/**
 * QUẢN TRỊ NỀN TẢNG PHẢI "VÀO" HỆ THỐNG CON (cơ cấu phân quyền 09/2026).
 *
 * SAdmin có quyền `*` nhưng không được nhìn mọi thứ cùng lúc: mỗi phiên chỉ ở trong MỘT hệ thống con
 * (`sessions.active_system`, đặt qua POST /auth/enter-system, có nhật ký). Route nghiệp vụ của hệ thống
 * khác bị từ chối với mã `enter_system_required`. Route quản trị nền tảng (/admin, /audit, /sync, /rbac,
 * /auth, kênh thông báo) luôn mở — đó là cổng Quản trị hệ thống. Dữ liệu dùng chung (mdm, reporting)
 * dùng được khi đã ở trong bất kỳ hệ thống nào. Tài khoản khác không bị guard này đụng tới.
 */
import { HttpError, type Context } from '../http/router.ts';
import { can, systemOfPermission, SYSTEMS, type SystemCode } from './rbac.ts';

const ADMIN_PATH_PREFIXES = ['/admin', '/audit', '/sync', '/rbac', '/auth', '/notifications', '/files', '/health'];
const PATH_SYSTEM: [RegExp, SystemCode][] = [
  [/^\/(htx|inputs|production|assign)(\/|$)/, 'htx'],
  [/^\/(kn|khuyennong)(\/|$)/, 'kn'],
  [/^\/(cgh|rental)(\/|$)/, 'cgh'],
  [/^\/gis(\/|$)/, 'gis'],
  [/^\/field(\/|$)/, 'field'],
  [/^\/(erp|warehouse|sim|simulation|scenarios|tms|finance|procurement|sales|straw|mrv|parameters|reports)(\/|$)/, 'erp'],
];

/** Hệ thống con của một route: theo quyền gác route, rồi theo tiền tố đường dẫn. */
export function systemOfRoute(pathname: string, permission?: string): SystemCode | 'shared' | 'admin' | null {
  if (ADMIN_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return 'admin';
  const byPermission = systemOfPermission(permission);
  if (byPermission) return byPermission;
  for (const [pattern, system] of PATH_SYSTEM) if (pattern.test(pathname)) return system;
  return null;
}

export function enforceSuperAdminSystemContext(ctx: Context, pathname: string): void {
  const user = ctx.user;
  if (!user || !can(user.roles, '*')) return;
  const system = systemOfRoute(pathname, ctx.routePermission);
  if (system === null || system === 'admin') return;
  const active = user.activeSystem ?? null;
  if (system === 'shared') {
    if (active) return;
    throw new HttpError(403, 'Quản trị nền tảng: hãy vào một hệ thống con trước khi thao tác dữ liệu dùng chung.', { code: 'enter_system_required', system: null });
  }
  if (active === system) return;
  const label = SYSTEMS.find((s) => s.code === system)?.label ?? system;
  throw new HttpError(403, `Quản trị nền tảng: hãy vào ${label} trước khi xem hoặc thao tác tính năng này.`, { code: 'enter_system_required', system });
}
