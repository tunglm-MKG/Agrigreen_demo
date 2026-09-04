import {
  api, registerPage, el, card, table, badge, alert, kpi, num, tons, pct, dateTime,
  mapContainer, createMap, LEAFLET_AVAILABLE, toast, guard, can, rawJson,
} from '/app.js';

// ---------------------------------------------------------------------------
// Nền GIS dùng chung — FN-06, FN-09 → FN-16
// ---------------------------------------------------------------------------

const LAYER_DEFS = [
  { id: 'admin_boundaries', label: 'Ranh giới hành chính', on: true },
  { id: 'cooperatives', label: 'Điểm HTX', on: true },
  { id: 'facilities', label: 'Hub / Kho / Nhà máy', on: true },
  { id: 'candidate_hubs', label: 'Hub ứng viên', on: true },
  { id: 'waterways', label: 'Tuyến đường thuỷ', on: true },
  { id: 'roads', label: 'Tuyến đường bộ', on: false },
  { id: 'crop_heatmap', label: 'Heatmap mùa vụ', on: true },
  { id: 'capacity_widgets', label: 'Widget dung lượng kho', on: true },
  { id: 'plots', label: 'Polygon thửa ruộng (zoom ≥ 13)', on: false },
  { id: 'weather', label: 'Thời tiết & cảnh báo', on: false },
  { id: 'machinery', label: 'Cơ giới hoá theo khâu', on: false },
  { id: 'crop_calendar', label: 'Lịch thời vụ theo xã (nhập Excel)', on: false },
];

