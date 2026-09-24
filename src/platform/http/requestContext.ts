/**
 * NGỮ CẢNH YÊU CẦU (đánh giá cấp độ 3, SEC-08): mọi dòng nhật ký ghi trong lúc xử lý một yêu cầu HTTP
 * mang cùng mã truy vết (request id), địa chỉ IP đã xác minh và tenant (HTX) của người gọi — không cần
 * truyền tay qua từng tầng dịch vụ. Dùng AsyncLocalStorage của Node.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userId: string | null;
  tenantId: string | null;
  method: string;
  path: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequest(): RequestContext | null {
  return storage.getStore() ?? null;
}
