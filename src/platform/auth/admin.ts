/**
 * QUẢN TRỊ HỆ THỐNG: TÀI KHOẢN, NHÓM NGƯỜI DÙNG VÀ PHÂN QUYỀN
 *
 * Đây là phân hệ mà một thao tác nhầm gây hậu quả nặng nhất: khoá nhầm tài khoản
 * quản trị cuối cùng là không còn ai vào sửa lại được. Vì vậy phần lớn mã ở đây
 * là các chốt chặn, không phải các thao tác CRUD.
 *
 *   SA-01  Không tự khoá hoặc tự gỡ quyền quản trị của chính mình.
 *   SA-02  Hệ thống phải luôn còn ít nhất MỘT tài khoản quản trị đang hoạt động.
 *   SA-03  Không cấp được quyền mà chính người thao tác không có (chống leo thang).
 *   SA-04  Khoá tài khoản thì HUỶ mọi phiên đang mở của người đó ngay lập tức.
 *   SA-05  Không xoá được nhóm đang có người dùng.
 *   SA-06  Nhóm hệ thống không xoá và không đổi mã được; chỉ ghi đè quyền.
 *   SA-07  Mật khẩu tạm chỉ hiện MỘT lần và buộc đổi ở lần đăng nhập kế tiếp.
 */
import { all, insert, one, run, transaction, update } from '../db/db.ts';
import { nowIso } from '../util/ids.ts';
import { logEvent, type AuditActor } from '../audit/audit.ts';
import {
  PERMISSION_GROUPS, ROLE_LABELS, ROLE_PERMISSIONS,
  defaultPermissionsFor, invalidatePermissionCache, permissionLabel, permissionsFor,
} from './rbac.ts';
import { getUser, listUsers, resetPassword, setUserStatus, type User, assertEmailAvailable } from './users.ts';
import { ROLE_SYSTEM } from './rbac.ts';

/** Mọi mã quyền hợp lệ, lấy từ danh mục có nhãn. */
function allPermissionCodes(): string[] {
  return PERMISSION_GROUPS.flatMap((group) => group.permissions.map((item) => item.code));
}

function isPlatformAdminRole(role: string): boolean {
  return ROLE_PERMISSIONS[role]?.[0] === '*';
}

/** Tài khoản đang hoạt động và có toàn quyền. */
function activeAdmins(): User[] {
  return listUsers().filter(
    (user) => user.status === 'active' && user.roles.some(isPlatformAdminRole),
  );
}

/** SA-02 — chặn thao tác làm mất tài khoản quản trị cuối cùng. */
function assertNotLastAdmin(userId: string, action: string): void {
  const admins = activeAdmins();
  if (admins.length > 1) return;
  if (!admins.some((admin) => admin.id === userId)) return;
  throw new Error(
    `Đây là tài khoản quản trị nền tảng đang hoạt động DUY NHẤT — không ${action} được. ` +
    'Hãy cấp quyền quản trị cho một tài khoản khác trước, nếu không sẽ không còn ai vào sửa lại hệ thống.',
  );
}

function hasSystemScope(actorId: string | undefined, system: string | undefined): boolean {
  if (!actorId || !system || system === '*') return false;
  try {
    return Boolean(one('SELECT id FROM admin_scopes WHERE user_id = ? AND system = ? AND scope_type = ?', [actorId, system, 'system']));
  } catch { return false; }
}

/** SA-03 — không cấp được quyền mà chính người thao tác không có. */
function assertCanGrant(actorId: string | undefined, permissions: string[]): void {
  if (!actorId) return;
  const actor = getUser(actorId);
  if (!actor) return;
  const held = permissionsFor(actor.roles);
  if (held.has('*')) return;

  const escalating = permissions.filter((permission) => !held.has(permission));
  if (escalating.length) {
    throw new Error(
      `Không cấp được quyền mà chính bạn không có: ${escalating.map(permissionLabel).join(', ')}. ` +
      'Nhờ quản trị nền tảng cấp giúp.',
    );
  }
}

// =====================================================================
// Nhóm người dùng
// =====================================================================

export interface GroupView {
  code: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  /** Quyền mặc định theo mã nguồn (rỗng với nhóm tuỳ chỉnh). */
  defaultPermissions: string[];
  /** Quyền hiệu lực sau khi áp ghi đè. */
  effectivePermissions: string[];
  /** Những ô đã bị quản trị viên chỉnh so với mặc định. */
  overrides: { permission: string; label: string; granted: boolean }[];
}

