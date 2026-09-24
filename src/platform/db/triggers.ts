/**
 * Trigger cấp cơ sở dữ liệu — lưới an toàn nhật ký sự kiện.
 *
 * Mọi phân hệ đã gọi `logEvent()` từ tầng nghiệp vụ (~274 điểm gọi). Trigger ở đây
 * là LƯỚI AN TOÀN: nếu một đường mà nào quên gọi `logEvent()`, trigger vẫn ghi lại
 * thay đổi vào `event_log` với `source = 'system'` và `note = 'db_trigger'`.
 *
 * Nguyên tắc:
 *  - AFTER INSERT: ghi `action = 'create'`, `after_json` = NEW row
 *  - AFTER UPDATE: ghi `action = 'update'`, `before_json` = OLD row, `after_json` = NEW row
 *    Chỉ ghi khi ít nhất một cột khác `updated_at` thay đổi (tránh ghi rác khi chỉ touch timestamp)
 *  - Không ghi trigger cho `event_log` (tránh đệ quy vô hạn) và các bảng kỹ thuật
 *    (sessions, request_log, rate_limits, sync_log, schema_migrations, distance_cache)
 *  - `module` suy từ miền dữ liệu (domains.ts)
 *  - Mỗi trigger sử dụng `json_object()` để tuần tự hoá NEW/OLD dựa trên cột thật của bảng
 *    (đọc PRAGMA table_info tại lúc migrate → trigger luôn khớp lược đồ hiện tại)
 */
import { db, all } from './db.ts';
import { TABLE_DOMAIN, schemaOf, domainOf, type Domain } from './domains.ts';

/** Bảng không cần trigger (kỹ thuật/nhật ký/tạm). */
const EXCLUDED_TABLES = new Set([
  'event_log', 'daily_snapshots', 'retention_policy', 'sync_log',
  'schema_migrations', 'sessions', 'request_log', 'rate_limits',
  'distance_cache', 'shared_sync_cursor', 'system_config',
  'password_resets', 'gps_logs',
]);

/** Ánh xạ miền → module name cho event_log. */
const DOMAIN_MODULE: Record<Domain, string> = {
  shared: 'platform',
  kn: 'khuyennong',
  htx: 'htx',
  cgh: 'cgh',
  gis: 'gis',
  erp: 'erp',
  field: 'field',
};

interface ColumnInfo {
  name: string;
  type: string;
}

/**
 * Lấy danh sách cột của một bảng từ PRAGMA table_info.
 * Schema phải khớp với tệp đã ATTACH (main cho shared, tên miền cho miền khác).
 */
function tableColumns(table: string, schema: string): ColumnInfo[] {
  return all<{ name: string; type: string }>(`PRAGMA ${schema}.table_info(${table})`);
}

/**
 * Tạo biểu thức `json_object(...)` từ danh sách cột, dùng tiền tố NEW hoặc OLD.
 * Ví dụ: `json_object('id', NEW.id, 'name', NEW.name, 'status', NEW.status)`
 */
function jsonObjectExpr(columns: ColumnInfo[], prefix: 'NEW' | 'OLD'): string {
  const pairs = columns.map((col) => `'${col.name}', ${prefix}.${col.name}`);
  return `json_object(${pairs.join(', ')})`;
}

/**
 * Tạo biểu thức WHERE so sánh OLD và NEW để chỉ ghi khi có thay đổi thật sự.
 * Bỏ qua `updated_at` vì cột này hầu như luôn thay đổi theo mỗi UPDATE.
 */
function changeDetectionExpr(columns: ColumnInfo[]): string {
  const comparisons = columns
    .filter((col) => col.name !== 'updated_at')
    .map((col) => `OLD.${col.name} IS NOT NEW.${col.name}`);
  return comparisons.length ? comparisons.join(' OR ') : '1';
}

/**
 * Tạo tất cả trigger AFTER INSERT và AFTER UPDATE cho các bảng nghiệp vụ.
 *
 * Gọi từ `migrate()` trong `schema.ts` SAU KHI bảng đã sẵn sàng.
 * Trigger được tạo bằng `CREATE TRIGGER IF NOT EXISTS` và bị huỷ + tạo lại
 * nếu lược đồ bảng thay đổi (đảm bảo json_object luôn khớp cột hiện tại).
 */
export function createAuditTriggers(): { created: number; skipped: string[] } {
  const handle = db();
  let created = 0;
  const skipped: string[] = [];

  for (const [table, domain] of Object.entries(TABLE_DOMAIN)) {
    if (EXCLUDED_TABLES.has(table)) continue;

    const schema = schemaOf(domain);
    const module = DOMAIN_MODULE[domain];

    // Đọc cột hiện tại của bảng.
    const columns = tableColumns(table, schema);
    if (!columns.length) {
      skipped.push(`${table} (bảng chưa tồn tại)`);
      continue;
    }

    // Cột khoá chính (thường là 'id').
    const pkCol = columns.find((c) => c.name === 'id') ?? columns[0];

    const newJson = jsonObjectExpr(columns, 'NEW');
    const oldJson = jsonObjectExpr(columns, 'OLD');
    const changeWhere = changeDetectionExpr(columns);

    // -- AFTER INSERT trigger --
    const trigInsert = `trg_${table}_ai`;
    handle.exec(`DROP TRIGGER IF EXISTS ${schema}.${trigInsert}`);
    handle.exec(`
      CREATE TRIGGER ${schema}.${trigInsert}
      AFTER INSERT ON ${table}
      FOR EACH ROW
      BEGIN
        INSERT INTO main.event_log (occurred_at, actor_id, actor_name, module, entity_type, entity_id, action, after_json, source, note)
        VALUES (
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          NULL,
          'system',
          '${module}',
          '${table}',
          NEW.${pkCol.name},
          'create',
          ${newJson},
          'system',
          'db_trigger'
        );
      END
    `);

    // -- AFTER UPDATE trigger --
    const trigUpdate = `trg_${table}_au`;
    handle.exec(`DROP TRIGGER IF EXISTS ${schema}.${trigUpdate}`);
    handle.exec(`
      CREATE TRIGGER ${schema}.${trigUpdate}
      AFTER UPDATE ON ${table}
      FOR EACH ROW
      WHEN ${changeWhere}
      BEGIN
        INSERT INTO main.event_log (occurred_at, actor_id, actor_name, module, entity_type, entity_id, action, before_json, after_json, source, note)
        VALUES (
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          NULL,
          'system',
          '${module}',
          '${table}',
          NEW.${pkCol.name},
          'update',
          ${oldJson},
          ${newJson},
          'system',
          'db_trigger'
        );
      END
    `);

    created += 2;
  }

  if (created) console.log(`[db] đã tạo ${created} trigger nhật ký (AFTER INSERT + AFTER UPDATE) cho ${created / 2} bảng nghiệp vụ.`);
  if (skipped.length) console.warn(`[db] bỏ qua trigger cho ${skipped.length} bảng: ${skipped.slice(0, 5).join('; ')}`);
  return { created, skipped };
}
