/**
 * Kiểm thử QUẢN TRỊ HỆ THỐNG: tài khoản, nhóm người dùng, phân quyền.
 *
 * Đây là phân hệ mà một thao tác nhầm gây hậu quả nặng nhất — khoá nhầm tài
 * khoản quản trị cuối cùng là không còn ai vào sửa lại được. Phần lớn test ở đây
 * bảo vệ các chốt chặn, không phải các thao tác CRUD.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-adm-')), 'test.db'));

const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const users = await import('../src/platform/auth/users.ts');
const rbac = await import('../src/platform/auth/rbac.ts');
const admin = await import('../src/platform/auth/admin.ts');

migrate();
seedAll();
admin.syncSystemGroups();

/** Tài khoản quản trị nền tảng có sẵn trong bộ seed. */
const rootAdmin = users.listUsers().find((u) => u.username === 'SAdmin')!;
const rootActor = { id: rootAdmin.id, name: rootAdmin.fullName };

function newUser(username: string, roles: string[]) {
  const created = users.createUser(
    { username, fullName: `Người dùng ${username}`, roles, password: 'MatKhau123' },
    rootActor,
  ) as { user: { id: string } };
  return created.user;
}

// ===========================================================================
// Nhóm người dùng
// ===========================================================================

test('Vai trò trong mã nguồn được đồng bộ thành nhóm hệ thống', () => {
  const groups = admin.listGroups();
  const system = groups.filter((g) => g.isSystem);
  assert.ok(system.length >= 10, `mới có ${system.length} nhóm hệ thống`);

  const htxGroup = groups.find((g) => g.code === 'htx_manager')!;
  assert.equal(htxGroup.isSystem, true);
  assert.ok(htxGroup.defaultPermissions.includes('portal.htx'));
  assert.ok(htxGroup.userCount >= 1, 'phải đếm được số người dùng trong nhóm');
});

test('SA-06 — nhóm hệ thống không xoá và không đổi tên được', () => {
  assert.throws(() => admin.deleteGroup('htx_manager', rootActor), /nhóm hệ thống/);
  assert.throws(() => admin.updateGroup('htx_manager', { label: 'Tên mới' }, rootActor), /lấy tên từ mã nguồn/);
  // Nhưng mô tả thì sửa được.
  const updated = admin.updateGroup('htx_manager', { description: 'Ghi chú nội bộ' }, rootActor);
  assert.equal(updated.description, 'Ghi chú nội bộ');
});

test('Tạo nhóm tuỳ chỉnh, cấp quyền, và người dùng nhận đúng quyền', () => {
  const group = admin.createGroup(
    { code: 'ke-toan-htx', label: 'Kế toán HTX', description: 'Chỉ xem tài chính và vật tư' },
    rootActor,
  );
  assert.equal(group.code, 'ke_toan_htx', 'mã được chuẩn hoá về chữ thường và gạch dưới');
  assert.equal(group.isSystem, false);
  assert.deepEqual(group.effectivePermissions, [], 'nhóm mới bắt đầu từ rỗng');

  admin.setGroupPermission('ke_toan_htx', 'portal.htx', true, rootActor);
  admin.setGroupPermission('ke_toan_htx', 'htx.read', true, rootActor);
  admin.setGroupPermission('ke_toan_htx', 'finance.read', true, rootActor);

  const after = admin.listGroups().find((g) => g.code === 'ke_toan_htx')!;
  assert.deepEqual(after.effectivePermissions.sort(), ['finance.read', 'htx.read', 'portal.htx']);

  // Người dùng trong nhóm nhận đúng quyền đó, không hơn.
  const user = newUser('ketoan01', ['ke_toan_htx']);
  const granted = rbac.permissionsFor(users.getUser(user.id)!.roles);
  assert.ok(granted.has('finance.read'));
  assert.ok(!granted.has('finance.write'), 'không được tự có thêm quyền ghi');
  assert.ok(!granted.has('portal.erp'));
});

