import { createHmac, timingSafeEqual } from 'node:crypto';
import { executeRecords } from './records.mjs';
import { receiveCapturedLead } from './generic-inbound.mjs';

const SYSTEM_USER = '00000000-0000-4000-8000-000000000000';

function same(a, b) {
  const one = Buffer.from(String(a || ''));
  const two = Buffer.from(String(b || ''));
  return one.length > 0 && one.length === two.length && timingSafeEqual(one, two);
}

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

export function verifyMetaSignature(body, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return same(expected, String(signature).slice(7).toLowerCase());
}

async function integrationFor(db, platform, key) {
  if (!key) fail(401, 'Webhook key required');
  const { data: rows } = await executeRecords(db, { table: 'app_settings', select: 'id, key, value',
    filters: [{ field: 'key', op: 'like', value: 'ad_integration_%' }], limit: 1000 });
  for (const row of rows) {
    let config;
    try { config = JSON.parse(row.value); } catch { continue; }
    if ((config.platform === platform || platform === 'google' && config.platform === 'bing') &&
      config.is_active !== false && same(config.webhook_key, key)) {
      return { setting: row, config };
    }
  }
  fail(401, 'Invalid webhook key');
}

function normalizeLead(raw, platform, campaign) {
  const email = String(raw.email || raw.email_address || '').trim();
  const mobile = String(raw.mobile || raw.phone || raw.phone_number || '').trim();
  const lead = { name: raw.name || raw.full_name || raw.first_name || 'Unnamed Lead',
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    mobile: /^[+\d\s().-]{7,25}$/.test(mobile) ? mobile : '',
    city: raw.city || '', state: raw.state || '', course: raw.course || raw.program || raw.interest || '',
    leadSource: platform === 'facebook' ? 'Facebook Lead Ads' : platform === 'bing' ? 'Bing Lead Ads' : 'Google Lead Ads',
    leadMedium: 'paid', leadCampaign: campaign || raw.campaign || raw.campaign_name || '' };
  if (!lead.email && !lead.mobile) fail(400, 'Webhook lead requires email or mobile');
  const providerFields = Object.fromEntries(Object.entries(raw).filter(([, value]) =>
    value != null && typeof value !== 'object').map(([field, value]) => [field, String(value)]));
  if (!lead.mobile) for (const field of ['mobile', 'phone', 'phone_number', 'mobile_number', 'contact']) delete providerFields[field];
  if (!lead.email) for (const field of ['email', 'email_address', 'email_id', 'mail']) delete providerFields[field];
  return { ...providerFields,
    ...Object.fromEntries(Object.entries(lead).map(([field, value]) => [field, String(value)])),
    source: lead.leadSource, medium: lead.leadMedium, campaign: lead.leadCampaign };
}

