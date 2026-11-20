import { timingSafeEqual } from 'node:crypto';
import { executeRecords } from './records.mjs';
import { processLead, processLeadBatch } from './lead-processor.mjs';
import { applyAutomation, recordAutomation } from './automation.mjs';

const SYSTEM_USER = '00000000-0000-4000-8000-000000000000';

function sameKey(a, b) {
  const one = Buffer.from(String(a || ''));
  const two = Buffer.from(String(b || ''));
  return one.length === two.length && timingSafeEqual(one, two);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function leadFromPayload(payload) {
  const lead = {};
  for (const [key, value] of Object.entries(payload)) {
    if (['api_key', 'landing_page_key', 'university_id'].includes(key) || value == null || typeof value === 'object') continue;
    if (key.length > 100 || String(value).length > 10_000) fail(400, 'Lead field is too large');
    lead[key] = String(value);
  }
  lead.mobile ||= lead.phone || '';
  if (!lead.name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email || '') || !/^[+\d\s().-]{10,20}$/.test(lead.mobile)) fail(400, 'Valid name, email, and mobile are required');
  return lead;
}

async function makeBatch(db, universityId, name) {
  const { data } = await executeRecords(db, {
    table: 'upload_batches', action: 'insert', select: 'id', single: true, returnRows: true,
    values: { university_id: universityId, file_name: name, total_leads: 1, status: 'processing',
      success_count: 0, fail_count: 0, duplicate_count: 0, processed_count: 0, user_id: SYSTEM_USER },
  });
  return data.id;
}

async function finishBatch(db, id) {
  await executeRecords(db, { table: 'upload_batches', action: 'update', filters: [{ field: 'id', op: 'eq', value: id }],
    values: { status: 'completed', completed_at: new Date().toISOString() } });
}

export async function receiveLead({ db, s3, bucket, payload, bearerKey }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'Invalid lead payload');
  const lead = leadFromPayload(payload);
  const landingKey = payload.landing_page_key || bearerKey || (!payload.university_id ? payload.api_key : '');

  if (landingKey) {
    const { data: pages } = await executeRecords(db, { table: 'landing_pages', select: '*', limit: 1000 });
    const page = pages.find((item) => item.is_active && sameKey(item.api_key, landingKey));
    if (!page) fail(401, 'Invalid landing page key');
    let universityIds = Array.isArray(page.university_ids) ? page.university_ids : [];
    if (page.routing_mode === 'preset' && page.preset_id) {
      const { data: preset } = await executeRecords(db, { table: 'multi_push_presets', select: 'university_ids', filters: [{ field: 'id', op: 'eq', value: page.preset_id }], single: true });
      universityIds = Array.isArray(preset?.university_ids) ? preset.university_ids : [];
    }
    if (!universityIds.length || universityIds.length > 10) fail(400, 'Landing page must target 1 to 10 universities');
    const defaults = page.default_values && typeof page.default_values === 'object' ? page.default_values : {};
    const tasks = [];
    const batchIds = [];
    for (const universityId of universityIds) {
      const batchId = await makeBatch(db, universityId, `LandingPage: ${page.name}`);
      batchIds.push(batchId);
      tasks.push({ universityId, batchId, sourceLabel: String(lead.source || 'Landing Page'),
        leadData: { ...defaults, ...lead, leadSource: lead.source || 'Landing Page', leadMedium: lead.medium || '', leadCampaign: lead.campaign || '' } });
    }
    const { results } = await processLeadBatch({ db, s3, bucket, tasks, userId: SYSTEM_USER, concurrency: 2 });
    await Promise.all(batchIds.map((id) => finishBatch(db, id)));
    await executeRecords(db, { table: 'landing_pages', action: 'update', filters: [{ field: 'id', op: 'eq', value: page.id }], values: {
      submissions_count: Number(page.submissions_count || 0) + 1, last_submission_at: new Date().toISOString(),
    } });
    return { success: results.some((item) => item.success), results };
  }

  if (!payload.university_id || !payload.api_key) fail(400, 'University ID and API key required');
  const { data: keys } = await executeRecords(db, { table: 'university_api_keys', select: '*', filters: [{ field: 'university_id', op: 'eq', value: payload.university_id }], limit: 100 });
  const key = keys.find((item) => item.is_active && sameKey(item.api_key, payload.api_key));
  if (!key) fail(401, 'Invalid API key or university ID');
  await executeRecords(db, { table: 'university_api_keys', action: 'update', filters: [{ field: 'id', op: 'eq', value: key.id }],
    values: { last_used_at: new Date().toISOString(), request_count: Number(key.request_count || 0) + 1 } });
  const { lead: preparedLead, rule } = await applyAutomation(db, lead);
  const { data: university } = await executeRecords(db, { table: 'universities', select: 'name', single: true,
    filters: [{ field: 'id', op: 'eq', value: payload.university_id }] });
  const primaryBatchId = await makeBatch(db, payload.university_id, `API_${new Date().toISOString()}`);
  const baseLead = { ...preparedLead, leadSource: preparedLead.source || '',
    leadMedium: preparedLead.medium || '', leadCampaign: preparedLead.campaign || '' };
  const tasks = [{ universityId: payload.university_id, batchId: primaryBatchId,
    sourceLabel: preparedLead.source || 'API', leadData: baseLead }];
  const batchIds = [primaryBatchId];
  for (const action of (rule?.actions || []).filter((item) => item.type === 'push').slice(0, 9)) {
    if (!/^[0-9a-f-]{36}$/i.test(action.university_id || '') ||
      tasks.some((task) => task.universityId === action.university_id)) continue;
    const batchId = await makeBatch(db, action.university_id, `Automation: ${rule.name}`);
    const mappedLead = { ...baseLead };
    for (const mapping of action.fieldMappings || []) {
      if (!mapping.uniField || mapping.uniField.includes('(static)')) continue;
      const value = mapping.defaultValue || baseLead[mapping.sourceField];
      if (value) mappedLead[mapping.uniField] = String(value);
    }
    tasks.push({ universityId: action.university_id, batchId,
      sourceLabel: `Automation: ${rule.name}`, leadData: mappedLead });
    batchIds.push(batchId);
  }
  try {
    const { results } = await processLeadBatch({ db, s3, bucket, tasks, userId: SYSTEM_USER, concurrency: 2 });
    await Promise.all(batchIds.map((id) => finishBatch(db, id)));
    await recordAutomation(db, rule, preparedLead, results[0], university?.name);
    return { ...results[0], batch_id: primaryBatchId, automation_results: results.slice(1) };
  } catch (error) {
    await Promise.all(batchIds.map((id) => executeRecords(db, { table: 'upload_batches', action: 'update',
      filters: [{ field: 'id', op: 'eq', value: id }], values: { status: 'failed', error_message: String(error.message || error) } })));
    throw error;
  }
}