registerPage('gis', {
  title: 'Nền tảng bản đồ số GIS dùng chung',
  subtitle: 'Chồng xếp đa tầng dữ liệu · tiếp nhận từ App HTX / Bản đồ CGH / ERP · cấp lại bản đồ chuẩn hoá cho TMS',
  async render(view, actions) {
    const active = new Set(LAYER_DEFS.filter((layer) => layer.on).map((layer) => layer.id));
    const mapNode = mapContainer('gis-map', 'tall');
    const legend = el('div', { class: 'card' });
    const alertsBox = el('div');
    const statsBox = el('div', { class: 'grid cols-4' });

    const chips = el('div', { class: 'chip-row' }, LAYER_DEFS.map((layer) =>
      el('button', {
        class: `chip${active.has(layer.id) ? ' active' : ''}`,
        text: layer.label,
        onclick: (event) => {
          if (active.has(layer.id)) active.delete(layer.id);
          else active.add(layer.id);
          event.target.classList.toggle('active');
          refresh();
        },
      })));

    if (can('gis.write')) {
      actions.append(el('button', {
        class: 'ghost small',
        text: '⇪ Cấp bản đồ chuẩn hoá cho TMS (FN-16)',
        onclick: async () => {
          const result = await guard(api('/gis/publish/tms', { body: {} }));
          toast(`Đã cấp gói bản đồ chuẩn hoá (${result.status}).`);
        },
      }));
    }
    actions.append(el('button', {
      class: 'ghost small',
      text: '⤓ Xuất GeoJSON tuyến',
      onclick: () => window.open('/api/gis/routes/export.geojson', '_blank'),
    }));

    view.replaceChildren(
      card('Lớp dữ liệu (bật/tắt độc lập — UX-04)', chips),
      statsBox,
      alertsBox,
      el('div', { class: 'split' }, [legend, card(null, mapNode)]),
    );

    let map = null;
    let overlays = [];

    async function refresh() {
      const zoom = map ? map.getZoom() : 8;
      const bundle = await guard(api(`/gis/map?layers=${[...active].join(',')}&zoom=${zoom}`));
      const alerts = await api('/gis/harvest-alerts?days=3').catch(() => []);
      renderStats(bundle, alerts);
      renderLegend(bundle, alerts);
      drawMap(bundle);
    }

    function renderStats(bundle, alerts) {
      const layers = bundle.layers ?? {};
      statsBox.replaceChildren(
        kpi('HTX trên bản đồ', num((layers.cooperatives ?? []).length)),
        kpi('Cơ sở vận hành', num((layers.facilities ?? []).length)),
        kpi('Tuyến đường thuỷ', num((layers.waterways ?? []).length),
          `${num((layers.waterways ?? []).filter((r) => r.status === 'da_xac_nhan').length)} đã xác nhận`),
        kpi('Vùng chín rộ 1–3 ngày tới', num(alerts.length), 'FN-13 — chuẩn bị kho/logistics',
          alerts.length ? 'warning' : 'good'),
      );
    }

    function renderLegend(bundle, alerts) {
      const palette = bundle.legend?.cropPalette ?? {};
      const thresholds = bundle.legend?.capacityThresholds ?? [];
      legend.replaceChildren(
        el('h3', { text: 'Chú giải & dữ liệu động' }),
        el('h4', { text: 'Heatmap trạng thái mùa vụ (FN-12)' }),
        el('div', { class: 'list' }, Object.entries(palette).map(([key, value]) =>
          el('div', { class: 'list-item', style: 'cursor:default' }, [
            el('span', { style: `display:inline-block;width:12px;height:12px;border-radius:3px;background:${value.color};margin-right:8px` }),
            value.label,
          ]))),
        el('h4', { text: 'Widget dung lượng kho (FN-14)' }),
        el('div', { class: 'list' }, thresholds.map((band) =>
          el('div', { class: 'list-item', style: 'cursor:default' }, [
            el('span', { style: `display:inline-block;width:12px;height:12px;border-radius:3px;background:${band.color};margin-right:8px` }),
            `${band.label} (< ${band.maxPct}%)`,
          ]))),
        el('h4', { text: 'Cảnh báo sản lượng thu hoạch (FN-13)' }),
        alerts.length
          ? table(
              [
                { key: 'name', label: 'HTX' },
                { key: 'expected_harvest_date', label: 'Ngày thu hoạch' },
                { key: 'straw_tons', label: 'Rơm dự kiến', align: 'right', render: (row) => tons(row.straw_tons) },
                {
                  key: 'severity', label: 'Mức',
                  render: (row) => badge(SEVERITY[row.severity] ?? row.severity,
                    row.severity === 'cao' ? 'bad' : row.severity === 'trung_binh' ? 'warn' : 'neutral'),
                },
              ],
              alerts,
            )
          : el('p', { class: 'muted', text: 'Không có vùng nào chín rộ trong 3 ngày tới.' }),
        el('h4', { text: 'Dải tỷ lệ zoom' }),
        el('div', { class: 'list' }, (bundle.zoomBands ?? []).map((band) =>
          el('div', { class: 'list-item', style: 'cursor:default' }, [
            el('div', { class: 'title', text: band.label }),
            el('div', { class: 'muted', text: `zoom ${band.minZoom}–${band.maxZoom} · gộp nhóm theo ${band.cluster}` }),
          ]))),
      );
    }

    function drawMap(bundle) {
      if (!LEAFLET_AVAILABLE()) return;
      if (!map) {
        map = createMap('gis-map');
        map.on('zoomend', () => { if (active.has('plots')) refresh(); });
      }
      overlays.forEach((layer) => map.removeLayer(layer));
      overlays = [];
      const L = window.L;
      const layers = bundle.layers ?? {};

      for (const unit of layers.admin_boundaries ?? []) {
        if (!unit.boundary) continue;
        overlays.push(L.geoJSON(unit.boundary, {
          style: { color: '#0E3B34', weight: 1, fillOpacity: 0.02, dashArray: '4 3' },
        }).bindTooltip(unit.name).addTo(map));
      }

      for (const item of layers.crop_heatmap ?? []) {
        if (!item.boundary) continue;
        overlays.push(L.geoJSON(item.boundary, { style: { color: item.color, weight: 1, fillOpacity: 0.35 } })
          .bindPopup(`<strong>${item.name}</strong><br>Giai đoạn: ${item.stageLabel}<br>Vụ: ${item.season}<br>Rơm dự kiến: ${num(item.strawTons)} tấn<br>Thu hoạch: ${item.expectedHarvestDate ?? '—'}`)
          .addTo(map));
      }

      for (const htx of layers.cooperatives ?? []) {
        overlays.push(L.circleMarker([htx.lat, htx.lng], {
          radius: 5, color: '#1C8C74', fillColor: '#1C8C74', fillOpacity: 0.85, weight: 1,
        }).bindTooltip(`${htx.code} — ${htx.name}`)
          .bindPopup(`<strong>${htx.name}</strong><br>Mã: ${htx.code}<br>Thành viên: ${num(htx.member_count)}<br>Diện tích đăng ký: ${num(htx.registered_area_ha)} ha`)
          .addTo(map));
      }

      for (const facility of layers.facilities ?? []) {
        overlays.push(L.marker([facility.lat, facility.lng])
          .bindTooltip(`${facility.code} — ${facility.name}`)
          .addTo(map));
      }

      for (const hub of layers.candidate_hubs ?? []) {
        overlays.push(L.circleMarker([hub.lat, hub.lng], {
          radius: 7, color: '#9C6414', fillColor: '#9C6414', fillOpacity: 0.6, weight: 2,
        }).bindTooltip(`Hub ứng viên: ${hub.name}`).addTo(map));
      }

      for (const widget of layers.capacity_widgets ?? []) {
        overlays.push(L.circleMarker([widget.lat, widget.lng], {
          radius: 11, color: widget.color, fillColor: widget.color, fillOpacity: 0.75, weight: 2,
        }).bindTooltip(`${widget.name}: ${widget.fillPct}% đầy`, { permanent: true, direction: 'top', className: 'capacity-label' })
          .bindPopup(`<strong>${widget.name}</strong><br>Sức chứa: ${num(widget.capacityTons)} tấn<br>Tồn: ${num(widget.currentStockTons)} tấn<br>Trống: ${num(widget.freeTons)} tấn<br>${widget.label}`)
          .addTo(map));
      }

      for (const route of layers.waterways ?? []) {
        if (!route.geometry) continue;
        overlays.push(L.geoJSON(route.geometry, {
          style: { color: '#6E9BBE', weight: route.status === 'da_xac_nhan' ? 3 : 2, dashArray: route.status === 'da_xac_nhan' ? null : '6 4' },
        }).bindPopup(`<strong>${route.name}</strong><br>${route.lengthLabel}<br>Tải trọng tối đa: ${num(route.maxLoadTons)} tấn<br>Rộng ${num(route.widthM)} m · sâu ${num(route.depthM)} m<br>Nguồn: ${SOURCE_LABEL[route.dataSource] ?? route.dataSource} · ${route.status === 'da_xac_nhan' ? 'Đã xác nhận' : 'Nháp'}`)
          .addTo(map));
      }

      for (const route of layers.roads ?? []) {
        if (!route.geometry) continue;
        overlays.push(L.geoJSON(route.geometry, { style: { color: '#C85A22', weight: 2 } })
          .bindPopup(`${route.name} — ${route.lengthLabel}`).addTo(map));
      }

      for (const item of layers.crop_calendar ?? []) {
        const month = item.harvest_date ? Number(String(item.harvest_date).slice(5, 7)) : 0;
        const color = ['#8B5E3C', '#1C8C74', '#3E7A3A', '#7AAE68', '#D9A441', '#C85A22',
          '#A3372A', '#6E9BBE', '#2A78D6', '#9C6414', '#5B4B8A', '#4A7C59'][month - 1] ?? '#9AA5A0';
        overlays.push(L.circleMarker([item.lat, item.lng], {
          radius: 6, color, fillColor: color, fillOpacity: 0.7, weight: 1,
        }).bindTooltip(`${item.commune} — thu hoạch ${item.harvest_date ?? 'chưa rõ'}`)
          .bindPopup(`<strong>${item.commune}</strong>${item.district ? ` (${item.district})` : ''}<br>` +
            `Vụ: ${item.season_name}<br>Diện tích gieo sạ: ${num(item.area_ha)} ha<br>` +
            `Xuống giống: ${item.sowing_date ?? '—'} <em>(${item.sowing_date_source ?? 'không có'})</em><br>` +
            `Thu hoạch: ${item.harvest_date ?? '—'}<br>Sản lượng: ${num(item.output_tons)} tấn<br>` +
            `Độ chính xác vị trí: ${item.geocode_precision === 'huyen' ? 'cấp huyện' : 'cấp tỉnh'}`)
          .addTo(map));
      }

      for (const plot of layers.plots ?? []) {
        if (!plot.boundary) continue;
        overlays.push(L.geoJSON(plot.boundary, { style: { color: '#3E7A3A', weight: 1, fillOpacity: 0.15 } })
          .bindTooltip(`${plot.code} — ${num(plot.area_ha, 3)} ha`).addTo(map));
      }

      if (bundle.bounds && overlays.length) {
        map.fitBounds([[bundle.bounds.south, bundle.bounds.west], [bundle.bounds.north, bundle.bounds.east]], { padding: [24, 24] });
      }
    }

    await refresh();
  },
});

