/**
 * HỢP ĐỒNG THU MUA RƠM với HTX (D1 trong bản rà soát).
 *
 * Trước đây việc thu gom không biết HTX nào có hợp đồng, cam kết bao nhiêu tấn, giá
 * nào; mức ưu tiên phân công nhập tay; phiếu mua rơm không có đơn giá để bám.
 * Hợp đồng là nơi duy nhất giữ ba con số đó.
 *
 *   CT-01  Một HTX chỉ có MỘT hợp đồng hiệu lực trong một khoảng thời gian —
 *          hai hợp đồng chồng nhau thì phiếu mua không biết lấy giá nào.
 *   CT-02  Giá và cam kết phải dương; ngày kết thúc không trước ngày bắt đầu.
 *   CT-03  Cơ sở giá là một trong hai: đ/tấn theo cân nhà máy, hoặc đ/cuộn. Rơm
 *          ĐBSCL bán theo cuộn nên đ/cuộn là cách phổ biến — phiếu theo cuộn không
 *          phải chờ cân mới ra tiền.
 */
import { all, insert, one, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, today, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';

export const PRICE_BASIS: Record<string, string> = {
  theo_tan_can: 'đ/tấn theo cân nhà máy',
  theo_cuon: 'đ/cuộn (đếm ở ruộng)',
};
export const CONTRACT_STATUS: Record<string, string> = { hieu_luc: 'Hiệu lực', het_han: 'Hết hạn', huy: 'Đã huỷ' };

type Row = Record<string, unknown>;

export interface ContractInput {
  htxId: string; fromDate: string; toDate: string; committedTons: number;
  priceBasis: 'theo_tan_can' | 'theo_cuon'; unitPrice: number; maxMoisturePct?: number; note?: string;
}

function validate(input: ContractInput): void {
  if (!input.htxId) throw new Error('Thiếu hợp tác xã.');
  if (!one('SELECT id FROM cooperatives WHERE id = ?', [input.htxId])) throw new Error('Không tìm thấy hợp tác xã.');
  if (!PRICE_BASIS[input.priceBasis]) throw new Error('Cơ sở giá phải là đ/tấn theo cân nhà máy hoặc đ/cuộn.');
  if (!(input.unitPrice > 0)) throw new Error('CT-02: Đơn giá phải lớn hơn 0.');
  if (!(input.committedTons > 0)) throw new Error('CT-02: Khối lượng cam kết phải lớn hơn 0.');
  if (!input.fromDate || !input.toDate || input.toDate < input.fromDate) throw new Error('CT-02: Ngày kết thúc không được trước ngày bắt đầu.');
}

export function createContract(input: ContractInput, actor: AuditActor = {}): Row {
  validate(input);
  const overlap = one<{ code: string }>(
    `SELECT code FROM straw_contracts WHERE htx_id = ? AND status = 'hieu_luc' AND from_date <= ? AND to_date >= ?`,
    [input.htxId, input.toDate, input.fromDate],
  );
  if (overlap) {
    throw new Error(`CT-01: HTX đã có hợp đồng ${overlap.code} hiệu lực chồng thời gian này — hết hạn hoặc huỷ hợp đồng cũ trước.`);
  }
  const n = one<{ n: number }>('SELECT COUNT(*) AS n FROM straw_contracts')?.n ?? 0;
  const timestamp = nowIso();
  const record = {
    id: uuid(), code: sequenceCode('HDR', n + 1, 5), htx_id: input.htxId,
    from_date: input.fromDate, to_date: input.toDate, committed_tons: input.committedTons,
    price_basis: input.priceBasis, unit_price: input.unitPrice, max_moisture_pct: input.maxMoisturePct ?? null,
    status: 'hieu_luc', note: input.note ?? null, created_by: actor.name ?? null, created_at: timestamp, updated_at: timestamp,
  };
  insert('straw_contracts', record);
  logEvent({ module: 'straw', entityType: 'straw_contracts', entityId: record.id, action: 'create', after: record }, actor);
  return contractDetail(record.id);
}

export function updateContract(id: string, patch: Partial<Pick<ContractInput, 'committedTons' | 'unitPrice' | 'toDate' | 'maxMoisturePct' | 'note'>>, actor: AuditActor = {}): Row {
  const before = one<Row & { status: string; from_date: string }>('SELECT * FROM straw_contracts WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy hợp đồng.');
  if (before.status !== 'hieu_luc') throw new Error('Chỉ sửa hợp đồng đang hiệu lực.');
  const values: Row = { updated_at: nowIso() };
  if (patch.committedTons !== undefined) { if (!(patch.committedTons > 0)) throw new Error('CT-02: Khối lượng cam kết phải lớn hơn 0.'); values.committed_tons = patch.committedTons; }
  if (patch.unitPrice !== undefined) { if (!(patch.unitPrice > 0)) throw new Error('CT-02: Đơn giá phải lớn hơn 0.'); values.unit_price = patch.unitPrice; }
  if (patch.toDate !== undefined) { if (patch.toDate < before.from_date) throw new Error('CT-02: Ngày kết thúc không được trước ngày bắt đầu.'); values.to_date = patch.toDate; }
  if (patch.maxMoisturePct !== undefined) values.max_moisture_pct = patch.maxMoisturePct;
  if (patch.note !== undefined) values.note = patch.note;
  update('straw_contracts', id, values);
  logEvent({ module: 'straw', entityType: 'straw_contracts', entityId: id, action: 'update', before, after: values }, actor);
  return contractDetail(id);
}

export function setContractStatus(id: string, status: 'hieu_luc' | 'het_han' | 'huy', actor: AuditActor = {}): Row {
  const before = one<Row>('SELECT * FROM straw_contracts WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy hợp đồng.');
  if (!CONTRACT_STATUS[status]) throw new Error('Trạng thái không hợp lệ.');
  update('straw_contracts', id, { status, updated_at: nowIso() });
  logEvent({ module: 'straw', entityType: 'straw_contracts', entityId: id, action: 'update', before: { status: before.status }, after: { status } }, actor);
  return contractDetail(id);
}

/** Hợp đồng hiệu lực của HTX bao trùm một ngày (ngày gặt). */
export function contractFor(htxId: string | null | undefined, date: string): (Row & { id: string; price_basis: string; unit_price: number; code: string }) | null {
  if (!htxId) return null;
  return one(
    `SELECT * FROM straw_contracts WHERE htx_id = ? AND status = 'hieu_luc' AND from_date <= ? AND to_date >= ? ORDER BY created_at DESC LIMIT 1`,
    [htxId, date, date],
  );
}

const SELECT = `
  SELECT c.*, h.name AS htx_name, h.code AS htx_code,
         (SELECT COUNT(*) FROM field_jobs j WHERE j.contract_id = c.id AND j.status <> 'huy') AS jobs,
         (SELECT COUNT(*) FROM field_jobs j WHERE j.contract_id = c.id AND j.status = 'hoan_thanh') AS jobs_done,
         (SELECT COALESCE(SUM(t.bales), 0) FROM straw_purchase_tickets t WHERE t.contract_id = c.id AND t.status <> 'huy') AS delivered_bales,
         (SELECT COALESCE(SUM(COALESCE(t.weighed_tons, t.estimated_tons)), 0) FROM straw_purchase_tickets t WHERE t.contract_id = c.id AND t.status <> 'huy') AS delivered_tons,
         (SELECT COALESCE(SUM(t.weighed_tons), 0) FROM straw_purchase_tickets t WHERE t.contract_id = c.id AND t.status <> 'huy') AS weighed_tons,
         (SELECT COALESCE(SUM(t.amount), 0) FROM straw_purchase_tickets t WHERE t.contract_id = c.id AND t.status IN ('da_xac_nhan', 'da_thanh_toan')) AS confirmed_amount,
         (SELECT COALESCE(SUM(t.amount), 0) FROM straw_purchase_tickets t WHERE t.contract_id = c.id AND t.status = 'da_thanh_toan') AS paid_amount
  FROM straw_contracts c JOIN cooperatives h ON h.id = c.htx_id`;

function decorate(row: Row): Row {
  const committed = Number(row.committed_tons);
  const delivered = Number(row.delivered_tons);
  const expired = row.status === 'hieu_luc' && String(row.to_date) < today();
  return {
    ...row,
    statusLabel: expired ? 'Hết hạn (chưa đóng)' : CONTRACT_STATUS[String(row.status)] ?? row.status,
    priceBasisLabel: PRICE_BASIS[String(row.price_basis)] ?? row.price_basis,
    progressPct: committed ? Math.round((delivered / committed) * 100) : 0,
    remainingTons: Math.max(0, Math.round((committed - delivered) * 10) / 10),
    daysLeft: Math.round((Date.parse(String(row.to_date)) - Date.parse(today())) / 86_400_000),
    expired,
  };
}

export function listContracts(filter: { htxId?: string; status?: string } = {}): Row[] {
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (filter.htxId) { where.push('c.htx_id = ?'); params.push(filter.htxId); }
  if (filter.status) { where.push('c.status = ?'); params.push(filter.status); }
  return all<Row>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.status = 'hieu_luc' DESC, c.to_date DESC`, params).map(decorate);
}

export function contractDetail(id: string): Row {
  const row = one<Row>(`${SELECT} WHERE c.id = ?`, [id]);
  if (!row) throw new Error('Không tìm thấy hợp đồng.');
  return decorate(row);
}

/** Tổng hợp KPI hợp đồng — cho giao diện hiển thị, không tính lại phía client. */
export function contractSummary(filter: { htxId?: string } = {}): Record<string, unknown> {
  const contracts = listContracts(filter);
  const active = contracts.filter((c) => c.status === 'hieu_luc' && !c.expired);
  return {
    total: contracts.length,
    active: active.length,
    committedTons: active.reduce((s, c) => s + Number(c.committed_tons), 0),
    deliveredTons: active.reduce((s, c) => s + Number(c.delivered_tons), 0),
    deliveredBales: active.reduce((s, c) => s + Number(c.delivered_bales), 0),
    expiringIn30Days: active.filter((c) => Number(c.daysLeft) <= 30).length,
  };
}
