/**
 * Finance & Revenue Engine.
 *
 * Ranh giới kiến trúc (ERP Vision v1.2, nguyên tắc 7): Payment (Core Service)
 * vận hành cổng thanh toán/ví giữ tiền/giải ngân; Finance chỉ xử lý logic
 * nghiệp vụ phía trên — tính phí, đối soát công nợ, revenue-share, kế toán.
 *
 * Ba mô hình doanh thu cấu hình được:
 *   1. transaction_fee — phí % trên mỗi giao dịch khớp lệnh thành công
 *   2. subscription    — Subscription / Data Licensing cho nhà máy quy mô lớn
 *   3. carbon_share    — chia sẻ doanh thu carbon (mặc định 45% giữ lại / 55% chia)
 */
import { all, insert, one, update } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';

export type Account = 'AP' | 'AR' | 'REVENUE' | 'EXPENSE' | 'CAPEX';

export interface LedgerInput {
  account: Account;
  amount: number;
  description: string;
  partnerId?: string;
  htxId?: string;
  facilityId?: string;
  refType?: string;
  refId?: string;
  dueDate?: string;
  entryDate?: string;
}

export function postEntry(input: LedgerInput, actor: AuditActor = {}): Record<string, unknown> {
  const record = {
    id: uuid(),
    entry_date: input.entryDate ?? nowIso().slice(0, 10),
    account: input.account,
    partner_id: input.partnerId ?? null,
    htx_id: input.htxId ?? null,
    ref_type: input.refType ?? null,
    ref_id: input.refId ?? null,
    facility_id: input.facilityId ?? null,
    amount: Math.round(input.amount),
    currency: 'VND',
    description: input.description,
    status: 'ghi_so',
    due_date: input.dueDate ?? null,
    created_at: nowIso(),
  };
  insert('ledger_entries', record);
  logEvent({ module: 'finance', entityType: 'ledger_entries', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

/** Ghi nhận phí nền tảng từ một giao dịch đã hoàn thành. */
export function recordPlatformFee(input: {
  refType: string; refId: string; amount: number; description: string; htxId?: string; partnerId?: string;
}): void {
  if (input.amount <= 0) return;
  postEntry({
    account: 'REVENUE',
    amount: input.amount,
    description: input.description,
    refType: input.refType,
    refId: input.refId,
    htxId: input.htxId,
    partnerId: input.partnerId,
  });
}

export function settleEntry(id: string, actor: AuditActor = {}): void {
  update('ledger_entries', id, { status: 'da_thanh_toan' });
  logEvent({ module: 'finance', entityType: 'ledger_entries', entityId: id, action: 'update', after: { status: 'da_thanh_toan' } }, actor);
}

/** Đối soát công nợ đa bên: HTX ↔ Mekong Green ↔ Nhà máy mua, theo Hub/kỳ. */
export function reconciliation(filter: { from?: string; to?: string; facilityId?: string } = {}): Record<string, unknown> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.from) {
    clauses.push('entry_date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push('entry_date <= ?');
    params.push(filter.to);
  }
  if (filter.facilityId) {
    clauses.push('facility_id = ?');
    params.push(filter.facilityId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const byAccount = all(`SELECT account, status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM ledger_entries ${where} GROUP BY account, status`, params);
  // Review 24/09/2026 (D03): cùng bộ lọc thời gian/kho cho MỌI bảng con, không chỉ byAccount.
  const extra = clauses.length ? ` AND ${clauses.map((c) => `l.${c}`).join(' AND ')}` : '';
  const payablesByHtx = all(
    `SELECT c.code, c.name, COALESCE(SUM(l.amount),0) AS total
     FROM ledger_entries l JOIN cooperatives c ON c.id = l.htx_id
     WHERE l.account = 'AP' AND l.status = 'ghi_so'${extra} GROUP BY c.id ORDER BY total DESC`, params,
  );
  const receivablesByPartner = all(
    `SELECT p.code, p.name, COALESCE(SUM(l.amount),0) AS total
     FROM ledger_entries l JOIN partners p ON p.id = l.partner_id
     WHERE l.account = 'AR' AND l.status = 'ghi_so'${extra} GROUP BY p.id ORDER BY total DESC`, params,
  );
  const overdue = all(
    `SELECT l.* FROM ledger_entries l WHERE l.status = 'ghi_so' AND l.due_date IS NOT NULL AND l.due_date < ?${extra} ORDER BY l.due_date`,
    [nowIso().slice(0, 10), ...params],
  );
  return { byAccount, payablesByHtx, receivablesByPartner, overdue, filter };
}

/** Báo cáo P&L đơn giản theo kỳ. */
export function profitAndLoss(from: string, to: string): Record<string, unknown> {
  const rows = all<{ account: string; total: number }>(
    'SELECT account, COALESCE(SUM(amount),0) AS total FROM ledger_entries WHERE entry_date BETWEEN ? AND ? GROUP BY account',
    [from, to],
  );
  const map = Object.fromEntries(rows.map((r) => [r.account, r.total]));
  const revenue = map.REVENUE ?? 0;
  // Review 24/09/2026 (D03): AP là CÔNG NỢ phải trả (hàng nhập kho chưa bán), không phải chi phí của kỳ —
  // trước đây cộng AP vào chi phí làm lợi nhuận giảm ngay khi nhập hàng.
  const expense = map.EXPENSE ?? 0;
  return {
    period: { from, to },
    revenue,
    expense,
    grossProfit: revenue - expense,
    capex: map.CAPEX ?? 0,
    receivables: map.AR ?? 0,
    payables: map.AP ?? 0,
    purchasesOnCredit: map.AP ?? 0,
    basis: 'operational_estimate',
    note: 'Báo cáo vận hành ước tính từ sổ nghiệp vụ một dòng (AP/AR/REVENUE/EXPENSE/CAPEX) — không phải sổ kế toán kép, chưa có giá vốn hàng bán, khoá kỳ hay bút toán đảo.',
  };
}

// ---------------------------------------------------------------------------
// Revenue Engine — cấu hình 3 mô hình kiếm tiền
// ---------------------------------------------------------------------------

export function listRevenueRules(): Record<string, unknown>[] {
  return all('SELECT * FROM revenue_rules ORDER BY kind, code');
}

export function upsertRevenueRule(
  input: { code: string; name: string; kind: 'transaction_fee' | 'subscription' | 'carbon_share'; ratePct?: number; fixedAmount?: number; appliesTo?: string; active?: boolean },
  actor: AuditActor = {},
): void {
  const existing = one<{ id: string }>('SELECT id FROM revenue_rules WHERE code = ?', [input.code]);
  const record = {
    id: existing?.id ?? uuid(),
    code: input.code,
    name: input.name,
    kind: input.kind,
    rate_pct: input.ratePct ?? null,
    fixed_amount: input.fixedAmount ?? null,
    applies_to: input.appliesTo ?? null,
    active: input.active === false ? 0 : 1,
  };
  if (existing) update('revenue_rules', existing.id, record);
  else insert('revenue_rules', record);
  logEvent({ module: 'finance', entityType: 'revenue_rules', entityId: record.id, action: existing ? 'update' : 'create', after: record }, actor);
}

/**
 * Chia sẻ doanh thu carbon — tỷ lệ cấu hình được, mặc định 45% giữ lại /
 * 55% chia cho nông dân, cơ quan quản lý và tổ chức xác nhận quốc tế.
 */
export function carbonRevenueShare(totalRevenue: number): Record<string, unknown> {
  const rule = one<{ rate_pct: number }>(
    "SELECT rate_pct FROM revenue_rules WHERE kind = 'carbon_share' AND active = 1 LIMIT 1",
  );
  const retainedPct = rule?.rate_pct ?? 45;
  const retained = Math.round((totalRevenue * retainedPct) / 100);
  const shared = totalRevenue - retained;
  return {
    totalRevenue,
    retainedPct,
    retained,
    sharedPct: 100 - retainedPct,
    shared,
    // Phân bổ gợi ý trong phần chia sẻ (cần chốt chính sách trước khi vận hành thật).
    allocation: [
      { beneficiary: 'Nông dân / HTX', pct: 70, amount: Math.round(shared * 0.7) },
      { beneficiary: 'Cơ quan quản lý', pct: 15, amount: Math.round(shared * 0.15) },
      { beneficiary: 'Tổ chức xác nhận quốc tế (VVB)', pct: 15, amount: shared - Math.round(shared * 0.7) - Math.round(shared * 0.15) },
    ],
    note: 'Tỷ lệ 45/55 theo mô hình công bố trong Vision v1.2; cấu hình lại tại Revenue Rules.',
  };
}

/**
 * Theo dõi CAPEX/OPEX Hub thực tế so với dự phóng của Simulation (FN-10).
 * Đây là vòng phản hồi Simulation ↔ Vận hành (Success Metric SM-04).
 */
export function budgetVsActual(facilityId: string): Record<string, unknown> {
  const facility = one<{ id: string; code: string; name: string; origin_scenario_id: string | null }>(
    'SELECT id, code, name, origin_scenario_id FROM facilities WHERE id = ?',
    [facilityId],
  );
  if (!facility) throw new Error('Không tìm thấy cơ sở');

  const actual = all<{ account: string; total: number }>(
    'SELECT account, COALESCE(SUM(amount),0) AS total FROM ledger_entries WHERE facility_id = ? GROUP BY account',
    [facilityId],
  );
  const actualMap = Object.fromEntries(actual.map((r) => [r.account, r.total]));

  let planned: { capex: number; opex: number; costPerTon: number | null } | null = null;
  if (facility.origin_scenario_id) {
    const row = one<{ payload_json: string }>(
      'SELECT payload_json FROM simulation_results WHERE scenario_id = ? ORDER BY computed_at DESC LIMIT 1',
      [facility.origin_scenario_id],
    );
    if (row) {
      const result = JSON.parse(row.payload_json) as {
        capex: { total: number }; opex: { total: number }; costs: { costPerTon: number | null };
      };
      planned = { capex: result.capex.total, opex: result.opex.total, costPerTon: result.costs.costPerTon };
    }
  }

  const actualCapex = actualMap.CAPEX ?? 0;
  const actualOpex = actualMap.EXPENSE ?? 0;
  return {
    facility,
    planned,
    actual: { capex: actualCapex, opex: actualOpex },
    variance: planned
      ? {
          capex: actualCapex - planned.capex,
          capexPct: planned.capex > 0 ? Math.round(((actualCapex - planned.capex) / planned.capex) * 1000) / 10 : null,
          opex: actualOpex - planned.opex,
          opexPct: planned.opex > 0 ? Math.round(((actualOpex - planned.opex) / planned.opex) * 1000) / 10 : null,
        }
      : null,
    note: planned
      ? 'So sánh dự phóng từ kịch bản mô phỏng gốc với số liệu vận hành thực tế (SM-04, ngưỡng mục tiêu ≤ 15%).'
      : 'Cơ sở này không được sinh từ một kịch bản mô phỏng — không có số dự phóng để đối chiếu.',
  };
}

export function listEntries(filter: { account?: string; limit?: number } = {}): Record<string, unknown>[] {
  return filter.account
    ? all('SELECT * FROM ledger_entries WHERE account = ? ORDER BY entry_date DESC LIMIT ?', [filter.account, filter.limit ?? 200])
    : all('SELECT * FROM ledger_entries ORDER BY entry_date DESC LIMIT ?', [filter.limit ?? 200]);
}
