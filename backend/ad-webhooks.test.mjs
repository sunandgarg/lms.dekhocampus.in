import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { googleLeads, metaLeads, metaSecretForPage, metaTokenForPage, verifyMetaSignature } from './ad-webhooks.mjs';
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
  const oldPage = process.env.META_PAGE_ID;
  const oldFetch = globalThis.fetch;
  process.env.META_ACCESS_TOKEN = 'test-token';
  process.env.META_PAGE_ID = '1234567890';
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
    const [lead] = await metaLeads({ entry: [{ id: '1234567890', changes: [{ field: 'leadgen', value: {
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
    if (oldPage === undefined) delete process.env.META_PAGE_ID;
    else process.env.META_PAGE_ID = oldPage;
  }
});

test('Meta selects a separate token for each authorized Page', () => {
  const oldPage = process.env.META_PAGE_ID;
  const oldToken = process.env.META_ACCESS_TOKEN;
  const oldTokens = process.env.META_PAGE_TOKENS;
  try {
    process.env.META_PAGE_ID = '1234567890';
    process.env.META_ACCESS_TOKEN = 'existing-page-token';
    process.env.META_PAGE_TOKENS = '{"950588674803179":"my-college-apply-token"}';
    assert.equal(metaTokenForPage('1234567890'), 'existing-page-token');
    assert.equal(metaTokenForPage('950588674803179'), 'my-college-apply-token');
    assert.equal(metaTokenForPage('9999999999'), '');
  } finally {
    if (oldPage === undefined) delete process.env.META_PAGE_ID; else process.env.META_PAGE_ID = oldPage;
    if (oldToken === undefined) delete process.env.META_ACCESS_TOKEN; else process.env.META_ACCESS_TOKEN = oldToken;
    if (oldTokens === undefined) delete process.env.META_PAGE_TOKENS; else process.env.META_PAGE_TOKENS = oldTokens;
  }
});

test('Meta selects a separate app secret for the other Page', () => {
  const previous = process.env.META_PAGE_APP_SECRETS;
  try {
    process.env.META_PAGE_APP_SECRETS = '{"950588674803179":"my-college-app-secret"}';
    assert.equal(metaSecretForPage('950588674803179'), 'my-college-app-secret');
    assert.equal(metaSecretForPage('9999999999'), '');
  } finally {
    if (previous === undefined) delete process.env.META_PAGE_APP_SECRETS;
    else process.env.META_PAGE_APP_SECRETS = previous;
  }
});

test('Meta fetches another Page’s lead with that Page’s token', async () => {
  const oldTokens = process.env.META_PAGE_TOKENS;
  const oldFetch = globalThis.fetch;
  const authorizations = [];
  process.env.META_PAGE_TOKENS = '{"950588674803179":"my-college-apply-token"}';
  globalThis.fetch = async (_url, options) => {
    authorizations.push(options.headers.Authorization);
    return { ok: true, json: async () => authorizations.length === 1
      ? { field_data: [{ name: 'email', values: ['student@example.com'] }], ad_id: '1234567890' }
      : { campaign: { name: 'Online_Amity_Video_Ads_21Nov' } } };
  };
  try {
    const [lead] = await metaLeads({ entry: [{ id: '950588674803179', changes: [
      { field: 'leadgen', value: { leadgen_id: '3456789012' } },
    ] }] });
    assert.equal(lead.meta_page_id, '950588674803179');
    assert.equal(lead.campaign, 'Online_Amity_Video_Ads_21Nov');
    assert.deepEqual(authorizations, ['Bearer my-college-apply-token', 'Bearer my-college-apply-token']);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldTokens === undefined) delete process.env.META_PAGE_TOKENS;
    else process.env.META_PAGE_TOKENS = oldTokens;
  }
});

test('Meta reports an expired Page token as a reconnect error', async () => {
  const oldTokens = process.env.META_PAGE_TOKENS;
  const oldFetch = globalThis.fetch;
  process.env.META_PAGE_TOKENS = '{"950588674803179":"expired-token"}';
  globalThis.fetch = async () => ({ ok: false, status: 401,
    json: async () => ({ error: { code: 190, message: 'Session expired' } }) });
  try {
    await assert.rejects(metaLeads({ entry: [{ id: '950588674803179', changes: [
      { field: 'leadgen', value: { leadgen_id: '3456789012' } },
    ] }] }), /access token expired; reconnect this Page/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldTokens === undefined) delete process.env.META_PAGE_TOKENS;
    else process.env.META_PAGE_TOKENS = oldTokens;
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
