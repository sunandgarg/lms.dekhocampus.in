import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { archiveAndDeliver } from './archive.mjs';
import { buildPayload, categorizeResponse } from './lead-payload.mjs';
import { executeRecords } from './records.mjs';
import { syncLeadToCrm } from './crm-sync.mjs';

let activeDeliveries = 0;
const waitingDeliveries = [];

async function withDeliverySlot(deliver) {
  if (activeDeliveries < 2) activeDeliveries++;
  else {
    if (waitingDeliveries.length >= 200) throw new Error('Server is busy; retry this lead later');
    await new Promise((resume) => waitingDeliveries.push(resume));
  }
  try { return await deliver(); }
  finally {
    const resume = waitingDeliveries.shift();
    if (resume) resume();
    else activeDeliveries--;
  }
}

function dateInIndia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function asObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

async function recordById(db, table, id) {
  const [rows] = await db.execute('SELECT data FROM lms_records WHERE collection = ? AND id = ? LIMIT 1', [table, id]);
  return rows[0] ? asObject(rows[0].data) : null;
}

export function validPartnerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid partner API URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || isIP(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Partner API must use a public HTTPS host');
  }
  return url;
}

function universityConfig(university, browserConfig = {}) {
  const config = {
    apiUrl: university.api_url,
    secretKey: university.secret_key || '',
    collegeId: university.college_id || '',
    source: university.source || '',
    medium: university.medium || '',
    campaign: university.campaign || '',
    apiType: university.api_type || 'generic',
    columnMapping: asObject(browserConfig.columnMapping || university.column_mapping),
    customColumnMapping: asObject(browserConfig.customColumnMapping),
    payloadWrapper: university.payload_wrapper || 'object',
    authType: university.auth_type || 'secret_key',
    authHeaderKey: university.auth_header_key || '',
    authHeaderValue: university.auth_header_value || '',
    customHeaders: asObject(university.custom_headers),
    universityDefaults: asObject(university.default_values),
    apiTimeoutSeconds: Number(browserConfig.apiTimeoutSeconds) || 30,
  };
  validPartnerUrl(config.apiUrl);
  return config;
}

async function reserveDailyCapacity(db, universityId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT data FROM lms_records WHERE collection = ? AND id = ? FOR UPDATE', ['universities', universityId]);
    if (!rows.length) throw new Error('University not found');
    const university = asObject(rows[0].data);
    if (university.status === 'disabled') {
      await connection.rollback();
      return { allowed: false, status: 'Disabled', response: 'University is disabled' };
    }
    const today = dateInIndia();
    const resetDay = String(university.daily_count_reset_at || '').slice(0, 10);
    const count = resetDay === today ? Number(university.daily_pushed_count || 0) : 0;
    const limit = Number(university.daily_lead_limit || university.daily_limit || 0);
    if (limit > 0 && count >= limit) {
      await connection.rollback();
      return { allowed: false, status: 'DLL_Blocked', response: `Daily lead limit reached (${count}/${limit})` };
    }
    university.daily_pushed_count = count + 1;
    university.daily_count_reset_at = today;
    university.updated_at = new Date().toISOString();
    await connection.execute('UPDATE lms_records SET data = ? WHERE collection = ? AND id = ?', [JSON.stringify(university), 'universities', universityId]);
    await connection.commit();
    return { allowed: true, university };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function incrementBatch(db, batchId, status) {
  if (!batchId) return;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT data FROM lms_records WHERE collection = ? AND id = ? FOR UPDATE', ['upload_batches', batchId]);
    if (!rows.length) { await connection.rollback(); return; }
    const batch = asObject(rows[0].data);
    batch.processed_count = Number(batch.processed_count || 0) + 1;
    const field = status === 'Success' ? 'success_count' : status === 'Duplicate' ? 'duplicate_count' : 'fail_count';
    batch[field] = Number(batch[field] || 0) + 1;
    await connection.execute('UPDATE lms_records SET data = ? WHERE collection = ? AND id = ?', [JSON.stringify(batch), 'upload_batches', batchId]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

function leadRow(task, result, userId) {
  const lead = task.leadData;
  const standard = new Set(['name', 'email', 'mobile', 'address', 'city', 'state', 'course', 'specialization', 'leadSource', 'leadMedium', 'leadCampaign']);
  const extra = Object.fromEntries(Object.entries(lead).filter(([key]) => !standard.has(key)));
  if (task.retryOf) extra.retry_of = task.retryOf;
  return {
    batch_id: task.batchId,
    university_id: task.universityId,
    user_id: userId,
    name: String(lead.name || ''),
    email: String(lead.email || ''),
    mobile: String(lead.mobile || ''),
    address: lead.address || null,
    city: lead.city || null,
    state: lead.state || null,
    course: lead.course || null,
    specialization: lead.specialization || null,
    lead_source: lead.leadSource || task.sourceLabel || null,
    lead_medium: lead.leadMedium || null,
    lead_campaign: lead.leadCampaign || null,
    extra_data: extra,
    status: result.status,
    api_response: String(result.response || '').slice(0, 64000),
    processed_at: new Date().toISOString(),
    retry_count: Number(task.retryCount || 0),
  };
}

async function deliverPartner(task, config, db, outbound) {
  const batch = await recordById(db, 'upload_batches', task.batchId);
  if (!batch || batch.is_paused || batch.is_cancelled || ['cancelled', 'paused'].includes(String(batch.status).toLowerCase())) {
    return { success: false, status: 'Cancelled', response: 'Batch was stopped before delivery', httpStatus: 0 };
  }
  const capacity = await reserveDailyCapacity(db, task.universityId);
  if (!capacity.allowed) return { success: false, status: capacity.status, response: capacity.response, httpStatus: 0 };

  const timeout = Math.min(300, Math.max(5, Number(config.apiTimeoutSeconds) || 30));
  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST', headers: outbound.headers, body: JSON.stringify(outbound.body),
      signal: AbortSignal.timeout(timeout * 1000), redirect: 'error',
    });
    const responseBody = (await response.text()).slice(0, 64_000);
    const status = categorizeResponse(response.status, responseBody, response.ok);
    return { success: status === 'Success', status, response: responseBody, httpStatus: response.status };
  } catch (error) {
    return { success: false, status: 'Fail', response: String(error), httpStatus: 0 };
  }
}

