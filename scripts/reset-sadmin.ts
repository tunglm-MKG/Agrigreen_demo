/**
 * Đặt lại mật khẩu SAdmin khi mất (chỉ chạy được trên máy chủ, tức là người có quyền truy cập hệ điều hành).
 *
 *   node scripts/reset-sadmin.ts                      → sinh mật khẩu tạm, in ra MỘT lần, bắt đổi khi đăng nhập
 *   SUPER_ADMIN_PASSWORD=... node scripts/reset-sadmin.ts   → đặt đúng mật khẩu này (phải đạt chính sách)
 *
 * Mọi phiên đang mở của SAdmin bị huỷ. Có thể chạy khi máy chủ đang hoạt động.
 */
import { migrate } from '../src/platform/db/schema.ts';
import { one, run } from '../src/platform/db/db.ts';
import { changePassword, generateTemporaryPassword, assertStrongPassword } from '../src/platform/auth/users.ts';
import { logEvent } from '../src/platform/audit/audit.ts';
import { describeResetMail, sendSuperAdminResetEmail } from '../src/platform/auth/passwordReset.ts';

migrate();
const row = one<{ id: string }>("SELECT id FROM users WHERE username = 'SAdmin'");
if (!row) { console.error('Chưa có tài khoản SAdmin — khởi động máy chủ một lần để tạo.'); process.exit(1); }
const provided = process.env.SUPER_ADMIN_PASSWORD?.trim();
if (provided) assertStrongPassword(provided);
const password = provided || generateTemporaryPassword(16);
changePassword(row.id, password, { enforcePolicy: true });
run('UPDATE users SET must_change_pw = ?, failed_attempts = 0, locked_until = NULL, status = ? WHERE id = ?', [provided ? 0 : 1, 'active', row.id]);
logEvent({ module: 'admin', entityType: 'users', entityId: row.id, action: 'update', note: 'super_admin_reset_by_operator', source: 'system' }, { name: 'operator' });
// Có chủ đích: người vận hành chạy trên máy chủ để nhận mật khẩu tạm; không lưu lại ở đâu khác.
console.log(provided // codeql[js/clear-text-logging]
  ? 'Đã đặt mật khẩu SAdmin theo SUPER_ADMIN_PASSWORD. Mọi phiên cũ đã bị huỷ.'
  : `Mật khẩu tạm của SAdmin (chỉ hiện một lần, phải đổi khi đăng nhập): ${password}`);
// Yêu cầu 24/09/2026: mỗi lần đặt lại cũng gửi email đặt lại (liên kết một lần) tới SADMIN_RESET_EMAIL.
console.log(describeResetMail(await sendSuperAdminResetEmail('operator_reset')));
