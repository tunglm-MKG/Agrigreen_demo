/**
 * CHUỖI THU MUA RƠM — hợp đồng HTX, phiếu mua rơm & công nợ, danh mục ghe.
 *
 *   straw-contracts  (ERP)   Hợp đồng thu mua: cam kết, giá, tiến độ giao
 *   straw-tickets    (ERP)   Phiếu mua rơm sinh từ việc thu gom; xác nhận → công nợ; trả → tất toán
 *   vessels          (ERP + Cổng Hiện trường)  Danh mục ghe: chủ, lớp tàu, đăng kiểm, đơn giá thuê
 *   htx-contracts    (Cổng HTX)  HTX xem hợp đồng, phiếu và công nợ của chính mình
 */
import { api, registerPage, el, card, kpi, table, badge, alert, num, vnd, dateTime, toast, guard, can, form, state } from '/app.js';

const shortDate = (v) => (v ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : '—');
const TICKET_TONE = { cho_can: 'neutral', cho_xac_nhan: 'warn', da_xac_nhan: 'info', da_thanh_toan: 'good', huy: 'bad' };
const CONTRACT_TONE = { hieu_luc: 'good', het_han: 'neutral', huy: 'bad' };
const EXPIRY = { het_han: ['Hết đăng kiểm', 'bad'], sap_het_han: ['Sắp hết đăng kiểm', 'warn'], con_han: ['Còn hạn', 'good'], khong_ro: ['Chưa rõ', 'neutral'] };

let selectedContract = null;
let selectedTicket = null;
let selectedVessel = null;

const progressBar = (pct) => el('div', { class: 'bar', title: `${pct}%` }, [el('span', { style: `width:${Math.min(100, pct)}%` })]);

// ===========================================================================
// Hợp đồng thu mua
// ===========================================================================

