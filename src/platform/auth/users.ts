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
  /** Tỉnh (admin_units.id) — phạm vi quản trị cấp tỉnh bám vào cột này. */
  provinceId: string | null;
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
  province_id?: string | null;
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
    provinceId: row.province_id ?? null,
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
  provinceId?: string;
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
      province_id: input.provinceId ?? null,
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

/**
 * Đổi mật khẩu. Chính sách độ mạnh (≥ 8 ký tự, hoa, thường, số — KN US-AUTH) được
 * áp ở lối vào người dùng (`enforcePolicy`); quản trị viên đặt lại/tự động hoá không bị chặn.
 */
export function changePassword(id: string, newPassword: string, options: { enforcePolicy?: boolean } = {}): void {
  if (options.enforcePolicy) {
    const weaknesses = passwordWeaknesses(newPassword);
    if (weaknesses.length) throw new Error(`Mật khẩu chưa đạt độ mạnh tối thiểu: ${weaknesses.join('; ')}.`);
  }
  const salt = randomBytes(12).toString('hex');
  update('users', id, {
    password_salt: salt,
    password_hash: hashPassword(newPassword, salt),
    must_change_pw: 0,
    updated_at: nowIso(),
  });
}

const SESSION_HOURS = 12;

/** GIS BR-09 / CGH US-ADM-01 AC-3: sai 5 lần trong 15 phút → khoá tạm 15 phút. */
export const LOCKOUT_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export class LoginError extends Error {
  code: 'locked' | 'temporarily_locked' | 'invalid';
  constructor(message: string, code: 'locked' | 'temporarily_locked' | 'invalid') {
    super(message);
    this.code = code;
  }
}

/**
 * Đăng nhập bằng TÊN ĐĂNG NHẬP hoặc SỐ ĐIỆN THOẠI (HTX US-LOGIN-01: nông dân nhớ số điện thoại
 * hơn tên tài khoản). Thông báo lỗi trung tính — không nói rõ sai tên hay sai mật khẩu (CGH US-ADM-01).
 */
export function login(identifier: string, password: string): { token: string; user: User } | null {
  const key = identifier.trim();
  const row = one<UserRow & { failed_attempts?: number; locked_until?: string | null; lock_reason?: string | null }>(
    'SELECT * FROM users WHERE username = ? OR (phone IS NOT NULL AND phone = ?)', [key, key.replace(/\s+/g, '')]);
  if (!row) return null;
  if (row.status !== 'active') {
    throw new LoginError('Tài khoản đã bị khoá, vui lòng liên hệ quản trị viên để mở khoá.', 'locked');
  }
  const now = nowIso();
  if (row.locked_until && row.locked_until > now) {
    const minutes = Math.max(1, Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60_000));
    throw new LoginError(`Tài khoản bị khoá tạm thời do đăng nhập sai nhiều lần. Vui lòng thử lại sau ${minutes} phút.`, 'temporarily_locked');
  }
  if (hashPassword(password, row.password_salt) !== row.password_hash) {
    // Cửa sổ 15 phút: đã hết khoá tạm thì đếm lại từ đầu.
    const attempts = (row.locked_until && row.locked_until <= now ? 0 : (row.failed_attempts ?? 0)) + 1;
    const values: Record<string, unknown> = { failed_attempts: attempts, updated_at: now };
    if (attempts >= LOCKOUT_ATTEMPTS) {
      values.locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
      values.failed_attempts = 0;
      logEvent({ module: 'admin', entityType: 'users', entityId: row.id, action: 'update', note: 'temporary_lockout', source: 'system' });
    }
    update('users', row.id, values);
    if (attempts >= LOCKOUT_ATTEMPTS) {
      throw new LoginError(`Tài khoản bị khoá tạm thời ${LOCKOUT_MINUTES} phút do đăng nhập sai ${LOCKOUT_ATTEMPTS} lần.`, 'temporarily_locked');
    }
    return null;
  }

  update('users', row.id, { failed_attempts: 0, locked_until: null, last_login_at: now, updated_at: now });
  const token = randomBytes(24).toString('hex');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_HOURS * 3600_000);
  insert('sessions', {
    token,
    user_id: row.id,
    created_at: created.toISOString(),
    expires_at: expires.toISOString(),
  });
  logEvent({ module: 'admin', entityType: 'login', entityId: row.id, action: 'create', note: 'login', source: 'ui' }, { id: row.id, name: row.full_name });
  return { token, user: hydrate(row) };
}

/** CGH US-ADM-01 AC-1: mật khẩu mới phải đạt độ mạnh tối thiểu. Trả về danh sách tiêu chí chưa đạt. */
export function passwordWeaknesses(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 8) issues.push('Tối thiểu 8 ký tự');
  if (!/[A-Z]/.test(password)) issues.push('Có ít nhất 1 chữ hoa');
  if (!/[a-z]/.test(password)) issues.push('Có ít nhất 1 chữ thường');
  if (!/[0-9]/.test(password)) issues.push('Có ít nhất 1 chữ số');
  return issues;
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
  const permissions = new Set(permissionsFor(user.roles));
  // Phạm vi quản trị được uỷ quyền (SA-11) mở hai quyền "ảo" cho giao diện: vào được
  // màn hình tài khoản, và uỷ quyền tiếp nếu là admin cấp hệ thống. Máy chủ KHÔNG
  // tin hai quyền này — mọi route quản trị tự kiểm phạm vi bằng `scopes.adminContext`.
  let adminScopes: Record<string, unknown>[] = [];
  if (!permissions.has('*')) {
    try {
      adminScopes = all<{ system: string; scope_type: string; scope_id: string | null }>(
        'SELECT system, scope_type, scope_id FROM admin_scopes WHERE user_id = ?', [user.id]);
    } catch { /* bảng chưa có */ }
    if (adminScopes.length) permissions.add('admin.users');
    if (adminScopes.some((s) => s.scope_type === 'system')) permissions.add('admin.delegate');
  }
  return {
    ...user,
    roleLabels: user.roles.map((role) => ROLE_LABELS[role] ?? role),
    permissions: [...permissions],
    adminScopes,
  };
}
