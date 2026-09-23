/**
 * CỔNG KHUYẾN NÔNG — giao diện theo bản mẫu "App Khuyến nông v5.0", chức năng theo BRD v1.0 & Backlog (epics A–L).
 *
 *   kn-dashboard  Bảng điều hành theo phạm vi vai trò (TW / tỉnh / xã) — US-DASH-01/02
 *   kn-org        Cây tổ chức 3 cấp — FN-03/04
 *   kn-network    HTX & khai báo cơ giới hoá trong địa bàn — US-HTX-01/04
 *   kn-tasks      Nhiệm vụ hỗ trợ HTX: SLA 24h, leo thang, phân công hàng loạt — US-TASK-01..04
 *   kn-broadcast  Chỉ đạo điều hành & cảnh báo khẩn theo vùng — FN-07/08, US-TASK-03
 *   kn-library    Thư viện kỹ thuật: chuyên mục, tin khẩn, hướng dẫn địa phương, tìm kiếm — US-LIB-01..06
 *   kn-prices     Giá cả thị trường: bản tin ngày, danh sách theo dõi biến động — US-PRICE-01..03
 *   kn-reports    Báo cáo tổng hợp theo phạm vi, CSV/in, "số liệu tạm tính" — US-RPT-01..03
 *   kn-directory  Danh bạ trực hỗ trợ — FN-15
 *   kn-training   Đào tạo ToT — FN-12
 *   kn-map        Bản đồ vùng khuyến nông — FN-05/06
 */
import {
  api, registerPage, el, card, kpi, statCard, table, badge, alert, num, pct, dateTime, dateOnly, state,
  toast, guard, can, form, mapContainer, createMap, LEAFLET_AVAILABLE, navigate, icon, modal, confirmDialog, promptDialog,
  emptyState, svgBarChart, chips, downloadUrl, tabs,
} from '/app.js';

export const ORG_LEVEL = { trung_uong: 'Trung ương', tinh: 'Tỉnh', xa: 'Xã / Tổ KNCĐ' };
const ARTICLE_KIND = { quy_trinh: 'Quy trình kỹ thuật', tai_lieu: 'Tài liệu', tin_tuc: 'Tin tức' };
const TASK_STATUS = {
  moi: { label: 'Mới', tone: 'bad' }, tiep_nhan: { label: 'Đã tiếp nhận', tone: 'warn' },
  dang_xu_ly: { label: 'Đang xử lý', tone: 'info' }, hoan_thanh: { label: 'Hoàn thành', tone: 'good' }, dong: { label: 'Đã đóng', tone: 'neutral' },
};
const FLOW = ['moi', 'tiep_nhan', 'dang_xu_ly', 'hoan_thanh', 'dong'];
const nextStatus = (status) => FLOW[Math.min(FLOW.indexOf(status) + 1, FLOW.length - 1)];
const nextLabel = (status) => ({ moi: 'Tiếp nhận', tiep_nhan: 'Xử lý', dang_xu_ly: 'Hoàn thành', hoan_thanh: 'Đóng' })[status] ?? '—';
const STAGE_LABEL = { lam_dat: 'Làm đất', gieo_sa: 'Gieo sạ', cham_soc: 'Chăm sóc', thu_hoach: 'Thu hoạch', sau_thu_hoach: 'Sau thu hoạch' };
const CAT_COLORS = { ky_thuat: 'linear-gradient(140deg,#22B86C,#0B5F3C)', canh_bao: 'linear-gradient(140deg,#FF7A7A,#B91C1C)', chinh_sach: 'linear-gradient(140deg,#6366F1,#3730A3)', thi_truong: 'linear-gradient(140deg,#FFB43C,#D9700C)', su_kien: 'linear-gradient(140deg,#38BDF8,#0B6E93)' };

const taskBadge = (row) => badge(TASK_STATUS[row.status]?.label ?? row.status, TASK_STATUS[row.status]?.tone ?? 'neutral');
function flatten(nodes, depth = 0, out = []) { for (const node of nodes) { out.push({ ...node, depth }); if (node.children?.length) flatten(node.children, depth + 1, out); } return out; }
function renderTree(nodes, depth = 0) {
  return el('div', { class: 'list' }, nodes.map((node) => el('div', {}, [
    el('div', { class: 'list-item', style: `margin-left:${depth * 16}px; cursor:default` }, [
      icon(node.level === 'trung_uong' ? 'flag' : node.level === 'tinh' ? 'building' : 'users', 18),
      el('div', { class: 'grow' }, [el('div', { class: 'title', text: node.name }), el('div', { class: 'muted', text: `${node.code} · ${ORG_LEVEL[node.level] ?? node.level}` })]),
    ]),
    node.children?.length ? renderTree(node.children, depth + 1) : null,
  ])));
}

// ===========================================================================
// Bảng điều hành theo phạm vi — US-DASH-01/02
// ===========================================================================

