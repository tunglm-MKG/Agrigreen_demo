/**
 * PHẠM VI QUẢN TRỊ — mỗi hệ thống con, mỗi cấp một admin riêng; super admin quản tất cả.
 *
 * Bài toán: Trung tâm Khuyến nông tỉnh An Giang cần một người tự tạo tài khoản và
 * phân quyền cho cán bộ của tỉnh mình, nhưng người đó KHÔNG được thấy cán bộ Đồng
 * Tháp, không được đụng vào ERP, và không được sửa ma trận quyền toàn hệ thống.
 *
 * Mô hình: một PHẠM VI = (hệ thống, cấp, đơn vị).
 *   system    quản trị toàn một hệ thống con (kn / htx / cgh / gis / erp / field)
 *   province  quản trị người dùng của một hệ thống trong MỘT tỉnh
 *   htx       quản trị người dùng của một hệ thống trong MỘT hợp tác xã
 * Super admin = nhóm `platform_admin` (quyền `*`): mọi hệ thống, mọi cấp, và là
 * người duy nhất sửa được ma trận nhóm–quyền.
 *
 *   SA-08  Admin theo phạm vi chỉ THẤY và THAO TÁC trên tài khoản trong phạm vi: cùng
 *          hệ thống, và cùng tỉnh / cùng HTX nếu phạm vi ở cấp đó.
 *   SA-09  Admin theo phạm vi chỉ gán được nhóm THUỘC hệ thống mình quản; không bao
 *          giờ gán được quản trị nền tảng; không gán được nhóm hệ thống khác cho
 *          người trong phạm vi (nếu không, admin KN tỉnh cấp được quyền ERP).
 *   SA-10  Ma trận nhóm–quyền là toàn hệ thống — chỉ super admin sửa. Admin phạm vi
 *          dùng nhóm có sẵn.
 *   SA-11  Uỷ quyền phân cấp: super admin cấp phạm vi bất kỳ; admin cấp hệ thống cấp
 *          được phạm vi tỉnh / HTX TRONG hệ thống mình; admin tỉnh / HTX không uỷ
 *          quyền tiếp.
 *   SA-12  Tài khoản tạo trong phạm vi tỉnh / HTX bị GÁN CỨNG tỉnh / HTX đó — không
 *          tạo người "ở tỉnh khác" từ trong phạm vi tỉnh mình.
 */
import { all, insert, one, run } from '../db/db.ts';
import { nowIso, uuid } from '../util/ids.ts';
import { logEvent, type AuditActor } from '../audit/audit.ts';
import { permissionsFor, ROLE_LABELS, ROLE_SYSTEM, SYSTEMS, type SystemCode } from './rbac.ts';
import { getUser, type User } from './users.ts';

export type ScopeType = 'system' | 'province' | 'htx';
export const SCOPE_TYPE_LABEL: Record<ScopeType, string> = { system: 'Toàn hệ thống', province: 'Cấp tỉnh', htx: 'Cấp hợp tác xã' };

export interface AdminScope {
  id: string;
  userId: string;
  username?: string;
  fullName?: string;
  system: SystemCode;
  systemLabel: string;
  scopeType: ScopeType;
  scopeId: string | null;
  scopeName: string | null;
  label: string;
  grantedBy: string | null;
  grantedAt: string;
  note: string | null;
}

export interface AdminContext {
  user: User;
  superAdmin: boolean;
  scopes: AdminScope[];
  systems: Set<SystemCode>;
  /** Có ít nhất một phạm vi cấp hệ thống → được uỷ quyền tiếp (SA-11). */
  canDelegate: boolean;
}

type ScopeRow = { id: string; user_id: string; system: string; scope_type: string; scope_id: string | null; granted_by: string | null; granted_at: string; note: string | null; username?: string; full_name?: string };

const isSuper = (user: User) => permissionsFor(user.roles).has('*');

function scopeName(type: ScopeType, id: string | null): string | null {
  if (!id) return null;
  if (type === 'province') return one<{ name: string }>('SELECT name FROM admin_units WHERE id = ?', [id])?.name ?? id;
  if (type === 'htx') return one<{ name: string }>('SELECT name FROM cooperatives WHERE id = ?', [id])?.name ?? id;
  return null;
}

function toScope(row: ScopeRow): AdminScope {
  const type = row.scope_type as ScopeType;
  const name = scopeName(type, row.scope_id);
  const systemLabel = SYSTEMS.find((s) => s.code === row.system)?.label ?? row.system;
  return {
    id: row.id, userId: row.user_id, username: row.username, fullName: row.full_name,
    system: row.system as SystemCode, systemLabel, scopeType: type, scopeId: row.scope_id, scopeName: name,
    label: type === 'system' ? `${systemLabel} — toàn hệ thống` : `${systemLabel} — ${type === 'province' ? 'tỉnh' : 'HTX'} ${name}`,
    grantedBy: row.granted_by, grantedAt: row.granted_at, note: row.note,
  };
}

