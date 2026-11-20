import { resolve4, resolveCname, resolveTxt } from 'node:dns/promises';
import { executeRecords } from './records.mjs';

let cachedIp = null;
let ipCheckedAt = 0;

export async function serverIp() {
  if (cachedIp && Date.now() - ipCheckedAt < 600_000) return { ip: cachedIp };
  const response = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Could not determine outbound IP');
  const { ip } = await response.json();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip || '')) throw new Error('Invalid outbound IP response');
  cachedIp = ip;
  ipCheckedAt = Date.now();
  return { ip };
}

export async function processQueue(db, batchId) {
  const filters = [{ field: 'status', op: 'eq', value: 'processing' }];
  if (batchId) filters.push({ field: 'id', op: 'eq', value: batchId });
  const { data: batches } = await executeRecords(db, { table: 'upload_batches', select: '*', filters, limit: 50 });
  let updated = 0;
  for (const batch of batches) {
    const processed = Number(batch.success_count || 0) + Number(batch.fail_count || 0) + Number(batch.duplicate_count || 0);
    const values = { processed_count: processed, current_lead_index: processed };
    if (processed >= Number(batch.total_leads || 0) && Number(batch.total_leads) > 0 && !batch.is_paused && !batch.is_cancelled) {
      values.status = 'completed';
      values.completed_at = new Date().toISOString();
      updated++;
    }
    await executeRecords(db, { table: 'upload_batches', action: 'update', filters: [{ field: 'id', op: 'eq', value: batch.id }], values });
  }
  return { success: true, updated, checked: batches.length };
}

export async function verifyDomain(db, input, actor) {
  const domainId = String(input.domainId || '');
  const domain = String(input.domain || '').toLowerCase();
  const token = String(input.token || '');
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain) || !token || !domainId) {
    const error = new Error('Valid domain, ID, and token required'); error.status = 400; throw error;
  }
  const { data: record } = await executeRecords(db, { table: 'custom_domains', select: '*', single: true,
    filters: [{ field: 'id', op: 'eq', value: domainId }] });
  if (!record || record.domain !== domain || record.verification_token !== token || record.user_id !== actor.id) {
    const error = new Error('Domain not found'); error.status = 404; throw error;
  }
  let txtVerified = false;
  let pointsToServer = false;
  try {
    const records = await resolveTxt(`_verify.${domain}`);
    txtVerified = records.some((parts) => parts.join('') === token);
  } catch { /* DNS record not published yet */ }
  try { pointsToServer = (await resolveCname(domain)).length > 0; }
  catch {
    try { pointsToServer = (await resolve4(domain)).length > 0; }
    catch { /* DNS record not published yet */ }
  }
  if (txtVerified) {
    await executeRecords(db, { table: 'custom_domains', action: 'update', filters: [{ field: 'id', op: 'eq', value: domainId }],
      values: { status: 'verified', verified_at: new Date().toISOString(), ssl_status: pointsToServer ? 'active' : 'pending',
        dns_config: { ...(record.dns_config || {}), txt_verified: true, cname_verified: pointsToServer } } });
    return { verified: true, cname_configured: pointsToServer, message: 'Domain verified successfully' };
  }
  return { verified: false, txt_found: false, cname_found: pointsToServer, message: 'Verification TXT record is missing or does not match' };
}
