/** Nạp lại dữ liệu nền. Dùng `node scripts/seed.ts --reset` để xoá sạch trước khi nạp. */
import { migrate } from '../src/platform/db/schema.ts';
import { resetAll, seedAll, seedIfEmpty } from '../src/seed.ts';
import { masterDataSummary } from '../src/mdm/service.ts';

migrate();

if (process.argv.includes('--reset')) {
  resetAll();
  seedAll();
  console.log('Đã xoá và nạp lại toàn bộ dữ liệu nền.');
} else if (seedIfEmpty()) {
  console.log('Đã nạp dữ liệu nền.');
} else {
  console.log('Cơ sở dữ liệu đã có dữ liệu — bỏ qua (dùng --reset để nạp lại).');
}

console.log(JSON.stringify(masterDataSummary(), null, 2));
