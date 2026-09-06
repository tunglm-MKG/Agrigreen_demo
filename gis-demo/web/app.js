/**
 * Giao diện demo lớp dữ liệu nền — MỘT lớp hiển thị mỗi lần, chọn bằng drop-list.
 *
 * Giao diện KHÔNG biết tên nguồn nào (A.1): mọi chữ về nguồn, giấy phép, mốc thời
 * gian đều lấy từ /api/layers (source() của adapter) và hiển thị nguyên văn. Đổi
 * nguồn ở máy chủ, tệp này không đổi.
 */
const api = async (path) => {
  const res = await fetch(`/api${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Lỗi ${res.status}`);
  return body;
};
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v; else if (k === 'html') node.innerHTML = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined) node.append(c);
  return node;
};
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString('vi-VN', { maximumFractionDigits: d }));
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
const today = () => new Date().toISOString().slice(0, 10);

const state = { layers: [], soilVariants: [], current: null, soilVariant: 'soil-ph', overlay: null, plotsLayer: null, marker: null, opacity: 0.75, plotsOn: true };

// ---------------------------------------------------------------------------
// Bản đồ nền — OpenStreetMap CHỈ dùng nền đã render (R-02)
// ---------------------------------------------------------------------------
const map = L.map('map', { zoomControl: false, attributionControl: false }).setView([9.9, 105.7], 8);
L.control.zoom({ position: 'bottomright' }).addTo(map);

/**
 * Nền bản đồ có dự phòng: thử nhà cung cấp đầu; quá 4 tile lỗi liên tiếp mà chưa
 * tile nào tải được thì chuyển sang nhà cung cấp kế (cùng dữ liệu OSM đã render).
 * Lý do: DNS của một số ISP trong nước không phân giải tile.openstreetmap.org.
 */
let basemapLayer = null;
function mountBasemap(providers) {
  let index = 0;
  const use = () => {
    const p = providers[index];
    if (!p) return;
    if (basemapLayer) map.removeLayer(basemapLayer);
    let errors = 0; let loaded = 0;
    basemapLayer = L.tileLayer(p.url, { maxZoom: 17, subdomains: 'abc' });
    window.__basemap = { name: p.name, errors: 0, loaded: 0 };
    basemapLayer.on('tileload', () => { loaded += 1; window.__basemap.loaded = loaded; });
    basemapLayer.on('tileerror', () => {
      errors += 1; window.__basemap.errors = errors;
      if (!loaded && errors >= 3 && index < providers.length - 1) { index += 1; console.warn(`[demo] nền ${p.name} không tải được (${errors} tile lỗi), chuyển sang ${providers[index].name}`); use(); }
    });
    basemapLayer.addTo(map);
    state.basemapName = p.name; state.basemapAttribution = p.attribution;
    if (state.current) renderAttribution(state.basemap, state.current);
  };
  use();
}

// ---------------------------------------------------------------------------
// Khối nguồn (F-05, R-03, R-04) — luôn hiển thị, lấy nguyên văn từ adapter
// ---------------------------------------------------------------------------
const kids = (...items) => items.filter((x) => x !== null && x !== undefined);
function renderSourceBox(source) {
  const box = document.getElementById('source-box');
  const live = source.status === 'song';
  box.replaceChildren(...kids(
    el('div', { class: 'sb-title', text: source.layerName }),
    // Chuỗi ghi nguồn của một số adapter đã bắt đầu bằng "Nguồn:" (đúng câu chữ brief) — không lặp tiền tố.
    el('div', { class: 'sb-row' }, [/^Nguồn:/i.test(source.attribution) ? '' : 'Nguồn: ', el('a', { href: source.attributionUrl || '#', target: '_blank', rel: 'noopener', text: source.attribution })]),
    el('div', { class: 'sb-row', text: `Dữ liệu: ${source.dataTimestamp ?? 'chưa có mốc thời gian'}` }),
    el('div', { class: `sb-status ${live ? 'live' : 'static'}`, text: live ? '● Dữ liệu sống' : `■ Dữ liệu tĩnh — chụp ngày ${dmy(source.snapshotDate)}` }),
    source.extra?.illustrative ? el('div', { class: 'sb-warn', text: '⚠ ĐANG HIỂN THỊ SỐ MINH HOẠ — chưa nạp dữ liệu từ nguồn' }) : null,
    source.caveat ? el('details', { class: 'sb-caveat' }, [el('summary', { text: 'Giới hạn của lớp này' }), el('p', { text: source.caveat })]) : null,
    source.license ? el('div', { class: 'sb-license', text: `Giấy phép: ${source.license}` }) : null,
  ));
}