registerPage('kn-dashboard', {
  title: 'Bảng điều hành Khuyến nông',
  subtitle: 'Địa bàn, HTX, nhiệm vụ SLA, nhật ký chờ xác minh và thời tiết — theo phạm vi vai trò của bạn',
  async render(view, actions) {
    const [dash, tasks, courses] = await Promise.all([guard(api('/kn/dashboard/v2')), api('/kn/tasks/v2').catch(() => []), api('/kn/courses').catch(() => [])]);
    const counts = Object.fromEntries((dash.tasks ?? []).map((r) => [r.status, r.n]));
    const open = (counts.moi ?? 0) + (counts.tiep_nhan ?? 0) + (counts.dang_xu_ly ?? 0);
    const k = dash.kpis ?? {};
    const pendingVerify = dash.pendingVerify ?? [];

    actions.append(el('span', { class: 'pill' }, [el('span', { class: 'dot' }), `Phạm vi: ${dash.scope?.label ?? ''}`]));
    if (can('khuyennong.publish')) {
      const pushBtn = el('button', { class: 'ghost small', onclick: async () => {
        pushBtn.disabled = true;
        try {
          const r = await guard(api('/kn/push-to-app-htx', { body: {} }));
          toast(`Đã đẩy ${r.recordCount} bản ghi sang Cổng HTX lúc ${new Date().toLocaleTimeString('vi-VN')} (${r.status}).`);
          pushBtn.replaceChildren(icon('check', 15), `Đã đẩy ${r.recordCount} bản ghi · ${new Date().toLocaleTimeString('vi-VN')}`);
        } finally { pushBtn.disabled = false; }
      } }, [icon('upload', 15), 'Đẩy sang Cổng HTX']);
      actions.append(pushBtn);
    }

    view.replaceChildren(
      pendingVerify.length ? el('div', { class: 'alertbar', onclick: () => navigate('kn-reports') }, [
        el('span', { class: 'ai' }, [icon('warning', 20)]),
        el('div', { class: 'grow' }, [el('b', { text: `${pendingVerify.length} nhật ký chờ duyệt trong địa bàn` }), el('div', { class: 'muted', text: 'Báo cáo tổng hợp đang ở trạng thái "số liệu tạm tính" cho tới khi HTX duyệt xong.' })]),
      ]) : null,
      el('div', { class: 'grid cols-4' }, [
        kpi('HTX trong địa bàn', num(k.htx), `${num(k.area_ha)} ha đăng ký · ${num(k.farmers)} nông hộ`, null, 'building'),
        kpi('Thửa đã số hoá', num(k.plots), 'Polygon do HTX/cán bộ vẽ', null, 'plot'),
        kpi('Nhiệm vụ mới', num(counts.moi ?? 0), `${num(open)} chưa đóng · ${(dash.overdueSla ?? []).length} quá SLA 24h`, null, 'task'),
        kpi('Lượt rút nước AWD (30 ngày)', num(dash.awdLogs30d), 'Dữ liệu MRV từ nhật ký đã ghi', null, 'water'),
      ]),
      (dash.overdueSla ?? []).length ? card('Nhiệm vụ quá SLA tiếp nhận 24 giờ', [
        alert(`${dash.overdueSla.length} yêu cầu của HTX chưa có cán bộ tiếp nhận sau 24 giờ — đã/sẽ leo thang lên TTKN tỉnh.`, 'bad'),
        table([{ key: 'code', label: 'Mã' }, { key: 'title', label: 'Nội dung' }, { key: 'htx_name', label: 'HTX', render: (r) => r.htx_name ?? '—' }, { key: 'created_at', label: 'Tạo lúc', render: (r) => dateTime(r.created_at) }], dash.overdueSla),
      ], el('button', { class: 'ghost small', onclick: () => navigate('kn-tasks') }, ['Mở nhiệm vụ →'])) : null,
      el('div', { class: 'split wide-left' }, [
        card('Diện tích & HTX theo tỉnh', [
          (dash.byProvince ?? []).length ? svgBarChart(dash.byProvince.map((p) => ({ label: p.name, value: Math.round(p.area_ha) })), { height: 210, unit: 'ha' }) : emptyState('Chưa có tỉnh nào trong phạm vi.', 'map'),
          table([{ key: 'name', label: 'Tỉnh' }, { key: 'htx', label: 'HTX', align: 'right' }, { key: 'area_ha', label: 'Diện tích (ha)', align: 'right', render: (r) => num(r.area_ha) }, { key: 'plots', label: 'Thửa', align: 'right' }], dash.byProvince ?? [], { plain: true, empty: '—' }),
        ]),
        el('div', { class: 'stack' }, [
          dash.weather?.length ? el('div', { class: 'weather-card' }, [
            el('div', {}, [el('div', { class: 'temp', text: `${num(dash.weather[0].temp_c)}°` }), el('div', { text: dateOnly(dash.weather[0].observed_for) }), el('div', { style: 'opacity:.9;font-size:12.5px', text: `Mưa ${num(dash.weather[0].rainfall_mm)} mm · Ẩm ${num(dash.weather[0].humidity_pct)}%` })]),
            el('div', { class: 'days' }, dash.weather.slice(1, 4).map((d) => el('div', { class: 'day' }, [el('b', { text: `${num(d.temp_c)}°` }), String(d.observed_for).slice(5)]))),
          ]) : null,
          card('Nhật ký chờ xác minh', table([
            { key: 'log_date', label: 'Ngày' }, { key: 'htx_name', label: 'HTX' }, { key: 'plot_code', label: 'Thửa' }, { key: 'activity', label: 'Hoạt động' },
            { key: 'gps_status', label: 'GPS', render: (r) => badge(r.gps_status === 'khop' ? 'Khớp' : r.gps_status === 'khong_khop' ? 'Không khớp' : 'Thiếu', r.gps_status === 'khop' ? 'good' : r.gps_status === 'khong_khop' ? 'bad' : 'neutral') },
          ], pendingVerify.slice(0, 8), { plain: true, empty: 'Không có nhật ký chờ duyệt.' })),
        ]),
      ]),
      el('div', { class: 'grid cols-2' }, [
        card('Nhiệm vụ gần đây', table([
          { key: 'code', label: 'Mã' }, { key: 'title', label: 'Nội dung' }, { key: 'htx_name', label: 'HTX', render: (r) => r.htx_name ?? '—' },
          { key: 'sla', label: 'SLA', render: (r) => (r.status === 'moi' ? badge(r.slaBreached ? `Quá ${r.ageHours - r.slaHours}h` : `Còn ${r.slaRemainingHours}h`, r.slaBreached ? 'bad' : 'warn') : '—') },
          { key: 'status', label: 'Trạng thái', render: taskBadge },
        ], tasks.slice(0, 8), { empty: 'Chưa có nhiệm vụ nào.' }), el('button', { class: 'ghost small', onclick: () => navigate('kn-tasks') }, ['Xem tất cả →'])),
        card('Khoá đào tạo sắp tới', table([
          { key: 'title', label: 'Khoá' }, { key: 'start_date', label: 'Bắt đầu' }, { key: 'enrolled', label: 'Học viên', align: 'right', render: (r) => `${num(r.enrolled)}/${num(r.capacity)}` },
        ], courses.slice(0, 8), { empty: 'Chưa có khoá đào tạo nào.' }), el('button', { class: 'ghost small', onclick: () => navigate('kn-training') }, ['Xem tất cả →'])),
      ]),
    );
  },
});

// ===========================================================================
// FN-03/04 — Cây tổ chức khuyến nông 3 cấp
// ===========================================================================

