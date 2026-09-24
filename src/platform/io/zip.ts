/**
 * Bộ đọc file ZIP tối giản (chỉ đọc, không ghi).
 *
 * File .xlsx thực chất là một gói ZIP chứa các phần XML. Node có sẵn `zlib`
 * để giải nén luồng deflate nhưng KHÔNG có bộ đọc container ZIP, nên phần này
 * tự đọc Central Directory — giữ nguyên cam kết 0 dependency của dự án.
 */
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Đọc danh mục file bên trong gói ZIP. */
/** Giới hạn chống "zip bomb" (SEC-07): số mục, kích thước từng mục, tổng kích thước giải nén và tỷ lệ nén. */
export const ZIP_LIMITS = { maxEntries: 5000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxRatio: 500 };

export function assertZipSafe(entries: ZipEntry[]): void {
  if (entries.length > ZIP_LIMITS.maxEntries) throw new Error(`Gói ZIP có ${entries.length} mục, vượt giới hạn ${ZIP_LIMITS.maxEntries}.`);
  let total = 0;
  for (const entry of entries) {
    if (entry.uncompressedSize > ZIP_LIMITS.maxEntryBytes) throw new Error(`Mục "${entry.name}" giải nén ${(entry.uncompressedSize / 1_048_576).toFixed(0)} MB, vượt giới hạn ${ZIP_LIMITS.maxEntryBytes / 1_048_576} MB.`);
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > ZIP_LIMITS.maxRatio) throw new Error(`Mục "${entry.name}" có tỷ lệ nén bất thường (${Math.round(entry.uncompressedSize / entry.compressedSize)}:1) — từ chối để tránh cạn bộ nhớ.`);
    total += entry.uncompressedSize;
  }
  if (total > ZIP_LIMITS.maxTotalBytes) throw new Error(`Tổng dung lượng giải nén ${(total / 1_048_576).toFixed(0)} MB vượt giới hạn ${ZIP_LIMITS.maxTotalBytes / 1_048_576} MB.`);
}

export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('File không phải định dạng ZIP hợp lệ (không tìm thấy End of Central Directory).');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) break;
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assertZipSafe(entries);
  return entries;
}

/** Giải nén nội dung một file trong gói ZIP. */
export function readZipFile(buffer: Buffer, entry: ZipEntry): Buffer {
  // Độ dài trường name/extra ở local header có thể khác central directory.
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) {
    // Không tin kích thước khai báo: chặn đầu ra ngay khi vượt (maxOutputLength) và đối chiếu sau khi giải nén.
    const out = inflateRawSync(raw, { maxOutputLength: Math.min(entry.uncompressedSize, ZIP_LIMITS.maxEntryBytes) + 1 });
    if (out.length !== entry.uncompressedSize) throw new Error(`Mục "${entry.name}" giải nén ${out.length} byte, khác kích thước khai báo ${entry.uncompressedSize} — gói ZIP không đáng tin.`);
    return out;
  }
  throw new Error(`Phương thức nén ${entry.compressionMethod} chưa được hỗ trợ.`);
}

/** Đọc một file trong gói ZIP theo tên, trả về chuỗi UTF-8. */
export function readZipText(buffer: Buffer, name: string): string | null {
  const entries = readZipEntries(buffer);
  const entry = entries.find((item) => item.name === name);
  return entry ? readZipFile(buffer, entry).toString('utf8') : null;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD nằm ở cuối file, có thể có comment tối đa 65.535 byte phía sau.
  const limit = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= limit; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}
