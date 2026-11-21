import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { executeRecords } from './records.mjs';
import { saveSourceFile } from './archive.mjs';
import { matchingInboundRules } from './inbound-routing.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = ['name', 'email', 'mobile', 'source', 'medium', 'campaign', 'course', 'city', 'state'];
const SYSTEM_FIELDS = new Set(['api_key', 'token', 'secret', 'authorization', 'external_id', 'idempotency_key']);

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function hash(value) { return createHash('sha256').update(value).digest(); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function publicConnection(row) { const { key_hash, ...safe } = row; return safe; }

function settings(input) {
  const name = String(input?.name || '').trim();
  const source = String(input?.source_label || '').trim();
  if (!name || name.length > 100 || source.length > 100) fail(400, 'Use a connection name and a source label under 100 characters');
  const field_map = input?.field_map || {};
  if (!record(field_map) || Object.keys(field_map).some((field) => !FIELDS.includes(field)) ||
      Object.values(field_map).some((path) => typeof path !== 'string' || path && !/^[\w.-]{1,100}$/.test(path))) {
    fail(400, 'Invalid incoming field mapping');
  }
  return { name, source_label: source || name, field_map };
}

async function existingDestinations(db, ids) {
  const found = new Set();
  for (let start = 0; start < ids.length; start += 500) {
    const group = ids.slice(start, start + 500);
    const { data } = await executeRecords(db, { table: 'universities', select: 'id',
      filters: [{ field: 'id', op: 'in', value: group }], limit: group.length });
    for (const row of data) found.add(row.id);
  }
  return found;
}

export async function listGenericConnections(db) {
  const { data } = await executeRecords(db, { table: 'inbound_connections', select: '*',
    order: [{ field: 'created_at', ascending: false }], limit: 1000 });
  return data.map(publicConnection);
}

export async function createGenericConnection(db, input, userId) {
  const values = settings(input);
  const key = `dcg_${randomBytes(32).toString('base64url')}`;
  const { data } = await executeRecords(db, { table: 'inbound_connections', action: 'insert',
    select: '*', single: true, returnRows: true,
    values: { ...values, key_hash: hash(key).toString('hex'), user_id: userId,
      is_active: true, request_count: 0 } });
  return { connection: publicConnection(data), key };
}

export async function updateGenericConnection(db, id, input) {
  if (!UUID.test(id)) fail(400, 'Invalid connection ID');
  const { data: current } = await executeRecords(db, { table: 'inbound_connections', select: '*',
    filters: [{ field: 'id', op: 'eq', value: id }], single: true });
  if (!current) fail(404, 'Connection not found');
  const values = settings({ ...current, ...input });
  if (input?.is_active != null && typeof input.is_active !== 'boolean') fail(400, 'Invalid active setting');
  const { data } = await executeRecords(db, { table: 'inbound_connections', action: 'update',
    filters: [{ field: 'id', op: 'eq', value: id }], select: '*', single: true, returnRows: true,
    values: { ...values, is_active: input?.is_active ?? current.is_active } });
  return publicConnection(data);
}

function getPath(raw, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((value, part) => value?.[part], raw);
}

function field(raw, mapping, canonical, aliases) {
  const paths = [mapping?.[canonical], canonical, ...aliases];
  for (const path of paths) {
    const value = getPath(raw, path);
    if (typeof value === 'string' || typeof value === 'number') {
      if (String(value).trim()) return String(value).trim();
    }
  }
  return '';
}

export function normalizeGenericLead(payload, connection) {
  const raw = record(payload?.lead) ? payload.lead : payload;
  if (!record(raw)) fail(400, 'Send one JSON lead object');
  const mapping = connection.field_map || {};
  const lead = {
    name: field(raw, mapping, 'name', ['full_name', 'fullName', 'first_name']),
    email: field(raw, mapping, 'email', ['email_address', 'email_id', 'mail']),
    mobile: field(raw, mapping, 'mobile', ['phone', 'phone_number', 'mobile_number', 'contact']),
    source: field(raw, mapping, 'source', ['lead_source', 'utm_source']) || connection.source_label,
    campaign: field(raw, mapping, 'campaign', ['lead_campaign', 'utm_campaign']),
    course: field(raw, mapping, 'course', ['course_interest', 'course_of_interest', 'program', 'interest']),
    city: field(raw, mapping, 'city', []),
    state: field(raw, mapping, 'state', []),
  };
  if (!lead.name) lead.name = 'Unnamed Lead';
  if (lead.name.length > 255 || lead.email.length > 254) fail(400, 'Name or email is too long');
  if (!lead.email && !lead.mobile) fail(400, 'Email or mobile is required');
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) fail(400, 'Invalid email');
  if (lead.mobile && !/^[+\d\s().-]{7,25}$/.test(lead.mobile)) fail(400, 'Invalid mobile');
  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SYSTEM_FIELDS.has(key.toLowerCase()) || key.length > 100 || value == null || typeof value === 'object') continue;
    const text = String(value);
    if (text.length > 10000) fail(400, `Field ${key} is too large`);
    extra[key] = text;
  }
  const leadData = { ...extra, ...lead, leadSource: lead.source,
    leadCampaign: lead.campaign, leadMedium: field(raw, mapping, 'medium', ['lead_medium', 'utm_medium']) };
  if (JSON.stringify(leadData).length > 100000) fail(413, 'Lead is too large');
  return { lead, leadData, extra };
}

