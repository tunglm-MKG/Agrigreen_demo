/**
 * CỔNG HỢP TÁC XÃ — hệ thống chức năng riêng theo BRD App Hợp tác xã.
 *
 *   FN-07/08  Lô ruộng, ranh giới GPS, xác minh vị trí → htx-plots
 *   FN-09     Vụ canh tác                              → htx-cycles
 *   FN-10     Nhật ký đồng ruộng, đồng bộ offline      → htx-logs
 *   FN-11     Khai báo sản lượng                       → htx-harvest
 *   FN-12     Yêu cầu hỗ trợ kỹ thuật                  → htx-support
 *   FN-13     Thời tiết & khuyến cáo nông vụ           → htx-advice
 *
 * Mọi màn hình đều làm việc trên MỘT hợp tác xã đang chọn. Lựa chọn đó được giữ
 * lại khi chuyển màn hình — nếu không, cán bộ HTX sẽ phải chọn lại đơn vị của
 * mình ở từng trang.
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num, tons, dateTime,
  toast, guard, can, form, mapContainer, createMap, LEAFLET_AVAILABLE, navigate,
} from '/app.js';

const PLOT_STATUS = {
  chua_mo_vu: { label: 'Chưa mở vụ', tone: 'neutral' },
  dang_canh_tac: { label: 'Đang canh tác', tone: 'good' },
  da_hoan_thanh_vu: { label: 'Đã hoàn thành vụ', tone: 'info' },
};

const STORAGE_KEY = 'mekong-green.htx';
let cachedCooperatives = null;

async function cooperatives() {
  if (!cachedCooperatives) cachedCooperatives = await api('/mdm/cooperatives');
  return cachedCooperatives;
}

function currentHtxId(list) {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { saved = null; }
  if (saved && list.some((h) => h.id === saved)) return saved;
  return list[0]?.id ?? null;
}

function setHtxId(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* chế độ ẩn danh: bỏ qua */ }
}

/**
 * Bộ chọn HTX đặt ở thanh hành động của mọi màn hình trong cổng.
 * Trả về id đang chọn; khi người dùng đổi, gọi lại `onChange`.
 */
async function htxSelector(actions, onChange) {
  const list = await cooperatives();
  const current = currentHtxId(list);
  actions.append(el('label', { class: 'htx-picker' }, [
    el('span', { class: 'muted', text: 'HTX:' }),
    el('select', {
      onchange: (event) => { setHtxId(event.target.value); onChange(event.target.value); },
    }, list.map((htx) => el('option', { value: htx.id, selected: htx.id === current }, [`${htx.code} — ${htx.name}`]))),
  ]));
  return { id: current, list };
}

// ===========================================================================
// Bảng điều hành HTX
// ===========================================================================

