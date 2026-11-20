import { createUser, hashPassword } from './auth.mjs';
import { executeRecords } from './records.mjs';

const ROLES = new Set(['super_admin', 'admin', 'user']);

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function mirrorProfile(db, user, extra = {}) {
  const value = {
    id: user.id, email: user.email, full_name: user.full_name || null,
    role: user.role, is_approved: Boolean(user.is_approved),
    last_sign_in_at: user.last_sign_in_at || null,
    ...extra,
  };
  const { data } = await executeRecords(db, { table: 'profiles', select: 'id', filters: [{ field: 'id', op: 'eq', value: user.id }], single: true });
  if (data) await executeRecords(db, { table: 'profiles', action: 'update', values: value, filters: [{ field: 'id', op: 'eq', value: user.id }] });
  else await executeRecords(db, { table: 'profiles', action: 'insert', values: value });
}

async function userById(db, id) {
  const [rows] = await db.execute('SELECT id, email, full_name, role, is_approved, created_at, last_sign_in_at FROM lms_users WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw invalid('User not found');
  return rows[0];
}

async function setRoleRecord(db, userId, role) {
  await executeRecords(db, { table: 'user_roles', action: 'delete', filters: [{ field: 'user_id', op: 'eq', value: userId }] });
  await executeRecords(db, { table: 'user_roles', action: 'insert', values: { user_id: userId, role } });
}

export async function manageUsers(db, input, actor) {
  const action = input?.action;
  if (!action) throw invalid('Action required');

  if (action === 'list_users') {
    const [users] = await db.execute('SELECT id, email, full_name, role, is_approved, created_at, last_sign_in_at FROM lms_users ORDER BY created_at DESC LIMIT 500');
    const { data: permissionRows } = await executeRecords(db, { table: 'user_permissions', select: '*' });
    return { users: users.map((user) => ({
      ...user,
      is_approved: Boolean(user.is_approved),
      roles: [user.role],
      permissions: permissionRows.filter((row) => row.user_id === user.id).map((row) => row.permission),
    })) };
  }

  if (action === 'create_user') {
    const role = input.role || 'user';
    if (!ROLES.has(role)) throw invalid('Invalid role');
    if (role !== 'user' && actor.role !== 'super_admin') throw Object.assign(new Error('Only a super admin can grant admin roles'), { status: 403 });
    const email = String(input.email || '').trim().toLowerCase();
    const [existing] = await db.execute('SELECT id FROM lms_users WHERE email = ? LIMIT 1', [email]);
    if (existing.length) throw invalid('A user with this email already exists');
    const id = await createUser(db, { email, password: input.password, fullName: input.full_name, role, approved: true });
    const user = await userById(db, id);
    await mirrorProfile(db, user, { approved_by: actor.id, approved_at: new Date().toISOString() });
    await setRoleRecord(db, id, role);
    return { created: true, user_id: id };
  }

  const id = String(input.user_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw invalid('Valid user ID required');
  const target = await userById(db, id);
  if (target.role === 'super_admin' && actor.role !== 'super_admin') {
    throw Object.assign(new Error('Only a super admin can manage this account'), { status: 403 });
  }

  if (action === 'approve_user' || action === 'revoke_user') {
    const approved = action === 'approve_user';
    if (!approved && id === actor.id) throw invalid('You cannot revoke your own access');
    await db.execute('UPDATE lms_users SET is_approved = ? WHERE id = ?', [approved, id]);
    if (!approved) await db.execute('DELETE FROM lms_sessions WHERE user_id = ?', [id]);
    target.is_approved = approved;
    await mirrorProfile(db, target, approved ? { approved_by: actor.id, approved_at: new Date().toISOString() } : { approved_by: null, approved_at: null });
    return { ok: true };
  }

  if (action === 'change_password') {
    const hash = await hashPassword(input.new_password);
    await db.execute('UPDATE lms_users SET password_hash = ? WHERE id = ?', [hash, id]);
    await db.execute('DELETE FROM lms_sessions WHERE user_id = ?', [id]);
    return { ok: true };
  }

  if (action === 'force_logout') {
    await db.execute('DELETE FROM lms_sessions WHERE user_id = ?', [id]);
    return { ok: true };
  }

  if (action === 'update_role') {
    const role = input.new_role;
    if (!ROLES.has(role)) throw invalid('Invalid role');
    if (role !== 'user' && actor.role !== 'super_admin') throw Object.assign(new Error('Only a super admin can grant admin roles'), { status: 403 });
    if (id === actor.id && role === 'user') throw invalid('You cannot remove your own admin role');
    await db.execute('UPDATE lms_users SET role = ? WHERE id = ?', [role, id]);
    target.role = role;
    await mirrorProfile(db, target);
    await setRoleRecord(db, id, role);
    return { ok: true };
  }

  if (action === 'update_permissions') {
    const permissions = input.permissions;
    if (!Array.isArray(permissions) || permissions.length > 100 || permissions.some((item) => typeof item !== 'string' || item.length > 80)) throw invalid('Invalid permissions');
    await executeRecords(db, { table: 'user_permissions', action: 'delete', filters: [{ field: 'user_id', op: 'eq', value: id }] });
    if (permissions.length) await executeRecords(db, { table: 'user_permissions', action: 'insert', values: permissions.map((permission) => ({ user_id: id, permission })) });
    return { ok: true };
  }

  throw invalid('Unknown user action');
}
