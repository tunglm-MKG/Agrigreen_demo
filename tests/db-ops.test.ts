/**
 * Ba việc từ rà soát CSDL 24/09/2026:
 *   - chỉ mục cho cột lọc nóng được tạo khi migrate (kể cả CSDL cũ),
 *   - sao lưu bằng VACUUM INTO có manifest, kiểm tra và khôi phục được,
 *   - băm mật khẩu scrypt với nâng cấp trong suốt từ hash SHA-256 cũ,
 *   - tham chiếu xuyên miền được chặn khi ghi và rà được bản ghi mồ côi.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { all, configureDatabase, db, insert, one, run } from '../src/platform/db/db.ts';

const base = mkdtempSync(join(tmpdir(), 'mekong-dbops-'));
configureDatabase(join(base, 'test.db'));
const { migrate, PERFORMANCE_INDEXES } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const { schemaOf, domainOf, CROSS_DOMAIN_REFS } = await import('../src/platform/db/domains.ts');
const backup = await import('../src/platform/db/backup.ts');
const integrity = await import('../src/platform/db/integrity.ts');
const users = await import('../src/platform/auth/users.ts');
const { legacySha256Hash } = await import('../src/platform/util/ids.ts');

migrate();
seedAll();

test('Chỉ mục hiệu năng: mọi chỉ mục khai báo đều tồn tại đúng tệp miền và phủ các cột lọc nóng', () => {
  const handle = db();
  let found = 0;
  for (const index of PERFORMANCE_INDEXES) {
    const schema = schemaOf(domainOf(index.table));
    const row = handle.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'index' AND name = ?`).get(index.name);
    assert.ok(row, `thiếu chỉ mục ${index.name} trong ${schema}`);
    found += 1;
  }
  assert.ok(found >= 40, `phải có ≥ 40 chỉ mục, đang ${found}`);
  for (const must of ['idx_plots_htx', 'idx_farm_logs_cycle', 'idx_support_tasks_htx', 'idx_notifications_recipient', 'idx_stock_lots_facility']) {
    assert.ok(PERFORMANCE_INDEXES.some((i) => i.name === must), must);
  }
  // Truy vấn theo htx_id trên thửa dùng chỉ mục thay vì quét bảng.
  const plan = handle.prepare('EXPLAIN QUERY PLAN SELECT * FROM plots WHERE htx_id = ? AND deleted_at IS NULL').all('x') as { detail: string }[];
  assert.ok(plan.some((p) => /USING INDEX idx_plots_htx/.test(p.detail)), JSON.stringify(plan));
});

test('Sao lưu: VACUUM INTO từng miền, manifest có băm + integrity, kiểm lại hợp lệ, khôi phục sang bộ tệp khác đọc được', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mekong-bk-'));
  const first = backup.backupAll({ dir, keep: 2 });
  assert.equal(first.manifest.ok, true);
  assert.equal(first.manifest.files.length, 7, 'bảy miền');
  assert.ok(first.manifest.files.every((f) => f.integrity === 'ok' && f.sha256.length === 64 && f.tables > 0));
  assert.ok(existsSync(join(first.dir, 'manifest.json')));
  assert.equal(backup.verifyBackup(first.dir).ok, true);

  // Luân chuyển: giữ 2 đợt gần nhất.
  backup.backupAll({ dir, keep: 2 });
  const third = backup.backupAll({ dir, keep: 2 });
  assert.ok(third.pruned.length >= 1, 'đợt cũ nhất bị xoá');
  assert.equal(backup.listBackups(dir).length, 2);

  // Bản sao bị sửa → kiểm phát hiện.
  const tampered = join(third.dir, third.manifest.files[0].file);
  const original = readFileSync(tampered);
  const copy = new DatabaseSync(tampered);
  copy.exec('CREATE TABLE tamper_marker (id INTEGER)');
  copy.close();
  const check = backup.verifyBackup(third.dir);
  assert.equal(check.ok, false);
  assert.match(check.problems.join(' '), /Băm không khớp/);
  writeFileSync(tampered, original);
  assert.equal(backup.verifyBackup(third.dir).ok, true);

  // Khôi phục sang bộ tệp khác và đọc được dữ liệu.
  const target = mkdtempSync(join(tmpdir(), 'mekong-restore-'));
  const { restored } = backup.restoreBackup(third.dir, join(target, 'mekonggreen.db'));
  assert.equal(restored.length, 7);
  const shared = new DatabaseSync(join(target, 'mekonggreen.shared.db'), { readOnly: true });
  const n = (shared.prepare('SELECT COUNT(*) AS n FROM cooperatives').get() as { n: number }).n;
  shared.close();
  assert.equal(n, one<{ n: number }>('SELECT COUNT(*) AS n FROM cooperatives')!.n, 'bản khôi phục có đủ HTX');
});

test('Mật khẩu: hash mới là scrypt; hash SHA-256 cũ vẫn đăng nhập được và được nâng cấp ngay lần đó', () => {
  const admin = users.listUsers().find((u) => u.username === 'SAdmin')!;
  const created = users.createUser({ username: 'scrypt_user', fullName: 'Scrypt', roles: ['farmer'], password: 'MatKhau123' }, { id: admin.id, name: admin.fullName });
  const row = one<{ password_hash: string; password_salt: string }>('SELECT password_hash, password_salt FROM users WHERE id = ?', [created.user.id])!;
  assert.match(row.password_hash, /^scrypt\$[0-9a-f]{64}$/);
  assert.equal(users.verifySecret('MatKhau123', row.password_salt, row.password_hash), true);
  assert.equal(users.verifySecret('sai', row.password_salt, row.password_hash), false);

  // Giả lập tài khoản cũ còn hash sha256.
  const legacySalt = 'abcdef012345';
  run('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', [legacySha256Hash('MatKhau123', legacySalt), legacySalt, created.user.id]);
  assert.ok(users.login('scrypt_user', 'MatKhau123')?.token, 'hash cũ vẫn xác thực được');
  const after = one<{ password_hash: string; password_salt: string }>('SELECT password_hash, password_salt FROM users WHERE id = ?', [created.user.id])!;
  assert.match(after.password_hash, /^scrypt\$/, 'đã nâng cấp sang scrypt');
  assert.notEqual(after.password_salt, legacySalt, 'salt mới');
  assert.ok(users.login('scrypt_user', 'MatKhau123')?.token, 'đăng nhập lại bằng hash mới');
  assert.equal(users.login('scrypt_user', 'sai'), null);
});

test('Tham chiếu xuyên miền: ghi bản ghi trỏ tới cha không tồn tại bị chặn; rà mồ côi phát hiện dữ liệu chèn lách', () => {
  assert.ok(CROSS_DOMAIN_REFS.length >= 80, `đang ${CROSS_DOMAIN_REFS.length}`);
  assert.equal(integrity.findOrphans().reduce((a, r) => a + r.orphans, 0), 0, 'dữ liệu seed sạch');
  const season = one<{ id: string }>('SELECT id FROM seasons LIMIT 1')!;
  assert.throws(
    () => insert('crop_cycles', { id: 'cc-mo-coi', code: 'VU-MOCOI', plot_id: 'khong-ton-tai', season_id: season.id, area_ha: 1, status: 'dang_canh_tac', created_at: new Date().toISOString() }),
    /Tham chiếu không tồn tại: crop_cycles\.plot_id/,
  );
  assert.ok(!one('SELECT id FROM crop_cycles WHERE id = ?', ['cc-mo-coi']), 'không ghi gì khi tham chiếu sai');
  // Chèn lách qua SQL thô → vòng rà phải thấy.
  run('INSERT INTO crop_cycles (id, code, plot_id, season_id, area_ha, status, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)', ['cc-lach', 'VU-LACH', 'khong-ton-tai', season.id, 'dang_canh_tac', new Date().toISOString()]);
  const report = integrity.findOrphans().find((r) => r.table === 'crop_cycles' && r.column === 'plot_id')!;
  assert.equal(report.orphans, 1);
  assert.deepEqual(report.sample, ['cc-lach']);
  const scan = integrity.dailyIntegrityScan({ name: 'test' });
  assert.equal(scan.ran, true);
  assert.ok(scan.orphans >= 1);
  assert.ok(all("SELECT id FROM event_log WHERE entity_type = 'db_integrity'").length >= 1, 'ghi nhật ký khi có mồ côi');
  assert.equal(integrity.dailyIntegrityScan({ name: 'test' }).ran, false, 'mỗi ngày chỉ rà một lần');
  run("DELETE FROM crop_cycles WHERE id = 'cc-lach'");
  assert.equal(integrity.findOrphans().reduce((a, r) => a + r.orphans, 0), 0);
});