registerPage('straw-contracts', {
  title: 'Hợp đồng thu mua rơm',
  subtitle: 'Mỗi HTX một hợp đồng hiệu lực: cam kết, cơ sở giá, tiến độ giao — việc thu gom và phiếu mua bám vào đây',
  async render(view, actions) {
    const [contracts, lookups] = await Promise.all([guard(api('/straw/contracts')), api('/field/lookups')]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const writable = can('procurement.write');
    const active = contracts.filter((c) => c.status === 'hieu_luc' && !c.expired);
    const detail = el('div', { class: 'grid' });

    const showContract = (c) => {
      selectedContract = c.id;
      detail.replaceChildren(card(`${c.code} — ${c.htx_name}`, [
        el('div', { class: 'chip-row' }, [
          badge(c.statusLabel, c.expired ? 'warn' : CONTRACT_TONE[c.status]), badge(c.priceBasisLabel, 'neutral'),
          badge(`${vnd(c.unit_price)} / ${c.price_basis === 'theo_cuon' ? 'cuộn' : 'tấn'}`, 'info'),
          badge(`${shortDate(c.from_date)} → ${shortDate(c.to_date)}${c.daysLeft >= 0 ? ` · còn ${c.daysLeft} ngày` : ''}`, 'neutral'),
        ]),
        el('div', { class: 'grid cols-4' }, [
          kpi('Cam kết', `${num(c.committed_tons)} t`), kpi('Đã giao', `${num(c.delivered_tons, 1)} t`, `${num(c.delivered_bales)} cuộn · ${num(c.weighed_tons, 1)} t đã cân`),
          kpi('Tiến độ', `${c.progressPct}%`, `còn ${num(c.remainingTons, 1)} t`, c.progressPct >= 100 ? 'good' : undefined),
          kpi('Đã xác nhận / đã trả', vnd(c.confirmed_amount), `đã trả ${vnd(c.paid_amount)}`),
        ]),
        c.note ? el('p', { class: 'muted', text: c.note }) : null,
        writable && c.status === 'hieu_luc'
          ? el('div', { class: 'grid cols-2' }, [
              form([
                { name: 'committedTons', label: 'Cam kết (tấn)', type: 'number', step: '1', value: c.committed_tons },
                { name: 'unitPrice', label: 'Đơn giá (đ)', type: 'number', step: '1000', value: c.unit_price },
                { name: 'toDate', label: 'Đến ngày', type: 'date', value: c.to_date },
                { name: 'note', label: 'Ghi chú', value: c.note ?? '' },
              ], async (values) => { await api(`/straw/contracts/${c.id}`, { method: 'PUT', body: values }); toast('Đã cập nhật hợp đồng.'); await refresh(); }, { submitLabel: 'Lưu', resetOnSuccess: false }),
              el('div', { class: 'chip-row', style: 'align-items:flex-end' }, [
                el('button', { class: 'small', text: 'Đóng hợp đồng (hết hạn)', onclick: async () => { await guard(api(`/straw/contracts/${c.id}/status`, { body: { status: 'het_han' } })); toast('Đã đóng.'); await refresh(); } }),
                el('button', { class: 'small ghost', text: 'Huỷ', onclick: async () => { if (!window.confirm('Huỷ hợp đồng này?')) return; await guard(api(`/straw/contracts/${c.id}/status`, { body: { status: 'huy' } })); toast('Đã huỷ.'); await refresh(); } }),
              ]),
            ])
          : null,
      ]));
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Hợp đồng hiệu lực', num(active.length), `${contracts.length} tổng`),
        kpi('Tổng cam kết', `${num(active.reduce((s, c) => s + c.committed_tons, 0))} t`, 'Các hợp đồng đang hiệu lực'),
        kpi('Đã giao', `${num(active.reduce((s, c) => s + c.delivered_tons, 0))} t`, `${num(active.reduce((s, c) => s + c.delivered_bales, 0))} cuộn`),
        kpi('Sắp hết hạn', num(active.filter((c) => c.daysLeft <= 30).length), 'trong 30 ngày', active.some((c) => c.daysLeft <= 30) ? 'warning' : undefined),
      ]),
      alert('CT-01: một HTX chỉ có một hợp đồng hiệu lực trong một khoảng thời gian. Việc thu gom của HTX có hợp đồng được ưu tiên xếp trước; phiếu mua rơm lấy đơn giá từ đây — không có hợp đồng thì người xác nhận phiếu phải nhập giá thoả thuận.', 'info'),
      card('Danh sách hợp đồng', table([
        { key: 'code', label: 'Mã' },
        { key: 'htx_name', label: 'HTX' },
        { key: 'period', label: 'Thời hạn', render: (c) => `${shortDate(c.from_date)} → ${shortDate(c.to_date)}` },
        { key: 'priceBasisLabel', label: 'Cơ sở giá' },
        { key: 'unit_price', label: 'Đơn giá', align: 'right', render: (c) => vnd(c.unit_price) },
        { key: 'committed_tons', label: 'Cam kết (t)', align: 'right', render: (c) => num(c.committed_tons) },
        { key: 'delivered_tons', label: 'Đã giao (t)', align: 'right', render: (c) => num(c.delivered_tons, 1) },
        { key: 'progressPct', label: 'Tiến độ', render: (c) => el('span', { class: 'chip-row' }, [progressBar(c.progressPct), `${c.progressPct}%`]) },
        { key: 'status', label: 'Trạng thái', render: (c) => badge(c.statusLabel, c.expired ? 'warn' : CONTRACT_TONE[c.status]) },
      ], contracts, { onRowClick: showContract, rowClass: (c) => (c.id === selectedContract ? 'selected' : null) })),
      detail,
      writable
        ? card('Tạo hợp đồng mới', form([
            { name: 'htxId', label: 'Hợp tác xã', type: 'select', required: true, options: lookups.cooperatives.map((c) => ({ value: c.id, label: c.name })) },
            { name: 'fromDate', label: 'Từ ngày', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
            { name: 'toDate', label: 'Đến ngày', type: 'date', required: true },
            { name: 'committedTons', label: 'Cam kết (tấn)', type: 'number', step: '1', required: true },
            { name: 'priceBasis', label: 'Cơ sở giá', type: 'select', options: [{ value: 'theo_cuon', label: 'đ/cuộn (đếm ở ruộng — ra tiền ngay)' }, { value: 'theo_tan_can', label: 'đ/tấn theo cân nhà máy (chờ cân đủ)' }] },
            { name: 'unitPrice', label: 'Đơn giá (đ)', type: 'number', step: '1000', required: true },
            { name: 'maxMoisturePct', label: 'Độ ẩm tối đa (%)', type: 'number', step: '1' },
            { name: 'note', label: 'Ghi chú' },
          ], async (values) => { await api('/straw/contracts', { body: values }); toast('Đã tạo hợp đồng.'); await refresh(); }, { submitLabel: '+ Tạo hợp đồng' }))
        : null,
    );
    const sel = contracts.find((c) => c.id === selectedContract);
    if (sel) showContract(sel);
  },
});

