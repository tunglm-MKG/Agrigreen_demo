/**
 * TỆP ĐÍNH KÈM DÙNG CHUNG — ảnh bằng chứng có toạ độ và thời gian trong ảnh.
 *
 * Ba nơi đòi bằng chứng (bước VietGAP, công đoạn thu gom, tranh chấp thuê máy)
 * trước đây chỉ nhận chuỗi ký tự: ảnh nằm ở Zalo hay Drive của cá nhân, mất theo
 * người. Bằng chứng nằm ngoài hệ thống thì không phải bằng chứng.
 *
 * Nguyên tắc:
 *   - Lưu theo băm nội dung (SHA-256): cùng một ảnh tải hai lần chỉ chiếm một chỗ.
 *   - Đọc EXIF ngay khi nhận: thời điểm chụp (DateTimeOriginal) và toạ độ GPS. Đây
 *     là hai thứ làm ảnh trở thành bằng chứng — ảnh không có chúng vẫn nhận nhưng
 *     bị gắn cờ, để kiểm định viên biết mức tin cậy.
 *   - So với vị trí đối tượng: ảnh chụp cách thửa quá 300 m hay chụp trước đó quá
 *     24 giờ thì gắn cờ, KHÔNG chặn — đội trưởng có thể đứng ở bờ kênh, mạng có
 *     thể về muộn. Chặn là mất bằng chứng; gắn cờ là giữ bằng chứng kèm nghi vấn.
 *
 * Bộ đọc EXIF tự viết (JPEG APP1 / TIFF), chỉ lấy đúng ba trường cần — không kéo
 * thêm dependency cho việc đọc vài chục byte.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { all, insert, one, update } from '../db/db.ts';
import { nowIso, uuid } from '../util/ids.ts';
import { logEvent, type AuditActor } from '../audit/audit.ts';
import { haversineKm, type LatLng } from '../geo/geo.ts';

export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const LOCATION_TOLERANCE_M = 300;
export const FRESHNESS_HOURS = 24;

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic',
  'application/pdf': '.pdf',
};

export const ATTACHMENT_FLAGS: Record<string, string> = {
  khong_exif: 'Ảnh không có dữ liệu EXIF — không xác minh được thời điểm và nơi chụp',
  khong_gps: 'Ảnh không có toạ độ GPS',
  khong_thoi_diem: 'Ảnh không ghi thời điểm chụp',
  xa_vi_tri: `Nơi chụp cách vị trí đối tượng quá ${LOCATION_TOLERANCE_M} m`,
  anh_cu: `Ảnh chụp trước thời điểm tải lên quá ${FRESHNESS_HOURS} giờ`,
  thoi_diem_tuong_lai: 'Thời điểm chụp nằm trong tương lai — đồng hồ máy sai',
  khong_phai_anh: 'Không phải ảnh — không kiểm được EXIF',
};

export function uploadDir(): string {
  const dir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'data', 'uploads');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// EXIF
// ---------------------------------------------------------------------------

export interface ExifSummary {
  hasExif: boolean;
  takenAt: string | null;   // ISO, coi như giờ địa phương ghi trong máy ảnh
  lat: number | null;
  lng: number | null;
}

/** Đọc DateTimeOriginal và GPS từ JPEG. Ảnh không phải JPEG → hasExif false. */
export function readExif(buffer: Buffer): ExifSummary {
  const none: ExifSummary = { hasExif: false, takenAt: null, lat: null, lng: null };
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return none;

  // Duyệt các segment JPEG tới APP1 "Exif\0\0".
  let offset = 2;
  let tiff: Buffer | null = null;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI: hết metadata
    const size = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1 && buffer.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      tiff = buffer.subarray(offset + 10, offset + 2 + size);
      break;
    }
    offset += 2 + size;
  }
  if (!tiff || tiff.length < 8) return none;

  const little = tiff.toString('ascii', 0, 2) === 'II';
  const u16 = (at: number) => (little ? tiff!.readUInt16LE(at) : tiff!.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff!.readUInt32LE(at) : tiff!.readUInt32BE(at));
  const inBounds = (at: number, len: number) => at >= 0 && at + len <= tiff!.length;

  type Entry = { tag: number; type: number; count: number; valueAt: number };
  const readIfd = (at: number): Entry[] => {
    if (!inBounds(at, 2)) return [];
    const n = u16(at);
    const entries: Entry[] = [];
    for (let i = 0; i < n; i += 1) {
      const e = at + 2 + i * 12;
      if (!inBounds(e, 12)) break;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      const valueAt = count * size <= 4 ? e + 8 : u32(e + 8);
      entries.push({ tag: u16(e), type, count, valueAt });
    }
    return entries;
  };
  const ascii = (entry: Entry) => (inBounds(entry.valueAt, entry.count)
    ? tiff!.toString('ascii', entry.valueAt, entry.valueAt + entry.count).replace(/\0+$/, '')
    : '');
  const rationals = (entry: Entry) => {
    const out: number[] = [];
    for (let i = 0; i < entry.count; i += 1) {
      const at = entry.valueAt + i * 8;
      if (!inBounds(at, 8)) break;
      const den = u32(at + 4);
      out.push(den ? u32(at) / den : 0);
    }
    return out;
  };

  const ifd0 = readIfd(u32(4));
  const exifPtr = ifd0.find((e) => e.tag === 0x8769);
  const gpsPtr = ifd0.find((e) => e.tag === 0x8825);
  const exif = exifPtr ? readIfd(u32(exifPtr.valueAt)) : [];
  const gps = gpsPtr ? readIfd(u32(gpsPtr.valueAt)) : [];

  const dateEntry = exif.find((e) => e.tag === 0x9003) ?? ifd0.find((e) => e.tag === 0x0132);
  let takenAt: string | null = null;
  if (dateEntry) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(ascii(dateEntry));
    if (m) takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }

  let lat: number | null = null;
  let lng: number | null = null;
  const latRef = gps.find((e) => e.tag === 0x0001);
  const latVal = gps.find((e) => e.tag === 0x0002);
  const lngRef = gps.find((e) => e.tag === 0x0003);
  const lngVal = gps.find((e) => e.tag === 0x0004);
  const dms = (parts: number[]) => (parts.length >= 3 ? parts[0] + parts[1] / 60 + parts[2] / 3600 : (parts[0] ?? NaN));
  if (latVal && lngVal) {
    const la = dms(rationals(latVal));
    const lo = dms(rationals(lngVal));
    if (Number.isFinite(la) && Number.isFinite(lo) && (la !== 0 || lo !== 0)) {
      lat = (latRef && ascii(latRef).startsWith('S')) ? -la : la;
      lng = (lngRef && ascii(lngRef).startsWith('W')) ? -lo : lo;
    }
  }
  return { hasExif: true, takenAt, lat, lng };
}

