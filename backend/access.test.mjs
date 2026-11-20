import test from 'node:test';
import assert from 'node:assert/strict';
import { userRecords } from './access.mjs';

const user = { id: '303670cf-d907-4d52-afb7-876935cb2a3a', role: 'user' };

test('team users only read their own lead history', async () => {
  let bound;
  const db = { execute: async (_sql, values) => { bound = values; return [[{ data: { id: 'x', user_id: user.id } }]]; } };
  const result = await userRecords(db, user, { table: 'leads', select: 'id, user_id' });
  assert.deepEqual(result.data, [{ id: 'x', user_id: user.id }]);
  assert.deepEqual(bound, ['leads', user.id, 1000, 0]);
});

test('team users cannot read partner credentials', async () => {
  const db = { execute: async () => [[{ data: { id: 'x', secret_key: 'private', auth_header_value: 'secret', custom_headers: { Key: 'secret' } } }]] };
  const result = await userRecords(db, user, { table: 'universities', select: '*' });
  assert.equal(result.data[0].secret_key, '');
  assert.equal(result.data[0].auth_header_value, '');
  assert.deepEqual(result.data[0].custom_headers, {});
});

test('team users cannot edit university configuration', async () => {
  const db = { execute: async () => [[{ data: { permission: 'lead-push.upload' } }]] };
  await assert.rejects(userRecords(db, user, { table: 'universities', action: 'update', values: { status: 'disabled' } }), /Access denied/);
});

test('administrator uploads are owned by the signed-in administrator', async () => {
  const admin = { id: '7c94e1dd-c102-48cc-894b-c72e147c6a53', role: 'super_admin' };
  let saved;
  const db = { execute: async (sql, values) => {
    if (sql.startsWith('INSERT INTO lms_records')) saved = JSON.parse(values[2]);
    return [[]];
  } };
  await userRecords(db, admin, { table: 'upload_batches', action: 'insert',
    values: { university_id: 'd761817d-acba-4aad-bd2f-f173502996d7', status: 'uploading', total_leads: 1 } });
  assert.equal(saved.user_id, admin.id);
});