export function scopesOf(userId: string): AdminScope[] {
  try {
    return all<ScopeRow>('SELECT * FROM admin_scopes WHERE user_id = ? ORDER BY system, scope_type', [userId]).map(toScope);
  } catch {
    return []; // bảng chưa có (CSDL cũ)
  }
}

/** Bối cảnh quản trị của người đang thao tác, hoặc null nếu họ không quản trị gì. */
export function tryAdminContext(user: User | null): AdminContext | null {
  if (!user) return null;
  const superAdmin = isSuper(user);
  const scopes = superAdmin ? [] : scopesOf(user.id);
  if (!superAdmin && !scopes.length) return null;
  return {
    user, superAdmin, scopes,
    systems: new Set(scopes.map((s) => s.system)),
    canDelegate: superAdmin || scopes.some((s) => s.scopeType === 'system'),
  };
}

export function adminContext(user: User | null): AdminContext {
  const ctx = tryAdminContext(user);
  if (!ctx) throw Object.assign(new Error('Tài khoản của bạn không có quyền quản trị người dùng ở phạm vi nào.'), { status: 403 });
  return ctx;
}

export function requireSuperAdmin(user: User | null): AdminContext {
  const ctx = adminContext(user);
  if (!ctx.superAdmin) throw Object.assign(new Error('SA-10: Chỉ quản trị nền tảng mới thao tác được ở mức toàn hệ thống.'), { status: 403 });
  return ctx;
}

// ---------------------------------------------------------------------------
// Ai thuộc phạm vi nào
// ---------------------------------------------------------------------------

/** Hệ thống của một tài khoản = tập hệ thống của các nhóm nó thuộc. */
export function systemsOfUser(user: { roles: string[] }): Set<SystemCode> {
  return new Set(user.roles.map((role) => ROLE_SYSTEM[role]).filter((s): s is SystemCode => Boolean(s) && s !== '*'));
}

function userInScope(user: User, scope: AdminScope): boolean {
  if (!systemsOfUser(user).has(scope.system)) return false;
  if (scope.scopeType === 'system') return true;
  if (scope.scopeType === 'province') return user.provinceId === scope.scopeId;
  return user.htxId === scope.scopeId;
}

/** Tập id tài khoản admin này được thấy; null = tất cả (super admin). */
export function visibleUserIds(ctx: AdminContext): Set<string> | null {
  if (ctx.superAdmin) return null;
  const rows = all<{ id: string }>('SELECT id FROM users');
  const visible = new Set<string>();
  for (const row of rows) {
    const user = getUser(row.id);
    if (!user) continue;
    if (isSuper(user)) continue; // SA-08: quản trị nền tảng nằm ngoài mọi phạm vi con
    if (ctx.scopes.some((scope) => userInScope(user, scope))) visible.add(user.id);
  }
  return visible;
}

export function assertCanManage(ctx: AdminContext, targetUserId: string): User {
  const target = getUser(targetUserId);
  if (!target) throw new Error('Không tìm thấy tài khoản.');
  if (ctx.superAdmin) return target;
  if (isSuper(target)) throw new Error('SA-08: Tài khoản quản trị nền tảng không thuộc phạm vi quản trị của bạn.');
  if (!ctx.scopes.some((scope) => userInScope(target, scope))) {
    throw new Error(`SA-08: Tài khoản "${target.username}" nằm ngoài phạm vi bạn quản trị (${ctx.scopes.map((s) => s.label).join('; ')}).`);
  }
  return target;
}

/** Nhóm admin này gán được (SA-09). */
export function assignableRoles(ctx: AdminContext): string[] {
  const all = Object.keys(ROLE_LABELS);
  if (ctx.superAdmin) return all;
  return all.filter((role) => { const s = ROLE_SYSTEM[role]; return s && s !== '*' && ctx.systems.has(s); });
}

export function assertRolesAllowed(ctx: AdminContext, roles: string[]): void {
  if (ctx.superAdmin) return;
  const allowed = new Set(assignableRoles(ctx));
  const outside = roles.filter((role) => !allowed.has(role));
  if (outside.length) {
    throw new Error(`SA-09: Bạn chỉ gán được nhóm thuộc ${[...ctx.systems].map((s) => SYSTEMS.find((x) => x.code === s)?.label ?? s).join(', ')}; không gán được: ${outside.map((r) => ROLE_LABELS[r] ?? r).join(', ')}.`);
  }
}

/**
 * Ép tài khoản mới nằm trong phạm vi (SA-12): phạm vi tỉnh → gán cứng tỉnh; phạm vi
 * HTX → gán cứng HTX. Nhiều phạm vi cùng cấp thì người tạo phải chọn một trong số đó.
 */
