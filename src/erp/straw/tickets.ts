/**
 * PHIẾU MUA RƠM và CÔNG NỢ HTX (B3 trong bản rà soát).
 *
 * Tài chính có sổ phải trả nhưng không có chứng từ mua rơm sinh từ số liệu hiện
 * trường: trả tiền HTX theo tấn cân hay theo cuộn, giá nào, đã trả chưa — nằm ngoài
 * hệ thống. Phiếu mua rơm là cầu nối: sinh tự động khi việc thu gom hoàn thành,
 * lấy đơn giá từ hợp đồng, xác nhận thì thành công nợ phải trả, trả thì tất toán.
 *
 *   PM-01  Một việc thu gom = một phiếu. Sinh tự động khi việc hoàn thành; số liệu
 *          làm mới mỗi lần ghe được cân, cho tới khi phiếu được xác nhận.
 *   PM-02  Cơ sở giá theo hợp đồng: đ/cuộn → tiền = cuộn × giá, ra ngay khi hoàn
 *          thành; đ/tấn cân → phải chờ MỌI ghe của việc được cân (trạng thái "chờ cân").
 *   PM-03  Không có hợp đồng thì phiếu vẫn sinh nhưng KHÔNG có tiền — người xác nhận
 *          phải nhập đơn giá thoả thuận; hệ thống không đoán giá.
 *   PM-04  Xác nhận ghi MỘT bút toán phải trả (AP) gắn HTX; trả tiền tất toán đúng bút
 *          toán đó. Phiếu đã xác nhận không tự làm mới nữa — số đã thành nợ.
 */