function renderLegend(source) {
  const legend = document.getElementById('legend');
  if (source.render !== 'raster' || !source.legend) { legend.hidden = true; return; }
  legend.hidden = false;
  const stops = source.legend.stops;
  const gradient = `linear-gradient(to right, ${stops.map((s, i) => `${s.color} ${(i / (stops.length - 1)) * 100}%`).join(', ')})`;
  legend.replaceChildren(
    el('div', { class: 'lg-title', text: `${source.layerName} (${source.unit})` }),
    el('div', { class: 'lg-bar', style: `background:${gradient}` }),
    el('div', { class: 'lg-ticks' }, stops.map((s) => el('span', { text: `${fmt(s.value, 1)}${s.label ? ` ${s.label}` : ''}` }))),
  );
}

function renderAttribution(basemap, source) {
  document.getElementById('attrib').replaceChildren(
    el('a', { href: basemap.attributionUrl, target: '_blank', rel: 'noopener', text: state.basemapAttribution ?? basemap.attribution }),
    ' · ',
    el('a', { href: source.attributionUrl || '#', target: '_blank', rel: 'noopener', text: source.attribution }),
    ' · ', el('span', { text: 'Lô mẫu: dữ liệu minh hoạ' }),
  );
}

// ---------------------------------------------------------------------------
// Vẽ lớp
// ---------------------------------------------------------------------------
function clearOverlay() {
  if (state.overlay) { map.removeLayer(state.overlay); state.overlay = null; }
}

async function showLayer(id) {
  const source = state.layers.find((l) => l.id === id);
  if (!source) return;
  state.current = source;
  clearOverlay();
  renderSourceBox(source);
  renderLegend(source);
  renderAttribution(state.basemap, source);
  document.getElementById('soil-variant')?.remove();

  const t0 = performance.now();
  const data = await api(`/layers/${id}/map`);
  if (data.kind === 'raster') {
    const [w, s, e, n] = data.bbox;
    const imageId = id === 'soil-ph' ? state.soilVariant : id;
    state.overlay = L.imageOverlay(`/api/layers/${imageId}/image`, [[s, w], [n, e]], { opacity: state.opacity, interactive: false }).addTo(map);
    if (id === 'soil-ph') mountSoilVariantPicker();
  } else {
    state.overlay = drawGeoJson(id, data.geojson).addTo(map);
    state.overlay.setStyle?.({ opacity: state.opacity, fillOpacity: state.opacity * 0.6 });
    if (data.dataTimestamp && !source.dataTimestamp) { source.dataTimestamp = data.dataTimestamp.replace('T', ' '); renderSourceBox(source); }
  }
  console.info(`[demo] lớp ${id} vẽ trong ${Math.round(performance.now() - t0)} ms`);
}

/** Thổ nhưỡng có ba biến — chọn biến để đổi ảnh phủ, cùng một adapter. */
function mountSoilVariantPicker() {
  const picker = el('select', { id: 'soil-variant', class: 'variant', onchange: async (e) => {
    state.soilVariant = e.target.value;
    const v = state.soilVariants.find((x) => x.id === state.soilVariant);
    renderLegend({ ...state.current, legend: v.legend, unit: v.unit, layerName: `Thổ nhưỡng — ${v.label}` });
    await showLayer('soil-ph');
  } }, state.soilVariants.map((v) => el('option', { value: v.id, selected: v.id === state.soilVariant, text: v.label })));
  document.getElementById('legend').prepend(picker);
  const v = state.soilVariants.find((x) => x.id === state.soilVariant);
  if (v) renderLegend({ ...state.current, legend: v.legend, unit: v.unit, layerName: `Thổ nhưỡng — ${v.label}` });
  document.getElementById('legend').prepend(picker);
}

