/**
 * GIS — KHUNG NHÌN QUẢN TRỊ (BRD GIS v1.5, FN-03..FN-09, FN-16..FN-18, FN-21..FN-23)
 *
 * Tab theo bản mẫu Mekong_Green_GIS_v1.3 → "Quản trị":
 *   Cấu hình        bảng màu mùa vụ, ngưỡng dung lượng kho, nền mặc định, chu kỳ thời tiết (FN-03, BR-52)
 *   HTX             tạo/sửa, vẽ ranh giới hoặc đặt marker, vô hiệu hoá có lý do & ảnh hưởng (FN-04, BR-14..17)
 *   Kho / Hub       thêm cơ sở, sức chứa, xoá mềm/khôi phục (FN-05)
 *   Thửa ruộng      toàn bộ thửa (kể cả đã xoá), tải KML/GeoJSON theo HTX (FN-06)
 *   Ranh giới HC    nạp GeoJSON/KML ranh giới xã/tỉnh 2025, xem trước → áp dụng (FN-07)
 *   Đã xoá          bản ghi xoá mềm và khôi phục (BR-19)
 *   Đồng bộ         nguồn, dead-letter, thử lại, nhập tay dự phòng & xác nhận ghi đè (FN-22/23, BR-52)
 *   Nhật ký         lịch sử thay đổi theo đối tượng (FN-17)
 *   Lưu trữ         chính sách giữ event log / snapshot (FN-18)
 *   Tích hợp        luồng vào/ra với App HTX, Bản đồ CGH, ERP, TMS (FN-21)
 */
import {
  api, registerPage, el, card, table, badge, alert, kpi, num, tons, dateTime, dateOnly, toast, guard, can, icon, tabs,
  form, modal, confirmDialog, promptDialog, emptyState, mapContainer, createMap, LEAFLET_AVAILABLE, apiConfirm,
} from '/app.js';

const FACILITY_KIND = { hub: 'Hub', warehouse: 'Kho', yard: 'Bãi', plant: 'Nhà máy', factory: 'Nhà máy' };
const SYNC_STATUS = { success: ['Thành công', 'good'], failed: ['Thất bại', 'warn'], dead_letter: ['Dead-letter', 'bad'], retrying: ['Đang thử lại', 'info'] };

/** Đọc một tệp người dùng chọn (GeoJSON/KML) thành chuỗi. */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Không đọc được tệp.'));
    reader.readAsText(file);
  });
}

/** Ô chọn tệp không gian + xem trước số đối tượng (FN-06/07). */
function spatialUpload(label, onParsed) {
  const input = el('input', { type: 'file', accept: '.geojson,.json,.kml,.txt,.csv,.shp,.zip' });
  const preview = el('div');
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    preview.replaceChildren(el('p', { class: 'muted', text: 'Đang đọc…' }));
    try {
      const content = await readFile(file);
      const parsed = await api('/gis/import/preview', { body: { content, fileName: file.name } });
      preview.replaceChildren(
        el('div', { class: 'chip-row' }, [badge(parsed.format.toUpperCase(), 'info'), badge(`${parsed.count} đối tượng`, 'good'), parsed.skipped?.length ? badge(`${parsed.skipped.length} bỏ qua`, 'warn') : null]),
        parsed.features.length ? table([
          { key: 'kind', label: 'Loại', render: (r) => ({ polygon: 'Vùng', point: 'Điểm', line: 'Tuyến' }[r.kind] ?? r.kind) },
          { key: 'name', label: 'Tên', render: (r) => r.name ?? '—' },
          { key: 'points', label: 'Đỉnh', align: 'right' },
        ], parsed.features.slice(0, 20), { plain: true }) : null,
        parsed.skipped?.length ? el('p', { class: 'muted', text: `Bỏ qua: ${parsed.skipped.slice(0, 5).join('; ')}` }) : null,
      );
      onParsed({ content, fileName: file.name, parsed });
    } catch (error) {
      preview.replaceChildren(alert(error.message, 'bad'));
      onParsed(null);
    }
  });
  return el('div', { class: 'stack' }, [el('label', {}, [label, input]), preview]);
}

/** Vẽ ranh giới (polygon) hoặc đặt marker cho một đối tượng trên bản đồ, rồi PUT boundary. */
function boundaryEditor(kind, entity, onSaved) {
  const mapId = `bd-map-${entity.id}`;
  const mapNode = mapContainer(mapId, '');
  const counter = el('span', { class: 'muted', text: '0 đỉnh' });
  const points = [];
  let mode = 'polygon';
  let map = null; let shapes = [];
  const seg = el('div', { class: 'seg', style: 'max-width:280px' });
  const drawSeg = () => seg.replaceChildren(...[['polygon', 'Vẽ vùng'], ['marker', 'Đặt điểm']].map(([m, l]) => el('button', { type: 'button', class: mode === m ? 'on' : '', text: l, onclick: () => { mode = m; points.length = 0; redraw(); drawSeg(); } })));
  drawSeg();
  const redraw = () => {
    counter.textContent = mode === 'polygon' ? `${points.length} đỉnh` : (points.length ? `${points[0].lat.toFixed(5)}, ${points[0].lng.toFixed(5)}` : 'Chưa đặt điểm');
    if (!map) return;
    shapes.forEach((s) => map.removeLayer(s)); shapes = [];
    if (mode === 'polygon' && points.length >= 2) shapes.push(window.L.polygon(points.map((p) => [p.lat, p.lng]), { color: '#12A150', weight: 2, fillOpacity: 0.2 }).addTo(map));
    for (const p of points) shapes.push(window.L.circleMarker([p.lat, p.lng], { radius: 5, color: '#12A150', fillOpacity: 1 }).addTo(map));
  };
  const dialog = modal(`Ranh giới: ${entity.name}`, [
    el('p', { class: 'muted', text: 'Nhấp lên bản đồ để thêm đỉnh (vùng cần ≥ 3 đỉnh) hoặc đặt một điểm đại diện. Không có toạ độ thì đối tượng không hiện được trên bản đồ (BR-15).' }),
    el('div', { class: 'row' }, [seg, counter]),
    mapNode,
  ], [
    el('button', { class: 'ghost', text: 'Hoàn tác', onclick: () => { points.pop(); redraw(); } }),
    el('button', { class: 'ghost', text: 'Đóng', onclick: () => dialog.close() }),
    el('button', { text: 'Lưu ranh giới', onclick: async () => {
      if (mode === 'polygon' && points.length < 3) return toast('Vùng cần tối thiểu 3 đỉnh.', true);
      if (mode === 'marker' && !points.length) return toast('Chưa đặt điểm.', true);
      const table = kind === 'htx' ? 'cooperatives' : 'facilities';
      await guard(api(`/mdm/${table}/${entity.id}/boundary`, { method: 'PUT', body: mode === 'polygon' ? { points } : { marker: points[0] } }));
      toast('Đã lưu ranh giới / vị trí.');
      dialog.close();
      onSaved?.();
    } }),
  ], { wide: true });
  if (LEAFLET_AVAILABLE()) {
    setTimeout(() => {
      map = createMap(mapId, [entity.lat ?? 10.2, entity.lng ?? 105.8], entity.lat ? 13 : 8);
      if (entity.boundaryGeo) window.L.geoJSON(entity.boundaryGeo, { style: { color: '#93A399', dashArray: '4 3', fillOpacity: 0.05 } }).addTo(map);
      map.on('click', (e) => {
        const p = { lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) };
        if (mode === 'marker') points.splice(0, points.length, p); else points.push(p);
        redraw();
      });
      redraw();
    }, 60);
  }
}

