/**
 * Ma trận phân quyền HỢP NHẤT cho toàn hệ sinh thái.
 *
 * ERP Product Vision v1.2 ghi nhận "RBAC chưa hợp nhất" là rủi ro mức Cao:
 * mỗi BRD/PRD tự định nghĩa vai trò riêng nên khi ghép phân hệ sẽ mâu thuẫn.
 * File này là nguồn duy nhất định nghĩa vai trò và quyền MẶC ĐỊNH cho cả 5 nhóm
 * đối tượng (HTX, doanh nghiệp, cơ quan quản lý, tổ chức kiểm định, nội bộ).
 *
 * Quản trị viên điều chỉnh được ma trận này từ giao diện mà không phải sửa mã;
 * phần ghi đè lưu ở bảng `group_permissions`, xem `permissionsFor` bên dưới.
 */
import { all } from '../db/db.ts';

export const ROLES = {
  PLATFORM_ADMIN: 'platform_admin',
  // AgriGreen — App Khuyến nông (3 cấp)
  KN_TRUNG_UONG: 'kn_trung_uong',
  KN_TINH: 'kn_tinh',
  KN_XA: 'kn_xa',
  // AgriGreen — App Hợp tác xã
  HTX_MANAGER: 'htx_manager',
  FARMER: 'farmer',
  // Bản đồ cơ giới hóa (khách hàng DCRD chỉ Xem)
  DCRD_VIEWER: 'dcrd_viewer',
  // ERP nội bộ Mekong Green
  SUPPLY_CHAIN: 'supply_chain',
  FINANCE: 'finance',
  WAREHOUSE_OP: 'warehouse_op',
  LOGISTICS: 'logistics',
  EXECUTIVE: 'executive',
  // Hiện trường — đội thu gom rơm của Mekong Green
  FIELD_MANAGER: 'field_manager',
  FIELD_CREW: 'field_crew',
  // Đối tác ngoài
  VVB_AUDITOR: 'vvb_auditor',
  // QUẢN TRỊ HỆ THỐNG CON (09/2026): mỗi hệ thống một nhóm admin riêng — toàn quyền nghiệp vụ và quản lý tài khoản
  // TRONG hệ thống đó, không vào cổng khác, không sửa ma trận nhóm–quyền, không cấu hình nền tảng.
  KN_ADMIN: 'kn_admin',
  HTX_ADMIN: 'htx_admin',
  CGH_ADMIN: 'cgh_admin',
  GIS_ADMIN: 'gis_admin',
  ERP_ADMIN: 'erp_admin',
  FIELD_ADMIN: 'field_admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_LABELS: Record<string, string> = {
  [ROLES.PLATFORM_ADMIN]: 'Quản trị nền tảng',
  [ROLES.KN_TRUNG_UONG]: 'Cán bộ Khuyến nông Trung ương',
  [ROLES.KN_TINH]: 'Cán bộ Khuyến nông tỉnh',
  [ROLES.KN_XA]: 'Cán bộ Khuyến nông xã / Tổ KNCĐ',
  [ROLES.HTX_MANAGER]: 'Ban quản lý HTX',
  [ROLES.FARMER]: 'Nông dân',
  [ROLES.DCRD_VIEWER]: 'Cục KTHT & PTNT (chỉ xem)',
  [ROLES.SUPPLY_CHAIN]: 'Supply Chain / Kế hoạch',
  [ROLES.FINANCE]: 'Tài chính - Kế toán',
  [ROLES.WAREHOUSE_OP]: 'Vận hành kho/bãi',
  [ROLES.LOGISTICS]: 'Điều phối vận tải',
  [ROLES.EXECUTIVE]: 'Ban lãnh đạo',
  [ROLES.FIELD_MANAGER]: 'Điều hành hiện trường',
  [ROLES.FIELD_CREW]: 'Đội trưởng thu gom rơm',
  [ROLES.VVB_AUDITOR]: 'Tổ chức kiểm định (VVB)',
  [ROLES.KN_ADMIN]: 'Quản trị hệ thống Khuyến nông',
  [ROLES.HTX_ADMIN]: 'Quản trị hệ thống Hợp tác xã',
  [ROLES.CGH_ADMIN]: 'Quản trị hệ thống Cơ giới hoá',
  [ROLES.GIS_ADMIN]: 'Quản trị Nền tảng GIS',
  [ROLES.ERP_ADMIN]: 'Quản trị hệ thống ERP',
  [ROLES.FIELD_ADMIN]: 'Quản trị hệ thống Hiện trường',
};

