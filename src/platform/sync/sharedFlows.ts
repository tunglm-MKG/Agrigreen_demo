/**
 * LUỒNG ĐỒNG BỘ DỮ LIỆU DÙNG CHUNG — dữ liệu dùng chung nằm ở CSDL `shared`, mỗi hệ
 * thống con nhận đúng phần mình cần, theo đúng chiều đã khai.
 *
 * Nguyên tắc: mỗi thực thể dùng chung có MỘT chủ sở hữu (hệ thống được ghi) và một
 * danh sách hệ thống được nhận. Không hệ thống nào giữ bản sao riêng để rồi lệch
 * nhau; và không hệ thống nào tự ý đọc thứ không nằm trong luồng của mình.
 *
 * Cơ chế: nguồn sự thật của mọi thay đổi là `event_log` (append-only, đã ghi trước /
 * sau cho mọi thao tác nghiệp vụ). Nạp dữ liệu nền ban đầu (seed, nhập Excel hàng
 * loạt) không đi qua nhật ký — hệ thống con tách ra khởi tạo từ một bản chụp
 * (`daily_snapshots`) rồi mới theo feed, đúng như mọi cơ chế sao chép theo nhật ký.
 *
 * Luồng đồng bộ = đọc event_log theo entity_type thuộc tập dùng chung, lọc theo hệ
 * thống nhận, đưa ra dạng FEED; hệ thống nhận đọc đến đâu thì ACK (con trỏ) đến đó. Cùng một tiến trình, các hệ thống con đọc CSDL shared
 * đã ATTACH nên không cần sao chép; khi một hệ thống con tách ra chạy riêng (một tỉnh
 * tự vận hành Khuyến nông), nó kéo feed này qua API và ack — mã nghiệp vụ không đổi.
 */
import { all, one, run } from '../db/db.ts';
import { nowIso } from '../util/ids.ts';
import { domainOf, tablesOf, type Domain } from '../db/domains.ts';
import type { SystemCode } from '../auth/rbac.ts';

export type Receiver = SystemCode | '*';

export interface SharedFlow {
  entity: string;
  label: string;
  /** Hệ thống được GHI thực thể này (nguồn phát sinh). `platform` = quản trị nền tảng. */
  owner: SystemCode | 'platform';
  /** Hệ thống khác cũng được ghi (ví dụ KN vẽ thửa và gán cho HTX). */
  coWriters?: SystemCode[];
  /** Hệ thống nhận thay đổi. `*` = mọi hệ thống. */
  receivers: Receiver[];
  why: string;
}

