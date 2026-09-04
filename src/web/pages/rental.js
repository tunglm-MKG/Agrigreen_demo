/**
 * SÀN CƠ GIỚI HOÁ — tin đăng, lệnh thuê, ký quỹ và tranh chấp.
 *
 * Sàn phục vụ HAI nhóm người dùng ở hai cổng khác nhau: chủ máy và cơ quan quản
 * lý vào từ Cổng Cơ giới hoá, còn HTX đi thuê máy vào từ Cổng Hợp tác xã. Trang
 * được đăng ký dưới hai định danh trỏ tới CÙNG một màn hình thay vì nhân đôi mã.
 */
import {
  api, registerPage, getPage, el, card, kpi, table, badge, alert, vnd, num, dateTime,
  toast, guard, can,
} from '/app.js';
// Nhãn khâu canh tác là dữ liệu nền của phân hệ Cơ giới hoá — dùng chung, không nhân bản.
import { STAGE } from '/pages/cgh.js';

// ===========================================================================
// Sàn cơ giới hoá
// ===========================================================================

const ORDER_STATUS = {
  dat_lich: { label: 'Đặt lịch', tone: 'neutral', next: 'xac_nhan', nextLabel: 'Xác nhận' },
  xac_nhan: { label: 'Đã xác nhận', tone: 'info', next: 'thuc_hien', nextLabel: 'Bắt đầu thực hiện' },
  thuc_hien: { label: 'Đang thực hiện', tone: 'warn', next: 'hoan_thanh', nextLabel: 'Hoàn thành' },
  hoan_thanh: { label: 'Hoàn thành', tone: 'good', next: null },
  tranh_chap: { label: 'Tranh chấp', tone: 'bad', next: 'hoan_thanh', nextLabel: 'Kết thúc' },
  huy: { label: 'Đã huỷ', tone: 'neutral', next: null },
};

