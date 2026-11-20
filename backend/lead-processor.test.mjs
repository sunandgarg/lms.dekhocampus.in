import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, categorizeResponse } from './lead-payload.mjs';
import { processLead } from './lead-processor.mjs';

const universityId = 'd761817d-acba-4aad-bd2f-f173502996d7';
const batchId = '5fcce38a-97ba-4f97-a457-d8ab5fd73173';
const userId = '303670cf-d907-4d52-afb7-876935cb2a3a';

test('partner mappings retain Meritto fields and auth values', () => {
  const { payload } = buildPayload(
    { name: 'Alice', email: 'alice@example.com', mobile: '9999999999', course: 'MBA' },
    { apiUrl: 'https://partner.example.com/leads', apiType: 'meritto', columnMapping: {},
      source: 'dc', medium: 'web', campaign: 'fall', collegeId: 'college-1', secretKey: 'secret' },
  );
  assert.equal(payload.college_id, 'college-1');
  assert.equal(payload.secret_key, 'secret');
  assert.equal(payload.course, 'MBA');
});

test('partner response classification preserves duplicate and success signals', () => {
  assert.equal(categorizeResponse(409, '{"message":"already exists"}', false), 'Duplicate');
  assert.equal(categorizeResponse(200, '{"success":true}', true), 'Success');
  assert.equal(categorizeResponse(200, '{"success":false}', true), 'Fail');
});

test('a failed S3 request archive prevents partner delivery', async () => {
  const university = { id: universityId, api_url: 'https://partner.example.com/leads', api_type: 'generic', column_mapping: {} };
  const calls = [];
  const connection = {
    beginTransaction: async () => {}, rollback: async () => {}, release: () => {},
    execute: async () => [[]],
  };
  const db = {
    execute: async (sql, values) => {
      calls.push(sql);
      if (sql.includes('SELECT data FROM lms_records') && values?.[0] === 'universities') return [[{ data: university }]];
      return [[]];
    },
    getConnection: async () => connection,
  };
  const originalFetch = globalThis.fetch;
  let partnerCalled = false;
  globalThis.fetch = async () => { partnerCalled = true; throw new Error('Should not send'); };
  try {
    await assert.rejects(processLead({ db, s3: { send: async () => { throw new Error('S3 unavailable'); } },
      bucket: 'test-bucket', userId,
      task: { universityId, batchId, leadData: { name: 'Alice', email: 'alice@example.com', mobile: '9999999999' } },
    }), (error) => error.archiveFailed === 'request' && error.status === 503);
    assert.equal(partnerCalled, false);
    assert.ok(!calls.some((sql) => sql.includes('INSERT INTO lms_transactions')));
  } finally { globalThis.fetch = originalFetch; }
});
