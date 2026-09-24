/**
 * Kiểm thử TỆP ĐÍNH KÈM — ảnh bằng chứng có EXIF.
 *
 * Bộ đọc EXIF tự viết nên phải được kiểm bằng ảnh JPEG dựng tay từng byte: nếu
 * đọc sai toạ độ hay giờ chụp thì cờ "đúng chỗ, đúng lúc" trở thành lời nói dối.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.UPLOAD_DIR = join(mkdtempSync(join(tmpdir(), 'mekong-up-')), 'uploads');
const { configureDatabase, one } = await import('../src/platform/db/db.ts');
configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-att-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const files = await import('../src/platform/files/attachments.ts');
const field = await import('../src/erp/field/service.ts');

migrate();
seedAll();
const actor = { id: 'test', name: 'Kiểm thử' };

/**
 * Dựng JPEG tối thiểu có APP1/EXIF (TIFF little-endian) với DateTimeOriginal và
 * GPS. Không cần dữ liệu ảnh thật — bộ đọc chỉ nhìn metadata.
 */
function jpegWithExif(options: { takenAt?: string; lat?: number; lng?: number } = {}): Buffer {
  const parts: Buffer[] = [];
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const rational = (v: number) => Buffer.concat([u32(Math.round(v * 10000)), u32(10000)]);
  const dms = (deg: number) => {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = Math.floor((abs - d) * 60);
    const s = ((abs - d) * 60 - m) * 60;
    return Buffer.concat([rational(d), rational(m), rational(s)]);
  };

  // Bố cục TIFF: header(8) | IFD0 | ExifIFD | GPSIFD | vùng dữ liệu
  const hasGps = options.lat !== undefined && options.lng !== undefined;
  const ifd0Entries = 1 + (hasGps ? 1 : 0);
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + ifd0Entries * 12 + 4;
  const exifEntries = options.takenAt ? 1 : 0;
  const gpsAt = exifAt + 2 + exifEntries * 12 + 4;
  const gpsEntries = hasGps ? 4 : 0;
  const dataAt = gpsAt + 2 + gpsEntries * 12 + 4;
  const data: Buffer[] = [];
  let cursor = dataAt;
  const place = (buf: Buffer) => { const at = cursor; data.push(buf); cursor += buf.length; return at; };

  const entry = (tag: number, type: number, count: number, value: Buffer | number) =>
    Buffer.concat([u16(tag), u16(type), u32(count), typeof value === 'number' ? u32(value) : Buffer.concat([value, Buffer.alloc(4 - value.length)])]);

  const ifd0 = [entry(0x8769, 4, 1, exifAt)];
  if (hasGps) ifd0.push(entry(0x8825, 4, 1, gpsAt));
  const exif: Buffer[] = [];
  if (options.takenAt) {
    const text = Buffer.from(`${options.takenAt}\0`, 'ascii'); // "YYYY:MM:DD HH:MM:SS"
    exif.push(entry(0x9003, 2, text.length, place(text)));
  }
  const gps: Buffer[] = [];
  if (hasGps) {
    gps.push(entry(0x0001, 2, 2, Buffer.from(options.lat! < 0 ? 'S\0' : 'N\0', 'ascii')));
    gps.push(entry(0x0002, 5, 3, place(dms(options.lat!))));
    gps.push(entry(0x0003, 2, 2, Buffer.from(options.lng! < 0 ? 'W\0' : 'E\0', 'ascii')));
    gps.push(entry(0x0004, 5, 3, place(dms(options.lng!))));
  }
  const tiff = Buffer.concat([
    Buffer.from('II', 'ascii'), u16(42), u32(ifd0At),
    u16(ifd0.length), ...ifd0, u32(0),
    u16(exif.length), ...exif, u32(0),
    u16(gps.length), ...gps, u32(0),
    ...data,
  ]);
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1Len = Buffer.alloc(2); app1Len.writeUInt16BE(app1Body.length + 2);
  parts.push(Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1]), app1Len, app1Body, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const job = one<{ id: string; lat: number; lng: number }>('SELECT id, lat, lng FROM field_jobs WHERE lat IS NOT NULL LIMIT 1')!;
const stage = one<{ id: string }>('SELECT id FROM field_job_stages WHERE job_id = ? AND stage = ?', [job.id, 'cuon_rom'])!;
const nowExif = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

test('Đọc được giờ chụp và toạ độ GPS từ EXIF; nam bán cầu / tây kinh tuyến ra số âm', () => {
  const exif = files.readExif(jpegWithExif({ takenAt: '2026:09:05 08:30:15', lat: 10.4521, lng: 105.3412 }));
  assert.equal(exif.hasExif, true);
  assert.equal(exif.takenAt, '2026-09-05T08:30:15');
  assert.ok(Math.abs(exif.lat! - 10.4521) < 0.0005, `lat ${exif.lat}`);
  assert.ok(Math.abs(exif.lng! - 105.3412) < 0.0005, `lng ${exif.lng}`);
  const south = files.readExif(jpegWithExif({ lat: -33.9, lng: -70.6 }));
  assert.ok(south.lat! < 0 && south.lng! < 0);
});

test('Ảnh không phải JPEG hoặc không có APP1 → không có EXIF, không ném lỗi', () => {
  assert.equal(files.readExif(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])).hasExif, false);
  assert.equal(files.readExif(Buffer.from([0xff, 0xd8, 0xff, 0xd9])).hasExif, false);
  assert.equal(files.readExif(Buffer.alloc(0)).hasExif, false);
});

