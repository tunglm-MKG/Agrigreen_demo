import { randomUUID, createHash } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sinh mã nghiệp vụ dạng `PREFIX-000123`.
 * Dùng cho Mã HTX / Mã chủ sở hữu / Mã máy — theo BRD Bản đồ CGH các mã này
 * do HỆ THỐNG TỰ SINH, Admin không nhập tay và không sửa được sau khi tạo.
 */
export function sequenceCode(prefix: string, sequence: number, width = 6): string {
  return `${prefix}-${String(sequence).padStart(width, '0')}`;
}

/** Băm nội dung để so sánh/ghi vết bất biến (dùng cho snapshot và MRV). */
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/** Băm mật khẩu (scrypt-like đơn giản bằng sha256 + salt, đủ cho môi trường nội bộ). */
export function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}
