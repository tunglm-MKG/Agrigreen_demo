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
 * Người dùng chỉ nhìn thấy cổng mà vai trò của họ có quyền vào; ai có quyền ở
 * nhiều cổng sẽ thấy bộ chuyển cổng ở chân thanh bên.
 */

export const PORTALS = [
  // -------------------------------------------------------------------------
  // Cổng Khuyến nông — BRD App Khuyến nông
  // -------------------------------------------------------------------------
  {
    id: 'kn',
    path: '/kn',
    name: 'Cổng Khuyến nông',
    short: 'Khuyến nông',
    tagline: 'Hệ thống Khuyến nông cộng đồng — tổ chức, thư viện, nhiệm vụ, giá cả, đào tạo',
    mark: '🌱',
    accent: '#1C8C74',
    permission: 'portal.kn',
    audience: 'Trung tâm Khuyến nông tỉnh · Trạm Khuyến nông huyện · Tổ Khuyến nông cộng đồng',
    nav: [
      {
        group: 'Điều hành',
        items: [
          { id: 'kn-dashboard', label: '📊 Bảng điều hành', permission: 'khuyennong.read' },
          { id: 'kn-org', label: '🏛️ Cây tổ chức 3 cấp', permission: 'khuyennong.read' },
          { id: 'kn-broadcast', label: '📢 Chỉ đạo điều hành', permission: 'khuyennong.publish' },
        ],
      },
      {
        group: 'Chuyên môn',
        items: [
          { id: 'kn-library', label: '📚 Thư viện kỹ thuật', permission: 'khuyennong.read' },
          { id: 'kn-protocols', label: '📋 Quy trình sản xuất chuẩn', permission: 'khuyennong.read' },
          { id: 'kn-surveys', label: '📝 Khảo sát thu thập dữ liệu', permission: 'khuyennong.read' },
          { id: 'kn-tasks', label: '🧰 Nhiệm vụ hỗ trợ HTX', permission: 'khuyennong.read' },
          { id: 'kn-training', label: '🎓 Đào tạo ToT', permission: 'khuyennong.read' },
        ],
      },
      {
        group: 'Thông tin thị trường',
        items: [
          { id: 'kn-prices', label: '💹 Giá cả thị trường', permission: 'khuyennong.read' },
          { id: 'kn-directory', label: '📇 Danh bạ trực hỗ trợ', permission: 'khuyennong.read' },
        ],
      },
      {
        group: 'Dữ liệu vùng',
        items: [
          { id: 'kn-map', label: '🗺️ Bản đồ vùng khuyến nông', permission: 'gis.read' },
          { id: 'kn-plots', label: '📐 Vẽ thửa & gán cho HTX', permission: 'mdm.write' },
          { id: 'kn-htx', label: '🏢 Hồ sơ HTX (mã số thuế)', permission: 'khuyennong.read' },
          { id: 'import', label: '📥 Nhập Excel HTX & vụ mùa', permission: 'mdm.write' },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Cổng Hợp tác xã — BRD App Hợp tác xã
  // -------------------------------------------------------------------------
  {
    id: 'htx',
    path: '/htx',
    name: 'Cổng Hợp tác xã',
    short: 'Hợp tác xã',
    tagline: 'Nhật ký đồng ruộng — lô ruộng, vụ canh tác, sản lượng, hỗ trợ kỹ thuật',
    mark: '👨‍🌾',
    accent: '#2F7D32',
    permission: 'portal.htx',
    audience: 'Ban quản lý HTX · Tổ hợp tác · Nông dân thành viên',
    nav: [
      {
        group: 'Sản xuất',
        items: [
          { id: 'htx-dashboard', label: '📊 Bảng điều hành HTX', permission: 'htx.read' },
          { id: 'htx-plots', label: '📐 Lô ruộng & GPS', permission: 'htx.read' },
          { id: 'htx-cycles', label: '🌾 Vụ canh tác', permission: 'htx.read' },
        ],
      },
      {
        group: 'Quy trình & kế hoạch',
        items: [
          { id: 'htx-protocols', label: '📋 Quy trình sản xuất', permission: 'htx.read' },
          { id: 'htx-plan', label: '📅 Kế hoạch sản xuất', permission: 'htx.read' },
          { id: 'htx-assign', label: '👥 Phân công công việc', permission: 'htx.read' },
          { id: 'htx-logs', label: '📓 Nhật ký đồng ruộng', permission: 'htx.read' },
        ],
      },
      {
        group: 'Vật tư & quản trị',
        items: [
          { id: 'htx-inputs', label: '🧪 Vật tư nông nghiệp', permission: 'htx.read' },
          { id: 'htx-settings', label: '⚙️ Cấu hình hợp tác xã', permission: 'htx.read' },
        ],
      },
      {
        group: 'Thu hoạch & tiêu thụ',
        items: [
          { id: 'htx-harvest', label: '🚜 Khai báo sản lượng', permission: 'htx.read' },
          { id: 'htx-rental', label: '🤝 Thuê máy cơ giới', permission: 'rental.read' },
        ],
      },
      {
        group: 'Hỗ trợ',
        items: [
          { id: 'htx-support', label: '🆘 Yêu cầu hỗ trợ kỹ thuật', permission: 'htx.read' },
          { id: 'htx-advice', label: '🌤️ Thời tiết & khuyến cáo', permission: 'htx.read' },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Cổng Cơ giới hoá — BRD Bản đồ Cơ giới hoá + Sàn cơ giới hoá
  // -------------------------------------------------------------------------
  {
    id: 'cgh',
    path: '/cgh',
    name: 'Cổng Cơ giới hoá',
    short: 'Cơ giới hoá',
    tagline: 'Bản đồ mức độ cơ giới hoá, cân đối cung – cầu máy và sàn cho thuê',
    mark: '🚜',
    accent: '#B0791C',
    permission: 'portal.cgh',
    audience: 'Chi cục PTNT · Cục KTHT & PTNT · Chủ máy · HTX có nhu cầu thuê máy',
    nav: [
      {
        group: 'Bản đồ & phân tích',
        items: [
          { id: 'cgh-dashboard', label: '📊 Bảng điều hành', permission: 'cgh.read' },
          { id: 'cgh-map', label: '🗺️ Bản đồ mức đáp ứng', permission: 'cgh.read' },
          { id: 'cgh-balance', label: '⚖️ Cân đối cung – cầu máy', permission: 'cgh.read' },
          { id: 'cgh-forecast', label: '🔮 Dự báo nhu cầu vụ tới', permission: 'cgh.read' },
          { id: 'cgh-shortage', label: '⚠️ Báo cáo thiếu hụt', permission: 'cgh.read' },
        ],
      },
      {
        group: 'Dữ liệu nền cơ giới hoá',
        items: [
          { id: 'cgh-machines', label: '🛠️ Hồ sơ máy & chủ máy', permission: 'cgh.read' },
          { id: 'cgh-norms', label: '📏 Định mức năng suất', permission: 'cgh.read' },
          { id: 'cgh-plans', label: '📅 Kế hoạch canh tác', permission: 'cgh.read' },
        ],
      },
      {
        group: 'Sàn cơ giới hoá',
        items: [
          { id: 'rental', label: '🤝 Tin đăng & lệnh thuê', permission: 'rental.read' },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Nền tảng GIS dùng chung — dữ liệu nền của cả ba cổng nghiệp vụ
  // -------------------------------------------------------------------------
  {
    id: 'gis',
    path: '/gis',
    name: 'Nền tảng GIS dùng chung',
    short: 'Nền GIS',
    tagline: 'Bản đồ số, ranh giới hành chính 2025, tuyến đường thuỷ và dữ liệu dùng chung',
    mark: '🗺️',
    accent: '#2C6E9B',
    permission: 'portal.gis',
    audience: 'Quản trị dữ liệu nền · Mọi cổng nghiệp vụ đều đọc từ đây',
    nav: [
      {
        group: 'Bản đồ số',
        items: [
          { id: 'gis', label: '🗺️ Bản đồ nền dùng chung', permission: 'gis.read' },
          { id: 'waterways', label: '💧 Số hoá tuyến đường thuỷ', permission: 'gis.read' },
        ],
      },
      {
        group: 'Mạng lưới đường thuỷ',
        items: [
          { id: 'gis-network', label: '🔗 Cấu trúc mạng lưới', permission: 'gis.read' },
          { id: 'gis-clearance', label: '📏 Thông số luồng & tải trọng', permission: 'gis.read' },
          { id: 'gis-routing', label: '🧭 Cự ly tối ưu Hub → Nhà máy', permission: 'gis.read' },
        ],
      },
      {
        group: 'Dữ liệu dùng chung',
        items: [
          { id: 'import', label: '📥 Nhập dữ liệu Excel', permission: 'mdm.write' },
          { id: 'masterdata', label: '🗄️ Master Data', permission: 'mdm.read' },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Cổng Hiện trường — đội thu gom rơm của Mekong Green
  //
  // Người dùng chính là đội trưởng đứng giữa ruộng với điện thoại: ít mục,
  // mục đầu là "Ghi nhận tại ruộng". Điều hành hiện trường vào cả đây và ERP.
  // -------------------------------------------------------------------------
  {
    id: 'field',
    path: '/field',
    name: 'Cổng Hiện trường',
    short: 'Hiện trường',
    tagline: 'Đội thu gom rơm: cuộn – gom – xuống ghe, theo thời gian thực',
    mark: '🌾',
    accent: '#8A5A19',
    permission: 'portal.field',
    audience: 'Đội trưởng thu gom · Điều hành hiện trường',
    nav: [
      {
        group: 'Tại ruộng',
        items: [{ id: 'field-record', label: '📱 Ghi nhận tại ruộng', permission: 'field.read' }],
      },
      {
        group: 'Điều hành',
        items: [
          { id: 'field-dashboard', label: '🛰️ Bảng điều hành', permission: 'field.read' },
          { id: 'field-plan', label: '📅 Kế hoạch thu gom', permission: 'field.read' },
          { id: 'field-weighing', label: '⚖️ Cân nhà máy & đối soát', permission: 'field.read' },
          { id: 'field-teams', label: '👷 Đội & phương tiện', permission: 'field.read' },
          { id: 'field-report', label: '📈 Năng suất', permission: 'field.read' },
        ],
      },
      {
        group: 'Liên phân hệ',
        items: [
          { id: 'tms', label: '🚛 Chuyến ghe (TMS)', permission: 'tms.read' },
          { id: 'gis', label: '🗺️ Bản đồ dùng chung', permission: 'gis.read' },
        ],
      },
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
    mark: '🏭',
    accent: '#0E3B34',
    permission: 'portal.erp',
    audience: 'Supply Chain · Kho vận · Tài chính · Ban lãnh đạo',
    nav: [
      {
        group: 'Tổng quan',
        items: [{ id: 'dashboard', label: '📊 Bảng điều hành', permission: 'reporting.read' }],
      },
      {
        group: 'Hoạch định đầu tư',
        items: [
          { id: 'planner', label: '📍 Hub Planner & Kịch bản', permission: 'simulation.read' },
          { id: 'compare', label: '⚖️ So sánh kịch bản', permission: 'simulation.read' },
          { id: 'parameters', label: '🎛️ Tham số mô phỏng', permission: 'simulation.read' },
          { id: 'sim-actuals', label: '🔁 Giả định – thực tế', permission: 'simulation.read' },
        ],
      },
      {
        group: 'Vận hành',
        items: [
          { id: 'warehouse', label: '🏭 Kho & Giám sát môi trường', permission: 'warehouse.read' },
          { id: 'trade', label: '📦 Mua hàng / Bán hàng', permission: 'procurement.read' },
          { id: 'tms', label: '🚛 Vận tải (TMS)', permission: 'tms.read' },
          { id: 'field-dashboard', label: '🌾 Hiện trường thu gom', permission: 'field.read' },
          { id: 'field-weighing', label: '⚖️ Cân ghe rơm & đối soát', permission: 'field.read' },
          { id: 'finance', label: '💰 Tài chính & MRV', permission: 'finance.read' },
        ],
      },
      {
        group: 'Quản trị hệ thống',
        items: [
          { id: 'sys-users', label: '👤 Tài khoản người dùng', permission: 'admin.users' },
          { id: 'sys-groups', label: '🛡️ Nhóm & phân quyền', permission: 'admin.users' },
          { id: 'sys-notify', label: '🔔 Thông báo & kênh gửi', permission: 'admin.config' },
          { id: 'masterdata', label: '🗄️ Master Data', permission: 'mdm.read' },
          { id: 'admin', label: '📜 Nhật ký & đồng bộ', permission: 'gis.read' },
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
