import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { googleLeads, metaLeads, verifyMetaSignature } from './ad-webhooks.mjs';
import { normalizeGenericLead } from './generic-inbound.mjs';

test('Meta webhook signature authenticates the exact request bytes', () => {
  const body = Buffer.from('{"object":"page","entry":[]}');
  const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, signature, 'test-secret'), true);
  assert.equal(verifyMetaSignature(Buffer.from('{}'), signature, 'test-secret'), false);
  assert.equal(verifyMetaSignature(body, signature, ''), false);
});

test('Meta lead uses the ad campaign name, not the ad name', async () => {
  const oldToken = process.env.META_ACCESS_TOKEN;
  const oldFetch = globalThis.fetch;
  process.env.META_ACCESS_TOKEN = 'test-token';
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => requests.length === 1
      ? { ad_id: '1234567890', campaign_id: '2345678901', field_data: [
          { name: 'full_name', values: ['Test Student'] }, { name: 'email', values: ['test@example.com'] },
        ] }
      : { campaign: { id: '2345678901', name: 'JEE_MAIN_2027_Session-1' } } };
  };
  try {
    const [lead] = await metaLeads({ entry: [{ changes: [{ field: 'leadgen', value: {
      leadgen_id: '3456789012', ad_id: '1234567890', ad_name: 'Wrong Ad Name',
    } }] }] });
    assert.equal(lead.campaign, 'JEE_MAIN_2027_Session-1');
    assert.equal(lead.campaign_id, '2345678901');
    assert.equal(lead.leadSource, 'Facebook Lead Ads');
    assert.equal(lead.leadMedium, 'paid');
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = oldToken;
  }
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
