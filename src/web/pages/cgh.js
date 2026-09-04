/**
 * CỔNG CƠ GIỚI HOÁ — hệ thống chức năng riêng theo BRD Bản đồ số Cơ giới hoá.
 *
 *   QT-01  Nhu cầu máy = diện tích ÷ định mức
 *   QT-02  Ngưỡng cảnh báo mức đáp ứng
 *   QT-03  Bản ghi đã KHOÁ không nhận ghi đè từ Cổng HTX
 *
 *   FN-02  Định mức năng suất          → cgh-norms
 *   FN-05  Hồ sơ máy & chủ máy         → cgh-machines
 *   FN-06/07 Bản đồ mức đáp ứng        → cgh-map
 *   FN-08  Kế hoạch canh tác           → cgh-plans
 *   FN-09  Cân đối cung–cầu, dự báo    → cgh-balance, cgh-forecast
 *   FN-10  Báo cáo thiếu hụt           → cgh-shortage
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num, pct,
  toast, guard, can, form, mapContainer, createMap, LEAFLET_AVAILABLE, navigate,
} from '/app.js';

export const STAGE = {
  lam_dat: 'Làm đất', gieo_sa: 'Gieo sạ', cham_soc: 'Chăm sóc',
  thu_hoach: 'Thu hoạch', sau_thu_hoach: 'Sau thu hoạch',
};
const CONDITION = {
  hoat_dong: 'Hoạt động', bao_tri: 'Bảo trì', hong: 'Hỏng', ngung_hoat_dong: 'Ngừng hoạt động',
};

function stageOptions() {
  return Object.entries(STAGE).map(([value, label]) => ({ value, label }));
}

// ===========================================================================
// Bảng điều hành
// ===========================================================================

registerPage('cgh-dashboard', {
  title: 'Bảng điều hành Cơ giới hoá',
  subtitle: 'QT-01 nhu cầu máy = diện tích ÷ định mức · QT-02 ngưỡng đáp ứng · QT-03 ưu tiên nguồn Cổng HTX',
  async render(view, actions) {
    const [dashboard, shortage] = await Promise.all([
      guard(api('/cgh/dashboard')), api('/cgh/shortage-report'),
    ]);

    if (can('cgh.write')) {
      actions.append(el('button', {
        class: 'ghost small', text: '↻ Đồng bộ từ Cổng HTX',
        onclick: async () => {
          const result = await guard(api('/cgh/sync-app-htx', { body: { machineConditions: [], cultivation: [] } }));
          toast(`Đồng bộ ${result.status}: ${result.recordCount} bản ghi.`);
        },
      }));
    }

    const summary = dashboard.summary ?? {};

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Tổng nhu cầu máy', num(summary.totalRequired), 'Theo định mức DCRD ban hành'),
        kpi('Năng lực đáp ứng', num(summary.totalOperational), 'Chỉ tính máy ở tình trạng "Hoạt động"'),
        kpi('Vùng × khâu thiếu máy', num(summary.thieu), 'Mức đáp ứng < 60%', summary.thieu ? 'critical' : 'good'),
        kpi('Vùng × khâu thừa máy', num(summary.thua), 'Mức đáp ứng ≥ 120%', 'info'),
      ]),

      card('Chú giải ngưỡng cảnh báo cung – cầu (QT-02)',
        el('div', { class: 'chip-row' }, (dashboard.coverageBands ?? []).map((band) =>
          el('span', { class: 'chip', style: `border-color:${band.color};color:${band.color}` }, [band.label])))),

      el('div', { class: 'grid cols-2' }, [
        card('Nơi thiếu máy nghiêm trọng nhất', table([
          { key: 'htxName', label: 'HTX' },
          { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
          { key: 'coveragePct', label: 'Đáp ứng', align: 'right', render: (row) => pct(row.coveragePct) },
        ], (shortage.shortages ?? []).slice(0, 8), { empty: 'Không có vùng nào thiếu máy.' }),
          el('button', { class: 'ghost small', text: 'Báo cáo đầy đủ →', onclick: () => navigate('cgh-shortage') })),

        card('Dự báo nhu cầu vụ tiếp theo', table([
          { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
          { key: 'projectedAreaHa', label: 'Dự báo (ha)', align: 'right', render: (row) => num(row.projectedAreaHa) },
          { key: 'projectedMachines', label: 'Máy cần', align: 'right', render: (row) => num(row.projectedMachines) },
        ], dashboard.forecast ?? [], { empty: 'Chưa đủ dữ liệu để dự báo.' }),
          el('button', { class: 'ghost small', text: 'Chi tiết dự báo →', onclick: () => navigate('cgh-forecast') })),
      ]),
    );
  },
});

// ===========================================================================
// FN-06/07 — Bản đồ mức đáp ứng
// ===========================================================================

registerPage('cgh-map', {
  title: 'Bản đồ mức đáp ứng cơ giới hoá',
  subtitle: 'Mỗi HTX hiển thị theo khâu YẾU NHẤT — màu theo ngưỡng cảnh báo QT-02 (FN-06, FN-07)',
  async render(view) {
    const [balance, dashboard] = await Promise.all([guard(api('/cgh/balance')), api('/cgh/dashboard')]);
    const mapNode = mapContainer('cgh-map-canvas', 'tall');

    const worst = new Map();
    for (const row of balance.rows) {
      if (!row.lat) continue;
      const current = worst.get(row.htxId);
      if (!current || (row.coveragePct ?? 999) < (current.coveragePct ?? 999)) worst.set(row.htxId, row);
    }

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('HTX trên bản đồ', num(worst.size)),
        kpi('HTX thiếu máy', num([...worst.values()].filter((r) => (r.coveragePct ?? 100) < 60).length), 'Đáp ứng < 60%', 'critical'),
        kpi('HTX chưa có dữ liệu', num([...worst.values()].filter((r) => r.coveragePct === null).length),
          'Thiếu diện tích hoặc định mức — không suy đoán'),
      ]),
      card('Chú giải ngưỡng (QT-02)',
        el('div', { class: 'chip-row' }, (dashboard.coverageBands ?? []).map((band) =>
          el('span', { class: 'chip', style: `border-color:${band.color};color:${band.color}` }, [band.label])))),
      card('Bản đồ mức đáp ứng theo HTX', [
        el('p', { class: 'muted', text: 'Điểm màu thể hiện khâu có mức đáp ứng THẤP NHẤT của HTX đó — một HTX đủ máy gặt nhưng thiếu máy làm đất vẫn phải hiện màu đỏ.' }),
        mapNode,
      ]),
    );

    if (!LEAFLET_AVAILABLE()) return;
    const map = createMap('cgh-map-canvas', [10.2, 105.8], 8);
    for (const row of worst.values()) {
      window.L.circleMarker([row.lat, row.lng], {
        radius: 8, color: row.color, fillColor: row.color, fillOpacity: 0.7, weight: 2,
      }).bindPopup(
        `<strong>${row.htxName}</strong><br>Khâu yếu nhất: ${STAGE[row.stage] ?? row.stage}` +
        `<br>Cần ${row.requiredMachines} máy, có ${row.operationalMachines}` +
        `<br>Mức đáp ứng: ${row.coveragePct === null ? 'Chưa có dữ liệu' : `${row.coveragePct}%`}`,
      ).addTo(map);
    }
  },
});

// ===========================================================================
// FN-09 — Cân đối cung – cầu
// ===========================================================================

registerPage('cgh-balance', {
  title: 'Cân đối cung – cầu máy',
  subtitle: 'Theo vùng × mùa vụ × khâu canh tác. Nhu cầu = diện tích ÷ định mức (QT-01), làm tròn lên (FN-09)',
  async render(view, actions) {
    const [seasons, balance] = await Promise.all([
      api('/mdm/seasons').catch(() => []), guard(api('/cgh/balance')),
    ]);

    let rows = balance.rows;
    const body = el('div');
    const draw = () => body.replaceChildren(table([
      { key: 'htxCode', label: 'Mã HTX' },
      { key: 'htxName', label: 'HTX' },
      { key: 'seasonName', label: 'Mùa vụ' },
      { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
      { key: 'areaHa', label: 'Diện tích (ha)', align: 'right', render: (row) => num(row.areaHa) },
      {
        key: 'areaSource', label: 'Nguồn diện tích',
        render: (row) => badge(row.areaSource === 'app_htx' ? '[Cổng HTX]' : '[Nhập tay]',
          row.areaSource === 'app_htx' ? 'good' : 'neutral'),
      },
      { key: 'requiredMachines', label: 'Cần', align: 'right', render: (row) => num(row.requiredMachines) },
      { key: 'operationalMachines', label: 'Đang hoạt động', align: 'right', render: (row) => num(row.operationalMachines) },
      {
        key: 'coveragePct', label: 'Mức đáp ứng', align: 'right',
        render: (row) => el('span', { class: 'badge', style: `background:${row.color}22;color:${row.color}` }, [
          row.coveragePct === null ? 'Chưa có dữ liệu' : pct(row.coveragePct),
        ]),
      },
      { key: 'gap', label: 'Chênh lệch', align: 'right', render: (row) => (row.gap === null ? '—' : num(row.gap)) },
    ], rows.slice(0, 200), { empty: 'Không có dòng nào khớp bộ lọc.' }));

    if (seasons.length) {
      actions.append(el('label', {}, ['Mùa vụ ', el('select', {
        onchange: async (event) => {
          const query = event.target.value ? `?seasonId=${event.target.value}` : '';
          rows = (await guard(api(`/cgh/balance${query}`))).rows;
          draw();
        },
      }, [el('option', { value: '' }, ['Tất cả mùa vụ']),
        ...seasons.map((s) => el('option', { value: s.id }, [s.name]))])]));
    }

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Tổng dòng cân đối', num(balance.rows.length), 'vùng × vụ × khâu'),
        kpi('Thiếu máy', num(balance.summary?.thieu ?? 0), null, 'critical'),
        kpi('Đủ máy', num(balance.summary?.du ?? 0), null, 'good'),
        kpi('Chưa có dữ liệu', num(balance.rows.filter((r) => r.coveragePct === null).length),
          'Không suy đoán khi thiếu diện tích hoặc định mức'),
      ]),
      card('Bảng cân đối cung – cầu', [
        el('p', { class: 'muted', text: 'Nguồn diện tích được ghi rõ trên từng dòng: dữ liệu do Cổng HTX khai báo được ưu tiên hơn số nhập tay (QT-03).' }),
        body,
      ]),
    );
    draw();
  },
});

// ===========================================================================
// FN-09 — Dự báo nhu cầu
// ===========================================================================

registerPage('cgh-forecast', {
  title: 'Dự báo nhu cầu máy vụ tới',
  subtitle: 'Ngoại suy từ diện tích các vụ đã qua; con số là ƯỚC TÍNH để lập kế hoạch, không phải cam kết (FN-09)',
  async render(view) {
    const forecast = await guard(api('/cgh/forecast'));

    view.replaceChildren(
      alert('Dự báo dựa trên xu hướng diện tích các vụ đã ghi nhận. Vụ nào chưa đủ dữ liệu lịch sử sẽ không được ngoại suy thay vì đưa ra con số thiếu căn cứ.', 'info'),
      card('Dự báo theo khâu canh tác', table([
        { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
        { key: 'avgAreaHa', label: 'Diện tích BQ (ha)', align: 'right', render: (row) => num(row.avgAreaHa) },
        { key: 'trendHaPerSeason', label: 'Xu hướng (ha/vụ)', align: 'right', render: (row) => num(row.trendHaPerSeason) },
        { key: 'projectedAreaHa', label: 'Diện tích dự báo (ha)', align: 'right', render: (row) => num(row.projectedAreaHa) },
        { key: 'projectedMachines', label: 'Số máy cần', align: 'right', render: (row) => num(row.projectedMachines) },
      ], forecast, { empty: 'Chưa đủ dữ liệu lịch sử để dự báo.' })),
    );
  },
});

// ===========================================================================
// FN-10 — Báo cáo thiếu hụt
// ===========================================================================

registerPage('cgh-shortage', {
  title: 'Báo cáo thiếu hụt cơ giới hoá',
  subtitle: 'Danh sách vùng × khâu có mức đáp ứng dưới ngưỡng, kèm nguồn của từng con số (FN-10)',
  async render(view) {
    const shortage = await guard(api('/cgh/shortage-report'));

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vùng × khâu thiếu máy', num((shortage.shortages ?? []).length), null,
          (shortage.shortages ?? []).length ? 'critical' : 'good'),
        kpi('Tổng số máy còn thiếu',
          num((shortage.shortages ?? []).reduce((acc, r) =>
            acc + Math.max(0, (r.requiredMachines ?? 0) - (r.operationalMachines ?? 0)), 0))),
      ]),

      card('Nguồn dữ liệu của báo cáo', [
        el('p', { class: 'muted', text: shortage.sourceLabels?.area ?? 'Nguồn diện tích: không xác định.' }),
        el('p', { class: 'muted', text: shortage.sourceLabels?.norm ?? 'Nguồn định mức: không xác định.' }),
      ]),

      card('Chi tiết thiếu hụt', table([
        { key: 'htxCode', label: 'Mã HTX' },
        { key: 'htxName', label: 'HTX' },
        { key: 'seasonName', label: 'Mùa vụ' },
        { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
        { key: 'areaHa', label: 'Diện tích (ha)', align: 'right', render: (row) => num(row.areaHa) },
        { key: 'requiredMachines', label: 'Cần', align: 'right' },
        { key: 'operationalMachines', label: 'Có', align: 'right' },
        { key: 'coveragePct', label: 'Đáp ứng', align: 'right', render: (row) => pct(row.coveragePct) },
      ], shortage.shortages ?? [], { empty: 'Không có vùng nào dưới ngưỡng cảnh báo.' })),
    );
  },
});

// ===========================================================================
// FN-05 — Hồ sơ máy & chủ máy
// ===========================================================================

registerPage('cgh-machines', {
  title: 'Hồ sơ máy & chủ máy',
  subtitle: 'Danh mục máy móc – thiết bị theo HTX và khâu canh tác; bản ghi đã KHOÁ không nhận ghi đè từ Cổng HTX (FN-05, QT-03)',
  async render(view) {
    const [machines, types, cooperatives] = await Promise.all([
      guard(api('/cgh/machines')), api('/cgh/machine-types'), api('/mdm/cooperatives'),
    ]);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Tổng số máy', num(machines.length)),
        kpi('Đang hoạt động', num(machines.filter((m) => m.condition === 'hoat_dong').length), null, 'good'),
        kpi('Hỏng / ngừng hoạt động',
          num(machines.filter((m) => m.condition === 'hong' || m.condition === 'ngung_hoat_dong').length), null, 'critical'),
        kpi('Bản ghi đã khoá', num(machines.filter((m) => m.condition_locked).length),
          'Cổng HTX không ghi đè được (QT-03)'),
      ]),

      can('cgh.write')
        ? el('div', { class: 'grid cols-2' }, [
            card('Thêm chủ máy', form([
              { name: 'fullName', label: 'Tên chủ máy', required: true },
              { name: 'phone', label: 'Điện thoại' },
              {
                name: 'htxId', label: 'Thuộc HTX', type: 'select',
                options: [{ value: '', label: '— Chủ máy tự do —' },
                  ...cooperatives.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))],
              },
            ], async (values) => {
              await api('/cgh/machine-owners', { body: { ...values, htxId: values.htxId || null } });
              toast('Đã thêm chủ máy.');
            }, { submitLabel: '+ Thêm chủ máy' })),

            card('Thêm máy vào hồ sơ', form([
              {
                name: 'machineTypeId', label: 'Chủng loại máy', type: 'select', required: true,
                options: types.map((t) => ({ value: t.id, label: `${t.name} (${STAGE[t.stage] ?? t.stage})` })),
              },
              {
                name: 'htxId', label: 'HTX quản lý', type: 'select', required: true,
                options: cooperatives.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
              },
              { name: 'brand', label: 'Hãng / model' },
              { name: 'manufactureYear', label: 'Năm sản xuất', type: 'number', min: '1980' },
              {
                name: 'condition', label: 'Tình trạng', type: 'select',
                options: Object.entries(CONDITION).map(([value, label]) => ({ value, label })),
              },
            ], async (values) => {
              await api('/cgh/machines', { body: values });
              toast('Đã thêm máy vào hồ sơ.');
              await this.render(view);
            }, { submitLabel: '+ Thêm máy' })),
          ])
        : null,

      card('Danh mục máy móc – thiết bị', table([
        { key: 'code', label: 'Mã máy' },
        { key: 'machine_type_name', label: 'Chủng loại' },
        { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
        { key: 'htx_name', label: 'HTX' },
        { key: 'brand', label: 'Hãng' },
        {
          key: 'condition', label: 'Tình trạng',
          render: (row) => badge(CONDITION[row.condition] ?? row.condition,
            row.condition === 'hoat_dong' ? 'good' : row.condition === 'hong' ? 'bad' : 'warn'),
        },
        {
          key: 'condition_source', label: 'Nguồn',
          render: (row) => badge(row.condition_source === 'app_htx' ? '[Cổng HTX]' : '[Nhập tay]', 'neutral'),
        },
        {
          key: 'condition_locked', label: 'Khoá',
          render: (row) => (can('cgh.write')
            ? el('button', {
                class: 'ghost small', text: row.condition_locked ? '🔒 Mở khoá' : '🔓 Khoá',
                onclick: async () => {
                  await guard(api(`/cgh/machines/${row.id}/lock`, { body: { locked: !row.condition_locked } }));
                  toast(row.condition_locked
                    ? 'Đã mở khoá — Cổng HTX được ghi đè trở lại.'
                    : 'Đã khoá — Cổng HTX không ghi đè bản ghi này (QT-03).');
                  await this.render(view);
                },
              })
            : (row.condition_locked ? 'Có' : '—')),
        },
      ], machines, { empty: 'Chưa có máy nào trong hồ sơ.' })),
    );
  },
});

// ===========================================================================
// FN-02 — Định mức năng suất
// ===========================================================================

registerPage('cgh-norms', {
  title: 'Định mức năng suất máy',
  subtitle: 'Cơ sở của QT-01: nhu cầu máy = diện tích ÷ định mức. Mỗi định mức phải dẫn được văn bản ban hành (FN-02)',
  async render(view) {
    const [norms, types] = await Promise.all([guard(api('/cgh/norms')), api('/cgh/machine-types')]);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Định mức đang hiệu lực', num(norms.length)),
        kpi('Chủng loại máy', num(types.length)),
        kpi('Định mức thiếu văn bản',
          num(norms.filter((n) => !n.document_ref).length),
          'Không dẫn được nguồn thì không dùng cho báo cáo chính thức',
          norms.filter((n) => !n.document_ref).length ? 'warning' : 'good'),
      ]),

      can('cgh.write')
        ? el('div', { class: 'grid cols-2' }, [
            card('Thêm chủng loại máy', form([
              { name: 'code', label: 'Mã chủng loại', required: true, placeholder: 'VD: MAY-GAT-DL' },
              { name: 'name', label: 'Tên chủng loại', required: true },
              { name: 'stage', label: 'Khâu canh tác', type: 'select', required: true, options: stageOptions() },
            ], async (values) => {
              await api('/cgh/machine-types', { body: values });
              toast('Đã thêm chủng loại máy.');
              await this.render(view);
            }, { submitLabel: '+ Thêm chủng loại' })),

            card('Ban hành định mức mới', [
              el('p', { class: 'muted', text: 'Định mức mới KHÔNG ghi đè định mức cũ mà có hiệu lực từ ngày chỉ định — báo cáo của các vụ trước vẫn tính theo định mức đúng thời điểm.' }),
              form([
                {
                  name: 'machineTypeId', label: 'Chủng loại máy', type: 'select', required: true,
                  options: types.map((t) => ({ value: t.id, label: `${t.name} (${STAGE[t.stage] ?? t.stage})` })),
                },
                { name: 'haPerMachineSeason', label: 'ha / máy / vụ', type: 'number', required: true, step: '0.1', min: '0.1' },
                { name: 'effectiveFrom', label: 'Hiệu lực từ', type: 'date', required: true },
                { name: 'documentRef', label: 'Văn bản ban hành', placeholder: 'VD: QĐ 1234/QĐ-BNN' },
              ], async (values) => {
                await api('/cgh/norms', { body: values });
                toast('Đã ban hành định mức mới.');
                await this.render(view);
              }, { submitLabel: '+ Ban hành định mức' }),
            ]),
          ])
        : null,

      card('Định mức đang hiệu lực', table([
        { key: 'machine_name', label: 'Chủng loại máy' },
        { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
        { key: 'ha_per_machine_season', label: 'ha/máy/vụ', align: 'right', render: (row) => num(row.ha_per_machine_season) },
        { key: 'effective_from', label: 'Hiệu lực từ' },
        {
          key: 'document_ref', label: 'Văn bản ban hành',
          render: (row) => (row.document_ref ? row.document_ref : badge('Thiếu văn bản', 'warn')),
        },
      ], norms, { empty: 'Chưa ban hành định mức nào.' })),
    );
  },
});

// ===========================================================================
// FN-08 — Kế hoạch canh tác
// ===========================================================================

registerPage('cgh-plans', {
  title: 'Kế hoạch canh tác',
  subtitle: 'Diện tích canh tác theo HTX × mùa vụ × khâu — đầu vào của bài toán cân đối cung – cầu (FN-08)',
  async render(view) {
    const [balance, cooperatives, seasons] = await Promise.all([
      guard(api('/cgh/balance')), api('/mdm/cooperatives'), api('/mdm/seasons').catch(() => []),
    ]);

    const manual = balance.rows.filter((r) => r.areaSource !== 'app_htx' && r.areaHa);
    const fromHtx = balance.rows.filter((r) => r.areaSource === 'app_htx');
    const missing = balance.rows.filter((r) => !r.areaHa);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Dòng lấy từ Cổng HTX', num(fromHtx.length), 'Ưu tiên hơn số nhập tay (QT-03)', 'good'),
        kpi('Dòng nhập tay', num(manual.length)),
        kpi('Chưa có diện tích', num(missing.length),
          'Không cân đối được — cần bổ sung kế hoạch',
          missing.length ? 'warning' : 'good'),
      ]),

      can('cgh.write')
        ? card('Khai báo / cập nhật kế hoạch canh tác', [
            el('p', { class: 'muted', text: 'Nếu Cổng HTX đã khai báo diện tích cho cùng HTX × vụ × khâu, số liệu từ Cổng HTX sẽ được ưu tiên và bản nhập tay ở đây chỉ dùng làm dự phòng.' }),
            form([
              {
                name: 'htxId', label: 'HTX', type: 'select', required: true,
                options: cooperatives.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
              },
              {
                name: 'seasonId', label: 'Mùa vụ', type: 'select', required: true,
                options: seasons.map((s) => ({ value: s.id, label: s.name })),
              },
              { name: 'stage', label: 'Khâu canh tác', type: 'select', required: true, options: stageOptions() },
              { name: 'areaHa', label: 'Diện tích (ha)', type: 'number', required: true, step: '0.1', min: '0' },
            ], async (values) => {
              await api('/cgh/cultivation-plans', { body: values });
              toast('Đã cập nhật kế hoạch canh tác.');
              await this.render(view);
            }, { submitLabel: 'Lưu kế hoạch' }),
          ])
        : null,

      card('Kế hoạch canh tác hiện có', table([
        { key: 'htxCode', label: 'Mã HTX' },
        { key: 'htxName', label: 'HTX' },
        { key: 'seasonName', label: 'Mùa vụ' },
        { key: 'stage', label: 'Khâu', render: (row) => STAGE[row.stage] ?? row.stage },
        { key: 'areaHa', label: 'Diện tích (ha)', align: 'right', render: (row) => (row.areaHa ? num(row.areaHa) : badge('Chưa có', 'warn')) },
        {
          key: 'areaSource', label: 'Nguồn',
          render: (row) => badge(row.areaSource === 'app_htx' ? '[Cổng HTX]' : '[Nhập tay]',
            row.areaSource === 'app_htx' ? 'good' : 'neutral'),
        },
      ], balance.rows.slice(0, 200), { empty: 'Chưa có kế hoạch canh tác nào.' })),
    );
  },
});
