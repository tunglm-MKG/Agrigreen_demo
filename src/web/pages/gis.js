/**
 * NỀN TẢNG GIS DÙNG CHUNG — giao diện theo bản mẫu Mekong_Green_GIS_v1.3:
 * bản đồ tràn khung, panel lớp nổi bên trái, thẻ nguồn dữ liệu bên phải, chú
 * giải và thước tỷ lệ ở đáy, tấm chi tiết (sheet) trượt từ phải.
 *
 *   gis           Bản đồ            FN-01..FN-16 (lớp nền, HTX, thửa, hub, tuyến, heatmap, thời tiết, cơ giới hoá, widget kho)
 *   gis-seasons   Mùa vụ & Cảnh báo FN-12/13/15 (heatmap mùa vụ, vùng chín rộ, thời tiết & cảnh báo)
 *   gis-history   Lịch sử & Replay  FN-18/19 (snapshot hàng ngày, xem lại theo ngày, dòng sự kiện)
 *   waterways     Số hoá tuyến      FN-20 (vẽ, đo, xác nhận tuyến đường thuỷ)
 *
 * Màn Quản trị (gis-admin) nằm ở gis-admin.js.
 */
import {
  api, registerPage, el, card, table, badge, alert, kpi, num, tons, pct, dateTime, dateOnly,
  mapContainer, createMap, setBasemap, LEAFLET_AVAILABLE, toast, guard, can, icon, emptyState, svgBarChart, chips,
} from '/app.js';

export const SOURCE_LABEL = { so_hoa_noi_bo: 'Số hoá nội bộ', chinh_thuc: 'Cơ quan quản lý', osm: 'OpenStreetMap' };
const SEVERITY = { cao: 'Cao', trung_binh: 'Trung bình', thap: 'Thấp' };
const STAGE_LABEL = { lam_dat: 'Làm đất', gieo_sa: 'Gieo sạ', cham_soc: 'Chăm sóc', thu_hoach: 'Thu hoạch', sau_thu_hoach: 'Sau thu hoạch' };
const FACILITY_KIND = { hub: 'Hub', warehouse: 'Kho', yard: 'Bãi', factory: 'Nhà máy', plant: 'Nhà máy' };

/** Nhóm lớp theo bản mẫu: Nền tảng · Vận hành · Hạ tầng · Dữ liệu động (nguồn hệ thống khác). */
export const LAYER_GROUPS = [
  { label: 'Nền tảng', layers: [
    { id: 'admin_boundaries', label: 'Ranh giới hành chính', sub: 'Tỉnh / xã sau sắp xếp 2025', icon: 'map', on: true },
    { id: 'cooperatives', label: 'Hợp tác xã', sub: 'Điểm & vùng canh tác', icon: 'building', on: true },
    { id: 'plots', label: 'Thửa ruộng', sub: 'Polygon — chỉ hiện khi zoom ≥ 13', icon: 'plot', on: false },
  ] },
  { label: 'Vận hành', layers: [
    { id: 'facilities', label: 'Kho / Hub / Nhà máy', sub: 'Cơ sở vận hành Mekong Green', icon: 'factory', on: true },
    { id: 'candidate_hubs', label: 'Hub ứng viên', sub: 'Từ mô phỏng đầu tư', icon: 'pin', on: false },
    { id: 'capacity_widgets', label: 'Dung lượng kho', sub: 'Widget % đầy — nguồn ERP', icon: 'database', on: true, source: 'erp' },
  ] },
  { label: 'Hạ tầng', layers: [
    { id: 'waterways', label: 'Đường thuỷ', sub: 'Tuyến đã số hoá, tải trọng sà lan', icon: 'water', on: true },
    { id: 'roads', label: 'Đường bộ', sub: 'Tải trọng cầu / đường', icon: 'truck', on: false },
  ] },
  { label: 'Dữ liệu động', layers: [
    { id: 'crop_heatmap', label: 'Heatmap mùa vụ', sub: 'Giai đoạn sinh trưởng — nguồn App HTX', icon: 'seed', on: true, source: 'app_htx' },
    { id: 'weather', label: 'Thời tiết & cảnh báo', sub: 'Dự báo theo tỉnh', icon: 'weather', on: false },
    { id: 'machinery', label: 'Cơ giới hoá theo khâu', sub: 'Số máy — nguồn Bản đồ CGH', icon: 'tractor', on: false, source: 'ban_do_cgh' },
    { id: 'crop_calendar', label: 'Lịch thời vụ theo xã', sub: 'Nhập từ Excel điều tra', icon: 'calendar', on: false },
  ] },
];
export const LAYER_DEFS = LAYER_GROUPS.flatMap((g) => g.layers);
const LAYER_STORAGE = 'mg.gis.layers';
const SOURCE_TAG = { app_htx: 'APP HTX', ban_do_cgh: 'BẢN ĐỒ CGH', erp: 'ERP' };

function loadLayerPrefs() {
  try { const saved = JSON.parse(localStorage.getItem(LAYER_STORAGE) ?? 'null'); if (Array.isArray(saved)) return new Set(saved); } catch { /* bỏ qua */ }
  return new Set(LAYER_DEFS.filter((l) => l.on).map((l) => l.id));
}
function saveLayerPrefs(set) { try { localStorage.setItem(LAYER_STORAGE, JSON.stringify([...set])); } catch { /* bỏ qua */ } }

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ===========================================================================
// Bản đồ — khung nhìn chính
// ===========================================================================

