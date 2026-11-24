import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceReview, upsertSourceRule, validateSourceProposal } from './source-review.mjs';

test('team proposals require a source and do not publish without admin', async () => {
  assert.throws(() => validateSourceProposal({ source: '', medium: '', proposed_source: 'FB', proposed_medium: '', note: '' }), /Choose an incoming source/);
  assert.throws(() => validateSourceProposal({ source: 'Facebook', medium: '', proposed_source: '', proposed_medium: '', note: '' }), /Enter a source/);
  await assert.rejects(sourceReview({}, { id: 'user-1', role: 'user' }, { action: 'publish',
    source: 'Facebook', medium: 'paid', proposed_source: 'FB', proposed_medium: '', note: '' }),
  { status: 403 });
  await assert.rejects(sourceReview({}, { id: 'user-1', role: 'user' }, { action: 'approve',
    id: '00000000-0000-4000-8000-000000000000' }), { status: 403 });
});

test('admin approval replaces the matching source rule without touching other campaigns', () => {
  const rules = [
    { id: 'same', enabled: true, match: { source: 'Facebook Lead Ads', medium: 'paid', campaign: '' }, set: { source: 'old', medium: '', campaign: '' } },
    { id: 'specific', enabled: true, match: { source: 'Facebook Lead Ads', medium: 'paid', campaign: 'MBA' }, set: { source: 'MBA', medium: '', campaign: '' } },
  ];
  const updated = upsertSourceRule(rules, { source: 'facebook lead ads', medium: 'paid', proposed_source: 'Meta', proposed_medium: 'CPC' });
  assert.equal(updated.length, 2);
  assert.equal(updated[0].id, 'same');
  assert.deepEqual(updated[0].set, { source: 'Meta', medium: 'CPC', campaign: '' });
  assert.equal(updated[1], rules[1]);
});

test('source list exposes active incoming-to-LMS mappings and approved explanations to users', async () => {
  const db = { execute: async (sql) => {
    if (sql.includes('GROUP BY source')) return [[{ source: 'Meta', medium: 'paid', leads: 1 }]];
    if (sql.includes('FROM lms_source_reviews')) {
      assert.match(sql, /r.status = 'approved' OR r.user_id/);
      return [[{ source: 'fb', medium: 'paid', status: 'approved', note: 'Facebook form leads' }]];
    }
    return [[{ data: JSON.stringify({ value: JSON.stringify([
      { id: 'active', enabled: true, match: { source: 'fb', medium: 'paid' }, set: { source: 'Meta' } },
      { id: 'disabled', enabled: false, match: { source: 'old' }, set: { source: 'new' } },
    ]) }) }]];
  } };
  const result = await sourceReview(db, { id: 'user-1', role: 'user' }, { action: 'list' });
  assert.deepEqual(result.rules.map((rule) => rule.id), ['active']);
  assert.equal(result.reviews[0].note, 'Facebook form leads');
});
