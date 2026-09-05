/**
 * CHỐNG GHI TRÙNG — header `Idempotency-Key` cho mọi yêu cầu ghi.
 *
 * Ruộng ĐBSCL mất sóng là chuyện thường. Người dùng bấm "Ghi lượt xuống ghe",
 * mạng chập chờn, không thấy phản hồi, bấm lại — trước đây thành hai lượt ghe,
 * hai chuyến TMS. Với khoá này, lần bấm sau mang cùng khoá sẽ nhận lại đúng kết
 * quả của lần trước, không chạy lại nghiệp vụ.
 *
 * Quy tắc:
 *   - Khoá gắn với NGƯỜI DÙNG: hai người khác nhau dùng trùng khoá không ảnh hưởng nhau.
 *   - Chỉ lưu phản hồi THÀNH CÔNG (2xx). Yêu cầu lỗi được phép thử lại thật.
 *   - Giữ 24 giờ — đủ cho hàng đợi offline đồng bộ khi có mạng trở lại.
 *   - Cùng khoá nhưng khác đường dẫn → từ chối, vì gần như chắc chắn là lỗi lập trình
 *     phía trình duyệt (tái dùng khoá), không phải gửi lại.
 */
import { all, one, run } from '../db/db.ts';
import { nowIso } from '../util/ids.ts';

export const RETENTION_HOURS = 24;

export interface StoredResponse { status: number; body: unknown; path: string }

export function findReplay(key: string, userId: string | null, method: string, path: string): StoredResponse | null {
  try {
    const row = one<{ status: number; response_json: string; path: string; method: string }>(
      'SELECT status, response_json, path, method FROM request_log WHERE idem_key = ? AND user_id IS ? AND created_at >= ?',
      [key, userId, new Date(Date.now() - RETENTION_HOURS * 3_600_000).toISOString()],
    );
    if (!row) return null;
    if (row.path !== path || row.method !== method) {
      throw new Error(`Khoá chống trùng "${key.slice(0, 8)}…" đã dùng cho một yêu cầu khác (${row.method} ${row.path}). Trình duyệt phải sinh khoá mới cho mỗi thao tác.`);
    }
    return { status: row.status, body: JSON.parse(row.response_json), path: row.path };
  } catch (error) {
    if ((error as Error).message.startsWith('Khoá chống trùng')) throw error;
    return null; // bảng chưa có (CSDL cũ) — bỏ qua cơ chế, không chặn nghiệp vụ
  }
}

export function storeResponse(key: string, userId: string | null, method: string, path: string, status: number, body: unknown): void {
  try {
    run(
      `INSERT OR REPLACE INTO request_log (idem_key, user_id, method, path, status, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [key, userId, method, path, status, JSON.stringify(body ?? null), nowIso()],
    );
  } catch {
    // Không có bảng thì thôi — cơ chế này là lớp bảo vệ thêm, không phải điều kiện sống.
  }
}

/** Dọn khoá quá hạn; gọi định kỳ từ máy chủ. */
export function purgeExpired(): number {
  try {
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 3_600_000).toISOString();
    const n = all('SELECT idem_key FROM request_log WHERE created_at < ?', [cutoff]).length;
    run('DELETE FROM request_log WHERE created_at < ?', [cutoff]);
    return n;
  } catch {
    return 0;
  }
}