// ===========================================================================
// Phiếu mua rơm & công nợ
// ===========================================================================

function ticketCard(t, { canConfirm, canPay, onDone }) {
  const needPrice = !t.unit_price;
  return card(`${t.code} — ${t.htx_name ?? 'HTX chưa rõ'} · việc ${t.job_code}`, [
    el('div', { class: 'chip-row' }, [
      badge(t.statusLabel, TICKET_TONE[t.status]), badge(t.priceBasisLabel, t.contract_code ? 'neutral' : 'warn'),
      t.contract_code ? badge(`HĐ ${t.contract_code}`, 'neutral') : null,
      t.overdue ? badge(`Quá hạn trả (${shortDate(t.due_date)})`, 'bad') : t.due_date ? badge(`Hạn trả ${shortDate(t.due_date)}`, 'neutral') : null,
    ]),
    el('div', { class: 'grid cols-4' }, [
      kpi('Cuộn', num(t.bales), `${t.loadings} lượt ghe`), kpi('Ước theo cuộn', `${num(t.estimated_tons, 1)} t`),
      kpi('Cân nhà máy', t.weighed_tons === null ? `${t.unweighed_loadings} ghe chưa cân` : `${num(t.weighed_tons, 1)} t`, t.weighed_tons === null ? 'PM-02: theo tấn cân phải cân đủ' : 'Đủ mọi ghe', t.weighed_tons === null && t.price_basis === 'theo_tan_can' ? 'warning' : undefined),
      kpi('Số tiền', t.amount ? vnd(t.amount) : '—', t.unit_price ? `${vnd(t.unit_price)} / ${t.price_basis === 'theo_cuon' ? 'cuộn' : 'tấn'}` : 'chưa có đơn giá'),
    ]),
    t.note ? el('p', { class: 'muted', text: t.note }) : null,
    table([
      { key: 'vessel_code', label: 'Ghe' }, { key: 'loaded_at', label: 'Xuống ghe', render: (l) => dateTime(l.loaded_at) },
      { key: 'bales', label: 'Cuộn', align: 'right', render: (l) => num(l.bales ?? 0) }, { key: 'tons', label: 'Ước (t)', align: 'right', render: (l) => num(l.tons, 1) },
      { key: 'weighed_kg', label: 'Cân (t)', align: 'right', render: (l) => (l.weighed_kg ? num(l.weighed_kg / 1000, 1) : badge('chưa cân', 'neutral')) },
      { key: 'grn_code', label: 'Phiếu nhập kho', render: (l) => (l.grn_code ? badge(`${l.grn_code} · ${l.grn_status === 'da_duyet' ? 'đã duyệt' : 'chờ duyệt'}`, l.grn_status === 'da_duyet' ? 'good' : 'info') : '—') },
    ], t.loadingDetails ?? []),
    canConfirm && ['cho_can', 'cho_xac_nhan'].includes(t.status)
      ? el('div', {}, [
          el('strong', { text: 'Xác nhận phiếu → ghi công nợ phải trả HTX' }),
          form([
            ...(needPrice ? [
              { name: 'priceBasis', label: 'Cơ sở giá thoả thuận (không có hợp đồng)', type: 'select', options: [{ value: 'theo_cuon', label: 'đ/cuộn' }, { value: 'theo_tan_can', label: 'đ/tấn theo cân' }] },
              { name: 'unitPrice', label: 'Đơn giá thoả thuận (đ)', type: 'number', step: '1000', required: true },
            ] : []),
            { name: 'note', label: 'Ghi chú' },
          ], async (values) => {
            const r = await api(`/straw/tickets/${t.id}/confirm`, { body: { ...values, unitPrice: values.unitPrice ?? undefined, priceBasis: values.priceBasis || undefined } });
            toast(`Đã xác nhận ${r.code}: ${vnd(r.amount)} — công nợ phải trả, hạn ${shortDate(r.due_date)}.`);
            await onDone();
          }, { submitLabel: '✔ Xác nhận & ghi công nợ' }),
        ])
      : null,
    canPay && t.status === 'da_xac_nhan'
      ? el('button', { class: 'small', text: `💸 Ghi đã thanh toán ${vnd(t.amount)}`, onclick: async () => {
          if (!window.confirm(`Xác nhận đã chuyển ${vnd(t.amount)} cho ${t.htx_name}?`)) return;
          await guard(api(`/straw/tickets/${t.id}/pay`, { body: {} })); toast('Đã tất toán.'); await onDone();
        } })
      : null,
    canConfirm && ['cho_can', 'cho_xac_nhan'].includes(t.status)
      ? el('button', { class: 'small ghost', text: 'Huỷ phiếu', onclick: async () => { const reason = window.prompt('Lý do huỷ phiếu?'); if (!reason) return; await guard(api(`/straw/tickets/${t.id}/cancel`, { body: { reason } })); toast('Đã huỷ.'); await onDone(); } })
      : null,
  ]);
}

