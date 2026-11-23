import test from 'node:test';
import assert from 'node:assert/strict';
import { reportRange, universityDeliveryReport } from './university-delivery-report.mjs';

test('report dates include the complete selected India day', () => {
  assert.deepEqual(reportRange('2026-11-23', '2026-11-23'),
    ['2026-11-22 18:30:00.000', '2026-11-23 18:30:00.000']);
  assert.throws(() => reportRange('2026-02-30', '2026-03-01'), /valid report date/);
  assert.throws(() => reportRange('2026-11-24', '2026-11-23'), /date range/);
});

test('report returns aggregate counts without lead contact fields', async () => {
  let parameters;
  const db = { execute: async (_sql, values) => {
    parameters = values;
    return [[{ university: 'Amity Noida', university_id: 'id', total: 30,
      success: 10, duplicate: 10, failed: 10 }]];
  } };
  const report = await universityDeliveryReport(db, { from: '2026-11-23', to: '2026-11-23' });
  assert.deepEqual(parameters, ['2026-11-22 18:30:00.000', '2026-11-23 18:30:00.000']);
  assert.deepEqual(report.rows[0], { university: 'Amity Noida', university_id: 'id', total: 30,
    success: 10, duplicate: 10, failed: 10, pending: 0 });
});
