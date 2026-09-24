/**
 * Tầng API REST cho toàn hệ thống.
 *
 * Mọi endpoint đều đi qua ma trận phân quyền hợp nhất (platform/auth/rbac.ts);
 * tham số thứ 3 của mỗi route là quyền bắt buộc. Endpoint không khai báo quyền
 * là endpoint công khai (đăng nhập, health-check).
 */
import { Router, HttpError, badRequest, notFound, unauthorized, forbidden, type Context, isSecureRequest, extractToken, UPLOAD_MAX_BODY_BYTES } from './platform/http/router.ts';
import { can as roleCan } from './platform/auth/rbac.ts';
import * as files from './platform/files/attachments.ts';
import * as notifyService from './platform/notify/service.ts';
import { PERMISSION_GROUPS, PERMISSIONS as P, ROLE_LABELS, ROLE_PERMISSIONS } from './platform/auth/rbac.ts';
import * as users from './platform/auth/users.ts';
import { enforceHtxScope, isHtxBound, assertEntityAccess } from './platform/auth/htxScope.ts';
import { clientIp, hitRateLimit } from './platform/http/rateLimit.ts';
import * as sysadmin from './platform/auth/admin.ts';
import * as scopes from './platform/auth/scopes.ts';
import * as sharedFlows from './platform/sync/sharedFlows.ts';
import { databaseFiles } from './platform/db/db.ts';
import { maskNationalId } from './platform/security/fieldCrypto.ts';
import { SYSTEMS } from './platform/auth/rbac.ts';
import * as audit from './platform/audit/audit.ts';
import * as sync from './platform/sync/sync.ts';
import * as mdm from './mdm/service.ts';
import * as lifecycle from './mdm/lifecycle.ts';
import { importCooperatives } from './mdm/import/cooperatives.ts';
import {
  communeHarvestProgress, importCropSeason, listCommuneCropSeasons, listSheets,
} from './mdm/import/cropSeason.ts';
import * as gis from './agrigreen/gis/service.ts';
import * as waterways from './agrigreen/gis/waterways.ts';
import * as kn from './agrigreen/khuyennong/service.ts';
import * as htx from './agrigreen/htx/service.ts';
import * as production from './agrigreen/htx/production.ts';
import * as assignment from './agrigreen/htx/assignment.ts';
import * as inputs from './agrigreen/htx/inputs.ts';
import * as survey from './agrigreen/khuyennong/survey.ts';
import * as registry from './mdm/htxRegistry.ts';
import * as wnet from './agrigreen/gis/waterwayNetwork.ts';
import { VESSEL_CLASSES, SAFETY_MARGINS } from './platform/geo/vessels.ts';
import { DistanceService } from './platform/geo/distance.ts';
import * as cgh from './agrigreen/cgh/service.ts';
import * as rental from './agrigreen/rental/service.ts';
import * as params from './erp/params/store.ts';
import { PARAMETER_CATALOG, catalogIntegrity } from './erp/params/catalog.ts';
import * as actuals from './erp/params/actuals.ts';
import * as sim from './erp/simulation/service.ts';
import * as warehouse from './erp/warehouse/service.ts';
import * as procurement from './erp/procurement/service.ts';
import * as sales from './erp/sales/service.ts';
import * as tms from './erp/tms/service.ts';
import * as finance from './erp/finance/service.ts';
import * as reporting from './erp/reporting/service.ts';
import * as field from './erp/field/service.ts';
import * as contracts from './erp/straw/contracts.ts';
import * as tickets from './erp/straw/tickets.ts';
import * as vessels from './erp/tms/vessels.ts';
import { registerBrdRoutes } from './api-brd.ts';

const body = (ctx: Context) => (ctx.body ?? {}) as Record<string, any>;
const num = (value: unknown, fallback?: number): number => {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  if (fallback !== undefined) return fallback;
  throw badRequest('Giá trị số không hợp lệ');
};

const LOGIN_MAX_PER_WINDOW = Number(process.env.LOGIN_MAX_PER_WINDOW ?? 20);
const LOGIN_WINDOW_MS = 10 * 60_000;

