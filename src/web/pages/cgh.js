/**
 * CỔNG CƠ GIỚI HOÁ — BRD Bản đồ số Cơ giới hoá v1.3 (FN-01..FN-12, QT-01..03) & Backlog v4.0.
 *
 *   cgh-dashboard  4 thẻ, HTX cần ưu tiên, máy theo khâu/tỉnh, xu hướng vụ, khối vận hành (US-DASH-01)
 *   cgh-map        Bản đồ mức đáp ứng: lọc vụ/khâu/mức, tìm HTX/xã/máy/chủ, panel chi tiết HTX (US-MAP-01..03)
 *   cgh-balance    Cân đối cung–cầu theo HTX và theo tỉnh, lưu kết quả theo vụ (US-ANL-01)
 *   cgh-forecast   Dự báo nhu cầu vụ tới (FN-09)
 *   cgh-shortage   Cảnh báo thiếu hụt (FN-10)
 *   cgh-reports    Báo cáo 3 tab từ kết quả đã lưu, CSV/in, đối chiếu hai vụ (US-RPT-01/02)
 *   cgh-machines   Hồ sơ máy: mã tự sinh, SN/số khung, ngày sở hữu, lịch sử, vô hiệu hoá, nhập hàng loạt 2 chế độ (US-MAC-01..03)
 *   cgh-owners     Chủ sở hữu máy: 4 loại, liên kết HTX, vô hiệu hoá kèm máy (US-OWN-01)
 *   cgh-catalog    Danh mục chủng loại, ngưỡng cảnh báo theo phiên bản, lịch sử cấu hình (US-CFG-01..04)
 *   cgh-norms      Định mức năng suất theo hiệu lực (FN-02)
 *   cgh-plans      Kế hoạch canh tác (FN-08)
 *   cgh-log        Nhật ký hoạt động: đăng nhập, tài khoản, truy cập bị từ chối (US-LOG-01)
 */
import {
  api, apiConfirm, registerPage, el, card, kpi, table, badge, alert, num, pct, dateTime, dateOnly,
  toast, guard, can, form, mapContainer, createMap, LEAFLET_AVAILABLE, navigate, icon, modal, confirmDialog, promptDialog,
  emptyState, svgBarChart, chips, downloadUrl, tabs,
} from '/app.js';

export const STAGE = { lam_dat: 'Làm đất', gieo_sa: 'Gieo sạ', cham_soc: 'Chăm sóc', thu_hoach: 'Thu hoạch', sau_thu_hoach: 'Sau thu hoạch' };
const CONDITION = { hoat_dong: 'Hoạt động', bao_tri: 'Bảo trì', hong: 'Hỏng', ngung_hoat_dong: 'Ngừng hoạt động' };
const LEVEL_TONE = { thieu: 'bad', can_chu_y: 'warn', du: 'good', thua: 'info', chua_co_du_lieu: 'neutral' };
const stageOptions = () => Object.entries(STAGE).map(([value, label]) => ({ value, label }));
const coverageBadge = (row) => el('span', { class: 'badge', style: `background:${row.color}22;color:${row.color}` }, [row.coveragePct === null || row.coveragePct === undefined ? 'Chưa có dữ liệu' : pct(row.coveragePct)]);
const bandLegend = (bands) => el('div', { class: 'chip-row' }, (bands ?? []).map((b) => el('span', { class: 'chip', style: `border-color:${b.color};color:${b.color}` }, [b.label])));
const seasonSelect = (seasons, current, onChange, allLabel = 'Tất cả mùa vụ') => el('label', {}, ['Mùa vụ ', el('select', { onchange: (e) => onChange(e.target.value) }, [allLabel ? el('option', { value: '' }, [allLabel]) : null, ...seasons.map((s) => el('option', { value: s.id, selected: s.id === current }, [s.name]))])]);

// ===========================================================================
// Bảng điều hành — US-DASH-01
// ===========================================================================

registerPage('cgh-dashboard', {
  title: 'Bảng điều hành Cơ giới hoá',
  subtitle: 'Nhu cầu máy = diện tích ÷ định mức (QT-01) · ngưỡng đáp ứng theo phiên bản (QT-02) · ưu tiên nguồn Cổng HTX (QT-03)',
  async render(view, actions) {
    const seasons = await api('/mdm/seasons').catch(() => []);
    let seasonId = '';
    const body = el('div', { class: 'stack' });
    actions.append(seasonSelect(seasons, seasonId, (v) => { seasonId = v; draw(); }));
    if (can('cgh.write')) {
      actions.append(el('button', { class: 'ghost small', onclick: async () => { const r = await guard(api('/cgh/sync-app-htx', { body: { machineConditions: [], cultivation: [] } })); toast(`Đồng bộ ${r.status}: ${r.recordCount} bản ghi.`); await draw(); } }, [icon('refresh', 15), 'Đồng bộ Cổng HTX']));
    }
    async function draw() {
      const d = await guard(api(`/cgh/dashboard/v2${seasonId ? `?seasonId=${seasonId}` : ''}`));
      const k = d.kpis ?? {};
      body.replaceChildren(
        d.ops?.syncBanner ? alert(d.ops.syncBanner, 'bad') : null,
        el('div', { class: 'grid cols-4' }, [
          kpi('Tổng số máy', num(k.totalMachines), `${num(k.totalHtx)} HTX đang hoạt động`, null, 'tractor'),
          kpi('HTX đủ / thừa máy', num(k.htxSufficient), 'Theo khâu yếu nhất của HTX', null, 'check'),
          kpi('HTX thiếu / cần chú ý', num(k.htxShort), 'Cần điều phối máy hoặc thuê', null, 'warning'),
          kpi('HTX chưa có dữ liệu', num(k.htxNoData), 'Thiếu diện tích hoặc định mức — không suy đoán', null, 'info'),
        ]),
        card('Ngưỡng cảnh báo đang áp dụng (QT-02)', [bandLegend(d.coverageBands), el('p', { class: 'muted', text: `Hiệu lực từ ${dateOnly(d.thresholds?.effectiveFrom)} · ${d.thresholds?.documentRef ?? ''}` })]),
        el('div', { class: 'split wide-left' }, [
          card('HTX cần ưu tiên', table([
            { key: 'htxName', label: 'HTX' }, { key: 'provinceName', label: 'Tỉnh', render: (r) => r.provinceName ?? '—' },
            { key: 'stage', label: 'Khâu yếu nhất', render: (r) => STAGE[r.stage] ?? r.stage },
            { key: 'coveragePct', label: 'Đáp ứng', align: 'right', render: coverageBadge },
            { key: 'gap', label: 'Thiếu', align: 'right', render: (r) => (r.gap === null ? '—' : num(Math.abs(Math.min(0, r.gap)))) },
            { key: 'act', label: '', render: (r) => el('button', { class: 'ghost small', onclick: () => navigate('cgh-map', { htxId: r.htxId }) }, [icon('map', 14)]) },
          ], d.priority ?? [], { empty: 'Không có HTX nào dưới ngưỡng.' })),
          el('div', { class: 'stack' }, [
            card('Máy theo khâu', svgBarChart((d.byStage ?? []).map((s) => ({ label: STAGE[s.stage] ?? s.stage, value: s.total, value2: s.operational, color: 'var(--brand)', color2: 'var(--good)' })), { height: 190, format: (v) => num(v) })),
            el('div', { class: 'legend-row' }, [el('span', {}, [el('i', { style: 'background:var(--brand)' }), 'Tổng máy']), el('span', {}, [el('i', { style: 'background:var(--good)' }), 'Đang hoạt động'])]),
            card('Máy theo tỉnh', table([{ key: 'province', label: 'Tỉnh', render: (r) => r.province ?? 'Chưa gán' }, { key: 'machines', label: 'Máy', align: 'right' }], d.byProvince ?? [], { plain: true })),
          ]),
        ]),
        (d.trend ?? []).length ? card('Xu hướng theo vụ (từ kết quả cân đối đã lưu)', table([
          { key: 'season', label: 'Vụ' }, { key: 'computedAt', label: 'Lưu lúc', render: (r) => dateTime(r.computedAt) },
          { key: 'thieu', label: 'Thiếu', align: 'right' }, { key: 'can_chu_y', label: 'Cần chú ý', align: 'right' }, { key: 'du', label: 'Đủ', align: 'right' }, { key: 'thua', label: 'Thừa', align: 'right' },
        ], d.trend)) : null,
        d.ops ? card('Khối vận hành (chỉ Admin)', el('div', { class: 'grid cols-4' }, [
          kpi('Tài khoản', `${num(d.ops.accounts?.active)}/${num(d.ops.accounts?.total)}`, `${num(d.ops.accounts?.locked)} bị khoá`),
          kpi('Lỗi đồng bộ App HTX', num((d.ops.syncErrors ?? []).length), (d.ops.syncErrors ?? [])[0]?.started_at ? `Gần nhất ${dateTime(d.ops.syncErrors[0].started_at)}` : 'Không có lỗi'),
          kpi('Nhập liệu hàng loạt gần nhất', d.ops.lastImport ? dateTime(d.ops.lastImport.occurred_at) : 'Chưa có'),
          kpi('Đăng nhập gần đây', num((d.ops.recentLogins ?? []).length), (d.ops.recentLogins ?? []).slice(0, 3).map((l) => l.actor_name).join(', ')),
        ])) : null,
      );
    }
    view.replaceChildren(body);
    await draw();
  },
});