function drawGeoJson(id, geojson) {
  if (id === 'weather') {
    return L.geoJSON(geojson, {
      pointToLayer: (f, latlng) => {
        const p = f.properties;
        const icon = L.divIcon({ className: 'wx-pin', html: `<div class="wx"><b>${fmt(p.temperature, 0)}°</b><small>${p.name}</small><i>${fmt(p.precipitation, 1)} mm</i></div>`, iconSize: [64, 44] });
        return L.marker(latlng, { icon }).bindPopup(`<strong>${p.name}</strong><br>${fmt(p.temperature, 1)} ${p.units.temperature_2m} · ẩm ${fmt(p.humidity, 0)}%<br>Mưa giờ qua ${fmt(p.precipitation, 1)} mm · gió ${fmt(p.wind, 0)} km/h<br><small>Số liệu lúc ${p.time.replace('T', ' ')} · lấy về ${new Date(p.fetchedAt).toLocaleTimeString('vi-VN')}</small>`);
      },
    });
  }
  if (id === 'water-level') {
    const illustrative = geojson.properties?.illustrative;
    return L.geoJSON(geojson, {
      pointToLayer: (f, latlng) => {
        const p = f.properties;
        const icon = L.divIcon({ className: 'wl-pin', html: `<div class="wl ${p.illustrative ? 'illu' : ''}"><b>${fmt(p.lastLevel, 2)} m</b><small>${p.name}</small>${p.illustrative ? '<i>minh hoạ</i>' : ''}</div>`, iconSize: [70, 44] });
        return L.marker(latlng, { icon }).bindPopup(`<strong>Trạm ${p.name}</strong> — ${p.river ?? ''}<br>Mực nước ${fmt(p.lastLevel, 2)} m (${dmy(p.lastDay)})${illustrative ? '<br><b style="color:#b3261e">SỐ MINH HOẠ — chưa nạp dữ liệu từ nguồn</b>' : ''}<br><small>Bấm vào bản đồ gần trạm để xem chuỗi thời gian</small>`);
      },
    });
  }
  if (id === 'salinity') {
    const seasons = geojson.properties?.seasons ?? [];
    const colour = (season) => (season === seasons[0] ? '#B3261E' : '#D98E04');
    return L.geoJSON(geojson, {
      style: (f) => (f.properties.part === 'affected'
        ? { color: colour(f.properties.season), weight: f.properties.season === seasons[0] ? 5 : 3, opacity: 0.85, dashArray: f.properties.note ? '6 6' : null }
        : { color: colour(f.properties.season), weight: 10, opacity: 0.35 }),
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 7, color: colour(f.properties.season), fillColor: '#fff', fillOpacity: 1, weight: 3 }),
      onEachFeature: (f, layer) => {
        const p = f.properties;
        layer.bindPopup(`<strong>${p.river}</strong><br>Ranh mặn 4 g/l: <b>${p.kmMin}–${p.kmMax} km</b> từ cửa sông<br>Thời kỳ ${dmy(p.periodFrom)} → ${dmy(p.periodTo)}${p.note ? `<br><i>${p.note}</i>` : ''}<br><small>${p.bulletin}, ngày ${dmy(p.bulletinDate)} — <a href="${p.bulletinUrl}" target="_blank" rel="noopener">bản tin gốc</a></small><br><small>Vị trí vẽ xấp xỉ theo trục sông.</small>`);
      },
    });
  }
  return L.geoJSON(geojson);
}

async function drawPlots() {
  const geojson = await api('/plots');
  const popup = (p) => `<strong>${p.code}</strong> <span class="tag demo" style="font-size:10px">MINH HOẠ</span><br>${p.cluster}<br>${fmt(p.areaHa, 1)} ha · giống ${p.variety}<br>Thu hoạch dự kiến ${dmy(p.expectedHarvest)}<br><small>${geojson.properties.disclaimer}</small>`;
  const polygons = L.geoJSON(geojson, {
    style: { color: '#1F4E45', weight: 1.5, fillColor: '#8FC5B4', fillOpacity: 0.35, dashArray: '4 3' },
    onEachFeature: (f, layer) => layer.bindPopup(popup(f.properties)),
  });
  // Thửa 150–350 m rộng thì ở mức toàn vùng chỉ là một chấm — thêm ghim tâm để người xem thấy lô ở đâu.
  const pins = L.layerGroup(geojson.features.map((f) => {
    const ring = f.geometry.coordinates[0];
    const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
    return L.marker([lat, lng], { icon: L.divIcon({ className: 'plot-pin', html: `<div class="plot-dot" title="${f.properties.code}"></div>`, iconSize: [12, 12] }) }).bindPopup(popup(f.properties));
  }));
  state.plotsLayer = L.layerGroup([polygons, pins]);
  const syncPins = () => { if (map.getZoom() >= 12) { if (state.plotsLayer.hasLayer(pins)) state.plotsLayer.removeLayer(pins); } else if (!state.plotsLayer.hasLayer(pins)) state.plotsLayer.addLayer(pins); };
  map.on('zoomend', syncPins); syncPins();
  if (state.plotsOn) state.plotsLayer.addTo(map);
}