async function metaCampaignName(adId) {
  if (!/^\d{5,30}$/.test(String(adId || ''))) return '';
  try {
    const response = await fetch(`https://graph.facebook.com/v27.0/${adId}?fields=campaign%7Bid%2Cname%7D`, {
      headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) return '';
    const ad = await response.json();
    return typeof ad.campaign?.name === 'string' ? ad.campaign.name.trim().slice(0, 255) : '';
  } catch { return ''; }
}

export async function metaLeads(payload) {
  if (!Array.isArray(payload.entry)) return [normalizeLead(payload, 'facebook')];
  const leads = [];
  for (const entry of payload.entry) for (const change of entry.changes || []) {
    if (change.field !== 'leadgen') continue;
    const leadId = String(change.value?.leadgen_id || '');
    if (!/^\d{5,30}$/.test(leadId) || !process.env.META_ACCESS_TOKEN) fail(503, 'Meta lead retrieval is not configured');
    const response = await fetch(`https://graph.facebook.com/v27.0/${leadId}?fields=field_data%2Cad_id%2Ccampaign_id`, {
      headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) fail(502, `Meta lead retrieval failed (${response.status})`);
    const full = await response.json();
    const raw = {};
    for (const field of full.field_data || []) {
      const key = String(field.name || '').toLowerCase();
      const value = field.values?.[0];
      if (key && value != null) raw[key] = value;
      if (/email/.test(key)) raw.email = value;
      else if (/phone|mobile/.test(key)) raw.mobile = value;
      else if (/name/.test(key)) raw.name = value;
      else if (/city/.test(key)) raw.city = value;
      else if (/state/.test(key)) raw.state = value;
      else if (/course|program/.test(key)) raw.course = value;
    }
    const adId = String(full.ad_id || change.value?.ad_id || '');
    const campaignName = await metaCampaignName(adId) || String(change.value?.campaign_name || '').trim();
    leads.push({ ...normalizeLead(raw, 'facebook', campaignName),
      external_id: leadId, ad_id: adId, campaign_id: String(full.campaign_id || change.value?.campaign_id || '') });
  }
  return leads;
}

export function googleLeads(payload, platform) {
  if (Array.isArray(payload.user_column_data)) {
    const raw = {};
    for (const column of payload.user_column_data) {
      const key = String(column.column_id || column.column_name || '').toLowerCase();
      const value = column.string_value;
      if (!key || value == null) continue;
      raw[key] = value;
      if (/email/.test(key)) raw.email = value;
      else if (/phone|mobile/.test(key)) raw.mobile = value;
      else if (/name/.test(key)) raw.name = value;
      else if (/city/.test(key)) raw.city = value;
      else if (/state/.test(key)) raw.state = value;
      else if (/course|program/.test(key)) raw.course = value;
    }
    return [{ ...normalizeLead(raw, platform, payload.campaign_name || payload.campaign_id),
      external_id: String(payload.lead_id || ''), form_id: String(payload.form_id || ''),
      is_test: String(payload.is_test === true) }];
  }
  if (payload.leadFormSubmission) {
    const submission = payload.leadFormSubmission;
    const raw = {};
    for (const column of submission.userData?.userColumnData || []) {
      const key = String(column.columnName || '').toLowerCase();
      if (key && column.stringValue != null) raw[key] = column.stringValue;
      if (/email/.test(key)) raw.email = column.stringValue;
      else if (/phone/.test(key)) raw.mobile = column.stringValue;
      else if (/name/.test(key)) raw.name = column.stringValue;
      else if (/city/.test(key)) raw.city = column.stringValue;
      else if (/state/.test(key)) raw.state = column.stringValue;
      else if (/course|program/.test(key)) raw.course = column.stringValue;
    }
    return [{ ...normalizeLead(raw, platform, submission.campaignName || payload.campaignName),
      external_id: String(submission.leadFormSubmissionId || payload.leadId || '') }];
  }
  const entries = payload.entries || payload.leads || [payload];
  if (!Array.isArray(entries)) fail(400, 'Invalid Google lead payload');
  return entries.map((entry) => normalizeLead(entry, platform));
}

export async function handleAdWebhook({ db, s3, bucket, platform, key, payload, rawBody, signature }) {
  if (!payload || typeof payload !== 'object') fail(400, 'Invalid webhook payload');
  if (platform === 'facebook' && Array.isArray(payload.entry)) {
    if (!verifyMetaSignature(rawBody, signature, process.env.META_APP_SECRET)) fail(401, 'Invalid Meta signature');
    if (payload.object !== 'page' || (process.env.META_PAGE_ID &&
      payload.entry.some((entry) => String(entry.id) !== process.env.META_PAGE_ID))) fail(400, 'Unexpected Meta Page');
  }
  const { setting, config } = await integrationFor(db, platform, key || payload.google_key || payload.Google_key);
  const actualPlatform = config.platform;
  const leads = actualPlatform === 'facebook' ? await metaLeads(payload) : googleLeads(payload, actualPlatform);
  if (!leads.length || leads.length > 100) fail(400, 'Expected 1 to 100 leads');
  const results = [];
  for (const lead of leads) {
    results.push(await receiveCapturedLead({ db, s3, bucket,
      connection: { id: setting.id, name: config.name || `${actualPlatform} Ads`,
        source_label: lead.leadSource, field_map: {}, user_id: SYSTEM_USER },
      payload: { lead, original_webhook: payload }, idempotencyKey: lead.external_id || undefined,
      defaultDestinationIds: config.university_id ? [config.university_id] : [] }));
  }
  config.leads_received = Number(config.leads_received || 0) + results.filter((item) => !item.duplicate).length;
  config.last_lead_at = new Date().toISOString();
  await executeRecords(db, { table: 'app_settings', action: 'update', filters: [{ field: 'id', op: 'eq', value: setting.id }],
    values: { value: JSON.stringify(config) } });
  return { success: true, leads_received: results.length, results };
}

export async function verifyMeta(db, key, challenge) {
  await integrationFor(db, 'facebook', key);
  if (typeof challenge !== 'string' || challenge.length > 1000) fail(400, 'Invalid challenge');
  return challenge;
}