export const SHARED_FLOWS: SharedFlow[] = [
  { entity: 'users', label: 'Tài khoản', owner: 'platform', receivers: ['*'], why: 'Một định danh cho mọi cổng; khoá ở đâu cũng là khoá' },
  { entity: 'user_roles', label: 'Nhóm của tài khoản', owner: 'platform', receivers: ['*'], why: 'Quyền có hiệu lực ở mọi hệ thống ngay khi đổi' },
  { entity: 'admin_scopes', label: 'Phạm vi quản trị', owner: 'platform', receivers: ['*'], why: 'Admin tỉnh được uỷ quyền ở đâu thì cổng đó phải biết' },
  { entity: 'admin_units', label: 'Đơn vị hành chính', owner: 'platform', receivers: ['*'], why: 'Tỉnh / xã sau sáp nhập 2025 dùng chung một danh mục' },
  { entity: 'seasons', label: 'Mùa vụ', owner: 'platform', receivers: ['*'], why: 'Cùng một lịch vụ cho HTX, CGH, ERP' },
  { entity: 'cooperatives', label: 'Hồ sơ hợp tác xã', owner: 'kn', coWriters: ['htx'], receivers: ['htx', 'cgh', 'gis', 'erp', 'field'], why: 'KN khởi tạo theo MST; HTX kích hoạt thừa hưởng; ERP ký hợp đồng; hiện trường thu gom' },
  { entity: 'farmers', label: 'Hộ nông dân', owner: 'htx', coWriters: ['kn'], receivers: ['kn'], why: 'Khảo sát khuyến nông cần danh sách hộ; ERP không cần dữ liệu cá nhân' },
  { entity: 'plots', label: 'Thửa ruộng', owner: 'htx', coWriters: ['kn'], receivers: ['kn', 'gis', 'field', 'erp'], why: 'Kế hoạch sản xuất, bản đồ, việc thu gom và phiếu nhập kho đều bám vào thửa' },
  { entity: 'harvest_statistics', label: 'Thống kê sản lượng', owner: 'htx', receivers: ['erp', 'cgh', 'kn'], why: 'Đầu vào mô phỏng Hub (tham số #5) và cân đối máy' },
  { entity: 'crop_status', label: 'Trạng thái mùa vụ', owner: 'htx', coWriters: ['kn'], receivers: ['gis', 'field', 'erp', 'kn'], why: 'Heatmap GIS và lịch gặt của đội thu gom' },
  { entity: 'commune_crop_seasons', label: 'Vụ mùa theo xã (nhập Excel)', owner: 'kn', receivers: ['gis', 'erp', 'field'], why: 'Đường cong nguồn cung theo ngày cho mô phỏng và kế hoạch thu gom' },
  { entity: 'commune_harvest_progress', label: 'Tiến độ thu hoạch theo xã', owner: 'kn', receivers: ['gis', 'erp', 'field'], why: 'Cập nhật đường cong nguồn cung khi xã báo tiến độ gặt thực tế' },
  { entity: 'weather_observations', label: 'Quan trắc thời tiết', owner: 'kn', receivers: ['htx', 'field'], why: 'Khuyến cáo cho HTX; tránh xếp cuộn rơm ngày mưa' },
  { entity: 'facilities', label: 'Cơ sở: Hub, kho, nhà máy', owner: 'erp', receivers: ['gis', 'field', 'htx'], why: 'Điểm đến của ghe rơm; điểm hiển thị trên bản đồ' },
  { entity: 'machine_types', label: 'Loại máy', owner: 'cgh', receivers: ['htx', 'field', 'erp'], why: 'Danh mục dùng chung cho thuê máy và đội thu gom' },
  { entity: 'machine_owners', label: 'Chủ máy', owner: 'cgh', receivers: ['htx'], why: 'Sàn cho thuê máy' },
  { entity: 'machines', label: 'Máy móc', owner: 'cgh', coWriters: ['htx'], receivers: ['htx', 'field', 'erp'], why: 'HTX kê khai máy, hiện trường liên kết phương tiện, ERP mô phỏng năng lực' },
  { entity: 'partners', label: 'Đối tác', owner: 'erp', receivers: ['htx'], why: 'HTX thấy ai mua rơm của mình' },
  { entity: 'items', label: 'Danh mục hàng hoá', owner: 'erp', receivers: ['htx', 'field'], why: 'Rơm cuộn / rơm xá — một mã cho cả chuỗi' },
  { entity: 'attachments', label: 'Tệp đính kèm / bằng chứng', owner: 'platform', receivers: ['*'], why: 'Bằng chứng nộp ở cổng nào cũng kiểm được ở ERP / MRV' },
  { entity: 'rice_varieties', label: 'Danh mục giống lúa', owner: 'htx', coWriters: ['kn'], receivers: ['kn', 'cgh', 'gis', 'erp'], why: 'Một mã giống cho mở vụ, báo cáo gieo sạ và tham số mô phỏng' },
  { entity: 'report_schedules', label: 'Lịch gửi báo cáo định kỳ', owner: 'platform', receivers: ['*'], why: 'Lịch đặt ở cổng nào cũng do một bộ hẹn giờ nền tảng chạy' },
  { entity: 'notifications', label: 'Thông báo', owner: 'platform', receivers: ['*'], why: 'Chuông trên mọi cổng đọc cùng một hộp' },
];

/** Bảng dùng chung không đi qua luồng (nội bộ nền tảng, không phải dữ liệu nghiệp vụ). */
export const PLATFORM_INTERNAL_TABLES = new Set([
  'user_groups', 'group_permissions', 'sessions', 'event_log', 'daily_snapshots', 'retention_policy', 'sync_log',
  'shared_sync_cursor', 'system_config', 'schema_migrations', 'rate_limits', 'request_log',
]);