registerPage('htx-dashboard', {
  title: 'Bảng điều hành Hợp tác xã',
  subtitle: 'Tình hình lô ruộng, vụ canh tác, sản lượng và yêu cầu hỗ trợ của đơn vị',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => this.render(view, (actions.replaceChildren(), actions)));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào trong dữ liệu dùng chung.', 'warn'));

    const [dashboard, plots, cycles] = await Promise.all([
      guard(api(`/htx/dashboard?htxId=${id}`)),
      api(`/mdm/plots?htxId=${id}`),
      api(`/htx/crop-cycles?htxId=${id}`),
    ]);
    const byStatus = Object.fromEntries((dashboard.plots ?? []).map((row) => [row.status, row]));
    const openTasks = (dashboard.openTasks ?? []).filter((t) => t.status !== 'dong')
      .reduce((acc, t) => acc + t.n, 0);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Lô ruộng', num(plots.length),
          `${num(plots.reduce((acc, p) => acc + p.area_ha, 0), 2)} ha — hệ thống tự tính từ polygon`),
        kpi('Đang canh tác', num(byStatus.dang_canh_tac?.n ?? 0), `${num(byStatus.dang_canh_tac?.area ?? 0, 1)} ha`, 'good'),
        kpi('Đã hoàn thành vụ', num(byStatus.da_hoan_thanh_vu?.n ?? 0), 'Vụ đã đóng — không mở lại được'),
        kpi('Yêu cầu hỗ trợ đang mở', num(openTasks), 'Đang chờ cán bộ khuyến nông', openTasks ? 'warning' : 'good'),
      ]),

      el('div', { class: 'grid cols-2' }, [
        card('Vụ đang canh tác', table([
          { key: 'code', label: 'Mã vụ' },
          { key: 'plot_code', label: 'Lô' },
          { key: 'season_name', label: 'Mùa vụ' },
          { key: 'sowing_date', label: 'Gieo sạ' },
        ], cycles.filter((c) => c.status === 'dang_canh_tac').slice(0, 8),
          { empty: 'Không có vụ nào đang canh tác.' }),
          el('button', { class: 'ghost small', text: 'Quản lý vụ →', onclick: () => navigate('htx-cycles') })),

        card('Nhật ký gần đây', table([
          { key: 'log_date', label: 'Ngày' },
          { key: 'plot_code', label: 'Lô' },
          { key: 'activity', label: 'Hoạt động' },
        ], (dashboard.recentLogs ?? []).slice(0, 8), { empty: 'Chưa có nhật ký nào.' }),
          el('button', { class: 'ghost small', text: 'Mở nhật ký →', onclick: () => navigate('htx-logs') })),
      ]),
    );
  },
});

// ===========================================================================
// FN-07/08 — Lô ruộng & ranh giới GPS
// ===========================================================================

