import test from 'node:test';
import assert from 'node:assert/strict';
import { retryApiConfig, retryInboundDelivery } from './retry.mjs';

const batchId = '5fcce38a-97ba-4f97-a457-d8ab5fd73173';
const inboundId = '303670cf-d907-4d52-afb7-876935cb2a3a';

test('university retry requires a failed lead linked to that incoming submission', async () => {
  await assert.rejects(retryInboundDelivery({ db: {}, batchId: 'bad' }), (error) => error.status === 400);
  const db = { execute: async (_sql, values) => {
    if (values[0] === 'leads') return [[{ data: { id: inboundId, batch_id: batchId,
      status: 'Fail', extra_data: { inbound_lead_id: inboundId } } }]];
    return [[{ data: { id: inboundId, batch_ids: [] } }]];
  } };
  await assert.rejects(retryInboundDelivery({ db, batchId }), (error) => error.status === 404);
});

test('repeat retry keeps the original destination field mapping', async () => {
  const parent = { id: inboundId, batch_id: batchId, extra_data: { lead_index: 0 } };
  const retry = { batch_id: 'd761817d-acba-4aad-bd2f-f173502996d7', extra_data: { retry_of: inboundId } };
  const mapping = { columnMapping: { mobile: 'CandidateMobile' } };
  const db = { execute: async (sql, values) => {
    if (sql.startsWith('SELECT task')) return [values[0] === batchId ? [{ task: { apiConfig: mapping } }] : []];
    return [[{ data: parent }]];
  } };
  assert.deepEqual(await retryApiConfig(db, retry), mapping);
});
