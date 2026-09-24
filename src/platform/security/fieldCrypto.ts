/**
 * MÃ HOÁ CỘT DỮ LIỆU CÁ NHÂN (rà soát CSDL 24/09/2026, nguyên tắc 10).
 *
 * Số CCCD (`farmers.national_id`, `survey_responses.national_id`) được mã hoá AES-256-GCM
 * trước khi ghi và chỉ giải mã ở tầng dịch vụ. Giá trị lưu có tiền tố `enc1:` để phân biệt
 * với dữ liệu cũ dạng rõ; `encryptPiiAtRest()` chạy khi khởi động để mã hoá nốt bản ghi cũ.
 *
 * Khoá: biến môi trường DATA_ENCRYPTION_KEY (64 ký tự hex) — nếu không có, hệ thống sinh
 * ngẫu nhiên và lưu ở `<thư mục data>/.keys/data-encryption.key`. TỆP KHOÁ KHÔNG NẰM TRONG
 * BẢN SAO LƯU CSDL: phải sao lưu riêng, mất khoá là mất số CCCD đã mã hoá.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, dataDirectory, run } from '../db/db.ts';

const PREFIX = 'enc1:';
const ALGO = 'aes-256-gcm';
let cachedKey: Buffer | null = null;
let cachedFor = '';

export function keyFilePath(): string { return join(dataDirectory(), '.keys', 'data-encryption.key'); }

function loadKey(): Buffer {
  const dir = dataDirectory();
  if (cachedKey && cachedFor === dir) return cachedKey;
  const fromEnv = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Error('DATA_ENCRYPTION_KEY phải là 64 ký tự hex (32 byte).');
    cachedKey = Buffer.from(fromEnv, 'hex');
  } else {
    const file = keyFilePath();
    if (!existsSync(file)) {
      mkdirSync(join(dir, '.keys'), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    }
    cachedKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (cachedKey.length !== 32) throw new Error(`Tệp khoá ${file} không hợp lệ (cần 64 ký tự hex).`);
  }
  cachedFor = dir;
  return cachedKey;
}

/** Cho test: quên khoá đã nạp (khi đổi thư mục data). */
export function resetKeyCache(): void { cachedKey = null; cachedFor = ''; }

export const isEncrypted = (value: unknown): boolean => typeof value === 'string' && value.startsWith(PREFIX);

/** Mã hoá một giá trị rõ; null/rỗng giữ nguyên; giá trị đã mã hoá không mã hoá lại. */
export function encryptField(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const plain = String(value);
  if (isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/** Giải mã; giá trị cũ dạng rõ trả nguyên; hỏng khoá/dữ liệu → chuỗi báo lỗi thay vì ném. */
export function decryptField(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const stored = String(value);
  if (!isEncrypted(stored)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url');
    const decipher = createDecipheriv(ALGO, loadKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return '[không giải mã được — kiểm tra DATA_ENCRYPTION_KEY]';
  }
}

/** Che số CCCD: chỉ lộ 3 số cuối. Nhận cả giá trị đã mã hoá lẫn giá trị rõ. */
export function maskNationalId(value: unknown): string | null {
  const plain = decryptField(value);
  if (!plain) return null;
  if (plain.length <= 3) return '•••';
  return '•'.repeat(plain.length - 3) + plain.slice(-3);
}

export const isMasked = (value: unknown): boolean => typeof value === 'string' && value.includes('•');

const PII_COLUMNS: { table: string; column: string }[] = [
  { table: 'farmers', column: 'national_id' },
  { table: 'survey_responses', column: 'national_id' },
];

/** Mã hoá nốt các bản ghi cũ còn lưu rõ. Idempotent; trả số dòng đã mã hoá. */
export function encryptPiiAtRest(): number {
  let encrypted = 0;
  for (const { table, column } of PII_COLUMNS) {
    const rows = all<{ id: string; value: string }>(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != '' AND ${column} NOT LIKE '${PREFIX}%'`);
    for (const row of rows) { run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [encryptField(row.value), row.id]); encrypted += 1; }
  }
  return encrypted;
}