registerPage('htx-plots', {
  title: 'Lô ruộng & ranh giới GPS',
  subtitle: 'Vẽ ranh giới thửa trên bản đồ — diện tích do hệ thống tính từ polygon, không nhập tay (FN-07, FN-08)',
  async render(view, actions) {
    const { id, list } = await htxSelector(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào trong dữ liệu dùng chung.', 'warn'));

    const plots = await guard(api(`/mdm/plots?htxId=${id}`));
    const mapNode = mapContainer('htx-plot-map', 'tall');
    const drawing = [];
    let map = null;
    let shapes = [];

    const counter = el('span', { class: 'muted', text: '0 điểm' });

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Số lô ruộng', num(plots.length)),
        kpi('Tổng diện tích', `${num(plots.reduce((acc, p) => acc + p.area_ha, 0), 2)} ha`,
          'Tổng từ polygon đã vẽ'),
        kpi('Lô chưa mở vụ', num(plots.filter((p) => p.status === 'chua_mo_vu').length),
          'Sẵn sàng mở vụ mới'),
      ]),

      el('div', { class: 'split' }, [
        card('Danh sách lô ruộng', [
          table([
            { key: 'code', label: 'Mã lô' },
            { key: 'area_ha', label: 'Diện tích (ha)', align: 'right', render: (row) => num(row.area_ha, 4) },
            {
              key: 'status', label: 'Trạng thái',
              render: (row) => badge(PLOT_STATUS[row.status]?.label ?? row.status, PLOT_STATUS[row.status]?.tone ?? 'neutral'),
            },
            {
              key: 'verify', label: '',
              render: (row) => (can('htx.read')
                ? el('button', {
                    class: 'ghost small', text: '📍 Xác minh vị trí',
                    onclick: async () => {
                      const raw = prompt('Toạ độ GPS hiện tại (lat, lng):', '10.38, 105.44');
                      if (!raw) return;
                      const [lat, lng] = raw.split(',').map((v) => Number(v.trim()));
                      const result = await guard(api('/htx/verify-location', { body: { plotId: row.id, lat, lng } }));
                      toast(result.inside
                        ? `Vị trí hợp lệ — cách tâm lô ${num(result.distanceKm, 2)} km.`
                        : `Vị trí NGOÀI lô: cách tâm ${num(result.distanceKm, 2)} km (ngưỡng ${num(result.toleranceKm, 2)} km).`,
                        !result.inside);
                    },
                  })
                : '—'),
            },
          ], plots, { empty: 'HTX chưa có lô ruộng nào — vẽ ranh giới trên bản đồ để tạo lô.' }),

          can('mdm.write')
            ? el('div', {}, [
                el('p', { class: 'muted', text: 'Nhấp ≥ 3 điểm trên bản đồ theo đúng thứ tự viền thửa, rồi bấm "Lưu lô ruộng". Diện tích do hệ thống tính bằng công thức diện tích cầu — nhập tay không được chấp nhận.' }),
                el('div', { class: 'chip-row' }, [
                  el('button', { class: 'small', text: '💾 Lưu lô ruộng', onclick: () => savePlot() }),
                  el('button', { class: 'ghost small', text: '↶ Xoá điểm cuối', onclick: () => { drawing.pop(); redraw(); } }),
                  el('button', { class: 'ghost small', text: '🗑 Xoá hết', onclick: () => { drawing.length = 0; redraw(); } }),
                  counter,
                ]),
              ])
            : null,
        ]),
        card('Vẽ ranh giới thửa ruộng', mapNode),
      ]),
    );

    function redraw() {
      counter.textContent = `${drawing.length} điểm`;
      if (!LEAFLET_AVAILABLE() || !map) return;
      shapes.forEach((shape) => map.removeLayer(shape));
      shapes = [];
      if (drawing.length >= 2) {
        shapes.push(window.L.polygon(drawing.map((p) => [p.lat, p.lng]),
          { color: '#9C6414', weight: 2, fillOpacity: 0.2 }).addTo(map));
      }
      drawing.forEach((point) => {
        shapes.push(window.L.circleMarker([point.lat, point.lng],
          { radius: 4, color: '#9C6414', fillOpacity: 1 }).addTo(map));
      });
    }

    async function savePlot() {
      if (drawing.length < 3) return toast('Ranh giới thửa ruộng phải có tối thiểu 3 đỉnh.', true);
      const created = await guard(api('/mdm/plots', { body: { htxId: id, boundary: drawing } }));
      toast(`Đã tạo lô ${created.code} — diện tích ${created.areaLabel} (hệ thống tự tính).`);
      drawing.length = 0;
      actions.replaceChildren();
      await this.render(view, actions);
    }

    if (LEAFLET_AVAILABLE()) {
      const htx = list.find((c) => c.id === id);
      map = createMap('htx-plot-map', [htx?.lat ?? 10.2, htx?.lng ?? 105.8], 12);
      map.on('click', (event) => {
        drawing.push({ lat: Number(event.latlng.lat.toFixed(6)), lng: Number(event.latlng.lng.toFixed(6)) });
        redraw();
      });
      for (const plot of plots) {
        if (!plot.boundaryGeo) continue;
        window.L.geoJSON(plot.boundaryGeo, { style: { color: '#3E7A3A', weight: 2, fillOpacity: 0.2 } })
          .bindTooltip(`${plot.code} — ${num(plot.area_ha, 4)} ha`).addTo(map);
      }
    }
    redraw();
  },
});

// ===========================================================================
// FN-09 — Vụ canh tác
// ===========================================================================