registerPage('gis', {
  title: 'Bản đồ dùng chung',
  subtitle: 'Chồng xếp đa tầng · dữ liệu động từ App HTX, Bản đồ CGH, ERP · cấp bản đồ chuẩn hoá cho TMS',
  fullBleed: true,
  async render(view, actions) {
    const active = loadLayerPrefs();
    const stage = el('div', { class: 'gis-stage' });
    const mapNode = mapContainer('gis-map');
    const sheet = el('div', { class: 'sheet' });
    const legend = el('div', { class: 'legend' });
    const scalebox = el('div', { class: 'scalebox' });
    const sourceTags = el('div', { class: 'source-tags' });
    const lyrList = el('div', { class: 'lyr-list' });
    const loadNotice = el('p', { class: 'muted', style: 'margin:0', text: 'Nhập tải trọng để lọc tuyến đủ điều kiện (FN-08/09).' });
    let map = null;
    let overlays = [];
    let routeLayers = new Map();
    let bundle = null;
    let suitable = null; // Set id tuyến phù hợp tải trọng, null = không lọc

    // ---- Thanh hành động ----
    const search = el('input', { placeholder: 'Tìm HTX, kho, hub…', style: 'width:220px', class: 'small' });
    const searchBox = el('div', { class: 'row', style: 'position:relative' }, [search]);
    const suggest = el('div', { class: 'bell-panel', hidden: true, style: 'top:42px;width:320px' });
    searchBox.append(suggest);
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      if (!q || !bundle) { suggest.hidden = true; return; }
      const hits = [];
      for (const h of bundle.layers.cooperatives ?? []) if (`${h.code} ${h.name}`.toLowerCase().includes(q)) hits.push({ label: `${h.code} — ${h.name}`, kind: 'HTX', lat: h.lat, lng: h.lng, open: () => openHtx(h) });
      for (const f of bundle.layers.facilities ?? []) if (`${f.code} ${f.name}`.toLowerCase().includes(q)) hits.push({ label: `${f.code} — ${f.name}`, kind: FACILITY_KIND[f.kind] ?? f.kind, lat: f.lat, lng: f.lng, open: () => openFacility(f) });
      for (const u of bundle.layers.admin_boundaries ?? []) if (u.name.toLowerCase().includes(q) && u.centroid_lat) hits.push({ label: u.name, kind: u.level === 'province' ? 'Tỉnh' : 'Xã', lat: u.centroid_lat, lng: u.centroid_lng, open: null });
      suggest.hidden = !hits.length;
      suggest.replaceChildren(...hits.slice(0, 8).map((hit) => el('div', { class: 'notif', onclick: () => {
        suggest.hidden = true; search.value = '';
        if (map && hit.lat) map.flyTo([hit.lat, hit.lng], Math.max(map.getZoom(), 12));
        hit.open?.();
      } }, [el('span', { class: 'dot' }), el('div', {}, [el('div', { class: 'title', text: hit.label }), el('div', { class: 'body', text: hit.kind })])])));
    });
    actions.append(searchBox);
    if (can('gis.write')) {
      actions.append(el('button', { class: 'ghost small', title: 'FN-16', onclick: async () => {
        const result = await guard(api('/gis/publish/tms', { body: {} }));
        toast(`Đã cấp gói bản đồ chuẩn hoá cho TMS (${result.status}).`);
      } }, [icon('upload', 15), 'Cấp cho TMS']));
    }
    actions.append(el('button', { class: 'ghost small', onclick: () => window.open('/api/gis/routes/export.geojson', '_blank') }, [icon('download', 15), 'GeoJSON']));

    // ---- Panel lớp ----
    const baseSwitch = el('div', { class: 'base-switch' });
    const drawBase = () => baseSwitch.replaceChildren(...[['street', 'Đường phố', 'map'], ['satellite', 'Vệ tinh', 'sun'], ['terrain', 'Địa hình', 'leaf']].map(([kind, label, ic]) =>
      el('button', { class: map?.__basemap === kind ? 'on' : '', onclick: () => { setBasemap(map, kind); drawBase(); } }, [icon(ic, 16), label])));
    const drawLayerList = () => {
      lyrList.replaceChildren();
      for (const group of LAYER_GROUPS) {
        lyrList.append(el('div', { class: 'lyr-section', text: group.label }));
        for (const layer of group.layers) {
          const on = active.has(layer.id);
          lyrList.append(el('div', { class: 'lyr' }, [
            el('span', { class: 'ic' }, [icon(layer.icon, 16)]),
            el('div', { class: 'tx' }, [el('b', { text: layer.label }), el('small', { text: layer.sub })]),
            el('button', { class: `switch${on ? ' on' : ''}`, 'aria-label': `Bật/tắt ${layer.label}`, onclick: () => {
              if (active.has(layer.id)) active.delete(layer.id); else active.add(layer.id);
              saveLayerPrefs(active); drawLayerList(); refresh();
            } }),
          ]));
        }
      }
    };
    drawLayerList();
    const loadInput = el('input', { type: 'number', min: '0', step: '10', placeholder: 'Tải trọng (tấn)' });
    const modeSelect = el('select', {}, [el('option', { value: 'waterway' }, ['Đường thuỷ']), el('option', { value: 'road' }, ['Đường bộ'])]);
    const applyLoad = async () => {
      const load = Number(loadInput.value);
      if (!load) { suitable = null; loadNotice.textContent = 'Nhập tải trọng để lọc tuyến đủ điều kiện (FN-08/09).'; paintRoutes(); return; }
      const result = await guard(api(`/gis/routes/suitable?mode=${modeSelect.value}&load=${load}`));
      suitable = new Set(result.suitable);
      loadNotice.textContent = result.notice ?? `${result.suitable.length}/${result.total} tuyến ${modeSelect.value === 'road' ? 'đường bộ' : 'đường thuỷ'} chịu được ≥ ${num(load)} tấn.`;
      if (result.notice) toast(result.notice, true);
      paintRoutes();
    };
    const panel = el('div', { class: 'layers-panel' }, [
      el('div', { class: 'hd' }, [el('span', {}, ['Lớp dữ liệu']), el('small', { text: `${active.size}/${LAYER_DEFS.length} đang bật` })]),
      baseSwitch,
      lyrList,
      el('div', { class: 'load-filter' }, [
        el('div', { class: 'row' }, [loadInput, modeSelect, el('button', { class: 'small', onclick: applyLoad }, [icon('filter', 14), 'Lọc'])]),
        loadNotice,
      ]),
    ]);

    stage.append(mapNode, panel, sourceTags, el('div', { class: 'map-foot' }, [scalebox, legend]), sheet);
    view.replaceChildren(stage);

    // ---- Sheet chi tiết ----
    const closeSheet = () => sheet.classList.remove('open');
    function showSheet(title, eyebrow, body) {
      sheet.replaceChildren(
        el('div', { class: 'sh' }, [el('div', { class: 'eyebrow', style: 'margin:0;color:var(--brand-deep)', text: eyebrow }), el('h3', { text: title }), el('button', { class: 'close', onclick: closeSheet }, [icon('x', 16)])]),
        el('div', { class: 'bd' }, body),
      );
      sheet.classList.add('open');
    }
    async function openHtx(htx) {
      const heat = (bundle?.layers.crop_heatmap ?? []).filter((c) => c.htxId === htx.id || c.htx_id === htx.id);
      const mach = (bundle?.layers.machinery ?? []).filter((m) => m.htx_id === htx.id);
      let plots = [];
      try { plots = await api(`/mdm/plots?htxId=${htx.id}`); } catch { plots = []; }
      showSheet(htx.name, `Hợp tác xã · ${htx.code}`, [
        el('div', { class: 'grid cols-2' }, [
          kpi('Thành viên', num(htx.member_count)), kpi('Diện tích đăng ký', `${num(htx.registered_area_ha)} ha`),
          kpi('Thửa đã vẽ', num(plots.length)), kpi('Diện tích thửa', `${num(plots.reduce((a, p) => a + (p.area_ha ?? 0), 0), 1)} ha`),
        ]),
        el('h4', { text: 'Mùa vụ hiện tại (App HTX)' }),
        heat.length ? el('div', { class: 'list' }, heat.map((c) => el('div', { class: 'list-item', style: 'cursor:default' }, [
          el('span', { style: `width:12px;height:12px;border-radius:3px;background:${c.color};display:inline-block` }),
          el('div', { class: 'grow' }, [el('div', { class: 'title', text: `${c.stageLabel} · ${c.season}` }), el('div', { class: 'muted', text: `Thu hoạch ${c.expectedHarvestDate ?? '—'} · rơm ${num(c.strawTons)} tấn` })]),
        ]))) : el('p', { class: 'muted', text: 'Chưa có dữ liệu mùa vụ từ App HTX.' }),
        el('h4', { text: 'Cơ giới hoá theo khâu (Bản đồ CGH)' }),
        mach.length ? table([
          { key: 'stage', label: 'Khâu', render: (r) => STAGE_LABEL[r.stage] ?? r.stage },
          { key: 'machine_count', label: 'Máy', align: 'right' },
          { key: 'operational_count', label: 'Hoạt động', align: 'right' },
        ], mach, { plain: true }) : el('p', { class: 'muted', text: active.has('machinery') ? 'HTX chưa có máy trong hồ sơ.' : 'Bật lớp "Cơ giới hoá theo khâu" để xem.' }),
        el('div', { class: 'chip-row', style: 'margin-top:12px' }, [
          el('span', { class: 'src-tag live', text: 'APP HTX · live' }), el('span', { class: 'src-tag', text: 'BẢN ĐỒ CGH' }),
        ]),
      ]);
    }
    function openFacility(f) {
      const widget = (bundle?.layers.capacity_widgets ?? []).find((w) => w.id === f.id);
      showSheet(f.name, `${FACILITY_KIND[f.kind] ?? f.kind} · ${f.code}`, [
        el('div', { class: 'grid cols-2' }, [
          kpi('Sức chứa', tons(f.capacity_tons)), kpi('Tồn kho', tons(f.current_stock_tons)),
        ]),
        widget ? el('div', {}, [
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Mức đầy' }), el('span', { class: 'v', style: `color:${widget.color}`, text: `${widget.fillPct}% · ${widget.label}` })]),
          el('div', { class: 'bar thick' }, [el('span', { style: `width:${Math.min(100, widget.fillPct)}%;background:${widget.color}` })]),
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Còn trống' }), el('span', { class: 'v', text: tons(widget.freeTons) })]),
        ]) : el('p', { class: 'muted', text: 'Cơ sở này không có widget dung lượng (chỉ Hub/Kho/Bãi).' }),
        el('p', { class: 'muted', style: 'margin-top:10px' }, [el('span', { class: 'src-tag', text: 'ERP · sức chứa & tồn kho' })]),
      ]);
    }
    function openRoute(route) {
      showSheet(route.name, `${route.mode === 'road' ? 'Đường bộ' : 'Đường thuỷ'} · ${route.code ?? ''}`, [
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Chiều dài (hệ thống đo)' }), el('span', { class: 'v', text: route.lengthLabel })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Tải trọng tối đa' }), el('span', { class: 'v', text: route.maxLoadTons ? `${num(route.maxLoadTons)} tấn` : 'Không xác định' })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Rộng / sâu' }), el('span', { class: 'v', text: `${num(route.widthM)} m / ${num(route.depthM)} m` })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Nguồn' }), el('span', { class: 'v', text: SOURCE_LABEL[route.dataSource] ?? route.dataSource })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Trạng thái' }), badge(route.status === 'da_xac_nhan' ? 'Đã xác nhận' : 'Nháp', route.status === 'da_xac_nhan' ? 'good' : 'neutral')]),
        suitable ? alert(suitable.has(route.id) ? 'Tuyến đủ điều kiện với tải trọng đang lọc.' : 'Tuyến KHÔNG đủ tải trọng đang lọc.', suitable.has(route.id) ? 'good' : 'warn') : null,
      ]);
    }

    // ---- Tải & vẽ ----
    async function refresh() {
      const zoom = map ? map.getZoom() : 8;
      const b = map ? map.getBounds() : null;
      const bbox = b && active.has('plots') ? `&bbox=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}` : '';
      bundle = await guard(api(`/gis/map?layers=${[...active].join(',')}&zoom=${zoom}${bbox}`));
      panel.querySelector('.hd small').textContent = `${active.size}/${LAYER_DEFS.length} đang bật`;
      renderTags();
      renderLegend();
      drawMap();
    }

    function renderTags() {
      const tags = [];
      for (const layer of LAYER_DEFS) if (active.has(layer.id) && layer.source) tags.push(el('span', { class: `src-tag${layer.source === 'app_htx' ? ' live' : ''}`, text: `${SOURCE_TAG[layer.source]} · ${layer.label}` }));
      if (bundle?.layers?.plotsNotice && active.has('plots')) tags.push(el('span', { class: 'src-tag', style: 'color:var(--warning)', text: bundle.layers.plotsNotice }));
      sourceTags.replaceChildren(...tags);
    }

    function renderLegend() {
      const palette = bundle?.legend?.cropPalette ?? {};
      const thresholds = bundle?.legend?.capacityThresholds ?? [];
      const rows = [];
      if (active.has('crop_heatmap')) rows.push(el('div', {}, [el('div', { class: 't', text: 'Giai đoạn mùa vụ' }), el('div', { class: 'row' }, Object.values(palette).map((v) => el('span', { class: 'it' }, [el('i', { style: `background:${v.color}` }), v.label])))]));
      if (active.has('capacity_widgets')) rows.push(el('div', {}, [el('div', { class: 't', text: 'Dung lượng kho' }), el('div', { class: 'row' }, thresholds.map((t) => el('span', { class: 'it' }, [el('i', { style: `background:${t.color}` }), `${t.label} <${t.maxPct}%`])))]));
      if (active.has('waterways') || active.has('roads')) rows.push(el('div', {}, [el('div', { class: 't', text: 'Tuyến' }), el('div', { class: 'row' }, [
        el('span', { class: 'it' }, [el('i', { class: 'ln', style: 'background:#2E8FC0' }), 'Thuỷ đã xác nhận']), el('span', { class: 'it' }, [el('i', { class: 'ln', style: 'background:#9BB8CC' }), 'Thuỷ nháp']),
        el('span', { class: 'it' }, [el('i', { class: 'ln', style: 'background:#C85A22' }), 'Đường bộ']), suitable ? el('span', { class: 'it' }, [el('i', { class: 'ln', style: 'background:#12A150;height:5px' }), 'Đủ tải trọng']) : null,
      ])]));
      legend.replaceChildren(...rows);
      legend.hidden = !rows.length;
    }

    function updateScale() {
      if (!map) return;
      const zoom = map.getZoom();
      const band = (bundle?.zoomBands ?? []).find((b) => zoom >= b.minZoom && zoom <= b.maxZoom);
      const center = map.getCenter();
      scalebox.replaceChildren(el('b', { text: `Zoom ${zoom} · ${band?.label ?? ''}` }), el('span', { text: `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)} · WGS84` }));
    }

    function paintRoutes() {
      for (const [id, entry] of routeLayers) {
        const ok = suitable ? suitable.has(id) : null;
        entry.layer.setStyle({
          color: ok === true ? '#12A150' : entry.base.color, weight: ok === true ? 5 : entry.base.weight,
          opacity: ok === false ? 0.25 : 1, dashArray: entry.base.dashArray,
        });
      }
      renderLegend();
    }

    function drawMap() {
      if (!LEAFLET_AVAILABLE()) return;
      const L = window.L;
      if (!map) {
        map = createMap('gis-map', [10.2, 105.8], 8, { layersControl: false, scrollZoom: true });
        L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
        map.on('zoomend moveend', () => { updateScale(); if (active.has('plots')) refresh(); });
        map.on('click', closeSheet);
        drawBase();
        setTimeout(() => map.invalidateSize(), 50);
      }
      overlays.forEach((layer) => map.removeLayer(layer));
      overlays = [];
      routeLayers = new Map();
      const layers = bundle.layers ?? {};

      for (const unit of layers.admin_boundaries ?? []) {
        if (!unit.boundary) continue;
        overlays.push(L.geoJSON(unit.boundary, { style: { color: unit.level === 'province' ? '#12241A' : '#5E7268', weight: unit.level === 'province' ? 1.5 : 1, fillOpacity: 0.02, dashArray: '4 3' } })
          .bindTooltip(unit.name, { sticky: true }).addTo(map));
      }
      for (const item of layers.crop_heatmap ?? []) {
        if (!item.boundary) continue;
        overlays.push(L.geoJSON(item.boundary, { style: { color: item.color, weight: 1, fillOpacity: 0.4 } })
          .bindTooltip(`${item.name} — ${item.stageLabel}`, { sticky: true })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); const htx = (layers.cooperatives ?? []).find((h) => h.id === item.htxId) ?? { id: item.htxId, code: item.code, name: item.name, member_count: null, registered_area_ha: null }; openHtx(htx); })
          .addTo(map));
      }
      for (const htx of layers.cooperatives ?? []) {
        if (htx.boundary) overlays.push(L.geoJSON(htx.boundary, { style: { color: '#12A150', weight: 1.5, fillOpacity: 0.08 } }).addTo(map));
        overlays.push(L.circleMarker([htx.lat, htx.lng], { radius: 6, color: '#fff', fillColor: '#12A150', fillOpacity: 1, weight: 2 })
          .bindTooltip(`${htx.code} — ${htx.name}`)
          .on('click', (e) => { L.DomEvent.stopPropagation(e); openHtx(htx); }).addTo(map));
      }
      for (const facility of layers.facilities ?? []) {
        const marker = L.marker([facility.lat, facility.lng], { icon: L.divIcon({ className: '', html: `<div class="hub-marker" title="${escapeHtml(facility.name)}">${facility.kind === 'factory' || facility.kind === 'plant' ? '🏭' : '📦'}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }) })
          .bindTooltip(`${facility.code} — ${facility.name}`)
          .on('click', (e) => { L.DomEvent.stopPropagation(e); openFacility(facility); });
        overlays.push(marker.addTo(map));
      }
      for (const hub of layers.candidate_hubs ?? []) {
        overlays.push(L.circleMarker([hub.lat, hub.lng], { radius: 8, color: '#C9821A', fillColor: '#C9821A', fillOpacity: 0.5, weight: 2, dashArray: '3 3' })
          .bindTooltip(`Hub ứng viên: ${hub.name}`).addTo(map));
      }
      for (const widget of layers.capacity_widgets ?? []) {
        overlays.push(L.circleMarker([widget.lat, widget.lng], { radius: 13, color: widget.color, fillColor: widget.color, fillOpacity: 0.75, weight: 2 })
          .bindTooltip(`${widget.name}: ${widget.fillPct}%`, { permanent: true, direction: 'top', className: 'capacity-label' })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); const f = (layers.facilities ?? []).find((x) => x.id === widget.id) ?? { ...widget, capacity_tons: widget.capacityTons, current_stock_tons: widget.currentStockTons }; openFacility(f); })
          .addTo(map));
      }
      const addRoute = (route, base) => {
        if (!route.geometry) return;
        const layer = L.geoJSON(route.geometry, { style: base }).bindTooltip(`${route.name} · ${route.lengthLabel}`, { sticky: true })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); openRoute(route); }).addTo(map);
        overlays.push(layer);
        routeLayers.set(route.id, { layer, base });
      };
      for (const route of layers.waterways ?? []) addRoute(route, { color: route.status === 'da_xac_nhan' ? '#2E8FC0' : '#9BB8CC', weight: route.status === 'da_xac_nhan' ? 3.5 : 2, dashArray: route.status === 'da_xac_nhan' ? null : '6 4' });
      for (const route of layers.roads ?? []) addRoute(route, { color: '#C85A22', weight: 2.5, dashArray: null });
      if (suitable) paintRoutes();

      for (const wx of layers.weather?.forecast ?? []) {
        if (!wx.centroid_lat) continue;
        const alertLevel = Boolean(wx.severity);
        overlays.push(L.marker([wx.centroid_lat, wx.centroid_lng], { icon: L.divIcon({ className: '', html: `<div class="wx-pin${alertLevel ? ' alert' : ''}">${Math.round(wx.temp_c ?? 0)}°</div>`, iconSize: [40, 40], iconAnchor: [20, 20] }) })
          .bindPopup(`<strong>${escapeHtml(wx.area_name)}</strong> · ${wx.observed_for}<br>Mưa ${num(wx.rainfall_mm)} mm · Ẩm ${num(wx.humidity_pct)}% · ${num(wx.temp_c)}°C${wx.severity ? `<br><b style="color:#DC5236">${escapeHtml(wx.headline ?? wx.severity)}</b>` : ''}`).addTo(map));
      }
      const machByHtx = new Map();
      for (const m of layers.machinery ?? []) { const e = machByHtx.get(m.htx_id) ?? { ...m, stages: [] }; e.stages.push(m); machByHtx.set(m.htx_id, e); }
      for (const m of machByHtx.values()) {
        const total = m.stages.reduce((a, s) => a + s.machine_count, 0);
        overlays.push(L.circleMarker([m.lat, m.lng], { radius: 8 + Math.min(12, Math.sqrt(total) * 2), color: '#B4744A', fillColor: '#EAB308', fillOpacity: 0.55, weight: 2 })
          .bindPopup(`<strong>${escapeHtml(m.name)}</strong> · ${total} máy<br>${m.stages.map((s) => `${STAGE_LABEL[s.stage] ?? s.stage}: ${s.operational_count}/${s.machine_count} hoạt động`).join('<br>')}`).addTo(map));
      }
      for (const item of layers.crop_calendar ?? []) {
        const month = item.harvest_date ? Number(String(item.harvest_date).slice(5, 7)) : 0;
        const color = ['#8B5E3C', '#1C8C74', '#3E7A3A', '#7AAE68', '#D9A441', '#C85A22', '#A3372A', '#6E9BBE', '#2A78D6', '#9C6414', '#5B4B8A', '#4A7C59'][month - 1] ?? '#9AA5A0';
        overlays.push(L.circleMarker([item.lat, item.lng], { radius: 6, color, fillColor: color, fillOpacity: 0.7, weight: 1 })
          .bindTooltip(`${item.commune} — thu hoạch ${item.harvest_date ?? 'chưa rõ'}`)
          .bindPopup(`<strong>${escapeHtml(item.commune)}</strong>${item.district ? ` (${escapeHtml(item.district)})` : ''}<br>Vụ: ${escapeHtml(item.season_name)}<br>Gieo sạ: ${num(item.area_ha)} ha · xuống giống ${item.sowing_date ?? '—'}<br>Thu hoạch: ${item.harvest_date ?? '—'} · ${num(item.output_tons)} tấn`).addTo(map));
      }
      for (const plot of layers.plots ?? []) {
        if (!plot.boundary) continue;
        overlays.push(L.geoJSON(plot.boundary, { style: { color: '#0B7A3A', weight: 1, fillOpacity: 0.15 } }).bindTooltip(`${plot.code} — ${num(plot.area_ha, 3)} ha`).addTo(map));
      }
      if (!drawMap.fitted && bundle.bounds && overlays.length) {
        drawMap.fitted = true;
        map.fitBounds([[bundle.bounds.south, bundle.bounds.west], [bundle.bounds.north, bundle.bounds.east]], { padding: [40, 40] });
      }
      updateScale();
    }

    await refresh();
  },
});

// ===========================================================================
// Mùa vụ & Cảnh báo — FN-12 heatmap, FN-13 vùng chín rộ, FN-15 thời tiết
// ===========================================================================

registerPage('gis-seasons', {
  title: 'Mùa vụ & Cảnh báo',
  subtitle: 'Heatmap giai đoạn sinh trưởng từ App HTX · vùng sắp chín rộ · thời tiết và cảnh báo theo tỉnh',
  async render(view, actions) {
    let days = 3;
    const [heat, weather] = await Promise.all([guard(api('/gis/heatmap')), api('/gis/weather').catch(() => ({ forecast: [], alerts: [] }))]);
    const items = Array.isArray(heat) ? heat : (heat.items ?? heat.rows ?? []);
    const palette = heat.palette ?? {};
    const alertsBox = el('div');
    const mapNode = mapContainer('gis-season-map');

    actions.append(chips([{ value: 3, label: '3 ngày' }, { value: 7, label: '7 ngày' }, { value: 14, label: '14 ngày' }], days, async (v) => { days = v; await drawAlerts(); }));

    const byStage = new Map();
    for (const it of items) { const k = it.stageLabel ?? it.stage; const e = byStage.get(k) ?? { label: k, color: it.color, n: 0, straw: 0 }; e.n += 1; e.straw += it.strawTons ?? 0; byStage.set(k, e); }
    const stageRows = [...byStage.values()];
    const alertsWx = (weather.alerts ?? []).length ? weather.alerts : (weather.forecast ?? []).filter((w) => w.severity);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('HTX có dữ liệu mùa vụ', num(items.length), 'Nguồn: App Hợp tác xã', null, 'seed'),
        kpi('Đang thu hoạch', num(items.filter((i) => i.stage === 'thu_hoach').length), 'Cần bố trí máy gặt & thu gom rơm', null, 'harvest'),
        kpi('Rơm dự kiến', tons(items.reduce((a, i) => a + (i.strawTons ?? 0), 0)), 'Tổng trên toàn vùng', null, 'leaf'),
        kpi('Cảnh báo thời tiết', num(alertsWx.length), alertsWx.length ? 'Có tỉnh đang cảnh báo' : 'Không có cảnh báo', null, 'warning'),
      ]),
      el('div', { class: 'split wide-left' }, [
        card('Phân bố giai đoạn sinh trưởng', [
          stageRows.length ? svgBarChart(stageRows.map((s) => ({ label: s.label, value: s.n, color: s.color })), { height: 200, format: (v) => num(v) }) : emptyState('Chưa có dữ liệu mùa vụ.'),
          el('div', { class: 'legend-row' }, stageRows.map((s) => el('span', {}, [el('i', { style: `background:${s.color}` }), `${s.label}: ${s.n} HTX · ${num(s.straw)} tấn rơm`]))),
        ]),
        card('Bản đồ heatmap mùa vụ', mapNode),
      ]),
      alertsBox,
      el('div', { class: 'grid cols-2' }, [
        card('Trạng thái mùa vụ theo HTX', table([
          { key: 'name', label: 'HTX' },
          { key: 'stageLabel', label: 'Giai đoạn', render: (r) => el('span', { class: 'badge', style: `background:${r.color}22;color:${r.color}` }, [r.stageLabel ?? r.stage]) },
          { key: 'season', label: 'Vụ' },
          { key: 'expectedHarvestDate', label: 'Thu hoạch dự kiến' },
          { key: 'strawTons', label: 'Rơm (tấn)', align: 'right', render: (r) => num(r.strawTons) },
        ], items, { empty: 'App HTX chưa gửi dữ liệu mùa vụ.' })),
        card('Thời tiết & cảnh báo theo tỉnh (FN-15)', [
          alertsWx.length ? el('div', {}, alertsWx.map((w) => alert(`${w.area_name ?? ''} · ${w.observed_for}: ${w.headline ?? w.severity}`, 'bad'))) : alert('Không có cảnh báo thời tiết trong kỳ dự báo.', 'good'),
          table([
            { key: 'area_name', label: 'Tỉnh' },
            { key: 'observed_for', label: 'Ngày' },
            { key: 'rainfall_mm', label: 'Mưa (mm)', align: 'right', render: (r) => num(r.rainfall_mm) },
            { key: 'humidity_pct', label: 'Ẩm (%)', align: 'right', render: (r) => num(r.humidity_pct) },
            { key: 'temp_c', label: '°C', align: 'right', render: (r) => num(r.temp_c) },
          ], (weather.forecast ?? []).slice(0, 30), { empty: 'Chưa có dữ liệu dự báo.' }),
        ]),
      ]),
    );

    async function drawAlerts() {
      const alerts = await api(`/gis/harvest-alerts?days=${days}`).catch(() => []);
      alertsBox.replaceChildren(card(`Vùng sắp chín rộ trong ${days} ngày tới (FN-13)`, alerts.length ? table([
        { key: 'name', label: 'HTX' },
        { key: 'expected_harvest_date', label: 'Ngày thu hoạch' },
        { key: 'straw_tons', label: 'Rơm dự kiến', align: 'right', render: (r) => tons(r.straw_tons) },
        { key: 'severity', label: 'Mức', render: (r) => badge(SEVERITY[r.severity] ?? r.severity, r.severity === 'cao' ? 'bad' : r.severity === 'trung_binh' ? 'warn' : 'neutral') },
      ], alerts) : alert(`Không có vùng nào chín rộ trong ${days} ngày tới.`, 'info'),
      el('span', { class: 'muted', text: 'Gửi kho & logistics chuẩn bị năng lực tiếp nhận' })));
    }
    await drawAlerts();

    if (LEAFLET_AVAILABLE()) {
      const map = createMap('gis-season-map', [10.2, 105.8], 8);
      const group = [];
      for (const item of items) {
        if (item.boundary) group.push(window.L.geoJSON(item.boundary, { style: { color: item.color, weight: 1, fillOpacity: 0.45 } }).bindTooltip(`${item.name} — ${item.stageLabel}`).addTo(map));
        else if (item.lat) group.push(window.L.circleMarker([item.lat, item.lng], { radius: 7, color: item.color, fillColor: item.color, fillOpacity: 0.8 }).bindTooltip(`${item.name} — ${item.stageLabel}`).addTo(map));
      }
      if (group.length) map.fitBounds(window.L.featureGroup(group).getBounds(), { padding: [30, 30] });
      void palette;
    }
  },
});

// ===========================================================================
// Lịch sử & Replay — FN-18 snapshot, FN-19 xem lại theo ngày
// ===========================================================================

registerPage('gis-history', {
  title: 'Lịch sử & Replay',
  subtitle: 'Xem lại trạng thái bản đồ tại một ngày bất kỳ · dòng sự kiện là nguồn sự thật, snapshot chỉ để truy vấn nhanh',
  fullBleed: true,
  async render(view, actions) {
    const stage = el('div', { class: 'gis-stage' });
    const mapNode = mapContainer('gis-history-map');
    const eventlog = el('div', { class: 'eventlog' });
    const info = el('div', { class: 'time-info' });
    const range = el('input', { type: 'range', min: '0', max: '29', value: '29', step: '1' });
    const playBtn = el('button', { class: 'play-btn', 'aria-label': 'Phát' }, [icon('play', 18)]);
    const basisBadge = el('span');
    const ticks = el('div', { class: 'ticks' });
    const DAYS = 30;
    const dates = Array.from({ length: DAYS }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (DAYS - 1 - i)); return d.toISOString().slice(0, 10); });
    ticks.replaceChildren(...[0, 7, 14, 21, 29].map((i) => el('span', { text: dates[i].slice(5) })));
    let map = null; let overlays = []; let timer = null; let index = DAYS - 1;

    if (can('gis.admin')) {
      actions.append(el('button', { class: 'ghost small', onclick: async () => {
        const result = await guard(api('/audit/snapshot', { body: {} }));
        toast(`Đã chụp snapshot hôm nay: ${result.layers.map((l) => `${l.layer} ${l.count}`).join(', ')}.`);
        await show(index);
      } }, [icon('camera', 15), 'Chụp snapshot hôm nay']));
    }
    actions.append(el('button', { class: 'ghost small', onclick: () => window.open('/api/audit/events?limit=500', '_blank') }, [icon('download', 15), 'Sự kiện (JSON)']));

    const timebar = el('div', { class: 'timebar' }, [
      el('div', { class: 'tr1' }, [
        playBtn, info, basisBadge,
        el('div', { class: 'track', style: 'flex:1;min-width:200px' }, [range, ticks]),
        el('input', { type: 'date', value: dates[index], max: dates[DAYS - 1], style: 'width:150px', onchange: (e) => { const i = dates.indexOf(e.target.value); if (i >= 0) { index = i; range.value = String(i); show(i); } else { showDate(e.target.value); } } }),
      ]),
    ]);
    stage.append(mapNode, eventlog, timebar);
    view.replaceChildren(stage);

    range.addEventListener('input', () => { index = Number(range.value); show(index); });
    playBtn.addEventListener('click', () => {
      if (timer) { clearInterval(timer); timer = null; playBtn.replaceChildren(icon('play', 18)); return; }
      playBtn.replaceChildren(icon('pause', 18));
      if (index >= DAYS - 1) index = 0;
      timer = setInterval(() => {
        index += 1; range.value = String(index); show(index);
        if (index >= DAYS - 1) { clearInterval(timer); timer = null; playBtn.replaceChildren(icon('play', 18)); }
      }, 900);
    });

    async function show(i) { await showDate(dates[i]); }
    async function showDate(date) {
      const [replay, events] = await Promise.all([
        api(`/audit/replay/${date}`).catch(() => ({ date, basis: 'empty', layers: {}, appliedEvents: 0 })),
        api('/audit/events?limit=200').catch(() => []),
      ]);
      const dayEvents = events.filter((e) => String(e.occurred_at ?? '').slice(0, 10) <= date).slice(0, 60);
      info.replaceChildren(el('b', { text: dateOnly(date) }), el('small', { text: `${Object.values(replay.layers).reduce((a, l) => a + (l?.length ?? 0), 0)} bản ghi · ${replay.appliedEvents} sự kiện áp lên snapshot` }));
      basisBadge.replaceChildren(badge(replay.basis === 'snapshot' ? 'Snapshot đúng ngày' : replay.basis === 'reconstructed' ? 'Tái dựng từ snapshot trước + event log' : 'Chưa có snapshot trước ngày này', replay.basis === 'snapshot' ? 'good' : replay.basis === 'reconstructed' ? 'info' : 'warn'));
      eventlog.replaceChildren(
        el('div', { class: 'eh' }, [el('span', { text: 'Dòng sự kiện' }), el('small', { class: 'muted', text: `đến ${dateOnly(date)}` })]),
        el('div', { class: 'eb' }, dayEvents.length ? dayEvents.map((e) => el('div', { class: 'ev' }, [
          el('span', { class: 'ed', style: e.action === 'delete' ? 'background:var(--critical)' : e.action === 'create' ? 'background:var(--good)' : '' }),
          el('div', { class: 'et' }, [el('b', { text: `${e.module} · ${e.entity_type} · ${e.action}` }), el('small', { text: `${e.actor_name ?? 'hệ thống'} · ${e.entity_id ?? ''}` })]),
          el('span', { class: 'tm', text: String(e.occurred_at ?? '').slice(5, 16).replace('T', ' ') }),
        ])) : [emptyState('Không có sự kiện.', 'history')]),
      );
      drawReplay(replay);
    }

    function drawReplay(replay) {
      if (!LEAFLET_AVAILABLE()) return;
      const L = window.L;
      if (!map) { map = createMap('gis-history-map', [10.2, 105.8], 8, { scrollZoom: true }); setTimeout(() => map.invalidateSize(), 50); }
      overlays.forEach((o) => map.removeLayer(o)); overlays = [];
      const stageOf = new Map((replay.layers.crop_status ?? []).map((c) => [c.htx_id, c]));
      const palette = { chuan_bi: '#8B5E3C', gieo_sa: '#7AAE68', sinh_truong: '#1C8C74', tro_bong: '#D9A441', chin: '#C85A22', thu_hoach: '#A3372A', sau_thu_hoach: '#6E9BBE' };
      for (const htx of replay.layers.cooperatives ?? []) {
        if (!htx.lat) continue;
        const cs = stageOf.get(htx.id);
        const color = cs ? (palette[cs.stage] ?? '#12A150') : '#93A399';
        overlays.push(L.circleMarker([htx.lat, htx.lng], { radius: 7, color: '#fff', fillColor: color, fillOpacity: 1, weight: 2 })
          .bindTooltip(`${htx.code} — ${htx.name}${cs ? ` · ${cs.stage}` : ''}`).addTo(map));
      }
      for (const f of replay.layers.facilities ?? []) {
        if (!f.lat || f.deleted_at) continue;
        overlays.push(L.circleMarker([f.lat, f.lng], { radius: 9, color: '#2E8FC0', fillColor: '#2E8FC0', fillOpacity: 0.8, weight: 2 })
          .bindTooltip(`${f.code} — ${f.name}${f.capacity_tons ? ` · ${num(f.current_stock_tons)}/${num(f.capacity_tons)} t` : ''}`).addTo(map));
      }
      for (const p of replay.layers.plots ?? []) {
        if (!p.centroid_lat) continue;
        overlays.push(L.circleMarker([p.centroid_lat, p.centroid_lng], { radius: 3, color: '#0B7A3A', fillOpacity: 0.7, weight: 1 }).bindTooltip(`${p.code} · ${num(p.area_ha, 2)} ha`).addTo(map));
      }
    }

    await show(index);
  },
});

// ===========================================================================
// FN-20 — Số hoá & đo tuyến đường thuỷ
// ===========================================================================

registerPage('waterways', {
  title: 'Số hoá & đo tuyến đường thuỷ',
  subtitle: 'Vẽ tuyến trên nền bản đồ · hệ thống tự đo chiều dài geodesic · chỉ tuyến "Đã xác nhận" mới tham gia định tuyến (FN-20)',
  async render(view, actions) {
    const routes = await guard(api('/gis/routes'));
    const editable = can('gis.write');

    const points = [];
    const measureBox = el('div');
    const mapNode = mapContainer('ww-map', 'tall');
    const listBox = el('div');

    const form = el('div', { class: 'card' }, [
      el('h3', { text: 'Tuyến đang vẽ' }),
      el('p', { class: 'muted', text: 'Nhấp lên bản đồ để thêm đỉnh. Chiều dài do hệ thống tính — không nhập tay được (BR-03).' }),
      measureBox,
      el('div', { class: 'row' }, [
        el('label', {}, ['Tên tuyến', el('input', { id: 'ww-name', placeholder: 'VD: Kênh Nguyễn Văn Tiếp' })]),
        el('label', {}, ['Loại', el('select', { id: 'ww-mode' }, [el('option', { value: 'waterway' }, ['Đường thuỷ']), el('option', { value: 'road' }, ['Đường bộ'])])]),
      ]),
      el('div', { class: 'row' }, [
        el('label', {}, ['Tải trọng tối đa (tấn)', el('input', { id: 'ww-load', type: 'number', value: '300' })]),
        el('label', {}, ['Chiều rộng (m)', el('input', { id: 'ww-width', type: 'number', value: '60' })]),
        el('label', {}, ['Độ sâu (m)', el('input', { id: 'ww-depth', type: 'number', value: '3.5' })]),
        el('label', {}, ['Tĩnh không cầu (m)', el('input', { id: 'ww-clearance', type: 'number', placeholder: 'không bắt buộc' })]),
      ]),
      el('div', { class: 'chip-row' }, [
        el('button', { class: 'small', disabled: !editable, onclick: () => save() }, [icon('check', 14), 'Lưu tuyến (Nháp)']),
        el('button', { class: 'ghost small', onclick: () => { points.pop(); redraw(); } }, [icon('back', 14), 'Hoàn tác đỉnh cuối']),
        el('button', { class: 'ghost small', onclick: () => { points.length = 0; redraw(); } }, [icon('trash', 14), 'Xoá toàn tuyến']),
      ]),
      el('p', { class: 'muted', text: 'BR-07: chiều dài tuyến số hoá là giá trị ƯỚC LƯỢNG phục vụ so sánh phương án đầu tư; không có giá trị pháp lý và không thay thế số liệu đo đạc thực địa.' }),
    ]);

    actions.append(
      el('button', { class: 'ghost small', onclick: () => window.open('/api/gis/routes/export.geojson?mode=waterway', '_blank') }, [icon('download', 15), 'GeoJSON']),
      el('button', { class: 'ghost small', onclick: () => window.open('/api/gis/routes/export.kml?mode=waterway', '_blank') }, [icon('download', 15), 'KML']),
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
          kpi('Phân đoạn', num(Math.max(0, points.length - 1))),
        ]),
        result && result.segments.length
          ? el('details', { class: 'raw' }, [el('summary', { class: 'muted', text: 'Chiều dài từng phân đoạn' }), el('pre', { text: result.segments.map((s) => `Đoạn ${s.index}: ${s.meters.toLocaleString('vi-VN')} m`).join('\n') })])
          : null,
      );
    }
    async function measure() {
      if (points.length < 2) { renderMeasure(null); return; }
      renderMeasure(await api('/gis/measure', { body: { points } }).catch(() => null));
    }
    function redraw() {
      if (!LEAFLET_AVAILABLE()) { measure(); return; }
      drawn.forEach((layer) => map.removeLayer(layer));
      drawn = [];
      const L = window.L;
      if (points.length) {
        drawn.push(L.polyline(points.map((p) => [p.lat, p.lng]), { color: '#C9821A', weight: 4 }).addTo(map));
        points.forEach((point, i) => { drawn.push(L.circleMarker([point.lat, point.lng], { radius: 5, color: '#C9821A', fillOpacity: 1 }).bindTooltip(`Đỉnh ${i + 1}`).addTo(map)); });
      }
      measure();
    }
    function drawExisting(list) {
      if (!LEAFLET_AVAILABLE()) return;
      existing.forEach((layer) => map.removeLayer(layer));
      existing = [];
      for (const route of list) {
        const geometry = JSON.parse(route.geometry);
        existing.push(window.L.geoJSON(geometry, { style: { color: route.status === 'da_xac_nhan' ? '#2E8FC0' : '#93A399', weight: 3, dashArray: route.status === 'da_xac_nhan' ? null : '6 4' } })
          .bindPopup(`<strong>${escapeHtml(route.code)} — ${escapeHtml(route.name)}</strong><br>${route.lengthLabel}<br>${SOURCE_LABEL[route.data_source] ?? route.data_source} · ${route.status === 'da_xac_nhan' ? 'Đã xác nhận' : 'Nháp'}`).addTo(map));
      }
    }
    async function save() {
      const name = document.getElementById('ww-name').value.trim();
      if (!name) return toast('Nhập tên tuyến trước khi lưu.', true);
      if (points.length < 2) return toast('Tuyến phải có tối thiểu 2 đỉnh (BR-01).', true);
      const created = await guard(api('/gis/routes', { body: {
        name, mode: document.getElementById('ww-mode').value, points,
        maxLoadTons: Number(document.getElementById('ww-load').value) || undefined,
        widthM: Number(document.getElementById('ww-width').value) || undefined,
        depthM: Number(document.getElementById('ww-depth').value) || undefined,
        clearanceM: Number(document.getElementById('ww-clearance').value) || undefined,
      } }));
      toast(`Đã lưu ${created.route.code} — ${created.lengthLabel}.`);
      for (const warning of created.warnings ?? []) toast(warning.message, true);
      points.length = 0;
      redraw();
      await reloadList();
    }
    async function reloadList() {
      const list = await api('/gis/routes');
      drawExisting(list);
      listBox.replaceChildren(card('Danh mục tuyến đã số hoá', table([
        { key: 'code', label: 'Mã' },
        { key: 'name', label: 'Tên tuyến' },
        { key: 'mode', label: 'Loại', render: (row) => (row.mode === 'waterway' ? 'Đường thuỷ' : 'Đường bộ') },
        { key: 'lengthLabel', label: 'Chiều dài', align: 'right' },
        { key: 'max_load_tons', label: 'Tải trọng', align: 'right', render: (row) => (row.max_load_tons ? `${num(row.max_load_tons)} t` : '—') },
        { key: 'depth_m', label: 'Sâu / Rộng', render: (row) => `${num(row.depth_m)} m / ${num(row.width_m)} m` },
        { key: 'data_source', label: 'Nguồn', render: (row) => badge(SOURCE_LABEL[row.data_source] ?? row.data_source, row.data_source === 'chinh_thuc' ? 'good' : 'warn') },
        { key: 'status', label: 'Trạng thái', render: (row) => badge(row.status === 'da_xac_nhan' ? 'Đã xác nhận' : 'Nháp', row.status === 'da_xac_nhan' ? 'good' : 'neutral') },
        { key: 'action', label: '', render: (row) => (editable
          ? el('button', { class: 'ghost small', text: row.status === 'da_xac_nhan' ? 'Chuyển về Nháp' : 'Xác nhận', onclick: async (event) => {
              event.stopPropagation();
              await guard(api(`/gis/routes/${row.id}/status`, { body: { status: row.status === 'da_xac_nhan' ? 'nhap' : 'da_xac_nhan' } }));
              toast('Đã cập nhật trạng thái tuyến.');
              await reloadList();
            } })
          : '—') },
      ], list)));
    }

    if (LEAFLET_AVAILABLE()) {
      map = createMap('ww-map', [10.4, 105.9], 9);
      map.on('click', (event) => { points.push({ lat: Number(event.latlng.lat.toFixed(6)), lng: Number(event.latlng.lng.toFixed(6)) }); redraw(); });
    }
    renderMeasure(null);
    await reloadList();
    void routes; void pct; void dateTime;
  },
});
