import { executeRecords } from './records.mjs';
import { redactPartnerMapping, sensitivePartnerField } from './inbound-field-overrides.mjs';

const CONFIG_READ = new Set([
  'universities', 'programs', 'state_cities', 'course_specializations',
  'custom_columns', 'custom_column_values', 'multi_push_presets',
]);
const OWN_READ = new Map([
  ['upload_batches', 'user_id'], ['leads', 'user_id'], ['api_logs', 'user_id'],
  ['user_permissions', 'user_id'], ['profiles', 'id'],
]);
const BATCH_WRITES = new Set([
  'status', 'is_paused', 'is_cancelled', 'current_lead_index',
  'processed_count', 'completed_at', 'error_message',
]);

function forbidden() {
  const error = new Error('Access denied');
  error.status = 403;
  throw error;
}

export function isAdmin(user) {
  return user.role === 'admin' || user.role === 'super_admin';
}

export async function canUpload(db, user) {
  if (isAdmin(user)) return true;
  const { data } = await executeRecords(db, { table: 'user_permissions', select: 'permission',
    filters: [{ field: 'user_id', op: 'eq', value: user.id }], limit: 100 });
  return data.some((row) => ['*', 'lead-push', 'lead-push.upload'].includes(row.permission));
}

function hideCredentials(result) {
  const strip = (row) => {
    if (!row || typeof row !== 'object') return row;
    const clean = { ...row };
    for (const field of ['secret_key', 'auth_header_value', 'custom_headers']) {
      if (field in clean) clean[field] = field === 'custom_headers' ? {} : '';
    }
    if (clean.column_mapping) {
      let mapping = clean.column_mapping;
      if (typeof mapping === 'string') {
        try { mapping = JSON.parse(mapping); } catch { mapping = {}; }
      }
      clean.column_mapping = redactPartnerMapping(mapping);
    }
    if (clean.default_values) {
      let defaults = clean.default_values;
      if (typeof defaults === 'string') {
        try { defaults = JSON.parse(defaults); } catch { defaults = {}; }
      }
      clean.default_values = defaults && typeof defaults === 'object' && !Array.isArray(defaults)
        ? Object.fromEntries(Object.entries(defaults).filter(([key]) => !sensitivePartnerField(key))) : {};
    }
    return clean;
  };
  return { ...result, data: Array.isArray(result.data) ? result.data.map(strip) : strip(result.data) };
}

export async function userRecords(db, user, input) {
  if (isAdmin(user)) {
    if (input?.table === 'upload_batches' && input.action === 'insert') {
      const values = Array.isArray(input.values) ? input.values : [input.values];
      if (values.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) forbidden();
      return executeRecords(db, { ...input, values: values.map((row) => ({ ...row, user_id: user.id })) });
    }
    return executeRecords(db, input);
  }
  if (!input || typeof input !== 'object') forbidden();
  const query = { ...input, filters: [...(input.filters || [])] };
  const action = query.action || 'select';
  if (action === 'select') {
    if (CONFIG_READ.has(query.table)) {
      const result = await executeRecords(db, query);
      return query.table === 'universities' ? hideCredentials(result) : result;
    }
    if (query.table === 'app_settings') {
      query.filters.push({ field: 'key', op: 'eq', value: 'rate_limit_config' });
      return executeRecords(db, query);
    }
    const owner = OWN_READ.get(query.table);
    if (!owner) forbidden();
    query.filters.push({ field: owner, op: 'eq', value: user.id });
    return executeRecords(db, query);
  }
  if (!await canUpload(db, user)) forbidden();
  if (query.table !== 'upload_batches') forbidden();
  if (action === 'insert') {
    const values = Array.isArray(query.values) ? query.values : [query.values];
    if (values.length > 100 || values.some((row) => !row || row.user_id && row.user_id !== user.id)) forbidden();
    query.values = values.map((row) => ({ ...row, user_id: user.id }));
    return executeRecords(db, query);
  }
  if (action === 'update' && query.values && Object.keys(query.values).every((key) => BATCH_WRITES.has(key))) {
    query.filters.push({ field: 'user_id', op: 'eq', value: user.id });
    return executeRecords(db, query);
  }
  forbidden();
}

export async function requireOwnedBatch(db, user, batchId) {
  const { data: batch } = await executeRecords(db, { table: 'upload_batches', select: 'id, user_id', single: true,
    filters: [{ field: 'id', op: 'eq', value: batchId }] });
  if (!batch || !isAdmin(user) && batch.user_id !== user.id) forbidden();
  return batch;
}
