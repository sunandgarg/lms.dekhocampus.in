import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGenericLead } from './generic-inbound.mjs';

test('generic lead maps nested provider fields and preserves the source', () => {
  const { lead, leadData } = normalizeGenericLead({ lead: {
    contact: { fullName: 'Jane Doe', emailAddress: 'jane@example.com', phone: '+919876543210' },
    campaign: 'Winter Ads', custom_code: 'A1',
  } }, { source_label: 'Paid Ads', field_map: {
    name: 'contact.fullName', email: 'contact.emailAddress', mobile: 'contact.phone',
  } });
  assert.equal(lead.name, 'Jane Doe');
  assert.equal(lead.email, 'jane@example.com');
  assert.equal(lead.mobile, '+919876543210');
  assert.equal(leadData.leadSource, 'Paid Ads');
  assert.equal(leadData.custom_code, 'A1');
});

test('generic lead requires a usable contact and does not copy credentials', () => {
  assert.throws(() => normalizeGenericLead({ name: 'No Contact' }, { source_label: 'API' }), /Email or mobile/);
  const { leadData } = normalizeGenericLead({ phone: '9876543210', api_key: 'private' }, { source_label: 'API' });
  assert.equal(leadData.name, 'Unnamed Lead');
  assert.equal(leadData.api_key, undefined);
});
