import { maskContactData } from './mask-contact.mjs';

function csv(value) {
  const string = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(string) ? `'${string}` : string;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function* batchReport(db, batchId, { masked = false } = {}) {
  const extraKeys = new Set();
  const readPage = async (offset) => {
    const [rows] = await db.execute(
      "SELECT data FROM lms_records WHERE collection = 'leads' AND record_batch_id = ? ORDER BY created_at, id LIMIT 500 OFFSET ?",
      [batchId, offset],
    );
    return rows.map(({ data }) => typeof data === 'string' ? JSON.parse(data) : data);
  };
  let offset = 0;
  while (true) {
    const rows = await readPage(offset);
    for (const lead of rows) for (const key of Object.keys(lead.extra_data || {})) extraKeys.add(key);
    if (rows.length < 500) break;
    offset += rows.length;
  }
  const standard = ['lead_id', 'name', 'email', 'mobile', 'address', 'city', 'state', 'course',
    'specialization', 'lead_source', 'lead_medium', 'lead_campaign', 'university_id'];
  const extras = [...extraKeys].sort();
  const fields = [...standard, ...extras, 'delivery_status', 'status_color', 'processed_at', 'partner_response'];
  yield fields.map(csv).join(',') + '\r\n';
  offset = 0;
  while (true) {
    const rows = await readPage(offset);
    for (const lead of rows) {
      const status = lead.status === 'Success' ? 'Success' : lead.status === 'Duplicate' ? 'Duplicate' : 'Fail';
      const color = status === 'Success' ? 'Green' : status === 'Duplicate' ? 'Red' : 'Light yellow';
      const values = [lead.id, lead.name, lead.email, lead.mobile, lead.address, lead.city, lead.state,
        lead.course, lead.specialization, lead.lead_source, lead.lead_medium, lead.lead_campaign,
        lead.university_id, ...extras.map((key) => lead.extra_data?.[key]), status, color,
        lead.processed_at, lead.api_response];
      yield values.map((value, index) => csv(masked ? maskContactData(value, fields[index]) : value)).join(',') + '\r\n';
    }
    if (rows.length < 500) return;
    offset += rows.length;
  }
}