const TICKET_COLUMNS = [
  { key: 'code', label: 'Mã' },
  { key: 'htx_name', label: 'HTX' },
  { key: 'job_code', label: 'Việc' },
  { key: 'harvest_date', label: 'Gặt', render: (t) => shortDate(t.harvest_date) },
  { key: 'bales', label: 'Cuộn', align: 'right', render: (t) => num(t.bales) },
  { key: 'weighed_tons', label: 'Cân (t)', align: 'right', render: (t) => (t.weighed_tons === null ? badge(`${t.unweighed_loadings} chưa cân`, 'neutral') : num(t.weighed_tons, 1)) },
  { key: 'amount', label: 'Số tiền', align: 'right', render: (t) => (t.amount ? vnd(t.amount) : el('span', { class: 'muted', text: 'chưa có giá' })) },
  { key: 'status', label: 'Trạng thái', render: (t) => el('span', { class: 'chip-row' }, [badge(t.statusLabel, TICKET_TONE[t.status]), t.overdue ? badge('quá hạn trả', 'bad') : null]) },
];

registerPage('straw-tickets', {
  title: 'Phiếu mua rơm & công nợ HTX',
  subtitle: 'Sinh tự động khi việc thu gom hoàn thành · xác nhận thành công nợ phải trả · trả tiền tất toán bút toán',
  async render(view, actions) {
    const [ticketsList, payables] = await Promise.all([guard(api('/straw/tickets')), api('/straw/payables').catch(() => null)]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const canConfirm = can('procurement.write');
    const canPay = can('finance.write');
    const detail = el('div', { class: 'grid' });
    const showTicket = async (id) => {
      selectedTicket = id;
      const t = await guard(api(`/straw/tickets/${id}`));
      detail.replaceChildren(ticketCard(t, { canConfirm, canPay, onDone: refresh }));
    };
    // Không có quyền tài chính (ví dụ Supply Chain) thì tính tổng từ danh sách phiếu — cùng con số, chỉ thiếu bảng theo HTX.
    const totals = payables?.totals ?? {
      outstanding: ticketsList.filter((t) => t.status === 'da_xac_nhan').reduce((s, t) => s + (t.amount ?? 0), 0),
      overdue: ticketsList.filter((t) => t.overdue).reduce((s, t) => s + (t.amount ?? 0), 0),
      paid: ticketsList.filter((t) => t.status === 'da_thanh_toan').reduce((s, t) => s + (t.amount ?? 0), 0),
      pending: ticketsList.filter((t) => ['cho_can', 'cho_xac_nhan'].includes(t.status)).length,
    };
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Chờ xác nhận / chờ cân', num(totals.pending), 'Phiếu chưa thành công nợ', totals.pending ? 'warning' : undefined),
        kpi('Công nợ phải trả', vnd(totals.outstanding), 'Đã xác nhận, chưa trả'),
        kpi('Quá hạn trả', vnd(totals.overdue), `hạn ${15} ngày sau xác nhận`, totals.overdue ? 'critical' : 'good'),
        kpi('Đã thanh toán', vnd(totals.paid), 'Luỹ kế'),
      ]),
      payables ? card('Công nợ theo HTX', table([
        { key: 'htx_name', label: 'HTX' }, { key: 'tickets', label: 'Phiếu', align: 'right' },
        { key: 'bales', label: 'Cuộn', align: 'right', render: (r) => num(r.bales) }, { key: 'tons', label: 'Tấn', align: 'right', render: (r) => num(r.tons, 1) },
        { key: 'pending', label: 'Chờ', align: 'right' },
        { key: 'outstanding', label: 'Phải trả', align: 'right', render: (r) => vnd(r.outstanding) },
        { key: 'overdue', label: 'Quá hạn', align: 'right', render: (r) => (r.overdue ? badge(vnd(r.overdue), 'bad') : '—') },
        { key: 'paid', label: 'Đã trả', align: 'right', render: (r) => vnd(r.paid) },
      ], payables.byHtx, { empty: 'Chưa có phiếu mua rơm' })) : null,
      card('Phiếu mua rơm', [
        el('p', { class: 'muted', text: 'PM-02: hợp đồng theo cuộn ra tiền ngay khi việc hoàn thành; theo tấn cân phải chờ mọi ghe của việc được cân ở nhà máy. PM-03: không có hợp đồng thì phải nhập đơn giá thoả thuận khi xác nhận — hệ thống không đoán giá.' }),
        table(TICKET_COLUMNS, ticketsList, { onRowClick: (t) => showTicket(t.id), rowClass: (t) => (t.id === selectedTicket ? 'selected' : null), empty: 'Chưa có phiếu — phiếu sinh khi việc thu gom hoàn thành xuống ghe' }),
      ]),
      detail,
    );
    if (selectedTicket && ticketsList.some((t) => t.id === selectedTicket)) await showTicket(selectedTicket);
  },
});

