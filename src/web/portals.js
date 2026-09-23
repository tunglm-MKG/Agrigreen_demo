/**
 * SỔ ĐĂNG KÝ CÁC CỔNG (PORTAL)
 * ============================
 *
 * Hệ thống không còn là MỘT ứng dụng gộp mọi phân hệ vào một thanh điều hướng.
 * Mỗi nhóm người dùng có một CỔNG RIÊNG, với đường dẫn riêng, nhận diện riêng
 * và hệ thống chức năng riêng theo đúng BRD của app đó:
 *
 *   /kn/   — Cổng Khuyến nông        (Trung tâm/Trạm Khuyến nông, Tổ KNCĐ)
 *   /htx/  — Cổng Hợp tác xã          (Ban quản lý HTX, nông dân)
 *   /cgh/  — Cổng Cơ giới hoá         (Chi cục PTNT, chủ máy, HTX thuê máy)
 *   /erp/  — ERP nội bộ Mekong Green  (Supply Chain, Kho, TMS, Tài chính)
 *   /field/ — Cổng Hiện trường        (đội thu gom rơm của Mekong Green, đội trưởng dùng trên điện thoại)
 *   /gis/  — Nền tảng GIS dùng chung  (dữ liệu nền cho cả bốn cổng trên)
 *
 * Bốn cổng nghiệp vụ dùng CHUNG một phiên đăng nhập, một CSDL và một nền GIS —
 * đúng nguyên tắc "dữ liệu dùng chung" của AgriGreen Platform. Tách cổng là tách
 * TRẢI NGHIỆM và PHẠM VI CHỨC NĂNG, không phải tách dữ liệu.
 *
 * Mỗi mục điều hướng có `icon` (tên trong icons.js). `quick` là 4 mục hiện ở
 * thanh điều hướng đáy trên điện thoại. Nhóm menu của Cổng Khuyến nông đánh số
 * theo đúng bản mẫu App Khuyến nông v5.0.
 */

const ADMIN_GROUP = {
  group: 'Quản trị hệ thống',
  items: [
    { id: 'sys-users', label: 'Tài khoản & phân quyền', icon: 'shield', permission: 'admin.users' },
    { id: 'sys-scopes', label: 'Phân cấp quản trị', icon: 'tag', permission: 'admin.delegate' },
  ],
};

