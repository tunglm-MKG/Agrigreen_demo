/**
 * SỨC KHOẺ CSDL — rà soát 24/09/2026, nguyên tắc 4 và 11.
 *
 * SQLite không cho khoá ngoại trỏ sang tệp khác, nên 15 quan hệ xuyên miền chỉ
 * được bảo vệ ở tầng ghi (`insert/update` trong db.ts kiểm `CROSS_DOMAIN_REFS`).
 * Mô-đun này bổ sung lớp thứ hai: rà bản ghi mồ côi định kỳ và trên màn quản trị,
 * cùng `integrity_check` cho từng tệp.
 */
import { all, db, one } from './db.ts';
import { CROSS_DOMAIN_REFS, DOMAINS, schemaOf } from './domains.ts';
import { logEvent } from '../audit/audit.ts';
import { nowIso } from '../util/ids.ts';

export interface OrphanReport { table: string; column: string; parent: string; orphans: number; sample: string[] }

/** Đếm bản ghi con trỏ tới cha không tồn tại cho từng quan hệ xuyên miền. */
export function findOrphans(): OrphanReport[] {
  return CROSS_DOMAIN_REFS.map((ref) => {
    const sql = `FROM ${ref.table} c WHERE c.${ref.column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ref.parent} p WHERE p.id = c.${ref.column})`;
    const orphans = one<{ n: number }>(`SELECT COUNT(*) AS n ${sql}`)?.n ?? 0;
    const sample = orphans ? all<{ id: string }>(`SELECT c.id ${sql} LIMIT 5`).map((r) => r.id) : [];
    return { ...ref, orphans, sample };
  });
}

/** integrity_check từng tệp miền (nhanh với tệp vài MB; với tệp lớn dùng quick_check). */
export function integrityByDomain(quick = false): { domain: string; result: string }[] {
  const handle = db();
  return DOMAINS.map((d) => {
    const row = handle.prepare(`PRAGMA ${schemaOf(d.code)}.${quick ? 'quick_check' : 'integrity_check'}`).get() as Record<string, unknown>;
    return { domain: d.code, result: String(Object.values(row)[0]) };
  });
}

export function indexSummary(): { domain: string; explicit: number }[] {
  const handle = db();
  return DOMAINS.map((d) => ({
    domain: d.code,
    explicit: (handle.prepare(`SELECT COUNT(*) AS n FROM ${schemaOf(d.code)}.sqlite_master WHERE type = 'index' AND sql IS NOT NULL`).get() as { n: number }).n,
  }));
}

let lastScanDay = '';
/** Chạy tối đa một lần mỗi ngày từ vòng quét nền: ghi nhật ký khi phát hiện mồ côi hoặc tệp hỏng. */
export function dailyIntegrityScan(actor = { name: 'system' }): { ran: boolean; orphans: number; broken: string[] } {
  const today = nowIso().slice(0, 10);
  if (lastScanDay === today) return { ran: false, orphans: 0, broken: [] };
  lastScanDay = today;
  const orphanReports = findOrphans().filter((r) => r.orphans > 0);
  const broken = integrityByDomain(true).filter((r) => r.result !== 'ok').map((r) => `${r.domain}: ${r.result}`);
  const orphans = orphanReports.reduce((a, r) => a + r.orphans, 0);
  if (orphans || broken.length) {
    logEvent({ module: 'admin', entityType: 'db_integrity', entityId: today, action: 'update', after: { orphans: orphanReports, broken }, note: 'daily_integrity_scan', source: 'system' }, actor);
    console.error(`[db] rà toàn vẹn ${today}: ${orphans} bản ghi mồ côi, ${broken.length} tệp lỗi.`);
  }
  return { ran: true, orphans, broken };
}
