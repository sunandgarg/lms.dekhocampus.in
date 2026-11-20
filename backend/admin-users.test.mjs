import test from 'node:test';
import assert from 'node:assert/strict';
import { manageUsers } from './admin-users.mjs';

test('ordinary admins cannot grant super admin access', async () => {
  await assert.rejects(manageUsers({}, { action: 'create_user', role: 'super_admin',
    email: 'new@example.com', password: 'long-secure-password' }, { id: 'admin', role: 'admin' }),
  (error) => error.status === 403);
});
