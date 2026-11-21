import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDeliveryResult, controlBatch } from './queue.mjs';

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

test('safety pause requires a discussion name before continuing', async () => {
  const batch = { status: 'paused', is_paused: true, safety_pause_reason: '25 leads failed', consecutive_fail_count: 25, total_leads: 1 };
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    release: () => {}, execute: async (sql) => sql.includes('COUNT(*)') ? [[{ count: 1 }]] : sql.startsWith('SELECT') ? [[{ data: batch }]] : [[]] };
  const db = { getConnection: async () => connection };
  await assert.rejects(controlBatch(db, 'batch-1', 'continue'), /discussed/);
  await controlBatch(db, 'batch-1', 'continue', 'Operations manager');
  assert.equal(batch.status, 'processing');
  assert.equal(batch.safety_pause_reason, null);
  assert.equal(batch.discussion_with, 'Operations manager');
});

test('a partially uploaded batch cannot resume and silently drop unsaved leads', async () => {
  const batch = { status: 'paused', is_paused: true, total_leads: 2010 };
  const connection = { beginTransaction: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql) => sql.includes('COUNT(*)') ? [[{ count: 920 }]] : [[{ data: batch }]] };
  await assert.rejects(controlBatch({ getConnection: async () => connection }, 'batch-1', 'continue'), /920 of 2010/);
  assert.equal(batch.status, 'paused');
});
