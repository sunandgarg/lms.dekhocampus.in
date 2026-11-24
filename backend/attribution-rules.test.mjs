import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyAttributionRules } from './attribution-rules.mjs';

test('rewrites matched incoming attribution for storage and delivery', () => {
  const lead = { source: 'Facebook Leads', campaign: 'Original ad' };
  const leadData = { leadSource: lead.source, leadMedium: 'Paid', leadCampaign: lead.campaign };
  applyAttributionRules(lead, leadData, [{ enabled: true,
    match: { source: 'facebook leads', medium: 'paid', campaign: '' },
    set: { source: 'Meta', medium: 'CPC', campaign: 'Admissions 2026' } }]);
  assert.deepEqual(lead, { source: 'Meta', campaign: 'Admissions 2026' });
  assert.equal(leadData.leadSource, 'Meta');
  assert.equal(leadData.leadMedium, 'CPC');
  assert.equal(leadData.leadCampaign, 'Admissions 2026');
});

test('ignores empty and unmatched rules and applies only the first match', () => {
  const lead = { source: 'Google', campaign: 'Original' };
  const leadData = { leadSource: 'Google', leadMedium: 'organic', leadCampaign: 'Original' };
  applyAttributionRules(lead, leadData, [
    { match: {}, set: { source: 'Wrong' } },
    { match: { source: 'Facebook' }, set: { source: 'Wrong' } },
    { match: { source: 'Google' }, set: { campaign: 'Search' } },
    { match: { source: 'Google' }, set: { campaign: 'Wrong' } },
  ]);
  assert.deepEqual(lead, { source: 'Google', campaign: 'Search' });
  assert.equal(leadData.leadCampaign, 'Search');
});
