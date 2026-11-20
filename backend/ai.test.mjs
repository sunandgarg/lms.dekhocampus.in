import test from 'node:test';
import assert from 'node:assert/strict';
import { aiGateway } from './ai.mjs';

test('lead scoring and enrollment prediction return bounded results', () => {
  const scored = aiGateway({ action: 'score_lead', data: { lead: {
    email: 'student@school.ac.in', mobile: '9876543210', course: 'MBA', city: 'Mumbai', state: 'MH', source: 'Google',
  } } });
  assert.equal(scored.score, 100);
  assert.equal(scored.quality, 'hot');
  const predicted = aiGateway({ action: 'predict_enrollment', data: { contacts: [{ id: '1', name: 'A', lead_score: 90,
    activities_count: 8, email_opens: 4, stage: 'qualified' }] } });
  assert.equal(predicted.predictions[0].probability, 95);
});