// ---------------------------------------------------------------------------
// Bấm điểm (F-03) và chuỗi lịch sử (F-04)
// ---------------------------------------------------------------------------
async function queryPoint(latlng) {
  const source = state.current;
  if (!source) return;
  if (state.marker) map.removeLayer(state.marker);
  state.marker = L.circleMarker(latlng, { radius: 6, color: '#111', fillColor: '#FFD166', fillOpacity: 1, weight: 2 }).addTo(map);
  const sheet = document.getElementById('sheet');
  const body = document.getElementById('sheet-body');
  sheet.hidden = false;
  body.replaceChildren(el('p', { class: 'muted', text: 'Đang đọc giá trị…' }));
  const t0 = performance.now();
  try {
    const value = await api(`/layers/${source.id}/value?lat=${latlng.lat.toFixed(4)}&lng=${latlng.lng.toFixed(4)}`);
    const ms = Math.round(performance.now() - t0);
    const rows = [];
    rows.push(el('div', { class: 'val-main' }, [el('b', { text: value.value === null ? 'Không có dữ liệu tại điểm này' : `${fmt(value.value, 2)} ${value.unit}` }), el('span', { class: 'muted', text: value.label ?? source.layerName })]));
    if (value.details) {
      rows.push(el('div', { class: 'val-grid' }, Object.values(value.details).map((d) => el('div', {}, [el('small', { text: d.label }), el('b', { text: `${fmt(d.value, 1)} ${d.unit}` })]))));
    }
    rows.push(el('div', { class: 'muted small', text: `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)} · dữ liệu ${value.dataTimestamp ?? '—'} · ${value.origin === 'live' ? 'vừa gọi nguồn' : value.origin === 'cache' ? 'từ bộ đệm' : 'tệp tĩnh'} · ${ms} ms` }));
    body.replaceChildren(el('h3', { text: source.layerName }), ...rows);
    if (source.hasSeries) mountSeries(body, source, latlng);
  } catch (error) {
    body.replaceChildren(el('p', { class: 'error', text: error.message }));
  }
}

function mountSeries(body, source, latlng) {
  const defaultFrom = source.id === 'weather' ? `${new Date().getFullYear() - 1}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01` : (source.dataTimestamp?.slice(0, 10) ?? '2024-01-01');
  const from = el('input', { type: 'date', value: defaultFrom, min: source.id === 'weather' ? '2015-01-01' : undefined });
  const to = el('input', { type: 'date', value: source.id === 'weather' ? new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) : today() });
  const chart = el('div', { class: 'chart' });
  const note = el('p', { class: 'muted small' });
  const run = async () => {
    chart.replaceChildren(el('p', { class: 'muted', text: 'Đang tải chuỗi…' }));
    const t0 = performance.now();
    try {
      const series = await api(`/layers/${source.id}/series?lat=${latlng.lat.toFixed(4)}&lng=${latlng.lng.toFixed(4)}&from=${from.value}&to=${to.value}`);
      chart.replaceChildren(drawChart(series, source.id));
      note.textContent = `${series.label} · ${series.points.length} điểm · ${series.note ?? ''} · ${series.origin === 'live' ? 'vừa gọi nguồn' : series.origin === 'cache' ? 'từ bộ đệm' : 'tệp tĩnh'} · ${Math.round(performance.now() - t0)} ms`;
    } catch (error) { chart.replaceChildren(el('p', { class: 'error', text: error.message })); }
  };
  body.append(
    el('div', { class: 'series-ctl' }, [el('label', {}, ['Từ ', from]), el('label', {}, ['Đến ', to]), el('button', { text: 'Xem chuỗi', onclick: run })]),
    chart, note,
  );
  run();
}

