/**
 * Procurement (PO) — Quản lý mua hàng & thu gom.
 *
 * Luồng: kế hoạch mùa vụ (Planning) → PR → PO → GRN (Warehouse) → đối soát 3
 * chiều → đề nghị thanh toán (Finance).
 */
import { all, insert, one, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { postEntry } from '../finance/service.ts';

export function createPurchaseOrder(
  input: { htxId: string; facilityId: string; itemId?: string; seasonId?: string; orderedTons: number; unitPrice: number; expectedDate?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  if (input.orderedTons <= 0) throw new Error('Khối lượng đặt mua phải lớn hơn 0.');
  if (input.unitPrice <= 0) throw new Error('Đơn giá phải lớn hơn 0.');

  const itemId = input.itemId ?? one<{ id: string }>("SELECT id FROM items WHERE category = 'straw' LIMIT 1")?.id;
  if (!itemId) throw new Error('Chưa có mặt hàng trong Item Master.');

  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM purchase_orders');
  const record = {
    id: uuid(),
    code: sequenceCode('PO', (count?.n ?? 0) + 1, 6),
    htx_id: input.htxId,
    facility_id: input.facilityId,
    item_id: itemId,
    season_id: input.seasonId ?? null,
    ordered_tons: input.orderedTons,
    unit_price: input.unitPrice,
    status: 'nhap',
    expected_date: input.expectedDate ?? null,
    created_by: actor.name ?? null,
    created_at: nowIso(),
    approved_by: null,
    approved_at: null,
  };
  insert('purchase_orders', record);
  logEvent({ module: 'procurement', entityType: 'purchase_orders', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function approvePurchaseOrder(id: string, actor: AuditActor = {}): Record<string, unknown> {
  const po = one<{ status: string }>('SELECT status FROM purchase_orders WHERE id = ?', [id]);
  if (!po) throw new Error('Không tìm thấy đơn mua');
  if (po.status !== 'nhap') throw new Error('Chỉ duyệt được đơn ở trạng thái Nháp.');
  update('purchase_orders', id, { status: 'duyet', approved_by: actor.name ?? null, approved_at: nowIso() });
  logEvent({ module: 'procurement', entityType: 'purchase_orders', entityId: id, action: 'approve' }, actor);
  return one('SELECT * FROM purchase_orders WHERE id = ?', [id])!;
}

/**
 * Đối soát 3 chiều: PO ↔ GRN đã duyệt ↔ đề nghị thanh toán.
 * Chỉ đề nghị thanh toán phần khối lượng đã nhận và đã được phê duyệt.
 */
export function threeWayMatch(poId: string): Record<string, unknown> {
  const po = one<{ id: string; code: string; ordered_tons: number; unit_price: number; htx_id: string; facility_id: string }>(
    'SELECT * FROM purchase_orders WHERE id = ?',
    [poId],
  );
  if (!po) throw new Error('Không tìm thấy đơn mua');
  const received = one<{ tons: number; n: number }>(
    "SELECT COALESCE(SUM(received_tons),0) AS tons, COUNT(*) AS n FROM goods_receipts WHERE po_id = ? AND status = 'da_duyet'",
    [poId],
  );
  const paid = one<{ amount: number }>(
    "SELECT COALESCE(SUM(amount),0) AS amount FROM ledger_entries WHERE ref_type = 'grn' AND account = 'AP' AND ref_id IN (SELECT id FROM goods_receipts WHERE po_id = ?)",
    [poId],
  );
  const receivedTons = received?.tons ?? 0;
  const variance = receivedTons - po.ordered_tons;
  return {
    po,
    receivedTons,
    receiptCount: received?.n ?? 0,
    varianceTons: Math.round(variance * 1000) / 1000,
    variancePct: po.ordered_tons > 0 ? Math.round((variance / po.ordered_tons) * 10_000) / 100 : 0,
    payableAmount: Math.round(receivedTons * po.unit_price),
    postedAmount: paid?.amount ?? 0,
    matched: Math.abs((paid?.amount ?? 0) - receivedTons * po.unit_price) < 1,
  };
}

/** Thanh toán HTX theo tấn thu gom thực tế. */
export function requestPayment(poId: string, actor: AuditActor = {}): Record<string, unknown> {
  const match = threeWayMatch(poId) as { po: any; payableAmount: number; postedAmount: number };
  const outstanding = match.payableAmount - match.postedAmount;
  if (outstanding <= 0) throw new Error('Không còn khoản phải trả cho đơn mua này.');
  const entry = postEntry(
    {
      account: 'AP',
      amount: outstanding,
      description: `Đề nghị thanh toán đơn mua ${match.po.code}`,
      htxId: match.po.htx_id,
      facilityId: match.po.facility_id,
      refType: 'purchase_order',
      refId: poId,
      dueDate: new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10),
    },
    actor,
  );
  return { entry, outstanding };
}

export function listPurchaseOrders(filter: { htxId?: string; status?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.htxId) {
    clauses.push('po.htx_id = ?');
    params.push(filter.htxId);
  }
  if (filter.status) {
    clauses.push('po.status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT po.*, c.code AS htx_code, c.name AS htx_name, f.name AS facility_name
     FROM purchase_orders po
     JOIN cooperatives c ON c.id = po.htx_id
     JOIN facilities f ON f.id = po.facility_id
     ${where} ORDER BY po.created_at DESC`,
    params,
  );
}

/** Báo cáo mua hàng theo Hub / kỳ / HTX. */
export function purchaseReport(from?: string, to?: string): Record<string, unknown> {
  const range = from && to ? 'WHERE substr(po.created_at,1,10) BETWEEN ? AND ?' : '';
  const params = from && to ? [from, to] : [];
  return {
    byHtx: all(
      `SELECT c.code, c.name, COUNT(*) AS orders, COALESCE(SUM(po.ordered_tons),0) AS ordered_tons,
              COALESCE(SUM(po.ordered_tons * po.unit_price),0) AS amount
       FROM purchase_orders po JOIN cooperatives c ON c.id = po.htx_id ${range}
       GROUP BY c.id ORDER BY amount DESC`,
      params,
    ),
    byFacility: all(
      `SELECT f.code, f.name, COUNT(*) AS orders, COALESCE(SUM(po.ordered_tons),0) AS ordered_tons
       FROM purchase_orders po JOIN facilities f ON f.id = po.facility_id ${range}
       GROUP BY f.id ORDER BY ordered_tons DESC`,
      params,
    ),
    byStatus: all(`SELECT status, COUNT(*) AS n FROM purchase_orders po ${range} GROUP BY status`, params),
  };
}
