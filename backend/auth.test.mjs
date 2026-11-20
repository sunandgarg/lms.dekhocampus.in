import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, readCookie, sessionCookie, clearSessionCookie } from './auth.mjs';

test('password hashes are salted and verified', async () => {
  const first = await hashPassword('a-long-test-password');
  const second = await hashPassword('a-long-test-password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('a-long-test-password', first), true);
  assert.equal(await verifyPassword('incorrect-password', first), false);
  assert.equal(await verifyPassword('a-long-test-password', 'bad-hash'), false);
});

test('session cookie is secure and HTTP only', () => {
  const cookie = sessionCookie('test-token');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(readCookie({ headers: { cookie: 'other=1; lms_session=test-token; another=2' } }), 'test-token');
  assert.match(clearSessionCookie(), /Max-Age=0/);
});
