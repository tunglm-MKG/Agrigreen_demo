/**
 * CỔNG MÃ TRUY CẬP CHO TOÀN TRANG
 *
 * Khi bản demo được đưa lên Internet, mọi người có đường link đều tới được màn
 * hình đăng nhập — nơi liệt kê sẵn tài khoản mẫu và mật khẩu. Cổng này đứng
 * TRƯỚC màn hình đó: chưa nhập đúng mã thì không thấy gì, kể cả API.
 *
 * Nguyên tắc thiết kế:
 *
 *   - Không đặt mã trong mã nguồn. Đọc từ biến môi trường `DEMO_ACCESS_CODE`.
 *     Không đặt biến này thì cổng TẮT hoàn toàn — chạy trên máy vẫn như cũ,
 *     không ai phải nhập thêm gì.
 *   - Cookie không chứa mã gốc mà chứa dấu vân của mã. Người xem cookie không
 *     suy ngược ra mã để chia sẻ tiếp.
 *   - So sánh bằng hàm chống dò thời gian, và hạn chế số lần thử theo IP. Một
 *     mã ngắn không có hai thứ đó thì dò ra trong vài phút.
 *
 * Đây là rào chắn cho bản trình diễn, KHÔNG phải cơ chế xác thực người dùng.
 * Ai có mã cũng thấy được mọi thứ; phân quyền thật vẫn nằm ở màn hình đăng nhập.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const COOKIE_NAME = 'mg_access';
/** Số lần nhập sai tối đa trong một cửa sổ thời gian, tính theo IP. */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

const attempts = new Map<string, { count: number; resetAt: number }>();

export function accessCode(): string | null {
  const code = process.env.DEMO_ACCESS_CODE?.trim();
  return code ? code : null;
}

export function gateEnabled(): boolean {
  return accessCode() !== null;
}

/** Dấu vân của mã — giá trị đặt trong cookie, không suy ngược ra mã gốc. */
function fingerprint(code: string): string {
  return createHash('sha256').update(`mekong-green:${code}`).digest('hex').slice(0, 32);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  // timingSafeEqual ném lỗi khi độ dài khác nhau, nên so độ dài trước bằng cách
  // băm cả hai về cùng kích thước.
  const hashA = createHash('sha256').update(bufferA).digest();
  const hashB = createHash('sha256').update(bufferB).digest();
  return timingSafeEqual(hashA, hashB);
}

export function hasAccess(req: IncomingMessage): boolean {
  const code = accessCode();
  if (!code) return true;
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return Boolean(cookie) && safeEqual(cookie, fingerprint(code));
}

function clientKey(req: IncomingMessage): string {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function throttled(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** Đằng sau Render/Fly luôn là HTTPS; cờ Secure lấy theo header proxy. */
function isSecure(req: IncomingMessage): boolean {
  return (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() === 'https';
}

/**
 * Xử lý một yêu cầu ở lớp cổng.
 *
 * Trả về `true` nghĩa là đã trả lời xong (hiện trang nhập mã hoặc xử lý form),
 * lời gọi phía sau không cần làm gì thêm.
 */
export function handleGate(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!gateEnabled()) return false;

  // Trang kiểm tra sức khoẻ phải luôn mở, nếu không nền tảng triển khai sẽ coi
  // dịch vụ là hỏng và khởi động lại liên tục.
  if (pathname === '/health') return false;

  if (pathname === '/__access' && req.method === 'POST') {
    handleSubmit(req, res);
    return true;
  }
  if (hasAccess(req)) return false;

  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(gatePage());
  return true;
}

function handleSubmit(req: IncomingMessage, res: ServerResponse): void {
  const key = clientKey(req);
  if (throttled(key)) {
    res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gatePage('Đã nhập sai quá nhiều lần. Thử lại sau 10 phút.'));
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    // Chặn thân yêu cầu quá lớn — biểu mẫu này chỉ có một ô.
    if (chunks.reduce((acc, item) => acc + item.length, 0) > 4_096) req.destroy();
  });
  req.on('end', () => {
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const submitted = (body.get('code') ?? '').trim();
    const expected = accessCode()!;

    if (submitted && safeEqual(submitted, expected)) {
      const flags = [
        `${COOKIE_NAME}=${fingerprint(expected)}`,
        'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=604800',
      ];
      if (isSecure(req)) flags.push('Secure');
      res.writeHead(302, { 'Set-Cookie': flags.join('; '), Location: '/' });
      res.end();
      return;
    }

    recordFailure(key);
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gatePage('Mã truy cập không đúng.'));
  });
}

function gatePage(error?: string): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mekong Green — Bản trình diễn</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #EEF2ED; color: #1B2B26;
      font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      padding: 24px;
    }
    form {
      background: #fff; border: 1px solid #DDE4DF; border-radius: 12px;
      padding: 28px; width: min(400px, 100%);
      box-shadow: 0 2px 10px rgba(0,0,0,.05); display: grid; gap: 14px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .mark {
      width: 44px; height: 44px; border-radius: 12px; background: #DCEBE5;
      display: grid; place-items: center; font-size: 22px;
    }
    h1 { margin: 0; font-size: 17px; }
    p { margin: 0; font-size: 13px; color: #5C6B64; }
    label { display: grid; gap: 5px; font-size: 13px; color: #3D4B45; }
    input {
      font: inherit; padding: 9px 11px; border: 1px solid #C9D4CD;
      border-radius: 8px; letter-spacing: .04em;
    }
    input:focus { outline: 2px solid #1C8C74; outline-offset: 1px; border-color: #1C8C74; }
    button {
      font: inherit; font-weight: 600; padding: 9px 14px; border: 0;
      border-radius: 8px; background: #1C8C74; color: #fff; cursor: pointer;
    }
    button:hover { background: #167260; }
    .error {
      background: #FDECEA; border-left: 3px solid #C0392B; color: #8E2A20;
      padding: 9px 11px; border-radius: 6px; font-size: 13px;
    }
    .note { border-top: 1px solid #EDF1EE; padding-top: 12px; font-size: 12px; color: #78877F; }
  </style>
</head>
<body>
  <form method="POST" action="/__access">
    <div class="brand">
      <span class="mark">🌾</span>
      <div>
        <h1>Mekong Green</h1>
        <p>AgriGreen Platform &amp; ERP nội bộ</p>
      </div>
    </div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <label>Mã truy cập bản trình diễn
      <input name="code" type="password" autocomplete="off" autofocus required />
    </label>
    <button type="submit">Vào xem bản trình diễn</button>
    <p class="note">
      Đây là bản trình diễn với dữ liệu mô phỏng. Liên hệ người gửi link cho bạn
      để nhận mã truy cập.
    </p>
  </form>
</body>
</html>`;
}