test('Ghi đè quyền của nhóm hệ thống: thu hồi rồi trả về mặc định', () => {
  const before = admin.listGroups().find((g) => g.code === 'kn_tinh')!;
  assert.ok(before.defaultPermissions.includes('khuyennong.publish'));
  assert.ok(rbac.permissionsFor(['kn_tinh']).has('khuyennong.publish'));

  // Thu hồi so với mặc định.
  admin.setGroupPermission('kn_tinh', 'khuyennong.publish', false, rootActor);
  assert.ok(!rbac.permissionsFor(['kn_tinh']).has('khuyennong.publish'), 'thu hồi phải có hiệu lực ngay');

  const overridden = admin.listGroups().find((g) => g.code === 'kn_tinh')!;
  assert.equal(overridden.overrides.length, 1);
  assert.equal(overridden.overrides[0].granted, false);
  assert.ok(
    overridden.defaultPermissions.includes('khuyennong.publish'),
    'mặc định gốc vẫn hiển thị để người dùng biết mình đang lệch khỏi đâu',
  );

  // Trả về mặc định.
  admin.setGroupPermission('kn_tinh', 'khuyennong.publish', null, rootActor);
  assert.ok(rbac.permissionsFor(['kn_tinh']).has('khuyennong.publish'));
  assert.equal(admin.listGroups().find((g) => g.code === 'kn_tinh')!.overrides.length, 0);
});

test('Khôi phục toàn bộ nhóm về mặc định', () => {
  admin.setGroupPermission('kn_xa', 'gis.write', false, rootActor);
  admin.setGroupPermission('kn_xa', 'finance.read', true, rootActor);
  assert.equal(admin.listGroups().find((g) => g.code === 'kn_xa')!.overrides.length, 2);

  const reset = admin.resetGroupPermissions('kn_xa', rootActor);
  assert.equal(reset.overrides.length, 0);
  assert.deepEqual(reset.effectivePermissions, reset.defaultPermissions);
});

test('Nhóm quản trị nền tảng KHÔNG điều chỉnh quyền được', () => {
  // Cho phép thu hồi quyền của nhóm này thì một thao tác nhầm là khoá cứng cả
  // hệ thống, không còn ai vào sửa lại.
  assert.throws(
    () => admin.setGroupPermission('platform_admin', 'admin.users', false, rootActor),
    /không điều chỉnh được/,
  );
  assert.ok(rbac.permissionsFor(['platform_admin']).has('*'));
});

test('SA-05 — không xoá được nhóm đang có người dùng', () => {
  admin.createGroup({ code: 'nhom-tam', label: 'Nhóm tạm' }, rootActor);
  admin.setGroupPermission('nhom_tam', 'portal.htx', true, rootActor);
  const user = newUser('nhomtam01', ['nhom_tam']);

  assert.throws(() => admin.deleteGroup('nhom_tam', rootActor), /đang có 1 người dùng/);

  // Gỡ người dùng khỏi nhóm rồi mới xoá được.
  admin.setUserRoles(user.id, ['farmer'], rootActor);
  admin.deleteGroup('nhom_tam', rootActor);
  assert.equal(admin.listGroups().some((g) => g.code === 'nhom_tam'), false);
  // Xoá nhóm phải dọn luôn ghi đè quyền, không để lại rác.
  assert.equal(all("SELECT permission FROM group_permissions WHERE group_code = 'nhom_tam'").length, 0);
});

test('Quyền không có trong danh mục thì từ chối', () => {
  assert.throws(
    () => admin.setGroupPermission('farmer', 'quyen.khong.ton.tai', true, rootActor),
    /không tồn tại trong danh mục/,
  );
});

// ===========================================================================
// Tài khoản
// ===========================================================================

test('Gán lại nhóm cho tài khoản thay đổi quyền ngay', () => {
  const user = newUser('doinhom01', ['farmer']);
  assert.ok(!rbac.permissionsFor(users.getUser(user.id)!.roles).has('portal.cgh'));

  admin.setUserRoles(user.id, ['farmer', 'dcrd_viewer'], rootActor);
  const after = users.getUser(user.id)!;
  assert.deepEqual(after.roles.sort(), ['dcrd_viewer', 'farmer']);
  assert.ok(rbac.permissionsFor(after.roles).has('portal.cgh'));
});

test('Tài khoản phải thuộc ít nhất một nhóm', () => {
  const user = newUser('khongnhom01', ['farmer']);
  assert.throws(() => admin.setUserRoles(user.id, [], rootActor), /ít nhất một nhóm/);
  assert.throws(() => admin.setUserRoles(user.id, ['nhom_khong_co'], rootActor), /không tồn tại/);
});

