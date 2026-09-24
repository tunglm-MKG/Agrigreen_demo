/**
 * App Khuyến nông — BRD v5.0.
 *
 * FN-03 cây cấu trúc phân cấp 3 cấp · FN-04 quản lý HTX & nông hộ
 * FN-05 vẽ ranh giới thửa ruộng · FN-07 liên thông App HTX
 * FN-09 bản đồ khuyến nông · FN-10/FN-11 thư viện kỹ thuật & tin tức
 * FN-12 đào tạo ToT · FN-13 dashboard & báo cáo · FN-14 nhiệm vụ hỗ trợ
 * FN-15 danh bạ trực · FN-16/FN-17 giá cả thị trường
 */
import { all, insert, one, run, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { runSync, registerRetryHandler } from '../../platform/sync/sync.ts';

// ---------------------------------------------------------------------------
// FN-03 — Cây cấu trúc phân cấp dữ liệu tổ chức khuyến nông (3 cấp)
// ---------------------------------------------------------------------------

export const ORG_LEVELS = ['trung_uong', 'tinh', 'xa'] as const;
export type OrgLevel = (typeof ORG_LEVELS)[number];

export function createOrgNode(
  input: { code: string; name: string; level: OrgLevel; parentId?: string; adminUnitId?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  if (input.level !== 'trung_uong' && !input.parentId) {
    throw new Error('Đơn vị cấp tỉnh/xã phải thuộc một đơn vị cấp trên.');
  }
  const record = {
    id: uuid(),
    code: input.code,
    name: input.name,
    level: input.level,
    parent_id: input.parentId ?? null,
    admin_unit_id: input.adminUnitId ?? null,
    created_at: nowIso(),
  };
  insert('org_nodes', record);
  logEvent({ module: 'khuyennong', entityType: 'org_nodes', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function orgTree(): Record<string, unknown>[] {
  const nodes = all<{ id: string; code: string; name: string; level: string; parent_id: string | null }>(
    'SELECT id, code, name, level, parent_id FROM org_nodes ORDER BY level, name',
  );
  const byParent = new Map<string | null, typeof nodes>();
  for (const node of nodes) {
    const list = byParent.get(node.parent_id) ?? [];
    list.push(node);
    byParent.set(node.parent_id, list);
  }
  const build = (parentId: string | null): Record<string, unknown>[] =>
    (byParent.get(parentId) ?? []).map((node) => ({ ...node, children: build(node.id) }));
  return build(null);
}

/** Danh sách id của một nút và toàn bộ nút con — dùng để giới hạn phạm vi quản lý. */
export function orgScope(nodeId: string): string[] {
  const result = [nodeId];
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    const children = all<{ id: string }>('SELECT id FROM org_nodes WHERE parent_id = ?', [current]);
    for (const child of children) {
      result.push(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// FN-10 / FN-11 — Thư viện kỹ thuật & tin tức (Master Data dùng chung 3 cấp)
// ---------------------------------------------------------------------------

export function createArticle(
  input: { title: string; kind: 'quy_trinh' | 'tai_lieu' | 'tin_tuc'; summary?: string; body?: string; crop?: string; scopeNodeId?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM knowledge_articles');
  const record = {
    id: uuid(),
    code: sequenceCode('KB', (count?.n ?? 0) + 1, 5),
    title: input.title,
    kind: input.kind,
    summary: input.summary ?? null,
    body: input.body ?? null,
    crop: input.crop ?? null,
    status: 'draft',
    scope_node_id: input.scopeNodeId ?? null,
    published_at: null,
    author_id: actor.id ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('knowledge_articles', record);
  logEvent({ module: 'khuyennong', entityType: 'knowledge_articles', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function publishArticle(id: string, actor: AuditActor = {}): Record<string, unknown> {
  const before = one('SELECT * FROM knowledge_articles WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy nội dung');
  update('knowledge_articles', id, { status: 'published', published_at: nowIso(), updated_at: nowIso() });
  const after = one('SELECT * FROM knowledge_articles WHERE id = ?', [id])!;
  logEvent({ module: 'khuyennong', entityType: 'knowledge_articles', entityId: id, action: 'approve', before, after }, actor);
  return after;
}

export function listArticles(filter: { kind?: string; status?: string; scopeNodeId?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.scopeNodeId) {
    const scope = orgScope(filter.scopeNodeId);
    clauses.push(`(scope_node_id IS NULL OR scope_node_id IN (${scope.map(() => '?').join(',')}))`);
    params.push(...scope);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT * FROM knowledge_articles ${where} ORDER BY COALESCE(published_at, created_at) DESC`, params);
}

// ---------------------------------------------------------------------------
// FN-14 — Nhiệm vụ hỗ trợ (tự sinh từ App HTX, cán bộ xã tiếp nhận/xử lý)
// ---------------------------------------------------------------------------

export const TASK_FLOW = ['moi', 'tiep_nhan', 'dang_xu_ly', 'hoan_thanh', 'dong'] as const;

export function listTasks(filter: { status?: string; assigneeId?: string; htxId?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    clauses.push('t.status = ?');
    params.push(filter.status);
  }
  if (filter.assigneeId) {
    clauses.push('t.assignee_id = ?');
    params.push(filter.assigneeId);
  }
  if (filter.htxId) {
    clauses.push('t.htx_id = ?');
    params.push(filter.htxId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT t.*, c.code AS htx_code, c.name AS htx_name FROM support_tasks t
     LEFT JOIN cooperatives c ON c.id = t.htx_id ${where} ORDER BY t.created_at DESC`,
    params,
  );
}

export function advanceTask(
  id: string,
  next: (typeof TASK_FLOW)[number],
  input: { assigneeId?: string; resolution?: string } = {},
  actor: AuditActor = {},
): Record<string, unknown> {
  const before = one<{ status: string }>('SELECT * FROM support_tasks WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy nhiệm vụ');
  const currentIndex = TASK_FLOW.indexOf(before.status as never);
  const nextIndex = TASK_FLOW.indexOf(next);
  if (nextIndex < currentIndex) throw new Error('Không thể lùi trạng thái nhiệm vụ.');

  const values: Record<string, unknown> = { status: next, updated_at: nowIso() };
  if (input.assigneeId) values.assignee_id = input.assigneeId;
  if (next === 'hoan_thanh' || next === 'dong') {
    values.resolved_at = nowIso();
    values.resolution = input.resolution ?? null;
  }
  update('support_tasks', id, values);
  const after = one('SELECT * FROM support_tasks WHERE id = ?', [id])!;
  logEvent({ module: 'khuyennong', entityType: 'support_tasks', entityId: id, action: 'update', before, after }, actor);
  return after;
}

/** Chỉ đạo / cảnh báo khẩn theo vùng — cấp trên gửi xuống toàn bộ nút con. */
export function broadcastDirective(
  input: { orgNodeId: string; title: string; description: string; priority?: string },
  actor: AuditActor = {},
): { created: number } {
  const scope = orgScope(input.orgNodeId);
  const cooperatives = all<{ id: string }>(
    `SELECT c.id FROM cooperatives c
     JOIN admin_units a ON a.id = c.province_id
     JOIN org_nodes o ON o.admin_unit_id = a.id
     WHERE o.id IN (${scope.map(() => '?').join(',')})`,
    scope,
  );
  let created = 0;
  for (const htx of cooperatives) {
    const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM support_tasks');
    insert('support_tasks', {
      id: uuid(),
      code: sequenceCode('CD', (count?.n ?? 0) + 1, 5),
      htx_id: htx.id,
      farmer_id: null,
      plot_id: null,
      title: input.title,
      description: input.description,
      category: 'khac',
      priority: input.priority ?? 'khan',
      status: 'moi',
      assignee_id: null,
      origin: 'chi_dao',
      created_at: nowIso(),
      updated_at: nowIso(),
      resolved_at: null,
      resolution: null,
    });
    created += 1;
  }
  logEvent({ module: 'khuyennong', entityType: 'support_tasks', action: 'create', after: { broadcast: input.title, created } }, actor);
  return { created };
}

// ---------------------------------------------------------------------------
// FN-15 — Danh bạ trực hỗ trợ
// ---------------------------------------------------------------------------

export function upsertOfficer(
  input: { id?: string; fullName: string; phone: string; orgNodeId: string; specialty?: string; onDuty?: boolean; userId?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const record = {
    id: input.id ?? uuid(),
    user_id: input.userId ?? null,
    full_name: input.fullName,
    phone: input.phone,
    org_node_id: input.orgNodeId,
    specialty: input.specialty ?? null,
    on_duty: input.onDuty === false ? 0 : 1,
  };
  if (input.id) update('extension_officers', input.id, record);
  else insert('extension_officers', record);
  logEvent({ module: 'khuyennong', entityType: 'extension_officers', entityId: record.id, action: input.id ? 'update' : 'create', after: record }, actor);
  return record;
}

export function directory(orgNodeId?: string): Record<string, unknown>[] {
  if (!orgNodeId) {
    return all(
      'SELECT e.*, o.name AS org_name, o.level FROM extension_officers e JOIN org_nodes o ON o.id = e.org_node_id ORDER BY o.level, e.full_name',
    );
  }
  const scope = orgScope(orgNodeId);
  return all(
    `SELECT e.*, o.name AS org_name, o.level FROM extension_officers e JOIN org_nodes o ON o.id = e.org_node_id
     WHERE e.org_node_id IN (${scope.map(() => '?').join(',')}) ORDER BY o.level, e.full_name`,
    scope,
  );
}

// ---------------------------------------------------------------------------
// FN-16 / FN-17 — Giá cả thị trường
// ---------------------------------------------------------------------------

export function upsertMarketPrice(
  input: { commodity: string; price: number; priceDate: string; region?: string; unit?: string; source?: string },
  actor: AuditActor = {},
): void {
  const existing = one<{ id: string }>(
    'SELECT id FROM market_prices WHERE commodity = ? AND price_date = ? AND COALESCE(region, \'\') = ?',
    [input.commodity, input.priceDate, input.region ?? ''],
  );
  const record = {
    id: existing?.id ?? uuid(),
    commodity: input.commodity,
    unit: input.unit ?? 'VNĐ/kg',
    price: input.price,
    price_date: input.priceDate,
    region: input.region ?? null,
    source: input.source ?? 'import',
  };
  if (existing) update('market_prices', existing.id, record);
  else insert('market_prices', record);
  logEvent({ module: 'khuyennong', entityType: 'market_prices', entityId: record.id, action: existing ? 'update' : 'create', after: record }, actor);
}

/** Bảng giá kèm biến động so với lần công bố trước. */
/** Xoá một bản ghi giá (dọn dữ liệu nhập sai) — chỉ cấp công bố; có nhật ký. */
export function deleteMarketPrice(id: string, actor: AuditActor = {}): void {
  const before = one<Record<string, unknown>>('SELECT * FROM market_prices WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy bản ghi giá.');
  run('DELETE FROM market_prices WHERE id = ?', [id]);
  logEvent({ module: 'khuyennong', entityType: 'market_prices', entityId: id, action: 'delete', before }, actor);
}

export function priceBoard(commodity?: string): Record<string, unknown>[] {
  const rows = all<{ commodity: string; unit: string; price: number; price_date: string; region: string | null; source: string }>(
    `SELECT * FROM market_prices ${commodity ? 'WHERE commodity = ?' : ''} ORDER BY commodity, region, price_date DESC`,
    commodity ? [commodity] : [],
  );
  const seen = new Map<string, { price: number; date: string }>();
  const result: Record<string, unknown>[] = [];
  for (const row of rows) {
    const key = `${row.commodity}|${row.region ?? ''}`;
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, { price: row.price, date: row.price_date });
      const older = rows.find(
        (r) => r.commodity === row.commodity && (r.region ?? '') === (row.region ?? '') && r.price_date < row.price_date,
      );
      const change = older ? row.price - older.price : 0;
      result.push({
        ...row,
        previousPrice: older?.price ?? null,
        change,
        changePct: older && older.price > 0 ? Math.round((change / older.price) * 1000) / 10 : null,
        trend: change > 0 ? 'tang' : change < 0 ? 'giam' : 'on_dinh',
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// FN-12 — Quản trị đào tạo ToT
// ---------------------------------------------------------------------------

export function createCourse(
  input: { title: string; startDate?: string; endDate?: string; location?: string; orgNodeId?: string; capacity?: number },
  actor: AuditActor = {},
): Record<string, unknown> {
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM training_courses');
  const record = {
    id: uuid(),
    code: sequenceCode('DT', (count?.n ?? 0) + 1, 4),
    title: input.title,
    start_date: input.startDate ?? null,
    end_date: input.endDate ?? null,
    location: input.location ?? null,
    org_node_id: input.orgNodeId ?? null,
    capacity: input.capacity ?? 0,
    status: 'planned',
  };
  insert('training_courses', record);
  logEvent({ module: 'khuyennong', entityType: 'training_courses', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function enrol(courseId: string, trainee: { name: string; htxId?: string; phone?: string }): Record<string, unknown> {
  const course = one<{ capacity: number }>('SELECT capacity FROM training_courses WHERE id = ?', [courseId]);
  if (!course) throw new Error('Không tìm thấy khoá đào tạo');
  const registered = one<{ n: number }>('SELECT COUNT(*) AS n FROM training_enrollments WHERE course_id = ?', [courseId]);
  if (course.capacity > 0 && (registered?.n ?? 0) >= course.capacity) {
    throw new Error('Khoá đào tạo đã đủ số lượng học viên.');
  }
  const record = {
    id: uuid(),
    course_id: courseId,
    trainee_name: trainee.name,
    htx_id: trainee.htxId ?? null,
    phone: trainee.phone ?? null,
    status: 'registered',
  };
  insert('training_enrollments', record);
  return record;
}

export function listCourses(): Record<string, unknown>[] {
  return all(
    `SELECT tc.*, (SELECT COUNT(*) FROM training_enrollments te WHERE te.course_id = tc.id) AS enrolled
     FROM training_courses tc ORDER BY COALESCE(tc.start_date, '9999') DESC`,
  );
}

// ---------------------------------------------------------------------------
// FN-09 — Bản đồ mạng lưới khuyến nông 3 cấp
// ---------------------------------------------------------------------------

export function networkMap(): Record<string, unknown> {
  return {
    tree: orgTree(),
    officers: directory(),
    cooperatives: all(
      "SELECT id, code, name, lat, lng, province_id, member_count FROM cooperatives WHERE status = 'active' AND lat IS NOT NULL",
    ),
  };
}

// ---------------------------------------------------------------------------
// FN-13 — Dashboard & báo cáo định kỳ
// ---------------------------------------------------------------------------

export function dashboard(): Record<string, unknown> {
  const tasks = all('SELECT status, COUNT(*) AS n FROM support_tasks GROUP BY status');
  const articles = all('SELECT kind, status, COUNT(*) AS n FROM knowledge_articles GROUP BY kind, status');
  const coverage = all(
    `SELECT o.level, COUNT(DISTINCT e.id) AS officers FROM org_nodes o
     LEFT JOIN extension_officers e ON e.org_node_id = o.id GROUP BY o.level`,
  );
  const plotProgress = all(
    'SELECT status, COUNT(*) AS n, COALESCE(SUM(area_ha), 0) AS area_ha FROM plots GROUP BY status',
  );
  const overdue = all(
    `SELECT code, title, htx_id, created_at FROM support_tasks
     WHERE status IN ('moi','tiep_nhan') AND created_at < ? ORDER BY created_at LIMIT 20`,
    [new Date(Date.now() - 3 * 86_400_000).toISOString()],
  );
  return { tasks, articles, coverage, plotProgress, overdueTasks: overdue, prices: priceBoard() };
}

// ---------------------------------------------------------------------------
// FN-07 — Liên thông dữ liệu App HTX (2 chiều)
// ---------------------------------------------------------------------------

function appHtxContentPayload(actor: AuditActor = {}) {
  const payload = {
    articles: listArticles({ status: 'published' }),
    directory: directory(),
    prices: priceBoard(),
  };
  logEvent({ module: 'khuyennong', entityType: 'app_htx_push', action: 'sync', after: { articles: payload.articles.length } }, actor);
  return { recordCount: payload.articles.length + payload.directory.length + payload.prices.length, result: payload };
}
export function pushToAppHtx(actor: AuditActor = {}) {
  return runSync({ system: 'app_htx', direction: 'outbound', dataset: 'khuyennong_content' }, () => appHtxContentPayload(actor));
}
// Retry tự động (O02): chạy lại cùng dataset khi bản ghi thất bại đến hạn.
registerRetryHandler('khuyennong_content', () => appHtxContentPayload({ name: 'retry' }));