// ===========================================================================
// Bản đồ mức đáp ứng — US-MAP
// ===========================================================================

registerPage('cgh-map', {
  title: 'Bản đồ mức đáp ứng cơ giới hoá',
  subtitle: 'Mỗi HTX tô màu theo khâu YẾU NHẤT · lọc vụ / khâu / mức · tìm HTX, xã, mã máy, chủ máy · nhấp để xem chi tiết',
  async render(view, actions, params = {}) {
    const [balance, seasons, dashboard] = await Promise.all([guard(api('/cgh/balance')), api('/mdm/seasons').catch(() => []), api('/cgh/dashboard')]);
    let rows = balance.rows; let stage = ''; let level = '';
    const mapNode = mapContainer('cgh-map-canvas', 'tall');
    const detail = el('div', { class: 'card' }, [emptyState('Nhấp một HTX trên bản đồ hoặc tìm kiếm để xem chi tiết.', 'map')]);
    const stats = el('div', { class: 'grid cols-4' });
    let map = null; let markers = [];
    const search = el('input', { placeholder: 'Tìm HTX, xã, mã máy, chủ máy…', style: 'min-width:240px' });
    const suggest = el('div', { class: 'bell-panel', hidden: true, style: 'top:42px;left:0;width:340px' });
    const searchWrap = el('div', { style: 'position:relative' }, [search, suggest]);
    let debounce;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = search.value.trim();
      if (q.length < 2) { suggest.hidden = true; return; }
      debounce = setTimeout(async () => {
        const r = await api(`/cgh/search?q=${encodeURIComponent(q)}`).catch(() => null);
        if (!r) return;
        const items = [
          ...r.htx.map((h) => ({ label: `${h.code} — ${h.name}`, kind: 'HTX', lat: h.lat, lng: h.lng, htxId: h.id })),
          ...r.communes.map((c) => ({ label: c.name, kind: 'Xã', lat: c.lat, lng: c.lng })),
          ...r.machines.map((m) => ({ label: `${m.code} · SN ${m.serial_number ?? '—'}`, kind: `Máy · ${m.htx_name ?? ''}`, lat: m.lat, lng: m.lng, htxId: m.htx_id })),
          ...r.owners.map((o) => ({ label: `${o.code} — ${o.name}`, kind: 'Chủ máy', lat: o.lat, lng: o.lng, htxId: o.htx_id })),
        ];
        suggest.hidden = !items.length;
        suggest.replaceChildren(...(items.length ? items.slice(0, 10).map((it) => el('div', { class: 'notif', onclick: () => { suggest.hidden = true; if (map && it.lat) map.flyTo([it.lat, it.lng], 13); if (it.htxId) openDetail(it.htxId); } }, [el('span', { class: 'dot' }), el('div', {}, [el('div', { class: 'title', text: it.label }), el('div', { class: 'body', text: it.kind })])])) : [el('p', { class: 'muted', style: 'padding:10px', text: 'Không tìm thấy.' })]));
      }, 250);
    });
    actions.append(searchWrap, seasonSelect(seasons, '', async (v) => { rows = (await guard(api(`/cgh/balance${v ? `?seasonId=${v}` : ''}`))).rows; draw(); }));

    const worstRows = () => {
      const worst = new Map();
      for (const row of rows) {
        if (!row.lat || (stage && row.stage !== stage)) continue;
        const cur = worst.get(row.htxId);
        if (!cur || (row.coveragePct ?? 999) < (cur.coveragePct ?? 999)) worst.set(row.htxId, row);
      }
      return [...worst.values()].filter((r) => !level || r.level === level);
    };
    function draw() {
      const list = worstRows();
      stats.replaceChildren(
        kpi('HTX trên bản đồ', num(list.length), null, null, 'map'),
        kpi('Thiếu / cần chú ý', num(list.filter((r) => r.level === 'thieu' || r.level === 'can_chu_y').length), null, null, 'warning'),
        kpi('Đủ / thừa', num(list.filter((r) => r.level === 'du' || r.level === 'thua').length), null, null, 'check'),
        kpi('Chưa có dữ liệu', num(list.filter((r) => r.coveragePct === null).length), 'Không suy đoán', null, 'info'),
      );
      if (!map) return;
      markers.forEach((m) => map.removeLayer(m)); markers = [];
      for (const row of list) {
        markers.push(window.L.circleMarker([row.lat, row.lng], { radius: 9, color: '#fff', fillColor: row.color, fillOpacity: 0.9, weight: 2 })
          .bindTooltip(`${row.htxName} · ${STAGE[row.stage] ?? row.stage} · ${row.coveragePct === null ? 'Chưa có dữ liệu' : pct(row.coveragePct)}`)
          .on('click', () => openDetail(row.htxId)).addTo(map));
      }
    }
    async function openDetail(htxId) {
      const d = await guard(api(`/cgh/htx/${htxId}/detail`));
      const atInput = el('input', { type: 'date', value: d.at, max: new Date().toISOString().slice(0, 10), style: 'width:150px', onchange: async (e) => { const s = await guard(api(`/cgh/htx/${htxId}/machines-at?at=${e.target.value}`)); snap.replaceChildren(snapTable(s)); } });
      const snapTable = (s) => table([{ key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage }, { key: 'total', label: 'Máy', align: 'right' }, { key: 'operational', label: 'Hoạt động', align: 'right' }], s.byStage, { plain: true, empty: 'Không có máy tại thời điểm này.' });
      const snap = el('div', {}, [snapTable(d)]);
      detail.replaceChildren(
        el('div', { class: 'card-head' }, [el('div', {}, [el('div', { class: 'eyebrow', text: `HTX · ${d.htx.code} · ${d.htx.province_name ?? ''}` }), el('h3', { text: d.htx.name })]), el('button', { class: 'ghost small', onclick: () => navigate('cgh-machines', { htxId }) }, [icon('tractor', 14), 'Hồ sơ máy'])]),
        el('div', { class: 'grid cols-2' }, [kpi('Diện tích đăng ký', `${num(d.htx.registered_area_ha)} ha`), kpi('Máy tại thời điểm', num(d.total))]),
        el('h4', { text: 'Cân đối theo khâu (vụ hiện tại)' }),
        table([{ key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage }, { key: 'areaHa', label: 'ha', align: 'right', render: (r) => num(r.areaHa) }, { key: 'requiredMachines', label: 'Cần', align: 'right' }, { key: 'operationalMachines', label: 'Có', align: 'right' }, { key: 'coveragePct', label: 'Đáp ứng', render: coverageBadge }], d.balance, { plain: true, empty: 'Chưa có kế hoạch canh tác.' }),
        el('div', { class: 'row', style: 'margin-top:10px' }, [el('label', {}, ['Số máy tại ngày (BR-09)', atInput])]),
        snap,
      );
    }
    view.replaceChildren(
      stats,
      card('Bộ lọc & chú giải', el('div', { class: 'row' }, [
        chips([{ value: '', label: 'Mọi khâu' }, ...stageOptions()], stage, (v) => { stage = v; draw(); }),
        chips([{ value: '', label: 'Mọi mức' }, ...(dashboard.coverageBands ?? []).map((b) => ({ value: b.level, label: b.label }))], level, (v) => { level = v; draw(); }),
      ])),
      el('div', { class: 'split wide-left' }, [card(null, mapNode), detail]),
    );
    if (LEAFLET_AVAILABLE()) {
      map = createMap('cgh-map-canvas', [10.2, 105.8], 8);
      const first = worstRows();
      if (first.length) map.fitBounds(first.map((r) => [r.lat, r.lng]), { padding: [30, 30] });
    }
    draw();
    if (params.htxId) openDetail(params.htxId);
  },
});

