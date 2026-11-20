import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { executeRecords } from './records.mjs';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

export async function authorizeShortApi(db, authorization, permission) {
  const token = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (!/^dkc_[A-Za-z0-9]{32}$/.test(token)) fail(401, 'Valid API key required');
  const hash = createHash('sha256').update(token).digest('hex');
  const { data: key } = await executeRecords(db, { table: 'url_api_keys', select: '*', single: true,
    filters: [{ field: 'key_hash', op: 'eq', value: hash }] });
  if (!key || key.key_hash?.length !== hash.length || !timingSafeEqual(Buffer.from(key.key_hash), Buffer.from(hash)) ||
    !key.is_active || key.expires_at && new Date(key.expires_at) < new Date() ||
    !Array.isArray(key.permissions) || !key.permissions.includes(permission)) fail(401, 'API key is invalid or lacks permission');

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT data FROM lms_records WHERE collection = ? AND id = ? FOR UPDATE', ['url_api_keys', key.id]);
    if (!rows.length) fail(401, 'API key has been revoked');
    const current = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    const today = new Date().toISOString().slice(0, 10);
    const count = current.requests_reset_at === today ? Number(current.requests_today || 0) : 0;
    if (count >= Math.max(1, Number(current.rate_limit) || 100)) fail(429, 'API key daily limit reached');
    current.requests_today = count + 1;
    current.requests_reset_at = today;
    current.last_used_at = new Date().toISOString();
    await connection.execute('UPDATE lms_records SET data = ? WHERE collection = ? AND id = ?', [JSON.stringify(current), 'url_api_keys', key.id]);
    await connection.commit();
    return current;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function shorten(db, key, input, host) {
  let target;
  try { target = new URL(String(input?.url || '')); }
  catch { fail(400, 'Valid destination URL required'); }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.href.length > 2000) {
    fail(400, 'Only HTTP or HTTPS destination URLs are allowed');
  }
  const header = input.header ? String(input.header).toUpperCase() : null;
  if (header && !/^[A-Z0-9]{1,32}$/.test(header)) fail(400, 'Invalid header');
  const code = input.custom_code || randomBytes(5).toString('hex');
  if (!/^[A-Za-z0-9]{3,64}$/.test(code)) fail(400, 'Invalid short code');
  const { data: existing } = await executeRecords(db, { table: 'url_mappings', select: 'id', single: true,
    filters: [{ field: 'short_code', op: 'eq', value: code }] });
  if (existing) fail(409, 'Short code already exists');
  const { data: mapping } = await executeRecords(db, { table: 'url_mappings', action: 'insert', select: 'id, short_code',
    single: true, returnRows: true, values: { short_code: code, original_url: target.href, header,
      user_id: key.user_id, is_active: true, clicks: 0, user_tracking: true } });
  return { id: mapping.id, short_code: code,
    short_url: `https://${host}/s/${header ? `${header}/` : ''}${code}`, original_url: target.href };
}

export async function shortAnalytics(db, key, code) {
  if (!/^[A-Za-z0-9]{3,64}$/.test(code || '')) fail(400, 'Invalid short code');
  const { data: mapping } = await executeRecords(db, { table: 'url_mappings', select: '*', single: true,
    filters: [{ field: 'short_code', op: 'eq', value: code }, { field: 'user_id', op: 'eq', value: key.user_id }] });
  if (!mapping) fail(404, 'Short URL not found');
  const { count } = await executeRecords(db, { table: 'url_clicks', select: 'id', count: 'exact', head: true,
    filters: [{ field: 'url_id', op: 'eq', value: mapping.id }] });
  return { short_code: code, original_url: mapping.original_url, clicks: count,
    is_active: mapping.is_active, created_at: mapping.created_at };
}