import { all, insert, one, transaction, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, today, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { postEntry, settleEntry } from '../finance/service.ts';
import { notify } from '../../platform/notify/service.ts';
import { contractFor, PRICE_BASIS } from './contracts.ts';

export const TICKET_STATUS: Record<string, string> = {
  cho_can: 'Chờ cân đủ', cho_xac_nhan: 'Chờ xác nhận', da_xac_nhan: 'Đã xác nhận — công nợ', da_thanh_toan: 'Đã thanh toán', huy: 'Đã huỷ',
};
/** Hạn thanh toán mặc định sau khi xác nhận. */
export const PAYMENT_TERM_DAYS = 15;

type Row = Record<string, unknown>;
const round1 = (v: number) => Math.round(v * 10) / 10;

function jobFigures(jobId: string) {
  const job = one<{ id: string; code: string; htx_id: string | null; harvest_date: string; status: string; contract_id: string | null; location_label: string }>(
    'SELECT id, code, htx_id, harvest_date, status, contract_id, location_label FROM field_jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('Không tìm thấy việc thu gom.');
  const loads = all<{ bales: number | null; tons: number; weighed_kg: number | null }>('SELECT bales, tons, weighed_kg FROM field_loadings WHERE job_id = ?', [jobId]);
  const bales = loads.reduce((s, l) => s + (l.bales ?? 0), 0);
  const estimated = round1(loads.reduce((s, l) => s + l.tons, 0));
  const unweighed = loads.filter((l) => l.weighed_kg === null).length;
  const weighed = loads.length && unweighed === 0 ? round1(loads.reduce((s, l) => s + (l.weighed_kg ?? 0), 0) / 1000) : null;
  return { job, loads: loads.length, bales, estimated, weighed, unweighed };
}

/** Tiền và trạng thái theo cơ sở giá (PM-02, PM-03). */
function compute(basis: string | null, unitPrice: number | null, bales: number, weighed: number | null, unweighed: number) {
  if (!basis || !unitPrice) return { amount: null as number | null, status: unweighed && basis === 'theo_tan_can' ? 'cho_can' : 'cho_xac_nhan' };
  if (basis === 'theo_cuon') return { amount: Math.round(bales * unitPrice), status: 'cho_xac_nhan' };
  if (weighed === null) return { amount: null, status: 'cho_can' };
  return { amount: Math.round(weighed * unitPrice), status: 'cho_xac_nhan' };
}

/**
 * Sinh hoặc làm mới phiếu cho một việc đã hoàn thành (PM-01). Phiếu đã xác nhận
 * giữ nguyên — trả về phiếu hiện có kèm cờ `frozen`.
 */
export function generateTicketForJob(jobId: string, actor: AuditActor = {}): Row {
  const f = jobFigures(jobId);
  if (f.job.status !== 'hoan_thanh') throw new Error(`Việc ${f.job.code} chưa hoàn thành — phiếu mua rơm chỉ lập khi rơm đã xuống ghe hết.`);
  if (!f.loads) throw new Error(`Việc ${f.job.code} không có lượt xuống ghe nào.`);
  const existing = one<Row & { id: string; status: string }>('SELECT * FROM straw_purchase_tickets WHERE job_id = ?', [jobId]);
  if (existing && ['da_xac_nhan', 'da_thanh_toan', 'huy'].includes(existing.status)) return { ...ticketDetail(existing.id), frozen: true };

  const contract = contractFor(f.job.htx_id, f.job.harvest_date);
  const basis = contract?.price_basis ?? null;
  const price = contract?.unit_price ?? null;
  const { amount, status } = compute(basis, price, f.bales, f.weighed, f.unweighed);
  const timestamp = nowIso();
  const values = {
    job_id: jobId, htx_id: f.job.htx_id, contract_id: contract?.id ?? null, price_basis: basis, unit_price: price,
    bales: f.bales, estimated_tons: f.estimated, weighed_tons: f.weighed, unweighed_loadings: f.unweighed, amount, status,
    note: contract ? null : 'PM-03: Không có hợp đồng hiệu lực cho HTX vào ngày gặt — nhập đơn giá thoả thuận khi xác nhận.',
    updated_at: timestamp,
  };
  if (existing) {
    update('straw_purchase_tickets', existing.id, values);
    logEvent({ module: 'straw', entityType: 'straw_purchase_tickets', entityId: existing.id, action: 'update', after: values }, actor);
    return ticketDetail(existing.id);
  }
  const n = one<{ n: number }>('SELECT COUNT(*) AS n FROM straw_purchase_tickets')?.n ?? 0;
  const record = {
    id: uuid(), code: sequenceCode('PMR', n + 1, 5), ...values,
    ledger_entry_id: null, confirmed_by: null, confirmed_at: null, paid_at: null, created_at: timestamp,
  };
  insert('straw_purchase_tickets', record);
  logEvent({ module: 'straw', entityType: 'straw_purchase_tickets', entityId: record.id, action: 'create', after: record }, actor);
  return ticketDetail(record.id);
}

/** Gọi sau mỗi lần cân ghe: việc đã hoàn thành thì phiếu cập nhật tấn cân. */
export function refreshTicketForJob(jobId: string, actor: AuditActor = {}): Row | null {
  const job = one<{ status: string }>('SELECT status FROM field_jobs WHERE id = ?', [jobId]);
  if (!job || job.status !== 'hoan_thanh') return null;
  try { return generateTicketForJob(jobId, actor); } catch { return null; }
}

export function confirmTicket(
  id: string,
  input: { unitPrice?: number; priceBasis?: 'theo_tan_can' | 'theo_cuon'; note?: string } = {},
  actor: AuditActor = {},
): Row {
  const t = one<Row & { id: string; code: string; status: string; htx_id: string | null; price_basis: string | null; unit_price: number | null; bales: number; weighed_tons: number | null; unweighed_loadings: number; job_id: string }>(
    'SELECT * FROM straw_purchase_tickets WHERE id = ?', [id]);
  if (!t) throw new Error('Không tìm thấy phiếu mua rơm.');
  if (t.status === 'da_xac_nhan' || t.status === 'da_thanh_toan') throw new Error(`Phiếu ${t.code} đã xác nhận rồi.`);
  if (t.status === 'huy') throw new Error(`Phiếu ${t.code} đã huỷ.`);

  const basis = input.priceBasis ?? t.price_basis;
  const price = input.unitPrice ?? t.unit_price;
  if (!basis || !PRICE_BASIS[basis]) throw new Error('PM-03: Phiếu không có hợp đồng — phải chọn cơ sở giá (đ/tấn cân hoặc đ/cuộn).');
  if (!(Number(price) > 0)) throw new Error('PM-03: Phiếu không có hợp đồng — phải nhập đơn giá thoả thuận, hệ thống không đoán giá.');
  if (basis === 'theo_tan_can' && t.weighed_tons === null) {
    throw new Error(`PM-02: Còn ${t.unweighed_loadings} ghe chưa cân — trả theo tấn cân thì phải cân đủ trước khi xác nhận.`);
  }
  const amount = basis === 'theo_cuon' ? Math.round(t.bales * Number(price)) : Math.round(Number(t.weighed_tons) * Number(price));
  if (!(amount > 0)) throw new Error('Số tiền phải lớn hơn 0 — kiểm số cuộn / tấn cân.');

  const htx = t.htx_id ? one<{ name: string }>('SELECT name FROM cooperatives WHERE id = ?', [t.htx_id]) : null;
  const due = new Date(Date.now() + PAYMENT_TERM_DAYS * 86_400_000).toISOString().slice(0, 10);
  let entryId = '';
  transaction(() => {
    const entry = postEntry({
      account: 'AP', amount, htxId: t.htx_id ?? undefined, refType: 'straw_ticket', refId: t.id, dueDate: due,
      description: `Phải trả ${htx?.name ?? 'HTX'} — phiếu mua rơm ${t.code} (${basis === 'theo_cuon' ? `${t.bales} cuộn` : `${t.weighed_tons} tấn cân`} × ${Number(price).toLocaleString('vi-VN')} đ)`,
    }, actor) as { id: string };
    entryId = entry.id;
    update('straw_purchase_tickets', id, {
      price_basis: basis, unit_price: price, amount, status: 'da_xac_nhan', ledger_entry_id: entryId,
      confirmed_by: actor.name ?? null, confirmed_at: nowIso(), due_date: due, note: input.note ?? t.note ?? null, updated_at: nowIso(),
    });
  });
  logEvent({ module: 'straw', entityType: 'straw_purchase_tickets', entityId: id, action: 'confirm', after: { amount, basis, price, ledger_entry_id: entryId } }, actor);

  if (t.htx_id) {
    const users = all<{ id: string }>('SELECT id FROM users WHERE htx_id = ?', [t.htx_id]);
    notify({
      module: 'straw', severity: 'info', title: `Phiếu mua rơm ${t.code} đã được xác nhận`,
      body: `${amount.toLocaleString('vi-VN')} đ (${basis === 'theo_cuon' ? `${t.bales} cuộn` : `${t.weighed_tons} tấn`} × ${Number(price).toLocaleString('vi-VN')} đ). Hạn thanh toán ${due}.`,
      link: '/htx/#htx-contracts', userIds: users.map((u) => u.id), dedupeKey: `straw.confirm.${id}`, entityType: 'straw_purchase_tickets', entityId: id,
    }, actor);
  }
  return ticketDetail(id);
}

export function payTicket(id: string, actor: AuditActor = {}): Row {
  const t = one<{ code: string; status: string; ledger_entry_id: string | null; htx_id: string | null; amount: number }>(
    'SELECT code, status, ledger_entry_id, htx_id, amount FROM straw_purchase_tickets WHERE id = ?', [id]);
  if (!t) throw new Error('Không tìm thấy phiếu mua rơm.');
  if (t.status !== 'da_xac_nhan') throw new Error(`Phiếu ${t.code} chưa xác nhận hoặc đã thanh toán — chỉ trả phiếu đang là công nợ.`);
  transaction(() => {
    if (t.ledger_entry_id) settleEntry(t.ledger_entry_id, actor);
    update('straw_purchase_tickets', id, { status: 'da_thanh_toan', paid_at: nowIso(), updated_at: nowIso() });
  });
  logEvent({ module: 'straw', entityType: 'straw_purchase_tickets', entityId: id, action: 'pay', after: { amount: t.amount } }, actor);
  if (t.htx_id) {
    const users = all<{ id: string }>('SELECT id FROM users WHERE htx_id = ?', [t.htx_id]);
    notify({
      module: 'straw', severity: 'info', title: `Đã thanh toán phiếu mua rơm ${t.code}`,
      body: `${Number(t.amount).toLocaleString('vi-VN')} đ đã chuyển. Xem chi tiết ở Hợp đồng & công nợ rơm.`,
      link: '/htx/#htx-contracts', userIds: users.map((u) => u.id), dedupeKey: `straw.pay.${id}`, entityType: 'straw_purchase_tickets', entityId: id,
    }, actor);
  }
  return ticketDetail(id);
}

export function cancelTicket(id: string, reason: string, actor: AuditActor = {}): Row {
  const t = one<{ code: string; status: string }>('SELECT code, status FROM straw_purchase_tickets WHERE id = ?', [id]);
  if (!t) throw new Error('Không tìm thấy phiếu mua rơm.');
  if (t.status === 'da_thanh_toan') throw new Error('Phiếu đã thanh toán không huỷ được — lập phiếu điều chỉnh.');
  if (t.status === 'da_xac_nhan') throw new Error('Phiếu đã thành công nợ — huỷ phải qua kế toán đảo bút toán, không huỷ trực tiếp.');
  if (!reason?.trim()) throw new Error('Phải ghi lý do huỷ.');
  update('straw_purchase_tickets', id, { status: 'huy', note: reason.trim(), updated_at: nowIso() });
  logEvent({ module: 'straw', entityType: 'straw_purchase_tickets', entityId: id, action: 'update', after: { status: 'huy', reason } }, actor);
  return ticketDetail(id);
}

const SELECT = `
  SELECT t.*, h.name AS htx_name, j.code AS job_code, j.location_label, j.harvest_date, c.code AS contract_code,
         (SELECT COUNT(*) FROM field_loadings l WHERE l.job_id = t.job_id) AS loadings
  FROM straw_purchase_tickets t
  LEFT JOIN cooperatives h ON h.id = t.htx_id
  LEFT JOIN field_jobs j ON j.id = t.job_id
  LEFT JOIN straw_contracts c ON c.id = t.contract_id`;

const decorate = (row: Row): Row => ({
  ...row,
  statusLabel: TICKET_STATUS[String(row.status)] ?? row.status,
  priceBasisLabel: row.price_basis ? PRICE_BASIS[String(row.price_basis)] : 'Chưa có hợp đồng',
  overdue: row.status === 'da_xac_nhan' && row.due_date !== null && String(row.due_date) < today(),
});

export function listTickets(filter: { htxId?: string; status?: string; limit?: number } = {}): Row[] {
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (filter.htxId) { where.push('t.htx_id = ?'); params.push(filter.htxId); }
  if (filter.status) { where.push('t.status = ?'); params.push(filter.status); }
  params.push(filter.limit ?? 300);
  return all<Row>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT ?`, params).map(decorate);
}

export function ticketDetail(id: string): Row {
  const row = one<Row>(`${SELECT} WHERE t.id = ?`, [id]);
  if (!row) throw new Error('Không tìm thấy phiếu mua rơm.');
  const loadings = all<Row>(
    `SELECT l.vessel_code, l.bales, l.tons, l.weighed_kg, l.weighed_at, l.loaded_at, g.code AS grn_code, g.status AS grn_status
     FROM field_loadings l LEFT JOIN goods_receipts g ON g.id = l.grn_id WHERE l.job_id = ? ORDER BY l.loaded_at`,
    [row.job_id as string],
  );
  return { ...decorate(row), loadingDetails: loadings };
}

/** Công nợ phải trả rơm theo HTX — cho Tài chính và cho chính HTX xem. */
export function payables(htxId?: string): Row {
  const where = htxId ? 'AND t.htx_id = ?' : '';
  const params = htxId ? [htxId] : [];
  const rows = all<Row>(
    `SELECT t.htx_id, h.name AS htx_name,
            COUNT(*) AS tickets,
            SUM(CASE WHEN t.status IN ('cho_can', 'cho_xac_nhan') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN t.status = 'da_xac_nhan' THEN t.amount ELSE 0 END) AS outstanding,
            SUM(CASE WHEN t.status = 'da_xac_nhan' AND t.due_date < ? THEN t.amount ELSE 0 END) AS overdue,
            SUM(CASE WHEN t.status = 'da_thanh_toan' THEN t.amount ELSE 0 END) AS paid,
            SUM(CASE WHEN t.status <> 'huy' THEN t.bales ELSE 0 END) AS bales,
            SUM(CASE WHEN t.status <> 'huy' THEN COALESCE(t.weighed_tons, t.estimated_tons) ELSE 0 END) AS tons
     FROM straw_purchase_tickets t LEFT JOIN cooperatives h ON h.id = t.htx_id
     WHERE 1 = 1 ${where} GROUP BY t.htx_id ORDER BY outstanding DESC`,
    [today(), ...params],
  );
  return {
    byHtx: rows,
    totals: {
      outstanding: rows.reduce((s, r) => s + Number(r.outstanding), 0),
      overdue: rows.reduce((s, r) => s + Number(r.overdue), 0),
      paid: rows.reduce((s, r) => s + Number(r.paid), 0),
      pending: rows.reduce((s, r) => s + Number(r.pending), 0),
    },
  };
}