// ===========================================================================
// Cân đối cung – cầu — FN-09, US-ANL-01
// ===========================================================================

registerPage('cgh-balance', {
  title: 'Cân đối cung – cầu máy',
  subtitle: 'Theo HTX × vụ × khâu và tổng hợp theo tỉnh. Nhu cầu = diện tích ÷ định mức, làm tròn lên (QT-01). Lưu kết quả để báo cáo',
  async render(view, actions) {
    const seasons = await api('/mdm/seasons').catch(() => []);
    let seasonId = seasons[0]?.id ?? '';
    const body = el('div', { class: 'stack' });
    actions.append(seasonSelect(seasons, seasonId, (v) => { seasonId = v; draw(); }, null));
    if (can('cgh.write')) {
      actions.append(el('button', { class: 'small', onclick: async () => {
        if (!seasonId) return toast('Chọn vụ trước.', true);
        const out = await guard(api('/cgh/balance/save', { body: { seasonId } }));
        toast(`Đã lưu kết quả cân đối vụ ${out.season_name} lúc ${dateTime(out.computed_at)}.`); await draw();
      } }, [icon('check', 15), 'Lưu kết quả cân đối']));
    }
    async function draw() {
      const [byHtx, byProv, snapshots] = await Promise.all([guard(api(`/cgh/balance${seasonId ? `?seasonId=${seasonId}` : ''}`)), api(`/cgh/balance/by-province${seasonId ? `?seasonId=${seasonId}` : ''}`), api('/cgh/balance/snapshots').catch(() => [])]);
      const mine = snapshots.filter((s) => !seasonId || s.season_id === seasonId);
      body.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Dòng cân đối', num(byHtx.rows.length), 'HTX × vụ × khâu', null, 'scale'),
          kpi('Thiếu máy', num(byHtx.summary?.thieu ?? 0), null, null, 'warning'),
          kpi('Đủ máy', num(byHtx.summary?.du ?? 0), null, null, 'check'),
          kpi('Kết quả đã lưu', num(mine.length), mine[0] ? `Mới nhất ${dateTime(mine[0].computed_at)}` : 'Chưa lưu — báo cáo chưa có số liệu', null, 'database'),
        ]),
        tabs([
          { id: 'prov', label: 'Theo tỉnh', icon: 'map', render: (p) => p.append(table([
            { key: 'provinceName', label: 'Tỉnh' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage }, { key: 'htxCount', label: 'HTX', align: 'right' },
            { key: 'areaHa', label: 'Diện tích (ha)', align: 'right', render: (r) => num(r.areaHa) }, { key: 'required', label: 'Cần', align: 'right' }, { key: 'operational', label: 'Có', align: 'right' },
            { key: 'coveragePct', label: 'Đáp ứng', render: coverageBadge }, { key: 'gap', label: 'Chênh', align: 'right', render: (r) => num(r.gap) },
          ], byProv.rows ?? [], { empty: 'Chưa có dữ liệu.' })) },
          { id: 'htx', label: 'Theo HTX', icon: 'building', render: (p) => p.append(table([
            { key: 'htxCode', label: 'Mã' }, { key: 'htxName', label: 'HTX' }, { key: 'provinceName', label: 'Tỉnh', render: (r) => r.provinceName ?? '—' }, { key: 'seasonName', label: 'Vụ' },
            { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage }, { key: 'areaHa', label: 'ha', align: 'right', render: (r) => num(r.areaHa) },
            { key: 'areaSource', label: 'Nguồn DT', render: (r) => badge(r.areaSource === 'app_htx' ? 'Cổng HTX' : 'Nhập tay', r.areaSource === 'app_htx' ? 'good' : 'neutral') },
            { key: 'requiredMachines', label: 'Cần', align: 'right' }, { key: 'operationalMachines', label: 'Có', align: 'right' }, { key: 'coveragePct', label: 'Đáp ứng', render: coverageBadge },
          ], byHtx.rows.slice(0, 300), { empty: 'Không có dòng nào.' })) },
          { id: 'saved', label: 'Kết quả đã lưu', icon: 'history', render: (p) => p.append(table([
            { key: 'season_name', label: 'Vụ' }, { key: 'computed_at', label: 'Lưu lúc', render: (r) => dateTime(r.computed_at) }, { key: 'computed_by', label: 'Người lưu' },
            { key: 's', label: 'Thiếu / Chú ý / Đủ / Thừa', render: (r) => `${r.summary?.thieu ?? 0} / ${r.summary?.can_chu_y ?? 0} / ${r.summary?.du ?? 0} / ${r.summary?.thua ?? 0}` },
          ], snapshots, { empty: 'Chưa lưu kết quả nào.' })) },
        ]),
      );
    }
    view.replaceChildren(body);
    await draw();
  },
});

// ===========================================================================
// Dự báo & thiếu hụt — FN-09/10
// ===========================================================================

registerPage('cgh-forecast', {
  title: 'Dự báo nhu cầu máy vụ tới',
  subtitle: 'Ngoại suy từ diện tích các vụ đã qua; con số là ƯỚC TÍNH để lập kế hoạch, không phải cam kết (FN-09)',
  async render(view) {
    const forecast = await guard(api('/cgh/forecast'));
    view.replaceChildren(
      alert('Dự báo dựa trên xu hướng diện tích các vụ đã ghi nhận. Vụ chưa đủ dữ liệu lịch sử sẽ không được ngoại suy.', 'info'),
      forecast.length ? card('Số máy cần theo khâu', svgBarChart(forecast.map((r) => ({ label: STAGE[r.stage] ?? r.stage, value: r.projectedMachines })), { height: 200, format: (v) => num(v) })) : null,
      card('Dự báo theo khâu canh tác', table([
        { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage }, { key: 'avgAreaHa', label: 'DT bình quân (ha)', align: 'right', render: (r) => num(r.avgAreaHa) },
        { key: 'trendHaPerSeason', label: 'Xu hướng (ha/vụ)', align: 'right', render: (r) => num(r.trendHaPerSeason) }, { key: 'projectedAreaHa', label: 'DT dự báo (ha)', align: 'right', render: (r) => num(r.projectedAreaHa) },
        { key: 'projectedMachines', label: 'Số máy cần', align: 'right', render: (r) => num(r.projectedMachines) },
      ], forecast, { empty: 'Chưa đủ dữ liệu lịch sử để dự báo.' })),
    );
  },
});

