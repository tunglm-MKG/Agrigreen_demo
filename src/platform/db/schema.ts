/**
 * Lược đồ cơ sở dữ liệu hợp nhất cho toàn hệ sinh thái.
 *
 * Nguyên tắc thiết kế (AgriGreen ERP Product Vision v1.2, mục 3.2):
 *  - Một Master Data, nhiều phân hệ dùng chung: danh mục HTX / vùng trồng /
 *    thiết bị / Hub / kho / nhà máy / đối tác nằm ở bảng dùng chung, không
 *    phân hệ nào giữ bản sao riêng.
 *  - Multi-site & multi-entity từ ngày đầu: Hub / Kho / Nhà máy đều là danh mục
 *    mở rộng được, không hard-code một dòng.
 *  - Mọi phân hệ đều audit-trail: bảng `event_log` append-only là nguồn sự thật.
 */
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { all, db, MONEY_COLUMNS } from './db.ts';
import { encryptPiiAtRest } from '../security/fieldCrypto.ts';
import { qualifyStatement, splitStatements, schemaOf, domainOf } from './domains.ts';

/**
 * Lược đồ hợp nhất được viết một lần; lúc chạy, từng câu CREATE được gắn tiền tố
 * miền (`kn.`, `erp.`, …) theo `domains.ts` để bảng rơi đúng tệp của hệ thống con.
 * FOREIGN KEY xuyên miền bị gỡ vì SQLite không cho khoá ngoại trỏ sang tệp khác.
 */
export function migrate(): void {
  const handle = db();
  const statements = splitStatements(SCHEMA);
  for (const statement of statements) handle.exec(qualifyStatement(statement));
  applyColumnMigrations();
  // Di trú dữ liệu TRƯỚC khi dựng lại bảng (cột evidence_json sẽ không còn trong định nghĩa mới).
  migrateStageEvidence();
  migrateCoverageThresholds();
  const { rebuilt, skipped } = reconcileTables();
  if (rebuilt.length) {
    console.log(`[db] đã dựng lại ${rebuilt.length} bảng theo lược đồ mới: ${rebuilt.join(', ')}`);
    // Dựng lại bảng làm mất chỉ mục tường minh → tạo lại toàn bộ (IF NOT EXISTS, rẻ).
    for (const statement of statements) if (/^CREATE (UNIQUE )?INDEX/i.test(statement)) handle.exec(qualifyStatement(statement));
  }
  for (const item of skipped) console.warn(`[db] KHÔNG dựng lại được bảng ${item.table}: ${item.reason} — dữ liệu hiện có vi phạm ràng buộc mới, cần sửa tay.`);
  applyPerformanceIndexes();
  normalizeMoneyColumns();
  const encrypted = encryptPiiAtRest();
  if (encrypted) console.log(`[db] đã mã hoá ${encrypted} số CCCD còn lưu rõ.`);
  normalizeAttachmentPaths();
  recordSchemaVersion(rebuilt.length, skipped.length);
}

