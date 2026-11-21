import { isAdmin } from './access.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export async function hideLeads(db, user, leadIds) {
  if (!isAdmin(user)) fail(403, 'Admin access required');
  if (!Array.isArray(leadIds) || !leadIds.length || leadIds.length > 100 || leadIds.some((id) => !UUID.test(id))) {
    fail(400, 'Choose 1 to 100 valid leads');
  }
  const ids = [...new Set(leadIds)];
  const placeholders = ids.map(() => '?').join(',');
  const [found] = await db.execute(
    `SELECT id, data, collection FROM lms_records WHERE collection IN ('leads', 'inbound_leads') AND id IN (${placeholders})`, ids);
  if (found.length !== ids.length) fail(404, 'A selected lead was not found');
  const visible = found.filter((row) => !row.data.deleted_at);
  if (visible.some((row) => row.collection === 'leads' && row.data.status === 'Retrying')) {
    fail(409, 'A lead is being retried. Wait for delivery to finish before deleting it.');
  }
  const batchIds = [...new Set(visible.filter((row) => row.collection === 'inbound_leads')
    .flatMap((row) => Array.isArray(row.data.batch_ids) ? row.data.batch_ids : []).filter((id) => UUID.test(id)))];
  if (batchIds.length) {
    const [active] = await db.execute(
      `SELECT id FROM lms_records WHERE collection = 'upload_batches' AND id IN (${batchIds.map(() => '?').join(',')})
       AND record_status IN ('uploading', 'scheduled', 'processing', 'paused') LIMIT 1`, batchIds);
    if (active.length) fail(409, 'Stop or finish this lead’s active push before deleting it.');
  }
  if (!visible.length) return { deleted: 0 };
  const [result] = await db.execute(
    `UPDATE lms_records SET data = JSON_SET(data, '$.deleted_at', ?, '$.deleted_by', ?)
     WHERE collection IN ('leads', 'inbound_leads') AND id IN (${placeholders})
       AND JSON_EXTRACT(data, '$.deleted_at') IS NULL`, [new Date().toISOString(), user.id, ...ids]);
  return { deleted: result.affectedRows || 0 };
}
