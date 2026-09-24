/**
 * ĐẶT LẠI MẬT KHẨU QUA LIÊN KẾT MỘT LẦN (yêu cầu 24/09/2026: mỗi lần khởi động lại hệ thống
 * và mỗi lần đặt lại mật khẩu SAdmin, gửi email đặt lại tới địa chỉ quản trị).
 *
 * Nguyên tắc:
 *   - Email KHÔNG chứa mật khẩu. Nó chứa một liên kết mang token ngẫu nhiên 32 byte, dùng đúng
 *     một lần, hết hạn sau RESET_LINK_MINUTES (mặc định 30). CSDL chỉ lưu SHA-256 của token.
 *   - Dùng liên kết = đặt mật khẩu mới (đạt chính sách), mở khoá tài khoản, xoá cờ bắt đổi,
 *     huỷ MỌI phiên đang mở và mọi liên kết còn lại của tài khoản đó. Mật khẩu hiện tại vẫn
 *     dùng được cho tới khi liên kết được dùng — nên gửi ở mỗi lần khởi động không làm ai bị
 *     văng ra.
 *   - Địa chỉ nhận: SADMIN_RESET_EMAIL (mặc định tunglm@mekonggreen.vn). Đặt rỗng hoặc `0` để tắt.
 */
import { createHash, randomBytes } from 'node:crypto';
import { insert, one, run } from '../db/db.ts';
import { nowIso, uuid } from '../util/ids.ts';
import { logEvent } from '../audit/audit.ts';
import { changePassword, SUPER_ADMIN_USERNAME } from './users.ts';
import { sendMail, type MailResult } from '../notify/mailer.ts';

export const RESET_LINK_MINUTES = Number(process.env.RESET_LINK_MINUTES ?? 30);
export const DEFAULT_SADMIN_RESET_EMAIL = 'tunglm@mekonggreen.vn';

export type ResetReason = 'startup' | 'operator_reset' | 'created' | 'admin_request';

export function superAdminResetEmail(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SADMIN_RESET_EMAIL;
  if (raw === undefined) return DEFAULT_SADMIN_RESET_EMAIL;
  const value = raw.trim();
  return value && value !== '0' ? value : null;
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** Cấp token đặt lại cho một tài khoản; trả về token thô (chỉ tồn tại trong email). */
export function issueResetToken(userId: string, reason: ResetReason, ttlMinutes = RESET_LINK_MINUTES): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  insert('password_resets', { id: uuid(), user_id: userId, token_digest: digest(token), reason, created_at: nowIso(), expires_at: expiresAt, used_at: null });
  // Dọn token đã hết hạn/đã dùng quá 7 ngày để bảng không phình.
  run("DELETE FROM password_resets WHERE (used_at IS NOT NULL OR expires_at < ?) AND created_at < datetime('now', '-7 days')", [nowIso()]);
  logEvent({ module: 'admin', entityType: 'users', entityId: userId, action: 'update', note: `password_reset_link_issued:${reason}`, source: 'system' });
  return { token, expiresAt };
}

export class ResetError extends Error {
  readonly code: 'invalid' | 'expired' | 'used';
  constructor(message: string, code: 'invalid' | 'expired' | 'used') { super(message); this.code = code; }
}

/** Dùng liên kết: đặt mật khẩu mới, mở khoá, huỷ phiên. Ném ResetError khi token sai/hết hạn/đã dùng. */
export function completeReset(token: string, newPassword: string, context: { ip?: string } = {}): { userId: string; username: string } {
  const row = one<{ id: string; user_id: string; expires_at: string; used_at: string | null; username: string }>(
    'SELECT r.id, r.user_id, r.expires_at, r.used_at, u.username FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_digest = ?',
    [digest(String(token ?? ''))],
  );
  if (!row) throw new ResetError('Liên kết đặt lại không hợp lệ.', 'invalid');
  if (row.used_at) throw new ResetError('Liên kết đặt lại đã được dùng.', 'used');
  if (row.expires_at < nowIso()) throw new ResetError('Liên kết đặt lại đã hết hạn — hãy yêu cầu liên kết mới.', 'expired');
  changePassword(row.user_id, newPassword, { enforcePolicy: true });   // huỷ mọi phiên
  run("UPDATE users SET must_change_pw = 0, failed_attempts = 0, locked_until = NULL, status = 'active', updated_at = ? WHERE id = ?", [nowIso(), row.user_id]);
  run('UPDATE password_resets SET used_at = ? WHERE id = ?', [nowIso(), row.id]);
  run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [nowIso(), row.user_id]);   // các liên kết khác mất hiệu lực
  logEvent({ module: 'admin', entityType: 'users', entityId: row.user_id, action: 'update', note: 'password_reset_link_used', after: { ip: context.ip ?? null }, source: 'system' });
  return { userId: row.user_id, username: row.username };
}

