/**
 * TOTP (RFC 6238) cho xác thực hai lớp — không dùng thư viện ngoài (dự án 0 dependency).
 * HMAC-SHA1, bước 30 giây, 6 chữ số, cửa sổ ±1 bước; chống dùng lại bằng bộ đếm đã dùng cuối.
 * Bí mật là base32 (RFC 4648) 20 byte, tương thích Google Authenticator / Microsoft Authenticator / Aegis…
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateSecret(bytes = 20): string { return base32Encode(randomBytes(bytes)); }

export function hotp(secretBase32: string, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const totpCounter = (atMs = Date.now(), stepSeconds = 30): number => Math.floor(atMs / 1000 / stepSeconds);

export function totp(secretBase32: string, atMs = Date.now()): string { return hotp(secretBase32, totpCounter(atMs)); }

/**
 * Kiểm mã: đúng trong cửa sổ ±window bước và bộ đếm phải LỚN HƠN bộ đếm đã dùng cuối (chống phát lại).
 * Trả về bộ đếm khớp, hoặc null.
 */
export function verifyTotp(secretBase32: string, code: string, options: { window?: number; lastCounter?: number | null; atMs?: number } = {}): number | null {
  const digits = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const now = totpCounter(options.atMs ?? Date.now());
  const window = options.window ?? 1;
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = now + delta;
    if (options.lastCounter != null && counter <= options.lastCounter) continue;
    const expected = Buffer.from(hotp(secretBase32, counter));
    const given = Buffer.from(digits);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return counter;
  }
  return null;
}

/** URI để ứng dụng xác thực nhận cấu hình (nhập tay hoặc dựng QR ở phía client). */
export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
