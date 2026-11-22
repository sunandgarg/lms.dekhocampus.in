import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskContactData, maskContactText, maskEmail, maskMobile } from './mask-contact.mjs';

test('contact masking keeps only the requested email and mobile edges', () => {
  assert.equal(maskEmail('sunandgarg@gmail.com'), 's******g@gmail.com');
  assert.equal(maskMobile('8700602524'), '8***4');
  assert.equal(maskMobile('+91 8700602524'), '8***4');
  assert.equal(maskContactText('Call +91 8700602524 or sunandgarg@gmail.com'), 'Call 8***4 or s******g@gmail.com');
});

test('nested lead data and partner responses are masked without changing names', () => {
  const data = { name: 'Sunand Garg', email: 'sunandgarg@gmail.com', mobile: '8700602524',
    extra_data: { original_mobile: '+91 8700602524', response: '{"phone":"8700602524"}' } };
  assert.deepEqual(maskContactData(data), { name: 'Sunand Garg', email: 's******g@gmail.com', mobile: '8***4',
    extra_data: { original_mobile: '8***4', response: '{"phone":"8***4"}' } });
});
