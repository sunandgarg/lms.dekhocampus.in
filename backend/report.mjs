function csv(value) {
  const string = String(value ?? '');
  return `"${string.replaceAll('"', '""')}"`;
}

export async function* batchReport(db, batchId) {
  yield 'lead_id,name,email,mobile,university_id,status,processed_at,response\r\n';
  let offset = 0;
  while (true) {
    const [rows] = await db.execute(
      "SELECT data FROM lms_records WHERE collection = 'leads' AND record_batch_id = ? ORDER BY created_at, id LIMIT 500 OFFSET ?",
      [batchId, offset],
    );
    for (const { data } of rows) {
      const lead = typeof data === 'string' ? JSON.parse(data) : data;
      yield [lead.id, lead.name, lead.email, lead.mobile, lead.university_id,
        lead.status, lead.processed_at, lead.api_response].map(csv).join(',') + '\r\n';
    }
    if (rows.length < 500) return;
    offset += rows.length;
  }
}
