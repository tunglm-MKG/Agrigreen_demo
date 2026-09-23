/**
 * App Khuyến nông — bổ sung theo Backlog User Story v1.0 (09/2026).
 *
 *   US-ADM-04   trang chủ theo vai trò: TW toàn quốc · tỉnh trong tỉnh · xã/Tổ KNCĐ địa bàn phụ trách
 *   US-HTX-04   khai báo máy móc cơ giới hoá và số lượng của từng HTX
 *   US-TASK-02/03/04  SLA 24 giờ, leo thang lên tỉnh, chỉ đạo theo vùng, phân công hàng loạt
 *   US-LIB-01/02/04/06  chuyên mục, cảnh báo khẩn, hướng dẫn địa phương gắn bản gốc, tìm kiếm, thông báo theo vùng
 *   US-PRICE-03/04      bản tin giá địa phương, theo dõi mặt hàng theo ngưỡng
 *   US-DASH-02          xuất báo cáo (CSV) đúng phạm vi vai trò
 */
import { all, insert, one, run, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { notify } from '../../platform/notify/service.ts';
import type { User } from '../../platform/auth/users.ts';
import { orgScope, priceBoard, listTasks } from './service.ts';

// ---------------------------------------------------------------------------
// Phạm vi dữ liệu theo vai trò (US-ADM-04, US-MAP-01, US-DASH-01)
// ---------------------------------------------------------------------------

export interface KnScope { level: 'trung_uong' | 'tinh' | 'xa'; label: string; provinceIds: string[] | null; htxIds: string[] | null; orgNodeIds: string[] | null }

export function scopeOf(user: User | null): KnScope {
  if (!user) return { level: 'trung_uong', label: 'Toàn quốc', provinceIds: null, htxIds: null, orgNodeIds: null };
  const roles = new Set(user.roles);
  if (roles.has('platform_admin') || roles.has('kn_trung_uong') || roles.has('executive')) {
    return { level: 'trung_uong', label: 'Toàn quốc', provinceIds: null, htxIds: null, orgNodeIds: null };
  }
  const provinceIds = user.provinceId ? [user.provinceId] : null;
  const orgNodeIds = user.orgNodeId ? orgScope(user.orgNodeId) : null;
  if (roles.has('kn_tinh')) {
    const name = user.provinceId ? one<{ name: string }>('SELECT name FROM admin_units WHERE id = ?', [user.provinceId])?.name : null;
    return { level: 'tinh', label: name ? `Tỉnh ${name}` : 'Cấp tỉnh', provinceIds, htxIds: null, orgNodeIds };
  }
  // Cán bộ xã / Tổ KNCĐ (UAT DEF-KN-02): phạm vi là xã được gán — HTX cùng xã với đầu mối tổ chức hoặc
  // HTX gắn trực tiếp trên tài khoản. Chỉ khi không gán gì mới rơi về tỉnh và nhãn nói rõ "chưa gán xã".
  const node = user.orgNodeId ? one<{ admin_unit_id: string | null; name: string }>('SELECT admin_unit_id, name FROM org_nodes WHERE id = ?', [user.orgNodeId]) : null;
  const unit = node?.admin_unit_id ? one<{ id: string; level: string; name: string }>('SELECT id, level, name FROM admin_units WHERE id = ?', [node.admin_unit_id]) : null;
  const provinceName = user.provinceId ? one<{ name: string }>('SELECT name FROM admin_units WHERE id = ?', [user.provinceId])?.name : null;
  if (unit && unit.level === 'commune') {
    const htxIds = all<{ id: string }>('SELECT id FROM cooperatives WHERE commune_id = ?', [unit.id]).map((r) => r.id);
    if (user.htxId && !htxIds.includes(user.htxId)) htxIds.push(user.htxId);
    return { level: 'xa', label: `Xã ${unit.name}`, provinceIds, htxIds, orgNodeIds };
  }
  if (user.htxId) {
    const own = one<{ id: string; name: string; commune_id: string | null }>('SELECT id, name, commune_id FROM cooperatives WHERE id = ?', [user.htxId]);
    const sameCommune = own?.commune_id ? all<{ id: string }>('SELECT id FROM cooperatives WHERE commune_id = ?', [own.commune_id]).map((r) => r.id) : [];
    const htxIds = [...new Set([user.htxId, ...sameCommune])];
    return { level: 'xa', label: `Địa bàn ${own?.name ?? 'HTX phụ trách'}`, provinceIds, htxIds, orgNodeIds };
  }
  const htxIds = provinceIds ? all<{ id: string }>('SELECT id FROM cooperatives WHERE province_id = ?', [provinceIds[0]]).map((r) => r.id) : null;
  return { level: 'xa', label: provinceName ? `Địa bàn ${provinceName} (chưa gán xã)` : 'Địa bàn phụ trách (chưa gán xã)', provinceIds, htxIds, orgNodeIds };
}

function htxFilter(scope: KnScope, column = 'c.id'): { clause: string; params: unknown[] } {
  if (scope.htxIds) return { clause: `${column} IN (${scope.htxIds.map(() => '?').join(',') || "''"})`, params: scope.htxIds };
  if (scope.provinceIds) return { clause: `c.province_id IN (${scope.provinceIds.map(() => '?').join(',')})`, params: scope.provinceIds };
  return { clause: '1 = 1', params: [] };
}

/** Bảng điều hành theo đúng phạm vi vai trò; toàn quốc = tổng các tỉnh (US-DASH-01 AC-2). */
export function scopedDashboard(user: User | null): Record<string, unknown> {
  const scope = scopeOf(user);
  const f = htxFilter(scope);
  const kpis = one<{ htx: number; area_ha: number; farmers: number; plots: number }>(
    `SELECT COUNT(DISTINCT c.id) AS htx, COALESCE(SUM(c.registered_area_ha), 0) AS area_ha, COALESCE(SUM(c.member_count), 0) AS farmers,
            (SELECT COUNT(*) FROM plots p JOIN cooperatives c2 ON c2.id = p.htx_id WHERE p.deleted_at IS NULL AND ${f.clause.replace(/c\./g, 'c2.')}) AS plots
     FROM cooperatives c WHERE c.status = 'active' AND ${f.clause}`, [...f.params, ...f.params]);
  const tasks = all<{ status: string; n: number }>(
    `SELECT t.status, COUNT(*) AS n FROM support_tasks t LEFT JOIN cooperatives c ON c.id = t.htx_id WHERE (t.htx_id IS NULL OR ${f.clause}) GROUP BY t.status`, f.params);
  const overdueSla = all(
    `SELECT t.code, t.title, t.created_at, t.sla_hours, c.name AS htx_name FROM support_tasks t LEFT JOIN cooperatives c ON c.id = t.htx_id
     WHERE t.status = 'moi' AND (t.htx_id IS NULL OR ${f.clause}) AND t.created_at < ? ORDER BY t.created_at LIMIT 20`,
    [...f.params, new Date(Date.now() - 24 * 3600_000).toISOString()]);
  const byProvince = all(
    `SELECT a.id, a.name, COUNT(DISTINCT c.id) AS htx, COALESCE(SUM(c.registered_area_ha), 0) AS area_ha,
            (SELECT COUNT(*) FROM plots p JOIN cooperatives c3 ON c3.id = p.htx_id WHERE c3.province_id = a.id AND p.deleted_at IS NULL) AS plots
     FROM admin_units a JOIN cooperatives c ON c.province_id = a.id AND c.status = 'active'
     WHERE a.level = 'province' AND ${f.clause} GROUP BY a.id ORDER BY area_ha DESC`, f.params);
  const pendingVerify = all(
    `SELECT fl.id, fl.log_date, fl.activity, fl.gps_status, p.code AS plot_code, c.name AS htx_name
     FROM farm_logs fl JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id JOIN cooperatives c ON c.id = p.htx_id
     WHERE fl.approval_status = 'cho_duyet' AND ${f.clause} ORDER BY fl.created_at DESC LIMIT 15`, f.params);
  const weather = scope.provinceIds
    ? all("SELECT observed_for, rainfall_mm, humidity_pct, temp_c, severity, headline FROM weather_observations WHERE area_id = ? AND observed_for >= ? ORDER BY observed_for LIMIT 5", [scope.provinceIds[0], nowIso().slice(0, 10)])
    : [];
  const awd = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM farm_logs fl JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id JOIN cooperatives c ON c.id = p.htx_id
     WHERE fl.activity = 'rut_nuoc_awd' AND ${f.clause} AND fl.log_date >= ?`, [...f.params, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)]);
  return { scope: { level: scope.level, label: scope.label }, kpis, tasks, overdueSla, byProvince, pendingVerify, weather, awdLogs30d: awd?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// US-HTX-01/04 — HTX & nông hộ trong phạm vi, khai báo máy móc
// ---------------------------------------------------------------------------

export function cooperativesInScope(user: User | null, search?: string): Record<string, unknown>[] {
  const scope = scopeOf(user);
  const f = htxFilter(scope);
  const params = [...f.params];
  let extra = '';
  if (search) { extra = ' AND (c.name LIKE ? OR c.code LIKE ? OR c.tax_code LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  return all(
    `SELECT c.*, a.name AS province_name,
            (SELECT COUNT(*) FROM farmers f WHERE f.htx_id = c.id AND f.status = 'active') AS farmer_count,
            (SELECT COUNT(*) FROM plots p WHERE p.htx_id = c.id AND p.deleted_at IS NULL) AS plot_count,
            (SELECT COALESCE(SUM(p.area_ha), 0) FROM plots p WHERE p.htx_id = c.id AND p.deleted_at IS NULL) AS plot_area_ha,
            (SELECT COALESCE(SUM(d.quantity), 0) FROM htx_machinery_declarations d WHERE d.htx_id = c.id) AS declared_machines,
            (SELECT COUNT(*) FROM machines m WHERE m.htx_id = c.id AND COALESCE(m.status, 'active') = 'active') AS registered_machines
     FROM cooperatives c LEFT JOIN admin_units a ON a.id = c.province_id
     WHERE c.status = 'active' AND ${f.clause}${extra} ORDER BY a.name, c.name`, params);
}

export function machineryDeclarations(htxId: string): Record<string, unknown>[] {
  return all(
    `SELECT mt.id AS machine_type_id, mt.code, mt.name, mt.stage, COALESCE(d.quantity, 0) AS quantity, d.note, d.declared_by, d.updated_at,
            (SELECT COUNT(*) FROM machines m WHERE m.htx_id = ? AND m.machine_type_id = mt.id AND COALESCE(m.status, 'active') = 'active') AS registered
     FROM machine_types mt LEFT JOIN htx_machinery_declarations d ON d.machine_type_id = mt.id AND d.htx_id = ?
     WHERE mt.active = 1 ORDER BY mt.stage, mt.name`, [htxId, htxId]);
}

export function declareMachinery(htxId: string, rows: { machineTypeId: string; quantity: number; note?: string }[], actor: AuditActor = {}): Record<string, unknown>[] {
  for (const row of rows) {
    if (!(row.quantity >= 0) || !Number.isInteger(Number(row.quantity))) throw new Error('Số lượng máy phải là số nguyên không âm.');
    const existing = one<{ id: string }>('SELECT id FROM htx_machinery_declarations WHERE htx_id = ? AND machine_type_id = ?', [htxId, row.machineTypeId]);
    if (existing) update('htx_machinery_declarations', existing.id, { quantity: row.quantity, note: row.note ?? null, declared_by: actor.name ?? null, updated_at: nowIso() });
    else insert('htx_machinery_declarations', { id: uuid(), htx_id: htxId, machine_type_id: row.machineTypeId, quantity: row.quantity, note: row.note ?? null, declared_by: actor.name ?? null, declared_at: nowIso(), updated_at: nowIso() });
  }
  logEvent({ module: 'khuyennong', entityType: 'htx_machinery_declarations', entityId: htxId, action: 'update', after: rows }, actor);
  return machineryDeclarations(htxId);
}

// ---------------------------------------------------------------------------
// US-TASK-02/03/04 — SLA, leo thang, phân công hàng loạt
// ---------------------------------------------------------------------------

export function tasksWithSla(filter: { status?: string; assigneeId?: string; htxId?: string } = {}): Record<string, unknown>[] {
  const now = Date.now();
  return listTasks(filter).map((task) => {
    const created = new Date(String(task.created_at)).getTime();
    const ageHours = Math.round((now - created) / 3600_000);
    const slaHours = Number(task.sla_hours ?? 24);
    const breached = task.status === 'moi' && ageHours > slaHours;
    return { ...task, ageHours, slaHours, slaBreached: breached, slaRemainingHours: task.status === 'moi' ? slaHours - ageHours : null };
  });
}

/** Quá SLA mà chưa tiếp nhận → leo thang lên TTKN tỉnh (US-TASK-02 AC-2). Gọi định kỳ từ quét cảnh báo. */
export function escalateOverdueTasks(actor: AuditActor = { name: 'system' }): number {
  const overdue = all<{ id: string; code: string; title: string; htx_id: string | null; sla_hours: number }>(
    `SELECT id, code, title, htx_id, sla_hours FROM support_tasks
     WHERE status = 'moi' AND escalated_at IS NULL AND created_at < ?`,
    [new Date(Date.now() - 24 * 3600_000).toISOString()]);
  for (const task of overdue) {
    const province = task.htx_id ? one<{ name: string }>('SELECT a.name FROM cooperatives c JOIN admin_units a ON a.id = c.province_id WHERE c.id = ?', [task.htx_id])?.name : null;
    update('support_tasks', task.id, { escalated_at: nowIso(), escalated_to: province ? `TTKN ${province}` : 'TTKN tỉnh', updated_at: nowIso() });
    notify({
      module: 'khuyennong', severity: 'warn', title: `Nhiệm vụ ${task.code} quá SLA ${task.sla_hours} giờ`,
      body: `${task.title} — chưa có cán bộ tiếp nhận, đã leo thang lên ${province ? `TTKN ${province}` : 'cấp tỉnh'}.`,
      link: '/kn/#kn-tasks', roles: ['kn_tinh', 'kn_trung_uong'], dedupeKey: `kn.task.escalate.${task.id}`, entityType: 'support_tasks', entityId: task.id,
    }, actor);
    logEvent({ module: 'khuyennong', entityType: 'support_tasks', entityId: task.id, action: 'update', note: 'sla_escalated', source: 'system' }, actor);
  }
  return overdue.length;
}

export function escalateTask(id: string, note: string, actor: AuditActor = {}): Record<string, unknown> {
  const task = one<Record<string, unknown>>('SELECT * FROM support_tasks WHERE id = ?', [id]);
  if (!task) throw new Error('Không tìm thấy nhiệm vụ');
  update('support_tasks', id, { escalated_at: nowIso(), escalated_to: 'TTKN tỉnh', resolution: note || null, updated_at: nowIso() });
  notify({ module: 'khuyennong', severity: 'warn', title: `Chuyển tiếp nhiệm vụ ${String(task.code)} lên tỉnh`, body: note || String(task.title), link: '/kn/#kn-tasks', roles: ['kn_tinh'], dedupeKey: `kn.task.forward.${id}.${Date.now()}` }, actor);
  logEvent({ module: 'khuyennong', entityType: 'support_tasks', entityId: id, action: 'update', before: task, after: { escalated_to: 'TTKN tỉnh', note } }, actor);
  return one<Record<string, unknown>>('SELECT * FROM support_tasks WHERE id = ?', [id])!;
}

export function bulkAssignTasks(ids: string[], assigneeId: string, actor: AuditActor = {}): { assigned: number } {
  const assignee = one<{ id: string; full_name: string }>('SELECT id, full_name FROM users WHERE id = ?', [assigneeId]);
  if (!assignee) throw new Error('Không tìm thấy cán bộ được phân công.');
  let assigned = 0;
  for (const id of ids) {
    const task = one<{ status: string }>('SELECT status FROM support_tasks WHERE id = ?', [id]);
    if (!task || task.status === 'dong' || task.status === 'hoan_thanh') continue;
    update('support_tasks', id, { assignee_id: assigneeId, status: task.status === 'moi' ? 'tiep_nhan' : task.status, updated_at: nowIso() });
    assigned += 1;
  }
  notify({ module: 'khuyennong', severity: 'info', title: `Bạn được phân công ${assigned} nhiệm vụ`, body: `${actor.name ?? 'Quản lý'} vừa phân công hàng loạt.`, link: '/kn/#kn-tasks', userIds: [assigneeId], dedupeKey: `kn.task.bulk.${assigneeId}.${Date.now()}` }, actor);
  logEvent({ module: 'khuyennong', entityType: 'support_tasks', action: 'update', after: { ids, assigneeId, assigned }, note: 'bulk_assign' }, actor);
  return { assigned };
}

/** Chỉ đạo/cảnh báo khẩn theo vùng có xác nhận đã đọc — gửi thông báo tới cán bộ và HTX trong tỉnh (US-TASK-03). */
export function regionalAlert(input: { provinceId: string; title: string; body: string; severity?: 'info' | 'warn' | 'critical' }, actor: AuditActor = {}): { recipients: number } {
  const province = one<{ name: string }>('SELECT name FROM admin_units WHERE id = ?', [input.provinceId]);
  if (!province) throw new Error('Không tìm thấy tỉnh.');
  const users = all<{ id: string }>(
    `SELECT DISTINCT u.id FROM users u LEFT JOIN cooperatives c ON c.id = u.htx_id
     WHERE u.status = 'active' AND (u.province_id = ? OR c.province_id = ?)`, [input.provinceId, input.provinceId]);
  const sent = notify({
    module: 'khuyennong', severity: input.severity ?? 'warn', title: `[${province.name}] ${input.title}`, body: input.body,
    link: '/kn/#kn-dashboard', userIds: users.map((u) => u.id), dedupeKey: `kn.alert.${input.provinceId}.${Date.now()}`, entityType: 'regional_alert',
  }, actor);
  logEvent({ module: 'khuyennong', entityType: 'regional_alert', entityId: input.provinceId, action: 'create', after: { ...input, recipients: users.length } }, actor);
  return { recipients: sent || users.length };
}

// ---------------------------------------------------------------------------
// US-LIB-01/02/04/06 — thư viện: chuyên mục, khẩn, địa phương, tìm kiếm, thông báo
// ---------------------------------------------------------------------------

export function createArticleV2(
  input: { title: string; kind: 'quy_trinh' | 'tai_lieu' | 'tin_tuc'; category?: string; urgent?: boolean; summary?: string; body?: string; crop?: string; scopeNodeId?: string | null; parentId?: string | null; regionLabel?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  if (!input.title?.trim()) throw new Error('Vui lòng nhập tiêu đề và chọn chuyên mục trước khi xuất bản.');
  if (input.parentId) {
    const parent = one<{ id: string; scope_node_id: string | null }>('SELECT id, scope_node_id FROM knowledge_articles WHERE id = ?', [input.parentId]);
    if (!parent) throw new Error('Không tìm thấy quy trình gốc để gắn hướng dẫn địa phương.');
    if (!input.regionLabel?.trim()) throw new Error('Hướng dẫn địa phương phải gắn nhãn tỉnh (regionLabel).');
  }
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM knowledge_articles');
  const record = {
    id: uuid(), code: sequenceCode('KB', (count?.n ?? 0) + 1, 5), title: input.title.trim(), kind: input.kind,
    category: input.category ?? (input.kind === 'tin_tuc' ? 'chinh_sach' : 'ky_thuat'), urgent: input.urgent ? 1 : 0,
    summary: input.summary ?? null, body: input.body ?? null, crop: input.crop ?? null, status: 'draft',
    scope_node_id: input.scopeNodeId ?? null, parent_id: input.parentId ?? null, region_label: input.regionLabel ?? null,
    published_at: null, author_id: actor.id ?? null, view_count: 0, created_at: nowIso(), updated_at: nowIso(),
  };
  insert('knowledge_articles', record);
  logEvent({ module: 'khuyennong', entityType: 'knowledge_articles', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

/** Xuất bản: thông báo đúng vùng áp dụng (US-LIB-06), tin khẩn đẩy tới nông dân & HTX (US-NEWS-03). */
export function publishArticleV2(id: string, actor: AuditActor = {}): Record<string, unknown> {
  const before = one<{ title: string; urgent: number; scope_node_id: string | null; kind: string; category: string; region_label: string | null }>('SELECT * FROM knowledge_articles WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy nội dung');
  update('knowledge_articles', id, { status: 'published', published_at: nowIso(), updated_at: nowIso() });
  const after = one<Record<string, unknown>>('SELECT * FROM knowledge_articles WHERE id = ?', [id])!;
  logEvent({ module: 'khuyennong', entityType: 'knowledge_articles', entityId: id, action: 'approve', before, after }, actor);

  // Người nhận theo vùng: nút tổ chức có admin_unit → tỉnh; không có → toàn hệ thống.
  let userIds: string[] | undefined;
  if (before.scope_node_id) {
    const nodes = orgScope(before.scope_node_id);
    const provinces = all<{ admin_unit_id: string }>(`SELECT admin_unit_id FROM org_nodes WHERE id IN (${nodes.map(() => '?').join(',')}) AND admin_unit_id IS NOT NULL`, nodes).map((r) => r.admin_unit_id);
    if (provinces.length) {
      userIds = all<{ id: string }>(
        `SELECT DISTINCT u.id FROM users u LEFT JOIN cooperatives c ON c.id = u.htx_id
         WHERE u.status = 'active' AND (u.province_id IN (${provinces.map(() => '?').join(',')}) OR c.province_id IN (${provinces.map(() => '?').join(',')}))`,
        [...provinces, ...provinces]).map((r) => r.id);
    }
  }
  notify({
    module: 'khuyennong', severity: before.urgent ? 'critical' : 'info',
    title: before.urgent ? `⚠️ Cảnh báo khẩn: ${before.title}` : `Nội dung mới: ${before.title}`,
    body: before.urgent ? 'Tin cảnh báo dịch hại / thời tiết — mở ngay để xem hướng dẫn xử lý.' : `${before.kind === 'quy_trinh' ? 'Quy trình kỹ thuật' : before.kind === 'tai_lieu' ? 'Tài liệu' : 'Tin tức'} vừa được xuất bản${before.region_label ? ` (${before.region_label})` : ''}.`,
    link: '/htx/#htx-news', ...(userIds ? { userIds } : { roles: ['kn_xa', 'kn_tinh', 'htx_manager', 'farmer'] }),
    dedupeKey: `kn.article.publish.${id}`, entityType: 'knowledge_articles', entityId: id,
  }, actor);
  return after;
}

export function searchArticles(filter: { q?: string; kind?: string; category?: string; status?: string; parentId?: string } = {}): { items: Record<string, unknown>[]; suggestions: string[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.q) { clauses.push('(title LIKE ? OR summary LIKE ? OR body LIKE ? OR crop LIKE ?)'); params.push(...Array(4).fill(`%${filter.q}%`)); }
  if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
  if (filter.category) { clauses.push('category = ?'); params.push(filter.category); }
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  if (filter.parentId) { clauses.push('parent_id = ?'); params.push(filter.parentId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = all(`SELECT a.*, o.name AS scope_name, pa.title AS parent_title FROM knowledge_articles a LEFT JOIN org_nodes o ON o.id = a.scope_node_id LEFT JOIN knowledge_articles pa ON pa.id = a.parent_id ${where} ORDER BY a.urgent DESC, COALESCE(a.published_at, a.created_at) DESC LIMIT 300`, params);
  // Không có kết quả → gợi ý chủ đề liên quan (US-LIB-04 AC-2).
  const suggestions = items.length ? [] : all<{ category: string; n: number }>("SELECT category, COUNT(*) AS n FROM knowledge_articles WHERE status = 'published' GROUP BY category ORDER BY n DESC LIMIT 5").map((r) => r.category);
  return { items, suggestions };
}

// ---------------------------------------------------------------------------
// US-PRICE-03/04 — bản tin giá địa phương & theo dõi theo ngưỡng
// ---------------------------------------------------------------------------

export function publishPriceBulletin(input: { region: string; note?: string; scopeNodeId?: string | null }, actor: AuditActor = {}): Record<string, unknown> {
  const today = nowIso().slice(0, 10);
  const board = priceBoard().filter((row) => !input.region || String(row.region ?? '').toLowerCase().includes(input.region.toLowerCase()) || String(row.region ?? '') === 'ĐBSCL');
  if (!board.some((row) => String(row.price_date) === today)) {
    throw new Error('Bản tin chỉ công bố được sau khi Master Data giá trong ngày đã được Admin nạp/đồng bộ.');
  }
  const lines = board.map((row) => `• ${row.commodity} (${row.region ?? 'ĐBSCL'}): ${Number(row.price).toLocaleString('vi-VN')} ${row.unit} ${row.trend === 'tang' ? '▲' : row.trend === 'giam' ? '▼' : '■'} ${row.changePct ?? 0}%`);
  const article = createArticleV2({
    title: `Bản tin giá ${input.region} ngày ${today}`, kind: 'tin_tuc', category: 'thi_truong',
    summary: `${board.length} mặt hàng · ${board.filter((r) => r.trend === 'tang').length} tăng · ${board.filter((r) => r.trend === 'giam').length} giảm`,
    body: `${lines.join('\n')}${input.note ? `\n\nGhi chú: ${input.note}` : ''}`, scopeNodeId: input.scopeNodeId ?? null, regionLabel: input.region,
  }, actor);
  return publishArticleV2(String(article.id), actor);
}

export function watchlist(userId: string): Record<string, unknown>[] {
  const board = priceBoard();
  return all<{ id: string; commodity: string; threshold_pct: number }>('SELECT * FROM price_watchlist WHERE user_id = ? ORDER BY commodity', [userId]).map((w) => {
    const latest = board.find((row) => row.commodity === w.commodity);
    const changePct = latest ? Number(latest.changePct ?? 0) : null;
    return { ...w, latest, triggered: changePct !== null && Math.abs(changePct) >= Number(w.threshold_pct) };
  });
}

export function setWatch(userId: string, commodity: string, thresholdPct: number, actor: AuditActor = {}): void {
  if (!(thresholdPct > 0)) throw new Error('Ngưỡng biến động phải lớn hơn 0 %.');
  const existing = one<{ id: string }>('SELECT id FROM price_watchlist WHERE user_id = ? AND commodity = ?', [userId, commodity]);
  if (existing) update('price_watchlist', existing.id, { threshold_pct: thresholdPct });
  else insert('price_watchlist', { id: uuid(), user_id: userId, commodity, threshold_pct: thresholdPct, created_at: nowIso() });
  logEvent({ module: 'khuyennong', entityType: 'price_watchlist', entityId: userId, action: 'update', after: { commodity, thresholdPct } }, actor);
}

export function unwatch(userId: string, commodity: string): void {
  run('DELETE FROM price_watchlist WHERE user_id = ? AND commodity = ?', [userId, commodity]);
}

/** Quét: mặt hàng theo dõi vượt ngưỡng → thông báo riêng cho người đó (US-PRICE-04 AC). */
export function scanWatchlists(actor: AuditActor = { name: 'system' }): number {
  let sent = 0;
  const users = all<{ user_id: string }>('SELECT DISTINCT user_id FROM price_watchlist');
  for (const { user_id } of users) {
    for (const item of watchlist(user_id)) {
      if (!item.triggered) continue;
      const latest = item.latest as { price: number; unit: string; changePct: number; price_date: string };
      sent += notify({
        module: 'khuyennong', severity: 'warn', title: `Giá ${String(item.commodity)} biến động ${latest.changePct}%`,
        body: `${Number(latest.price).toLocaleString('vi-VN')} ${latest.unit} (${latest.price_date}) — vượt ngưỡng ${String(item.threshold_pct)}% bạn đã đặt.`,
        link: '/kn/#kn-prices', userIds: [user_id], dedupeKey: `kn.price.watch.${user_id}.${String(item.commodity)}.${latest.price_date}`,
      }, actor);
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// US-DASH-02 — báo cáo tổng hợp (dòng để xuất CSV / in)
// ---------------------------------------------------------------------------

export function summaryReportRows(user: User | null): { rows: Record<string, unknown>[]; provisional: boolean; scope: string } {
  const scope = scopeOf(user);
  const f = htxFilter(scope);
  const rows = all(
    `SELECT a.name AS tinh, c.code AS ma_htx, c.name AS ten_htx, c.registered_area_ha AS dien_tich_dang_ky_ha,
            (SELECT COALESCE(SUM(p.area_ha), 0) FROM plots p WHERE p.htx_id = c.id AND p.deleted_at IS NULL) AS dien_tich_da_ve_ha,
            (SELECT COUNT(*) FROM plots p WHERE p.htx_id = c.id AND p.deleted_at IS NULL) AS so_thua,
            (SELECT COUNT(*) FROM farmers fm WHERE fm.htx_id = c.id AND fm.status = 'active') AS so_ho,
            (SELECT COUNT(*) FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id WHERE p.htx_id = c.id AND cc.status = 'dang_canh_tac') AS vu_dang_canh_tac,
            (SELECT COALESCE(SUM(hd.paddy_tons), 0) FROM harvest_declarations hd JOIN crop_cycles cc ON cc.id = hd.crop_cycle_id JOIN plots p ON p.id = cc.plot_id WHERE p.htx_id = c.id) AS san_luong_lua_tan,
            (SELECT COUNT(*) FROM farm_logs fl JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id WHERE p.htx_id = c.id AND fl.activity = 'rut_nuoc_awd') AS luot_awd,
            (SELECT COUNT(*) FROM support_tasks t WHERE t.htx_id = c.id AND t.status NOT IN ('dong','hoan_thanh')) AS nhiem_vu_mo
     FROM cooperatives c LEFT JOIN admin_units a ON a.id = c.province_id
     WHERE c.status = 'active' AND ${f.clause} ORDER BY a.name, c.name`, f.params);
  // "Số liệu tạm tính" khi còn nhật ký chờ duyệt trong phạm vi (US-DASH-02 AC-1).
  const pending = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM farm_logs fl JOIN crop_cycles cc ON cc.id = fl.crop_cycle_id JOIN plots p ON p.id = cc.plot_id JOIN cooperatives c ON c.id = p.htx_id
     WHERE fl.approval_status = 'cho_duyet' AND ${f.clause}`, f.params);
  return { rows, provisional: (pending?.n ?? 0) > 0, scope: scope.label };
}
