/**
 * MẠNG LƯỚI ĐƯỜNG THUỶ — Nền tảng GIS dùng chung.
 *
 *   gis-network   Nhận diện cấu trúc mạng lưới, dựng lại, kiểm tra tiếp cận cơ sở
 *   gis-clearance Khai báo rộng/sâu/cầu → suy ra tải trọng lưu thông từng tuyến
 *   gis-routing   Đường đi tối ưu Hub → Nhà máy theo từng lớp phương tiện
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num,
  toast, guard, can, form, mapContainer, createMap, LEAFLET_AVAILABLE,
} from '/app.js';

const FINDING_LABEL = {
  giao_cat: 'Giao cắt thiếu đỉnh',
  noi_chu_t: 'Nối chữ T thiếu đỉnh',
  khe_ho: 'Khe hở',
  tuyen_co_lap: 'Tuyến cô lập',
};

// ===========================================================================
// Nhận diện & dựng lại cấu trúc mạng lưới
// ===========================================================================

registerPage('gis-network', {
  title: 'Cấu trúc mạng lưới đường thuỷ',
  subtitle: 'Tự động nhận diện chỗ mạng lưới bị đứt và dựng lại để thuật toán tìm đường đi qua được',
  async render(view, actions) {
    const [analysis, meta] = await Promise.all([
      guard(api('/waterway/analysis')), api('/waterway/vessels'),
    ]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };

    const mapNode = mapContainer('gis-network-map', 'tall');

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Tuyến đã xác nhận', `${num(analysis.confirmedCount)}/${num(analysis.routeCount)}`,
          `${num(analysis.totalLengthKm, 1)} km`),
        kpi('Cụm liên thông', num(analysis.componentCount),
          analysis.componentCount === 1 ? 'Toàn mạng lưới đi tới nhau được' : 'Mạng lưới đang bị chia cắt',
          analysis.componentCount === 1 ? 'good' : 'critical'),
        kpi('Điểm cần xử lý', num(analysis.findings.length),
          `${analysis.findings.filter((f) => f.autoFixable).length} chỗ sửa tự động được`,
          analysis.findings.length ? 'warning' : 'good'),
        kpi('Cơ sở ngoài tầm tiếp cận', num(analysis.disconnectedFacilities),
          'Hub / nhà máy không với tới mạng lưới',
          analysis.disconnectedFacilities ? 'critical' : 'good'),
      ]),

      alert(
        'Hệ thống nhận diện CẤU TRÚC mạng lưới từ các tuyến đã số hoá — không nhận diện kênh rạch từ ' +
        'ảnh vệ tinh. Cái được tìm ra là chỗ hai tuyến nhìn trên bản đồ thì nối nhau nhưng trong dữ liệu ' +
        'là hai đường rời, khiến thuật toán tìm đường không rẽ qua được.',
        'info'),

      ...analysis.notes
        .filter((note) => note.includes('vượt bán kính') || note.includes('cụm rời'))
        .map((note) => alert(note, 'bad')),

      can('gis.write')
        ? card('Dựng lại mạng lưới', [
            el('p', { class: 'muted', text: `Chèn đỉnh tại các giao điểm để hai tuyến nối được với nhau. Khe hở ≤ ${meta.autoJoinMaxM} m coi là lỗi số hoá và nối được; xa hơn chỉ báo cáo, vì rất có thể là hai con kênh khác nhau và nối bừa sẽ tạo ra tuyến vận tải không có thật.` }),
            form([
              {
                name: 'joinGaps', label: 'Nối khe hở nhỏ', type: 'select',
                options: [
                  { value: '0', label: 'Không — chỉ chèn đỉnh tại giao điểm' },
                  { value: '1', label: `Có — nối khe hở ≤ ${meta.autoJoinMaxM} m` },
                ],
              },
            ], async (values) => {
              const result = await api('/waterway/rebuild', { body: { joinGaps: values.joinGaps === '1' } });
              toast(
                `Đã chèn ${result.verticesInserted} đỉnh, sửa ${result.routesModified.length} tuyến, ` +
                `nối ${result.gapsJoined.length} khe hở. Còn ${result.analysisAfter.componentCount} cụm.`,
              );
              for (const item of result.skipped) toast(`Bỏ qua: ${item.reason}`, true);
              await refresh();
            }, { submitLabel: '🔧 Dựng lại mạng lưới' }),
          ])
        : null,

      card('Điểm cần xử lý', table([
        { key: 'kind', label: 'Loại', render: (row) => badge(FINDING_LABEL[row.kind] ?? row.kind, row.autoFixable ? 'warn' : 'bad') },
        { key: 'routeCodes', label: 'Tuyến liên quan', render: (row) => row.routeCodes.join(' ↔ ') },
        { key: 'gapM', label: 'Khe hở', align: 'right', render: (row) => (row.gapM ? `${num(row.gapM)} m` : '—') },
        { key: 'label', label: 'Mô tả' },
        {
          key: 'autoFixable', label: 'Sửa tự động',
          render: (row) => badge(row.autoFixable ? 'Được' : 'Không', row.autoFixable ? 'good' : 'neutral'),
        },
      ], analysis.findings, { empty: 'Mạng lưới không có chỗ nào bị đứt — mọi tuyến đã nối đúng.' })),

      card('Khả năng tiếp cận mạng lưới của Hub và Nhà máy', [
        el('p', { class: 'muted', text: 'Mạng lưới có đẹp tới đâu mà nhà máy nằm cách bờ kênh quá xa thì mọi chặng đường thuỷ vẫn rơi về ước lượng Haversine hiệu chỉnh.' }),
        table([
          { key: 'kind', label: 'Loại', render: (row) => badge(row.kind === 'plant' ? 'Nhà máy' : 'Hub', 'neutral') },
          { key: 'code', label: 'Mã' },
          { key: 'name', label: 'Tên' },
          { key: 'nearestKm', label: 'Cách mạng lưới', align: 'right', render: (row) => `${num(row.nearestKm, 2)} km` },
          { key: 'nearestRouteCode', label: 'Tuyến gần nhất', render: (row) => row.nearestRouteCode ?? '—' },
          {
            key: 'connected', label: 'Tiếp cận',
            render: (row) => badge(row.connected ? 'Trong tầm' : 'NGOÀI TẦM', row.connected ? 'good' : 'bad'),
          },
        ], analysis.facilityAccess, { empty: 'Chưa có Hub hoặc nhà máy nào.' }),
      ]),

      card('Bản đồ mạng lưới', mapNode),
    );

    if (!LEAFLET_AVAILABLE()) return;
    const map = createMap('gis-network-map', [10.4, 105.9], 8);
    const geo = await api('/gis/routes/export.geojson?mode=waterway').catch(() => null);
    if (geo?.features) {
      window.L.geoJSON(geo, {
        style: { color: '#2C6E9B', weight: 3, opacity: 0.8 },
        onEachFeature: (feature, layer) => layer.bindTooltip(feature.properties?.name ?? ''),
      }).addTo(map);
    }
    for (const finding of analysis.findings) {
      window.L.circleMarker([finding.lat, finding.lng], {
        radius: 7, color: finding.autoFixable ? '#B0791C' : '#C0392B',
        fillColor: finding.autoFixable ? '#B0791C' : '#C0392B', fillOpacity: 0.75, weight: 2,
      }).bindPopup(`<strong>${FINDING_LABEL[finding.kind] ?? finding.kind}</strong><br>${finding.label}`).addTo(map);
    }
    for (const facility of analysis.facilityAccess) {
      window.L.circleMarker([facility.lat, facility.lng], {
        radius: 6, color: facility.connected ? '#2F7D32' : '#C0392B',
        fillColor: '#FFFFFF', fillOpacity: 1, weight: 3,
      }).bindTooltip(`${facility.code} — cách mạng lưới ${num(facility.nearestKm, 2)} km`).addTo(map);
    }
  },
});

// ===========================================================================
// Thông số kỹ thuật & tải trọng lưu thông
// ===========================================================================

registerPage('gis-clearance', {
  title: 'Thông số luồng & tải trọng lưu thông',
  subtitle: 'Khai báo độ rộng, độ sâu và tĩnh không cầu trên tuyến — hệ thống suy ra ghe hoặc sà lan bao nhiêu tấn đi được',
  async render(view, actions) {
    const [overview, meta, structures, routes] = await Promise.all([
      guard(api('/waterway/capacity')), api('/waterway/vessels'),
      api('/waterway/structures'), api('/gis/routes?mode=waterway').catch(() => []),
    ]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };

    if (can('gis.write')) {
      actions.append(el('button', {
        class: 'ghost small', text: '↻ Tính lại toàn bộ tải trọng',
        onclick: async () => {
          const result = await guard(api('/waterway/derive-capacity', { body: {} }));
          toast(`Đã tính lại ${result.length} tuyến.`);
          await refresh();
        },
      }));
    }

    view.replaceChildren(
      card('Kích thước phương tiện và biên an toàn', [
        el('p', { class: 'muted', text: `Kênh phải rộng hơn thân tàu ${meta.margins.widthFactor} lần, sâu hơn mớn nước ${meta.margins.underKeelM} m, và tĩnh không cầu phải cao hơn chiều cao tàu ${meta.margins.airGapM} m. Con số vừa khít trên giấy là không đi được ngoài thực địa.` }),
        table([
          { key: 'label', label: 'Phương tiện' },
          { key: 'tons', label: 'Tải trọng', align: 'right', render: (row) => `${num(row.tons)} tấn` },
          { key: 'beamM', label: 'Rộng thân', align: 'right', render: (row) => `${row.beamM} m` },
          { key: 'draftM', label: 'Mớn nước', align: 'right', render: (row) => `${row.draftM} m` },
          { key: 'airDraftM', label: 'Tĩnh không', align: 'right', render: (row) => `${row.airDraftM} m` },
          {
            key: 'need', label: 'Yêu cầu tối thiểu của tuyến', align: 'right',
            render: (row) => `rộng ${(row.beamM * meta.margins.widthFactor).toFixed(1)} m · sâu ${(row.draftM + meta.margins.underKeelM).toFixed(1)} m · tĩnh không ${(row.airDraftM + meta.margins.airGapM).toFixed(1)} m`,
          },
        ], meta.vessels),
      ]),

      el('div', { class: 'grid cols-4' }, (overview.byVessel ?? []).map((row) =>
        kpi(row.label, `${num(row.routeCount)} tuyến`, `${num(row.lengthKm, 1)} km đi được`))),

      overview.incompleteData
        ? alert(
            `${overview.incompleteData}/${overview.totalRoutes} tuyến chưa đủ số liệu (thiếu độ rộng hoặc độ sâu) ` +
            'nên không kết luận được tải trọng. Hệ thống KHÔNG đoán — tuyến thiếu số liệu bị loại khỏi định tuyến.',
            'warn')
        : null,

      card('Tải trọng lưu thông từng tuyến', table([
        { key: 'code', label: 'Mã tuyến' },
        { key: 'name', label: 'Tên tuyến' },
        { key: 'width_m', label: 'Rộng (m)', align: 'right', render: (row) => (row.width_m ?? badge('Chưa đo', 'warn')) },
        { key: 'depth_m', label: 'Sâu (m)', align: 'right', render: (row) => (row.depth_m ?? badge('Chưa đo', 'warn')) },
        { key: 'clearance_m', label: 'Tĩnh không (m)', align: 'right', render: (row) => (row.clearance_m ?? '—') },
        { key: 'length_m', label: 'Dài (km)', align: 'right', render: (row) => num(row.length_m / 1000, 1) },
        {
          key: 'derived_max_load_tons', label: 'Tải trọng suy ra', align: 'right',
          render: (row) => (row.derived_certainty === 'thieu_du_lieu'
            ? badge('Thiếu số liệu', 'warn')
            : row.derived_max_load_tons
              ? badge(`${num(row.derived_max_load_tons)} tấn`, 'good')
              : badge('Không qua được', 'bad')),
        },
      ], overview.routes ?? [], { empty: 'Chưa có tuyến đường thuỷ nào được xác nhận.' })),

      can('gis.write') && routes.length
        ? card('Thêm công trình vượt sông', [
            el('p', { class: 'muted', text: 'Cầu, cống, âu thuyền là ràng buộc ĐIỂM: cả tuyến rộng và sâu tới đâu cũng vô nghĩa nếu có một cây cầu tĩnh không 4 m chắn ngang. Tĩnh không thấp nhất trên tuyến mới là con số quyết định.' }),
            form([
              {
                name: 'routeId', label: 'Tuyến', type: 'select', required: true,
                options: routes.filter((r) => r.mode === 'waterway').map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` })),
              },
              { name: 'name', label: 'Tên công trình', required: true, placeholder: 'VD: Cầu Chợ Gạo' },
              {
                name: 'kind', label: 'Loại', type: 'select',
                options: meta.structureKinds.map((k) => ({ value: k.code, label: k.label })),
              },
              { name: 'lat', label: 'Vĩ độ', type: 'number', step: 'any', required: true },
              { name: 'lng', label: 'Kinh độ', type: 'number', step: 'any', required: true },
              { name: 'clearanceHeightM', label: 'Tĩnh không (m)', type: 'number', step: '0.1' },
              { name: 'clearanceWidthM', label: 'Khẩu độ khoang thông thuyền (m)', type: 'number', step: '0.1' },
              { name: 'depthM', label: 'Độ sâu tại công trình (m)', type: 'number', step: '0.1' },
              { name: 'surveyDate', label: 'Ngày khảo sát', type: 'date' },
            ], async (values) => {
              await api('/waterway/structures', { body: values });
              toast('Đã thêm công trình — tải trọng của tuyến được tính lại ngay.');
              await refresh();
            }, { submitLabel: '+ Thêm công trình' }),
          ])
        : null,

      card('Công trình trên tuyến', table([
        { key: 'code', label: 'Mã' },
        { key: 'route_code', label: 'Tuyến' },
        { key: 'name', label: 'Tên công trình' },
        { key: 'kind', label: 'Loại', render: (row) => (meta.structureKinds.find((k) => k.code === row.kind)?.label ?? row.kind) },
        {
          key: 'clearance_height_m', label: 'Tĩnh không', align: 'right',
          render: (row) => (row.clearance_height_m ? `${row.clearance_height_m} m` : badge('Chưa đo', 'warn')),
        },
        { key: 'clearance_width_m', label: 'Khẩu độ', align: 'right', render: (row) => (row.clearance_width_m ? `${row.clearance_width_m} m` : '—') },
        { key: 'depth_m', label: 'Sâu tại đây', align: 'right', render: (row) => (row.depth_m ? `${row.depth_m} m` : '—') },
        { key: 'data_source', label: 'Nguồn' },
        {
          key: 'del', label: '',
          render: (row) => (can('gis.write')
            ? el('button', {
                class: 'ghost small', text: '✕',
                onclick: async () => {
                  await guard(api(`/waterway/structures/${row.id}`, { method: 'DELETE' }));
                  toast('Đã xoá — tải trọng tuyến được tính lại.');
                  await refresh();
                },
              })
            : '—'),
        },
      ], structures, { empty: 'Chưa khai báo công trình nào. Tuyến không có cầu thì không bị ràng buộc tĩnh không.' })),
    );
  },
});

// ===========================================================================
// Đường đi tối ưu Hub → Nhà máy
// ===========================================================================

registerPage('gis-routing', {
  title: 'Cự ly tối ưu Hub → Nhà máy',
  subtitle: 'Đường ngắn nhất trong số những tuyến phương tiện ĐI ĐƯỢC — không phải đường ngắn nhất trên giấy',
  async render(view) {
    const [hubs, facilities, meta] = await Promise.all([
      guard(api('/sim/hubs')), api('/mdm/facilities?kind=plant'), api('/waterway/vessels'),
    ]);
    const result = el('div', { class: 'grid' });
    const mapNode = mapContainer('gis-routing-map', 'tall');
    let map = null;
    let layers = [];

    const compute = async (hubId, plantId) => {
      const hub = hubs.find((h) => h.id === hubId);
      const plant = facilities.find((f) => f.id === plantId);
      if (!hub || !plant) return;

      const payload = { fromLat: hub.lat, fromLng: hub.lng, toLat: plant.lat, toLng: plant.lng };
      const [water, road] = await Promise.all([
        guard(api('/waterway/optimal-route', { body: { ...payload, mode: 'waterway' } })),
        guard(api('/waterway/optimal-route', { body: { ...payload, mode: 'road' } })),
      ]);

      result.replaceChildren(
        card(`${hub.code} ${hub.name} → ${plant.name}`, [
          el('div', { class: 'grid cols-4' }, [
            kpi('Đường thuỷ tối ưu',
              water.optimal.found ? `${num(water.optimal.distanceKm, 2)} km` : 'Không đi được',
              water.optimal.found ? water.optimal.sourceLabel : 'Không tiếp giáp mạng lưới',
              water.optimal.found ? 'good' : 'critical'),
            kpi('Đường bộ', `${num(road.optimal.distanceKm, 2)} km`, road.optimal.sourceLabel),
            kpi('Chênh lệch',
              water.optimal.found
                ? `${num(water.optimal.distanceKm - road.optimal.distanceKm, 2)} km`
                : '—',
              'Đường thuỷ so với đường bộ'),
            kpi('Tuyến đi qua', num(water.optimal.routeCodes.length),
              water.optimal.routeCodes.join(' → ') || '—'),
          ]),
          water.optimal.reason ? alert(water.optimal.reason, 'warn') : null,

          el('h4', { text: 'So sánh theo lớp phương tiện' }),
          el('p', { class: 'muted', text: 'Con kênh ngắn nhất có thể chỉ vừa ghe 100 tấn, còn sà lan phải đi vòng theo sông lớn. Đây chính là đánh đổi cần thấy khi chọn phương thức vận chuyển.' }),
          table([
            { key: 'vesselLabel', label: 'Phương tiện' },
            { key: 'tons', label: 'Tải trọng', align: 'right', render: (row) => `${num(row.tons)} tấn` },
            {
              key: 'distanceKm', label: 'Cự ly tối ưu', align: 'right',
              render: (row) => (row.found ? `${num(row.distanceKm, 2)} km` : badge('Không đi được', 'bad')),
            },
            { key: 'routeCodes', label: 'Tuyến đi qua', render: (row) => (row.routeCodes.join(' → ') || '—') },
            { key: 'reason', label: 'Ghi chú', render: (row) => (row.reason ? row.reason.slice(0, 90) : '—') },
          ], water.byVessel ?? []),
        ]),
      );

      // Vẽ đường đi lên bản đồ.
      if (LEAFLET_AVAILABLE() && map) {
        layers.forEach((layer) => map.removeLayer(layer));
        layers = [];
        layers.push(window.L.circleMarker([hub.lat, hub.lng], {
          radius: 8, color: '#B0791C', fillColor: '#B0791C', fillOpacity: 0.8, weight: 2,
        }).bindTooltip(hub.name).addTo(map));
        layers.push(window.L.marker([plant.lat, plant.lng]).bindTooltip(plant.name).addTo(map));
        if (water.optimal.path?.length >= 2) {
          const line = window.L.polyline(water.optimal.path.map((p) => [p.lat, p.lng]), {
            color: '#2C6E9B', weight: 4, opacity: 0.85,
          }).bindTooltip(`Đường thuỷ tối ưu ${num(water.optimal.distanceKm, 2)} km`).addTo(map);
          layers.push(line);
          map.fitBounds(line.getBounds(), { padding: [30, 30] });
        }
      }
    };

    const hubSelect = el('select', {}, hubs.map((h) => el('option', { value: h.id }, [`${h.code} — ${h.name}`])));
    const plantSelect = el('select', {}, facilities.map((f) => el('option', { value: f.id }, [f.name])));

    view.replaceChildren(
      card('Chọn chặng cần tính', [
        el('div', { class: 'row' }, [
          el('label', {}, ['Hub', hubSelect]),
          el('label', {}, ['Nhà máy', plantSelect]),
          el('button', {
            class: 'small', text: '🧭 Tính cự ly tối ưu',
            onclick: () => compute(hubSelect.value, plantSelect.value),
          }),
        ]),
        el('p', { class: 'muted', text: `Bán kính tiếp cận mạng lưới: ${meta.snapToleranceM} m để nối đỉnh, 8 km để coi một cơ sở là tiếp giáp mạng lưới đường thuỷ.` }),
      ]),
      result,
      card('Bản đồ đường đi', mapNode),
    );

    if (LEAFLET_AVAILABLE()) {
      map = createMap('gis-routing-map', [10.4, 105.9], 8);
      const geo = await api('/gis/routes/export.geojson?mode=waterway').catch(() => null);
      if (geo?.features) {
        window.L.geoJSON(geo, { style: { color: '#9BB7C9', weight: 2, opacity: 0.6 } }).addTo(map);
      }
    }
    if (hubs.length && facilities.length) await compute(hubs[0].id, facilities[0].id);
  },
});
