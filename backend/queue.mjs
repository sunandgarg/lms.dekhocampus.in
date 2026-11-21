import { processLead } from './lead-processor.mjs';
import { haltBatch, unhaltBatch, batchHalted } from './batch-gate.mjs';

function bad(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export async function enqueueLeads(db, batchId, tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 100) bad('Send 1 to 100 leads per request');
  const [rows] = await db.execute("SELECT data FROM lms_records WHERE collection = 'upload_batches' AND id = ?", [batchId]);
  const batch = rows[0]?.data;
  if (!batch || batch.status !== 'uploading') bad('Batch is not accepting leads', 409);
  const values = [];
  for (const item of tasks) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= Number(batch.total_leads) ||
        !item.leadData || typeof item.leadData !== 'object' || Array.isArray(item.leadData)) bad('Invalid lead index or data');
    const mapping = item.apiConfig && typeof item.apiConfig === 'object' ? item.apiConfig : {};
    const task = { universityId: batch.university_id, batchId, leadIndex: item.index,
      sourceLabel: batch.source_label || '', leadData: item.leadData,
      apiConfig: { columnMapping: mapping.columnMapping, customColumnMapping: mapping.customColumnMapping,
        apiTimeoutSeconds: mapping.apiTimeoutSeconds } };
    if (JSON.stringify(task).length > 100_000) bad('Lead data is too large');
    values.push([batchId, item.index, JSON.stringify(task)]);
  }
  await db.query('INSERT INTO lms_lead_queue (batch_id, lead_index, task) VALUES ? ON DUPLICATE KEY UPDATE batch_id = batch_id', [values]);
  return { accepted: tasks.length };
}

