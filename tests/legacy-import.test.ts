/**
 * Review kiến trúc 24/09/2026 — A06: nâng cấp từ tệp SQLite hợp nhất cũ (`data/mekonggreen.db`).
 * Dùng chính tệp legacy 99 bảng trong archive/ làm dữ liệu đầu vào.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDatabase, one } from '../src/platform/db/db.ts';

const LEGACY = join(process.cwd(), 'archive', 'mekonggreen.legacy-single-file.db');
const dir = mkdtempSync(join(tmpdir(), 'mekong-legacy-'));
const base = join(dir, 'mekonggreen.db');
const hasLegacy = existsSync(LEGACY);
if (hasLegacy) copyFileSync(LEGACY, base);
configureDatabase(base);
const { migrate } = await import('../src/platform/db/schema.ts');
const { importLegacyDatabase } = await import('../src/platform/db/legacy.ts');
const { seedIfEmpty } = await import('../src/seed.ts');

test('Tệp hợp nhất cũ được nhập vào bộ tệp mới trước khi seed; không seed đè; tệp cũ được đổi tên; lần sau không nhập lại', { skip: !hasLegacy && 'không có archive/mekonggreen.legacy-single-file.db' }, () => {
  migrate();
  const report = importLegacyDatabase();
  assert.ok(report, 'phải phát hiện và nhập tệp cũ');
  const byTable = Object.fromEntries(report!.tables.map((t) => [t.table, t]));
  assert.equal(byTable.cooperatives.imported, 26, 'đủ 26 HTX');
  assert.equal(byTable.users.imported, 14, 'đủ 14 tài khoản');
  assert.ok(report!.tables.length >= 40, `nhập ${report!.tables.length} bảng`);
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM cooperatives')!.n, 26);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE entity_type = 'legacy_import'")!.n, 1, 'ghi nhật ký đợt nhập');
  assert.ok(!existsSync(base), 'tệp cũ không còn ở đường dẫn gốc');
  const files = readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('mekonggreen.db.imported-')), 'tệp cũ đổi tên .imported-*');
  assert.ok(files.some((f) => f.startsWith('mekonggreen.db.truoc-nhap-')), 'có bản sao trước khi nhập');
  // Dữ liệu đã có → seedIfEmpty không nạp demo đè lên.
  assert.equal(seedIfEmpty(), false);
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM cooperatives')!.n, 26);
  // Idempotent.
  assert.equal(importLegacyDatabase(), null);
  // Ràng buộc mới vẫn có hiệu lực trên dữ liệu nhập.
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM main.sqlite_master WHERE type = 'table' AND name = 'users' AND sql LIKE '%CHECK (must_change_pw IN (0, 1))%'")!.n, 1);
});
