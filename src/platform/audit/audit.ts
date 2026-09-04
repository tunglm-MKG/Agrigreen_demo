/**
 * Nhật ký sự kiện, snapshot theo ngày và replay.
 *
 * Đáp ứng:
 *  - GIS FN-17: event log append-only cho MỌI lớp dữ liệu, là nguồn sự thật để
 *    tái dựng trạng thái, phục vụ audit và retry.
 *  - GIS FN-18: snapshot trạng thái toàn hệ thống theo ngày.
 *  - GIS FN-19: replay trạng thái GIS theo một ngày trong quá khứ.
 *  - GIS FN-20: chính sách lưu trữ & dọn dẹp.
 *  - Simulation FN-01 BR-01 và Warehouse FN-38: mọi thay đổi dữ liệu nền phải
 *    ghi nhật ký (ai sửa, khi nào, giá trị cũ/mới).
 */
import { all, insert, one, run, upsert, parseJson } from '../db/db.ts';
import { digest, nowIso, today } from '../util/ids.ts';

export interface AuditActor {
  id?: string | null;
  name?: string | null;
}

export interface AuditEntry {
  module: string;
  entityType: string;
  entityId?: string | null;
  action: 'create' | 'update' | 'delete' | 'approve' | 'export' | 'sync' | 'simulate';
  before?: unknown;
  after?: unknown;
  source?: 'ui' | 'api' | 'integration' | 'system';
  note?: string;
}

export function logEvent(entry: AuditEntry, actor: AuditActor = {}): void {
  insert('event_log', {
    occurred_at: nowIso(),
    actor_id: actor.id ?? null,
    actor_name: actor.name ?? 'system',
    module: entry.module,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    action: entry.action,
    before_json: entry.before === undefined ? null : JSON.stringify(entry.before),
    after_json: entry.after === undefined ? null : JSON.stringify(entry.after),
    source: entry.source ?? 'ui',
    note: entry.note ?? null,
  });
}

