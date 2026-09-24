/**
 * Kiểm thử TÁCH CƠ SỞ DỮ LIỆU THEO HỆ THỐNG CON và LUỒNG DỮ LIỆU DÙNG CHUNG.
 *
 * Điều đáng bảo vệ: mỗi bảng nằm đúng tệp của miền mình; không bảng nào "lơ lửng"
 * ngoài miền; FK xuyên miền được gỡ đúng chỗ mà FK cùng miền vẫn được cưỡng chế;
 * bảng dùng chung nào cũng có luồng (chủ + người nhận); feed và con trỏ hoạt động.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, databaseFiles, domainFile, one, run } from '../src/platform/db/db.ts';
import { DOMAINS, TABLE_DOMAIN, domainOf, qualifyStatement, splitStatements, tablesOf } from '../src/platform/db/domains.ts';

const dir = mkdtempSync(join(tmpdir(), 'mekong-dom-'));
configureDatabase(join(dir, 'test.db'));
const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const flows = await import('../src/platform/sync/sharedFlows.ts');
const { readFileSync } = await import('node:fs');

migrate();
seedAll();

test('Mọi bảng trong lược đồ đều được xếp miền, và mọi miền khai báo đều có bảng thật', () => {
  const schema = readFileSync(join(process.cwd(), 'src', 'platform', 'db', 'schema.ts'), 'utf8');
  const declared = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.ok(declared.length >= 98);
  for (const table of declared) assert.ok(TABLE_DOMAIN[table], `bảng ${table} chưa xếp miền`);
  for (const table of Object.keys(TABLE_DOMAIN)) assert.ok(declared.includes(table), `miền khai bảng ${table} nhưng lược đồ không có`);
  assert.throws(() => domainOf('bang_khong_ton_tai'), /chưa được xếp vào miền/);
});

test('Mỗi miền một tệp riêng trên đĩa; bảng nằm đúng tệp của miền mình', () => {
  const files = databaseFiles() as { domain: string; path: string; tables: string[]; tableCount: number; declared: number }[];
  assert.equal(files.length, DOMAINS.length);
  for (const f of files) {
    assert.ok(existsSync(f.path), `${f.path} không tồn tại`);
    assert.equal(f.path, domainFile(f.domain as never));
    const expected = tablesOf(f.domain as never);
    assert.deepEqual(f.tables, expected, `tệp ${f.domain} không chứa đúng bảng của miền`);
  }
  assert.ok(existsSync(join(dir, 'test.shared.db')) && existsSync(join(dir, 'test.erp.db')) && existsSync(join(dir, 'test.kn.db')));
  assert.ok(!existsSync(join(dir, 'test.db')), 'không còn tệp hợp nhất');
});

test('Mã nghiệp vụ vẫn JOIN xuyên miền không cần tiền tố; giao dịch ghi hai tệp vẫn nguyên tử', () => {
  const rows = all<{ code: string; name: string }>(
    `SELECT j.code, h.name FROM field_jobs j JOIN cooperatives h ON h.id = j.htx_id LIMIT 3`);
  assert.ok(rows.length >= 1, 'field (tệp field) join cooperatives (tệp shared)');
  const before = one<{ n: number }>('SELECT COUNT(*) AS n FROM field_teams')!.n;
  assert.throws(() => {
    run('BEGIN');
    run(`INSERT INTO field_teams (id, code, name, status, created_at, updated_at) VALUES ('tx1', 'TX-1', 'x', 'hoat_dong', 'now', 'now')`);
    run(`INSERT INTO cooperatives (id) VALUES (NULL)`); // vi phạm NOT NULL → rollback cả hai tệp
  });
  run('ROLLBACK');
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM field_teams')!.n, before);
});

test('FOREIGN KEY xuyên miền bị gỡ lúc migrate; FK cùng miền vẫn được cưỡng chế', () => {
  // crop_cycles (htx) → plots (shared): gỡ. plan_step_evidence (htx) → production_plan_steps (htx): giữ.
  const cycles = one<{ sql: string }>(`SELECT sql FROM htx.sqlite_master WHERE name = 'crop_cycles'`)!.sql;
  assert.ok(!/REFERENCES plots/.test(cycles), 'FK htx→shared phải bị gỡ');
  const evidence = one<{ sql: string }>(`SELECT sql FROM htx.sqlite_master WHERE name = 'plan_step_evidence'`)!.sql;
  assert.ok(/REFERENCES production_plan_steps/.test(evidence), 'FK cùng miền giữ nguyên');
  assert.throws(() => run(`INSERT INTO plan_step_evidence (id, plan_step_id, kind, created_at) VALUES ('e1', 'khong-co', 'ghi_chu', 'now')`), /FOREIGN KEY/);
  // Bộ viết lại không làm hỏng câu: dấu phẩy treo được dọn.
  const out = qualifyStatement(`CREATE TABLE IF NOT EXISTS crop_cycles (
  id TEXT PRIMARY KEY,
  plot_id TEXT NOT NULL,
  FOREIGN KEY (plot_id) REFERENCES plots(id)
)`);
  assert.match(out, /CREATE TABLE IF NOT EXISTS htx\.crop_cycles/);
  assert.ok(!/FOREIGN KEY/.test(out));
  assert.ok(!/,\s*\)/.test(out), `dấu phẩy treo: ${out}`);
  assert.equal(qualifyStatement('CREATE INDEX IF NOT EXISTS idx_x ON trips(status)'), 'CREATE INDEX IF NOT EXISTS erp.idx_x ON trips(status)');
  assert.ok(splitStatements('-- chú thích\nCREATE TABLE IF NOT EXISTS a (x);\n\nCREATE TABLE IF NOT EXISTS b (y);\n').length === 2);
});

test('Mọi bảng dùng chung đều có luồng (chủ + người nhận) hoặc là nội bộ nền tảng', () => {
  assert.deepEqual(flows.uncoveredSharedTables(), []);
  for (const f of flows.SHARED_FLOWS) {
    assert.equal(domainOf(f.entity), 'shared', `${f.entity} không phải bảng dùng chung`);
    assert.ok(f.receivers.length, `${f.entity} không có người nhận`);
    assert.ok(f.why.length > 10);
  }
  // Không hệ thống con nào là chủ của thứ nằm trong tệp hệ thống khác.
  assert.equal(flows.canWriteShared('kn', 'cooperatives'), true);
  assert.equal(flows.canWriteShared('erp', 'cooperatives'), false, 'ERP chỉ đọc hồ sơ HTX');
  assert.equal(flows.canWriteShared('field', 'field_jobs'), true);
  assert.equal(flows.canWriteShared('field', 'ledger_entries'), false, 'hiện trường không ghi sổ cái ERP');
});

test('Feed theo hệ thống chỉ chứa thực thể hệ thống đó nhận; ack đẩy con trỏ; chạy lại không nhận trùng', async () => {
  const kn = flows.feedFor('kn', 0, 5000);
  assert.ok(kn.events.length > 0);
  const knEntities = new Set(flows.flowsFor('kn').map((f) => f.entity));
  for (const e of kn.events) assert.ok(knEntities.has(e.entity), `KN nhận ${e.entity} ngoài luồng`);
  // Seed nạp cơ sở hàng loạt không qua nhật ký; một thay đổi nghiệp vụ trên cơ sở (ERP đổi
  // trạng thái Hub) mới sinh sự kiện — và sự kiện đó phải tới hiện trường, không tới KN.
  const { logEvent } = await import('../src/platform/audit/audit.ts');
  logEvent({ module: 'erp', entityType: 'facilities', entityId: 'hub-x', action: 'update', after: { status: 'active' } }, { name: 'test' });
  const field = flows.feedFor('field', 0, 5000);
  assert.ok(field.events.some((e) => e.entity === 'facilities'), 'hiện trường nhận cơ sở (điểm ghe cập)');
  assert.ok(!flows.feedFor('kn', 0, 5000).events.some((e) => e.entity === 'facilities'), 'KN không nhận cơ sở ERP');
  assert.ok(!field.events.some((e) => e.entity === 'farmers'), 'hiện trường không nhận dữ liệu hộ');

  assert.equal(flows.cursorOf('kn'), 0);
  flows.ack('kn', kn.cursor);
  assert.equal(flows.cursorOf('kn'), kn.cursor);
  assert.equal(flows.feedFor('kn', flows.cursorOf('kn')).events.length, 0, 'đã ack thì không còn gì chờ');
  flows.ack('kn', 1);
  assert.equal(flows.cursorOf('kn'), kn.cursor, 'ack lùi không kéo con trỏ lùi');
  const ov = flows.overview(['kn', 'erp']) as { receivers: { system: string; pending: number }[] };
  assert.equal(ov.receivers.find((r) => r.system === 'kn')!.pending, 0);
  assert.ok(ov.receivers.find((r) => r.system === 'erp')!.pending > 0);
});
