/**
 * Ma trận phân quyền HỢP NHẤT cho toàn hệ sinh thái.
 *
 * ERP Product Vision v1.2 ghi nhận "RBAC chưa hợp nhất" là rủi ro mức Cao:
 * mỗi BRD/PRD tự định nghĩa vai trò riêng nên khi ghép phân hệ sẽ mâu thuẫn.
 * File này là nguồn duy nhất định nghĩa vai trò và quyền cho cả 5 nhóm đối
 * tượng (HTX, doanh nghiệp, cơ quan quản lý, tổ chức kiểm định, nội bộ).
 */

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
  // Đối tác ngoài
  VVB_AUDITOR: 'vvb_auditor',
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
  [ROLES.VVB_AUDITOR]: 'Tổ chức kiểm định (VVB)',
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
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const P = PERMISSIONS;

const READ_ONLY_ALL: Permission[] = [
  P.MDM_READ, P.GIS_READ, P.KN_READ, P.HTX_READ, P.CGH_READ,
  P.RENTAL_READ, P.SIM_READ, P.WH_READ, P.PO_READ, P.SO_READ,
  P.TMS_READ, P.FIN_READ, P.MRV_READ, P.REPORT_READ,
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
    P.PORTAL_ERP, P.PORTAL_GIS, P.PORTAL_CGH,
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
    P.MDM_READ, P.GIS_READ, P.WH_READ, P.WH_WRITE,
    P.PO_READ, P.SO_READ, P.TMS_READ, P.MRV_WRITE, P.MRV_READ,
  ],
  [ROLES.LOGISTICS]: [
    P.PORTAL_ERP, P.PORTAL_GIS,
    P.MDM_READ, P.GIS_READ, P.GIS_WRITE, P.TMS_READ, P.TMS_WRITE,
    P.WH_READ, P.SIM_READ, P.REPORT_READ,
  ],
  // Ban lãnh đạo: xem toàn bộ + chốt ngưỡng khuyến nghị và trạng thái "Chính thức"
  // (Simulation FN-01 BR-04, AS-14 — hai quyền này tách khỏi quyền dựng kịch bản).
  [ROLES.EXECUTIVE]: [
    ...READ_ONLY_ALL, P.SIM_MARK_OFFICIAL, P.SIM_THRESHOLD,
    P.PORTAL_ERP, P.PORTAL_KN, P.PORTAL_HTX, P.PORTAL_CGH, P.PORTAL_GIS,
  ],

  // Kiểm định viên chỉ vào ERP để đối chiếu hồ sơ MRV, không đụng tới các cổng
  // nghiệp vụ của nông dân và cán bộ khuyến nông.
  [ROLES.VVB_AUDITOR]: [P.PORTAL_ERP, P.GIS_READ, P.MRV_READ, P.REPORT_READ],
};

export function permissionsFor(roles: string[]): Set<string> {
  const result = new Set<string>();
  for (const role of roles) {
    const granted = ROLE_PERMISSIONS[role];
    if (!granted) continue;
    if (granted[0] === '*') return new Set(['*']);
    for (const permission of granted as Permission[]) result.add(permission);
  }
  return result;
}

export function can(roles: string[], permission: Permission | string): boolean {
  const granted = permissionsFor(roles);
  return granted.has('*') || granted.has(permission);
}
