import {
  api, registerPage, el, card, kpi, table, badge, alert, vnd, num, tons, pct, dateTime,
  mapContainer, createMap, LEAFLET_AVAILABLE, toast, guard, can, rawJson,
} from '/app.js';
import { facilityLocationEditor } from '/pages/facility-location.js';

const MODE_LABEL = { road: 'Đường bộ', waterway: 'Đường thuỷ' };
const DECIDED_BY = {
  mac_dinh: 'mặc định', goi_y_he_thong: 'hệ thống gợi ý', nguoi_dung_ghi_de: 'người dùng ghi đè',
};
const PAYBACK_LABEL = {
  hoan_von: null,
  khong_hoan_von: 'Không hoàn vốn',
  khong_hoan_von_trong_ky: 'Không hoàn vốn trong vòng đời',
  thieu_baseline: 'Thiếu baseline',
};

// ===========================================================================
// FN-02 / FN-03 / FN-13 — Hub Planner & Dashboard kịch bản
// ===========================================================================

registerPage('planner', {
  title: 'Hub Planner — Hub ứng viên & Kịch bản đầu tư',
  subtitle: 'Chọn vị trí trên bản đồ → gán vào kịch bản (1..n Hub) → mô phỏng toàn chuỗi chi phí Ruộng → Hub → Nhà máy',
  async render(view, actions) {
    const writable = can('simulation.write');
    let hubs = await guard(api('/sim/hubs'));
    let scenarios = await guard(api('/sim/scenarios'));
    let currentScenarioId = scenarios[0]?.id ?? null;
    let pendingPoint = null;

    const mapNode = mapContainer('planner-map', 'tall');
    const sidePanel = el('div', { class: 'grid' });
    // Bảng cấu hình Hub có 7 cột nên đặt ở dải toàn chiều rộng dưới bản đồ,
    // không nhét vào cột rail 340px bên trái.
    const hubConfigPanel = el('div', { class: 'grid' });
    const resultPanel = el('div', { class: 'grid' });
    const plantEditorSlot = el('div');

    if (can('mdm.write')) {
      actions.append(el('button', {
        class: 'ghost small', text: '📍 Sửa vị trí nhà máy đầu ra',
        onclick: async () => {
          const plants = await guard(api('/mdm/facilities?kind=plant'));
          const scenario = scenarios.find((s) => s.id === currentScenarioId);
          const plant = plants.find((p) => p.id === scenario?.plant_id) ?? plants[0];
          if (!plant) return toast('Chưa có nhà máy đầu ra trong danh mục.', true);
          plantEditorSlot.replaceChildren(facilityLocationEditor(plant, {
            onSaved: () => { toast('Chạy lại mô phỏng để cập nhật khoảng cách Hub→Nhà máy.'); },
            onClose: () => refreshAll(),
          }));
          plantEditorSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      }));
    }

    view.replaceChildren(
      plantEditorSlot,
      el('div', { class: 'split' }, [sidePanel, card('Bản đồ chọn Hub (FN-02)', [
        el('p', { class: 'muted', text: 'Nhấp lên bản đồ để đặt một Hub ứng viên mới. Vòng tròn thể hiện bán kính phục vụ của Hub trong kịch bản đang chọn.' }),
        mapNode,
      ])]),
      hubConfigPanel,
      resultPanel,
    );

    let map = null;
    let layers = [];

    // ---------- Bảng điều khiển bên trái ----------
    async function renderSide() {
      const scenario = scenarios.find((s) => s.id === currentScenarioId) ?? null;
      const scenarioHubs = scenario ? await api(`/sim/scenarios/${scenario.id}`).then((r) => r.hubs) : [];

      hubConfigPanel.replaceChildren(
        card('Hub trong kịch bản (FN-02 BR-03)', [
        el('p', { class: 'muted', text: 'Bán kính phục vụ / sức chứa / tải trọng sà lan / phương thức vận chuyển lưu ở cấp cặp Hub–Kịch bản, nên cùng một Hub có thể cho kết quả khác nhau ở hai kịch bản.' }),
        el('p', { class: 'muted', text: 'Sức chứa Hub là LƯỢNG TỒN KHO RƠM TỐI ĐA (tấn) mà Hub có thể chứa tại một thời điểm, không phải sản lượng thông qua cả năm. Rơm vượt sức chứa sẽ phải bỏ lại tại ruộng.' }),
        table(
          [
            { key: 'name', label: 'Hub' },
            {
              key: 'service_radius_km', label: 'Bán kính (km)', align: 'right',
              render: (row) => el('input', {
                type: 'number', value: row.service_radius_km, style: 'width:80px', disabled: !writable,
                onchange: (event) => updateHubConfig(row.hub_id, { serviceRadiusKm: Number(event.target.value) }),
              }),
            },
            {
              key: 'design_capacity_tons', label: 'Sức chứa tồn kho (tấn)', align: 'right',
              render: (row) => el('input', {
                type: 'number', value: row.design_capacity_tons, style: 'width:110px', disabled: !writable,
                onchange: (event) => updateHubConfig(row.hub_id, { designCapacityTons: Number(event.target.value) }),
              }),
            },
            {
              key: 'barge_payload_tons', label: 'Sà lan Hub→NM',
              render: (row) => el('select', {
                disabled: !writable, style: 'width:110px',
                onchange: (event) => updateHubConfig(row.hub_id, { bargePayloadTons: Number(event.target.value) }),
              }, [
                el('option', { value: '1000', selected: Number(row.barge_payload_tons) !== 2000 }, ['1.000 tấn']),
                el('option', { value: '2000', selected: Number(row.barge_payload_tons) === 2000 }, ['2.000 tấn']),
              ]),
            },
            {
              key: 'mode_hub_plant', label: 'PT Hub→NM',
              render: (row) => el('select', {
                disabled: !writable, style: 'width:120px',
                onchange: (event) => updateHubConfig(row.hub_id, { modeHubPlant: event.target.value }),
              }, [
                el('option', { value: 'auto', selected: row.mode_hub_plant === 'auto' }, ['Tự động']),
                el('option', { value: 'road', selected: row.mode_hub_plant === 'road' }, ['Đường bộ']),
                el('option', { value: 'waterway', selected: row.mode_hub_plant === 'waterway' }, ['Đường thuỷ']),
              ]),
            },
            {
              key: 'land_mode', label: 'Mặt bằng',
              render: (row) => el('select', {
                disabled: !writable, style: 'width:90px',
                onchange: (event) => updateHubConfig(row.hub_id, { landMode: event.target.value }),
              }, [
                el('option', { value: 'mua', selected: row.land_mode === 'mua' }, ['Mua/Xây']),
                el('option', { value: 'thue', selected: row.land_mode === 'thue' }, ['Thuê']),
              ]),
            },
            {
              key: 'remove', label: '',
              render: (row) => (writable ? el('button', {
                class: 'ghost small', text: '✕',
                onclick: async () => {
                  await guard(api(`/sim/scenarios/${currentScenarioId}/hubs/${row.hub_id}`, { method: 'DELETE' }));
                  await refreshAll();
                },
              }) : '—'),
            },
          ],
          scenarioHubs,
          { empty: 'Kịch bản chưa có Hub — chọn từ danh sách bên dưới.' },
        ),
        ]),
      );

      sidePanel.replaceChildren(
        card('Kịch bản đầu tư', [
          el('select', {
            onchange: async (event) => { currentScenarioId = event.target.value; await refreshAll(); },
          }, scenarios.map((s) => el('option', { value: s.id, selected: s.id === currentScenarioId },
            [`${s.code} — ${s.name} (${s.hubCount} Hub)`]))),
          scenario
            ? el('div', { style: 'margin-top:10px' }, [
                el('div', { class: 'chip-row' }, [
                  badge(scenario.status === 'chinh_thuc' ? 'Chính thức' : 'Tham khảo', scenario.status === 'chinh_thuc' ? 'good' : 'neutral'),
                  badge(`Vòng đời ${scenario.lifecycle_years} năm`, 'info'),
                  badge(scenario.discounted ? 'Có chiết khấu' : 'Không chiết khấu', 'neutral'),
                  scenario.parameter_set_version ? badge(`Bộ tham số v${scenario.parameter_set_version}`, 'neutral') : null,
                ]),
                el('div', { class: 'chip-row', style: 'margin-top:10px' }, [
                  el('button', {
                    class: 'small', text: '▶ Chạy mô phỏng', disabled: !writable,
                    onclick: () => runSimulation(scenario.id),
                  }),
                  el('button', {
                    class: 'ghost small', text: '↻ Tính lại theo bộ tham số hiện tại', disabled: !writable,
                    onclick: async () => {
                      await guard(api(`/sim/scenarios/${scenario.id}`, {
                        method: 'PUT', body: { parameter_set_version: null },
                      }));
                      await runSimulation(scenario.id, true);
                    },
                  }),
                  el('button', {
                    class: 'ghost small', text: '✓ Đánh dấu Chính thức', disabled: !can('simulation.mark_official'),
                    onclick: async () => {
                      await guard(api(`/sim/scenarios/${scenario.id}/official`, { body: {} }));
                      toast('Kịch bản đã được đánh dấu "Chính thức".');
                      scenarios = await api('/sim/scenarios');
                      await refreshAll();
                    },
                  }),
                  el('button', {
                    class: 'ghost small', text: '⤓ Báo cáo (PDF/in)',
                    onclick: () => window.open(`/api/sim/scenarios/${scenario.id}/report.html`, '_blank'),
                  }),
                  el('button', {
                    class: 'ghost small', text: '⤓ Excel/CSV',
                    onclick: () => window.open(`/api/sim/scenarios/${scenario.id}/report.csv`, '_blank'),
                  }),
                ]),
              ])
            : alert('Chưa có kịch bản nào — tạo kịch bản đầu tiên bên dưới.', 'info'),
        ], writable ? el('button', {
          class: 'small', text: '+ Kịch bản',
          onclick: async () => {
            const name = prompt('Tên kịch bản đầu tư (ví dụ: Phương án 3 Hub):');
            if (!name) return;
            const created = await guard(api('/sim/scenarios', { body: { name } }));
            scenarios = await api('/sim/scenarios');
            currentScenarioId = created.id;
            await refreshAll();
          },
        }) : null),

        card('Danh sách Hub ứng viên đã lưu (FN-03)', el('div', { class: 'list scroll-y' }, hubs.map((hub) =>
          el('div', {
            class: 'list-item',
            onclick: () => currentScenarioId && attachHub(hub.id),
          }, [
            el('div', { class: 'title' }, [`${hub.code} — ${hub.name}`]),
            el('div', { class: 'muted', text: `${hub.lat.toFixed(4)}, ${hub.lng.toFixed(4)} · ${hub.status === 'da_mo_phong' ? 'Đã mô phỏng' : 'Nháp — chưa mô phỏng'}` }),
            hub.scenarios.length ? el('div', { class: 'muted', text: `Đang dùng ở: ${hub.scenarios.join(', ')}` }) : null,
          ]))), hubs.length ? null : undefined),
      );
    }

    async function updateHubConfig(hubId, patch) {
      await guard(api(`/sim/scenarios/${currentScenarioId}/hubs`, { body: { hubId, ...patch } }));
      toast('Đã cập nhật cấu hình Hub trong kịch bản. Chạy lại mô phỏng để cập nhật kết quả.');
      await renderSide();
      await drawMap();
    }

    async function attachHub(hubId) {
      await guard(api(`/sim/scenarios/${currentScenarioId}/hubs`, { body: { hubId } }));
      scenarios = await api('/sim/scenarios');
      await refreshAll();
    }

    async function runSimulation(scenarioId, refreshDistances = false) {
      toast('Đang mô phỏng…');
      const result = await guard(api(`/sim/scenarios/${scenarioId}/run`, { body: { refreshDistances } }));
      scenarios = await api('/sim/scenarios');
      hubs = await api('/sim/hubs');
      toast(`Mô phỏng xong: Cost/Ton ${vnd(result.costs.costPerTon)} · TCO/Ton ${vnd(result.financial.tcoPerTon)}.`);
      await refreshAll();
    }

    // ---------- Bản đồ ----------
    async function drawMap() {
      if (!LEAFLET_AVAILABLE()) return;
      if (!map) {
        map = createMap('planner-map', [10.4, 105.9], 8);
        map.on('click', async (event) => {
          if (!writable) return;
          pendingPoint = { lat: Number(event.latlng.lat.toFixed(6)), lng: Number(event.latlng.lng.toFixed(6)) };
          const name = prompt(`Tên Hub ứng viên tại (${pendingPoint.lat}, ${pendingPoint.lng}):`);
          if (!name) return;
          try {
            const created = await api('/sim/hubs', { body: { name, ...pendingPoint } });
            toast(`Đã tạo ${created.code} — ${created.name}.`);
            hubs = await api('/sim/hubs');
            if (currentScenarioId) await attachHub(created.id);
            else await refreshAll();
          } catch (error) {
            toast(error.message, true);
          }
        });
      }
      layers.forEach((layer) => map.removeLayer(layer));
      layers = [];
      const L = window.L;

      const bundle = await api('/gis/map?layers=cooperatives,facilities&zoom=8');
      for (const htx of bundle.layers.cooperatives ?? []) {
        layers.push(L.circleMarker([htx.lat, htx.lng], {
          radius: 4, color: '#7C8B82', fillColor: '#7C8B82', fillOpacity: 0.7, weight: 1,
        }).bindTooltip(`${htx.code} — ${htx.name}`).addTo(map));
      }
      for (const plant of (bundle.layers.facilities ?? []).filter((f) => f.kind === 'plant')) {
        layers.push(L.marker([plant.lat, plant.lng]).bindTooltip(`🏭 ${plant.name}`).addTo(map));
      }

      const detail = currentScenarioId ? await api(`/sim/scenarios/${currentScenarioId}`) : null;
      const configured = new Map((detail?.hubs ?? []).map((row) => [row.hub_id, row]));
      const result = detail?.result ?? null;

      for (const hub of hubs) {
        const inScenario = configured.get(hub.id);
        layers.push(L.circleMarker([hub.lat, hub.lng], {
          radius: inScenario ? 9 : 6,
          color: inScenario ? '#9C6414' : '#7C8B82',
          fillColor: inScenario ? '#9C6414' : '#FFFFFF',
          fillOpacity: 0.85, weight: 2,
        }).bindTooltip(`${hub.code} — ${hub.name}`).addTo(map));
        if (inScenario) {
          layers.push(L.circle([hub.lat, hub.lng], {
            radius: inScenario.service_radius_km * 1000,
            color: '#9C6414', weight: 1, fillOpacity: 0.06, dashArray: '5 4',
          }).addTo(map));
        }
      }

      // Vẽ chặng Hub → Nhà máy theo phương thức đã chọn.
      for (const hub of result?.hubs ?? []) {
        const leg = hub.legs.find((l) => l.leg === 'hub_plant');
        if (!leg) continue;
        layers.push(L.polyline([[hub.lat, hub.lng], [result.plant.lat, result.plant.lng]], {
          color: leg.mode === 'waterway' ? '#6E9BBE' : '#C85A22',
          weight: 3, opacity: 0.75, dashArray: leg.mode === 'waterway' ? '8 5' : null,
        }).bindTooltip(`${hub.name} → ${result.plant.name}: ${MODE_LABEL[leg.mode]}, ${num(leg.weightedAvgDistanceKm, 1)} km, ${vnd(leg.cost, { compact: true })}`).addTo(map));
        for (const htx of hub.cooperatives) {
          layers.push(L.polyline([[htx.lat, htx.lng], [hub.lat, hub.lng]], {
            color: '#1C8C74', weight: 1, opacity: 0.4,
          }).addTo(map));
        }
      }
    }

    // ---------- FN-13 Dashboard kết quả ----------
    async function renderResult() {
      if (!currentScenarioId) {
        resultPanel.replaceChildren();
        return;
      }
      const detail = await api(`/sim/scenarios/${currentScenarioId}`);
      const result = detail.result;
      if (!result) {
        resultPanel.replaceChildren(alert('Kịch bản chưa được mô phỏng. Nhấn "▶ Chạy mô phỏng" để tính toàn bộ chuỗi chi phí.', 'info'));
        return;
      }
      resultPanel.replaceChildren(scenarioDashboard(result));
    }

    async function refreshAll() {
      await renderSide();
      await drawMap();
      await renderResult();
    }

    await refreshAll();
  },
});

/**
 * Kế hoạch vận chuyển hai phương thức + mô phỏng luồng rơm theo ngày.
 *
 * Trong mùa thu hoạch: ghe chở thẳng ruộng → nhà máy tới hạn tiêu thụ ngày,
 * phần vượt về Hub để băm/nén và lưu trữ.
 * Ngoài mùa thu hoạch: sà lan 1.000/2.000 tấn chở đầy tải từ Hub về nhà máy.
 */
function strawFlowCard(result) {
  const flow = result.flow;
  if (!flow) return null;

  const total = Math.max(flow.directFieldPlantTons + flow.fieldHubTons + flow.uncollectedTons, 1);
  const split = (value) => pct((value / total) * 100);

  return card('② Kế hoạch vận chuyển & dòng chảy rơm (mô phỏng theo ngày)', [
    el('div', { class: 'chip-row' }, [
      badge(`${flow.harvestDays} ngày có thu hoạch`, 'good'),
      badge(`${flow.noHarvestDays} ngày KHÔNG có rơm tại ruộng`, 'warn'),
      badge(`Nhà máy tiêu thụ ${tons(flow.plantDailyDemandTons)}/ngày × ${flow.plantOperatingDays} ngày`, 'info'),
      ...flow.calendarSources.map((source) =>
        badge(`${source.seasonName}: ${source.source === 'thuc_te' ? 'ngày thu hoạch thực tế' : 'lịch suy diễn'}`,
          source.source === 'thuc_te' ? 'good' : 'neutral')),
    ]),

    el('div', { class: 'grid cols-4', style: 'margin-top:10px' }, [
      kpi('Ruộng → Nhà máy (ghe, chở thẳng)', tons(flow.directFieldPlantTons),
        `${split(flow.directFieldPlantTons)} sản lượng · ${num(flow.boatTripsDirect)} chuyến ghe`, 'good'),
      kpi('Ruộng → Hub (ghe, phần vượt)', tons(flow.fieldHubTons),
        `${split(flow.fieldHubTons)} sản lượng · ${num(flow.boatTripsToHub)} chuyến ghe`),
      kpi('Hub → Nhà máy (sà lan, ngoài vụ)', tons(flow.hubPlantTons),
        `${flow.bargeTripsFull} chuyến đầy tải + ${flow.bargeTripsPartial} chuyến non tải (dọn kho)`),
      kpi('Rơm phải bỏ lại tại ruộng', tons(flow.uncollectedTons),
        'Hub đã đầy hoặc nằm ngoài mọi bán kính phục vụ',
        flow.uncollectedTons > 0 ? 'critical' : 'good'),
      kpi('Tồn kho cao điểm toàn mạng', tons(flow.networkPeakInventoryTons),
        'Cơ sở tính diện tích kho và CAPEX — thay hệ số ước lượng cũ'),
      kpi('Nhà máy thiếu nguyên liệu', tons(flow.plantUnmetTons),
        `${flow.plantUnmetDays} ngày trong năm`,
        flow.plantUnmetDays > 0 ? 'critical' : 'good'),
      kpi('Mức đáp ứng thực tế', pct(flow.coveragePct),
        'Tính trên luồng rơm theo ngày, không phải tổng cả năm',
        flow.coveragePct >= 100 ? 'good' : 'warning'),
      kpi('Tồn kho đỉnh tại nhà máy', tons(flow.plantPeakStockTons),
        'Sức chứa tối thiểu của bãi tiếp nhận tại nhà máy'),
    ]),

    el('h4', { text: 'Các đợt thu hoạch trong năm' }),
    table(
      [
        { key: 'window', label: 'Đợt', render: (row) => `${row.fromLabel} → ${row.toLabel}` },
        { key: 'days', label: 'Số ngày', align: 'right', render: (row) => num(row.days) },
        { key: 'tons', label: 'Sản lượng rơm thu gom', align: 'right', render: (row) => tons(row.tons) },
      ],
      flow.harvestWindows,
    ),

    el('h4', { text: 'Dòng chảy rơm theo tháng (tấn)' }),
    table(
      [
        { key: 'label', label: 'Tháng' },
        { key: 'harvestTons', label: 'Thu hoạch tại ruộng', align: 'right', render: (row) => tons(row.harvestTons) },
        { key: 'directToPlantTons', label: 'Ghe chở thẳng về NM', align: 'right', render: (row) => tons(row.directToPlantTons) },
        { key: 'toHubTons', label: 'Ghe đưa về Hub', align: 'right', render: (row) => tons(row.toHubTons) },
        { key: 'hubToPlantTons', label: 'Sà lan Hub → NM', align: 'right', render: (row) => tons(row.hubToPlantTons) },
        { key: 'plantConsumedTons', label: 'NM tiêu thụ', align: 'right', render: (row) => tons(row.plantConsumedTons) },
        {
          key: 'plantUnmetTons', label: 'NM thiếu', align: 'right',
          render: (row) => row.plantUnmetTons > 0 ? badge(tons(row.plantUnmetTons), 'bad') : '—',
        },
        { key: 'hubInventoryEndTons', label: 'Tồn kho Hub cuối tháng', align: 'right', render: (row) => tons(row.hubInventoryEndTons) },
      ],
      flow.months,
    ),

    el('details', { class: 'raw' }, [
      el('summary', { class: 'muted', text: 'Giả định của mô hình dòng chảy' }),
      el('ul', {}, flow.notes.map((note) => el('li', { class: 'muted', text: note }))),
    ]),
  ]);
}

/** Đường cong tồn kho 365 ngày, vẽ bằng SVG thuần — không cần thư viện biểu đồ. */
function inventorySparkline(hubFlow) {
  const curve = hubFlow.inventoryCurve ?? [];
  if (!curve.length) return null;
  const width = 720;
  const height = 120;
  const max = Math.max(hubFlow.maxInventoryTons || 0, ...curve, 1);
  const points = curve
    .map((value, index) => `${((index / (curve.length - 1)) * width).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`)
    .join(' ');
  const capacityY = height - ((hubFlow.maxInventoryTons || 0) / max) * height;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'sparkline');
  svg.innerHTML =
    `<polyline points="${points}" fill="none" stroke="#1C8C74" stroke-width="2" />` +
    `<line x1="0" y1="${capacityY.toFixed(1)}" x2="${width}" y2="${capacityY.toFixed(1)}" ` +
    `stroke="#C85A22" stroke-width="1" stroke-dasharray="6 4" />`;

  const months = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
  return el('div', { class: 'sparkline-wrap' }, [
    svg,
    el('div', { class: 'sparkline-axis' }, months.map((label) => el('span', { class: 'muted', text: label }))),
    el('p', {
      class: 'muted',
      text:
        `Đường xanh: tồn kho theo ngày. Đường cam đứt nét: sức chứa tối đa ${tons(hubFlow.maxInventoryTons)}. ` +
        `Đỉnh ${tons(hubFlow.peakInventoryTons)} vào ngày ${hubFlow.peakInventoryDayLabel}; ` +
        `bình quân ${tons(hubFlow.averageInventoryTons)}; đầy kho ${hubFlow.daysAtCapacity} ngày.`,
    }),
  ]);
}

