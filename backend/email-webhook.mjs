import { timingSafeEqual } from 'node:crypto';
import { executeRecords } from './records.mjs';

export async function receiveEmailEvents(db, key, payload) {
  const { data: settings } = await executeRecords(db, { table: 'email_api_settings', select: 'webhook_key, webhook_events', limit: 1, single: true });
  const actual = Buffer.from(String(settings?.webhook_key || ''));
  const provided = Buffer.from(String(key || ''));
  if (!actual.length || actual.length !== provided.length || !timingSafeEqual(actual, provided)) {
    throw Object.assign(new Error('Invalid webhook key'), { status: 401 });
  }
  const events = Array.isArray(payload) ? payload : [payload];
  if (events.length > 100 || events.some((item) => !item || typeof item !== 'object')) {
    throw Object.assign(new Error('Expected at most 100 events'), { status: 400 });
  }
  const rows = events.map((event) => {
    const eventType = String(event.event || event.EVENT || 'unknown').toLowerCase()
      .replace('spamreport', 'spam_report').replace('dropped', 'block').replace('invalidemail', 'invalid');
    const email = String(event.email || event.EMAIL || event.rcpt || '').trim().toLowerCase();
    if (!email || email.length > 254) return null;
    if (Object.keys(settings.webhook_events || {}).length && !settings.webhook_events[eventType]) return null;
    return { campaign_id: event.campaign_id || event.CAMPAIGN_ID || null,
      recipient_email: email, event_type: eventType, event_data: event,
      provider_message_id: event.sg_message_id || event.TRANSID || event.message_id || null,
      received_at: event.timestamp ? new Date(Number(event.timestamp) * 1000).toISOString() : new Date().toISOString() };
  }).filter(Boolean);
  if (rows.length) await executeRecords(db, { table: 'email_events', action: 'insert', values: rows });
  return { success: true, processed: rows.length };
}
