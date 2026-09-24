/**
 * MÃ HOÁ CỘT DỮ LIỆU CÁ NHÂN VÀ BÍ MẬT (rà soát CSDL 24/09/2026 NT 10; đánh giá bảo mật 24/09/2026 M-04, M-05).
 *
 * Số CCCD (`farmers.national_id`, `survey_responses.national_id`) và token kênh gửi được mã hoá
 * AES-256-GCM. Giá trị lưu có tiền tố phiên bản:
 *   - `enc2:<kid>:<payload>`  định dạng hiện hành, mang định danh khoá để xoay được;
 *   - `enc1:<payload>`        định dạng cũ (không có kid) — giải mã bằng cách thử lần lượt các khoá trong vòng khoá.
 *
 * Vòng khoá (key ring):
 *   - DATA_ENCRYPTION_KEY: khoá hiện hành (64 ký tự hex, hoặc chuỗi ≥ 32 ký tự sẽ được dẫn xuất qua SHA-256);
 *     DATA_ENCRYPTION_KEY_ID: định danh (mặc định `k1`).
 *   - DATA_ENCRYPTION_KEYS_PREVIOUS: "kid:khoá,kid:khoá" — chỉ để GIẢI MÃ khi xoay khoá.
 *   - Không có biến môi trường: môi trường production TỪ CHỐI khởi động; môi trường khác sinh khoá vào
 *     `<data>/.keys/data-encryption.key` (kid `file`) để phát triển — khoá nằm cạnh dữ liệu, không dùng cho dữ liệu thật.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, dataDirectory, run } from '../db/db.ts';

const PREFIX_V1 = 'enc1:';
const PREFIX_V2 = 'enc2:';
const ALGO = 'aes-256-gcm';

interface KeyRing { current: { kid: string; key: Buffer; source: 'env' | 'file' }; all: Map<string, Buffer> }
let ring: KeyRing | null = null;
let ringFor = '';

export function keyFilePath(): string { return join(dataDirectory(), '.keys', 'data-encryption.key'); }
const isProduction = () => process.env.NODE_ENV === 'production';

/** 64 hex → 32 byte; chuỗi ≥ 32 ký tự khác → SHA-256 (cho phép dùng secret ngẫu nhiên của nền tảng triển khai). */
function deriveKey(raw: string, label: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (value.length >= 32) return createHash('sha256').update(value, 'utf8').digest();
  throw new Error(`${label} phải là 64 ký tự hex hoặc chuỗi ngẫu nhiên ≥ 32 ký tự.`);
}

function loadRing(): KeyRing {
  const dir = dataDirectory();
  if (ring && ringFor === dir) return ring;
  const all = new Map<string, Buffer>();
  let current: KeyRing['current'];
  const fromEnv = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (fromEnv) {
    const kid = (process.env.DATA_ENCRYPTION_KEY_ID ?? 'k1').trim();
    current = { kid, key: deriveKey(fromEnv, 'DATA_ENCRYPTION_KEY'), source: 'env' };
  } else {
    if (isProduction()) throw new Error('Thiếu DATA_ENCRYPTION_KEY: môi trường production không được tự sinh khoá mã hoá cạnh dữ liệu (M-05).');
    const file = keyFilePath();
    if (!existsSync(file)) {
      mkdirSync(join(dir, '.keys'), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    }
    current = { kid: 'file', key: deriveKey(readFileSync(file, 'utf8'), `tệp khoá ${file}`), source: 'file' };
  }
  all.set(current.kid, current.key);
  for (const entry of (process.env.DATA_ENCRYPTION_KEYS_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx <= 0) throw new Error('DATA_ENCRYPTION_KEYS_PREVIOUS phải có dạng "kid:khoá,kid:khoá".');
    all.set(entry.slice(0, idx), deriveKey(entry.slice(idx + 1), `khoá cũ ${entry.slice(0, idx)}`));
  }
  // Khoá tệp cũ (nếu còn) vẫn đọc được các giá trị enc1 mã hoá trước khi chuyển sang biến môi trường.
  if (current.source === 'env' && !isProduction() && existsSync(keyFilePath())) {
    try { all.set('file', deriveKey(readFileSync(keyFilePath(), 'utf8'), 'tệp khoá')); } catch { /* bỏ qua tệp hỏng */ }
  }
  ring = { current, all };
  ringFor = dir;
  return ring;
}

/** Gọi khi khởi động: ném lỗi rõ ràng nếu production thiếu khoá (thay vì lỗi mơ hồ khi ghi bản ghi đầu tiên). */
export function assertEncryptionKeyConfigured(): void { loadRing(); }

/** Cho test: quên vòng khoá đã nạp (khi đổi thư mục data hoặc biến môi trường). */
export function resetKeyCache(): void { ring = null; ringFor = ''; }

export function encryptionKeyStatus(): { kid: string; source: 'env' | 'file'; previousKids: string[]; production: boolean } {
  const r = loadRing();
  return { kid: r.current.kid, source: r.current.source, previousKids: [...r.all.keys()].filter((k) => k !== r.current.kid), production: isProduction() };
}

export const isEncrypted = (value: unknown): boolean => typeof value === 'string' && (value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2));

