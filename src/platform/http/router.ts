/**
 * Router HTTP tối giản, không phụ thuộc thư viện ngoài.
 * Hỗ trợ tham số động dạng `/api/hubs/:id` và middleware kiểm tra quyền.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { userFromToken, type User } from '../auth/users.ts';
import { can } from '../auth/rbac.ts';
import { logEvent } from '../audit/audit.ts';
import { findReplay, storeResponse } from './idempotency.ts';
import { unitOfWork, withWriteLock } from '../db/db.ts';

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  user: User | null;
  actor: { id?: string | null; name?: string | null };
  /** Đường dẫn đã chuẩn hoá (gộp `//`, bỏ `/` cuối) — guard và nhật ký phải dùng cái này, không dùng URL thô. */
  path: string;
  /** Mẫu route đã khớp, ví dụ `/inputs/purchases/:id` — kiểm quyền theo route + params, không diễn giải URL lần hai. */
  routePath: string;
  /** Quyền gác route (nếu có) — để guard suy ra hệ thống con của route. */
  routePermission?: string;
}

/** Chuẩn hoá đường dẫn MỘT LẦN cho cả routing lẫn guard: `/a//b/` → `/a/b` (review 24/09/2026, R1). */
export function normalizePath(pathname: string): string {
  return '/' + pathname.split('/').filter(Boolean).join('/');
}

export type Handler = (ctx: Context) => unknown | Promise<unknown>;

export interface RouteOptions {
  /** false → handler ghi chạy ngoài giao dịch (vẫn qua khoá ghi) — dùng cho VACUUM INTO, thao tác tệp dài, và các
   *  handler mà trạng thái phải được LƯU cả khi ném lỗi (đếm lần đăng nhập sai). */
  unitOfWork?: boolean;
  /** Giới hạn thân yêu cầu (byte); mặc định DEFAULT_MAX_BODY_BYTES. Route tải tệp đặt cao hơn (H-02). */
  maxBodyBytes?: number;
  /** true → phản hồi chứa bí mật (mật khẩu tạm): không lưu vào bảng chống trùng và không phát lại (M-02). */
  sensitive?: boolean;
}

/** 1 MB cho JSON thường; tệp đính kèm 12 MB → base64 ≈ 16 MB + bao JSON. */
export const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;
export const UPLOAD_MAX_BODY_BYTES = 17 * 1024 * 1024;

/** Đằng sau Render/Fly luôn là HTTPS; cờ Secure của cookie lấy theo header proxy hoặc socket TLS. */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  return proto === 'https' || Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/**
 * Chống CSRF lớp hai (L-04): yêu cầu ghi có header Origin thì Origin phải trùng host đang phục vụ;
 * không có Origin nhưng trình duyệt báo Sec-Fetch-Site: cross-site cũng bị từ chối. Client API (không gửi
 * Origin, không phải trình duyệt) không bị ảnh hưởng.
 */
export function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin === 'string' && origin && origin !== 'null') {
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (!host || originHost !== host) throw new HttpError(403, 'Yêu cầu ghi đến từ nguồn (Origin) khác — bị từ chối để chống CSRF.');
    return;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Yêu cầu ghi xuyên site bị từ chối để chống CSRF.');
}