export async function sealQueue(db, batchId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT data FROM lms_records WHERE collection = 'upload_batches' AND id = ? FOR UPDATE", [batchId]);
    const batch = rows[0]?.data;
    if (!batch || batch.status !== 'uploading') bad('Batch is not ready', 409);
    const [counts] = await connection.execute('SELECT COUNT(*) AS count FROM lms_lead_queue WHERE batch_id = ?', [batchId]);
    if (counts[0].count !== Number(batch.total_leads)) bad('Some leads have not been queued', 409);
    batch.status = 'processing';
    await connection.execute("UPDATE lms_records SET data = ? WHERE collection = 'upload_batches' AND id = ?", [JSON.stringify(batch), batchId]);
    await connection.commit();
    return { queued: counts[0].count };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function claimNext(db) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(`SELECT q.batch_id, q.lead_index, q.task, b.data AS batch
      FROM lms_lead_queue q JOIN lms_records b ON b.collection = 'upload_batches' AND b.id = q.batch_id
      WHERE q.status = 'queued' AND JSON_UNQUOTE(JSON_EXTRACT(b.data, '$.status')) = 'processing'
      AND JSON_EXTRACT(b.data, '$.is_paused') != true AND JSON_EXTRACT(b.data, '$.is_cancelled') != true
      ORDER BY q.created_at, q.lead_index LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!rows.length) { await connection.rollback(); return null; }
    const item = rows[0];
    await connection.execute("UPDATE lms_lead_queue SET status = 'processing' WHERE batch_id = ? AND lead_index = ?",
      [item.batch_id, item.lead_index]);
    await connection.commit();
    return item;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function finishItem(db, item, error, result) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('UPDATE lms_lead_queue SET status = ?, error = ? WHERE batch_id = ? AND lead_index = ?',
      [error ? 'needs_review' : 'done', error ? String(error.message || error).slice(0, 1000) : null, item.batch_id, item.lead_index]);
    const [rows] = await connection.execute("SELECT data FROM lms_records WHERE collection = 'upload_batches' AND id = ? FOR UPDATE", [item.batch_id]);
    if (rows.length) {
      const batch = rows[0].data;
      if (error) { batch.status = 'failed'; batch.error_message = 'Lead delivery needs review before retry: ' + String(error.message || error).slice(0, 400); }
      else if (batch.status === 'processing') {
        applyDeliveryResult(batch, result);
        const [pending] = await connection.execute("SELECT COUNT(*) AS count FROM lms_lead_queue WHERE batch_id = ? AND status IN ('queued', 'processing')", [item.batch_id]);
        if (!pending[0].count && batch.status === 'processing') { batch.status = 'completed'; batch.completed_at = new Date().toISOString(); }
      }
      await connection.execute("UPDATE lms_records SET data = ? WHERE collection = 'upload_batches' AND id = ?", [JSON.stringify(batch), item.batch_id]);
    }
    await connection.commit();
  } catch (finishError) { await connection.rollback(); throw finishError; }
  finally { connection.release(); }
}

export function applyDeliveryResult(batch, result) {
  const failed = !['Success', 'Duplicate', 'Cancelled'].includes(result?.status);
  batch.consecutive_fail_count = failed ? Number(batch.consecutive_fail_count || 0) + 1 : 0;
  if (batch.consecutive_fail_count >= 25) {
    batch.status = 'paused'; batch.is_paused = true;
    batch.safety_pause_reason = '25 leads failed consecutively. Check the partner response and discuss before continuing.';
    batch.error_message = batch.safety_pause_reason;
    batch.paused_at = new Date().toISOString();
  }
}

export async function workQueue({ db, s3, bucket }) {
  const item = await claimNext(db);
  if (!item) return false;
  try { const result = await processLead({ db, s3, bucket, task: item.task, userId: item.batch.user_id });
    if (result.status === 'Cancelled') {
      const [rows] = await db.execute("SELECT data FROM lms_records WHERE collection = 'upload_batches' AND id = ?", [item.batch_id]);
      const status = rows[0]?.data?.status === 'cancelled' ? 'cancelled' : 'queued';
      await db.execute('UPDATE lms_lead_queue SET status = ?, error = NULL WHERE batch_id = ? AND lead_index = ?',
        [status, item.batch_id, item.lead_index]);
    } else await finishItem(db, item, null, result); }
  catch (error) { console.error('Queued lead needs review:', error);
    await finishItem(db, item, error); }
  return true;
}

export async function controlBatch(db, batchId, action, discussionWith = '') {
  if (!['pause', 'stop', 'continue'].includes(action)) bad('Invalid batch action');
  const connection = await db.getConnection();
  const wasHalted = batchHalted(batchId);
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT data FROM lms_records WHERE collection = 'upload_batches' AND id = ? FOR UPDATE", [batchId]);
    if (!rows.length) bad('Batch not found', 404);
    const batch = rows[0].data;
    if (action === 'continue') {
      if (batch.status !== 'paused') bad('Only paused batches can continue', 409);
      const [counts] = await connection.execute('SELECT COUNT(*) AS count FROM lms_lead_queue WHERE batch_id = ?', [batchId]);
      if (counts[0].count !== Number(batch.total_leads)) bad(`Only ${counts[0].count} of ${batch.total_leads} leads reached the server. Re-upload the file before pushing.`, 409);
      if (batch.safety_pause_reason && !String(discussionWith).trim()) bad('Enter who you discussed the failures with', 400);
      batch.discussion_with = String(discussionWith).trim().slice(0, 120) || batch.discussion_with || null;
      batch.discussed_at = new Date().toISOString();
      batch.consecutive_fail_count = 0;
      batch.safety_pause_reason = null;
      batch.error_message = null;
      batch.is_paused = false; batch.status = 'processing';
    } else if (action === 'pause') {
      if (batch.status !== 'processing') bad('Only processing batches can be paused', 409);
      haltBatch(batchId);
      batch.is_paused = true; batch.status = 'paused'; batch.paused_at = new Date().toISOString();
    } else {
      if (!['processing', 'paused', 'uploading'].includes(batch.status)) bad('Batch is already finished', 409);
      haltBatch(batchId);
      batch.is_cancelled = true; batch.is_paused = false; batch.status = 'cancelled';
      batch.completed_at = new Date().toISOString();
    }
    await connection.execute("UPDATE lms_records SET data = ? WHERE collection = 'upload_batches' AND id = ?", [JSON.stringify(batch), batchId]);
    await connection.commit();
    if (action === 'continue') unhaltBatch(batchId);
    return { status: batch.status, safety_pause_reason: batch.safety_pause_reason || null };
  } catch (error) { await connection.rollback(); if (!wasHalted) unhaltBatch(batchId); throw error; }
  finally { connection.release(); }
}

export async function recoverQueue(db) {
  const [rows] = await db.query("SELECT DISTINCT batch_id FROM lms_lead_queue WHERE status = 'processing'");
  await db.query("UPDATE lms_lead_queue SET status = 'needs_review', error = 'Server restarted during delivery; check partner and S3 archive before retry' WHERE status = 'processing'");
  for (const { batch_id } of rows) {
    const [batches] = await db.execute("SELECT data FROM lms_records WHERE collection = 'upload_batches' AND id = ?", [batch_id]);
    if (!batches.length) continue;
    const batch = batches[0].data;
    batch.status = 'failed';
    batch.error_message = 'Server restarted during delivery. Review the transaction archive before retrying.';
    await db.execute("UPDATE lms_records SET data = ? WHERE collection = 'upload_batches' AND id = ?", [JSON.stringify(batch), batch_id]);
  }
}