registerPage('gis-admin', {
  title: 'Quản trị GIS',
  subtitle: 'Cấu hình lớp dữ liệu · HTX, kho/hub, thửa · ranh giới hành chính · đồng bộ & nhật ký',
  async render(view) {
    const admin = can('gis.admin');
    const mdmWrite = can('mdm.write');
    view.replaceChildren(tabs([
      { id: 'config', label: 'Cấu hình', icon: 'settings', render: renderConfig },
      { id: 'htx', label: 'HTX', icon: 'building', render: renderHtx },
      { id: 'facilities', label: 'Kho / Hub', icon: 'factory', render: renderFacilities },
      { id: 'plots', label: 'Thửa ruộng', icon: 'plot', render: renderPlots },
      { id: 'admin-units', label: 'Ranh giới HC', icon: 'map', render: renderAdminUnits },
      { id: 'deleted', label: 'Đã xoá', icon: 'trash', render: renderDeleted },
      { id: 'sync', label: 'Đồng bộ', icon: 'refresh', render: renderSync },
      { id: 'history', label: 'Nhật ký', icon: 'history', render: renderHistory },
      { id: 'retention', label: 'Lưu trữ', icon: 'database', render: renderRetention },
      { id: 'integration', label: 'Tích hợp', icon: 'link', render: renderIntegration },
      { id: 'catalog', label: 'Giống & mùa vụ', icon: 'seed', render: renderCatalog },
    ], { initial: sessionStorage.getItem('mg.gis.admin.tab') ?? 'config', onChange: (id) => { try { sessionStorage.setItem('mg.gis.admin.tab', id); } catch { /* bỏ qua */ } } }));

    // ------------------------------------------------------------------ Cấu hình
    async function renderConfig(panel) {
      const cfg = await guard(api('/gis/admin/config'));
      const paletteRows = Object.entries(cfg.cropPalette);
      const paletteInputs = new Map();
      const paletteCard = card('Bảng màu giai đoạn mùa vụ (FN-03, BR-52)', [
        el('p', { class: 'muted', text: 'Mã màu phải ở dạng HEX (#RRGGBB). Thay đổi áp dụng cho heatmap ở mọi cổng đọc từ GIS.' }),
        el('div', { class: 'stack' }, paletteRows.map(([key, v]) => {
          const color = el('input', { type: 'color', value: v.color, disabled: !admin });
          const hex = el('input', { type: 'text', value: v.color, maxlength: '7', disabled: !admin });
          const label = el('input', { type: 'text', value: v.label, disabled: !admin, style: 'max-width:220px' });
          color.addEventListener('input', () => { hex.value = color.value.toUpperCase(); });
          hex.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) color.value = hex.value; });
          paletteInputs.set(key, { hex, label });
          return el('div', { class: 'hex-row' }, [color, hex, label, el('span', { class: 'muted mono', text: key })]);
        })),
        admin ? el('div', { class: 'chip-row' }, [
          el('button', { class: 'small', onclick: async () => {
            const palette = {};
            for (const [key, { hex, label }] of paletteInputs) palette[key] = { color: hex.value.trim().toUpperCase(), label: label.value.trim() };
            await guard(api('/gis/admin/config/palette', { method: 'PUT', body: { palette } }));
            toast('Đã lưu bảng màu.'); await renderConfig(panel);
          } }, [icon('check', 14), 'Lưu bảng màu']),
          el('button', { class: 'ghost small', onclick: async () => { await guard(api('/gis/admin/config/reset', { body: { key: 'gis.crop_palette' } })); toast('Đã khôi phục mặc định.'); await renderConfig(panel); } }, [icon('refresh', 14), 'Mặc định']),
        ]) : null,
      ]);

      const bands = cfg.capacityThresholds.map((b) => ({ ...b }));
      const bandBox = el('div', { class: 'stack' });
      const drawBands = () => bandBox.replaceChildren(...bands.map((b, i) => el('div', { class: 'row' }, [
        el('label', {}, ['Ngưỡng dưới (%)', el('input', { type: 'number', min: '1', max: '100', value: b.maxPct, disabled: !admin, oninput: (e) => { b.maxPct = Number(e.target.value); } })]),
        el('label', {}, ['Màu', el('input', { type: 'color', value: b.color, disabled: !admin, oninput: (e) => { b.color = e.target.value.toUpperCase(); } })]),
        el('label', {}, ['Nhãn', el('input', { type: 'text', value: b.label, disabled: !admin, oninput: (e) => { b.label = e.target.value; } })]),
        admin ? el('button', { class: 'ghost small danger', onclick: () => { bands.splice(i, 1); drawBands(); } }, [icon('trash', 14)]) : null,
      ])));
      drawBands();
      const thresholdCard = card('Ngưỡng cảnh báo dung lượng kho (FN-14)', [
        el('p', { class: 'muted', text: 'Các ngưỡng phải tăng dần và ≤ 100%. Widget kho tô màu theo dải đầu tiên có "% đầy" nhỏ hơn ngưỡng.' }),
        bandBox,
        admin ? el('div', { class: 'chip-row' }, [
          el('button', { class: 'ghost small', onclick: () => { bands.push({ maxPct: 100, color: '#DC5236', label: 'Mới' }); drawBands(); } }, [icon('plus', 14), 'Thêm dải']),
          el('button', { class: 'small', onclick: async () => { await guard(api('/gis/admin/config/thresholds', { method: 'PUT', body: { bands } })); toast('Đã lưu ngưỡng.'); await renderConfig(panel); } }, [icon('check', 14), 'Lưu ngưỡng']),
          el('button', { class: 'ghost small', onclick: async () => { await guard(api('/gis/admin/config/reset', { body: { key: 'gis.capacity_thresholds' } })); toast('Đã khôi phục mặc định.'); await renderConfig(panel); } }, [icon('refresh', 14), 'Mặc định']),
        ]) : null,
      ]);

      const simpleCard = card('Nền bản đồ & làm mới thời tiết', [
        form([
          { name: 'basemap', label: 'Nền mặc định', type: 'select', options: [['street', 'Đường phố'], ['satellite', 'Vệ tinh'], ['terrain', 'Địa hình']].map(([value, label]) => ({ value, label, selected: cfg.defaultBasemap === value })) },
          { name: 'weather', label: 'Chu kỳ làm mới thời tiết (giờ)', type: 'number', min: '1', value: cfg.weatherRefreshHours },
        ], async (v) => {
          await api('/gis/admin/config/simple', { method: 'PUT', body: { key: 'gis.default_basemap', value: v.basemap } });
          await api('/gis/admin/config/simple', { method: 'PUT', body: { key: 'gis.weather_refresh_hours', value: v.weather } });
          toast('Đã lưu cấu hình.'); await renderConfig(panel);
        }, { submitLabel: 'Lưu', resetOnSuccess: false }),
        el('h4', { text: 'Dải tỷ lệ zoom' }),
        table([{ key: 'label', label: 'Mức' }, { key: 'minZoom', label: 'Zoom từ', align: 'right' }, { key: 'maxZoom', label: 'đến', align: 'right' }, { key: 'cluster', label: 'Gộp theo' }], cfg.zoomBands ?? [], { plain: true }),
      ]);
      panel.replaceChildren(
        el('div', { class: 'grid cols-2' }, [paletteCard, thresholdCard]),
        simpleCard,
        card('Lịch sử thay đổi cấu hình', table([
          { key: 'occurred_at', label: 'Lúc', render: (r) => dateTime(r.occurred_at) },
          { key: 'entity_id', label: 'Khoá' },
          { key: 'actor_name', label: 'Người' },
          { key: 'after_json', label: 'Giá trị mới', render: (r) => el('code', { text: String(r.after_json ?? '').slice(0, 80) }) },
        ], cfg.history ?? [], { empty: 'Chưa có thay đổi.' })),
      );
    }

    // ------------------------------------------------------------------ HTX
    async function renderHtx(panel) {
      const [list, inactive, provinces] = await Promise.all([api('/mdm/cooperatives'), api('/mdm/cooperatives/inactive').catch(() => []), api('/mdm/admin-units?level=province').catch(() => [])]);
      const provs = provinces.filter((a) => a.level === 'province');
      let pendingImport = null;
      panel.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('HTX đang hoạt động', num(list.length), null, null, 'building'),
          kpi('Có toạ độ', num(list.filter((c) => c.lat).length), 'Hiện được trên bản đồ', null, 'pin'),
          kpi('Có ranh giới vùng', num(list.filter((c) => c.boundaryGeo || c.boundary).length), null, null, 'plot'),
          kpi('Đã vô hiệu hoá', num(inactive.length), 'Khôi phục ở tab "Đã xoá"', inactive.length ? 'warning' : null, 'lock'),
        ]),
        mdmWrite ? el('div', { class: 'grid cols-2' }, [
          card('Thêm HTX', form([
            { name: 'name', label: 'Tên HTX', required: true },
            { name: 'provinceId', label: 'Tỉnh', type: 'select', options: [{ value: '', label: '— chọn —' }, ...provs.map((p) => ({ value: p.id, label: p.name }))] },
            { name: 'lat', label: 'Vĩ độ', type: 'number', step: '0.000001' }, { name: 'lng', label: 'Kinh độ', type: 'number', step: '0.000001' },
            { name: 'registeredAreaHa', label: 'Diện tích đăng ký (ha)', type: 'number', step: '0.1' }, { name: 'memberCount', label: 'Thành viên', type: 'number' },
            { name: 'contactName', label: 'Người liên hệ' }, { name: 'contactPhone', label: 'Điện thoại' },
          ], async (v) => { await api('/mdm/cooperatives', { body: { ...v, provinceId: v.provinceId || undefined } }); toast('Đã thêm HTX.'); await renderHtx(panel); }, { submitLabel: 'Thêm HTX' })),
          card('Nạp HTX từ GeoJSON / KML (FN-04)', [
            spatialUpload('Tệp ranh giới / điểm HTX', (r) => { pendingImport = r; }),
            el('div', { class: 'row' }, [
              el('label', {}, ['Tỉnh gán mặc định', el('select', { id: 'htx-import-prov' }, [el('option', { value: '' }, ['— theo thuộc tính tệp —']), ...provs.map((p) => el('option', { value: p.id }, [p.name]))])]),
              el('button', { class: 'small', onclick: async () => {
                if (!pendingImport) return toast('Chọn tệp trước.', true);
                const out = await guard(api('/gis/import/htx', { body: { content: pendingImport.content, fileName: pendingImport.fileName, provinceId: document.getElementById('htx-import-prov').value || undefined } }));
                toast(`Tạo ${out.created}, cập nhật ${out.updated}, lỗi ${out.errors.length}.`, out.errors.length > 0);
                await renderHtx(panel);
              } }, [icon('upload', 14), 'Nạp']),
            ]),
            el('p', { class: 'muted', text: 'Shapefile (.shp) không đọc trực tiếp — chuyển sang GeoJSON/KML trước. Tên HTX trùng sẽ được cập nhật ranh giới thay vì tạo mới.' }),
          ]),
        ]) : null,
        card('Danh sách HTX', table([
          { key: 'code', label: 'Mã' },
          { key: 'name', label: 'Tên' },
          { key: 'province_name', label: 'Tỉnh', render: (r) => r.province_name ?? r.provinceName ?? '—' },
          { key: 'registered_area_ha', label: 'DT đăng ký', align: 'right', render: (r) => `${num(r.registered_area_ha)} ha` },
          { key: 'member_count', label: 'Thành viên', align: 'right' },
          { key: 'geo', label: 'Toạ độ', render: (r) => (r.boundaryGeo || r.boundary ? badge('Vùng', 'good') : r.lat ? badge('Điểm', 'info') : badge('Thiếu', 'warn')) },
          { key: 'act', label: '', render: (r) => (mdmWrite ? el('span', { class: 'chip-row' }, [
            el('button', { class: 'ghost small', title: 'Vẽ ranh giới / đặt điểm', onclick: () => boundaryEditor('htx', r, () => renderHtx(panel)) }, [icon('edit', 14)]),
            el('button', { class: 'ghost small', title: 'Lịch sử', onclick: () => showHistory('cooperatives', r.id, r.name) }, [icon('history', 14)]),
            el('button', { class: 'ghost small danger', title: 'Vô hiệu hoá', onclick: async () => {
              const impact = await api(`/mdm/cooperatives/${r.id}/impact`);
              const reason = await promptDialog(`Vô hiệu hoá ${r.name}`, { multiline: true, minLength: 20, placeholder: 'Lý do (tối thiểu 20 ký tự)',
                message: `Ảnh hưởng: ${impact.farmers} nông hộ · ${impact.openCycles} vụ đang canh tác · ${impact.pendingLogs} nhật ký chờ duyệt · ${impact.accounts} tài khoản sẽ bị khoá · ${impact.machines} máy.` });
              if (reason === null) return;
              const out = await guard(api(`/mdm/cooperatives/${r.id}/deactivate`, { body: { reason } }));
              toast(`Đã vô hiệu hoá — khoá ${out.lockedAccounts} tài khoản.`); await renderHtx(panel);
            } }, [icon('lock', 14)]),
          ]) : '—') },
        ], list, { empty: 'Chưa có HTX.' })),
      );
    }

    // ------------------------------------------------------------------ Kho / Hub
    async function renderFacilities(panel) {
      const [facilities, capacity] = await Promise.all([guard(api('/mdm/facilities')), api('/gis/capacity').catch(() => [])]);
      const capOf = new Map(capacity.map((c) => [c.id, c]));
      let pendingImport = null;
      panel.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Cơ sở vận hành', num(facilities.length), null, null, 'factory'),
          kpi('Hub / Kho / Bãi', num(facilities.filter((f) => ['hub', 'warehouse', 'yard'].includes(f.kind)).length), 'Có widget dung lượng', null, 'database'),
          kpi('Tổng sức chứa', tons(facilities.reduce((a, f) => a + (f.capacity_tons ?? 0), 0)), null, null, 'scale'),
          kpi('Kho gần đầy', num(capacity.filter((c) => c.fillPct >= 80).length), '≥ 80% đầy', capacity.some((c) => c.fillPct >= 80) ? 'warning' : null, 'warning'),
        ]),
        mdmWrite ? el('div', { class: 'grid cols-2' }, [
          card('Thêm kho / hub / nhà máy (FN-05)', form([
            { name: 'name', label: 'Tên cơ sở', required: true },
            { name: 'kind', label: 'Loại', type: 'select', required: true, options: [['hub', 'Hub'], ['warehouse', 'Kho'], ['yard', 'Bãi'], ['plant', 'Nhà máy']].map(([value, label]) => ({ value, label })) },
            { name: 'lat', label: 'Vĩ độ', type: 'number', step: '0.000001', required: true }, { name: 'lng', label: 'Kinh độ', type: 'number', step: '0.000001', required: true },
            { name: 'capacityTons', label: 'Sức chứa (tấn)', type: 'number', step: '1' },
          ], async (v) => { await api('/mdm/facilities', { body: v }); toast('Đã thêm cơ sở.'); await renderFacilities(panel); }, { submitLabel: 'Thêm cơ sở' })),
          card('Nạp hub/kho từ GeoJSON / KML', [
            spatialUpload('Tệp điểm / vùng cơ sở', (r) => { pendingImport = r; }),
            el('div', { class: 'row' }, [
              el('label', {}, ['Loại mặc định', el('select', { id: 'fac-import-kind' }, [['hub', 'Hub'], ['warehouse', 'Kho'], ['yard', 'Bãi'], ['plant', 'Nhà máy']].map(([v, l]) => el('option', { value: v }, [l])))]),
              el('button', { class: 'small', onclick: async () => {
                if (!pendingImport) return toast('Chọn tệp trước.', true);
                const out = await guard(api('/gis/import/hub', { body: { content: pendingImport.content, fileName: pendingImport.fileName, kind: document.getElementById('fac-import-kind').value } }));
                toast(`Tạo ${out.created}, cập nhật ${out.updated}, lỗi ${out.errors.length}.`, out.errors.length > 0); await renderFacilities(panel);
              } }, [icon('upload', 14), 'Nạp']),
            ]),
          ]),
        ]) : null,
        card('Danh sách cơ sở', table([
          { key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' },
          { key: 'kind', label: 'Loại', render: (r) => badge(FACILITY_KIND[r.kind] ?? r.kind, 'neutral') },
          { key: 'capacity_tons', label: 'Sức chứa', align: 'right', render: (r) => tons(r.capacity_tons) },
          { key: 'current_stock_tons', label: 'Tồn', align: 'right', render: (r) => tons(r.current_stock_tons) },
          { key: 'fill', label: '% đầy', render: (r) => { const c = capOf.get(r.id); return c ? el('span', { class: 'badge', style: `background:${c.color}22;color:${c.color}` }, [`${c.fillPct}% · ${c.label}`]) : '—'; } },
          { key: 'act', label: '', render: (r) => (mdmWrite ? el('span', { class: 'chip-row' }, [
            el('button', { class: 'ghost small', title: 'Vẽ ranh giới / vị trí', onclick: () => boundaryEditor('facility', r, () => renderFacilities(panel)) }, [icon('edit', 14)]),
            el('button', { class: 'ghost small', title: 'Nhập tay sức chứa (dự phòng khi ERP mất kết nối)', onclick: async () => {
              const dlg = modal(`Nhập tay: ${r.name}`, [
                el('p', { class: 'muted', text: 'Chỉ dùng khi ERP không đồng bộ được. Khi ERP trở lại, hệ thống sẽ hỏi trước khi ghi đè số nhập tay (BR-52).' }),
                form([{ name: 'capacity_tons', label: 'Sức chứa (tấn)', type: 'number', value: r.capacity_tons }, { name: 'current_stock_tons', label: 'Tồn kho (tấn)', type: 'number', value: r.current_stock_tons }],
                  async (v) => { await api('/gis/admin/manual-entry', { body: { table: 'facilities', id: r.id, fields: v } }); toast('Đã nhập tay.'); dlg.close(); await renderFacilities(panel); }, { submitLabel: 'Lưu nhập tay', stacked: true }),
              ]);
            } }, [icon('edit', 14), 'Nhập tay']),
            el('button', { class: 'ghost small', title: 'Lịch sử', onclick: () => showHistory('facilities', r.id, r.name) }, [icon('history', 14)]),
            el('button', { class: 'ghost small danger', title: 'Xoá mềm', onclick: async () => {
              const reason = await promptDialog(`Xoá ${r.name}`, { placeholder: 'Lý do xoá', message: 'Bản ghi bị ẩn khỏi bản đồ và có thể khôi phục ở tab "Đã xoá" (BR-19).' });
              if (reason === null) return;
              await guard(api(`/mdm/facilities/${r.id}`, { method: 'DELETE', body: { reason } })); toast('Đã xoá mềm.'); await renderFacilities(panel);
            } }, [icon('trash', 14)]),
          ]) : '—') },
        ], facilities, { empty: 'Chưa có cơ sở nào.' })),
      );
    }

    // ------------------------------------------------------------------ Thửa ruộng
    async function renderPlots(panel) {
      const cooperatives = await api('/mdm/cooperatives');
      let htxId = cooperatives[0]?.id ?? '';
      let showDeleted = false;
      let pendingImport = null;
      const body = el('div');
      const draw = async () => {
        const plots = htxId ? await guard(api(`/mdm/plots/all?htxId=${htxId}&deleted=${showDeleted ? 1 : 0}`)) : [];
        body.replaceChildren(
          el('div', { class: 'grid cols-4' }, [
            kpi('Thửa', num(plots.filter((p) => !p.deleted_at).length), null, null, 'plot'),
            kpi('Diện tích', `${num(plots.filter((p) => !p.deleted_at).reduce((a, p) => a + (p.area_ha ?? 0), 0), 2)} ha`, 'Hệ thống tính từ polygon', null, 'ruler'),
            kpi('Đã xoá', num(plots.filter((p) => p.deleted_at).length), null, null, 'trash'),
          ]),
          table([
            { key: 'code', label: 'Mã thửa' },
            { key: 'area_ha', label: 'Diện tích (ha)', align: 'right', render: (r) => num(r.area_ha, 4) },
            { key: 'status', label: 'Trạng thái', render: (r) => (r.deleted_at ? badge(`Đã xoá ${dateOnly(r.deleted_at)}`, 'bad') : badge(r.status ?? '—', 'neutral')) },
            { key: 'source', label: 'Nguồn' },
            { key: 'act', label: '', render: (r) => (mdmWrite ? (r.deleted_at
              ? el('button', { class: 'ghost small', onclick: async () => { await guard(api(`/mdm/plots/${r.id}/restore`, { body: {} })); toast('Đã khôi phục.'); await draw(); } }, [icon('unlock', 14), 'Khôi phục'])
              : el('span', { class: 'chip-row' }, [
                el('button', { class: 'ghost small', onclick: () => showHistory('plots', r.id, r.code) }, [icon('history', 14)]),
                el('button', { class: 'ghost small danger', onclick: async () => {
                  const reason = await promptDialog(`Xoá thửa ${r.code}`, { placeholder: 'Lý do', message: 'Vụ canh tác gắn với thửa vẫn giữ lịch sử; thửa có thể khôi phục.' });
                  if (reason === null) return;
                  await guard(api(`/mdm/plots/${r.id}`, { method: 'DELETE', body: { reason } })); toast('Đã xoá mềm.'); await draw();
                } }, [icon('trash', 14)]),
              ])) : '—') },
          ], plots, { empty: 'HTX chưa có thửa nào.' }),
        );
      };
      panel.replaceChildren(
        el('div', { class: 'row' }, [
          el('label', {}, ['HTX', el('select', { onchange: (e) => { htxId = e.target.value; draw(); } }, cooperatives.map((c) => el('option', { value: c.id }, [`${c.code} — ${c.name}`])))]),
          el('label', { class: 'pick-item', style: 'align-self:end' }, [el('input', { type: 'checkbox', onchange: (e) => { showDeleted = e.target.checked; draw(); } }), 'Hiện thửa đã xoá']),
        ]),
        mdmWrite ? card('Tải KML / GeoJSON thửa cho HTX đang chọn (FN-06)', [
          spatialUpload('Tệp ranh giới thửa', (r) => { pendingImport = r; }),
          el('button', { class: 'small', onclick: async () => {
            if (!pendingImport) return toast('Chọn tệp trước.', true);
            const out = await guard(api('/gis/import/plot', { body: { content: pendingImport.content, fileName: pendingImport.fileName, htxId } }));
            toast(`Tạo ${out.created} thửa, lỗi ${out.errors.length}${out.errors.length ? `: ${out.errors[0].reason}` : ''}.`, out.errors.length > 0);
            await draw();
          } }, [icon('upload', 14), 'Nạp thửa']),
        ]) : null,
        body,
      );
      await draw();
    }

    // ------------------------------------------------------------------ Ranh giới hành chính
    async function renderAdminUnits(panel) {
      const units = await guard(api('/mdm/admin-units'));
      let pending = null;
      const previewBox = el('div');
      panel.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Tỉnh', num(units.filter((u) => u.level === 'province').length), 'Sau sắp xếp 2025', null, 'map'),
          kpi('Xã', num(units.filter((u) => u.level === 'commune').length), null, null, 'pin'),
          kpi('Có ranh giới', num(units.filter((u) => u.boundary).length), `/${units.length} đơn vị`, null, 'plot'),
        ]),
        admin ? card('Nạp ranh giới hành chính (FN-07)', [
          el('p', { class: 'muted', text: 'Tệp GeoJSON/KML có thuộc tính tên/mã xã, tỉnh. Hệ thống khớp theo mã hoặc tên; đơn vị không khớp được liệt kê để rà soát trước khi áp dụng.' }),
          spatialUpload('Tệp ranh giới', async (r) => {
            pending = r;
            if (!r) return previewBox.replaceChildren();
            const pv = await guard(api('/gis/admin-boundaries/preview', { body: { content: r.content, fileName: r.fileName } }));
            previewBox.replaceChildren(
              el('div', { class: 'chip-row' }, [badge(`${pv.matched.length} khớp`, 'good'), badge(`${pv.unmatched.length} không khớp`, pv.unmatched.length ? 'warn' : 'neutral')]),
              table([{ key: 'name', label: 'Đơn vị' }, { key: 'level', label: 'Cấp' }, { key: 'vertices', label: 'Đỉnh', align: 'right' }], pv.matched.slice(0, 50), { plain: true }),
              pv.unmatched.length ? el('p', { class: 'muted', text: `Không khớp: ${pv.unmatched.slice(0, 10).join(', ')}` }) : null,
              el('button', { class: 'small', disabled: !pv.matched.length, onclick: async () => {
                if (!(await confirmDialog(`Áp dụng ranh giới cho ${pv.matched.length} đơn vị? Ranh giới cũ được giữ trong nhật ký.`))) return;
                const out = await guard(api('/gis/admin-boundaries/apply', { body: { content: pending.content, fileName: pending.fileName } }));
                toast(`Đã cập nhật ${out.updated} đơn vị.`); await renderAdminUnits(panel);
              } }, [icon('check', 14), 'Áp dụng']),
            );
          }),
          previewBox,
        ]) : null,
        card('Đơn vị hành chính', table([
          { key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' },
          { key: 'level', label: 'Cấp', render: (r) => badge(r.level === 'province' ? 'Tỉnh' : 'Xã', r.level === 'province' ? 'info' : 'neutral') },
          { key: 'boundary', label: 'Ranh giới', render: (r) => (r.boundary ? badge('Có', 'good') : badge('Chưa', 'warn')) },
          { key: 'centroid_lat', label: 'Tâm', render: (r) => (r.centroid_lat ? `${Number(r.centroid_lat).toFixed(3)}, ${Number(r.centroid_lng).toFixed(3)}` : '—') },
        ], units, { empty: 'Chưa có đơn vị hành chính.' })),
      );
    }

    // ------------------------------------------------------------------ Đã xoá
    async function renderDeleted(panel) {
      const items = await guard(api('/mdm/deleted'));
      const label = { plots: 'Thửa', facilities: 'Cơ sở', cooperatives: 'HTX' };
      panel.replaceChildren(card('Bản ghi đã xoá / vô hiệu hoá (BR-19)', items.length ? table([
        { key: 'table', label: 'Loại', render: (r) => badge(label[r.table] ?? r.table, 'neutral') },
        { key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên', render: (r) => r.name ?? '—' },
        { key: 'deletedAt', label: 'Lúc', render: (r) => dateTime(r.deletedAt) },
        { key: 'by', label: 'Người', render: (r) => r.by ?? '—' },
        { key: 'reason', label: 'Lý do', render: (r) => r.reason ?? '—' },
        { key: 'act', label: '', render: (r) => (mdmWrite ? el('button', { class: 'ghost small', onclick: async () => {
          if (r.table === 'cooperatives') await guard(api(`/mdm/cooperatives/${r.id}/reactivate`, { body: {} }));
          else await guard(api('/mdm/restore', { body: { table: r.table, id: r.id } }));
          toast('Đã khôi phục.'); await renderDeleted(panel);
        } }, [icon('unlock', 14), 'Khôi phục']) : '—') },
      ], items) : emptyState('Không có bản ghi nào đã xoá.', 'trash')));
    }

    // ------------------------------------------------------------------ Đồng bộ
    async function renderSync(panel) {
      const [monitor, overrides] = await Promise.all([guard(api('/gis/admin/sync')), api('/gis/admin/overrides').catch(() => [])]);
      panel.replaceChildren(
        el('div', { class: 'stack' }, (monitor.sources ?? []).map((s) => el('div', { class: 'sync-card' }, [
          el('span', { class: `si ${s.health === 'ok' ? '' : s.health === 'warn' ? 'warn' : 'bad'}` }, [icon(s.health === 'ok' ? 'check' : 'warning', 20)]),
          el('div', { class: 'st' }, [el('b', { text: s.label }), el('span', { class: 'muted', text: `Lần cuối: ${s.last ? dateTime(s.last) : '—'} · ${num(s.records)} bản ghi` })]),
          el('div', { class: 'sync-metrics' }, [
            el('div', {}, [el('div', { class: 'm', text: num(s.success) }), el('small', { text: 'thành công' })]),
            el('div', {}, [el('div', { class: 'm', style: s.failed ? 'color:var(--warning)' : '', text: num(s.failed) }), el('small', { text: 'thất bại' })]),
            el('div', {}, [el('div', { class: 'm', style: s.dead ? 'color:var(--critical)' : '', text: num(s.dead) }), el('small', { text: 'dead-letter' })]),
          ]),
        ]))),
        admin ? el('div', { class: 'chip-row' }, [
          el('button', { class: 'ghost small', onclick: async () => { await guard(api('/gis/admin/sync/simulate-failure', { body: { system: 'app_htx', dataset: 'demo_failure' } })); toast('Đã tạo giao dịch thất bại mẫu.'); await renderSync(panel); } }, [icon('warning', 14), 'Mô phỏng lỗi App HTX']),
        ]) : null,
        card('Dead-letter cần xử lý (FN-23)', (monitor.deadLetter ?? []).length ? table([
          { key: 'system', label: 'Hệ thống' }, { key: 'dataset', label: 'Bộ dữ liệu' },
          { key: 'started_at', label: 'Lúc', render: (r) => dateTime(r.started_at) },
          { key: 'attempt', label: 'Lần thử', align: 'right' },
          { key: 'error_message', label: 'Lỗi', render: (r) => el('span', { class: 'muted', text: String(r.error_message ?? '').slice(0, 80) }) },
          { key: 'act', label: '', render: (r) => (admin ? el('button', { class: 'ghost small', onclick: async () => { const out = await guard(api(`/gis/admin/sync/${r.id}/retry`, { body: {} })); toast(out.status === 'success' ? 'Thử lại thành công.' : `Kết quả: ${out.status}`); await renderSync(panel); } }, [icon('refresh', 14), 'Thử lại']) : '—') },
        ], monitor.deadLetter) : alert('Không có giao dịch dead-letter.', 'good')),
        card('Số nhập tay đang chờ xác nhận ghi đè (BR-52)', overrides.length ? table([
          { key: 'table', label: 'Bảng' }, { key: 'id', label: 'Bản ghi', render: (r) => r.current?.name ?? r.current?.code ?? r.id },
          { key: 'fields', label: 'Giá trị nhập tay', render: (r) => el('code', { text: JSON.stringify(r.fields) }) },
          { key: 'enteredAt', label: 'Lúc', render: (r) => dateTime(r.enteredAt) },
          { key: 'differs', label: 'Nguồn đã khác?', render: (r) => badge(r.differs ? 'Có' : 'Chưa', r.differs ? 'warn' : 'neutral') },
          { key: 'act', label: '', render: (r) => (admin ? el('span', { class: 'chip-row' }, [
            el('button', { class: 'ghost small', onclick: async () => { await guard(api('/gis/admin/overrides/resolve', { body: { table: r.table, id: r.id, accept: false } })); toast('Giữ số nhập tay.'); await renderSync(panel); } }, ['Giữ nhập tay']),
            el('button', { class: 'small', onclick: async () => { await guard(api('/gis/admin/overrides/resolve', { body: { table: r.table, id: r.id, accept: true, incoming: r.incoming ?? undefined } })); toast('Đã cho phép nguồn ghi đè.'); await renderSync(panel); } }, ['Cho nguồn ghi đè']),
          ]) : '—') },
        ], overrides) : el('p', { class: 'muted', text: 'Không có bản ghi nhập tay nào.' })),
        card('Giao dịch đồng bộ gần đây', table([
          { key: 'started_at', label: 'Lúc', render: (r) => dateTime(r.started_at) },
          { key: 'system', label: 'Hệ thống' }, { key: 'direction', label: 'Chiều', render: (r) => (r.direction === 'inbound' ? 'Vào' : 'Ra') },
          { key: 'dataset', label: 'Bộ dữ liệu' }, { key: 'record_count', label: 'Bản ghi', align: 'right' },
          { key: 'status', label: 'Trạng thái', render: (r) => badge(SYNC_STATUS[r.status]?.[0] ?? r.status, SYNC_STATUS[r.status]?.[1] ?? 'neutral') },
        ], (monitor.recent ?? []).slice(0, 40), { empty: 'Chưa có giao dịch.' })),
      );
    }

    // ------------------------------------------------------------------ Nhật ký
    async function renderHistory(panel) {
      let entityType = 'cooperatives';
      let entityId = '';
      const body = el('div');
      const draw = async () => {
        const rows = await guard(api(`/mdm/history?entityType=${entityType}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}&limit=200`));
        body.replaceChildren(table([
          { key: 'occurred_at', label: 'Lúc', render: (r) => dateTime(r.occurred_at) },
          { key: 'action', label: 'Hành động', render: (r) => badge({ create: 'Tạo', update: 'Sửa', delete: 'Xoá' }[r.action] ?? r.action, r.action === 'delete' ? 'bad' : r.action === 'create' ? 'good' : 'info') },
          { key: 'entity_id', label: 'Bản ghi' }, { key: 'actor_name', label: 'Người' },
          { key: 'note', label: 'Ghi chú', render: (r) => r.note ?? '—' },
          { key: 'diff', label: 'Thay đổi', render: (r) => el('details', { class: 'raw' }, [el('summary', { class: 'muted', text: 'xem' }), el('pre', { text: `TRƯỚC: ${String(r.before_json ?? '—').slice(0, 600)}\nSAU:   ${String(r.after_json ?? '—').slice(0, 600)}` })]) },
        ], rows, { empty: 'Không có sự kiện.' }));
      };
      panel.replaceChildren(
        el('div', { class: 'row' }, [
          el('label', {}, ['Đối tượng', el('select', { onchange: (e) => { entityType = e.target.value; draw(); } }, [['cooperatives', 'HTX'], ['facilities', 'Kho / Hub'], ['plots', 'Thửa'], ['admin_units', 'Đơn vị hành chính'], ['transport_routes', 'Tuyến'], ['system_config', 'Cấu hình']].map(([v, l]) => el('option', { value: v }, [l])))]),
          el('label', {}, ['Mã bản ghi (tuỳ chọn)', el('input', { placeholder: 'id', oninput: (e) => { entityId = e.target.value.trim(); } })]),
          el('button', { class: 'small', onclick: draw }, [icon('search', 14), 'Xem']),
        ]),
        body,
      );
      await draw();
    }

    // ------------------------------------------------------------------ Lưu trữ
    async function renderRetention(panel) {
      const policy = await guard(api('/audit/retention'));
      panel.replaceChildren(el('div', { class: 'grid cols-2' }, [
        card('Chính sách lưu trữ (FN-18)', [
          el('p', { class: 'muted', text: 'Event log là nguồn sự thật để tái dựng trạng thái theo ngày; snapshot chỉ để truy vấn nhanh. Gộp (compact) sự kiện cũ giúp giữ hiệu năng.' }),
          form([
            { name: 'eventLogDays', label: 'Giữ event log (ngày)', type: 'number', min: '30', value: policy.eventLogDays, required: true },
            { name: 'snapshotDays', label: 'Giữ snapshot hàng ngày (ngày)', type: 'number', min: '7', value: policy.snapshotDays, required: true },
            { name: 'compactAfterDays', label: 'Gộp sự kiện sau (ngày)', type: 'number', min: '7', value: policy.compactAfterDays, required: true },
          ], async (v) => { await api('/audit/retention', { method: 'PUT', body: v }); toast('Đã lưu chính sách.'); }, { submitLabel: 'Lưu', resetOnSuccess: false, stacked: true }),
          admin ? el('button', { class: 'ghost small', onclick: async () => { if (!(await confirmDialog('Áp dụng chính sách lưu trữ ngay? Sự kiện quá hạn sẽ bị gộp/xoá theo cấu hình.', { danger: true }))) return; const out = await guard(api('/audit/retention/apply', { body: {} })); toast(`Đã áp dụng: ${JSON.stringify(out)}`); } }, [icon('trash', 14), 'Áp dụng ngay']) : null,
        ]),
        card('Snapshot', [
          el('p', { class: 'muted', text: 'Hệ thống chụp snapshot toàn bộ lớp mỗi ngày. Có thể chụp thủ công ở màn "Lịch sử & Replay".' }),
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Lớp được chụp' }), el('span', { class: 'v', text: 'HTX · thửa · cơ sở · tuyến · mùa vụ · máy · thời tiết · dung lượng kho' })]),
        ]),
      ]));
    }

    // ------------------------------------------------------------------ Tích hợp
    async function renderIntegration(panel) {
      const info = await guard(api('/gis/admin/integration'));
      const row = (s) => el('div', { class: 'sync-card' }, [
        el('span', { class: `si ${s.last?.status === 'success' || !s.last ? '' : 'warn'}` }, [icon('link', 20)]),
        el('div', { class: 'st' }, [el('b', { text: s.label }), el('span', { class: 'muted', text: s.datasets.join(' · ') }), s.feeds ? el('div', { class: 'chip-row', style: 'margin-top:6px' }, s.feeds.map((f) => badge(f, 'info'))) : null]),
        el('div', { style: 'text-align:right' }, [el('div', { class: 'muted', text: s.last ? `${dateTime(s.last.started_at)} · ${num(s.last.record_count)} bản ghi` : 'Chưa có giao dịch' }), s.last ? badge(SYNC_STATUS[s.last.status]?.[0] ?? s.last.status, SYNC_STATUS[s.last.status]?.[1] ?? 'neutral') : null]),
      ]);
      const health = can('admin.config') ? await api('/admin/db-health').catch(() => null) : null;
      const healthCard = health ? card('Sức khoẻ cơ sở dữ liệu', [
        el('div', { class: 'chip-row' }, [
          ...health.integrity.map((d) => badge(`${d.domain}: ${d.result === 'ok' ? 'toàn vẹn' : d.result}`, d.result === 'ok' ? 'good' : 'bad')),
          badge(`${health.indexes.reduce((a, d) => a + d.explicit, 0)} chỉ mục`, 'neutral'),
        ]),
        el('h4', { text: 'Tham chiếu xuyên miền (15 quan hệ không có khoá ngoại ở tầng SQLite)' }),
        health.orphans.some((o) => o.orphans > 0)
          ? table([{ key: 'table', label: 'Bảng con' }, { key: 'column', label: 'Cột' }, { key: 'parent', label: 'Bảng cha' }, { key: 'orphans', label: 'Mồ côi', align: 'right' }, { key: 'sample', label: 'Ví dụ', render: (r) => r.sample.join(', ') }], health.orphans.filter((o) => o.orphans > 0), { plain: true })
          : alert('Không có bản ghi mồ côi — mọi tham chiếu xuyên miền đều còn bản ghi cha.', 'good'),
        el('h4', { text: 'Sao lưu' }),
        el('div', { class: 'chip-row' }, [el('button', { class: 'small', onclick: async () => { const r = await guard(api('/admin/db-backup', { body: {} })); toast(`${r.manifest.ok ? 'Đã sao lưu' : 'Sao lưu lỗi'}: ${r.manifest.files.length} tệp trong ${r.manifest.durationMs} ms.`); await renderIntegration(panel); } }, [icon('database', 14), 'Sao lưu ngay'])]),
        table([
          { key: 'createdAt', label: 'Lúc', render: (r) => dateTime(r.createdAt) }, { key: 'ok', label: 'Kết quả', render: (r) => badge(r.ok ? 'Hợp lệ' : 'Lỗi', r.ok ? 'good' : 'bad') },
          { key: 'bytes', label: 'Dung lượng', align: 'right', render: (r) => `${num(r.bytes / 1024)} KB` }, { key: 'dir', label: 'Thư mục', render: (r) => el('code', { text: r.dir }) },
        ], health.backups, { plain: true, empty: 'Chưa có đợt sao lưu nào — sao lưu tự động chạy 5 phút sau khi khởi động và mỗi 24 giờ (BACKUP_INTERVAL_HOURS).' }),
      ]) : null;
      panel.replaceChildren(
        healthCard,
        card('Luồng dữ liệu VÀO GIS (FN-21)', el('div', { class: 'stack' }, (info.inbound ?? []).map(row))),
        card('Luồng dữ liệu RA từ GIS', el('div', { class: 'stack' }, (info.outbound ?? []).map(row))),
        alert(`Đang có ${info.manualOverrides ?? 0} bản ghi nhập tay dự phòng. GIS chỉ HIỂN THỊ kết quả thiếu/thừa máy từ Bản đồ CGH, không tính lại.`, 'info'),
      );
    }

    // ------------------------------------------------------------------ Giống lúa & mùa vụ (UAT DEF-HTX-13)
    async function renderCatalog(panel) {
      const [varieties, seasons] = await Promise.all([guard(api('/mdm/rice-varieties?all=1')), api('/mdm/seasons').catch(() => [])]);
      panel.replaceChildren(
        el('div', { class: 'grid cols-2' }, [
          card('Giống lúa', [
            el('p', { class: 'muted', text: 'Giống đang được vụ tham chiếu thì chỉ ẩn được, không xoá; giống ẩn khôi phục lại được.' }),
            mdmWrite ? form([
              { name: 'code', label: 'Mã giống', required: true, placeholder: 'OM5451' }, { name: 'name', label: 'Tên giống', required: true },
              { name: 'growthDays', label: 'Ngày sinh trưởng', type: 'number', min: '60', value: 95 },
              { name: 'yieldMinTHa', label: 'Năng suất tối thiểu (t/ha)', type: 'number', step: '0.1', value: 5 }, { name: 'yieldMaxTHa', label: 'Năng suất tối đa (t/ha)', type: 'number', step: '0.1', value: 8 },
            ], async (v) => { await api('/mdm/rice-varieties', { body: v }); toast('Đã lưu giống lúa.'); await renderCatalog(panel); }, { submitLabel: 'Thêm / cập nhật giống' }) : null,
            table([
              { key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }, { key: 'growth_days', label: 'Ngày ST', align: 'right' },
              { key: 'yield', label: 'Năng suất (t/ha)', render: (r) => `${num(r.yield_min_t_ha, 1)} – ${num(r.yield_max_t_ha, 1)}` },
              { key: 'status', label: 'Trạng thái', render: (r) => badge(r.status === 'hidden' ? 'Đã ẩn' : 'Đang dùng', r.status === 'hidden' ? 'neutral' : 'good') },
              { key: 'act', label: '', render: (r) => (mdmWrite ? (r.status === 'hidden'
                ? el('button', { class: 'ghost small', onclick: async () => { await guard(api(`/mdm/rice-varieties/${r.id}/restore`, { body: {} })); toast('Đã khôi phục.'); await renderCatalog(panel); } }, [icon('unlock', 14), 'Khôi phục'])
                : el('button', { class: 'ghost small danger', onclick: async () => { if (!(await confirmDialog(`Ẩn/xoá giống ${r.name}? Giống đang được vụ tham chiếu sẽ chỉ bị ẩn.`))) return; const out = await guard(api(`/mdm/rice-varieties/${r.id}`, { method: 'DELETE' })); toast(out.hidden ? `Đã ẩn (đang có ${out.referenced} vụ tham chiếu).` : 'Đã xoá.'); await renderCatalog(panel); } }, [icon('trash', 14)])) : '—') },
            ], varieties, { empty: 'Chưa có giống lúa.' }),
          ]),
          card('Mùa vụ', [
            mdmWrite ? form([
              { name: 'code', label: 'Mã vụ', required: true, placeholder: 'DX-2026-2027' }, { name: 'name', label: 'Tên vụ', required: true, placeholder: 'Đông Xuân 2026-2027' },
              { name: 'year', label: 'Năm', type: 'number', required: true, value: new Date().getFullYear() },
              { name: 'startMonth', label: 'Tháng bắt đầu', type: 'number', min: '1', max: '12', required: true, value: 11 }, { name: 'endMonth', label: 'Tháng kết thúc', type: 'number', min: '1', max: '12', required: true, value: 3 },
              { name: 'sortOrder', label: 'Thứ tự', type: 'number', value: 1 },
            ], async (v) => { await api('/mdm/seasons', { body: v }); toast('Đã thêm mùa vụ.'); await renderCatalog(panel); }, { submitLabel: 'Thêm mùa vụ' }) : null,
            table([
              { key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }, { key: 'year', label: 'Năm', align: 'right' },
              { key: 'months', label: 'Tháng', render: (r) => `${r.start_month} → ${r.end_month}` }, { key: 'sort_order', label: 'Thứ tự', align: 'right' },
            ], seasons, { empty: 'Chưa có mùa vụ.' }),
          ]),
        ]),
      );
    }

    function showHistory(entityType, entityId, title) {
      api(`/mdm/history?entityType=${entityType}&entityId=${encodeURIComponent(entityId)}&limit=100`).then((rows) => {
        modal(`Lịch sử: ${title}`, rows.length ? el('div', { class: 'timeline' }, rows.map((r) => el('div', { class: 'tl-item' }, [
          el('span', { class: 'dot', style: r.action === 'delete' ? 'background:var(--critical)' : r.action === 'create' ? 'background:var(--good)' : '' }),
          el('div', { class: 'body' }, [el('b', { text: `${{ create: 'Tạo', update: 'Sửa', delete: 'Xoá' }[r.action] ?? r.action} · ${r.actor_name ?? 'hệ thống'}` }), el('span', { text: `${dateTime(r.occurred_at)}${r.note ? ` · ${r.note}` : ''}` })]),
        ]))) : emptyState('Chưa có lịch sử.', 'history'));
      }).catch((e) => toast(e.message, true));
    }
    void apiConfirm;
  },
});
