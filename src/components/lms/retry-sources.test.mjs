import test from 'node:test';
import assert from 'node:assert/strict';
import { retrySources } from './retry-sources.ts';

test('a large selection only checks deliveries with failures, including partial batches', () => {
  const selected = Array.from({ length: 10_000 }, (_, index) => ({
    id: `incoming-${index}`, isInbound: true, status: 'Received',
    deliveries: [{ id: `batch-${index}`, status: 'completed',
      success_count: index < 5 ? 9995 : 1, fail_count: index < 5 ? 5 : 0 }],
  }));
  const result = retrySources(selected);
  assert.equal(result.directIds.length, 0);
  assert.deepEqual(result.batchIds, ['batch-0', 'batch-1', 'batch-2', 'batch-3', 'batch-4']);
});

test('direct failed lead and a chosen university batch stay separate', () => {
  const selected = [{ id: 'failed-lead', status: 'Failed', deliveries: [] }];
  assert.deepEqual(retrySources(selected), { directIds: ['failed-lead'], batchIds: [] });
  assert.deepEqual(retrySources(selected, 'chosen-batch'), { directIds: [], batchIds: ['chosen-batch'] });
});
