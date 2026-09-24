/**
 * MIỀN DỮ LIỆU — mỗi hệ thống con một cơ sở dữ liệu riêng, dữ liệu dùng chung ở một nơi.
 *
 * Trước đây toàn bộ 98 bảng nằm trong MỘT tệp SQLite. Về mặt vận hành điều đó nghĩa
 * là: sao lưu App HTX là sao lưu luôn sổ cái ERP; tách Cổng Khuyến nông ra một máy
 * chủ riêng là không thể; một tỉnh muốn giữ dữ liệu khuyến nông của mình trên hạ
 * tầng của họ cũng không thể.
 *
 * Nay mỗi miền là một TỆP riêng:
 *   shared   dữ liệu dùng chung — định danh, tài khoản, đơn vị hành chính, HTX, thửa,
 *            máy móc, cơ sở (Hub/nhà máy), nhật ký truy vết, thông báo
 *   kn / htx / cgh / gis / erp / field   dữ liệu riêng của từng hệ thống con
 *
 * Cùng một tiến trình, các tệp được ATTACH vào một kết nối nên mã nghiệp vụ vẫn JOIN
 * xuyên miền như cũ (SQLite phân giải tên bảng không tiền tố qua mọi tệp đã gắn).
 * Ràng buộc FOREIGN KEY xuyên miền bị gỡ lúc migrate — SQLite không cho khoá ngoại
 * trỏ sang tệp khác — nên tính toàn vẹn xuyên miền do tầng nghiệp vụ giữ, đúng như
 * khi các hệ thống này tách ra chạy riêng.
 *
 * Luồng đồng bộ dữ liệu dùng chung: xem `platform/sync/sharedFlows.ts`.
 */

export type Domain = 'shared' | 'kn' | 'htx' | 'cgh' | 'gis' | 'erp' | 'field';

export const DOMAINS: { code: Domain; label: string; description: string }[] = [
  { code: 'shared', label: 'Dữ liệu dùng chung', description: 'Định danh, tài khoản, phân quyền, đơn vị hành chính, HTX, thửa ruộng, máy móc, cơ sở, nhật ký truy vết, thông báo' },
  { code: 'kn', label: 'Hệ thống Khuyến nông', description: 'Cây tổ chức, thư viện kỹ thuật, nhiệm vụ, khảo sát, giá thị trường, đào tạo' },
  { code: 'htx', label: 'Hệ thống Hợp tác xã', description: 'Vụ canh tác, nhật ký, quy trình VietGAP, kế hoạch sản xuất, vật tư, khai báo sản lượng' },
  { code: 'cgh', label: 'Hệ thống Cơ giới hoá', description: 'Định mức, kế hoạch canh tác, sàn cho thuê máy' },
  { code: 'gis', label: 'Nền tảng GIS', description: 'Lớp bản đồ, tuyến đường thuỷ, công trình, bộ đệm khoảng cách' },
  { code: 'erp', label: 'ERP nội bộ Mekong Green', description: 'Mô phỏng đầu tư, kho, mua bán, vận tải, tài chính, MRV, hợp đồng rơm, phiếu mua, ghe' },
  { code: 'field', label: 'Hệ thống Hiện trường', description: 'Đội thu gom, phương tiện, việc thu gom, công đoạn, lượt ghe' },
];