// ---------------------------------------------------------------------------
// FN-20 — Số hoá & đo tuyến đường thuỷ
// ---------------------------------------------------------------------------

registerPage('waterways', {
  title: 'Số hoá & đo tuyến đường thuỷ (FN-20)',
  subtitle: 'Vẽ tuyến trên nền bản đồ · hệ thống tự đo chiều dài geodesic · chỉ tuyến "Đã xác nhận" mới tham gia định tuyến',
  async render(view, actions) {
    const routes = await guard(api('/gis/routes'));
    const editable = can('gis.write');

    const points = [];
    const measureBox = el('div', { class: 'card' });
    const mapNode = mapContainer('ww-map', 'tall');
    const listBox = el('div');

    const form = el('div', { class: 'card' }, [
      el('h3', { text: 'Tuyến đang vẽ' }),
      el('p', { class: 'muted', text: 'Nhấp lên bản đồ để thêm đỉnh. Chiều dài do hệ thống tính — không nhập tay được (BR-03).' }),
      measureBox,
      el('div', { class: 'row' }, [
        el('label', {}, ['Tên tuyến', el('input', { id: 'ww-name', placeholder: 'VD: Kênh Nguyễn Văn Tiếp' })]),
        el('label', {}, ['Loại', el('select', { id: 'ww-mode' }, [
          el('option', { value: 'waterway' }, ['Đường thuỷ']),
          el('option', { value: 'road' }, ['Đường bộ']),
        ])]),
      ]),
      el('div', { class: 'row' }, [
        el('label', {}, ['Tải trọng sà lan tối đa (tấn)', el('input', { id: 'ww-load', type: 'number', value: '300' })]),
        el('label', {}, ['Chiều rộng (m)', el('input', { id: 'ww-width', type: 'number', value: '60' })]),
        el('label', {}, ['Độ sâu (m)', el('input', { id: 'ww-depth', type: 'number', value: '3.5' })]),
        el('label', {}, ['Tĩnh không cầu (m)', el('input', { id: 'ww-clearance', type: 'number', placeholder: 'không bắt buộc' })]),
      ]),
      el('div', { class: 'chip-row' }, [
        el('button', { class: 'small', text: '💾 Lưu tuyến (Nháp)', disabled: !editable, onclick: () => save() }),
        el('button', { class: 'ghost small', text: '↶ Hoàn tác đỉnh cuối', onclick: () => { points.pop(); redraw(); } }),
        el('button', { class: 'ghost small', text: '🗑 Xoá toàn tuyến', onclick: () => { points.length = 0; redraw(); } }),
      ]),
      el('p', { class: 'muted', text: 'BR-07: chiều dài tuyến số hoá là giá trị ƯỚC LƯỢNG phục vụ so sánh phương án đầu tư; không có giá trị pháp lý và không thay thế số liệu đo đạc thực địa.' }),
    ]);

    actions.append(
      el('button', { class: 'ghost small', text: '⤓ GeoJSON', onclick: () => window.open('/api/gis/routes/export.geojson?mode=waterway', '_blank') }),
      el('button', { class: 'ghost small', text: '⤓ KML (Google Earth)', onclick: () => window.open('/api/gis/routes/export.kml?mode=waterway', '_blank') }),
    );

    view.replaceChildren(el('div', { class: 'split' }, [form, card(null, mapNode)]), listBox);

    let map = null;
    let drawn = [];
    let existing = [];

    function renderMeasure(result) {
      measureBox.replaceChildren(
        el('div', { class: 'grid cols-3' }, [
          kpi('Số đỉnh', num(points.length)),
          kpi('Chiều dài', result ? result.label : '—'),
          kpi('Số phân đoạn', num(Math.max(0, points.length - 1))),
        ]),
        result && result.segments.length
          ? el('details', { class: 'raw' }, [
              el('summary', { class: 'muted', text: 'Chiều dài từng phân đoạn' }),
              el('pre', { text: result.segments.map((s) => `Đoạn ${s.index}: ${s.meters.toLocaleString('vi-VN')} m`).join('\n') }),
            ])
          : null,
      );
    }

    async function measure() {
      if (points.length < 2) {
        renderMeasure(null);
        return;
      }
      const result = await api('/gis/measure', { body: { points } }).catch(() => null);
      renderMeasure(result);
    }

    function redraw() {
      if (!LEAFLET_AVAILABLE()) {
        measure();
        return;
      }
      drawn.forEach((layer) => map.removeLayer(layer));
      drawn = [];
      const L = window.L;
      if (points.length) {
        drawn.push(L.polyline(points.map((p) => [p.lat, p.lng]), { color: '#9C6414', weight: 4 }).addTo(map));
        points.forEach((point, index) => {
          drawn.push(L.circleMarker([point.lat, point.lng], { radius: 5, color: '#9C6414', fillOpacity: 1 })
            .bindTooltip(`Đỉnh ${index + 1}`).addTo(map));
        });
      }
      measure();
    }

    function drawExisting(list) {
      if (!LEAFLET_AVAILABLE()) return;
      existing.forEach((layer) => map.removeLayer(layer));
      existing = [];
      const L = window.L;
      for (const route of list) {
        const geometry = JSON.parse(route.geometry);
        existing.push(L.geoJSON(geometry, {
          style: {
            color: route.status === 'da_xac_nhan' ? '#6E9BBE' : '#7C8B82',
            weight: 3, dashArray: route.status === 'da_xac_nhan' ? null : '6 4',
          },
        }).bindPopup(`<strong>${route.code} — ${route.name}</strong><br>${route.lengthLabel}<br>${SOURCE_LABEL[route.data_source] ?? route.data_source} · ${route.status === 'da_xac_nhan' ? 'Đã xác nhận' : 'Nháp'}`).addTo(map));
      }
    }

    async function save() {
      const name = document.getElementById('ww-name').value.trim();
      if (!name) return toast('Nhập tên tuyến trước khi lưu.', true);
      if (points.length < 2) return toast('Tuyến phải có tối thiểu 2 đỉnh (BR-01).', true);
      const created = await guard(api('/gis/routes', {
        body: {
          name,
          mode: document.getElementById('ww-mode').value,
          points,
          maxLoadTons: Number(document.getElementById('ww-load').value) || undefined,
          widthM: Number(document.getElementById('ww-width').value) || undefined,
          depthM: Number(document.getElementById('ww-depth').value) || undefined,
          clearanceM: Number(document.getElementById('ww-clearance').value) || undefined,
        },
      }));
      toast(`Đã lưu ${created.route.code} — ${created.lengthLabel}.`);
      for (const warning of created.warnings ?? []) toast(warning.message, true);
      points.length = 0;
      redraw();
      await reloadList();
    }

    async function reloadList() {
      const list = await api('/gis/routes');
      drawExisting(list);
      listBox.replaceChildren(card('Danh mục tuyến đã số hoá', table(
        [
          { key: 'code', label: 'Mã' },
          { key: 'name', label: 'Tên tuyến' },
          { key: 'mode', label: 'Loại', render: (row) => (row.mode === 'waterway' ? 'Đường thuỷ' : 'Đường bộ') },
          { key: 'lengthLabel', label: 'Chiều dài (hệ thống tính)', align: 'right' },
          { key: 'max_load_tons', label: 'Tải trọng', align: 'right', render: (row) => (row.max_load_tons ? `${num(row.max_load_tons)} t` : '—') },
          { key: 'depth_m', label: 'Sâu / Rộng', render: (row) => `${num(row.depth_m)} m / ${num(row.width_m)} m` },
          { key: 'data_source', label: 'Nguồn', render: (row) => badge(SOURCE_LABEL[row.data_source] ?? row.data_source, row.data_source === 'chinh_thuc' ? 'good' : 'warn') },
          {
            key: 'status', label: 'Trạng thái',
            render: (row) => badge(row.status === 'da_xac_nhan' ? 'Đã xác nhận' : 'Nháp', row.status === 'da_xac_nhan' ? 'good' : 'neutral'),
          },
          {
            key: 'action', label: '',
            render: (row) => (editable
              ? el('button', {
                  class: 'ghost small',
                  text: row.status === 'da_xac_nhan' ? 'Chuyển về Nháp' : 'Xác nhận',
                  onclick: async (event) => {
                    event.stopPropagation();
                    await guard(api(`/gis/routes/${row.id}/status`, {
                      body: { status: row.status === 'da_xac_nhan' ? 'nhap' : 'da_xac_nhan' },
                    }));
                    toast('Đã cập nhật trạng thái tuyến.');
                    await reloadList();
                  },
                })
              : '—'),
          },
        ],
        list,
      )));
    }

    if (LEAFLET_AVAILABLE()) {
      map = createMap('ww-map', [10.4, 105.9], 9);
      map.on('click', (event) => {
        points.push({ lat: Number(event.latlng.lat.toFixed(6)), lng: Number(event.latlng.lng.toFixed(6)) });
        redraw();
      });
    }
    renderMeasure(null);
    await reloadList();
  },
});

const SOURCE_LABEL = {
  so_hoa_noi_bo: 'Số hoá nội bộ',
  chinh_thuc: 'Cơ quan quản lý',
  osm: 'OpenStreetMap',
};
const SEVERITY = { cao: 'Cao', trung_binh: 'Trung bình', thap: 'Thấp' };