export function flowsFor(system: SystemCode): SharedFlow[] {
  return SHARED_FLOWS.filter((f) => f.receivers.includes('*') || f.receivers.includes(system) || f.owner === system || f.coWriters?.includes(system));
}

/** Mọi bảng dùng chung phải hoặc có luồng, hoặc là nội bộ nền tảng — không có bảng "lơ lửng". */
export function uncoveredSharedTables(): string[] {
  const covered = new Set(SHARED_FLOWS.map((f) => f.entity));
  return tablesOf('shared').filter((t) => !covered.has(t) && !PLATFORM_INTERNAL_TABLES.has(t));
}

/** Một hệ thống con chỉ được GHI vào bảng dùng chung mà nó là chủ hoặc đồng chủ. */
export function canWriteShared(system: SystemCode, table: string): boolean {
  if (domainOf(table) !== 'shared') return domainOf(table) === (system as Domain);
  const flow = SHARED_FLOWS.find((f) => f.entity === table);
  if (!flow) return false;
  return flow.owner === system || (flow.coWriters ?? []).includes(system);
}

// ---------------------------------------------------------------------------
// Feed và con trỏ
// ---------------------------------------------------------------------------

export interface FeedEvent { seq: number; at: string; entity: string; entityId: string | null; action: string; actor: string | null; after: unknown }

/** Thay đổi trên dữ liệu dùng chung mà `system` cần nhận, sau con trỏ `since`. */
export function feedFor(system: SystemCode, since = 0, limit = 200): { events: FeedEvent[]; cursor: number; latest: number } {
  const entities = flowsFor(system).map((f) => f.entity);
  const latest = one<{ m: number | null }>('SELECT MAX(rowid) AS m FROM event_log')?.m ?? 0;
  if (!entities.length) return { events: [], cursor: since, latest };
  const rows = all<{ seq: number; occurred_at: string; entity_type: string; entity_id: string | null; action: string; actor_name: string | null; after_json: string | null }>(
    `SELECT rowid AS seq, occurred_at, entity_type, entity_id, action, actor_name, after_json FROM event_log
     WHERE rowid > ? AND entity_type IN (${entities.map(() => '?').join(',')}) ORDER BY rowid LIMIT ?`,
    [since, ...entities, limit],
  );
  return {
    events: rows.map((r) => ({ seq: r.seq, at: r.occurred_at, entity: r.entity_type, entityId: r.entity_id, action: r.action, actor: r.actor_name, after: r.after_json ? JSON.parse(r.after_json) : null })),
    cursor: rows.length ? rows[rows.length - 1].seq : since, latest,
  };
}

export function cursorOf(system: SystemCode): number {
  return one<{ last_seq: number }>('SELECT last_seq FROM shared_sync_cursor WHERE system = ?', [system])?.last_seq ?? 0;
}

export function ack(system: SystemCode, seq: number): void {
  run(`INSERT INTO shared_sync_cursor (system, last_seq, acked_at) VALUES (?, ?, ?)
       ON CONFLICT(system) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), acked_at = excluded.acked_at`, [system, seq, nowIso()]);
}

/** Tổng quan cho màn hình quản trị: từng luồng, số thay đổi, và từng hệ thống còn nợ bao nhiêu. */
export function overview(systems: SystemCode[]): Record<string, unknown> {
  const counts = new Map(all<{ entity_type: string; n: number; last: string | null }>(
    'SELECT entity_type, COUNT(*) AS n, MAX(occurred_at) AS last FROM event_log GROUP BY entity_type').map((r) => [r.entity_type, r]));
  const flows = SHARED_FLOWS.map((f) => ({ ...f, events: counts.get(f.entity)?.n ?? 0, lastChange: counts.get(f.entity)?.last ?? null }));
  const receivers = systems.map((system) => {
    const cursor = cursorOf(system);
    const pending = feedFor(system, cursor, 100_000).events.length;
    return { system, cursor, pending, flows: flowsFor(system).map((f) => f.entity), acked: one<{ acked_at: string }>('SELECT acked_at FROM shared_sync_cursor WHERE system = ?', [system])?.acked_at ?? null };
  });
  return { flows, receivers, uncovered: uncoveredSharedTables() };
}