/**
 * Đồng bộ các vai trò hệ thống trong mã nguồn vào bảng `user_groups`.
 *
 * Chạy được nhiều lần: bổ sung vai trò mới, cập nhật nhãn, không đụng vào nhóm
 * tuỳ chỉnh do quản trị viên tạo.
 */
export function syncSystemGroups(): void {
  const timestamp = nowIso();
  for (const [code, label] of Object.entries(ROLE_LABELS)) {
    const existing = one<{ code: string }>('SELECT code FROM user_groups WHERE code = ?', [code]);
    if (existing) {
      update('user_groups', code, { label, is_system: 1, updated_at: timestamp }, 'code');
      continue;
    }
    insert('user_groups', {
      code, label, description: null, is_system: 1,
      created_by: 'system', created_at: timestamp, updated_at: timestamp,
    });
  }
}

export function listGroups(): GroupView[] {
  syncSystemGroups();
  const rows = all<{
    code: string; label: string; description: string | null; is_system: number;
  }>('SELECT code, label, description, is_system FROM user_groups ORDER BY is_system DESC, label');

  const counts = new Map<string, number>();
  for (const row of all<{ role: string; n: number }>(
    'SELECT role, COUNT(*) AS n FROM user_roles GROUP BY role',
  )) counts.set(row.role, row.n);

  return rows.map((row) => {
    const overrideRows = all<{ permission: string; granted: number }>(
      'SELECT permission, granted FROM group_permissions WHERE group_code = ? ORDER BY permission',
      [row.code],
    );
    const defaults = [...defaultPermissionsFor([row.code])];
    return {
      code: row.code,
      label: row.label,
      description: row.description,
      isSystem: row.is_system === 1,
      userCount: counts.get(row.code) ?? 0,
      defaultPermissions: defaults.includes('*') ? ['*'] : defaults.sort(),
      effectivePermissions: [...permissionsFor([row.code])].sort(),
      overrides: overrideRows.map((item) => ({
        permission: item.permission,
        label: permissionLabel(item.permission),
        granted: item.granted === 1,
      })),
    };
  });
}

export function createGroup(
  input: { code: string; label: string; description?: string },
  actor: AuditActor = {},
): GroupView {
  const code = input.code?.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!code) throw new Error('Nhóm phải có mã.');
  if (!input.label?.trim()) throw new Error('Nhóm phải có tên hiển thị.');
  if (one('SELECT code FROM user_groups WHERE code = ?', [code])) {
    throw new Error(`Mã nhóm "${code}" đã tồn tại.`);
  }

  const timestamp = nowIso();
  insert('user_groups', {
    code, label: input.label.trim(), description: input.description ?? null,
    is_system: 0, created_by: actor.name ?? null, created_at: timestamp, updated_at: timestamp,
  });
  logEvent({ module: 'admin', entityType: 'user_groups', entityId: code, action: 'create', after: input }, actor);
  return listGroups().find((group) => group.code === code)!;
}

export function updateGroup(
  code: string,
  input: { label?: string; description?: string },
  actor: AuditActor = {},
): GroupView {
  const before = one<Record<string, unknown>>('SELECT * FROM user_groups WHERE code = ?', [code]);
  if (!before) throw new Error('Không tìm thấy nhóm.');
  // SA-06: nhãn của vai trò hệ thống lấy từ mã nguồn, sửa ở đây sẽ bị ghi đè ở
  // lần đồng bộ kế tiếp — nói rõ thay vì để người dùng sửa xong thấy mất.
  if (before.is_system === 1 && input.label) {
    throw new Error(
      'Nhóm hệ thống lấy tên từ mã nguồn nên không đổi tên ở đây được (sẽ bị ghi đè khi hệ thống ' +
      'khởi động lại). Bạn vẫn điều chỉnh được quyền của nhóm này.',
    );
  }

  const values: Record<string, unknown> = { updated_at: nowIso() };
  if (input.label !== undefined) values.label = input.label.trim();
  if (input.description !== undefined) values.description = input.description;
  update('user_groups', code, values, 'code');
  logEvent({ module: 'admin', entityType: 'user_groups', entityId: code, action: 'update', before, after: values }, actor);
  return listGroups().find((group) => group.code === code)!;
}