/** Biểu đồ SVG tự vẽ: cột mưa + đường nhiệt độ (thời tiết) hoặc đường mực nước. */
function drawChart(series, id) {
  const W = Math.min(720, document.getElementById('sheet').clientWidth - 32);
  const H = 180;
  const P = { l: 40, r: 40, t: 12, b: 26 };
  const pts = series.points.filter((p) => p.v !== null || p.tmax !== null);
  if (!pts.length) return el('p', { class: 'muted', text: 'Không có dữ liệu trong khoảng đã chọn.' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', '100%'); svg.setAttribute('class', 'svgchart');
  const x = (i) => P.l + (i / Math.max(1, pts.length - 1)) * (W - P.l - P.r);
  const add = (name, attrs) => { const n = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); return n; };
  const text = (s, xx, yy, extra = {}) => { const t = add('text', { x: xx, y: yy, class: 'ct', ...extra }); t.textContent = s; };

  if (id === 'weather') {
    const rain = pts.map((p) => p.v ?? 0);
    const rMax = Math.max(5, ...rain);
    const temps = pts.flatMap((p) => [p.tmax, p.tmin]).filter((v) => v !== null && v !== undefined);
    const tMin = Math.floor(Math.min(...temps) - 1); const tMax = Math.ceil(Math.max(...temps) + 1);
    const yR = (v) => H - P.b - (v / rMax) * (H - P.t - P.b);
    const yT = (v) => H - P.b - ((v - tMin) / (tMax - tMin)) * (H - P.t - P.b);
    const bw = Math.max(1, (W - P.l - P.r) / pts.length - 0.5);
    pts.forEach((p, i) => add('rect', { x: x(i) - bw / 2, y: yR(p.v ?? 0), width: bw, height: H - P.b - yR(p.v ?? 0), class: 'rain' }));
    const line = (key, cls) => add('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yT(p[key] ?? tMin).toFixed(1)}`).join(' '), class: cls });
    line('tmax', 'tmax'); line('tmin', 'tmin');
    text(`${rMax} mm`, 2, P.t + 8); text('0', 2, H - P.b);
    text(`${tMax}°`, W - P.r + 4, P.t + 8); text(`${tMin}°`, W - P.r + 4, H - P.b);
  } else {
    const vals = pts.map((p) => p.v);
    const vMin = Math.floor(Math.min(...vals) * 10) / 10 - 0.2; const vMax = Math.ceil(Math.max(...vals) * 10) / 10 + 0.2;
    const y = (v) => H - P.b - ((v - vMin) / (vMax - vMin || 1)) * (H - P.t - P.b);
    add('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ') + ` L${x(pts.length - 1).toFixed(1)},${H - P.b} L${x(0)},${H - P.b} Z`, class: series.note?.includes('MINH HOẠ') ? 'area illu' : 'area' });
    add('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '), class: series.note?.includes('MINH HOẠ') ? 'wl-line illu' : 'wl-line' });
    text(`${vMax.toFixed(1)} m`, 2, P.t + 8); text(`${vMin.toFixed(1)} m`, 2, H - P.b);
  }
  add('line', { x1: P.l, y1: H - P.b, x2: W - P.r, y2: H - P.b, class: 'axis' });
  text(dmy(pts[0].t), P.l, H - 6); text(dmy(pts[pts.length - 1].t), W - P.r - 70, H - 6);
  return svg;
}

// ---------------------------------------------------------------------------
// Khởi động
// ---------------------------------------------------------------------------
async function boot() {
  const t0 = performance.now();
  const meta = await api('/layers');
  state.layers = meta.layers; state.soilVariants = meta.soilVariants; state.basemap = meta.basemap;
  // Bản đồ được tạo trước khi CSS (kể cả leaflet.css từ CDN) kịp tải → Leaflet nhớ
  // kích cỡ sai và chỉ xin một tile. Tính lại kích cỡ trước khi gắn nền và khi đổi khung.
  map.invalidateSize();
  window.addEventListener('load', () => map.invalidateSize());
  window.addEventListener('resize', () => map.invalidateSize());
  mountBasemap(meta.basemap.providers);
  const select = document.getElementById('layer-select');
  select.replaceChildren(...meta.layers.map((l) => el('option', { value: l.id, text: `${l.status === 'song' ? '●' : '■'} ${l.layerName}` })));
  select.addEventListener('change', () => showLayer(select.value));
  document.getElementById('opacity').addEventListener('input', (e) => {
    state.opacity = Number(e.target.value) / 100;
    if (state.overlay?.setOpacity) state.overlay.setOpacity(state.opacity);
    else state.overlay?.setStyle?.({ opacity: state.opacity, fillOpacity: state.opacity * 0.6 });
  });
  document.getElementById('plots-toggle').addEventListener('change', (e) => {
    state.plotsOn = e.target.checked;
    if (!state.plotsLayer) return;
    if (state.plotsOn) state.plotsLayer.addTo(map); else map.removeLayer(state.plotsLayer);
  });
  document.getElementById('sheet-close').addEventListener('click', () => { document.getElementById('sheet').hidden = true; });
  map.on('click', (e) => queryPoint(e.latlng));
  await Promise.all([showLayer(meta.layers[0].id), drawPlots()]);
  console.info(`[demo] sẵn sàng sau ${Math.round(performance.now() - t0)} ms`);
  window.__demoReady = Math.round(performance.now() - t0);
}
boot().catch((error) => { document.getElementById('source-box').textContent = `Không khởi động được: ${error.message}`; });
