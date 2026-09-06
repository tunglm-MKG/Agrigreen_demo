/**
 * CSDL RIÊNG của demo GIS — tách hoàn toàn khỏi CSDL lõi AgriGreen (brief §2).
 *
 * Tệp: gis-demo/data/gis-demo.db. Không bảng nào ở đây liên quan tới HTX, hộ, thửa
 * thật. Nhật ký truy cập không chứa IP hay định danh cá nhân (R-05): chỉ đường dẫn,
 * mốc giờ và số lời gọi ngoài — đúng những gì cần để kiểm tiêu chí 8.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

let handle: DatabaseSync | null = null;
let currentPath = process.env.GIS_DEMO_DB ?? join(process.cwd(), 'gis-demo', 'data', 'gis-demo.db');

export function configure(path: string): void {
  if (handle) { handle.close(); handle = null; }
  currentPath = path;
}

export function db(): DatabaseSync {
  if (handle) return handle;
  mkdirSync(dirname(currentPath), { recursive: true });
  handle = new DatabaseSync(currentPath);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec(SCHEMA);
  return handle;
}

export const run = (sql: string, params: unknown[] = []) => { db().prepare(sql).run(...(params as never[])); };
export const all = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] => db().prepare(sql).all(...(params as never[])) as T[];
export const one = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null => (db().prepare(sql).get(...(params as never[])) as T | undefined) ?? null;

const SCHEMA = `
-- Bộ đệm cho adapter nguồn sống (Open-Meteo). Thời hạn tối thiểu 1 giờ (A.1).
CREATE TABLE IF NOT EXISTS api_cache (
  cache_key   TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
-- Đếm lời gọi ngoài theo giờ, theo nguồn — bằng chứng cho tiêu chí 8.
CREATE TABLE IF NOT EXISTS external_calls (
  called_at   TEXT NOT NULL,
  provider    TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  ms          INTEGER
);
-- Nhật ký truy cập KHÔNG có định danh cá nhân (R-05).
CREATE TABLE IF NOT EXISTS access_log (
  at          TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INTEGER NOT NULL,
  ms          INTEGER
);
-- Mực nước: trạm và chuỗi, nạp một lần từ CSV xuất ở MRC Data Portal (A.2).
CREATE TABLE IF NOT EXISTS water_level_stations (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  river       TEXT,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  datum       TEXT,
  source_note TEXT
);
CREATE TABLE IF NOT EXISTS water_level_series (
  station_code TEXT NOT NULL,
  day          TEXT NOT NULL,
  level_m      REAL,
  quality      TEXT NOT NULL DEFAULT 'mrc',   -- mrc | minh_hoa
  PRIMARY KEY (station_code, day)
);
CREATE TABLE IF NOT EXISTS water_level_import (
  imported_at  TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  rows         INTEGER NOT NULL,
  from_day     TEXT,
  to_day       TEXT,
  source       TEXT NOT NULL
);
-- Mặn: bảng NHẬP TAY từ bản tin đã công bố (A.2). Không tự động hoá.
CREATE TABLE IF NOT EXISTS salinity_manual (
  id            TEXT PRIMARY KEY,
  river         TEXT NOT NULL,
  mouth_lat     REAL NOT NULL,
  mouth_lng     REAL NOT NULL,
  upstream_lat  REAL NOT NULL,
  upstream_lng  REAL NOT NULL,
  period_from   TEXT NOT NULL,
  period_to     TEXT NOT NULL,
  km_min        REAL NOT NULL,
  km_max        REAL NOT NULL,
  bulletin      TEXT NOT NULL,
  bulletin_date TEXT NOT NULL,
  bulletin_url  TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_external_calls_at ON external_calls(called_at);
CREATE INDEX IF NOT EXISTS idx_access_log_at ON access_log(at);
`;

/** Ghi một lời gọi ngoài — mọi adapter nguồn sống phải gọi qua đây. */
export function recordExternalCall(provider: string, endpoint: string, ok: boolean, ms: number): void {
  run('INSERT INTO external_calls (called_at, provider, endpoint, ok, ms) VALUES (?, ?, ?, ?, ?)', [new Date().toISOString(), provider, endpoint, ok ? 1 : 0, ms]);
}

export function externalCallsLast(minutes: number): { total: number; byProvider: Record<string, number> } {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const rows = all<{ provider: string; n: number }>('SELECT provider, COUNT(*) AS n FROM external_calls WHERE called_at >= ? GROUP BY provider', [since]);
  return { total: rows.reduce((s, r) => s + r.n, 0), byProvider: Object.fromEntries(rows.map((r) => [r.provider, r.n])) };
}

export function cacheGet<T>(key: string): { value: T; fetchedAt: string } | null {
  const row = one<{ value_json: string; fetched_at: string; expires_at: string }>('SELECT value_json, fetched_at, expires_at FROM api_cache WHERE cache_key = ?', [key]);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) return null;
  return { value: JSON.parse(row.value_json) as T, fetchedAt: row.fetched_at };
}

export function cacheSet(key: string, provider: string, value: unknown, ttlMinutes: number): void {
  const now = new Date();
  run(
    `INSERT INTO api_cache (cache_key, provider, value_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    [key, provider, JSON.stringify(value), now.toISOString(), new Date(now.getTime() + ttlMinutes * 60_000).toISOString()],
  );
}

export function logAccess(path: string, status: number, ms: number): void {
  // Chỉ đường dẫn không có query (query có thể chứa toạ độ người dùng bấm — không phải PII nhưng cũng không cần lưu).
  run('INSERT INTO access_log (at, path, status, ms) VALUES (?, ?, ?, ?)', [new Date().toISOString(), path.split('?')[0], status, ms]);
}
