/**
 * Tài khoản, phiên đăng nhập và tra cứu quyền.
 *
 * Đáp ứng: GIS FN-01, Khuyến nông FN-01/FN-02, App HTX FN-01/FN-02, CGH FN-01,
 * Warehouse FN-36. Không có cơ chế tự đăng ký công khai — mọi tài khoản do
 * Admin khởi tạo (App HTX BR-01).
 */
import { randomBytes } from 'node:crypto';
import { all, insert, one, run, transaction, update } from '../db/db.ts';
import { hashPassword, nowIso, uuid } from '../util/ids.ts';
import { logEvent } from '../audit/audit.ts';
import { permissionsFor, ROLE_LABELS } from './rbac.ts';

export interface User {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  mustChangePassword: boolean;
  orgNodeId: string | null;
  htxId: string | null;
  roles: string[];
}

interface UserRow {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  password_salt: string;
  must_change_pw: number;
  status: string;
  org_node_id: string | null;
  htx_id: string | null;
}

function hydrate(row: UserRow): User {
  const roles = all<{ role: string }>('SELECT role FROM user_roles WHERE user_id = ?', [row.id]).map(
    (r) => r.role,
  );
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    mustChangePassword: row.must_change_pw === 1,
    orgNodeId: row.org_node_id,
    htxId: row.htx_id,
    roles,
  };
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  password?: string;
  email?: string;
  phone?: string;
  roles: string[];
  orgNodeId?: string;
  htxId?: string;
}

export function createUser(input: CreateUserInput, actor = {}): { user: User; temporaryPassword: string } {
  const existing = one('SELECT id FROM users WHERE username = ?', [input.username]);
  if (existing) throw new Error(`Tên đăng nhập "${input.username}" đã tồn tại`);

  const id = uuid();
  const salt = randomBytes(12).toString('hex');
  const temporaryPassword = input.password ?? randomBytes(4).toString('hex');
  const timestamp = nowIso();

  transaction(() => {
    insert('users', {
      id,
      username: input.username,
      full_name: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      password_hash: hashPassword(temporaryPassword, salt),
      password_salt: salt,
      must_change_pw: input.password ? 0 : 1,
      status: 'active',
      org_node_id: input.orgNodeId ?? null,
      htx_id: input.htxId ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    for (const role of input.roles) {
      insert('user_roles', { user_id: id, role });
    }
  });

  const user = getUser(id)!;
  logEvent(
    { module: 'admin', entityType: 'users', entityId: id, action: 'create', after: { ...user } },
    actor,
  );
  return { user, temporaryPassword };
}

export function getUser(id: string): User | null {
  const row = one<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  return row ? hydrate(row) : null;
}

export function listUsers(): User[] {
  return all<UserRow>('SELECT * FROM users ORDER BY full_name').map(hydrate);
}

export function setUserStatus(id: string, status: 'active' | 'locked', actor = {}): void {
  const before = getUser(id);
  update('users', id, { status, updated_at: nowIso() });
  // Khoá tài khoản là huỷ luôn quyền truy cập hiện tại, không chỉ chặn lần đăng
  // nhập sau. Xem thêm `admin.setStatus` để biết số phiên đã bị huỷ.
  if (status === 'locked') run('DELETE FROM sessions WHERE user_id = ?', [id]);
  logEvent(
    { module: 'admin', entityType: 'users', entityId: id, action: 'update', before, after: getUser(id) },
    actor,
  );
}

export function resetPassword(id: string, actor = {}): string {
  const salt = randomBytes(12).toString('hex');
  const temporaryPassword = randomBytes(4).toString('hex');
  update('users', id, {
    password_salt: salt,
    password_hash: hashPassword(temporaryPassword, salt),
    must_change_pw: 1,
    updated_at: nowIso(),
  });
  logEvent({ module: 'admin', entityType: 'users', entityId: id, action: 'update', note: 'reset_password' }, actor);
  return temporaryPassword;
}

export function changePassword(id: string, newPassword: string): void {
  const salt = randomBytes(12).toString('hex');
  update('users', id, {
    password_salt: salt,
    password_hash: hashPassword(newPassword, salt),
    must_change_pw: 0,
    updated_at: nowIso(),
  });
}

const SESSION_HOURS = 12;

export function login(username: string, password: string): { token: string; user: User } | null {
  const row = one<UserRow>('SELECT * FROM users WHERE username = ?', [username]);
  if (!row || row.status !== 'active') return null;
  if (hashPassword(password, row.password_salt) !== row.password_hash) return null;

  const token = randomBytes(24).toString('hex');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_HOURS * 3600_000);
  insert('sessions', {
    token,
    user_id: row.id,
    created_at: created.toISOString(),
    expires_at: expires.toISOString(),
  });
  return { token, user: hydrate(row) };
}

export function logout(token: string): void {
  run('DELETE FROM sessions WHERE token = ?', [token]);
}

export function userFromToken(token: string | null | undefined): User | null {
  if (!token) return null;
  const session = one<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token = ?',
    [token],
  );
  if (!session) return null;
  if (session.expires_at < nowIso()) {
    run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }

  const user = getUser(session.user_id);
  // Tài khoản bị khoá SAU khi phiên đã mở thì phiên đó phải chết theo. Không
  // kiểm tra ở đây thì người bị khoá vẫn dùng hệ thống bình thường tới khi
  // phiên hết hạn — tức là việc khoá gần như vô tác dụng đúng lúc cần nó nhất.
  if (!user || user.status !== 'active') {
    run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  return user;
}

export function describeUser(user: User): Record<string, unknown> {
  return {
    ...user,
    roleLabels: user.roles.map((role) => ROLE_LABELS[role] ?? role),
    permissions: [...permissionsFor(user.roles)],
  };
}
