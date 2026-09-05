/**
 * Kiểm thử THÔNG BÁO CHỦ ĐỘNG — outbox nhiều kênh.
 *
 * Điều đáng bảo vệ nhất: kênh chưa cấu hình không được nuốt thông báo âm thầm,
 * gửi lại không dội chuông, và adapter lỗi không kéo sập tiến trình nền.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, run } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-ntf-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const notify = await import('../src/platform/notify/service.ts');
const users = await import('../src/platform/auth/users.ts');

migrate();
seedAll();
run('DELETE FROM notifications'); // bắt đầu sạch, không dính dòng do seed sinh ra

const actor = { id: 'test', name: 'Kiểm thử' };
const byUsername = (username: string) => users.listUsers().find((u) => u.username === username)!;
const hientruong = byUsername('hientruong');   // field_manager, có zalo_user_id
const dieuphoi = byUsername('dieuphoi');       // logistics, có zalo_user_id + phone
const khonhap = byUsername('khonhap');         // warehouse_op, không zalo

test('Gửi theo vai trò tạo một dòng inapp cho mỗi người; ai có Zalo id có thêm dòng zalo "chờ cấu hình"', () => {
  const n = notify.notify({ module: 'test', title: 'Thử', body: 'nội dung', roles: ['field_manager', 'warehouse_op'] }, actor);
  const rows = all<{ recipient_user_id: string; channel: string; status: string }>('SELECT recipient_user_id, channel, status FROM notifications');
  assert.equal(n, rows.length);
  const mine = rows.filter((r) => r.recipient_user_id === hientruong.id);
  assert.deepEqual(mine.map((r) => `${r.channel}:${r.status}`).sort(), ['inapp:da_gui', 'zalo:cho_cau_hinh']);
  const wh = rows.filter((r) => r.recipient_user_id === khonhap.id);
  assert.deepEqual(wh.map((r) => r.channel), ['inapp'], 'không Zalo id thì không có dòng zalo');
});

test('SMS chỉ đi với mức critical và người có số điện thoại', () => {
  run('DELETE FROM notifications');
  run(`UPDATE users SET phone = '0912000111' WHERE id = ?`, [dieuphoi.id]);
  notify.notify({ module: 'test', title: 'Thường', body: 'x', severity: 'warn', userIds: [dieuphoi.id] }, actor);
  assert.equal(all(`SELECT id FROM notifications WHERE channel = 'sms'`).length, 0);
  notify.notify({ module: 'test', title: 'Nghiêm trọng', body: 'x', severity: 'critical', userIds: [dieuphoi.id] }, actor);
  const sms = one<{ status: string }>(`SELECT status FROM notifications WHERE channel = 'sms'`);
  assert.equal(sms?.status, 'cho_cau_hinh', 'chưa có cổng SMS → chờ cấu hình, không bỏ qua');
});

test('Khoá khử trùng: cùng khoá trong 20 giờ không tạo dòng mới', () => {
  run('DELETE FROM notifications');
  const first = notify.notify({ module: 'test', title: 'A', body: 'a', roles: ['field_manager'], dedupeKey: 'k1' }, actor);
  const second = notify.notify({ module: 'test', title: 'A', body: 'a', roles: ['field_manager'], dedupeKey: 'k1' }, actor);
  assert.ok(first > 0);
  assert.equal(second, 0);
  assert.ok(notify.notify({ module: 'test', title: 'B', body: 'b', roles: ['field_manager'], dedupeKey: 'k2' }, actor) > 0, 'khoá khác thì vẫn báo');
});

test('Người nhận không tồn tại hoặc bị khoá → không tạo dòng nào', () => {
  run('DELETE FROM notifications');
  assert.equal(notify.notify({ module: 'test', title: 'x', body: 'x', userIds: ['khong-co'] }, actor), 0);
  assert.equal(notify.notify({ module: 'test', title: 'x', body: 'x', roles: ['vai_tro_la'] }, actor), 0);
});

test('Cấu hình Zalo xong thì dòng "chờ cấu hình" chuyển sang chờ gửi và được adapter gửi', async () => {
  run('DELETE FROM notifications');
  notify.notify({ module: 'test', title: 'Zalo', body: 'x', userIds: [hientruong.id] }, actor);
  assert.equal(one<{ status: string }>(`SELECT status FROM notifications WHERE channel = 'zalo'`)?.status, 'cho_cau_hinh');

  const sentTo: string[] = [];
  notify.overrideSender('zalo', async (_row, recipient) => { sentTo.push(recipient.zalo_user_id!); });
  notify.setChannelConfig('notify.zalo_access_token', 'token-thu', actor);
  const result = await notify.processOutbox();
  assert.equal(result.sent, 1);
  assert.deepEqual(sentTo, [hientruong.zaloUserId ?? one<{ zalo_user_id: string }>('SELECT zalo_user_id FROM users WHERE id = ?', [hientruong.id])!.zalo_user_id]);
  assert.equal(one<{ status: string; sent_at: string | null }>(`SELECT status, sent_at FROM notifications WHERE channel = 'zalo'`)?.status, 'da_gui');
  assert.equal(notify.channelStatus().zalo.configured, true);
  // Nhật ký không chứa token.
  const log = one<{ after_json: string }>(`SELECT after_json FROM event_log WHERE entity_id = 'notify.zalo_access_token' ORDER BY occurred_at DESC LIMIT 1`);
  assert.ok(log && !log.after_json.includes('token-thu'));
});

test('Adapter lỗi: đếm lần thử, giữ chờ gửi, sang "lỗi" sau 5 lần — không ném ra ngoài', async () => {
  run('DELETE FROM notifications');
  notify.notify({ module: 'test', title: 'Lỗi', body: 'x', userIds: [hientruong.id] }, actor);
  notify.overrideSender('zalo', async () => { throw new Error('Zalo trả lỗi -216'); });
  for (let i = 1; i <= 5; i += 1) {
    const result = await notify.processOutbox();
    assert.equal(result.failed, 1, `lần ${i}`);
    const row = one<{ attempts: number; status: string; last_error: string }>(`SELECT attempts, status, last_error FROM notifications WHERE channel = 'zalo'`)!;
    assert.equal(row.attempts, i);
    assert.equal(row.status, i < 5 ? 'cho_gui' : 'loi');
    assert.match(row.last_error, /-216/);
  }
  const again = await notify.processOutbox();
  assert.equal(again.failed + again.sent, 0, 'dòng lỗi không được thử lại vô hạn');
  assert.ok(notify.outboxProblems().some((p) => p.status === 'loi'));
  notify.overrideSender('zalo', null);
});

test('Đọc phía người dùng: chưa đọc, đánh dấu từng cái và tất cả', () => {
  run('DELETE FROM notifications');
  notify.notify({ module: 'test', title: '1', body: 'x', userIds: [khonhap.id] }, actor);
  notify.notify({ module: 'test', title: '2', body: 'x', userIds: [khonhap.id] }, actor);
  notify.notify({ module: 'test', title: 'khác', body: 'x', userIds: [hientruong.id] }, actor);
  assert.equal(notify.unreadCount(khonhap.id), 2);
  const items = notify.listForUser(khonhap.id) as { id: string; read_at: string | null }[];
  assert.equal(items.length, 2);
  notify.markRead(khonhap.id, [items[0].id]);
  assert.equal(notify.unreadCount(khonhap.id), 1);
  assert.equal(notify.markRead(khonhap.id, 'all'), 1);
  assert.equal(notify.unreadCount(khonhap.id), 0);
  assert.equal(notify.unreadCount(hientruong.id), 1, 'không đụng người khác');
  assert.equal(notify.listForUser(khonhap.id, { unreadOnly: true }).length, 0);
});

test('Quét cảnh báo: việc quá hạn của seed sinh thông báo cho điều hành, chạy lại không sinh thêm', () => {
  run('DELETE FROM notifications');
  const first = notify.runAlertScan();
  assert.ok(first.field_overdue >= 1, JSON.stringify(first));
  const overdue = all<{ title: string }>(`SELECT title FROM notifications WHERE recipient_user_id = ? AND channel = 'inapp' AND module = 'field'`, [hientruong.id]);
  assert.ok(overdue.some((n) => /quá hạn/.test(n.title)));
  const second = notify.runAlertScan();
  assert.equal(second.field_overdue, 0, 'khoá khử trùng theo ngày');
  for (const value of Object.values(second)) assert.ok(value >= 0, 'không quy tắc nào lỗi');
});

test('Ghe chưa cân sau 48 giờ được nhắc cho điều hành, điều phối và kho', () => {
  run('DELETE FROM notifications');
  // Lùi giờ xuống ghe của lượt chưa cân trong seed về 3 ngày trước.
  run(`UPDATE field_loadings SET loaded_at = datetime('now', '-3 day') WHERE weighed_at IS NULL`);
  const result = notify.runAlertScan();
  assert.ok(result.field_unweighed >= 1);
  const recipients = new Set(all<{ recipient_user_id: string }>(`SELECT recipient_user_id FROM notifications WHERE title LIKE 'Ghe % chưa cân%'`).map((r) => r.recipient_user_id));
  assert.ok(recipients.has(hientruong.id) && recipients.has(dieuphoi.id) && recipients.has(khonhap.id));
});
