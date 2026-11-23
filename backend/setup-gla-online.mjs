import mysql from 'mysql2/promise';
import { executeRecords } from './records.mjs';
import { GLA_ONLINE_ENDPOINT } from './gla-online.mjs';

const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER || 'lms',
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'lms',
});
try {
  await db.beginTransaction();
  const { data: existing } = await executeRecords(db, { table: 'universities', select: 'id,name',
    filters: [{ field: 'name', op: 'eq', value: 'GLA ONLINE' }], single: true });
  let universityId = existing?.id;
  if (!universityId) {
    const { data: university } = await executeRecords(db, { table: 'universities', action: 'insert',
      select: 'id', single: true, returnRows: true, values: {
        name: 'GLA ONLINE', status: 'live', api_type: 'glaonline', api_url: GLA_ONLINE_ENDPOINT,
        source: 'dekho_campus', medium: 'dekhocampus', campaign: 'API',
        auth_type: 'none', secret_key: '', college_id: '', custom_headers: {},
        column_mapping: {}, default_values: {}, payload_wrapper: 'object',
        leads_per_minute: 30, default_push_concurrency: 1, api_timeout_seconds: 30,
        sample_csv_content: 'name,email,mobile,dob,course,specialization,glaCityCode,program_code\n',
      } });
    universityId = university.id;
  }
  for (const name of ['MBA', 'MCA']) {
    const { data } = await executeRecords(db, { table: 'programs', select: 'id',
      filters: [{ field: 'university_id', op: 'eq', value: universityId }, { field: 'name', op: 'eq', value: name }], single: true });
    if (!data) await executeRecords(db, { table: 'programs', action: 'insert', values: { university_id: universityId, name } });
  }
  const { data: hr } = await executeRecords(db, { table: 'course_specializations', select: 'id',
    filters: [{ field: 'university_id', op: 'eq', value: universityId },
      { field: 'course', op: 'eq', value: 'MBA' },
      { field: 'specialization', op: 'eq', value: 'Human Resource Management' }], single: true });
  if (!hr) await executeRecords(db, { table: 'course_specializations', action: 'insert', values: {
    university_id: universityId, course: 'MBA', specialization: 'Human Resource Management',
  } });
  await db.commit();
  console.log('GLA ONLINE configured', universityId);
} catch (error) {
  await db.rollback();
  throw error;
} finally {
  await db.end();
}
