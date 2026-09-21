/**
 * Kiểm thử PHÂN QUYỀN THEO PHẠM VI (SA-08..SA-12).
 *
 * Câu hỏi bảo vệ: admin Khuyến nông tỉnh An Giang có thấy cán bộ Đồng Tháp không?
 * Có cấp được quyền ERP không? Có uỷ quyền tiếp được không? Mỗi câu phải là KHÔNG,
 * và super admin phải là CÓ với tất cả.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-scope-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const users = await import('../src/platform/auth/users.ts');
const scopes = await import('../src/platform/auth/scopes.ts');
const admin = await import('../src/platform/auth/admin.ts');
const rbac = await import('../src/platform/auth/rbac.ts');

migrate();
seedAll();
admin.syncSystemGroups();

const byName = (username: string) => users.listUsers().find((u) => u.username === username)!;
const ctxOf = (username: string) => scopes.adminContext(byName(username));
const actorOf = (username: string) => ({ id: byName(username).id, name: username });
const province = (code: string) => one<{ id: string }>('SELECT id FROM admin_units WHERE code = ? AND level = ?', [code, 'province'])!.id;

test('Mỗi nhóm thuộc đúng một hệ thống; quản trị nền tảng đứng ngoài mọi hệ thống', () => {
  for (const role of Object.keys(rbac.ROLE_LABELS)) assert.ok(rbac.ROLE_SYSTEM[role], `nhóm ${role} chưa xếp hệ thống`);
  assert.equal(rbac.ROLE_SYSTEM[rbac.ROLES.PLATFORM_ADMIN], '*');
  assert.equal(rbac.ROLE_SYSTEM[rbac.ROLES.KN_TINH], 'kn');
  assert.equal(rbac.ROLE_SYSTEM[rbac.ROLES.FINANCE], 'erp');
  for (const s of rbac.SYSTEMS) for (const r of s.roles) assert.equal(rbac.ROLE_SYSTEM[r], s.code);
});

test('Seed: admin KN An Giang có phạm vi tỉnh; admin ERP có phạm vi toàn hệ thống; super admin không cần dòng nào', () => {
  const kn = ctxOf('qtri_kn_ag');
  assert.equal(kn.superAdmin, false);
  assert.deepEqual(kn.scopes.map((s) => [s.system, s.scopeType]), [['kn', 'province']]);
  assert.equal(kn.canDelegate, false);
  const erp = ctxOf('qtri_erp');
  assert.deepEqual(erp.scopes.map((s) => [s.system, s.scopeType]), [['erp', 'system']]);
  assert.equal(erp.canDelegate, true);
  const root = ctxOf('admin');
  assert.equal(root.superAdmin, true);
  assert.equal(all('SELECT id FROM admin_scopes WHERE user_id = ?', [byName('admin').id]).length, 0);
  assert.equal(scopes.tryAdminContext(byName('nongdan')), null, 'nông dân không quản trị gì');
  assert.throws(() => scopes.adminContext(byName('nongdan')), /không có quyền quản trị/);
});

test('SA-08: admin KN tỉnh An Giang thấy cán bộ An Giang, KHÔNG thấy Đồng Tháp, ERP, hay super admin', () => {
  const visible = scopes.visibleUserIds(ctxOf('qtri_kn_ag'))!;
  assert.ok(visible.has(byName('canbo_xa').id), 'cán bộ xã An Giang');
  assert.ok(visible.has(byName('qtri_kn_ag').id), 'thấy chính mình');
  assert.ok(!visible.has(byName('canbo_xa_dt').id), 'cán bộ xã Đồng Tháp nằm ngoài');
  assert.ok(!visible.has(byName('canbo_tw').id), 'cán bộ TW không có tỉnh');
  assert.ok(!visible.has(byName('taichinh').id), 'ERP là hệ thống khác');
  assert.ok(!visible.has(byName('htx01').id), 'htx01 ở An Giang nhưng thuộc hệ thống HTX');
  assert.ok(!visible.has(byName('admin').id), 'super admin ngoài mọi phạm vi con');
  assert.equal(scopes.visibleUserIds(ctxOf('admin')), null, 'super admin thấy tất cả');
  assert.throws(() => scopes.assertCanManage(ctxOf('qtri_kn_ag'), byName('canbo_xa_dt').id), /SA-08/);
  assert.throws(() => scopes.assertCanManage(ctxOf('qtri_kn_ag'), byName('admin').id), /SA-08/);
  scopes.assertCanManage(ctxOf('qtri_kn_ag'), byName('canbo_xa').id);
});

test('SA-08 cấp hệ thống: admin ERP thấy mọi người của ERP ở mọi tỉnh, không thấy KN', () => {
  const visible = scopes.visibleUserIds(ctxOf('qtri_erp'))!;
  for (const u of ['supplychain', 'taichinh', 'khonhap', 'dieuphoi', 'banlanhdao', 'vvb']) assert.ok(visible.has(byName(u).id), u);
  assert.ok(!visible.has(byName('canbo_xa').id));
  assert.ok(!visible.has(byName('hientruong').id), 'hiện trường là hệ thống riêng');
});

test('SA-09: nhóm gán được chỉ thuộc hệ thống mình; không bao giờ có quản trị nền tảng', () => {
  const kn = scopes.assignableRoles(ctxOf('qtri_kn_ag'));
  assert.deepEqual(new Set(kn), new Set([rbac.ROLES.KN_TRUNG_UONG, rbac.ROLES.KN_TINH, rbac.ROLES.KN_XA]));
  assert.throws(() => scopes.assertRolesAllowed(ctxOf('qtri_kn_ag'), [rbac.ROLES.FINANCE]), /SA-09/);
  assert.throws(() => scopes.assertRolesAllowed(ctxOf('qtri_erp'), [rbac.ROLES.PLATFORM_ADMIN]), /SA-09/);
  assert.ok(scopes.assignableRoles(ctxOf('admin')).includes(rbac.ROLES.PLATFORM_ADMIN));
});

test('Admin cấp hệ thống ERP gán được nhóm Tài chính cho nhân viên dù bản thân không có quyền tài chính (SA-03 nhường chỗ)', () => {
  const target = users.createUser({ username: 'nv_kho_moi', fullName: 'Nhân viên kho mới', roles: [rbac.ROLES.WAREHOUSE_OP], password: 'x1234567' }, actorOf('qtri_erp'));
  const erpCtx = ctxOf('qtri_erp');
  scopes.assertCanManage(erpCtx, target.user.id);
  scopes.assertRolesAllowed(erpCtx, [rbac.ROLES.FINANCE]);
  const updated = admin.setUserRoles(target.user.id, [rbac.ROLES.FINANCE], actorOf('qtri_erp'));
  assert.deepEqual(updated.roles, [rbac.ROLES.FINANCE]);
  // Nhưng admin tỉnh KN (không có phạm vi cấp hệ thống) vẫn bị SA-03 chặn khi cấp nhóm cao hơn mình.
  const officer = byName('canbo_xa');
  assert.throws(() => admin.setUserRoles(officer.id, [rbac.ROLES.KN_TRUNG_UONG], actorOf('qtri_kn_ag')), /không có/);
});

test('SA-12: tài khoản tạo trong phạm vi tỉnh bị gán cứng tỉnh đó; tỉnh khác bị từ chối', () => {
  const kn = ctxOf('qtri_kn_ag');
  const coerced = scopes.coerceCreateInput(kn, { username: 'cb_moi', fullName: 'x', roles: [rbac.ROLES.KN_XA] });
  assert.equal(coerced.provinceId, province('AG'));
  assert.throws(() => scopes.coerceCreateInput(kn, { username: 'cb', fullName: 'x', roles: [rbac.ROLES.KN_XA], provinceId: province('DT') }), /SA-12/);
  assert.throws(() => scopes.coerceCreateInput(kn, { username: 'cb', fullName: 'x', roles: [rbac.ROLES.HTX_MANAGER] }), /SA-09/);
  const created = users.createUser({ ...coerced, password: 'matkhau123' }, actorOf('qtri_kn_ag'));
  assert.equal(created.user.provinceId, province('AG'));
  assert.ok(scopes.visibleUserIds(kn)!.has(created.user.id), 'người vừa tạo lập tức nằm trong phạm vi');
  // Super admin không bị ép.
  const free = scopes.coerceCreateInput(ctxOf('admin'), { username: 'a', fullName: 'a', roles: [rbac.ROLES.KN_XA] });
  assert.equal(free.provinceId, undefined);
});

test('SA-11: super admin uỷ quyền bất kỳ; admin cấp hệ thống chỉ uỷ quyền tỉnh/HTX trong hệ thống mình; admin tỉnh không uỷ quyền', () => {
  const root = ctxOf('admin');
  const erp = ctxOf('qtri_erp');
  const kn = ctxOf('qtri_kn_ag');
  const staff = byName('khonhap');
  // ERP admin → phạm vi tỉnh cho nhân viên kho: được.
  const granted = scopes.grantScope({ userId: staff.id, system: 'erp', scopeType: 'province', scopeId: province('CT') }, erp, actorOf('qtri_erp'));
  assert.equal(granted.scopeType, 'province');
  assert.throws(() => scopes.grantScope({ userId: staff.id, system: 'erp', scopeType: 'system' }, erp, actorOf('qtri_erp')), /SA-11.*không nhân bản/);
  assert.throws(() => scopes.grantScope({ userId: byName('canbo_xa').id, system: 'kn', scopeType: 'province', scopeId: province('AG') }, erp, actorOf('qtri_erp')), /SA-11.*không quản trị toàn hệ thống/);
  assert.throws(() => scopes.grantScope({ userId: byName('canbo_xa').id, system: 'kn', scopeType: 'province', scopeId: province('AG') }, kn, actorOf('qtri_kn_ag')), /SA-11.*không uỷ quyền tiếp/);
  // Người được uỷ quyền phải thuộc nhóm của hệ thống đó.
  assert.throws(() => scopes.grantScope({ userId: byName('canbo_xa').id, system: 'erp', scopeType: 'system' }, root, actorOf('admin')), /không thuộc nhóm nào/);
  // Super admin: cấp hệ thống cho cán bộ TW KN.
  const knSys = scopes.grantScope({ userId: byName('canbo_tw').id, system: 'kn', scopeType: 'system' }, root, actorOf('admin'));
  assert.equal(ctxOf('canbo_tw').canDelegate, true);
  assert.throws(() => scopes.grantScope({ userId: staff.id, system: 'erp', scopeType: 'province', scopeId: province('CT') }, root, actorOf('admin')), /đã được cấp/);
  // Thu hồi: ERP admin thu hồi được phạm vi tỉnh mình cấp; không thu hồi được phạm vi KN.
  scopes.revokeScope(granted.id, erp, actorOf('qtri_erp'));
  assert.throws(() => scopes.revokeScope(knSys.id, erp, actorOf('qtri_erp')), /SA-11/);
  scopes.revokeScope(knSys.id, root, actorOf('admin'));
  assert.equal(scopes.tryAdminContext(byName('canbo_tw')), null);
});

test('describeUser mở quyền ảo admin.users cho admin phạm vi và admin.delegate cho cấp hệ thống — không mở admin.groups', () => {
  const kn = users.describeUser(byName('qtri_kn_ag')) as { permissions: string[]; adminScopes: unknown[] };
  assert.ok(kn.permissions.includes('admin.users'));
  assert.ok(!kn.permissions.includes('admin.delegate'));
  assert.ok(!kn.permissions.includes('admin.groups'), 'SA-10: ma trận nhóm–quyền không mở cho admin phạm vi');
  assert.equal(kn.adminScopes.length, 1);
  const erp = users.describeUser(byName('qtri_erp')) as { permissions: string[] };
  assert.ok(erp.permissions.includes('admin.delegate'));
  const plain = users.describeUser(byName('canbo_xa')) as { permissions: string[] };
  assert.ok(!plain.permissions.includes('admin.users'));
  assert.throws(() => scopes.requireSuperAdmin(byName('qtri_erp')), /SA-10/);
});

test('Bảng điều hành thu hẹp theo phạm vi: admin tỉnh đếm đúng người tỉnh mình, không lộ số quản trị nền tảng', () => {
  const dash = scopes.scopedDashboard(ctxOf('qtri_kn_ag')) as { totalUsers: number; platformAdmins: null; scoped: boolean };
  assert.equal(dash.scoped, true);
  assert.equal(dash.platformAdmins, null);
  assert.equal(dash.totalUsers, scopes.visibleUserIds(ctxOf('qtri_kn_ag'))!.size);
  const lookups = scopes.adminLookups(ctxOf('qtri_kn_ag')) as { provinces: { code: string }[]; systems: { code: string }[] };
  assert.deepEqual(lookups.provinces.map((p) => p.code), ['AG'], 'danh sách tỉnh chỉ còn tỉnh mình');
  assert.deepEqual(lookups.systems.map((s) => s.code), ['kn']);
});
