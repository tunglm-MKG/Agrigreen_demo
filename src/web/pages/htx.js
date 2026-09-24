/**
 * CỔNG HỢP TÁC XÃ — giao diện theo bản mẫu "App Hợp tác xã v5.1" và Backlog v4.0 (epics A–K).
 *
 *   htx-dashboard  Bảng điều hành: thẻ số liệu, lối tắt, biểu đồ sản lượng, bản tin khẩn, lịch gửi báo cáo (US-DASH, US-RPT)
 *   htx-news       Bản tin & cảnh báo khuyến nông cho nông dân (US-NEWS-01..03)
 *   htx-farmers    Nông dân thành viên: thêm/sửa/nhập hàng loạt (US-HH-01..03)
 *   htx-plots      Thửa ruộng: vẽ ≥ 4 điểm, kiểm tra chồng lấn, GPS, tải KML/GeoJSON (US-PLOT-01..05)
 *   htx-cycles     Mùa vụ: wizard 4 bước, mở nhiều thửa, sao chép vụ trước, tự gán SOP theo giống (US-SEASON-01..04)
 *   htx-logs       Nhật ký canh tác: hoạt động, vật tư, GPS, máy móc, ghi nhiều thửa, offline (US-LOG-01..05)
 *   htx-approve    Duyệt nhật ký của nông dân (US-APPR-01..02)
 *   htx-harvest    Khai báo sản lượng: cảnh báo bất thường, khai nhiều vụ, báo cáo (US-HARV-01..03)
 *   htx-support    Yêu cầu hỗ trợ kỹ thuật (FN-12)
 *   htx-advice     Thời tiết & khuyến cáo (FN-13)
 *
 * Mọi màn hình làm việc trên MỘT hợp tác xã đang chọn; tài khoản gắn HTX bị khoá vào HTX của mình.
 */
import {
  api, apiConfirm, registerPage, el, card, kpi, statCard, table, badge, alert, num, tons, pct, dateTime, dateOnly, state,
  toast, guard, can, form, mapContainer, createMap, LEAFLET_AVAILABLE, navigate, icon, modal, confirmDialog, promptDialog,
  emptyState, svgBarChart, chips, downloadUrl, tabs,
} from '/app.js';

const PLOT_STATUS = {
  chua_mo_vu: { label: 'Chưa mở vụ', tone: 'neutral' },
  dang_canh_tac: { label: 'Đang canh tác', tone: 'good' },
  da_hoan_thanh_vu: { label: 'Đã hoàn thành vụ', tone: 'info' },
};
const APPROVAL = { cho_duyet: ['Chờ duyệt', 'warn'], da_duyet: ['Đã duyệt', 'good'], yeu_cau_bo_sung: ['Yêu cầu bổ sung', 'bad'] };
const ACTIVITY_EMOJI = { lam_dat: '🚜', gieo_sa: '🌱', bon_phan: '🧪', phun_thuoc: '💨', tuoi: '💧', rut_nuoc_awd: '🌊', thu_hoach: '🌾' };
const STRAW_STATE = [['de_tren_ruong', 'Để trên ruộng'], ['da_cuon', 'Đã cuộn'], ['da_ban', 'Đã bán'], ['dot', 'Đốt (không khuyến khích)']];

const STORAGE_KEY = 'mekong-green.htx';
let cachedCooperatives = null;
let gpsLabels = null;

async function cooperatives() {
  if (!cachedCooperatives) {
    const list = await api('/mdm/cooperatives');
    cachedCooperatives = state.user?.htxId ? list.filter((c) => c.id === state.user.htxId) : list;
  }
  return cachedCooperatives;
}
async function labelsGps() { if (!gpsLabels) gpsLabels = await api('/htx/gps-labels').catch(() => ({})); return gpsLabels; }

function currentHtxId(list) {
  if (state.user?.htxId) return state.user.htxId;
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { saved = null; }
  if (saved && list.some((h) => h.id === saved)) return saved;
  return list[0]?.id ?? null;
}
function setHtxId(id) { try { localStorage.setItem(STORAGE_KEY, id); } catch { /* bỏ qua */ } }

/** Bộ chọn HTX ở thanh hành động. Tài khoản gắn HTX chỉ thấy tên đơn vị mình. */
async function htxSelector(actions, onChange) {
  const list = await cooperatives();
  const current = currentHtxId(list);
  const htx = list.find((h) => h.id === current);
  if (list.length <= 1) actions.append(el('span', { class: 'pill' }, [el('span', { class: 'dot' }), htx ? `${htx.code} — ${htx.name}` : 'Chưa gắn HTX']));
  else actions.append(el('label', { class: 'htx-picker' }, [
    el('span', { class: 'muted', text: 'HTX:' }),
    el('select', { onchange: (event) => { setHtxId(event.target.value); onChange(event.target.value); } },
      list.map((h) => el('option', { value: h.id, selected: h.id === current }, [`${h.code} — ${h.name}`]))),
  ]));
  return { id: current, list, htx };
}
const rerender = (page, view, actions) => { actions.replaceChildren(); return page.render(view, actions); };

/** Lấy toạ độ GPS thiết bị; trả về null nếu không có/không cho phép (US-LOG-03: ghi rõ "Không có GPS thiết bị"). */
function deviceGps() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)), accuracy: pos.coords.accuracy }),
      () => resolve(null), { timeout: 6000, maximumAge: 60_000 },
    );
  });
}
function readFile(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result ?? '')); r.onerror = () => reject(new Error('Không đọc được tệp.')); r.readAsText(file); });
}
const quickTile = (ic, label, page) => el('button', { class: 'qtile', onclick: () => navigate(page) }, [el('span', { class: 'qi' }, [icon(ic, 26)]), label]);

// ===========================================================================
// Bảng điều hành HTX
// ===========================================================================