test('SA-01 — không tự khoá và không tự gỡ quyền quản trị của chính mình', () => {
  const second = newUser('admin2', ['platform_admin']);
  const selfActor = { id: second.id, name: 'admin2' };

  assert.throws(() => admin.setStatus(second.id, 'locked', selfActor), /tự khoá tài khoản của chính mình/);
  assert.throws(() => admin.setUserRoles(second.id, ['farmer'], selfActor), /tự gỡ quyền quản trị/);

  // Người khác làm thì được (vì vẫn còn admin gốc).
  admin.setUserRoles(second.id, ['farmer'], rootActor);
  assert.equal(users.getUser(second.id)!.roles.includes('platform_admin'), false);
});

test('SA-02 — luôn phải còn ít nhất một quản trị nền tảng đang hoạt động', () => {
  const admins = admin.listUserViews().filter((u) => u.isPlatformAdmin && u.status === 'active');
  assert.equal(admins.length, 1, 'bối cảnh test: đang còn đúng một admin');

  const other = admin.listUserViews().find((u) => !u.isPlatformAdmin)!;
  const otherActor = { id: other.id, name: other.fullName };

  assert.throws(() => admin.setStatus(rootAdmin.id, 'locked', otherActor), /DUY NHẤT/);
  assert.throws(() => admin.setUserRoles(rootAdmin.id, ['farmer'], otherActor), /DUY NHẤT/);

  // Có admin thứ hai thì thao tác trên admin gốc lại hợp lệ.
  const backup = newUser('admin_du_phong', ['platform_admin']);
  admin.setStatus(rootAdmin.id, 'locked', { id: backup.id, name: 'admin_du_phong' });
  assert.equal(users.getUser(rootAdmin.id)!.status, 'locked');

  admin.setStatus(rootAdmin.id, 'active', { id: backup.id, name: 'admin_du_phong' });
  admin.setUserRoles(backup.id, ['farmer'], rootActor);
});

test('SA-03 — không cấp được quyền mà chính mình không có', () => {
  // Người quản lý tài khoản nhưng KHÔNG có quyền tài chính.
  admin.createGroup({ code: 'quan-tri-han-che', label: 'Quản trị hạn chế' }, rootActor);
  admin.setGroupPermission('quan_tri_han_che', 'admin.users', true, rootActor);
  admin.setGroupPermission('quan_tri_han_che', 'portal.erp', true, rootActor);
  const limited = newUser('quantri_hanche', ['quan_tri_han_che']);
  const limitedActor = { id: limited.id, name: 'quantri_hanche' };

  admin.createGroup({ code: 'nhom-thu-nghiem', label: 'Nhóm thử nghiệm' }, rootActor);

  assert.throws(
    () => admin.setGroupPermission('nhom_thu_nghiem', 'finance.write', true, limitedActor),
    /quyền mà chính bạn không có/,
  );
  // Quyền mình có thì cấp được.
  admin.setGroupPermission('nhom_thu_nghiem', 'portal.erp', true, limitedActor);

  // Và không tự phong mình làm quản trị nền tảng.
  assert.throws(
    () => admin.setUserRoles(limited.id, ['quan_tri_han_che', 'platform_admin'], limitedActor),
    /Chỉ quản trị nền tảng/,
  );
});

test('SA-04 — khoá tài khoản huỷ mọi phiên đang mở ngay lập tức', () => {
  const user = newUser('bikhoa01', ['farmer']);
  users.changePassword(user.id, 'MatKhau123');

  const session = users.login('bikhoa01', 'MatKhau123')!;
  assert.ok(session, 'đăng nhập được trước khi khoá');
  assert.ok(users.userFromToken(session.token), 'phiên hợp lệ');

  const result = admin.setStatus(user.id, 'locked', rootActor);
  assert.equal(result.revokedSessions, 1, 'phải báo số phiên đã huỷ');
  assert.equal(
    users.userFromToken(session.token), null,
    'phiên cũ phải chết ngay, không đợi tới lúc hết hạn 12 giờ',
  );
  // KN US-AUTH: tài khoản bị khoá phải nhận thông điệp rõ (mã 'locked'), không phải lỗi "sai mật khẩu" chung.
  assert.throws(() => users.login('bikhoa01', 'MatKhau123'), (error: Error & { code?: string }) => error.code === 'locked' && /bị khoá/.test(error.message), 'không đăng nhập lại được');
});

