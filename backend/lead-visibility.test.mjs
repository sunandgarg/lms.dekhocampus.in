import test from 'node:test';
import assert from 'node:assert/strict';
import { hideLeads } from './lead-visibility.mjs';

const leadId = '303670cf-d907-4d52-afb7-876935cb2a3a';
const batchId = 'd761817d-acba-4aad-bd2f-f173502996d7';
const admin = { id: '7c94e1dd-c102-48cc-894b-c72e147c6a53', role: 'admin' };

test('normal users cannot delete leads', async () => {
  await assert.rejects(hideLeads({}, { id: leadId, role: 'user' }, [leadId]),
    (error) => error.status === 403);
});

test('active inbound deliveries block deletion', async () => {
  const db = { execute: async (sql) => {
    if (sql.includes("collection IN ('leads', 'inbound_leads')"))
      return [[{ id: leadId, collection: 'inbound_leads', data: { batch_ids: [batchId] } }]];
    return [[{ id: batchId }]];
  } };
  await assert.rejects(hideLeads(db, admin, [leadId]), (error) => error.status === 409);
});

test('admin deletion marks a completed lead while retaining its record', async () => {
  let update;
  const db = { execute: async (sql, values) => {
    if (sql.startsWith('SELECT id, data')) return [[{ id: leadId, collection: 'leads', data: { status: 'Success' } }]];
    update = { sql, values };
    return [{ affectedRows: 1 }];
  } };
  assert.deepEqual(await hideLeads(db, admin, [leadId]), { deleted: 1 });
  assert.match(update.sql, /JSON_SET\(data, '\$\.deleted_at'/);
  assert.equal(update.values[1], admin.id);
  assert.equal(update.values[2], leadId);
});