registerPage('kn-org', {
  title: 'Cây tổ chức khuyến nông 3 cấp',
  subtitle: 'Trung ương → Tỉnh → Xã / Tổ Khuyến nông cộng đồng; mỗi đầu mối là một phạm vi phân quyền dữ liệu (FN-03, FN-04)',
  async render(view) {
    const tree = await guard(api('/kn/org-tree'));
    const flat = flatten(tree);
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đơn vị cấp tỉnh', num(flat.filter((n) => n.level === 'tinh').length), null, null, 'building'),
        kpi('Tổ KNCĐ / cấp xã', num(flat.filter((n) => n.level === 'xa').length), null, null, 'users'),
        kpi('Tổng đầu mối', num(flat.length), 'Mỗi đầu mối là một phạm vi dữ liệu', null, 'grid'),
      ]),
      el('div', { class: 'split' }, [
        card('Sơ đồ tổ chức', renderTree(tree)),
        can('khuyennong.write')
          ? card('Thêm đầu mối tổ chức (FN-04)', [
              el('p', { class: 'muted', text: 'Đầu mối cấp dưới kế thừa phạm vi dữ liệu của đầu mối cha; không xoá trực tiếp đầu mối cha vì kéo theo toàn bộ nhánh.' }),
              form([
                { name: 'code', label: 'Mã đầu mối', required: true, placeholder: 'VD: KN-AG-CHOMOI' }, { name: 'name', label: 'Tên đơn vị', required: true },
                { name: 'level', label: 'Cấp', type: 'select', required: true, options: Object.entries(ORG_LEVEL).map(([value, label]) => ({ value, label })) },
                { name: 'parentId', label: 'Trực thuộc', type: 'select', options: [{ value: '', label: '— Không (cấp cao nhất) —' }, ...flat.map((n) => ({ value: n.id, label: `${n.code} — ${n.name}` }))] },
              ], async (v) => { await api('/kn/org-nodes', { body: { ...v, parentId: v.parentId || null } }); toast('Đã thêm đầu mối tổ chức.'); await this.render(view); }, { submitLabel: 'Thêm đầu mối' }),
            ])
          : card('Danh sách đầu mối', table([{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên đơn vị' }, { key: 'level', label: 'Cấp', render: (r) => badge(ORG_LEVEL[r.level] ?? r.level, 'neutral') }], flat)),
      ]),
    );
  },
});

// ===========================================================================
// HTX & cơ giới hoá trong địa bàn — US-HTX-01/04
// ===========================================================================

registerPage('kn-network', {
  title: 'HTX & cơ giới hoá địa bàn',
  subtitle: 'Danh sách HTX trong phạm vi quản lý, nông hộ, thửa đã vẽ và khai báo số máy theo khâu',
  async render(view) {
    let q = '';
    const body = el('div');
    const draw = async () => {
      const list = await guard(api(`/kn/htx${q ? `?q=${encodeURIComponent(q)}` : ''}`));
      body.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('HTX', num(list.length), null, null, 'building'),
          kpi('Nông hộ', num(list.reduce((a, c) => a + (c.farmer_count ?? 0), 0)), null, null, 'users'),
          kpi('Thửa đã vẽ', num(list.reduce((a, c) => a + (c.plot_count ?? 0), 0)), `${num(list.reduce((a, c) => a + (c.plot_area_ha ?? 0), 0))} ha`, null, 'plot'),
          kpi('Máy khai báo', num(list.reduce((a, c) => a + (c.declared_machines ?? 0), 0)), `${num(list.reduce((a, c) => a + (c.registered_machines ?? 0), 0))} máy đã có hồ sơ CGH`, null, 'tractor'),
        ]),
        card('Hợp tác xã trong phạm vi', table([
          { key: 'code', label: 'Mã' }, { key: 'name', label: 'HTX' }, { key: 'province_name', label: 'Tỉnh', render: (r) => r.province_name ?? '—' },
          { key: 'tax_code', label: 'MST', render: (r) => r.tax_code ?? badge('Chưa có', 'warn') },
          { key: 'farmer_count', label: 'Nông hộ', align: 'right' }, { key: 'plot_count', label: 'Thửa', align: 'right' },
          { key: 'plot_area_ha', label: 'DT vẽ / đăng ký', align: 'right', render: (r) => `${num(r.plot_area_ha, 1)} / ${num(r.registered_area_ha)} ha` },
          { key: 'declared_machines', label: 'Máy khai báo', align: 'right', render: (r) => `${num(r.declared_machines)} (${num(r.registered_machines)} hồ sơ)` },
          { key: 'act', label: '', render: (r) => el('span', { class: 'chip-row' }, [
            el('button', { class: 'ghost small', onclick: () => openMachinery(r) }, [icon('tractor', 14), 'Máy móc']),
            can('mdm.write') ? el('button', { class: 'ghost small', onclick: () => navigate('kn-plots') }, [icon('plot', 14), 'Vẽ thửa']) : null,
          ]) },
        ], list, { empty: 'Không có HTX nào trong phạm vi / khớp từ khoá.' })),
      );
    };
    async function openMachinery(htx) {
      const rows = await guard(api(`/kn/htx/${htx.id}/machinery`));
      const inputs = new Map();
      const dlg = modal(`Khai báo cơ giới hoá — ${htx.name}`, [
        el('p', { class: 'muted', text: 'Số máy do HTX/cán bộ khai báo theo chủng loại. Cột "Hồ sơ CGH" là số máy đã có hồ sơ chi tiết ở Bản đồ Cơ giới hoá — hai con số này có thể khác nhau.' }),
        table([
          { key: 'stage', label: 'Khâu', render: (r) => STAGE_LABEL[r.stage] ?? r.stage }, { key: 'name', label: 'Chủng loại' },
          { key: 'registered', label: 'Hồ sơ CGH', align: 'right' },
          { key: 'quantity', label: 'Khai báo', render: (r) => { const i = el('input', { type: 'number', min: '0', step: '1', value: r.quantity, style: 'width:90px', disabled: !can('khuyennong.write') }); inputs.set(r.machine_type_id, i); return i; } },
          { key: 'updated_at', label: 'Cập nhật', render: (r) => (r.updated_at ? `${dateOnly(r.updated_at)} · ${r.declared_by ?? ''}` : '—') },
        ], rows, { plain: true }),
      ], can('khuyennong.write') ? [
        el('button', { class: 'ghost', text: 'Đóng', onclick: () => dlg.close() }),
        el('button', { text: 'Lưu khai báo', onclick: async () => {
          const payload = [...inputs].map(([machineTypeId, i]) => ({ machineTypeId, quantity: Number(i.value) })).filter((r) => Number.isFinite(r.quantity));
          await guard(api(`/kn/htx/${htx.id}/machinery`, { method: 'PUT', body: { rows: payload } })); toast('Đã lưu khai báo máy móc.'); dlg.close(); await draw();
        } }),
      ] : [], { wide: true });
    }
    view.replaceChildren(el('div', { class: 'row' }, [el('input', { placeholder: 'Tìm HTX theo tên, mã, MST…', oninput: (e) => { q = e.target.value.trim(); draw(); } })]), body);
    await draw();
  },
});

// ===========================================================================
// Nhiệm vụ hỗ trợ HTX — US-TASK
// ===========================================================================

