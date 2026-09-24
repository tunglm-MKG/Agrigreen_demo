/**
 * Kiểm thử tách cổng (portal) và ma trận quyền vào cổng.
 *
 * Điểm mấu chốt được bảo vệ ở đây: QUYỀN ĐỌC DỮ LIỆU KHÔNG KÉO THEO QUYỀN VÀO
 * CỔNG. Ban quản lý HTX đọc được quy trình kỹ thuật đã xuất bản (khuyennong.read)
 * nhưng không được vào Cổng Khuyến nông; họ cũng xem được báo cáo dùng chung
 * (reporting.read) mà không vì thế mở được ERP nội bộ.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PERMISSIONS as P, ROLES, permissionsFor } from '../src/platform/auth/rbac.ts';

// Nạp thẳng cấu hình thật thay vì phân tích văn bản nguồn — test không được
// trôi khỏi cấu hình mà nó đang bảo vệ.
const { PORTALS, portalItems } = await import('../src/web/portals.js');

interface DeclaredPortal {
  id: string;
  path: string;
  permission: string;
  pageIds: string[];
}

function declaredPortals(): DeclaredPortal[] {
  return (PORTALS as Record<string, unknown>[]).map((portal) => ({
    id: portal.id as string,
    path: portal.path as string,
    permission: portal.permission as string,
    pageIds: (portalItems(portal) as { id: string }[]).map((item) => item.id),
  }));
}

test('Mỗi cổng có đường dẫn riêng và được gác bằng một quyền portal.* riêng', () => {
  const portals = declaredPortals();
  assert.equal(portals.length, 7, 'phải có đúng 7 cổng: KN, HTX, CGH, GIS, Hiện trường, ERP và Quản trị hệ thống');

  const paths = portals.map((p) => p.path);
  assert.deepEqual([...new Set(paths)], paths, 'đường dẫn cổng không được trùng nhau');

  for (const portal of portals) {
    assert.ok(
      portal.permission.startsWith('portal.'),
      `${portal.id}: cổng phải được gác bằng quyền portal.*, không phải quyền đọc dữ liệu (đang là "${portal.permission}")`,
    );
    assert.ok(portal.pageIds.length >= 1, `${portal.id}: cổng phải có ít nhất một chức năng`);
  }
});

test('Ba app nghiệp vụ đã tách thành cổng riêng, mỗi cổng có hệ thống chức năng riêng', () => {
  const portals = declaredPortals();
  const byId = Object.fromEntries(portals.map((p) => [p.id, p]));

  for (const id of ['kn', 'htx', 'cgh']) {
    assert.ok(byId[id], `thiếu cổng "${id}"`);
  }

  // Trước khi tách, cả ba app chỉ có 1 trang mỗi app. Sau khi tách, mỗi cổng
  // phải có một hệ thống chức năng nhiều màn hình theo BRD.
  assert.ok(byId.kn.pageIds.length >= 8, `Cổng Khuyến nông mới có ${byId.kn.pageIds.length} chức năng`);
  assert.ok(byId.htx.pageIds.length >= 7, `Cổng Hợp tác xã mới có ${byId.htx.pageIds.length} chức năng`);
  assert.ok(byId.cgh.pageIds.length >= 8, `Cổng Cơ giới hoá mới có ${byId.cgh.pageIds.length} chức năng`);

  // Không cổng nghiệp vụ nào được dùng chung định danh trang với cổng khác,
  // trừ những màn hình dùng chung có chủ đích (nhập Excel, sàn cho thuê).
  // Cổng Hiện trường dùng lại màn hình TMS và GIS (đội trưởng xem chuyến ghe của
  // mình); ERP mở được bảng điều hành hiện trường — đều là dùng chung có chủ đích.
  // Tài khoản và phân cấp quản trị hiện ở MỌI cổng: admin KN tỉnh quản cán bộ của mình ngay trong Cổng Khuyến nông.
  const shared = new Set(['import', 'masterdata', 'rental', 'htx-rental', 'tms', 'gis', 'field-dashboard', 'field-weighing', 'vessels', 'sys-users', 'sys-scopes']);
  const seen = new Map<string, string>();
  for (const portal of portals) {
    for (const pageId of portal.pageIds) {
      if (shared.has(pageId)) continue;
      const owner = seen.get(pageId);
      assert.equal(owner, undefined, `trang "${pageId}" xuất hiện ở cả cổng ${owner} và ${portal.id}`);
      seen.set(pageId, portal.id);
    }
  }
});

test('Quyền ĐỌC dữ liệu không mở cửa cổng tương ứng', () => {
  const htx = permissionsFor([ROLES.HTX_MANAGER]);

  // Ban quản lý HTX vẫn đọc được nội dung khuyến nông và báo cáo dùng chung…
  assert.ok(htx.has(P.KN_READ), 'HTX phải đọc được quy trình kỹ thuật đã xuất bản');
  assert.ok(htx.has(P.REPORT_READ), 'HTX phải xem được báo cáo dùng chung');

  // …nhưng KHÔNG vào được Cổng Khuyến nông hay ERP nội bộ.
  assert.ok(!htx.has(P.PORTAL_KN), 'HTX không được vào Cổng Khuyến nông');
  assert.ok(!htx.has(P.PORTAL_ERP), 'HTX không được vào ERP nội bộ');
  assert.ok(htx.has(P.PORTAL_HTX), 'HTX phải vào được cổng của chính mình');
});

test('Mỗi vai trò nghiệp vụ vào đúng cổng của mình', () => {
  const cases: [string, string[], string[]][] = [
    [ROLES.KN_TINH, [P.PORTAL_KN, P.PORTAL_GIS], [P.PORTAL_HTX, P.PORTAL_ERP]],
    [ROLES.FARMER, [P.PORTAL_HTX], [P.PORTAL_KN, P.PORTAL_CGH, P.PORTAL_ERP]],
    [ROLES.DCRD_VIEWER, [P.PORTAL_CGH], [P.PORTAL_KN, P.PORTAL_HTX, P.PORTAL_ERP]],
    [ROLES.WAREHOUSE_OP, [P.PORTAL_ERP], [P.PORTAL_KN, P.PORTAL_HTX, P.PORTAL_CGH]],
    [ROLES.VVB_AUDITOR, [P.PORTAL_ERP], [P.PORTAL_KN, P.PORTAL_HTX, P.PORTAL_CGH, P.PORTAL_GIS]],
  ];

  for (const [role, allowed, denied] of cases) {
    const granted = permissionsFor([role]);
    for (const permission of allowed) {
      assert.ok(granted.has(permission), `${role} phải có ${permission}`);
    }
    for (const permission of denied) {
      assert.ok(!granted.has(permission), `${role} KHÔNG được có ${permission}`);
    }
  }
});

test('Cán bộ Khuyến nông xã vào được cả hai cổng vì làm việc trực tiếp cùng HTX', () => {
  const granted = permissionsFor([ROLES.KN_XA]);
  assert.ok(granted.has(P.PORTAL_KN));
  assert.ok(granted.has(P.PORTAL_HTX));
  assert.ok(!granted.has(P.PORTAL_ERP), 'cán bộ khuyến nông không có việc gì trong ERP nội bộ');
});

test('Quản trị nền tảng vào được mọi cổng', () => {
  const granted = permissionsFor([ROLES.PLATFORM_ADMIN]);
  assert.ok(granted.has('*'));
});

test('Mọi trang khai báo trong portals.js đều được nạp ở boot.js', () => {
  const boot = readFileSync(new URL('../src/web/boot.js', import.meta.url), 'utf8');
  const modules = [...boot.matchAll(/import '\/pages\/([^']+)\.js'/g)].map((m) => m[1]);
  assert.ok(modules.length >= 8, 'boot.js phải nạp đủ các module trang');

  const registered = new Set<string>();
  for (const moduleName of modules) {
    const source = readFileSync(new URL(`../src/web/pages/${moduleName}.js`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/registerPage\('([^']+)'/g)) registered.add(match[1]);
  }

  for (const portal of declaredPortals()) {
    for (const pageId of portal.pageIds) {
      assert.ok(registered.has(pageId), `cổng ${portal.id} trỏ tới trang "${pageId}" chưa được đăng ký ở đâu cả`);
    }
  }
});