// ===========================================================================
// Danh mục ghe
// ===========================================================================

registerPage('vessels', {
  title: 'Danh mục ghe & đơn giá thuê',
  subtitle: 'Số hiệu, chủ ghe, lớp tàu, đăng kiểm, đơn giá — lượt xuống ghe tra ở đây; cân xong là có cước thật',
  async render(view, actions) {
    const [list, lookups] = await Promise.all([guard(api('/vessels')), api('/vessels/lookups')]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const writable = can('tms.write');
    const attention = list.filter((v) => v.status === 'hoat_dong' && ['het_han', 'sap_het_han'].includes(v.expiry.state));
    const detail = el('div', { class: 'grid' });
    const showVessel = (v) => {
      selectedVessel = v.id;
      detail.replaceChildren(card(`${v.code} — ${v.name ?? v.kindLabel}`, [
        el('div', { class: 'chip-row' }, [
          badge(v.kindLabel, 'neutral'), badge(v.classLabel, 'neutral'), badge(...EXPIRY[v.expiry.state]), badge(v.rateLabel, v.rate_type ? 'info' : 'warn'),
          badge(v.status === 'hoat_dong' ? 'Hoạt động' : 'Ngừng', v.status === 'hoat_dong' ? 'good' : 'bad'),
        ]),
        el('div', { class: 'grid cols-4' }, [
          kpi('Chuyến đã chạy', num(v.trips), v.last_trip_at ? `gần nhất ${dateTime(v.last_trip_at)}` : 'chưa có'),
          kpi('Rơm đã chở', `${num(v.loaded_tons)} t ước`, `${num(v.weighed_tons, 1)} t cân`),
          kpi('Cước thực', vnd(v.actual_cost), 'Σ chuyến hoàn thành'),
          kpi('Đăng kiểm', v.registration_expiry ? shortDate(v.registration_expiry) : '—', v.expiry.daysLeft === null ? 'chưa có hạn' : v.expiry.daysLeft < 0 ? `hết hạn ${Math.abs(v.expiry.daysLeft)} ngày` : `còn ${v.expiry.daysLeft} ngày`, v.expiry.state === 'het_han' ? 'critical' : v.expiry.state === 'sap_het_han' ? 'warning' : undefined),
        ]),
        v.owner_name ? el('p', { class: 'muted', text: `Chủ ghe: ${v.owner_name}${v.owner_phone ? ` · ${v.owner_phone}` : ''}${v.registered_tons ? ` · tải trọng đăng ký ${num(v.registered_tons)} t` : ''}${v.straw_payload_tons ? ` · chở rơm ~${num(v.straw_payload_tons)} t` : ''}` }) : null,
        v.note ? el('p', { class: 'muted', text: v.note }) : null,
        writable
          ? form([
              { name: 'name', label: 'Tên gọi', value: v.name ?? '' },
              { name: 'ownerName', label: 'Chủ ghe', value: v.owner_name ?? '' },
              { name: 'ownerPhone', label: 'Điện thoại', value: v.owner_phone ?? '' },
              { name: 'strawPayloadTons', label: 'Rơm chở được (t)', type: 'number', step: '1', value: v.straw_payload_tons ?? '' },
              { name: 'registrationExpiry', label: 'Hạn đăng kiểm', type: 'date', value: v.registration_expiry ?? '' },
              { name: 'rateType', label: 'Loại đơn giá', type: 'select', options: [{ value: '', label: '— không —' }, ...Object.entries(lookups.rateTypes).map(([value, label]) => ({ value, label, selected: v.rate_type === value }))] },
              { name: 'rateVnd', label: 'Đơn giá (đ)', type: 'number', step: '1000', value: v.rate_vnd ?? '' },
              { name: 'status', label: 'Trạng thái', type: 'select', options: [{ value: 'hoat_dong', label: 'Hoạt động', selected: v.status === 'hoat_dong' }, { value: 'ngung', label: 'Ngừng', selected: v.status === 'ngung' }] },
              { name: 'note', label: 'Ghi chú', value: v.note ?? '' },
            ], async (values) => {
              await api(`/vessels/${v.id}`, { method: 'PUT', body: { ...values, rateType: values.rateType || undefined, rateVnd: values.rateVnd ?? undefined, strawPayloadTons: values.strawPayloadTons ?? undefined } });
              toast('Đã cập nhật ghe.'); await refresh();
            }, { submitLabel: 'Lưu', resetOnSuccess: false })
          : null,
      ]));
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Ghe / sà lan hoạt động', num(list.filter((v) => v.status === 'hoat_dong').length), `${list.length} trong danh mục`),
        kpi('Có đơn giá thuê', num(list.filter((v) => v.rate_type).length), 'Cân xong là có cước thật'),
        kpi('Cần chú ý đăng kiểm', num(attention.length), 'Hết hạn hoặc ≤ 30 ngày', attention.length ? 'warning' : 'good'),
        kpi('Rơm đã chở', `${num(list.reduce((s, v) => s + v.weighed_tons, 0))} t`, 'Theo cân nhà máy'),
      ]),
      attention.length ? alert(`${attention.map((v) => `${v.code} (${EXPIRY[v.expiry.state][0].toLowerCase()})`).join(', ')} — GH-02: vẫn xếp hàng được nhưng đội trưởng và điều phối sẽ thấy cảnh báo ở mỗi lượt.`, 'warn') : null,
      card('Danh mục', table([
        { key: 'code', label: 'Số hiệu' }, { key: 'name', label: 'Tên', render: (v) => v.name ?? '—' },
        { key: 'kindLabel', label: 'Loại' }, { key: 'classLabel', label: 'Lớp tàu' },
        { key: 'owner_name', label: 'Chủ ghe', render: (v) => v.owner_name ?? '—' },
        { key: 'straw_payload_tons', label: 'Rơm (t)', align: 'right', render: (v) => (v.straw_payload_tons ? num(v.straw_payload_tons) : '—') },
        { key: 'rateLabel', label: 'Đơn giá' },
        { key: 'expiry', label: 'Đăng kiểm', render: (v) => badge(...EXPIRY[v.expiry.state]) },
        { key: 'trips', label: 'Chuyến', align: 'right' },
      ], list, { onRowClick: showVessel, rowClass: (v) => (v.id === selectedVessel ? 'selected' : null) })),
      detail,
      writable
        ? card('Thêm ghe / sà lan', form([
            { name: 'code', label: 'Số hiệu đăng ký', required: true, placeholder: 'AG-12345' },
            { name: 'name', label: 'Tên gọi' },
            { name: 'kind', label: 'Loại', type: 'select', options: [{ value: 'ghe', label: 'Ghe' }, { value: 'sa_lan', label: 'Sà lan' }] },
            { name: 'vesselClass', label: 'Lớp tàu (tính lưu thông)', type: 'select', options: lookups.classes.map((c) => ({ value: c.code, label: c.label })) },
            { name: 'ownerName', label: 'Chủ ghe' }, { name: 'ownerPhone', label: 'Điện thoại' },
            { name: 'registeredTons', label: 'Tải trọng đăng ký (t)', type: 'number', step: '1' },
            { name: 'strawPayloadTons', label: 'Rơm chở được (t)', type: 'number', step: '1' },
            { name: 'registrationExpiry', label: 'Hạn đăng kiểm', type: 'date' },
            { name: 'rateType', label: 'Loại đơn giá', type: 'select', options: [{ value: '', label: '— chưa có —' }, ...Object.entries(lookups.rateTypes).map(([value, label]) => ({ value, label }))] },
            { name: 'rateVnd', label: 'Đơn giá (đ)', type: 'number', step: '1000' },
          ], async (values) => {
            await api('/vessels', { body: { ...values, rateType: values.rateType || undefined, rateVnd: values.rateVnd ?? undefined, registeredTons: values.registeredTons ?? undefined, strawPayloadTons: values.strawPayloadTons ?? undefined, registrationExpiry: values.registrationExpiry || undefined } });
            toast('Đã thêm vào danh mục.'); await refresh();
          }, { submitLabel: '+ Thêm ghe' }))
        : null,
    );
    const sel = list.find((v) => v.id === selectedVessel);
    if (sel) showVessel(sel);
  },
});

