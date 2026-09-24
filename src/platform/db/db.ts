/**
 * Lớp truy cập dữ liệu dùng chung cho toàn nền tảng.
 *
 * Dùng `node:sqlite` (có sẵn trong Node >= 22) nên toàn bộ hệ thống chạy được
 * mà không cần cài thêm bất kỳ package nào.
 *
 * MỖI MIỀN DỮ LIỆU MỘT TỆP (xem `domains.ts`): tệp dùng chung là `main`, các hệ
 * thống con được ATTACH vào cùng kết nối. Đường dẫn cấu hình là đường dẫn GỐC —
 * `data/mekonggreen.db` cho ra `data/mekonggreen.shared.db`, `.kn.db`, `.htx.db`, …
 * Mã nghiệp vụ không thấy khác biệt: tên bảng không tiền tố được phân giải qua
 * mọi tệp đã gắn; một giao dịch có thể ghi nhiều tệp và vẫn nguyên tử.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DOMAINS, tablesOf, type Domain, crossDomainRefsOf } from './domains.ts';

export type Row = Record<string, unknown>;

let instance: DatabaseSync | null = null;
let basePath = resolve(process.cwd(), 'data', 'mekonggreen.db');

/** Đường dẫn tệp của một miền, suy từ đường dẫn gốc. */
export function domainFile(domain: Domain, base = basePath): string {
  const dir = dirname(base);
  const stem = basename(base).replace(/\.db$/i, '');
  return join(dir, `${stem}.${domain}.db`);
}

export function configureDatabase(path: string): void {
  if (instance) {
    instance.close();
    instance = null;
  }
  basePath = resolve(path);
}

/** Thư mục chứa các tệp CSDL (nơi đặt `.keys/`, `backups/`). */
export function dataDirectory(): string { return dirname(basePath); }

/**
 * Cột tiền tệ lưu theo ĐỒNG (INTEGER) — VNĐ không có xu; số thực nhị phân làm lệch công nợ
 * khi cộng dồn (rà soát 24/09/2026, nguyên tắc 7). Ghi qua insert/update/upsert được làm tròn.
 */
export const MONEY_COLUMNS: Record<string, string[]> = {
  straw_contracts: ['unit_price'], straw_purchase_tickets: ['unit_price', 'amount'], vessels: ['rate_vnd'], market_prices: ['price'],
  input_purchases: ['total_amount'], input_purchase_lines: ['unit_price'], input_stock: ['unit_cost'],
  rental_listings: ['price_per_ha', 'price_per_day'], rental_orders: ['amount', 'platform_fee'], scenarios: ['baseline_manual_cost_per_ton'],
  purchase_orders: ['unit_price'], sales_orders: ['unit_price'], trips: ['planned_cost', 'actual_cost'], ledger_entries: ['amount'], revenue_rules: ['fixed_amount'],
};
function roundMoney(table: string, values: Record<string, unknown>): Record<string, unknown> {
  const money = MONEY_COLUMNS[table];
  if (!money) return values;
  const out = { ...values };
  for (const column of money) if (typeof out[column] === 'number' && Number.isFinite(out[column] as number)) out[column] = Math.round(out[column] as number);
  return out;
}