export const PORTALS = [
  // -------------------------------------------------------------------------
  // Cổng Khuyến nông — BRD App Khuyến nông v1.0 (FN-01..FN-12)
  // -------------------------------------------------------------------------
  {
    id: 'kn',
    path: '/kn',
    name: 'Cổng Khuyến nông',
    short: 'Khuyến nông',
    tagline: 'Hệ thống Khuyến nông cộng đồng — địa bàn, HTX, nhiệm vụ, thư viện, giá cả, đào tạo',
    tagline2: 'Hệ thống Khuyến nông',
    mark: '🌱',
    accent: '#0E7A4B',
    permission: 'portal.kn',
    audience: 'Trung tâm Khuyến nông tỉnh · Trạm Khuyến nông huyện · Tổ Khuyến nông cộng đồng',
    quick: ['kn-dashboard', 'kn-tasks', 'kn-library', 'kn-network'],
    nav: [
      {
        group: '1. Quản lý địa bàn & HTX',
        items: [
          { id: 'kn-dashboard', label: 'Bảng điều hành', icon: 'dashboard', permission: 'khuyennong.read' },
          { id: 'kn-org', label: 'Cây tổ chức 3 cấp', icon: 'building', permission: 'khuyennong.read' },
          { id: 'kn-network', label: 'HTX & cơ giới hoá địa bàn', icon: 'tractor', permission: 'khuyennong.read' },
          { id: 'kn-htx', label: 'Hồ sơ HTX (mã số thuế)', icon: 'building', permission: 'khuyennong.read' },
          { id: 'kn-map', label: 'Bản đồ vùng khuyến nông', icon: 'map', permission: 'gis.read' },
          { id: 'kn-plots', label: 'Vẽ thửa & gán cho HTX', icon: 'plot', permission: 'mdm.write' },
          { id: 'import', label: 'Nhập Excel HTX & vụ mùa', icon: 'upload', permission: 'mdm.write' },
        ],
      },
      {
        group: '2. Nghiệp vụ khuyến nông',
        items: [
          { id: 'kn-tasks', label: 'Nhiệm vụ hỗ trợ HTX', icon: 'task', permission: 'khuyennong.read' },
          { id: 'kn-broadcast', label: 'Chỉ đạo & cảnh báo vùng', icon: 'megaphone', permission: 'khuyennong.publish' },
          { id: 'kn-library', label: 'Thư viện kỹ thuật', icon: 'library', permission: 'khuyennong.read' },
          { id: 'kn-protocols', label: 'Quy trình sản xuất chuẩn', icon: 'log', permission: 'khuyennong.read' },
          { id: 'kn-surveys', label: 'Khảo sát thu thập dữ liệu', icon: 'edit', permission: 'khuyennong.read' },
          { id: 'kn-training', label: 'Đào tạo ToT', icon: 'star', permission: 'khuyennong.read' },
          { id: 'kn-reports', label: 'Báo cáo tổng hợp', icon: 'chart', permission: 'khuyennong.read' },
        ],
      },
      {
        group: '3. Tiện ích & cá nhân',
        items: [
          { id: 'kn-prices', label: 'Giá cả thị trường', icon: 'price', permission: 'khuyennong.read' },
          { id: 'kn-directory', label: 'Danh bạ trực hỗ trợ', icon: 'phone', permission: 'khuyennong.read' },
        ],
      },
      ADMIN_GROUP,
    ],
  },

  // -------------------------------------------------------------------------
  // Cổng Hợp tác xã — BRD App Hợp tác xã (Backlog v4.0, epics A–K)
  // -------------------------------------------------------------------------
  {
    id: 'htx',
    path: '/htx',
    name: 'Cổng Hợp tác xã',
    short: 'Hợp tác xã',
    tagline: 'Nhật ký đồng ruộng — thửa ruộng, mùa vụ, sản lượng, hỗ trợ kỹ thuật',
    tagline2: 'Nhật ký đồng ruộng',
    mark: '👨‍🌾',
    accent: '#00A3E0',
    permission: 'portal.htx',
    audience: 'Ban quản lý HTX · Tổ hợp tác · Nông dân thành viên',
    quick: ['htx-dashboard', 'htx-logs', 'htx-plots', 'htx-cycles'],
    nav: [
      {
        group: 'Tổng quan',
        items: [
          { id: 'htx-dashboard', label: 'Bảng điều hành HTX', icon: 'dashboard', permission: 'htx.read' },
          { id: 'htx-news', label: 'Bản tin & cảnh báo', icon: 'news', permission: 'htx.read' },
        ],
      },
      {
        group: 'Thửa ruộng & mùa vụ',
        items: [
          { id: 'htx-farmers', label: 'Nông dân thành viên', icon: 'users', permission: 'htx.read' },
          { id: 'htx-plots', label: 'Thửa ruộng & GPS', icon: 'plot', permission: 'htx.read' },
          { id: 'htx-cycles', label: 'Mùa vụ canh tác', icon: 'seed', permission: 'htx.read' },
          { id: 'htx-plan', label: 'Kế hoạch sản xuất', icon: 'calendar', permission: 'htx.read' },
        ],
      },
      {
        group: 'Nhật ký & duyệt',
        items: [
          { id: 'htx-logs', label: 'Nhật ký canh tác', icon: 'log', permission: 'htx.read' },
          { id: 'htx-approve', label: 'Duyệt nhật ký', icon: 'check', permission: 'htx.read' },
          { id: 'htx-assign', label: 'Phân công công việc', icon: 'users', permission: 'htx.read' },
          { id: 'htx-protocols', label: 'Quy trình sản xuất', icon: 'library', permission: 'htx.read' },
        ],
      },
      {
        group: 'Thu hoạch & tiêu thụ',
        items: [
          { id: 'htx-harvest', label: 'Khai báo sản lượng', icon: 'harvest', permission: 'htx.read' },
          { id: 'htx-contracts', label: 'Hợp đồng & công nợ rơm', icon: 'money', permission: 'htx.read' },
          { id: 'htx-rental', label: 'Thuê máy cơ giới', icon: 'tractor', permission: 'rental.read' },
          { id: 'htx-inputs', label: 'Vật tư nông nghiệp', icon: 'wrench', permission: 'htx.read' },
        ],
      },
      {
        group: 'Hỗ trợ & cấu hình',
        items: [
          { id: 'htx-support', label: 'Yêu cầu hỗ trợ kỹ thuật', icon: 'support', permission: 'htx.read' },
          { id: 'htx-advice', label: 'Thời tiết & khuyến cáo', icon: 'weather', permission: 'htx.read' },
          { id: 'htx-settings', label: 'Cấu hình hợp tác xã', icon: 'settings', permission: 'htx.read' },
        ],
      },
      ADMIN_GROUP,
    ],
  },

  // -------------------------------------------------------------------------
  // Cổng Cơ giới hoá — BRD Bản đồ Cơ giới hoá v1.3 (FN-01..12) + sàn cho thuê
  // -------------------------------------------------------------------------
  {
    id: 'cgh',
    path: '/cgh',
    name: 'Cổng Cơ giới hoá',
    short: 'Cơ giới hoá',
    tagline: 'Bản đồ mức độ cơ giới hoá, cân đối cung – cầu máy và sàn cho thuê',
    tagline2: 'Bản đồ Cơ giới hoá',
    mark: '🚜',
    accent: '#B0791C',
    permission: 'portal.cgh',
    audience: 'Chi cục PTNT · Cục KTHT & PTNT · Chủ máy · HTX có nhu cầu thuê máy',
    quick: ['cgh-dashboard', 'cgh-map', 'cgh-balance', 'cgh-machines'],
    nav: [
      {
        group: 'Bản đồ & phân tích',
        items: [
          { id: 'cgh-dashboard', label: 'Bảng điều hành', icon: 'dashboard', permission: 'cgh.read' },
          { id: 'cgh-map', label: 'Bản đồ mức đáp ứng', icon: 'map', permission: 'cgh.read' },
          { id: 'cgh-balance', label: 'Cân đối cung – cầu máy', icon: 'scale', permission: 'cgh.read' },
          { id: 'cgh-forecast', label: 'Dự báo nhu cầu vụ tới', icon: 'forecast', permission: 'cgh.read' },
          { id: 'cgh-shortage', label: 'Cảnh báo thiếu hụt', icon: 'warning', permission: 'cgh.read' },
          { id: 'cgh-reports', label: 'Báo cáo & so sánh vụ', icon: 'chart', permission: 'cgh.read' },
        ],
      },
      {
        group: 'Dữ liệu nền cơ giới hoá',
        items: [
          { id: 'cgh-htx', label: 'Hồ sơ HTX', icon: 'building', permission: 'cgh.read' },
          { id: 'cgh-machines', label: 'Hồ sơ máy', icon: 'tractor', permission: 'cgh.read' },
          { id: 'cgh-owners', label: 'Chủ sở hữu máy', icon: 'users', permission: 'cgh.read' },
          { id: 'cgh-catalog', label: 'Danh mục & ngưỡng', icon: 'settings', permission: 'cgh.read' },
          { id: 'cgh-norms', label: 'Định mức năng suất', icon: 'ruler', permission: 'cgh.read' },
          { id: 'cgh-plans', label: 'Kế hoạch canh tác', icon: 'calendar', permission: 'cgh.read' },
        ],
      },
      {
        group: 'Sàn cơ giới hoá',
        items: [
          { id: 'rental', label: 'Tin đăng & lệnh thuê', icon: 'handshake', permission: 'rental.read' },
        ],
      },
      {
        group: 'Nhật ký',
        items: [
          { id: 'cgh-log', label: 'Nhật ký hoạt động', icon: 'history', permission: 'cgh.write' },
        ],
      },
      ADMIN_GROUP,
    ],
  },

  // -------------------------------------------------------------------------
  // Nền tảng GIS dùng chung — BRD GIS v1.5: 4 khung nhìn (Bản đồ · Mùa vụ &
  // Cảnh báo · Lịch sử & Replay · Quản trị) + mạng lưới đường thuỷ
  // -------------------------------------------------------------------------
  {
    id: 'gis',
    path: '/gis',
    name: 'Nền tảng GIS dùng chung',
    short: 'Nền GIS',
    tagline: 'Bản đồ số, ranh giới hành chính 2025, mùa vụ, replay lịch sử và quản trị dữ liệu nền',
    tagline2: 'Nền tảng GIS',
    mark: '🗺️',
    accent: '#12A150',
    permission: 'portal.gis',
    audience: 'Quản trị dữ liệu nền · Mọi cổng nghiệp vụ đều đọc từ đây',
    quick: ['gis', 'gis-seasons', 'gis-history', 'gis-admin'],
    nav: [
      {
        group: 'Khung nhìn',
        items: [
          { id: 'gis', label: 'Bản đồ', icon: 'map', permission: 'gis.read' },
          { id: 'gis-seasons', label: 'Mùa vụ & Cảnh báo', icon: 'seed', permission: 'gis.read' },
          { id: 'gis-history', label: 'Lịch sử & Replay', icon: 'history', permission: 'gis.read' },
          { id: 'gis-admin', label: 'Quản trị', icon: 'settings', permission: 'gis.read' },
        ],
      },
      {
        group: 'Đường thuỷ',
        items: [
          { id: 'waterways', label: 'Số hoá tuyến', icon: 'water', permission: 'gis.read' },
          { id: 'gis-network', label: 'Mạng lưới', icon: 'link', permission: 'gis.read' },
          { id: 'gis-clearance', label: 'Luồng & tải trọng', icon: 'ruler', permission: 'gis.read' },
          { id: 'gis-routing', label: 'Cự ly Hub → NM', icon: 'compass', permission: 'gis.read' },
        ],
      },
      {
        group: 'Dữ liệu',
        items: [
          { id: 'import', label: 'Nhập Excel', icon: 'upload', permission: 'mdm.write' },
          { id: 'masterdata', label: 'Master Data', icon: 'database', permission: 'mdm.read' },
        ],
      },
      ADMIN_GROUP,
    ],
  },

  // -------------------------------------------------------------------------
  // Cổng Hiện trường — đội thu gom rơm của Mekong Green
  // -------------------------------------------------------------------------
  {
    id: 'field',
    path: '/field',
    name: 'Cổng Hiện trường',
    short: 'Hiện trường',
    tagline: 'Đội thu gom rơm: cuộn – gom – xuống ghe, theo thời gian thực',
    tagline2: 'Đội thu gom rơm',
    mark: '🌾',
    accent: '#8A5A19',
    permission: 'portal.field',
    audience: 'Đội trưởng thu gom · Điều hành hiện trường',
    quick: ['field-record', 'field-dashboard', 'field-plan', 'field-weighing'],
    nav: [
      {
        group: 'Tại ruộng',
        items: [{ id: 'field-record', label: 'Ghi nhận tại ruộng', icon: 'mobile', permission: 'field.read' }],
      },
      {
        group: 'Điều hành',
        items: [
          { id: 'field-dashboard', label: 'Bảng điều hành', icon: 'dashboard', permission: 'field.read' },
          { id: 'field-plan', label: 'Kế hoạch thu gom', icon: 'calendar', permission: 'field.read' },
          { id: 'field-weighing', label: 'Cân nhà máy & đối soát', icon: 'scale', permission: 'field.read' },
          { id: 'vessels', label: 'Danh mục ghe', icon: 'boat', permission: 'tms.read' },
          { id: 'field-teams', label: 'Đội & phương tiện', icon: 'users', permission: 'field.read' },
          { id: 'field-report', label: 'Năng suất', icon: 'chart', permission: 'field.read' },
        ],
      },
      {
        group: 'Liên phân hệ',
        items: [
          { id: 'tms', label: 'Chuyến ghe (TMS)', icon: 'truck', permission: 'tms.read' },
          { id: 'gis', label: 'Bản đồ dùng chung', icon: 'map', permission: 'gis.read' },
        ],
      },
      ADMIN_GROUP,
    ],
  },

  // -------------------------------------------------------------------------
  // ERP nội bộ Mekong Green
  // -------------------------------------------------------------------------
  {
    id: 'erp',
    path: '/erp',
    name: 'ERP nội bộ Mekong Green',
    short: 'ERP nội bộ',
    tagline: 'Hoạch định Hub, kho bãi, mua bán, vận tải và tài chính – MRV',
    tagline2: 'Mekong Green ERP',
    mark: '🏭',
    accent: '#0E3B34',
    permission: 'portal.erp',
    audience: 'Supply Chain · Kho vận · Tài chính · Ban lãnh đạo',
    quick: ['dashboard', 'warehouse', 'tms', 'finance'],
    nav: [
      {
        group: 'Tổng quan',
        items: [{ id: 'dashboard', label: 'Bảng điều hành', icon: 'dashboard', permission: 'reporting.read' }],
      },
      {
        group: 'Hoạch định đầu tư',
        items: [
          { id: 'planner', label: 'Hub Planner & Kịch bản', icon: 'pin', permission: 'simulation.read' },
          { id: 'compare', label: 'So sánh kịch bản', icon: 'scale', permission: 'simulation.read' },
          { id: 'parameters', label: 'Tham số mô phỏng', icon: 'settings', permission: 'simulation.read' },
          { id: 'sim-actuals', label: 'Giả định – thực tế', icon: 'refresh', permission: 'simulation.read' },
        ],
      },
      {
        group: 'Vận hành',
        items: [
          { id: 'warehouse', label: 'Kho & Giám sát môi trường', icon: 'factory', permission: 'warehouse.read' },
          { id: 'trade', label: 'Mua hàng / Bán hàng', icon: 'handshake', permission: 'procurement.read' },
          { id: 'tms', label: 'Vận tải (TMS)', icon: 'truck', permission: 'tms.read' },
          { id: 'field-dashboard', label: 'Hiện trường thu gom', icon: 'leaf', permission: 'field.read' },
          { id: 'field-weighing', label: 'Cân ghe rơm & đối soát', icon: 'scale', permission: 'field.read' },
          { id: 'straw-contracts', label: 'Hợp đồng thu mua rơm', icon: 'log', permission: 'procurement.read' },
          { id: 'straw-tickets', label: 'Phiếu mua rơm & công nợ HTX', icon: 'money', permission: 'procurement.read' },
          { id: 'vessels', label: 'Danh mục ghe & đơn giá', icon: 'boat', permission: 'tms.read' },
          { id: 'finance', label: 'Tài chính & MRV', icon: 'chart', permission: 'finance.read' },
        ],
      },
      {
        group: 'Quản trị hệ thống',
        items: [
          { id: 'sys-users', label: 'Tài khoản người dùng', icon: 'shield', permission: 'admin.users' },
          { id: 'sys-scopes', label: 'Phân cấp quản trị', icon: 'tag', permission: 'admin.delegate' },
          { id: 'sys-groups', label: 'Nhóm & phân quyền', icon: 'users', permission: 'admin.groups' },
          { id: 'sys-data', label: 'Miền dữ liệu & đồng bộ', icon: 'database', permission: 'admin.config' },
          { id: 'sys-notify', label: 'Thông báo & kênh gửi', icon: 'bell', permission: 'admin.config' },
          { id: 'masterdata', label: 'Master Data', icon: 'database', permission: 'mdm.read' },
          { id: 'admin', label: 'Nhật ký & đồng bộ', icon: 'history', permission: 'gis.read' },
        ],
      },
    ],
  },
];

/** Tra cổng theo đường dẫn hiện tại; trả về null khi đang ở trang chọn cổng. */
export function portalFromPath(pathname) {
  const segment = `/${pathname.split('/').filter(Boolean)[0] ?? ''}`;
  return PORTALS.find((portal) => portal.path === segment) ?? null;
}

export function portalById(id) {
  return PORTALS.find((portal) => portal.id === id) ?? null;
}

/** Mọi mục điều hướng của một cổng, đã làm phẳng. */
export function portalItems(portal) {
  return portal.nav.flatMap((group) => group.items);
}
