/**
 * Các route bổ sung theo BRD / User Story 09-2026 (GIS v1.5, KN v1.0, HTX v4.0, CGH v4.0).
 *
 * Tách khỏi api.ts để nhìn được trọn bộ thay đổi của đợt cập nhật này ở một chỗ.
 * Quy ước lỗi: thao tác cần NGƯỜI DÙNG XÁC NHẬN LẠI (chồng lấn ranh giới, sản lượng
 * bất thường, vô hiệu hoá chủ máy còn máy) trả HTTP 409 kèm `details.needsConfirm`.
 */
import { HttpError, Router, badRequest, forbidden, notFound, unauthorized, type Context } from './platform/http/router.ts';
import { PERMISSIONS as P, can as roleCan } from './platform/auth/rbac.ts';
import { logEvent } from './platform/audit/audit.ts';
import { backupAll, listBackups, verifyBackup } from './platform/db/backup.ts';
import { findOrphans, indexSummary, integrityByDomain } from './platform/db/integrity.ts';
import { maskNationalId } from './platform/security/fieldCrypto.ts';
import * as users from './platform/auth/users.ts';
import * as reporting from './erp/reporting/service.ts';
import * as mdm from './mdm/service.ts';
import * as lifecycle from './mdm/lifecycle.ts';
import * as varieties from './mdm/varieties.ts';
import { parseCoordinateLines, parseSpatialFile } from './mdm/geoImport.ts';
import * as waterways from './agrigreen/gis/waterways.ts';
import * as gisAdmin from './agrigreen/gis/admin.ts';
import * as htxOps from './agrigreen/htx/fieldOps.ts';
import * as knOps from './agrigreen/khuyennong/ops.ts';
import * as cghOps from './agrigreen/cgh/ops.ts';
import * as cgh from './agrigreen/cgh/service.ts';

const body = (ctx: Context) => (ctx.body ?? {}) as Record<string, any>;
const num = (value: unknown, fallback?: number): number => {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  if (fallback !== undefined) return fallback;
  throw badRequest('Giá trị số không hợp lệ');
};
const requireUser = (ctx: Context) => { if (!ctx.user) throw unauthorized(); return ctx.user; };

/** Chuyển lỗi "cần xác nhận" của tầng nghiệp vụ thành HTTP 409 để giao diện hiện hộp xác nhận. */
function confirmable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const e = error as Error & { needsConfirm?: boolean; overlaps?: unknown; anomaly?: string; machines?: number };
    if (e.needsConfirm) throw new HttpError(409, e.message, { needsConfirm: true, overlaps: e.overlaps ?? null, anomaly: e.anomaly ?? null, machines: e.machines ?? null });
    throw error;
  }
}

function sendCsv(ctx: Context, fileName: string, rows: Record<string, unknown>[], columns?: { key: string; label: string }[]): undefined {
  const csv = rows.length ? reporting.toCsv(rows, columns) : `﻿${(columns ?? []).map((c) => c.label).join(',')}\n`;
  ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName}"` });
  ctx.res.end(csv);
  return undefined;
}

/** HTX của tài khoản đang đăng nhập — cán bộ HTX chỉ được thao tác trong HTX của mình (US-HH-01 AC-3, US-PLOT-01 AC-4). */
function scopedHtxId(ctx: Context, requested?: string | null): string {
  const user = requireUser(ctx);
  if (user.htxId) {
    if (requested && requested !== user.htxId) throw forbidden('Bạn không có quyền truy cập dữ liệu của hợp tác xã khác.');
    return user.htxId;
  }
  if (!requested) throw badRequest('Thiếu htxId');
  return requested;
}

/**
 * Dữ liệu cá nhân (NĐ 13/2023/NĐ-CP, UAT DEF-CGH-08): số điện thoại nông hộ / chủ máy được che mặc định
 * (09xx•••456). Người có quyền ghi của phân hệ mới xem đầy đủ bằng `?reveal=1`, và mỗi lần xem đều vào nhật ký.
 */