test('Đặt lại mật khẩu cũng huỷ phiên đang mở', () => {
  const user = newUser('resetpw01', ['farmer']);
  users.changePassword(user.id, 'MatKhau123');
  const session = users.login('resetpw01', 'MatKhau123')!;

  const result = admin.resetUserPassword(user.id, rootActor);
  assert.ok(result.temporaryPassword.length >= 8);
  assert.equal(result.revokedSessions, 1);
  assert.equal(
    users.userFromToken(session.token), null,
    'người đang chiếm tài khoản phải bị đẩy ra, đó chính là lý do đặt lại mật khẩu',
  );
  // Mật khẩu tạm dùng được và buộc đổi.
  const relogin = users.login('resetpw01', result.temporaryPassword)!;
  assert.ok(relogin);
  assert.equal(relogin.user.mustChangePassword, true);
});

test('Buộc đăng xuất mọi thiết bị mà không đổi mật khẩu', () => {
  const user = newUser('dangxuat01', ['farmer']);
  users.changePassword(user.id, 'MatKhau123');
  const a = users.login('dangxuat01', 'MatKhau123')!;
  const b = users.login('dangxuat01', 'MatKhau123')!;

  assert.equal(admin.revokeSessions(user.id, rootActor), 2);
  assert.equal(users.userFromToken(a.token), null);
  assert.equal(users.userFromToken(b.token), null);
  // Mật khẩu cũ vẫn dùng được — chỉ đăng xuất, không đặt lại.
  assert.ok(users.login('dangxuat01', 'MatKhau123'));
});

test('Cập nhật hồ sơ không đụng tới vai trò hay mật khẩu', () => {
  const user = newUser('hoso01', ['farmer']);
  users.changePassword(user.id, 'MatKhau123');

  const updated = admin.updateProfile(
    user.id, { fullName: 'Trần Thị Hồ Sơ', email: 'hoso@example.com', phone: '0900000001' }, rootActor,
  );
  assert.equal(updated.fullName, 'Trần Thị Hồ Sơ');
  assert.deepEqual(updated.roles, ['farmer'], 'vai trò giữ nguyên');
  assert.ok(users.login('hoso01', 'MatKhau123'), 'mật khẩu giữ nguyên');

  assert.throws(() => admin.updateProfile(user.id, { fullName: '  ' }, rootActor), /không được để trống/);
});

test('Chi tiết tài khoản chỉ rõ quyền đến từ nhóm nào', () => {
  const user = newUser('truyvet01', ['farmer', 'dcrd_viewer']);
  const detail = admin.userDetail(user.id) as Record<string, unknown>;
  const byGroup = detail.byGroup as { code: string; permissions: string[] }[];

  assert.equal(byGroup.length, 2);
  const dcrd = byGroup.find((g) => g.code === 'dcrd_viewer')!;
  assert.ok(dcrd.permissions.includes('portal.cgh'), 'trả lời được câu "vì sao người này vào được Cổng CGH"');
  assert.equal(detail.hasAllPermissions, false);
});

test('Bảng điều hành quản trị đếm đúng', () => {
  const dashboard = admin.adminDashboard() as Record<string, number>;
  const views = admin.listUserViews();

  assert.equal(dashboard.totalUsers, views.length);
  assert.equal(dashboard.activeUsers, views.filter((u) => u.status === 'active').length);
  assert.equal(dashboard.lockedUsers, views.filter((u) => u.status !== 'active').length);
  assert.equal(dashboard.totalUsers, dashboard.activeUsers + dashboard.lockedUsers);
  assert.ok(dashboard.platformAdmins >= 1, 'luôn phải còn ít nhất một quản trị');
});

test('Mọi thay đổi phân quyền đều để lại nhật ký truy vết', () => {
  const before = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM event_log WHERE entity_type = 'group_permissions'",
  )!.n;
  admin.setGroupPermission('farmer', 'rental.write', false, rootActor);
  const after = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM event_log WHERE entity_type = 'group_permissions'",
  )!.n;
  assert.ok(after > before, 'thay đổi quyền phải ghi nhật ký — nếu không thì không truy được ai đã sửa gì');

  const latest = one<{ actor_name: string; entity_id: string }>(
    "SELECT actor_name, entity_id FROM event_log WHERE entity_type = 'group_permissions' ORDER BY id DESC LIMIT 1",
  )!;
  assert.equal(latest.entity_id, 'farmer:rental.write');
  assert.equal(latest.actor_name, rootAdmin.fullName);
  admin.setGroupPermission('farmer', 'rental.write', null, rootActor);
});