registerPage('cgh-shortage', {
  title: 'Cảnh báo thiếu hụt cơ giới hoá',
  subtitle: 'Vùng × khâu có mức đáp ứng dưới ngưỡng, kèm nguồn của từng con số (FN-10)',
  async render(view) {
    const shortage = await guard(api('/cgh/shortage-report'));
    const rows = shortage.shortages ?? [];
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vùng × khâu thiếu máy', num(rows.length), null, null, 'warning'),
        kpi('Tổng máy còn thiếu', num(rows.reduce((a, r) => a + Math.max(0, (r.requiredMachines ?? 0) - (r.operationalMachines ?? 0)), 0)), null, null, 'tractor'),
      ]),
      card('Nguồn dữ liệu', [el('p', { class: 'muted', text: shortage.sourceLabels?.area ?? 'Nguồn diện tích: không xác định.' }), el('p', { class: 'muted', text: shortage.sourceLabels?.norm ?? 'Nguồn định mức: không xác định.' })]),
      card('Chi tiết thiếu hụt', table([
        { key: 'htxCode', label: 'Mã' }, { key: 'htxName', label: 'HTX' }, { key: 'seasonName', label: 'Vụ' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage },
        { key: 'areaHa', label: 'ha', align: 'right', render: (r) => num(r.areaHa) }, { key: 'requiredMachines', label: 'Cần', align: 'right' }, { key: 'operationalMachines', label: 'Có', align: 'right' }, { key: 'coveragePct', label: 'Đáp ứng', align: 'right', render: (r) => pct(r.coveragePct) },
      ], rows, { empty: 'Không có vùng nào dưới ngưỡng cảnh báo.' })),
    );
  },
});

// ===========================================================================
// Báo cáo & đối chiếu vụ — US-RPT-01/02
// ===========================================================================

registerPage('cgh-reports', {
  title: 'Báo cáo & so sánh vụ',
  subtitle: 'Báo cáo từ kết quả cân đối ĐÃ LƯU (không tính lại) · tiêu đề ghi Ngày xuất & Vụ · CSV / in · đối chiếu hai vụ',
  async render(view, actions) {
    const [seasons, provinces] = await Promise.all([api('/mdm/seasons').catch(() => []), api('/mdm/admin-units?level=province').catch(() => [])]);
    let seasonId = seasons[0]?.id ?? ''; let provinceId = ''; let stage = '';
    const body = el('div');
    actions.append(el('button', { class: 'ghost small', onclick: () => window.print() }, [icon('print', 15), 'In']));
    async function draw() {
      if (!seasonId) return body.replaceChildren(alert('Chưa có mùa vụ.', 'warn'));
      const qs = `seasonId=${seasonId}${provinceId ? `&provinceId=${provinceId}` : ''}${stage ? `&stage=${stage}` : ''}`;
      const rep = await guard(api(`/cgh/report?${qs}`));
      body.replaceChildren(
        el('div', { class: 'section-head' }, [
          el('div', {}, [el('h3', { text: `Báo cáo cơ giới hoá — ${rep.season ?? ''}` }), el('p', { text: `Ngày xuất ${dateTime(rep.exportedAt)}${rep.saved ? ` · kết quả lưu lúc ${dateTime(rep.computedAt)}` : ''}` })]),
          rep.saved ? el('div', { class: 'chip-row' }, [el('button', { class: 'ghost small', onclick: () => downloadUrl(`/cgh/report.csv?${qs}&tab=summary`, 'cgh-tong-hop.csv') }, [icon('download', 14), 'CSV tổng hợp']), el('button', { class: 'ghost small', onclick: () => downloadUrl(`/cgh/report.csv?${qs}&tab=shortage`, 'cgh-thieu-hut.csv') }, [icon('download', 14), 'CSV thiếu hụt'])]) : null,
        ]),
        rep.saved ? tabs([
          { id: 'summary', label: 'Tổng hợp theo tỉnh', icon: 'chart', render: (p) => p.append(table([
            { key: 'provinceName', label: 'Tỉnh' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage }, { key: 'htxCount', label: 'HTX', align: 'right' }, { key: 'areaHa', label: 'ha', align: 'right', render: (r) => num(r.areaHa) },
            { key: 'required', label: 'Cần', align: 'right' }, { key: 'operational', label: 'Có', align: 'right' }, { key: 'coveragePct', label: 'Đáp ứng', render: coverageBadge }, { key: 'levelLabel', label: 'Mức', render: (r) => badge(r.levelLabel, LEVEL_TONE[r.level] ?? 'neutral') },
          ], rep.summaryRows, { empty: 'Không có dòng.' })) },
          { id: 'shortage', label: 'Thiếu hụt', icon: 'warning', render: (p) => p.append(table([
            { key: 'provinceName', label: 'Tỉnh' }, { key: 'htxCode', label: 'Mã' }, { key: 'htxName', label: 'HTX' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage },
            { key: 'required', label: 'Cần', align: 'right' }, { key: 'operational', label: 'Có', align: 'right' }, { key: 'shortage', label: 'Thiếu', align: 'right' }, { key: 'coveragePct', label: 'Đáp ứng', align: 'right', render: (r) => pct(r.coveragePct) },
            { key: 'areaSource', label: 'Nguồn DT', render: (r) => badge(r.areaSource === 'app_htx' ? 'Cổng HTX' : 'Nhập tay', 'neutral') },
          ], rep.shortageRows, { empty: 'Không có HTX thiếu máy.' })) },
          { id: 'compare', label: 'Đối chiếu hai vụ', icon: 'scale', render: renderCompare },
        ]) : el('div', {}, [alert(rep.notice, 'warn'), el('button', { class: 'ghost small', onclick: () => navigate('cgh-balance') }, ['Đến màn Cân đối →'])]),
      );
    }
    async function renderCompare(panel) {
      let a = seasonId; let b = seasons.find((s) => s.id !== seasonId)?.id ?? '';
      const out = el('div');
      const run = async () => {
        if (!a || !b) return out.replaceChildren(alert('Chọn hai vụ.', 'info'));
        try {
          const c = await api(`/cgh/compare?a=${a}&b=${b}`);
          out.replaceChildren(
            el('div', { class: 'chip-row' }, [badge(`${c.seasonA.name}${c.seasonA.saved ? '' : ' (chưa lưu)'}`, c.seasonA.saved ? 'good' : 'warn'), '→', badge(`${c.seasonB.name}${c.seasonB.saved ? '' : ' (chưa lưu)'}`, c.seasonB.saved ? 'good' : 'warn'), el('button', { class: 'ghost small', onclick: () => downloadUrl(`/cgh/compare.csv?a=${a}&b=${b}`, 'cgh-doi-chieu.csv') }, [icon('download', 14), 'CSV'])]),
            table([
              { key: 'provinceName', label: 'Tỉnh' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage },
              { key: 'operationalA', label: 'Máy vụ A', align: 'right', render: (r) => (r.operationalA ?? '—') }, { key: 'operationalB', label: 'Máy vụ B', align: 'right', render: (r) => (r.operationalB ?? '—') },
              { key: 'deltaOperational', label: 'Δ máy', align: 'right', render: (r) => (r.deltaOperational === null ? '—' : badge(`${r.deltaOperational > 0 ? '+' : ''}${r.deltaOperational}`, r.deltaOperational > 0 ? 'good' : r.deltaOperational < 0 ? 'bad' : 'neutral')) },
              { key: 'coverageA', label: 'Đáp ứng A', align: 'right', render: (r) => (r.coverageA == null ? '—' : pct(r.coverageA)) }, { key: 'coverageB', label: 'Đáp ứng B', align: 'right', render: (r) => (r.coverageB == null ? '—' : pct(r.coverageB)) },
              { key: 'deltaCoverage', label: 'Δ %', align: 'right', render: (r) => (r.deltaCoverage === null ? '—' : `${r.deltaCoverage > 0 ? '+' : ''}${r.deltaCoverage}`) },
              { key: 'presence', label: '', render: (r) => (r.presence === 'ca_hai' ? '' : badge(r.presence === 'chi_vu_a' ? 'Chỉ vụ A' : 'Chỉ vụ B', 'warn')) },
            ], c.rows, { empty: 'Hai vụ chưa có kết quả lưu để đối chiếu.' }),
          );
        } catch (e) { out.replaceChildren(alert(e.message, 'bad')); }
      };
      panel.append(el('div', { class: 'row' }, [
        el('label', {}, ['Vụ A', el('select', { onchange: (e) => { a = e.target.value; run(); } }, seasons.map((s) => el('option', { value: s.id, selected: s.id === a }, [s.name])))]),
        el('label', {}, ['Vụ B', el('select', { onchange: (e) => { b = e.target.value; run(); } }, seasons.map((s) => el('option', { value: s.id, selected: s.id === b }, [s.name])))]),
      ]), out);
      await run();
    }
    view.replaceChildren(
      card('Bộ lọc', el('div', { class: 'row' }, [
        seasonSelect(seasons, seasonId, (v) => { seasonId = v; draw(); }, null),
        el('label', {}, ['Tỉnh ', el('select', { onchange: (e) => { provinceId = e.target.value; draw(); } }, [el('option', { value: '' }, ['Tất cả']), ...provinces.filter((p) => p.level === 'province').map((p) => el('option', { value: p.id }, [p.name]))])]),
        el('label', {}, ['Khâu ', el('select', { onchange: (e) => { stage = e.target.value; draw(); } }, [el('option', { value: '' }, ['Tất cả']), ...stageOptions().map((o) => el('option', { value: o.value }, [o.label]))])]),
      ])),
      body,
    );
    await draw();
  },
});