export async function receiveGenericLead({ db, s3, bucket, token, payload, idempotencyKey }) {
  if (!/^dcg_[A-Za-z0-9_-]{43}$/.test(String(token || ''))) fail(401, 'Valid bearer key required');
  if (!record(payload)) fail(400, 'Send one JSON lead object');
  const tokenHash = hash(token).toString('hex');
  const { data: connection } = await executeRecords(db, { table: 'inbound_connections', select: '*',
    filters: [{ field: 'key_hash', op: 'eq', value: tokenHash }], single: true });
  if (!connection || !connection.is_active ||
      !timingSafeEqual(Buffer.from(connection.key_hash, 'hex'), Buffer.from(tokenHash, 'hex'))) fail(401, 'Invalid or inactive key');
  return receiveCapturedLead({ db, s3, bucket, connection, payload, idempotencyKey });
}

export async function receiveCapturedLead({ db, s3, bucket, connection, payload, idempotencyKey, defaultDestinationIds = [] }) {
  if (!record(payload)) fail(400, 'Send one JSON lead object');
  const { lead, leadData, extra } = normalizeGenericLead(payload, connection);
  const externalKey = idempotencyKey || payload.external_id || payload.lead?.external_id || '';
  if (externalKey && (typeof externalKey !== 'string' || externalKey.length > 200)) fail(400, 'Invalid idempotency key');
  const keyHash = externalKey ? hash(externalKey) : null;
  const payloadHash = hash(JSON.stringify(payload));
  if (keyHash) {
    const [existing] = await db.execute(
      'SELECT payload_hash, lead_id FROM lms_inbound_ids WHERE connection_id = ? AND external_key_hash = ?',
      [connection.id, keyHash]);
    if (existing.length) {
      if (!timingSafeEqual(existing[0].payload_hash, payloadHash)) fail(409, 'Idempotency key was used for different lead data');
      return { accepted: true, duplicate: true, lead_id: existing[0].lead_id };
    }
  }
  const matchedRules = await matchingInboundRules(db, leadData, payload);
  const destinations = new Map();
  for (const universityId of defaultDestinationIds) {
    if (UUID.test(universityId)) destinations.set(universityId, 'Ad integration');
  }
  for (const rule of matchedRules) for (const universityId of rule.destination_ids) {
    if (UUID.test(universityId) && !destinations.has(universityId)) destinations.set(universityId, rule.name);
  }
  const existing = await existingDestinations(db, [...destinations.keys()]);
  const skippedDestinations = [...destinations.keys()].filter((id) => !existing.has(id));
  for (const id of skippedDestinations) destinations.delete(id);
  const id = randomUUID();
  if (!bucket) fail(503, 'Archive bucket unavailable');
  try { await saveSourceFile({ s3, bucket, batchId: id, filename: 'incoming.json',
    body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json' }); }
  catch { fail(503, 'Could not archive incoming lead'); }

  const transaction = await db.getConnection();
  try {
    await transaction.beginTransaction();
    if (keyHash) {
      const [insert] = await transaction.execute(
        'INSERT IGNORE INTO lms_inbound_ids (connection_id, external_key_hash, payload_hash, lead_id) VALUES (?, ?, ?, ?)',
        [connection.id, keyHash, payloadHash, id]);
      if (!insert.affectedRows) {
        const [rows] = await transaction.execute(
          'SELECT payload_hash, lead_id FROM lms_inbound_ids WHERE connection_id = ? AND external_key_hash = ?',
          [connection.id, keyHash]);
        if (!rows.length || !timingSafeEqual(rows[0].payload_hash, payloadHash)) fail(409, 'Idempotency key was used for different lead data');
        await transaction.rollback();
        return { accepted: true, duplicate: true, lead_id: rows[0].lead_id };
      }
    }
    const batchIds = [];
    for (const [universityId, routeName] of destinations) {
      const batchId = randomUUID();
      batchIds.push(batchId);
      await executeRecords(transaction, { table: 'upload_batches', action: 'insert', values: {
        id: batchId, university_id: universityId, user_id: connection.user_id,
        file_name: `Generic Push: ${routeName}`, total_leads: 1,
        status: 'processing', is_paused: false, is_cancelled: false,
        processed_count: 0, success_count: 0, fail_count: 0, duplicate_count: 0,
        source_label: lead.source,
      } });
      const task = { universityId, batchId, leadIndex: 0, sourceLabel: lead.source,
        leadData: { ...leadData, inbound_lead_id: id } };
      await transaction.execute('INSERT INTO lms_lead_queue (batch_id, lead_index, task) VALUES (?, 0, ?)',
        [batchId, JSON.stringify(task)]);
    }
    await executeRecords(transaction, { table: 'inbound_leads', action: 'insert', values: {
      id, connection_id: connection.id, connection_name: connection.name, user_id: connection.user_id,
      name: lead.name, email: lead.email, mobile: lead.mobile, city: lead.city, course: lead.course,
      source: lead.source, campaign: lead.campaign, status: 'Received',
      batch_ids: batchIds, matched_rules: matchedRules.map((rule) => rule.name),
      skipped_destinations: skippedDestinations.length, extra_data: extra,
    } });
    for (const rule of matchedRules) {
      await transaction.execute(`UPDATE lms_records SET data = JSON_SET(data,
        '$.triggered_count', COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.triggered_count')) AS UNSIGNED), 0) + 1,
        '$.last_triggered_at', ?) WHERE collection = 'inbound_routing_rules' AND id = ?`,
      [new Date().toISOString(), rule.id]);
    }
    await transaction.execute(`UPDATE lms_records SET data = JSON_SET(data,
      '$.request_count', COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.request_count')) AS UNSIGNED), 0) + 1,
      '$.last_used_at', ?) WHERE collection = 'inbound_connections' AND id = ?`,
    [new Date().toISOString(), connection.id]);
    await transaction.commit();
    return { accepted: true, duplicate: false, lead_id: id,
      queued_destinations: batchIds.length, skipped_destinations: skippedDestinations.length,
      matched_rules: matchedRules.map((rule) => rule.name), batch_ids: batchIds };
  } catch (error) { await transaction.rollback(); throw error; }
  finally { transaction.release(); }
}
