/**
 * SAO LƯU & KHÔI PHỤC — rà soát CSDL 24/09/2026, nguyên tắc 11.
 *
 * Mỗi miền là một tệp SQLite; sao lưu nóng từng tệp bằng `VACUUM <schema> INTO`
 * (bản sao nhất quán tại một thời điểm, không cần dừng máy chủ, không kéo theo
 * -wal/-shm). Sau khi chép, mở lại từng bản sao ở chế độ chỉ đọc để chạy
 * `integrity_check`, đếm bảng và băm SHA-256 → ghi `manifest.json`. Bản sao nào
 * không qua kiểm tra thì cả đợt bị đánh dấu hỏng và không được tính vào luân chuyển.
 *
 * Khôi phục: kiểm băm theo manifest rồi mới chép đè lên tệp miền tương ứng; phải
 * thực hiện khi máy chủ đã dừng (SQLite không cho thay tệp đang mở).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, domainFile, schemaName } from './db.ts';
import { DOMAINS, type Domain } from './domains.ts';
import { nowIso } from '../util/ids.ts';
import { encryptionKeyStatus } from '../security/fieldCrypto.ts';

export interface BackupFileInfo { domain: Domain; file: string; bytes: number; sha256: string; tables: number; integrity: string }
export interface BackupManifest { version: 1; createdAt: string; source: string; ok: boolean; files: BackupFileInfo[]; durationMs: number; uploads?: { files: number; bytes: number } | null; encryptionKeyId?: string | null }

const DEFAULT_KEEP = 14;
export const DEFAULT_BACKUP_DIR = () => process.env.BACKUP_DIR ?? resolve(process.cwd(), 'data', 'backups');

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
/** Thư mục đợt sao lưu chưa tồn tại: <timestamp>, nếu trùng trong cùng giây thì thêm hậu tố -2, -3… */
function freshDir(root: string): string {
  const base = join(root, stamp());
  if (!existsSync(base)) return base;
  for (let n = 2; ; n += 1) { const candidate = `${base}-${n}`; if (!existsSync(candidate)) return candidate; }
}
function sha256File(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

function inspectCopy(path: string): { tables: number; integrity: string } {
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = String(Object.values(copy.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[0]);
    const tables = (copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
    return { tables, integrity };
  } finally {
    copy.close();
  }
}

/** Sao lưu toàn bộ 7 miền vào `<dir>/<timestamp>/`, kiểm tra bản sao, luân chuyển giữ `keep` đợt gần nhất. */
export function backupAll(options: { dir?: string; keep?: number } = {}): { dir: string; manifest: BackupManifest; pruned: string[] } {
  const started = Date.now();
  const root = options.dir ?? DEFAULT_BACKUP_DIR();
  const dir = freshDir(root);
  mkdirSync(dir, { recursive: true });
  const handle = db();
  const files: BackupFileInfo[] = [];
  for (const domain of DOMAINS) {
    const target = join(dir, basename(domainFile(domain.code)));
    // Đường dẫn POSIX cho SQLite, nháy đơn nhân đôi.
    const literal = target.split('\\').join('/').replace(/'/g, "''");
    handle.exec(`VACUUM ${schemaName(domain.code)} INTO '${literal}'`);
    const { tables, integrity } = inspectCopy(target);
    files.push({ domain: domain.code, file: basename(target), bytes: statSync(target).size, sha256: sha256File(target), tables, integrity });
  }
  // SEC-09: bản sao lưu nhất quán gồm CSDL + tệp đính kèm; ghi định danh khoá mã hoá để biết cần khoá nào khi khôi phục
  // (khoá KHÔNG nằm trong đợt sao lưu — quyền truy cập khoá tách khỏi quyền truy cập bản sao).
  let uploads: { files: number; bytes: number } | null = null;
  const uploadsDir = process.env.UPLOAD_DIR ?? resolve(dirname(domainFile('shared')), 'uploads');
  if (process.env.BACKUP_INCLUDE_UPLOADS !== '0' && existsSync(uploadsDir)) {
    cpSync(uploadsDir, join(dir, 'uploads'), { recursive: true });
    let count = 0; let bytes = 0;
    for (const name of readdirSync(join(dir, 'uploads'))) { const st = statSync(join(dir, 'uploads', name)); if (st.isFile()) { count += 1; bytes += st.size; } }
    uploads = { files: count, bytes };
  }
  let encryptionKeyId: string | null = null;
  try { encryptionKeyId = encryptionKeyStatus().kid; } catch { encryptionKeyId = null; }
  const manifest: BackupManifest = {
    version: 1, createdAt: nowIso(), source: domainFile('shared').replace(/\.shared\.db$/i, '.db'),
    ok: files.every((f) => f.integrity === 'ok' && f.tables > 0), files, durationMs: Date.now() - started, uploads, encryptionKeyId,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const pruned = manifest.ok ? pruneBackups(root, options.keep ?? DEFAULT_KEEP) : [];
  return { dir, manifest, pruned };
}

/** Danh sách đợt sao lưu (mới nhất trước) kèm manifest nếu đọc được. */
export function listBackups(root = DEFAULT_BACKUP_DIR()): { dir: string; manifest: BackupManifest | null }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse()
    .map((name) => {
      const path = join(root, name);
      try { return { dir: path, manifest: JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as BackupManifest }; } catch { return { dir: path, manifest: null }; }
    });
}

/** Xoá các đợt cũ hơn `keep` đợt hợp lệ gần nhất (đợt hỏng không được tính, nhưng cũng bị xoá khi quá hạn). */
export function pruneBackups(root: string, keep: number): string[] {
  const all = listBackups(root);
  const pruned: string[] = [];
  let kept = 0;
  for (const entry of all) {
    if (entry.manifest?.ok && kept < keep) { kept += 1; continue; }
    if (kept >= keep || !entry.manifest?.ok) { rmSync(entry.dir, { recursive: true, force: true }); pruned.push(entry.dir); }
  }
  return pruned;
}

/** Kiểm lại một đợt sao lưu: băm khớp manifest và integrity_check từng tệp. */
export function verifyBackup(dir: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let manifest: BackupManifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch { return { ok: false, problems: ['Không đọc được manifest.json'] }; }
  for (const f of manifest.files) {
    const path = join(dir, f.file);
    if (!existsSync(path)) { problems.push(`Thiếu tệp ${f.file}`); continue; }
    if (sha256File(path) !== f.sha256) problems.push(`Băm không khớp: ${f.file}`);
    const { integrity } = inspectCopy(path);
    if (integrity !== 'ok') problems.push(`integrity_check ${f.file}: ${integrity}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Khôi phục một đợt sao lưu lên bộ tệp đích (mặc định là CSDL hiện hành). Chỉ chạy khi
 * máy chủ đã dừng; hàm không tự đóng kết nối vì được gọi từ script riêng.
 */
export function restoreBackup(dir: string, targetBase?: string): { restored: string[] } {
  const check = verifyBackup(dir);
  if (!check.ok) throw new Error(`Bản sao lưu không hợp lệ: ${check.problems.join('; ')}`);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
  const restored: string[] = [];
  for (const f of manifest.files) {
    const target = targetBase ? domainFile(f.domain, resolve(targetBase)) : domainFile(f.domain);
    mkdirSync(resolve(target, '..'), { recursive: true });
    for (const suffix of ['-wal', '-shm']) if (existsSync(target + suffix)) rmSync(target + suffix, { force: true });
    copyFileSync(join(dir, f.file), target);
    restored.push(target);
  }
  // Tệp đính kèm (nếu đợt sao lưu có): về UPLOAD_DIR hoặc cạnh bộ tệp đích.
  if (existsSync(join(dir, 'uploads'))) {
    const uploadsTarget = targetBase ? join(dirname(resolve(targetBase)), 'uploads') : (process.env.UPLOAD_DIR ?? resolve(dirname(domainFile('shared')), 'uploads'));
    cpSync(join(dir, 'uploads'), uploadsTarget, { recursive: true });
    restored.push(uploadsTarget);
  }
  return { restored };
}
