import { executeRecords } from './records.mjs';
import { processLead } from './lead-processor.mjs';
import { saveSourceFile } from './archive.mjs';

function leadData(lead) {
  const data = { name: String(lead.name || ''), email: String(lead.email || ''), mobile: String(lead.mobile || ''),
    address: lead.address || '', city: lead.city || '', state: lead.state || '',
    course: lead.course || '', specialization: lead.specialization || '',
    leadSource: lead.lead_source || '', leadMedium: lead.lead_medium || '',
    leadCampaign: lead.lead_campaign || '' };
  for (const [key, value] of Object.entries(lead.extra_data || {})) {
    if (typeof value === 'string' && key !== 'retry_of') data[key] = value;
  }
  return data;
}

export async function retryLeads({ db, s3, bucket, leadIds, userId, maxRetries = 3 }) {
  if (!Array.isArray(leadIds) || !leadIds.length || leadIds.length > 100 ||
    leadIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    throw Object.assign(new Error('Choose 1 to 100 valid leads'), { status: 400 });
  }
  const { data: found } = await executeRecords(db, { table: 'leads', select: '*',
    filters: [{ field: 'id', op: 'in', value: leadIds }], limit: 100 });
  const eligible = found.filter((lead) => ['Fail', 'failed'].includes(lead.status) && Number(lead.retry_count || 0) < maxRetries);
  if (!eligible.length) return { retried: 0, skipped: leadIds.length, results: [] };
  const results = [];
  for (const lead of eligible) {
    const { data: batch } = await executeRecords(db, { table: 'upload_batches', action: 'insert', select: 'id', single: true,
      returnRows: true, values: { university_id: lead.university_id, user_id: userId,
        file_name: `Retry of ${lead.id}`, total_leads: 1, status: 'processing', processed_count: 0 } });
    let deliveryStarted = false;
    try {
      const data = leadData(lead);
      const fields = Object.keys(data);
      const cell = (value) => `"${String(value || '').replaceAll('"', '""')}"`;
      const csv = fields.map(cell).join(',') + '\n' + fields.map((field) => cell(data[field])).join(',') + '\n';
      await saveSourceFile({ s3, bucket, batchId: batch.id, filename: 'retry.csv', body: Buffer.from(csv) });
      const [claimed] = await db.execute(
        "UPDATE lms_records SET data = JSON_SET(data, '$.status', 'Retrying') WHERE collection = 'leads' AND id = ? AND record_status IN ('Fail', 'failed')",
        [lead.id],
      );
      if (!claimed.affectedRows) {
        await executeRecords(db, { table: 'upload_batches', action: 'update', filters: [{ field: 'id', op: 'eq', value: batch.id }],
          values: { status: 'cancelled' } });
        results.push({ lead_id: lead.id, skipped: true });
        continue;
      }
      deliveryStarted = true;
      const result = await processLead({ db, s3, bucket, userId,
        task: { universityId: lead.university_id, batchId: batch.id, sourceLabel: 'Manual Retry',
          leadData: data, retryCount: Number(lead.retry_count || 0) + 1, retryOf: lead.id } });
      await db.execute("UPDATE lms_records SET data = JSON_SET(data, '$.status', 'Retried', '$.retry_count', ?) WHERE collection = 'leads' AND id = ?",
        [Number(lead.retry_count || 0) + 1, lead.id]);
      await executeRecords(db, { table: 'upload_batches', action: 'update', filters: [{ field: 'id', op: 'eq', value: batch.id }],
        values: { status: 'completed', completed_at: new Date().toISOString() } });
      results.push({ lead_id: lead.id, status: result.status, batch_id: batch.id });
    } catch (error) {
      // Once delivery starts, a thrown error can mean the partner received the lead.
      // Keep it out of automatic retries until the S3 transaction is reviewed.
      await db.execute("UPDATE lms_records SET data = JSON_SET(data, '$.status', ?) WHERE collection = 'leads' AND id = ? AND record_status = 'Retrying'",
        [deliveryStarted ? 'Needs_Review' : 'Fail', lead.id]);
      await executeRecords(db, { table: 'upload_batches', action: 'update', filters: [{ field: 'id', op: 'eq', value: batch.id }],
        values: { status: 'failed', error_message: deliveryStarted
          ? `Retry outcome needs review before another send: ${String(error.message || error)}`
          : String(error.message || error) } });
      throw error;
    }
  }
  return { retried: results.filter((item) => !item.skipped).length, skipped: leadIds.length - results.filter((item) => !item.skipped).length, results };
}

let autoRetryRunning = false;
export async function runAutoRetries({ db, s3, bucket }) {
  if (autoRetryRunning) return;
  autoRetryRunning = true;
  try {
    const { data: failed } = await executeRecords(db, { table: 'leads', select: 'id, university_id, user_id, retry_count, processed_at',
      filters: [{ field: 'status', op: 'in', value: ['Fail', 'failed'] }, { field: 'retry_count', op: 'lt', value: 10 }],
      order: [{ field: 'created_at', ascending: true }], limit: 200 });
    const universityCache = new Map();
    for (const lead of failed) {
      let university = universityCache.get(lead.university_id);
      if (university === undefined) {
        const result = await executeRecords(db, { table: 'universities', select: 'auto_retry_enabled, auto_retry_delay_minutes, auto_retry_max_attempts',
          filters: [{ field: 'id', op: 'eq', value: lead.university_id }], single: true });
        university = result.data || null;
        universityCache.set(lead.university_id, university);
      }
      if (!lead.user_id || !university?.auto_retry_enabled || Number(lead.retry_count || 0) >= Number(university.auto_retry_max_attempts || 3)) continue;
      const delay = Math.max(5, Number(university.auto_retry_delay_minutes || 30)) * 60_000;
      if (Date.now() - new Date(lead.processed_at || 0).getTime() < delay) continue;
      // shortcut: partner timeouts can be ambiguous; enable automatic retry only for partners that deduplicate leads.
      try { await retryLeads({ db, s3, bucket, leadIds: [lead.id], userId: lead.user_id,
        maxRetries: Number(university.auto_retry_max_attempts || 3) }); }
      catch (error) { console.error('Automatic retry failed for lead', lead.id, error); }
    }
  } finally { autoRetryRunning = false; }
}
