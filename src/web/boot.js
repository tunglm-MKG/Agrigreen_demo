/**
 * Điểm vào của giao diện web.
 *
 * Import TĨNH toàn bộ các trang trước, rồi mới gọi `bootstrap()`. Cách này
 * tránh chu trình ESM có top-level await giữa `app.js` và các module trang.
 *
 * Mọi trang của MỌI cổng đều được nạp ở đây; `portals.js` mới là nơi quyết định
 * cổng nào hiển thị trang nào, và RBAC quyết định người dùng thấy được gì.
 */
import { bootstrap } from '/app.js';

// Nền tảng dùng chung
import '/pages/gis.js';
import '/pages/waterway-network.js';
import '/pages/import.js';
import '/pages/admin.js';

// Cổng Khuyến nông
import '/pages/kn.js';
import '/pages/kn-survey.js';

// Cổng Hợp tác xã
import '/pages/htx.js';
import '/pages/production.js';
import '/pages/htx-ops.js';

// Cổng Cơ giới hoá (+ sàn cho thuê dùng chung với Cổng HTX)
import '/pages/cgh.js';
import '/pages/rental.js';

// ERP nội bộ
import '/pages/dashboard.js';
import '/pages/simulation.js';
import '/pages/parameters.js';
import '/pages/erp.js';

bootstrap().catch((error) => {
  console.error('Không khởi động được giao diện:', error);
  document.getElementById('login-error').textContent = error.message;
});