registerPage('htx-cycles', {
  title: 'Vụ canh tác',
  subtitle: 'Mở vụ trên lô ruộng và theo dõi vòng đời; vụ đã khai báo sản lượng sẽ đóng vĩnh viễn (FN-09)',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    const [cycles, plots, seasons] = await Promise.all([
      guard(api(`/htx/crop-cycles?htxId=${id}`)),
      api(`/mdm/plots?htxId=${id}`),
      api('/mdm/seasons'),
    ]);
    const openPlots = plots.filter((p) => p.status === 'chua_mo_vu');

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vụ đang canh tác', num(cycles.filter((c) => c.status === 'dang_canh_tac').length), null, 'good'),
        kpi('Vụ đã đóng', num(cycles.filter((c) => c.status !== 'dang_canh_tac').length)),
        kpi('Lô sẵn sàng mở vụ', num(openPlots.length)),
      ]),

      can('htx.write')
        ? card('Mở vụ canh tác mới', [
            el('p', { class: 'muted', text: 'Mỗi lô ruộng chỉ có tối đa một vụ đang canh tác. Lô đang canh tác không xuất hiện trong danh sách dưới đây.' }),
            openPlots.length
              ? form([
                  {
                    name: 'plotId', label: 'Lô ruộng', type: 'select', required: true,
                    options: openPlots.map((p) => ({ value: p.id, label: `${p.code} — ${num(p.area_ha, 3)} ha` })),
                  },
                  {
                    name: 'seasonId', label: 'Mùa vụ', type: 'select', required: true,
                    options: seasons.map((s) => ({ value: s.id, label: s.name })),
                  },
                  { name: 'sowingDate', label: 'Ngày xuống giống', type: 'date' },
                  { name: 'riceVariety', label: 'Giống lúa', placeholder: 'VD: OM5451' },
                ], async (values) => {
                  await api('/htx/crop-cycles', { body: { ...values, htxId: id } });
                  toast('Đã mở vụ canh tác mới.');
                  actions.replaceChildren();
                  await this.render(view, actions);
                }, { submitLabel: '+ Mở vụ' })
              : alert('Mọi lô ruộng đều đang có vụ canh tác. Khai báo sản lượng để đóng vụ trước khi mở vụ mới.', 'info'),
          ])
        : null,

      card('Danh sách vụ canh tác', table([
        { key: 'code', label: 'Mã vụ' },
        { key: 'plot_code', label: 'Lô' },
        { key: 'season_name', label: 'Mùa vụ' },
        { key: 'area_ha', label: 'Diện tích', align: 'right', render: (row) => `${num(row.area_ha, 2)} ha` },
        { key: 'sowing_date', label: 'Gieo sạ' },
        {
          key: 'status', label: 'Trạng thái',
          render: (row) => badge(row.status === 'dang_canh_tac' ? 'Đang canh tác' : 'Đã hoàn thành vụ',
            row.status === 'dang_canh_tac' ? 'good' : 'info'),
        },
        {
          key: 'action', label: '',
          render: (row) => (row.status === 'dang_canh_tac'
            ? el('span', { class: 'chip-row' }, [
                el('button', { class: 'ghost small', text: '📓 Nhật ký', onclick: () => navigate('htx-logs') }),
                el('button', { class: 'ghost small', text: '🚜 Khai báo sản lượng', onclick: () => navigate('htx-harvest') }),
              ])
            : '—'),
        },
      ], cycles, { empty: 'Chưa có vụ canh tác nào.' })),
    );
  },
});

// ===========================================================================
// FN-10 — Nhật ký đồng ruộng
// ===========================================================================

