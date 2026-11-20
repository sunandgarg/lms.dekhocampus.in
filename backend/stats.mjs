import { randomUUID } from 'node:crypto';

function indiaDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function statsDelta(status) {
  if (status === 'Cancelled') return null;
  if (status === 'DLL_Blocked') return { pushed: 0, field: 'dll_blocked' };
  if (status === 'Disabled') return { pushed: 0, field: 'other_error' };
  return { pushed: 1, field: { Success: 'success', Duplicate: 'duplicate', Fail: 'failed' }[status] || 'other_error' };
}

export async function updateLeadStats(db, task, result) {
  const delta = statsDelta(result.status);
  if (!delta) return;
  const source = String(task.sourceLabel || task.leadData.leadSource || '').trim() || null;
  const date = indiaDate();
  const now = new Date().toISOString();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // One university row serializes creation and updates of its rollups.
    const [university] = await connection.execute("SELECT id FROM lms_records WHERE collection = 'universities' AND id = ? FOR UPDATE", [task.universityId]);
    if (!university.length) throw new Error('University not found for stats');
    for (const table of ['lead_push_daily_stats', 'lead_push_cumulative_stats']) {
      const daily = table === 'lead_push_daily_stats';
      const [found] = await connection.execute(
        `SELECT id, data FROM lms_records WHERE collection = ? AND record_university_id = ?
         AND COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.source_label')), 'null'), '') = ?
         ${daily ? "AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.stat_date')) = ?" : ''}
         LIMIT 1 FOR UPDATE`, daily ? [table, task.universityId, source || '', date] : [table, task.universityId, source || ''],
      );
      const row = found.length ? (typeof found[0].data === 'string' ? JSON.parse(found[0].data) : found[0].data) : daily
        ? { id: randomUUID(), university_id: task.universityId, source_label: source, stat_date: date,
          pushed: 0, success: 0, failed: 0, duplicate: 0, other_error: 0, dll_blocked: 0, created_at: now }
        : { id: randomUUID(), university_id: task.universityId, source_label: source,
          total_pushed: 0, total_success: 0, total_failed: 0, total_duplicate: 0,
          total_other_error: 0, total_dll_blocked: 0, first_pushed_at: null, last_pushed_at: null };
      const prefix = daily ? '' : 'total_';
      row[`${prefix}pushed`] = Number(row[`${prefix}pushed`] || 0) + delta.pushed;
      row[`${prefix}${delta.field}`] = Number(row[`${prefix}${delta.field}`] || 0) + 1;
      if (!daily && delta.pushed) {
        row.first_pushed_at ||= now;
        row.last_pushed_at = now;
      }
      row.updated_at = now;
      if (found.length) await connection.execute('UPDATE lms_records SET data = ? WHERE collection = ? AND id = ?', [JSON.stringify(row), table, row.id]);
      else await connection.execute('INSERT INTO lms_records (collection, id, data) VALUES (?, ?, ?)', [table, row.id, JSON.stringify(row)]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
