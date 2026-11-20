import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchReport } from './report.mjs';

test('downloadable lead reports do not execute spreadsheet formulas', async () => {
  const db = { execute: async () => [[{ data: {
    id: 'lead-1', name: '=HYPERLINK("https://bad.example")', email: 'a@example.com',
    mobile: '+1234567890', university_id: 'uni-1', status: 'Success',
    processed_at: '2026-11-21', api_response: '@SUM(1,1)',
  } }]] };
  const chunks = [];
  for await (const chunk of batchReport(db, 'batch-1')) chunks.push(chunk);
  const report = chunks.join('');
  assert.match(report, /"'=HYPERLINK/);
  assert.match(report, /"'\+1234567890"/);
  assert.match(report, /"'@SUM/);
});