registerPage('kn-tasks', {
  title: 'Nhiệm vụ hỗ trợ HTX',
  subtitle: 'Yêu cầu từ Cổng HTX tự thành nhiệm vụ · SLA tiếp nhận 24 giờ · quá hạn leo thang lên TTKN tỉnh · phân công hàng loạt',
  async render(view, actions) {
    const [tasks, staff] = await Promise.all([guard(api('/kn/tasks/v2')), api('/kn/staff').catch(() => [])]);
    let filter = 'all'; let onlyBreached = false;
    const selected = new Set();
    const body = el('div');
    const bulkBar = el('div', { class: 'save-bar', hidden: true });

    if (can('khuyennong.publish')) {
      actions.append(el('button', { class: 'ghost small', onclick: async () => { const r = await guard(api('/kn/tasks/escalate-overdue', { body: {} })); toast(`Đã leo thang ${r.escalated} nhiệm vụ quá SLA.`); await this.render(view, (actions.replaceChildren(), actions)); } }, [icon('warning', 15), 'Leo thang quá SLA']));
    }
    const drawBulk = () => {
      bulkBar.hidden = !selected.size;
      if (!selected.size) return;
      const sel = el('select', {}, staff.map((s) => el('option', { value: s.id }, [`${s.fullName} (${s.roles.join(', ')})`])));
      bulkBar.replaceChildren(el('strong', { text: `${selected.size} nhiệm vụ đã chọn` }), sel,
        el('button', { class: 'small', onclick: async () => { const r = await guard(api('/kn/tasks/bulk-assign', { body: { ids: [...selected], assigneeId: sel.value } })); toast(`Đã phân công ${r.assigned} nhiệm vụ.`); selected.clear(); await this.render(view, (actions.replaceChildren(), actions)); } }, [icon('users', 14), 'Phân công']),
        el('button', { class: 'ghost small', onclick: () => { selected.clear(); draw(); } }, ['Bỏ chọn']));
    };
    const draw = () => {
      const rows = tasks.filter((t) => (filter === 'all' || t.status === filter) && (!onlyBreached || t.slaBreached));
      body.replaceChildren(table([
        can('khuyennong.publish') ? { key: 'sel', label: '', render: (r) => (r.status !== 'dong' && r.status !== 'hoan_thanh' ? el('input', { type: 'checkbox', checked: selected.has(r.id) ? true : null, onchange: (e) => { if (e.target.checked) selected.add(r.id); else selected.delete(r.id); drawBulk(); } }) : '') } : null,
        { key: 'code', label: 'Mã' }, { key: 'title', label: 'Nội dung' }, { key: 'htx_name', label: 'HTX', render: (r) => r.htx_name ?? '—' },
        { key: 'origin', label: 'Nguồn', render: (r) => badge(r.origin === 'app_htx' ? 'Cổng HTX' : 'Chỉ đạo', 'neutral') },
        { key: 'sla', label: 'SLA 24h', render: (r) => (r.status === 'moi' ? badge(r.slaBreached ? `Quá ${r.ageHours - r.slaHours}h` : `Còn ${r.slaRemainingHours}h`, r.slaBreached ? 'bad' : 'warn') : (r.escalated_to ? badge(`→ ${r.escalated_to}`, 'info') : '—')) },
        { key: 'assignee_name', label: 'Phụ trách', render: (r) => r.assignee_name ?? r.assignee_id ?? '—' },
        { key: 'status', label: 'Trạng thái', render: taskBadge },
        { key: 'created_at', label: 'Tạo lúc', render: (r) => dateTime(r.created_at) },
        { key: 'action', label: '', render: (r) => (can('khuyennong.write') && r.status !== 'dong' ? el('span', { class: 'chip-row' }, [
          el('button', { class: 'ghost small', text: nextLabel(r.status), onclick: async () => { await guard(api(`/kn/tasks/${r.id}/advance`, { body: { status: nextStatus(r.status) } })); toast('Đã cập nhật nhiệm vụ.'); await this.render(view, (actions.replaceChildren(), actions)); } }),
          !r.escalated_at ? el('button', { class: 'ghost small', title: 'Chuyển tiếp lên tỉnh', onclick: async () => { const note = await promptDialog('Chuyển tiếp lên TTKN tỉnh', { placeholder: 'Lý do / nội dung cần hỗ trợ' }); if (note === null) return; await guard(api(`/kn/tasks/${r.id}/escalate`, { body: { note } })); toast('Đã chuyển tiếp.'); await this.render(view, (actions.replaceChildren(), actions)); } }, [icon('arrow', 14)]) : null,
        ]) : '—') },
      ].filter(Boolean), rows, { empty: 'Không có nhiệm vụ nào ở trạng thái này.' }));
      drawBulk();
    };
    const counts = Object.fromEntries(FLOW.map((st) => [st, tasks.filter((t) => t.status === st).length]));
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Mới', num(counts.moi), `${tasks.filter((t) => t.slaBreached).length} quá SLA`, null, 'task'),
        kpi('Đang xử lý', num(counts.tiep_nhan + counts.dang_xu_ly), null, null, 'refresh'),
        kpi('Hoàn thành', num(counts.hoan_thanh), null, null, 'check'),
        kpi('Đã leo thang', num(tasks.filter((t) => t.escalated_at).length), 'Lên TTKN tỉnh', null, 'arrow'),
      ]),
      card('Danh sách nhiệm vụ', [
        el('div', { class: 'row' }, [
          chips([{ value: 'all', label: 'Tất cả' }, ...FLOW.map((st) => ({ value: st, label: `${TASK_STATUS[st].label} (${counts[st]})` }))], filter, (v) => { filter = v; draw(); }),
          el('label', { class: 'pick-item' }, [el('input', { type: 'checkbox', onchange: (e) => { onlyBreached = e.target.checked; draw(); } }), 'Chỉ quá SLA']),
        ]),
        body, bulkBar,
      ]),
    );
    draw();
  },
});

// ===========================================================================
// Chỉ đạo điều hành & cảnh báo vùng — FN-07/08, US-TASK-03
// ===========================================================================

registerPage('kn-broadcast', {
  title: 'Chỉ đạo & cảnh báo vùng',
  subtitle: 'Phát chỉ đạo xuống đầu mối trong phạm vi (mỗi đơn vị một nhiệm vụ theo dõi) · cảnh báo khẩn tới toàn bộ cán bộ và HTX một tỉnh',
  async render(view) {
    const [tree, tasks, provinces] = await Promise.all([guard(api('/kn/org-tree')), api('/kn/tasks'), api('/mdm/admin-units?level=province').catch(() => [])]);
    const flat = flatten(tree);
    const directives = tasks.filter((t) => t.origin !== 'app_htx');
    view.replaceChildren(
      el('div', { class: 'grid cols-2' }, [
        card('Phát chỉ đạo', [
          el('p', { class: 'muted', text: 'Chỉ đạo tới đầu mối đã chọn VÀ toàn bộ nhánh cấp dưới; mỗi đơn vị nhận một nhiệm vụ riêng để theo dõi tiến độ.' }),
          form([
            { name: 'title', label: 'Tiêu đề chỉ đạo', required: true }, { name: 'content', label: 'Nội dung', type: 'textarea', rows: 3, required: true },
            { name: 'orgNodeId', label: 'Phạm vi', type: 'select', required: true, options: flat.map((n) => ({ value: n.id, label: `${'— '.repeat(n.depth)}${n.name} (${ORG_LEVEL[n.level] ?? n.level})` })) },
            { name: 'dueDate', label: 'Hạn xử lý', type: 'date' },
          ], async (v) => { const r = await api('/kn/broadcast', { body: v }); toast(`Đã phát chỉ đạo tới ${r.recipients ?? r.created ?? 0} đầu mối.`); await this.render(view); }, { submitLabel: 'Phát chỉ đạo' }),
        ]),
        card('Cảnh báo khẩn theo vùng (US-TASK-03)', [
          el('p', { class: 'muted', text: 'Gửi thông báo tới MỌI cán bộ khuyến nông và tài khoản HTX thuộc tỉnh đã chọn. Dùng cho dịch hại bùng phát, thời tiết cực đoan.' }),
          form([
            { name: 'provinceId', label: 'Tỉnh', type: 'select', required: true, options: provinces.filter((p) => p.level === 'province').map((p) => ({ value: p.id, label: p.name })) },
            { name: 'severity', label: 'Mức', type: 'select', options: [{ value: 'warn', label: 'Cảnh báo' }, { value: 'critical', label: 'KHẨN' }, { value: 'info', label: 'Thông tin' }] },
            { name: 'title', label: 'Tiêu đề', required: true }, { name: 'body', label: 'Nội dung', type: 'textarea', rows: 3, required: true },
          ], async (v) => { if (!(await confirmDialog(`Gửi cảnh báo "${v.title}" tới toàn bộ cán bộ & HTX của tỉnh đã chọn?`, { okLabel: 'Gửi ngay' }))) throw new Error('Đã huỷ.'); const r = await api('/kn/alerts/regional', { body: v }); toast(`Đã gửi cảnh báo tới ${r.recipients} người nhận.`); }, { submitLabel: 'Gửi cảnh báo' }),
        ]),
      ]),
      card('Chỉ đạo đã phát & tiến độ tiếp nhận', table([
        { key: 'code', label: 'Mã' }, { key: 'title', label: 'Nội dung' }, { key: 'org_name', label: 'Đơn vị nhận' }, { key: 'due_date', label: 'Hạn' },
        { key: 'status', label: 'Trạng thái', render: taskBadge }, { key: 'created_at', label: 'Phát lúc', render: (r) => dateTime(r.created_at) },
      ], directives, { empty: 'Chưa phát chỉ đạo nào.' })),
    );
  },
});

