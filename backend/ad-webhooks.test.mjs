import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { googleLeads, verifyMetaSignature } from './ad-webhooks.mjs';
import { normalizeGenericLead } from './generic-inbound.mjs';

test('Meta webhook signature authenticates the exact request bytes', () => {
  const body = Buffer.from('{"object":"page","entry":[]}');
  const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, signature, 'test-secret'), true);
  assert.equal(verifyMetaSignature(Buffer.from('{}'), signature, 'test-secret'), false);
  assert.equal(verifyMetaSignature(body, signature, ''), false);
});

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

test('ad webhook keeps a usable email when the provider phone is invalid', () => {
  const [lead] = googleLeads({ lead_id: 'test-456', user_column_data: [
    { column_id: 'EMAIL', string_value: 'student@example.com' },
    { column_id: 'PHONE_NUMBER', string_value: 'test phone' },
  ] }, 'google');
  assert.equal(lead.email, 'student@example.com');
  assert.equal(lead.mobile, '');
  assert.equal(lead.phone_number, undefined);
  assert.equal(normalizeGenericLead({ lead }, { field_map: {}, source_label: 'Google Ads' }).lead.mobile, '');
});
