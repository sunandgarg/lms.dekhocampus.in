import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testApi } from './test-integrations.mjs';

test('integration test sends the supplied sample lead and reports its status', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  const writes = [];
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { status: 200, ok: true, text: async () => '{"success":true}' };
  };
  try {
    const result = await testApi({ apiUrl: 'https://partner.example.com/leads',
      leadData: { name: 'Sample Student', email: 'sample@example.com', mobile: '9999999999' } },
      { s3: { send: async (command) => { writes.push(command.input); return {}; } }, bucket: 'test-archive' });
    assert.equal(result.status, 'Success');
    assert.match(JSON.stringify(body), /sample@example.com/);
    assert.equal(writes.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});