// ===========================================================================
// Thư viện kỹ thuật — US-LIB
// ===========================================================================

registerPage('kn-library', {
  title: 'Thư viện kỹ thuật & tin tức',
  subtitle: 'Chuyên mục, tin khẩn, hướng dẫn bổ sung địa phương gắn quy trình chuẩn; chỉ nội dung ĐÃ XUẤT BẢN mới hiện ở Cổng HTX',
  async render(view, actions) {
    const [tree, categories] = await Promise.all([api('/kn/org-tree'), api('/kn/news-categories').catch(() => ({}))]);
    const flat = flatten(tree);
    let q = ''; let category = ''; let status = '';
    const listBox = el('div');
    const suggestBox = el('div', { class: 'chip-row' });
    const catTiles = el('div', { class: 'grid cols-4', style: 'grid-template-columns:repeat(auto-fit,minmax(150px,1fr))' });
    let all = [];

    if (can('khuyennong.publish')) {
      actions.append(el('button', { class: 'ghost small', onclick: async () => { const r = await guard(api('/kn/push-to-app-htx', { body: {} })); toast(`Đã đồng bộ ${r.recordCount} bản ghi.`); } }, [icon('upload', 15), 'Đẩy sang Cổng HTX']));
    }
    const draw = async () => {
      const data = await guard(api(`/kn/articles/search?${q ? `q=${encodeURIComponent(q)}&` : ''}${category ? `category=${category}&` : ''}${status ? `status=${status}` : ''}`));
      all = data.items;
      suggestBox.replaceChildren(...(data.suggestions ?? []).map((s) => el('button', { class: 'chip', text: s, onclick: () => { q = s; search.value = s; draw(); } })));
      if (data.suggestions?.length) suggestBox.prepend(el('span', { class: 'muted', text: 'Không có kết quả — gợi ý:' }));
      catTiles.replaceChildren(...Object.entries(categories).map(([code, label]) => el('button', { class: 'libcat', style: `background:${CAT_COLORS[code] ?? 'var(--brand)'}`, onclick: () => { category = category === code ? '' : code; draw(); } }, [
        el('b', { text: label }), el('span', { text: `${all.filter((a) => a.category === code).length} bài · ${all.filter((a) => a.category === code && a.status === 'published').length} đã xuất bản` }),
      ])));
      listBox.replaceChildren(table([
        { key: 'code', label: 'Mã' },
        { key: 'title', label: 'Tiêu đề', render: (r) => el('span', {}, [r.urgent ? badge('KHẨN', 'bad') : null, ' ', r.title, r.parent_id ? el('span', { class: 'muted', text: ' · bổ sung địa phương' }) : null]) },
        { key: 'kind', label: 'Loại', render: (r) => badge(ARTICLE_KIND[r.kind] ?? r.kind, 'neutral') },
        { key: 'category', label: 'Chuyên mục', render: (r) => categories[r.category] ?? r.category ?? '—' },
        { key: 'region_label', label: 'Phạm vi', render: (r) => (r.region_label ? el('span', { class: 'std prov', text: r.region_label }) : el('span', { class: 'std', text: r.scope_name ?? 'TOÀN HỆ THỐNG' })) },
        { key: 'view_count', label: 'Xem', align: 'right' },
        { key: 'status', label: 'Trạng thái', render: (r) => (r.status === 'published' ? badge('Đã xuất bản', 'good') : (can('khuyennong.publish')
          ? el('button', { class: 'ghost small', text: 'Xuất bản', onclick: async () => { const out = await guard(api(`/kn/articles/${r.id}/publish/v2`, { body: {} })); toast(`Đã xuất bản${out.notified ? ` — thông báo ${out.notified} người` : ''}.`); await draw(); } })
          : badge('Nháp', 'neutral'))) },
        { key: 'act', label: '', render: (r) => el('span', { class: 'chip-row' }, [
          el('button', { class: 'ghost small', onclick: () => modal(r.title, [el('div', { class: 'chip-row' }, [badge(ARTICLE_KIND[r.kind] ?? r.kind, 'neutral'), r.crop ? badge(r.crop, 'info') : null]), r.summary ? el('p', { style: 'font-weight:600', text: r.summary }) : null, el('div', { style: 'white-space:pre-wrap;line-height:1.7', text: r.body ?? '' })], [], { wide: true }) }, [icon('eye', 14)]),
          can('khuyennong.write') && r.kind === 'quy_trinh' && !r.parent_id ? el('button', { class: 'ghost small', title: 'Thêm hướng dẫn bổ sung địa phương', onclick: () => composeLocal(r) }, [icon('pin', 14), 'Bổ sung địa phương']) : null,
        ]) },
      ], all, { empty: 'Không có nội dung phù hợp.' }));
    };
    const search = el('input', { placeholder: 'Tìm theo tiêu đề, tóm tắt, nội dung, giống cây…', oninput: (e) => { q = e.target.value.trim(); draw(); } });
    function composeLocal(parent) {
      const dlg = modal(`Hướng dẫn địa phương cho: ${parent.title}`, [
        el('p', { class: 'muted', text: 'Nội dung bổ sung của tỉnh gắn với quy trình chuẩn quốc gia, hiển thị kèm nhãn tỉnh và không thay thế quy trình gốc (US-LIB-04).' }),
        form([
          { name: 'title', label: 'Tiêu đề', required: true, value: `${parent.title} — hướng dẫn địa phương` },
          { name: 'regionLabel', label: 'Nhãn tỉnh', required: true, placeholder: 'VD: Đồng Tháp' },
          { name: 'scopeNodeId', label: 'Phạm vi áp dụng', type: 'select', options: [{ value: '', label: '— Toàn hệ thống —' }, ...flat.map((n) => ({ value: n.id, label: n.name }))] },
          { name: 'summary', label: 'Tóm tắt', type: 'textarea', rows: 2 }, { name: 'body', label: 'Nội dung', type: 'textarea', rows: 5 },
        ], async (v) => { await api('/kn/articles/v2', { body: { ...v, kind: 'quy_trinh', category: 'ky_thuat', parentId: parent.id, scopeNodeId: v.scopeNodeId || null } }); toast('Đã tạo bản nháp hướng dẫn địa phương.'); dlg.close(); await draw(); }, { submitLabel: 'Tạo bản nháp', stacked: true }),
      ], [], { wide: true });
    }
    view.replaceChildren(
      catTiles,
      el('div', { class: 'row' }, [search, chips([{ value: '', label: 'Tất cả' }, { value: 'published', label: 'Đã xuất bản' }, { value: 'draft', label: 'Nháp' }], status, (v) => { status = v; draw(); })]),
      suggestBox,
      can('khuyennong.write') ? el('details', { class: 'card tight' }, [
        el('summary', { style: 'cursor:pointer;font-weight:600', text: '+ Soạn nội dung mới' }),
        form([
          { name: 'title', label: 'Tiêu đề', required: true },
          { name: 'kind', label: 'Loại', type: 'select', required: true, options: Object.entries(ARTICLE_KIND).map(([value, label]) => ({ value, label })) },
          { name: 'category', label: 'Chuyên mục', type: 'select', required: true, options: Object.entries(categories).map(([value, label]) => ({ value, label })) },
          { name: 'crop', label: 'Cây trồng', placeholder: 'Lúa' },
          { name: 'scopeNodeId', label: 'Phạm vi', type: 'select', options: [{ value: '', label: '— Toàn hệ thống —' }, ...flat.map((n) => ({ value: n.id, label: n.name }))] },
          { name: 'urgent', label: 'Tin KHẨN (đẩy thông báo tới nông dân & HTX khi xuất bản)', type: 'checkbox' },
          { name: 'summary', label: 'Tóm tắt', type: 'textarea', rows: 2 }, { name: 'body', label: 'Nội dung', type: 'textarea', rows: 5 },
        ], async (v) => { await api('/kn/articles/v2', { body: { ...v, scopeNodeId: v.scopeNodeId || null } }); toast('Đã tạo bản nháp. Cần XUẤT BẢN thì nông dân mới thấy.'); await draw(); }, { submitLabel: 'Tạo bản nháp' }),
      ]) : null,
      card('Danh mục nội dung', listBox),
    );
    await draw();
  },
});