export function deleteGroup(code: string, actor: AuditActor = {}): void {
  const group = one<{ code: string; is_system: number; label: string }>(
    'SELECT code, is_system, label FROM user_groups WHERE code = ?', [code],
  );
  if (!group) throw new Error('Không tìm thấy nhóm.');
  // SA-06
  if (group.is_system === 1) {
    throw new Error(`"${group.label}" là nhóm hệ thống — không xoá được. Chỉ điều chỉnh quyền của nhóm.`);
  }
  // SA-05
  const inUse = one<{ n: number }>('SELECT COUNT(*) AS n FROM user_roles WHERE role = ?', [code]);
  if ((inUse?.n ?? 0) > 0) {
    throw new Error(
      `Nhóm "${group.label}" đang có ${inUse!.n} người dùng — gỡ họ khỏi nhóm trước khi xoá, ` +
      'nếu không những tài khoản đó sẽ mất quyền mà không ai biết vì sao.',
    );
  }

  transaction(() => {
    run('DELETE FROM group_permissions WHERE group_code = ?', [code]);
    run('DELETE FROM user_groups WHERE code = ?', [code]);
  });
  invalidatePermissionCache();
  logEvent({ module: 'admin', entityType: 'user_groups', entityId: code, action: 'delete', before: group }, actor);
}

/**
 * Đặt một quyền cho nhóm: cấp thêm, thu hồi, hoặc trả về mặc định.
 *
 * `granted = null` nghĩa là XOÁ ghi đè, để quyền quay lại theo mã nguồn. Có nút
 * này thì người dùng mới dám thử — sai còn quay lại được.
 */