registerPage('htx-logs', {
  title: 'Nhật ký đồng ruộng',
  subtitle: 'Ghi hoạt động canh tác theo vụ; hỗ trợ đồng bộ các bản ghi đã tạo khi mất mạng (FN-10)',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    const [cycles, activities, dashboard] = await Promise.all([
      guard(api(`/htx/crop-cycles?htxId=${id}`)),
      api('/htx/activities').catch(() => []),
      api(`/htx/dashboard?htxId=${id}`),
    ]);
    const active = cycles.filter((c) => c.status === 'dang_canh_tac');
    const activityOptions = (Array.isArray(activities) ? activities : Object.keys(activities ?? {}))
      .map((a) => ({ value: typeof a === 'string' ? a : a.code, label: typeof a === 'string' ? a : (a.label ?? a.code) }));

    const logBox = el('div');
    const showLogs = async (cycleId) => {
      if (!cycleId) return logBox.replaceChildren();
      const logs = await guard(api(`/htx/crop-cycles/${cycleId}/logs`));
      logBox.replaceChildren(table([
        { key: 'log_date', label: 'Ngày' },
        { key: 'activity', label: 'Hoạt động' },
        { key: 'detail', label: 'Chi tiết' },
        { key: 'recorded_by', label: 'Người ghi' },
      ], logs, { empty: 'Vụ này chưa có nhật ký nào.' }));
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vụ đang canh tác', num(active.length)),
        kpi('Bản ghi nhật ký gần đây', num((dashboard.recentLogs ?? []).length)),
      ]),

      can('htx.write') && active.length
        ? card('Ghi nhật ký canh tác', form([
            {
              name: 'cropCycleId', label: 'Vụ canh tác', type: 'select', required: true,
              options: active.map((c) => ({ value: c.id, label: `${c.code} — lô ${c.plot_code} (${c.season_name})` })),
            },
            {
              name: 'activity', label: 'Hoạt động', type: 'select', required: true,
              options: activityOptions.length ? activityOptions : [
                { value: 'lam_dat', label: 'Làm đất' }, { value: 'gieo_sa', label: 'Gieo sạ' },
                { value: 'bon_phan', label: 'Bón phân' }, { value: 'phun_thuoc', label: 'Phun thuốc' },
                { value: 'tuoi', label: 'Tưới' }, { value: 'rut_nuoc_awd', label: 'Rút nước (AWD)' },
                { value: 'thu_hoach', label: 'Thu hoạch' },
              ],
            },
            { name: 'logDate', label: 'Ngày thực hiện', type: 'date' },
            { name: 'detail', label: 'Chi tiết', type: 'textarea', rows: 2 },
          ], async (values) => {
            await api('/htx/farm-logs', { body: values });
            toast('Đã ghi nhật ký canh tác.');
            await showLogs(values.cropCycleId);
          }, { submitLabel: '+ Ghi nhật ký' }))
        : (active.length ? null : alert('Chưa có vụ nào đang canh tác — mở vụ trước khi ghi nhật ký.', 'info')),

      card('Xem nhật ký theo vụ', [
        el('label', {}, ['Vụ canh tác', el('select', {
          onchange: (event) => showLogs(event.target.value),
        }, [el('option', { value: '' }, ['— Chọn vụ —']),
          ...cycles.map((c) => el('option', { value: c.id }, [`${c.code} — lô ${c.plot_code}`]))])]),
        logBox,
      ]),

      can('htx.write')
        ? card('Đồng bộ nhật ký ghi khi mất mạng (offline)', [
            el('p', { class: 'muted', text: 'Ứng dụng ngoài đồng có thể ghi nhật ký khi không có sóng. Dán JSON các bản ghi chờ đồng bộ vào đây; hệ thống báo rõ số bản ghi được nhận và số bị từ chối kèm lý do, thay vì âm thầm bỏ qua.' }),
            form([
              { name: 'records', label: 'Bản ghi (JSON)', type: 'textarea', rows: 4, required: true,
                placeholder: '[{"cropCycleId":"...","activity":"bon_phan","logDate":"2026-04-01"}]' },
            ], async (values) => {
              let parsed;
              try { parsed = JSON.parse(values.records); } catch { throw new Error('JSON không hợp lệ.'); }
              if (!Array.isArray(parsed)) throw new Error('Cần một MẢNG bản ghi.');
              const result = await api('/htx/farm-logs/sync', { body: { records: parsed } });
              toast(`Đồng bộ: nhận ${result.accepted}, từ chối ${result.rejected}.`, result.rejected > 0);
            }, { submitLabel: '⇅ Đồng bộ' }),
          ])
        : null,
    );
  },
});

// ===========================================================================
// FN-11 — Khai báo sản lượng
// ===========================================================================

