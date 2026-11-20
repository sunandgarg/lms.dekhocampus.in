import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_AGE_SECONDS = 60 * 60 * 12;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Password must contain 12 to 1024 characters');
  }
  const salt = randomBytes(24);
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, saltHex, hashHex] = String(encoded || '').split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{48}$/.test(saltHex || '') || !/^[a-f0-9]{128}$/.test(hashHex || '')) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest();
}

export async function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  await db.execute(
    'INSERT INTO lms_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND))',
    [tokenHash(token), userId, SESSION_AGE_SECONDS],
  );
  return token;
}

export function sessionCookie(token, secure = true) {
  return `lms_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_AGE_SECONDS}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure = true) {
  return `lms_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readCookie(request) {
  const found = /(?:^|;\s*)lms_session=([^;]+)/.exec(request.headers.cookie || '');
  return found?.[1] || null;
}

export async function sessionUser(db, request) {
  const token = readCookie(request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [rows] = await db.execute(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_approved
     FROM lms_sessions s JOIN lms_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW(3) LIMIT 1`,
    [tokenHash(token)],
  );
  return rows[0] || null;
}

export async function signOut(db, request) {
  const token = readCookie(request);
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    await db.execute('DELETE FROM lms_sessions WHERE token_hash = ?', [tokenHash(token)]);
  }
}

export async function createUser(db, { email, password, fullName, role = 'user', approved = false }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Valid email required');
  if (!['super_admin', 'admin', 'user'].includes(role)) throw new Error('Invalid role');
  const id = randomUUID();
  await db.execute(
    'INSERT INTO lms_users (id, email, password_hash, full_name, role, is_approved) VALUES (?, ?, ?, ?, ?, ?)',
    [id, normalized, await hashPassword(password), fullName || null, role, approved],
  );
  return id;
}