export function buildApi(): Router {
  const api = new Router();

  // ===================== Xác thực & phân quyền =====================
  api.post('/auth/login', (ctx) => {
    // M-01: giới hạn theo IP song song với khoá theo tài khoản — chặn password spraying.
    const limit = hitRateLimit(`login:${clientIp(ctx.req)}`, LOGIN_MAX_PER_WINDOW, LOGIN_WINDOW_MS);
    if (!limit.allowed) {
      ctx.res.setHeader('Retry-After', String(limit.retryAfterSec));
      throw new HttpError(429, `Quá nhiều lần đăng nhập từ địa chỉ này. Thử lại sau ${Math.ceil(limit.retryAfterSec / 60)} phút.`);
    }
    const { username, password } = body(ctx);
    let session: ReturnType<typeof users.login>;
    try {
      session = users.login(String(username ?? ''), String(password ?? ''));
    } catch (error) {
      // Khoá tạm / khoá hẳn: nói rõ lý do (GIS BR-09, HTX US-ACC-01 AC-5) — mã 423 Locked.
      if (error instanceof users.LoginError) throw new HttpError(423, error.message, { code: error.code });
      throw error;
    }
    // Thông báo trung tính, không nêu sai trường nào (CGH US-ADM-01 AC-3).
    if (!session) throw badRequest('Tên đăng nhập / số điện thoại hoặc mật khẩu không đúng');
    const flags = [`mg_session=${session.token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (isSecureRequest(ctx.req)) flags.push('Secure');   // H-03: cookie phiên không đi qua HTTP
    ctx.res.setHeader('Set-Cookie', flags.join('; '));
    return { token: session.token, user: users.describeUser(session.user) };
    // unitOfWork: false — số lần sai và bộ đếm IP phải được LƯU kể cả khi handler ném lỗi.
  }, undefined, { unitOfWork: false, sensitive: true });

  api.post('/auth/logout', (ctx) => {
    const token = ctx.body?.token ?? null;
    if (token) users.logout(String(token));
    ctx.res.setHeader('Set-Cookie', 'mg_session=; Path=/; Max-Age=0');
    return { ok: true };
  });

  api.get('/auth/me', (ctx) => (ctx.user ? users.describeUser(ctx.user) : { anonymous: true }));

  api.post('/auth/password', (ctx) => {
    if (!ctx.user) throw badRequest('Chưa đăng nhập');
    // L-03: đổi mật khẩu → huỷ mọi phiên khác, giữ phiên đang thao tác.
    users.changePassword(ctx.user.id, String(body(ctx).password ?? ''), { enforcePolicy: true, keepToken: extractToken(ctx.req) });
    return { ok: true };
  }, undefined, { sensitive: true });

  api.get('/rbac/matrix', () => ({
    roles: Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({
      role,
      label: ROLE_LABELS[role] ?? role,
      permissions,
    })),
    permissions: Object.values(P),
  }));

  // ---- Quản trị hệ thống: tài khoản, nhóm người dùng, phân quyền ----
  // ===================== Tệp đính kèm (ảnh bằng chứng có EXIF) =====================
  // Ai đã đăng nhập cũng gửi và xem được; quyền với ĐỐI TƯỢNG được kiểm ở màn hình
  // gọi tới. Tệp không có quyền riêng vì nó luôn đi kèm một đối tượng nghiệp vụ.
  const requireUser = (ctx: Context) => { if (!ctx.user) throw unauthorized(); };
  // Đánh giá bảo mật 24/09/2026 (H-01): quyền với tệp = quyền với ĐỐI TƯỢNG chủ quản, kiểm ở máy chủ cho cả 4 route.
  api.post('/files', (ctx) => {
    requireUser(ctx);
    const b = body(ctx);
    assertEntityAccess(ctx, String(b.entityType ?? ''), String(b.entityId ?? ''), 'write');
    return files.saveAttachment({
      entityType: String(b.entityType ?? ''), entityId: String(b.entityId ?? ''),
      fileName: String(b.fileName ?? ''), mime: String(b.mime ?? ''), data: files.decodeUpload(String(b.data ?? '')),
      note: b.note, deviceLat: b.deviceLat === undefined || b.deviceLat === null ? undefined : num(b.deviceLat),
      deviceLng: b.deviceLng === undefined || b.deviceLng === null ? undefined : num(b.deviceLng),
    }, ctx.actor);
  }, undefined, { maxBodyBytes: UPLOAD_MAX_BODY_BYTES });
  api.get('/files', (ctx) => {
    requireUser(ctx);
    const entityType = ctx.query.get('entityType') ?? '';
    const entityId = ctx.query.get('entityId') ?? '';
    assertEntityAccess(ctx, entityType, entityId, 'read');
    return files.listAttachments(entityType, entityId);
  });
  api.get('/files/:id/content', (ctx) => {
    requireUser(ctx);
    const meta = files.attachmentMeta(ctx.params.id);
    if (!meta || meta.deleted_at) throw notFound('Không tìm thấy tệp');
    assertEntityAccess(ctx, meta.entity_type, meta.entity_id, 'read');
    const file = files.readAttachment(ctx.params.id);
    if (!file) throw notFound('Không tìm thấy tệp');
    // H-03: trả về dạng tải xuống, không nội suy loại (nosniff) — nội dung đã được đối chiếu magic bytes lúc tải lên.
    ctx.res.writeHead(200, {
      'Content-Type': file.mime, 'Content-Length': file.data.length, 'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
    ctx.res.end(file.data);
    return undefined;
  });
  api.delete('/files/:id', (ctx) => {
    requireUser(ctx);
    const meta = files.attachmentMeta(ctx.params.id);
    if (!meta) throw notFound('Không tìm thấy tệp');
    assertEntityAccess(ctx, meta.entity_type, meta.entity_id, 'write');
    files.removeAttachment(ctx.params.id, String(body(ctx).reason ?? ''), ctx.actor);
    return { ok: true };
  });

  // ===================== Thông báo =====================
  api.get('/notifications', (ctx) => {
    requireUser(ctx);
    return {
      unread: notifyService.unreadCount(ctx.user!.id),
      items: notifyService.listForUser(ctx.user!.id, { unreadOnly: ctx.query.get('unread') === '1', limit: ctx.query.get('limit') ? num(ctx.query.get('limit')) : undefined }),
    };
  });
  api.post('/notifications/read', (ctx) => {
    requireUser(ctx);
    const ids = body(ctx).ids;
    return { marked: notifyService.markRead(ctx.user!.id, ids === 'all' ? 'all' : (Array.isArray(ids) ? ids.map(String) : [])) };
  });
  api.get('/notifications/channels', () => notifyService.channelStatus(), P.ADMIN_CONFIG);
  api.put('/notifications/channels', async (ctx) => {
    const key = String(body(ctx).key ?? '');
    const value = String(body(ctx).value ?? '');
    await notifyService.assertChannelValueSafe(key, value);   // M-03: chặn SSRF trước khi lưu URL webhook
    notifyService.setChannelConfig(key, value, ctx.actor);
    return notifyService.channelStatus();
  }, P.ADMIN_CONFIG, { sensitive: true });
  api.get('/notifications/problems', () => notifyService.outboxProblems(), P.ADMIN_CONFIG);
  api.post('/notifications/scan', async () => ({ scan: notifyService.runAlertScan(), outbox: await notifyService.processOutbox() }), P.ADMIN_CONFIG);

  // ===================== Chuỗi thu mua rơm: hợp đồng, phiếu mua, danh mục ghe =====================
  api.get('/straw/contracts', (ctx) => contracts.listContracts({ htxId: ctx.query.get('htxId') || undefined, status: ctx.query.get('status') || undefined }), P.PO_READ);
  api.get('/straw/contracts/:id', (ctx) => contracts.contractDetail(ctx.params.id), P.PO_READ);
  api.post('/straw/contracts', (ctx) => contracts.createContract(body(ctx) as never, ctx.actor), P.PO_WRITE);
  api.put('/straw/contracts/:id', (ctx) => contracts.updateContract(ctx.params.id, body(ctx) as never, ctx.actor), P.PO_WRITE);
  api.post('/straw/contracts/:id/status', (ctx) => contracts.setContractStatus(ctx.params.id, body(ctx).status, ctx.actor), P.PO_WRITE);
  api.get('/straw/tickets', (ctx) => tickets.listTickets({ htxId: ctx.query.get('htxId') || undefined, status: ctx.query.get('status') || undefined }), P.PO_READ);
  api.get('/straw/tickets/:id', (ctx) => tickets.ticketDetail(ctx.params.id), P.PO_READ);
  api.post('/straw/tickets/generate/:jobId', (ctx) => tickets.generateTicketForJob(ctx.params.jobId, ctx.actor), P.PO_WRITE);
  api.post('/straw/tickets/:id/confirm', (ctx) => tickets.confirmTicket(ctx.params.id, body(ctx) as never, ctx.actor), P.PO_WRITE);
  api.post('/straw/tickets/:id/pay', (ctx) => tickets.payTicket(ctx.params.id, ctx.actor), P.FIN_WRITE);
  api.post('/straw/tickets/:id/cancel', (ctx) => tickets.cancelTicket(ctx.params.id, String(body(ctx).reason ?? ''), ctx.actor), P.PO_WRITE);
  api.get('/straw/payables', (ctx) => tickets.payables(ctx.query.get('htxId') || undefined), P.FIN_READ);
  // Cổng HTX: HTX chỉ thấy hợp đồng, phiếu và công nợ của CHÍNH MÌNH — lấy theo tài khoản, không theo tham số.
  api.get('/straw/my', (ctx) => {
    const htxId = ctx.user?.htxId;
    if (!htxId) return { contracts: [], tickets: [], payables: tickets.payables('__none__'), notice: 'Tài khoản chưa gắn với hợp tác xã nào.' };
    return { contracts: contracts.listContracts({ htxId }), tickets: tickets.listTickets({ htxId }), payables: tickets.payables(htxId) };
  }, P.HTX_READ);
  api.get('/vessels', (ctx) => vessels.listVessels({ status: ctx.query.get('status') || undefined }), P.TMS_READ);
  api.get('/vessels/lookups', () => ({ rateTypes: vessels.RATE_TYPES, classes: VESSEL_CLASSES.map((c) => ({ code: c.code, label: c.label, tons: c.tons })) }), P.TMS_READ);
  api.post('/vessels', (ctx) => vessels.createVessel(body(ctx) as never, ctx.actor), P.TMS_WRITE);
  api.put('/vessels/:id', (ctx) => vessels.updateVessel(ctx.params.id, body(ctx) as never, ctx.actor), P.TMS_WRITE);

  // ===================== Quản lý hiện trường (đội thu gom rơm) =====================
  api.get('/field/lookups', () => field.fieldLookups(), P.FIELD_READ);
  api.get('/field/dashboard', (ctx) => field.fieldDashboard(ctx.query.get('date') || undefined), P.FIELD_READ);
  api.get('/field/teams', () => field.listTeams(), P.FIELD_READ);
  api.post('/field/teams', (ctx) => field.createTeam(body(ctx) as never, ctx.actor), P.FIELD_MANAGE);
  api.put('/field/teams/:id', (ctx) => field.updateTeam(ctx.params.id, body(ctx), ctx.actor), P.FIELD_MANAGE);
  api.post('/field/teams/:id/members', (ctx) => field.addMember(ctx.params.id, body(ctx) as never, ctx.actor), P.FIELD_MANAGE);
  api.post('/field/members/:id/status', (ctx) => {
    field.setMemberStatus(ctx.params.id, body(ctx).status, ctx.actor);
    return { ok: true };
  }, P.FIELD_MANAGE);
  api.get('/field/vehicles', (ctx) => field.listVehicles({
    teamId: ctx.query.get('teamId') || undefined, kind: ctx.query.get('kind') || undefined, unassigned: ctx.query.get('unassigned') === '1',
  }), P.FIELD_READ);
  api.post('/field/vehicles', (ctx) => field.createVehicle(body(ctx) as never, ctx.actor), P.FIELD_MANAGE);
  api.put('/field/vehicles/:id', (ctx) => field.updateVehicle(ctx.params.id, body(ctx), ctx.actor), P.FIELD_MANAGE);

  api.get('/field/jobs', (ctx) => field.listJobs({
    status: ctx.query.get('status') || undefined, teamId: ctx.query.get('teamId') || undefined,
    from: ctx.query.get('from') || undefined, to: ctx.query.get('to') || undefined, htxId: ctx.query.get('htxId') || undefined,
    onlyOverdue: ctx.query.get('overdue') === '1', limit: ctx.query.get('limit') ? num(ctx.query.get('limit')) : undefined,
  }), P.FIELD_READ);
  api.get('/field/jobs/:id', (ctx) => field.jobDetail(ctx.params.id), P.FIELD_READ);
  api.post('/field/jobs', (ctx) => field.createJob(body(ctx) as never, ctx.actor), P.FIELD_MANAGE);
  api.post('/field/jobs/:id/assign', (ctx) => field.assignJob(ctx.params.id, body(ctx) as never, ctx.actor), P.FIELD_MANAGE);
  api.post('/field/jobs/:id/unassign', (ctx) => field.unassignJob(ctx.params.id, ctx.actor), P.FIELD_MANAGE);
  api.post('/field/jobs/:id/cancel', (ctx) => field.cancelJob(ctx.params.id, String(body(ctx).reason ?? ''), ctx.actor), P.FIELD_MANAGE);
  api.post('/field/jobs/:id/stages/:stage/start', (ctx) =>
    field.startStage(ctx.params.id, ctx.params.stage as never, body(ctx), ctx.actor), P.FIELD_WRITE);
  api.post('/field/jobs/:id/stages/:stage/complete', (ctx) =>
    field.completeStage(ctx.params.id, ctx.params.stage as never, body(ctx) as never, ctx.actor), P.FIELD_WRITE);
  api.post('/field/jobs/:id/loadings', (ctx) => field.recordLoading(ctx.params.id, body(ctx) as never, ctx.actor), P.FIELD_WRITE);

  // Cân tại nhà máy: kho (warehouse.write) hoặc điều hành hiện trường (field.manage) đều ghi được.
  api.get('/field/weighings/pending', () => field.pendingWeighings(), P.FIELD_READ);
  api.post('/field/loadings/:id/weigh', (ctx) => {
    if (!roleCan(ctx.user!.roles, P.WH_WRITE) && !roleCan(ctx.user!.roles, P.FIELD_MANAGE)) {
      throw forbidden('Ghi cân nhà máy cần quyền nhập kho hoặc quyền điều hành hiện trường');
    }
    return field.recordPlantWeighing(ctx.params.id, body(ctx) as never, ctx.actor);
  }, P.FIELD_READ);
  api.get('/field/reconciliation', (ctx) => field.weighingReconciliation(
    ctx.query.get('from') ?? undefined, ctx.query.get('to') ?? undefined), P.FIELD_READ);
  api.get('/field/bale-kg', (ctx) => field.baleKg(ctx.query.get('htxId') || null), P.FIELD_READ);

  api.get('/field/calendar', (ctx) => field.harvestCalendar(
    ctx.query.get('from') || undefined, ctx.query.get('days') ? num(ctx.query.get('days')) : undefined), P.FIELD_READ);
  api.post('/field/calendar/sync', (ctx) => field.syncHarvestCalendar(
    body(ctx).fromDate, body(ctx).days ? num(body(ctx).days) : undefined, ctx.actor), P.FIELD_MANAGE);
  api.post('/field/auto-assign', (ctx) => field.autoAssign(body(ctx) as never, ctx.actor), P.FIELD_MANAGE);
  api.get('/field/report', (ctx) => {
    if (!ctx.query.get('from') || !ctx.query.get('to')) throw badRequest('Thiếu khoảng thời gian from / to');
    return field.productivityReport(ctx.query.get('from'), ctx.query.get('to'));
  }, P.FIELD_READ);

  // ===================== Quản trị người dùng theo PHẠM VI (SA-08..12) =====================
  // Không dùng quyền tĩnh: super admin (quyền *) hoặc người có phạm vi được uỷ quyền
  // mới vào; mỗi thao tác tự kiểm tài khoản đích có nằm trong phạm vi không.
  const adminCtx = (ctx: Context) => {
    if (!ctx.user) throw unauthorized();
    try { return scopes.adminContext(ctx.user); } catch (error) { throw forbidden((error as Error).message); }
  };
  const superOnly = (ctx: Context) => {
    if (!ctx.user) throw unauthorized();
    try { return scopes.requireSuperAdmin(ctx.user); } catch (error) { throw forbidden((error as Error).message); }
  };
  api.get('/admin/dashboard', (ctx) => { const a = adminCtx(ctx); return a.superAdmin ? { ...sysadmin.adminDashboard(), scoped: false } : scopes.scopedDashboard(a); });
  api.get('/admin/lookups', (ctx) => scopes.adminLookups(adminCtx(ctx)));
  api.get('/admin/user-views', (ctx) => {
    const visible = scopes.visibleUserIds(adminCtx(ctx));
    const views = sysadmin.listUserViews();
    return visible ? views.filter((v) => visible.has(v.id)) : views;
  });
  api.get('/admin/users/:id', (ctx) => { scopes.assertCanManage(adminCtx(ctx), ctx.params.id); return { ...sysadmin.userDetail(ctx.params.id), adminScopes: scopes.scopesOf(ctx.params.id) }; });
  api.put('/admin/users/:id', (ctx) => { scopes.assertCanManage(adminCtx(ctx), ctx.params.id); return sysadmin.updateProfile(ctx.params.id, body(ctx) as never, ctx.actor); });
  api.put('/admin/users/:id/roles', (ctx) => {
    const a = adminCtx(ctx);
    scopes.assertCanManage(a, ctx.params.id);
    const roles = (body(ctx).roles ?? []) as string[];
    scopes.assertRolesAllowed(a, roles);
    return sysadmin.setUserRoles(ctx.params.id, roles, ctx.actor);
  });
  api.post('/admin/users/:id/set-status', (ctx) => { scopes.assertCanManage(adminCtx(ctx), ctx.params.id); return sysadmin.setStatus(ctx.params.id, body(ctx).status, ctx.actor); });
  api.post('/admin/users/:id/reset-pw', (ctx) => resetWithEmail(ctx));
  api.post('/admin/users/:id/revoke-sessions', (ctx) => { scopes.assertCanManage(adminCtx(ctx), ctx.params.id); return { revokedSessions: sysadmin.revokeSessions(ctx.params.id, ctx.actor) }; });
  api.get('/admin/users', (ctx) => { const visible = scopes.visibleUserIds(adminCtx(ctx)); const list = users.listUsers(); return visible ? list.filter((u) => visible.has(u.id)) : list; });
  // Tạo tài khoản: trả mật khẩu tạm MỘT lần để quản trị viên copy; tuỳ chọn gửi email cho người dùng.
  api.post('/admin/users', (ctx) => {
    const a = adminCtx(ctx);
    const input = scopes.coerceCreateInput(a, body(ctx) as never) as { roles?: string[]; htxId?: string | null };
    // UAT DEF-ADM-01 (US-ACC-01 AC-7): tài khoản Nông dân / Quản lý HTX phải liên kết một HTX.
    if ((input.roles ?? []).some((r) => r === 'farmer' || r === 'htx_manager') && !input.htxId) {
      throw badRequest('Tài khoản vai trò Nông dân / Quản lý HTX phải chọn Hợp tác xã liên kết.');
    }
    const created = users.createUser(input as never, ctx.actor);
    const email = body(ctx).sendEmail ? notifyService.sendCredentialEmail(created.user.id, { username: created.user.username, temporaryPassword: created.temporaryPassword, kind: 'created' }, ctx.actor) : null;
    return { ...created, email };
  }, undefined, { sensitive: true });   // M-02: phản hồi chứa mật khẩu tạm — không lưu vào bảng chống trùng
  const resetWithEmail = (ctx: Context) => {
    scopes.assertCanManage(adminCtx(ctx), ctx.params.id);
    const result = sysadmin.resetUserPassword(ctx.params.id, ctx.actor);
    const target = users.getUser(ctx.params.id);
    const email = body(ctx)?.sendEmail && target ? notifyService.sendCredentialEmail(target.id, { username: target.username, temporaryPassword: result.temporaryPassword, kind: 'reset' }, ctx.actor) : null;
    return { ...result, email };
  };
  api.post('/admin/users/:id/status', (ctx) => { scopes.assertCanManage(adminCtx(ctx), ctx.params.id); return sysadmin.setStatus(ctx.params.id, body(ctx).status, ctx.actor); });
  api.post('/admin/users/:id/reset-password', (ctx) => resetWithEmail(ctx), undefined, { sensitive: true });

  // Ma trận nhóm–quyền: toàn hệ thống → chỉ super admin (SA-10).
  // Danh mục quyền (nhãn tiếng Việt) — admin phạm vi cũng cần để đọc ma trận, chỉ SỬA mới là super admin.
  api.get('/admin/permissions', (ctx) => { adminCtx(ctx); return { groups: PERMISSION_GROUPS, roles: ROLE_LABELS, defaults: ROLE_PERMISSIONS }; });
  api.get('/admin/groups', (ctx) => { adminCtx(ctx); return sysadmin.listGroups(); });
  api.post('/admin/groups', (ctx) => { superOnly(ctx); return sysadmin.createGroup(body(ctx) as never, ctx.actor); });
  api.put('/admin/groups/:code', (ctx) => { superOnly(ctx); return sysadmin.updateGroup(ctx.params.code, body(ctx) as never, ctx.actor); });
  api.delete('/admin/groups/:code', (ctx) => { superOnly(ctx); sysadmin.deleteGroup(ctx.params.code, ctx.actor); return { ok: true }; });
  api.put('/admin/groups/:code/permission', (ctx) => { superOnly(ctx); return sysadmin.setGroupPermission(ctx.params.code, String(body(ctx).permission), body(ctx).granted === null ? null : Boolean(body(ctx).granted), ctx.actor); });
  api.post('/admin/groups/:code/reset', (ctx) => { superOnly(ctx); return sysadmin.resetGroupPermissions(ctx.params.code, ctx.actor); });

  // Uỷ quyền phạm vi (SA-11).
  api.get('/admin/scopes', (ctx) => {
    const a = adminCtx(ctx);
    const list = scopes.listScopes({ system: ctx.query.get('system') || undefined });
    return a.superAdmin ? list : list.filter((s) => a.systems.has(s.system));
  });
  api.post('/admin/scopes', (ctx) => scopes.grantScope(body(ctx) as never, adminCtx(ctx), ctx.actor));
  api.delete('/admin/scopes/:id', (ctx) => { scopes.revokeScope(ctx.params.id, adminCtx(ctx), ctx.actor); return { ok: true }; });

  // Miền dữ liệu & luồng đồng bộ dữ liệu dùng chung.
  api.get('/admin/data-domains', (ctx) => { superOnly(ctx); return { files: databaseFiles(), sync: sharedFlows.overview(SYSTEMS.map((s) => s.code)) }; });
  api.get('/sync/shared/feed', (ctx) => {
    const a = adminCtx(ctx);
    const system = ctx.query.get('system') as never;
    if (!SYSTEMS.some((s) => s.code === system)) throw badRequest('Thiếu hoặc sai tham số system');
    if (!a.superAdmin && !a.systems.has(system)) throw forbidden('Chỉ đọc được feed của hệ thống mình quản trị');
    return sharedFlows.feedFor(system, ctx.query.get('since') ? num(ctx.query.get('since')) : sharedFlows.cursorOf(system), ctx.query.get('limit') ? num(ctx.query.get('limit')) : undefined);
  });
  api.post('/sync/shared/ack', (ctx) => {
    const a = adminCtx(ctx);
    const system = String(body(ctx).system) as never;
    if (!SYSTEMS.some((s) => s.code === system)) throw badRequest('Thiếu hoặc sai tham số system');
    if (!a.superAdmin && !a.systems.has(system)) throw forbidden('Chỉ ack được feed của hệ thống mình quản trị');
    sharedFlows.ack(system, num(body(ctx).seq));
    return { system, cursor: sharedFlows.cursorOf(system) };
  });

  // ===================== Nhật ký, snapshot, replay =====================
  api.get('/audit/events', (ctx) =>
    audit.queryEvents({
      module: ctx.query.get('module') ?? undefined,
      entityType: ctx.query.get('entityType') ?? undefined,
      entityId: ctx.query.get('entityId') ?? undefined,
      limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
    }), P.GIS_READ);
  api.post('/audit/snapshot', (ctx) => ({ layers: audit.captureSnapshot(body(ctx).date) }), P.GIS_ADMIN);
  api.get('/audit/replay/:date', (ctx) => audit.replay(ctx.params.date), P.GIS_READ);
  api.get('/audit/retention', () => audit.getRetentionPolicy(), P.GIS_READ);
  api.put('/audit/retention', (ctx) => {
    audit.setRetentionPolicy(body(ctx) as never, ctx.actor);
    return audit.getRetentionPolicy();
  }, P.GIS_ADMIN);
  api.post('/audit/retention/apply', () => audit.applyRetention(), P.GIS_ADMIN);

  // ===================== Đồng bộ tích hợp =====================
  api.get('/sync/logs', (ctx) =>
    sync.listSyncLogs({
      system: ctx.query.get('system') ?? undefined,
      status: ctx.query.get('status') ?? undefined,
    }), P.GIS_READ);
  api.get('/sync/health', () => sync.syncHealth(), P.GIS_READ);
  api.post('/sync/retry', () => sync.processRetries(), P.GIS_ADMIN);

  // ===================== Master Data =====================
  api.get('/mdm/summary', () => mdm.masterDataSummary(), P.MDM_READ);
  api.get('/mdm/admin-units', (ctx) => mdm.listAdminUnits(ctx.query.get('level') ?? undefined), P.MDM_READ);
  api.get('/mdm/cooperatives', (ctx) =>
    mdm.listCooperatives({
      provinceId: ctx.query.get('provinceId') ?? undefined,
      search: ctx.query.get('q') ?? undefined,
    }), P.MDM_READ);
  api.post('/mdm/cooperatives', (ctx) => mdm.createCooperative(body(ctx) as never, ctx.actor), P.MDM_WRITE);
  api.put('/mdm/cooperatives/:id', (ctx) => mdm.updateCooperative(ctx.params.id, body(ctx), ctx.actor), P.MDM_WRITE);
  api.post('/mdm/cooperatives/:id/status', (ctx) => {
    mdm.setCooperativeStatus(ctx.params.id, body(ctx).status, ctx.actor);
    return { ok: true };
  }, P.MDM_WRITE);
  api.get('/mdm/farmers', (ctx) => mdm.listFarmers(ctx.query.get('htxId') ?? undefined).map((f) => ({ ...f, national_id: maskNationalId(f.national_id) })), P.MDM_READ);
  api.post('/mdm/farmers', (ctx) => mdm.createFarmer(body(ctx) as never, ctx.actor), P.MDM_WRITE);
  api.get('/mdm/plots', (ctx) => mdm.listPlots(ctx.query.get('htxId') ?? undefined), P.MDM_READ);
  // UAT DEF-KN-PLOT-01/02: mọi đường tạo thửa (kể cả cán bộ khuyến nông vẽ hộ) đều qua kiểm tra ≥ 4 điểm, không tự cắt, chồng lấn.
  api.post('/mdm/plots', (ctx) => {
    try {
      return lifecycle.createPlotChecked(body(ctx) as never, ctx.actor);
    } catch (error) {
      const e = error as Error & { needsConfirm?: boolean; overlaps?: unknown };
      if (e.needsConfirm) throw new HttpError(409, e.message, { needsConfirm: true, overlaps: e.overlaps ?? null });
      throw error;
    }
  }, P.MDM_WRITE);
  api.put('/mdm/plots/:id/boundary', (ctx) => mdm.updatePlotBoundary(ctx.params.id, body(ctx).boundary, ctx.actor), P.MDM_WRITE);
  api.get('/mdm/facilities', (ctx) => mdm.listFacilities(ctx.query.get('kind') ?? undefined), P.MDM_READ);
  api.post('/mdm/facilities', (ctx) => mdm.createFacility(body(ctx) as never, ctx.actor), P.MDM_WRITE);
  api.put('/mdm/facilities/:id', (ctx) => mdm.updateFacility(ctx.params.id, body(ctx) as never, ctx.actor), P.MDM_WRITE);
  api.get('/mdm/facilities/:id/zones', (ctx) => mdm.listStorageZones(ctx.params.id), P.MDM_READ);
  api.get('/mdm/seasons', () => mdm.listSeasons(), P.MDM_READ);
  api.get('/mdm/partners', (ctx) => mdm.listPartners(ctx.query.get('kind') ?? undefined), P.MDM_READ);
  api.get('/mdm/items', () => mdm.listItems(), P.MDM_READ);
  api.get('/mdm/harvest-statistics', (ctx) => mdm.listHarvestStatistics(ctx.query.get('htxId') ?? undefined), P.MDM_READ);
  api.post('/mdm/harvest-statistics', (ctx) => {
    mdm.upsertHarvestStatistic(body(ctx) as never, ctx.actor);
    return { ok: true };
  }, P.MDM_WRITE);

  // ===================== Nhập dữ liệu từ Excel =====================
  // Client gửi file dạng base64 trong JSON để tránh phải phân tích multipart.
  const decodeUpload = (ctx: Context): { buffer: Buffer; fileName: string } => {
    const payload = body(ctx);
    const base64 = String(payload.contentBase64 ?? '');
    if (!base64) throw badRequest('Thiếu nội dung file (contentBase64).');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) throw badRequest('File rỗng hoặc không giải mã được.');
    if (buffer.length > 25 * 1024 * 1024) throw badRequest('File vượt quá 25 MB.');
    return { buffer, fileName: String(payload.fileName ?? 'upload.xlsx') };
  };

  api.post('/import/sheets', (ctx) => {
    const { buffer, fileName } = decodeUpload(ctx);
    return { fileName, sheets: listSheets(buffer) };
  }, P.MDM_READ);

  api.post('/import/cooperatives', (ctx) => {
    const { buffer, fileName } = decodeUpload(ctx);
    const payload = body(ctx);
    return importCooperatives(
      buffer,
      {
        fileName,
        sheetName: payload.sheetName,
        dryRun: payload.dryRun !== false,
        updateExisting: Boolean(payload.updateExisting),
      },
      ctx.actor,
    );
  }, P.MDM_WRITE);

  api.post('/import/crop-season', (ctx) => {
    const { buffer, fileName } = decodeUpload(ctx);
    const payload = body(ctx);
    return importCropSeason(
      buffer,
      {
        fileName,
        sheetName: payload.sheetName,
        seasonCode: payload.seasonCode,
        defaultProvince: payload.defaultProvince,
        dryRun: payload.dryRun !== false,
      },
      ctx.actor,
    );
  }, P.KN_WRITE);

  api.get('/crop-seasons/communes', (ctx) =>
    listCommuneCropSeasons(ctx.query.get('seasonId') ?? undefined), P.KN_READ);
  api.get('/crop-seasons/communes/:id/progress', (ctx) => communeHarvestProgress(ctx.params.id), P.KN_READ);

  // ===================== Nền tảng GIS dùng chung =====================
  api.get('/gis/map', (ctx) => {
    const bboxParam = ctx.query.get('bbox');
    const bbox = bboxParam
      ? (() => {
          const [south, west, north, east] = bboxParam.split(',').map(Number);
          return { south, west, north, east };
        })()
      : undefined;
    return gis.buildMapBundle({
      layers: ctx.query.get('layers')?.split(',').filter(Boolean),
      zoom: ctx.query.get('zoom') ? Number(ctx.query.get('zoom')) : undefined,
      bbox,
      date: ctx.query.get('date') ?? undefined,
    });
  }, P.GIS_READ);
  api.get('/gis/heatmap', () => gis.cropHeatmap(), P.GIS_READ);
  api.get('/gis/harvest-alerts', (ctx) => gis.harvestAlerts(Number(ctx.query.get('days') ?? 3)), P.GIS_READ);
  api.get('/gis/capacity', () => gis.capacityWidgets(), P.GIS_READ);
  api.get('/gis/weather', (ctx) => gis.weatherLayer(ctx.query.get('date') ?? undefined), P.GIS_READ);
  api.get('/gis/config/:key', (ctx) => gis.getConfig(ctx.params.key, null), P.GIS_READ);
  api.put('/gis/config/:key', (ctx) => {
    gis.setConfig(ctx.params.key, body(ctx).value, ctx.actor);
    return { ok: true };
  }, P.GIS_ADMIN);
  api.post('/gis/ingest', (ctx) => gis.ingest(body(ctx) as never, ctx.actor), P.GIS_WRITE);
  api.post('/gis/publish/:consumer', (ctx) => gis.publishStandardBundle(ctx.params.consumer, ctx.actor), P.GIS_WRITE);

  // ----- FN-20: số hoá & đo tuyến -----
  api.get('/gis/routes', (ctx) =>
    waterways.listRoutes({
      mode: (ctx.query.get('mode') as never) ?? undefined,
      status: (ctx.query.get('status') as never) ?? undefined,
    }), P.GIS_READ);
  api.post('/gis/routes', (ctx) => waterways.createRoute(body(ctx) as never, ctx.actor), P.GIS_WRITE);
  api.put('/gis/routes/:id/geometry', (ctx) => waterways.updateRouteGeometry(ctx.params.id, body(ctx).points, ctx.actor), P.GIS_WRITE);
  api.post('/gis/routes/:id/status', (ctx) => waterways.setRouteStatus(ctx.params.id, body(ctx).status, ctx.actor), P.GIS_WRITE);
  api.delete('/gis/routes/:id', (ctx) => {
    waterways.deleteRoute(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.GIS_WRITE);
  api.post('/gis/measure', (ctx) => waterways.measure(body(ctx).points), P.GIS_READ);
  api.get('/gis/routes/export.geojson', (ctx) => waterways.exportGeoJson({ mode: (ctx.query.get('mode') as never) ?? undefined }), P.GIS_READ);
  api.get('/gis/routes/export.kml', (ctx) => {
    const kml = waterways.exportKml({ mode: (ctx.query.get('mode') as never) ?? undefined });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/vnd.google-earth.kml+xml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="mekonggreen-routes.kml"',
    });
    ctx.res.end(kml);
    return undefined;
  }, P.GIS_READ);
  api.post('/gis/routes/import', (ctx) => waterways.importGeoJson(body(ctx).featureCollection, body(ctx).options, ctx.actor), P.GIS_WRITE);

  // ===================== App Khuyến nông =====================
  api.get('/kn/org-tree', () => kn.orgTree(), P.KN_READ);
  api.post('/kn/org-nodes', (ctx) => kn.createOrgNode(body(ctx) as never, ctx.actor), P.KN_PUBLISH);
  api.get('/kn/articles', (ctx) =>
    kn.listArticles({
      kind: ctx.query.get('kind') ?? undefined,
      status: ctx.query.get('status') ?? undefined,
      scopeNodeId: ctx.query.get('scopeNodeId') ?? undefined,
    }), P.KN_READ);
  api.post('/kn/articles', (ctx) => kn.createArticle(body(ctx) as never, ctx.actor), P.KN_WRITE);
  api.post('/kn/articles/:id/publish', (ctx) => kn.publishArticle(ctx.params.id, ctx.actor), P.KN_PUBLISH);
  api.get('/kn/tasks', (ctx) =>
    kn.listTasks({
      status: ctx.query.get('status') ?? undefined,
      assigneeId: ctx.query.get('assigneeId') ?? undefined,
      htxId: ctx.query.get('htxId') ?? undefined,
    }), P.KN_READ);
  api.post('/kn/tasks/:id/advance', (ctx) => kn.advanceTask(ctx.params.id, body(ctx).status, body(ctx), ctx.actor), P.KN_WRITE);
  api.post('/kn/broadcast', (ctx) => kn.broadcastDirective(body(ctx) as never, ctx.actor), P.KN_PUBLISH);
  api.get('/kn/directory', (ctx) => kn.directory(ctx.query.get('orgNodeId') ?? undefined), P.KN_READ);
  api.post('/kn/directory', (ctx) => kn.upsertOfficer(body(ctx) as never, ctx.actor), P.KN_WRITE);
  api.get('/kn/prices', (ctx) => kn.priceBoard(ctx.query.get('commodity') ?? undefined), P.KN_READ);
  // UAT DEF-KN-03: giá thị trường là Master Data (FN-17 BR-01) — chỉ cấp có quyền công bố (Admin/TTKN) mới ghi được,
  // cán bộ xã (khuyennong.write) chỉ đọc. Cùng nguyên tắc cho cây tổ chức và mở khoá đào tạo.
  api.post('/kn/prices', (ctx) => {
    kn.upsertMarketPrice(body(ctx) as never, ctx.actor);
    return { ok: true };
  }, P.KN_PUBLISH);
  api.delete('/kn/prices/:id', (ctx) => { kn.deleteMarketPrice(ctx.params.id, ctx.actor); return { ok: true }; }, P.KN_PUBLISH);
  api.get('/kn/courses', () => kn.listCourses(), P.KN_READ);
  api.post('/kn/courses', (ctx) => kn.createCourse(body(ctx) as never, ctx.actor), P.KN_PUBLISH);
  api.post('/kn/courses/:id/enrol', (ctx) => kn.enrol(ctx.params.id, body(ctx) as never), P.KN_WRITE);
  api.get('/kn/network-map', () => kn.networkMap(), P.KN_READ);
  api.get('/kn/dashboard', () => kn.dashboard(), P.KN_READ);
  api.post('/kn/push-to-app-htx', (ctx) => kn.pushToAppHtx(ctx.actor), P.KN_PUBLISH);

  // ===================== App Hợp tác xã =====================
  api.get('/htx/dashboard', (ctx) => htx.dashboard(ctx.query.get('htxId') ?? undefined), P.HTX_READ);
  api.get('/htx/crop-cycles', (ctx) => htx.listCropCycles(ctx.query.get('htxId') ?? undefined), P.HTX_READ);
  api.post('/htx/crop-cycles', (ctx) => htx.openCropCycle(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.get('/htx/crop-cycles/:id/logs', (ctx) => htx.listFarmLogs(ctx.params.id), P.HTX_READ);
  api.post('/htx/farm-logs', (ctx) => htx.addFarmLog(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/htx/farm-logs/sync', (ctx) => htx.syncOfflineLogs(body(ctx).records ?? [], ctx.actor), P.HTX_WRITE);
  api.post('/htx/harvest', (ctx) => htx.declareHarvest(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/htx/support-requests', (ctx) => htx.requestSupport(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/htx/verify-location', (ctx) => htx.verifyLocation(body(ctx).plotId, { lat: num(body(ctx).lat), lng: num(body(ctx).lng) }), P.HTX_READ);
  api.get('/htx/advice/:htxId', (ctx) => htx.farmingAdvice(ctx.params.htxId), P.HTX_READ);
  api.get('/htx/gps-logs', (ctx) => htx.listGpsLogs(ctx.query.get('refId') ?? undefined), P.HTX_READ);
  api.get('/htx/activities', () => htx.FARM_ACTIVITIES, P.HTX_READ);

  // ---- Quy trình sản xuất chuẩn & kế hoạch sản xuất (App Hợp tác xã) ----
  api.get('/production/standards', () => ({
    standards: production.PROTOCOL_STANDARDS,
    evidenceKinds: production.EVIDENCE_KINDS,
    stepStatus: production.STEP_STATUS,
  }), P.HTX_READ);

  api.get('/production/protocols', (ctx) => production.listProtocols({
    status: ctx.query.get('status') ?? undefined,
    htxId: ctx.query.get('htxId') ?? undefined,
  }), P.HTX_READ);
  api.get('/production/protocols/:id', (ctx) => ({
    protocol: production.getProtocol(ctx.params.id) ?? notFoundResult(),
    steps: production.listProtocolSteps(ctx.params.id),
  }), P.HTX_READ);
  api.post('/production/protocols', (ctx) => production.createProtocol(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/production/protocols/:id/steps', (ctx) =>
    production.addProtocolStep(ctx.params.id, body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.delete('/production/steps/:id', (ctx) => {
    production.removeProtocolStep(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.HTX_WRITE);
  api.post('/production/protocols/:id/publish', (ctx) =>
    production.publishProtocol(ctx.params.id, ctx.actor), P.HTX_WRITE);
  api.post('/production/protocols/:id/clone', (ctx) =>
    production.cloneProtocol(ctx.params.id, body(ctx) as never, ctx.actor), P.HTX_WRITE);

  // Rút quy trình mới từ một vụ đã hoàn thành (nhật ký hoặc kế hoạch đã thực hiện).
  api.get('/production/derivable-cycles', (ctx) =>
    production.cyclesEligibleForDerivation(ctx.query.get('htxId') ?? undefined), P.HTX_READ);
  api.get('/production/cycles/:id/derive-preview', (ctx) =>
    production.previewProtocolFromCycle(ctx.params.id), P.HTX_READ);
  api.post('/production/protocols/from-cycle', (ctx) =>
    production.createProtocolFromCycle(body(ctx) as never, ctx.actor), P.HTX_WRITE);

  api.get('/production/plans', (ctx) => production.listPlans(ctx.query.get('htxId') ?? undefined), P.HTX_READ);
  api.get('/production/plans/:id', (ctx) => ({
    plan: production.getPlan(ctx.params.id) ?? notFoundResult(),
    steps: production.listPlanSteps(ctx.params.id),
    progress: production.planProgress(ctx.params.id),
  }), P.HTX_READ);
  api.get('/production/cycles/:id/plan', (ctx) => production.planForCycle(ctx.params.id) ?? { plan: null }, P.HTX_READ);
  api.get('/production/cycles/:id/traceability', (ctx) =>
    production.traceabilityRecord(ctx.params.id) ?? { plan: null }, P.HTX_READ);
  api.post('/production/plans', (ctx) => production.generatePlan(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.delete('/production/plans/:id', (ctx) => {
    production.cancelPlan(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.HTX_WRITE);

  api.post('/production/steps/:id/confirm', (ctx) =>
    production.confirmPlanStep(ctx.params.id, body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/production/steps/:id/skip', (ctx) =>
    production.skipPlanStep(ctx.params.id, body(ctx).reason, ctx.actor), P.HTX_WRITE);
  api.post('/production/steps/:id/evidence', (ctx) =>
    production.addEvidence(ctx.params.id, body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.get('/production/steps/:id/evidence', (ctx) => production.listEvidence(ctx.params.id), P.HTX_READ);

  // ---- Thửa ruộng: vẽ lại đường bao, gán HTX / thành viên ----
  api.put('/mdm/plots/:id/boundary', (ctx) =>
    mdm.updatePlotBoundary(ctx.params.id, body(ctx).boundary, ctx.actor), P.MDM_WRITE);
  api.put('/mdm/plots/:id/assign', (ctx) =>
    mdm.assignPlot(ctx.params.id, body(ctx) as never, ctx.actor), P.MDM_WRITE);

  // ---- Phân công công việc theo kế hoạch sản xuất ----
  api.get('/assign/models', () => ({
    models: assignment.OPERATING_MODELS,
    roles: assignment.ASSIGNMENT_ROLES,
    status: assignment.ASSIGNMENT_STATUS,
  }), P.HTX_READ);
  api.get('/assign/plots/:id/work-plan', (ctx) => assignment.plotWorkPlan(ctx.params.id), P.HTX_READ);
  api.get('/assign/steps/:id', (ctx) => assignment.listAssignments(ctx.params.id), P.HTX_READ);
  api.post('/assign', (ctx) => assignment.assignWork(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/assign/:id/respond', (ctx) =>
    assignment.respondToAssignment(ctx.params.id, body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.delete('/assign/:id', (ctx) => {
    assignment.cancelAssignment(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.HTX_WRITE);
  api.get('/assign/farmers/:id/workload', (ctx) => assignment.workloadForFarmer(ctx.params.id), P.HTX_READ);
  api.get('/assign/machine-schedule', (ctx) => assignment.machineSchedule(
    ctx.query.get('htxId') ?? '', ctx.query.get('from') ?? undefined, ctx.query.get('to') ?? undefined,
  ), P.HTX_READ);
  api.get('/assign/summary', (ctx) => assignment.assignmentSummary(ctx.query.get('htxId') ?? ''), P.HTX_READ);
  api.put('/assign/operating-model', (ctx) =>
    assignment.setOperatingModel(body(ctx).htxId, body(ctx).model, ctx.actor), P.HTX_WRITE);

  // ---- Vật tư HTX: mua sắm, tồn kho, cấp phát ----
  api.get('/inputs/categories', () => inputs.INPUT_CATEGORIES, P.HTX_READ);
  api.get('/inputs/items', (ctx) => inputs.listItems({
    category: ctx.query.get('category') ?? undefined,
    htxId: ctx.query.get('htxId') ?? undefined,
  }), P.HTX_READ);
  api.post('/inputs/items', (ctx) => inputs.createItem(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.get('/inputs/purchases', (ctx) => inputs.listPurchases(ctx.query.get('htxId') ?? ''), P.HTX_READ);
  api.get('/inputs/purchases/:id', (ctx) => inputs.getPurchase(ctx.params.id) ?? notFoundResult(), P.HTX_READ);
  api.post('/inputs/purchases', (ctx) => inputs.createPurchase(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.get('/inputs/stock', (ctx) => inputs.stockOnHand(ctx.query.get('htxId') ?? ''), P.HTX_READ);
  api.get('/inputs/stock-summary', (ctx) => inputs.stockSummary(ctx.query.get('htxId') ?? ''), P.HTX_READ);
  api.post('/inputs/issues', (ctx) => inputs.issueToPlot(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.get('/inputs/issues', (ctx) => inputs.listIssues({
    htxId: ctx.query.get('htxId') ?? undefined,
    plotId: ctx.query.get('plotId') ?? undefined,
    cropCycleId: ctx.query.get('cropCycleId') ?? undefined,
  }), P.HTX_READ);
  api.get('/inputs/traceability/:cropCycleId', (ctx) =>
    inputs.inputTraceability(ctx.params.cropCycleId), P.HTX_READ);
  api.get('/inputs/dashboard', (ctx) => inputs.inputDashboard(ctx.query.get('htxId') ?? ''), P.HTX_READ);

  // ---- Khảo sát thu thập dữ liệu (App Khuyến nông) ----
  api.get('/survey/meta', () => ({
    frequencies: survey.SURVEY_FREQUENCIES,
    questionKinds: survey.QUESTION_KINDS,
    productionStatuses: survey.PRODUCTION_STATUSES,
  }), P.KN_READ);
  api.get('/survey/admin-units', (ctx) => survey.adminChildren(
    ctx.query.get('parentId'), ctx.query.get('level') ?? undefined,
  ), P.KN_READ);
  api.get('/survey/admin-path/:id', (ctx) => survey.adminPath(ctx.params.id), P.KN_READ);
  api.get('/survey/templates', (ctx) =>
    survey.listTemplates({ status: ctx.query.get('status') ?? undefined }), P.KN_READ);
  api.get('/survey/templates/:id', (ctx) => ({
    template: survey.getTemplate(ctx.params.id) ?? notFoundResult(),
    questions: survey.listQuestions(ctx.params.id),
  }), P.KN_READ);
  api.post('/survey/templates', (ctx) => survey.createTemplate(body(ctx) as never, ctx.actor), P.KN_WRITE);
  api.post('/survey/templates/:id/questions', (ctx) =>
    survey.addQuestion(ctx.params.id, body(ctx) as never, ctx.actor), P.KN_WRITE);
  api.delete('/survey/questions/:id', (ctx) => {
    survey.removeQuestion(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.KN_WRITE);
  api.post('/survey/templates/:id/publish', (ctx) =>
    survey.publishTemplate(ctx.params.id, ctx.actor), P.KN_PUBLISH);
  api.post('/survey/responses', (ctx) => survey.submitResponse(body(ctx) as never, ctx.actor), P.KN_WRITE);
  api.get('/survey/responses', (ctx) => survey.listResponses({
    templateId: ctx.query.get('templateId') ?? undefined,
    period: ctx.query.get('period') ?? undefined,
    communeId: ctx.query.get('communeId') ?? undefined,
  }), P.KN_READ);
  api.get('/survey/responses/:id', (ctx) => survey.getResponse(ctx.params.id) ?? notFoundResult(), P.KN_READ);
  api.get('/survey/templates/:id/summary', (ctx) =>
    survey.surveySummary(ctx.params.id, ctx.query.get('period') ?? undefined), P.KN_READ);

  // ---- Hồ sơ HTX theo mã số thuế: Khuyến nông lập, HTX kích hoạt ----
  // ---- Mạng lưới đường thuỷ: nhận diện cấu trúc, công trình, tải trọng ----
  api.get('/waterway/vessels', () => ({
    vessels: VESSEL_CLASSES,
    margins: SAFETY_MARGINS,
    structureKinds: wnet.STRUCTURE_KINDS,
    snapToleranceM: wnet.SNAP_TOLERANCE_M,
    autoJoinMaxM: wnet.AUTO_JOIN_MAX_M,
  }), P.GIS_READ);
  api.get('/waterway/analysis', () => wnet.analyzeNetwork(), P.GIS_READ);
  api.post('/waterway/rebuild', (ctx) => wnet.rebuildNetwork(body(ctx) as never, ctx.actor), P.GIS_WRITE);

  api.get('/waterway/structures', (ctx) =>
    wnet.listStructures(ctx.query.get('routeId') ?? undefined), P.GIS_READ);
  api.post('/waterway/structures', (ctx) => wnet.addStructure(body(ctx) as never, ctx.actor), P.GIS_WRITE);
  api.delete('/waterway/structures/:id', (ctx) => {
    wnet.removeStructure(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.GIS_WRITE);

  api.get('/waterway/capacity', () => wnet.capacityOverview(), P.GIS_READ);
  api.get('/waterway/capacity/:routeId', (ctx) => wnet.deriveRouteCapacity(ctx.params.routeId), P.GIS_READ);
  api.post('/waterway/derive-capacity', (ctx) => wnet.deriveAllCapacities(ctx.actor), P.GIS_WRITE);

  /**
   * Đường đi tối ưu giữa hai điểm bất kỳ (thường là Hub → Nhà máy).
   * Truyền `vesselCode` để chỉ nhận tuyến mà phương tiện đó đi lọt.
   */
  api.post('/waterway/optimal-route', (ctx) => {
    const input = body(ctx);
    const service = new DistanceService({
      correctionFactors: { road: 1.3, waterway: 1.45 },
      waterwayAccessRadiusKm: 8,
      refresh: true,
    });
    const from = { lat: num(input.fromLat), lng: num(input.fromLng) };
    const to = { lat: num(input.toLat), lng: num(input.toLng) };
    const mode = (input.mode ?? 'waterway') as 'road' | 'waterway';
    return {
      optimal: service.optimalRoute(from, to, mode, input.vesselCode),
      // Bảng so sánh mọi lớp phương tiện — chỉ có ý nghĩa với đường thuỷ.
      byVessel: mode === 'waterway' ? service.routeOptions(from, to) : [],
    };
  }, P.GIS_READ);

  api.get('/htx-registry/pending', () => registry.pendingClaims(), P.KN_READ);
  api.get('/htx-registry/lookup', (ctx) =>
    registry.findByTaxCode(ctx.query.get('taxCode') ?? '') ?? { found: false }, P.MDM_READ);
  api.post('/htx-registry/register', (ctx) =>
    registry.registerByExtension(body(ctx) as never, ctx.actor), P.KN_WRITE);
  api.post('/htx-registry/preview-claim', (ctx) => registry.previewClaim(body(ctx).taxCode), P.MDM_READ);
  // Người nhận HTX luôn là người đang đăng nhập; gắn HTX cho người KHÁC là thao tác quản trị tài khoản
  // (review 24/09/2026, P1 #2 — trước đây tin `userId` trong body).
  api.post('/htx-registry/claim', (ctx) => {
    const requested = body(ctx).userId ? String(body(ctx).userId) : null;
    const self = ctx.user!.id;
    if (requested && requested !== self && !roleCan(ctx.user!.roles, P.ADMIN_USERS)) {
      throw forbidden('Chỉ quản trị tài khoản mới được gắn hợp tác xã cho người dùng khác.');
    }
    return registry.claimByTaxCode({ ...body(ctx), userId: requested && roleCan(ctx.user!.roles, P.ADMIN_USERS) ? requested : self }, ctx.actor);
  }, P.HTX_WRITE);
  api.put('/htx-registry/:id/tax-code', (ctx) =>
    registry.setTaxCode(ctx.params.id, body(ctx).taxCode, ctx.actor), P.MDM_WRITE);

  // ===================== Bản đồ số Cơ giới hoá =====================
  api.get('/cgh/machine-types', () => cgh.listMachineTypes(), P.CGH_READ);
  api.post('/cgh/machine-types', (ctx) => {
    cgh.upsertMachineType(body(ctx) as never, ctx.actor);
    return { ok: true };
  }, P.CGH_WRITE);
  api.get('/cgh/norms', (ctx) => cgh.effectiveNorms(ctx.query.get('date') ?? undefined), P.CGH_READ);
  api.post('/cgh/norms', (ctx) => {
    cgh.addProductivityNorm(body(ctx) as never, ctx.actor);
    return { ok: true };
  }, P.CGH_WRITE);
  api.get('/cgh/machines', (ctx) =>
    cgh.listMachines({
      htxId: ctx.query.get('htxId') ?? undefined,
      stage: ctx.query.get('stage') ?? undefined,
      condition: ctx.query.get('condition') ?? undefined,
      includeInactive: ctx.query.get('includeInactive') === '1',
    }), P.CGH_READ);
  api.post('/cgh/machines', (ctx) => cgh.createMachine(body(ctx) as never, ctx.actor), P.CGH_WRITE);
  api.post('/cgh/machine-owners', (ctx) => cgh.createMachineOwner(body(ctx) as never, ctx.actor), P.CGH_WRITE);
  api.post('/cgh/machines/:id/condition', (ctx) =>
    cgh.applyConditionUpdate(ctx.params.id, body(ctx).condition, body(ctx).source ?? 'nhap_tay', ctx.actor), P.CGH_WRITE);
  api.post('/cgh/machines/:id/lock', (ctx) => {
    cgh.lockMachineCondition(ctx.params.id, Boolean(body(ctx).locked), ctx.actor);
    return { ok: true };
  }, P.CGH_WRITE);
  api.post('/cgh/cultivation-plans', (ctx) => cgh.upsertCultivationPlan(body(ctx) as never, ctx.actor), P.CGH_WRITE);
  api.get('/cgh/balance', (ctx) => cgh.balanceSupplyDemand(ctx.query.get('seasonId') ?? undefined), P.CGH_READ);
  api.get('/cgh/forecast', () => cgh.forecastDemand(), P.CGH_READ);
  api.get('/cgh/dashboard', (ctx) => cgh.dashboard(ctx.query.get('seasonId') ?? undefined), P.CGH_READ);
  api.get('/cgh/shortage-report', (ctx) => cgh.shortageReport(ctx.query.get('seasonId') ?? undefined), P.CGH_READ);
  api.post('/cgh/sync-app-htx', (ctx) => cgh.syncFromAppHtx(body(ctx) as never, ctx.actor), P.CGH_WRITE);

  // ===================== Sàn cơ giới hoá =====================
  api.get('/rental/listings', (ctx) =>
    rental.searchListings({
      stage: ctx.query.get('stage') ?? undefined,
      lat: ctx.query.get('lat') ? Number(ctx.query.get('lat')) : undefined,
      lng: ctx.query.get('lng') ? Number(ctx.query.get('lng')) : undefined,
      maxDistanceKm: ctx.query.get('maxKm') ? Number(ctx.query.get('maxKm')) : undefined,
      from: ctx.query.get('from') ?? undefined,
      to: ctx.query.get('to') ?? undefined,
    }), P.RENTAL_READ);
  api.post('/rental/listings', (ctx) => rental.createListing(body(ctx) as never, ctx.actor), P.RENTAL_WRITE);
  // Sàn thuê máy: quyền theo CÁC BÊN trong giao dịch (bên thuê / HTX sở hữu máy), không theo htxId người gọi gửi lên (R2).
  const rentalScope = (ctx: Context): rental.RentalScope => ({ htxId: isHtxBound(ctx.user) ? ctx.user.htxId : null });
  api.get('/rental/orders', (ctx) =>
    rental.listOrders({ htxId: ctx.query.get('htxId') ?? undefined, status: ctx.query.get('status') ?? undefined }, rentalScope(ctx)), P.RENTAL_READ);
  api.post('/rental/orders', (ctx) => rental.bookOrder(body(ctx) as never, ctx.actor, rentalScope(ctx)), P.RENTAL_WRITE);
  api.post('/rental/orders/:id/advance', (ctx) => rental.advanceOrder(ctx.params.id, body(ctx).status, ctx.actor, rentalScope(ctx)), P.RENTAL_WRITE);
  api.post('/rental/disputes', (ctx) => rental.openDispute(body(ctx) as never, ctx.actor, rentalScope(ctx)), P.RENTAL_WRITE);
  api.post('/rental/disputes/:id/resolve', (ctx) => rental.resolveDispute(ctx.params.id, body(ctx) as never, ctx.actor), P.RENTAL_RESOLVE);
  api.get('/rental/disputes', (ctx) => rental.listDisputes(ctx.query.get('status') ?? undefined, rentalScope(ctx)), P.RENTAL_READ);
  api.get('/rental/dashboard', () => rental.marketplaceDashboard(), P.RENTAL_READ);

  // ===================== ERP — Tham số mô phỏng (FN-01) =====================
  api.get('/sim/parameters', () => ({
    integrity: catalogIntegrity(),
    currentVersion: params.currentParameterSetVersion(),
    parameters: params.listParameters(),
    unapproved: params.unapprovedAssumptions(),
    catalogNotes: PARAMETER_CATALOG.filter((p) => p.managedElsewhere).map((p) => ({
      number: p.number, name: p.name, managedElsewhere: p.managedElsewhere,
    })),
  }), P.SIM_READ);
  api.put('/sim/parameters/:code', (ctx) => params.updateParameter(ctx.params.code, body(ctx) as never, ctx.actor), P.SIM_WRITE);
  api.post('/sim/parameters/:code/approve', (ctx) =>
    params.approveParameter(ctx.params.code, String(body(ctx).approver ?? ctx.user?.fullName ?? 'unknown'), ctx.actor), P.SIM_PARAM_APPROVE);
  // Đối chiếu giả định – thực tế: số thật từ hiện trường / TMS / kho đặt cạnh tham số.
  api.get('/sim/actuals', (ctx) => actuals.compareAssumptions(ctx.query.get('days') ? num(ctx.query.get('days')) : undefined), P.SIM_READ);
  api.post('/sim/actuals/:code/propose', (ctx) => actuals.proposeFromActual(
    ctx.params.code, { days: body(ctx).days ? num(body(ctx).days) : undefined, note: body(ctx).note }, ctx.actor), P.SIM_WRITE);
  api.get('/sim/parameter-sets', () => params.listParameterSets(), P.SIM_READ);
  api.get('/sim/parameter-sets/:version', (ctx) => params.parameterSetSnapshot(Number(ctx.params.version)), P.SIM_READ);
  api.post('/sim/parameter-sets', (ctx) => params.createParameterSet(String(body(ctx).note ?? 'Tạo thủ công'), ctx.actor), P.SIM_WRITE);

  // ===================== ERP — Hub ứng viên & kịch bản =====================
  api.get('/sim/hubs', () => sim.listCandidateHubs(), P.SIM_READ);
  api.post('/sim/hubs', (ctx) => sim.createCandidateHub(body(ctx) as never, ctx.actor), P.SIM_WRITE);
  api.delete('/sim/hubs/:id', (ctx) => {
    sim.deleteCandidateHub(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.SIM_WRITE);

  api.get('/sim/scenarios', () => sim.listScenarios(), P.SIM_READ);
  api.post('/sim/scenarios', (ctx) => sim.createScenario(body(ctx) as never, ctx.actor), P.SIM_WRITE);
  api.get('/sim/scenarios/:id', (ctx) => {
    const scenario = sim.getScenario(ctx.params.id);
    if (!scenario) throw notFound('Không tìm thấy kịch bản');
    return { scenario, hubs: sim.listScenarioHubs(ctx.params.id), result: sim.latestResult(ctx.params.id) };
  }, P.SIM_READ);
  api.put('/sim/scenarios/:id', (ctx) => sim.updateScenario(ctx.params.id, body(ctx), ctx.actor), P.SIM_WRITE);
  api.post('/sim/scenarios/:id/hubs', (ctx) => {
    sim.attachHub(ctx.params.id, body(ctx).hubId, body(ctx), ctx.actor);
    return sim.listScenarioHubs(ctx.params.id);
  }, P.SIM_WRITE);
  api.delete('/sim/scenarios/:id/hubs/:hubId', (ctx) => {
    sim.detachHub(ctx.params.id, ctx.params.hubId, ctx.actor);
    return sim.listScenarioHubs(ctx.params.id);
  }, P.SIM_WRITE);

  api.post('/sim/scenarios/:id/run', (ctx) =>
    sim.runSimulation(ctx.params.id, { refreshDistances: Boolean(body(ctx).refreshDistances) }, ctx.actor), P.SIM_WRITE);
  api.get('/sim/scenarios/:id/result', (ctx) => sim.latestResult(ctx.params.id) ?? notFoundResult(), P.SIM_READ);
  api.post('/sim/scenarios/:id/official', (ctx) => sim.markOfficial(ctx.params.id, ctx.actor), P.SIM_MARK_OFFICIAL);
  api.post('/sim/compare', (ctx) => sim.compareScenarios(body(ctx).scenarioIds ?? [], body(ctx).includeBaseline !== false), P.SIM_READ);
  api.get('/sim/scenarios/:id/recommendation', (ctx) => sim.recommend(ctx.params.id), P.SIM_READ);
  api.post('/sim/scenarios/:id/sensitivity', (ctx) => sim.runSensitivity(ctx.params.id, body(ctx).codes, ctx.actor), P.SIM_WRITE);
  api.get('/sim/scenarios/:id/sensitivity', (ctx) => sim.latestSensitivity(ctx.params.id) ?? notFoundResult(), P.SIM_READ);
  api.post('/sim/scenarios/:id/handover/:hubId', (ctx) => sim.exportHubToWarehouse(ctx.params.id, ctx.params.hubId, ctx.actor), P.SIM_WRITE);
  api.get('/sim/handovers', () => sim.listHandovers(), P.SIM_READ);

  // FN-16 — xuất báo cáo
  api.get('/sim/scenarios/:id/report.csv', (ctx) => {
    const result = sim.latestResult(ctx.params.id);
    if (!result) throw notFound('Kịch bản chưa có kết quả mô phỏng');
    const csv = reporting.toCsv(
      result.hubs.map((hub) => ({
        hub: hub.name,
        htx: hub.cooperativeCount,
        delivered_tons: hub.deliveredTons,
        capex: hub.capex.total,
        opex: hub.opex.total,
        collection: hub.costs.collectionCost,
        transportation: hub.costs.transportationCost,
        warehouse: hub.costs.warehouseCost,
        handling: hub.costs.handlingCost,
        total_logistics: hub.costs.totalDeliveredLogisticsCost,
        cost_per_ton: hub.costs.costPerTon ?? 'Không xác định',
      })),
    );
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.scenarioCode}.csv"`,
    });
    ctx.res.end(csv);
    return undefined;
  }, P.SIM_READ);

  api.get('/sim/scenarios/:id/report.html', (ctx) => {
    const result = sim.latestResult(ctx.params.id);
    if (!result) throw notFound('Kịch bản chưa có kết quả mô phỏng');
    const html = reporting.toPrintableReport({
      title: `Kết quả mô phỏng — ${result.scenarioName}`,
      subtitle: `${result.scenarioCode} · Nhà máy đầu ra: ${result.plant.name}`,
      provenance: {
        'Phiên bản bộ tham số': result.parameterSetVersion,
        'Trạng thái kịch bản': result.status === 'chinh_thuc' ? 'Chính thức' : 'Tham khảo',
        'Nguồn baseline': result.financial.baselineSourceLabel,
        'Chế độ tính': result.financial.discounted ? 'Có chiết khấu' : 'Không chiết khấu',
        'Thời điểm tính': result.computedAt,
      },
      sections: [
        {
          heading: 'Chỉ số tài chính cấp kịch bản',
          rows: [{
            CAPEX: result.capex.total,
            'OPEX năm 1': result.opex.total,
            'Total Delivered Logistics Cost': result.costs.totalDeliveredLogisticsCost,
            'Cost per Ton (chưa gồm khấu hao đầu tư)': result.costs.costPerTon,
            TCO: result.financial.tco,
            'TCO per Ton': result.financial.tcoPerTon,
            'ROI (%)': result.financial.roiPct,
            'Payback (năm)': result.financial.paybackYears,
          }],
        },
        {
          heading: 'Chi tiết theo Hub',
          rows: result.hubs.map((hub) => ({
            Hub: hub.name,
            'Số HTX': hub.cooperativeCount,
            'Delivered (tấn)': hub.deliveredTons,
            'Kho (m²)': hub.sizing.warehouseAreaM2,
            'Sân bãi (m²)': hub.sizing.yardAreaM2,
            'Máy ép kiện': hub.sizing.balePressCount,
            'Xe nâng': hub.sizing.forkliftCount,
            CAPEX: hub.capex.total,
            'Cost/Ton': hub.costs.costPerTon,
          })),
        },
        { heading: 'Cảnh báo', rows: result.warnings.map((warning) => ({ 'Nội dung': warning })) },
      ],
    });
    ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    ctx.res.end(html);
    return undefined;
  }, P.SIM_READ);

  // ===================== ERP — Warehouse =====================
  api.post('/wh/inbound-notices', (ctx) => warehouse.receiveInboundNotice(body(ctx) as never, ctx.actor), P.WH_WRITE);
  api.post('/wh/weighings', (ctx) => warehouse.recordWeighing(body(ctx) as never, ctx.actor), P.WH_WRITE);
  api.get('/wh/receipts', (ctx) => warehouse.listGoodsReceipts(ctx.query.get('facilityId') ?? undefined), P.WH_READ);
  api.post('/wh/receipts', (ctx) => warehouse.createGoodsReceipt(body(ctx) as never, ctx.actor), P.WH_WRITE);
  api.post('/wh/receipts/:id/approve', (ctx) => warehouse.approveGoodsReceipt(ctx.params.id, ctx.actor), P.WH_APPROVE);
  api.post('/wh/issues', (ctx) => warehouse.createGoodsIssue(body(ctx) as never, ctx.actor), P.WH_WRITE);
  api.post('/wh/issues/:id/approve', (ctx) => warehouse.approveGoodsIssue(ctx.params.id, ctx.actor), P.WH_APPROVE);
  api.get('/wh/lots', (ctx) => warehouse.listStockLots(ctx.query.get('facilityId') ?? undefined), P.WH_READ);
  api.get('/wh/lots/:id/environment', (ctx) => warehouse.lotEnvironmentHistory(ctx.params.id), P.WH_READ);
  api.get('/wh/issue-priority/:facilityId', (ctx) => warehouse.suggestedIssueOrder(ctx.params.facilityId), P.WH_READ);
  api.post('/wh/sensors', (ctx) => warehouse.ingestSensorReading(body(ctx) as never), P.WH_WRITE);
  api.get('/wh/environment', (ctx) => warehouse.environmentDashboard(ctx.query.get('facilityId') ?? undefined), P.WH_READ);
  api.post('/wh/alerts/:id/ack', (ctx) => {
    warehouse.acknowledgeAlert(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.WH_WRITE);
  api.get('/wh/thresholds', (ctx) => warehouse.getThresholds(ctx.query.get('facilityId') ?? undefined), P.WH_READ);
  api.put('/wh/thresholds', (ctx) => {
    warehouse.setThresholds(body(ctx) as never, ctx.actor);
    return { ok: true };
  }, P.WH_WRITE);
  api.post('/wh/zones', (ctx) => warehouse.addStorageZone(body(ctx) as never, ctx.actor), P.WH_WRITE);
  api.get('/wh/stocktakes', () => warehouse.listStocktakes(), P.WH_READ);
  api.post('/wh/stocktakes', (ctx) => warehouse.planStocktake(body(ctx) as never, ctx.actor), P.WH_WRITE);
  api.post('/wh/stocktakes/:id/count', (ctx) => warehouse.submitCount(ctx.params.id, num(body(ctx).countedTons), body(ctx).reason, ctx.actor), P.WH_WRITE);
  api.post('/wh/stocktakes/:id/approve', (ctx) => warehouse.approveStocktake(ctx.params.id, ctx.actor), P.WH_APPROVE);
  api.get('/wh/reports/inventory', (ctx) => warehouse.inventoryReport(ctx.query.get('facilityId') ?? undefined), P.WH_READ);
  api.get('/wh/reports/movement', (ctx) =>
    warehouse.movementReport(
      ctx.query.get('from') ?? '1970-01-01',
      ctx.query.get('to') ?? new Date().toISOString().slice(0, 10),
      ctx.query.get('facilityId') ?? undefined,
    ), P.WH_READ);
  api.get('/wh/reports/quality', (ctx) => warehouse.qualityReport(ctx.query.get('facilityId') ?? undefined), P.WH_READ);
  api.post('/wh/trip-documents', (ctx) => warehouse.issueTripDocument(body(ctx) as never, ctx.actor), P.WH_WRITE);

  // ===================== ERP — MRV =====================
  api.get('/mrv/summary', () => warehouse.mrvSummary(), P.MRV_READ);
  api.post('/mrv/sync-lakehouse', (ctx) => warehouse.syncToDataLakehouse(ctx.actor), P.MRV_WRITE);

  // ===================== ERP — Procurement / Sales =====================
  api.get('/po', (ctx) => procurement.listPurchaseOrders({ htxId: ctx.query.get('htxId') ?? undefined, status: ctx.query.get('status') ?? undefined }), P.PO_READ);
  api.post('/po', (ctx) => procurement.createPurchaseOrder(body(ctx) as never, ctx.actor), P.PO_WRITE);
  api.post('/po/:id/approve', (ctx) => procurement.approvePurchaseOrder(ctx.params.id, ctx.actor), P.PO_WRITE);
  api.get('/po/:id/match', (ctx) => procurement.threeWayMatch(ctx.params.id), P.PO_READ);
  api.post('/po/:id/payment', (ctx) => procurement.requestPayment(ctx.params.id, ctx.actor), P.PO_WRITE);
  api.get('/po/reports/summary', (ctx) => procurement.purchaseReport(ctx.query.get('from') ?? undefined, ctx.query.get('to') ?? undefined), P.PO_READ);

  api.get('/so', (ctx) => sales.listSalesOrders({ partnerId: ctx.query.get('partnerId') ?? undefined, status: ctx.query.get('status') ?? undefined }), P.SO_READ);
  api.post('/so', (ctx) => sales.createSalesOrder(body(ctx) as never, ctx.actor), P.SO_WRITE);
  api.post('/so/:id/advance', (ctx) => sales.advanceSalesOrder(ctx.params.id, body(ctx).status, ctx.actor), P.SO_WRITE);
  api.get('/so/reports/summary', (ctx) => sales.salesReport(ctx.query.get('from') ?? undefined, ctx.query.get('to') ?? undefined), P.SO_READ);

  // ===================== ERP — TMS =====================
  api.post('/tms/plan-route', (ctx) =>
    tms.planRoute({
      from: { lat: num(body(ctx).from?.lat), lng: num(body(ctx).from?.lng) },
      to: { lat: num(body(ctx).to?.lat), lng: num(body(ctx).to?.lng) },
      tons: num(body(ctx).tons, 1),
      criteria: body(ctx).criteria,
    }), P.TMS_READ);
  api.get('/tms/trips', (ctx) => tms.listTrips({ status: ctx.query.get('status') ?? undefined }), P.TMS_READ);
  api.post('/tms/trips', (ctx) => tms.createTrip(body(ctx) as never, ctx.actor), P.TMS_WRITE);
  api.post('/tms/trips/:id/depart', (ctx) => tms.departTrip(ctx.params.id, ctx.actor), P.TMS_WRITE);
  api.post('/tms/trips/:id/complete', (ctx) => tms.completeTrip(ctx.params.id, body(ctx) as never, ctx.actor), P.TMS_WRITE);
  api.get('/tms/cost-variance', (ctx) => tms.costVariance(ctx.query.get('from') ?? undefined, ctx.query.get('to') ?? undefined), P.TMS_READ);

  // ===================== ERP — Finance =====================
  api.get('/finance/entries', (ctx) => finance.listEntries({ account: ctx.query.get('account') ?? undefined }), P.FIN_READ);
  api.post('/finance/entries', (ctx) => finance.postEntry(body(ctx) as never, ctx.actor), P.FIN_WRITE);
  api.post('/finance/entries/:id/settle', (ctx) => {
    finance.settleEntry(ctx.params.id, ctx.actor);
    return { ok: true };
  }, P.FIN_WRITE);
  api.get('/finance/reconciliation', (ctx) =>
    finance.reconciliation({
      from: ctx.query.get('from') ?? undefined,
      to: ctx.query.get('to') ?? undefined,
      facilityId: ctx.query.get('facilityId') ?? undefined,
    }), P.FIN_READ);
  api.get('/finance/revenue-rules', () => finance.listRevenueRules(), P.FIN_READ);
  api.post('/finance/revenue-rules', (ctx) => {
    finance.upsertRevenueRule(body(ctx) as never, ctx.actor);
    return { ok: true };
  }, P.FIN_WRITE);
  api.get('/finance/carbon-share', (ctx) => finance.carbonRevenueShare(Number(ctx.query.get('revenue') ?? 0)), P.FIN_READ);
  api.get('/finance/budget-vs-actual/:facilityId', (ctx) => finance.budgetVsActual(ctx.params.facilityId), P.FIN_READ);

  // ===================== Reporting & BI =====================
  api.get('/reports/executive', () => reporting.executiveDashboard(), P.REPORT_READ);
  api.get('/reports/scenario-leaderboard', () => reporting.scenarioLeaderboard(), P.REPORT_READ);
  api.get('/reports/finance', (ctx) =>
    reporting.financeDashboard(
      ctx.query.get('from') ?? `${new Date().getUTCFullYear()}-01-01`,
      ctx.query.get('to') ?? new Date().toISOString().slice(0, 10),
    ), P.REPORT_READ);

  // Bổ sung theo BRD / User Story 09-2026 — xem api-brd.ts.
  registerBrdRoutes(api);
  // Tài khoản HTX chỉ chạm được dữ liệu HTX mình — áp cho mọi route, kể cả route đăng ký sau này.
  api.guard(enforceHtxScope);
  // UAT DEF-AUTH-01: cờ "phải đổi mật khẩu" được THI HÀNH — mật khẩu tạm chỉ mở được ba đường: đổi mật khẩu, xem hồ sơ, đăng xuất.
  api.guard((ctx, pathname) => {
    if (ctx.user?.mustChangePassword && !['/auth/password', '/auth/me', '/auth/logout'].includes(pathname)) {
      throw new HttpError(403, 'Bạn phải đổi mật khẩu tạm trước khi sử dụng hệ thống.', { code: 'must_change_password' });
    }
  });

  return api;
}

function notFoundResult() {
  throw notFound('Chưa có dữ liệu — hãy chạy mô phỏng trước.');
}
