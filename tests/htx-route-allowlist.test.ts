/**
 * Đánh giá bảo mật 24/09/2026 — M-06: phạm vi dữ liệu HTX theo cơ chế FAIL-CLOSED.
 * Duyệt toàn bộ router: route nào RBAC cho tài khoản HTX/nông dân gọi được thì phải có trong HTX_ROUTE_ALLOWLIST
 * (đã rà soát phạm vi); dòng nào trong allowlist không còn route thì là rác. Quên khai báo = test đỏ, không phải lọt dữ liệu.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDatabase } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-allowlist-')), 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { buildApi } = await import('../src/api.ts');
const { can } = await import('../src/platform/auth/rbac.ts');
const { HTX_ROUTE_ALLOWLIST } = await import('../src/platform/auth/htxRoutes.ts');
migrate();

test('Mọi route mà vai trò HTX/nông dân gọi được đều đã được khai báo trong HTX_ROUTE_ALLOWLIST; không có dòng rác', () => {
  const routes = buildApi().listRoutes();
  const reachable = routes.filter((r) => !r.permission || can(['htx_manager'], r.permission) || can(['farmer'], r.permission));
  const keys = new Set(reachable.map((r) => `${r.method} ${r.path}`));
  const missing = [...keys].filter((k) => !HTX_ROUTE_ALLOWLIST.has(k));
  assert.deepEqual(missing, [], `Route mới chưa rà soát phạm vi HTX (thêm vào src/platform/auth/htxRoutes.ts sau khi kiểm):\n  ${missing.join('\n  ')}`);
  const allKeys = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const stale = [...HTX_ROUTE_ALLOWLIST].filter((k) => !allKeys.has(k));
  assert.deepEqual(stale, [], `Dòng allowlist không còn route tương ứng:\n  ${stale.join('\n  ')}`);
  assert.ok(keys.size > 100, `router có ${keys.size} route cho HTX`);
});
