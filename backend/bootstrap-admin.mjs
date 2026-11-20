import mysql from 'mysql2/promise';
import { createUser } from './auth.mjs';
import { executeRecords } from './records.mjs';

const email = process.env.BOOTSTRAP_EMAIL;
const password = process.env.BOOTSTRAP_PASSWORD;
if (!email || !password) throw new Error('BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD are required');

const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER || 'lms',
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'lms',
});
try {
  const [admins] = await db.execute("SELECT id FROM lms_users WHERE role IN ('super_admin', 'admin') LIMIT 1");
  if (admins.length) throw new Error('An administrator already exists; use the app to manage users');
  const id = await createUser(db, { email, password, fullName: 'LMS Administrator', role: 'super_admin', approved: true });
  await executeRecords(db, { table: 'profiles', action: 'insert', values: {
    id, email, full_name: 'LMS Administrator', role: 'super_admin', is_approved: true,
    approved_at: new Date().toISOString(), approved_by: id,
  } });
  await executeRecords(db, { table: 'user_roles', action: 'insert', values: { user_id: id, role: 'super_admin' } });
  console.log(`Created administrator ${email}`);
} finally { await db.end(); }
