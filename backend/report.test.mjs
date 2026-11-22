import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchReport } from './report.mjs';

test('downloadable lead reports do not execute spreadsheet formulas', async () => {
  const db = { execute: async () => [[{ data: {
    id: 'lead-1', name: '=HYPERLINK("https://bad.example")', email: 'a@example.com',
    mobile: '+1234567890', university_id: 'uni-1', status: 'Success',
    processed_at: '2026-11-21', api_response: '@SUM(1,1)', extra_data: { 'preferred campus': 'Noida' },
  } }]] };
  const chunks = [];
  for await (const chunk of batchReport(db, 'batch-1')) chunks.push(chunk);
  const report = chunks.join('');
  assert.match(report, /"'=HYPERLINK/);
  assert.match(report, /"'\+1234567890"/);
  assert.match(report, /"'@SUM/);
  assert.match(report, /"preferred campus","delivery_status","status_color"/);
  assert.match(report, /"Noida","Success","Green"/);
});

test('team response CSV masks contact fields and nested extras while admin CSV stays complete', async () => {
  const db = { execute: async () => [[{ data: {
    id: 'lead-1', name: 'Sunand Garg', email: 'sunandgarg@gmail.com', mobile: '8700602524',
    extra_data: { original_mobile: '+91 8700602524' }, status: 'Success',
    api_response: 'Saved sunandgarg@gmail.com',
  } }]] };
  const masked = [];
  for await (const chunk of batchReport(db, 'batch-1', { masked: true })) masked.push(chunk);
  const report = masked.join('');
  assert.match(report, /s\*\*\*\*\*\*g@gmail\.com/);
  assert.match(report, /8\*\*\*4/);
  assert.doesNotMatch(report, /8700602524|sunandgarg@gmail\.com/);
  const full = [];
  for await (const chunk of batchReport(db, 'batch-1')) full.push(chunk);
  assert.match(full.join(''), /8700602524/);
});

test('team response CSV masks phone columns even when their numbers use another format', async () => {
  const db = { execute: async () => [[{ data: {
    id: 'lead-2', name: 'Example Lead', mobile: '+1 202 555 0188',
    extra_data: { alternate_phone: '0123456789' }, status: 'Success',
  } }]] };
  const chunks = [];
  for await (const chunk of batchReport(db, 'batch-2', { masked: true })) chunks.push(chunk);
  const report = chunks.join('');
  assert.match(report, /2\*\*\*8/);
  assert.match(report, /0\*\*\*9/);
  assert.doesNotMatch(report, /202 555 0188|0123456789/);
});
