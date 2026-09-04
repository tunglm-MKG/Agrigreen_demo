/** Điểm khởi động ứng dụng. */
import { start } from './server.ts';

start().catch((error) => {
  console.error('Không khởi động được máy chủ:', error);
  process.exit(1);
});
