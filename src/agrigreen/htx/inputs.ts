/**
 * VẬT TƯ NÔNG NGHIỆP CỦA HỢP TÁC XÃ: MUA SẮM → TỒN KHO → CẤP PHÁT
 *
 * Khác hẳn module Procurement của ERP Mekong Green (mua rơm nguyên liệu đầu
 * vào cho nhà máy). Đây là chu trình nội bộ HTX cho phân bón và thuốc bảo vệ
 * thực vật, gắn thẳng vào THỬA RUỘNG và BƯỚC KẾ HOẠCH.
 *
 * Vì sao phải gắn tới tận thửa và bước: hồ sơ VietGAP đòi truy xuất được lô
 * thuốc nào đã xuống thửa nào, ngày nào, ai nhận. Một sổ kho chỉ ghi "xuất 50 kg
 * ure" không trả lời được câu hỏi đó.
 *
 * Các chốt chặn:
 *   IN-01  Tồn kho quản lý theo LÔ (batch), không gộp — thu hồi lô lỗi mới lần
 *          ra được đúng những thửa đã dùng.
 *   IN-02  Không cấp phát quá tồn kho của lô.
 *   IN-03  Không cấp phát vật tư đã hết hạn sử dụng.
 *   IN-04  Thuốc BVTV ngoài danh mục được phép thì không cấp phát — VietGAP loại
 *          ngay lô hàng dùng hoạt chất cấm.
 *   IN-05  Cấp phát thuốc BVTV có thời gian cách ly sẽ kiểm tra ngược lại ngày
 *          thu hoạch dự kiến của vụ và cảnh báo nếu không đủ ngày cách ly.
 *   IN-06  Vật tư chỉ cấp cho thửa thuộc chính HTX đang giữ kho.
 */
import { all, insert, one, transaction, update } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';

export const INPUT_CATEGORIES = [
  { code: 'phan_bon', label: 'Phân bón' },
  { code: 'thuoc_bvtv', label: 'Thuốc bảo vệ thực vật' },
  { code: 'giong', label: 'Giống' },
  { code: 'khac', label: 'Vật tư khác' },
];

const DAY_MS = 86_400_000;

function addDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

// =====================================================================
// Danh mục vật tư
// =====================================================================