// ---------------------------------------------------------------------------
// Phiên bản lược đồ (A07)
// ---------------------------------------------------------------------------
export const SCHEMA_VERSION = '2026.09.24-d';
export function schemaChecksum(): string {
  return createHash('sha256').update(SCHEMA).update(JSON.stringify(COLUMN_ADDITIONS)).update(JSON.stringify(PERFORMANCE_INDEXES)).digest('hex');
}
function recordSchemaVersion(rebuiltTables: number, skippedTables: number): void {
  const checksum = schemaChecksum();
  const exists = db().prepare('SELECT id FROM schema_migrations WHERE checksum = ?').get(checksum);
  if (exists) return;
  db().prepare('INSERT INTO schema_migrations (version, checksum, applied_at, rebuilt_tables, skipped_tables, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(SCHEMA_VERSION, checksum, new Date().toISOString(), rebuiltTables, skippedTables, skippedTables ? 'Có bảng không dựng lại được — xem log khởi động' : null);
}
/** Trạng thái lược đồ trên tệp: phiên bản/băm đã áp gần nhất và băm hiện tại của mã — khác nhau nghĩa là khởi động lại chưa chạy migrate. */
export function schemaStatus(): { version: string; checksum: string; applied: Record<string, unknown> | null; upToDate: boolean; history: number } {
  const checksum = schemaChecksum();
  const applied = db().prepare('SELECT version, checksum, applied_at, rebuilt_tables, skipped_tables, notes FROM schema_migrations ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  const history = (db().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
  return { version: SCHEMA_VERSION, checksum, applied: applied ?? null, upToDate: applied?.checksum === checksum, history };
}

/** attachments.storage_path từng lưu đường dẫn tuyệt đối của máy chạy → chuyển thành khoá tương đối (O03). */
function normalizeAttachmentPaths(): void {
  const rows = db().prepare("SELECT id, storage_path FROM attachments WHERE storage_path LIKE '%/%' OR storage_path LIKE '%\\%'").all() as { id: string; storage_path: string }[];
  for (const row of rows) db().prepare('UPDATE attachments SET storage_path = ? WHERE id = ?').run(basename(row.storage_path), row.id);
}

// ---------------------------------------------------------------------------
// Dựng lại bảng khi định nghĩa trong SCHEMA khác với định nghĩa đang lưu trong tệp
// (SQLite không có ALTER TABLE ADD CONSTRAINT / ALTER COLUMN). Quy trình 12 bước của
// SQLite: tắt khoá ngoại → tạo bảng mới → chép cột chung → xoá bảng cũ → đổi tên.
// Bảng nào dữ liệu cũ vi phạm ràng buộc mới thì bỏ qua và cảnh báo, không làm hỏng khởi động.
// ---------------------------------------------------------------------------

/** Chuẩn hoá văn bản CREATE TABLE để so sánh (bỏ IF NOT EXISTS, tên schema, dấu nháy, khoảng trắng, chữ hoa). */
export function normalizeTableSql(sql: string): string {
  return sql
    .replace(/^\s*CREATE TABLE IF NOT EXISTS\s+/i, 'CREATE TABLE ')
    .replace(/^CREATE TABLE\s+(\w+)\./i, 'CREATE TABLE ')
    .replace(/"(\w+)"/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .replace(/;\s*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Định nghĩa mong muốn của một bảng = câu CREATE trong SCHEMA + các cột thêm bằng ALTER
 * (applyColumnMigrations) chèn đúng chỗ SQLite chèn: sau cột cuối, trước ràng buộc bảng.
 */
export function desiredTableSql(statement: string): string {
  const table = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)![1];
  let sql = qualifyStatement(statement);
  const declared = new Set(columnNamesOf(sql));
  const extras = COLUMN_ADDITIONS.filter((a) => a.table === table && !declared.has(a.column)).map((a) => `${a.column} ${a.definition}`);
  if (!extras.length) return sql;
  const constraintAt = sql.search(/\n\s*(FOREIGN KEY|PRIMARY KEY\s*\(|UNIQUE\s*\(|CHECK\s*\(|CONSTRAINT\b)/);
  if (constraintAt >= 0) {
    sql = sql.slice(0, constraintAt) + ' ' + extras.map((e) => `${e},`).join(' ') + sql.slice(constraintAt);
  } else {
    sql = sql.replace(/\s*\)\s*$/, `, ${extras.join(', ')})`);
  }
  return sql;
}

/** Tên cột theo thứ tự trong một câu CREATE TABLE (phân tích văn bản, đủ cho lược đồ của dự án). */
function columnNamesOf(createSql: string): string[] {
  const open = createSql.indexOf('(');
  const body = createSql.slice(open + 1, createSql.lastIndexOf(')'));
  const names: string[] = [];
  let depth = 0; let current = '';
  const parts: string[] = [];
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  for (const part of parts) {
    const m = /^\s*(\w+)\s/.exec(part);
    if (!m) continue;
    if (/^(FOREIGN|PRIMARY|UNIQUE|CHECK|CONSTRAINT)$/i.test(m[1])) continue;
    names.push(m[1]);
  }
  return names;
}

export function reconcileTables(): { rebuilt: string[]; skipped: { table: string; reason: string }[] } {
  const handle = db();
  const rebuilt: string[] = [];
  const skipped: { table: string; reason: string }[] = [];
  const pending: { table: string; schema: string; create: string }[] = [];
  for (const statement of splitStatements(SCHEMA)) {
    const m = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement);
    if (!m) continue;
    const table = m[1];
    const schema = schemaOf(domainOf(table));
    const stored = handle.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined;
    if (!stored) continue;
    const desired = desiredTableSql(statement);
    if (normalizeTableSql(stored.sql) === normalizeTableSql(desired)) continue;
    pending.push({ table, schema, create: desired });
  }
  if (!pending.length) return { rebuilt, skipped };
  handle.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const item of pending) {
      const temp = `__new_${item.table}`;
      const createTemp = item.create.replace(/^CREATE TABLE IF NOT EXISTS (\w+)\.(\w+)/, `CREATE TABLE ${item.schema}.${temp}`);
      handle.exec('BEGIN');
      try {
        handle.exec(`DROP TABLE IF EXISTS ${item.schema}.${temp}`);
        handle.exec(createTemp);
        const oldColumns = (handle.prepare(`PRAGMA ${item.schema}.table_info(${item.table})`).all() as { name: string }[]).map((c) => c.name);
        const newColumns = new Set((handle.prepare(`PRAGMA ${item.schema}.table_info(${temp})`).all() as { name: string }[]).map((c) => c.name));
        const common = oldColumns.filter((c) => newColumns.has(c)).join(', ');
        handle.exec(`INSERT INTO ${item.schema}.${temp} (${common}) SELECT ${common} FROM ${item.schema}.${item.table}`);
        handle.exec(`DROP TABLE ${item.schema}.${item.table}`);
        handle.exec(`ALTER TABLE ${item.schema}.${temp} RENAME TO ${item.table}`);
        handle.exec('COMMIT');
        rebuilt.push(item.table);
      } catch (error) {
        handle.exec('ROLLBACK');
        skipped.push({ table: item.table, reason: (error as Error).message });
      }
    }
  } finally {
    handle.exec('PRAGMA foreign_keys = ON');
  }
  return { rebuilt, skipped };
}

// ---------------------------------------------------------------------------
// Di trú dữ liệu một lần (idempotent)
// ---------------------------------------------------------------------------

/** evidence_json (mảng JSON trong field_job_stages) → bảng field_stage_evidence, mỗi mục một dòng. */
function migrateStageEvidence(): number {
  const columns = all<{ name: string }>('PRAGMA field.table_info(field_job_stages)');
  if (!columns.some((c) => c.name === 'evidence_json')) return 0;
  const rows = all<{ id: string; evidence_json: string; recorded_by: string | null; completed_at: string | null }>(
    "SELECT id, evidence_json, recorded_by, completed_at FROM field_job_stages WHERE evidence_json IS NOT NULL AND evidence_json NOT IN ('', '[]')");
  let moved = 0;
  for (const row of rows) {
    let items: { kind?: string; url?: string; note?: string }[] = [];
    try { items = JSON.parse(row.evidence_json); } catch { items = []; }
    for (const item of items) {
      if (!item || !item.kind) continue;
      db().prepare('INSERT INTO field_stage_evidence (id, stage_id, kind, url, note, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), row.id, String(item.kind), item.url ?? null, item.note ?? null, row.completed_at ?? new Date().toISOString(), row.recorded_by);
      moved += 1;
    }
    db().prepare('UPDATE field_job_stages SET evidence_json = NULL WHERE id = ?').run(row.id);
  }
  return moved;
}

/** system_config['cgh.coverage_thresholds'] (mảng JSON) → bảng cgh_coverage_thresholds. */
function migrateCoverageThresholds(): number {
  const row = db().prepare("SELECT value_json FROM system_config WHERE key = 'cgh.coverage_thresholds'").get() as { value_json: string } | undefined;
  if (!row) return 0;
  let versions: { du: number; canChuY: number; thua: number; effectiveFrom: string; documentRef?: string }[] = [];
  try { versions = JSON.parse(row.value_json); } catch { versions = []; }
  let moved = 0;
  for (const v of versions) {
    if (!v?.effectiveFrom || !(v.canChuY < v.du && v.du < v.thua)) continue;
    db().prepare('INSERT OR IGNORE INTO cgh_coverage_thresholds (id, effective_from, can_chu_y, du, thua, document_ref, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), v.effectiveFrom, v.canChuY, v.du, v.thua, v.documentRef ?? null, new Date().toISOString(), 'migration');
    moved += 1;
  }
  db().prepare("DELETE FROM system_config WHERE key = 'cgh.coverage_thresholds'").run();
  return moved;
}

/** Tiền tệ lưu theo đồng (INTEGER). Dữ liệu cũ có phần lẻ → làm tròn một lần. */
function normalizeMoneyColumns(): void {
  for (const [table, columns] of Object.entries(MONEY_COLUMNS)) {
    for (const column of columns) {
      db().exec(`UPDATE ${table} SET ${column} = CAST(ROUND(${column}) AS INTEGER) WHERE ${column} IS NOT NULL AND ${column} != CAST(${column} AS INTEGER)`);
    }
  }
}

/**
 * Chỉ mục cho cột lọc/khoá ngoại nóng (rà soát CSDL 24/09/2026, nguyên tắc 8).
 * Chạy sau applyColumnMigrations vì vài chỉ mục dùng cột được thêm sau (deleted_at, approval_status).
 * Cột chưa tồn tại (CSDL rất cũ) → bỏ qua chỉ mục đó, không làm hỏng khởi động.
 */
export const PERFORMANCE_INDEXES: { name: string; table: string; columns: string[] }[] = [
  // dùng chung
  { name: 'idx_plots_htx', table: 'plots', columns: ['htx_id', 'deleted_at'] },
  { name: 'idx_plots_farmer', table: 'plots', columns: ['farmer_id'] },
  { name: 'idx_farmers_htx', table: 'farmers', columns: ['htx_id', 'status'] },
  { name: 'idx_farmers_phone', table: 'farmers', columns: ['phone'] },
  { name: 'idx_users_phone', table: 'users', columns: ['phone'] },
  { name: 'idx_users_htx', table: 'users', columns: ['htx_id'] },
  { name: 'idx_users_org', table: 'users', columns: ['org_node_id'] },
  { name: 'idx_sessions_user', table: 'sessions', columns: ['user_id', 'expires_at'] },
  { name: 'idx_event_log_actor', table: 'event_log', columns: ['actor_id'] },
  { name: 'idx_event_log_module_time', table: 'event_log', columns: ['module', 'occurred_at'] },
  { name: 'idx_notifications_recipient', table: 'notifications', columns: ['recipient_user_id', 'read_at'] },
  { name: 'idx_notifications_outbox', table: 'notifications', columns: ['status', 'channel'] },
  { name: 'idx_machines_htx', table: 'machines', columns: ['htx_id'] },
  { name: 'idx_machines_type', table: 'machines', columns: ['machine_type_id'] },
  { name: 'idx_machines_owner', table: 'machines', columns: ['owner_id'] },
  { name: 'idx_machines_serial', table: 'machines', columns: ['serial_number'] },
  { name: 'idx_machine_owners_htx', table: 'machine_owners', columns: ['htx_id'] },
  { name: 'idx_cooperatives_province', table: 'cooperatives', columns: ['province_id', 'status'] },
  { name: 'idx_cooperatives_commune', table: 'cooperatives', columns: ['commune_id'] },
  { name: 'idx_facilities_province', table: 'facilities', columns: ['province_id'] },
  { name: 'idx_admin_units_parent', table: 'admin_units', columns: ['parent_id', 'level'] },
  { name: 'idx_attachments_entity', table: 'attachments', columns: ['entity_type', 'entity_id'] },
  { name: 'idx_weighings_facility', table: 'weighings', columns: ['facility_id'] },
  { name: 'idx_gps_logs_user', table: 'gps_logs', columns: ['user_id'] },
  { name: 'idx_crop_status_htx', table: 'crop_status', columns: ['htx_id', 'season_id'] },
  { name: 'idx_org_nodes_parent', table: 'org_nodes', columns: ['parent_id'] },
  { name: 'idx_extension_officers_org', table: 'extension_officers', columns: ['org_node_id', 'on_duty'] },
  // HTX
  { name: 'idx_crop_cycles_plot', table: 'crop_cycles', columns: ['plot_id', 'status'] },
  { name: 'idx_crop_cycles_season', table: 'crop_cycles', columns: ['season_id'] },
  { name: 'idx_farm_logs_cycle', table: 'farm_logs', columns: ['crop_cycle_id', 'log_date'] },
  { name: 'idx_farm_logs_approval', table: 'farm_logs', columns: ['approval_status'] },
  { name: 'idx_harvest_cycle', table: 'harvest_declarations', columns: ['crop_cycle_id'] },
  { name: 'idx_production_plans_cycle', table: 'production_plans', columns: ['crop_cycle_id'] },
  { name: 'idx_plan_steps_plan', table: 'production_plan_steps', columns: ['plan_id', 'status'] },
  { name: 'idx_step_assignments_step', table: 'plan_step_assignments', columns: ['plan_step_id'] },
  { name: 'idx_step_assignments_farmer', table: 'plan_step_assignments', columns: ['farmer_id'] },
  { name: 'idx_input_stock_htx', table: 'input_stock', columns: ['htx_id', 'item_id'] },
  { name: 'idx_input_purchases_htx', table: 'input_purchases', columns: ['htx_id'] },
  { name: 'idx_input_purchase_lines_purchase', table: 'input_purchase_lines', columns: ['purchase_id'] },
  { name: 'idx_input_issues_htx', table: 'input_issues', columns: ['htx_id'] },
  { name: 'idx_input_issues_cycle', table: 'input_issues', columns: ['crop_cycle_id'] },
  { name: 'idx_input_issues_plot', table: 'input_issues', columns: ['plot_id'] },
  { name: 'idx_protocol_steps_protocol', table: 'protocol_steps', columns: ['protocol_id'] },
  // Khuyến nông
  { name: 'idx_support_tasks_htx', table: 'support_tasks', columns: ['htx_id', 'status'] },
  { name: 'idx_support_tasks_assignee', table: 'support_tasks', columns: ['assignee_id'] },
  { name: 'idx_articles_status', table: 'knowledge_articles', columns: ['status', 'category'] },
  { name: 'idx_articles_scope', table: 'knowledge_articles', columns: ['scope_node_id'] },
  { name: 'idx_market_prices_commodity', table: 'market_prices', columns: ['commodity', 'price_date'] },
  { name: 'idx_enrollments_course', table: 'training_enrollments', columns: ['course_id'] },
  { name: 'idx_survey_responses_template', table: 'survey_responses', columns: ['template_id'] },
  { name: 'idx_survey_answers_response', table: 'survey_answers', columns: ['response_id'] },
  { name: 'idx_price_watchlist_user', table: 'price_watchlist', columns: ['user_id'] },
  { name: 'idx_machinery_decl_htx', table: 'htx_machinery_declarations', columns: ['htx_id'] },
  // Cơ giới hoá
  { name: 'idx_cultivation_plans_htx', table: 'cultivation_plans', columns: ['htx_id', 'season_id'] },
  { name: 'idx_norms_type', table: 'productivity_norms', columns: ['machine_type_id', 'effective_from'] },
  { name: 'idx_rental_listings_machine', table: 'rental_listings', columns: ['machine_id'] },
  { name: 'idx_rental_orders_renter', table: 'rental_orders', columns: ['renter_htx_id'] },
  { name: 'idx_rental_orders_listing', table: 'rental_orders', columns: ['listing_id'] },
  // ERP
  { name: 'idx_stock_lots_facility', table: 'stock_lots', columns: ['facility_id', 'status'] },
  { name: 'idx_stock_lots_htx', table: 'stock_lots', columns: ['htx_id'] },
  { name: 'idx_goods_receipts_facility', table: 'goods_receipts', columns: ['facility_id'] },
  { name: 'idx_goods_issues_facility', table: 'goods_issues', columns: ['facility_id', 'status'] },
  { name: 'idx_ledger_partner', table: 'ledger_entries', columns: ['partner_id'] },
  { name: 'idx_ledger_htx', table: 'ledger_entries', columns: ['htx_id'] },
  { name: 'idx_ledger_ref', table: 'ledger_entries', columns: ['ref_id'] },
  { name: 'idx_sales_orders_facility', table: 'sales_orders', columns: ['facility_id'] },
  { name: 'idx_purchase_orders_htx', table: 'purchase_orders', columns: ['htx_id'] },
  { name: 'idx_scenario_hubs_scenario', table: 'scenario_hubs', columns: ['scenario_id'] },
  { name: 'idx_simulation_results_scenario', table: 'simulation_results', columns: ['scenario_id'] },
  { name: 'idx_storage_zones_facility', table: 'storage_zones', columns: ['facility_id'] },
  { name: 'idx_straw_tickets_contract', table: 'straw_purchase_tickets', columns: ['contract_id'] },
  // Hiện trường
  { name: 'idx_field_jobs_htx', table: 'field_jobs', columns: ['htx_id'] },
  { name: 'idx_field_jobs_plot', table: 'field_jobs', columns: ['plot_id'] },
  { name: 'idx_field_job_stages_job', table: 'field_job_stages', columns: ['job_id'] },
  { name: 'idx_field_loadings_trip', table: 'field_loadings', columns: ['trip_id'] },
  { name: 'idx_field_team_members_team', table: 'field_team_members', columns: ['team_id'] },
  { name: 'idx_field_vehicles_team', table: 'field_vehicles', columns: ['team_id'] },
  // GIS
  { name: 'idx_transport_routes_province', table: 'transport_routes', columns: ['province_id'] },
  { name: 'idx_waterway_structures_route', table: 'waterway_structures', columns: ['route_id'] },
  { name: 'idx_weather_area', table: 'weather_observations', columns: ['area_id', 'observed_for'] },
  // Review 24/09/2026 (D05): theo EXPLAIN của truy vấn thật — thứ tự xuất kho, sổ cái theo kho/ngày, phiếu khảo sát theo kỳ.
  { name: 'idx_stock_lots_issue_order', table: 'stock_lots', columns: ['facility_id', 'status', 'risk_score DESC', 'received_at'] },
  { name: 'idx_ledger_facility_date', table: 'ledger_entries', columns: ['facility_id', 'entry_date'] },
  { name: 'idx_survey_responses_period', table: 'survey_responses', columns: ['template_id', 'period', 'subject_kind'] },
];

function applyPerformanceIndexes(): { created: number; skipped: string[] } {
  const handle = db();
  const skipped: string[] = [];
  let created = 0;
  for (const index of PERFORMANCE_INDEXES) {
    const schema = schemaOf(domainOf(index.table));
    const existing = new Set((handle.prepare(`PRAGMA ${schema}.table_info(${index.table})`).all() as { name: string }[]).map((c) => c.name));
    const missing = index.columns.map((c) => c.replace(/\s+(ASC|DESC)$/i, '')).filter((c) => !existing.has(c));
    if (!existing.size || missing.length) { skipped.push(`${index.name} (thiếu ${missing.join(', ') || 'bảng'})`); continue; }
    handle.exec(`CREATE INDEX IF NOT EXISTS ${schema}.${index.name} ON ${index.table}(${index.columns.join(', ')})`);
    created += 1;
  }
  if (skipped.length) console.warn(`[db] bỏ qua ${skipped.length} chỉ mục vì cột chưa tồn tại: ${skipped.slice(0, 5).join('; ')}`);
  return { created, skipped };
}

/**
 * Bổ sung cột cho bảng đã tồn tại.
 *
 * `CREATE TABLE IF NOT EXISTS` không thêm cột vào bảng cũ, nên các cột phát
 * sinh sau khi hệ thống đã chạy phải được thêm bằng ALTER TABLE có kiểm tra.
 */
/** Cột thêm bằng ALTER TABLE cho CSDL cũ. Cũng dùng để dựng "định nghĩa mong muốn" khi so khớp lược đồ (reconcileTables). */
export const COLUMN_ADDITIONS: { table: string; column: string; definition: string }[] = [
    // Kích cỡ sà lan dùng cho chặng Hub→Nhà máy ngoài mùa thu hoạch (1000/2000 tấn).
    { table: 'scenario_hubs', column: 'barge_payload_tons', definition: 'REAL' },
    // Nhật ký canh tác nay có thể là XÁC NHẬN một bước trong kế hoạch sản xuất.
    // Để trống nghĩa là hoạt động phát sinh ngoài kế hoạch — vẫn ghi nhận được.
    { table: 'farm_logs', column: 'plan_step_id', definition: 'TEXT' },
    // Truy vết nguồn gốc: quy trình được rút ra từ vụ canh tác nào.
    { table: 'production_protocols', column: 'source_crop_cycle_id', definition: 'TEXT' },
    // Tuyến đường thuỷ: tải trọng SUY RA từ thông số kỹ thuật, kèm mức tin cậy.
    // max_load_tons cũ là số nhập tay; hai cột này là kết quả hệ thống tính.
    { table: 'transport_routes', column: 'derived_max_load_tons', definition: 'REAL' },
    { table: 'transport_routes', column: 'derived_vessel_code', definition: 'TEXT' },
    { table: 'transport_routes', column: 'derived_certainty', definition: 'TEXT' },
    { table: 'transport_routes', column: 'derived_at', definition: 'TEXT' },
    // Định danh pháp lý HTX + mô hình vận hành + nguồn gốc hồ sơ.
    // UNIQUE không thêm được bằng ALTER nên ràng buộc trùng MST do service kiểm.
    { table: 'cooperatives', column: 'tax_code', definition: 'TEXT' },
    { table: 'cooperatives', column: 'operating_model', definition: "TEXT NOT NULL DEFAULT 'tap_trung'" },
    { table: 'cooperatives', column: 'origin', definition: "TEXT NOT NULL DEFAULT 'htx'" },
    { table: 'cooperatives', column: 'claimed_at', definition: 'TEXT' },
    // Zalo user id để gửi thông báo qua Zalo OA.
    { table: 'users', column: 'zalo_user_id', definition: 'TEXT' },
    // Tỉnh của tài khoản — phạm vi quản trị cấp tỉnh (SA-08) bám vào đây.
    { table: 'users', column: 'province_id', definition: 'TEXT' },
    // Rơm bán theo CUỘN, cân chỉ có ở nhà máy: lượt ghe mang cả số cuộn (đếm ở
    // ruộng) và số cân (ghi ở nhà máy); tấn lúc xuống ghe là ước tính.
    { table: 'field_loadings', column: 'tons_source', definition: "TEXT NOT NULL DEFAULT 'uoc_theo_cuon'" },
    { table: 'field_loadings', column: 'weighed_kg', definition: 'REAL' },
    { table: 'field_loadings', column: 'weighed_at', definition: 'TEXT' },
    { table: 'field_loadings', column: 'weighing_id', definition: 'TEXT' },
    { table: 'field_loadings', column: 'plant_bales', definition: 'INTEGER' },
    { table: 'field_loadings', column: 'variance_pct', definition: 'REAL' },
    // Chi phí chuyến là số NHẬP TAY hay tính theo đơn giá giả định? Đối chiếu
    // giả định – thực tế chỉ được dùng số nhập tay, nếu không sẽ tự khớp.
    { table: 'trips', column: 'actual_cost_source', definition: 'TEXT' },
    // Lượt ghe nối với thông báo hàng đến và phiếu nhập kho (đóng mắt hở B1).
    { table: 'field_loadings', column: 'inbound_notice_id', definition: 'TEXT' },
    { table: 'field_loadings', column: 'grn_id', definition: 'TEXT' },
    // Việc thu gom biết mình thuộc hợp đồng nào → ưu tiên và đơn giá phiếu mua.
    { table: 'field_jobs', column: 'contract_id', definition: 'TEXT' },
    { table: 'cooperatives', column: 'claimed_by', definition: 'TEXT' },

    // ---- Cập nhật theo BRD/User Story 09/2026 (GIS v1.5, KN v1.0, HTX v4.0, CGH v4.0) ----
    // Đăng nhập: khoá tạm sau 5 lần sai trong 15 phút (GIS BR-09, CGH US-ADM-01), lý do khoá
    // để kích hoạt lại HTX chỉ mở đúng tài khoản bị khoá vì HTX (HTX US-HTXSTATUS-02).
    { table: 'users', column: 'failed_attempts', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'users', column: 'locked_until', definition: 'TEXT' },
    { table: 'users', column: 'lock_reason', definition: 'TEXT' },
    { table: 'users', column: 'last_login_at', definition: 'TEXT' },
    // Nhật ký canh tác: duyệt (US-LOG-05), nhãn GPS (US-GPS-01), máy móc đã dùng (US-LOG-01 AC-2).
    { table: 'farm_logs', column: 'approval_status', definition: "TEXT NOT NULL DEFAULT 'cho_duyet'" },
    { table: 'farm_logs', column: 'approved_by', definition: 'TEXT' },
    { table: 'farm_logs', column: 'approved_at', definition: 'TEXT' },
    { table: 'farm_logs', column: 'review_note', definition: 'TEXT' },
    { table: 'farm_logs', column: 'gps_status', definition: 'TEXT' },
    { table: 'farm_logs', column: 'gps_distance_m', definition: 'REAL' },
    { table: 'farm_logs', column: 'machines_json', definition: 'TEXT' },
    // Xoá mềm & lưu vết (GIS BR-14/17/19): thửa, cơ sở, HTX ẩn khỏi bản đồ nhưng còn lịch sử.
    { table: 'plots', column: 'deleted_at', definition: 'TEXT' },
    { table: 'plots', column: 'deleted_by', definition: 'TEXT' },
    { table: 'plots', column: 'deleted_reason', definition: 'TEXT' },
    { table: 'facilities', column: 'deleted_at', definition: 'TEXT' },
    { table: 'facilities', column: 'deleted_reason', definition: 'TEXT' },
    { table: 'facilities', column: 'capacity_unit', definition: "TEXT NOT NULL DEFAULT 'tấn'" },
    { table: 'facilities', column: 'address', definition: 'TEXT' },
    { table: 'facilities', column: 'boundary', definition: 'TEXT' },
    { table: 'cooperatives', column: 'deleted_at', definition: 'TEXT' },
    { table: 'cooperatives', column: 'status_reason', definition: 'TEXT' },
    { table: 'cooperatives', column: 'deactivated_at', definition: 'TEXT' },
    // Thư viện: chuyên mục, cảnh báo khẩn (US-NEWS-03), hướng dẫn địa phương gắn bản gốc (US-LIB-02).
    { table: 'knowledge_articles', column: 'category', definition: "TEXT NOT NULL DEFAULT 'ky_thuat'" },
    { table: 'knowledge_articles', column: 'urgent', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'knowledge_articles', column: 'parent_id', definition: 'TEXT' },
    { table: 'knowledge_articles', column: 'region_label', definition: 'TEXT' },
    { table: 'knowledge_articles', column: 'view_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
    // CGH: chủ sở hữu & máy có vòng đời (US-OWN-01, US-MAC-01/03), ngày HTX sở hữu để đếm máy theo thời điểm (BR-09).
    { table: 'machine_owners', column: 'status', definition: "TEXT NOT NULL DEFAULT 'active'" },
    { table: 'machine_owners', column: 'deactivated_at', definition: 'TEXT' },
    { table: 'machines', column: 'owned_since', definition: 'TEXT' },
    { table: 'machines', column: 'deactivated_at', definition: 'TEXT' },
    { table: 'machines', column: 'status', definition: "TEXT NOT NULL DEFAULT 'active'" },
    { table: 'machines', column: 'fuel', definition: 'TEXT' },
    { table: 'machines', column: 'power_hp', definition: 'REAL' },
    { table: 'productivity_norms', column: 'document_date', definition: 'TEXT' },
    // Nhiệm vụ hỗ trợ: SLA 24 giờ và leo thang (US-TASK-02).
    { table: 'support_tasks', column: 'escalated_at', definition: 'TEXT' },
    { table: 'support_tasks', column: 'escalated_to', definition: 'TEXT' },
    { table: 'support_tasks', column: 'sla_hours', definition: 'INTEGER NOT NULL DEFAULT 24' },
    // Danh bạ trực: mốc cập nhật để tự chuyển "Không xác định" (US-DIR-01).
    { table: 'extension_officers', column: 'duty_updated_at', definition: 'TEXT' },
    // Vụ canh tác gắn giống lúa từ danh mục (US-CAT-01, US-SEASON-01).
    { table: 'crop_cycles', column: 'variety_id', definition: 'TEXT' },
    // Snapshot có watermark: thời điểm chụp thật và id sự kiện cuối — replay theo sequence, không theo ngày (A05).
    { table: 'daily_snapshots', column: 'captured_at', definition: 'TEXT' },
    { table: 'daily_snapshots', column: 'last_event_id', definition: 'INTEGER' },
    // Outbox có lease: dòng đang gửi được claim kèm thời điểm, hết hạn thì trả về hàng đợi (O02).
    { table: 'notifications', column: 'claimed_at', definition: 'TEXT' },
    // Quản trị nền tảng đang ở trong hệ thống con nào (cơ cấu phân quyền 09/2026).
    { table: 'sessions', column: 'active_system', definition: 'TEXT' },
    // Đánh giá cấp độ 3 (SEC-06/08): phiên có mốc hoạt động (idle timeout), mốc xác thực (hành động nhạy cảm),
    // trạng thái chờ mã hai lớp, IP/UA; người dùng có bí mật TOTP (mã hoá); nhật ký có mã truy vết, IP, tenant.
    { table: 'sessions', column: 'last_seen_at', definition: 'TEXT' },
    { table: 'sessions', column: 'auth_at', definition: 'TEXT' },
    { table: 'sessions', column: 'mfa_pending', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'sessions', column: 'ip', definition: 'TEXT' },
    { table: 'sessions', column: 'user_agent', definition: 'TEXT' },
    { table: 'users', column: 'mfa_secret', definition: 'TEXT' },
    { table: 'users', column: 'mfa_enabled', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'users', column: 'mfa_last_counter', definition: 'INTEGER' },
    { table: 'event_log', column: 'request_id', definition: 'TEXT' },
    { table: 'event_log', column: 'actor_ip', definition: 'TEXT' },
    { table: 'event_log', column: 'tenant_id', definition: 'TEXT' },
];

function applyColumnMigrations(): void {
  for (const addition of COLUMN_ADDITIONS) {
    const columns = all<{ name: string }>(`PRAGMA table_info(${addition.table})`);
    if (!columns.length) continue;
    if (columns.some((column) => column.name === addition.column)) continue;
    db().exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`);
  }
}

export const SCHEMA = /* sql */ `
-- =====================================================================
-- 0. NỀN TẢNG: tài khoản, phân quyền, nhật ký
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  must_change_pw  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_pw IN (0, 1)),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'pending')),   -- active | locked | pending
  org_node_id     TEXT,                             -- vị trí trên cây tổ chức khuyến nông
  htx_id          TEXT,                             -- HTX liên kết (App HTX BR-02)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL,
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =====================================================================
-- NHÓM NGƯỜI DÙNG VÀ PHÂN QUYỀN ĐỘNG
--
-- Ma trận RBAC gốc nằm trong mã nguồn (rbac.ts) và là baseline. Hai bảng dưới
-- đây cho phép quản trị viên điều chỉnh mà không phải sửa mã và triển khai lại:
--
--   user_groups        Nhóm do quản trị viên tạo thêm, ngoài các vai trò hệ thống.
--   group_permissions  Ghi đè quyền cho MỘT nhóm: cấp thêm hoặc thu hồi bớt.
--
-- Lưu dạng GHI ĐÈ thay vì lưu trọn bộ quyền hiệu lực là có chủ đích: khi mã
-- nguồn bổ sung quyền mới cho một vai trò hệ thống, vai trò đó nhận được ngay,
-- thay vì đứng yên ở ảnh chụp cũ. Bù lại, giao diện phải chỉ rõ ô nào là mặc
-- định và ô nào đã bị ghi đè — nếu không người dùng sẽ không hiểu vì sao quyền
-- tự đổi sau một lần cập nhật hệ thống.
-- =====================================================================

CREATE TABLE IF NOT EXISTS user_groups (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  -- Nhóm hệ thống (định nghĩa trong rbac.ts) không xoá và không đổi tên được;
  -- chỉ được ghi đè quyền. Nhóm tuỳ chỉnh thì sửa xoá thoải mái.
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_permissions (
  group_code  TEXT NOT NULL,
  permission  TEXT NOT NULL,
  -- 1 = cấp thêm so với mặc định; 0 = thu hồi so với mặc định.
  granted     INTEGER NOT NULL,
  changed_by  TEXT,
  changed_at  TEXT NOT NULL,
  PRIMARY KEY (group_code, permission)
);

-- ===========================================================================
-- QUẢN LÝ HIỆN TRƯỜNG — đội thu gom rơm của Mekong Green (erp/field)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS field_teams (
  id            TEXT PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  leader_name   TEXT,
  leader_phone  TEXT,
  leader_user_id TEXT,             -- tài khoản đội trưởng (Cổng Hiện trường)
  base_lat      REAL,              -- điểm đóng quân, dùng để chọn đội gần ruộng nhất
  base_lng      REAL,
  base_label    TEXT,
  province_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'hoat_dong' CHECK (status IN ('hoat_dong', 'tam_nghi', 'giai_the')),   -- hoat_dong | tam_nghi | giai_the
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS field_team_members (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  full_name   TEXT NOT NULL,
  phone       TEXT,
  role        TEXT NOT NULL DEFAULT 'cong_nhan' CHECK (role IN ('doi_truong', 'lai_may', 'cong_nhan', 'lai_ghe')),    -- doi_truong | lai_may | cong_nhan | lai_ghe
  status      TEXT NOT NULL DEFAULT 'hoat_dong',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES field_teams(id)
);
CREATE TABLE IF NOT EXISTS field_vehicles (
  id             TEXT PRIMARY KEY,
  code           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('may_cuon', 'may_keo', 'xe_tai', 'may_xuc', 'ghe', 'sa_lan')),     -- may_cuon | may_keo | xe_tai | may_xuc | ghe | sa_lan
  plate_number   TEXT,
  team_id        TEXT,
  machine_id     TEXT,              -- liên kết danh mục máy cơ giới hoá (CGH) nếu có
  capacity_value REAL,              -- máy cuộn: tấn/ngày — quyết định năng lực xếp việc
  capacity_unit  TEXT,
  status         TEXT NOT NULL DEFAULT 'san_sang' CHECK (status IN ('san_sang', 'dang_dung', 'bao_duong', 'hong')),   -- san_sang | dang_dung | bao_duong | hong
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES field_teams(id)
);
-- Một việc thu gom = một thửa (hoặc một HTX) × một ngày gặt.
CREATE TABLE IF NOT EXISTS field_jobs (
  id                      TEXT PRIMARY KEY,
  code                    TEXT UNIQUE NOT NULL,
  source_type             TEXT NOT NULL,   -- crop_cycle | crop_status | harvest | manual
  source_id               TEXT,
  crop_cycle_id           TEXT,
  plot_id                 TEXT,
  htx_id                  TEXT,
  location_label          TEXT,
  lat                     REAL,
  lng                     REAL,
  loading_lat             REAL,            -- điểm tập kết bờ kênh
  loading_lng             REAL,
  destination_facility_id TEXT,            -- Hub / nhà máy nhận rơm
  harvest_date            TEXT NOT NULL,
  harvest_confirmed       INTEGER NOT NULL DEFAULT 0 CHECK (harvest_confirmed IN (0, 1)),   -- 1 = HTX đã khai báo sản lượng
  expected_straw_tons     REAL NOT NULL DEFAULT 0,
  area_ha                 REAL,
  team_id                 TEXT,
  planned_date            TEXT,
  assignment_mode         TEXT,            -- auto | manual
  assigned_by             TEXT,
  assigned_at             TEXT,
  priority                INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'cho_phan_cong' CHECK (status IN ('cho_phan_cong', 'da_phan_cong', 'dang_thuc_hien', 'hoan_thanh', 'huy')),
  note                    TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES field_teams(id)
);
-- Ba công đoạn cố định của mỗi việc: cuon_rom → gom_rom → xuong_ghe.
CREATE TABLE IF NOT EXISTS field_job_stages (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  stage         TEXT NOT NULL,
  sort_order    INTEGER NOT NULL,
  planned_start TEXT,
  planned_end   TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  quantity_tons REAL,
  bales         INTEGER,
  vehicle_id    TEXT,
  recorded_by   TEXT,
  lat           REAL,
  lng           REAL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'cho_thuc_hien' CHECK (status IN ('cho_thuc_hien', 'dang_thuc_hien', 'hoan_thanh', 'huy')),
  UNIQUE (job_id, stage),
  FOREIGN KEY (job_id) REFERENCES field_jobs(id),
  FOREIGN KEY (vehicle_id) REFERENCES field_vehicles(id)
);
-- Bằng chứng công đoạn: mỗi mục một dòng (thay cột evidence_json — nguyên tắc 5, rà soát 24/09/2026).
-- Ảnh có tệp đính kèm nằm ở bảng attachments (entity_type = field_job_stage); bảng này giữ
-- loại bằng chứng, ghi chú và liên kết ngoài do người ghi nhận khai.
CREATE TABLE IF NOT EXISTS field_stage_evidence (
  id           TEXT PRIMARY KEY,
  stage_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  url          TEXT,
  note         TEXT,
  recorded_at  TEXT NOT NULL,
  recorded_by  TEXT,
  FOREIGN KEY (stage_id) REFERENCES field_job_stages(id)
);
CREATE INDEX IF NOT EXISTS idx_field_stage_evidence_stage ON field_stage_evidence(stage_id);
-- Mỗi lượt xuống ghe là một chuyến TMS (trip_id) — cầu nối hiện trường ↔ vận tải.
CREATE TABLE IF NOT EXISTS field_loadings (
  id                      TEXT PRIMARY KEY,
  job_id                  TEXT NOT NULL,
  vessel_code             TEXT NOT NULL,
  vessel_kind             TEXT,
  tons                    REAL NOT NULL,
  bales                   INTEGER,
  destination_facility_id TEXT,
  trip_id                 TEXT,
  loaded_at               TEXT NOT NULL,
  recorded_by             TEXT,
  lat                     REAL,
  lng                     REAL,
  note                    TEXT,
  FOREIGN KEY (job_id) REFERENCES field_jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_field_jobs_team_status ON field_jobs(team_id, status);
CREATE INDEX IF NOT EXISTS idx_field_jobs_harvest ON field_jobs(harvest_date);
CREATE INDEX IF NOT EXISTS idx_field_loadings_job ON field_loadings(job_id);

-- ===========================================================================
-- TỆP ĐÍNH KÈM DÙNG CHUNG — ảnh bằng chứng có EXIF (platform/files)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL,     -- field_job_stage | field_loading | plan_step | plot | rental_dispute ...
  entity_id       TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  sha256          TEXT NOT NULL,     -- lưu theo băm: cùng ảnh không chiếm hai chỗ
  storage_path    TEXT NOT NULL,
  taken_at        TEXT,              -- EXIF DateTimeOriginal
  lat             REAL,
  lng             REAL,
  location_source TEXT,              -- exif | thiet_bi
  distance_m      REAL,              -- cách vị trí đối tượng
  flags_json      TEXT NOT NULL DEFAULT '[]',
  note            TEXT,
  uploaded_by     TEXT,
  uploaded_at     TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);

-- ===========================================================================
-- THÔNG BÁO CHỦ ĐỘNG — outbox nhiều kênh (platform/notify)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL,   -- một thông báo → nhiều dòng (mỗi kênh một dòng)
  recipient_user_id TEXT NOT NULL,
  channel           TEXT NOT NULL CHECK (channel IN ('inapp', 'zalo', 'sms', 'email')),   -- inapp | zalo | sms
  severity          TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),   -- info | warn | critical
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  link              TEXT,
  module            TEXT NOT NULL,
  entity_type       TEXT,
  entity_id         TEXT,
  dedupe_key        TEXT,
  status            TEXT NOT NULL CHECK (status IN ('cho_gui', 'dang_gui', 'da_gui', 'loi', 'cho_cau_hinh', 'khong_co_email')),   -- cho_gui | da_gui | loi | cho_cau_hinh
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  sent_at           TEXT,
  read_at           TEXT,
  FOREIGN KEY (recipient_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(recipient_user_id, channel, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, channel);

-- ===========================================================================
-- CHỐNG GHI TRÙNG — phản hồi đã trả cho một Idempotency-Key (platform/http)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS request_log (
  idem_key      TEXT NOT NULL,
  user_id       TEXT,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status        INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (idem_key, user_id)
);

-- ===========================================================================
-- CHUỖI THU MUA RƠM: hợp đồng HTX, phiếu mua rơm, danh mục ghe (erp/straw, erp/tms)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS straw_contracts (
  id               TEXT PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  htx_id           TEXT NOT NULL,
  from_date        TEXT NOT NULL,
  to_date          TEXT NOT NULL,
  committed_tons   REAL NOT NULL,
  price_basis      TEXT NOT NULL,      -- theo_tan_can | theo_cuon
  unit_price       INTEGER NOT NULL,      -- đ/tấn hoặc đ/cuộn
  max_moisture_pct REAL,
  status           TEXT NOT NULL DEFAULT 'hieu_luc' CHECK (status IN ('hieu_luc', 'het_han', 'huy')),   -- hieu_luc | het_han | huy
  note             TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);
CREATE TABLE IF NOT EXISTS straw_purchase_tickets (
  id                 TEXT PRIMARY KEY,
  code               TEXT UNIQUE NOT NULL,
  job_id             TEXT NOT NULL UNIQUE,   -- PM-01: một việc = một phiếu
  htx_id             TEXT,
  contract_id        TEXT,
  price_basis        TEXT,
  unit_price         INTEGER,
  bales              INTEGER NOT NULL DEFAULT 0,
  estimated_tons     REAL NOT NULL DEFAULT 0,
  weighed_tons       REAL,                    -- chỉ khi MỌI ghe của việc đã cân
  unweighed_loadings INTEGER NOT NULL DEFAULT 0,
  amount             INTEGER,
  status             TEXT NOT NULL CHECK (status IN ('cho_can', 'cho_xac_nhan', 'da_xac_nhan', 'da_thanh_toan', 'huy')),           -- cho_can | cho_xac_nhan | da_xac_nhan | da_thanh_toan | huy
  ledger_entry_id    TEXT,
  due_date           TEXT,
  confirmed_by       TEXT,
  confirmed_at       TEXT,
  paid_at            TEXT,
  note               TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES field_jobs(id),
  FOREIGN KEY (contract_id) REFERENCES straw_contracts(id),
  FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id)
);
CREATE TABLE IF NOT EXISTS vessels (
  id                  TEXT PRIMARY KEY,
  code                TEXT UNIQUE NOT NULL,   -- số hiệu đăng ký
  name                TEXT,
  kind                TEXT NOT NULL,          -- ghe | sa_lan
  vessel_class        TEXT,                   -- mã lớp tàu platform/geo/vessels.ts
  owner_name          TEXT,
  owner_phone         TEXT,
  registered_tons     REAL,
  straw_payload_tons  REAL,
  registration_expiry TEXT,
  rate_type           TEXT,                   -- per_ton | per_trip | per_ton_km
  rate_vnd            INTEGER,
  status              TEXT NOT NULL DEFAULT 'hoat_dong',
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_straw_contracts_htx ON straw_contracts(htx_id, status);
CREATE INDEX IF NOT EXISTS idx_straw_tickets_htx ON straw_purchase_tickets(htx_id, status);

-- Phạm vi quản trị được uỷ quyền (platform/auth/scopes.ts): mỗi hệ thống con,
-- mỗi cấp một admin riêng; super admin (platform_admin) không cần dòng nào ở đây.
CREATE TABLE IF NOT EXISTS admin_scopes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  system      TEXT NOT NULL,          -- kn | htx | cgh | gis | erp | field
  scope_type  TEXT NOT NULL,          -- system | province | htx
  scope_id    TEXT,                   -- admin_units.id (tỉnh) hoặc cooperatives.id (HTX); NULL với cấp hệ thống
  granted_by  TEXT,
  granted_at  TEXT NOT NULL,
  note        TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_admin_scopes_user ON admin_scopes(user_id);
-- Con trỏ đồng bộ dữ liệu dùng chung của từng hệ thống con (platform/sync/sharedFlows.ts).
CREATE TABLE IF NOT EXISTS shared_sync_cursor (
  system    TEXT PRIMARY KEY,
  last_seq  INTEGER NOT NULL DEFAULT 0,
  acked_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- GIS FN-17: nhật ký sự kiện append-only cho MỌI lớp dữ liệu.
CREATE TABLE IF NOT EXISTS event_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  TEXT NOT NULL,
  actor_id     TEXT,
  actor_name   TEXT,
  module       TEXT NOT NULL,       -- gis | simulation | warehouse | htx | ...
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  action       TEXT NOT NULL,       -- create | update | delete | approve | export | sync
  before_json  TEXT,
  after_json   TEXT,
  source       TEXT CHECK (source IS NULL OR source IN ('ui', 'api', 'integration', 'system')),                -- ui | api | integration | system
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_log_day ON event_log(substr(occurred_at, 1, 10));
CREATE INDEX IF NOT EXISTS idx_event_log_entity ON event_log(entity_type, entity_id);

-- GIS FN-18: snapshot trạng thái toàn hệ thống theo ngày.
CREATE TABLE IF NOT EXISTS daily_snapshots (
  snapshot_date TEXT NOT NULL,
  layer         TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  record_count  INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, layer)
);

-- GIS FN-20: chính sách lưu trữ & dọn dẹp dữ liệu lịch sử.
CREATE TABLE IF NOT EXISTS retention_policy (
  id                    TEXT PRIMARY KEY,
  event_log_days        INTEGER NOT NULL DEFAULT 730,
  snapshot_days         INTEGER NOT NULL DEFAULT 365,
  compact_after_days    INTEGER NOT NULL DEFAULT 90,
  updated_at            TEXT NOT NULL
);

-- GIS FN-21/FN-22: nhật ký & retry đồng bộ tích hợp.
CREATE TABLE IF NOT EXISTS sync_log (
  id             TEXT PRIMARY KEY,
  system         TEXT NOT NULL,     -- app_htx | ban_do_cgh | erp | tms
  direction      TEXT NOT NULL,     -- inbound | outbound
  dataset        TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  record_count   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,     -- success | failed | dead_letter | retrying
  attempt        INTEGER NOT NULL DEFAULT 1,
  next_retry_at  TEXT,
  error_message  TEXT,
  payload_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_log(status, next_retry_at);

-- =====================================================================
-- 1. MASTER DATA & CONFIGURATION HUB
-- =====================================================================

CREATE TABLE IF NOT EXISTS admin_units (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  -- province | commune | ap  (đơn vị hành chính sau sáp nhập 2025; ap = thôn/ấp/khóm)
  level       TEXT NOT NULL,
  parent_id   TEXT,
  boundary    TEXT,                 -- GeoJSON Polygon
  centroid_lat REAL,
  centroid_lng REAL
);

CREATE TABLE IF NOT EXISTS cooperatives (       -- Danh mục HTX (dùng chung)
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,          -- Mã HTX: hệ thống tự sinh (CGH BR-01)
  name           TEXT NOT NULL,
  province_id    TEXT,
  commune_id     TEXT,
  address        TEXT,
  contact_name   TEXT,
  contact_phone  TEXT,
  lat            REAL,
  lng            REAL,
  boundary       TEXT,                          -- GeoJSON Polygon (ranh giới vùng HTX)
  registered_area_ha REAL DEFAULT 0,            -- diện tích đăng ký hành chính (KHÁC diện tích canh tác theo vụ)
  member_count   INTEGER DEFAULT 0,
  -- Mã số thuế: định danh pháp lý duy nhất của HTX. Khuyến nông khởi tạo hồ sơ
  -- kèm MST; khi HTX kích hoạt tài khoản và điền đúng MST thì nhận lại toàn bộ
  -- dữ liệu đã có sẵn trên CSDL dùng chung (thửa ruộng, thành viên, vụ...).
  tax_code       TEXT UNIQUE,
  -- tap_trung            = Ban quản trị phân công việc cho thành viên
  -- thanh_vien_chu_dong  = thành viên tự chủ trên thửa của mình; Ban quản trị
  --                        chỉ điều phối máy móc, thiết bị dùng chung
  operating_model TEXT NOT NULL DEFAULT 'tap_trung',
  origin         TEXT NOT NULL DEFAULT 'htx' CHECK (origin IN ('htx', 'khuyennong')),   -- htx | khuyennong
  claimed_at     TEXT,
  claimed_by     TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (province_id) REFERENCES admin_units(id),
  FOREIGN KEY (commune_id) REFERENCES admin_units(id)
);

CREATE TABLE IF NOT EXISTS farmers (            -- Hồ sơ nông hộ
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  national_id   TEXT,
  htx_id        TEXT NOT NULL,
  address       TEXT,
  reliability_score REAL DEFAULT 0,             -- điểm tin cậy 1-5 (Requirement nhóm 9)
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS plots (              -- Thửa ruộng / lô ruộng (GIS polygon)
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT,
  htx_id       TEXT NOT NULL,
  farmer_id    TEXT,
  boundary     TEXT,                            -- GeoJSON Polygon do cán bộ/nông dân vẽ
  area_ha      REAL NOT NULL DEFAULT 0,         -- hệ thống TỰ TÍNH từ polygon
  centroid_lat REAL,
  centroid_lng REAL,
  soil_type    TEXT,
  status       TEXT NOT NULL DEFAULT 'chua_mo_vu' CHECK (status IN ('chua_mo_vu', 'dang_canh_tac', 'da_hoan_thanh_vu')), -- chua_mo_vu | dang_canh_tac | da_hoan_thanh_vu
  source       TEXT NOT NULL DEFAULT 'app_htx',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (farmer_id) REFERENCES farmers(id)
);

CREATE TABLE IF NOT EXISTS seasons (            -- Danh mục mùa vụ (Đông Xuân / Hè Thu / Thu Đông)
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  year        INTEGER NOT NULL,
  start_month INTEGER NOT NULL,
  end_month   INTEGER NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- Sản lượng lúa thống kê theo HTX × mùa vụ.
-- Simulation FN-06 BR-01 (quyết định B3): đây là NGUỒN DUY NHẤT của Total Available Supply.
CREATE TABLE IF NOT EXISTS harvest_statistics (
  id             TEXT PRIMARY KEY,
  htx_id         TEXT NOT NULL,
  season_id      TEXT NOT NULL,
  planted_area_ha REAL NOT NULL DEFAULT 0,      -- chỉ để hiển thị/đối chiếu (tham số #4)
  paddy_tons     REAL NOT NULL DEFAULT 0,       -- tham số #5
  source         TEXT NOT NULL DEFAULT 'gso',
  recorded_at    TEXT NOT NULL,
  UNIQUE (htx_id, season_id),
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (season_id) REFERENCES seasons(id)
);

CREATE TABLE IF NOT EXISTS facilities (         -- Hub / Kho / Bãi / Nhà máy đầu ra (multi-site)
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('hub', 'warehouse', 'yard', 'plant')),                  -- hub | warehouse | yard | plant
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  province_id   TEXT,
  capacity_tons REAL DEFAULT 0,
  current_stock_tons REAL DEFAULT 0,
  annual_demand_tons REAL DEFAULT 0,            -- tham số #12 cho nhà máy đầu ra
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'closed')), -- draft | active | closed
  origin_scenario_id TEXT,                      -- FN-19: Hub chuyển từ kịch bản sang vận hành
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (province_id) REFERENCES admin_units(id)
);

CREATE TABLE IF NOT EXISTS storage_zones (      -- Khu vực lưu trữ trong một bãi/kho
  id           TEXT PRIMARY KEY,
  facility_id  TEXT NOT NULL,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  zone_type    TEXT NOT NULL DEFAULT 'covered', -- outdoor | covered | closed | container
  capacity_tons REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (facility_id) REFERENCES facilities(id)
);

CREATE TABLE IF NOT EXISTS partners (           -- Đối tác mua / NCC / tổ chức kiểm định
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- customer | vendor | vvb | buyer
  tax_code    TEXT,
  contact     TEXT,
  address     TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS items (              -- Item master (rơm theo loại, dược liệu, vật tư)
  id        TEXT PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  uom       TEXT NOT NULL DEFAULT 'tấn',
  category  TEXT NOT NULL DEFAULT 'straw'
);

CREATE TABLE IF NOT EXISTS machine_types (      -- Danh mục chủng loại máy (CGH FN-02)
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  stage         TEXT NOT NULL,                  -- khâu sản xuất: tự gán theo chủng loại
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS machine_owners (     -- Hồ sơ chủ sở hữu máy (CGH FN-04)
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,             -- Mã CSH tự sinh
  name        TEXT NOT NULL,
  owner_type  TEXT NOT NULL,                    -- thanh_vien_htx | htx | doanh_nghiep | khac
  htx_id      TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS machines (           -- Hồ sơ máy móc - thiết bị (CGH FN-05)
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,         -- Mã máy tự sinh
  machine_type_id TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  htx_id          TEXT NOT NULL,
  brand           TEXT,
  model           TEXT,
  serial_number   TEXT,
  chassis_number  TEXT,
  year_made       INTEGER,
  capacity_ha_per_season REAL DEFAULT 0,
  condition       TEXT NOT NULL DEFAULT 'hoat_dong' CHECK (condition IN ('hoat_dong', 'bao_tri', 'hong', 'ngung_hoat_dong')), -- hoat_dong | bao_tri | hong | ngung_hoat_dong
  condition_source TEXT NOT NULL DEFAULT 'nhap_tay' CHECK (condition_source IN ('app_htx', 'nhap_tay')), -- app_htx | nhap_tay  (QT-03)
  condition_locked INTEGER NOT NULL DEFAULT 0 CHECK (condition_locked IN (0, 1)),       -- bản ghi Admin đã "khóa" (QT-03 mục 3)
  condition_updated_at TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (machine_type_id) REFERENCES machine_types(id),
  FOREIGN KEY (owner_id) REFERENCES machine_owners(id),
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

-- CGH FN-02c: định mức năng suất (ha/máy/vụ) do DCRD ban hành, có ngày hiệu lực.
CREATE TABLE IF NOT EXISTS productivity_norms (
  id               TEXT PRIMARY KEY,
  machine_type_id  TEXT NOT NULL,
  stage            TEXT NOT NULL,
  ha_per_machine_season REAL NOT NULL,
  effective_from   TEXT NOT NULL,
  effective_to     TEXT,
  document_ref     TEXT,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  FOREIGN KEY (machine_type_id) REFERENCES machine_types(id)
);

-- CGH: diện tích canh tác & lịch mùa vụ theo vùng × vụ (nguồn App HTX, fallback nhập tay).
CREATE TABLE IF NOT EXISTS cultivation_plans (
  id           TEXT PRIMARY KEY,
  htx_id       TEXT NOT NULL,
  season_id    TEXT NOT NULL,
  area_ha      REAL NOT NULL DEFAULT 0,
  stage_start  TEXT,
  stage_end    TEXT,
  source       TEXT NOT NULL DEFAULT 'nhap_tay', -- app_htx | nhap_tay
  locked       INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  updated_at   TEXT NOT NULL,
  UNIQUE (htx_id, season_id)
);

-- Dữ liệu vụ mùa theo ĐƠN VỊ HÀNH CHÍNH (xã/phường), nhập từ file điều tra của
-- Chi cục Trồng trọt & BVTV. Khác cultivation_plans (theo HTX) ở chỗ đơn vị
-- quan sát là địa giới hành chính, nên dùng được cả khi chưa map được về HTX.
CREATE TABLE IF NOT EXISTS commune_crop_seasons (
  id             TEXT PRIMARY KEY,
  season_id      TEXT NOT NULL,
  province_code  TEXT,
  province_name  TEXT,
  district       TEXT,
  commune        TEXT NOT NULL,
  area_ha        REAL NOT NULL DEFAULT 0,
  sowing_date    TEXT,
  -- khai_bao = có trong file; suy_ra = tính ngược từ ngày thu hoạch
  sowing_date_source TEXT,
  harvest_date   TEXT,
  yield_dry_tons_per_ha REAL,
  output_tons    REAL,
  rice_variety   TEXT,
  lat            REAL,
  lng            REAL,
  geocode_precision TEXT,
  source_file    TEXT,
  updated_at     TEXT NOT NULL,
  -- Hai huyện khác nhau trong cùng tỉnh có thể có xã trùng tên.
  UNIQUE (season_id, province_code, district, commune),
  FOREIGN KEY (season_id) REFERENCES seasons(id)
);

-- Tiến độ thu hoạch theo từng mốc ngày (file điều tra ghi nhiều đợt trong vụ).
CREATE TABLE IF NOT EXISTS commune_harvest_progress (
  id                TEXT PRIMARY KEY,
  commune_season_id TEXT NOT NULL,
  as_of_date        TEXT NOT NULL,
  area_ha           REAL NOT NULL DEFAULT 0,
  yield_dry_tons_per_ha REAL,
  output_tons       REAL NOT NULL DEFAULT 0,
  UNIQUE (commune_season_id, as_of_date),
  FOREIGN KEY (commune_season_id) REFERENCES commune_crop_seasons(id) ON DELETE CASCADE
);

-- =====================================================================
-- 2. GIS DÙNG CHUNG
-- =====================================================================

CREATE TABLE IF NOT EXISTS gis_layers (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,        -- base | infrastructure | natural | dynamic
  visible_default INTEGER NOT NULL DEFAULT 1 CHECK (visible_default IN (0, 1)),
  min_zoom    INTEGER NOT NULL DEFAULT 0,
  max_zoom    INTEGER NOT NULL DEFAULT 22,
  style_json  TEXT
);

-- GIS FN-07 (đường bộ) & FN-08 (đường thủy) + Simulation FN-20 (tuyến tự số hóa).
CREATE TABLE IF NOT EXISTS transport_routes (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  mode           TEXT NOT NULL,       -- road | waterway
  road_class     TEXT,                -- FN-07: phân loại đường bộ
  max_load_tons  REAL,                -- FN-07/FN-08: tải trọng tối đa
  width_m        REAL,                -- FN-08: chiều rộng lòng kênh
  depth_m        REAL,                -- FN-08: độ sâu
  clearance_m    REAL,                -- tĩnh không cầu
  geometry       TEXT NOT NULL,       -- GeoJSON LineString
  length_m       REAL NOT NULL,       -- hệ thống tự tính (FN-20 BR-03: không cho nhập tay)
  data_source    TEXT NOT NULL DEFAULT 'so_hoa_noi_bo', -- so_hoa_noi_bo | chinh_thuc | osm
  status         TEXT NOT NULL DEFAULT 'nhap',          -- nhap | da_xac_nhan (FN-20 BR-04)
  -- Tải trọng SUY RA từ rộng/sâu/tĩnh không, khác max_load_tons nhập tay.
  derived_max_load_tons REAL,
  derived_vessel_code   TEXT,
  derived_certainty     TEXT,
  derived_at            TEXT,
  province_id    TEXT,
  note           TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- =====================================================================
-- CÔNG TRÌNH VƯỢT SÔNG TRÊN TUYẾN ĐƯỜNG THUỶ
--
-- Cầu, cống, âu thuyền là ràng buộc ĐIỂM trên tuyến: cả tuyến rộng và sâu tới
-- đâu cũng vô nghĩa nếu có một cây cầu tĩnh không 4 m chắn ngang. Tách bảng
-- riêng vì một tuyến có nhiều công trình, và tĩnh không thấp nhất trong số đó
-- mới là con số quyết định sà lan nào qua được.
-- =====================================================================

CREATE TABLE IF NOT EXISTS waterway_structures (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  route_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'cau',   -- cau | cong | au_thuyen | duong_day_dien
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  -- Tĩnh không thông thuyền (m), đo từ mực nước cao nhất thiết kế.
  clearance_height_m REAL,
  -- Khẩu độ khoang thông thuyền (m) — hẹp hơn lòng kênh ở vị trí cầu.
  clearance_width_m  REAL,
  -- Độ sâu luồng ngay tại công trình, thường cạn hơn do bồi lắng chân trụ.
  depth_m       REAL,
  survey_date   TEXT,
  data_source   TEXT NOT NULL DEFAULT 'khao_sat',  -- khao_sat | ho_so_thiet_ke | uoc_luong
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (route_id) REFERENCES transport_routes(id) ON DELETE CASCADE
);

-- FN-04 BR-05: cache khoảng cách theo cặp toạ độ, kèm ngày tính và nguồn tính.
CREATE TABLE IF NOT EXISTS distance_cache (
  id          TEXT PRIMARY KEY,      -- hash(from, to, mode)
  from_lat    REAL NOT NULL,
  from_lng    REAL NOT NULL,
  to_lat      REAL NOT NULL,
  to_lng      REAL NOT NULL,
  mode        TEXT NOT NULL,         -- road | waterway
  distance_km REAL NOT NULL,
  source      TEXT NOT NULL,         -- routing_thuc_te | tuyen_so_hoa_noi_bo | haversine_hieu_chinh
  computed_at TEXT NOT NULL
);

-- GIS FN-10/FN-11: thời tiết dự báo & cảnh báo.
CREATE TABLE IF NOT EXISTS weather_observations (
  id           TEXT PRIMARY KEY,
  area_id      TEXT NOT NULL,        -- admin_units.id
  observed_for TEXT NOT NULL,        -- ngày
  rainfall_mm  REAL,
  humidity_pct REAL,
  temp_c       REAL,
  kind         TEXT NOT NULL DEFAULT 'forecast', -- forecast | realtime
  severity     TEXT,                 -- null | canh_bao | nguy_hiem
  headline     TEXT,
  received_at  TEXT NOT NULL,
  FOREIGN KEY (area_id) REFERENCES admin_units(id)
);

-- GIS FN-12/FN-13: trạng thái mùa vụ & cảnh báo sản lượng (nhận từ App HTX).
CREATE TABLE IF NOT EXISTS crop_status (
  id             TEXT PRIMARY KEY,
  htx_id         TEXT NOT NULL,
  season_id      TEXT NOT NULL,
  stage          TEXT NOT NULL CHECK (stage IN ('lam_dat', 'gieo_sa', 'sinh_truong', 'chin', 'thu_hoach', 'sau_thu_hoach')),      -- lam_dat | gieo_sa | sinh_truong | chin | thu_hoach | sau_thu_hoach
  expected_harvest_date TEXT,
  expected_yield_tons REAL DEFAULT 0,
  straw_tons     REAL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  UNIQUE (htx_id, season_id),
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (season_id) REFERENCES seasons(id)
);

-- =====================================================================
-- 3. APP KHUYẾN NÔNG
-- =====================================================================

CREATE TABLE IF NOT EXISTS org_nodes (          -- Cây tổ chức khuyến nông 3 cấp (FN-03)
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  level      TEXT NOT NULL,          -- trung_uong | tinh | xa | to_knc?
  parent_id  TEXT,
  admin_unit_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_articles ( -- FN-10/FN-11: thư viện kỹ thuật & tin tức
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- quy_trinh | tai_lieu | tin_tuc
  summary      TEXT,
  body         TEXT,
  crop         TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')), -- draft | published | archived
  scope_node_id TEXT,
  published_at TEXT,
  author_id    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  FOREIGN KEY (scope_node_id) REFERENCES org_nodes(id)
);

CREATE TABLE IF NOT EXISTS support_tasks (      -- FN-14: nhiệm vụ hỗ trợ (tự sinh từ App HTX)
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  htx_id        TEXT NOT NULL,
  farmer_id     TEXT,
  plot_id       TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  category      TEXT NOT NULL DEFAULT 'ky_thuat', -- ky_thuat | sau_benh | thiet_bi | khac
  priority      TEXT NOT NULL DEFAULT 'binh_thuong',
  status        TEXT NOT NULL DEFAULT 'moi' CHECK (status IN ('moi', 'tiep_nhan', 'dang_xu_ly', 'hoan_thanh', 'dong')),       -- moi | tiep_nhan | dang_xu_ly | hoan_thanh | dong
  assignee_id   TEXT,
  origin        TEXT NOT NULL DEFAULT 'app_htx',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolution    TEXT
);

CREATE TABLE IF NOT EXISTS extension_officers ( -- FN-15: danh bạ trực hỗ trợ
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  full_name   TEXT NOT NULL,
  phone       TEXT NOT NULL,
  org_node_id TEXT NOT NULL,
  specialty   TEXT,
  on_duty     INTEGER NOT NULL DEFAULT 1 CHECK (on_duty IN (0, 1)),
  FOREIGN KEY (org_node_id) REFERENCES org_nodes(id)
);

CREATE TABLE IF NOT EXISTS market_prices (      -- FN-16/FN-17: giá cả thị trường
  id          TEXT PRIMARY KEY,
  commodity   TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT 'VNĐ/kg',
  price       INTEGER NOT NULL,
  price_date  TEXT NOT NULL,
  region      TEXT,
  source      TEXT,
  UNIQUE (commodity, price_date, region)
);

CREATE TABLE IF NOT EXISTS training_courses (   -- FN-12: quản trị đào tạo ToT
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  location    TEXT,
  org_node_id TEXT,
  capacity    INTEGER DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'planned',
  FOREIGN KEY (org_node_id) REFERENCES org_nodes(id)
);

CREATE TABLE IF NOT EXISTS training_enrollments (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL,
  trainee_name TEXT NOT NULL,
  htx_id     TEXT,
  phone      TEXT,
  status     TEXT NOT NULL DEFAULT 'registered',
  FOREIGN KEY (course_id) REFERENCES training_courses(id)
);

-- =====================================================================
-- 4. APP HỢP TÁC XÃ
-- =====================================================================

CREATE TABLE IF NOT EXISTS crop_cycles (        -- FN-10: khai báo mở vụ mới
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  plot_id        TEXT NOT NULL,
  season_id      TEXT NOT NULL,
  variety        TEXT,
  sowing_date    TEXT,
  expected_harvest_date TEXT,
  area_ha        REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'dang_canh_tac' CHECK (status IN ('dang_canh_tac', 'da_hoan_thanh_vu')), -- dang_canh_tac | da_hoan_thanh_vu
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (plot_id) REFERENCES plots(id),
  FOREIGN KEY (season_id) REFERENCES seasons(id)
);

CREATE TABLE IF NOT EXISTS farm_logs (          -- FN-11: nhật ký canh tác (+ AWD cho MRV)
  id            TEXT PRIMARY KEY,
  crop_cycle_id TEXT NOT NULL,
  log_date      TEXT NOT NULL,
  activity      TEXT NOT NULL,      -- lam_dat | gieo_sa | bon_phan | phun_thuoc | tuoi | rut_nuoc_awd | thu_hoach
  detail        TEXT,
  input_name    TEXT,
  input_qty     REAL,
  input_uom     TEXT,
  photo_url     TEXT,
  lat           REAL,
  lng           REAL,
  recorded_by   TEXT,
  synced        INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1)),   -- hỗ trợ offline-first
  created_at    TEXT NOT NULL,
  FOREIGN KEY (crop_cycle_id) REFERENCES crop_cycles(id)
);

-- =====================================================================
-- QUY TRÌNH SẢN XUẤT CHUẨN & KẾ HOẠCH SẢN XUẤT
--
-- Nhật ký canh tác trước đây là các bản ghi rời rạc: nông dân nhớ gì ghi nấy.
-- Cách đó không chứng minh được đã canh tác theo chuẩn nào, vì không có gì để
-- đối chiếu. Nay bổ sung hai lớp:
--
--   (1) QUY TRÌNH CHUẨN (VietGAP, SRP, hữu cơ...) — bản mẫu gồm các bước, mỗi
--       bước neo vào ngày xuống giống bằng số ngày lệch, có cửa sổ thời gian
--       cho phép, loại bằng chứng bắt buộc và điểm kiểm soát.
--   (2) KẾ HOẠCH SẢN XUẤT — bung quy trình ra thành lịch cụ thể cho MỘT vụ,
--       theo đúng ngày xuống giống của vụ đó.
--
-- Ghi nhật ký khi đó trở thành XÁC NHẬN một bước kế hoạch: có thể lệch ngày so
-- với dự kiến (kèm lý do) và phải đính bằng chứng nếu bước yêu cầu.
-- =====================================================================

CREATE TABLE IF NOT EXISTS production_protocols (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  standard      TEXT NOT NULL DEFAULT 'vietgap',  -- vietgap | srp | huu_co | noi_bo
  crop          TEXT NOT NULL DEFAULT 'lua',
  version       INTEGER NOT NULL DEFAULT 1,
  -- he_thong = quy trình chuẩn do Khuyến nông ban hành, mọi HTX dùng được;
  -- htx      = quy trình riêng của một HTX (thường sao chép rồi chỉnh).
  scope         TEXT NOT NULL DEFAULT 'he_thong',
  htx_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'nhap' CHECK (status IN ('nhap', 'ban_hanh', 'ngung')),     -- nhap | ban_hanh | ngung
  document_ref  TEXT,
  description   TEXT,
  source_protocol_id TEXT,
  -- Vụ canh tác đã hoàn thành mà quy trình này được rút ra từ đó (nếu có).
  source_crop_cycle_id TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (code, version),
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (source_crop_cycle_id) REFERENCES crop_cycles(id),
  FOREIGN KEY (source_protocol_id) REFERENCES production_protocols(id)
);

CREATE TABLE IF NOT EXISTS protocol_steps (
  id            TEXT PRIMARY KEY,
  protocol_id   TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  activity      TEXT NOT NULL,          -- khớp FARM_ACTIVITIES của nhật ký
  stage         TEXT,                   -- giai đoạn sinh trưởng, chỉ để hiển thị
  -- Neo theo NGÀY XUỐNG GIỐNG của vụ: âm = trước khi sạ (làm đất), 0 = ngày sạ.
  offset_days   INTEGER NOT NULL DEFAULT 0,
  window_days   INTEGER NOT NULL DEFAULT 3,  -- lệch trong khoảng này coi là đúng hạn
  mandatory     INTEGER NOT NULL DEFAULT 1 CHECK (mandatory IN (0, 1)),
  -- Danh sách loại bằng chứng bắt buộc, JSON: ["anh_hien_truong","hoa_don_vat_tu"]
  evidence_kinds TEXT,
  -- Thời gian cách ly sau phun thuốc (ngày) — VietGAP bắt buộc với thuốc BVTV.
  phi_days      INTEGER,
  control_point TEXT,                   -- điểm kiểm soát / ngưỡng phải đạt
  instruction   TEXT,
  FOREIGN KEY (protocol_id) REFERENCES production_protocols(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS production_plans (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  crop_cycle_id    TEXT NOT NULL UNIQUE,   -- mỗi vụ chỉ có một kế hoạch đang hiệu lực
  protocol_id      TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,       -- ghim phiên bản tại thời điểm sinh kế hoạch
  anchor_date      TEXT NOT NULL,          -- ngày xuống giống dùng để tính lịch
  status           TEXT NOT NULL DEFAULT 'dang_thuc_hien' CHECK (status IN ('dang_thuc_hien', 'hoan_thanh', 'huy')), -- dang_thuc_hien | hoan_thanh | huy
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (crop_cycle_id) REFERENCES crop_cycles(id),
  FOREIGN KEY (protocol_id) REFERENCES production_protocols(id)
);

CREATE TABLE IF NOT EXISTS production_plan_steps (
  id               TEXT PRIMARY KEY,
  plan_id          TEXT NOT NULL,
  protocol_step_id TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  name             TEXT NOT NULL,
  activity         TEXT NOT NULL,
  stage            TEXT,
  planned_date     TEXT NOT NULL,
  window_days      INTEGER NOT NULL DEFAULT 3,
  mandatory        INTEGER NOT NULL DEFAULT 1 CHECK (mandatory IN (0, 1)),
  evidence_kinds   TEXT,
  phi_days         INTEGER,
  control_point    TEXT,
  instruction      TEXT,
  -- ke_hoach | da_thuc_hien | tre_han | bo_qua
  status           TEXT NOT NULL DEFAULT 'ke_hoach',
  actual_date      TEXT,
  deviation_days   INTEGER,
  deviation_reason TEXT,
  farm_log_id      TEXT,
  confirmed_by     TEXT,
  confirmed_at     TEXT,
  FOREIGN KEY (plan_id) REFERENCES production_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (farm_log_id) REFERENCES farm_logs(id),
  FOREIGN KEY (protocol_step_id) REFERENCES protocol_steps(id)
);

CREATE TABLE IF NOT EXISTS plan_step_evidence (
  id            TEXT PRIMARY KEY,
  plan_step_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- anh_hien_truong | hoa_don_vat_tu | phieu_kiem_nghiem | ghi_chu | khac
  label         TEXT,
  file_name     TEXT,
  mime_type     TEXT,
  content       TEXT,            -- data URI hoặc ghi chú dạng văn bản
  lat           REAL,
  lng           REAL,
  captured_at   TEXT,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (plan_step_id) REFERENCES production_plan_steps(id) ON DELETE CASCADE
);

-- =====================================================================
-- PHÂN CÔNG CÔNG VIỆC THEO KẾ HOẠCH SẢN XUẤT
--
-- Một bước kế hoạch trên một thửa ruộng được giao cho thành viên HTX và/hoặc
-- máy móc. Hai mô hình vận hành HTX quyết định AI được giao việc cho ai:
--   tap_trung           — Ban quản trị phân công nhân lực và máy móc.
--   thanh_vien_chu_dong — thành viên tự làm trên thửa của mình; Ban quản trị
--                         chỉ điều phối máy móc, thiết bị dùng chung (drone...).
-- =====================================================================

CREATE TABLE IF NOT EXISTS plan_step_assignments (
  id             TEXT PRIMARY KEY,
  plan_step_id   TEXT NOT NULL,
  -- nhan_cong = giao cho người; may_moc = điều phối máy/thiết bị
  kind           TEXT NOT NULL,
  farmer_id      TEXT,
  machine_id     TEXT,
  role           TEXT,                    -- phu_trach | ho_tro | van_hanh_may
  planned_date   TEXT,
  hours          REAL,
  note           TEXT,
  -- da_giao | da_nhan | tu_choi | hoan_thanh | huy
  status         TEXT NOT NULL DEFAULT 'da_giao',
  responded_at   TEXT,
  decline_reason TEXT,
  assigned_by    TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (plan_step_id, farmer_id, machine_id),
  FOREIGN KEY (plan_step_id) REFERENCES production_plan_steps(id) ON DELETE CASCADE,
  FOREIGN KEY (farmer_id) REFERENCES farmers(id),
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);

-- =====================================================================
-- VẬT TƯ NÔNG NGHIỆP CỦA HTX: MUA SẮM → TỒN KHO → CẤP PHÁT
--
-- Khác hẳn module Procurement của ERP Mekong Green (mua rơm nguyên liệu).
-- Đây là chu trình nội bộ HTX cho phân bón và thuốc bảo vệ thực vật, gắn thẳng
-- vào thửa ruộng và bước kế hoạch để phục vụ truy xuất VietGAP: mỗi lần cấp
-- phát biết rõ lô vật tư nào, xuống thửa nào, cho bước nào.
-- =====================================================================

CREATE TABLE IF NOT EXISTS input_items (        -- Danh mục vật tư
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('phan_bon', 'thuoc_bvtv', 'giong', 'khac')),             -- phan_bon | thuoc_bvtv | giong | khac
  uom           TEXT NOT NULL DEFAULT 'kg',
  active_ingredient TEXT,                  -- hoạt chất (thuốc BVTV)
  -- Thời gian cách ly bắt buộc của hoạt chất — dùng để kiểm tra VietGAP.
  phi_days      INTEGER,
  -- Nằm trong danh mục được phép sử dụng hay không (VietGAP bắt buộc kiểm tra).
  permitted     INTEGER NOT NULL DEFAULT 1 CHECK (permitted IN (0, 1)),
  permit_ref    TEXT,
  htx_id        TEXT,                      -- NULL = danh mục dùng chung
  created_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS input_purchases (    -- Phiếu mua vật tư của HTX
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  htx_id        TEXT NOT NULL,
  supplier      TEXT,
  invoice_no    TEXT,
  purchase_date TEXT NOT NULL,
  -- nhap | da_nhan (đã nhập kho) | huy
  status        TEXT NOT NULL DEFAULT 'nhap',
  total_amount  INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS input_purchase_lines (
  id            TEXT PRIMARY KEY,
  purchase_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  batch_no      TEXT,
  expiry_date   TEXT,
  qty           REAL NOT NULL,
  unit_price    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (purchase_id) REFERENCES input_purchases(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES input_items(id)
);

CREATE TABLE IF NOT EXISTS input_stock (        -- Tồn kho theo LÔ, không gộp
  id            TEXT PRIMARY KEY,
  htx_id        TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  batch_no      TEXT,
  expiry_date   TEXT,
  qty_on_hand   REAL NOT NULL DEFAULT 0,
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  purchase_id   TEXT,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (item_id) REFERENCES input_items(id),
  FOREIGN KEY (purchase_id) REFERENCES input_purchases(id)
);

CREATE TABLE IF NOT EXISTS input_issues (       -- Phiếu cấp phát xuống thửa ruộng
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  htx_id        TEXT NOT NULL,
  stock_id      TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  plot_id       TEXT NOT NULL,
  crop_cycle_id TEXT NOT NULL,
  plan_step_id  TEXT,                      -- gắn với bước kế hoạch để truy xuất
  farmer_id     TEXT,                      -- người nhận vật tư
  qty           REAL NOT NULL,
  issue_date    TEXT NOT NULL,
  note          TEXT,
  issued_by     TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (stock_id) REFERENCES input_stock(id),
  FOREIGN KEY (item_id) REFERENCES input_items(id),
  FOREIGN KEY (plot_id) REFERENCES plots(id),
  FOREIGN KEY (crop_cycle_id) REFERENCES crop_cycles(id),
  FOREIGN KEY (plan_step_id) REFERENCES production_plan_steps(id)
);

-- =====================================================================
-- MẪU KHẢO SÁT THU THẬP DỮ LIỆU — App Khuyến nông
--
-- Khảo sát định kỳ (tuần/tháng) hoặc đột xuất. Mỗi phiếu trả lời gắn với hộ dân
-- hoặc HTX và địa chỉ hành chính chọn theo cấp: tỉnh → xã → thôn/ấp.
-- =====================================================================

CREATE TABLE IF NOT EXISTS survey_templates (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  purpose       TEXT,
  -- tuan | thang | dot_xuat
  frequency     TEXT NOT NULL DEFAULT 'dot_xuat',
  -- Phạm vi đối tượng: ho_dan | htx | ca_hai
  subject_scope TEXT NOT NULL DEFAULT 'ca_hai',
  org_node_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'nhap' CHECK (status IN ('nhap', 'ban_hanh', 'ngung')),   -- nhap | ban_hanh | ngung
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (org_node_id) REFERENCES org_nodes(id)
);

CREATE TABLE IF NOT EXISTS survey_questions (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  code          TEXT NOT NULL,
  label         TEXT NOT NULL,
  -- text | number | date | select | multiselect | boolean
  kind          TEXT NOT NULL DEFAULT 'text',
  uom           TEXT,
  options       TEXT,                      -- JSON mảng lựa chọn
  required      INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  help_text     TEXT,
  FOREIGN KEY (template_id) REFERENCES survey_templates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  template_id   TEXT NOT NULL,
  -- Kỳ khảo sát: 2026-W12 (tuần), 2026-04 (tháng), hoặc ngày với đợt đột xuất.
  period        TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,             -- ho_dan | htx
  farmer_id     TEXT,
  htx_id        TEXT,
  subject_name  TEXT NOT NULL,
  phone         TEXT,
  national_id   TEXT,
  tax_code      TEXT,
  province_id   TEXT,
  commune_id    TEXT,
  hamlet_id     TEXT,
  address_detail TEXT,
  lat           REAL,
  lng           REAL,
  -- Hai trường nghiệp vụ được hỏi ở mọi đợt khảo sát hiện trạng sản xuất.
  cycle_start_date TEXT,
  production_status TEXT,
  surveyed_at   TEXT NOT NULL,
  surveyed_by   TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (template_id, period, subject_kind, farmer_id, htx_id),
  FOREIGN KEY (template_id) REFERENCES survey_templates(id)
);

CREATE TABLE IF NOT EXISTS survey_answers (
  id            TEXT PRIMARY KEY,
  response_id   TEXT NOT NULL,
  question_id   TEXT NOT NULL,
  value_text    TEXT,
  value_number  REAL,
  FOREIGN KEY (response_id) REFERENCES survey_responses(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES survey_questions(id)
);

CREATE TABLE IF NOT EXISTS harvest_declarations ( -- FN-12: khai báo sản lượng sau thu hoạch
  id            TEXT PRIMARY KEY,
  crop_cycle_id TEXT NOT NULL,
  harvest_date  TEXT NOT NULL,
  paddy_tons    REAL NOT NULL DEFAULT 0,
  straw_tons    REAL NOT NULL DEFAULT 0,
  straw_state   TEXT,               -- rai_dong | da_cat | da_cuon_kien | san_sang_thu_gom
  moisture_pct  REAL,
  declared_by   TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (crop_cycle_id) REFERENCES crop_cycles(id)
);

CREATE TABLE IF NOT EXISTS gps_logs (           -- SYS-01: ghi nhận lịch sử toạ độ
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  context     TEXT NOT NULL,        -- ve_ranh_gioi | ghi_nhat_ky | xac_thuc_vi_tri
  ref_id      TEXT,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  REAL,
  captured_at TEXT NOT NULL
);

-- =====================================================================
-- 5. SÀN CƠ GIỚI HÓA (Rental Marketplace)
-- =====================================================================

CREATE TABLE IF NOT EXISTS rental_listings (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  machine_id     TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  price_per_ha   INTEGER NOT NULL DEFAULT 0,
  price_per_day  INTEGER NOT NULL DEFAULT 0,
  service_radius_km REAL NOT NULL DEFAULT 20,
  available_from TEXT,
  available_to   TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),  -- active | paused | closed
  created_at     TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);

CREATE TABLE IF NOT EXISTS rental_orders (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  listing_id     TEXT NOT NULL,
  renter_htx_id  TEXT NOT NULL,
  plot_id        TEXT,
  area_ha        REAL NOT NULL DEFAULT 0,
  scheduled_from TEXT NOT NULL,
  scheduled_to   TEXT NOT NULL,
  amount         INTEGER NOT NULL DEFAULT 0,
  platform_fee   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'dat_lich' CHECK (status IN ('dat_lich', 'xac_nhan', 'thuc_hien', 'hoan_thanh', 'tranh_chap', 'huy')), -- dat_lich | xac_nhan | thuc_hien | hoan_thanh | tranh_chap | huy
  escrow_status  TEXT NOT NULL DEFAULT 'chua_giu', -- chua_giu | dang_giu | da_giai_ngan | hoan_tien
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES rental_listings(id)
);

CREATE TABLE IF NOT EXISTS rental_disputes (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'mo' CHECK (status IN ('mo', 'dang_xu_ly', 'dong')),       -- mo | dang_xu_ly | dong
  resolution  TEXT,
  opened_by   TEXT,
  created_at  TEXT NOT NULL,
  closed_at   TEXT,
  FOREIGN KEY (order_id) REFERENCES rental_orders(id)
);

-- =====================================================================
-- 6. ERP — THAM SỐ MÔ PHỎNG & KỊCH BẢN ĐẦU TƯ
-- =====================================================================

-- FN-01: 49 tham số đầu vào, phân loại nguồn, min/base/max (chuẩn bị cho FN-18).
CREATE TABLE IF NOT EXISTS parameters (
  id             TEXT PRIMARY KEY,
  number         INTEGER NOT NULL UNIQUE,        -- STT 1..49
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  unit           TEXT,
  group_name     TEXT NOT NULL,
  classification TEXT NOT NULL,                  -- thi_truong | gia_dinh | khac
  value_base     REAL,
  value_min      REAL,
  value_max      REAL,
  text_value     TEXT,
  data_source    TEXT,                           -- BR-02: nguồn dữ liệu (nhóm thị trường)
  source_date    TEXT,
  approved_by    TEXT,                           -- BR-02: người phê duyệt (nhóm giả định)
  approved_at    TEXT,
  note           TEXT,
  updated_at     TEXT NOT NULL
);

-- FN-01 BR-03: mỗi lần lưu thay đổi tạo một phiên bản bộ tham số mới.
CREATE TABLE IF NOT EXISTS parameter_sets (
  id           TEXT PRIMARY KEY,
  version      INTEGER NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  note         TEXT,
  payload_json TEXT NOT NULL,                    -- snapshot toàn bộ 49 tham số
  checksum     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_hubs (      -- FN-02: Hub ứng viên
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  province_id TEXT,
  status      TEXT NOT NULL DEFAULT 'nhap' CHECK (status IN ('nhap', 'da_mo_phong')),      -- nhap | da_mo_phong
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenarios (           -- FN-14: kịch bản đầu tư (1..n Hub)
  id                 TEXT PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT,
  plant_id           TEXT NOT NULL,              -- nhà máy đầu ra (VFT)
  parameter_set_version INTEGER,                 -- BR-03/BR-04
  lifecycle_years    INTEGER NOT NULL DEFAULT 10,
  discounted         INTEGER NOT NULL DEFAULT 0, -- FN-12 BR-05: chế độ chiết khấu
  status             TEXT NOT NULL DEFAULT 'tham_khao' CHECK (status IN ('tham_khao', 'chinh_thuc')), -- tham_khao | chinh_thuc
  baseline_mode      TEXT NOT NULL DEFAULT 'no_hub',    -- no_hub | scenario | manual
  baseline_manual_cost_per_ton INTEGER,
  baseline_scenario_id TEXT,
  simulated_at       TEXT,
  created_by         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (baseline_scenario_id) REFERENCES scenarios(id)
);

-- FN-02 BR-03: cấu hình riêng theo cặp Hub–Kịch bản.
CREATE TABLE IF NOT EXISTS scenario_hubs (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL,
  hub_id           TEXT NOT NULL,
  service_radius_km REAL NOT NULL,
  design_capacity_tons REAL NOT NULL,
  mode_field_hub   TEXT NOT NULL DEFAULT 'auto', -- auto | road | waterway  (FN-08 BR-04c override)
  mode_hub_plant   TEXT NOT NULL DEFAULT 'auto',
  land_mode        TEXT NOT NULL DEFAULT 'mua',  -- mua | thue  (FN-10 BR-03)
  sort_order       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (scenario_id, hub_id),
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE,
  FOREIGN KEY (hub_id) REFERENCES candidate_hubs(id)
);

-- Kết quả mô phỏng đã lưu (TECH-05: truy vết quyết định đầu tư).
CREATE TABLE IF NOT EXISTS simulation_results (
  id            TEXT PRIMARY KEY,
  scenario_id   TEXT NOT NULL,
  parameter_set_version INTEGER NOT NULL,
  computed_at   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);

-- FN-18: kết quả phân tích độ nhạy.
CREATE TABLE IF NOT EXISTS sensitivity_results (
  id            TEXT PRIMARY KEY,
  scenario_id   TEXT NOT NULL,
  parameter_set_version INTEGER NOT NULL,
  computed_at   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  stale         INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);

-- FN-19: nhật ký kết xuất Hub sang Module Warehouse.
CREATE TABLE IF NOT EXISTS hub_handovers (
  id           TEXT PRIMARY KEY,
  scenario_id  TEXT NOT NULL,
  hub_id       TEXT NOT NULL,
  facility_id  TEXT,
  payload_json TEXT NOT NULL,
  exported_by  TEXT,
  exported_at  TEXT NOT NULL,
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id)
);

-- =====================================================================
-- 7. ERP — VẬN HÀNH (PO / SO / WAREHOUSE / TMS / FINANCE)
-- =====================================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  htx_id        TEXT NOT NULL,
  facility_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  season_id     TEXT,
  ordered_tons  REAL NOT NULL,
  unit_price    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'nhap' CHECK (status IN ('nhap', 'duyet', 'dang_giao', 'hoan_thanh', 'huy')),   -- nhap | duyet | dang_giao | hoan_thanh | huy
  expected_date TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  approved_by   TEXT,
  approved_at   TEXT
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  partner_id    TEXT NOT NULL,
  facility_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  ordered_tons  REAL NOT NULL,
  unit_price    INTEGER NOT NULL,
  delivery_date TEXT,
  status        TEXT NOT NULL DEFAULT 'nhap' CHECK (status IN ('nhap', 'xac_nhan', 'dang_giao', 'da_giao', 'hoan_tat')),   -- nhap | xac_nhan | dang_giao | da_giao | hoan_tat
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_notices (    -- WH FN-01: thông báo lô hàng đến từ TMS
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  facility_id   TEXT NOT NULL,
  po_id         TEXT,
  trip_id       TEXT,
  eta           TEXT,
  expected_tons REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'cho_den',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE IF NOT EXISTS weighings (          -- WH FN-02/FN-14/FN-30: cân điện tử
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  facility_id  TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),        -- in | out
  vehicle_code TEXT,
  gross_kg     REAL NOT NULL,
  tare_kg      REAL NOT NULL,
  net_kg       REAL NOT NULL,
  device_id    TEXT,
  weighed_at   TEXT NOT NULL,
  ref_id       TEXT
);

CREATE TABLE IF NOT EXISTS goods_receipts (     -- WH FN-04: GRN
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  po_id         TEXT,
  facility_id   TEXT NOT NULL,
  zone_id       TEXT,
  htx_id        TEXT,
  plot_id       TEXT,
  season_id     TEXT,
  weighing_id   TEXT,
  received_tons REAL NOT NULL,
  variance_tons REAL NOT NULL DEFAULT 0,
  moisture_pct  REAL,
  impurity_pct  REAL,
  harvest_date  TEXT,
  origin_lat    REAL,
  origin_lng    REAL,
  status        TEXT NOT NULL DEFAULT 'cho_duyet' CHECK (status IN ('cho_duyet', 'da_duyet', 'tu_choi')), -- cho_duyet | da_duyet | tu_choi
  approved_by   TEXT,
  approved_at   TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (zone_id) REFERENCES storage_zones(id),
  FOREIGN KEY (weighing_id) REFERENCES weighings(id),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id)
);

CREATE TABLE IF NOT EXISTS goods_issues (       -- WH FN-13: phiếu xuất kho
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  so_id        TEXT,
  facility_id  TEXT NOT NULL,
  issued_tons  REAL NOT NULL,
  weighing_id  TEXT,
  trip_id      TEXT,
  status       TEXT NOT NULL DEFAULT 'cho_duyet',
  approved_by  TEXT,
  approved_at  TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (weighing_id) REFERENCES weighings(id),
  FOREIGN KEY (so_id) REFERENCES sales_orders(id),
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE IF NOT EXISTS stock_lots (         -- Lô tồn kho, gắn nguồn gốc MRV
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  facility_id   TEXT NOT NULL,
  zone_id       TEXT,
  grn_id        TEXT,
  htx_id        TEXT,
  plot_id       TEXT,
  item_id       TEXT NOT NULL,
  quantity_tons REAL NOT NULL,
  remaining_tons REAL NOT NULL,
  received_at   TEXT NOT NULL,
  moisture_pct  REAL,
  risk_score    REAL NOT NULL DEFAULT 0,  -- WH FN-12: điểm rủi ro xuống cấp
  status        TEXT NOT NULL DEFAULT 'ton',
  FOREIGN KEY (zone_id) REFERENCES storage_zones(id),
  FOREIGN KEY (grn_id) REFERENCES goods_receipts(id)
);

-- Review kiến trúc 24/09/2026 (A03/R3): nguồn sự thật duy nhất của tồn kho là LÔ; mọi thay đổi
-- remaining_tons đi qua sổ vận động bất biến; tổng tồn cơ sở là số chiếu (projection) dựng lại được.
CREATE TABLE IF NOT EXISTS stock_movements (
  id            TEXT PRIMARY KEY,
  facility_id   TEXT NOT NULL,
  lot_id        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('nhap', 'xuat', 'dieu_chinh', 'chuyen', 'dao', 'ton_dau_ky')),
  quantity_tons REAL NOT NULL CHECK (quantity_tons <> 0),   -- dương = tăng lô, âm = giảm lô
  ref_type      TEXT,                                      -- goods_receipt | goods_issue | stocktake | opening
  ref_id        TEXT,
  note          TEXT,
  occurred_at   TEXT NOT NULL,
  recorded_by   TEXT,
  FOREIGN KEY (lot_id) REFERENCES stock_lots(id)
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_lot ON stock_movements(lot_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_facility ON stock_movements(facility_id, occurred_at);

CREATE TABLE IF NOT EXISTS issue_allocations (  -- Phiếu xuất lấy bao nhiêu tấn từ lô nào (thay JSON "consumed" trong nhật ký)
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL,
  lot_id     TEXT NOT NULL,
  tons       REAL NOT NULL CHECK (tons > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES goods_issues(id),
  FOREIGN KEY (lot_id) REFERENCES stock_lots(id)
);
CREATE INDEX IF NOT EXISTS idx_issue_allocations_issue ON issue_allocations(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_allocations_lot ON issue_allocations(lot_id);

CREATE TABLE IF NOT EXISTS env_readings (       -- WH FN-08/FN-31: cảm biến IoT
  id          TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL,
  zone_id     TEXT,
  sensor_id   TEXT NOT NULL,
  humidity_pct REAL,
  temp_c      REAL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (zone_id) REFERENCES storage_zones(id)
);
CREATE INDEX IF NOT EXISTS idx_env_zone_time ON env_readings(zone_id, recorded_at);

CREATE TABLE IF NOT EXISTS env_thresholds (     -- WH FN-37
  id            TEXT PRIMARY KEY,
  facility_id   TEXT,
  humidity_warn REAL NOT NULL DEFAULT 18,
  humidity_crit REAL NOT NULL DEFAULT 22,
  temp_warn     REAL NOT NULL DEFAULT 40,
  temp_crit     REAL NOT NULL DEFAULT 55,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS env_alerts (         -- WH FN-10
  id          TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL,
  zone_id     TEXT,
  level       TEXT NOT NULL CHECK (level IN ('canh_bao', 'nguy_hiem')),        -- canh_bao | nguy_hiem
  metric      TEXT NOT NULL,        -- humidity | temperature
  value       REAL NOT NULL,
  threshold   REAL NOT NULL,
  message     TEXT NOT NULL,
  raised_at   TEXT NOT NULL,
  acknowledged_at TEXT,
  FOREIGN KEY (zone_id) REFERENCES storage_zones(id)
);

CREATE TABLE IF NOT EXISTS stocktakes (         -- WH FN-20..23
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  facility_id  TEXT NOT NULL,
  zone_id      TEXT,
  planned_for  TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'dinh_ky',
  status       TEXT NOT NULL DEFAULT 'ke_hoach' CHECK (status IN ('ke_hoach', 'dang_kiem', 'cho_duyet', 'da_duyet')), -- ke_hoach | dang_kiem | cho_duyet | da_duyet
  book_tons    REAL,
  counted_tons REAL,
  variance_tons REAL,
  reason       TEXT,
  approved_by  TEXT,
  approved_at  TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (zone_id) REFERENCES storage_zones(id)
);

CREATE TABLE IF NOT EXISTS trips (              -- TMS: chuyến vận chuyển
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  mode          TEXT NOT NULL,       -- road | waterway
  vehicle_code  TEXT,
  driver_name   TEXT,
  from_lat      REAL NOT NULL,
  from_lng      REAL NOT NULL,
  to_lat        REAL NOT NULL,
  to_lng        REAL NOT NULL,
  from_label    TEXT,
  to_label      TEXT,
  distance_km   REAL NOT NULL DEFAULT 0,
  planned_tons  REAL NOT NULL DEFAULT 0,
  actual_tons   REAL NOT NULL DEFAULT 0,
  planned_cost  INTEGER NOT NULL DEFAULT 0,
  actual_cost   INTEGER NOT NULL DEFAULT 0,
  co2_kg        REAL NOT NULL DEFAULT 0,
  departed_at   TEXT,
  arrived_at    TEXT,
  status        TEXT NOT NULL DEFAULT 'ke_hoach' CHECK (status IN ('ke_hoach', 'dang_chay', 'hoan_thanh', 'huy')), -- ke_hoach | dang_chay | hoan_thanh | huy
  ref_type      TEXT,
  ref_id        TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_documents (     -- ePOD / e-bill
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- epod | ebill
  code       TEXT NOT NULL UNIQUE,
  signer     TEXT,
  signed_at  TEXT,
  payload_json TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (     -- Finance: AR/AP + doanh thu nền tảng
  id          TEXT PRIMARY KEY,
  entry_date  TEXT NOT NULL,
  account     TEXT NOT NULL CHECK (account IN ('AP', 'AR', 'REVENUE', 'EXPENSE', 'CAPEX')),          -- AP | AR | REVENUE | EXPENSE | CAPEX
  partner_id  TEXT,
  htx_id      TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  facility_id TEXT,
  amount      INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'VND',
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'ghi_so' CHECK (status IN ('ghi_so', 'da_thanh_toan', 'qua_han')),  -- ghi_so | da_thanh_toan | qua_han
  due_date    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue_rules (      -- Finance Revenue Engine
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- transaction_fee | subscription | carbon_share
  rate_pct     REAL,
  fixed_amount INTEGER,
  applies_to   TEXT,                  -- rental | straw_trade | carbon
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS mrv_records (        -- Traceability & MRV Data Bridge
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  source_module TEXT NOT NULL,        -- warehouse | tms | po | so
  ref_type     TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  htx_id       TEXT,
  plot_id      TEXT,
  lat          REAL,
  lng          REAL,
  occurred_at  TEXT NOT NULL,
  quantity_tons REAL NOT NULL DEFAULT 0,
  co2_avoided_kg REAL NOT NULL DEFAULT 0,
  co2_emitted_kg REAL NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Review kiến trúc 24/09/2026 (A07): mỗi phiên bản lược đồ đã áp lên tệp được ghi lại kèm băm nội dung,
-- số bảng dựng lại/bỏ qua — đối chiếu được "cài mới" và "nâng cấp" có cùng lược đồ hay không.
-- Đánh giá bảo mật 24/09/2026 (H-04, M-01): bộ đếm giới hạn tốc độ (cổng truy cập, đăng nhập theo IP) — bền qua
-- khởi động lại và dùng chung giữa các tiến trình, thay cho Map trong RAM.
-- Liên kết đặt lại mật khẩu một lần (email đặt lại SAdmin khi khởi động / reset-sadmin). Chỉ lưu digest.
CREATE TABLE IF NOT EXISTS password_resets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  reason       TEXT NOT NULL CHECK (reason IN ('startup', 'operator_reset', 'created', 'admin_request')),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, used_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version        TEXT NOT NULL,
  checksum       TEXT NOT NULL UNIQUE,
  applied_at     TEXT NOT NULL,
  rebuilt_tables INTEGER NOT NULL DEFAULT 0,
  skipped_tables INTEGER NOT NULL DEFAULT 0,
  notes          TEXT
);

-- =====================================================================
-- 8. BỔ SUNG THEO BRD / USER STORY 09-2026
-- =====================================================================

-- HTX US-CAT-01 / US-SEASON-01: danh mục giống lúa dùng chung; mở vụ chọn giống từ đây,
-- hệ thống tự gán quy trình SOP mặc định theo giống. Ngưỡng năng suất dùng cho US-YIELD-03.
CREATE TABLE IF NOT EXISTS rice_varieties (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  growth_days         INTEGER NOT NULL DEFAULT 95,
  yield_min_t_ha      REAL NOT NULL DEFAULT 4,
  yield_max_t_ha      REAL NOT NULL DEFAULT 9,
  default_protocol_id TEXT,
  status              TEXT NOT NULL DEFAULT 'active',    -- active | hidden
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- KN US-HTX-04: cán bộ khuyến nông khai báo máy móc cơ giới hoá và số lượng của từng HTX.
CREATE TABLE IF NOT EXISTS htx_machinery_declarations (
  id              TEXT PRIMARY KEY,
  htx_id          TEXT NOT NULL,
  machine_type_id TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  declared_by     TEXT,
  declared_at     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (htx_id, machine_type_id)
);

-- KN US-PRICE-04: danh sách mặt hàng theo dõi theo ngưỡng biến động của từng tài khoản.
CREATE TABLE IF NOT EXISTS price_watchlist (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  commodity     TEXT NOT NULL,
  threshold_pct REAL NOT NULL DEFAULT 5,
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, commodity)
);

-- CGH US-ANL-01 / US-RPT-02 / FN-09 BR-05: kết quả cân đối LƯU theo vụ để đối chiếu & xu hướng,
-- báo cáo đọc số đã lưu, không tính lại tại thời điểm xuất.
CREATE TABLE IF NOT EXISTS cgh_balance_snapshots (
  id           TEXT PRIMARY KEY,
  season_id    TEXT NOT NULL,
  season_name  TEXT NOT NULL,
  computed_at  TEXT NOT NULL,
  computed_by  TEXT,
  summary_json TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cgh_balance_season ON cgh_balance_snapshots(season_id, computed_at);

-- US-CFG-03: ngưỡng cảnh báo cung–cầu có phiên bản theo ngày hiệu lực. Trước đây là một
-- mảng JSON trong system_config (nguyên tắc 6, rà soát 24/09/2026) — nay mỗi phiên bản một dòng.
CREATE TABLE IF NOT EXISTS cgh_coverage_thresholds (
  id             TEXT PRIMARY KEY,
  effective_from TEXT NOT NULL UNIQUE,
  can_chu_y      REAL NOT NULL,
  du             REAL NOT NULL,
  thua           REAL NOT NULL,
  document_ref   TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT,
  CHECK (can_chu_y < du AND du < thua)
);

-- KN US-DASH-03 / HTX US-DASH-03: lịch tự tổng hợp & gửi báo cáo định kỳ qua email.
CREATE TABLE IF NOT EXISTS report_schedules (
  id          TEXT PRIMARY KEY,
  system      TEXT NOT NULL,          -- kn | htx | cgh
  scope_id    TEXT,                   -- htx_id / province_id, NULL = toàn hệ thống
  report      TEXT NOT NULL,          -- mã báo cáo
  frequency   TEXT NOT NULL,          -- tuan | thang | quy
  emails      TEXT NOT NULL,          -- danh sách email, phân tách bằng dấu phẩy
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by  TEXT,
  created_at  TEXT NOT NULL
);
`;
