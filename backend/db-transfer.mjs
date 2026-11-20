import collections from './collections.json' with { type: 'json' };
import { executeRecords } from './records.mjs';

const RETAINED = new Set(['upload_batches', 'leads', 'api_logs']);

export async function* exportData(db) {
  yield `{"exported_at":${JSON.stringify(new Date().toISOString())},"version":3,"tables":{`;
  let firstTable = true;
  for (const table of Object.keys(collections)) {
    if (!firstTable) yield ',';
    firstTable = false;
    yield `${JSON.stringify(table)}:[`;
    let offset = 0;
    while (true) {
      const [rows] = await db.execute(
        'SELECT data FROM lms_records WHERE collection = ? ORDER BY id LIMIT 500 OFFSET ?', [table, offset],
      );
      for (let i = 0; i < rows.length; i++) {
        if (offset || i) yield ',';
        yield typeof rows[i].data === 'string' ? rows[i].data : JSON.stringify(rows[i].data);
      }
      if (rows.length < 500) break;
      offset += rows.length;
    }
    yield ']';
  }
  yield '}}';
}

export async function importData(db, input) {
  const mode = input?.mode || 'upsert';
  if (!['upsert', 'insert', 'replace'].includes(mode)) throw Object.assign(new Error('Invalid import mode'), { status: 400 });
  const tables = input?.data?.tables || input?.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) throw Object.assign(new Error('Tables required'), { status: 400 });
  const results = {};
  for (const [table, rows] of Object.entries(tables)) {
    if (!collections[table] || !Array.isArray(rows) || rows.length > 500) {
      results[table] = { error: 'Unknown table or invalid row count' };
      continue;
    }
    if (mode === 'replace' && RETAINED.has(table)) {
      results[table] = { error: 'Lead history cannot be replaced; use upsert' };
      continue;
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      if (mode === 'replace') await connection.execute('DELETE FROM lms_records WHERE collection = ?', [table]);
      let inserted = 0;
      for (const row of rows) {
        const action = mode === 'insert' ? 'insert' : 'upsert';
        try {
          await executeRecords(connection, { table, action, values: row });
          inserted++;
        } catch (error) {
          if (mode !== 'insert' || error.code !== 'ER_DUP_ENTRY') throw error;
        }
      }
      await connection.commit();
      results[table] = { inserted };
    } catch (error) {
      await connection.rollback();
      results[table] = { error: String(error.message || error) };
    } finally { connection.release(); }
  }
  return { success: Object.values(results).every((result) => !result.error), results };
}