// ===========================================================================
// Giá cả thị trường — US-PRICE
// ===========================================================================

registerPage('kn-prices', {
  title: 'Giá cả thị trường',
  subtitle: 'Bảng giá theo mặt hàng & vùng · bản tin giá ngày gửi tới HTX · theo dõi biến động vượt ngưỡng cá nhân',
  async render(view, actions) {
    const [prices, watch] = await Promise.all([guard(api('/kn/prices')), api('/kn/prices/watchlist').catch(() => [])]);
    const commodities = [...new Set(prices.map((p) => p.commodity))];
    if (can('khuyennong.publish')) {
      actions.append(el('button', { class: 'small', onclick: () => {
        const dlg = modal('Công bố bản tin giá ngày', [
          el('p', { class: 'muted', text: 'Bản tin gom bảng giá HÔM NAY thành một tin "Thị trường & giá" và xuất bản tới Cổng HTX. Chỉ công bố được khi giá trong ngày đã được nạp.' }),
          form([{ name: 'region', label: 'Vùng', required: true, placeholder: 'VD: An Giang' }, { name: 'note', label: 'Ghi chú', type: 'textarea', rows: 2 }],
            async (v) => { const out = await api('/kn/prices/bulletin', { body: v }); toast(`Đã công bố bản tin ${out.code ?? ''}.`); dlg.close(); }, { submitLabel: 'Công bố', stacked: true }),
        ]);
      } }, [icon('megaphone', 15), 'Bản tin giá ngày']));
    }
    const watchBox = el('div');
    const drawWatch = (list) => watchBox.replaceChildren(list.length ? table([
      { key: 'commodity', label: 'Mặt hàng' }, { key: 'threshold_pct', label: 'Ngưỡng', align: 'right', render: (r) => pct(r.threshold_pct, 0) },
      { key: 'latest', label: 'Giá mới nhất', render: (r) => (r.latest ? `${num(r.latest.price)} ${r.latest.unit} (${r.latest.changePct ?? 0}%)` : '—') },
      { key: 'triggered', label: 'Trạng thái', render: (r) => badge(r.triggered ? 'Vượt ngưỡng' : 'Ổn định', r.triggered ? 'bad' : 'good') },
      { key: 'x', label: '', render: (r) => el('button', { class: 'ghost small danger', onclick: async () => { await guard(api(`/kn/prices/watchlist/${encodeURIComponent(r.commodity)}`, { method: 'DELETE' })); drawWatch(list.filter((w) => w.id !== r.id)); } }, [icon('trash', 14)]) },
    ], list, { plain: true }) : el('p', { class: 'muted', text: 'Chưa theo dõi mặt hàng nào.' }));
    drawWatch(watch);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Mặt hàng', num(commodities.length), null, null, 'price'),
        kpi('Đang tăng', num(prices.filter((p) => p.trend === 'tang').length), null, null, 'arrow'),
        kpi('Đang giảm', num(prices.filter((p) => p.trend === 'giam').length), null, null, 'warning'),
        kpi('Theo dõi vượt ngưỡng', num(watch.filter((w) => w.triggered).length), `${watch.length} mặt hàng theo dõi`, null, 'bell'),
      ]),
      el('div', { class: 'split wide-left' }, [
        card('Bảng giá hiện hành', table([
          { key: 'commodity', label: 'Mặt hàng' }, { key: 'region', label: 'Vùng' },
          { key: 'price', label: 'Giá', align: 'right', render: (r) => `${num(r.price)} ${r.unit}` },
          { key: 'change', label: 'Biến động', align: 'right', render: (r) => (r.changePct == null ? '—' : badge(`${r.change > 0 ? '▲' : r.change < 0 ? '▼' : '■'} ${pct(Math.abs(r.changePct))}`, r.trend === 'tang' ? 'good' : r.trend === 'giam' ? 'bad' : 'neutral')) },
          { key: 'price_date', label: 'Ngày' }, { key: 'source', label: 'Nguồn' },
          can('khuyennong.publish') ? { key: 'x', label: '', render: (r) => (r.id ? el('button', { class: 'ghost small danger', title: 'Xoá bản ghi giá nhập sai', onclick: async () => { if (!(await confirmDialog(`Xoá bản ghi giá ${r.commodity} · ${r.region ?? ''} · ${r.price_date}?`, { danger: true, okLabel: 'Xoá' }))) return; await guard(api(`/kn/prices/${r.id}`, { method: 'DELETE' })); toast('Đã xoá bản ghi giá.'); await this.render(view, (actions.replaceChildren(), actions)); } }, [icon('trash', 14)]) : '') } : null,
        ].filter(Boolean), prices, { empty: 'Chưa có dữ liệu giá.' })),
        el('div', { class: 'stack' }, [
          card('Theo dõi biến động (US-PRICE-03)', [
            watchBox,
            form([
              { name: 'commodity', label: 'Mặt hàng', type: 'select', required: true, options: commodities.map((c) => ({ value: c, label: c })) },
              { name: 'thresholdPct', label: 'Ngưỡng (%)', type: 'number', step: '0.5', min: '0.5', value: 5, required: true },
            ], async (v) => { const list = await api('/kn/prices/watchlist', { method: 'PUT', body: v }); drawWatch(list); toast('Đã cập nhật theo dõi.'); }, { submitLabel: 'Theo dõi' }),
          ]),
          can('khuyennong.publish') ? card('Công bố giá mới (Master Data — chỉ cấp công bố)', form([
            { name: 'commodity', label: 'Mặt hàng', required: true, placeholder: 'VD: Lúa OM5451' }, { name: 'region', label: 'Vùng', required: true, placeholder: 'VD: An Giang' },
            { name: 'price', label: 'Giá', type: 'number', required: true, step: '1' }, { name: 'unit', label: 'Đơn vị', required: true, value: 'đ/kg' },
            { name: 'priceDate', label: 'Ngày áp dụng', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) }, { name: 'source', label: 'Nguồn', placeholder: 'VD: Sở NN&MT' },
          ], async (v) => { await api('/kn/prices', { body: v }); toast('Đã công bố giá mới.'); await this.render(view, (actions.replaceChildren(), actions)); }, { submitLabel: 'Công bố giá' })) : null,
        ]),
      ]),
    );
  },
});

