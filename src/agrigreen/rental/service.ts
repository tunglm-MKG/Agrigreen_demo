/**
 * Sàn cơ giới hóa (Rental & Booking Marketplace).
 *
 * ERP Product Vision v1.2 xác định đây là sản phẩm thương mại hoá sớm nhất
 * (H1/2027) nhưng chưa có BRD; module này hiện thực vòng đời lệnh thuê P2P:
 *   đặt lịch → xác nhận → thực hiện → hoàn thành / tranh chấp
 * và quy trình xử lý tranh chấp (khoảng trống mức Cao trong Risk Register).
 *
 * Ranh giới kiến trúc: giữ tiền/giải ngân thuộc Payment (Core Service); module
 * này chỉ phát lệnh và ghi nhận trạng thái escrow, còn Finance tính phí nền tảng.
 */
import { all, insert, one, transaction, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { haversineKm } from '../../platform/geo/geo.ts';
import { recordPlatformFee } from '../../erp/finance/service.ts';
import { forbidden } from '../../platform/http/router.ts';

/**
 * Phạm vi của người gọi (review 24/09/2026, R2): tài khoản gắn HTX chỉ thấy/sửa lệnh thuê mà HTX mình
 * là BÊN THUÊ hoặc BÊN CHO THUÊ (HTX sở hữu máy). `htxId = null` = không ràng buộc (quản trị, DCRD).
 * Sàn cho thuê chéo HTX nên KHÔNG chặn theo "máy của HTX khác"; chặn theo vai trò trong giao dịch.
 */
export interface RentalScope { htxId: string | null }
const OPEN_SCOPE: RentalScope = { htxId: null };

interface OrderParties { renter_htx_id: string; owner_htx_id: string | null; status: string }
function orderParties(orderId: string): OrderParties | null {
  return one<OrderParties>(
    `SELECT o.renter_htx_id, m.htx_id AS owner_htx_id, o.status
     FROM rental_orders o JOIN rental_listings l ON l.id = o.listing_id JOIN machines m ON m.id = l.machine_id WHERE o.id = ?`,
    [orderId],
  );
}
function partyRole(parties: OrderParties, scope: RentalScope): 'renter' | 'owner' | 'both' | 'none' | 'open' {
  if (!scope.htxId) return 'open';
  const renter = parties.renter_htx_id === scope.htxId;
  const owner = parties.owner_htx_id === scope.htxId;
  return renter && owner ? 'both' : renter ? 'renter' : owner ? 'owner' : 'none';
}
/** Bên thuê chỉ được huỷ khi mới đặt lịch hoặc mở tranh chấp; bên cho thuê điều khiển tiến trình thực hiện. */
const RENTER_TRANSITIONS: Record<string, OrderStatus[]> = { dat_lich: ['huy'], xac_nhan: ['tranh_chap'], thuc_hien: ['tranh_chap'] };
const OWNER_TRANSITIONS: Record<string, OrderStatus[]> = { dat_lich: ['xac_nhan', 'huy'], xac_nhan: ['thuc_hien', 'huy', 'tranh_chap'], thuc_hien: ['hoan_thanh', 'tranh_chap'] };
function assertMayAdvance(parties: OrderParties, next: OrderStatus, scope: RentalScope): void {
  const role = partyRole(parties, scope);
  if (role === 'open') return;
  if (role === 'none') throw forbidden('Bạn không phải bên thuê hay bên cho thuê của lệnh này.');
  const allowed = new Set<OrderStatus>([
    ...(role === 'renter' || role === 'both' ? RENTER_TRANSITIONS[parties.status] ?? [] : []),
    ...(role === 'owner' || role === 'both' ? OWNER_TRANSITIONS[parties.status] ?? [] : []),
  ]);
  if (!allowed.has(next)) throw forbidden(`Vai trò ${role === 'renter' ? 'bên thuê' : 'bên cho thuê'} không được chuyển lệnh từ "${parties.status}" sang "${next}".`);
}

export const ORDER_FLOW = ['dat_lich', 'xac_nhan', 'thuc_hien', 'hoan_thanh'] as const;
export type OrderStatus = (typeof ORDER_FLOW)[number] | 'tranh_chap' | 'huy';

const ALLOWED_TRANSITIONS: Record<string, OrderStatus[]> = {
  dat_lich: ['xac_nhan', 'huy'],
  xac_nhan: ['thuc_hien', 'huy', 'tranh_chap'],
  thuc_hien: ['hoan_thanh', 'tranh_chap'],
  hoan_thanh: ['tranh_chap'],
  tranh_chap: ['hoan_thanh', 'huy'],
  huy: [],
};

// ---------------------------------------------------------------------------
// Tin đăng cho thuê
// ---------------------------------------------------------------------------

export function createListing(
  input: {
    machineId: string; pricePerHa?: number; pricePerDay?: number;
    serviceRadiusKm?: number; availableFrom?: string; availableTo?: string;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const machine = one<{ id: string; owner_id: string; condition: string }>(
    'SELECT id, owner_id, condition FROM machines WHERE id = ?',
    [input.machineId],
  );
  if (!machine) throw new Error('Không tìm thấy máy');
  if (machine.condition !== 'hoat_dong') {
    throw new Error('Chỉ máy ở tình trạng "Hoạt động" mới được đăng cho thuê.');
  }
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM rental_listings');
  const record = {
    id: uuid(),
    code: sequenceCode('TD', (count?.n ?? 0) + 1, 5),
    machine_id: input.machineId,
    owner_id: machine.owner_id,
    price_per_ha: input.pricePerHa ?? 0,
    price_per_day: input.pricePerDay ?? 0,
    service_radius_km: input.serviceRadiusKm ?? 20,
    available_from: input.availableFrom ?? null,
    available_to: input.availableTo ?? null,
    status: 'active',
    created_at: nowIso(),
  };
  insert('rental_listings', record);
  logEvent({ module: 'rental', entityType: 'rental_listings', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

/** Tìm & so sánh máy theo khâu sản xuất, khoảng cách và giá. */
export function searchListings(query: {
  stage?: string; lat?: number; lng?: number; maxDistanceKm?: number; from?: string; to?: string;
}): Record<string, unknown>[] {
  const rows = all<{
    id: string; code: string; price_per_ha: number; price_per_day: number; service_radius_km: number;
    available_from: string | null; available_to: string | null;
    machine_code: string; machine_type_name: string; stage: string; brand: string | null; model: string | null;
    owner_name: string; owner_phone: string | null; htx_name: string | null; lat: number | null; lng: number | null;
  }>(
    `SELECT l.id, l.code, l.price_per_ha, l.price_per_day, l.service_radius_km, l.available_from, l.available_to,
            m.code AS machine_code, mt.name AS machine_type_name, mt.stage, m.brand, m.model,
            mo.name AS owner_name, mo.phone AS owner_phone, c.name AS htx_name, c.lat, c.lng
     FROM rental_listings l
     JOIN machines m ON m.id = l.machine_id
     JOIN machine_types mt ON mt.id = m.machine_type_id
     JOIN machine_owners mo ON mo.id = l.owner_id
     LEFT JOIN cooperatives c ON c.id = m.htx_id
     WHERE l.status = 'active' AND m.condition = 'hoat_dong'
       ${query.stage ? 'AND mt.stage = ?' : ''}
     ORDER BY l.price_per_ha`,
    query.stage ? [query.stage] : [],
  );

  return rows
    .map((row) => {
      const distanceKm =
        query.lat !== undefined && query.lng !== undefined && row.lat !== null && row.lng !== null
          ? Math.round(haversineKm({ lat: query.lat, lng: query.lng }, { lat: row.lat, lng: row.lng }) * 100) / 100
          : null;
      return { ...row, distanceKm, withinServiceRadius: distanceKm === null ? true : distanceKm <= row.service_radius_km };
    })
    .filter((row) => {
      if (query.maxDistanceKm && row.distanceKm !== null && row.distanceKm > query.maxDistanceKm) return false;
      if (query.from && row.available_to && row.available_to < query.from) return false;
      if (query.to && row.available_from && row.available_from > query.to) return false;
      return row.withinServiceRadius;
    });
}

// ---------------------------------------------------------------------------
// Lệnh thuê
// ---------------------------------------------------------------------------

export function bookOrder(
  input: { listingId: string; renterHtxId: string; plotId?: string; areaHa: number; from: string; to: string },
  actor: AuditActor = {},
  scope: RentalScope = OPEN_SCOPE,
): Record<string, unknown> {
  if (scope.htxId && input.renterHtxId !== scope.htxId) throw forbidden('Chỉ đặt thuê được cho hợp tác xã của mình.');
  const listing = one<{ id: string; price_per_ha: number; price_per_day: number; status: string }>(
    'SELECT id, price_per_ha, price_per_day, status FROM rental_listings WHERE id = ?',
    [input.listingId],
  );
  if (!listing || listing.status !== 'active') throw new Error('Tin đăng không khả dụng');

  // Kiểm tra trùng lịch với các lệnh chưa kết thúc.
  const clash = one(
    `SELECT id FROM rental_orders WHERE listing_id = ?
     AND status IN ('dat_lich','xac_nhan','thuc_hien')
     AND NOT (scheduled_to < ? OR scheduled_from > ?)`,
    [input.listingId, input.from, input.to],
  );
  if (clash) throw new Error('Khoảng thời gian này đã có lệnh thuê khác — chọn lịch khác.');

  const days = Math.max(
    1,
    Math.ceil((new Date(input.to).getTime() - new Date(input.from).getTime()) / 86_400_000),
  );
  const amount = listing.price_per_ha > 0 ? listing.price_per_ha * input.areaHa : listing.price_per_day * days;
  const platformFee = Math.round(amount * platformFeeRate('rental'));

  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM rental_orders');
  const record = {
    id: uuid(),
    code: sequenceCode('LT', (count?.n ?? 0) + 1, 6),
    listing_id: input.listingId,
    renter_htx_id: input.renterHtxId,
    plot_id: input.plotId ?? null,
    area_ha: input.areaHa,
    scheduled_from: input.from,
    scheduled_to: input.to,
    amount: Math.round(amount),
    platform_fee: platformFee,
    status: 'dat_lich',
    escrow_status: 'chua_giu',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('rental_orders', record);
  logEvent({ module: 'rental', entityType: 'rental_orders', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

function platformFeeRate(appliesTo: string): number {
  const rule = one<{ rate_pct: number }>(
    "SELECT rate_pct FROM revenue_rules WHERE kind = 'transaction_fee' AND applies_to = ? AND active = 1",
    [appliesTo],
  );
  return (rule?.rate_pct ?? 0) / 100;
}

export function advanceOrder(
  id: string,
  next: OrderStatus,
  actor: AuditActor = {},
  scope: RentalScope = OPEN_SCOPE,
): Record<string, unknown> {
  const before = one<{ id: string; status: string; amount: number; platform_fee: number; renter_htx_id: string }>(
    'SELECT * FROM rental_orders WHERE id = ?',
    [id],
  );
  if (!before) throw new Error('Không tìm thấy lệnh thuê');
  const parties = orderParties(id);
  if (parties) assertMayAdvance(parties, next, scope);
  const allowed = ALLOWED_TRANSITIONS[before.status] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Không thể chuyển trạng thái từ "${before.status}" sang "${next}".`);
  }

  const values: Record<string, unknown> = { status: next, updated_at: nowIso() };
  // Payment (Core Service) giữ tiền khi lệnh được xác nhận và giải ngân khi hoàn thành.
  if (next === 'xac_nhan') values.escrow_status = 'dang_giu';
  if (next === 'hoan_thanh') values.escrow_status = 'da_giai_ngan';
  if (next === 'huy') values.escrow_status = before.status === 'dat_lich' ? 'chua_giu' : 'hoan_tien';

  transaction(() => {
    update('rental_orders', id, values);
    if (next === 'hoan_thanh') {
      // Finance chỉ tiêu thụ kết quả giao dịch để ghi nhận phí nền tảng.
      recordPlatformFee({
        refType: 'rental_order',
        refId: id,
        amount: before.platform_fee,
        description: `Phí nền tảng lệnh thuê ${id}`,
        htxId: before.renter_htx_id,
      });
    }
  });

  const after = one('SELECT * FROM rental_orders WHERE id = ?', [id])!;
  logEvent({ module: 'rental', entityType: 'rental_orders', entityId: id, action: 'update', before, after }, actor);
  return after;
}

export function listOrders(filter: { htxId?: string; status?: string } = {}, scope: RentalScope = OPEN_SCOPE): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope.htxId) {
    // Tài khoản HTX: chỉ lệnh mà mình là bên thuê hoặc bên cho thuê.
    clauses.push('(o.renter_htx_id = ? OR m.htx_id = ?)');
    params.push(scope.htxId, scope.htxId);
  }
  if (filter.htxId) {
    clauses.push('o.renter_htx_id = ?');
    params.push(filter.htxId);
  }
  if (filter.status) {
    clauses.push('o.status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT o.*, l.code AS listing_code, m.code AS machine_code, mt.name AS machine_type_name, mt.stage,
            c.name AS renter_name, mo.name AS owner_name
     FROM rental_orders o
     JOIN rental_listings l ON l.id = o.listing_id
     JOIN machines m ON m.id = l.machine_id
     JOIN machine_types mt ON mt.id = m.machine_type_id
     JOIN machine_owners mo ON mo.id = l.owner_id
     LEFT JOIN cooperatives c ON c.id = o.renter_htx_id
     ${where} ORDER BY o.created_at DESC`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Quy trình xử lý tranh chấp (khoảng trống được nêu trong Risk Register)
// ---------------------------------------------------------------------------

export function openDispute(
  input: { orderId: string; reason: string; detail?: string },
  actor: AuditActor = {},
  scope: RentalScope = OPEN_SCOPE,
): Record<string, unknown> {
  const order = one<{ id: string; status: string }>('SELECT id, status FROM rental_orders WHERE id = ?', [input.orderId]);
  if (!order) throw new Error('Không tìm thấy lệnh thuê');
  const parties = orderParties(input.orderId);
  if (parties && partyRole(parties, scope) === 'none') throw forbidden('Chỉ bên thuê hoặc bên cho thuê mới mở được khiếu nại cho lệnh này.');
  const record = {
    id: uuid(),
    order_id: input.orderId,
    reason: input.reason,
    detail: input.detail ?? null,
    status: 'mo',
    resolution: null,
    opened_by: actor.name ?? null,
    created_at: nowIso(),
    closed_at: null,
  };
  transaction(() => {
    insert('rental_disputes', record);
    update('rental_orders', input.orderId, { status: 'tranh_chap', updated_at: nowIso() });
  });
  logEvent({ module: 'rental', entityType: 'rental_disputes', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function resolveDispute(
  id: string,
  input: { resolution: string; orderOutcome: 'hoan_thanh' | 'huy' },
  actor: AuditActor = {},
): Record<string, unknown> {
  const dispute = one<{ id: string; order_id: string; status: string }>('SELECT * FROM rental_disputes WHERE id = ?', [id]);
  if (!dispute) throw new Error('Không tìm thấy khiếu nại');
  if (dispute.status === 'dong') throw new Error('Khiếu nại đã đóng.');
  update('rental_disputes', id, { status: 'dong', resolution: input.resolution, closed_at: nowIso() });
  advanceOrder(dispute.order_id, input.orderOutcome, actor);
  const after = one('SELECT * FROM rental_disputes WHERE id = ?', [id])!;
  logEvent({ module: 'rental', entityType: 'rental_disputes', entityId: id, action: 'approve', after }, actor);
  return after;
}

export function listDisputes(status?: string, scope: RentalScope = OPEN_SCOPE): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status) { clauses.push('d.status = ?'); params.push(status); }
  if (scope.htxId) { clauses.push('(o.renter_htx_id = ? OR m.htx_id = ?)'); params.push(scope.htxId, scope.htxId); }
  return all(
    `SELECT d.*, o.code AS order_code FROM rental_disputes d
     JOIN rental_orders o ON o.id = d.order_id JOIN rental_listings l ON l.id = o.listing_id JOIN machines m ON m.id = l.machine_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY d.created_at DESC`,
    params,
  );
}

export function marketplaceDashboard(): Record<string, unknown> {
  return {
    listings: one('SELECT COUNT(*) AS total FROM rental_listings WHERE status = \'active\''),
    ordersByStatus: all('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM rental_orders GROUP BY status'),
    revenue: one(
      "SELECT COALESCE(SUM(platform_fee), 0) AS platform_fee, COALESCE(SUM(amount), 0) AS gmv FROM rental_orders WHERE status = 'hoan_thanh'",
    ),
    disputes: all('SELECT status, COUNT(*) AS n FROM rental_disputes GROUP BY status'),
    topStages: all(
      `SELECT mt.stage, COUNT(*) AS orders, COALESCE(SUM(o.amount),0) AS amount
       FROM rental_orders o JOIN rental_listings l ON l.id = o.listing_id
       JOIN machines m ON m.id = l.machine_id JOIN machine_types mt ON mt.id = m.machine_type_id
       GROUP BY mt.stage ORDER BY orders DESC`,
    ),
  };
}
