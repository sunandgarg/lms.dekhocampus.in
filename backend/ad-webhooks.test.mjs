import test from 'node:test';
import assert from 'node:assert/strict';
import { googleLeads } from './ad-webhooks.mjs';

test('Google Ads published webhook shape accepts name and phone without email', () => {
  const leads = googleLeads({ lead_id: 'google-123', campaign_id: 42, is_test: true,
    user_column_data: [
      { column_id: 'FULL_NAME', string_value: 'Test Student' },
      { column_id: 'PHONE_NUMBER', string_value: '+919876543210' },
      { column_id: 'COURSE', string_value: 'MBA' },
    ] }, 'google');
  assert.equal(leads[0].name, 'Test Student');
  assert.equal(leads[0].mobile, '+919876543210');
  assert.equal(leads[0].email, '');
  assert.equal(leads[0].course, 'MBA');
  assert.equal(leads[0].external_id, 'google-123');
});
