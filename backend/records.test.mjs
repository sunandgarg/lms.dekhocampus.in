import test from 'node:test';
import assert from 'node:assert/strict';
import { whereClause, executeRecords } from './records.mjs';

test('record filters use bound values', () => {
  const params = [];
  const sql = whereClause({ table: 'leads', filters: [{ field: 'email', op: 'eq', value: "x' OR 1=1 --" }] }, params);
  assert.equal(params[0], 'leads');
  assert.equal(params[1], "x' OR 1=1 --");
  assert.doesNotMatch(sql, /OR 1=1/);
  assert.match(sql, /record_email/);
});

test('numeric filters compare numbers rather than strings', () => {
  const params = [];
  const sql = whereClause({ table: 'crm_contacts', filters: [{ field: 'lead_score', op: 'gt', value: 80 }] }, params);
  assert.match(sql, /CAST\(JSON_UNQUOTE/);
  assert.equal(params.at(-1), 80);
});

test('unknown fields and collections are rejected', () => {
  assert.throws(() => whereClause({ table: 'leads; DROP TABLE', filters: [] }, []), /Unknown collection/);
  assert.throws(() => whereClause({ table: 'leads', filters: [{ field: 'bad_field', op: 'eq', value: 1 }] }, []), /Unknown leads field/);
});

test('unfiltered delete is rejected before database access', async () => {
  const db = { execute: () => { throw new Error('database must not be called'); } };
  await assert.rejects(executeRecords(db, { table: 'crm_contacts', action: 'delete' }), /requires a filter/);
});

test('lead history cannot be deleted', async () => {
  await assert.rejects(executeRecords({}, { table: 'leads', action: 'delete', filters: [{ field: 'id', op: 'eq', value: 'x' }] }), /retained/);
});

test('selection returns only requested fields', async () => {
  const db = { execute: async () => [[{ data: { id: '1', name: 'Alice', mobile: '9999999999' } }]] };
  const result = await executeRecords(db, { table: 'leads', select: 'id, name', limit: 1 });
  assert.deepEqual(result.data, [{ id: '1', name: 'Alice' }]);
});