// ===========================================================================
// Cổng HTX — hợp đồng và công nợ của chính mình
// ===========================================================================

registerPage('htx-contracts', {
  title: 'Hợp đồng & công nợ rơm',
  subtitle: 'Hợp đồng thu mua với Mekong Green, phiếu mua rơm từng đợt giao và tiền còn phải nhận',
  async render(view) {
    const data = await guard(api('/straw/my'));
    if (data.notice) { view.replaceChildren(alert(data.notice, 'warn')); return; }
    const totals = data.payables.totals;
    const active = data.contracts.find((c) => c.status === 'hieu_luc' && !c.expired);
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Hợp đồng hiệu lực', active ? active.code : 'Chưa có', active ? `${active.priceBasisLabel} · ${vnd(active.unit_price)}` : 'Liên hệ Mekong Green để ký'),
        kpi('Đã giao / cam kết', active ? `${num(active.delivered_tons, 1)} / ${num(active.committed_tons)} t` : '—', active ? `${active.progressPct}% · còn ${num(active.remainingTons, 1)} t` : ''),
        kpi('Tiền còn phải nhận', vnd(totals.outstanding), totals.overdue ? `quá hạn ${vnd(totals.overdue)}` : 'Đã xác nhận, chưa trả', totals.overdue ? 'critical' : undefined),
        kpi('Đã nhận', vnd(totals.paid), `${num(totals.pending)} phiếu đang chờ xác nhận / chờ cân`),
      ]),
      active ? card(`Hợp đồng ${active.code}`, [
        el('div', { class: 'chip-row' }, [badge(active.statusLabel, 'good'), badge(`${shortDate(active.from_date)} → ${shortDate(active.to_date)}`, 'neutral'), badge(`${vnd(active.unit_price)} / ${active.price_basis === 'theo_cuon' ? 'cuộn' : 'tấn cân'}`, 'info'), active.max_moisture_pct ? badge(`độ ẩm ≤ ${active.max_moisture_pct}%`, 'neutral') : null]),
        progressBar(active.progressPct),
        active.note ? el('p', { class: 'muted', text: active.note }) : null,
      ]) : alert('HTX chưa có hợp đồng thu mua hiệu lực. Rơm vẫn được thu gom và lập phiếu, nhưng đơn giá sẽ do hai bên thoả thuận từng đợt.', 'info'),
      card('Phiếu mua rơm', [
        el('p', { class: 'muted', text: 'Mỗi đợt thu gom hoàn thành là một phiếu. Phiếu theo cuộn ra tiền ngay; phiếu theo tấn cân chờ nhà máy cân đủ. "Đã xác nhận" là Mekong Green đã ghi nợ phải trả.' }),
        table(TICKET_COLUMNS.filter((c) => c.key !== 'htx_name'), data.tickets, { empty: 'Chưa có đợt thu gom nào hoàn thành' }),
      ]),
      data.contracts.length > 1 ? card('Hợp đồng trước', table([
        { key: 'code', label: 'Mã' }, { key: 'period', label: 'Thời hạn', render: (c) => `${shortDate(c.from_date)} → ${shortDate(c.to_date)}` },
        { key: 'delivered_tons', label: 'Đã giao (t)', align: 'right', render: (c) => num(c.delivered_tons, 1) }, { key: 'paid_amount', label: 'Đã nhận', align: 'right', render: (c) => vnd(c.paid_amount) },
        { key: 'status', label: 'Trạng thái', render: (c) => badge(c.statusLabel, CONTRACT_TONE[c.status]) },
      ], data.contracts.filter((c) => c !== active))) : null,
    );
    void state;
  },
});
