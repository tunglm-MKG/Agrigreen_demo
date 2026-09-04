import {
  api, registerPage, el, card, kpi, table, badge, alert, num, tons, dateTime,
  toast, guard, can, rawJson,
} from '/app.js';
import { facilityLocationEditor } from '/pages/facility-location.js';

// ===========================================================================
// Master Data & Configuration Hub
// ===========================================================================

registerPage('masterdata', {
  title: 'Master Data & Configuration Hub',
  subtitle: 'Một Master Data, nhiều phân hệ dùng chung — mọi phân hệ đọc từ nguồn này, không nhân bản',
  async render(view) {
    const [summary, cooperatives, facilities, seasons, statistics, partners, adminUnits] = await Promise.all([
      guard(api('/mdm/summary')), api('/mdm/cooperatives'), api('/mdm/facilities'),
      api('/mdm/seasons'), api('/mdm/harvest-statistics'), api('/mdm/partners'), api('/mdm/admin-units'),
    ]);

    const facilityEditorSlot = el('div');

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Hợp tác xã', num(summary.cooperatives)),
        kpi('Nông hộ', num(summary.farmers)),
        kpi('Thửa ruộng', num(summary.plots), `${num(summary.plotAreaHa, 1)} ha`),
        kpi('Máy cơ giới', num(summary.machines), `${num(summary.machineOwners)} chủ sở hữu`),
        kpi('Hub / Kho', num(summary.facilities.hub + summary.facilities.warehouse)),
        kpi('Nhà máy đầu ra', num(summary.facilities.plant)),
        kpi('Tuyến GIS', num(summary.routes.road + summary.routes.waterway), `${num(summary.routes.confirmed)} đã xác nhận`),
        kpi('Bản ghi sản lượng', num(summary.harvestStatistics), `${num(summary.seasons)} mùa vụ`),
      ]),

      card('Đơn vị hành chính sau sáp nhập 2025', [
        alert('RS-09: bản seed dùng ranh giới MINH HOẠ. Cần thay bằng shapefile/GeoJSON chính thức từ Cục Thống kê trước khi dùng cho quyết định đầu tư thật.', 'warn'),
        table(
          [
            { key: 'code', label: 'Mã' },
            { key: 'name', label: 'Tỉnh/Thành' },
            { key: 'centroid_lat', label: 'Vĩ độ', align: 'right', render: (row) => num(row.centroid_lat, 4) },
            { key: 'centroid_lng', label: 'Kinh độ', align: 'right', render: (row) => num(row.centroid_lng, 4) },
          ],
          adminUnits,
        ),
      ]),

      card('Danh mục HTX (dùng chung cho Khuyến nông, App HTX, CGH, Simulation, Warehouse)', table(
        [
          { key: 'code', label: 'Mã HTX' },
          { key: 'name', label: 'Tên' },
          { key: 'member_count', label: 'Thành viên', align: 'right', render: (row) => num(row.member_count) },
          { key: 'registered_area_ha', label: 'Diện tích đăng ký (ha)', align: 'right', render: (row) => num(row.registered_area_ha) },
          { key: 'lat', label: 'Toạ độ', render: (row) => (row.lat === null ? badge('Thiếu GPS', 'bad') : `${num(row.lat, 4)}, ${num(row.lng, 4)}`) },
          { key: 'contact_phone', label: 'Liên hệ' },
        ],
        cooperatives,
      )),

      el('div', { class: 'grid cols-2' }, [
        card('Danh mục cơ sở vận hành (multi-site)', [
          el('p', { class: 'muted', text: 'Toạ độ nhà máy/Hub là đầu vào trực tiếp của mọi phép tính khoảng cách (FN-04). Bấm "Sửa vị trí" để chọn lại điểm trên bản đồ.' }),
          facilityEditorSlot,
          table(
            [
              { key: 'code', label: 'Mã' },
              { key: 'name', label: 'Tên' },
              { key: 'kind', label: 'Loại', render: (row) => badge(FACILITY[row.kind] ?? row.kind, row.kind === 'plant' ? 'info' : 'neutral') },
              {
                key: 'coords', label: 'Toạ độ',
                render: (row) => el('code', { text: `${Number(row.lat).toFixed(4)}, ${Number(row.lng).toFixed(4)}` }),
              },
              { key: 'capacity_tons', label: 'Sức chứa', align: 'right', render: (row) => tons(row.capacity_tons) },
              { key: 'annual_demand_tons', label: 'Nhu cầu/năm', align: 'right', render: (row) => (row.annual_demand_tons ? tons(row.annual_demand_tons) : '—') },
              { key: 'origin_scenario_id', label: 'Nguồn gốc', render: (row) => (row.origin_scenario_id ? badge('Từ kịch bản mô phỏng', 'good') : '—') },
              {
                key: 'action', label: '',
                render: (row) => (can('mdm.write')
                  ? el('button', {
                      class: 'ghost small', text: '📍 Sửa vị trí',
                      onclick: () => {
                        facilityEditorSlot.replaceChildren(
                          facilityLocationEditor(row, { onClose: () => this.render(view) }),
                        );
                        facilityEditorSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      },
                    })
                  : '—'),
              },
            ],
            facilities,
          ),
        ]),
        card('Đối tác & tổ chức kiểm định', table(
          [
            { key: 'code', label: 'Mã' },
            { key: 'name', label: 'Tên' },
            { key: 'kind', label: 'Vai trò', render: (row) => badge(PARTNER[row.kind] ?? row.kind, 'neutral') },
          ],
          partners,
        )),
      ]),

      card('Sản lượng lúa thống kê theo HTX × mùa vụ (tham số #5 — nguồn duy nhất của Total Available Supply)', table(
        [
          { key: 'htx_code', label: 'Mã HTX' },
          { key: 'htx_name', label: 'HTX' },
          { key: 'season_name', label: 'Mùa vụ' },
          { key: 'planted_area_ha', label: 'Diện tích (ha)', align: 'right', render: (row) => num(row.planted_area_ha) },
          { key: 'paddy_tons', label: 'Sản lượng lúa', align: 'right', render: (row) => tons(row.paddy_tons) },
          { key: 'source', label: 'Nguồn' },
          { key: 'recorded_at', label: 'Cập nhật', render: (row) => dateTime(row.recorded_at) },
        ],
        statistics.slice(0, 60),
      )),

      card('Mùa vụ', table(
        [
          { key: 'code', label: 'Mã' },
          { key: 'name', label: 'Mùa vụ' },
          { key: 'start_month', label: 'Tháng bắt đầu', align: 'right' },
          { key: 'end_month', label: 'Tháng kết thúc', align: 'right' },
        ],
        seasons,
      )),
    );
  },
});