export function db(): DatabaseSync {
  if (!instance) {
    mkdirSync(dirname(basePath), { recursive: true });
    instance = new DatabaseSync(domainFile('shared'));
    for (const domain of DOMAINS) {
      if (domain.code === 'shared') continue;
      // SQLite nhận đường dẫn kiểu POSIX kể cả trên Windows; nháy đơn trong tên tệp được nhân đôi.
      const file = domainFile(domain.code).split('\\').join('/').replace(/'/g, "''");
      instance.exec(`ATTACH DATABASE '${file}' AS ${domain.code}`);
    }
    // Review kiến trúc 24/09/2026 (A01): với nhiều tệp ATTACH, SQLite chỉ bảo đảm COMMIT nguyên tử
    // XUYÊN TỆP khi máy chủ crash nếu KHÔNG dùng WAL (dùng super-journal). Ứng dụng là một tiến trình,
    // một kết nối đồng bộ nên WAL không đem lại lợi ích đồng thời; chọn TRUNCATE + synchronous=FULL.
    // Ghi đè bằng SQLITE_JOURNAL_MODE=WAL nếu chấp nhận đánh đổi để lấy tốc độ ghi.
    const journalMode = /^(WAL|TRUNCATE|DELETE|PERSIST)$/i.test(process.env.SQLITE_JOURNAL_MODE ?? '') ? String(process.env.SQLITE_JOURNAL_MODE).toUpperCase() : 'TRUNCATE';
    for (const domain of DOMAINS) {
      const schema = domain.code === 'shared' ? 'main' : domain.code;
      instance.exec(`PRAGMA ${schema}.journal_mode = ${journalMode}`);
      instance.exec(`PRAGMA ${schema}.synchronous = FULL`);
    }
    instance.exec('PRAGMA busy_timeout = 5000');
    instance.exec('PRAGMA foreign_keys = ON');
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Tên schema SQLite của một miền (`main` cho dùng chung). */
export const schemaName = (domain: Domain): string => (domain === 'shared' ? 'main' : domain);

/** Tệp, kích cỡ và số bảng của từng miền — cho màn hình quản trị dữ liệu. */
export function databaseFiles(): { domain: Domain; label: string; description: string; path: string; sizeBytes: number; tables: string[]; tableCount: number }[] {
  db();
  return DOMAINS.map((domain) => {
    const path = domainFile(domain.code);
    const exists = existsSync(path);
    const wal = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
    const tables = all<{ name: string }>(
      `SELECT name FROM ${schemaName(domain.code)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((r) => r.name);
    return {
      domain: domain.code, label: domain.label, description: domain.description, path,
      sizeBytes: (exists ? statSync(path).size : 0) + wal, tables, tableCount: tables.length,
      declared: tablesOf(domain.code).length,
    } as never;
  });
}

/** Chạy một câu lệnh ghi (INSERT/UPDATE/DELETE/DDL). */
export function run(sql: string, params: unknown[] = []): void {
  db().prepare(sql).run(...(params as never[]));
}

/** Trả về toàn bộ dòng kết quả. */
export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

/** Trả về dòng đầu tiên hoặc null. */
export function one<T = Row>(sql: string, params: unknown[] = []): T | null {
  const rows = all<T>(sql, params);
  return rows.length ? rows[0] : null;
}

/** Trả về một giá trị vô hướng (cột đầu tiên của dòng đầu tiên). */
export function scalar<T = unknown>(sql: string, params: unknown[] = []): T | null {
  const row = one<Row>(sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? (row[keys[0]] as T) : null;
}

/**
 * Bọc một khối lệnh trong transaction; rollback nếu ném lỗi. LỒNG ĐƯỢC: lớp ngoài cùng BEGIN/COMMIT,
 * các lớp trong dùng SAVEPOINT — nên dịch vụ gọi transaction() bên trong một đơn vị công việc của
 * yêu cầu HTTP (unitOfWork) vẫn chạy đúng và cùng commit với nhật ký/outbox (review 24/09/2026, A04).
 */
let depth = 0;
export function transaction<T>(fn: () => T): T {
  const handle = db();
  const level = depth;
  handle.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT sp_${level}`);
  depth = level + 1;
  try {
    const result = fn();
    depth = level;
    handle.exec(level === 0 ? 'COMMIT' : `RELEASE sp_${level}`);
    return result;
  } catch (error) {
    depth = level;
    if (level === 0) handle.exec('ROLLBACK');
    else { handle.exec(`ROLLBACK TO sp_${level}`); handle.exec(`RELEASE sp_${level}`); }
    throw error;
  }
}
export const inTransaction = (): boolean => depth > 0;

/**
 * Khoá ghi trong tiến trình: tuần tự hoá yêu cầu ghi và tác vụ nền. Một đơn vị công việc có
 * `await` ở giữa (gửi webhook, đọc tệp) không bị yêu cầu khác chen vào cùng giao dịch SQLite.
 */
let writeChain: Promise<unknown> = Promise.resolve();
export function withWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = writeChain.then(() => fn(), () => fn());
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Đơn vị công việc của MỘT yêu cầu ghi: BEGIN → guard + handler (có thể async) → COMMIT; lỗi → ROLLBACK.
 * Dữ liệu nghiệp vụ, event_log, outbox thông báo và bản ghi idempotency cùng commit hoặc cùng huỷ.
 */
export async function unitOfWork<T>(fn: () => Promise<T> | T): Promise<T> {
  return withWriteLock(async () => {
    if (depth > 0) return fn();
    const handle = db();
    handle.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const result = await fn();
      depth = 0;
      handle.exec('COMMIT');
      return result;
    } catch (error) {
      depth = 0;
      try { handle.exec('ROLLBACK'); } catch { /* giao dịch đã bị huỷ bởi lỗi trước đó */ }
      throw error;
    }
  });
}

/**
 * Chèn một bản ghi từ object. Các giá trị object/array được tự động JSON hoá,
 * boolean được quy đổi về 0/1 vì SQLite không có kiểu boolean.
 */
/** Khoá ngoại xuyên miền không tồn tại ở tầng SQLite → kiểm ở đây, đúng một SELECT cho mỗi cột tham chiếu có giá trị. */
function assertCrossDomainRefs(table: string, values: Record<string, unknown>): void {
  for (const ref of crossDomainRefsOf(table)) {
    const id = values[ref.column];
    if (id === undefined || id === null || id === '') continue;
    if (!one(`SELECT 1 FROM ${ref.parent} WHERE id = ?`, [id])) {
      throw new Error(`Tham chiếu không tồn tại: ${table}.${ref.column} → ${ref.parent} (${String(id)}). Bản ghi cha có thể đã bị xoá.`);
    }
  }
}

export function insert(table: string, input: Record<string, unknown>): void {
  const values = roundMoney(table, input);
  assertCrossDomainRefs(table, values);
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => normalize(values[column])),
  );
}

/** Chèn hoặc ghi đè theo khoá chính. */
export function upsert(table: string, input: Record<string, unknown>): void {
  const values = roundMoney(table, input);
  assertCrossDomainRefs(table, values);
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  run(
    `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => normalize(values[column])),
  );
}

/** Cập nhật bản ghi theo cột khoá (mặc định là `id`). */
export function update(
  table: string,
  id: string,
  input: Record<string, unknown>,
  keyColumn = 'id',
): void {
  const values = roundMoney(table, input);
  const columns = Object.keys(values);
  if (!columns.length) return;
  assertCrossDomainRefs(table, values);
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  run(
    `UPDATE ${table} SET ${assignments} WHERE ${keyColumn} = ?`,
    [...columns.map((column) => normalize(values[column])), id],
  );
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** Đọc một cột JSON đã lưu dạng chuỗi. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