/** Bảng nào thuộc miền nào. Bảng mới PHẢI được khai ở đây — test sẽ bắt bảng chưa xếp miền. */
export const TABLE_DOMAIN: Record<string, Domain> = {
  // ---- dùng chung ----
  users: 'shared', user_roles: 'shared', user_groups: 'shared', group_permissions: 'shared', admin_scopes: 'shared',
  sessions: 'shared', event_log: 'shared', daily_snapshots: 'shared', retention_policy: 'shared', sync_log: 'shared',
  shared_sync_cursor: 'shared', system_config: 'shared', schema_migrations: 'shared', rate_limits: 'shared', password_resets: 'shared', request_log: 'shared', attachments: 'shared', notifications: 'shared',
  admin_units: 'shared', cooperatives: 'shared', farmers: 'shared', plots: 'shared', seasons: 'shared',
  harvest_statistics: 'shared', crop_status: 'shared', commune_crop_seasons: 'shared', commune_harvest_progress: 'shared',
  weather_observations: 'shared', facilities: 'shared', partners: 'shared', items: 'shared',
  machine_types: 'shared', machine_owners: 'shared', machines: 'shared',
  rice_varieties: 'shared', report_schedules: 'shared',
  // ---- khuyến nông ----
  org_nodes: 'kn', knowledge_articles: 'kn', support_tasks: 'kn', extension_officers: 'kn', market_prices: 'kn',
  training_courses: 'kn', training_enrollments: 'kn', survey_templates: 'kn', survey_questions: 'kn', survey_responses: 'kn', survey_answers: 'kn',
  htx_machinery_declarations: 'kn', price_watchlist: 'kn',
  // ---- hợp tác xã ----
  crop_cycles: 'htx', farm_logs: 'htx', production_protocols: 'htx', protocol_steps: 'htx', production_plans: 'htx',
  production_plan_steps: 'htx', plan_step_evidence: 'htx', plan_step_assignments: 'htx', input_items: 'htx', input_purchases: 'htx',
  input_purchase_lines: 'htx', input_stock: 'htx', input_issues: 'htx', harvest_declarations: 'htx', gps_logs: 'htx',
  // ---- cơ giới hoá ----
  productivity_norms: 'cgh', cultivation_plans: 'cgh', rental_listings: 'cgh', rental_orders: 'cgh', rental_disputes: 'cgh',
  cgh_balance_snapshots: 'cgh', cgh_coverage_thresholds: 'cgh',
  // ---- GIS ----
  gis_layers: 'gis', transport_routes: 'gis', waterway_structures: 'gis', distance_cache: 'gis',
  // ---- ERP ----
  parameters: 'erp', parameter_sets: 'erp', candidate_hubs: 'erp', scenarios: 'erp', scenario_hubs: 'erp', simulation_results: 'erp',
  sensitivity_results: 'erp', hub_handovers: 'erp', purchase_orders: 'erp', sales_orders: 'erp', inbound_notices: 'erp', weighings: 'erp',
  goods_receipts: 'erp', goods_issues: 'erp', stock_lots: 'erp', stock_movements: 'erp', issue_allocations: 'erp', storage_zones: 'erp', env_readings: 'erp', env_thresholds: 'erp',
  env_alerts: 'erp', stocktakes: 'erp', trips: 'erp', trip_documents: 'erp', ledger_entries: 'erp', revenue_rules: 'erp', mrv_records: 'erp',
  straw_contracts: 'erp', straw_purchase_tickets: 'erp', vessels: 'erp',
  // ---- hiện trường ----
  field_teams: 'field', field_team_members: 'field', field_vehicles: 'field', field_jobs: 'field', field_job_stages: 'field', field_stage_evidence: 'field', field_loadings: 'field',
};

export function domainOf(table: string): Domain {
  const domain = TABLE_DOMAIN[table];
  if (!domain) throw new Error(`Bảng "${table}" chưa được xếp vào miền dữ liệu nào — khai báo trong platform/db/domains.ts trước.`);
  return domain;
}

export function tablesOf(domain: Domain): string[] {
  return Object.entries(TABLE_DOMAIN).filter(([, d]) => d === domain).map(([t]) => t).sort();
}

/**
 * Viết lại một câu DDL của lược đồ hợp nhất cho miền của bảng:
 *   CREATE TABLE x (...)           → CREATE TABLE <miền>.x (...), gỡ FOREIGN KEY trỏ sang miền khác
 *   CREATE INDEX i ON x (...)      → CREATE INDEX <miền>.i ON x (...)
 * Câu khác giữ nguyên.
 */
/** Tên schema SQLite của miền: tệp dùng chung mở làm `main`, các miền khác được ATTACH đúng tên. */
export const schemaOf = (domain: Domain): string => (domain === 'shared' ? 'main' : domain);

/**
 * Quan hệ cha–con nằm ở hai tệp khác nhau — SQLite không cho khoá ngoại trỏ sang tệp khác
 * (FOREIGN KEY khai trong SCHEMA bị qualifyStatement gỡ). `db.insert/update/upsert` kiểm danh
 * sách này trước khi ghi, và `integrity.findOrphans()` rà định kỳ (rà soát CSDL 24/09/2026, NT 4).
 * Quan hệ CÙNG miền được khai FOREIGN KEY thật trong SCHEMA và SQLite tự kiểm.
 */