// ===========================================================================
// Hồ sơ máy — US-MAC
// ===========================================================================

registerPage('cgh-machines', {
  title: 'Hồ sơ máy',
  subtitle: 'Mã máy tự sinh MAY-<tỉnh>-xxxxx · bắt buộc SN hoặc số khung · ngày HTX sở hữu (BR-09) · lịch sử · nhập hàng loạt 2 chế độ',
  async render(view, actions, params = {}) {
    const [types, cooperatives, owners] = await Promise.all([api('/cgh/machine-types'), api('/mdm/cooperatives'), api('/cgh/owners').catch(() => [])]);
    let htxId = params.htxId ?? ''; let includeInactive = false; let q = '';
    const body = el('div');
    actions.append(el('label', {}, ['HTX ', el('select', { onchange: (e) => { htxId = e.target.value; draw(); } }, [el('option', { value: '' }, ['Tất cả HTX']), ...cooperatives.map((c) => el('option', { value: c.id, selected: c.id === htxId }, [`${c.code} — ${c.name}`]))])]));
    async function draw() {
      const machines = (await guard(api(`/cgh/machines?${htxId ? `htxId=${htxId}&` : ''}${includeInactive ? 'includeInactive=1' : ''}`))).filter((m) => !q || `${m.code} ${m.serial_number ?? ''} ${m.chassis_number ?? ''} ${m.brand ?? ''} ${m.owner_name ?? ''}`.toLowerCase().includes(q.toLowerCase()));
      body.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Tổng máy', num(machines.length), null, null, 'tractor'),
          kpi('Đang hoạt động', num(machines.filter((m) => m.condition === 'hoat_dong').length), null, null, 'check'),
          kpi('Hỏng / ngừng / bảo trì', num(machines.filter((m) => m.condition !== 'hoat_dong').length), null, null, 'wrench'),
          kpi('Bản ghi đã khoá', num(machines.filter((m) => m.condition_locked).length), 'Cổng HTX không ghi đè (QT-03)', null, 'lock'),
        ]),
        card('Danh mục máy', table([
          { key: 'code', label: 'Mã máy' }, { key: 'machine_type_name', label: 'Chủng loại' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage },
          { key: 'htx_name', label: 'HTX', render: (r) => r.htx_name ?? '—' }, { key: 'owner_name', label: 'Chủ máy', render: (r) => r.owner_name ?? '—' },
          { key: 'serial_number', label: 'SN / Số khung', render: (r) => r.serial_number ?? r.chassis_number ?? '—' }, { key: 'brand', label: 'Hãng', render: (r) => [r.brand, r.model].filter(Boolean).join(' ') || '—' },
          { key: 'owned_since', label: 'Sở hữu từ', render: (r) => (r.owned_since ? dateOnly(r.owned_since) : '—') },
          { key: 'condition', label: 'Tình trạng', render: (r) => badge(CONDITION[r.condition] ?? r.condition, r.condition === 'hoat_dong' ? 'good' : r.condition === 'hong' ? 'bad' : 'warn') },
          { key: 'status', label: '', render: (r) => (r.status === 'inactive' ? badge(`Vô hiệu ${dateOnly(r.deactivated_at)}`, 'neutral') : (r.condition_locked ? badge('Khoá', 'info') : '')) },
          { key: 'act', label: '', render: (r) => el('span', { class: 'chip-row' }, [
            el('button', { class: 'ghost small', title: 'Lịch sử', onclick: () => showHistory(r) }, [icon('history', 14)]),
            can('cgh.write') && r.status !== 'inactive' ? el('button', { class: 'ghost small', title: 'Sửa', onclick: () => editMachine(r) }, [icon('edit', 14)]) : null,
            can('cgh.write') && r.status !== 'inactive' ? el('button', { class: 'ghost small', title: r.condition_locked ? 'Mở khoá' : 'Khoá (QT-03)', onclick: async () => { await guard(api(`/cgh/machines/${r.id}/lock`, { body: { locked: !r.condition_locked } })); toast(r.condition_locked ? 'Đã mở khoá.' : 'Đã khoá — Cổng HTX không ghi đè bản ghi này.'); await draw(); } }, [icon(r.condition_locked ? 'unlock' : 'lock', 14)]) : null,
            can('cgh.write') ? (r.status === 'inactive'
              ? el('button', { class: 'ghost small', onclick: async () => { await guard(api(`/cgh/machines/${r.id}/reactivate`, { body: {} })); toast('Đã kích hoạt lại.'); await draw(); } }, ['Kích hoạt'])
              : el('button', { class: 'ghost small danger', title: 'Vô hiệu hoá', onclick: async () => { const reason = await promptDialog(`Vô hiệu hoá ${r.code}`, { placeholder: 'Lý do (bán, hỏng hẳn, chuyển HTX…)', message: 'Máy vẫn được tính cho các vụ trước ngày vô hiệu hoá (BR-09).' }); if (reason === null) return; await guard(api(`/cgh/machines/${r.id}/deactivate`, { body: { reason } })); toast('Đã vô hiệu hoá.'); await draw(); } }, [icon('trash', 14)])) : null,
          ]) },
        ], machines, { empty: 'Chưa có máy nào khớp bộ lọc.' })),
      );
    }
    function editMachine(m) {
      const dlg = modal(`Sửa máy ${m.code}`, form([
        { name: 'brand', label: 'Hãng', value: m.brand ?? '' }, { name: 'model', label: 'Model', value: m.model ?? '' },
        { name: 'serial_number', label: 'Số máy (SN)', value: m.serial_number ?? '' }, { name: 'chassis_number', label: 'Số khung', value: m.chassis_number ?? '' },
        { name: 'year_made', label: 'Năm SX', type: 'number', value: m.year_made ?? '' }, { name: 'power_hp', label: 'Công suất (HP)', type: 'number', value: m.power_hp ?? '' },
        { name: 'fuel', label: 'Nhiên liệu', value: m.fuel ?? '' }, { name: 'owned_since', label: 'HTX sở hữu từ', type: 'date', value: m.owned_since ?? '' },
        { name: 'owner_id', label: 'Chủ máy', type: 'select', options: owners.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}`, selected: o.id === m.owner_id })) },
      ], async (v) => { const patch = Object.fromEntries(Object.entries(v).filter(([, val]) => val !== '' && val !== null)); await api(`/cgh/machines/${m.id}`, { method: 'PUT', body: patch }); toast('Đã cập nhật máy.'); dlg.close(); await draw(); }, { submitLabel: 'Lưu', stacked: true, resetOnSuccess: false }), [], { wide: true });
    }
    async function showHistory(m) {
      const rows = await guard(api(`/cgh/machines/${m.id}/history`));
      modal(`Lịch sử máy ${m.code}`, rows.length ? el('div', { class: 'timeline' }, rows.map((r) => el('div', { class: 'tl-item' }, [
        el('span', { class: 'dot', style: r.action === 'create' ? 'background:var(--good)' : r.action === 'delete' ? 'background:var(--critical)' : '' }),
        el('div', { class: 'body' }, [el('b', { text: `${{ create: 'Tạo hồ sơ', update: 'Cập nhật', delete: 'Xoá' }[r.action] ?? r.action}${r.note ? ` · ${r.note}` : ''}` }), el('span', { text: `${dateTime(r.occurred_at)} · ${r.actor_name ?? 'hệ thống'}` }), r.after_json ? el('details', { class: 'raw' }, [el('summary', { class: 'muted', text: 'chi tiết' }), el('pre', { text: String(r.after_json).slice(0, 800) })]) : null]),
      ]))) : emptyState('Chưa có lịch sử.', 'history'));
    }
    view.replaceChildren(
      el('div', { class: 'row' }, [
        el('input', { placeholder: 'Tìm mã máy, SN, số khung, hãng, chủ máy…', oninput: (e) => { q = e.target.value.trim(); draw(); } }),
        el('label', { class: 'pick-item' }, [el('input', { type: 'checkbox', onchange: (e) => { includeInactive = e.target.checked; draw(); } }), 'Hiện máy đã vô hiệu hoá']),
      ]),
      can('cgh.write') ? el('div', { class: 'grid cols-2' }, [
        card('Thêm máy (mã tự sinh theo tỉnh)', form([
          { name: 'machineTypeId', label: 'Chủng loại', type: 'select', required: true, options: types.map((t) => ({ value: t.id, label: `${t.name} (${STAGE[t.stage] ?? t.stage})` })) },
          { name: 'htxId', label: 'HTX quản lý', type: 'select', required: true, options: cooperatives.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}`, selected: c.id === htxId })) },
          { name: 'ownerId', label: 'Chủ sở hữu', type: 'select', required: true, options: owners.map((o) => ({ value: o.id, label: `${o.code} — ${o.name} (${o.owner_type_label})` })) },
          { name: 'serialNumber', label: 'Số máy (SN)', placeholder: 'bắt buộc nếu không có số khung' }, { name: 'chassisNumber', label: 'Số khung' },
          { name: 'brand', label: 'Hãng' }, { name: 'model', label: 'Model' }, { name: 'yearMade', label: 'Năm SX', type: 'number', min: '1980' },
          { name: 'powerHp', label: 'Công suất (HP)', type: 'number' }, { name: 'fuel', label: 'Nhiên liệu', placeholder: 'Diesel' },
          { name: 'ownedSince', label: 'HTX sở hữu từ', type: 'date', value: new Date().toISOString().slice(0, 10), required: true },
          { name: 'condition', label: 'Tình trạng', type: 'select', options: Object.entries(CONDITION).map(([value, label]) => ({ value, label })) },
        ], async (v) => { const m = await api('/cgh/machines', { body: v }); toast(`Đã thêm máy ${m.code}.`); await draw(); }, { submitLabel: 'Thêm máy' })),
        card('Nhập hàng loạt (US-MAC-02)', [
          el('p', { class: 'muted', text: 'Dán bảng có tiêu đề: machine_type, owner, serial_number hoặc chassis_number, brand, model, year_made, fuel, power_hp, owned_since, condition. KHÔNG có cột mã máy (hệ thống tự sinh).' }),
          form([
            { name: 'htxId', label: 'HTX', type: 'select', required: true, options: cooperatives.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}`, selected: c.id === htxId })) },
            { name: 'mode', label: 'Chế độ', type: 'select', options: [{ value: 'cap_nhat', label: 'Cập nhật — thêm/sửa theo SN, giữ máy không có trong tệp' }, { value: 'thay_the', label: 'Thay thế toàn bộ — máy không có trong tệp bị vô hiệu hoá' }] },
            { name: 'text', label: 'Dữ liệu', type: 'textarea', rows: 5, required: true, placeholder: 'machine_type\towner\tserial_number\tbrand\towned_since\nMáy gặt đập liên hợp\tCSH-AG-00001\tKB-2231\tKubota\t2025-11-01' },
          ], async (v) => {
            if (v.mode === 'thay_the' && !(await confirmDialog('Chế độ THAY THẾ sẽ vô hiệu hoá mọi máy của HTX không có trong tệp. Tiếp tục?', { danger: true, okLabel: 'Thay thế' }))) throw new Error('Đã huỷ.');
            const out = await api('/cgh/machines/import', { body: { htxId: v.htxId, mode: v.mode, text: v.text } });
            toast(`Tạo ${out.created} · cập nhật ${out.updated} · vô hiệu ${out.deactivated} · lỗi ${out.errors.length}.`, out.errors.length > 0);
            if (out.errors.length) modal('Dòng lỗi', table([{ key: 'row', label: 'Dòng' }, { key: 'reason', label: 'Lý do' }], out.errors, { plain: true }));
            await draw();
          }, { submitLabel: 'Nhập' }),
        ]),
      ]) : null,
      body,
    );
    await draw();
  },
});

// ===========================================================================
// Chủ sở hữu — US-OWN-01
// ===========================================================================

registerPage('cgh-owners', {
  title: 'Chủ sở hữu máy',
  subtitle: 'Mã CSH-<tỉnh>-xxxxx tự sinh · 4 loại chủ sở hữu · Thành viên HTX / HTX phải gắn đúng một HTX · vô hiệu hoá kèm máy',
  async render(view) {
    const [ownerTypes, cooperatives] = await Promise.all([api('/cgh/owner-types'), api('/mdm/cooperatives')]);
    let includeInactive = false;
    const body = el('div');
    async function draw() {
      const owners = await guard(api(`/cgh/owners${includeInactive ? '?all=1' : ''}`));
      body.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Chủ sở hữu', num(owners.filter((o) => o.status !== 'inactive').length), null, null, 'users'),
          kpi('Thành viên HTX', num(owners.filter((o) => o.owner_type === 'thanh_vien_htx').length), null, null, 'user'),
          kpi('Doanh nghiệp / khác', num(owners.filter((o) => o.owner_type === 'doanh_nghiep' || o.owner_type === 'khac').length), null, null, 'building'),
          kpi('Máy đang gắn', num(owners.reduce((a, o) => a + (o.machine_count ?? 0), 0)), null, null, 'tractor'),
        ]),
        card('Danh sách chủ sở hữu', table([
          { key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }, { key: 'owner_type_label', label: 'Loại', render: (r) => badge(r.owner_type_label, 'neutral') },
          { key: 'htx_name', label: 'HTX liên kết', render: (r) => r.htx_name ?? '—' }, { key: 'phone', label: 'SĐT', render: (r) => r.phone ?? '—' }, { key: 'machine_count', label: 'Máy', align: 'right' },
          { key: 'status', label: 'Trạng thái', render: (r) => badge(r.status === 'inactive' ? 'Vô hiệu' : 'Hoạt động', r.status === 'inactive' ? 'neutral' : 'good') },
          { key: 'act', label: '', render: (r) => (can('cgh.write') ? (r.status === 'inactive'
            ? el('button', { class: 'ghost small', onclick: async () => { await guard(api(`/cgh/owners/${r.id}/reactivate`, { body: {} })); toast('Đã kích hoạt lại.'); await draw(); } }, ['Kích hoạt'])
            : el('button', { class: 'ghost small danger', onclick: async () => { const out = await guard(apiConfirm(`/cgh/owners/${r.id}/deactivate`, { body: {} })); toast(`Đã vô hiệu hoá${out.machinesDeactivated ? ` cùng ${out.machinesDeactivated} máy` : ''}.`); await draw(); } }, [icon('trash', 14), 'Vô hiệu hoá'])) : '—') },
        ], owners, { empty: 'Chưa có chủ sở hữu.' })),
      );
    }
    view.replaceChildren(
      el('div', { class: 'row' }, [el('label', { class: 'pick-item' }, [el('input', { type: 'checkbox', onchange: (e) => { includeInactive = e.target.checked; draw(); } }), 'Hiện đã vô hiệu hoá'])]),
      can('cgh.write') ? card('Thêm chủ sở hữu', form([
        { name: 'name', label: 'Tên chủ sở hữu', required: true },
        { name: 'ownerType', label: 'Loại', type: 'select', required: true, options: Object.entries(ownerTypes).map(([value, label]) => ({ value, label })) },
        { name: 'htxId', label: 'HTX liên kết', type: 'select', options: [{ value: '', label: '— Không gắn (DN / đơn vị khác) —' }, ...cooperatives.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))] },
        { name: 'phone', label: 'SĐT', placeholder: '09xxxxxxxx' },
      ], async (v) => { const o = await api('/cgh/machine-owners', { body: { ...v, htxId: v.htxId || undefined, phone: v.phone || undefined } }); toast(`Đã thêm chủ sở hữu ${o.code}.`); await draw(); }, { submitLabel: 'Thêm' })) : null,
      body,
    );
    await draw();
  },
});

// ===========================================================================
// Danh mục & ngưỡng — US-CFG
// ===========================================================================

registerPage('cgh-catalog', {
  title: 'Danh mục & ngưỡng cảnh báo',
  subtitle: 'Chủng loại máy (ngừng dùng / xoá khi chưa tham chiếu) · ngưỡng đáp ứng theo phiên bản hiệu lực · lịch sử cấu hình không ghi đè',
  async render(view) {
    view.replaceChildren(tabs([
      { id: 'types', label: 'Chủng loại máy', icon: 'tractor', render: renderTypes },
      { id: 'thresholds', label: 'Ngưỡng cảnh báo', icon: 'scale', render: renderThresholds },
      { id: 'history', label: 'Lịch sử cấu hình', icon: 'history', render: renderHistory },
    ]));
    async function renderTypes(panel) {
      const types = await guard(api('/cgh/machine-types/all'));
      panel.replaceChildren(
        can('cgh.write') ? card('Thêm chủng loại', form([
          { name: 'code', label: 'Mã', required: true, placeholder: 'VD: MAY-GAT-DL' }, { name: 'name', label: 'Tên', required: true },
          { name: 'stage', label: 'Khâu', type: 'select', required: true, options: stageOptions() },
        ], async (v) => { await api('/cgh/machine-types', { body: v }); toast('Đã thêm chủng loại.'); await renderTypes(panel); }, { submitLabel: 'Thêm' })) : null,
        table([
          { key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage },
          { key: 'machine_count', label: 'Máy tham chiếu', align: 'right' }, { key: 'norm_count', label: 'Định mức', align: 'right' },
          { key: 'active', label: 'Trạng thái', render: (r) => badge(r.active ? 'Đang dùng' : 'Ngừng sử dụng', r.active ? 'good' : 'neutral') },
          { key: 'act', label: '', render: (r) => (can('cgh.write') ? el('span', { class: 'chip-row' }, [
            el('button', { class: 'ghost small', onclick: async () => { const out = await guard(api(`/cgh/machine-types/${r.id}/active`, { body: { active: !r.active } })); toast(r.active ? `Đã ngừng sử dụng — ${out.affectedMachines} máy hiện có vẫn giữ nguyên.` : 'Đã kích hoạt lại.'); await renderTypes(panel); } }, [r.active ? 'Ngừng dùng' : 'Kích hoạt']),
            !r.machine_count && !r.norm_count ? el('button', { class: 'ghost small danger', onclick: async () => { if (!(await confirmDialog(`Xoá chủng loại ${r.name}? Chỉ xoá được khi chưa có máy/định mức tham chiếu.`, { danger: true }))) return; await guard(api(`/cgh/machine-types/${r.id}`, { method: 'DELETE' })); toast('Đã xoá.'); await renderTypes(panel); } }, [icon('trash', 14)]) : null,
          ]) : '—') },
        ], types, { empty: 'Chưa có chủng loại.' }),
      );
    }
    async function renderThresholds(panel) {
      const t = await guard(api('/cgh/thresholds'));
      panel.replaceChildren(
        card('Đang áp dụng', [bandLegend(t.bands), el('p', { class: 'muted', text: `Cần chú ý < ${t.current.canChuY}% ≤ … < ${t.current.du}% Đủ … ≥ ${t.current.thua}% Thừa · hiệu lực ${dateOnly(t.current.effectiveFrom)} · ${t.current.documentRef ?? ''}` })]),
        can('cgh.write') ? card('Ban hành bộ ngưỡng mới (áp cho vụ có ngày ≥ hiệu lực)', form([
          { name: 'canChuY', label: 'Mốc Cần chú ý (%)', type: 'number', required: true, value: t.current.canChuY }, { name: 'du', label: 'Mốc Đủ (%)', type: 'number', required: true, value: t.current.du },
          { name: 'thua', label: 'Mốc Thừa (%)', type: 'number', required: true, value: t.current.thua }, { name: 'effectiveFrom', label: 'Hiệu lực từ', type: 'date', required: true }, { name: 'documentRef', label: 'Văn bản', placeholder: 'QĐ …/QĐ-KTHT' },
        ], async (v) => { await api('/cgh/thresholds', { body: v }); toast('Đã ban hành bộ ngưỡng mới.'); await renderThresholds(panel); }, { submitLabel: 'Ban hành' })) : null,
        card('Các phiên bản', table([
          { key: 'effectiveFrom', label: 'Hiệu lực từ', render: (r) => dateOnly(r.effectiveFrom) }, { key: 'canChuY', label: 'Cần chú ý <', align: 'right', render: (r) => `${r.canChuY}%` },
          { key: 'du', label: 'Đủ ≥', align: 'right', render: (r) => `${r.du}%` }, { key: 'thua', label: 'Thừa ≥', align: 'right', render: (r) => `${r.thua}%` }, { key: 'documentRef', label: 'Văn bản', render: (r) => r.documentRef ?? '—' },
        ], t.versions)),
      );
    }
    async function renderHistory(panel) {
      let entityType = 'machine_types';
      const out = el('div');
      const draw = async () => {
        const rows = await guard(api(`/cgh/history?entityType=${entityType}`));
        out.replaceChildren(table([
          { key: 'occurred_at', label: 'Lúc', render: (r) => dateTime(r.occurred_at) }, { key: 'action', label: 'Hành động' }, { key: 'entity_id', label: 'Bản ghi' }, { key: 'actor_name', label: 'Người' },
          { key: 'diff', label: 'Thay đổi', render: (r) => el('details', { class: 'raw' }, [el('summary', { class: 'muted', text: 'xem' }), el('pre', { text: `TRƯỚC: ${String(r.before_json ?? '—').slice(0, 500)}\nSAU:   ${String(r.after_json ?? '—').slice(0, 500)}` })]) },
        ], rows, { empty: 'Chưa có thay đổi.' }));
      };
      panel.replaceChildren(chips([{ value: 'machine_types', label: 'Chủng loại' }, { value: 'productivity_norms', label: 'Định mức' }, { value: 'system_config', label: 'Ngưỡng' }, { value: 'machine_owners', label: 'Chủ máy' }], entityType, (v) => { entityType = v; draw(); }), out);
      await draw();
    }
  },
});

// ===========================================================================
// FN-02 — Định mức năng suất
// ===========================================================================

registerPage('cgh-norms', {
  title: 'Định mức năng suất máy',
  subtitle: 'Cơ sở của QT-01. Định mức mới không ghi đè mà có hiệu lực từ ngày chỉ định; không chồng khoảng hiệu lực; phải dẫn văn bản',
  async render(view) {
    const [norms, types] = await Promise.all([guard(api('/cgh/norms/all')), api('/cgh/machine-types')]);
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đang hiệu lực', num(norms.filter((n) => n.in_effect).length), null, null, 'ruler'),
        kpi('Chủng loại máy', num(types.length), null, null, 'tractor'),
        kpi('Thiếu văn bản', num(norms.filter((n) => !n.document_ref).length), 'Không dùng cho báo cáo chính thức', null, 'warning'),
      ]),
      can('cgh.write') ? card('Ban hành định mức mới', form([
        { name: 'machineTypeId', label: 'Chủng loại', type: 'select', required: true, options: types.map((t) => ({ value: t.id, label: `${t.name} (${STAGE[t.stage] ?? t.stage})` })) },
        { name: 'haPerMachineSeason', label: 'ha / máy / vụ', type: 'number', required: true, step: '0.1', min: '0.1' },
        { name: 'effectiveFrom', label: 'Hiệu lực từ', type: 'date', required: true }, { name: 'effectiveTo', label: 'Hiệu lực đến (tuỳ chọn)', type: 'date' },
        { name: 'documentRef', label: 'Văn bản ban hành', required: true, placeholder: 'VD: QĐ 1234/QĐ-BNN' }, { name: 'documentDate', label: 'Ngày văn bản', type: 'date' },
      ], async (v) => { await api('/cgh/norms', { body: { ...v, stage: types.find((t) => t.id === v.machineTypeId)?.stage, effectiveTo: v.effectiveTo || undefined, documentDate: v.documentDate || undefined } }); toast('Đã ban hành định mức mới.'); await this.render(view); }, { submitLabel: 'Ban hành' })) : null,
      card('Định mức', table([
        { key: 'machine_name', label: 'Chủng loại' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage },
        { key: 'ha_per_machine_season', label: 'ha/máy/vụ', align: 'right', render: (r) => num(r.ha_per_machine_season) },
        { key: 'effective_from', label: 'Từ', render: (r) => dateOnly(r.effective_from) }, { key: 'effective_to', label: 'Đến', render: (r) => (r.effective_to ? dateOnly(r.effective_to) : 'Không giới hạn') },
        { key: 'document_ref', label: 'Văn bản', render: (r) => (r.document_ref ? `${r.document_ref}${r.document_date ? ` (${dateOnly(r.document_date)})` : ''}` : badge('Thiếu văn bản', 'warn')) },
        { key: 'in_effect', label: '', render: (r) => (r.in_effect ? badge('Hiệu lực', 'good') : badge('Ngoài hiệu lực', 'neutral')) },
        { key: 'act', label: '', render: (r) => (can('cgh.write') && r.in_effect && !r.effective_to ? el('button', { class: 'ghost small', onclick: async () => { const d = await promptDialog('Kết thúc hiệu lực từ ngày (YYYY-MM-DD)', { value: new Date().toISOString().slice(0, 10) }); if (!d) return; await guard(api(`/cgh/norms/${r.id}/close`, { body: { effectiveTo: d } })); toast('Đã đóng hiệu lực.'); await this.render(view); } }, ['Kết thúc']) : '') },
      ], norms, { empty: 'Chưa ban hành định mức nào.' })),
    );
  },
});

// ===========================================================================
// FN-08 — Kế hoạch canh tác
// ===========================================================================

registerPage('cgh-plans', {
  title: 'Kế hoạch canh tác',
  subtitle: 'Diện tích canh tác theo HTX × mùa vụ × khâu — đầu vào của cân đối cung – cầu (FN-08); số từ Cổng HTX được ưu tiên (QT-03)',
  async render(view) {
    const [balance, cooperatives, seasons] = await Promise.all([guard(api('/cgh/balance')), api('/mdm/cooperatives'), api('/mdm/seasons').catch(() => [])]);
    const manual = balance.rows.filter((r) => r.areaSource !== 'app_htx' && r.areaHa);
    const fromHtx = balance.rows.filter((r) => r.areaSource === 'app_htx');
    const missing = balance.rows.filter((r) => !r.areaHa);
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Dòng từ Cổng HTX', num(fromHtx.length), 'Ưu tiên hơn nhập tay', null, 'check'),
        kpi('Dòng nhập tay', num(manual.length), null, null, 'edit'),
        kpi('Chưa có diện tích', num(missing.length), 'Không cân đối được', null, 'warning'),
      ]),
      can('cgh.write') ? card('Khai báo / cập nhật kế hoạch', form([
        { name: 'htxId', label: 'HTX', type: 'select', required: true, options: cooperatives.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })) },
        { name: 'seasonId', label: 'Mùa vụ', type: 'select', required: true, options: seasons.map((s) => ({ value: s.id, label: s.name })) },
        { name: 'stage', label: 'Khâu', type: 'select', required: true, options: stageOptions() },
        { name: 'areaHa', label: 'Diện tích (ha)', type: 'number', required: true, step: '0.1', min: '0' },
      ], async (v) => { await api('/cgh/cultivation-plans', { body: v }); toast('Đã cập nhật kế hoạch.'); await this.render(view); }, { submitLabel: 'Lưu kế hoạch' })) : null,
      card('Kế hoạch hiện có', table([
        { key: 'htxCode', label: 'Mã' }, { key: 'htxName', label: 'HTX' }, { key: 'seasonName', label: 'Vụ' }, { key: 'stage', label: 'Khâu', render: (r) => STAGE[r.stage] ?? r.stage },
        { key: 'areaHa', label: 'ha', align: 'right', render: (r) => (r.areaHa ? num(r.areaHa) : badge('Chưa có', 'warn')) },
        { key: 'areaSource', label: 'Nguồn', render: (r) => badge(r.areaSource === 'app_htx' ? 'Cổng HTX' : 'Nhập tay', r.areaSource === 'app_htx' ? 'good' : 'neutral') },
      ], balance.rows.slice(0, 300), { empty: 'Chưa có kế hoạch canh tác nào.' })),
    );
  },
});

// ===========================================================================
// Nhật ký hoạt động — US-LOG-01
// ===========================================================================

registerPage('cgh-log', {
  title: 'Nhật ký hoạt động hệ thống',
  subtitle: 'Đăng nhập, thay đổi tài khoản, truy cập bị từ chối — lọc theo loại và khoảng thời gian tối đa 90 ngày',
  async render(view) {
    if (!can('cgh.write')) return view.replaceChildren(alert('Chỉ quản trị viên Bản đồ Cơ giới hoá xem được nhật ký hoạt động.', 'warn'));
    let kind = 'all';
    const from = el('input', { type: 'date', value: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10) });
    const to = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const body = el('div');
    const KIND = { login: ['Đăng nhập', 'info'], access_denied: ['Từ chối truy cập', 'bad'], users: ['Tài khoản', 'warn'] };
    async function draw() {
      try {
        const rows = await api(`/cgh/activity-log?kind=${kind}&from=${from.value}&to=${to.value}`);
        body.replaceChildren(table([
          { key: 'occurred_at', label: 'Lúc', render: (r) => dateTime(r.occurred_at) },
          { key: 'entity_type', label: 'Loại', render: (r) => badge(KIND[r.entity_type]?.[0] ?? r.entity_type, KIND[r.entity_type]?.[1] ?? 'neutral') },
          { key: 'actor_name', label: 'Người', render: (r) => r.actor_name ?? '—' }, { key: 'action', label: 'Hành động' },
          { key: 'after_json', label: 'Chi tiết', render: (r) => el('code', { text: String(r.after_json ?? r.note ?? '').slice(0, 120) }) }, { key: 'source', label: 'Nguồn' },
        ], rows, { empty: 'Không có sự kiện trong khoảng đã chọn.' }));
      } catch (e) { body.replaceChildren(alert(e.message, 'bad')); }
    }
    view.replaceChildren(
      el('div', { class: 'row' }, [
        chips([{ value: 'all', label: 'Tất cả' }, { value: 'login', label: 'Đăng nhập' }, { value: 'account', label: 'Tài khoản' }, { value: 'denied', label: 'Từ chối truy cập' }], kind, (v) => { kind = v; draw(); }),
        el('label', {}, ['Từ', from]), el('label', {}, ['Đến', to]), el('button', { class: 'small', onclick: draw }, [icon('search', 14), 'Xem']),
      ]),
      body,
    );
    await draw();
  },
});
