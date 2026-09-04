import {
  api, registerPage, el, card, kpi, table, badge, alert, vnd, num, tons, pct, dateTime, can,
} from '/app.js';

registerPage('dashboard', {
  title: 'Bảng điều hành hợp nhất',
  subtitle: 'Reporting & BI — nguồn cung, mạng lưới, vận hành, tài chính và MRV trên một màn hình',
  async render(view) {
    const [report, leaderboard] = await Promise.all([
      api('/reports/executive'),
      api('/reports/scenario-leaderboard').catch(() => []),
    ]);

    const supply = report.supply ?? {};
    const network = report.network ?? {};
    const operations = report.operations ?? {};
    const finance = report.finance ?? {};
    const mrv = report.mrv?.totals ?? {};

    const kpis = el('div', { class: 'grid cols-4' }, [
      kpi('Hợp tác xã liên kết', num(supply.cooperatives), `${num(supply.planted_area_ha, 0)} ha gieo trồng`),
      kpi('Sản lượng lúa thống kê', tons(supply.paddy_tons), 'Nguồn duy nhất của Total Available Supply (B3)'),
      kpi('Kịch bản đầu tư', `${num(network.scenarios?.total)} kịch bản`,
        `${num(network.scenarios?.official ?? 0)} chính thức · ${num(network.candidateHubs?.simulated ?? 0)}/${num(network.candidateHubs?.total ?? 0)} Hub đã mô phỏng`),
      kpi('Cảnh báo môi trường đang mở', num(operations.openAlerts?.n ?? 0), 'Kho/bãi — độ ẩm & nhiệt độ',
        (operations.openAlerts?.n ?? 0) > 0 ? 'critical' : 'good'),
      kpi('Nhập kho luỹ kế', tons(operations.inboundTons?.tons ?? 0), 'GRN đã phê duyệt'),
      kpi('Xuất kho luỹ kế', tons(operations.outboundTons?.tons ?? 0), 'Phiếu xuất đã phê duyệt'),
      kpi('Doanh thu ghi nhận', vnd(finance.revenue ?? 0, { compact: true }), `Kỳ ${finance.period?.from ?? ''} → ${finance.period?.to ?? ''}`),
      kpi('CO₂ tránh được', `${num((mrv.co2_avoided_kg ?? 0) / 1000, 1)} tấn`,
        `${num(mrv.records ?? 0)} bản ghi MRV · phát thải vận tải ${num((mrv.co2_emitted_kg ?? 0) / 1000, 1)} tấn`),
    ]);

    const facilityTable = card('Mạng lưới cơ sở vận hành (multi-site)',
      table(
        [
          { key: 'kind', label: 'Loại', render: (row) => FACILITY_LABEL[row.kind] ?? row.kind },
          { key: 'n', label: 'Số lượng', align: 'right', render: (row) => num(row.n) },
          { key: 'capacity', label: 'Sức chứa', align: 'right', render: (row) => tons(row.capacity) },
          { key: 'stock', label: 'Tồn hiện tại', align: 'right', render: (row) => tons(row.stock) },
          {
            key: 'fill', label: 'Mức đầy', align: 'right',
            render: (row) => (row.capacity > 0 ? pct((row.stock / row.capacity) * 100) : '—'),
          },
        ],
        report.network?.facilities ?? [],
      ));

    const leaderboardCard = card('Xếp hạng kịch bản đầu tư (theo TCO per Ton tăng dần)',
      leaderboard.length
        ? table(
            [
              { key: 'code', label: 'Mã' },
              { key: 'name', label: 'Kịch bản' },
              {
                key: 'status', label: 'Trạng thái',
                render: (row) => badge(row.status === 'chinh_thuc' ? 'Chính thức' : 'Tham khảo',
                  row.status === 'chinh_thuc' ? 'good' : 'neutral'),
              },
              { key: 'hubCount', label: 'Hub', align: 'right' },
              { key: 'deliveredTons', label: 'Delivered', align: 'right', render: (row) => tons(row.deliveredTons) },
              { key: 'tcoPerTon', label: 'TCO/Ton', align: 'right', render: (row) => vnd(row.tcoPerTon) },
              { key: 'costPerTon', label: 'Cost/Ton', align: 'right', render: (row) => vnd(row.costPerTon) },
              {
                key: 'plantDemandCoveragePct', label: 'Đáp ứng NM', align: 'right',
                render: (row) => badge(pct(row.plantDemandCoveragePct), row.plantDemandCoveragePct >= 100 ? 'good' : 'warn'),
              },
              { key: 'parameterSetVersion', label: 'Bộ tham số', align: 'right', render: (row) => `v${row.parameterSetVersion}` },
            ],
            leaderboard,
          )
        : alert('Chưa có kịch bản nào được mô phỏng. Mở "Hub Planner & Kịch bản" để dựng phương án đầu tư đầu tiên.', 'info'));

    const integrations = card('Tình trạng đồng bộ tích hợp (GIS FN-21 / FN-22)', [
      report.integrations?.pendingRetries
        ? alert(`${report.integrations.pendingRetries} giao dịch đang chờ retry tự động.`, 'warn')
        : null,
      table(
        [
          { key: 'system', label: 'Hệ thống', render: (row) => SYSTEM_LABEL[row.system] ?? row.system },
          { key: 'total', label: 'Tổng', align: 'right' },
          { key: 'success', label: 'Thành công', align: 'right' },
          { key: 'failed', label: 'Lỗi', align: 'right' },
          {
            key: 'deadLetter', label: 'Dead-letter', align: 'right',
            render: (row) => (row.deadLetter > 0 ? badge(num(row.deadLetter), 'bad') : num(row.deadLetter)),
          },
        ],
        report.integrations?.bySystem ?? [],
        { empty: 'Chưa có lượt đồng bộ nào được ghi nhận.' },
      ),
    ]);

    const tripCard = card('Chuyến vận chuyển theo trạng thái',
      table(
        [
          { key: 'status', label: 'Trạng thái', render: (row) => TRIP_STATUS[row.status] ?? row.status },
          { key: 'n', label: 'Số chuyến', align: 'right' },
        ],
        operations.trips ?? [],
      ));

    const mrvCard = card('Dữ liệu MRV gần nhất',
      table(
        [
          { key: 'code', label: 'Mã' },
          { key: 'source_module', label: 'Phân hệ' },
          { key: 'ref_type', label: 'Chứng từ' },
          { key: 'quantity_tons', label: 'Khối lượng', align: 'right', render: (row) => tons(row.quantity_tons) },
          { key: 'co2_avoided_kg', label: 'CO₂ tránh', align: 'right', render: (row) => `${num(row.co2_avoided_kg)} kg` },
          { key: 'occurred_at', label: 'Thời điểm', render: (row) => dateTime(row.occurred_at) },
        ],
        report.mrv?.recent ?? [],
      ));

    view.replaceChildren(
      kpis,
      leaderboardCard,
      el('div', { class: 'grid cols-2' }, [facilityTable, integrations]),
      el('div', { class: 'grid cols-2' }, [tripCard, mrvCard]),
      el('p', { class: 'muted', text: `Cập nhật lúc ${dateTime(report.generatedAt)}` }),
    );
  },
});

const FACILITY_LABEL = { hub: 'Hub trung chuyển', warehouse: 'Kho', yard: 'Bãi', plant: 'Nhà máy đầu ra' };
const SYSTEM_LABEL = {
  app_htx: 'App Hợp tác xã', ban_do_cgh: 'Bản đồ Cơ giới hoá', erp: 'ERP', tms: 'TMS',
  khuyen_nong: 'App Khuyến nông', simulation: 'Planning & Simulation',
};
const TRIP_STATUS = { ke_hoach: 'Kế hoạch', dang_chay: 'Đang chạy', hoan_thanh: 'Hoàn thành', huy: 'Huỷ' };
