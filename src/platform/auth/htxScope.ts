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
import { badRequest, forbidden, unauthorized, type Context } from '../http/router.ts';
import { can } from './rbac.ts';
import { HTX_ROUTE_ALLOWLIST } from './htxRoutes.ts';

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

/**
 * H-01: tệp đính kèm không có quyền riêng — quyền đi theo ĐỐI TƯỢNG CHỦ QUẢN. Bảng ánh xạ loại đối tượng → HTX sở hữu;
 * loại chưa khai báo bị từ chối với MỌI người (fail-closed), kể cả quản trị, để buộc khai báo khi thêm loại mới.
 */
const ATTACHMENT_OWNER_SQL: Record<string, string> = {
  plot: OWNER_SQL.plots,
  farmer: OWNER_SQL.farmers,
  crop_cycle: OWNER_SQL.crop_cycles,
  farm_log: OWNER_SQL.farm_logs,
  plan_step: OWNER_SQL.production_plan_steps,
  production_plan: OWNER_SQL.production_plans,
  work_assignment: OWNER_SQL.work_assignments,
  input_purchase: OWNER_SQL.input_purchases,
  cooperative: OWNER_SQL.cooperatives,
  field_job: 'SELECT htx_id AS htx FROM field_jobs WHERE id = ?',
  field_job_stage: 'SELECT j.htx_id AS htx FROM field_job_stages s JOIN field_jobs j ON j.id = s.job_id WHERE s.id = ?',
  field_loading: 'SELECT j.htx_id AS htx FROM field_loadings l JOIN field_jobs j ON j.id = l.job_id WHERE l.id = ?',
  rental_order: 'SELECT renter_htx_id AS htx FROM rental_orders WHERE id = ?',
  rental_dispute: 'SELECT o.renter_htx_id AS htx FROM rental_disputes d JOIN rental_orders o ON o.id = d.order_id WHERE d.id = ?',
  support_task: 'SELECT htx_id AS htx FROM support_tasks WHERE id = ?',
  survey_response: 'SELECT htx_id AS htx FROM survey_responses WHERE id = ?',
  machine: 'SELECT htx_id AS htx FROM machines WHERE id = ?',
  facility: 'SELECT NULL AS htx FROM facilities WHERE id = ?',
};
/** Người không gắn HTX (cán bộ, kho, quản trị) muốn TẢI LÊN / GỠ tệp phải có quyền ghi tương ứng với loại đối tượng. */
const ATTACHMENT_WRITE_PERMISSIONS: Record<string, string[]> = {
  plot: ['htx.write', 'khuyennong.write', 'mdm.write', 'gis.write'], farmer: ['htx.write', 'khuyennong.write', 'mdm.write'],
  crop_cycle: ['htx.write', 'khuyennong.write'], farm_log: ['htx.write', 'khuyennong.write'], plan_step: ['htx.write', 'khuyennong.write'],
  production_plan: ['htx.write', 'khuyennong.write'], work_assignment: ['htx.write'], input_purchase: ['htx.write'],
  cooperative: ['mdm.write', 'khuyennong.write'], field_job: ['field.write', 'field.manage'], field_job_stage: ['field.write', 'field.manage'],
  field_loading: ['field.write', 'field.manage'], rental_order: ['rental.write'], rental_dispute: ['rental.write', 'rental.resolve'],
  support_task: ['htx.write', 'khuyennong.write'], survey_response: ['khuyennong.write'], machine: ['cgh.write', 'mdm.write'],
  facility: ['mdm.write', 'gis.write', 'warehouse.write'],
};

export function assertEntityAccess(ctx: Context, entityType: string, entityId: string, mode: 'read' | 'write'): void {
  const user = ctx.user;
  if (!user) throw unauthorized();
  const sql = ATTACHMENT_OWNER_SQL[entityType];
  if (!sql) throw forbidden(`Loại đối tượng "${entityType || '(trống)'}" chưa được khai báo phạm vi tệp đính kèm.`);
  if (!entityId) throw badRequest('Thiếu mã đối tượng gắn tệp.');
  if (isHtxBound(user)) {
    let owner: string | null = null;
    try { owner = one<{ htx: string | null }>(sql, [entityId])?.htx ?? null; } catch { owner = null; }
    if (!owner || owner !== user.htxId) throw forbidden('Bạn không có quyền với đối tượng gắn tệp này.');
    return;
  }
  if (mode === 'write') {
    const needed = ATTACHMENT_WRITE_PERMISSIONS[entityType] ?? [];
    if (!needed.some((p) => can(user.roles, p))) throw forbidden('Vai trò hiện tại không có quyền ghi trên đối tượng gắn tệp này.');
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

  // Đánh giá bảo mật 24/09/2026 (M-06): FAIL-CLOSED — tài khoản HTX chỉ gọi được route đã được rà soát phạm vi và
  // khai báo trong HTX_ROUTE_ALLOWLIST; route mới chưa khai báo bị từ chối (và test duyệt route sẽ báo đỏ).
  const routeKey = `${ctx.req.method} ${ctx.routePath}`;
  if (!HTX_ROUTE_ALLOWLIST.has(routeKey)) throw forbidden(`Route ${routeKey} chưa được khai báo phạm vi cho tài khoản hợp tác xã.`);
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

  // 4. Tham số đường dẫn — kiểm trên ĐƯỜNG DẪN ĐÃ CHUẨN HOÁ và trên ROUTE ĐÃ KHỚP (mẫu + params đã parse),
  //    nên `/inputs/purchases//ID` hay `/inputs/purchases/ID/` không lách được (review 24/09/2026, R1).
  const canonical = ctx.routePath ? ctx.routePath.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(ctx.params[name] ?? '')) : null;
  for (const candidate of new Set([pathname, canonical].filter((p): p is string => Boolean(p)))) {
    for (const [pattern, kind] of PATH_ENTITY) {
      const match = pattern.exec(candidate);
      if (match) check(kind, decodeURIComponent(match[1]));
    }
  }
}
