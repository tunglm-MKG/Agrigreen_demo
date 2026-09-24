/**
 * Cơ cấu phân quyền 09/2026:
 *   - mỗi hệ thống con có nhóm quản trị riêng (*_admin): toàn quyền nghiệp vụ và quản lý tài khoản TRONG hệ thống,
 *     không vào cổng khác, không sửa ma trận nhóm–quyền, không thấy/không đụng tài khoản hệ thống khác;
 *   - quản trị nền tảng (SAdmin) làm việc ở cổng Quản trị hệ thống riêng; muốn xem nghiệp vụ của hệ thống nào
 *     phải "vào" hệ thống đó (mỗi phiên một hệ thống, có nhật ký).
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-sysadmin-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const { buildApi } = await import('../src/api.ts');
const { HttpError, sendJson } = await import('../src/platform/http/router.ts');
const rbac = await import('../src/platform/auth/rbac.ts');
const scopes = await import('../src/platform/auth/scopes.ts');
const users = await import('../src/platform/auth/users.ts');
const { systemOfRoute } = await import('../src/platform/auth/systemContext.ts');

migrate();
seedAll();

const api = buildApi();
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const apiUrl = new URL(url.toString()); apiUrl.pathname = url.pathname.slice(4);
    if (!(await api.handle(req, res, apiUrl))) sendJson(res, 404, { error: 'no route' });
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.status : 400, { error: (error as Error).message, details: error instanceof HttpError ? error.details ?? null : null });
  }
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(() => server.close());
const call = (token: string | null, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (res: Response) => res.json() as Promise<Record<string, any>>;
const login = async (u: string, p: string) => ((await json(await call(null, 'POST', '/auth/login', { username: u, password: p }))) as { token: string }).token;
const byName = (u: string) => users.listUsers().find((x) => x.username === u)!;

test('Mỗi hệ thống con có nhóm quản trị riêng: chỉ vào cổng của mình, có admin.users/admin.delegate, không có admin.config/groups/portal.sysadmin', () => {
  for (const system of rbac.SYSTEMS) {
    const perms = rbac.permissionsFor([system.adminRole]);
    assert.ok(!perms.has('*'));
    const portals = [...perms].filter((p) => p.startsWith('portal.'));
    assert.deepEqual(portals, [system.portal], `${system.adminRole} chỉ vào cổng ${system.portal}`);
    assert.ok(perms.has('admin.users') && perms.has('admin.delegate'), `${system.adminRole} quản lý tài khoản trong hệ thống`);
    for (const forbidden of ['admin.config', 'admin.groups', 'portal.sysadmin']) assert.ok(!perms.has(forbidden), `${system.adminRole} không có ${forbidden}`);
    // Toàn quyền TRONG miền nghiệp vụ của hệ thống; KHÔNG có quyền đọc/ghi miền của hệ thống khác (cách ly tuyệt đối).
    const own = new Set(rbac.systemAdminPermissions(system.code));
    for (const other of rbac.SYSTEMS.filter((o) => o.code !== system.code)) {
      for (const p of rbac.systemAdminPermissions(other.code)) {
        if (p.startsWith('portal.') || p.startsWith('admin.') || ['mdm.read', 'mdm.write', 'gis.read', 'reporting.read'].includes(p)) continue;
        if (other.code === 'gis' && p.startsWith('gis.')) continue;
        assert.ok(!own.has(p), `${system.adminRole} không được có ${p} của ${other.code}`);
      }
    }
    assert.equal(rbac.ROLE_SYSTEM[system.adminRole], system.code);
  }
});

test('Quản trị KN chỉ thấy và quản lý tài khoản Khuyến nông; không gán được nhóm ERP; không vào được API ERP/HTX', async () => {
  const knAdmin = byName('qtri_kn');
  const ctx = scopes.tryAdminContext(knAdmin)!;
  assert.ok(ctx && !ctx.superAdmin && ctx.systems.has('kn') && ctx.systems.size === 1, 'phạm vi ngầm cấp hệ thống KN từ nhóm kn_admin');
  const visible = scopes.visibleUserIds(ctx)!;
  assert.ok(visible.has(byName('canbo_tw').id) && visible.has(byName('canbo_xa').id));
  assert.ok(!visible.has(byName('supplychain').id) && !visible.has(byName('htx01').id) && !visible.has(byName('SAdmin').id));
  assert.ok(scopes.assignableRoles(ctx).includes(rbac.ROLES.KN_ADMIN), 'admin cấp hệ thống gán được nhóm quản trị hệ thống mình');
  assert.throws(() => scopes.assertRolesAllowed(ctx, [rbac.ROLES.FINANCE]), /SA-09/);
  assert.throws(() => scopes.assertRolesAllowed(ctx, [rbac.ROLES.HTX_ADMIN]), /SA-09/);

  const token = await login('qtri_kn', '123456');
  const list = (await json(await call(token, 'GET', '/admin/users'))) as { username: string }[];
  assert.ok(list.some((u) => u.username === 'canbo_tw') && !list.some((u) => u.username === 'supplychain'));
  const lach = await call(token, 'POST', '/admin/users', { username: 'lach_erp', fullName: 'Lách', roles: ['finance'] });
  assert.ok([400, 403].includes(lach.status) && /SA-09/.test((await json(lach)).error), 'không tạo được tài khoản ERP');
  const created = await call(token, 'POST', '/admin/users', { username: 'cb_kn_moi', fullName: 'Cán bộ KN mới', roles: ['kn_tinh'], provinceId: byName('canbo_xa').provinceId });
  assert.equal(created.status, 200, 'tạo được tài khoản trong hệ thống mình');
  const editErp = await call(token, 'PUT', `/admin/users/${byName('supplychain').id}`, { fullName: 'x' });
  assert.ok([400, 403].includes(editErp.status) && /SA-08/.test((await json(editErp)).error), 'không sửa được người ERP');
  assert.equal((await call(token, 'GET', '/finance/entries')).status, 403, 'không đọc được tài chính ERP');
  assert.equal((await call(token, 'GET', '/htx/farmers')).status, 403, 'không đọc được dữ liệu HTX');
  assert.equal((await call(token, 'GET', '/admin/groups')).status, 200, 'xem được nhóm để gán');
  assert.equal((await call(token, 'POST', '/admin/groups', { code: 'x', label: 'x' })).status, 403, 'không sửa được ma trận nhóm–quyền');
  assert.equal((await call(token, 'GET', '/notifications/channels')).status, 403, 'không đụng cấu hình nền tảng');
});

test('Phạm vi từ nhóm quản trị không gỡ được như phạm vi uỷ quyền; admin ERP theo nhóm thấy đủ người ERP', () => {
  const erpCtx = scopes.tryAdminContext(byName('qtri_erp'))!;
  assert.ok(erpCtx.scopes.some((s) => s.id === 'role:erp_admin' && s.scopeType === 'system'));
  assert.throws(() => scopes.revokeScope('role:erp_admin', scopes.tryAdminContext(byName('SAdmin'))!), /gỡ nhóm/);
  const visible = scopes.visibleUserIds(erpCtx)!;
  for (const u of ['supplychain', 'taichinh', 'khonhap', 'vvb']) assert.ok(visible.has(byName(u).id), u);
  assert.ok(!visible.has(byName('qtri_kn').id));
});

test('SAdmin: cổng Quản trị riêng; API nghiệp vụ bị chặn tới khi "vào" đúng hệ thống; route quản trị luôn mở; vào/rời có nhật ký', async () => {
  const token = await login('SAdmin', process.env.SUPER_ADMIN_PASSWORD!);
  const htxQuery = `/htx/farmers?htxId=${byName('htx01').htxId}`;
  const me = await json(await call(token, 'GET', '/auth/me'));
  assert.equal(me.superAdmin, true);
  assert.equal(me.activeSystem, null);
  assert.ok((me.permissions as string[]).includes('*'));
  // Chưa vào hệ thống nào → nghiệp vụ bị chặn với mã enter_system_required.
  const blocked = await call(token, 'GET', htxQuery);
  assert.equal(blocked.status, 403);
  assert.equal((await json(blocked)).details?.code, 'enter_system_required');
  assert.equal((await call(token, 'GET', '/cgh/thresholds')).status, 403);
  assert.equal((await call(token, 'GET', '/admin/users')).status, 200, 'quản trị luôn mở');
  assert.equal((await call(token, 'GET', '/admin/db-health')).status, 200);
  // Vào HTX → HTX mở, CGH vẫn đóng, dữ liệu dùng chung mở.
  const entered = await call(token, 'POST', '/auth/enter-system', { system: 'htx' });
  assert.equal(entered.status, 200, await entered.text());
  assert.equal((await json(await call(token, 'GET', '/auth/me'))).activeSystem, 'htx');
  assert.equal((await call(token, 'GET', htxQuery)).status, 200);
  assert.equal((await call(token, 'GET', '/cgh/thresholds')).status, 403);
  assert.equal((await call(token, 'GET', '/mdm/cooperatives')).status, 200, 'dữ liệu dùng chung dùng được khi đã ở trong một hệ thống');
  // Chuyển sang CGH → thay thế, không cộng dồn.
  await call(token, 'POST', '/auth/enter-system', { system: 'cgh' });
  assert.equal((await call(token, 'GET', '/cgh/thresholds')).status, 200);
  assert.equal((await call(token, 'GET', htxQuery)).status, 403);
  // Rời → đóng hết nghiệp vụ.
  await call(token, 'POST', '/auth/leave-system', {});
  assert.equal((await call(token, 'GET', '/cgh/thresholds')).status, 403);
  assert.equal((await call(token, 'POST', '/auth/enter-system', { system: 'khong_co' })).status, 400);
  assert.ok(all("SELECT id FROM event_log WHERE entity_type = 'admin_session' AND note = 'enter_system'").length >= 2, 'vào hệ thống được ghi nhật ký');
  // Tài khoản thường không dùng được enter-system và không bị guard SAdmin đụng tới.
  const htxToken = await login('htx01', '123456');
  assert.equal((await call(htxToken, 'POST', '/auth/enter-system', { system: 'erp' })).status, 403);
  assert.equal((await call(htxToken, 'GET', '/htx/farmers')).status, 200);
});

test('Phân loại route theo hệ thống: quyền → hệ thống; đường dẫn quản trị luôn là admin', () => {
  assert.equal(systemOfRoute('/htx/farmers', 'htx.read'), 'htx');
  assert.equal(systemOfRoute('/rental/orders', 'rental.read'), 'cgh');
  assert.equal(systemOfRoute('/admin/users', undefined), 'admin');
  assert.equal(systemOfRoute('/audit/events', 'gis.read'), 'admin');
  assert.equal(systemOfRoute('/mdm/cooperatives', 'mdm.read'), 'shared');
  assert.equal(systemOfRoute('/field/teams', 'field.manage'), 'field');
  assert.equal(systemOfRoute('/notifications', undefined), 'admin');
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'qtri_%'")!.n, 7, 'seed có admin cho 6 hệ thống + admin KN tỉnh');
});
