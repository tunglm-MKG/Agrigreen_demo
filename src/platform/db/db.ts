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
import { DOMAINS, tablesOf, type Domain } from './domains.ts';

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
    for (const domain of DOMAINS) instance.exec(`PRAGMA ${domain.code === 'shared' ? 'main' : domain.code}.journal_mode = WAL`);
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

/** Bọc một khối lệnh trong transaction; rollback nếu ném lỗi. */
export function transaction<T>(fn: () => T): T {
  const handle = db();
  handle.exec('BEGIN');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    handle.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Chèn một bản ghi từ object. Các giá trị object/array được tự động JSON hoá,
 * boolean được quy đổi về 0/1 vì SQLite không có kiểu boolean.
 */
export function insert(table: string, values: Record<string, unknown>): void {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => normalize(values[column])),
  );
}

/** Chèn hoặc ghi đè theo khoá chính. */
export function upsert(table: string, values: Record<string, unknown>): void {
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
  values: Record<string, unknown>,
  keyColumn = 'id',
): void {
  const columns = Object.keys(values);
  if (!columns.length) return;
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