/** FN-13 BR-01 — dashboard đủ 4 nhóm KPI với các trường cụ thể. */
export function scenarioDashboard(result) {
  const financial = result.financial;
  const provenance = el('div', { class: 'chip-row' }, [
    badge(result.status === 'chinh_thuc' ? 'Chính thức' : 'Tham khảo', result.status === 'chinh_thuc' ? 'good' : 'neutral'),
    badge(`Bộ tham số v${result.parameterSetVersion}`, 'info'),
    badge(financial.discounted ? `Chiết khấu ${pct(financial.discountRatePct)}` : 'Không chiết khấu', 'neutral'),
    badge(`Baseline: ${financial.baselineSourceLabel}`, 'neutral'),
    badge(`Tính lúc ${dateTime(result.computedAt)}`, 'neutral'),
  ]);

  const warnings = el('div', {}, [
    ...(result.unapprovedParameters.length
      ? [alert(`Còn ${result.unapprovedParameters.length} tham số giả định chưa phê duyệt — kịch bản chỉ ở trạng thái "Tham khảo" (FN-01 BR-04): ${result.unapprovedParameters.map((p) => `#${p.number} ${p.name}`).join('; ')}`, 'warn')]
      : []),
    ...result.warnings.map((warning) => alert(warning, warning.includes('không đáp ứng nhu cầu nhà máy') ? 'bad' : 'warn')),
  ]);

  // (a) Nguồn cung
  const supply = card('① Nguồn cung theo mùa vụ (FN-06)', [
    el('div', { class: 'grid cols-4' }, [
      kpi('Total Available Supply', tons(result.totalAvailableTons), 'Sản lượng lúa × hệ số rơm/lúa'),
      kpi('Collectable Supply', tons(result.collectableTons), '× hệ số thu gom khả thi'),
      kpi('Delivered Supply', tons(result.deliveredTons), '× (1 − hệ số hao hụt) — mẫu số Cost/Ton'),
      kpi('Đáp ứng nhu cầu nhà máy', pct(result.plantDemandCoveragePct),
        `Nhu cầu ${tons(result.plant.annualDemandTons)}/năm`,
        result.plantDemandCoveragePct >= 100 ? 'good' : 'warning'),
    ]),
    table(
      [
        { key: 'seasonName', label: 'Mùa vụ' },
        { key: 'paddyTons', label: 'Lúa thống kê', align: 'right', render: (row) => tons(row.paddyTons) },
        { key: 'totalAvailableTons', label: 'Total Available', align: 'right', render: (row) => tons(row.totalAvailableTons) },
        { key: 'collectableTons', label: 'Collectable', align: 'right', render: (row) => tons(row.collectableTons) },
        { key: 'deliveredTons', label: 'Delivered', align: 'right', render: (row) => tons(row.deliveredTons) },
      ],
      result.seasons,
    ),
  ]);

  // (a2) Kế hoạch vận chuyển & dòng chảy rơm theo ngày
  const flowCard = strawFlowCard(result);

  // (d) Tài chính
  const finance = card('③ Chỉ số tài chính & đầu tư (FN-10 → FN-12)', [
    el('div', { class: 'grid cols-4' }, [
      kpi('CAPEX', vnd(result.capex.total, { compact: true }),
        `Xây dựng ${vnd(result.capex.construction, { compact: true })} · Thiết bị ${vnd(result.capex.equipment, { compact: true })} · Khác ${vnd(result.capex.other, { compact: true })}`),
      kpi('OPEX năm 1', vnd(result.opex.total, { compact: true }),
        `Handling ${vnd(result.opex.handlingCostAnnual, { compact: true })} · Warehouse ${vnd(result.opex.warehouseCostAnnual, { compact: true })}`),
      kpi('Cost per Ton', vnd(result.costs.costPerTon), result.costs.costPerTonNote),
      kpi('TCO per Ton ★', vnd(financial.tcoPerTon), `Chỉ số xếp hạng kịch bản · TCO ${vnd(financial.tco, { compact: true })}`),
      kpi('Chi phí vòng đời đầy đủ chuỗi / tấn', vnd(financial.lifecycleCostPerTon),
        'CAPEX + Σ Total Delivered Logistics Cost — cột duy nhất so sánh được với No-Hub'),
      kpi('Baseline Cost/Ton', vnd(financial.baselineCostPerTon), financial.baselineSourceLabel),
      kpi('ROI', financial.roiPct === null ? 'Thiếu baseline' : pct(financial.roiPct),
        `Vòng đời ${financial.lifecycleYears} năm · ramp-up năm 1 ${pct(financial.rampUpPct)}`,
        (financial.roiPct ?? 0) >= 0 ? 'good' : 'critical'),
      kpi('Payback Period', PAYBACK_LABEL[financial.paybackStatus] ?? `${financial.paybackYears} năm`,
        `Escalation OPEX ${pct(financial.opexEscalationPct)}/năm`,
        financial.paybackStatus === 'hoan_von' ? 'good' : 'warning'),
    ]),
    el('h4', { text: 'Chuỗi 4 cấu phần chi phí logistics (FN-11 BR-01)' }),
    table(
      [
        { key: 'label', label: 'Cấu phần' },
        { key: 'value', label: 'Chi phí năm 1', align: 'right', render: (row) => vnd(row.value) },
        { key: 'share', label: 'Tỷ trọng', align: 'right', render: (row) => pct(row.share) },
        { key: 'perTon', label: 'đ/tấn', align: 'right', render: (row) => vnd(row.perTon) },
      ],
      costChainRows(result.costs, result.deliveredTons),
    ),
    el('h4', { text: 'Dòng tiền theo năm' }),
    table(
      [
        { key: 'year', label: 'Năm', align: 'right' },
        { key: 'deliveredTons', label: 'Delivered', align: 'right', render: (row) => tons(row.deliveredTons) },
        { key: 'opex', label: 'OPEX', align: 'right', render: (row) => vnd(row.opex, { compact: true }) },
        { key: 'savings', label: 'Tiết kiệm so với baseline', align: 'right', render: (row) => vnd(row.savings, { compact: true }) },
        { key: 'cumulativeSavings', label: 'Luỹ kế', align: 'right', render: (row) => vnd(row.cumulativeSavings, { compact: true }) },
      ],
      financial.yearlyCashflow,
    ),
  ]);

  // (b) + (c) theo từng Hub
  const hubCards = result.hubs.map((hub) => card(`Hub: ${hub.name}`, [
    el('div', { class: 'chip-row' }, [
      badge(`${hub.cooperativeCount} HTX`, 'info'),
      badge(`Bán kính ${hub.serviceRadiusKm} km`, 'neutral'),
      badge(hub.landMode === 'thue' ? 'Thuê mặt bằng' : 'Mua/Xây', 'neutral'),
      badge(`Khoảng cách tới nhà máy ${num(hub.distanceToPlantKm, 1)} km — ${hub.distanceToPlantSourceLabel}`,
        hub.distanceToPlantSourceLabel.includes('Haversine') ? 'warn' : 'good'),
      hub.capacityWarning
        ? badge(hub.capacityWarning.shortfallPct < 0 ? 'Kho quá tải' : 'Sức chứa dư', hub.capacityWarning.shortfallPct < 0 ? 'bad' : 'warn')
        : badge('Sức chứa vừa đủ', 'good'),
      hub.flow ? badge(`Tồn kho đỉnh ${tons(hub.flow.peakInventoryTons)} / ${tons(hub.flow.maxInventoryTons)}`, 'info') : null,
      hub.flow ? badge(`Sà lan ${num(hub.flow.bargePayloadTons)} tấn · ${hub.flow.fullBargeTrips} chuyến đầy + ${hub.flow.partialBargeTrips} non tải`, 'neutral') : null,
    ]),
    el('div', { class: 'grid cols-4', style: 'margin-top:10px' }, [
      kpi('Delivered Supply', tons(hub.deliveredTons)),
      kpi('Cost per Ton', vnd(hub.costs.costPerTon)),
      kpi('CAPEX', vnd(hub.capex.total, { compact: true })),
      kpi('Lead time', `${num(hub.leadTimeHours, 1)} giờ`, 'Ruộng→Hub + Hub→Nhà máy'),
    ]),
    el('h4', { text: '④ Kho bãi & thiết bị (FN-09 — ước tính)' }),
    table(
      [
        { key: 'k', label: 'Chỉ tiêu' },
        { key: 'v', label: 'Giá trị', align: 'right' },
      ],
      [
        { k: 'Peak Inventory', v: tons(hub.sizing.peakInventoryTons) },
        { k: 'Warehouse Capacity', v: tons(hub.sizing.warehouseCapacityTons) },
        { k: 'Warehouse Area', v: `${num(hub.sizing.warehouseAreaM2)} m²` },
        { k: 'Yard Area', v: `${num(hub.sizing.yardAreaM2)} m²` },
        { k: 'Number of Bale Press', v: num(hub.sizing.balePressCount) },
        { k: 'Number of Forklifts', v: num(hub.sizing.forkliftCount) },
      ],
    ),
    el('p', { class: 'muted', text: hub.sizing.estimateNotice }),
    hub.flow ? el('h4', { text: 'Đường cong tồn kho trong năm (mô phỏng theo ngày)' }) : null,
    hub.flow ? inventorySparkline(hub.flow) : null,
    el('h4', { text: '④ Vận chuyển theo chặng (FN-08)' }),
    table(
      [
        { key: 'label', label: 'Chặng' },
        { key: 'mode', label: 'Phương thức', render: (row) => badge(`${MODE_LABEL[row.mode]} (${DECIDED_BY[row.modeDecidedBy]})`, row.mode === 'waterway' ? 'info' : 'neutral') },
        { key: 'tons', label: 'Khối lượng', align: 'right', render: (row) => tons(row.tons) },
        { key: 'weightedAvgDistanceKm', label: 'Cự ly BQ (km)', align: 'right', render: (row) => num(row.weightedAvgDistanceKm, 1) },
        { key: 'trips', label: 'Số chuyến', align: 'right', render: (row) => num(row.trips) },
        { key: 'vehiclesRequired', label: 'Phương tiện', align: 'right', render: (row) => num(row.vehiclesRequired) },
        { key: 'leadTimeHours', label: 'Lead time (h)', align: 'right', render: (row) => num(row.leadTimeHours, 1) },
        { key: 'cost', label: 'Chi phí', align: 'right', render: (row) => vnd(row.cost) },
      ],
      hub.legs,
    ),
    el('details', { class: 'raw' }, [
      el('summary', { class: 'muted', text: `Vùng nguyên liệu — ${hub.cooperativeCount} HTX, khoảng cách tính theo TỪNG HTX (quyết định B6)` }),
      table(
        [
          { key: 'code', label: 'Mã' },
          { key: 'name', label: 'HTX' },
          { key: 'distanceToHubKm', label: 'Ruộng→Hub (km)', align: 'right', render: (row) => num(row.distanceToHubKm, 1) },
          { key: 'distanceToHubSourceLabel', label: 'Nguồn tính', render: (row) => badge(row.distanceToHubSourceLabel, row.distanceToHubSourceLabel.includes('Haversine') ? 'warn' : 'good') },
          { key: 'distanceToPlantKm', label: 'Ruộng→NM (km)', align: 'right', render: (row) => num(row.distanceToPlantKm, 1) },
          { key: 'collectableTons', label: 'Collectable', align: 'right', render: (row) => tons(row.collectableTons) },
          { key: 'deliveredTons', label: 'Delivered', align: 'right', render: (row) => tons(row.deliveredTons) },
        ],
        hub.cooperatives,
      ),
    ]),
    can('simulation.write') && result.status === 'chinh_thuc'
      ? el('button', {
          class: 'ghost small', text: '⇨ Kết xuất Hub sang Module Warehouse (FN-19)',
          onclick: async () => {
            const handover = await guard(api(`/sim/scenarios/${result.scenarioId}/handover/${hub.hubId}`, { body: {} }));
            toast(`Đã tạo cơ sở vận hành cho ${handover.payload.hubName}.`);
          },
        })
      : null,
  ]));

  // FN-17 — cột đối chứng No-Hub Baseline
  const baseline = result.baseline;
  const baselineCard = card('⑤ No-Hub Baseline — vận chuyển thẳng Ruộng → Nhà máy (FN-17)',
    baseline.available
      ? [
          el('div', { class: 'grid cols-4' }, [
            kpi('Baseline Cost/Ton', vnd(baseline.baselineCostPerTon), 'Mẫu số so sánh cho ROI & Payback'),
            kpi('Delivered Supply', tons(baseline.deliveredTons)),
            kpi('Collection Cost', vnd(baseline.collectionCost, { compact: true })),
            kpi('Transportation trực tiếp', vnd(baseline.transportationCost, { compact: true })),
          ]),
          el('p', { class: 'muted', text: 'CAPEX = 0 · Warehouse Cost = 0 · Handling Cost = 0 (BR-01).' }),
          baseline.excludedCooperatives.length
            ? alert(`${baseline.excludedCooperatives.length} HTX bị loại khỏi baseline (${pct(baseline.excludedSupplyPct)} sản lượng) — baseline chỉ mang tính tham khảo.`, 'warn')
            : null,
          table(
            [
              { key: 'label', label: 'Chặng' },
              { key: 'mode', label: 'Phương thức', render: (row) => MODE_LABEL[row.mode] },
              { key: 'weightedAvgDistanceKm', label: 'Cự ly BQ (km)', align: 'right', render: (row) => num(row.weightedAvgDistanceKm, 1) },
              { key: 'trips', label: 'Số chuyến', align: 'right', render: (row) => num(row.trips) },
              { key: 'cost', label: 'Chi phí', align: 'right', render: (row) => vnd(row.cost) },
            ],
            baseline.legs,
          ),
        ]
      : alert(`Không tính được No-Hub Baseline: ${baseline.reason ?? 'thiếu dữ liệu'}. FN-12 chuyển sang chế độ nhập Baseline Cost/Ton thủ công.`, 'warn'));

  const notes = card('Ghi chú phương pháp & giới hạn mô hình',
    el('div', { class: 'list' }, result.notes.map((note) => el('div', { class: 'list-item', style: 'cursor:default', text: note }))));

  return el('div', { class: 'grid' }, [provenance, warnings, supply, flowCard, finance, ...hubCards, baselineCard, notes]);
}

function costChainRows(costs, deliveredTons) {
  const total = costs.totalDeliveredLogisticsCost || 1;
  const rows = [
    { label: 'Collection Cost (thu gom tại ruộng)', value: costs.collectionCost },
    { label: 'Warehouse Cost (duy trì mặt bằng kho/bãi)', value: costs.warehouseCost },
    { label: 'Handling Cost (bốc xếp & vận hành thiết bị)', value: costs.handlingCost },
    { label: 'Transportation — Ruộng → Hub', value: costs.transportationFieldHub },
    { label: 'Transportation — Hub → Nhà máy', value: costs.transportationHubPlant },
  ];
  rows.push({ label: 'TỔNG — Total Delivered Logistics Cost', value: costs.totalDeliveredLogisticsCost });
  return rows.map((row) => ({
    ...row,
    share: (row.value / total) * 100,
    perTon: deliveredTons > 0 ? row.value / deliveredTons : null,
  }));
}

// ===========================================================================
// FN-14 / FN-15 / FN-18 — So sánh kịch bản, khuyến nghị, độ nhạy
// ===========================================================================

registerPage('compare', {
  title: 'So sánh kịch bản đầu tư',
  subtitle: 'Xếp hạng theo TCO per Ton tăng dần · cột đối chứng No-Hub Baseline · phân tích độ nhạy',
  async render(view) {
    const scenarios = await guard(api('/sim/scenarios'));
    const selected = new Set(scenarios.filter((s) => s.simulated_at).slice(0, 4).map((s) => s.id));

    const chips = el('div', { class: 'chip-row' }, scenarios.map((scenario) =>
      el('button', {
        class: `chip${selected.has(scenario.id) ? ' active' : ''}`,
        text: `${scenario.code} — ${scenario.name}${scenario.simulated_at ? '' : ' (chưa mô phỏng)'}`,
        onclick: (event) => {
          if (selected.has(scenario.id)) selected.delete(scenario.id);
          else selected.add(scenario.id);
          event.target.classList.toggle('active');
          refresh();
        },
      })));

    const tableBox = el('div');
    const recommendationBox = el('div');
    const sensitivityBox = el('div');

    view.replaceChildren(
      card('Chọn kịch bản để so sánh', chips),
      tableBox,
      el('div', { class: 'grid cols-2' }, [recommendationBox, sensitivityBox]),
    );

    async function refresh() {
      if (!selected.size) {
        tableBox.replaceChildren(alert('Chọn ít nhất một kịch bản đã mô phỏng.', 'info'));
        recommendationBox.replaceChildren();
        sensitivityBox.replaceChildren();
        return;
      }
      const report = await guard(api('/sim/compare', { body: { scenarioIds: [...selected] } }));
      if (report.blocked) {
        tableBox.replaceChildren(card('Bảng so sánh', alert(report.blocked, 'bad')));
        return;
      }
      tableBox.replaceChildren(card('Bảng so sánh KPI (FN-14)', [
        ...report.warnings.map((warning) => alert(warning, 'warn')),
        table(
          [
            { key: 'rank', label: 'Hạng', align: 'right', render: (row, index) => (row.isBaselineColumn ? '—' : index + 1) },
            { key: 'name', label: 'Kịch bản' },
            {
              key: 'status', label: 'Trạng thái',
              render: (row) => badge(row.isBaselineColumn ? 'Đối chứng'
                : row.status === 'chinh_thuc' ? 'Chính thức' : 'Tham khảo',
                row.isBaselineColumn ? 'info' : row.status === 'chinh_thuc' ? 'good' : 'neutral'),
            },
            { key: 'parameterSetVersion', label: 'Bộ tham số', align: 'right', render: (row) => `v${row.parameterSetVersion}` },
            { key: 'hubCount', label: 'Hub', align: 'right' },
            { key: 'deliveredTons', label: 'Delivered', align: 'right', render: (row) => tons(row.deliveredTons) },
            { key: 'capex', label: 'CAPEX', align: 'right', render: (row) => vnd(row.capex, { compact: true }) },
            { key: 'opexYear1', label: 'OPEX năm 1', align: 'right', render: (row) => vnd(row.opexYear1, { compact: true }) },
            { key: 'collectionCost', label: 'Collection', align: 'right', render: (row) => vnd(row.collectionCost, { compact: true }) },
            { key: 'transportationCost', label: 'Transport', align: 'right', render: (row) => vnd(row.transportationCost, { compact: true }) },
            { key: 'warehouseCost', label: 'Warehouse', align: 'right', render: (row) => vnd(row.warehouseCost, { compact: true }) },
            { key: 'handlingCost', label: 'Handling', align: 'right', render: (row) => vnd(row.handlingCost, { compact: true }) },
            { key: 'costPerTon', label: 'Cost/Ton*', align: 'right', render: (row) => vnd(row.costPerTon) },
            { key: 'tcoPerTon', label: 'TCO/Ton ★', align: 'right', render: (row) => vnd(row.tcoPerTon) },
            { key: 'lifecycleCostPerTon', label: 'Vòng đời đầy đủ/tấn', align: 'right', render: (row) => vnd(row.lifecycleCostPerTon) },
            { key: 'roiPct', label: 'ROI', align: 'right', render: (row) => (row.roiPct === null ? '—' : pct(row.roiPct)) },
            {
              key: 'paybackYears', label: 'Payback', align: 'right',
              render: (row) => (row.paybackYears !== null ? `${row.paybackYears} năm` : (PAYBACK_LABEL[row.paybackStatus] ?? '—')),
            },
            {
              key: 'plantDemandCoveragePct', label: 'Đáp ứng NM', align: 'right',
              render: (row) => badge(pct(row.plantDemandCoveragePct), row.plantDemandCoveragePct >= 100 ? 'good' : 'warn'),
            },
            {
              key: 'shortfallWarnings', label: 'Cảnh báo thiếu hụt', align: 'right',
              render: (row) => (row.shortfallWarnings > 0 ? badge(`${row.shortfallWarnings} Hub`, 'warn') : '—'),
            },
          ],
          report.rows,
          { rowClass: (row) => (row.isBaselineColumn ? 'highlight' : null) },
        ),
        el('p', { class: 'muted', text: '* Cost/Ton chưa gồm khấu hao đầu tư — chỉ dùng phân tích cơ cấu chi phí, không dùng xếp hạng (FN-11 BR-03).' }),
      ]));

      const first = report.rows.find((row) => !row.isBaselineColumn);
      if (first) {
        await renderRecommendation(first.scenarioId);
        await renderSensitivity(first.scenarioId);
      }
    }

    async function renderRecommendation(scenarioId) {
      const recommendation = await api(`/sim/scenarios/${scenarioId}/recommendation`).catch(() => null);
      if (!recommendation) return recommendationBox.replaceChildren();
      recommendationBox.replaceChildren(card('Khuyến nghị đầu tư (FN-15)', [
        el('div', { class: 'kpi' }, [
          el('div', { class: 'label', text: 'Kết luận' }),
          el('div', { class: 'value', text: recommendation.label }),
        ]),
        el('ul', {}, recommendation.reasons.map((reason) => el('li', { text: reason }))),
        el('h4', { text: 'Thứ hạng theo TCO per Ton' }),
        table(
          [
            { key: 'code', label: 'Mã' },
            { key: 'name', label: 'Kịch bản' },
            { key: 'tcoPerTon', label: 'TCO/Ton', align: 'right', render: (row) => vnd(row.tcoPerTon) },
          ],
          recommendation.ranking,
        ),
        el('p', { class: 'muted', text: `Ngưỡng: ROI tối thiểu ${recommendation.thresholds.minRoiPct ?? 'chưa chốt'} · Payback tối đa ${recommendation.thresholds.maxPaybackYears ?? 'chưa chốt'}` }),
      ]));
    }

    async function renderSensitivity(scenarioId) {
      const box = el('div');
      const existing = await api(`/sim/scenarios/${scenarioId}/sensitivity`).catch(() => null);
      const runButton = el('button', {
        class: 'small', text: '▶ Chạy phân tích độ nhạy', disabled: !can('simulation.write'),
        onclick: async () => {
          toast('Đang chạy one-at-a-time trên các tham số trọng yếu…');
          const report = await guard(api(`/sim/scenarios/${scenarioId}/sensitivity`, { body: {} }));
          draw(report);
        },
      });
      sensitivityBox.replaceChildren(card('Phân tích độ nhạy (FN-18)', box, runButton));
      draw(existing);

      function draw(report) {
        if (!report || !report.rows) {
          box.replaceChildren(alert('Chưa có kết quả phân tích độ nhạy cho kịch bản này.', 'info'));
          return;
        }
        const maxSwing = Math.max(...report.rows.map((row) => row.swing), 1);
        box.replaceChildren(
          report.stale ? alert('Kết quả đã lỗi thời — bộ tham số hoặc kịch bản đã thay đổi sau lần phân tích này (BR-03).', 'warn') : null,
          report.highSensitivity
            ? alert(`Kết quả phụ thuộc mạnh vào giả định: biên độ chi phí vòng đời/tấn đạt ${pct(report.swingPct)} (ngưỡng cảnh báo ±20%).`, 'warn')
            : alert(`Biên độ chi phí vòng đời/tấn lớn nhất: ${pct(report.swingPct)}.`, 'good'),
          el('h4', { text: 'Biểu đồ tornado — xếp theo mức ảnh hưởng tới chi phí vòng đời đầy đủ chuỗi / tấn' }),
          el('div', { class: 'grid', style: 'gap:6px' }, report.rows.map((row) => el('div', { class: 'tornado-row' }, [
            el('span', { text: `#${row.number} ${row.name}` }),
            el('div', { class: 'tornado-bar' }, [el('span', { style: `left:0;width:${(row.swing / maxSwing) * 100}%` })]),
            el('span', { class: 'muted', text: vnd(row.swing, { compact: true }) }),
          ]))),
          table(
            [
              { key: 'name', label: 'Tham số' },
              { key: 'min', label: 'Min', align: 'right', render: (row) => num(row.min, 3) },
              { key: 'base', label: 'Base', align: 'right', render: (row) => num(row.base, 3) },
              { key: 'max', label: 'Max', align: 'right', render: (row) => num(row.max, 3) },
              { key: 'tmin', label: 'TCO/Ton (min)', align: 'right', render: (row) => vnd(row.tcoPerTon.min) },
              { key: 'tmax', label: 'TCO/Ton (max)', align: 'right', render: (row) => vnd(row.tcoPerTon.max) },
              { key: 'lmin', label: 'Vòng đời/tấn (min)', align: 'right', render: (row) => vnd(row.lifecycleCostPerTon?.min) },
              { key: 'lmax', label: 'Vòng đời/tấn (max)', align: 'right', render: (row) => vnd(row.lifecycleCostPerTon?.max) },
            ],
            report.rows,
          ),
          report.skipped?.length
            ? alert(`Bị loại khỏi phân tích: ${report.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`, 'info')
            : null,
          el('p', { class: 'muted', text: report.method }),
        );
      }
    }

    await refresh();
  },
});