export interface EventFilter {
  module?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function queryEvents(filter: EventFilter = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.module) {
    clauses.push('module = ?');
    params.push(filter.module);
  }
  if (filter.entityType) {
    clauses.push('entity_type = ?');
    params.push(filter.entityType);
  }
  if (filter.entityId) {
    clauses.push('entity_id = ?');
    params.push(filter.entityId);
  }
  if (filter.from) {
    clauses.push('occurred_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push('occurred_at <= ?');
    params.push(filter.to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filter.limit ?? 200);
  return all(`SELECT * FROM event_log ${where} ORDER BY id DESC LIMIT ?`, params);
}

/** Các lớp dữ liệu được chụp snapshot hàng ngày (GIS FN-18: "toàn bộ các lớp"). */
const SNAPSHOT_LAYERS: { layer: string; sql: string }[] = [
  { layer: 'cooperatives', sql: 'SELECT * FROM cooperatives WHERE status <> \'deleted\'' },
  { layer: 'plots', sql: 'SELECT id, code, htx_id, area_ha, status, centroid_lat, centroid_lng FROM plots' },
  { layer: 'facilities', sql: 'SELECT * FROM facilities' },
  { layer: 'transport_routes', sql: 'SELECT id, code, name, mode, length_m, status, data_source, max_load_tons FROM transport_routes' },
  { layer: 'crop_status', sql: 'SELECT * FROM crop_status' },
  { layer: 'machines', sql: 'SELECT id, code, machine_type_id, htx_id, condition, condition_source FROM machines' },
  { layer: 'weather', sql: 'SELECT * FROM weather_observations WHERE observed_for >= date(\'now\', \'-1 day\')' },
  { layer: 'facility_capacity', sql: 'SELECT id, code, name, capacity_tons, current_stock_tons FROM facilities WHERE kind IN (\'hub\',\'warehouse\',\'yard\')' },
];

/** GIS FN-18: chụp snapshot trạng thái toàn hệ thống cho một ngày. */
export function captureSnapshot(date = today()): { layer: string; count: number }[] {
  const summary: { layer: string; count: number }[] = [];
  for (const { layer, sql } of SNAPSHOT_LAYERS) {
    const rows = all(sql);
    const payload = JSON.stringify(rows);
    upsert('daily_snapshots', {
      snapshot_date: date,
      layer,
      payload_json: payload,
      checksum: digest(rows),
      record_count: rows.length,
      created_at: nowIso(),
    });
    summary.push({ layer, count: rows.length });
  }
  return summary;
}

/**
 * GIS FN-19: xem lại trạng thái GIS theo ngày.
 *
 * Ưu tiên đọc snapshot của đúng ngày; nếu chưa có, lấy snapshot gần nhất TRƯỚC
 * ngày đó rồi áp các sự kiện trong khoảng để tái dựng (event log là nguồn sự
 * thật, snapshot chỉ để truy vấn nhanh).
 */
export function replay(date: string): {
  date: string;
  basis: 'snapshot' | 'reconstructed' | 'empty';
  layers: Record<string, unknown[]>;
  appliedEvents: number;
} {
  const exact = all<{ layer: string; payload_json: string }>(
    'SELECT layer, payload_json FROM daily_snapshots WHERE snapshot_date = ?',
    [date],
  );
  if (exact.length) {
    const layers: Record<string, unknown[]> = {};
    for (const row of exact) layers[row.layer] = parseJson(row.payload_json, []);
    return { date, basis: 'snapshot', layers, appliedEvents: 0 };
  }

  const previousDate = one<{ snapshot_date: string }>(
    'SELECT snapshot_date FROM daily_snapshots WHERE snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1',
    [date],
  );
  if (!previousDate) {
    return { date, basis: 'empty', layers: {}, appliedEvents: 0 };
  }

  const base = all<{ layer: string; payload_json: string }>(
    'SELECT layer, payload_json FROM daily_snapshots WHERE snapshot_date = ?',
    [previousDate.snapshot_date],
  );
  const layers: Record<string, unknown[]> = {};
  for (const row of base) layers[row.layer] = parseJson(row.payload_json, []);

  const events = all<{ entity_type: string; entity_id: string; action: string; after_json: string }>(
    `SELECT entity_type, entity_id, action, after_json FROM event_log
     WHERE substr(occurred_at, 1, 10) > ? AND substr(occurred_at, 1, 10) <= ?
     ORDER BY id ASC`,
    [previousDate.snapshot_date, date],
  );

  for (const event of events) {
    const bucket = layers[event.entity_type];
    if (!Array.isArray(bucket)) continue;
    const index = bucket.findIndex((row) => (row as { id?: string }).id === event.entity_id);
    if (event.action === 'delete') {
      if (index >= 0) bucket.splice(index, 1);
      continue;
    }
    const after = parseJson<Record<string, unknown> | null>(event.after_json, null);
    if (!after) continue;
    if (index >= 0) bucket[index] = { ...(bucket[index] as object), ...after };
    else bucket.push(after);
  }

  return { date, basis: 'reconstructed', layers, appliedEvents: events.length };
}

export interface RetentionPolicy {
  eventLogDays: number;
  snapshotDays: number;
  compactAfterDays: number;
}

export function getRetentionPolicy(): RetentionPolicy {
  const row = one<{ event_log_days: number; snapshot_days: number; compact_after_days: number }>(
    'SELECT * FROM retention_policy WHERE id = ?',
    ['default'],
  );
  return {
    eventLogDays: row?.event_log_days ?? 730,
    snapshotDays: row?.snapshot_days ?? 365,
    compactAfterDays: row?.compact_after_days ?? 90,
  };
}

export function setRetentionPolicy(policy: RetentionPolicy, actor: AuditActor = {}): void {
  const before = getRetentionPolicy();
  upsert('retention_policy', {
    id: 'default',
    event_log_days: policy.eventLogDays,
    snapshot_days: policy.snapshotDays,
    compact_after_days: policy.compactAfterDays,
    updated_at: nowIso(),
  });
  logEvent(
    { module: 'gis', entityType: 'retention_policy', entityId: 'default', action: 'update', before, after: policy },
    actor,
  );
}

/** GIS FN-20: dọn dẹp dữ liệu lịch sử quá hạn. */
export function applyRetention(): { removedEvents: number; removedSnapshots: number } {
  const policy = getRetentionPolicy();
  const eventCutoff = daysAgo(policy.eventLogDays);
  const snapshotCutoff = daysAgo(policy.snapshotDays);
  const removedEvents = countRows(
    'SELECT COUNT(*) AS n FROM event_log WHERE substr(occurred_at, 1, 10) < ?',
    [eventCutoff],
  );
  const removedSnapshots = countRows(
    'SELECT COUNT(*) AS n FROM daily_snapshots WHERE snapshot_date < ?',
    [snapshotCutoff],
  );
  run('DELETE FROM event_log WHERE substr(occurred_at, 1, 10) < ?', [eventCutoff]);
  run('DELETE FROM daily_snapshots WHERE snapshot_date < ?', [snapshotCutoff]);
  return { removedEvents, removedSnapshots };
}

function countRows(sql: string, params: unknown[]): number {
  const row = one<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
