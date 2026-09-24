/**
 * Tài khoản, phiên đăng nhập và tra cứu quyền.
 *
 * Đáp ứng: GIS FN-01, Khuyến nông FN-01/FN-02, App HTX FN-01/FN-02, CGH FN-01,
 * Warehouse FN-36. Không có cơ chế tự đăng ký công khai — mọi tài khoản do
 * Admin khởi tạo (App HTX BR-01).
 */
import { createHash, randomBytes, randomInt, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { decryptField, encryptField } from '../security/fieldCrypto.ts';
import { generateSecret, otpauthUri, verifyTotp } from './totp.ts';
import { hitRateLimit } from '../http/rateLimit.ts';
import { all, insert, one, run, transaction, update, upsert } from '../db/db.ts';
import { legacySha256Hash, nowIso, uuid } from '../util/ids.ts';
import { logEvent, type AuditActor } from '../audit/audit.ts';
import { permissionsFor, ROLE_LABELS, ROLES, SYSTEMS, isSystemAdminRole, ADMIN_ROLE_SYSTEM, type SystemCode } from './rbac.ts';

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

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number, options: typeof SCRYPT_PARAMS) => Promise<Buffer>;
/** Bản KHÔNG CHẶN event loop (SEC-05): scrypt chạy trên threadpool; hash cũ (sha256) rẻ nên kiểm đồng bộ. */
export async function verifySecretAsync(password: string, salt: string, stored: string): Promise<boolean> {
  if (isLegacyHash(stored)) return verifySecret(password, salt, stored);
  const key = await scryptAsync(password, salt, 32, SCRYPT_PARAMS);
  const a = Buffer.from(SCRYPT_PREFIX + key.toString('hex')); const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Phiên lưu DIGEST của token (SEC-06): lộ bảng sessions không suy ra được bearer token. */
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex');

/** So khớp hằng thời gian; nhận cả hash cũ (sha256) lẫn hash mới (scrypt). */
export function verifySecret(password: string, salt: string, stored: string): boolean {
  const candidate = isLegacyHash(stored) ? legacySha256Hash(password, salt) : hashSecret(password, salt);
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
  /** Quản trị nền tảng đang "ở trong" hệ thống con nào (theo phiên); null = chưa vào hệ thống nào. */
  activeSystem?: SystemCode | null;
  /** Token của phiên hiện tại (chỉ có khi được dựng từ token). */
  sessionToken?: string;
  /** Xác thực hai lớp đã bật cho tài khoản. */
  mfaEnabled: boolean;
  /** Phiên đã đăng nhập mật khẩu nhưng CHƯA nhập mã hai lớp. */
  mfaPending?: boolean;
  /** Lần xác thực (mật khẩu / mã hai lớp / xác nhận lại) gần nhất của phiên — cho hành động nhạy cảm. */
  authAt?: string | null;
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
  mfa_secret?: string | null;
  mfa_enabled?: number | null;
  mfa_last_counter?: number | null;
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
    mfaEnabled: row.mfa_enabled === 1,
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
export function changePassword(id: string, newPassword: string, options: { enforcePolicy?: boolean; keepToken?: string | null } = {}): void {
  if (options.enforcePolicy !== false) assertStrongPassword(newPassword);
  const salt = randomBytes(12).toString('hex');
  update('users', id, {
    password_salt: salt,
    password_hash: hashSecret(newPassword, salt),
    must_change_pw: 0,
    updated_at: nowIso(),
  });
  // Đánh giá bảo mật 24/09/2026 (L-03): đổi mật khẩu vì nghi lộ phiên → mọi phiên KHÁC bị huỷ ngay.
  if (options.keepToken) run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [id, tokenDigest(options.keepToken)]);
  else run('DELETE FROM sessions WHERE user_id = ?', [id]);
}

/** L-08: sau hạn này, tài khoản còn hash SHA-256 cũ vẫn đăng nhập được nhưng bị buộc đặt mật khẩu mới ngay. */
export const LEGACY_HASH_DEADLINE = process.env.LEGACY_HASH_DEADLINE ?? '2026-12-31';
export function legacyHashCount(): number {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE password_hash NOT LIKE 'scrypt$%'")?.n ?? 0;
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
type LoginRow = UserRow & { failed_attempts?: number; locked_until?: string | null; lock_reason?: string | null };
export interface LoginResult { token: string; user: User; mfaRequired: boolean }
export interface LoginContext { ip?: string | null; userAgent?: string | null }

function findLoginRow(identifier: string): LoginRow | null {
  const key = identifier.trim();
  const row = one<LoginRow>(
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
  return row;
}

function registerLoginFailure(row: LoginRow): null {
  const now = nowIso();
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

function openSession(row: LoginRow, password: string, context: LoginContext): LoginResult {
  const now = nowIso();
  const upgrade: Record<string, unknown> = {};
  if (isLegacyHash(row.password_hash)) {
    // Nâng cấp trong suốt: mật khẩu vừa xác thực đúng → băm lại bằng scrypt với salt mới.
    const salt = randomBytes(12).toString('hex');
    upgrade.password_salt = salt;
    upgrade.password_hash = hashSecret(password, salt);
    // Quá hạn di trú (L-08): hash yếu tồn tại vô thời hạn trong CSDL → buộc đặt mật khẩu mới ngay lần này.
    if (now.slice(0, 10) > LEGACY_HASH_DEADLINE) upgrade.must_change_pw = 1;
  }
  update('users', row.id, { failed_attempts: 0, locked_until: null, last_login_at: now, updated_at: now, ...upgrade });
  const token = randomBytes(24).toString('hex');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_HOURS * 3600_000);
  const mfaRequired = row.mfa_enabled === 1;
  insert('sessions', {
    token: tokenDigest(token),   // SEC-06: chỉ lưu digest
    user_id: row.id,
    created_at: created.toISOString(),
    expires_at: expires.toISOString(),
    last_seen_at: created.toISOString(),
    auth_at: mfaRequired ? null : created.toISOString(),
    mfa_pending: mfaRequired ? 1 : 0,
    ip: context.ip ?? null,
    user_agent: context.userAgent ? String(context.userAgent).slice(0, 200) : null,
  });
  logEvent({ module: 'admin', entityType: 'login', entityId: row.id, action: 'create', note: mfaRequired ? 'login_password_ok_mfa_pending' : 'login', source: 'ui', after: { ip: context.ip ?? null } }, { id: row.id, name: row.full_name });
  return { token, user: hydrate(row), mfaRequired };
}

/** Đăng nhập đồng bộ (test, script). Route HTTP dùng loginAsync để không chặn event loop khi băm scrypt. */
export function login(identifier: string, password: string, context: LoginContext = {}): LoginResult | null {
  const row = findLoginRow(identifier);
  if (!row) return null;
  if (!verifySecret(password, row.password_salt, row.password_hash)) return registerLoginFailure(row);
  return openSession(row, password, context);
}

export async function loginAsync(identifier: string, password: string, context: LoginContext = {}): Promise<LoginResult | null> {
  const row = findLoginRow(identifier);
  if (!row) return null;
  if (!(await verifySecretAsync(password, row.password_salt, row.password_hash))) return registerLoginFailure(row);
  return openSession(row, password, context);
}

// ---------------------------------------------------------------------------
// XÁC THỰC HAI LỚP (TOTP) — đánh giá cấp độ 3 (SEC-04/SEC-06): bắt buộc cho quản trị, tuỳ chọn cho người dùng khác.
// Bí mật lưu mã hoá (fieldCrypto). MFA_ENFORCE=1 (hoặc production nếu không đặt =0) → quản trị chưa đăng ký bị
// chặn mọi thao tác cho tới khi đăng ký xong.
// ---------------------------------------------------------------------------
export const isMfaEnforced = (): boolean => process.env.MFA_ENFORCE === '1' || (process.env.NODE_ENV === 'production' && process.env.MFA_ENFORCE !== '0');
const isAdminRole = (role: string): boolean => role === ROLES.PLATFORM_ADMIN || isSystemAdminRole(role);

export function mfaEnrollmentRequired(user: User): boolean {
  if (!isMfaEnforced() || user.mfaEnabled) return false;
  return user.roles.some(isAdminRole);
}

const MFA_ATTEMPTS = 10;
const MFA_WINDOW_MS = 15 * 60_000;
function mfaSecretOf(userId: string): { secret: string | null; enabled: boolean; lastCounter: number | null; username: string } {
  const row = one<{ username: string; mfa_secret: string | null; mfa_enabled: number | null; mfa_last_counter: number | null }>('SELECT username, mfa_secret, mfa_enabled, mfa_last_counter FROM users WHERE id = ?', [userId]);
  if (!row) throw new Error('Không tìm thấy tài khoản.');
  return { secret: row.mfa_secret ? decryptField(row.mfa_secret) : null, enabled: row.mfa_enabled === 1, lastCounter: row.mfa_last_counter ?? null, username: row.username };
}

/** Bước 1 đăng ký: sinh bí mật mới (chưa bật); trả bí mật base32 và URI otpauth để nhập vào ứng dụng xác thực. */
export function beginMfaEnrollment(userId: string, actor: AuditActor = {}): { secret: string; otpauthUri: string; issuer: string } {
  const current = mfaSecretOf(userId);
  const secret = generateSecret();
  update('users', userId, { mfa_secret: encryptField(secret), mfa_enabled: 0, mfa_last_counter: null, updated_at: nowIso() });
  logEvent({ module: 'admin', entityType: 'users', entityId: userId, action: 'update', note: 'mfa_enrollment_started', source: 'ui' }, actor);
  const issuer = process.env.MFA_ISSUER ?? 'Mekong Green';
  return { secret, otpauthUri: otpauthUri(issuer, current.username, secret), issuer };
}

/** Bước 2 đăng ký: mã đúng → bật MFA cho tài khoản. */
export function confirmMfaEnrollment(userId: string, code: string, actor: AuditActor = {}): void {
  const { secret } = mfaSecretOf(userId);
  if (!secret) throw new Error('Chưa bắt đầu đăng ký xác thực hai lớp.');
  const counter = verifyTotp(secret, code);
  if (counter === null) throw new Error('Mã xác thực không đúng hoặc đã hết hạn — kiểm tra lại giờ trên điện thoại.');
  update('users', userId, { mfa_enabled: 1, mfa_last_counter: counter, updated_at: nowIso() });
  logEvent({ module: 'admin', entityType: 'users', entityId: userId, action: 'update', note: 'mfa_enabled', source: 'ui' }, actor);
}

/** Kiểm mã của tài khoản đã bật MFA (có giới hạn số lần thử và chống phát lại). */
export function verifyMfa(userId: string, code: string): boolean {
  const limit = hitRateLimit(`mfa:${userId}`, MFA_ATTEMPTS, MFA_WINDOW_MS);
  if (!limit.allowed) throw new LoginError(`Nhập sai mã xác thực quá nhiều lần. Thử lại sau ${Math.ceil(limit.retryAfterSec / 60)} phút.`, 'temporarily_locked');
  const { secret, enabled, lastCounter } = mfaSecretOf(userId);
  if (!secret || !enabled) return false;
  const counter = verifyTotp(secret, code, { lastCounter });
  if (counter === null) return false;
  update('users', userId, { mfa_last_counter: counter });
  return true;
}

/** Hoàn tất đăng nhập hai lớp cho phiên đang chờ. */
export function completeMfaLogin(token: string, user: User, code: string): void {
  if (!verifyMfa(user.id, code)) {
    logEvent({ module: 'admin', entityType: 'login', entityId: user.id, action: 'update', note: 'mfa_failed', source: 'ui' }, { id: user.id, name: user.fullName });
    throw new LoginError('Mã xác thực không đúng.', 'mfa_invalid');
  }
  const now = nowIso();
  run('UPDATE sessions SET mfa_pending = 0, auth_at = ? WHERE token = ?', [now, tokenDigest(token)]);
  logEvent({ module: 'admin', entityType: 'login', entityId: user.id, action: 'create', note: 'login_mfa_ok', source: 'ui' }, { id: user.id, name: user.fullName });
}

/** Sau khi đăng ký MFA thành công, phiên hiện tại được đánh dấu đã qua hai lớp và làm mới mốc xác thực. */
export function completeMfaLoginSilently(token: string): void {
  run('UPDATE sessions SET mfa_pending = 0, auth_at = ? WHERE token = ?', [nowIso(), tokenDigest(token)]);
}

/** Tắt MFA (tự người dùng, đã xác nhận lại mật khẩu; hoặc quản trị đặt lại) — mọi phiên bị huỷ để đăng nhập lại. */
export function resetMfa(userId: string, actor: AuditActor = {}, note = 'mfa_reset'): void {
  update('users', userId, { mfa_secret: null, mfa_enabled: 0, mfa_last_counter: null, updated_at: nowIso() });
  run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  logEvent({ module: 'admin', entityType: 'users', entityId: userId, action: 'update', note, source: 'ui' }, actor);
}

/** Xác nhận lại danh tính trước hành động nhạy cảm: mật khẩu (+ mã hai lớp nếu đã bật) → làm mới auth_at của phiên. */
export async function reauthenticate(token: string, user: User, password: string, code?: string): Promise<void> {
  const row = one<UserRow>('SELECT * FROM users WHERE id = ?', [user.id]);
  if (!row || !(await verifySecretAsync(password, row.password_salt, row.password_hash))) {
    hitRateLimit(`reauth:${user.id}`, MFA_ATTEMPTS, MFA_WINDOW_MS);
    throw new LoginError('Mật khẩu không đúng.', 'reauth_failed');
  }
  if (row.mfa_enabled === 1 && !verifyMfa(user.id, code ?? '')) throw new LoginError('Mã xác thực hai lớp không đúng.', 'mfa_invalid');
  run('UPDATE sessions SET auth_at = ? WHERE token = ?', [nowIso(), tokenDigest(token)]);
  logEvent({ module: 'admin', entityType: 'login', entityId: user.id, action: 'update', note: 'reauthenticated', source: 'ui' }, { id: user.id, name: user.fullName });
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
  const pick = (set: string) => set[randomInt(set.length)];   // randomInt không thiên lệch (CodeQL js/biased-cryptographic-random)
  const chars = [pick(TEMP_UPPER), pick(TEMP_UPPER), pick(TEMP_LOWER), pick(TEMP_LOWER), pick(TEMP_DIGIT), pick(TEMP_DIGIT)];
  const pool = TEMP_UPPER + TEMP_LOWER + TEMP_DIGIT;
  while (chars.length < Math.max(8, length)) chars.push(pick(pool));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Super Admin toàn hệ thống
// ---------------------------------------------------------------------------

export const SUPER_ADMIN_USERNAME = 'SAdmin';

/**
 * Bảo đảm tài khoản Super Admin `SAdmin` tồn tại khi khởi động.
 *  - Đã có `SAdmin`: giữ nguyên mật khẩu hiện tại (quản trị viên có thể đã đổi), chỉ bảo đảm vai trò.
 *  - Còn tài khoản `admin` cũ: đổi tên thành `SAdmin`, đặt mật khẩu ban đầu và huỷ mọi phiên cũ.
 *  - Chưa có gì: tạo mới với vai trò quản trị nền tảng.
 * Mật khẩu ban đầu lấy từ biến môi trường SUPER_ADMIN_PASSWORD nếu có.
 */
/**
 * Đánh giá bảo mật 24/09/2026 (C-01): KHÔNG còn mật khẩu mặc định trong mã nguồn.
 *  - Có SUPER_ADMIN_PASSWORD → dùng làm mật khẩu ban đầu (must_change_pw = 0, quản trị tự chịu trách nhiệm).
 *  - Không có → sinh mật khẩu ngẫu nhiên, in ra log MỘT lần, bắt đổi ở lần đăng nhập đầu.
 *  - CSDL có sẵn SAdmin từ bản cũ (mật khẩu từng nằm trong repo) và không đặt biến môi trường → buộc đổi
 *    mật khẩu ở lần đăng nhập kế tiếp và huỷ phiên đang mở; đánh dấu trong system_config để chỉ làm một lần.
 */
const SADMIN_ROTATION_MARKER = 'security.sadmin_rotation_2026_09_24';
export function ensureSuperAdmin(initialPassword = process.env.SUPER_ADMIN_PASSWORD): { action: 'created' | 'renamed' | 'kept' | 'rotation_required'; userId: string; temporaryPassword?: string } {
  const timestamp = nowIso();
  const generated = !initialPassword;
  const password = initialPassword || generateTemporaryPassword(16);
  const mustChange = generated ? 1 : 0;
  const announce = (id: string) => {
    if (!generated) return;
    // Có chủ đích: mật khẩu tạm chỉ tồn tại ở log khởi động MỘT lần và bị buộc đổi ở lần đăng nhập đầu (đánh giá bảo mật C-01).
    console.warn(`\n  [auth] SAdmin được tạo với mật khẩu tạm: ${password}\n  [auth] Mật khẩu này chỉ hiện MỘT lần và phải đổi ở lần đăng nhập đầu. Đặt SUPER_ADMIN_PASSWORD để tự chọn.\n`); // codeql[js/clear-text-logging]
    logEvent({ module: 'admin', entityType: 'users', entityId: id, action: 'create', note: 'super_admin_temporary_password_issued', source: 'system' });
  };
  const ensureRole = (userId: string) => {
    if (!one('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?', [userId, ROLES.PLATFORM_ADMIN])) insert('user_roles', { user_id: userId, role: ROLES.PLATFORM_ADMIN });
  };
  const existing = one<UserRow>('SELECT * FROM users WHERE username = ?', [SUPER_ADMIN_USERNAME]);
  if (existing) {
    ensureRole(existing.id);
    // SEC-04: KHÔNG tự mở khoá SAdmin khi khởi động — tài khoản bị khoá phải được người vận hành xử lý (npm run reset-sadmin).
    if (existing.status !== 'active') console.warn(`  [auth] SAdmin đang ở trạng thái "${existing.status}" — không tự mở khoá; dùng npm run reset-sadmin nếu cần khôi phục.`);
    if (!one('SELECT 1 FROM system_config WHERE key = ?', [SADMIN_ROTATION_MARKER])) {
      upsert('system_config', { key: SADMIN_ROTATION_MARKER, value_json: JSON.stringify({ at: timestamp, forced: generated }), updated_at: timestamp, updated_by: 'system' });
      if (generated) {
        // Mật khẩu hiện tại có thể là chuỗi từng công bố trong repo → buộc đổi, huỷ phiên đang mở.
        update('users', existing.id, { must_change_pw: 1, updated_at: timestamp });
        run('DELETE FROM sessions WHERE user_id = ?', [existing.id]);
        logEvent({ module: 'admin', entityType: 'users', entityId: existing.id, action: 'update', note: 'super_admin_forced_rotation', source: 'system' });
        console.warn('  [auth] SAdmin phải đổi mật khẩu ở lần đăng nhập kế tiếp (mật khẩu cũ từng nằm trong mã nguồn — C-01).');
        return { action: 'rotation_required', userId: existing.id };
      }
    }
    return { action: 'kept', userId: existing.id };
  }
  upsert('system_config', { key: SADMIN_ROTATION_MARKER, value_json: JSON.stringify({ at: timestamp, forced: false }), updated_at: timestamp, updated_by: 'system' });
  const salt = randomBytes(12).toString('hex');
  const legacy = one<UserRow>("SELECT * FROM users WHERE username = 'admin'");
  if (legacy) {
    transaction(() => {
      update('users', legacy.id, {
        username: SUPER_ADMIN_USERNAME, full_name: 'Quản trị hệ thống (Super Admin)', password_salt: salt,
        password_hash: hashSecret(password, salt), must_change_pw: mustChange, status: 'active', failed_attempts: 0, locked_until: null, updated_at: timestamp,
      });
      ensureRole(legacy.id);
      run('DELETE FROM sessions WHERE user_id = ?', [legacy.id]);
    });
    logEvent({ module: 'admin', entityType: 'users', entityId: legacy.id, action: 'update', note: 'super_admin_renamed', source: 'system' });
    announce(legacy.id);
    return { action: 'renamed', userId: legacy.id, temporaryPassword: generated ? password : undefined };
  }
  const id = uuid();
  transaction(() => {
    insert('users', {
      id, username: SUPER_ADMIN_USERNAME, full_name: 'Quản trị hệ thống (Super Admin)', email: null, phone: null,
      password_hash: hashSecret(password, salt), password_salt: salt, must_change_pw: mustChange, status: 'active',
      org_node_id: null, htx_id: null, province_id: null, created_at: timestamp, updated_at: timestamp,
    });
    insert('user_roles', { user_id: id, role: ROLES.PLATFORM_ADMIN });
  });
  logEvent({ module: 'admin', entityType: 'users', entityId: id, action: 'create', note: 'super_admin_created', source: 'system' });
  announce(id);
  return { action: 'created', userId: id, temporaryPassword: generated ? password : undefined };
}

export function logout(token: string): void {
  run('DELETE FROM sessions WHERE token = ?', [tokenDigest(token)]);
}

/** Phiên hết hạn tuyệt đối sau SESSION_HOURS và hết hạn RẢNH sau SESSION_IDLE_MINUTES không hoạt động (SEC-06). */
export const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES ?? 60);

export function userFromToken(token: string | null | undefined): User | null {
  if (!token) return null;
  const digest = tokenDigest(token);
  const session = one<{ user_id: string; expires_at: string; active_system?: string | null; last_seen_at?: string | null; auth_at?: string | null; mfa_pending?: number | null }>(
    'SELECT user_id, expires_at, active_system, last_seen_at, auth_at, mfa_pending FROM sessions WHERE token = ?',
    [digest],
  );
  if (!session) return null;
  const nowMs = Date.now();
  if (session.expires_at < nowIso()) {
    run('DELETE FROM sessions WHERE token = ?', [digest]);
    return null;
  }
  const lastSeen = session.last_seen_at ? Date.parse(session.last_seen_at) : nowMs;
  if (SESSION_IDLE_MINUTES > 0 && nowMs - lastSeen > SESSION_IDLE_MINUTES * 60_000) {
    run('DELETE FROM sessions WHERE token = ?', [digest]);
    return null;
  }
  // Ghi mốc hoạt động thưa (≥ 60 giây/lần) để không tốn một lệnh ghi cho mỗi yêu cầu.
  if (nowMs - lastSeen >= 60_000 || !session.last_seen_at) run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', [new Date(nowMs).toISOString(), digest]);

  const user = getUser(session.user_id);
  // Tài khoản bị khoá SAU khi phiên đã mở thì phiên đó phải chết theo. Không
  // kiểm tra ở đây thì người bị khoá vẫn dùng hệ thống bình thường tới khi
  // phiên hết hạn — tức là việc khoá gần như vô tác dụng đúng lúc cần nó nhất.
  if (!user || user.status !== 'active') {
    run('DELETE FROM sessions WHERE token = ?', [digest]);
    return null;
  }
  return {
    ...user, activeSystem: (session.active_system as SystemCode | null | undefined) ?? null, sessionToken: token,
    authAt: session.auth_at ?? null, mfaPending: session.mfa_pending === 1,
  };
}

/**
 * Quản trị nền tảng phải "VÀO" một hệ thống con trước khi thao tác nghiệp vụ trong đó (cơ cấu 09/2026):
 * ghi vào phiên, có nhật ký; rời hệ thống thì đặt null. Người không phải quản trị nền tảng không dùng.
 */
export function setActiveSystem(token: string, system: SystemCode | null, actor: { id?: string | null; name?: string | null } = {}): void {
  if (system && !SYSTEMS.some((s) => s.code === system)) throw new Error('Hệ thống không hợp lệ.');
  run('UPDATE sessions SET active_system = ? WHERE token = ?', [system, tokenDigest(token)]);
  logEvent({ module: 'admin', entityType: 'admin_session', entityId: actor.id ?? null, action: 'update', after: { activeSystem: system }, note: system ? 'enter_system' : 'leave_system', source: 'ui' }, actor);
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
    // Nhóm quản trị hệ thống con = phạm vi cấp hệ thống ngầm.
    for (const role of user.roles.filter(isSystemAdminRole)) adminScopes.push({ system: ADMIN_ROLE_SYSTEM[role], scope_type: 'system', scope_id: null, fromRole: role });
    if (adminScopes.length) permissions.add('admin.users');
    if (adminScopes.some((s) => s.scope_type === 'system')) permissions.add('admin.delegate');
  }
  const { sessionToken: _token, ...safe } = user;
  return {
    ...safe,
    roleLabels: user.roles.map((role) => ROLE_LABELS[role] ?? role),
    permissions: [...permissions],
    adminScopes,
    superAdmin: permissions.has('*'),
    activeSystem: user.activeSystem ?? null,
    mfaEnabled: user.mfaEnabled,
    mfaPending: user.mfaPending ?? false,
    mfaEnrollmentRequired: mfaEnrollmentRequired(user),
    mfaEnforced: isMfaEnforced(),
    authAt: user.authAt ?? null,
    systemAdminOf: user.roles.filter(isSystemAdminRole).map((role) => ADMIN_ROLE_SYSTEM[role]),
  };
}
