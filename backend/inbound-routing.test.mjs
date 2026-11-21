import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesInboundRule } from './inbound-routing.mjs';

const lead = { city: 'New Delhi', state: 'Delhi', course: 'MBA', source: 'Meta Ads' };

test('a rule without conditions routes every new lead', () => {
  assert.equal(matchesInboundRule({ conditions: [] }, lead, {}), true);
});

test('all and any conditions support city, state, and course', () => {
  const conditions = [
    { field: 'city', operator: 'contains', value: 'Delhi' },
    { field: 'course', operator: 'is', value: 'B.Tech' },
  ];
  assert.equal(matchesInboundRule({ conditions, match_mode: 'all' }, lead, {}), false);
  assert.equal(matchesInboundRule({ conditions, match_mode: 'any' }, lead, {}), true);
});

test('a rule can match a custom nested incoming field', () => {
  const rule = { conditions: [{ field: 'ad.setName', operator: 'starts_with', value: 'Summer' }] };
  assert.equal(matchesInboundRule(rule, lead, { lead: { ad: { setName: 'Summer 2026' } } }), true);
});

test('an incomplete or invalid condition never matches', () => {
  assert.equal(matchesInboundRule({ conditions: [{ field: 'city', operator: 'contains', value: '' }] }, lead, {}), false);
  assert.equal(matchesInboundRule({ conditions: [{ field: 'city', operator: 'bogus', value: 'Delhi' }] }, lead, {}), false);
});