const FACILITY = { hub: 'Hub', warehouse: 'Kho', yard: 'Bãi', plant: 'Nhà máy đầu ra' };
const PARTNER = { customer: 'Khách hàng mua', vendor: 'Nhà cung cấp', vvb: 'Tổ chức kiểm định (VVB)', buyer: 'Bên mua tín chỉ' };

// ===========================================================================
// Tài khoản, RBAC, nhật ký, đồng bộ, replay
// ===========================================================================

registerPage('admin', {
  title: 'Quản trị nền tảng',
  subtitle: 'Tài khoản & ma trận RBAC hợp nhất · nhật ký sự kiện · snapshot & replay · giám sát đồng bộ',
  async render(view, actions) {
    const [matrix, events, syncLogs, health, retention] = await Promise.all([
      guard(api('/rbac/matrix')), api('/audit/events?limit=60'),
      api('/sync/logs'), api('/sync/health'), api('/audit/retention'),
    ]);
    const users = can('admin.users') ? await api('/admin/users') : [];

    const replayBox = el('div');

    if (can('gis.admin')) {
      actions.append(
        el('button', {
          class: 'ghost small', text: '📸 Chụp snapshot hôm nay (FN-18)',
          onclick: async () => {
            const result = await guard(api('/audit/snapshot', { body: {} }));
            toast(`Đã chụp snapshot ${result.layers.length} lớp dữ liệu.`);
          },
        }),
        el('button', {
          class: 'ghost small', text: '↻ Chạy retry đồng bộ (FN-22)',
          onclick: async () => {
            const result = await guard(api('/sync/retry', { body: {} }));
            toast(`Retry: ${result.retried} lượt · phục hồi ${result.recovered} · dead-letter ${result.deadLettered}.`);
          },
        }),
      );
    }

    view.replaceChildren(
      users.length
        ? card('Tài khoản người dùng', table(
            [
              { key: 'username', label: 'Tên đăng nhập' },
              { key: 'fullName', label: 'Họ tên' },
              { key: 'roles', label: 'Vai trò', render: (row) => el('span', { class: 'chip-row' }, row.roles.map((role) => badge(role, 'neutral'))) },
              { key: 'status', label: 'Trạng thái', render: (row) => badge(row.status === 'active' ? 'Hoạt động' : 'Đã khoá', row.status === 'active' ? 'good' : 'bad') },
              {
                key: 'action', label: '',
                render: (row) => el('span', { class: 'chip-row' }, [
                  el('button', {
                    class: 'ghost small', text: row.status === 'active' ? 'Khoá' : 'Mở khoá',
                    onclick: async () => {
                      await guard(api(`/admin/users/${row.id}/status`, { body: { status: row.status === 'active' ? 'locked' : 'active' } }));
                      toast('Đã cập nhật trạng thái tài khoản.');
                    },
                  }),
                  el('button', {
                    class: 'ghost small', text: 'Reset mật khẩu',
                    onclick: async () => {
                      const result = await guard(api(`/admin/users/${row.id}/reset-password`, { body: {} }));
                      window.alert(`Mật khẩu tạm của ${row.username}: ${result.temporaryPassword}`);
                    },
                  }),
                ]),
              },
            ],
            users,
          ))
        : null,

      card('Ma trận phân quyền hợp nhất (RBAC)', [
        alert('ERP Vision v1.2 ghi nhận "RBAC chưa hợp nhất" là rủi ro mức Cao. Ma trận dưới đây là nguồn duy nhất định nghĩa vai trò và quyền cho toàn bộ phân hệ.', 'info'),
        table(
          [
            { key: 'label', label: 'Vai trò' },
            { key: 'role', label: 'Mã', render: (row) => el('code', { text: row.role }) },
            {
              key: 'permissions', label: 'Quyền',
              render: (row) => (row.permissions[0] === '*'
                ? badge('Toàn quyền', 'good')
                : el('span', { class: 'chip-row' }, row.permissions.map((permission) => badge(permission, 'neutral')))),
            },
          ],
          matrix.roles,
        ),
      ]),

      el('div', { class: 'grid cols-2' }, [
        card('Giám sát đồng bộ tích hợp (FN-21)', [
          health.pendingRetries ? alert(`${health.pendingRetries} giao dịch đang chờ retry.`, 'warn') : null,
          table(
            [
              { key: 'system', label: 'Hệ thống' },
              { key: 'total', label: 'Tổng', align: 'right' },
              { key: 'success', label: 'Thành công', align: 'right' },
              { key: 'failed', label: 'Lỗi', align: 'right' },
              { key: 'deadLetter', label: 'Dead-letter', align: 'right', render: (row) => (row.deadLetter ? badge(num(row.deadLetter), 'bad') : '0') },
            ],
            health.bySystem ?? [],
            { empty: 'Chưa có lượt đồng bộ nào.' },
          ),
          table(
            [
              { key: 'started_at', label: 'Thời điểm', render: (row) => dateTime(row.started_at) },
              { key: 'system', label: 'Hệ thống' },
              { key: 'dataset', label: 'Dataset' },
              { key: 'direction', label: 'Chiều', render: (row) => (row.direction === 'inbound' ? 'Nhận vào' : 'Gửi ra') },
              { key: 'record_count', label: 'Bản ghi', align: 'right' },
              {
                key: 'status', label: 'Kết quả',
                render: (row) => badge(SYNC_STATUS[row.status] ?? row.status,
                  row.status === 'success' ? 'good' : row.status === 'dead_letter' ? 'bad' : 'warn'),
              },
              { key: 'error_message', label: 'Lỗi' },
            ],
            syncLogs.slice(0, 25),
            { empty: 'Chưa có nhật ký đồng bộ.' },
          ),
        ]),

        card('Xem lại trạng thái GIS theo ngày (FN-19)', [
          el('div', { class: 'row' }, [
            el('label', {}, ['Chọn ngày', el('input', { type: 'date', id: 'replay-date', value: new Date().toISOString().slice(0, 10) })]),
            el('button', {
              class: 'small', text: 'Tua về ngày này',
              onclick: async () => {
                const date = document.getElementById('replay-date').value;
                const result = await guard(api(`/audit/replay/${date}`));
                replayBox.replaceChildren(
                  alert(result.basis === 'snapshot'
                    ? `Đọc trực tiếp từ snapshot ngày ${result.date}.`
                    : result.basis === 'reconstructed'
                      ? `Tái dựng từ snapshot gần nhất + ${result.appliedEvents} sự kiện trong event log.`
                      : `Chưa có snapshot nào trước ngày ${result.date}.`,
                    result.basis === 'empty' ? 'warn' : 'good'),
                  table(
                    [
                      { key: 'layer', label: 'Lớp dữ liệu' },
                      { key: 'count', label: 'Số bản ghi', align: 'right' },
                    ],
                    Object.entries(result.layers ?? {}).map(([layer, rows]) => ({ layer, count: rows.length })),
                    { empty: 'Không có dữ liệu để tái dựng.' },
                  ),
                );
              },
            }),
          ]),
          replayBox,
          el('h4', { text: 'Chính sách lưu trữ (FN-20)' }),
          el('p', { class: 'muted', text: `Event log giữ ${retention.eventLogDays} ngày · snapshot giữ ${retention.snapshotDays} ngày · nén snapshot cũ sau ${retention.compactAfterDays} ngày.` }),
        ]),
      ]),

      card('Nhật ký sự kiện (event log append-only — FN-17)', table(
        [
          { key: 'occurred_at', label: 'Thời điểm', render: (row) => dateTime(row.occurred_at) },
          { key: 'actor_name', label: 'Người thực hiện' },
          { key: 'module', label: 'Phân hệ' },
          { key: 'entity_type', label: 'Đối tượng' },
          { key: 'action', label: 'Hành động', render: (row) => badge(ACTION[row.action] ?? row.action, ACTION_TONE[row.action] ?? 'neutral') },
          { key: 'note', label: 'Ghi chú' },
          {
            key: 'detail', label: '',
            render: (row) => (row.after_json
              ? el('details', {}, [
                  el('summary', { class: 'muted', text: 'Chi tiết' }),
                  el('pre', { style: 'max-width:520px;overflow:auto;font-size:11px', text: row.after_json.slice(0, 1500) }),
                ])
              : '—'),
          },
        ],
        events,
      )),
    );
  },
});

const SYNC_STATUS = { success: 'Thành công', failed: 'Lỗi — chờ retry', dead_letter: 'Dead-letter', retrying: 'Đang chạy' };
const ACTION = {
  create: 'Tạo', update: 'Sửa', delete: 'Xoá', approve: 'Phê duyệt',
  export: 'Kết xuất', sync: 'Đồng bộ', simulate: 'Mô phỏng',
};
const ACTION_TONE = { create: 'good', update: 'info', delete: 'bad', approve: 'good', export: 'warn', sync: 'neutral', simulate: 'info' };
