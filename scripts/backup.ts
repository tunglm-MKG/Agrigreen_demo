/**
 * Sao lưu toàn bộ CSDL (7 tệp miền) — chạy được khi máy chủ đang hoạt động.
 *
 *   node scripts/backup.ts                 → data/backups/<timestamp>/ (giữ 14 đợt gần nhất)
 *   node scripts/backup.ts --dir D:/bk --keep 30
 *   node scripts/backup.ts --verify data/backups/2026-09-24T02-00-00
 *   node scripts/backup.ts --list
 */
import { migrate } from '../src/platform/db/schema.ts';
import { backupAll, listBackups, verifyBackup } from '../src/platform/db/backup.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes('--list')) {
  for (const b of listBackups(opt('--dir'))) console.log(`${b.manifest?.ok ? 'OK ' : 'ERR'} ${b.dir}  ${b.manifest?.createdAt ?? ''}  ${b.manifest ? `${b.manifest.files.reduce((a, f) => a + f.bytes, 0)} bytes` : 'không có manifest'}`);
} else if (opt('--verify')) {
  const result = verifyBackup(opt('--verify')!);
  console.log(result.ok ? 'Bản sao lưu hợp lệ.' : `LỖI: ${result.problems.join('; ')}`);
  process.exit(result.ok ? 0 : 1);
} else {
  migrate();
  const { dir, manifest, pruned } = backupAll({ dir: opt('--dir'), keep: opt('--keep') ? Number(opt('--keep')) : undefined });
  console.log(`${manifest.ok ? 'Đã sao lưu' : 'SAO LƯU LỖI'} → ${dir} (${manifest.durationMs} ms)`);
  for (const f of manifest.files) console.log(`  ${f.integrity === 'ok' ? '✓' : '✗'} ${f.file}  ${f.tables} bảng  ${(f.bytes / 1024).toFixed(0)} KB  ${f.sha256.slice(0, 12)}…`);
  if (pruned.length) console.log(`Đã xoá ${pruned.length} đợt cũ.`);
  process.exit(manifest.ok ? 0 : 1);
}