/**
 * Quyền được đặt tên theo dạng `mien.hanh_dong`.
 * `*` đại diện cho mọi hành động trong miền đó.
 */
export const PERMISSIONS = {
  MDM_READ: 'mdm.read',
  MDM_WRITE: 'mdm.write',
  GIS_READ: 'gis.read',
  GIS_WRITE: 'gis.write',
  GIS_ADMIN: 'gis.admin',
  KN_READ: 'khuyennong.read',
  KN_WRITE: 'khuyennong.write',
  KN_PUBLISH: 'khuyennong.publish',
  HTX_READ: 'htx.read',
  HTX_WRITE: 'htx.write',
  CGH_READ: 'cgh.read',
  CGH_WRITE: 'cgh.write',
  RENTAL_READ: 'rental.read',
  RENTAL_WRITE: 'rental.write',
  RENTAL_RESOLVE: 'rental.resolve',
  SIM_READ: 'simulation.read',
  SIM_WRITE: 'simulation.write',
  SIM_PARAM_APPROVE: 'simulation.param_approve',
  SIM_MARK_OFFICIAL: 'simulation.mark_official',
  SIM_THRESHOLD: 'simulation.threshold',
  WH_READ: 'warehouse.read',
  WH_WRITE: 'warehouse.write',
  WH_APPROVE: 'warehouse.approve',
  PO_READ: 'procurement.read',
  PO_WRITE: 'procurement.write',
  SO_READ: 'sales.read',
  SO_WRITE: 'sales.write',
  TMS_READ: 'tms.read',
  TMS_WRITE: 'tms.write',
  FIN_READ: 'finance.read',
  FIN_WRITE: 'finance.write',
  MRV_READ: 'mrv.read',
  MRV_WRITE: 'mrv.write',
  REPORT_READ: 'reporting.read',
  ADMIN_USERS: 'admin.users',
  ADMIN_CONFIG: 'admin.config',
  // Ma trận nhóm–quyền là toàn hệ thống — chỉ quản trị nền tảng (SA-10). Không nhóm
  // nào có sẵn quyền này; super admin có qua `*`.
  ADMIN_GROUPS: 'admin.groups',
  // Uỷ quyền phạm vi quản trị (SA-11). Cấp qua phạm vi cấp hệ thống, không qua nhóm.
  ADMIN_DELEGATE: 'admin.delegate',
  // Hiện trường: xem / ghi nhận tại ruộng / lập kế hoạch và phân công.
  FIELD_READ: 'field.read',
  FIELD_WRITE: 'field.write',
  FIELD_MANAGE: 'field.manage',

  // -------------------------------------------------------------------------
  // QUYỀN VÀO CỔNG — tách hẳn khỏi quyền đọc dữ liệu.
  //
  // Ban quản lý HTX có `khuyennong.read` để đọc quy trình kỹ thuật đã xuất bản,
  // nhưng KHÔNG vì thế mà được vào Cổng Khuyến nông để phát chỉ đạo hay quản lý
  // cây tổ chức. Tương tự, `reporting.read` cho phép xem báo cáo dùng chung chứ
  // không mở cửa ERP nội bộ. Nếu gộp hai loại quyền này làm một, mọi vai trò
  // đều nhìn thấy mọi cổng — đúng luật nhưng sai nghiệp vụ.
  // -------------------------------------------------------------------------
  PORTAL_KN: 'portal.kn',
  PORTAL_HTX: 'portal.htx',
  PORTAL_CGH: 'portal.cgh',
  PORTAL_GIS: 'portal.gis',
  PORTAL_ERP: 'portal.erp',
  PORTAL_FIELD: 'portal.field',
  /** Cổng Quản trị hệ thống — chỉ quản trị nền tảng (qua `*`); không nhóm nào khác được cấp. */
  PORTAL_SYSADMIN: 'portal.sysadmin',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Danh sách quyền kèm nhãn tiếng Việt, để giao diện phân quyền đọc được. */
export const PERMISSION_GROUPS: { group: string; permissions: { code: string; label: string }[] }[] = [
  {
    group: 'Dữ liệu dùng chung & GIS',
    permissions: [
      { code: 'mdm.read', label: 'Xem dữ liệu dùng chung' },
      { code: 'mdm.write', label: 'Sửa dữ liệu dùng chung' },
      { code: 'gis.read', label: 'Xem bản đồ và tuyến' },
      { code: 'gis.write', label: 'Số hoá và sửa tuyến' },
      { code: 'gis.admin', label: 'Quản trị GIS (snapshot, replay)' },
    ],
  },
  {
    group: 'App Khuyến nông',
    permissions: [
      { code: 'khuyennong.read', label: 'Xem nội dung khuyến nông' },
      { code: 'khuyennong.write', label: 'Soạn nội dung, xử lý nhiệm vụ' },
      { code: 'khuyennong.publish', label: 'Xuất bản và phát chỉ đạo' },
    ],
  },
  {
    group: 'App Hợp tác xã & Cơ giới hoá',
    permissions: [
      { code: 'htx.read', label: 'Xem dữ liệu HTX' },
      { code: 'htx.write', label: 'Ghi nhật ký, khai báo sản lượng' },
      { code: 'cgh.read', label: 'Xem bản đồ cơ giới hoá' },
      { code: 'cgh.write', label: 'Quản lý máy móc, định mức' },
      { code: 'rental.read', label: 'Xem sàn cho thuê' },
      { code: 'rental.write', label: 'Đăng tin, đặt lệnh thuê' },
      { code: 'rental.resolve', label: 'Xử lý tranh chấp' },
    ],
  },
  {
    group: 'Mô phỏng đầu tư',
    permissions: [
      { code: 'simulation.read', label: 'Xem kịch bản mô phỏng' },
      { code: 'simulation.write', label: 'Dựng và chạy kịch bản' },
      { code: 'simulation.param_approve', label: 'Phê duyệt tham số giả định' },
      { code: 'simulation.mark_official', label: 'Đánh dấu kịch bản Chính thức' },
      { code: 'simulation.threshold', label: 'Chốt ngưỡng khuyến nghị đầu tư' },
    ],
  },
  {
    group: 'Vận hành ERP',
    permissions: [
      { code: 'warehouse.read', label: 'Xem kho' },
      { code: 'warehouse.write', label: 'Nhập xuất kho' },
      { code: 'procurement.read', label: 'Xem mua hàng' },
      { code: 'procurement.write', label: 'Tạo đơn mua' },
      { code: 'sales.read', label: 'Xem bán hàng' },
      { code: 'sales.write', label: 'Tạo đơn bán' },
      { code: 'tms.read', label: 'Xem vận tải' },
      { code: 'tms.write', label: 'Điều phối vận tải' },
      { code: 'finance.read', label: 'Xem tài chính' },
      { code: 'finance.write', label: 'Ghi sổ tài chính' },
      { code: 'mrv.read', label: 'Xem hồ sơ MRV' },
      { code: 'mrv.write', label: 'Ghi dữ liệu MRV' },
      { code: 'reporting.read', label: 'Xem báo cáo' },
    ],
  },
  {
    group: 'Hiện trường thu gom rơm',
    permissions: [
      { code: 'field.read', label: 'Xem đội, kế hoạch, tiến độ thu gom' },
      { code: 'field.write', label: 'Ghi nhận công đoạn tại ruộng' },
      { code: 'field.manage', label: 'Lập kế hoạch, phân công, quản lý đội & phương tiện' },
    ],
  },
  {
    group: 'Cổng truy cập',
    permissions: [
      { code: 'portal.kn', label: 'Vào Cổng Khuyến nông' },
      { code: 'portal.htx', label: 'Vào Cổng Hợp tác xã' },
      { code: 'portal.cgh', label: 'Vào Cổng Cơ giới hoá' },
      { code: 'portal.gis', label: 'Vào Nền tảng GIS' },
      { code: 'portal.erp', label: 'Vào ERP nội bộ' },
      { code: 'portal.field', label: 'Vào Cổng Hiện trường' },
      { code: 'portal.sysadmin', label: 'Vào Cổng Quản trị hệ thống (chỉ quản trị nền tảng)' },
    ],
  },
  {
    group: 'Quản trị hệ thống',
    permissions: [
      { code: 'admin.users', label: 'Quản lý tài khoản và phân quyền (trong phạm vi)' },
      { code: 'admin.groups', label: 'Sửa ma trận nhóm–quyền toàn hệ thống' },
      { code: 'admin.delegate', label: 'Uỷ quyền phạm vi quản trị' },
      { code: 'admin.config', label: 'Cấu hình hệ thống' },
    ],
  },
];

/**
 * HỆ THỐNG CON và nhóm thuộc mỗi hệ thống — cơ sở của phân quyền theo phạm vi.
 *
 * Một tài khoản "thuộc" hệ thống nào là do nhóm của nó; admin của hệ thống nào chỉ
 * thấy và chỉ gán được nhóm của hệ thống đó (SA-08, SA-09). `platform_admin` không
 * thuộc hệ thống nào — nó đứng trên tất cả.
 */
export type SystemCode = 'kn' | 'htx' | 'cgh' | 'gis' | 'erp' | 'field';

export const SYSTEMS: { code: SystemCode; label: string; portal: string; adminRole: string; roles: string[] }[] = [
  { code: 'kn', label: 'Hệ thống Khuyến nông', portal: 'portal.kn', adminRole: ROLES.KN_ADMIN, roles: [ROLES.KN_ADMIN, ROLES.KN_TRUNG_UONG, ROLES.KN_TINH, ROLES.KN_XA] },
  { code: 'htx', label: 'Hệ thống Hợp tác xã', portal: 'portal.htx', adminRole: ROLES.HTX_ADMIN, roles: [ROLES.HTX_ADMIN, ROLES.HTX_MANAGER, ROLES.FARMER] },
  { code: 'cgh', label: 'Hệ thống Cơ giới hoá', portal: 'portal.cgh', adminRole: ROLES.CGH_ADMIN, roles: [ROLES.CGH_ADMIN, ROLES.DCRD_VIEWER] },
  { code: 'gis', label: 'Nền tảng GIS', portal: 'portal.gis', adminRole: ROLES.GIS_ADMIN, roles: [ROLES.GIS_ADMIN] },
  { code: 'erp', label: 'ERP nội bộ Mekong Green', portal: 'portal.erp', adminRole: ROLES.ERP_ADMIN, roles: [ROLES.ERP_ADMIN, ROLES.SUPPLY_CHAIN, ROLES.FINANCE, ROLES.WAREHOUSE_OP, ROLES.LOGISTICS, ROLES.EXECUTIVE, ROLES.VVB_AUDITOR] },
  { code: 'field', label: 'Hệ thống Hiện trường', portal: 'portal.field', adminRole: ROLES.FIELD_ADMIN, roles: [ROLES.FIELD_ADMIN, ROLES.FIELD_MANAGER, ROLES.FIELD_CREW] },
];

/** Nhóm quản trị của từng hệ thống con và chiều ngược lại. */
export const SYSTEM_ADMIN_ROLES: Record<SystemCode, string> = Object.fromEntries(SYSTEMS.map((s) => [s.code, s.adminRole])) as Record<SystemCode, string>;
export const ADMIN_ROLE_SYSTEM: Record<string, SystemCode> = Object.fromEntries(SYSTEMS.map((s) => [s.adminRole, s.code]));
export const isSystemAdminRole = (role: string): boolean => role in ADMIN_ROLE_SYSTEM;

/**
 * Hệ thống con mà một QUYỀN thuộc về — dùng để buộc quản trị nền tảng "vào" đúng hệ thống trước khi thao tác.
 *   'shared' = dữ liệu dùng chung (mdm, reporting) — dùng được khi đã ở trong bất kỳ hệ thống nào;
 *   'admin'  = quản trị nền tảng; null = quyền không thuộc hệ thống nào (route mở).
 */
export function systemOfPermission(permission: string | undefined | null): SystemCode | 'shared' | 'admin' | null {
  if (!permission) return null;
  const [domain, action] = permission.split('.');
  if (domain === 'portal') return action === 'sysadmin' ? 'admin' : (action as SystemCode);
  switch (domain) {
    case 'khuyennong': return 'kn';
    case 'htx': return 'htx';
    case 'cgh': case 'rental': return 'cgh';
    case 'gis': return 'gis';
    case 'simulation': case 'warehouse': case 'procurement': case 'sales': case 'tms': case 'finance': case 'mrv': return 'erp';
    case 'field': return 'field';
    case 'mdm': case 'reporting': return 'shared';
    case 'admin': return 'admin';
    default: return null;
  }
}

/** Nhóm → hệ thống. `*` là quản trị nền tảng. */
export const ROLE_SYSTEM: Record<string, SystemCode | '*'> = Object.fromEntries([
  [ROLES.PLATFORM_ADMIN, '*'],
  ...SYSTEMS.flatMap((s) => s.roles.map((r) => [r, s.code] as [string, SystemCode])),
]) as Record<string, SystemCode | '*'>;

/** Nhãn tiếng Việt của một quyền; trả về chính mã khi chưa có nhãn. */
export function permissionLabel(code: string): string {
  for (const group of PERMISSION_GROUPS) {
    const found = group.permissions.find((item) => item.code === code);
    if (found) return found.label;
  }
  return code;
}

const P = PERMISSIONS;

const READ_ONLY_ALL: Permission[] = [
  P.MDM_READ, P.GIS_READ, P.KN_READ, P.HTX_READ, P.CGH_READ,
  P.RENTAL_READ, P.SIM_READ, P.WH_READ, P.PO_READ, P.SO_READ,
  P.TMS_READ, P.FIN_READ, P.MRV_READ, P.REPORT_READ, P.FIELD_READ,
];

export const ROLE_PERMISSIONS: Record<string, Permission[] | ['*']> = {
  [ROLES.PLATFORM_ADMIN]: ['*'],

  [ROLES.KN_TRUNG_UONG]: [
    P.PORTAL_KN, P.PORTAL_GIS, P.PORTAL_CGH,
    P.MDM_READ, P.MDM_WRITE, P.GIS_READ,
    P.KN_READ, P.KN_WRITE, P.KN_PUBLISH,
    P.HTX_READ, P.CGH_READ, P.REPORT_READ, P.MRV_READ,
  ],
  [ROLES.KN_TINH]: [
    P.PORTAL_KN, P.PORTAL_GIS,
    P.MDM_READ, P.GIS_READ, P.KN_READ, P.KN_WRITE, P.KN_PUBLISH,
    P.HTX_READ, P.CGH_READ, P.REPORT_READ,
  ],
  // Cán bộ xã / Tổ KNCĐ làm việc trực tiếp cùng HTX nên vào được cả hai cổng.
  [ROLES.KN_XA]: [
    P.PORTAL_KN, P.PORTAL_HTX,
    P.MDM_READ, P.MDM_WRITE, P.GIS_READ, P.GIS_WRITE,
    P.KN_READ, P.KN_WRITE, P.HTX_READ, P.HTX_WRITE, P.CGH_READ,
  ],

  [ROLES.HTX_MANAGER]: [
    P.PORTAL_HTX,
    P.MDM_READ, P.GIS_READ, P.KN_READ,
    P.HTX_READ, P.HTX_WRITE, P.CGH_READ,
    P.RENTAL_READ, P.RENTAL_WRITE, P.REPORT_READ,
  ],
  [ROLES.FARMER]: [
    P.PORTAL_HTX,
    P.GIS_READ, P.KN_READ, P.HTX_READ, P.HTX_WRITE, P.RENTAL_READ,
  ],

  // CGH BRD: "Cục chỉ Xem" — vai trò khách hàng DCRD không được ghi dữ liệu.
  [ROLES.DCRD_VIEWER]: [P.PORTAL_CGH, P.MDM_READ, P.GIS_READ, P.CGH_READ, P.REPORT_READ],

  [ROLES.SUPPLY_CHAIN]: [
    P.PORTAL_ERP, P.PORTAL_GIS, P.PORTAL_CGH, P.PORTAL_FIELD,
    P.FIELD_READ, P.FIELD_MANAGE,
    P.MDM_READ, P.MDM_WRITE, P.GIS_READ, P.GIS_WRITE,
    P.SIM_READ, P.SIM_WRITE, P.SIM_PARAM_APPROVE,
    P.WH_READ, P.PO_READ, P.PO_WRITE, P.SO_READ,
    P.TMS_READ, P.TMS_WRITE, P.CGH_READ, P.REPORT_READ, P.MRV_READ,
  ],
  [ROLES.FINANCE]: [
    P.PORTAL_ERP,
    P.MDM_READ, P.SIM_READ, P.SIM_PARAM_APPROVE,
    P.FIN_READ, P.FIN_WRITE, P.PO_READ, P.SO_READ,
    P.WH_READ, P.REPORT_READ,
  ],
  [ROLES.WAREHOUSE_OP]: [
    P.PORTAL_ERP,
    P.MDM_READ, P.GIS_READ, P.WH_READ, P.WH_WRITE, P.FIELD_READ,
    P.PO_READ, P.SO_READ, P.TMS_READ, P.MRV_WRITE, P.MRV_READ,
  ],
  [ROLES.LOGISTICS]: [
    P.PORTAL_ERP, P.PORTAL_GIS, P.PORTAL_FIELD,
    P.FIELD_READ, P.FIELD_MANAGE,
    P.MDM_READ, P.GIS_READ, P.GIS_WRITE, P.TMS_READ, P.TMS_WRITE,
    P.WH_READ, P.SIM_READ, P.REPORT_READ,
  ],
  // Ban lãnh đạo: xem toàn bộ + chốt ngưỡng khuyến nghị và trạng thái "Chính thức"
  // (Simulation FN-01 BR-04, AS-14 — hai quyền này tách khỏi quyền dựng kịch bản).
  [ROLES.EXECUTIVE]: [
    ...READ_ONLY_ALL, P.SIM_MARK_OFFICIAL, P.SIM_THRESHOLD,
    P.PORTAL_ERP, P.PORTAL_KN, P.PORTAL_HTX, P.PORTAL_CGH, P.PORTAL_GIS, P.PORTAL_FIELD,
  ],

  // Điều hành hiện trường: lập kế hoạch thu gom từ lịch gặt của App HTX, phân
  // công đội, theo dõi ghe — nên cần đọc HTX, CGH và tạo chuyến TMS.
  [ROLES.FIELD_MANAGER]: [
    P.PORTAL_FIELD, P.PORTAL_ERP,
    P.FIELD_READ, P.FIELD_WRITE, P.FIELD_MANAGE,
    P.MDM_READ, P.GIS_READ, P.HTX_READ, P.CGH_READ, P.TMS_READ, P.TMS_WRITE, P.WH_READ, P.PO_READ, P.REPORT_READ,
  ],
  // Đội trưởng thu gom: chỉ ghi nhận việc của đội mình trên điện thoại.
  [ROLES.FIELD_CREW]: [P.PORTAL_FIELD, P.FIELD_READ, P.FIELD_WRITE, P.GIS_READ, P.MDM_READ],

  // Kiểm định viên chỉ vào ERP để đối chiếu hồ sơ MRV, không đụng tới các cổng
  // nghiệp vụ của nông dân và cán bộ khuyến nông.
  [ROLES.VVB_AUDITOR]: [P.PORTAL_ERP, P.GIS_READ, P.MRV_READ, P.REPORT_READ],
};

/**
 * QUYỀN CỦA QUẢN TRỊ HỆ THỐNG CON (cơ cấu 09/2026) — CÁCH LY TUYỆT ĐỐI GIỮA CÁC HỆ THỐNG:
 *   = cổng của mình + TOÀN BỘ quyền thuộc miền nghiệp vụ của hệ thống mình (đọc/ghi/duyệt)
 *   + dữ liệu dùng chung chỉ đọc (mdm.read, gis.read, reporting.read; mdm.write nếu nhóm nghiệp vụ của hệ thống có)
 *   + quản lý tài khoản và uỷ quyền TRONG hệ thống (admin.users, admin.delegate).
 * KHÔNG có quyền đọc/ghi dữ liệu hệ thống khác dù nhóm nghiệp vụ của hệ thống có (cán bộ KN đọc HTX được,
 * quản trị KN thì không), KHÔNG có admin.config / admin.groups / portal.sysadmin — ba thứ đó chỉ quản trị nền tảng có.
 */
const SYSTEM_PERMISSION_DOMAINS: Record<SystemCode, string[]> = {
  kn: ['khuyennong'], htx: ['htx'], cgh: ['cgh', 'rental'], gis: ['gis'],
  erp: ['simulation', 'warehouse', 'procurement', 'sales', 'tms', 'finance', 'mrv'], field: ['field'],
};
const SHARED_READ: Permission[] = [P.MDM_READ, P.GIS_READ, P.REPORT_READ];
export function systemAdminPermissions(code: SystemCode): Permission[] {
  const system = SYSTEMS.find((s) => s.code === code)!;
  const domains = new Set(SYSTEM_PERMISSION_DOMAINS[code]);
  const union = new Set<Permission>([system.portal as Permission, ...SHARED_READ, P.ADMIN_USERS, P.ADMIN_DELEGATE]);
  for (const permission of Object.values(P)) if (domains.has(permission.split('.')[0])) union.add(permission);
  const rolesWriteMdm = system.roles.some((role) => role !== system.adminRole && ((ROLE_PERMISSIONS[role] ?? []) as Permission[]).includes(P.MDM_WRITE));
  if (rolesWriteMdm || code === 'gis') union.add(P.MDM_WRITE);
  union.delete(P.ADMIN_CONFIG); union.delete(P.ADMIN_GROUPS); union.delete(P.PORTAL_SYSADMIN);
  return [...union];
}
for (const system of SYSTEMS) ROLE_PERMISSIONS[system.adminRole] = systemAdminPermissions(system.code);

/**
 * QUYỀN MẶC ĐỊNH THEO MÃ NGUỒN — baseline, không đọc CSDL.
 *
 * Tách riêng khỏi `permissionsFor` để giao diện quản trị so sánh được đâu là
 * mặc định và đâu là phần đã bị ghi đè.
 */
export function defaultPermissionsFor(roles: string[]): Set<string> {
  const result = new Set<string>();
  for (const role of roles) {
    const granted = ROLE_PERMISSIONS[role];
    if (!granted) continue;
    if (granted[0] === '*') return new Set(['*']);
    for (const permission of granted as Permission[]) result.add(permission);
  }
  return result;
}

/**
 * Ghi đè quyền do quản trị viên đặt, nạp từ bảng `group_permissions`.
 *
 * Được gọi trên MỌI yêu cầu nên phải rẻ: giữ trong bộ nhớ và chỉ nạp lại khi có
 * thay đổi (`invalidatePermissionCache`). Truy vấn CSDL mỗi lần sẽ biến phân
 * quyền thành nút thắt cổ chai của cả hệ thống.
 */
let overrideCache: Map<string, Map<string, boolean>> | null = null;

export function invalidatePermissionCache(): void {
  overrideCache = null;
}

function overrides(): Map<string, Map<string, boolean>> {
  if (overrideCache) return overrideCache;
  const map = new Map<string, Map<string, boolean>>();
  try {
    const rows = all<{ group_code: string; permission: string; granted: number }>(
      'SELECT group_code, permission, granted FROM group_permissions',
    );
    for (const row of rows) {
      const entry = map.get(row.group_code) ?? new Map<string, boolean>();
      entry.set(row.permission, row.granted === 1);
      map.set(row.group_code, entry);
    }
  } catch {
    // Bảng chưa tồn tại (CSDL cũ chưa migrate) — dùng mặc định trong mã nguồn.
  }
  overrideCache = map;
  return map;
}

/**
 * Quyền HIỆU LỰC của một tập vai trò: mặc định trong mã nguồn, rồi áp ghi đè.
 *
 * Vai trò có `*` (quản trị nền tảng) vẫn là toàn quyền và KHÔNG chịu ghi đè —
 * nếu cho phép thu hồi quyền của quản trị nền tảng thì một thao tác nhầm là
 * khoá cứng cả hệ thống, không còn ai vào sửa lại được.
 */
export function permissionsFor(roles: string[]): Set<string> {
  for (const role of roles) {
    if (ROLE_PERMISSIONS[role]?.[0] === '*') return new Set(['*']);
  }

  const table = overrides();
  const result = new Set<string>();
  for (const role of roles) {
    // Vai trò hệ thống lấy mặc định từ mã nguồn; nhóm tuỳ chỉnh bắt đầu từ rỗng.
    for (const permission of (ROLE_PERMISSIONS[role] ?? []) as Permission[]) result.add(permission);
    for (const [permission, granted] of table.get(role) ?? []) {
      if (granted) result.add(permission);
      else result.delete(permission);
    }
  }
  return result;
}

export function can(roles: string[], permission: Permission | string): boolean {
  const granted = permissionsFor(roles);
  return granted.has('*') || granted.has(permission);
}
