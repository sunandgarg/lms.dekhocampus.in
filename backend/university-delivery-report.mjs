const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function indiaMidnightUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw Object.assign(new Error('Choose a valid report date'), { status: 400 });
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) throw Object.assign(new Error('Choose a valid report date'), { status: 400 });
  return date.getTime() - INDIA_OFFSET_MS;
}

export function reportRange(from, to) {
  const start = indiaMidnightUtc(from);
  const end = indiaMidnightUtc(to) + DAY_MS;
  if (end <= start || end - start > 365 * DAY_MS) {
    throw Object.assign(new Error('Choose a date range of up to 365 days'), { status: 400 });
  }
  return [new Date(start).toISOString().slice(0, 23).replace('T', ' '),
    new Date(end).toISOString().slice(0, 23).replace('T', ' ')];
}

export async function universityDeliveryReport(db, { from, to }) {
  const [start, end] = reportRange(from, to);
  const [rows] = await db.execute(`
    SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(u.data, '$.name')), 'Unknown university') AS university,
      l.record_university_id AS university_id,
      COUNT(*) AS total,
      SUM(l.record_status IN ('Success', 'success')) AS success,
      SUM(l.record_status IN ('Duplicate', 'duplicate')) AS duplicate,
      SUM(l.record_status IN ('Fail', 'failed', 'Failed', 'Needs_Review')) AS failed
    FROM lms_records l
    LEFT JOIN lms_records u ON u.collection = 'universities' AND u.id = l.record_university_id
    WHERE l.collection = 'leads' AND l.created_at >= ? AND l.created_at < ?
      AND (JSON_EXTRACT(l.data, '$.deleted_at') IS NULL OR JSON_TYPE(JSON_EXTRACT(l.data, '$.deleted_at')) = 'NULL')
    GROUP BY l.record_university_id, university
    ORDER BY total DESC, university ASC`, [start, end]);
  return { from, to, rows: rows.map((row) => ({
    university: row.university, university_id: row.university_id,
    total: Number(row.total), success: Number(row.success), duplicate: Number(row.duplicate),
    failed: Number(row.failed), pending: Number(row.total) - Number(row.success) - Number(row.duplicate) - Number(row.failed),
  })) };
}