export const CROSS_DOMAIN_REFS: { table: string; column: string; parent: string }[] = [
  { table: 'crop_cycles', column: 'plot_id', parent: 'plots' },
  { table: 'crop_cycles', column: 'season_id', parent: 'seasons' },
  { table: 'production_protocols', column: 'htx_id', parent: 'cooperatives' },
  { table: 'plan_step_assignments', column: 'farmer_id', parent: 'farmers' },
  { table: 'plan_step_assignments', column: 'machine_id', parent: 'machines' },
  { table: 'input_items', column: 'htx_id', parent: 'cooperatives' },
  { table: 'input_purchases', column: 'htx_id', parent: 'cooperatives' },
  { table: 'input_stock', column: 'htx_id', parent: 'cooperatives' },
  { table: 'input_issues', column: 'htx_id', parent: 'cooperatives' },
  { table: 'input_issues', column: 'plot_id', parent: 'plots' },
  { table: 'productivity_norms', column: 'machine_type_id', parent: 'machine_types' },
  { table: 'rental_listings', column: 'machine_id', parent: 'machines' },
  { table: 'storage_zones', column: 'facility_id', parent: 'facilities' },
  { table: 'straw_contracts', column: 'htx_id', parent: 'cooperatives' },
  { table: 'straw_purchase_tickets', column: 'job_id', parent: 'field_jobs' },
  { table: 'users', column: 'org_node_id', parent: 'org_nodes' },
  { table: 'field_teams', column: 'leader_user_id', parent: 'users' },
  { table: 'field_teams', column: 'province_id', parent: 'admin_units' },
  { table: 'field_vehicles', column: 'machine_id', parent: 'machines' },
  { table: 'field_jobs', column: 'crop_cycle_id', parent: 'crop_cycles' },
  { table: 'field_jobs', column: 'plot_id', parent: 'plots' },
  { table: 'field_jobs', column: 'htx_id', parent: 'cooperatives' },
  { table: 'field_jobs', column: 'destination_facility_id', parent: 'facilities' },
  { table: 'field_loadings', column: 'destination_facility_id', parent: 'facilities' },
  { table: 'field_loadings', column: 'trip_id', parent: 'trips' },
  { table: 'straw_purchase_tickets', column: 'htx_id', parent: 'cooperatives' },
  { table: 'cultivation_plans', column: 'htx_id', parent: 'cooperatives' },
  { table: 'cultivation_plans', column: 'season_id', parent: 'seasons' },
  { table: 'transport_routes', column: 'province_id', parent: 'admin_units' },
  { table: 'org_nodes', column: 'admin_unit_id', parent: 'admin_units' },
  { table: 'knowledge_articles', column: 'author_id', parent: 'users' },
  { table: 'support_tasks', column: 'htx_id', parent: 'cooperatives' },
  { table: 'support_tasks', column: 'farmer_id', parent: 'farmers' },
  { table: 'support_tasks', column: 'plot_id', parent: 'plots' },
  { table: 'support_tasks', column: 'assignee_id', parent: 'users' },
  { table: 'extension_officers', column: 'user_id', parent: 'users' },
  { table: 'training_enrollments', column: 'htx_id', parent: 'cooperatives' },
  { table: 'input_issues', column: 'farmer_id', parent: 'farmers' },
  { table: 'survey_responses', column: 'farmer_id', parent: 'farmers' },
  { table: 'survey_responses', column: 'htx_id', parent: 'cooperatives' },
  { table: 'survey_responses', column: 'province_id', parent: 'admin_units' },
  { table: 'survey_responses', column: 'commune_id', parent: 'admin_units' },
  { table: 'survey_responses', column: 'hamlet_id', parent: 'admin_units' },
  { table: 'gps_logs', column: 'user_id', parent: 'users' },
  { table: 'rental_listings', column: 'owner_id', parent: 'machine_owners' },
  { table: 'rental_orders', column: 'renter_htx_id', parent: 'cooperatives' },
  { table: 'rental_orders', column: 'plot_id', parent: 'plots' },
  { table: 'candidate_hubs', column: 'province_id', parent: 'admin_units' },
  { table: 'hub_handovers', column: 'facility_id', parent: 'facilities' },
  { table: 'facilities', column: 'origin_scenario_id', parent: 'scenarios' },
  { table: 'scenarios', column: 'plant_id', parent: 'facilities' },
  { table: 'purchase_orders', column: 'htx_id', parent: 'cooperatives' },
  { table: 'purchase_orders', column: 'facility_id', parent: 'facilities' },
  { table: 'purchase_orders', column: 'item_id', parent: 'items' },
  { table: 'purchase_orders', column: 'season_id', parent: 'seasons' },
  { table: 'sales_orders', column: 'partner_id', parent: 'partners' },
  { table: 'sales_orders', column: 'facility_id', parent: 'facilities' },
  { table: 'sales_orders', column: 'item_id', parent: 'items' },
  { table: 'inbound_notices', column: 'facility_id', parent: 'facilities' },
  { table: 'weighings', column: 'facility_id', parent: 'facilities' },
  { table: 'goods_receipts', column: 'facility_id', parent: 'facilities' },
  { table: 'goods_receipts', column: 'htx_id', parent: 'cooperatives' },
  { table: 'goods_receipts', column: 'plot_id', parent: 'plots' },
  { table: 'goods_receipts', column: 'season_id', parent: 'seasons' },
  { table: 'goods_issues', column: 'facility_id', parent: 'facilities' },
  { table: 'stock_lots', column: 'facility_id', parent: 'facilities' },
  { table: 'stock_lots', column: 'htx_id', parent: 'cooperatives' },
  { table: 'stock_lots', column: 'plot_id', parent: 'plots' },
  { table: 'stock_lots', column: 'item_id', parent: 'items' },
  { table: 'env_readings', column: 'facility_id', parent: 'facilities' },
  { table: 'env_thresholds', column: 'facility_id', parent: 'facilities' },
  { table: 'env_alerts', column: 'facility_id', parent: 'facilities' },
  { table: 'stocktakes', column: 'facility_id', parent: 'facilities' },
  { table: 'ledger_entries', column: 'partner_id', parent: 'partners' },
  { table: 'ledger_entries', column: 'htx_id', parent: 'cooperatives' },
  { table: 'ledger_entries', column: 'facility_id', parent: 'facilities' },
  { table: 'mrv_records', column: 'htx_id', parent: 'cooperatives' },
  { table: 'mrv_records', column: 'plot_id', parent: 'plots' },
  { table: 'htx_machinery_declarations', column: 'htx_id', parent: 'cooperatives' },
  { table: 'htx_machinery_declarations', column: 'machine_type_id', parent: 'machine_types' },
  { table: 'price_watchlist', column: 'user_id', parent: 'users' },
  { table: 'cgh_balance_snapshots', column: 'season_id', parent: 'seasons' },
  { table: 'rice_varieties', column: 'default_protocol_id', parent: 'production_protocols' },
];
const REFS_BY_TABLE = new Map<string, { column: string; parent: string }[]>();
for (const ref of CROSS_DOMAIN_REFS) REFS_BY_TABLE.set(ref.table, [...(REFS_BY_TABLE.get(ref.table) ?? []), ref]);
export const crossDomainRefsOf = (table: string) => REFS_BY_TABLE.get(table) ?? [];

