/**
 * THÔNG BÁO CHỦ ĐỘNG — hệ thống biết thì phải nói, không chờ ai mở đúng màn hình.
 *
 * Trước đây mọi cảnh báo (rơm quá hạn, vi phạm cách ly thuốc, kho quá ẩm, thiếu
 * máy) chỉ hiện khi có người vào đúng trang. Cảnh báo không đến tay người cần thì
 * bằng không.
 *
 * Kiến trúc outbox:
 *   notify()        → ghi một dòng cho MỖI người nhận × MỖI kênh, trạng thái cho_gui
 *   processOutbox() → tiến trình nền gửi qua adapter, thử lại tối đa 5 lần
 *
 * Kênh:
 *   inapp   luôn có — chuông trên thanh đầu trang của mọi cổng, gửi xong ngay
 *   zalo    khi người nhận có Zalo user id VÀ đã cấu hình access token Zalo OA
 *   sms     khi người nhận có số điện thoại VÀ đã cấu hình cổng SMS; chỉ mức critical
 *           vì SMS tốn tiền
 *   email   gửi qua webhook HTTP (POST JSON {to, subject, text}) tới dịch vụ mail của đơn vị;
 *           dùng cho mật khẩu tạm khi tạo/đặt lại tài khoản. Nội dung bảo mật bị xoá khỏi
 *           outbox ngay sau khi gửi thành công.
 *
 * Kênh chưa cấu hình KHÔNG bị âm thầm bỏ qua: dòng thông báo mang trạng thái
 * `cho_cau_hinh` để quản trị viên thấy đúng chỗ đang thiếu. Cấu hình đọc từ biến
 * môi trường trước, rồi bảng system_config — đổi được từ giao diện không cần
 * khởi động lại.
 *
 * Web push chưa làm: cần VAPID + mã hoá RFC 8291; khi cần sẽ thêm adapter thứ ba.
 */
import { all, insert, one, run, update } from '../db/db.ts';
import { decryptField, encryptField, isCurrentKey } from '../security/fieldCrypto.ts';
import { assertSafeWebhookUrl, safeFetchInit } from '../security/urlGuard.ts';
import { nowIso, uuid } from '../util/ids.ts';
import { logEvent, type AuditActor } from '../audit/audit.ts';

export type Severity = 'info' | 'warn' | 'critical';
export type Channel = 'inapp' | 'zalo' | 'sms' | 'email';

export const MAX_ATTEMPTS = 5;
/** Cùng khoá trùng trong khoảng này thì không báo lại — tránh dội chuông mỗi lần quét. */
const DEDUPE_WINDOW_HOURS = 20;

export interface NotifyInput {
  title: string;
  body: string;
  severity?: Severity;
  module: string;
  link?: string;            // đường dẫn trong ứng dụng, ví dụ /field/#field-dashboard
  userIds?: string[];
  roles?: string[];
  dedupeKey?: string;
  entityType?: string;
  entityId?: string;
}

// ---------------------------------------------------------------------------
// Cấu hình kênh
// ---------------------------------------------------------------------------

const SECRET_KEYS = new Set(['notify.zalo_access_token', 'notify.sms_gateway_token', 'notify.email_webhook_token']);
const URL_KEYS = new Set(['notify.sms_gateway_url', 'notify.email_webhook_url']);

function configValue(key: string, envName: string): string | null {
  const env = process.env[envName];
  if (env) return env;
  try {
    const row = one<{ value_json: string }>('SELECT value_json FROM system_config WHERE key = ?', [key]);
    if (!row) return null;
    const parsed = JSON.parse(row.value_json);
    if (typeof parsed !== 'string' || !parsed) return null;
    // M-04: token lưu mã hoá (AES-256-GCM) — giải mã khi dùng; giá trị cũ dạng rõ vẫn đọc được.
    return SECRET_KEYS.has(key) ? decryptField(parsed) : parsed;
  } catch {
    return null;
  }
}

/** Mã hoá nốt token còn lưu rõ (chạy khi khởi động) và mã hoá lại bằng khoá hiện hành (xoay khoá). */
export function rotateChannelSecrets(): number {
  let changed = 0;
  for (const key of SECRET_KEYS) {
    const row = one<{ value_json: string }>('SELECT value_json FROM system_config WHERE key = ?', [key]);
    if (!row) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value_json); } catch { continue; }
    if (typeof parsed !== 'string' || !parsed || isCurrentKey(parsed)) continue;
    const plain = decryptField(parsed);
    if (!plain || plain.startsWith('[không giải mã')) continue;
    run('UPDATE system_config SET value_json = ?, updated_at = ? WHERE key = ?', [JSON.stringify(encryptField(plain)), nowIso(), key]);
    changed += 1;
  }
  return changed;
}

