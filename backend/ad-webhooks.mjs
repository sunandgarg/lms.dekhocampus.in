import { timingSafeEqual } from 'node:crypto';
import { executeRecords } from './records.mjs';
import { processLeadBatch } from './lead-processor.mjs';
import { saveSourceFile } from './archive.mjs';

const SYSTEM_USER = '00000000-0000-4000-8000-000000000000';

function same(a, b) {
  const one = Buffer.from(String(a || ''));
  const two = Buffer.from(String(b || ''));
  return one.length > 0 && one.length === two.length && timingSafeEqual(one, two);
}

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

async function integrationFor(db, platform, key) {
  if (!key) fail(401, 'Webhook key required');
  const { data: rows } = await executeRecords(db, { table: 'app_settings', select: 'id, key, value',
    filters: [{ field: 'key', op: 'like', value: 'ad_integration_%' }], limit: 1000 });
  for (const row of rows) {
    let config;
    try { config = JSON.parse(row.value); } catch { continue; }
    if ((config.platform === platform || platform === 'google' && config.platform === 'bing') &&
      config.is_active !== false && same(config.webhook_key, key)) {
      if (!config.university_id) fail(400, 'Set a university for this integration');
      return { setting: row, config };
    }
  }
  fail(401, 'Invalid webhook key');
}

function normalizeLead(raw, platform, campaign) {
  const lead = { name: raw.name || raw.full_name || raw.first_name || '',
    email: raw.email || raw.email_address || '', mobile: raw.mobile || raw.phone || raw.phone_number || '',
    city: raw.city || '', state: raw.state || '', course: raw.course || raw.program || raw.interest || '',
    leadSource: platform === 'facebook' ? 'Facebook Lead Ads' : platform === 'bing' ? 'Bing Lead Ads' : 'Google Lead Ads',
    leadMedium: 'paid', leadCampaign: campaign || raw.campaign || raw.campaign_name || '' };
  if (!lead.name || !lead.email || !lead.mobile) fail(400, 'Webhook lead requires name, email, and mobile');
  return Object.fromEntries(Object.entries(lead).map(([field, value]) => [field, String(value)]));
}

async function metaLeads(payload) {
  if (!Array.isArray(payload.entry)) return [normalizeLead(payload, 'facebook')];
  const leads = [];
  for (const entry of payload.entry) for (const change of entry.changes || []) {
    if (change.field !== 'leadgen') continue;
    const leadId = String(change.value?.leadgen_id || '');
    if (!/^\d{5,30}$/.test(leadId) || !process.env.META_ACCESS_TOKEN) fail(503, 'Meta lead retrieval is not configured');
    const response = await fetch(`https://graph.facebook.com/v21.0/${leadId}?fields=field_data`, {
      headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) fail(502, `Meta lead retrieval failed (${response.status})`);
    const full = await response.json();
    const raw = {};
    for (const field of full.field_data || []) {
      const key = String(field.name || '').toLowerCase();
      const value = field.values?.[0];
      if (/email/.test(key)) raw.email = value;
      else if (/phone|mobile/.test(key)) raw.mobile = value;
      else if (/name/.test(key)) raw.name = value;
      else if (/city/.test(key)) raw.city = value;
      else if (/state/.test(key)) raw.state = value;
      else if (/course|program/.test(key)) raw.course = value;
    }
    leads.push(normalizeLead(raw, 'facebook', change.value?.campaign_name || change.value?.ad_name));
  }
  return leads;
}

function googleLeads(payload, platform) {
  if (payload.leadFormSubmission) {
    const submission = payload.leadFormSubmission;
    const raw = {};
    for (const column of submission.userData?.userColumnData || []) {
      const key = String(column.columnName || '').toLowerCase();
      if (/email/.test(key)) raw.email = column.stringValue;
      else if (/phone/.test(key)) raw.mobile = column.stringValue;
      else if (/name/.test(key)) raw.name = column.stringValue;
      else if (/city/.test(key)) raw.city = column.stringValue;
      else if (/state/.test(key)) raw.state = column.stringValue;
      else if (/course|program/.test(key)) raw.course = column.stringValue;
    }
    return [normalizeLead(raw, platform, submission.campaignName || payload.campaignName)];
  }
  const entries = payload.entries || payload.leads || [payload];
  if (!Array.isArray(entries)) fail(400, 'Invalid Google lead payload');
  return entries.map((entry) => normalizeLead(entry, platform));
}

export async function handleAdWebhook({ db, s3, bucket, platform, key, payload }) {
  if (!payload || typeof payload !== 'object') fail(400, 'Invalid webhook payload');
  const { setting, config } = await integrationFor(db, platform, key || payload.google_key);
  const actualPlatform = config.platform;
  const leads = actualPlatform === 'facebook' ? await metaLeads(payload) : googleLeads(payload, actualPlatform);
  if (!leads.length || leads.length > 100) fail(400, 'Expected 1 to 100 leads');
  const universityId = config.university_id;
  const { data: batch } = await executeRecords(db, { table: 'upload_batches', action: 'insert', select: 'id', single: true,
    returnRows: true,
    values: { university_id: universityId, file_name: `${actualPlatform}_ads_${new Date().toISOString()}.json`,
      total_leads: leads.length, status: 'processing', user_id: SYSTEM_USER, processed_count: 0 } });
  try {
    await saveSourceFile({ s3, bucket, batchId: batch.id, filename: `${actualPlatform}.json`,
      body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json' });
    const { results } = await processLeadBatch({ db, s3, bucket, userId: SYSTEM_USER,
      tasks: leads.map((lead) => ({ universityId, batchId: batch.id, sourceLabel: lead.leadSource, leadData: lead })),
      concurrency: 2 });
    await executeRecords(db, { table: 'upload_batches', action: 'update', filters: [{ field: 'id', op: 'eq', value: batch.id }],
      values: { status: 'completed', completed_at: new Date().toISOString() } });
    config.leads_received = Number(config.leads_received || 0) + results.length;
    config.last_lead_at = new Date().toISOString();
    await executeRecords(db, { table: 'app_settings', action: 'update', filters: [{ field: 'id', op: 'eq', value: setting.id }],
      values: { value: JSON.stringify(config) } });
    return { success: true, leads_received: results.length, batch_id: batch.id, results };
  } catch (error) {
    await executeRecords(db, { table: 'upload_batches', action: 'update', filters: [{ field: 'id', op: 'eq', value: batch.id }],
      values: { status: 'failed', error_message: String(error.message || error) } });
    throw error;
  }
}

export async function verifyMeta(db, key, challenge) {
  await integrationFor(db, 'facebook', key);
  if (typeof challenge !== 'string' || challenge.length > 1000) fail(400, 'Invalid challenge');
  return challenge;
}
