/**
 * PHẠM VI DỮ LIỆU CỦA TÀI KHOẢN HTX — chốt ở tầng API cho MỌI route.
 *
 * Tài khoản gắn hợp tác xã (Ban quản lý HTX, nông dân) chỉ được đọc/ghi dữ liệu
 * của chính HTX mình. Trước đây chỉ vài route trong api-brd.ts tự kiểm; các route
 * còn lại tin `htxId` do người gọi gửi lên (review 24/09/2026, lỗi P1 #1).
 *
 * Guard này chạy trước handler, sau khi đã đọc body:
 *   1. `htxId` (query, body, tham số đường dẫn) khác HTX của tài khoản → 403.
 *   2. Route thuộc nhóm HTX mà thiếu `htxId` → điền HTX của tài khoản, không để
 *      tài khoản HTX đọc "tất cả".
 *   3. Mọi tham chiếu thực thể trong body/đường dẫn (thửa, vụ, lô vật tư, bước kế
 *      hoạch, nông hộ, phiếu mua…) được truy về HTX sở hữu; khác HTX → 403.
 *
 * Cán bộ khuyến nông, quản trị viên không bị ràng buộc (họ làm việc trên nhiều HTX);
 * phạm vi của họ do scopes.ts / knOps.scopeOf quyết định.
 */
import { one } from '../db/db.ts';
import { forbidden, type Context } from '../http/router.ts';
import { can } from './rbac.ts';

const HTX_BOUND_ROLES = new Set(['htx_manager', 'farmer']);
const HTX_PATH_PREFIXES = ['/htx/', '/inputs/', '/assign', '/mdm/plots', '/mdm/farmers', '/production/plans', '/reports/schedules'];
const HTX_ID_KEYS = ['htxId', 'renterHtxId', 'scopeId'];

/** Khoá trong body → loại thực thể để truy HTX sở hữu. */
const ENTITY_KEYS: Record<string, EntityKind> = {
  plotId: 'plots', excludePlotId: 'plots', cropCycleId: 'crop_cycles', stockId: 'input_stock', planStepId: 'production_plan_steps',
  stepId: 'production_plan_steps', planId: 'production_plans', purchaseId: 'input_purchases', farmerId: 'farmers', assignmentId: 'work_assignments',
};
const ENTITY_LIST_KEYS: Record<string, EntityKind> = { plotIds: 'plots', cropCycleIds: 'crop_cycles' };
const PATH_ENTITY: [RegExp, EntityKind][] = [
  [/^\/htx\/crop-cycles\/([^/]+)/, 'crop_cycles'],
  [/^\/htx\/farm-logs\/([^/]+)\/review$/, 'farm_logs'],
  [/^\/htx\/farmers\/([^/]+)/, 'farmers'],
  [/^\/htx\/advice\/([^/]+)/, 'cooperatives'],
  [/^\/production\/cycles\/([^/]+)/, 'crop_cycles'],
  [/^\/production\/plans\/([^/]+)/, 'production_plans'],
  [/^\/production\/steps\/([^/]+)/, 'production_plan_steps'],
  [/^\/assign\/steps\/([^/]+)/, 'production_plan_steps'],
  [/^\/assign\/plots\/([^/]+)/, 'plots'],
  [/^\/assign\/farmers\/([^/]+)/, 'farmers'],
  [/^\/assign\/([^/]+)(?:\/respond)?$/, 'work_assignments'],
  [/^\/mdm\/plots\/([^/]+)/, 'plots'],
  [/^\/mdm\/cooperatives\/([^/]+)/, 'cooperatives'],
  [/^\/inputs\/purchases\/([^/]+)/, 'input_purchases'],
  [/^\/inputs\/traceability\/([^/]+)/, 'crop_cycles'],
];

type EntityKind = 'plots' | 'farmers' | 'crop_cycles' | 'production_plans' | 'production_plan_steps' | 'input_stock' | 'input_purchases' | 'farm_logs' | 'cooperatives' | 'work_assignments';