// ===========================================================================
// Báo cáo tổng hợp — US-RPT
// ===========================================================================

registerPage('kn-reports', {
  title: 'Báo cáo tổng hợp',
  subtitle: 'Số liệu HTX, thửa, nông hộ, vụ, sản lượng, AWD theo phạm vi vai trò · xuất CSV / in · lịch gửi định kỳ',
  async render(view, actions) {
    const report = await guard(api('/kn/reports/summary'));
    actions.append(
      el('button', { class: 'ghost small', onclick: () => downloadUrl('/kn/reports/summary.csv', 'bao-cao-khuyen-nong.csv') }, [icon('download', 15), 'CSV']),
      el('button', { class: 'ghost small', onclick: () => window.print() }, [icon('print', 15), 'In']),
      el('button', { class: 'ghost small', onclick: openSchedules }, [icon('calendar', 15), 'Lịch gửi']),
    );
    const rows = report.rows ?? [];
    const sum = (k) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const byProv = new Map();
    for (const r of rows) { const e = byProv.get(r.tinh) ?? { label: r.tinh ?? '—', value: 0 }; e.value += Number(r.dien_tich_da_ve_ha ?? 0); byProv.set(r.tinh, e); }
    view.replaceChildren(
      report.provisional ? alert('SỐ LIỆU TẠM TÍNH — còn nhật ký chờ duyệt trong phạm vi. Số liệu sẽ chốt khi HTX duyệt xong (US-DASH-02).', 'warn') : alert(`Số liệu đã chốt · phạm vi: ${report.scope}`, 'good'),
      el('div', { class: 'grid cols-4' }, [
        kpi('HTX', num(rows.length), report.scope, null, 'building'),
        kpi('Diện tích đã vẽ', `${num(sum('dien_tich_da_ve_ha'), 1)} ha`, `/ ${num(sum('dien_tich_dang_ky_ha'))} ha đăng ký`, null, 'plot'),
        kpi('Sản lượng lúa', `${num(sum('san_luong_lua_tan'), 1)} t`, `${num(sum('vu_dang_canh_tac'))} vụ đang canh tác`, null, 'harvest'),
        kpi('Lượt AWD', num(sum('luot_awd')), 'Dữ liệu MRV', null, 'water'),
      ]),
      byProv.size > 1 ? card('Diện tích đã vẽ theo tỉnh', svgBarChart([...byProv.values()], { height: 200, unit: 'ha' })) : null,
      card('Chi tiết theo HTX', table([
        { key: 'tinh', label: 'Tỉnh' }, { key: 'ma_htx', label: 'Mã' }, { key: 'ten_htx', label: 'HTX' },
        { key: 'dien_tich_dang_ky_ha', label: 'DT đăng ký', align: 'right', render: (r) => num(r.dien_tich_dang_ky_ha) },
        { key: 'dien_tich_da_ve_ha', label: 'DT đã vẽ', align: 'right', render: (r) => num(r.dien_tich_da_ve_ha, 1) },
        { key: 'so_thua', label: 'Thửa', align: 'right' }, { key: 'so_ho', label: 'Hộ', align: 'right' }, { key: 'vu_dang_canh_tac', label: 'Vụ đang CT', align: 'right' },
        { key: 'san_luong_lua_tan', label: 'Lúa (t)', align: 'right', render: (r) => num(r.san_luong_lua_tan, 1) }, { key: 'luot_awd', label: 'AWD', align: 'right' },
        { key: 'nhiem_vu_mo', label: 'NV mở', align: 'right', render: (r) => (r.nhiem_vu_mo ? badge(String(r.nhiem_vu_mo), 'warn') : '0') },
      ], rows, { empty: 'Không có HTX trong phạm vi.' })),
    );
    async function openSchedules() {
      const list = await api('/reports/schedules?system=kn').catch(() => []);
      const body = el('div', { class: 'stack' });
      const draw = (items) => body.replaceChildren(items.length ? table([
        { key: 'report', label: 'Báo cáo' }, { key: 'frequency', label: 'Tần suất', render: (r) => ({ tuan: 'Tuần', thang: 'Tháng', quy: 'Quý' }[r.frequency] ?? r.frequency) }, { key: 'emails', label: 'Người nhận' }, { key: 'next_run_at', label: 'Lần tới', render: (r) => dateOnly(r.next_run_at) },
        { key: 'x', label: '', render: (r) => el('button', { class: 'ghost small danger', onclick: async () => { await guard(api(`/reports/schedules/${r.id}`, { method: 'DELETE' })); draw(items.filter((x) => x.id !== r.id)); } }, [icon('trash', 14)]) },
      ], items, { plain: true }) : el('p', { class: 'muted', text: 'Chưa có lịch.' }),
      form([
        { name: 'report', label: 'Báo cáo', type: 'select', options: [{ value: 'tong_hop', label: 'Tổng hợp địa bàn' }, { value: 'nhiem_vu', label: 'Nhiệm vụ & SLA' }, { value: 'san_luong', label: 'Sản lượng' }] },
        { name: 'frequency', label: 'Tần suất', type: 'select', options: [{ value: 'tuan', label: 'Hàng tuần' }, { value: 'thang', label: 'Hàng tháng' }, { value: 'quy', label: 'Hàng quý' }] },
        { name: 'emails', label: 'Email nhận', required: true },
      ], async (v) => { const c = await api('/reports/schedules', { body: { ...v, system: 'kn', scopeId: state.user?.provinceId ?? null } }); draw([...items, c]); toast('Đã đặt lịch.'); }, { submitLabel: 'Đặt lịch' }));
      draw(list);
      modal('Lịch gửi báo cáo định kỳ (US-RPT-03)', body);
    }
  },
});

// ===========================================================================
// FN-15 — Danh bạ trực hỗ trợ
// ===========================================================================

