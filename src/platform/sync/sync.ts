/**
 * Nhật ký, giám sát và retry đồng bộ tích hợp.
 *
 * GIS FN-21: ghi log mỗi lần đồng bộ với ERP / App HTX / Bản đồ CGH / TMS
 *            (thời điểm, nguồn, số bản ghi, thành công/lỗi, thông điệp lỗi).
 * GIS FN-22: retry theo chính sách backoff; vượt ngưỡng → dead-letter + cảnh báo.
 */
import { all, insert, one, update } from '../db/db.ts';
import { nowIso, uuid } from '../util/ids.ts';
import { logEvent } from '../audit/audit.ts';

export type SyncSystem = 'app_htx' | 'ban_do_cgh' | 'erp' | 'tms' | 'khuyen_nong' | 'simulation';
export type SyncDirection = 'inbound' | 'outbound';

export const MAX_ATTEMPTS = 5;
/** Backoff luỹ tiến (phút) cho từng lần thử lại. */
const BACKOFF_MINUTES = [1, 5, 15, 60];

export interface SyncOutcome<T> {
  logId: string;
  status: 'success' | 'failed' | 'dead_letter';
  recordCount: number;
  result?: T;
  error?: string;
}

/**
 * Chạy một tác vụ đồng bộ có ghi nhật ký đầy đủ. Nếu tác vụ ném lỗi, bản ghi
 * được đánh dấu `failed` và lên lịch retry; nếu đã vượt MAX_ATTEMPTS thì chuyển
 * sang `dead_letter`.
 */
export function runSync<T>(
  options: {
    system: SyncSystem;
    direction: SyncDirection;
    dataset: string;
    attempt?: number;
    payload?: unknown;
  },
  task: () => { recordCount: number; result?: T },
): SyncOutcome<T> {
  const logId = uuid();
  const attempt = options.attempt ?? 1;
  const startedAt = nowIso();

  insert('sync_log', {
    id: logId,
    system: options.system,
    direction: options.direction,
    dataset: options.dataset,
    started_at: startedAt,
    finished_at: null,
    record_count: 0,
    status: 'retrying',
    attempt,
    next_retry_at: null,
    error_message: null,
    payload_json: options.payload ? JSON.stringify(options.payload) : null,
  });

  try {
    const { recordCount, result } = task();
    update('sync_log', logId, {
      finished_at: nowIso(),
      record_count: recordCount,
      status: 'success',
      next_retry_at: null,
    });
    logEvent({
      module: 'sync',
      entityType: 'sync_log',
      entityId: logId,
      action: 'sync',
      after: { system: options.system, dataset: options.dataset, recordCount },
      source: 'integration',
    });
    return { logId, status: 'success', recordCount, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = attempt >= MAX_ATTEMPTS;
    update('sync_log', logId, {
      finished_at: nowIso(),
      status: exhausted ? 'dead_letter' : 'failed',
      error_message: message,
      next_retry_at: exhausted ? null : nextRetryAt(attempt),
    });
    logEvent({
      module: 'sync',
      entityType: 'sync_log',
      entityId: logId,
      action: 'sync',
      after: { system: options.system, dataset: options.dataset, error: message, attempt },
      source: 'integration',
      note: exhausted ? 'dead_letter' : 'scheduled_retry',
    });
    return { logId, status: exhausted ? 'dead_letter' : 'failed', recordCount: 0, error: message };
  }
}

function nextRetryAt(attempt: number): string {
  const minutes = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)];
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export interface SyncLogRow {
  id: string;
  system: string;
  direction: string;
  dataset: string;
  started_at: string;
  finished_at: string | null;
  record_count: number;
  status: string;
  attempt: number;
  next_retry_at: string | null;
  error_message: string | null;
}

export function listSyncLogs(filter: { system?: string; status?: string; limit?: number } = {}): SyncLogRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.system) {
    clauses.push('system = ?');
    params.push(filter.system);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filter.limit ?? 100);
  return all<SyncLogRow>(`SELECT * FROM sync_log ${where} ORDER BY started_at DESC LIMIT ?`, params);
}

/** Bảng giám sát: tỷ lệ thành công và số giao dịch đang nằm trong dead-letter. */
export function syncHealth(): {
  bySystem: { system: string; total: number; success: number; failed: number; deadLetter: number }[];
  pendingRetries: number;
} {
  const bySystem = all<{ system: string; total: number; success: number; failed: number; deadLetter: number }>(
    `SELECT system,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS deadLetter
     FROM sync_log GROUP BY system ORDER BY system`,
  );
  const pending = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sync_log WHERE status = 'failed' AND next_retry_at IS NOT NULL",
  );
  return { bySystem, pendingRetries: pending?.n ?? 0 };
}

/**
 * Quét các bản ghi đã đến hạn retry. Trả về danh sách để scheduler chạy lại
 * đúng dataset tương ứng (đăng ký trong `retryHandlers`).
 */
export function dueRetries(): SyncLogRow[] {
  return all<SyncLogRow>(
    "SELECT * FROM sync_log WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ? ORDER BY next_retry_at",
    [nowIso()],
  );
}

type RetryHandler = (payload: unknown) => { recordCount: number };
const retryHandlers = new Map<string, RetryHandler>();

export function registerRetryHandler(dataset: string, handler: RetryHandler): void {
  retryHandlers.set(dataset, handler);
}

/** Thực thi một vòng retry cho toàn bộ bản ghi đến hạn (FN-22). */
export function processRetries(): { retried: number; recovered: number; deadLettered: number } {
  let retried = 0;
  let recovered = 0;
  let deadLettered = 0;
  for (const row of dueRetries()) {
    const handler = retryHandlers.get(row.dataset);
    if (!handler) continue;
    retried += 1;
    const payloadRow = one<{ payload_json: string | null }>('SELECT payload_json FROM sync_log WHERE id = ?', [row.id]);
    const payload = payloadRow?.payload_json ? JSON.parse(payloadRow.payload_json) : undefined;
    const outcome = runSync(
      {
        system: row.system as SyncSystem,
        direction: row.direction as SyncDirection,
        dataset: row.dataset,
        attempt: row.attempt + 1,
        payload,
      },
      () => handler(payload),
    );
    // Bản ghi cũ đã được thay bằng lần thử mới.
    update('sync_log', row.id, { status: 'retrying', next_retry_at: null });
    if (outcome.status === 'success') recovered += 1;
    if (outcome.status === 'dead_letter') deadLettered += 1;
  }
  return { retried, recovered, deadLettered };
}
