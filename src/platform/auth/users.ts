/**
 * Tài khoản, phiên đăng nhập và tra cứu quyền.
 *
 * Đáp ứng: GIS FN-01, Khuyến nông FN-01/FN-02, App HTX FN-01/FN-02, CGH FN-01,
 * Warehouse FN-36. Không có cơ chế tự đăng ký công khai — mọi tài khoản do
 * Admin khởi tạo (App HTX BR-01).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { all, insert, one, run, transaction, update } from '../db/db.ts';
import { hashPassword, nowIso, uuid } from '../util/ids.ts';
import { logEvent } from '../audit/audit.ts';
import { permissionsFor, ROLE_LABELS, ROLES } from './rbac.ts';

// ---------------------------------------------------------------------------
// Băm mật khẩu: scrypt (KDF có chi phí bộ nhớ) thay cho SHA-256 một vòng (rà soát CSDL 24/09/2026,
// nguyên tắc 10). Bản ghi cũ vẫn xác thực được và được nâng cấp trong suốt ở lần đăng nhập thành công.
// ---------------------------------------------------------------------------
const SCRYPT_N = Number(process.env.SCRYPT_N ?? 16384);
const SCRYPT_PARAMS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_PREFIX = 'scrypt$';

export function hashSecret(password: string, salt: string): string {
  return SCRYPT_PREFIX + scryptSync(password, salt, 32, SCRYPT_PARAMS).toString('hex');
}

export function isLegacyHash(stored: string): boolean { return !stored.startsWith(SCRYPT_PREFIX); }

/** So khớp hằng thời gian; nhận cả hash cũ (sha256) lẫn hash mới (scrypt). */
export function verifySecret(password: string, salt: string, stored: string): boolean {
  const candidate = isLegacyHash(stored) ? hashPassword(password, salt) : hashSecret(password, salt);
  const a = Buffer.from(candidate); const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

/** UAT DEF-CGH-03: email là định danh nhận mật khẩu tạm — không được trùng giữa hai tài khoản. */
export function assertEmailAvailable(email: string | null | undefined, exceptUserId?: string): void {
  const value = String(email ?? '').trim().toLowerCase();
  if (!value) return;
  const clash = one<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = ? AND id <> ?', [value, exceptUserId ?? '']);
  if (clash) throw new Error('Email này đã được sử dụng');
}

export const PHONE_RE = /^0\d{9}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const normalizePhone = (phone: unknown): string | null => {
  const digits = String(phone ?? '').replace(/[\s.\-()]/g, '');
  return digits ? digits : null;
};

/** UAT DEF-ADM-02 (BR-03): số điện thoại là định danh đăng nhập nên phải duy nhất toàn hệ thống. */
export function assertPhoneAvailable(phone: string | null | undefined, exceptUserId?: string): void {
  const value = normalizePhone(phone);
  if (!value) return;
  if (!PHONE_RE.test(value)) throw new Error('Số điện thoại không đúng định dạng — cần 10 chữ số, bắt đầu bằng 0 (VD: 0912345678).');
  const clash = one<{ id: string }>('SELECT id FROM users WHERE phone = ? AND id <> ?', [value, exceptUserId ?? '']);
  if (clash) throw new Error('Số điện thoại này đã được đăng ký cho tài khoản khác');
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

/**
 * Tạo tài khoản. Mật khẩu do quản trị viên đặt phải đạt chính sách độ mạnh
 * (≥ 8 ký tự, chữ thường, chữ hoa, chữ số); không đặt thì hệ thống sinh mật khẩu
 * tạm đạt chuẩn và buộc đổi ở lần đăng nhập đầu. `enforcePolicy: false` chỉ dành
 * cho dữ liệu trình diễn (seed).
 */
export function createUser(input: CreateUserInput, actor = {}, options: { enforcePolicy?: boolean } = {}): { user: User; temporaryPassword: string } {
  const existing = one('SELECT id FROM users WHERE username = ?', [input.username]);
  if (existing) throw new Error(`Tên đăng nhập "${input.username}" đã tồn tại`);
  // UAT DEF-SYS-01 / DEF-ADM-01: kiểm dữ liệu bắt buộc bằng thông điệp nghiệp vụ, không để lỗi NOT NULL của CSDL lọt ra.
  if (!input.username?.trim()) throw new Error('Tên đăng nhập là trường bắt buộc.');
  if (!input.fullName?.trim()) throw new Error('Họ tên là trường bắt buộc.');
  if (!Array.isArray(input.roles) || !input.roles.length) throw new Error('Tài khoản phải thuộc ít nhất một nhóm quyền.');
  if (input.email && !EMAIL_RE.test(input.email.trim())) throw new Error('Email không đúng định dạng (VD: ten@donvi.vn).');
  const phone = normalizePhone(input.phone);
  assertPhoneAvailable(phone);
  assertEmailAvailable(input.email);
  if (input.password && options.enforcePolicy !== false) assertStrongPassword(input.password);

  const id = uuid();
  const salt = randomBytes(12).toString('hex');
  const temporaryPassword = input.password ?? generateTemporaryPassword();
  const timestamp = nowIso();

  transaction(() => {
    insert('users', {
      id,
      username: input.username,
      full_name: input.fullName,
      email: input.email?.trim() || null,
      phone,
      password_hash: hashSecret(temporaryPassword, salt),
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
  const temporaryPassword = generateTemporaryPassword();
  update('users', id, {
    password_salt: salt,
    password_hash: hashSecret(temporaryPassword, salt),
    must_change_pw: 1,
    updated_at: nowIso(),
  });
  logEvent({ module: 'admin', entityType: 'users', entityId: id, action: 'update', note: 'reset_password' }, actor);
  return temporaryPassword;
}

/** Đổi mật khẩu. Mọi mật khẩu đặt mới phải đạt chính sách độ mạnh (≥ 8 ký tự, chữ thường, chữ hoa, chữ số). */
export function changePassword(id: string, newPassword: string, options: { enforcePolicy?: boolean } = {}): void {
  if (options.enforcePolicy !== false) assertStrongPassword(newPassword);
  const salt = randomBytes(12).toString('hex');
  update('users', id, {
    password_salt: salt,
    password_hash: hashSecret(newPassword, salt),
    must_change_pw: 0,
    updated_at: nowIso(),
  });
}

const SESSION_HOURS = 12;

/** GIS BR-09 / CGH US-ADM-01 AC-3: sai 5 lần trong 15 phút → khoá tạm 15 phút. */
export const LOCKOUT_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

/** Một thông điệp duy nhất cho trạng thái khoá tạm (UAT DEF-CGH-09). */
const lockoutMessage = (minutes: number) => `Tài khoản bị khoá tạm thời do đăng nhập sai quá ${LOCKOUT_ATTEMPTS} lần. Vui lòng thử lại sau ${minutes} phút hoặc liên hệ quản trị viên.`;

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
    // Nếu dữ liệu cũ còn trùng SĐT, ưu tiên tài khoản đang hoạt động để người hợp lệ không bị chặn bởi bản ghi đã khoá (UAT DEF-ADM-02).
    "SELECT * FROM users WHERE username = ? OR (phone IS NOT NULL AND phone = ?) ORDER BY (username = ?) DESC, (status = 'active') DESC LIMIT 1", [key, key.replace(/\s+/g, ''), key]);
  if (!row) return null;
  if (row.status !== 'active') {
    throw new LoginError('Tài khoản đã bị khoá, vui lòng liên hệ quản trị viên để mở khoá.', 'locked');
  }
  const now = nowIso();
  if (row.locked_until && row.locked_until > now) {
    const minutes = Math.max(1, Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60_000));
    throw new LoginError(lockoutMessage(minutes), 'temporarily_locked');
  }
  if (!verifySecret(password, row.password_salt, row.password_hash)) {
    // Cửa sổ 15 phút: đã hết khoá tạm thì đếm lại từ đầu.
    const attempts = (row.locked_until && row.locked_until <= now ? 0 : (row.failed_attempts ?? 0)) + 1;
    const values: Record<string, unknown> = { failed_attempts: attempts, updated_at: now };
    // "Sai QUÁ 5 lần" (UAT DEF-CGH-09): 5 lần sai chỉ báo sai, lần thứ 6 mới khoá.
    if (attempts > LOCKOUT_ATTEMPTS) {
      values.locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
      values.failed_attempts = 0;
      logEvent({ module: 'admin', entityType: 'users', entityId: row.id, action: 'update', note: 'temporary_lockout', source: 'system' });
    }
    update('users', row.id, values);
    if (attempts > LOCKOUT_ATTEMPTS) throw new LoginError(lockoutMessage(LOCKOUT_MINUTES), 'temporarily_locked');
    return null;
  }

  const upgrade: Record<string, unknown> = {};
  if (isLegacyHash(row.password_hash)) {
    // Nâng cấp trong suốt: mật khẩu vừa xác thực đúng → băm lại bằng scrypt với salt mới.
    const salt = randomBytes(12).toString('hex');
    upgrade.password_salt = salt;
    upgrade.password_hash = hashSecret(password, salt);
  }
  update('users', row.id, { failed_attempts: 0, locked_until: null, last_login_at: now, updated_at: now, ...upgrade });
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

export function assertStrongPassword(password: string): void {
  const weaknesses = passwordWeaknesses(password);
  if (weaknesses.length) throw new Error(`Mật khẩu chưa đạt độ mạnh tối thiểu: ${weaknesses.join('; ')}.`);
}

// Bỏ các ký tự dễ nhầm (O/0, I/l/1) vì mật khẩu tạm thường được đọc qua điện thoại.
const TEMP_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TEMP_LOWER = 'abcdefghijkmnpqrstuvwxyz';
const TEMP_DIGIT = '23456789';

/** Mật khẩu tạm luôn đạt chính sách: ≥ 2 chữ hoa, ≥ 2 chữ thường, ≥ 2 chữ số, xáo trộn ngẫu nhiên. */
export function generateTemporaryPassword(length = 10): string {
  const pick = (set: string) => set[randomBytes(1)[0] % set.length];
  const chars = [pick(TEMP_UPPER), pick(TEMP_UPPER), pick(TEMP_LOWER), pick(TEMP_LOWER), pick(TEMP_DIGIT), pick(TEMP_DIGIT)];
  const pool = TEMP_UPPER + TEMP_LOWER + TEMP_DIGIT;
  while (chars.length < Math.max(8, length)) chars.push(pick(pool));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Super Admin toàn hệ thống
// ---------------------------------------------------------------------------

export const SUPER_ADMIN_USERNAME = 'SAdmin';
const DEFAULT_SUPER_ADMIN_PASSWORD = 'TungLM18@';

/**
 * Bảo đảm tài khoản Super Admin `SAdmin` tồn tại khi khởi động.
 *  - Đã có `SAdmin`: giữ nguyên mật khẩu hiện tại (quản trị viên có thể đã đổi), chỉ bảo đảm vai trò.
 *  - Còn tài khoản `admin` cũ: đổi tên thành `SAdmin`, đặt mật khẩu ban đầu và huỷ mọi phiên cũ.
 *  - Chưa có gì: tạo mới với vai trò quản trị nền tảng.
 * Mật khẩu ban đầu lấy từ biến môi trường SUPER_ADMIN_PASSWORD nếu có.
 */
export function ensureSuperAdmin(initialPassword = process.env.SUPER_ADMIN_PASSWORD ?? DEFAULT_SUPER_ADMIN_PASSWORD): { action: 'created' | 'renamed' | 'kept'; userId: string } {
  const timestamp = nowIso();
  const ensureRole = (userId: string) => {
    if (!one('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?', [userId, ROLES.PLATFORM_ADMIN])) insert('user_roles', { user_id: userId, role: ROLES.PLATFORM_ADMIN });
  };
  const existing = one<UserRow>('SELECT * FROM users WHERE username = ?', [SUPER_ADMIN_USERNAME]);
  if (existing) {
    ensureRole(existing.id);
    if (existing.status !== 'active') update('users', existing.id, { status: 'active', locked_until: null, failed_attempts: 0, updated_at: timestamp });
    return { action: 'kept', userId: existing.id };
  }
  const salt = randomBytes(12).toString('hex');
  const legacy = one<UserRow>("SELECT * FROM users WHERE username = 'admin'");
  if (legacy) {
    transaction(() => {
      update('users', legacy.id, {
        username: SUPER_ADMIN_USERNAME, full_name: 'Quản trị hệ thống (Super Admin)', password_salt: salt,
        password_hash: hashSecret(initialPassword, salt), must_change_pw: 0, status: 'active', failed_attempts: 0, locked_until: null, updated_at: timestamp,
      });
      ensureRole(legacy.id);
      run('DELETE FROM sessions WHERE user_id = ?', [legacy.id]);
    });
    logEvent({ module: 'admin', entityType: 'users', entityId: legacy.id, action: 'update', note: 'super_admin_renamed', source: 'system' });
    return { action: 'renamed', userId: legacy.id };
  }
  const id = uuid();
  transaction(() => {
    insert('users', {
      id, username: SUPER_ADMIN_USERNAME, full_name: 'Quản trị hệ thống (Super Admin)', email: null, phone: null,
      password_hash: hashSecret(initialPassword, salt), password_salt: salt, must_change_pw: 0, status: 'active',
      org_node_id: null, htx_id: null, province_id: null, created_at: timestamp, updated_at: timestamp,
    });
    insert('user_roles', { user_id: id, role: ROLES.PLATFORM_ADMIN });
  });
  logEvent({ module: 'admin', entityType: 'users', entityId: id, action: 'create', note: 'super_admin_created', source: 'system' });
  return { action: 'created', userId: id };
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