const OWNER_SQL: Record<EntityKind, string> = {
  plots: 'SELECT htx_id AS htx FROM plots WHERE id = ?',
  farmers: 'SELECT htx_id AS htx FROM farmers WHERE id = ?',
  cooperatives: 'SELECT id AS htx FROM cooperatives WHERE id = ?',
  input_stock: 'SELECT htx_id AS htx FROM input_stock WHERE id = ?',
  input_purchases: 'SELECT htx_id AS htx FROM input_purchases WHERE id = ?',
  crop_cycles: 'SELECT p.htx_id AS htx FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id WHERE cc.id = ?',
  farm_logs: 'SELECT p.htx_id AS htx FROM farm_logs fl JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id WHERE fl.id = ?',
  production_plans: 'SELECT p.htx_id AS htx FROM production_plans pl JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id WHERE pl.id = ?',
  production_plan_steps: 'SELECT p.htx_id AS htx FROM production_plan_steps ps JOIN production_plans pl ON pl.id = ps.plan_id JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id WHERE ps.id = ?',
  work_assignments: 'SELECT p.htx_id AS htx FROM plan_step_assignments wa JOIN production_plan_steps ps ON ps.id = wa.plan_step_id JOIN production_plans pl ON pl.id = ps.plan_id JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id WHERE wa.id = ?',
};

/** HTX sở hữu thực thể; null khi không tìm thấy (để handler tự trả 404) hoặc bảng không tồn tại. */
export function ownerHtxOf(kind: EntityKind, id: string): string | null {
  try {
    return one<{ htx: string | null }>(OWNER_SQL[kind], [id])?.htx ?? null;
  } catch {
    return null;
  }
}

export function isHtxBound(user: Context['user']): user is NonNullable<Context['user']> & { htxId: string } {
  if (!user?.htxId) return false;
  if (!user.roles.some((role) => HTX_BOUND_ROLES.has(role))) return false;
  // Quản trị viên nền tảng / quản trị tài khoản không bị khoá vào một HTX.
  return !can(user.roles, 'admin.users');
}

export function enforceHtxScope(ctx: Context, pathname: string): void {
  const user = ctx.user;
  if (!isHtxBound(user)) return;
  const mine = user.htxId;
  const deny = () => forbidden('Bạn không có quyền truy cập dữ liệu của hợp tác xã khác.');
  const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>) : null;

  // 1. htxId tường minh phải là HTX của mình.
  for (const key of HTX_ID_KEYS) {
    const fromQuery = ctx.query.get(key);
    if (fromQuery && fromQuery !== mine) throw deny();
    if (body && typeof body[key] === 'string' && body[key] && body[key] !== mine) throw deny();
  }

  // 2. Thiếu htxId trên route HTX → mặc định là HTX của mình.
  if (HTX_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (!ctx.query.get('htxId')) ctx.query.set('htxId', mine);
    if (body && ctx.req.method !== 'GET' && body.htxId === undefined) body.htxId = mine;
  }

  // 3. Tham chiếu thực thể trong body.
  const check = (kind: EntityKind, id: unknown) => {
    if (typeof id !== 'string' || !id) return;
    const owner = ownerHtxOf(kind, id);
    if (owner && owner !== mine) throw deny();
  };
  if (body) {
    for (const [key, kind] of Object.entries(ENTITY_KEYS)) check(kind, body[key]);
    for (const [key, kind] of Object.entries(ENTITY_LIST_KEYS)) if (Array.isArray(body[key])) for (const id of body[key] as unknown[]) check(kind, id);
    for (const listKey of ['records', 'rows']) {
      const list = body[listKey];
      if (Array.isArray(list)) for (const row of list) if (row && typeof row === 'object') for (const [key, kind] of Object.entries(ENTITY_KEYS)) check(kind, (row as Record<string, unknown>)[key]);
    }
  }

  // 4. Tham số đường dẫn.
  for (const [pattern, kind] of PATH_ENTITY) {
    const match = pattern.exec(pathname);
    if (match) check(kind, decodeURIComponent(match[1]));
  }
}
