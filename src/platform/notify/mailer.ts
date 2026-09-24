/**
 * GỬI EMAIL HỆ THỐNG — không phụ thuộc thư viện ngoài.
 *
 * Thứ tự vận chuyển (transport):
 *   1. SMTP trực tiếp khi có SMTP_HOST (node:net / node:tls, STARTTLS hoặc TLS ngầm ở cổng 465,
 *      AUTH PLAIN / LOGIN). Đây là đường chính cho máy chủ của đơn vị.
 *   2. Webhook email của kênh thông báo (notify.email_webhook_url / EMAIL_WEBHOOK_URL) nếu đã cấu hình.
 *   3. Không có gì cả → ghi tệp .eml vào <data>/outbox và cảnh báo ở log (môi trường phát triển);
 *      ở production việc này được coi là LỖI cấu hình và ghi nhật ký với mức cảnh báo.
 *
 * Biến môi trường: SMTP_HOST, SMTP_PORT (587; 465 = TLS ngầm), SMTP_SECURE (1 = TLS ngầm),
 * SMTP_STARTTLS (mặc định bật khi máy chủ hỗ trợ; 0 = không nâng cấp — chỉ dùng cho relay nội bộ/test),
 * SMTP_USER, SMTP_PASS, SMTP_FROM (mặc định EMAIL_FROM hoặc no-reply@mekonggreen.vn),
 * SMTP_TIMEOUT_MS (15000), SMTP_TLS_REJECT_UNAUTHORIZED (1).
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from '../db/db.ts';
import { assertSafeWebhookUrl, safeFetchInit } from '../security/urlGuard.ts';

export interface MailMessage { to: string; subject: string; text: string; from?: string }
export interface MailResult { transport: 'smtp' | 'webhook' | 'outbox'; detail: string }

export interface SmtpConfig {
  host: string; port: number; secure: boolean; starttls: boolean; user?: string; pass?: string;
  from: string; timeoutMs: number; rejectUnauthorized: boolean;
}

export function smtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  const secure = env.SMTP_SECURE === '1' || (env.SMTP_SECURE === undefined && port === 465);
  return {
    host, port, secure,
    starttls: env.SMTP_STARTTLS !== '0',
    user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined,
    from: env.SMTP_FROM || env.EMAIL_FROM || 'no-reply@mekonggreen.vn',
    timeoutMs: Number(env.SMTP_TIMEOUT_MS ?? 15_000),
    rejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED !== '0',
  };
}

const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export function isEmailAddress(value: string): boolean { return ADDRESS_RE.test(value.trim()); }

/** Tiêu đề có dấu → RFC 2047 (UTF-8, base64). */
export function encodeHeaderWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Dựng thư MIME text/plain UTF-8; dot-stuffing theo RFC 5321 §4.5.2 để nội dung không kết thúc DATA sớm. */
export function buildRfc822(message: MailMessage, from: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderWord(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${from.split('@')[1] ?? 'mekonggreen.vn'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
    '',
    ...message.text.replace(/\r?\n/g, '\n').split('\n').map((line) => (line.startsWith('.') ? `.${line}` : line)),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

class SmtpError extends Error {
  readonly code: number;
  constructor(message: string, code: number) { super(message); this.code = code; }
}

/** Máy khách SMTP tối thiểu: EHLO → (STARTTLS → EHLO) → AUTH → MAIL/RCPT/DATA → QUIT. */
export async function sendViaSmtp(message: MailMessage, config: SmtpConfig): Promise<string> {
  let socket: Socket | TLSSocket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: config.rejectUnauthorized })
    : netConnect({ host: config.host, port: config.port });
  socket.setTimeout(config.timeoutMs);
  let buffer = '';
  const waiters: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void }[] = [];
  const fail = (error: Error) => { while (waiters.length) waiters.shift()!.reject(error); };
  const pump = () => {
    // Một phản hồi có thể nhiều dòng: "250-…" tiếp tục, "250 …" kết thúc.
    for (;;) {
      const match = /^(\d{3})[ ](?:.*)\r\n/m.exec(buffer);
      if (!match) return;
      const end = match.index + match[0].length;
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const lines = chunk.split('\r\n').filter(Boolean);
      waiters.shift()?.resolve({ code: Number(match[1]), lines });
    }
  };
  const attach = (s: Socket | TLSSocket) => {
    s.on('data', (d: Buffer) => { buffer += d.toString('utf8'); pump(); });
    s.on('error', (e: Error) => fail(e));
    s.on('timeout', () => { fail(new Error('SMTP: hết thời gian chờ')); s.destroy(); });
    s.on('close', () => fail(new Error('SMTP: kết nối đóng sớm')));
  };
  attach(socket);
  const read = () => new Promise<{ code: number; lines: string[] }>((resolve, reject) => waiters.push({ resolve, reject }));
  const command = async (line: string | null, expect: number[]): Promise<{ code: number; lines: string[] }> => {
    if (line !== null) socket.write(`${line}\r\n`);
    const reply = await read();
    if (!expect.includes(reply.code)) throw new SmtpError(`SMTP ${line?.split(' ')[0] ?? 'greeting'} → ${reply.lines.join(' | ')}`, reply.code);
    return reply;
  };
  const ehlo = async () => (await command(`EHLO ${hostnameForEhlo()}`, [250])).lines.map((l) => l.slice(4).toUpperCase());
  try {
    await command(null, [220]);
    let features = await ehlo();
    if (!config.secure && config.starttls && features.some((f) => f.startsWith('STARTTLS'))) {
      await command('STARTTLS', [220]);
      socket.removeAllListeners('data'); socket.removeAllListeners('error'); socket.removeAllListeners('timeout'); socket.removeAllListeners('close');
      socket = tlsConnect({ socket, servername: config.host, rejectUnauthorized: config.rejectUnauthorized });
      socket.setTimeout(config.timeoutMs);
      attach(socket);
      await new Promise<void>((resolve, reject) => { (socket as TLSSocket).once('secureConnect', resolve); socket.once('error', reject); });
      features = await ehlo();
    } else if (!config.secure && config.starttls && config.user) {
      // Có thông tin đăng nhập mà kênh không mã hoá được → không gửi mật khẩu SMTP dưới dạng rõ.
      throw new Error('SMTP: máy chủ không hỗ trợ STARTTLS — từ chối AUTH trên kênh rõ (đặt SMTP_STARTTLS=0 chỉ cho relay nội bộ không cần đăng nhập).');
    }
    if (config.user) {
      const auth = features.find((f) => f.startsWith('AUTH')) ?? '';
      if (auth.includes('PLAIN')) {
        await command(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.pass ?? ''}`, 'utf8').toString('base64')}`, [235]);
      } else {
        await command('AUTH LOGIN', [334]);
        await command(Buffer.from(config.user, 'utf8').toString('base64'), [334]);
        await command(Buffer.from(config.pass ?? '', 'utf8').toString('base64'), [235]);
      }
    }
    const from = message.from ?? config.from;
    await command(`MAIL FROM:<${bareAddress(from)}> SMTPUTF8`, [250]).catch(async (e) => { if (e instanceof SmtpError && [500, 501, 555].includes(e.code)) return command(`MAIL FROM:<${bareAddress(from)}>`, [250]); throw e; });
    await command(`RCPT TO:<${bareAddress(message.to)}>`, [250, 251]);
    await command('DATA', [354]);
    socket.write(buildRfc822(message, from));
    const accepted = await command('.', [250]);
    await command('QUIT', [221]).catch(() => undefined);
    return accepted.lines.join(' ');
  } finally {
    socket.end(); socket.destroy();
  }
}

