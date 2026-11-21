import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activateScheduledBatches, applyDeliveryResult, claimNext, controlBatch, sealQueue } from './queue.mjs';

test('25 consecutive failures pause a batch; a success resets the streak', () => {
  const batch = { status: 'processing', is_paused: false };
  for (let index = 0; index < 24; index++) applyDeliveryResult(batch, { status: 'Fail' });
  assert.equal(batch.status, 'processing');
  applyDeliveryResult(batch, { status: 'Success' });
  assert.equal(batch.consecutive_fail_count, 0);
  for (let index = 0; index < 25; index++) applyDeliveryResult(batch, { status: 'Fail' });
  assert.equal(batch.status, 'paused');
  assert.equal(batch.is_paused, true);
  assert.match(batch.safety_pause_reason, /25 leads failed/);
});

test('a duplicate also resets the consecutive failure streak', () => {
  const batch = { status: 'processing', is_paused: false };
  for (let index = 0; index < 24; index++) applyDeliveryResult(batch, { status: 'Fail' });
  applyDeliveryResult(batch, { status: 'Duplicate' });
  assert.equal(batch.consecutive_fail_count, 0);
  applyDeliveryResult(batch, { status: 'Fail' });
  assert.equal(batch.status, 'processing');
  assert.equal(batch.consecutive_fail_count, 1);
});

test('safety pause requires a discussion name before continuing', async () => {
  const batch = { status: 'paused', is_paused: true, safety_pause_reason: '25 leads failed', consecutive_fail_count: 25, total_leads: 1 };
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    release: () => {}, execute: async (sql) => sql.includes('COUNT(*)') ? [[{ count: 1 }]] : sql.startsWith('SELECT') ? [[{ data: batch }]] : [[]] };
  const db = { getConnection: async () => connection };
  await assert.rejects(controlBatch(db, 'batch-1', 'continue'), /discussed/);
  await controlBatch(db, 'batch-1', 'continue', 'Operations manager');
  assert.equal(batch.status, 'processing');
  assert.equal(batch.safety_pause_reason, null);
  assert.equal(batch.consecutive_fail_count, 0);
  assert.equal(batch.discussion_with, 'Operations manager');
});

test('a partially uploaded batch cannot resume and silently drop unsaved leads', async () => {
  const batch = { status: 'paused', is_paused: true, total_leads: 2010 };
  const connection = { beginTransaction: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql) => sql.includes('COUNT(*)') ? [[{ count: 920 }]] : [[{ data: batch }]] };
  await assert.rejects(controlBatch({ getConnection: async () => connection }, 'batch-1', 'continue'), /920 of 2010/);
  assert.equal(batch.status, 'paused');
});

test('sealed future batches stay scheduled until the server activates them', async () => {
  const batch = { status: 'uploading', total_leads: 1, scheduled_at: new Date(Date.now() + 60_000).toISOString() };
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql) => sql.includes('COUNT(*)') ? [[{ count: 1 }]] : sql.startsWith('SELECT') ? [[{ data: batch }]] : [[]] };
  const result = await sealQueue({ getConnection: async () => connection }, 'batch-1');
  assert.equal(result.status, 'scheduled');
  const db = { execute: async (sql) => sql.startsWith('SELECT') ? [[{ id: 'batch-1', data: batch }]] : [{ affectedRows: 1 }] };
  assert.equal(await activateScheduledBatches(db, Date.now()), 0);
  assert.equal(await activateScheduledBatches(db, Date.now() + 120_000), 1);
});

test('queue claim reserves the next send according to the batch rate', async () => {
  const batch = { status: 'processing', leads_per_minute: 30 };
  const item = { batch_id: 'batch-1', lead_index: 0, task: {}, batch };
  let saved;
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async () => [[item]], execute: async (sql, params) => { if (sql.startsWith('UPDATE lms_records')) saved = JSON.parse(params[0]); return [[]]; } };
  const before = Date.now();
  await claimNext({ getConnection: async () => connection });
  assert.ok(saved.next_send_at_ms >= before + 2000);
  assert.ok(saved.next_send_at_ms <= Date.now() + 2000);
});