export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_BASE_URL || `http://localhost:${env.PORT ?? 4173}`).replace(/\/+$/, '');
}

export function resetLink(token: string): string { return `${appBaseUrl()}/?reset=${encodeURIComponent(token)}`; }

const REASON_TEXT: Record<ResetReason, string> = {
  startup: 'Hệ thống Mekong Green vừa được khởi động lại',
  operator_reset: 'Người vận hành vừa chạy lệnh đặt lại mật khẩu SAdmin trên máy chủ',
  created: 'Tài khoản SAdmin vừa được khởi tạo',
  admin_request: 'Có yêu cầu đặt lại mật khẩu SAdmin',
};

export interface SuperAdminResetMail { sent: boolean; to: string | null; transport?: MailResult['transport']; detail?: string; expiresAt?: string }

/**
 * Gửi email đặt lại mật khẩu SAdmin. Không bao giờ ném lỗi ra ngoài (khởi động không được đổ vì mail).
 * Trả về kết quả để nơi gọi in log cho đúng.
 */
export async function sendSuperAdminResetEmail(reason: ResetReason): Promise<SuperAdminResetMail> {
  const to = superAdminResetEmail();
  if (!to) return { sent: false, to: null };
  const admin = one<{ id: string }>('SELECT id FROM users WHERE username = ?', [SUPER_ADMIN_USERNAME]);
  if (!admin) return { sent: false, to };
  try {
    const { token, expiresAt } = issueResetToken(admin.id, reason);
    const link = resetLink(token);
    const at = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const result = await sendMail({
      to,
      subject: `[Mekong Green] Đặt lại mật khẩu SAdmin — ${at}`,
      text: `${REASON_TEXT[reason]} lúc ${at} (giờ Việt Nam).\n\n` +
        `Để đặt mật khẩu mới cho tài khoản quản trị SAdmin, mở liên kết dưới đây trong vòng ${RESET_LINK_MINUTES} phút:\n\n` +
        `${link}\n\n` +
        'Liên kết chỉ dùng được MỘT lần. Khi bạn đặt mật khẩu mới, mọi phiên đăng nhập hiện có của SAdmin sẽ bị huỷ và tài khoản được mở khoá nếu đang bị khoá.\n' +
        'Nếu bạn không dùng liên kết, mật khẩu hiện tại vẫn giữ nguyên và liên kết tự hết hạn.\n\n' +
        'Nếu bạn không mong đợi thư này, hãy kiểm tra ngay ai đã khởi động lại hoặc đặt lại hệ thống — sự kiện đã được ghi trong nhật ký hệ thống.\n' +
        '— Mekong Green Platform (thư tự động, vui lòng không trả lời)',
    });
    logEvent({ module: 'admin', entityType: 'users', entityId: admin.id, action: 'update', note: `sadmin_reset_email:${reason}`, after: { to, transport: result.transport }, source: 'system' });
    return { sent: result.transport !== 'outbox', to, transport: result.transport, detail: result.detail, expiresAt };
  } catch (error) {
    console.error(`[auth] Không gửi được email đặt lại SAdmin tới ${to}: ${(error as Error).message}`);
    return { sent: false, to, detail: (error as Error).message };
  }
}

/** Dòng log ngắn gọn, nhất quán giữa khởi động và script. */
export function describeResetMail(r: SuperAdminResetMail): string {
  if (!r.to) return '[auth] SADMIN_RESET_EMAIL tắt — không gửi email đặt lại SAdmin.';
  if (r.sent) return `[auth] Đã gửi email đặt lại mật khẩu SAdmin tới ${r.to} qua ${r.transport} (liên kết hiệu lực tới ${r.expiresAt}).`;
  if (r.transport === 'outbox') return `[auth] CHƯA gửi được email đặt lại SAdmin tới ${r.to} (chưa cấu hình SMTP_HOST/webhook) — thư nằm ở ${r.detail}.`;
  return `[auth] Không gửi được email đặt lại SAdmin tới ${r.to}: ${r.detail ?? 'lỗi không rõ'}.`;
}
