/**
 * Khôi phục CSDL từ một đợt sao lưu. DỪNG MÁY CHỦ TRƯỚC KHI CHẠY.
 *
 *   node scripts/restore.ts data/backups/2026-09-24T02-00-00            → ghi đè data/mekonggreen.*.db
 *   node scripts/restore.ts <thư mục sao lưu> --target data/khoi-phuc    → khôi phục sang bộ tệp khác để kiểm tra
 */
import { restoreBackup, verifyBackup } from '../src/platform/db/backup.ts';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('Cách dùng: node scripts/restore.ts <thư mục sao lưu> [--target <đường dẫn cơ sở .db>]'); process.exit(2); }
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;

const check = verifyBackup(dir);
if (!check.ok) { console.error(`Bản sao lưu không hợp lệ: ${check.problems.join('; ')}`); process.exit(1); }
const { restored } = restoreBackup(dir, target ? (target.endsWith('.db') ? target : `${target}/mekonggreen.db`) : undefined);
console.log(`Đã khôi phục ${restored.length} tệp:`);
for (const f of restored) console.log('  ' + f);
console.log('Khởi động lại máy chủ để dùng dữ liệu vừa khôi phục.');