/** Mã hoá một giá trị rõ; null/rỗng giữ nguyên; giá trị đã mã hoá không mã hoá lại. */
export function encryptField(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const plain = String(value);
  if (isEncrypted(plain)) return plain;
  const { current } = loadRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, current.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX_V2}${current.kid}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

function decryptWith(key: Buffer, payload: string): string {
  const raw = Buffer.from(payload, 'base64url');
  const decipher = createDecipheriv(ALGO, key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

const UNREADABLE = '[không giải mã được — kiểm tra DATA_ENCRYPTION_KEY / DATA_ENCRYPTION_KEYS_PREVIOUS]';

/** Giải mã; giá trị cũ dạng rõ trả nguyên; hỏng khoá/dữ liệu → chuỗi báo lỗi thay vì ném. */
export function decryptField(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const stored = String(value);
  if (!isEncrypted(stored)) return stored;
  const r = loadRing();
  try {
    if (stored.startsWith(PREFIX_V2)) {
      const rest = stored.slice(PREFIX_V2.length);
      const sep = rest.indexOf(':');
      const kid = rest.slice(0, sep);
      const key = r.all.get(kid);
      if (!key) return UNREADABLE;
      return decryptWith(key, rest.slice(sep + 1));
    }
    const payload = stored.slice(PREFIX_V1.length);
    for (const key of r.all.values()) {
      try { return decryptWith(key, payload); } catch { /* thử khoá kế */ }
    }
    return UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

/** Giá trị đã mã hoá bằng đúng khoá hiện hành (định dạng v2)? Dùng khi xoay khoá. */
export function isCurrentKey(value: unknown): boolean {
  const { current } = loadRing();
  return typeof value === 'string' && value.startsWith(`${PREFIX_V2}${current.kid}:`);
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
    const rows = all<{ id: string; value: string }>(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != '' AND ${column} NOT LIKE '${PREFIX_V1}%' AND ${column} NOT LIKE '${PREFIX_V2}%'`);
    for (const row of rows) { run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [encryptField(row.value), row.id]); encrypted += 1; }
  }
  return encrypted;
}

/** Xoay khoá: mọi giá trị chưa dùng khoá hiện hành (enc1 hoặc enc2 với kid cũ) được giải mã và mã hoá lại. */
export function rotateEncryptedFields(): number {
  let rotated = 0;
  for (const { table, column } of PII_COLUMNS) {
    const rows = all<{ id: string; value: string }>(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE '${PREFIX_V1}%' OR ${column} LIKE '${PREFIX_V2}%'`);
    for (const row of rows) {
      if (isCurrentKey(row.value)) continue;
      const plain = decryptField(row.value);
      if (plain === null || plain === UNREADABLE) throw new Error(`Không giải mã được ${table}.${column} của bản ghi ${row.id} — thiếu khoá cũ trong DATA_ENCRYPTION_KEYS_PREVIOUS.`);
      run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [encryptField(plain), row.id]);
      rotated += 1;
    }
  }
  return rotated;
}
