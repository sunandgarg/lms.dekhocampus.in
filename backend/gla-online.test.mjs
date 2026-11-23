import test from 'node:test';
import assert from 'node:assert/strict';
import { glaOnlinePayload, glaOnlineRequest, GLA_ONLINE_ENDPOINT } from './gla-online.mjs';
import { categorizeResponse } from './lead-payload.mjs';

test('GLA Online maps MBA Human Resource Management to the supplied program code', () => {
  const payload = glaOnlinePayload({ name: 'Test Lead', dob: '2000-07-12', email: 'test@example.com',
    mobile: '+91 9899158166', course: 'MBA', specialization: 'Human Resource Management', city: 'Noida' });
  assert.deepEqual(payload, { Name: 'Test Lead', DOB: '12/07/2000', EmailId: 'test@example.com',
    Mobile: '9899158166', ProgramCode: 'OGLAMBA202', source: 'dekho_campus', City: '0' });
  const request = glaOnlineRequest(GLA_ONLINE_ENDPOINT, payload);
  assert.equal(request.method, 'GET');
  assert.equal(request.body, null);
  assert.equal(new URL(request.url).searchParams.get('ProgramCode'), 'OGLAMBA202');
  assert.equal(new URL(request.url).searchParams.get('DOB'), '12/07/2000');
});

test('GLA Online refuses unknown programs and embedded sample-lead parameters', () => {
  assert.equal(glaOnlinePayload({ name: 'Test', dob: '12/07/2000', email: 'test@example.com',
    mobile: '9899158166', course: 'MCA' }).ProgramCode, 'OGLAMCA201');
  assert.throws(() => glaOnlinePayload({ name: 'Test', dob: '12/07/2000', email: 'test@example.com',
    mobile: '9899158166', course: 'MBA' }), /ProgramCode/);
  assert.throws(() => glaOnlineRequest(`${GLA_ONLINE_ENDPOINT}?Name=Test`, {}), /without test-lead/);
});

test('GLA Online duplicate response is not counted as success', () => {
  assert.equal(categorizeResponse(200, '"Email Id or Mobile No already registered, please check and try again"', true), 'Duplicate');
});