registerPage('htx-harvest', {
  title: 'Khai báo sản lượng',
  subtitle: 'Khai báo sản lượng lúa và rơm khi kết thúc vụ; vụ sẽ ĐÓNG và không mở lại được (FN-11)',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    const cycles = await guard(api(`/htx/crop-cycles?htxId=${id}`));
    const active = cycles.filter((c) => c.status === 'dang_canh_tac');
    const done = cycles.filter((c) => c.status !== 'dang_canh_tac');

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vụ chờ khai báo', num(active.length), null, active.length ? 'warning' : 'good'),
        kpi('Vụ đã khai báo', num(done.length)),
        kpi('Sản lượng lúa đã khai',
          tons(done.reduce((acc, c) => acc + (c.paddy_tons ?? 0), 0))),
        kpi('Sản lượng rơm đã khai',
          tons(done.reduce((acc, c) => acc + (c.straw_tons ?? 0), 0)),
          'Nguồn cung đầu vào cho mô phỏng Hub của ERP'),
      ]),

      can('htx.write') && active.length
        ? card('Khai báo sản lượng', [
            alert('Khai báo sản lượng sẽ ĐÓNG vụ canh tác. Vụ đã đóng không mở lại được — muốn canh tác tiếp phải mở vụ mới.', 'warn'),
            form([
              {
                name: 'cropCycleId', label: 'Vụ canh tác', type: 'select', required: true,
                options: active.map((c) => ({ value: c.id, label: `${c.code} — lô ${c.plot_code} (${num(c.area_ha, 2)} ha)` })),
              },
              { name: 'paddyTons', label: 'Sản lượng lúa (tấn)', type: 'number', required: true, step: '0.01', min: '0' },
              { name: 'strawTons', label: 'Sản lượng rơm (tấn)', type: 'number', step: '0.01', min: '0' },
              { name: 'harvestDate', label: 'Ngày thu hoạch', type: 'date' },
            ], async (values) => {
              await api('/htx/harvest', { body: values });
              toast('Đã khai báo sản lượng — vụ chuyển sang trạng thái đóng.');
              actions.replaceChildren();
              await this.render(view, actions);
            }, { submitLabel: '🚜 Khai báo & đóng vụ' }),
          ])
        : (active.length ? null : alert('Không có vụ nào đang canh tác để khai báo.', 'info')),

      card('Lịch sử khai báo sản lượng', table([
        { key: 'code', label: 'Mã vụ' },
        { key: 'plot_code', label: 'Lô' },
        { key: 'season_name', label: 'Mùa vụ' },
        { key: 'area_ha', label: 'Diện tích', align: 'right', render: (row) => `${num(row.area_ha, 2)} ha` },
        { key: 'paddy_tons', label: 'Lúa', align: 'right', render: (row) => tons(row.paddy_tons) },
        { key: 'straw_tons', label: 'Rơm', align: 'right', render: (row) => tons(row.straw_tons) },
        { key: 'harvest_date', label: 'Ngày thu hoạch' },
      ], done, { empty: 'Chưa có vụ nào được khai báo sản lượng.' })),
    );
  },
});

// ===========================================================================
// FN-12 — Yêu cầu hỗ trợ kỹ thuật
// ===========================================================================