export function createItem(
  input: {
    code?: string; name: string; category: string; uom?: string;
    activeIngredient?: string; phiDays?: number | null;
    permitted?: boolean; permitRef?: string; htxId?: string | null;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  if (!input.name?.trim()) throw new Error('Vật tư phải có tên.');
  if (!INPUT_CATEGORIES.some((c) => c.code === input.category)) {
    throw new Error(`Nhóm vật tư không hợp lệ: "${input.category}".`);
  }
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM input_items');
  const record = {
    id: uuid(),
    code: (input.code?.trim() || `VT-${String((count?.n ?? 0) + 1).padStart(4, '0')}`).toUpperCase(),
    name: input.name.trim(),
    category: input.category,
    uom: input.uom ?? 'kg',
    active_ingredient: input.activeIngredient ?? null,
    phi_days: input.phiDays ?? null,
    permitted: input.permitted === false ? 0 : 1,
    permit_ref: input.permitRef ?? null,
    htx_id: input.htxId ?? null,
    created_at: nowIso(),
  };
  insert('input_items', record);
  logEvent({ module: 'htx', entityType: 'input_items', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function listItems(filter: { category?: string; htxId?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.category) { clauses.push('category = ?'); params.push(filter.category); }
  // HTX thấy danh mục dùng chung + danh mục riêng của mình.
  if (filter.htxId) { clauses.push('(htx_id IS NULL OR htx_id = ?)'); params.push(filter.htxId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT * FROM input_items ${where} ORDER BY category, name`, params);
}

// =====================================================================
// Mua sắm
// =====================================================================

export interface PurchaseLineInput {
  itemId: string;
  qty: number;
  unitPrice?: number;
  batchNo?: string;
  expiryDate?: string;
}

/**
 * Tạo phiếu mua và NHẬP KHO ngay theo từng lô.
 *
 * Mỗi dòng phiếu mua tạo một bản ghi tồn kho riêng theo số lô, không cộng dồn
 * vào một con số tổng (IN-01).
 */
export function createPurchase(
  input: {
    htxId: string; supplier?: string; invoiceNo?: string; purchaseDate?: string;
    note?: string; lines: PurchaseLineInput[];
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const htx = one<{ id: string }>('SELECT id FROM cooperatives WHERE id = ?', [input.htxId]);
  if (!htx) throw new Error('Không tìm thấy hợp tác xã.');
  if (!input.lines?.length) throw new Error('Phiếu mua phải có ít nhất một dòng vật tư.');

  const purchaseDate = input.purchaseDate ?? nowIso().slice(0, 10);

  return transaction(() => {
    const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM input_purchases');
    const purchase = {
      id: uuid(),
      code: `MVT-${String((count?.n ?? 0) + 1).padStart(5, '0')}`,
      htx_id: input.htxId,
      supplier: input.supplier ?? null,
      invoice_no: input.invoiceNo ?? null,
      purchase_date: purchaseDate,
      status: 'da_nhan',
      total_amount: 0,
      note: input.note ?? null,
      created_by: actor.name ?? null,
      created_at: nowIso(),
    };
    insert('input_purchases', purchase);

    let total = 0;
    for (const line of input.lines) {
      const item = one<{ id: string; name: string; uom: string }>(
        'SELECT id, name, uom FROM input_items WHERE id = ?', [line.itemId],
      );
      if (!item) throw new Error(`Không tìm thấy vật tư ${line.itemId}.`);
      if (!(line.qty > 0)) throw new Error(`Số lượng mua của "${item.name}" phải lớn hơn 0.`);
      if (line.expiryDate && line.expiryDate < purchaseDate) {
        throw new Error(`Vật tư "${item.name}" có hạn sử dụng ${line.expiryDate} đã qua ngày mua.`);
      }
      const unitPrice = line.unitPrice ?? 0;
      total += line.qty * unitPrice;

      insert('input_purchase_lines', {
        id: uuid(),
        purchase_id: purchase.id,
        item_id: line.itemId,
        batch_no: line.batchNo ?? null,
        expiry_date: line.expiryDate ?? null,
        qty: line.qty,
        unit_price: unitPrice,
      });

      // Nhập kho theo lô — mỗi lô một dòng tồn riêng (IN-01).
      insert('input_stock', {
        id: uuid(),
        htx_id: input.htxId,
        item_id: line.itemId,
        batch_no: line.batchNo ?? null,
        expiry_date: line.expiryDate ?? null,
        qty_on_hand: line.qty,
        unit_cost: unitPrice,
        purchase_id: purchase.id,
        updated_at: nowIso(),
      });
    }

    update('input_purchases', purchase.id, { total_amount: Math.round(total) });
    logEvent({ module: 'htx', entityType: 'input_purchases', entityId: purchase.id, action: 'create', after: purchase }, actor);
    return getPurchase(purchase.id)!;
  });
}

export function getPurchase(id: string): Record<string, unknown> | null {
  const purchase = one<Record<string, unknown>>('SELECT * FROM input_purchases WHERE id = ?', [id]);
  if (!purchase) return null;
  const lines = all(
    `SELECT l.*, i.name AS item_name, i.uom, i.category
       FROM input_purchase_lines l JOIN input_items i ON i.id = l.item_id
      WHERE l.purchase_id = ?`,
    [id],
  );
  return { ...purchase, lines };
}

export function listPurchases(htxId: string): Record<string, unknown>[] {
  return all(
    `SELECT p.*, (SELECT COUNT(*) FROM input_purchase_lines l WHERE l.purchase_id = p.id) AS line_count
       FROM input_purchases p WHERE p.htx_id = ? ORDER BY p.purchase_date DESC, p.created_at DESC`,
    [htxId],
  );
}

// =====================================================================
// Tồn kho
// =====================================================================

export function stockOnHand(htxId: string, options: { includeEmpty?: boolean } = {}): Record<string, unknown>[] {
  const today = nowIso().slice(0, 10);
  const rows = all<Record<string, unknown>>(
    `SELECT s.*, i.name AS item_name, i.category, i.uom, i.active_ingredient,
            i.phi_days, i.permitted
       FROM input_stock s JOIN input_items i ON i.id = s.item_id
      WHERE s.htx_id = ? ${options.includeEmpty ? '' : 'AND s.qty_on_hand > 0'}
      ORDER BY i.category, i.name, s.expiry_date`,
    [htxId],
  );
  return rows.map((row) => {
    const expiry = row.expiry_date as string | null;
    const daysLeft = expiry
      ? Math.round((new Date(`${expiry}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY_MS)
      : null;
    return {
      ...row,
      expired: expiry ? expiry < today : false,
      daysToExpiry: daysLeft,
      // Cảnh báo sớm để HTX dùng trước, tránh phải huỷ.
      nearExpiry: daysLeft !== null && daysLeft >= 0 && daysLeft <= 60,
    };
  });
}

/** Tổng hợp tồn kho theo vật tư (cộng các lô) — chỉ để hiển thị. */
export function stockSummary(htxId: string): Record<string, unknown>[] {
  return all(
    `SELECT i.id AS item_id, i.name AS item_name, i.category, i.uom,
            SUM(s.qty_on_hand) AS qty_on_hand,
            COUNT(*) AS batch_count,
            MIN(s.expiry_date) AS earliest_expiry
       FROM input_stock s JOIN input_items i ON i.id = s.item_id
      WHERE s.htx_id = ? AND s.qty_on_hand > 0
      GROUP BY i.id ORDER BY i.category, i.name`,
    [htxId],
  );
}

// =====================================================================
// Cấp phát xuống thửa ruộng
// =====================================================================

export interface IssueInput {
  stockId: string;
  plotId: string;
  qty: number;
  planStepId?: string | null;
  farmerId?: string | null;
  issueDate?: string;
  note?: string;
}

export interface IssueResult {
  issue: Record<string, unknown>;
  remainingQty: number;
  warnings: string[];
}

export function issueToPlot(input: IssueInput, actor: AuditActor = {}): IssueResult {
  const stock = one<{
    id: string; htx_id: string; item_id: string; batch_no: string | null;
    expiry_date: string | null; qty_on_hand: number;
  }>('SELECT * FROM input_stock WHERE id = ?', [input.stockId]);
  if (!stock) throw new Error('Không tìm thấy lô vật tư trong kho.');

  const item = one<{
    id: string; name: string; uom: string; category: string;
    permitted: number; phi_days: number | null; permit_ref: string | null;
  }>('SELECT * FROM input_items WHERE id = ?', [stock.item_id])!;

  const plot = one<{ id: string; code: string; htx_id: string }>(
    'SELECT id, code, htx_id FROM plots WHERE id = ?', [input.plotId],
  );
  if (!plot) throw new Error('Không tìm thấy thửa ruộng.');

  // IN-06
  if (plot.htx_id !== stock.htx_id) {
    throw new Error(`Thửa ${plot.code} không thuộc HTX đang giữ lô vật tư này.`);
  }
  if (!(input.qty > 0)) throw new Error('Số lượng cấp phát phải lớn hơn 0.');
  // IN-02
  if (input.qty > stock.qty_on_hand) {
    throw new Error(
      `Tồn kho lô ${stock.batch_no ?? '(không số lô)'} chỉ còn ${stock.qty_on_hand} ${item.uom}, ` +
      `không cấp được ${input.qty} ${item.uom}.`,
    );
  }

  const issueDate = input.issueDate ?? nowIso().slice(0, 10);
  // IN-03
  if (stock.expiry_date && stock.expiry_date < issueDate) {
    throw new Error(
      `Lô ${stock.batch_no ?? '(không số lô)'} của "${item.name}" đã hết hạn ngày ${stock.expiry_date} — ` +
      'không được cấp phát ra đồng ruộng.',
    );
  }
  // IN-04
  if (!item.permitted) {
    throw new Error(
      `"${item.name}" không nằm trong danh mục được phép sử dụng — cấp phát sẽ làm cả lô lúa mất chuẩn VietGAP.`,
    );
  }

  const warnings: string[] = [];

  // Xác định vụ đang canh tác trên thửa để gắn truy xuất.
  const cycle = one<{ id: string; code: string }>(
    "SELECT id, code FROM crop_cycles WHERE plot_id = ? AND status = 'dang_canh_tac' ORDER BY created_at DESC LIMIT 1",
    [input.plotId],
  );
  if (!cycle) {
    warnings.push(
      `Thửa ${plot.code} không có vụ đang canh tác — phiếu cấp phát này sẽ không gắn được vào hồ sơ truy xuất của vụ nào.`,
    );
  }

  // IN-05: thuốc BVTV có thời gian cách ly thì đối chiếu ngày thu hoạch dự kiến.
  if (item.phi_days && cycle) {
    const harvestStep = one<{ planned_date: string; name: string }>(
      `SELECT s.planned_date, s.name
         FROM production_plan_steps s
         JOIN production_plans pl ON pl.id = s.plan_id
        WHERE pl.crop_cycle_id = ? AND s.activity = 'thu_hoach'
        ORDER BY s.planned_date LIMIT 1`,
      [cycle.id],
    );
    if (harvestStep) {
      const earliest = addDays(issueDate, item.phi_days);
      if (harvestStep.planned_date < earliest) {
        warnings.push(
          `"${item.name}" cần cách ly ${item.phi_days} ngày. Cấp phát ngày ${issueDate} thì sớm nhất ` +
          `được thu hoạch từ ${earliest}, trong khi kế hoạch dự kiến thu hoạch ngày ${harvestStep.planned_date}. ` +
          'Phải dời lịch phun hoặc lịch thu hoạch.',
        );
      }
    }
  }

  return transaction(() => {
    const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM input_issues');
    const record = {
      id: uuid(),
      code: `CPVT-${String((count?.n ?? 0) + 1).padStart(5, '0')}`,
      htx_id: stock.htx_id,
      stock_id: stock.id,
      item_id: stock.item_id,
      plot_id: input.plotId,
      crop_cycle_id: cycle?.id ?? null,
      plan_step_id: input.planStepId ?? null,
      farmer_id: input.farmerId ?? null,
      qty: input.qty,
      issue_date: issueDate,
      note: input.note ?? null,
      issued_by: actor.name ?? null,
      created_at: nowIso(),
    };
    insert('input_issues', record);
    update('input_stock', stock.id, {
      qty_on_hand: Math.round((stock.qty_on_hand - input.qty) * 10_000) / 10_000,
      updated_at: nowIso(),
    });
    logEvent({ module: 'htx', entityType: 'input_issues', entityId: record.id, action: 'create', after: record }, actor);
    return {
      issue: record,
      remainingQty: Math.round((stock.qty_on_hand - input.qty) * 10_000) / 10_000,
      warnings,
    };
  });
}

export function listIssues(filter: { htxId?: string; plotId?: string; cropCycleId?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.htxId) { clauses.push('e.htx_id = ?'); params.push(filter.htxId); }
  if (filter.plotId) { clauses.push('e.plot_id = ?'); params.push(filter.plotId); }
  if (filter.cropCycleId) { clauses.push('e.crop_cycle_id = ?'); params.push(filter.cropCycleId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT e.*, i.name AS item_name, i.uom, i.category, i.active_ingredient, i.phi_days,
            s.batch_no, s.expiry_date, p.code AS plot_code, f.full_name AS farmer_name,
            st.name AS step_name
       FROM input_issues e
       JOIN input_items i ON i.id = e.item_id
       JOIN input_stock s ON s.id = e.stock_id
       JOIN plots p ON p.id = e.plot_id
       LEFT JOIN farmers f ON f.id = e.farmer_id
       LEFT JOIN production_plan_steps st ON st.id = e.plan_step_id
       ${where}
      ORDER BY e.issue_date DESC, e.created_at DESC`,
    params,
  );
}

/**
 * Hồ sơ vật tư của một vụ — phần bắt buộc của hồ sơ truy xuất VietGAP.
 * Trả lời được: lô nào, hoạt chất gì, xuống thửa nào, ngày nào, ai nhận.
 */
export function inputTraceability(cropCycleId: string): Record<string, unknown> {
  const issues = listIssues({ cropCycleId });
  const byCategory = new Map<string, number>();
  for (const issue of issues) {
    const key = String(issue.category);
    byCategory.set(key, (byCategory.get(key) ?? 0) + Number(issue.qty));
  }
  return {
    issues,
    totalIssues: issues.length,
    byCategory: [...byCategory.entries()].map(([category, qty]) => ({ category, qty })),
    pesticides: issues.filter((issue) => issue.category === 'thuoc_bvtv'),
  };
}

/** Bảng điều hành vật tư: tồn kho, sắp hết hạn, đã cấp phát trong kỳ. */
export function inputDashboard(htxId: string): Record<string, unknown> {
  const stock = stockOnHand(htxId);
  const issues = listIssues({ htxId });
  const purchases = listPurchases(htxId);
  return {
    stockLines: stock.length,
    expiredLines: stock.filter((row) => row.expired).length,
    nearExpiryLines: stock.filter((row) => row.nearExpiry).length,
    totalPurchaseAmount: purchases.reduce((acc, row) => acc + Number(row.total_amount ?? 0), 0),
    issueCount: issues.length,
    plotsServed: new Set(issues.map((row) => row.plot_id)).size,
    summary: stockSummary(htxId),
  };
}
