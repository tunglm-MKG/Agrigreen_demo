/**
 * GIỚI HẠN TỐC ĐỘ THEO KHOÁ (IP, tài khoản…) — đánh giá bảo mật 24/09/2026, H-04 và M-01.
 *
 * Bộ đếm nằm trong bảng `rate_limits` (SQLite) thay vì Map trong RAM: bền qua khởi động lại
 * và dùng chung giữa các tiến trình cùng volume. Cửa sổ cố định, đủ cho cổng truy cập demo
 * và đăng nhập; không phải token bucket.
 */
import type { IncomingMessage } from 'node:http';
import { one, run } from '../db/db.ts';

export interface RateLimitResult { allowed: boolean; count: number; retryAfterSec: number }

/** Ghi nhận một lượt và cho biết còn trong hạn mức không. */
export function hitRateLimit(bucket: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const row = one<{ count: number; window_start: string }>('SELECT count, window_start FROM rate_limits WHERE bucket = ?', [bucket]);
  const start = row ? Date.parse(row.window_start) : 0;
  if (!row || !Number.isFinite(start) || now - start >= windowMs) {
    run('INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = excluded.window_start', [bucket, new Date(now).toISOString()]);
    return { allowed: true, count: 1, retryAfterSec: 0 };
  }
  const count = row.count + 1;
  run('UPDATE rate_limits SET count = ? WHERE bucket = ?', [count, bucket]);
  return { allowed: count <= max, count, retryAfterSec: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}

/** Chỉ xem (không cộng): còn bị chặn không. */
export function isRateLimited(bucket: string, max: number, windowMs: number): { limited: boolean; retryAfterSec: number } {
  const row = one<{ count: number; window_start: string }>('SELECT count, window_start FROM rate_limits WHERE bucket = ?', [bucket]);
  if (!row) return { limited: false, retryAfterSec: 0 };
  const start = Date.parse(row.window_start);
  const now = Date.now();
  if (now - start >= windowMs) return { limited: false, retryAfterSec: 0 };
  return { limited: row.count >= max, retryAfterSec: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}

export function resetRateLimit(bucket: string): void {
  run('DELETE FROM rate_limits WHERE bucket = ?', [bucket]);
}

/** Dọn bộ đếm cũ (gọi từ vòng quét nền). */
export function purgeRateLimits(olderThanMs = 24 * 3_600_000): void {
  run('DELETE FROM rate_limits WHERE window_start < ?', [new Date(Date.now() - olderThanMs).toISOString()]);
}

/**
 * Địa chỉ IP client. `X-Forwarded-For` chỉ được tin khi biết số lớp proxy phía trước
 * (TRUSTED_PROXY_HOPS, Render/Fly = 1): lấy phần tử thứ N từ PHẢI sang — phần tử đầu là do
 * client tự đặt và giả mạo được (H-04). Không đặt biến → dùng địa chỉ socket.
 */
export function clientIp(req: IncomingMessage): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  if (hops > 0) {
    const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