registerPage('htx-dashboard', {
  title: 'Bảng điều hành Hợp tác xã',
  subtitle: 'Thửa ruộng, mùa vụ, sản lượng, nhật ký chờ duyệt và bản tin khuyến nông của đơn vị',
  async render(view, actions) {
    const { id, htx } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào trong dữ liệu dùng chung.', 'warn'));

    const [yieldDash, dashboard, cycles, news, advice] = await Promise.all([
      guard(api(`/htx/yield-dashboard?htxId=${id}`)),
      api(`/htx/dashboard?htxId=${id}`).catch(() => ({})),
      api(`/htx/crop-cycles?htxId=${id}`).catch(() => []),
      api('/htx/news?category=canh_bao').catch(() => ({ items: [] })),
      api(`/htx/advice/${id}`).catch(() => null),
    ]);
    const totals = yieldDash.totals ?? {};
    const active = cycles.filter((c) => c.status === 'dang_canh_tac');
    const urgent = (news.items ?? []).filter((n) => n.urgent)[0];
    const today = advice?.forecast?.[0];

    actions.append(
      el('button', { class: 'ghost small', onclick: () => downloadUrl(`/htx/reports/harvest.csv?htxId=${id}`, 'bao-cao-san-luong.csv') }, [icon('download', 15), 'Xuất CSV']),
      el('button', { class: 'ghost small', onclick: () => openSchedules(id) }, [icon('calendar', 15), 'Lịch gửi báo cáo']),
    );

    view.replaceChildren(
      urgent ? el('div', { class: 'alertbar', onclick: () => navigate('htx-news') }, [
        el('span', { class: 'ai' }, [icon('warning', 20)]),
        el('div', { class: 'grow' }, [el('b', { text: urgent.title }), el('div', { class: 'muted', text: urgent.summary ?? urgent.categoryLabel })]),
        badge('KHẨN', 'bad'),
      ]) : null,
      el('div', { class: 'grid cols-4' }, [
        kpi('Thửa ruộng', num(totals.plots), `${num(totals.area_ha, 1)} ha · ${num(totals.farmers)} nông hộ`, null, 'plot'),
        kpi('Vụ đang canh tác', num(active.length), `${num(cycles.length - active.length)} vụ đã hoàn thành`, null, 'seed'),
        kpi('Tiến độ quy trình', totals.sopProgressPct == null ? 'Chưa có SOP' : pct(totals.sopProgressPct, 0), 'Bước đã thực hiện / tổng bước vụ hiện tại', null, 'check'),
        kpi('Nhật ký chờ duyệt', num(totals.pendingApprovals), totals.pendingApprovals ? 'Số liệu tổng hợp đang TẠM TÍNH' : 'Đã duyệt hết', null, 'log'),
      ]),
      el('div', { class: 'grid cols-3', style: 'grid-template-columns:repeat(auto-fit,minmax(90px,1fr))' }, [
        quickTile('log', 'Ghi nhật ký', 'htx-logs'), quickTile('seed', 'Mở vụ', 'htx-cycles'), quickTile('harvest', 'Sản lượng', 'htx-harvest'),
        quickTile('support', 'Hỗ trợ', 'htx-support'), quickTile('users', 'Nông dân', 'htx-farmers'), quickTile('news', 'Bản tin', 'htx-news'),
      ].filter((_, i) => i < (can('htx.write') ? 6 : 6))),
      el('div', { class: 'split wide-left' }, [
        card('Sản lượng theo mùa vụ (dự kiến theo giống vs thực tế)', [
          (yieldDash.bySeason ?? []).length
            ? svgBarChart(yieldDash.bySeason.map((s) => ({ label: s.season_name, value: Math.round(s.expected_tons * 10) / 10, value2: Math.round(s.actual_tons * 10) / 10, color: 'var(--brand)', color2: 'var(--accent)' })), { height: 220, unit: 'tấn' })
            : emptyState('Chưa có mùa vụ nào.', 'seed'),
          el('div', { class: 'legend-row' }, [el('span', {}, [el('i', { style: 'background:var(--brand)' }), 'Dự kiến theo năng suất giống']), el('span', {}, [el('i', { style: 'background:var(--accent)' }), 'Thực tế đã khai báo'])]),
          table([
            { key: 'season_name', label: 'Mùa vụ' }, { key: 'cycles', label: 'Vụ', align: 'right' },
            { key: 'area_ha', label: 'Diện tích', align: 'right', render: (r) => `${num(r.area_ha, 1)} ha` },
            { key: 'harvested', label: 'Đã thu hoạch', align: 'right', render: (r) => `${r.harvested}/${r.cycles}` },
            { key: 'actual_tons', label: 'Lúa thực tế', align: 'right', render: (r) => tons(r.actual_tons) },
          ], yieldDash.bySeason ?? [], { plain: true, empty: 'Chưa có dữ liệu.' }),
        ]),
        el('div', { class: 'stack' }, [
          today ? el('div', { class: 'weather-card' }, [
            el('div', {}, [el('div', { class: 'temp', text: `${num(today.temp_c)}°` }), el('div', { text: `${htx?.name ?? ''} · ${dateOnly(today.observed_for)}` }), el('div', { style: 'opacity:.9;font-size:12.5px', text: `Mưa ${num(today.rainfall_mm)} mm · Ẩm ${num(today.humidity_pct)}%` })]),
            el('div', { class: 'days' }, (advice.forecast ?? []).slice(1, 4).map((d) => el('div', { class: 'day' }, [el('b', { text: `${num(d.temp_c)}°` }), String(d.observed_for).slice(5)]))),
          ]) : null,
          card('Năng suất theo giống', table([
            { key: 'variety', label: 'Giống' }, { key: 'cycles', label: 'Vụ', align: 'right' },
            { key: 'area_ha', label: 'ha', align: 'right', render: (r) => num(r.area_ha, 1) },
            { key: 'yield_t_ha', label: 'Tấn/ha', align: 'right', render: (r) => (r.yield_t_ha == null ? 'Chưa thu hoạch' : num(r.yield_t_ha, 2)) },
          ], yieldDash.byVariety ?? [], { plain: true, empty: 'Chưa có dữ liệu.' })),
        ]),
      ]),
      el('div', { class: 'grid cols-2' }, [
        card('Vụ đang canh tác', table([
          { key: 'code', label: 'Mã vụ' }, { key: 'plot_code', label: 'Thửa' }, { key: 'season_name', label: 'Mùa vụ' }, { key: 'variety', label: 'Giống', render: (r) => r.variety ?? '—' }, { key: 'sowing_date', label: 'Gieo sạ' },
        ], active.slice(0, 8), { empty: 'Không có vụ nào đang canh tác.' }), el('button', { class: 'ghost small', text: 'Quản lý vụ →', onclick: () => navigate('htx-cycles') })),
        card('Nhật ký gần đây', table([
          { key: 'log_date', label: 'Ngày' }, { key: 'plot_code', label: 'Thửa' }, { key: 'activity', label: 'Hoạt động' },
        ], (dashboard.recentLogs ?? []).slice(0, 8), { empty: 'Chưa có nhật ký nào.' }), el('button', { class: 'ghost small', text: 'Mở nhật ký →', onclick: () => navigate('htx-logs') })),
      ]),
    );
  },
});

async function openSchedules(htxId) {
  const list = await api(`/reports/schedules?system=htx&scopeId=${htxId}`).catch(() => []);
  const body = el('div', { class: 'stack' });
  const draw = (rows) => body.replaceChildren(
    rows.length ? table([
      { key: 'report', label: 'Báo cáo' }, { key: 'frequency', label: 'Tần suất', render: (r) => ({ tuan: 'Hàng tuần', thang: 'Hàng tháng', quy: 'Hàng quý' }[r.frequency] ?? r.frequency) },
      { key: 'emails', label: 'Người nhận' }, { key: 'next_run_at', label: 'Lần gửi tới', render: (r) => dateOnly(r.next_run_at) },
      { key: 'x', label: '', render: (r) => el('button', { class: 'ghost small danger', onclick: async () => { await guard(api(`/reports/schedules/${r.id}`, { method: 'DELETE' })); draw(rows.filter((x) => x.id !== r.id)); toast('Đã huỷ lịch.'); } }, [icon('trash', 14)]) },
    ], rows, { plain: true }) : el('p', { class: 'muted', text: 'Chưa có lịch gửi báo cáo.' }),
    form([
      { name: 'report', label: 'Báo cáo', type: 'select', options: [{ value: 'san_luong', label: 'Sản lượng theo vụ' }, { value: 'nhat_ky', label: 'Nhật ký canh tác' }, { value: 'tong_hop', label: 'Tổng hợp HTX' }] },
      { name: 'frequency', label: 'Tần suất', type: 'select', options: [{ value: 'tuan', label: 'Hàng tuần' }, { value: 'thang', label: 'Hàng tháng' }, { value: 'quy', label: 'Hàng quý' }] },
      { name: 'emails', label: 'Email nhận (phân cách bằng dấu phẩy)', required: true, placeholder: 'kt@htx.vn, giamdoc@htx.vn' },
    ], async (v) => { const created = await api('/reports/schedules', { body: { ...v, system: 'htx', scopeId: htxId } }); toast('Đã đặt lịch gửi báo cáo.'); draw([...rows, created]); }, { submitLabel: 'Đặt lịch' }),
  );
  draw(list);
  modal('Lịch gửi báo cáo tự động (US-RPT-03)', body);
}

// ===========================================================================
// Bản tin & cảnh báo — US-NEWS
// ===========================================================================