// ---------------------------------------------------------------------------
// Vị trí tham chiếu của đối tượng đính kèm
// ---------------------------------------------------------------------------

/** Toạ độ của đối tượng để so với nơi chụp. Không biết thì trả null — không đoán. */
export function referencePoint(entityType: string, entityId: string): LatLng | null {
  const pick = (row: { lat: number | null; lng: number | null } | null) =>
    (row && row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null);
  switch (entityType) {
    case 'field_job':
      return pick(one('SELECT lat, lng FROM field_jobs WHERE id = ?', [entityId]));
    case 'field_job_stage':
      return pick(one('SELECT j.lat, j.lng FROM field_job_stages s JOIN field_jobs j ON j.id = s.job_id WHERE s.id = ?', [entityId]));
    case 'field_loading':
      return pick(one('SELECT j.loading_lat AS lat, j.loading_lng AS lng FROM field_loadings l JOIN field_jobs j ON j.id = l.job_id WHERE l.id = ?', [entityId]));
    case 'plot':
      return pick(one('SELECT centroid_lat AS lat, centroid_lng AS lng FROM plots WHERE id = ?', [entityId]));
    case 'plan_step':
      return pick(one(
        `SELECT p.centroid_lat AS lat, p.centroid_lng AS lng FROM production_plan_steps s
         JOIN production_plans pl ON pl.id = s.plan_id JOIN crop_cycles c ON c.id = pl.crop_cycle_id
         JOIN plots p ON p.id = c.plot_id WHERE s.id = ?`, [entityId]));
    case 'crop_cycle':
      return pick(one('SELECT p.centroid_lat AS lat, p.centroid_lng AS lng FROM crop_cycles c JOIN plots p ON p.id = c.plot_id WHERE c.id = ?', [entityId]));
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Lưu và truy vấn
// ---------------------------------------------------------------------------

export interface SaveInput {
  entityType: string;
  entityId: string;
  fileName: string;
  mime: string;
  data: Buffer;
  note?: string;
  /** Toạ độ điện thoại lúc tải lên — dự phòng khi ảnh không có GPS. */
  deviceLat?: number;
  deviceLng?: number;
}

export function saveAttachment(input: SaveInput, actor: AuditActor = {}): Record<string, unknown> {
  if (!input.entityType || !input.entityId) throw new Error('Thiếu đối tượng để gắn tệp.');
  if (!input.data?.length) throw new Error('Tệp rỗng.');
  if (input.data.length > MAX_FILE_BYTES) {
    throw new Error(`Tệp ${(input.data.length / 1_048_576).toFixed(1)} MB vượt giới hạn ${MAX_FILE_BYTES / 1_048_576} MB — giảm độ phân giải trước khi tải.`);
  }
  const ext = ALLOWED_MIME[input.mime];
  if (!ext) throw new Error(`Không nhận loại tệp "${input.mime}". Nhận ảnh JPEG/PNG/WebP/HEIC hoặc PDF.`);
  // Đánh giá bảo mật 24/09/2026 (L-01): loại tệp phải khớp NỘI DUNG (magic bytes), không tin lời khai của client.
  if (!contentMatchesMime(input.data, input.mime)) throw new Error(`Nội dung tệp không phải ${input.mime} như khai báo — tệp bị từ chối.`);

  const sha256 = createHash('sha256').update(input.data).digest('hex');
  const path = join(uploadDir(), `${sha256}${ext}`);
  if (!existsSync(path)) writeFileSync(path, input.data);

  const exif = input.mime === 'image/jpeg' ? readExif(input.data) : { hasExif: false, takenAt: null, lat: null, lng: null };
  const flags: string[] = [];
  if (!input.mime.startsWith('image/')) flags.push('khong_phai_anh');
  else if (!exif.hasExif) flags.push('khong_exif');
  else {
    if (exif.lat === null) flags.push('khong_gps');
    if (!exif.takenAt) flags.push('khong_thoi_diem');
  }

  const lat = exif.lat ?? input.deviceLat ?? null;
  const lng = exif.lng ?? input.deviceLng ?? null;
  const reference = referencePoint(input.entityType, input.entityId);
  let distanceM: number | null = null;
  if (reference && lat !== null && lng !== null) {
    distanceM = Math.round(haversineKm(reference, { lat, lng }) * 1000);
    if (distanceM > LOCATION_TOLERANCE_M) flags.push('xa_vi_tri');
  }
  if (exif.takenAt) {
    const ageHours = (Date.now() - new Date(exif.takenAt).getTime()) / 3_600_000;
    if (ageHours > FRESHNESS_HOURS) flags.push('anh_cu');
    if (ageHours < -1) flags.push('thoi_diem_tuong_lai');
  }

  const record = {
    id: uuid(), entity_type: input.entityType, entity_id: input.entityId,
    file_name: input.fileName || `anh${ext}`, mime: input.mime, size_bytes: input.data.length, sha256,
    storage_path: `${sha256}${ext}`, taken_at: exif.takenAt, lat, lng,   // khoá tương đối với UPLOAD_DIR — phục hồi sang máy khác vẫn đọc được (O03)
    location_source: exif.lat !== null ? 'exif' : (input.deviceLat !== undefined ? 'thiet_bi' : null),
    distance_m: distanceM, flags_json: JSON.stringify(flags), note: input.note ?? null,
    uploaded_by: actor.name ?? null, uploaded_at: nowIso(),
  };
  insert('attachments', record);
  logEvent({
    module: 'files', entityType: 'attachments', entityId: record.id, action: 'create',
    after: { ...record, storage_path: undefined }, note: `${input.entityType}:${input.entityId}`,
  }, actor);
  return view(record);
}

function view(row: Record<string, unknown>): Record<string, unknown> {
  const flags = JSON.parse(String(row.flags_json ?? '[]')) as string[];
  return {
    id: row.id, entityType: row.entity_type, entityId: row.entity_id, fileName: row.file_name, mime: row.mime,
    sizeBytes: row.size_bytes, sha256: row.sha256, takenAt: row.taken_at, lat: row.lat, lng: row.lng,
    locationSource: row.location_source, distanceM: row.distance_m, note: row.note,
    uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at,
    flags, flagLabels: flags.map((flag) => ATTACHMENT_FLAGS[flag] ?? flag),
    // Ảnh không có cờ nào là ảnh tin được: đúng chỗ, đúng lúc, có dấu vết máy ảnh.
    trusted: flags.length === 0,
    url: `/api/files/${row.id}/content`,
  };
}

/** 8–12 byte đầu của tệp phải khớp loại khai báo. */
export function contentMatchesMime(data: Buffer, mime: string): boolean {
  if (data.length < 12) return false;
  const head = data.subarray(0, 12);
  switch (mime) {
    case 'image/jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png': return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp': return head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'image/heic': { const brand = head.subarray(4, 12).toString('ascii'); return brand.startsWith('ftyp') && /heic|heix|hevc|mif1|msf1|heim|heis/.test(brand.slice(4)); }
    case 'application/pdf': return head.subarray(0, 5).toString('ascii') === '%PDF-';
    default: return false;
  }
}

/** Đối tượng chủ quản của tệp — để API kiểm phạm vi trước khi đọc/xoá (H-01). */
export function attachmentMeta(id: string): { entity_type: string; entity_id: string; deleted_at: string | null } | null {
  return one<{ entity_type: string; entity_id: string; deleted_at: string | null }>('SELECT entity_type, entity_id, deleted_at FROM attachments WHERE id = ?', [id]);
}

export function listAttachments(entityType: string, entityId: string): Record<string, unknown>[] {
  return all<Record<string, unknown>>(
    'SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY uploaded_at',
    [entityType, entityId],
  ).map(view);
}

export function attachmentCounts(entityType: string, entityIds: string[]): Map<string, number> {
  if (!entityIds.length) return new Map();
  const rows = all<{ entity_id: string; n: number }>(
    `SELECT entity_id, COUNT(*) AS n FROM attachments WHERE entity_type = ? AND deleted_at IS NULL
     AND entity_id IN (${entityIds.map(() => '?').join(',')}) GROUP BY entity_id`,
    [entityType, ...entityIds],
  );
  return new Map(rows.map((row) => [row.entity_id, row.n]));
}

export function readAttachment(id: string): { mime: string; fileName: string; data: Buffer } | null {
  const row = one<{ mime: string; file_name: string; storage_path: string }>(
    'SELECT mime, file_name, storage_path FROM attachments WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!row) return null;
  const path = resolveStoragePath(row.storage_path);
  if (!path) return null;
  return { mime: row.mime, fileName: row.file_name, data: readFileSync(path) };
}

/** Khoá tương đối (mới) hoặc đường dẫn tuyệt đối (bản ghi cũ): thử theo UPLOAD_DIR trước, rồi đường dẫn gốc. */
export function resolveStoragePath(stored: string): string | null {
  const candidates = isAbsolute(stored) ? [join(uploadDir(), stored.split(/[\\/]/).pop() ?? ''), stored] : [join(uploadDir(), stored)];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Xoá mềm: bằng chứng đã nộp không biến mất khỏi lịch sử, chỉ ẩn khỏi hồ sơ. */
export function removeAttachment(id: string, reason: string, actor: AuditActor = {}): void {
  if (!one('SELECT id FROM attachments WHERE id = ?', [id])) throw new Error('Không tìm thấy tệp.');
  if (!reason?.trim()) throw new Error('Phải ghi lý do gỡ bằng chứng.');
  update('attachments', id, { deleted_at: nowIso(), note: reason.trim() });
  logEvent({ module: 'files', entityType: 'attachments', entityId: id, action: 'delete', after: { reason } }, actor);
}

/** Giải mã tệp từ JSON của trình duyệt: data URI hoặc base64 thuần. */
export function decodeUpload(data: string): Buffer {
  const base64 = data.includes(',') && data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  return Buffer.from(base64, 'base64');
}
