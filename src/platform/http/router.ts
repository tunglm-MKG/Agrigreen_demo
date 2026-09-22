/**
 * Router HTTP tối giản, không phụ thuộc thư viện ngoài.
 * Hỗ trợ tham số động dạng `/api/hubs/:id` và middleware kiểm tra quyền.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { userFromToken, type User } from '../auth/users.ts';
import { can } from '../auth/rbac.ts';
import { logEvent } from '../audit/audit.ts';
import { findReplay, storeResponse } from './idempotency.ts';

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  user: User | null;
  actor: { id?: string | null; name?: string | null };
}

export type Handler = (ctx: Context) => unknown | Promise<unknown>;

interface Route {
  method: string;
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

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const notFound = (message = 'Không tìm thấy dữ liệu') => new HttpError(404, message);
export const forbidden = (message = 'Không đủ quyền truy cập') => new HttpError(403, message);
export const unauthorized = (message = 'Chưa đăng nhập') => new HttpError(401, message);

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler, permission?: string): this {
    this.routes.push({
      method,
      segments: path.split('/').filter(Boolean),
      handler,
      permission,
    });
    return this;
  }

  get(path: string, handler: Handler, permission?: string): this {
    return this.add('GET', path, handler, permission);
  }

  post(path: string, handler: Handler, permission?: string): this {
    return this.add('POST', path, handler, permission);
  }

  put(path: string, handler: Handler, permission?: string): this {
    return this.add('PUT', path, handler, permission);
  }

  patch(path: string, handler: Handler, permission?: string): this {
    return this.add('PATCH', path, handler, permission);
  }

  delete(path: string, handler: Handler, permission?: string): this {
    return this.add('DELETE', path, handler, permission);
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
    const parts = pathname.split('/').filter(Boolean);
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
    const found = this.match(req.method ?? 'GET', url.pathname);
    if (!found) return false;

    const token = extractToken(req);
    const user = userFromToken(token);

    if (found.route.permission) {
      if (!user) throw unauthorized();
      if (!can(user.roles, found.route.permission)) {
        // CGH US-LOG-01 / FN-12 BR-01: truy cập bị từ chối do không đủ quyền phải vào nhật ký (ai, đường dẫn, quyền thiếu).
        try {
          logEvent({ module: 'admin', entityType: 'access_denied', entityId: user.id, action: 'update',
            after: { method: req.method, path: url.pathname, permission: found.route.permission }, source: 'api' }, { id: user.id, name: user.fullName });
        } catch { /* không để lỗi ghi log chặn phản hồi 403 */ }
        throw forbidden(`Vai trò hiện tại không có quyền "${found.route.permission}"`);
      }
    }

    // Chống ghi trùng: cùng khoá của cùng người → trả lại kết quả cũ, không chạy lại.
    const method = req.method ?? 'GET';
    const idemHeader = req.headers['idempotency-key'];
    const idemKey = method !== 'GET' && method !== 'HEAD' && typeof idemHeader === 'string' && idemHeader.length >= 8
      ? idemHeader.slice(0, 128)
      : null;
    if (idemKey) {
      const replay = findReplay(idemKey, user?.id ?? null, method, url.pathname);
      if (replay) {
        await readBody(req); // tiêu thụ body để kết nối đóng sạch
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
      body: await readBody(req),
      user,
      actor: { id: user?.id ?? null, name: user?.fullName ?? 'anonymous' },
    };

    const result = await found.route.handler(ctx);
    if (result !== undefined && !res.writableEnded) {
      if (idemKey) storeResponse(idemKey, user?.id ?? null, method, url.pathname, 200, result);
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

export async function readBody(req: IncomingMessage): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