interface Route {
  method: string;
  path: string;
  options: RouteOptions;
  segments: string[];
  handler: Handler;
  permission?: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Nhãn tiếng Việt cho ràng buộc CSDL hay gặp — để lỗi UNIQUE/NOT NULL không lộ tên bảng/cột ra người dùng (UAT DEF-SYS-01). */
const DB_FIELD_LABELS: Record<string, string> = {
  'org_nodes.code': 'Mã đầu mối tổ chức', 'org_nodes.name': 'Tên đầu mối tổ chức',
  'users.username': 'Tên đăng nhập', 'users.full_name': 'Họ tên', 'users.email': 'Email', 'users.phone': 'Số điện thoại',
  'protocol_steps.activity': 'Hoạt động của bước quy trình', 'protocol_steps.name': 'Tên bước quy trình',
  'machine_types.code': 'Mã chủng loại máy', 'machine_types.name': 'Tên chủng loại máy',
  'seasons.code': 'Mã mùa vụ', 'rice_varieties.code': 'Mã giống lúa', 'market_prices.commodity, market_prices.price_date, market_prices.region': 'Bản ghi giá (mặt hàng, ngày, vùng)',
  'cooperatives.tax_code': 'Mã số thuế', 'cooperatives.code': 'Mã HTX', 'machines.serial_number': 'Số máy (SN)', 'facilities.code': 'Mã cơ sở',
  'knowledge_articles.code': 'Mã bài viết', 'extension_officers.phone': 'Số điện thoại cán bộ',
};
const labelOf = (path: string) => DB_FIELD_LABELS[path] ?? `trường "${path.split('.').pop()}"`;

/**
 * Chuyển lỗi kỹ thuật (ràng buộc SQLite, lỗi kiểu dữ liệu JS) thành thông điệp nghiệp vụ tiếng Việt.
 * Trả về `{ message, technical }`: `technical` khác null nghĩa là thông điệp gốc đã bị che và nên ghi log máy chủ.
 */
export function friendlyError(error: unknown): { message: string; technical: string | null } {
  const raw = error instanceof Error ? error.message : String(error);
  let m = /UNIQUE constraint failed: (.+)$/.exec(raw);
  if (m) return { message: `${labelOf(m[1].trim())} đã tồn tại — vui lòng dùng giá trị khác.`, technical: raw };
  m = /NOT NULL constraint failed: ([\w.]+)/.exec(raw);
  if (m) return { message: `Thiếu trường bắt buộc: ${labelOf(m[1])}.`, technical: raw };
  m = /CHECK constraint failed: ([\w.]+)/.exec(raw);
  if (m) return { message: `Giá trị của ${labelOf(m[1])} không hợp lệ.`, technical: raw };
  if (/FOREIGN KEY constraint failed/.test(raw)) return { message: 'Bản ghi tham chiếu tới dữ liệu không tồn tại hoặc đã bị xoá.', technical: raw };
  if (/cannot be bound|is not iterable|Cannot read propert|is not a function|Cannot convert undefined|Invalid time value|Unexpected token/.test(raw)) {
    return { message: 'Dữ liệu gửi lên không đúng định dạng hoặc thiếu trường bắt buộc. Kiểm tra lại biểu mẫu rồi thử lại.', technical: raw };
  }
  if (/no such column|ambiguous column|no such table|SQLITE_|syntax error|database is locked/.test(raw)) {
    return { message: 'Hệ thống gặp lỗi khi truy vấn dữ liệu. Vui lòng thử lại; nếu vẫn lỗi hãy báo quản trị viên (mã lỗi: DB).', technical: raw };
  }
  // Đánh giá bảo mật 24/09/2026 (M-07): chỉ lỗi NGHIỆP VỤ ném có chủ đích (Error thuần, không mã hệ thống, không
  // dấu vết kỹ thuật) mới được trả nguyên văn; mọi thứ khác trả thông điệp chung và ghi log máy chủ.
  const isPlainBusinessError = error instanceof Error && error.constructor === Error && !('code' in error) && !('errno' in error);
  const looksTechnical = /[A-Za-z]:\\|\/app\/|\/src\/|\.ts:\d|\.js:\d|\bat \w+ \(|ENOENT|EACCES|EPERM|ECONN|ETIMEDOUT|ERR_[A-Z_]+|SQLITE|TypeError|ReferenceError|RangeError|undefined is not|null is not/.test(raw);
  if (isPlainBusinessError && !looksTechnical) return { message: raw, technical: null };
  return { message: 'Hệ thống gặp lỗi không mong đợi. Vui lòng thử lại; nếu vẫn lỗi hãy báo quản trị viên (mã lỗi: SYS).', technical: raw };
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const notFound = (message = 'Không tìm thấy dữ liệu') => new HttpError(404, message);
export const forbidden = (message = 'Không đủ quyền truy cập') => new HttpError(403, message);
export const unauthorized = (message = 'Chưa đăng nhập') => new HttpError(401, message);

export type Guard = (ctx: Context, pathname: string) => void | Promise<void>;

export class Router {
  private readonly routes: Route[] = [];
  private readonly guards: Guard[] = [];

  /** Hàm chạy trước MỌI handler (sau khi đã xác thực và đọc body) — dùng để chốt phạm vi dữ liệu. */
  guard(fn: Guard): this {
    this.guards.push(fn);
    return this;
  }

  listRoutes(): RouteInfo[] {
    return this.routes.map((r) => ({ method: r.method, path: r.path, permission: r.permission, options: r.options }));
  }

  add(method: string, path: string, handler: Handler, permission?: string, options: RouteOptions = {}): this {
    this.routes.push({
      method,
      path: normalizePath(path),
      segments: path.split('/').filter(Boolean),
      handler,
      permission,
      options,
    });
    return this;
  }

  get(path: string, handler: Handler, permission?: string, options?: RouteOptions): this {
    return this.add('GET', path, handler, permission, options);
  }

  post(path: string, handler: Handler, permission?: string, options?: RouteOptions): this {
    return this.add('POST', path, handler, permission, options);
  }

  put(path: string, handler: Handler, permission?: string, options?: RouteOptions): this {
    return this.add('PUT', path, handler, permission, options);
  }

  patch(path: string, handler: Handler, permission?: string): this {
    return this.add('PATCH', path, handler, permission);
  }

  delete(path: string, handler: Handler, permission?: string, options?: RouteOptions): this {
    return this.add('DELETE', path, handler, permission, options);
  }

  /** Gộp các route của một router con vào router này, thêm tiền tố đường dẫn. */
  mount(prefix: string, child: Router): this {
    const prefixSegments = prefix.split('/').filter(Boolean);
    for (const route of child.routes) {
      this.routes.push({ ...route, segments: [...prefixSegments, ...route.segments] });
    }
    return this;
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = normalizePath(pathname).split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]);
        else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const pathname = normalizePath(url.pathname);
    const found = this.match(req.method ?? 'GET', pathname);
    if (!found) return false;

    const token = extractToken(req);
    const user = userFromToken(token);

    if (found.route.permission) {
      if (!user) throw unauthorized();
      if (!can(user.roles, found.route.permission)) {
        // CGH US-LOG-01 / FN-12 BR-01: truy cập bị từ chối do không đủ quyền phải vào nhật ký (ai, đường dẫn, quyền thiếu).
        try {
          logEvent({ module: 'admin', entityType: 'access_denied', entityId: user.id, action: 'update',
            after: { method: req.method, path: pathname, permission: found.route.permission }, source: 'api' }, { id: user.id, name: user.fullName });
        } catch { /* không để lỗi ghi log chặn phản hồi 403 */ }
        throw forbidden(`Vai trò hiện tại không có quyền "${found.route.permission}"`);
      }
    }

    // Chống ghi trùng: cùng khoá của cùng người → trả lại kết quả cũ, không chạy lại.
    // Route xác thực (/auth/*) KHÔNG tham gia: phản hồi đăng nhập chứa token, nếu lưu lại thì
    // một yêu cầu sai mật khẩu dùng cùng khoá sẽ nhận lại token cũ (review 24/09/2026, P1 #5).
    const method = req.method ?? 'GET';
    const idemHeader = req.headers['idempotency-key'];
    const isAuthRoute = /(^|\/)auth\//.test(pathname);
    const idemKey = method !== 'GET' && method !== 'HEAD' && !isAuthRoute && typeof idemHeader === 'string' && idemHeader.length >= 8
      ? idemHeader.slice(0, 128)
      : null;
    // Yêu cầu ghi: chống CSRF theo Origin và giới hạn kích thước thân TRƯỚC khi đọc (L-04, H-02).
    if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);
    const maxBody = found.route.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (idemKey && !found.route.options.sensitive) {
      const replay = findReplay(idemKey, user?.id ?? null, method, pathname);
      if (replay) {
        await readBody(req, maxBody); // tiêu thụ body để kết nối đóng sạch
        res.setHeader('Idempotency-Replayed', 'true');
        sendJson(res, replay.status, replay.body);
        return true;
      }
    }

    const ctx: Context = {
      req,
      res,
      params: found.params,
      query: url.searchParams,
      body: await readBody(req, maxBody),
      user,
      actor: { id: user?.id ?? null, name: user?.fullName ?? 'anonymous' },
      path: pathname,
      routePath: found.route.path,
      routePermission: found.route.permission,
    };

    // Yêu cầu GHI chạy trong một đơn vị công việc: guard + handler + nhật ký + outbox cùng commit;
    // ném lỗi ở bất kỳ đâu → không còn "báo lỗi nhưng dữ liệu đã đổi" (review 24/09/2026, A04).
    const execute = async () => {
      for (const guard of this.guards) await guard(ctx, pathname);
      return found.route.handler(ctx);
    };
    const mutating = method !== 'GET' && method !== 'HEAD';
    const result = mutating ? (found.route.options.unitOfWork === false ? await withWriteLock(execute) : await unitOfWork(execute)) : await execute();
    if (result !== undefined && !res.writableEnded) {
      if (idemKey && !found.route.options.sensitive) storeResponse(idemKey, user?.id ?? null, method, pathname, 200, result);
      sendJson(res, 200, result);
    }
    return true;
  }
}

export function extractToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)mg_session=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  // H-02: từ chối sớm theo Content-Length, và đếm byte khi đọc — vượt ngưỡng là huỷ kết nối, không gom hết vào RAM.
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Trả 413 ngay (chưa đọc byte nào); Node đóng kết nối sau phản hồi vì thân chưa được tiêu thụ.
    throw new HttpError(413, `Thân yêu cầu ${(declared / 1_048_576).toFixed(1)} MB vượt giới hạn ${(maxBytes / 1_048_576).toFixed(0)} MB.`);
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += (chunk as Buffer).length;
    if (received > maxBytes) {
      req.destroy();
      throw new HttpError(413, `Thân yêu cầu vượt giới hạn ${(maxBytes / 1_048_576).toFixed(0)} MB.`);
    }
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw badRequest('Body không phải JSON hợp lệ');
    }
  }
  // L-04: API chỉ nhận JSON — biểu mẫu x-www-form-urlencoded (thứ trình duyệt gửi được xuyên site) không được diễn giải.
  return raw;
}

/** Danh sách route đã đăng ký — cho test duyệt phạm vi (M-06) và tài liệu. */
export interface RouteInfo { method: string; path: string; permission?: string; options: RouteOptions }

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