const bareAddress = (value: string) => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();
const hostnameForEhlo = () => (process.env.SMTP_EHLO_NAME || 'mekong-green.local').replace(/[^A-Za-z0-9.-]/g, '');

async function sendViaWebhook(message: MailMessage): Promise<string> {
  // Nạp muộn để tránh vòng import với notify/service.ts.
  const { channelConfig } = await import('./service.ts');
  const { emailUrl, emailToken, emailFrom } = channelConfig();
  if (!emailUrl) throw new Error('no-webhook');
  await assertSafeWebhookUrl(emailUrl, 'Webhook email');
  const response = await fetch(emailUrl, safeFetchInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(emailToken ? { Authorization: `Bearer ${emailToken}` } : {}) },
    body: JSON.stringify({ to: message.to, subject: message.subject, text: message.text, from: message.from ?? emailFrom ?? undefined }),
  }));
  if (!response.ok) throw new Error(`Webhook email trả ${response.status}`);
  return `webhook ${response.status}`;
}

export function outboxDirectory(): string { return process.env.MAIL_OUTBOX_DIR || join(dataDirectory(), 'outbox'); }

function writeToOutbox(message: MailMessage): string {
  const dir = outboxDirectory();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.eml`);
  writeFileSync(file, buildRfc822(message, process.env.SMTP_FROM || process.env.EMAIL_FROM || 'no-reply@mekonggreen.vn'), 'utf8');
  return file;
}

/**
 * Gửi một thư hệ thống. Không ném lỗi ra ngoài khi SMTP/webhook hỏng: rơi xuống outbox tệp và
 * trả về `transport: 'outbox'` để nơi gọi ghi log/nhật ký cho đúng. Địa chỉ không hợp lệ thì ném lỗi.
 */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  if (!isEmailAddress(message.to)) throw new Error(`Địa chỉ email không hợp lệ: ${message.to}`);
  const smtp = smtpConfig();
  if (smtp) {
    try { return { transport: 'smtp', detail: await sendViaSmtp(message, smtp) }; }
    catch (error) { console.error(`[mail] SMTP ${smtp.host}:${smtp.port} thất bại: ${(error as Error).message}`); }
  }
  try { return { transport: 'webhook', detail: await sendViaWebhook(message) }; }
  catch (error) { if ((error as Error).message !== 'no-webhook') console.error(`[mail] webhook email thất bại: ${(error as Error).message}`); }
  const file = writeToOutbox(message);
  const level = process.env.NODE_ENV === 'production' ? 'error' : 'warn';
  console[level](`[mail] Chưa cấu hình SMTP_HOST hay webhook email — thư "${message.subject}" tới ${message.to} được ghi vào ${file}`);
  return { transport: 'outbox', detail: file };
}
