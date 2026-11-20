import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statsDelta } from './stats.mjs';

test('lead rollups distinguish attempted sends from blocked and cancelled leads', () => {
  assert.deepEqual(statsDelta('Success'), { pushed: 1, field: 'success' });
  assert.deepEqual(statsDelta('Duplicate'), { pushed: 1, field: 'duplicate' });
  assert.deepEqual(statsDelta('Fail'), { pushed: 1, field: 'failed' });
  assert.deepEqual(statsDelta('DLL_Blocked'), { pushed: 0, field: 'dll_blocked' });
  assert.equal(statsDelta('Cancelled'), null);
});
