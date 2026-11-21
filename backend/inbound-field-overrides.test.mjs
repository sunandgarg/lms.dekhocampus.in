import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInboundFieldOverrides, mergePartnerMapping, redactPartnerMapping } from './inbound-field-overrides.mjs';
import { buildPayload } from './lead-payload.mjs';

const mapping = {
  __field_course: JSON.stringify({ fieldName: 'program', sourceType: 'lead_data', sourceKey: 'course' }),
  __field_campus: JSON.stringify({ fieldName: 'campus', sourceType: 'static', staticValue: 'Noida' }),
  __field_secret: JSON.stringify({ fieldName: 'secret_key', sourceType: 'dynamic', dynamicType: 'secret_key' }),
};
const university = { column_mapping: mapping };
const rules = { defaults: [{ targetField: 'program', value: 'MBA' }, { targetField: 'campus', value: 'Greater Noida' }],
  transforms: [{ sourceField: 'city', equals: 'Delhi', targetField: 'program', value: 'BBA' }] };

test('route field values use a condition, then a fallback, without changing the university', () => {
  const first = { name: 'A', city: 'Delhi', course: '', email: 'a@example.com' };
  const changed = applyInboundFieldOverrides(first, first, university, rules);
  const config = { apiType: 'generic', columnMapping: changed.columnMapping, universityDefaults: {} };
  assert.equal(buildPayload(first, config).payload.program, 'BBA');
  assert.equal(buildPayload(first, config).payload.campus, 'Greater Noida');
  assert.equal(JSON.parse(mapping.__field_campus).staticValue, 'Noida');
  const second = { ...first, city: 'Mumbai', course: 'BTech' };
  const secondConfig = applyInboundFieldOverrides(second, second, university, rules);
  assert.equal(buildPayload(second, { ...config, columnMapping: secondConfig.columnMapping }).payload.program, 'BTech');
});

test('route overrides cannot create new partner fields or replace credentials', () => {
  const lead = { name: 'A' };
  const changed = applyInboundFieldOverrides(lead, lead, university, { defaults: [
    { targetField: 'secret_key', value: 'wrong' }, { targetField: 'arbitrary', value: 'wrong' },
  ] });
  assert.equal(changed, null);
});

test('a route can correct one incoming field mapping without changing the integration', () => {
  const configured = { column_mapping: {
    __field_mobile: JSON.stringify({ fieldName: 'CandidateMobile', sourceType: 'lead_data', sourceKey: 'city' }),
  } };
  const lead = { city: 'Delhi', mobile: '9876543210' };
  const changed = applyInboundFieldOverrides(lead, lead, configured, {
    sources: [{ targetField: 'CandidateMobile', sourceField: 'mobile' }],
  });
  assert.equal(buildPayload(lead, { apiType: 'generic', columnMapping: changed.columnMapping }).payload.CandidateMobile, '9876543210');
  assert.equal(JSON.parse(configured.column_mapping.__field_mobile).sourceKey, 'city');
});

test('an empty equals value matches blank or missing incoming fields only', () => {
  const settings = { transforms: [{ sourceField: 'state', equals: '', targetField: 'program', value: 'Unknown state' }] };
  for (const lead of [{ state: '' }, { state: '  ' }, {}]) {
    const changed = applyInboundFieldOverrides(lead, lead, university, settings);
    assert.equal(JSON.parse(changed.columnMapping.__field_course).staticValue, 'Unknown state');
  }
  assert.equal(applyInboundFieldOverrides({ state: 'Delhi' }, { state: 'Delhi' }, university, settings), null);
});

test('All Leads Medium column uses the normalized incoming lead medium', () => {
  const lead = { leadMedium: 'paid' };
  const changed = applyInboundFieldOverrides(lead, lead, university, {
    transforms: [{ sourceField: 'leadMedium', equals: 'paid', targetField: 'program', value: 'Paid campaign' }],
  });
  assert.equal(JSON.parse(changed.columnMapping.__field_course).staticValue, 'Paid campaign');
});

test('partner credentials stay hidden from team configuration while delivery retains them', () => {
  const stored = { __static_AccessKey: 'private', __field_key: JSON.stringify({ fieldName: 'AccessKey', sourceType: 'static', staticValue: 'private' }) };
  const visible = redactPartnerMapping(stored);
  assert.equal(visible.__static_AccessKey, '');
  assert.equal(JSON.parse(visible.__field_key).staticValue, '');
  const merged = mergePartnerMapping(stored, visible);
  assert.equal(merged.__static_AccessKey, 'private');
  assert.equal(JSON.parse(merged.__field_key).staticValue, 'private');
});