export function qualifyStatement(statement: string): string {
  const table = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement);
  if (table) {
    const domain = domainOf(table[1]);
    let body = statement.replace(/CREATE TABLE IF NOT EXISTS (\w+)/, `CREATE TABLE IF NOT EXISTS ${schemaOf(domain)}.$1`);
    // Gỡ FOREIGN KEY xuyên miền — SQLite không cho khoá ngoại trỏ sang tệp khác.
    body = body.replace(/^\s*FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+(\w+)\s*\([^)]*\)\s*,?\s*(--.*)?$/gm, (line, ref: string) =>
      (domainOf(ref) === domain ? line : ''));
    // Dấu phẩy treo trước dấu đóng ngoặc sau khi gỡ dòng cuối. splitStatements đã bỏ chú thích nên chỉ còn
    // khoảng trắng giữa dấu phẩy và ')' — biểu thức đơn giản, không lồng quantifier (CodeQL js/redos).
    body = body.replace(/,(\s*)\)\s*;?\s*$/, '$1)');
    return body;
  }
  const index = /CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)/.exec(statement);
  if (index) {
    const domain = domainOf(index[3]);
    return statement.replace(/CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON/, `CREATE $1INDEX IF NOT EXISTS ${schemaOf(domain)}.$2 ON`);
  }
  return statement;
}

/**
 * Tách lược đồ hợp nhất thành từng câu lệnh. Bỏ chú thích TRƯỚC rồi mới tách theo
 * `;` — chú thích tiếng Việt trong lược đồ có dấu chấm phẩy ("không đổi tên được;"),
 * tách trước sẽ cắt câu CREATE giữa chừng.
 */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
  return withoutComments
    .split(/;\s*\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => /\S/.test(chunk));
}