registerPage('rental', {
  title: 'Sàn cơ giới hoá (Rental Marketplace)',
  subtitle: 'Tìm & đặt máy theo khâu sản xuất · vòng đời lệnh thuê P2P · escrow qua Payment · xử lý tranh chấp',
  async render(view, actions) {
    const [dashboard, listings, orders, disputes, cooperatives] = await Promise.all([
      guard(api('/rental/dashboard')), api('/rental/listings'), api('/rental/orders'),
      api('/rental/disputes'), api('/mdm/cooperatives'),
    ]);

    const revenue = dashboard.revenue ?? {};

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Tin đăng đang hoạt động', num(dashboard.listings?.total ?? 0)),
        kpi('GMV lệnh hoàn thành', vnd(revenue.gmv ?? 0, { compact: true })),
        kpi('Phí nền tảng', vnd(revenue.platform_fee ?? 0, { compact: true }), 'Ghi nhận sang Finance khi lệnh hoàn thành'),
        kpi('Tranh chấp đang mở', num((disputes ?? []).filter((d) => d.status !== 'dong').length),
          'Quy trình xử lý khiếu nại', disputes.some((d) => d.status !== 'dong') ? 'critical' : 'good'),
      ]),

      card('Tìm & so sánh máy', table(
        [
          { key: 'code', label: 'Tin đăng' },
          { key: 'machine_type_name', label: 'Chủng loại' },
          { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
          { key: 'owner_name', label: 'Chủ sở hữu' },
          { key: 'htx_name', label: 'Địa bàn' },
          { key: 'price_per_ha', label: 'Giá/ha', align: 'right', render: (row) => vnd(row.price_per_ha) },
          { key: 'price_per_day', label: 'Giá/ngày', align: 'right', render: (row) => vnd(row.price_per_day) },
          { key: 'service_radius_km', label: 'Bán kính phục vụ', align: 'right', render: (row) => `${num(row.service_radius_km)} km` },
          {
            key: 'book', label: '',
            render: (row) => (can('rental.write')
              ? el('button', {
                  class: 'ghost small', text: 'Đặt lịch',
                  onclick: async () => {
                    const area = Number(prompt('Diện tích cần làm (ha):', '10'));
                    if (!area) return;
                    const from = prompt('Từ ngày (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
                    const to = prompt('Đến ngày (YYYY-MM-DD):', new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
                    const order = await guard(api('/rental/orders', {
                      body: { listingId: row.id, renterHtxId: cooperatives[0].id, areaHa: area, from, to },
                    }));
                    toast(`Đã tạo lệnh thuê ${order.code} — ${vnd(order.amount)} (phí nền tảng ${vnd(order.platform_fee)}).`);
                  },
                })
              : '—'),
          },
        ],
        listings,
        { empty: 'Chưa có tin đăng nào. Chủ máy đăng tin từ hồ sơ thiết bị.' },
      ), can('rental.write') ? el('button', {
        class: 'small', text: '+ Đăng tin cho thuê',
        onclick: async () => {
          const machines = await api('/cgh/machines?condition=hoat_dong');
          const code = prompt(`Mã máy muốn đăng (ví dụ ${machines[0]?.code}):`, machines[0]?.code);
          const machine = machines.find((m) => m.code === code);
          if (!machine) return toast('Không tìm thấy máy.', true);
          const price = Number(prompt('Giá thuê theo ha (VNĐ):', '1200000'));
          await guard(api('/rental/listings', { body: { machineId: machine.id, pricePerHa: price } }));
          toast('Đã đăng tin cho thuê.');
        },
      }) : null),

      card('Lệnh thuê', table(
        [
          { key: 'code', label: 'Mã lệnh' },
          { key: 'machine_type_name', label: 'Máy' },
          { key: 'renter_name', label: 'Bên thuê' },
          { key: 'owner_name', label: 'Bên cho thuê' },
          { key: 'area_ha', label: 'Diện tích', align: 'right', render: (row) => `${num(row.area_ha)} ha` },
          { key: 'scheduled_from', label: 'Lịch', render: (row) => `${row.scheduled_from} → ${row.scheduled_to}` },
          { key: 'amount', label: 'Giá trị', align: 'right', render: (row) => vnd(row.amount) },
          { key: 'platform_fee', label: 'Phí NT', align: 'right', render: (row) => vnd(row.platform_fee) },
          {
            key: 'status', label: 'Trạng thái',
            render: (row) => badge(ORDER_STATUS[row.status]?.label ?? row.status, ORDER_STATUS[row.status]?.tone ?? 'neutral'),
          },
          { key: 'escrow_status', label: 'Escrow (Payment)', render: (row) => badge(ESCROW[row.escrow_status] ?? row.escrow_status, 'neutral') },
          {
            key: 'action', label: '',
            render: (row) => {
              const flow = ORDER_STATUS[row.status];
              if (!can('rental.write') || !flow?.next) return '—';
              return el('span', { class: 'chip-row' }, [
                el('button', {
                  class: 'ghost small', text: flow.nextLabel,
                  onclick: async () => {
                    await guard(api(`/rental/orders/${row.id}/advance`, { body: { status: flow.next } }));
                    toast('Đã cập nhật lệnh thuê.');
                  },
                }),
                row.status !== 'tranh_chap'
                  ? el('button', {
                      class: 'ghost small', text: '⚠ Khiếu nại',
                      onclick: async () => {
                        const reason = prompt('Lý do khiếu nại (thiết bị hỏng / trễ lịch / thanh toán treo…):');
                        if (!reason) return;
                        await guard(api('/rental/disputes', { body: { orderId: row.id, reason } }));
                        toast('Đã mở khiếu nại — lệnh chuyển sang trạng thái Tranh chấp.');
                      },
                    })
                  : null,
              ]);
            },
          },
        ],
        orders,
        { empty: 'Chưa có lệnh thuê nào.' },
      )),

      disputes.length
        ? card('Khiếu nại & tranh chấp', table(
            [
              { key: 'order_code', label: 'Lệnh thuê' },
              { key: 'reason', label: 'Lý do' },
              { key: 'status', label: 'Trạng thái', render: (row) => badge(row.status === 'dong' ? 'Đã đóng' : 'Đang mở', row.status === 'dong' ? 'good' : 'bad') },
              { key: 'created_at', label: 'Mở lúc', render: (row) => dateTime(row.created_at) },
              { key: 'resolution', label: 'Kết luận' },
              {
                key: 'action', label: '',
                render: (row) => (can('rental.resolve') && row.status !== 'dong'
                  ? el('button', {
                      class: 'ghost small', text: 'Giải quyết',
                      onclick: async () => {
                        const resolution = prompt('Kết luận xử lý:');
                        if (!resolution) return;
                        const outcome = confirm('Hoàn thành lệnh thuê? (Huỷ nếu chọn Cancel)') ? 'hoan_thanh' : 'huy';
                        await guard(api(`/rental/disputes/${row.id}/resolve`, { body: { resolution, orderOutcome: outcome } }));
                        toast('Đã đóng khiếu nại.');
                      },
                    })
                  : '—'),
              },
            ],
            disputes,
          ))
        : null,
    );
  },
});

const ESCROW = {
  chua_giu: 'Chưa giữ tiền', dang_giu: 'Đang giữ', da_giai_ngan: 'Đã giải ngân', hoan_tien: 'Đã hoàn tiền',
};

// Cùng màn hình, mở từ Cổng Hợp tác xã dưới góc nhìn bên ĐI THUÊ.
registerPage('htx-rental', {
  ...getPage('rental'),
  title: 'Thuê máy cơ giới',
  subtitle: 'Tìm máy theo khâu canh tác và địa bàn, đặt lịch và theo dõi lệnh thuê của HTX',
});