export async function processLead({ db, s3, bucket, task, userId }) {
  if (!bucket) throw new Error('Archive bucket is not configured');
  if (!task || typeof task !== 'object' || !task.batchId || !task.universityId || !task.leadData || typeof task.leadData !== 'object') {
    const error = new Error('Invalid lead task'); error.status = 400; throw error;
  }
  if (JSON.stringify(task.leadData).length > 100_000 || Object.entries(task.leadData).some(([key, value]) => key.length > 100 || typeof value !== 'string' || value.length > 10_000)) {
    const error = new Error('Lead data is too large or contains invalid fields'); error.status = 400; throw error;
  }
  const university = await recordById(db, 'universities', task.universityId);
  if (!university) { const error = new Error('University not found'); error.status = 404; throw error; }
  const config = universityConfig(university, task.apiConfig);
  const { payload, headers } = buildPayload(task.leadData, config);
  const outbound = { url: config.apiUrl, method: 'POST', headers,
    body: config.payloadWrapper === 'array' && !Array.isArray(payload) ? [payload] : payload };
  const transactionId = randomUUID();
  const prefix = `batches/${task.batchId}/transactions/${transactionId}/`;
  let result;
  let archiveError = null;
  try {
    result = await archiveAndDeliver({
      s3, bucket, batchId: task.batchId, transactionId,
      input: { universityId: task.universityId, batchId: task.batchId, sourceLabel: task.sourceLabel,
        leadData: task.leadData, outbound, apiConfig: config },
      deliver: () => withDeliverySlot(() => deliverPartner(task, config, db, outbound)),
    });
  } catch (error) {
    if (error.archiveFailed === 'request') {
      error.status = 503;
      throw error;
    }
    archiveError = error.archiveFailed === 'response' ? error : null;
    result = error.deliveryResult?.status
      ? { ...error.deliveryResult, response: `${error.deliveryResult.response || ''}\nResponse archive failed` }
      : { success: false, status: archiveError ? 'Archive_Error' : 'Fail', response: String(error), httpStatus: 0 };
  }
  await db.execute(
    'INSERT INTO lms_transactions (id, batch_id, university_id, user_id, request_key, response_key, status, http_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [transactionId, task.batchId, task.universityId, userId, `${prefix}request.json`, archiveError ? null : `${prefix}response.json`, result.status, result.httpStatus],
  );
  const { data: savedLead } = await executeRecords(db, { table: 'leads', action: 'insert', select: '*', single: true,
    values: leadRow(task, result, userId), returnRows: true });
  await executeRecords(db, { table: 'api_logs', action: 'insert', values: {
    university_id: task.universityId, batch_id: task.batchId, user_id: userId, status: result.status,
    email: task.leadData.email || null, mobile: task.leadData.mobile || null,
    lead_data: task.leadData, response: String(result.response || '').slice(0, 64000),
    source_label: task.sourceLabel || null, trigger_point: 'node-api',
    lead_id: savedLead.id,
    source: task.leadData.leadSource || task.sourceLabel || null,
    medium: task.leadData.leadMedium || null,
    campaign: task.leadData.leadCampaign || null,
  } });
  await incrementBatch(db, task.batchId, result.status);
  if (result.status === 'Success') {
    try { await syncLeadToCrm(db, savedLead); }
    catch (error) { console.error('CRM sync failed for lead', savedLead.id, error); }
  }
  if (archiveError) {
    archiveError.status = 503;
    throw archiveError;
  }
  return result;
}

export async function processLeadBatch({ db, s3, bucket, tasks, userId, concurrency = 1 }) {
  if (!Array.isArray(tasks) || tasks.length > 100) {
    const error = new Error('Expected at most 100 lead tasks'); error.status = 400; throw error;
  }
  const results = new Array(tasks.length);
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, 2, tasks.length));
  let next = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < tasks.length) {
      const index = next++;
      try { results[index] = await processLead({ db, s3, bucket, task: tasks[index], userId }); }
      catch (error) { throw error; }
    }
  }));
  return { results };
}
