/**
 * Sales (SO) — Quản lý bán hàng đầu ra (EVN / VFT / doanh nghiệp mua).
 *
 * Luồng: hợp đồng khung → SO → lệnh giao hàng (Warehouse + TMS) → ePOD/e-bill
 * → hoá đơn → thu tiền (Finance).
 */
import { all, insert, one, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';

export function createSalesOrder(
  input: { partnerId: string; facilityId: string; itemId?: string; orderedTons: number; unitPrice: number; deliveryDate?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  if (input.orderedTons <= 0) throw new Error('Khối lượng bán phải lớn hơn 0.');
  const itemId = input.itemId ?? one<{ id: string }>("SELECT id FROM items WHERE category = 'straw' LIMIT 1")?.id;
  if (!itemId) throw new Error('Chưa có mặt hàng trong Item Master.');

  // Kiểm tra tồn kho khả dụng trước khi xác nhận đơn.
  const facility = one<{ current_stock_tons: number; name: string }>(
    'SELECT current_stock_tons, name FROM facilities WHERE id = ?',
    [input.facilityId],
  );
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM sales_orders');
  const record = {
    id: uuid(),
    code: sequenceCode('SO', (count?.n ?? 0) + 1, 6),
    partner_id: input.partnerId,
    facility_id: input.facilityId,
    item_id: itemId,
    ordered_tons: input.orderedTons,
    unit_price: input.unitPrice,
    delivery_date: input.deliveryDate ?? null,
    status: 'nhap',
    created_at: nowIso(),
  };
  insert('sales_orders', record);
  logEvent({ module: 'sales', entityType: 'sales_orders', entityId: record.id, action: 'create', after: record }, actor);
  return {
    ...record,
    availableStockTons: facility?.current_stock_tons ?? 0,
    stockWarning:
      facility && facility.current_stock_tons < input.orderedTons
        ? `Tồn kho ${facility.name} hiện chỉ ${facility.current_stock_tons} tấn — chưa đủ cho đơn ${input.orderedTons} tấn.`
        : null,
  };
}

export function advanceSalesOrder(
  id: string,
  next: 'xac_nhan' | 'dang_giao' | 'da_giao' | 'hoan_tat',
  actor: AuditActor = {},
): Record<string, unknown> {
  const flow = ['nhap', 'xac_nhan', 'dang_giao', 'da_giao', 'hoan_tat'];
  const before = one<{ status: string }>('SELECT status FROM sales_orders WHERE id = ?', [id]);
  if (!before) throw new Error('Không tìm thấy đơn bán');
  if (flow.indexOf(next) <= flow.indexOf(before.status)) {
    throw new Error(`Không thể chuyển từ "${before.status}" sang "${next}".`);
  }
  update('sales_orders', id, { status: next });
  logEvent({ module: 'sales', entityType: 'sales_orders', entityId: id, action: 'update', before, after: { status: next } }, actor);
  return one('SELECT * FROM sales_orders WHERE id = ?', [id])!;
}

export function listSalesOrders(filter: { partnerId?: string; status?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.partnerId) {
    clauses.push('so.partner_id = ?');
    params.push(filter.partnerId);
  }
  if (filter.status) {
    clauses.push('so.status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT so.*, p.code AS partner_code, p.name AS partner_name, f.name AS facility_name
     FROM sales_orders so JOIN partners p ON p.id = so.partner_id JOIN facilities f ON f.id = so.facility_id
     ${where} ORDER BY so.created_at DESC`,
    params,
  );
}

export function salesReport(from?: string, to?: string): Record<string, unknown> {
  const range = from && to ? 'WHERE substr(so.created_at,1,10) BETWEEN ? AND ?' : '';
  const params = from && to ? [from, to] : [];
  return {
    byPartner: all(
      `SELECT p.code, p.name, COUNT(*) AS orders, COALESCE(SUM(so.ordered_tons),0) AS tons,
              COALESCE(SUM(so.ordered_tons * so.unit_price),0) AS revenue
       FROM sales_orders so JOIN partners p ON p.id = so.partner_id ${range} GROUP BY p.id ORDER BY revenue DESC`,
      params,
    ),
    byStatus: all(`SELECT status, COUNT(*) AS n, COALESCE(SUM(ordered_tons),0) AS tons FROM sales_orders so ${range} GROUP BY status`, params),
    fulfilment: all(
      `SELECT so.code, so.ordered_tons,
              COALESCE((SELECT SUM(gi.issued_tons) FROM goods_issues gi WHERE gi.so_id = so.id AND gi.status = 'da_duyet'), 0) AS issued_tons
       FROM sales_orders so ${range} ORDER BY so.created_at DESC LIMIT 100`,
      params,
    ),
  };
}
