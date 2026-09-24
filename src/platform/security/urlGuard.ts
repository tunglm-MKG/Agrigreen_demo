/**
 * CHẶN SSRF CHO URL DO NGƯỜI DÙNG CẤU HÌNH (đánh giá bảo mật 24/09/2026, M-03).
 *
 * Webhook SMS/email được quản trị viên nhập qua giao diện. Trước khi lưu và trước MỖI lần gửi:
 *   - chỉ https, không có user:pass trong URL;
 *   - tên miền không phải localhost/*.internal/*.local;
 *   - mọi địa chỉ IP phân giải được đều không thuộc dải riêng, loopback, link-local, CGNAT,
 *     hay IPv4 nhúng trong IPv6;
 *   - nếu đặt WEBHOOK_ALLOWED_HOSTS (danh sách phân cách dấu phẩy) thì host phải nằm trong đó.
 * Khi gửi: không theo redirect, timeout 10 giây.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE_V4: [number, number][] = [
  [0x0a000000, 8],    // 10.0.0.0/8
  [0xac100000, 12],   // 172.16.0.0/12
  [0xc0a80000, 16],   // 192.168.0.0/16
  [0x7f000000, 8],    // 127.0.0.0/8
  [0xa9fe0000, 16],   // 169.254.0.0/16 (link-local, metadata)
  [0x00000000, 8],    // 0.0.0.0/8
  [0x64400000, 10],   // 100.64.0.0/10 (CGNAT)
  [0xe0000000, 4],    // 224.0.0.0/4 multicast
  [0xf0000000, 4],    // 240.0.0.0/4 reserved
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return PRIVATE_V4.some(([base, bits]) => (v4 >>> (32 - bits)) === (base >>> (32 - bits)));
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;   // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;   // fe80::/10 link-local
  return false;
}

export async function assertSafeWebhookUrl(raw: string, purpose = 'Webhook'): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${purpose}: địa chỉ không hợp lệ.`); }
  if (url.protocol !== 'https:') throw new Error(`${purpose} phải dùng https:// (đang là ${url.protocol}).`);
  if (url.username || url.password) throw new Error(`${purpose}: không nhúng tài khoản/mật khẩu trong URL.`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error(`${purpose}: không chấp nhận máy chủ nội bộ "${host}".`);
  }
  const allow = (process.env.WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new Error(`${purpose}: máy chủ "${host}" không nằm trong WEBHOOK_ALLOWED_HOSTS.`);
  }
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try { addresses = (await lookup(host, { all: true })).map((a) => a.address); } catch { throw new Error(`${purpose}: không phân giải được tên miền "${host}".`); }
  }
  if (!addresses.length) throw new Error(`${purpose}: tên miền "${host}" không có địa chỉ IP.`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error(`${purpose}: "${host}" trỏ tới địa chỉ nội bộ ${address} — bị chặn để tránh SSRF.`);
  }
  return url;
}

/** Tuỳ chọn fetch an toàn cho webhook: không theo redirect, có timeout. */
export function safeFetchInit(init: RequestInit = {}, timeoutMs = 10_000): RequestInit {
  return { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) };
}
