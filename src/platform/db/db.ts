/**
 * Lớp truy cập dữ liệu dùng chung cho toàn nền tảng.
 *
 * Dùng `node:sqlite` (có sẵn trong Node >= 22) nên toàn bộ hệ thống chạy được
 * mà không cần cài thêm bất kỳ package nào.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Row = Record<string, unknown>;

let instance: DatabaseSync | null = null;
let dbPath = resolve(process.cwd(), 'data', 'mekonggreen.db');

export function configureDatabase(path: string): void {
  if (instance) {
    instance.close();
    instance = null;
  }
  dbPath = resolve(path);
}

export function db(): DatabaseSync {
  if (!instance) {
    mkdirSync(dirname(dbPath), { recursive: true });
    instance = new DatabaseSync(dbPath);
    instance.exec('PRAGMA journal_mode = WAL');
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