/** URL webhook phải qua kiểm SSRF (M-03) — gọi từ route trước khi lưu. */
export async function assertChannelValueSafe(key: string, value: string): Promise<void> {
  if (URL_KEYS.has(key) && value) await assertSafeWebhookUrl(value, key === 'notify.sms_gateway_url' ? 'Cổng SMS' : 'Webhook email');
}

export function channelConfig() {
  return {
    zaloToken: configValue('notify.zalo_access_token', 'ZALO_OA_ACCESS_TOKEN'),
    smsUrl: configValue('notify.sms_gateway_url', 'SMS_GATEWAY_URL'),
    smsToken: configValue('notify.sms_gateway_token', 'SMS_GATEWAY_TOKEN'),
    emailUrl: configValue('notify.email_webhook_url', 'EMAIL_WEBHOOK_URL'),
    emailToken: configValue('notify.email_webhook_token', 'EMAIL_WEBHOOK_TOKEN'),
    emailFrom: configValue('notify.email_from', 'EMAIL_FROM'),
  };
}

export function setChannelConfig(key: string, value: string, actor: AuditActor = {}): void {
  const allowed = ['notify.zalo_access_token', 'notify.sms_gateway_url', 'notify.sms_gateway_token', 'notify.email_webhook_url', 'notify.email_webhook_token', 'notify.email_from'];
  if (!allowed.includes(key)) throw new Error('Khoá cấu hình không hợp lệ.');
  run(
    `INSERT INTO system_config (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, JSON.stringify(SECRET_KEYS.has(key) && value ? encryptField(value) : value), nowIso(), actor.name ?? null],
  );
  // Không ghi giá trị token vào nhật ký — chỉ ghi rằng nó đã đổi.
  logEvent({ module: 'notify', entityType: 'system_config', entityId: key, action: 'update', after: { set: value.length > 0 } }, actor);
}

export function channelStatus(): Record<string, unknown> {
  const config = channelConfig();
  const pending = all<{ channel: string; status: string; n: number }>(
    'SELECT channel, status, COUNT(*) AS n FROM notifications GROUP BY channel, status');
  const count = (channel: string, status: string) => pending.find((r) => r.channel === channel && r.status === status)?.n ?? 0;
  return {
    inapp: { configured: true, label: 'Chuông trong ứng dụng', sent: count('inapp', 'da_gui') },
    zalo: {
      configured: Boolean(config.zaloToken), label: 'Zalo OA',
      sent: count('zalo', 'da_gui'), waitingConfig: count('zalo', 'cho_cau_hinh'), failed: count('zalo', 'loi'), queued: count('zalo', 'cho_gui'),
      recipients: one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE zalo_user_id IS NOT NULL')?.n ?? 0,
    },
    sms: {
      configured: Boolean(config.smsUrl), label: 'SMS (chỉ mức nghiêm trọng)',
      sent: count('sms', 'da_gui'), waitingConfig: count('sms', 'cho_cau_hinh'), failed: count('sms', 'loi'), queued: count('sms', 'cho_gui'),
    },
    email: {
      configured: Boolean(config.emailUrl), label: 'Email (mật khẩu tạm, thông báo tài khoản)',
      sent: count('email', 'da_gui'), waitingConfig: count('email', 'cho_cau_hinh'), failed: count('email', 'loi'), queued: count('email', 'cho_gui'),
      recipients: one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL AND email <> ''")?.n ?? 0,
      note: 'Webhook nhận POST JSON {to, subject, text, from}. Khi chưa cấu hình, email mật khẩu tạm nằm ở trạng thái "chờ cấu hình" — quản trị viên copy mật khẩu hiện trên màn hình để gửi tay.',
    },
    webpush: { configured: false, label: 'Web push', note: 'Chưa hỗ trợ — cần khoá VAPID và mã hoá RFC 8291' },
  };
}

// ---------------------------------------------------------------------------
// Tạo thông báo
// ---------------------------------------------------------------------------

interface Recipient { id: string; phone: string | null; zalo_user_id: string | null; email?: string | null }

function resolveRecipients(input: NotifyInput): Recipient[] {
  const byId = new Map<string, Recipient>();
  if (input.userIds?.length) {
    for (const row of all<Recipient>(
      `SELECT id, phone, zalo_user_id FROM users WHERE status = 'active' AND id IN (${input.userIds.map(() => '?').join(',')})`,
      input.userIds,
    )) byId.set(row.id, row);
  }
  if (input.roles?.length) {
    for (const row of all<Recipient>(
      `SELECT DISTINCT u.id, u.phone, u.zalo_user_id FROM users u JOIN user_roles r ON r.user_id = u.id
       WHERE u.status = 'active' AND r.role IN (${input.roles.map(() => '?').join(',')})`,
      input.roles,
    )) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/** Trả về số dòng đã tạo. 0 khi không có người nhận hoặc bị khử trùng. */
export function notify(input: NotifyInput, actor: AuditActor = {}): number {
  const severity = input.severity ?? 'info';
  const recipients = resolveRecipients(input);
  if (!recipients.length) return 0;
  const config = channelConfig();
  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3_600_000).toISOString();
  let created = 0;

  for (const user of recipients) {
    if (input.dedupeKey) {
      const dup = one('SELECT id FROM notifications WHERE recipient_user_id = ? AND dedupe_key = ? AND channel = ? AND created_at >= ?',
        [user.id, input.dedupeKey, 'inapp', since]);
      if (dup) continue;
    }
    const channels: { channel: Channel; status: string }[] = [{ channel: 'inapp', status: 'da_gui' }];
    if (user.zalo_user_id) channels.push({ channel: 'zalo', status: config.zaloToken ? 'cho_gui' : 'cho_cau_hinh' });
    if (user.phone && severity === 'critical') channels.push({ channel: 'sms', status: config.smsUrl ? 'cho_gui' : 'cho_cau_hinh' });

    const groupId = uuid();
    for (const { channel, status } of channels) {
      insert('notifications', {
        id: uuid(), group_id: groupId, recipient_user_id: user.id, channel, severity,
        title: input.title, body: input.body, link: input.link ?? null, module: input.module,
        entity_type: input.entityType ?? null, entity_id: input.entityId ?? null,
        dedupe_key: input.dedupeKey ?? null, status, attempts: 0, last_error: null,
        created_at: nowIso(), sent_at: status === 'da_gui' ? nowIso() : null, read_at: null,
      });
      created += 1;
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

type Sender = (row: Record<string, any>, recipient: Recipient) => Promise<void>;

async function sendZalo(row: Record<string, any>, recipient: Recipient): Promise<void> {
  const token = channelConfig().zaloToken;
  if (!token) throw new Error('Chưa cấu hình Zalo OA access token');
  const response = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', safeFetchInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', access_token: token },
    body: JSON.stringify({ recipient: { user_id: recipient.zalo_user_id }, message: { text: `${row.title}\n${row.body}` } }),
  }));
  const payload = await response.json().catch(() => ({})) as { error?: number; message?: string };
  if (!response.ok || (payload.error && payload.error !== 0)) {
    throw new Error(`Zalo trả lỗi ${payload.error ?? response.status}: ${payload.message ?? ''}`.trim());
  }
}

async function sendSms(row: Record<string, any>, recipient: Recipient): Promise<void> {
  const { smsUrl, smsToken } = channelConfig();
  if (!smsUrl) throw new Error('Chưa cấu hình cổng SMS');
  await assertSafeWebhookUrl(smsUrl, 'Cổng SMS');   // kiểm lại TRƯỚC MỖI lần gửi (DNS có thể đổi — M-03)
  const response = await fetch(smsUrl, safeFetchInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(smsToken ? { Authorization: `Bearer ${smsToken}` } : {}) },
    body: JSON.stringify({ to: recipient.phone, text: `${row.title}: ${row.body}`.slice(0, 300) }),
  }));
  if (!response.ok) throw new Error(`Cổng SMS trả ${response.status}`);
}

async function sendEmail(row: Record<string, any>, recipient: Recipient): Promise<void> {
  const { emailUrl, emailToken, emailFrom } = channelConfig();
  if (!emailUrl) throw new Error('Chưa cấu hình webhook email');
  if (!recipient.email) throw new Error('Người nhận không có địa chỉ email');
  await assertSafeWebhookUrl(emailUrl, 'Webhook email');
  const response = await fetch(emailUrl, safeFetchInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(emailToken ? { Authorization: `Bearer ${emailToken}` } : {}) },
    body: JSON.stringify({ to: recipient.email, subject: row.title, text: row.body, from: emailFrom ?? undefined }),
  }));
  if (!response.ok) throw new Error(`Webhook email trả ${response.status}`);
}

const SENDERS: Record<string, Sender> = { zalo: sendZalo, sms: sendSms, email: sendEmail };

/**
 * Gửi thông tin đăng nhập (mật khẩu tạm) cho một người dùng qua email. Không tạo dòng
 * "chuông" trong ứng dụng vì người nhận chưa đăng nhập được. Trả về trạng thái để giao
 * diện nói rõ: đã xếp hàng gửi / chờ cấu hình kênh / người dùng chưa có email.
 */
export function sendCredentialEmail(
  userId: string,
  credentials: { username: string; temporaryPassword: string; kind: 'created' | 'reset' },
  actor: AuditActor = {},
): { status: 'cho_gui' | 'cho_cau_hinh' | 'khong_co_email'; to: string | null; notificationId: string | null } {
  const user = one<{ email: string | null; full_name: string }>('SELECT email, full_name FROM users WHERE id = ?', [userId]);
  if (!user?.email) return { status: 'khong_co_email', to: null, notificationId: null };
  const status = channelConfig().emailUrl ? 'cho_gui' : 'cho_cau_hinh';
  const id = uuid();
  const title = credentials.kind === 'created' ? 'Tài khoản Mekong Green của bạn đã được tạo' : 'Mật khẩu Mekong Green của bạn đã được đặt lại';
  const body = `Xin chào ${user.full_name},\n\nTên đăng nhập: ${credentials.username}\nMật khẩu tạm: ${credentials.temporaryPassword}\n\n` +
    'Hệ thống sẽ yêu cầu đổi mật khẩu ở lần đăng nhập đầu. Mật khẩu mới cần tối thiểu 8 ký tự, gồm chữ thường, chữ in hoa và chữ số.\n' +
    'Nếu bạn không yêu cầu thông tin này, hãy báo ngay cho quản trị viên.';
  insert('notifications', {
    id, group_id: uuid(), recipient_user_id: userId, channel: 'email', severity: 'info', title, body, link: null, module: 'admin',
    entity_type: 'credential', entity_id: userId, dedupe_key: null, status, attempts: 0, last_error: null, created_at: nowIso(), sent_at: null, read_at: null,
  });
  // Nhật ký chỉ ghi RẰNG đã gửi, không ghi mật khẩu.
  logEvent({ module: 'admin', entityType: 'users', entityId: userId, action: 'update', note: `credential_email_${credentials.kind}`, after: { to: user.email, status } }, actor);
  return { status, to: user.email, notificationId: id };
}

/** Cho phép test thay adapter thật bằng adapter giả. */
export function overrideSender(channel: Channel, sender: Sender | null): void {
  if (sender) SENDERS[channel] = sender;
  else delete SENDERS[channel];
}

let outboxBusy = false;
const LEASE_MS = 5 * 60_000;
export async function processOutbox(limit = 50): Promise<{ sent: number; failed: number; skipped: number; busy?: boolean }> {
  // Review 24/09/2026 (O02): một lượt đang chạy (webhook chậm) thì lượt sau không được lấy trùng dòng.
  if (outboxBusy) return { sent: 0, failed: 0, skipped: 0, busy: true };
  outboxBusy = true;
  try {
  // Lease hết hạn (tiến trình trước dừng giữa chừng) → trả về hàng đợi.
  run("UPDATE notifications SET status = 'cho_gui' WHERE status = 'dang_gui' AND (claimed_at IS NULL OR claimed_at < ?)", [new Date(Date.now() - LEASE_MS).toISOString()]);
  // Kênh vừa được cấu hình thì các dòng đang chờ cấu hình phải được gửi.
  const config = channelConfig();
  if (config.zaloToken) run(`UPDATE notifications SET status = 'cho_gui' WHERE channel = 'zalo' AND status = 'cho_cau_hinh'`);
  if (config.smsUrl) run(`UPDATE notifications SET status = 'cho_gui' WHERE channel = 'sms' AND status = 'cho_cau_hinh'`);
  if (config.emailUrl) run(`UPDATE notifications SET status = 'cho_gui' WHERE channel = 'email' AND status = 'cho_cau_hinh'`);

  const rows = all<Record<string, any>>(
    `SELECT n.*, u.phone, u.zalo_user_id, u.email FROM notifications n JOIN users u ON u.id = n.recipient_user_id
     WHERE n.status = 'cho_gui' AND n.attempts < ? ORDER BY n.created_at LIMIT ?`,
    [MAX_ATTEMPTS, limit],
  );
  // Claim: đánh dấu đang gửi TRƯỚC khi await, để lượt khác/tiến trình khác không lấy lại cùng dòng.
  const claimedAt = nowIso();
  for (const row of rows) run("UPDATE notifications SET status = 'dang_gui', claimed_at = ? WHERE id = ? AND status = 'cho_gui'", [claimedAt, row.id]);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    const sender = SENDERS[row.channel];
    if (!sender) { skipped += 1; update('notifications', row.id, { status: 'cho_gui', claimed_at: null }); continue; }
    try {
      await sender(row, { id: row.recipient_user_id, phone: row.phone, zalo_user_id: row.zalo_user_id, email: row.email });
      const values: Record<string, unknown> = { status: 'da_gui', sent_at: nowIso(), attempts: row.attempts + 1, last_error: null };
      // Thư chứa mật khẩu tạm: gửi xong thì xoá nội dung khỏi outbox, không để mật khẩu nằm lại trong CSDL.
      if (row.entity_type === 'credential') values.body = '[Nội dung bảo mật đã được xoá sau khi gửi]';
      update('notifications', row.id, values);
      sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      update('notifications', row.id, {
        attempts, last_error: (error as Error).message.slice(0, 300),
        status: attempts >= MAX_ATTEMPTS ? 'loi' : 'cho_gui',
      });
      failed += 1;
    }
  }
  return { sent, failed, skipped };
  } finally {
    outboxBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Đọc phía người dùng
// ---------------------------------------------------------------------------

export function listForUser(userId: string, options: { unreadOnly?: boolean; limit?: number } = {}): Record<string, unknown>[] {
  return all(
    `SELECT id, severity, title, body, link, module, entity_type, entity_id, created_at, read_at FROM notifications
     WHERE recipient_user_id = ? AND channel = 'inapp' ${options.unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC LIMIT ?`,
    [userId, options.limit ?? 30],
  );
}

export function unreadCount(userId: string): number {
  return one<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ? AND channel = 'inapp' AND read_at IS NULL`, [userId])?.n ?? 0;
}

export function markRead(userId: string, ids: string[] | 'all'): number {
  const at = nowIso();
  if (ids === 'all') {
    const n = unreadCount(userId);
    run(`UPDATE notifications SET read_at = ? WHERE recipient_user_id = ? AND channel = 'inapp' AND read_at IS NULL`, [at, userId]);
    return n;
  }
  if (!ids.length) return 0;
  run(`UPDATE notifications SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [at, userId, ...ids]);
  return ids.length;
}

/** Bảng theo dõi cho quản trị: dòng lỗi và dòng chờ cấu hình gần nhất. */
export function outboxProblems(limit = 50): Record<string, unknown>[] {
  return all(
    `SELECT n.id, n.channel, n.status, n.attempts, n.last_error, n.title, n.created_at, u.username
     FROM notifications n JOIN users u ON u.id = n.recipient_user_id
     WHERE n.status IN ('loi', 'cho_cau_hinh', 'cho_gui') ORDER BY n.created_at DESC LIMIT ?`,
    [limit],
  );
}

// ---------------------------------------------------------------------------
// Quét định kỳ: các điều kiện hệ thống đã biết nhưng chưa ai được báo
// ---------------------------------------------------------------------------

/**
 * Chạy mỗi 10 phút trong máy chủ. Mọi quy tắc đều có khoá khử trùng theo ngày
 * nên chạy lại không dội chuông. Quy tắc theo sự kiện (lượt ghe mới, vi phạm
 * cách ly, cân lệch) nằm ngay tại chỗ phát sinh, không ở đây.
 */
export function runAlertScan(): Record<string, number> {
  const today = nowIso().slice(0, 10);
  const result: Record<string, number> = {};
  const safe = (name: string, fn: () => number) => {
    try { result[name] = fn(); } catch (error) { result[name] = -1; console.error(`[notify] quét "${name}" lỗi:`, (error as Error).message); }
  };

  // FM-02: rơm nằm ruộng quá hạn chưa cuộn xong → điều hành + đội trưởng của đội đó.
  safe('field_overdue', () => {
    const rows = all<{ id: string; code: string; location_label: string; harvest_date: string; expected_straw_tons: number; leader_user_id: string | null; team_name: string | null }>(
      `SELECT j.id, j.code, j.location_label, j.harvest_date, j.expected_straw_tons, t.leader_user_id, t.name AS team_name
       FROM field_jobs j LEFT JOIN field_teams t ON t.id = j.team_id
       JOIN field_job_stages s ON s.job_id = j.id AND s.stage = 'cuon_rom'
       WHERE j.status NOT IN ('hoan_thanh', 'huy') AND s.completed_at IS NULL AND j.harvest_date <= date('now', '-4 day')`);
    let n = 0;
    for (const job of rows) {
      const days = Math.round((Date.parse(today) - Date.parse(job.harvest_date)) / 86_400_000);
      n += notify({
        module: 'field', severity: days >= 6 ? 'critical' : 'warn',
        title: `Rơm quá hạn ${days} ngày — ${job.code}`,
        body: `${job.location_label}: gặt ${job.harvest_date}, ${Math.round(job.expected_straw_tons)} tấn chưa cuộn xong${job.team_name ? ` (${job.team_name})` : ' (chưa phân công)'}. Mỗi ngày trễ rơm ẩm thêm.`,
        link: '/field/#field-dashboard', roles: ['field_manager'],
        userIds: job.leader_user_id ? [job.leader_user_id] : [],
        dedupeKey: `field.overdue.${job.id}.${today}`, entityType: 'field_job', entityId: job.id,
      });
    }
    return n;
  });

  // Việc gặt trong 2 ngày tới mà chưa có đội.
  safe('field_unassigned', () => {
    const rows = all<{ n: number; tons: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(expected_straw_tons), 0) AS tons FROM field_jobs
       WHERE status = 'cho_phan_cong' AND harvest_date BETWEEN date('now', '-3 day') AND date('now', '+2 day')`);
    if (!rows[0]?.n) return 0;
    return notify({
      module: 'field', severity: 'warn', title: `${rows[0].n} việc thu gom sắp gặt chưa có đội`,
      body: `${Math.round(rows[0].tons)} tấn rơm gặt trong 2 ngày tới chưa được phân công. Vào Kế hoạch thu gom bấm phân công tự động.`,
      link: '/field/#field-plan', roles: ['field_manager'], dedupeKey: `field.unassigned.${today}`,
    });
  });

  // Máy hỏng / bảo dưỡng của đội đang có việc.
  safe('field_vehicle_down', () => {
    const rows = all<{ id: string; code: string; name: string; status: string; team_name: string }>(
      `SELECT v.id, v.code, v.name, v.status, t.name AS team_name FROM field_vehicles v JOIN field_teams t ON t.id = v.team_id
       WHERE v.status IN ('hong', 'bao_duong') AND v.kind = 'may_cuon'
         AND EXISTS (SELECT 1 FROM field_jobs j WHERE j.team_id = v.team_id AND j.status IN ('da_phan_cong', 'dang_thuc_hien'))`);
    let n = 0;
    for (const v of rows) {
      n += notify({
        module: 'field', severity: 'warn', title: `Máy cuộn ${v.status === 'hong' ? 'hỏng' : 'bảo dưỡng'} — ${v.team_name}`,
        body: `${v.name} (${v.code}) không dùng được trong khi đội đang có việc. Điều máy dự phòng hoặc chia việc.`,
        link: '/field/#field-teams', roles: ['field_manager'], dedupeKey: `field.vehicle.${v.id}.${today}`, entityType: 'field_vehicle', entityId: v.id,
      });
    }
    return n;
  });

  // Ghe sắp hết / đã hết hạn đăng kiểm → điều phối và điều hành hiện trường (GH-02).
  safe('vessel_expiry', () => {
    const rows = all<{ id: string; code: string; registration_expiry: string }>(
      `SELECT id, code, registration_expiry FROM vessels WHERE status = 'hoat_dong' AND registration_expiry IS NOT NULL
         AND registration_expiry <= date('now', '+30 day')`);
    let n = 0;
    for (const v of rows) {
      const days = Math.round((Date.parse(v.registration_expiry) - Date.parse(today)) / 86_400_000);
      n += notify({
        module: 'tms', severity: days < 0 ? 'critical' : 'warn',
        title: days < 0 ? `Ghe ${v.code} đã hết hạn đăng kiểm` : `Ghe ${v.code} còn ${days} ngày đăng kiểm`,
        body: days < 0 ? `Hết hạn ${Math.abs(days)} ngày (${v.registration_expiry}). Không nên xếp hàng lên ghe này cho tới khi chủ ghe gia hạn.` : `Hạn ${v.registration_expiry}. Nhắc chủ ghe gia hạn để không đứt chuyến giữa vụ.`,
        link: '/erp/#vessels', roles: ['logistics', 'field_manager'], dedupeKey: `vessel.expiry.${v.id}.${today}`, entityType: 'vessel', entityId: v.id,
      });
    }
    return n;
  });

  // Phiếu mua rơm quá hạn thanh toán → Tài chính.
  safe('straw_overdue', () => {
    const rows = all<{ id: string; code: string; amount: number; due_date: string; htx_name: string }>(
      `SELECT t.id, t.code, t.amount, t.due_date, h.name AS htx_name FROM straw_purchase_tickets t LEFT JOIN cooperatives h ON h.id = t.htx_id
       WHERE t.status = 'da_xac_nhan' AND t.due_date < date('now')`);
    let n = 0;
    for (const t of rows) {
      n += notify({
        module: 'straw', severity: 'warn', title: `Phiếu mua rơm ${t.code} quá hạn thanh toán`,
        body: `${Number(t.amount).toLocaleString('vi-VN')} đ trả ${t.htx_name ?? 'HTX'}, hạn ${t.due_date}. Chậm trả là mất niềm tin của HTX ngay trước vụ sau.`,
        link: '/erp/#straw-tickets', roles: ['finance'], dedupeKey: `straw.overdue.${t.id}.${today}`, entityType: 'straw_purchase_tickets', entityId: t.id,
      });
    }
    return n;
  });

  // Kho: cảnh báo môi trường chưa xác nhận → vận hành kho.
  safe('warehouse_env', () => {
    const rows = all<{ id: string; level: string; message: string; facility_id: string }>(
      `SELECT id, level, message, facility_id FROM env_alerts WHERE acknowledged_at IS NULL AND raised_at >= datetime('now', '-2 day')`);
    let n = 0;
    for (const alert of rows) {
      n += notify({
        module: 'warehouse', severity: alert.level === 'nguy_hiem' ? 'critical' : 'warn',
        title: alert.level === 'nguy_hiem' ? 'Kho vượt ngưỡng nguy hiểm' : 'Kho vượt ngưỡng cảnh báo', body: alert.message,
        link: '/erp/#warehouse', roles: ['warehouse_op'], dedupeKey: `wh.env.${alert.id}`, entityType: 'env_alert', entityId: alert.id,
      });
    }
    return n;
  });

  // Ghe đã xuống hàng quá 48 giờ mà nhà máy chưa cân → điều phối + điều hành.
  safe('field_unweighed', () => {
    const rows = all<{ id: string; vessel_code: string; loaded_at: string; bales: number | null; tons: number; code: string }>(
      `SELECT l.id, l.vessel_code, l.loaded_at, l.bales, l.tons, j.code FROM field_loadings l JOIN field_jobs j ON j.id = l.job_id
       WHERE l.weighed_at IS NULL AND l.loaded_at <= datetime('now', '-2 day')`);
    let n = 0;
    for (const l of rows) {
      n += notify({
        module: 'field', severity: 'warn', title: `Ghe ${l.vessel_code} chưa cân sau 48 giờ`,
        body: `Xuống ghe ${l.loaded_at.slice(0, 16).replace('T', ' ')} tại việc ${l.code} (${l.bales ?? '?'} cuộn, ước ${l.tons} tấn) nhưng nhà máy chưa ghi cân. Không cân thì không đối chiếu được và không trả tiền được.`,
        link: '/field/#field-weighing', roles: ['field_manager', 'logistics', 'warehouse_op'],
        dedupeKey: `field.unweighed.${l.id}.${today}`, entityType: 'field_loading', entityId: l.id,
      });
    }
    return n;
  });

  return result;
}