registerPage('htx-support', {
  title: 'Yêu cầu hỗ trợ kỹ thuật',
  subtitle: 'Gửi yêu cầu tới cán bộ khuyến nông; mỗi yêu cầu tự động thành một nhiệm vụ có người chịu trách nhiệm (FN-12)',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    const [dashboard, plots, directory] = await Promise.all([
      guard(api(`/htx/dashboard?htxId=${id}`)),
      api(`/mdm/plots?htxId=${id}`),
      api('/kn/directory').catch(() => []),
    ]);
    const onDuty = (directory ?? []).filter((o) => o.on_duty);

    view.replaceChildren(
      can('htx.write')
        ? card('Gửi yêu cầu hỗ trợ', [
            el('p', { class: 'muted', text: 'Yêu cầu gửi đi sẽ xuất hiện ngay ở Cổng Khuyến nông dưới dạng nhiệm vụ, có mã theo dõi và hạn tiếp nhận — không phải một cuộc gọi rồi quên.' }),
            form([
              { name: 'title', label: 'Vấn đề gặp phải', required: true, placeholder: 'VD: Lúa vàng lá bất thường' },
              { name: 'content', label: 'Mô tả chi tiết', type: 'textarea', rows: 3, required: true },
              {
                name: 'plotId', label: 'Lô ruộng liên quan', type: 'select',
                options: [{ value: '', label: '— Không xác định —' },
                  ...plots.map((p) => ({ value: p.id, label: `${p.code} — ${num(p.area_ha, 2)} ha` }))],
              },
              {
                name: 'urgency', label: 'Mức độ', type: 'select',
                options: [
                  { value: 'binh_thuong', label: 'Bình thường' },
                  { value: 'khan', label: 'Khẩn — dịch hại lây lan' },
                ],
              },
            ], async (values) => {
              await api('/htx/support-requests', { body: { ...values, htxId: id, plotId: values.plotId || null } });
              toast('Đã gửi yêu cầu — cán bộ khuyến nông sẽ tiếp nhận.');
              actions.replaceChildren();
              await this.render(view, actions);
            }, { submitLabel: '🆘 Gửi yêu cầu' }),
          ])
        : null,

      card('Trạng thái các yêu cầu đã gửi', table([
        { key: 'status', label: 'Trạng thái' },
        { key: 'n', label: 'Số lượng', align: 'right', render: (row) => num(row.n) },
      ], dashboard.openTasks ?? [], { empty: 'Chưa gửi yêu cầu nào.' })),

      card('Cán bộ khuyến nông đang trực', table([
        { key: 'full_name', label: 'Cán bộ' },
        { key: 'org_name', label: 'Đơn vị' },
        { key: 'phone', label: 'Điện thoại' },
        { key: 'specialty', label: 'Chuyên môn' },
      ], onDuty, { empty: 'Hiện không có cán bộ nào trực.' })),
    );
  },
});

// ===========================================================================
// FN-13 — Thời tiết & khuyến cáo nông vụ
// ===========================================================================

registerPage('htx-advice', {
  title: 'Thời tiết & khuyến cáo nông vụ',
  subtitle: 'Dự báo thời tiết theo địa bàn HTX kèm khuyến cáo canh tác tương ứng (FN-13)',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    const advice = await guard(api(`/htx/advice/${id}`).catch(() => ({ advice: [], forecast: [] })));
    const alerts = (advice.forecast ?? []).filter((f) => f.severity);

    view.replaceChildren(
      alerts.length
        ? el('div', {}, alerts.map((f) => alert(`${f.observed_for}: ${f.headline ?? f.severity}`, 'bad')))
        : null,

      card('Khuyến cáo canh tác', (advice.advice ?? []).length
        ? el('div', { class: 'list' }, (advice.advice ?? []).map((text) =>
            el('div', { class: 'list-item', style: 'cursor:default', text })))
        : alert('Chưa có khuyến cáo nào cho địa bàn này.', 'info')),

      card('Dự báo thời tiết', table([
        { key: 'observed_for', label: 'Ngày' },
        { key: 'rainfall_mm', label: 'Lượng mưa (mm)', align: 'right', render: (row) => num(row.rainfall_mm) },
        { key: 'humidity_pct', label: 'Độ ẩm (%)', align: 'right', render: (row) => num(row.humidity_pct) },
        { key: 'temp_c', label: 'Nhiệt độ (°C)', align: 'right', render: (row) => num(row.temp_c) },
        { key: 'severity', label: 'Cảnh báo', render: (row) => (row.severity ? badge(row.headline ?? row.severity, 'bad') : '—') },
      ], advice.forecast ?? [], { empty: 'Chưa có dữ liệu dự báo.' })),
    );
  },
});
