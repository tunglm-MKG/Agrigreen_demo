/**
 * ĐƯỜNG NÂNG CẤP TỪ TỆP HỢP NHẤT CŨ (review kiến trúc 24/09/2026, A06).
 *
 * Trước 09/2026 toàn bộ dữ liệu nằm trong một tệp `data/mekonggreen.db`. Bản tách miền
 * mở `mekonggreen.shared.db` + 6 tệp khác, nên nếu chỉ CREATE IF NOT EXISTS rồi seed
 * thì dữ liệu cũ vẫn nằm trên đĩa nhưng biến mất khỏi giao diện.
 *
 * `importLegacyDatabase()` chạy sau migrate() và TRƯỚC seedIfEmpty():
 *   1. phát hiện tệp hợp nhất cũ tại đúng đường dẫn gốc (có bảng `cooperatives`);
 *   2. chỉ nhập khi bộ tệp mới còn trống (chưa có HTX) — không trộn hai nguồn;
 *   3. sao lưu tệp cũ (copy) rồi chép từng bảng theo cột chung, đếm số dòng nhập/bỏ;
 *   4. kiểm `foreign_key_check`, ghi `event_log`, đổi tên tệp cũ thành `.imported-<thời điểm>`
 *      để lần khởi động sau không nhập lại.
 * Lỗi giữa chừng → ROLLBACK toàn bộ và ném lỗi: máy chủ KHÔNG khởi động với dữ liệu nửa vời
 * và KHÔNG tự seed demo đè lên.
 */
import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { db, domainFile, one, schemaName } from './db.ts';
import { TABLE_DOMAIN } from './domains.ts';
import { nowIso } from '../util/ids.ts';

export interface LegacyImportReport {
  source: string;
  backup: string;
  tables: { table: string; source: number; imported: number; skipped: number }[];
  fkViolations: number;
  renamedTo: string;
}

/** Đường dẫn tệp hợp nhất cũ = đường dẫn gốc (không có hậu tố miền). */
export function legacyPath(): string {
  return domainFile('shared').replace(/\.shared\.db$/i, '.db');
}

function isLegacyFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const row = probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('cooperatives', 'users')").get() as { n: number };
      return row.n === 2;
    } finally { probe.close(); }
  } catch { return false; }
}

export function importLegacyDatabase(): LegacyImportReport | null {
  const source = legacyPath();
  if (!isLegacyFile(source)) return null;
  const existing = one<{ n: number }>('SELECT COUNT(*) AS n FROM cooperatives')?.n ?? 0;
  if (existing > 0) {
    console.warn(`[db] Phát hiện tệp hợp nhất cũ ${source} nhưng bộ tệp mới đã có dữ liệu — KHÔNG nhập. Đổi tên tệp cũ nếu không còn dùng.`);
    return null;
  }
  const stamp = nowIso().replace(/[:.]/g, '-');
  const backup = `${source}.truoc-nhap-${stamp}`;
  copyFileSync(source, backup);

  const handle = db();
  const literal = source.split('\\').join('/').replace(/'/g, "''");
  handle.exec(`ATTACH DATABASE '${literal}' AS legacy`);
  const tables: LegacyImportReport['tables'] = [];
  handle.exec('PRAGMA foreign_keys = OFF');
  handle.exec('BEGIN');
  try {
    const legacyTables = new Set((handle.prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name));
    for (const [table, domain] of Object.entries(TABLE_DOMAIN)) {
      if (!legacyTables.has(table)) continue;
      const schema = schemaName(domain);
      const target = new Set((handle.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      if (!target.size) continue;
      const common = (handle.prepare(`PRAGMA legacy.table_info(${table})`).all() as { name: string }[]).map((c) => c.name).filter((c) => target.has(c));
      if (!common.length) continue;
      const sourceCount = (handle.prepare(`SELECT COUNT(*) AS n FROM legacy.${table}`).get() as { n: number }).n;
      if (!sourceCount) continue;
      const cols = common.join(', ');
      // OR IGNORE: dòng vi phạm UNIQUE/CHECK/NOT NULL của lược đồ mới bị bỏ và được đếm — không làm hỏng cả đợt nhập.
      const result = handle.prepare(`INSERT OR IGNORE INTO ${schema}.${table} (${cols}) SELECT ${cols} FROM legacy.${table}`).run();
      const imported = Number(result.changes);
      tables.push({ table, source: sourceCount, imported, skipped: sourceCount - imported });
    }
    handle.exec('COMMIT');
  } catch (error) {
    handle.exec('ROLLBACK');
    handle.exec('DETACH DATABASE legacy');
    handle.exec('PRAGMA foreign_keys = ON');
    throw new Error(`Nhập dữ liệu từ tệp hợp nhất cũ thất bại, đã hoàn tác: ${(error as Error).message}. Bản sao tệp cũ: ${backup}`);
  }
  handle.exec('DETACH DATABASE legacy');
  handle.exec('PRAGMA foreign_keys = ON');
  const fkViolations = handle.prepare('PRAGMA foreign_key_check').all().length;

  const renamedTo = `${source}.imported-${stamp}`;
  renameSync(source, renamedTo);
  for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) renameSync(source + suffix, `${renamedTo}${suffix}`);

  const imported = tables.reduce((a, t) => a + t.imported, 0);
  const skipped = tables.reduce((a, t) => a + t.skipped, 0);
  handle.prepare(`INSERT INTO ${schemaName('shared')}.event_log (occurred_at, actor_id, actor_name, module, entity_type, entity_id, action, after_json, source, note) VALUES (?, NULL, 'system', 'admin', 'legacy_import', ?, 'create', ?, 'system', 'import_legacy_single_file')`)
    .run(nowIso(), source, JSON.stringify({ tables: tables.length, imported, skipped, fkViolations, backup, renamedTo }));
  console.log(`[db] Đã nhập dữ liệu từ tệp hợp nhất cũ: ${tables.length} bảng, ${imported} dòng (bỏ ${skipped} dòng vi phạm ràng buộc mới, ${fkViolations} vi phạm khoá ngoại). Tệp cũ → ${renamedTo}`);
  return { source, backup, tables, fkViolations, renamedTo };
}