export function coerceCreateInput<T extends { roles: string[]; provinceId?: string; htxId?: string }>(ctx: AdminContext, input: T): T {
  if (ctx.superAdmin) return input;
  assertRolesAllowed(ctx, input.roles);
  const provinces = ctx.scopes.filter((s) => s.scopeType === 'province').map((s) => s.scopeId!);
  const htxs = ctx.scopes.filter((s) => s.scopeType === 'htx').map((s) => s.scopeId!);
  const hasSystemLevel = ctx.scopes.some((s) => s.scopeType === 'system');
  if (hasSystemLevel) return input;
  const out = { ...input };
  if (provinces.length && !htxs.length) {
    if (out.provinceId && !provinces.includes(out.provinceId)) throw new Error('SA-12: Không tạo tài khoản ở tỉnh ngoài phạm vi của bạn.');
    if (!out.provinceId) { if (provinces.length === 1) out.provinceId = provinces[0]; else throw new Error('SA-12: Bạn quản trị nhiều tỉnh — chọn tỉnh cho tài khoản mới.'); }
  }
  if (htxs.length && !provinces.length) {
    if (out.htxId && !htxs.includes(out.htxId)) throw new Error('SA-12: Không tạo tài khoản ở HTX ngoài phạm vi của bạn.');
    if (!out.htxId) { if (htxs.length === 1) out.htxId = htxs[0]; else throw new Error('SA-12: Bạn quản trị nhiều HTX — chọn HTX cho tài khoản mới.'); }
  }
  if (provinces.length && htxs.length) {
    const okProvince = out.provinceId && provinces.includes(out.provinceId);
    const okHtx = out.htxId && htxs.includes(out.htxId);
    if (!okProvince && !okHtx) throw new Error('SA-12: Tài khoản mới phải thuộc một tỉnh hoặc một HTX trong phạm vi của bạn.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Uỷ quyền (SA-11)
// ---------------------------------------------------------------------------

export function listScopes(filter: { userId?: string; system?: string } = {}): AdminScope[] {
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (filter.userId) { where.push('s.user_id = ?'); params.push(filter.userId); }
  if (filter.system) { where.push('s.system = ?'); params.push(filter.system); }
  return all<ScopeRow>(
    `SELECT s.*, u.username, u.full_name FROM admin_scopes s JOIN users u ON u.id = s.user_id WHERE ${where.join(' AND ')} ORDER BY s.system, s.scope_type, u.username`,
    params,
  ).map(toScope);
}

function assertCanDelegate(granter: AdminContext, system: SystemCode, scopeType: ScopeType): void {
  if (granter.superAdmin) return;
  if (!granter.canDelegate) throw new Error('SA-11: Admin cấp tỉnh / HTX không uỷ quyền tiếp được. Nhờ admin cấp hệ thống hoặc quản trị nền tảng.');
  const owns = granter.scopes.some((s) => s.scopeType === 'system' && s.system === system);
  if (!owns) throw new Error(`SA-11: Bạn không quản trị toàn hệ thống ${SYSTEMS.find((s) => s.code === system)?.label ?? system}, nên không uỷ quyền trong hệ thống đó được.`);
  if (scopeType === 'system') throw new Error('SA-11: Admin cấp hệ thống chỉ uỷ quyền được phạm vi tỉnh / HTX, không nhân bản quyền toàn hệ thống. Việc đó là của quản trị nền tảng.');
}

export function grantScope(
  input: { userId: string; system: SystemCode; scopeType: ScopeType; scopeId?: string | null; note?: string },
  granter: AdminContext,
  actor: AuditActor = {},
): AdminScope {
  if (!SYSTEMS.some((s) => s.code === input.system)) throw new Error('Hệ thống không hợp lệ.');
  if (!SCOPE_TYPE_LABEL[input.scopeType]) throw new Error('Cấp phạm vi không hợp lệ.');
  const target = getUser(input.userId);
  if (!target) throw new Error('Không tìm thấy tài khoản được uỷ quyền.');
  if (isSuper(target)) throw new Error('Quản trị nền tảng đã có mọi phạm vi — không cần uỷ quyền thêm.');
  assertCanDelegate(granter, input.system, input.scopeType);

  let scopeId: string | null = null;
  if (input.scopeType === 'province') {
    if (!input.scopeId || !one('SELECT id FROM admin_units WHERE id = ? AND level = ?', [input.scopeId, 'province'])) throw new Error('Phạm vi cấp tỉnh phải chọn một tỉnh.');
    scopeId = input.scopeId;
  } else if (input.scopeType === 'htx') {
    if (!input.scopeId || !one('SELECT id FROM cooperatives WHERE id = ?', [input.scopeId])) throw new Error('Phạm vi cấp HTX phải chọn một hợp tác xã.');
    scopeId = input.scopeId;
  }
  // Người được uỷ quyền phải có chân trong hệ thống đó, nếu không họ không vào được cổng để quản trị.
  if (!systemsOfUser(target).has(input.system)) {
    throw new Error(`Tài khoản "${target.username}" không thuộc nhóm nào của ${SYSTEMS.find((s) => s.code === input.system)?.label} — gán nhóm trước, rồi mới uỷ quyền quản trị.`);
  }
  const dup = one<{ id: string }>('SELECT id FROM admin_scopes WHERE user_id = ? AND system = ? AND scope_type = ? AND scope_id IS ?', [input.userId, input.system, input.scopeType, scopeId]);
  if (dup) throw new Error('Phạm vi này đã được cấp cho tài khoản.');

  const record = { id: uuid(), user_id: input.userId, system: input.system, scope_type: input.scopeType, scope_id: scopeId, granted_by: actor.name ?? null, granted_at: nowIso(), note: input.note ?? null };
  insert('admin_scopes', record);
  logEvent({ module: 'admin', entityType: 'admin_scopes', entityId: record.id, action: 'create', after: record }, actor);
  return listScopes({ userId: input.userId }).find((s) => s.id === record.id)!;
}

export function revokeScope(id: string, granter: AdminContext, actor: AuditActor = {}): void {
  const row = one<ScopeRow>('SELECT * FROM admin_scopes WHERE id = ?', [id]);
  if (!row) throw new Error('Không tìm thấy phạm vi.');
  assertCanDelegate(granter, row.system as SystemCode, row.scope_type as ScopeType);
  run('DELETE FROM admin_scopes WHERE id = ?', [id]);
  logEvent({ module: 'admin', entityType: 'admin_scopes', entityId: id, action: 'delete', before: row }, actor);
}

/** Bảng điều hành thu hẹp theo phạm vi — admin tỉnh không thấy con số toàn hệ thống. */
export function scopedDashboard(ctx: AdminContext): Record<string, unknown> {
  const ids = visibleUserIds(ctx);
  const users = all<{ id: string; status: string; must_change_pw: number }>('SELECT id, status, must_change_pw FROM users').filter((u) => !ids || ids.has(u.id));
  const sessions = ids
    ? all<{ user_id: string }>('SELECT DISTINCT user_id FROM sessions WHERE expires_at > ?', [nowIso()]).filter((s) => ids.has(s.user_id)).length
    : one<{ n: number }>('SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at > ?', [nowIso()])?.n ?? 0;
  return {
    scoped: true, scopes: ctx.scopes.map((s) => s.label),
    totalUsers: users.length, activeUsers: users.filter((u) => u.status === 'active').length,
    lockedUsers: users.filter((u) => u.status === 'locked').length, platformAdmins: null,
    activeSessions: sessions, mustChangePassword: users.filter((u) => u.must_change_pw === 1).length,
  };
}

/** Danh mục cho biểu mẫu: hệ thống, tỉnh, HTX, nhóm gán được, phạm vi của tôi. */
export function adminLookups(ctx: AdminContext): Record<string, unknown> {
  const provinces = all<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM admin_units WHERE level = 'province' ORDER BY name`);
  const provinceIds = new Set(ctx.scopes.filter((s) => s.scopeType === 'province').map((s) => s.scopeId));
  const htxIds = new Set(ctx.scopes.filter((s) => s.scopeType === 'htx').map((s) => s.scopeId));
  const limitedToUnits = !ctx.superAdmin && !ctx.scopes.some((s) => s.scopeType === 'system');
  const cooperatives = all<{ id: string; code: string; name: string; province_id: string | null }>('SELECT id, code, name, province_id FROM cooperatives ORDER BY name');
  return {
    superAdmin: ctx.superAdmin,
    scopes: ctx.scopes,
    canDelegate: ctx.canDelegate,
    systems: SYSTEMS.filter((s) => ctx.superAdmin || ctx.systems.has(s.code)).map((s) => ({ code: s.code, label: s.label, roles: s.roles.map((r) => ({ code: r, label: ROLE_LABELS[r] ?? r })) })),
    allSystems: SYSTEMS.map((s) => ({ code: s.code, label: s.label })),
    assignableRoles: assignableRoles(ctx).map((r) => ({ code: r, label: ROLE_LABELS[r] ?? r, system: ROLE_SYSTEM[r] })),
    provinces: limitedToUnits && provinceIds.size ? provinces.filter((p) => provinceIds.has(p.id)) : provinces,
    cooperatives: (limitedToUnits && htxIds.size ? cooperatives.filter((c) => htxIds.has(c.id)) : limitedToUnits && provinceIds.size ? cooperatives.filter((c) => provinceIds.has(c.province_id)) : cooperatives).slice(0, 500),
    scopeTypes: SCOPE_TYPE_LABEL,
  };
}