test('Ảnh chụp đúng chỗ, đúng lúc → không cờ, được đánh dấu tin được', () => {
  const saved = files.saveAttachment({
    entityType: 'field_job_stage', entityId: stage.id, fileName: 'cuon.jpg', mime: 'image/jpeg',
    data: jpegWithExif({ takenAt: nowExif(), lat: job.lat + 0.0005, lng: job.lng }), // ~55 m
  }, actor) as { trusted: boolean; flags: string[]; distanceM: number; locationSource: string };
  assert.deepEqual(saved.flags, []);
  assert.equal(saved.trusted, true);
  assert.ok(saved.distanceM < 300, `cách ${saved.distanceM} m`);
  assert.equal(saved.locationSource, 'exif');
});

test('Ảnh chụp cách thửa 2 km → cờ xa_vi_tri nhưng vẫn được lưu (gắn cờ, không chặn)', () => {
  const saved = files.saveAttachment({
    entityType: 'field_job_stage', entityId: stage.id, fileName: 'xa.jpg', mime: 'image/jpeg',
    data: jpegWithExif({ takenAt: nowExif(), lat: job.lat + 0.018, lng: job.lng }),
  }, actor) as { trusted: boolean; flags: string[]; distanceM: number };
  assert.ok(saved.flags.includes('xa_vi_tri'), saved.flags.join(','));
  assert.equal(saved.trusted, false);
  assert.ok(saved.distanceM > 1500);
});

test('Ảnh chụp 3 ngày trước → cờ anh_cu; ảnh không EXIF → cờ khong_exif và dùng toạ độ thiết bị', () => {
  const old = files.saveAttachment({
    entityType: 'field_job_stage', entityId: stage.id, fileName: 'cu.jpg', mime: 'image/jpeg',
    data: jpegWithExif({ takenAt: '2026:01:01 07:00:00', lat: job.lat, lng: job.lng }),
  }, actor) as { flags: string[] };
  assert.ok(old.flags.includes('anh_cu'));

  const png = files.saveAttachment({
    entityType: 'field_job_stage', entityId: stage.id, fileName: 'anh.png', mime: 'image/png',
    data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)]), deviceLat: job.lat, deviceLng: job.lng,   // L-01: chữ ký PNG đầy đủ
  }, actor) as { flags: string[]; locationSource: string; distanceM: number };
  assert.ok(png.flags.includes('khong_exif'));
  assert.equal(png.locationSource, 'thiet_bi');
  assert.ok(png.distanceM < 50, 'toạ độ thiết bị vẫn được so với đối tượng');
});

test('Cùng một ảnh tải hai lần chỉ lưu một tệp trên đĩa (theo băm) nhưng hai dòng đính kèm', () => {
  const data = jpegWithExif({ takenAt: nowExif(), lat: job.lat, lng: job.lng });
  const a = files.saveAttachment({ entityType: 'field_job', entityId: job.id, fileName: 'a.jpg', mime: 'image/jpeg', data }, actor) as { sha256: string; id: string };
  const b = files.saveAttachment({ entityType: 'field_job', entityId: job.id, fileName: 'b.jpg', mime: 'image/jpeg', data }, actor) as { sha256: string; id: string };
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.id, b.id);
  const paths = one<{ n: number }>('SELECT COUNT(DISTINCT storage_path) AS n FROM attachments WHERE sha256 = ?', [a.sha256])!;
  assert.equal(paths.n, 1);
  assert.equal(files.listAttachments('field_job', job.id).length, 2);
});

test('Đọc lại được nội dung tệp; loại tệp lạ và tệp quá lớn bị từ chối rõ lý do', () => {
  const saved = files.saveAttachment({ entityType: 'field_job', entityId: job.id, fileName: 'x.jpg', mime: 'image/jpeg', data: jpegWithExif() }, actor) as { id: string };
  const back = files.readAttachment(saved.id)!;
  assert.equal(back.mime, 'image/jpeg');
  assert.ok(back.data.length > 10);
  assert.throws(() => files.saveAttachment({ entityType: 'field_job', entityId: job.id, fileName: 'x.exe', mime: 'application/x-msdownload', data: Buffer.from('x') }, actor), /Không nhận loại tệp/);
  assert.throws(() => files.saveAttachment({ entityType: 'field_job', entityId: job.id, fileName: 'big.jpg', mime: 'image/jpeg', data: Buffer.alloc(files.MAX_FILE_BYTES + 1) }, actor), /vượt giới hạn/);
});

test('Gỡ bằng chứng là xoá mềm có lý do — vẫn còn trong CSDL, biến khỏi hồ sơ', () => {
  const saved = files.saveAttachment({ entityType: 'field_job', entityId: job.id, fileName: 'g.jpg', mime: 'image/jpeg', data: jpegWithExif() }, actor) as { id: string };
  assert.throws(() => files.removeAttachment(saved.id, '', actor), /lý do/);
  files.removeAttachment(saved.id, 'Ảnh nhầm thửa', actor);
  assert.ok(!files.listAttachments('field_job', job.id).some((a) => a.id === saved.id));
  assert.ok(one('SELECT id FROM attachments WHERE id = ?', [saved.id]), 'không xoá cứng');
  assert.equal(files.readAttachment(saved.id), null);
});

test('decodeUpload nhận cả data URI và base64 thuần', () => {
  const raw = Buffer.from('xin chao');
  assert.equal(files.decodeUpload(`data:text/plain;base64,${raw.toString('base64')}`).toString(), 'xin chao');
  assert.equal(files.decodeUpload(raw.toString('base64')).toString(), 'xin chao');
});

void field;
