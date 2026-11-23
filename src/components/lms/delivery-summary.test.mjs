import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDeliveries } from './delivery-summary.ts';

test('delivery battery counts the latest result once per university', () => {
  const amity = { id: 'a2', status: 'completed', fail_count: 1, universities: { name: 'Amity Noida' } };
  const lpu = { id: 'l1', status: 'completed', success_count: 1, universities: { name: 'LPU' } };
  const oldAmity = { id: 'a1', status: 'completed', success_count: 1, universities: { name: 'Amity Noida' } };
  const result = summarizeDeliveries([{ deliveries: [amity, lpu] }, { deliveries: [oldAmity] }]);
  assert.deepEqual(result, { deliveries: [amity, lpu], pushed: 1, notPushed: 1, pending: 0 });
  assert.deepEqual(summarizeDeliveries([{ deliveries: [{ id: 'p', status: 'processing' }] }]).pending, 1);
  assert.deepEqual(summarizeDeliveries([{ deliveries: [{ id: 'paused', status: 'paused' }] }]).pending, 1);
});
