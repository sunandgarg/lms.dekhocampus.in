import { executeRecords } from './records.mjs';

export async function resolveShortUrl(db, { code, header, userAgent, referrer, ip }) {
  if (!/^[A-Za-z0-9]{1,64}$/.test(code || '') || header && !/^[A-Za-z0-9]{1,32}$/.test(header)) return null;
  const query = { table: 'url_mappings', select: '*', filters: [{ field: 'short_code', op: 'eq', value: code }], limit: 10 };
  const { data: matches } = await executeRecords(db, query);
  const mapping = matches.find((item) => header ? item.header === header.toUpperCase() : !item.header) || (!header ? matches[0] : null);
  if (!mapping || !mapping.is_active || mapping.expires_at && new Date(mapping.expires_at) < new Date()) return null;
  let target;
  try { target = new URL(mapping.original_url); } catch { return null; }
  if (!['https:', 'http:'].includes(target.protocol)) return null;

  if (mapping.user_tracking !== false) {
    const updated = { ...mapping, clicks: Number(mapping.clicks || 0) + 1 };
    await db.execute('UPDATE lms_records SET data = ? WHERE collection = ? AND id = ?', [JSON.stringify(updated), 'url_mappings', mapping.id]);
    await executeRecords(db, { table: 'url_clicks', action: 'insert', values: {
      url_id: mapping.id,
      user_agent: String(userAgent || '').slice(0, 1000),
      referrer: String(referrer || '').slice(0, 1000) || null,
      ip_address: String(ip || '').slice(0, 64) || null,
      clicked_at: new Date().toISOString(),
    } });
  }
  return target.href;
}