registerPage('htx-news', {
  title: 'Bản tin & cảnh báo khuyến nông',
  subtitle: 'Kỹ thuật canh tác, cảnh báo dịch hại / thời tiết, chính sách, thị trường — do Khuyến nông xuất bản',
  async render(view) {
    let category = ''; let q = '';
    const list = el('div', { class: 'stack' });
    const search = el('input', { placeholder: 'Tìm bài viết…', oninput: (e) => { q = e.target.value.trim(); draw(); } });
    const catBox = el('div');
    async function draw() {
      const data = await guard(api(`/htx/news?${category ? `category=${category}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`));
      if (!catBox.childElementCount) catBox.append(chips([{ value: '', label: 'Tất cả' }, ...Object.entries(data.categories).map(([value, label]) => ({ value, label }))], category, (v) => { category = v; draw(); }));
      list.replaceChildren(...(data.items.length ? data.items.map((n) => el('div', { class: `card news-card${n.urgent ? ' urgent' : ''}`, onclick: () => openArticle(n) }, [
        el('div', { class: 'thumb', text: n.urgent ? '⚠️' : ({ ky_thuat: '📗', chinh_sach: '📜', thi_truong: '💹', su_kien: '📅', canh_bao: '⚠️' }[n.category] ?? '📰') }),
        el('div', { class: 'body' }, [
          el('div', { class: 'chip-row', style: 'margin-bottom:4px' }, [n.urgent ? badge('KHẨN', 'bad') : null, badge(n.categoryLabel, 'neutral'), n.region_label ? el('span', { class: 'std prov', text: n.region_label }) : el('span', { class: 'std', text: 'CHUẨN QUỐC GIA' })]),
          el('b', { text: n.title }),
          el('div', { class: 'muted', text: n.summary ?? '' }),
          el('div', { class: 'muted', text: `${dateOnly(n.published_at)} · ${num(n.view_count)} lượt xem${n.parent_id ? ' · bổ sung địa phương' : ''}` }),
        ]),
      ])) : [emptyState('Không có bài viết phù hợp.', 'news')]));
    }
    function openArticle(n) {
      api(`/htx/news/${n.id}/viewed`, { body: {} }).catch(() => undefined);
      modal(n.title, [
        el('div', { class: 'chip-row' }, [n.urgent ? badge('KHẨN', 'bad') : null, badge(n.categoryLabel, 'neutral'), n.crop ? badge(n.crop, 'info') : null, el('span', { class: 'muted', text: dateOnly(n.published_at) })]),
        n.summary ? el('p', { style: 'font-weight:600', text: n.summary }) : null,
        el('div', { style: 'white-space:pre-wrap;line-height:1.7', text: n.body ?? '' }),
      ], [], { wide: true });
    }
    view.replaceChildren(el('div', { class: 'row' }, [search]), catBox, list);
    await draw();
  },
});

// ===========================================================================
// Nông dân thành viên — US-HH
// ===========================================================================

registerPage('htx-farmers', {
  title: 'Nông dân thành viên',
  subtitle: 'Danh sách nông hộ của HTX, thửa ruộng gắn với từng hộ; thêm từng người hoặc nhập hàng loạt',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
    let q = '';
    let reveal = false;
    const body = el('div');
    if (can('htx.write')) {
      actions.append(el('button', { class: 'ghost small', onclick: (e) => { reveal = !reveal; e.currentTarget.replaceChildren(icon(reveal ? 'lock' : 'eye', 15), reveal ? 'Che số điện thoại' : 'Hiện số điện thoại'); draw(); } }, [icon('eye', 15), 'Hiện số điện thoại']));
    }
    const farmerStats = await api(`/mdm/farmers/summary?htxId=${id}`).catch(() => null);
    const draw = async () => {
      // NĐ 13/2023: số điện thoại che mặc định; chỉ người có quyền ghi mở xem và mỗi lần mở đều được ghi nhật ký.
      const farmers = await guard(api(`/htx/farmers?htxId=${id}${q ? `&q=${encodeURIComponent(q)}` : ''}${reveal ? '&reveal=1' : ''}`));
      body.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Nông hộ', num(farmerStats?.total ?? farmers.length), null, null, 'users'),
          kpi('Có thửa ruộng', num(farmerStats?.with_plots ?? farmers.filter((f) => f.plot_count > 0).length), null, null, 'plot'),
          kpi('Tổng diện tích', `${num(farmerStats?.total_area_ha ?? farmers.reduce((a, f) => a + (f.area_ha ?? 0), 0), 1)} ha`, null, null, 'ruler'),
          kpi('Có số điện thoại', num(farmerStats?.with_phone ?? farmers.filter((f) => f.phone).length), 'Nhận cảnh báo qua SMS/Zalo', null, 'phone'),
        ]),
        card('Danh sách nông hộ', table([
          { key: 'code', label: 'Mã' }, { key: 'full_name', label: 'Họ tên' }, { key: 'phone', label: 'SĐT', render: (r) => r.phone ?? '—' },
          { key: 'plot_count', label: 'Thửa', align: 'right' }, { key: 'area_ha', label: 'Diện tích', align: 'right', render: (r) => `${num(r.area_ha, 2)} ha` },
          { key: 'status', label: 'Trạng thái', render: (r) => badge(r.status === 'active' ? 'Đang hoạt động' : 'Ngừng', r.status === 'active' ? 'good' : 'neutral') },
          { key: 'act', label: '', render: (r) => (can('htx.write') ? el('button', { class: 'ghost small', onclick: () => editFarmer(r) }, [icon('edit', 14), 'Sửa']) : '—') },
        ], farmers, { empty: q ? 'Không tìm thấy nông hộ phù hợp với từ khoá.' : 'Chưa có nông hộ nào.' })),
      );
    };
    function editFarmer(f) {
      const dlg = modal(`Sửa nông hộ ${f.code}`, form([
        { name: 'fullName', label: 'Họ tên', value: f.full_name, required: true }, { name: 'phone', label: 'SĐT', value: f.phone ?? '' },
        { name: 'nationalId', label: 'CCCD', value: f.national_id ?? '' }, { name: 'address', label: 'Địa chỉ', value: f.address ?? '' },
        { name: 'status', label: 'Trạng thái', type: 'select', options: [{ value: 'active', label: 'Đang hoạt động', selected: f.status === 'active' }, { value: 'inactive', label: 'Ngừng', selected: f.status !== 'active' }] },
      ], async (v) => { await api(`/htx/farmers/${f.id}`, { method: 'PUT', body: v }); toast('Đã cập nhật nông hộ.'); dlg.close(); await draw(); }, { submitLabel: 'Lưu', stacked: true, resetOnSuccess: false }));
    }
    view.replaceChildren(
      el('div', { class: 'row' }, [el('input', { placeholder: 'Tìm theo tên, SĐT, mã…', oninput: (e) => { q = e.target.value.trim(); draw(); } })]),
      can('htx.write') ? el('div', { class: 'grid cols-2' }, [
        card('Thêm nông hộ', form([
          { name: 'fullName', label: 'Họ tên', required: true }, { name: 'phone', label: 'SĐT (09xxxxxxxx)', placeholder: '0912345678' },
          { name: 'nationalId', label: 'CCCD' }, { name: 'address', label: 'Địa chỉ' },
        ], async (v) => { await api('/htx/farmers', { body: { ...v, htxId: id } }); toast('Đã thêm nông hộ.'); await draw(); }, { submitLabel: 'Thêm nông hộ' })),
        card('Nhập hàng loạt (dán từ Excel)', [
          el('p', { class: 'muted', text: 'Dòng đầu là tiêu đề: full_name, phone, national_id, address (phân cách bằng tab hoặc dấu phẩy). Dòng lỗi được báo rõ, các dòng hợp lệ vẫn được lưu.' }),
          form([{ name: 'text', label: 'Dữ liệu', type: 'textarea', rows: 5, required: true, placeholder: 'full_name\tphone\nNguyễn Văn A\t0912345678' }],
            async (v) => { const out = await api('/htx/farmers/import', { body: { htxId: id, text: v.text } }); toast(`Đã tạo ${out.created} nông hộ; ${out.errors.length} dòng lỗi${out.errors.length ? `: dòng ${out.errors[0].row} — ${out.errors[0].reason}` : ''}.`, out.errors.length > 0); await draw(); }, { submitLabel: 'Nhập' }),
        ]),
      ]) : null,
      body,
    );
    await draw();
  },
});

// ===========================================================================
// Thửa ruộng & GPS — US-PLOT
// ===========================================================================

registerPage('htx-plots', {
  title: 'Thửa ruộng & ranh giới GPS',
  subtitle: 'Vẽ ranh giới ≥ 4 điểm hoặc tải KML/GeoJSON · hệ thống kiểm tra chồng lấn và tự tính diện tích',
  async render(view, actions) {
    const { id, list } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
    const [plots, farmers, plotStats] = await Promise.all([guard(api(`/mdm/plots?htxId=${id}`)), api(`/htx/farmers?htxId=${id}`).catch(() => []), api(`/mdm/plots/summary?htxId=${id}`).catch(() => null)]);
    const mapNode = mapContainer('htx-plot-map', 'tall');
    const drawing = [];
    let map = null; let shapes = [];
    const counter = el('span', { class: 'muted', text: '0 điểm' });
    const overlapBox = el('div');
    const nameInput = el('input', { placeholder: 'Tên thửa (tuỳ chọn)' });
    const farmerSel = el('select', {}, [el('option', { value: '' }, ['— Chưa gán nông hộ —']), ...farmers.map((f) => el('option', { value: f.id }, [`${f.code} — ${f.full_name}`]))]);
    const writable = can('htx.write') || can('mdm.write');

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Thửa ruộng', num(plotStats?.total ?? plots.length), null, null, 'plot'),
        kpi('Tổng diện tích', `${num(plotStats?.total_area_ha ?? plots.reduce((a, p) => a + p.area_ha, 0), 2)} ha`, 'Tính từ polygon — không nhập tay', null, 'ruler'),
        kpi('Chưa mở vụ', num(plotStats?.not_planted ?? plots.filter((p) => p.status === 'chua_mo_vu').length), 'Sẵn sàng mở vụ mới', null, 'seed'),
        kpi('Đã gán nông hộ', num(plotStats?.assigned ?? plots.filter((p) => p.farmer_id).length), null, null, 'users'),
      ]),
      el('div', { class: 'split' }, [
        el('div', { class: 'stack' }, [
          writable ? card('Vẽ thửa mới', [
            el('p', { class: 'muted', text: 'Nhấp ≥ 4 điểm theo viền thửa (hoặc dùng GPS thiết bị tại từng góc). Hệ thống kiểm tra chồng lấn với thửa khác trước khi lưu.' }),
            el('div', { class: 'row' }, [el('label', {}, ['Tên', nameInput]), el('label', {}, ['Nông hộ', farmerSel])]),
            el('div', { class: 'chip-row' }, [
              el('button', { class: 'ghost small', onclick: async () => { const p = await deviceGps(); if (!p) return toast('Không có GPS thiết bị — nhấp trên bản đồ.', true); drawing.push({ lat: p.lat, lng: p.lng }); redraw(); if (map) map.setView([p.lat, p.lng], 17); } }, [icon('gps', 14), 'Thêm điểm GPS']),
              el('button', { class: 'ghost small', onclick: () => { drawing.pop(); redraw(); } }, [icon('back', 14), 'Xoá điểm cuối']),
              el('button', { class: 'ghost small', onclick: () => { drawing.length = 0; redraw(); } }, [icon('trash', 14), 'Xoá hết']),
              counter,
            ]),
            overlapBox,
            el('button', { class: 'small', onclick: () => savePlot() }, [icon('check', 14), 'Kiểm tra & lưu thửa']),
          ]) : null,
          writable ? card('Tải KML / GeoJSON hoặc dán toạ độ', tabs([
            { id: 'file', label: 'Tệp', render: (p) => {
              const input = el('input', { type: 'file', accept: '.kml,.geojson,.json' });
              p.append(el('label', {}, ['Tệp KML / GeoJSON', input]), el('button', { class: 'small', style: 'margin-top:8px', onclick: async () => {
                const file = input.files?.[0]; if (!file) return toast('Chọn tệp trước.', true);
                const content = await readFile(file);
                let out = await guard(api('/htx/plots/import', { body: { htxId: id, content, fileName: file.name } }));
                const pending = out.errors.filter((e) => e.needsConfirm);
                if (pending.length && await confirmDialog(`${pending.length} thửa trong tệp chồng lấn với thửa đã có của HTX. Vẫn lưu các thửa này?`, { title: 'Cần xác nhận chồng lấn', okLabel: 'Vẫn lưu', extra: [el('ul', {}, pending.slice(0, 6).map((e) => el('li', { text: `${e.name ?? `Đối tượng ${e.index}`}: ${e.reason}` })))] })) {
                  const again = await guard(api('/htx/plots/import', { body: { htxId: id, content, fileName: file.name, confirmOverlap: true } }));
                  out = { ...again, created: out.created + again.created, errors: again.errors };
                }
                if (out.errors.length) modal('Đối tượng chưa nạp được', table([{ key: 'index', label: '#' }, { key: 'name', label: 'Tên', render: (r) => r.name ?? '—' }, { key: 'reason', label: 'Lý do' }], out.errors, { plain: true }));
                toast(`Tạo ${out.created} thửa; ${out.errors.length} đối tượng bị từ chối.`, out.errors.length > 0);
                if (out.created) await rerender(this, view, actions);
              } }, [icon('upload', 14), 'Nạp']));
            } },
            { id: 'text', label: 'Dán toạ độ', render: (p) => {
              p.append(form([{ name: 'coordinates', label: 'Mỗi dòng "lat, lng" (≥ 4 dòng, không thẳng hàng)', type: 'textarea', rows: 5, required: true, placeholder: '10.3812, 105.4421\n10.3815, 105.4432\n…' }, { name: 'name', label: 'Tên thửa' }],
                async (v) => {
                  const lines = v.coordinates.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  if (lines.length < 4) throw new Error(`Cần tối thiểu 4 điểm ranh giới, hiện có ${lines.length}.`);
                  const out = await apiConfirm('/htx/plots/import', { body: { htxId: id, coordinates: v.coordinates, name: v.name || undefined } }, 'confirmOverlap');
                  toast(`Đã tạo thửa ${out.plot?.code ?? ''} — ${out.plot?.areaLabel ?? ''}.`); await rerender(this, view, actions);
                }, { submitLabel: 'Kiểm tra & tạo thửa' }));
            } },
          ])) : null,
          card('Danh sách thửa', table([
            { key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên', render: (r) => r.name ?? '—' },
            { key: 'area_ha', label: 'ha', align: 'right', render: (r) => num(r.area_ha, 3) },
            { key: 'status', label: 'Trạng thái', render: (r) => badge(PLOT_STATUS[r.status]?.label ?? r.status, PLOT_STATUS[r.status]?.tone ?? 'neutral') },
            { key: 'act', label: '', render: (r) => el('span', { class: 'chip-row' }, [
              el('button', { class: 'ghost small', title: 'Xác minh vị trí GPS', onclick: async () => {
                const p = await deviceGps();
                const raw = p ? `${p.lat}, ${p.lng}` : await promptDialog('Toạ độ GPS hiện tại (lat, lng)', { value: '10.38, 105.44', message: 'Thiết bị không cung cấp GPS — nhập tay để kiểm tra.' });
                if (!raw) return;
                const [lat, lng] = raw.split(',').map((v) => Number(v.trim()));
                const result = await guard(api('/htx/verify-location', { body: { plotId: r.id, lat, lng } }));
                toast(result.inside ? `Vị trí khớp — cách tâm thửa ${num(result.distanceKm * 1000)} m.` : `Vị trí KHÔNG khớp: cách tâm ${num(result.distanceKm, 2)} km (ngưỡng ${num(result.toleranceKm, 2)} km).`, !result.inside);
              } }, [icon('gps', 14)]),
              map ? el('button', { class: 'ghost small', title: 'Xem trên bản đồ', onclick: () => { if (r.boundaryGeo && map) map.fitBounds(window.L.geoJSON(r.boundaryGeo).getBounds()); } }, [icon('map', 14)]) : null,
              can('mdm.write') ? el('button', { class: 'ghost small danger', title: 'Xoá mềm', onclick: async () => { const reason = await promptDialog(`Xoá thửa ${r.code}`, { placeholder: 'Lý do' }); if (reason === null) return; await guard(api(`/mdm/plots/${r.id}`, { method: 'DELETE', body: { reason } })); toast('Đã xoá (có thể khôi phục ở GIS › Quản trị).'); await rerender(this, view, actions); } }, [icon('trash', 14)]) : null,
            ]) },
          ], plots, { empty: 'HTX chưa có thửa nào — vẽ trên bản đồ hoặc tải tệp.' })),
        ]),
        card('Bản đồ thửa ruộng', mapNode),
      ]),
    );

    function redraw() {
      counter.textContent = `${drawing.length} điểm${drawing.length && drawing.length < 4 ? ' (cần ≥ 4)' : ''}`;
      overlapBox.replaceChildren();
      if (!map) return;
      shapes.forEach((s) => map.removeLayer(s)); shapes = [];
      if (drawing.length >= 2) shapes.push(window.L.polygon(drawing.map((p) => [p.lat, p.lng]), { color: '#00A3E0', weight: 2, fillOpacity: 0.2 }).addTo(map));
      drawing.forEach((p, i) => shapes.push(window.L.circleMarker([p.lat, p.lng], { radius: 5, color: '#00A3E0', fillOpacity: 1 }).bindTooltip(`Điểm ${i + 1}`).addTo(map)));
    }
    async function savePlot() {
      if (drawing.length < 4) return toast('Ranh giới thửa cần tối thiểu 4 điểm.', true);
      const check = await guard(api('/htx/plots/overlap-check', { body: { boundary: drawing } }));
      if (check.overlaps.length) {
        overlapBox.replaceChildren(alert(`Chồng lấn với ${check.overlaps.length} thửa: ${check.overlaps.map((o) => o.code).join(', ')}. ${check.overlaps.some((o) => o.htxId !== id) ? 'Có thửa thuộc HTX khác — không thể lưu.' : 'Xác nhận để vẫn lưu.'}`, 'warn'));
      }
      const created = await guard(apiConfirm('/htx/plots', { body: { htxId: id, boundary: drawing, name: nameInput.value.trim() || undefined, farmerId: farmerSel.value || undefined, source: 've_tay' } }, 'confirmOverlap'));
      toast(`Đã tạo thửa ${created.code} — ${created.areaLabel ?? `${num(created.area_ha, 3)} ha`} (hệ thống tự tính).`);
      drawing.length = 0;
      await rerender(this, view, actions);
    }
    if (LEAFLET_AVAILABLE()) {
      const htx = list.find((c) => c.id === id);
      map = createMap('htx-plot-map', [htx?.lat ?? 10.2, htx?.lng ?? 105.8], 13);
      map.on('click', (e) => { if (!writable) return; drawing.push({ lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) }); redraw(); });
      const group = [];
      for (const plot of plots) {
        if (!plot.boundaryGeo) continue;
        group.push(window.L.geoJSON(plot.boundaryGeo, { style: { color: plot.status === 'dang_canh_tac' ? '#00A82D' : '#64748B', weight: 2, fillOpacity: 0.22 } }).bindTooltip(`${plot.code} — ${num(plot.area_ha, 3)} ha`).addTo(map));
      }
      if (group.length) map.fitBounds(window.L.featureGroup(group).getBounds(), { padding: [30, 30] });
    }
    redraw();
  },
});

// ===========================================================================
// Mùa vụ — US-SEASON (wizard 4 bước)
// ===========================================================================

registerPage('htx-cycles', {
  title: 'Mùa vụ canh tác',
  subtitle: 'Mở vụ theo 4 bước cho một hoặc nhiều thửa; giống lúa tự gán quy trình chuẩn; vụ đã khai sản lượng sẽ đóng',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
    const [cycles, plots, seasons, varieties, protocols] = await Promise.all([
      guard(api(`/htx/crop-cycles?htxId=${id}`)), api(`/mdm/plots?htxId=${id}`), api('/mdm/seasons'),
      api('/mdm/rice-varieties').catch(() => []), api('/production/protocols?status=published').catch(() => []),
    ]);
    const openPlots = plots.filter((p) => p.status === 'chua_mo_vu');
    const wizardBox = el('div');
    const stepState = { plotIds: new Set(), seasonId: seasons[0]?.id ?? '', varietyId: varieties[0]?.id ?? '', variety: varieties[0]?.name ?? '', sowingDate: new Date().toISOString().slice(0, 10), protocolId: '' };
    let step = 0;
    const today = new Date();
    const minDate = new Date(today.getTime() - 15 * 86_400_000).toISOString().slice(0, 10);
    const maxDate = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

    const drawWizard = () => {
      if (!can('htx.write')) return wizardBox.replaceChildren();
      if (!openPlots.length) return wizardBox.replaceChildren(card('Mở vụ canh tác', alert('Mọi thửa đều đang có vụ. Khai báo sản lượng để đóng vụ trước khi mở vụ mới.', 'info')));
      const steps = ['Chọn thửa', 'Mùa vụ & giống', 'Ngày sạ & quy trình', 'Xác nhận'];
      const header = el('div', { class: 'wizard-steps' }, steps.map((s, i) => el('span', { class: `wizard-step${i < step ? ' done' : i === step ? ' now' : ''}` }, [el('i', { text: i < step ? '✓' : String(i + 1) }), s])));
      let content;
      if (step === 0) {
        content = el('div', { class: 'stack' }, [
          el('div', { class: 'chip-row' }, [el('button', { class: 'ghost small', onclick: () => { openPlots.forEach((p) => stepState.plotIds.add(p.id)); drawWizard(); } }, ['Chọn tất cả']), el('button', { class: 'ghost small', onclick: () => { stepState.plotIds.clear(); drawWizard(); } }, ['Bỏ chọn']), el('span', { class: 'muted', text: `${stepState.plotIds.size} thửa đã chọn` })]),
          el('div', { class: 'pick-list', style: 'max-height:260px' }, openPlots.map((p) => el('label', { class: 'pick-item' }, [el('input', { type: 'checkbox', checked: stepState.plotIds.has(p.id) ? true : null, onchange: (e) => { if (e.target.checked) stepState.plotIds.add(p.id); else stepState.plotIds.delete(p.id); } }), `${p.code} — ${num(p.area_ha, 3)} ha${p.farmer_name ? ` · ${p.farmer_name}` : ''}`]))),
          stepState.plotIds.size === 1 ? el('button', { class: 'ghost small', onclick: async () => {
            const prev = await guard(api(`/htx/seasons/previous-config?plotId=${[...stepState.plotIds][0]}`));
            if (!prev.cycleCode) return toast('Thửa này chưa có vụ trước để sao chép.', true);
            Object.assign(stepState, { varietyId: prev.varietyId ?? stepState.varietyId, variety: prev.variety ?? stepState.variety, protocolId: prev.protocolId ?? '' });
            toast(`Đã sao chép cấu hình từ vụ ${prev.cycleCode}: giống ${prev.variety ?? '—'}.`); step = 1; drawWizard();
          } }, [icon('copy', 14), 'Sao chép cấu hình vụ trước']) : null,
        ]);
      } else if (step === 1) {
        content = el('div', { class: 'row' }, [
          el('label', {}, ['Mùa vụ', el('select', { onchange: (e) => { stepState.seasonId = e.target.value; } }, seasons.map((s) => el('option', { value: s.id, selected: s.id === stepState.seasonId }, [s.name])))]),
          el('label', {}, ['Giống lúa', el('select', { onchange: (e) => { const v = varieties.find((x) => x.id === e.target.value); stepState.varietyId = e.target.value; stepState.variety = v?.name ?? ''; stepState.protocolId = v?.default_protocol_id ?? ''; } },
            varieties.map((v) => el('option', { value: v.id, selected: v.id === stepState.varietyId }, [`${v.name} · ${v.growth_days} ngày · ${v.yield_min_t_ha}–${v.yield_max_t_ha} t/ha`])))]),
        ]);
      } else if (step === 2) {
        const variety = varieties.find((v) => v.id === stepState.varietyId);
        content = el('div', { class: 'row' }, [
          el('label', {}, [`Ngày xuống giống (${dateOnly(minDate)} → ${dateOnly(maxDate)})`, el('input', { type: 'date', value: stepState.sowingDate, min: minDate, max: maxDate, onchange: (e) => { stepState.sowingDate = e.target.value; } })]),
          el('label', {}, ['Quy trình sản xuất (SOP)', el('select', { onchange: (e) => { stepState.protocolId = e.target.value; } }, [el('option', { value: '', selected: !stepState.protocolId }, [variety?.default_protocol_id ? 'Theo mặc định của giống' : '— Không gán —']), ...protocols.map((p) => el('option', { value: p.id, selected: p.id === stepState.protocolId }, [`${p.code ?? ''} ${p.name ?? p.title ?? ''}`]))])]),
        ]);
      } else {
        const variety = varieties.find((v) => v.id === stepState.varietyId);
        const chosen = openPlots.filter((p) => stepState.plotIds.has(p.id));
        content = el('div', {}, [
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Thửa' }), el('span', { class: 'v', text: `${chosen.length} thửa · ${num(chosen.reduce((a, p) => a + p.area_ha, 0), 2)} ha` })]),
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Mùa vụ' }), el('span', { class: 'v', text: seasons.find((s) => s.id === stepState.seasonId)?.name ?? '' })]),
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Giống' }), el('span', { class: 'v', text: variety?.name ?? stepState.variety })]),
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Ngày sạ' }), el('span', { class: 'v', text: dateOnly(stepState.sowingDate) })]),
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Quy trình' }), el('span', { class: 'v', text: stepState.protocolId ? (protocols.find((p) => p.id === stepState.protocolId)?.name ?? 'Đã chọn') : (variety?.default_protocol_id ? 'Mặc định theo giống' : 'Không gán') })]),
        ]);
      }
      const nav = el('div', { class: 'chip-row', style: 'justify-content:flex-end' }, [
        step > 0 ? el('button', { class: 'ghost small', onclick: () => { step -= 1; drawWizard(); } }, ['← Quay lại']) : null,
        step < 3 ? el('button', { class: 'small', onclick: () => { if (step === 0 && !stepState.plotIds.size) return toast('Chọn ít nhất một thửa.', true); step += 1; drawWizard(); } }, ['Tiếp →'])
          : el('button', { class: 'small', onclick: async () => {
            const body = { seasonId: stepState.seasonId, varietyId: stepState.varietyId || undefined, variety: stepState.variety || undefined, sowingDate: stepState.sowingDate, protocolId: stepState.protocolId || undefined };
            const ids = [...stepState.plotIds];
            if (ids.length === 1) { await guard(api('/htx/seasons/open', { body: { ...body, plotId: ids[0] } })); toast('Đã mở vụ và tạo kế hoạch theo quy trình.'); }
            else { const out = await guard(api('/htx/seasons/open-bulk', { body: { ...body, plotIds: ids, htxId: id } })); toast(`Đã mở ${out.opened.length} vụ; ${out.skipped.length} thửa bỏ qua${out.skipped.length ? `: ${out.skipped[0].reason}` : ''}.`, out.skipped.length > 0); }
            await rerender(this, view, actions);
          } }, [icon('check', 14), 'Mở vụ']),
      ]);
      wizardBox.replaceChildren(card('Mở vụ canh tác mới', [header, content, nav]));
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vụ đang canh tác', num(cycles.filter((c) => c.status === 'dang_canh_tac').length), null, null, 'seed'),
        kpi('Vụ đã hoàn thành', num(cycles.filter((c) => c.status !== 'dang_canh_tac').length), null, null, 'check'),
        kpi('Thửa sẵn sàng mở vụ', num(openPlots.length), null, null, 'plot'),
        kpi('Giống trong danh mục', num(varieties.length), 'Do Khuyến nông quản lý', null, 'leaf'),
      ]),
      wizardBox,
      card('Danh sách vụ canh tác', table([
        { key: 'code', label: 'Mã vụ' }, { key: 'plot_code', label: 'Thửa' }, { key: 'season_name', label: 'Mùa vụ' }, { key: 'variety', label: 'Giống', render: (r) => r.variety ?? '—' },
        { key: 'area_ha', label: 'Diện tích', align: 'right', render: (r) => `${num(r.area_ha, 2)} ha` }, { key: 'sowing_date', label: 'Gieo sạ' },
        { key: 'status', label: 'Trạng thái', render: (r) => badge(r.status === 'dang_canh_tac' ? 'Đang canh tác' : 'Đã hoàn thành vụ', r.status === 'dang_canh_tac' ? 'good' : 'info') },
        { key: 'act', label: '', render: (r) => (r.status === 'dang_canh_tac' ? el('span', { class: 'chip-row' }, [
          el('button', { class: 'ghost small', onclick: () => navigate('htx-plan') }, [icon('calendar', 14), 'Kế hoạch']),
          el('button', { class: 'ghost small', onclick: () => navigate('htx-logs') }, [icon('log', 14), 'Nhật ký']),
          el('button', { class: 'ghost small', onclick: () => navigate('htx-harvest') }, [icon('harvest', 14), 'Sản lượng']),
        ]) : '—') },
      ], cycles, { empty: 'Chưa có vụ canh tác nào.' })),
    );
    drawWizard();
  },
});

// ===========================================================================
// Nhật ký canh tác — US-LOG
// ===========================================================================

registerPage('htx-logs', {
  title: 'Nhật ký canh tác',
  subtitle: 'Ghi hoạt động theo vụ với vật tư, GPS, máy móc; ghi cùng lúc nhiều thửa; tự lưu tạm khi mất mạng',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
    const [cycles, activities, labels, machines] = await Promise.all([
      guard(api(`/htx/crop-cycles?htxId=${id}`)), api('/htx/activities').catch(() => []), labelsGps(), api(`/cgh/machines?htxId=${id}`).catch(() => []),
    ]);
    const active = cycles.filter((c) => c.status === 'dang_canh_tac');
    const chosen = new Set(active.length ? [active[0].id] : []);
    let activity = activities[0]?.code ?? 'bon_phan';
    let gps = null;
    const gpsBox = el('span', { class: 'muted', text: 'Chưa lấy GPS' });
    const machinePick = new Set();
    const logBox = el('div');
    const cycleSel = el('select', { onchange: (e) => showLogs(e.target.value) }, [el('option', { value: '' }, ['— Chọn vụ —']), ...cycles.map((c) => el('option', { value: c.id }, [`${c.code} — thửa ${c.plot_code}`]))]);
    let statusFilter = 'all';

    const actGrid = el('div', { class: 'opt-grid' });
    const drawAct = () => actGrid.replaceChildren(...activities.map((a) => el('button', { type: 'button', class: activity === a.code ? 'on' : '', onclick: () => { activity = a.code; drawAct(); } }, [el('span', { class: 'em', text: ACTIVITY_EMOJI[a.code] ?? '📝' }), a.label.replace(/ \(.*\)/, '')])));
    drawAct();

    async function showLogs(cycleId) {
      if (!cycleId) return logBox.replaceChildren();
      const logs = (await guard(api(`/htx/crop-cycles/${cycleId}/logs`))).filter((l) => statusFilter === 'all' || l.approval_status === statusFilter);
      logBox.replaceChildren(table([
        { key: 'log_date', label: 'Ngày' },
        { key: 'activity', label: 'Hoạt động', render: (r) => `${ACTIVITY_EMOJI[r.activity] ?? ''} ${activities.find((a) => a.code === r.activity)?.label ?? r.activity}` },
        { key: 'detail', label: 'Chi tiết', render: (r) => [r.detail, r.input_name ? `${r.input_name} ${num(r.input_qty)} ${r.input_uom ?? ''}` : null].filter(Boolean).join(' · ') || '—' },
        { key: 'gps_status', label: 'GPS', render: (r) => badge(labels[r.gps_status] ?? 'Chưa xác định', r.gps_status === 'khop' ? 'good' : r.gps_status === 'khong_khop' ? 'bad' : 'neutral') },
        { key: 'approval_status', label: 'Duyệt', render: (r) => badge(APPROVAL[r.approval_status]?.[0] ?? '—', APPROVAL[r.approval_status]?.[1] ?? 'neutral') },
        { key: 'recorded_by', label: 'Người ghi' },
      ], logs, { empty: 'Vụ này chưa có nhật ký.' }));
    }

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vụ đang canh tác', num(active.length), null, null, 'seed'),
        kpi('Máy của HTX', num(machines.length), 'Chọn máy đã dùng khi ghi nhật ký', null, 'tractor'),
        kpi('Hoạt động', num(activities.length), 'Rút nước AWD là dữ liệu MRV', null, 'log'),
      ]),
      can('htx.write') && active.length ? card('Ghi nhật ký', [
        el('h4', { text: '1. Vụ / thửa áp dụng (chọn nhiều để ghi hàng loạt)' }),
        el('div', { class: 'pick-list', style: 'max-height:150px' }, active.map((c) => el('label', { class: 'pick-item' }, [el('input', { type: 'checkbox', checked: chosen.has(c.id) ? true : null, onchange: (e) => { if (e.target.checked) chosen.add(c.id); else chosen.delete(c.id); } }), `${c.code} — thửa ${c.plot_code} (${c.season_name}${c.variety ? ` · ${c.variety}` : ''})`]))),
        el('h4', { text: '2. Hoạt động' }), actGrid,
        el('h4', { text: '3. Chi tiết' }),
        form([
          { name: 'logDate', label: 'Ngày thực hiện', type: 'date', value: new Date().toISOString().slice(0, 10), required: true },
          { name: 'inputName', label: 'Vật tư (nếu có)', placeholder: 'VD: Urê' }, { name: 'inputQty', label: 'Lượng', type: 'number', step: '0.01' }, { name: 'inputUom', label: 'Đơn vị', placeholder: 'kg / lít' },
          { name: 'detail', label: 'Ghi chú', type: 'textarea', rows: 2 }, { name: 'photoUrl', label: 'Ảnh (URL)', placeholder: 'https://…' },
        ], async (v) => {
          if (!chosen.size) throw new Error('Chọn ít nhất một vụ.');
          const body = { activity, logDate: v.logDate, detail: v.detail || undefined, inputName: v.inputName || undefined, inputQty: v.inputQty ?? undefined, inputUom: v.inputUom || undefined, photoUrl: v.photoUrl || undefined,
            lat: gps?.lat, lng: gps?.lng, gpsSource: gps ? 'thiet_bi' : 'khong_co_gps_thiet_bi', machineIds: [...machinePick] };
          if (chosen.size === 1) { const out = await api('/htx/farm-logs/v2', { body: { ...body, cropCycleId: [...chosen][0] } }); toast(`Đã ghi nhật ký · GPS: ${labels[out.gps_status] ?? out.gpsLabel ?? '—'} · chờ duyệt.`); }
          else { const out = await api('/htx/farm-logs/bulk', { body: { ...body, cropCycleIds: [...chosen] } }); toast(`Đã ghi ${out.created} nhật ký${out.skipped.length ? `, bỏ qua ${out.skipped.length}` : ''}.`, out.skipped.length > 0); }
          if (cycleSel.value) await showLogs(cycleSel.value);
        }, { submitLabel: 'Ghi nhật ký', resetOnSuccess: false }),
        el('div', { class: 'row' }, [
          el('button', { class: 'ghost small', onclick: async () => { gps = await deviceGps(); gpsBox.textContent = gps ? `GPS: ${gps.lat}, ${gps.lng} (±${Math.round(gps.accuracy)} m)` : 'Không có GPS thiết bị — nhật ký sẽ ghi "Không có GPS thiết bị"'; } }, [icon('gps', 14), 'Lấy vị trí GPS']), gpsBox,
        ]),
        machines.length ? el('div', {}, [el('h4', { text: 'Máy đã sử dụng' }), el('div', { class: 'chip-row' }, machines.map((m) => el('button', { class: 'chip', onclick: (e) => { if (machinePick.has(m.id)) machinePick.delete(m.id); else machinePick.add(m.id); e.target.classList.toggle('active'); } }, [`${m.code} · ${m.machine_type_name ?? ''}`])))]) : null,
      ]) : (active.length ? null : alert('Chưa có vụ nào đang canh tác — mở vụ trước khi ghi nhật ký.', 'info')),
      card('Nhật ký theo vụ', [
        el('div', { class: 'row' }, [el('label', {}, ['Vụ canh tác', cycleSel]), chips([{ value: 'all', label: 'Tất cả' }, { value: 'cho_duyet', label: 'Chờ duyệt' }, { value: 'da_duyet', label: 'Đã duyệt' }, { value: 'yeu_cau_bo_sung', label: 'Cần bổ sung' }], statusFilter, (v) => { statusFilter = v; showLogs(cycleSel.value); })]),
        logBox,
      ]),
      can('htx.write') ? el('details', { class: 'card tight' }, [
        el('summary', { style: 'cursor:pointer;font-weight:600', text: 'Đồng bộ nhật ký ghi khi mất mạng (JSON)' }),
        el('p', { class: 'muted', text: 'Nhật ký ghi tại đây khi mất mạng đã tự xếp hàng đợi và gửi lại khi có mạng. Ô này dùng cho ứng dụng di động khác dán JSON bản ghi chờ đồng bộ.' }),
        form([{ name: 'records', label: 'Bản ghi (JSON)', type: 'textarea', rows: 3, required: true, placeholder: '[{"cropCycleId":"...","activity":"bon_phan","logDate":"2026-04-01"}]' }], async (v) => {
          let parsed; try { parsed = JSON.parse(v.records); } catch { throw new Error('JSON không hợp lệ.'); }
          if (!Array.isArray(parsed)) throw new Error('Cần một MẢNG bản ghi.');
          const result = await api('/htx/farm-logs/sync', { body: { records: parsed } });
          toast(`Đồng bộ: nhận ${result.accepted}, từ chối ${result.rejected}.`, result.rejected > 0);
        }, { submitLabel: 'Đồng bộ' }),
      ]) : null,
    );
    if (active[0]) { cycleSel.value = active[0].id; await showLogs(active[0].id); }
  },
});

// ===========================================================================
// Duyệt nhật ký — US-APPR
// ===========================================================================

registerPage('htx-approve', {
  title: 'Duyệt nhật ký canh tác',
  subtitle: 'Ban quản lý HTX xác nhận nhật ký nông dân ghi; yêu cầu bổ sung khi thiếu ảnh/GPS. Số liệu tổng hợp chỉ tính bản đã duyệt',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
    let status = 'cho_duyet';
    const body = el('div');
    const labels = await labelsGps();
    const draw = async () => {
      const logs = await guard(api(`/htx/farm-logs/review?htxId=${id}&status=${status}`));
      body.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          statCard('log', num(logs.length), status === 'all' ? 'Tổng nhật ký' : APPROVAL[status]?.[0] ?? '', 'warn'),
          statCard('gps', num(logs.filter((l) => l.gps_status === 'khop').length), 'GPS khớp thửa', 'good'),
          statCard('warning', num(logs.filter((l) => l.gps_status === 'khong_khop').length), 'GPS không khớp', 'bad'),
          statCard('camera', num(logs.filter((l) => l.photo_url).length), 'Có ảnh minh chứng', 'info'),
        ]),
        table([
          { key: 'log_date', label: 'Ngày' }, { key: 'plot_code', label: 'Thửa' }, { key: 'farmer_name', label: 'Nông hộ', render: (r) => r.farmer_name ?? '—' },
          { key: 'activity', label: 'Hoạt động' }, { key: 'detail', label: 'Chi tiết', render: (r) => r.detail ?? '—' },
          { key: 'gps_label', label: 'GPS', render: (r) => badge(r.gps_label ?? labels[r.gps_status] ?? '—', r.gps_status === 'khop' ? 'good' : r.gps_status === 'khong_khop' ? 'bad' : 'neutral') },
          { key: 'machines', label: 'Máy', render: (r) => (r.machines?.length ? `${r.machines.length} máy` : '—') },
          { key: 'approval_status', label: 'Trạng thái', render: (r) => badge(APPROVAL[r.approval_status]?.[0] ?? r.approval_status, APPROVAL[r.approval_status]?.[1] ?? 'neutral') },
          { key: 'act', label: '', render: (r) => (can('htx.write') && r.approval_status !== 'da_duyet' ? el('span', { class: 'chip-row' }, [
            el('button', { class: 'small', onclick: async () => { await guard(api(`/htx/farm-logs/${r.id}/review`, { body: { decision: 'da_duyet' } })); toast('Đã duyệt.'); await draw(); } }, [icon('check', 14), 'Duyệt']),
            el('button', { class: 'ghost small', onclick: async () => { const note = await promptDialog('Yêu cầu bổ sung', { placeholder: 'Cần bổ sung gì? (ảnh, GPS, lượng vật tư…)', minLength: 5 }); if (note === null) return; await guard(api(`/htx/farm-logs/${r.id}/review`, { body: { decision: 'yeu_cau_bo_sung', note } })); toast('Đã gửi yêu cầu bổ sung.'); await draw(); } }, ['Yêu cầu bổ sung']),
          ]) : (r.review_note ? el('span', { class: 'muted', text: r.review_note }) : '—')) },
        ], logs, { empty: 'Không có nhật ký ở trạng thái này.' }),
      );
    };
    view.replaceChildren(chips([{ value: 'cho_duyet', label: 'Chờ duyệt' }, { value: 'yeu_cau_bo_sung', label: 'Yêu cầu bổ sung' }, { value: 'da_duyet', label: 'Đã duyệt' }, { value: 'all', label: 'Tất cả' }], status, (v) => { status = v; draw(); }), body);
    await draw();
  },
});

// ===========================================================================
// Khai báo sản lượng — US-HARV
// ===========================================================================

registerPage('htx-harvest', {
  title: 'Khai báo sản lượng',
  subtitle: 'Khai lúa & rơm khi kết thúc vụ; hệ thống cảnh báo năng suất bất thường theo giống; vụ ĐÓNG sau khi khai',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
    const [cycles, report, seasons] = await Promise.all([guard(api(`/htx/crop-cycles?htxId=${id}`)), api(`/htx/reports/harvest?htxId=${id}`).catch(() => []), api('/mdm/seasons').catch(() => [])]);
    const active = cycles.filter((c) => c.status === 'dang_canh_tac');
    const done = cycles.filter((c) => c.status !== 'dang_canh_tac');
    let seasonFilter = '';
    const reportBox = el('div');
    const drawReport = () => reportBox.replaceChildren(table([
      { key: 'ma_vu', label: 'Mã vụ' }, { key: 'ma_lo', label: 'Thửa' }, { key: 'nong_ho', label: 'Nông hộ', render: (r) => r.nong_ho || '—' }, { key: 'mua_vu', label: 'Mùa vụ' }, { key: 'giong', label: 'Giống', render: (r) => r.giong || '—' },
      { key: 'dien_tich_ha', label: 'ha', align: 'right', render: (r) => num(r.dien_tich_ha, 2) }, { key: 'lua_tan', label: 'Lúa (t)', align: 'right', render: (r) => (r.lua_tan == null ? '—' : num(r.lua_tan, 2)) },
      { key: 'nang_suat', label: 't/ha', align: 'right', render: (r) => (r.lua_tan == null || !r.dien_tich_ha ? '—' : num(r.lua_tan / r.dien_tich_ha, 2)) },
      { key: 'rom_tan', label: 'Rơm (t)', align: 'right', render: (r) => (r.rom_tan == null ? '—' : num(r.rom_tan, 2)) }, { key: 'trang_thai', label: 'Trạng thái', render: (r) => badge(r.trang_thai, r.trang_thai === 'Đang canh tác' ? 'good' : 'info') },
    ], report.filter((r) => !seasonFilter || r.mua_vu === seasonFilter), { empty: 'Chưa có dữ liệu.' }));

    actions.append(el('button', { class: 'ghost small', onclick: () => downloadUrl(`/htx/reports/harvest.csv?htxId=${id}`, 'bao-cao-san-luong.csv') }, [icon('download', 15), 'Xuất CSV']), el('button', { class: 'ghost small', onclick: () => window.print() }, [icon('print', 15), 'In']));

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vụ chờ khai báo', num(active.length), null, null, 'harvest'),
        kpi('Vụ đã khai báo', num(done.length), null, null, 'check'),
        kpi('Lúa đã khai', tons(done.reduce((a, c) => a + (c.paddy_tons ?? 0), 0)), null, null, 'leaf'),
        kpi('Rơm đã khai', tons(done.reduce((a, c) => a + (c.straw_tons ?? 0), 0)), 'Nguồn cung cho mô phỏng Hub', null, 'truck'),
      ]),
      can('htx.write') && active.length ? el('div', { class: 'grid cols-2' }, [
        card('Khai báo một vụ', [
          alert('Khai báo sản lượng sẽ ĐÓNG vụ. Năng suất lệch xa dải của giống sẽ được hỏi xác nhận trước khi lưu.', 'warn'),
          form([
            { name: 'cropCycleId', label: 'Vụ canh tác', type: 'select', required: true, options: active.map((c) => ({ value: c.id, label: `${c.code} — thửa ${c.plot_code} (${num(c.area_ha, 2)} ha${c.variety ? `, ${c.variety}` : ''})` })) },
            { name: 'harvestDate', label: 'Ngày thu hoạch', type: 'date', value: new Date().toISOString().slice(0, 10) },
            { name: 'paddyTons', label: 'Lúa (tấn)', type: 'number', required: true, step: '0.01', min: '0' }, { name: 'moisturePct', label: 'Độ ẩm (%)', type: 'number', step: '0.1', min: '0', max: '100' },
            { name: 'strawTons', label: 'Rơm (tấn)', type: 'number', step: '0.01', min: '0' }, { name: 'strawState', label: 'Tình trạng rơm', type: 'select', options: STRAW_STATE.map(([value, label]) => ({ value, label })) },
          ], async (v) => { await apiConfirm('/htx/harvest/v2', { body: v }, 'confirmAnomaly'); toast('Đã khai báo sản lượng — vụ chuyển sang trạng thái đóng.'); await rerender(this, view, actions); }, { submitLabel: 'Khai báo & đóng vụ' }),
        ]),
        card('Khai báo nhiều vụ (dán từ Excel)', [
          el('p', { class: 'muted', text: 'Mỗi dòng: mã vụ, lúa (tấn), rơm (tấn), ngày thu hoạch (YYYY-MM-DD). Dòng bất thường cần xác nhận riêng sẽ được liệt kê, không chặn các dòng khác.' }),
          form([{ name: 'text', label: 'Dữ liệu', type: 'textarea', rows: 5, required: true, placeholder: 'VU-2026-DX-001, 6.5, 4.2, 2026-03-12' }], async (v) => {
            const codeToId = new Map(active.map((c) => [c.code, c.id]));
            const rows = v.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [code, paddy, straw, date] = l.split(/[,\t;]/).map((x) => x.trim()); return { cropCycleId: codeToId.get(code) ?? code, paddyTons: Number(paddy), strawTons: straw ? Number(straw) : undefined, harvestDate: date || undefined }; });
            const out = await api('/htx/harvest/bulk', { body: { rows } });
            const needs = out.errors.filter((e) => e.needsConfirm);
            toast(`Đã lưu ${out.saved}; ${out.errors.length} dòng lỗi${needs.length ? ` (${needs.length} cần xác nhận bất thường — khai riêng)` : ''}.`, out.errors.length > 0);
            if (out.errors.length) modal('Dòng chưa lưu', table([{ key: 'row', label: 'Dòng' }, { key: 'cropCycleId', label: 'Vụ' }, { key: 'reason', label: 'Lý do' }], out.errors, { plain: true }));
            if (out.saved) await rerender(this, view, actions);
          }, { submitLabel: 'Khai báo hàng loạt' }),
        ]),
      ]) : (active.length ? null : alert('Không có vụ nào đang canh tác để khai báo.', 'info')),
      card('Báo cáo sản lượng theo vụ (US-RPT-01)', [
        el('div', { class: 'row' }, [el('label', {}, ['Mùa vụ', el('select', { onchange: (e) => { seasonFilter = e.target.value; drawReport(); } }, [el('option', { value: '' }, ['Tất cả']), ...seasons.map((s) => el('option', { value: s.name }, [s.name]))])])]),
        reportBox,
      ]),
    );
    drawReport();
  },
});

// ===========================================================================
// FN-12 — Yêu cầu hỗ trợ kỹ thuật
// ===========================================================================

registerPage('htx-support', {
  title: 'Yêu cầu hỗ trợ kỹ thuật',
  subtitle: 'Gửi yêu cầu tới cán bộ khuyến nông; mỗi yêu cầu thành một nhiệm vụ có mã theo dõi và hạn tiếp nhận 24 giờ',
  async render(view, actions) {
    const { id } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
    const [dashboard, plots, directory] = await Promise.all([guard(api(`/htx/dashboard?htxId=${id}`)), api(`/mdm/plots?htxId=${id}`), api('/kn/directory').catch(() => [])]);
    const onDuty = (directory ?? []).filter((o) => o.on_duty);
    const ISSUE = [['dich_hai', '🐛', 'Dịch hại'], ['benh_lua', '🍂', 'Bệnh lúa'], ['thoi_tiet', '🌧️', 'Thời tiết'], ['ky_thuat', '🧪', 'Kỹ thuật'], ['may_moc', '🚜', 'Máy móc'], ['khac', '❓', 'Khác']];
    let issue = 'dich_hai';
    const grid = el('div', { class: 'opt-grid' });
    const drawGrid = () => grid.replaceChildren(...ISSUE.map(([code, em, label]) => el('button', { type: 'button', class: issue === code ? 'on' : '', onclick: () => { issue = code; drawGrid(); } }, [el('span', { class: 'em', text: em }), label])));
    drawGrid();
    view.replaceChildren(
      el('div', { class: 'split wide-left' }, [
        can('htx.write') ? card('Gửi yêu cầu hỗ trợ', [
          el('h4', { text: 'Loại vấn đề' }), grid,
          form([
            { name: 'title', label: 'Vấn đề gặp phải', required: true, placeholder: 'VD: Lúa vàng lá bất thường' },
            { name: 'content', label: 'Mô tả chi tiết', type: 'textarea', rows: 3, required: true },
            { name: 'plotId', label: 'Thửa liên quan', type: 'select', options: [{ value: '', label: '— Không xác định —' }, ...plots.map((p) => ({ value: p.id, label: `${p.code} — ${num(p.area_ha, 2)} ha` }))] },
            { name: 'urgency', label: 'Mức độ', type: 'select', options: [{ value: 'binh_thuong', label: 'Bình thường' }, { value: 'khan', label: 'Khẩn — dịch hại lây lan' }] },
          ], async (v) => {
            // UAT DEF-HTX-12/10: gửi đúng tên trường máy chủ đọc — description / category / priority — thay vì ghép vào tiêu đề.
            await api('/htx/support-requests', { body: { title: v.title, description: v.content, category: issue, priority: v.urgency, htxId: id, plotId: v.plotId || null } });
            toast('Đã gửi yêu cầu — cán bộ khuyến nông sẽ tiếp nhận trong 24 giờ.'); await rerender(this, view, actions);
          }, { submitLabel: 'Gửi yêu cầu' }),
        ]) : el('div'),
        el('div', { class: 'stack' }, [
          card('Trạng thái các yêu cầu', table([{ key: 'status', label: 'Trạng thái' }, { key: 'n', label: 'Số lượng', align: 'right', render: (r) => num(r.n) }], dashboard.openTasks ?? [], { empty: 'Chưa gửi yêu cầu nào.' })),
          card('Cán bộ đang trực', onDuty.length ? el('div', { class: 'list' }, onDuty.map((o) => el('a', { class: 'list-item', href: `tel:${o.phone}` }, [
            el('span', { class: 'avatar', text: (o.full_name ?? '?').split(' ').pop()[0] }),
            el('div', { class: 'grow' }, [el('div', { class: 'title', text: o.full_name }), el('div', { class: 'muted', text: `${o.org_name ?? ''} · ${o.specialty ?? ''}` })]),
            el('span', { class: 'badge good' }, [icon('phone', 12), o.phone]),
          ]))) : el('p', { class: 'muted', text: 'Hiện không có cán bộ nào trực.' })),
        ]),
      ]),
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
    const { id, htx } = await htxSelector(actions, () => rerender(this, view, actions));
    if (!id) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
    const advice = await guard(api(`/htx/advice/${id}`).catch(() => ({ advice: [], forecast: [] })));
    const alerts = (advice.forecast ?? []).filter((f) => f.severity);
    const today = advice.forecast?.[0];
    view.replaceChildren(
      today ? el('div', { class: 'weather-card' }, [
        el('div', {}, [el('div', { class: 'temp', text: `${num(today.temp_c)}°` }), el('div', { text: `${htx?.name ?? ''} · ${dateOnly(today.observed_for)}` }), el('div', { style: 'opacity:.9;font-size:12.5px', text: `Mưa ${num(today.rainfall_mm)} mm · Ẩm ${num(today.humidity_pct)}%` })]),
        el('div', { class: 'days' }, (advice.forecast ?? []).slice(1, 6).map((d) => el('div', { class: 'day' }, [el('b', { text: `${num(d.temp_c)}°` }), String(d.observed_for).slice(5), el('div', { text: `${num(d.rainfall_mm)} mm` })]))),
      ]) : null,
      alerts.length ? el('div', {}, alerts.map((f) => alert(`${dateOnly(f.observed_for)}: ${f.headline ?? f.severity}`, 'bad'))) : null,
      el('div', { class: 'grid cols-2' }, [
        card('Khuyến cáo canh tác', (advice.advice ?? []).length ? el('div', { class: 'list' }, (advice.advice ?? []).map((text) => el('div', { class: 'list-item', style: 'cursor:default' }, [icon('leaf', 18), text]))) : alert('Chưa có khuyến cáo nào cho địa bàn này.', 'info')),
        card('Dự báo 7 ngày', table([
          { key: 'observed_for', label: 'Ngày', render: (r) => dateOnly(r.observed_for) },
          { key: 'rainfall_mm', label: 'Mưa (mm)', align: 'right', render: (r) => num(r.rainfall_mm) }, { key: 'humidity_pct', label: 'Ẩm (%)', align: 'right', render: (r) => num(r.humidity_pct) },
          { key: 'temp_c', label: '°C', align: 'right', render: (r) => num(r.temp_c) }, { key: 'severity', label: 'Cảnh báo', render: (r) => (r.severity ? badge(r.headline ?? r.severity, 'bad') : '—') },
        ], advice.forecast ?? [], { empty: 'Chưa có dữ liệu dự báo.' })),
      ]),
    );
    void confirmDialog; void dateTime;
  },
});