registerPage('kn-directory', {
  title: 'Danh bạ trực hỗ trợ',
  subtitle: 'Nông dân ở Cổng HTX gọi thẳng cán bộ đang trực theo địa bàn và chuyên môn (FN-15)',
  async render(view) {
    const [directory, tree] = await Promise.all([guard(api('/kn/directory')), api('/kn/org-tree')]);
    const flat = flatten(tree);
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đang trực', num(directory.filter((o) => o.on_duty).length), 'Hiển thị cho nông dân ngay lúc này', null, 'phone'),
        kpi('Tổng cán bộ', num(directory.length), null, null, 'users'),
        kpi('Đầu mối có người trực', num(new Set(directory.filter((o) => o.on_duty).map((o) => o.org_node_id)).size), `trên ${flat.length} đầu mối`, null, 'building'),
      ]),
      can('khuyennong.write') ? card('Thêm / cập nhật cán bộ', form([
        { name: 'fullName', label: 'Họ tên', required: true },
        { name: 'orgNodeId', label: 'Đơn vị', type: 'select', required: true, options: flat.map((n) => ({ value: n.id, label: `${n.name} (${ORG_LEVEL[n.level] ?? n.level})` })) },
        { name: 'phone', label: 'Điện thoại', required: true }, { name: 'specialty', label: 'Chuyên môn', placeholder: 'VD: Bảo vệ thực vật' },
        { name: 'onDuty', label: 'Trạng thái trực', type: 'select', options: [{ value: '1', label: 'Đang trực' }, { value: '0', label: 'Không trực' }] },
      ], async (v) => { await api('/kn/directory', { body: { ...v, onDuty: v.onDuty === '1' } }); toast('Đã cập nhật danh bạ.'); await this.render(view); }, { submitLabel: 'Lưu cán bộ' })) : null,
      card('Danh bạ', table([
        { key: 'full_name', label: 'Cán bộ' }, { key: 'org_name', label: 'Đơn vị' }, { key: 'level', label: 'Cấp', render: (r) => badge(ORG_LEVEL[r.level] ?? r.level, 'neutral') },
        { key: 'phone', label: 'Điện thoại', render: (r) => el('a', { href: `tel:${r.phone}`, text: r.phone }) }, { key: 'specialty', label: 'Chuyên môn' },
        { key: 'on_duty', label: 'Trực', render: (r) => badge(r.on_duty ? 'Đang trực' : 'Không trực', r.on_duty ? 'good' : 'neutral') },
      ], directory, { empty: 'Danh bạ trống.' })),
    );
  },
});

// ===========================================================================
// FN-12 — Đào tạo ToT
// ===========================================================================

registerPage('kn-training', {
  title: 'Đào tạo ToT',
  subtitle: 'Khoá đào tạo giảng viên nguồn và ghi danh học viên từ các HTX (FN-12)',
  async render(view) {
    const courses = await guard(api('/kn/courses'));
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Khoá đào tạo', num(courses.length), null, null, 'star'),
        kpi('Tổng học viên', num(courses.reduce((a, c) => a + (c.enrolled ?? 0), 0)), null, null, 'users'),
        kpi('Còn chỗ', num(courses.reduce((a, c) => a + Math.max(0, (c.capacity ?? 0) - (c.enrolled ?? 0)), 0)), 'Tổng chỗ trống', null, 'plus'),
      ]),
      can('khuyennong.write') ? card('Mở khoá đào tạo', form([
        { name: 'title', label: 'Tên khoá', required: true }, { name: 'startDate', label: 'Bắt đầu', type: 'date', required: true }, { name: 'endDate', label: 'Kết thúc', type: 'date' },
        { name: 'capacity', label: 'Số chỗ', type: 'number', required: true, min: '1' }, { name: 'location', label: 'Địa điểm' },
      ], async (v) => { await api('/kn/courses', { body: v }); toast('Đã mở khoá đào tạo.'); await this.render(view); }, { submitLabel: 'Mở khoá' })) : null,
      card('Danh sách khoá đào tạo', table([
        { key: 'code', label: 'Mã' }, { key: 'title', label: 'Khoá' }, { key: 'start_date', label: 'Bắt đầu' }, { key: 'location', label: 'Địa điểm' },
        { key: 'enrolled', label: 'Học viên', align: 'right', render: (r) => badge(`${num(r.enrolled)}/${num(r.capacity)}`, (r.enrolled ?? 0) >= (r.capacity ?? 0) ? 'warn' : 'good') },
        { key: 'status', label: 'Trạng thái' },
        { key: 'enrol', label: '', render: (r) => (can('khuyennong.write') && (r.enrolled ?? 0) < (r.capacity ?? 0)
          ? el('button', { class: 'ghost small', text: '+ Ghi danh', onclick: async () => { const name = await promptDialog('Họ tên học viên'); if (!name) return; await guard(api(`/kn/courses/${r.id}/enrol`, { body: { name } })); toast('Đã ghi danh.'); await this.render(view); } })
          : '—') },
      ], courses, { empty: 'Chưa có khoá đào tạo nào.' })),
    );
  },
});

// ===========================================================================
// FN-05/06 — Bản đồ vùng khuyến nông
// ===========================================================================

registerPage('kn-map', {
  title: 'Bản đồ vùng khuyến nông',
  subtitle: 'Mạng lưới đầu mối, HTX phụ trách và tình hình mùa vụ trên nền GIS dùng chung (FN-05, FN-06)',
  async render(view) {
    const [networkMap, bundle] = await Promise.all([guard(api('/kn/network-map')), api('/gis/map?layers=cooperatives,admin_boundaries,crop_heatmap').catch(() => ({ layers: {} }))]);
    const mapNode = mapContainer('kn-map-canvas', 'tall');
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đầu mối trên bản đồ', num(networkMap.nodes?.length ?? 0), null, null, 'building'),
        kpi('HTX', num(bundle.layers?.cooperatives?.length ?? 0), null, null, 'users'),
        kpi('HTX có dữ liệu mùa vụ', num(bundle.layers?.crop_heatmap?.length ?? 0), 'Từ App HTX qua GIS', null, 'seed'),
      ]),
      card('Bản đồ mạng lưới khuyến nông', [el('p', { class: 'muted', text: 'Nền bản đồ, ranh giới hành chính và toạ độ HTX lấy từ Nền tảng GIS dùng chung — mọi cổng đọc cùng một nguồn.' }), mapNode]),
    );
    if (!LEAFLET_AVAILABLE()) return;
    const map = createMap('kn-map-canvas');
    const L = window.L;
    for (const u of bundle.layers?.admin_boundaries ?? []) if (u.boundary) L.geoJSON(u.boundary, { style: { color: '#0B5F3C', weight: 1, fillOpacity: 0.02, dashArray: '4 3' } }).bindTooltip(u.name).addTo(map);
    for (const c of bundle.layers?.crop_heatmap ?? []) if (c.boundary) L.geoJSON(c.boundary, { style: { color: c.color, weight: 1, fillOpacity: 0.35 } }).bindTooltip(`${c.name} — ${c.stageLabel}`).addTo(map);
    for (const htx of bundle.layers?.cooperatives ?? []) {
      if (htx.lat == null) continue;
      L.circleMarker([htx.lat, htx.lng], { radius: 5, color: '#fff', fillColor: '#0E7A4B', fillOpacity: 1, weight: 1.5 }).bindTooltip(`${htx.code} — ${htx.name}`).addTo(map);
    }
    for (const node of networkMap.nodes ?? []) {
      if (node.lat == null) continue;
      L.marker([node.lat, node.lng]).bindTooltip(`${node.name} (${ORG_LEVEL[node.level] ?? node.level})`).addTo(map);
    }
    void statCard; void tabs; void emptyState;
  },
});