export function maskPhone(phone: unknown): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\s+/g, '');
  if (digits.length < 7) return '•••';
  return `${digits.slice(0, 4)}${'•'.repeat(Math.max(2, digits.length - 7))}${digits.slice(-3)}`;
}
function maskPhones<T extends Record<string, unknown>>(ctx: Context, rows: T[], revealPermission: string, entityType: string): (T & { phone_masked?: boolean })[] {
  const wantsReveal = ctx.query.get('reveal') === '1';
  const allowed = Boolean(ctx.user && roleCan(ctx.user.roles, revealPermission));
  if (wantsReveal && allowed) {
    logEvent({ module: 'admin', entityType: 'pii_access', entityId: entityType, action: 'update', after: { rows: rows.length, path: ctx.req.url }, source: 'api' }, ctx.actor);
    return rows;
  }
  return rows.map((row) => {
    const masked: Record<string, unknown> = { ...row };
    if ('phone' in row) { masked.phone = maskPhone(row.phone); masked.phone_masked = true; }
    if ('national_id' in row) masked.national_id = maskNationalId(row.national_id);
    return masked as T & { phone_masked?: boolean };
  });
}

export function registerBrdRoutes(api: Router): void {
  // ===================== Danh mục giống lúa (HTX US-CAT-01/02) =====================
  api.get('/mdm/rice-varieties', (ctx) => varieties.listVarieties(ctx.query.get('all') === '1'), P.MDM_READ);
  api.post('/mdm/rice-varieties', (ctx) => varieties.upsertVariety(body(ctx) as never, ctx.actor), P.MDM_WRITE);
  api.put('/mdm/rice-varieties/:id', (ctx) => varieties.upsertVariety({ ...(body(ctx) as object), id: ctx.params.id } as never, ctx.actor), P.MDM_WRITE);
  api.delete('/mdm/rice-varieties/:id', (ctx) => varieties.removeVariety(ctx.params.id, ctx.actor), P.MDM_WRITE);
  api.post('/mdm/rice-varieties/:id/restore', (ctx) => { varieties.restoreVariety(ctx.params.id, ctx.actor); return { ok: true }; }, P.MDM_WRITE);
  api.post('/mdm/rice-varieties/import', (ctx) => varieties.importVarieties(body(ctx).rows ?? [], ctx.actor), P.MDM_WRITE);
  // UAT DEF-HTX-13: danh mục mùa vụ có endpoint tạo/sửa (Master Data Hub không còn chỉ đọc).
  api.post('/mdm/seasons', (ctx) => varieties.upsertSeason(body(ctx) as never, ctx.actor), P.MDM_WRITE);

  // ===================== Xoá mềm / khôi phục / lịch sử (GIS BR-14/17/19) =====================
  api.delete('/mdm/plots/:id', (ctx) => { lifecycle.softDelete('plots', ctx.params.id, String(body(ctx).reason ?? ''), ctx.actor); return { ok: true }; }, P.MDM_WRITE);
  api.post('/mdm/plots/:id/restore', (ctx) => { lifecycle.restore('plots', ctx.params.id, ctx.actor); return { ok: true }; }, P.MDM_WRITE);
  api.delete('/mdm/facilities/:id', (ctx) => { lifecycle.softDelete('facilities', ctx.params.id, String(body(ctx).reason ?? ''), ctx.actor); return { ok: true }; }, P.MDM_WRITE);
  api.post('/mdm/facilities/:id/restore', (ctx) => { lifecycle.restore('facilities', ctx.params.id, ctx.actor); return { ok: true }; }, P.MDM_WRITE);
  api.put('/mdm/cooperatives/:id/boundary', (ctx) => { lifecycle.setBoundary('cooperatives', ctx.params.id, body(ctx).points ?? null, body(ctx).marker ?? null, ctx.actor); return { ok: true }; }, P.MDM_WRITE);
  api.put('/mdm/facilities/:id/boundary', (ctx) => { lifecycle.setBoundary('facilities', ctx.params.id, body(ctx).points ?? null, body(ctx).marker ?? null, ctx.actor); return { ok: true }; }, P.MDM_WRITE);
  api.get('/mdm/deleted', () => lifecycle.listDeleted(), P.MDM_READ);
  api.post('/mdm/restore', (ctx) => { lifecycle.restore(body(ctx).table, String(body(ctx).id), ctx.actor); return { ok: true }; }, P.MDM_WRITE);
  api.get('/mdm/history', (ctx) => lifecycle.historyOf(ctx.query.get('entityType') ?? '', ctx.query.get('entityId') ?? '', ctx.query.get('limit') ? num(ctx.query.get('limit')) : undefined), P.MDM_READ);
  api.get('/mdm/plots/all', (ctx) => lifecycle.plotsDeletedAware(ctx.query.get('htxId') ?? undefined, ctx.query.get('deleted') === '1'), P.MDM_READ);

  // ===================== Vô hiệu hoá / kích hoạt HTX có lý do (HTX US-HTXSTATUS) =====================
  api.get('/mdm/cooperatives/:id/impact', (ctx) => lifecycle.cooperativeImpact(ctx.params.id), P.MDM_READ);
  api.post('/mdm/cooperatives/:id/deactivate', (ctx) => lifecycle.deactivateCooperative(ctx.params.id, String(body(ctx).reason ?? ''), ctx.actor), P.MDM_WRITE);
  api.post('/mdm/cooperatives/:id/reactivate', (ctx) => lifecycle.reactivateCooperative(ctx.params.id, ctx.actor), P.MDM_WRITE);
  api.get('/mdm/cooperatives/inactive', () => lifecycle.listDeleted().filter((d) => d.table === 'cooperatives'), P.MDM_READ);

  // ===================== Nông hộ trong HTX (HTX US-HH-01/02/03) =====================
  api.get('/htx/farmers', (ctx) => maskPhones(ctx, lifecycle.farmersWithPlots(scopedHtxId(ctx, ctx.query.get('htxId')), ctx.query.get('q') ?? undefined), P.HTX_WRITE, 'farmers'), P.HTX_READ);
  api.post('/htx/farmers', (ctx) => {
    const htxId = scopedHtxId(ctx, body(ctx).htxId);
    const phone = String(body(ctx).phone ?? '').replace(/\s+/g, '');
    if (!body(ctx).fullName?.trim()) throw badRequest('Vui lòng nhập đầy đủ Họ tên, SĐT, Diện tích và HTX liên kết.');
    if (phone && !/^0\d{9}$/.test(phone)) throw badRequest('SĐT không đúng định dạng, VD: 09xxxxxxxx');
    if (phone && mdm.listFarmers().some((f) => f.phone === phone)) throw badRequest('SĐT đã được sử dụng bởi nông hộ khác');
    return mdm.createFarmer({ ...(body(ctx) as object), htxId, phone } as never, ctx.actor);
  }, P.HTX_WRITE);
  api.put('/htx/farmers/:id', (ctx) => lifecycle.updateFarmer(ctx.params.id, body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/htx/farmers/import', (ctx) => lifecycle.importFarmers(scopedHtxId(ctx, body(ctx).htxId), body(ctx).rows ?? cghOps.parseDelimited(String(body(ctx).text ?? '')), ctx.actor), P.HTX_WRITE);

  // ===================== Lô ruộng: vẽ có kiểm tra chồng lấn, tải KML/GeoJSON (HTX US-PLOT-01..05, KN US-PLOT-01..03) =====================
  api.post('/htx/plots', (ctx) => confirmable(() => lifecycle.createPlotChecked({ ...(body(ctx) as object), htxId: scopedHtxId(ctx, body(ctx).htxId) } as never, ctx.actor)), P.HTX_WRITE);
  api.post('/htx/plots/overlap-check', (ctx) => ({ overlaps: lifecycle.findOverlaps(body(ctx).boundary ?? [], body(ctx).excludePlotId) }), P.HTX_READ);
  api.post('/htx/plots/import', (ctx) => {
    const htxId = scopedHtxId(ctx, body(ctx).htxId);
    const confirmOverlap = Boolean(body(ctx).confirmOverlap);
    if (body(ctx).coordinates) {
      // Dán toạ độ = vẽ một thửa: cùng luật ≥ 4 điểm, chồng lấn cùng HTX → 409 cần xác nhận, khác HTX → chặn (UAT DEF-HTX-01/02).
      const created = confirmable(() => lifecycle.createPlotChecked({ name: body(ctx).name ?? undefined, htxId, boundary: parseCoordinateLines(String(body(ctx).coordinates)), source: 'toa_do', confirmOverlap }, ctx.actor));
      return { created: 1, updated: 0, errors: [], ids: [created.id], plot: created, format: 'manual', skipped: [] };
    }
    const parsed = parseSpatialFile(String(body(ctx).content ?? ''), String(body(ctx).fileName ?? ''));
    const outcome = lifecycle.importFeatures('plot', parsed.features as never, { htxId, source: 'import', confirmOverlap }, ctx.actor);
    return { ...outcome, format: parsed.format, skipped: parsed.skipped, needsConfirm: outcome.errors.some((e) => e.needsConfirm) };
  }, P.HTX_WRITE);
  // Cán bộ khuyến nông vẽ thửa cho HTX bất kỳ trong địa bàn (KN US-PLOT-01) — quyền mdm.write.
  api.post('/mdm/plots/checked', (ctx) => confirmable(() => lifecycle.createPlotChecked(body(ctx) as never, ctx.actor)), P.MDM_WRITE);

  // ===================== GIS — quản trị (BRD GIS FN-03..09, FN-16, FN-22/23) =====================
  api.post('/gis/import/preview', (ctx) => {
    const parsed = parseSpatialFile(String(body(ctx).content ?? ''), String(body(ctx).fileName ?? ''));
    return { format: parsed.format, count: parsed.features.length, skipped: parsed.skipped, features: parsed.features.slice(0, 200).map((f) => ({ kind: f.kind, name: f.name, points: f.points.length, properties: f.properties })) };
  }, P.GIS_READ);
  api.post('/gis/import/:target', (ctx) => {
    const target = ctx.params.target as lifecycle.ImportTarget;
    if (!['htx', 'hub', 'plot'].includes(target)) throw notFound('Đích nạp phải là htx / hub / plot');
    const parsed = parseSpatialFile(String(body(ctx).content ?? ''), String(body(ctx).fileName ?? ''));
    const outcome = lifecycle.importFeatures(target, parsed.features, { htxId: body(ctx).htxId, provinceId: body(ctx).provinceId, kind: body(ctx).kind }, ctx.actor);
    return { ...outcome, format: parsed.format, skipped: parsed.skipped };
  }, P.GIS_ADMIN);
  api.post('/gis/admin-boundaries/preview', (ctx) => gisAdmin.previewAdminBoundaries(parseSpatialFile(String(body(ctx).content ?? ''), String(body(ctx).fileName ?? '')).features), P.GIS_ADMIN);
  api.post('/gis/admin-boundaries/apply', (ctx) => gisAdmin.applyAdminBoundaries(parseSpatialFile(String(body(ctx).content ?? ''), String(body(ctx).fileName ?? '')).features, ctx.actor), P.GIS_ADMIN);

  api.get('/gis/admin/config', () => gisAdmin.configOverview(), P.GIS_READ);
  api.put('/gis/admin/config/palette', (ctx) => { gisAdmin.setCropPalette(body(ctx).palette ?? {}, ctx.actor); return gisAdmin.configOverview(); }, P.GIS_ADMIN);
  api.put('/gis/admin/config/thresholds', (ctx) => { gisAdmin.setCapacityThresholds(body(ctx).bands ?? [], ctx.actor); return gisAdmin.configOverview(); }, P.GIS_ADMIN);
  api.put('/gis/admin/config/simple', (ctx) => { gisAdmin.setSimpleConfig(body(ctx).key, body(ctx).value, ctx.actor); return gisAdmin.configOverview(); }, P.GIS_ADMIN);
  api.post('/gis/admin/config/reset', (ctx) => { gisAdmin.resetConfig(body(ctx).key, ctx.actor); return gisAdmin.configOverview(); }, P.GIS_ADMIN);

  api.get('/gis/admin/sync', () => gisAdmin.syncMonitor(), P.GIS_READ);
  api.post('/gis/admin/sync/:id/retry', (ctx) => gisAdmin.retryOne(ctx.params.id, null, ctx.actor), P.GIS_ADMIN);
  api.post('/gis/admin/sync/simulate-failure', (ctx) => gisAdmin.simulateFailure(body(ctx).system ?? 'app_htx', body(ctx).dataset ?? 'demo_failure', ctx.actor), P.GIS_ADMIN);
  api.post('/gis/admin/manual-entry', (ctx) => { gisAdmin.manualEntry(body(ctx) as never, ctx.actor); return { ok: true }; }, P.GIS_ADMIN);
  api.get('/gis/admin/overrides', () => gisAdmin.pendingOverrides(), P.GIS_READ);
  api.post('/gis/admin/overrides/resolve', (ctx) => { gisAdmin.resolveOverride(body(ctx) as never, ctx.actor); return { ok: true }; }, P.GIS_ADMIN);
  api.get('/gis/admin/integration', () => gisAdmin.integrationOverview(), P.GIS_READ);

  // ===================== Sức khoẻ CSDL & sao lưu (rà soát 24/09/2026) =====================
  api.get('/admin/db-health', () => ({
    integrity: integrityByDomain(true), orphans: findOrphans(), indexes: indexSummary(),
    backups: listBackups().slice(0, 10).map((b) => ({ dir: b.dir, ok: b.manifest?.ok ?? false, createdAt: b.manifest?.createdAt ?? null, bytes: b.manifest?.files.reduce((a, f) => a + f.bytes, 0) ?? 0, durationMs: b.manifest?.durationMs ?? null })),
  }), P.ADMIN_CONFIG);
  api.post('/admin/db-backup', (ctx) => {
    const result = backupAll({ keep: Number(body(ctx)?.keep ?? 14) });
    logEvent({ module: 'admin', entityType: 'db_backup', entityId: result.dir, action: 'create', after: { ok: result.manifest.ok, files: result.manifest.files.length, durationMs: result.manifest.durationMs }, source: 'ui' }, ctx.actor);
    return result;
  }, P.ADMIN_CONFIG);
  api.post('/admin/db-backup/verify', (ctx) => verifyBackup(String(body(ctx).dir ?? '')), P.ADMIN_CONFIG);

  // FN-08/FN-09 — tra cứu tuyến phù hợp tải trọng (US-ROAD-01, US-WATER-01)
  api.get('/gis/routes/suitable', (ctx) => {
    const mode = (ctx.query.get('mode') as 'road' | 'waterway') ?? 'waterway';
    const load = num(ctx.query.get('load'), 0);
    const routes = waterways.listRoutes({ mode });
    const suitable = routes.filter((r) => Number(r.max_load_tons ?? r.derived_max_load_tons ?? 0) >= load);
    return { mode, load, total: routes.length, suitable: suitable.map((r) => r.id), routes: suitable, notice: suitable.length ? null : 'Không tìm thấy tuyến phù hợp với tải trọng đã nhập.' };
  }, P.GIS_READ);

  // ===================== App HTX — nhật ký, duyệt, mở vụ, sản lượng, tin tức, dashboard =====================
  api.get('/htx/gps-labels', () => htxOps.GPS_LABELS, P.HTX_READ);
  api.post('/htx/farm-logs/v2', (ctx) => htxOps.addFarmLogV2(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/htx/farm-logs/bulk', (ctx) => htxOps.addFarmLogsBulk(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.get('/htx/farm-logs/review', (ctx) => htxOps.pendingLogs(scopedHtxId(ctx, ctx.query.get('htxId')), (ctx.query.get('status') as never) ?? 'cho_duyet'), P.HTX_READ);
  api.post('/htx/farm-logs/:id/review', (ctx) => htxOps.reviewFarmLog(ctx.params.id, body(ctx).decision, body(ctx).note, ctx.actor), P.HTX_WRITE);

  api.post('/htx/seasons/open', (ctx) => htxOps.openSeasonV2(body(ctx) as never, ctx.actor), P.HTX_WRITE);
  api.post('/htx/seasons/open-bulk', (ctx) => htxOps.openSeasonBulk({ ...(body(ctx) as object), htxId: ctx.user?.htxId ?? body(ctx).htxId } as never, ctx.actor), P.HTX_WRITE);
  api.get('/htx/seasons/previous-config', (ctx) => htxOps.previousSeasonConfig(ctx.query.get('plotId') ?? ''), P.HTX_READ);

  api.post('/htx/harvest/v2', (ctx) => confirmable(() => htxOps.declareHarvestV2(body(ctx) as never, ctx.actor)), P.HTX_WRITE);
  api.post('/htx/harvest/bulk', (ctx) => htxOps.declareHarvestBulk(body(ctx).rows ?? [], ctx.actor), P.HTX_WRITE);

  api.get('/htx/yield-dashboard', (ctx) => htxOps.yieldDashboard(scopedHtxId(ctx, ctx.query.get('htxId')), {
    seasonId: ctx.query.get('seasonId') ?? undefined, variety: ctx.query.get('variety') ?? undefined, farmerId: ctx.query.get('farmerId') ?? undefined,
  }), P.HTX_READ);
  api.get('/htx/reports/harvest.csv', (ctx) => sendCsv(ctx, 'bao-cao-san-luong.csv', htxOps.harvestReportRows(scopedHtxId(ctx, ctx.query.get('htxId')), ctx.query.get('seasonId') ?? undefined)), P.HTX_READ);
  api.get('/htx/reports/harvest', (ctx) => htxOps.harvestReportRows(scopedHtxId(ctx, ctx.query.get('htxId')), ctx.query.get('seasonId') ?? undefined), P.HTX_READ);

  api.get('/htx/news', (ctx) => ({ categories: htxOps.NEWS_CATEGORIES, items: htxOps.newsFeed({ category: ctx.query.get('category') ?? undefined, q: ctx.query.get('q') ?? undefined }) }), P.HTX_READ);
  api.post('/htx/news/:id/viewed', (ctx) => { htxOps.markArticleViewed(ctx.params.id); return { ok: true }; }, P.HTX_READ);

  api.get('/reports/schedules', (ctx) => { requireUser(ctx); return htxOps.listReportSchedules(ctx.query.get('system') ?? 'htx', ctx.query.get('scopeId') ?? ctx.user?.htxId ?? null); });
  api.post('/reports/schedules', (ctx) => { requireUser(ctx); return htxOps.scheduleReport({ ...(body(ctx) as object), scopeId: body(ctx).scopeId ?? ctx.user?.htxId ?? null } as never, ctx.actor); });
  api.delete('/reports/schedules/:id', (ctx) => { requireUser(ctx); htxOps.cancelReportSchedule(ctx.params.id, ctx.actor); return { ok: true }; });

  // ===================== App Khuyến nông — phạm vi vai trò, HTX & máy móc, SLA, thư viện, giá, báo cáo =====================
  api.get('/kn/dashboard/v2', (ctx) => knOps.scopedDashboard(ctx.user), P.KN_READ);
  api.get('/kn/htx', (ctx) => knOps.cooperativesInScope(ctx.user, ctx.query.get('q') ?? undefined), P.KN_READ);
  api.get('/kn/htx/:id/machinery', (ctx) => knOps.machineryDeclarations(ctx.params.id), P.KN_READ);
  api.put('/kn/htx/:id/machinery', (ctx) => knOps.declareMachinery(ctx.params.id, body(ctx).rows ?? [], ctx.actor), P.KN_WRITE);
  api.get('/kn/tasks/v2', (ctx) => knOps.tasksWithSla({ status: ctx.query.get('status') ?? undefined, assigneeId: ctx.query.get('assigneeId') ?? undefined, htxId: ctx.query.get('htxId') ?? undefined }), P.KN_READ);
  api.post('/kn/tasks/:id/escalate', (ctx) => knOps.escalateTask(ctx.params.id, String(body(ctx).note ?? ''), ctx.actor), P.KN_WRITE);
  api.post('/kn/tasks/bulk-assign', (ctx) => knOps.bulkAssignTasks(body(ctx).ids ?? [], String(body(ctx).assigneeId ?? ''), ctx.actor), P.KN_PUBLISH);
  api.post('/kn/tasks/escalate-overdue', (ctx) => ({ escalated: knOps.escalateOverdueTasks(ctx.actor) }), P.KN_PUBLISH);
  api.post('/kn/alerts/regional', (ctx) => knOps.regionalAlert(body(ctx) as never, ctx.actor), P.KN_PUBLISH);
  // UAT DEF-KN-TASK-01: chỉ liệt kê cán bộ đang hoạt động để phân công.
  api.get('/kn/staff', () => users.listUsers().filter((u) => u.status === 'active' && u.roles.some((r) => r.startsWith('kn_'))).map((u) => ({ id: u.id, fullName: u.fullName, roles: u.roles, provinceId: u.provinceId })), P.KN_READ);

  api.post('/kn/articles/v2', (ctx) => knOps.createArticleV2(body(ctx) as never, ctx.actor), P.KN_WRITE);
  api.post('/kn/articles/:id/publish/v2', (ctx) => knOps.publishArticleV2(ctx.params.id, ctx.actor), P.KN_PUBLISH);
  api.get('/kn/articles/search', (ctx) => knOps.searchArticles({
    q: ctx.query.get('q') ?? undefined, kind: ctx.query.get('kind') ?? undefined, category: ctx.query.get('category') ?? undefined,
    status: ctx.query.get('status') ?? undefined, parentId: ctx.query.get('parentId') ?? undefined,
  }), P.KN_READ);
  api.get('/kn/news-categories', () => htxOps.NEWS_CATEGORIES, P.KN_READ);

  api.post('/kn/prices/bulletin', (ctx) => knOps.publishPriceBulletin(body(ctx) as never, ctx.actor), P.KN_PUBLISH);
  api.get('/kn/prices/watchlist', (ctx) => knOps.watchlist(requireUser(ctx).id), P.KN_READ);
  api.put('/kn/prices/watchlist', (ctx) => { knOps.setWatch(requireUser(ctx).id, String(body(ctx).commodity), num(body(ctx).thresholdPct, 5), ctx.actor); return knOps.watchlist(ctx.user!.id); }, P.KN_READ);
  api.delete('/kn/prices/watchlist/:commodity', (ctx) => { knOps.unwatch(requireUser(ctx).id, decodeURIComponent(ctx.params.commodity)); return { ok: true }; }, P.KN_READ);

  api.get('/kn/reports/summary', (ctx) => knOps.summaryReportRows(ctx.user), P.KN_READ);
  api.get('/kn/reports/summary.csv', (ctx) => {
    const report = knOps.summaryReportRows(ctx.user);
    return sendCsv(ctx, `bao-cao-khuyen-nong${report.provisional ? '-tam-tinh' : ''}.csv`, report.rows);
  }, P.KN_READ);

  // ===================== Bản đồ Cơ giới hoá — cấu hình, hồ sơ, bản đồ, cân đối, báo cáo, dashboard, nhật ký =====================
  api.get('/cgh/thresholds', () => ({ versions: cghOps.listThresholdVersions(), current: cgh.coverageThresholds(), bands: cgh.coverageBands() }), P.CGH_READ);
  api.post('/cgh/thresholds', (ctx) => cghOps.addThresholdVersion(body(ctx) as never, ctx.actor), P.CGH_WRITE);
  api.get('/cgh/machine-types/all', () => cghOps.listMachineTypesAll(), P.CGH_READ);
  api.put('/cgh/machine-types/:id', (ctx) => cghOps.updateMachineType(ctx.params.id, body(ctx) as never, ctx.actor), P.CGH_WRITE);
  api.post('/cgh/machine-types/:id/active', (ctx) => cghOps.setMachineTypeActive(ctx.params.id, Boolean(body(ctx).active), ctx.actor), P.CGH_WRITE);
  api.delete('/cgh/machine-types/:id', (ctx) => { cghOps.deleteMachineType(ctx.params.id, ctx.actor); return { ok: true }; }, P.CGH_WRITE);
  api.get('/cgh/norms/all', () => cghOps.allNorms(), P.CGH_READ);
  api.post('/cgh/norms/:id/close', (ctx) => { cghOps.closeNorm(ctx.params.id, String(body(ctx).effectiveTo ?? ''), ctx.actor); return { ok: true }; }, P.CGH_WRITE);
  api.get('/cgh/history', (ctx) => cghOps.configHistory(ctx.query.get('entityType') ?? 'machine_types', ctx.query.get('entityId') ?? undefined), P.CGH_READ);

  api.get('/cgh/owner-types', () => cgh.OWNER_TYPES, P.CGH_READ);
  api.get('/cgh/owners', (ctx) => maskPhones(ctx, cghOps.listOwners({ htxId: ctx.query.get('htxId') ?? undefined, includeInactive: ctx.query.get('all') === '1' }), P.CGH_WRITE, 'machine_owners'), P.CGH_READ);
  api.post('/cgh/owners/:id/deactivate', (ctx) => confirmable(() => cghOps.deactivateOwner(ctx.params.id, Boolean(body(ctx).confirm), ctx.actor)), P.CGH_WRITE);
  api.post('/cgh/owners/:id/reactivate', (ctx) => { cghOps.reactivateOwner(ctx.params.id, ctx.actor); return { ok: true }; }, P.CGH_WRITE);

  api.put('/cgh/machines/:id', (ctx) => cghOps.updateMachine(ctx.params.id, body(ctx), ctx.actor), P.CGH_WRITE);
  api.post('/cgh/machines/:id/deactivate', (ctx) => { cghOps.deactivateMachine(ctx.params.id, String(body(ctx).deactivatedAt ?? new Date().toISOString().slice(0, 10)), body(ctx).reason, ctx.actor); return { ok: true }; }, P.CGH_WRITE);
  api.post('/cgh/machines/:id/reactivate', (ctx) => { cghOps.reactivateMachine(ctx.params.id, ctx.actor); return { ok: true }; }, P.CGH_WRITE);
  api.get('/cgh/machines/:id/history', (ctx) => cghOps.machineHistory(ctx.params.id), P.CGH_READ);
  api.post('/cgh/machines/import', (ctx) => {
    const rows = body(ctx).rows ?? cghOps.parseDelimited(String(body(ctx).text ?? ''));
    if (!rows.length) throw badRequest('Tệp không đúng mẫu quy định, vui lòng tải mẫu chuẩn và thử lại');
    const required = ['machine_type', 'owner'];
    const missing = required.filter((c) => !(c in rows[0]));
    if (missing.length || !('serial_number' in rows[0] || 'chassis_number' in rows[0])) throw badRequest(`Tệp thiếu cột bắt buộc: ${[...missing, ...(('serial_number' in rows[0] || 'chassis_number' in rows[0]) ? [] : ['serial_number/chassis_number'])].join(', ')}`);
    if ('ma_may' in rows[0] || 'code' in rows[0]) throw badRequest('Tệp không đúng mẫu quy định — không được có cột Mã máy vì mã do hệ thống tự sinh.');
    return cghOps.importMachines({ htxId: String(body(ctx).htxId ?? ''), mode: body(ctx).mode === 'thay_the' ? 'thay_the' : 'cap_nhat', rows }, ctx.actor);
  }, P.CGH_WRITE);
  api.get('/cgh/htx/:id/machines-at', (ctx) => cghOps.machineCountAt(ctx.params.id, ctx.query.get('at') ?? new Date().toISOString().slice(0, 10)), P.CGH_READ);
  api.get('/cgh/htx/:id/detail', (ctx) => cghOps.htxDetail(ctx.params.id, ctx.query.get('at') ?? undefined), P.CGH_READ);
  api.get('/cgh/search', (ctx) => cghOps.quickSearch(ctx.query.get('q') ?? ''), P.CGH_READ);

  api.get('/cgh/balance/by-province', (ctx) => {
    const balance = cgh.balanceSupplyDemand(ctx.query.get('seasonId') ?? undefined);
    return { rows: cghOps.balanceByProvince(balance.rows), summary: balance.summary, thresholds: cgh.coverageThresholds() };
  }, P.CGH_READ);
  api.post('/cgh/balance/save', (ctx) => cghOps.saveBalanceSnapshot(String(body(ctx).seasonId ?? ''), ctx.actor), P.CGH_WRITE);
  api.get('/cgh/balance/snapshots', () => cghOps.listBalanceSnapshots(), P.CGH_READ);
  api.get('/cgh/report', (ctx) => cghOps.report({ seasonId: ctx.query.get('seasonId') ?? '', provinceId: ctx.query.get('provinceId') ?? undefined, stage: ctx.query.get('stage') ?? undefined }), P.CGH_READ);
  api.get('/cgh/report.csv', (ctx) => {
    const data = cghOps.report({ seasonId: ctx.query.get('seasonId') ?? '', provinceId: ctx.query.get('provinceId') ?? undefined, stage: ctx.query.get('stage') ?? undefined });
    const tab = ctx.query.get('tab') ?? 'summary';
    const header = { exportedAt: data.exportedAt, season: data.season };
    const rows = (tab === 'shortage' ? (data.shortageRows as Record<string, unknown>[]) : (data.summaryRows as Record<string, unknown>[])).map((r) => ({ ngay_xuat: header.exportedAt, vu: header.season, ...r }));
    return sendCsv(ctx, `cgh-${tab}-${String(data.season ?? 'vu')}.csv`, rows);
  }, P.CGH_READ);
  api.get('/cgh/compare', (ctx) => cghOps.compareSeasons(ctx.query.get('a') ?? '', ctx.query.get('b') ?? ''), P.CGH_READ);
  api.get('/cgh/compare.csv', (ctx) => {
    const data = cghOps.compareSeasons(ctx.query.get('a') ?? '', ctx.query.get('b') ?? '');
    return sendCsv(ctx, 'cgh-doi-chieu-vu.csv', (data.rows as Record<string, unknown>[]).map((r) => ({ ngay_xuat: data.exportedAt, vu_a: (data.seasonA as { name: string }).name, vu_b: (data.seasonB as { name: string }).name, ...r })));
  }, P.CGH_READ);
  api.get('/cgh/dashboard/v2', (ctx) => cghOps.dashboardV2(ctx.query.get('seasonId') ?? undefined, Boolean(ctx.user && roleCan(ctx.user.roles, P.CGH_WRITE))), P.CGH_READ);
  api.get('/cgh/activity-log', (ctx) => cghOps.activityLog({ kind: (ctx.query.get('kind') as never) ?? 'all', from: ctx.query.get('from') ?? undefined, to: ctx.query.get('to') ?? undefined }), P.CGH_WRITE);
}
