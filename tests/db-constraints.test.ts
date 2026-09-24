/**
 * Các mục còn lại của rà soát CSDL 24/09/2026 (ưu tiên 5–8 + mã hoá CCCD + khoá ngoại cùng miền):
 *   - dựng lại bảng cũ theo lược đồ mới (reconcileTables) và không dựng lại khi đã khớp,
 *   - FOREIGN KEY cùng miền, CHECK boolean/enum, NOT NULL có hiệu lực ở tầng SQLite,
 *   - tiền tệ lưu theo đồng (làm tròn khi ghi),
 *   - CCCD mã hoá khi lưu, giải mã ở dịch vụ, che ở API,
 *   - member_count giảm khi nông hộ ngừng,
 *   - bằng chứng công đoạn và ngưỡng CGH chuyển sang bảng chuẩn hoá (kèm di trú dữ liệu cũ).
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { all, configureDatabase, db, insert, one, run, update } from '../src/platform/db/db.ts';

const base = mkdtempSync(join(tmpdir(), 'mekong-constraints-'));
const basePath = join(base, 'mekonggreen.db');

// --- Giả lập CSDL CŨ: tạo trước vài bảng theo định nghĩa cũ (không CHECK/FK, REAL tiền tệ, còn evidence_json, JSON ngưỡng) ---
{
  const shared = new DatabaseSync(join(base, 'mekonggreen.shared.db'));
  shared.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, phone TEXT, email TEXT, htx_id TEXT, org_node_id TEXT, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, must_change_pw INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', lock_reason TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT, last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  shared.exec(`CREATE TABLE system_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`);
  shared.exec(`INSERT INTO system_config VALUES ('cgh.coverage_thresholds', '[{"du":85,"canChuY":60,"thua":120,"effectiveFrom":"2026-01-01","documentRef":"QĐ cũ"},{"du":90,"canChuY":70,"thua":130,"effectiveFrom":"2026-06-01"}]', '2026-01-01T00:00:00Z', 'test')`);
  shared.close();
  const field = new DatabaseSync(join(base, 'mekonggreen.field.db'));
  field.exec(`CREATE TABLE field_job_stages (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage TEXT NOT NULL, sort_order INTEGER NOT NULL, planned_start TEXT, planned_end TEXT, started_at TEXT, completed_at TEXT, quantity_tons REAL, bales INTEGER, vehicle_id TEXT, recorded_by TEXT, lat REAL, lng REAL, note TEXT, evidence_json TEXT, status TEXT NOT NULL DEFAULT 'cho_thuc_hien', UNIQUE (job_id, stage))`);
  field.exec(`INSERT INTO field_job_stages (id, job_id, stage, sort_order, completed_at, recorded_by, evidence_json, status) VALUES ('st-old', 'job-old', 'cuon_rom', 1, '2026-09-01T09:00:00Z', 'Tổ trưởng', '[{"kind":"photo","note":"Ảnh kiện rơm"},{"kind":"video","url":"https://example.org/v"}]', 'hoan_thanh')`);
  field.close();
  const erp = new DatabaseSync(join(base, 'mekonggreen.erp.db'));
  erp.exec(`CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, entry_date TEXT NOT NULL, account TEXT NOT NULL, partner_id TEXT, htx_id TEXT, ref_type TEXT, ref_id TEXT, facility_id TEXT, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'VND', description TEXT, status TEXT NOT NULL DEFAULT 'ghi_so', due_date TEXT, created_at TEXT NOT NULL)`);
  erp.exec(`INSERT INTO ledger_entries (id, entry_date, account, amount, created_at) VALUES ('le-old', '2026-09-01', 'AR', 1234567.6, '2026-09-01T00:00:00Z')`);
  erp.close();
}

configureDatabase(basePath);
const schema = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const crypto = await import('../src/platform/security/fieldCrypto.ts');
const mdm = await import('../src/mdm/service.ts');
const lifecycle = await import('../src/mdm/lifecycle.ts');
const cghOps = await import('../src/agrigreen/cgh/ops.ts');
const cgh = await import('../src/agrigreen/cgh/service.ts');

schema.migrate();
seedAll();

const storedSql = (domain: string, table: string) => (db().prepare(`SELECT sql FROM ${domain}.sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string }).sql;

test('Dựng lại bảng: CSDL cũ được nâng theo lược đồ mới, dữ liệu giữ nguyên, lần migrate sau không dựng lại nữa', () => {
  const users = storedSql('main', 'users');
  assert.match(users, /CHECK \(must_change_pw IN \(0, 1\)\)/, 'CHECK boolean có hiệu lực trên bảng cũ');
  assert.match(users, /FOREIGN KEY \(htx_id\) REFERENCES cooperatives\(id\)/, 'FOREIGN KEY cùng miền được thêm');
  assert.match(users, /zalo_user_id TEXT/, 'cột thêm bằng ALTER vẫn còn sau khi dựng lại');
  const ledger = storedSql('erp', 'ledger_entries');
  assert.match(ledger, /amount\s+INTEGER NOT NULL/, 'tiền tệ về INTEGER');
  assert.equal(one<{ amount: number }>("SELECT amount FROM ledger_entries WHERE id = 'le-old'")!.amount, 1234568, 'số lẻ cũ được làm tròn về đồng');
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n > 0, true, 'dữ liệu users sau seed');
  const again = schema.reconcileTables();
  assert.deepEqual(again, { rebuilt: [], skipped: [] }, 'lược đồ đã khớp → không dựng lại');
});

test('Ràng buộc ở tầng SQLite: FOREIGN KEY cùng miền, CHECK boolean/enum, NOT NULL', () => {
  const htx = one<{ id: string }>('SELECT id FROM cooperatives LIMIT 1')!;
  // FK cùng miền: nông hộ trỏ HTX không tồn tại bị SQLite từ chối.
  assert.throws(() => run("INSERT INTO farmers (id, code, full_name, htx_id, status, created_at) VALUES ('f-x', 'NH-X', 'X', 'htx-khong-co', 'active', '2026-01-01')"), /FOREIGN KEY/i);
  // CHECK boolean
  assert.throws(() => run("UPDATE users SET must_change_pw = 2 WHERE username = 'SAdmin'"), /CHECK/i);
  // CHECK enum
  assert.throws(() => run("UPDATE users SET status = 'bi_khoa' WHERE username = 'SAdmin'"), /CHECK/i);
  assert.throws(() => run("UPDATE cooperatives SET status = 'dung' WHERE id = ?", [htx.id]), /CHECK/i);
  // NOT NULL mới
  const type = one<{ id: string }>('SELECT id FROM machine_types LIMIT 1')!;
  const owner = one<{ id: string }>('SELECT id FROM machine_owners LIMIT 1')!;
  assert.throws(() => run("INSERT INTO machines (id, code, machine_type_id, owner_id, htx_id, created_at) VALUES ('m-x', 'MAY-X', ?, ?, NULL, '2026-01-01')", [type.id, owner.id]), /NOT NULL/i);
  // khoá ngoại thật vẫn cho ghi hợp lệ
  const plan = db().prepare('PRAGMA foreign_key_check').all();
  assert.equal(plan.length, 0, 'dữ liệu seed không vi phạm khoá ngoại nào');
});

test('Tiền tệ: ghi qua insert/update được làm tròn về đồng; khóa ngoại cùng miền đếm được trong sqlite_master', () => {
  insert('ledger_entries', { id: 'le-new', entry_date: '2026-09-24', account: 'AR', amount: 1000.49, created_at: '2026-09-24T00:00:00Z' });
  assert.equal(one<{ amount: number }>("SELECT amount FROM ledger_entries WHERE id = 'le-new'")!.amount, 1000);
  update('ledger_entries', 'le-new', { amount: 2500.5 });
  assert.equal(one<{ amount: number }>("SELECT amount FROM ledger_entries WHERE id = 'le-new'")!.amount, 2501);
  const fkCount = all<{ n: number }>("SELECT COUNT(*) AS n FROM main.sqlite_master WHERE type = 'table' AND sql LIKE '%FOREIGN KEY%'")[0].n;
  assert.ok(fkCount >= 15, `${fkCount} bảng dùng chung có FOREIGN KEY`);
});

test('CCCD: mã hoá khi lưu, dịch vụ giải mã, che chỉ lộ 3 số cuối, giá trị che gửi lại không ghi đè', () => {
  const htx = one<{ id: string }>('SELECT id FROM cooperatives LIMIT 1')!;
  const created = mdm.createFarmer({ fullName: 'Nguyễn Văn Mã Hoá', htxId: htx.id, nationalId: '079123456789' });
  assert.equal(created.national_id, '079123456789', 'dịch vụ trả số rõ cho người vừa nhập');
  const raw = one<{ national_id: string }>('SELECT national_id FROM farmers WHERE id = ?', [created.id])!.national_id;
  assert.match(raw, /^enc2:k1:/, 'trong CSDL là bản mã có định danh khoá');
  assert.notEqual(raw, '079123456789');
  assert.equal(crypto.decryptField(raw), '079123456789');
  assert.equal(crypto.maskNationalId(raw), '•••••••••789');
  assert.equal(mdm.listFarmers(htx.id).find((f) => f.id === created.id)!.national_id, '079123456789', 'listFarmers giải mã');
  // Gửi lại giá trị đã che (form không sửa CCCD) → không ghi đè.
  lifecycle.updateFarmer(String(created.id), { nationalId: '•••••••••789', address: 'Ấp 1' });
  assert.equal(crypto.decryptField(one<{ national_id: string }>('SELECT national_id FROM farmers WHERE id = ?', [created.id])!.national_id), '079123456789');
  // Bản ghi cũ dạng rõ được mã hoá khi khởi động.
  run("UPDATE farmers SET national_id = '001200300400' WHERE id = ?", [created.id]);
  assert.equal(crypto.encryptPiiAtRest(), 1);
  assert.match(one<{ national_id: string }>('SELECT national_id FROM farmers WHERE id = ?', [created.id])!.national_id, /^enc2:/);
  assert.equal(crypto.encryptPiiAtRest(), 0, 'idempotent');
});

test('member_count: chỉ đếm nông hộ đang hoạt động, giảm khi hộ ngừng', () => {
  const htx = one<{ id: string }>('SELECT id FROM cooperatives LIMIT 1')!;
  const before = one<{ member_count: number }>('SELECT member_count FROM cooperatives WHERE id = ?', [htx.id])!.member_count;
  const f = mdm.createFarmer({ fullName: 'Hộ tạm', htxId: htx.id });
  assert.equal(one<{ member_count: number }>('SELECT member_count FROM cooperatives WHERE id = ?', [htx.id])!.member_count, before + 1);
  lifecycle.updateFarmer(String(f.id), { status: 'inactive' });
  assert.equal(one<{ member_count: number }>('SELECT member_count FROM cooperatives WHERE id = ?', [htx.id])!.member_count, before, 'giảm khi hộ ngừng');
  assert.throws(() => lifecycle.updateFarmer(String(f.id), { status: 'ngung' }), /active hoặc inactive/);
});

test('Bằng chứng công đoạn: evidence_json cũ được tách thành dòng, cột cũ biến mất sau khi dựng lại', () => {
  const rows = all<{ kind: string; url: string | null; note: string | null; recorded_by: string }>("SELECT kind, url, note, recorded_by FROM field_stage_evidence WHERE stage_id = 'st-old' ORDER BY kind").map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { kind: 'photo', url: null, note: 'Ảnh kiện rơm', recorded_by: 'Tổ trưởng' },
    { kind: 'video', url: 'https://example.org/v', note: null, recorded_by: 'Tổ trưởng' },
  ]);
  const columns = (db().prepare('PRAGMA field.table_info(field_job_stages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!columns.includes('evidence_json'), 'cột evidence_json đã bỏ');
  assert.match(storedSql('field', 'field_stage_evidence'), /FOREIGN KEY \(stage_id\) REFERENCES field_job_stages\(id\)/);
});

test('Ngưỡng CGH: JSON trong system_config được di trú sang bảng có phiên bản; ban hành mới ghi một dòng; áp đúng theo ngày', () => {
  assert.equal(one("SELECT key FROM system_config WHERE key = 'cgh.coverage_thresholds'"), null, 'khoá JSON cũ đã xoá');
  const versions = cghOps.listThresholdVersions();
  assert.deepEqual(versions.map((v) => v.effectiveFrom), ['2026-06-01', '2026-01-01']);
  assert.equal(versions[1].documentRef, 'QĐ cũ');
  assert.equal(cgh.coverageThresholds('2026-03-01').du, 85);
  assert.equal(cgh.coverageThresholds('2026-07-01').du, 90);
  assert.equal(cgh.coverageThresholds('2025-01-01').du, 85, 'trước mọi phiên bản → mặc định BRD');
  cghOps.addThresholdVersion({ du: 88, canChuY: 65, thua: 125, effectiveFrom: '2027-01-01', documentRef: 'QĐ 2027' }, { name: 'test' });
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM cgh_coverage_thresholds')!.n, 3);
  // Cùng ngày hiệu lực → thay thế, không nhân đôi.
  cghOps.addThresholdVersion({ du: 89, canChuY: 65, thua: 125, effectiveFrom: '2027-01-01' }, { name: 'test' });
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM cgh_coverage_thresholds')!.n, 3);
  assert.equal(cgh.coverageThresholds('2027-02-01').du, 89);
  // CHECK ở tầng SQLite chặn bộ ngưỡng không tăng dần dù chèn thẳng bằng SQL.
  assert.throws(() => run("INSERT INTO cgh_coverage_thresholds (id, effective_from, can_chu_y, du, thua, created_at) VALUES ('x', '2028-01-01', 90, 80, 120, '2026-01-01')"), /CHECK/i);
});