export function setGroupPermission(
  code: string,
  permission: string,
  granted: boolean | null,
  actor: AuditActor = {},
): GroupView {
  const group = one<{ code: string; label: string }>(
    'SELECT code, label FROM user_groups WHERE code = ?', [code],
  );
  if (!group) throw new Error('Không tìm thấy nhóm.');
  if (!allPermissionCodes().includes(permission)) {
    throw new Error(`Quyền "${permission}" không tồn tại trong danh mục.`);
  }
  if (isPlatformAdminRole(code)) {
    throw new Error(
      'Nhóm quản trị nền tảng luôn có toàn quyền và không điều chỉnh được. ' +
      'Cho phép thu hồi quyền của nhóm này thì một thao tác nhầm là khoá cứng cả hệ thống.',
    );
  }
  if (granted === true) assertCanGrant(actor.id, [permission]);

  if (granted === null) {
    run('DELETE FROM group_permissions WHERE group_code = ? AND permission = ?', [code, permission]);
  } else {
    run(
      `INSERT INTO group_permissions (group_code, permission, granted, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_code, permission) DO UPDATE SET
         granted = excluded.granted, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
      [code, permission, granted ? 1 : 0, actor.name ?? null, nowIso()],
    );
  }
  invalidatePermissionCache();
  logEvent({
    module: 'admin', entityType: 'group_permissions', entityId: `${code}:${permission}`,
    action: granted === null ? 'delete' : 'update',
    after: { group: code, permission, granted },
  }, actor);
  return listGroups().find((item) => item.code === code)!;
}

/** Trả toàn bộ nhóm về quyền mặc định theo mã nguồn. */
export function resetGroupPermissions(code: string, actor: AuditActor = {}): GroupView {
  const removed = all('SELECT permission FROM group_permissions WHERE group_code = ?', [code]).length;
  run('DELETE FROM group_permissions WHERE group_code = ?', [code]);
  invalidatePermissionCache();
  logEvent({
    module: 'admin', entityType: 'group_permissions', entityId: code,
    action: 'delete', after: { reset: true, removed },
  }, actor);
  return listGroups().find((item) => item.code === code)!;
}

// =====================================================================
// Tài khoản
// =====================================================================

export interface UserView extends User {
  roleLabels: string[];
  permissionCount: number;
  isPlatformAdmin: boolean;
  activeSessions: number;
  lastLoginAt: string | null;
}

export function listUserViews(): UserView[] {
  const sessions = new Map<string, { n: number; last: string }>();
  for (const row of all<{ user_id: string; n: number; last: string }>(
    `SELECT user_id, COUNT(*) AS n, MAX(created_at) AS last FROM sessions
      WHERE expires_at > ? GROUP BY user_id`, [nowIso()],
  )) sessions.set(row.user_id, { n: row.n, last: row.last });

  return listUsers().map((user) => {
    const permissions = permissionsFor(user.roles);
    return {
      ...user,
      roleLabels: user.roles.map((role) => ROLE_LABELS[role] ?? role),
      permissionCount: permissions.has('*') ? allPermissionCodes().length : permissions.size,
      isPlatformAdmin: user.roles.some(isPlatformAdminRole),
      activeSessions: sessions.get(user.id)?.n ?? 0,
      lastLoginAt: sessions.get(user.id)?.last ?? null,
    };
  });
}

export function userDetail(userId: string): Record<string, unknown> {
  const user = getUser(userId);
  if (!user) throw new Error('Không tìm thấy tài khoản.');
  const permissions = permissionsFor(user.roles);
  return {
    ...user,
    roleLabels: user.roles.map((role) => ROLE_LABELS[role] ?? role),
    permissions: permissions.has('*') ? allPermissionCodes() : [...permissions].sort(),
    hasAllPermissions: permissions.has('*'),
    // Quyền đến từ nhóm nào — để trả lời câu "vì sao người này vào được đây".
    byGroup: user.roles.map((role) => ({
      code: role,
      label: ROLE_LABELS[role] ?? role,
      permissions: [...permissionsFor([role])].sort(),
    })),
  };
}

/** Cập nhật thông tin hồ sơ. Không đụng tới vai trò hay mật khẩu. */
export function updateProfile(
  userId: string,
  input: { fullName?: string; email?: string; phone?: string; orgNodeId?: string | null; htxId?: string | null },
  actor: AuditActor = {},
): User {
  const before = getUser(userId);
  if (!before) throw new Error('Không tìm thấy tài khoản.');

  const values: Record<string, unknown> = { updated_at: nowIso() };
  if (input.fullName !== undefined) {
    if (!input.fullName.trim()) throw new Error('Họ tên không được để trống.');
    values.full_name = input.fullName.trim();
  }
  if (input.email !== undefined) { assertEmailAvailable(input.email, userId); values.email = input.email || null; }
  if (input.phone !== undefined) values.phone = input.phone || null;
  if (input.orgNodeId !== undefined) values.org_node_id = input.orgNodeId || null;
  if (input.htxId !== undefined) values.htx_id = input.htxId || null;

  update('users', userId, values);
  const after = getUser(userId)!;
  logEvent({ module: 'admin', entityType: 'users', entityId: userId, action: 'update', before, after }, actor);
  return after;
}

/**
 * Đặt lại danh sách nhóm của một tài khoản.
 *
 * Thay cả tập thay vì thêm/bớt từng nhóm: giao diện gửi lên trạng thái cuối
 * cùng người dùng thấy, nên không có cửa cho tình trạng lệch giữa hai bên.
 */
export function setUserRoles(userId: string, roles: string[], actor: AuditActor = {}): UserView {
  const user = getUser(userId);
  if (!user) throw new Error('Không tìm thấy tài khoản.');

  const unique = [...new Set(roles.map((role) => role.trim()).filter(Boolean))];
  if (!unique.length) {
    throw new Error('Tài khoản phải thuộc ít nhất một nhóm, nếu không sẽ không vào được cổng nào.');
  }
  // Nhóm hệ thống phải có mặt trong bảng trước khi kiểm — CSDL vừa nạp lại chưa có dòng nào
  // cho tới khi ai đó mở màn hình nhóm; gọi API thẳng sẽ bị "nhóm không tồn tại" oan.
  syncSystemGroups();
  for (const role of unique) {
    if (!one('SELECT code FROM user_groups WHERE code = ?', [role])) {
      throw new Error(`Nhóm "${role}" không tồn tại.`);
    }
  }

  const losesAdmin = user.roles.some(isPlatformAdminRole) && !unique.some(isPlatformAdminRole);
  // SA-01
  if (losesAdmin && actor.id === userId) {
    throw new Error(
      'Không tự gỡ quyền quản trị của chính mình. Nhờ một quản trị viên khác thực hiện nếu thực sự cần.',
    );
  }
  // SA-02
  if (losesAdmin) assertNotLastAdmin(userId, 'gỡ quyền quản trị');
  // SA-03: chỉ được giao nhóm mà mình đủ quyền cấp.
  const gaining = unique.filter((role) => !user.roles.includes(role));
  for (const role of gaining) {
    if (isPlatformAdminRole(role)) {
      const actorUser = actor.id ? getUser(actor.id) : null;
      if (actorUser && !permissionsFor(actorUser.roles).has('*')) {
        throw new Error('Chỉ quản trị nền tảng mới cấp được quyền quản trị nền tảng.');
      }
      continue;
    }
    // Admin được uỷ quyền TOÀN một hệ thống gán được mọi nhóm của hệ thống đó, kể cả
    // nhóm có quyền mà bản thân họ không có (kế toán ERP không cần là kế toán). Còn
    // lại giữ SA-03: không cấp thứ mình không có.
    if (!hasSystemScope(actor.id, ROLE_SYSTEM[role])) assertCanGrant(actor.id, [...permissionsFor([role])]);
  }

  transaction(() => {
    run('DELETE FROM user_roles WHERE user_id = ?', [userId]);
    for (const role of unique) insert('user_roles', { user_id: userId, role });
  });
  logEvent({
    module: 'admin', entityType: 'user_roles', entityId: userId, action: 'update',
    before: { roles: user.roles }, after: { roles: unique },
  }, actor);
  return listUserViews().find((item) => item.id === userId)!;
}

/**
 * Khoá hoặc mở khoá tài khoản.
 *
 * SA-04: khoá thì huỷ luôn mọi phiên đang mở. Không có bước này thì người bị
 * khoá vẫn dùng hệ thống bình thường cho tới khi phiên hết hạn — tức là việc
 * khoá gần như vô tác dụng đúng vào lúc cần nó nhất.
 */
export function setStatus(
  userId: string,
  status: 'active' | 'locked',
  actor: AuditActor = {},
): { user: UserView; revokedSessions: number } {
  const user = getUser(userId);
  if (!user) throw new Error('Không tìm thấy tài khoản.');

  if (status === 'locked') {
    // SA-01
    if (actor.id === userId) {
      throw new Error('Không tự khoá tài khoản của chính mình — bạn sẽ không đăng nhập lại được.');
    }
    // SA-02
    assertNotLastAdmin(userId, 'khoá');
  }

  // Đếm TRƯỚC khi khoá: `setUserStatus` tự xoá phiên, đếm sau thì luôn ra 0 và
  // giao diện sẽ báo "đã huỷ 0 phiên" ngay cả khi vừa đẩy ai đó ra khỏi hệ thống.
  const revoked = status === 'locked'
    ? all('SELECT token FROM sessions WHERE user_id = ?', [userId]).length
    : 0;

  setUserStatus(userId, status, actor);

  if (status === 'locked') {
    run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    if (revoked) {
      logEvent({
        module: 'admin', entityType: 'sessions', entityId: userId,
        action: 'delete', after: { revokedSessions: revoked, reason: 'khoa_tai_khoan' },
      }, actor);
    }
  }
  return { user: listUserViews().find((item) => item.id === userId)!, revokedSessions: revoked };
}

/** SA-07 — mật khẩu tạm chỉ trả về một lần, và buộc đổi ở lần đăng nhập kế. */
export function resetUserPassword(userId: string, actor: AuditActor = {}): {
  temporaryPassword: string; revokedSessions: number;
} {
  const user = getUser(userId);
  if (!user) throw new Error('Không tìm thấy tài khoản.');

  const temporaryPassword = resetPassword(userId, actor);
  // Đặt lại mật khẩu mà không huỷ phiên thì người đang chiếm tài khoản vẫn ở
  // trong hệ thống — đúng tình huống mà việc reset sinh ra để xử lý.
  const revoked = all('SELECT token FROM sessions WHERE user_id = ?', [userId]).length;
  run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return { temporaryPassword, revokedSessions: revoked };
}

/** Buộc đăng xuất khỏi mọi thiết bị mà không đổi mật khẩu. */
export function revokeSessions(userId: string, actor: AuditActor = {}): number {
  const revoked = all('SELECT token FROM sessions WHERE user_id = ?', [userId]).length;
  run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  logEvent({
    module: 'admin', entityType: 'sessions', entityId: userId,
    action: 'delete', after: { revokedSessions: revoked, reason: 'buoc_dang_xuat' },
  }, actor);
  return revoked;
}

/** Bảng điều hành quản trị: số liệu tổng quan về tài khoản và phân quyền. */
export function adminDashboard(): Record<string, unknown> {
  const users = listUserViews();
  const groups = listGroups();
  return {
    totalUsers: users.length,
    activeUsers: users.filter((user) => user.status === 'active').length,
    lockedUsers: users.filter((user) => user.status !== 'active').length,
    platformAdmins: users.filter((user) => user.isPlatformAdmin && user.status === 'active').length,
    mustChangePassword: users.filter((user) => user.mustChangePassword).length,
    activeSessions: users.reduce((acc, user) => acc + user.activeSessions, 0),
    totalGroups: groups.length,
    customGroups: groups.filter((group) => !group.isSystem).length,
    customisedGroups: groups.filter((group) => group.overrides.length > 0).length,
    emptyGroups: groups.filter((group) => group.userCount === 0).map((group) => group.label),
  };
}
