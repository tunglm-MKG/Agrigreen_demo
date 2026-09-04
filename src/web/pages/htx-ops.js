/**
 * PHÂN CÔNG CÔNG VIỆC & VẬT TƯ NÔNG NGHIỆP — Cổng Hợp tác xã.
 *
 *   htx-assign   Chọn thửa → xem kế hoạch dự kiến → gán thành viên / máy móc
 *   htx-inputs   Mua sắm → tồn kho theo lô → cấp phát xuống thửa ruộng
 *   htx-settings Mô hình vận hành HTX và mã số thuế
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num, vnd, dateTime,
  toast, guard, can, form, navigate,
} from '/app.js';

const ACTIVITY_LABEL = {
  lam_dat: 'Làm đất', gieo_sa: 'Gieo sạ', bon_phan: 'Bón phân', phun_thuoc: 'Phun thuốc',
  tuoi: 'Tưới nước', rut_nuoc_awd: 'Rút nước (AWD)', thu_hoach: 'Thu hoạch',
};
const ASSIGN_STATUS = {
  da_giao: { label: 'Đã giao', tone: 'neutral' },
  da_nhan: { label: 'Đã nhận', tone: 'good' },
  tu_choi: { label: 'Từ chối', tone: 'bad' },
  hoan_thanh: { label: 'Hoàn thành', tone: 'good' },
  huy: { label: 'Đã huỷ', tone: 'neutral' },
};
const CATEGORY_LABEL = {
  phan_bon: 'Phân bón', thuoc_bvtv: 'Thuốc BVTV', giong: 'Giống', khac: 'Vật tư khác',
};

const HTX_KEY = 'mekong-green.htx';

function savedHtxId(list) {
  let saved = null;
  try { saved = localStorage.getItem(HTX_KEY); } catch { saved = null; }
  if (saved && list.some((h) => h.id === saved)) return saved;
  return list[0]?.id ?? null;
}

/** Bộ chọn HTX dùng chung cho các màn hình của cổng. */
async function htxPicker(actions, onChange) {
  const list = await api('/mdm/cooperatives');
  const current = savedHtxId(list);
  actions.append(el('label', { class: 'htx-picker' }, [
    el('span', { class: 'muted', text: 'HTX:' }),
    el('select', {
      onchange: (event) => {
        try { localStorage.setItem(HTX_KEY, event.target.value); } catch { /* bỏ qua */ }
        onChange(event.target.value);
      },
    }, list.map((h) => el('option', { value: h.id, selected: h.id === current }, [`${h.code} — ${h.name}`]))),
  ]));
  return { id: current, list };
}

// ===========================================================================
// Phân công công việc
// ===========================================================================

registerPage('htx-assign', {
  title: 'Phân công công việc',
  subtitle: 'Chọn thửa ruộng → xem kế hoạch sản xuất dự kiến → gán công đoạn cho thành viên hoặc máy móc',
  async render(view, actions) {
    const { id: htxId } = await htxPicker(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!htxId) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    const [plots, farmers, machines, meta, summary] = await Promise.all([
      guard(api(`/mdm/plots?htxId=${htxId}`)),
      api(`/mdm/farmers?htxId=${htxId}`).catch(() => []),
      api(`/cgh/machines?htxId=${htxId}`).catch(() => []),
      api('/assign/models'),
      api(`/assign/summary?htxId=${htxId}`).catch(() => ({})),
    ]);

    const model = meta.models.find((m) => m.code === summary.operatingModel) ?? meta.models[0];
    const detail = el('div', { class: 'grid' });
    let selectedPlotId = plots[0]?.id ?? null;

    const drawPlan = async () => {
      if (!selectedPlotId) return detail.replaceChildren();
      const workPlan = await guard(api(`/assign/plots/${selectedPlotId}/work-plan`));

      if (!workPlan.plan) {
        return detail.replaceChildren(card(`Thửa ${workPlan.plot.code}`, [
          alert(workPlan.notice, 'info'),
          el('button', { class: 'ghost small', text: 'Mở Kế hoạch sản xuất →', onclick: () => navigate('htx-plan') }),
        ]));
      }

      detail.replaceChildren(card(
        `Kế hoạch ${workPlan.plan.code} — thửa ${workPlan.plot.code} (${num(workPlan.plot.area_ha, 2)} ha)`,
        [
          el('div', { class: 'chip-row' }, [
            badge(workPlan.plan.protocol_name, 'info'),
            badge(`Vụ ${workPlan.cycle.code} · ${workPlan.cycle.season_name}`, 'neutral'),
            workPlan.plot.farmer_name ? badge(`Chủ thửa: ${workPlan.plot.farmer_name}`, 'neutral') : null,
            badge(model.label, workPlan.operatingModel === 'tap_trung' ? 'good' : 'warn'),
          ]),
          el('p', { class: 'muted', text: model.description }),
          workPlan.notice ? alert(workPlan.notice, 'warn') : null,
          el('div', { class: 'plan-steps' }, workPlan.steps.map((step) =>
            assignStepRow(step, { farmers, machines, meta, drawPlan }))),
        ],
      ));
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Mô hình vận hành', model.label, model.description),
        kpi('Phân công đang chờ nhận', num(summary.pending ?? 0), null, summary.pending ? 'warning' : 'good'),
        kpi('Bị từ chối', num(summary.declined ?? 0), 'Cần bố trí người khác',
          summary.declined ? 'critical' : 'good'),
        kpi('Tổng phân công', num(summary.total ?? 0),
          `${num(summary.byKind?.nhan_cong ?? 0)} nhân công · ${num(summary.byKind?.may_moc ?? 0)} máy móc`),
      ]),

      card('Chọn thửa ruộng', table([
        { key: 'code', label: 'Mã thửa' },
        { key: 'name', label: 'Tên' },
        { key: 'area_ha', label: 'Diện tích (ha)', align: 'right', render: (row) => num(row.area_ha, 3) },
        { key: 'farmer_name', label: 'Chủ thửa', render: (row) => row.farmer_name ?? '—' },
        {
          key: 'status', label: 'Trạng thái',
          render: (row) => badge(row.status === 'dang_canh_tac' ? 'Đang canh tác' : 'Chưa mở vụ',
            row.status === 'dang_canh_tac' ? 'good' : 'neutral'),
        },
      ], plots, {
        empty: 'HTX chưa có thửa ruộng nào — vẽ thửa ở màn hình "Lô ruộng & GPS".',
        onRowClick: (row) => { selectedPlotId = row.id; drawPlan(); },
        rowClass: (row) => (row.id === selectedPlotId ? 'highlight' : null),
      })),

      detail,
    );

    await drawPlan();
  },
});

/** Một công đoạn, mở ra được form gán người / máy. */
function assignStepRow(step, ctx) {
  const body = el('div', { class: 'plan-step-body', hidden: true });
  const assignments = step.assignments ?? [];

  const head = el('div', {
    class: 'plan-step-head',
    onclick: () => { body.hidden = !body.hidden; },
  }, [
    el('span', { class: 'plan-step-order', text: String(step.sort_order) }),
    el('div', { class: 'plan-step-main' }, [
      el('strong', { text: step.name }),
      el('div', { class: 'muted', text: `${ACTIVITY_LABEL[step.activity] ?? step.activity} · dự kiến ${step.planned_date}` }),
    ]),
    el('span', { class: 'chip-row' }, [
      assignments.length
        ? badge(`${assignments.length} phân công`, 'info')
        : badge('Chưa phân công', 'neutral'),
      step.status === 'da_thuc_hien' ? badge('Đã thực hiện', 'good') : null,
    ]),
  ]);

  const children = [];

  if (assignments.length) {
    children.push(table([
      {
        key: 'who', label: 'Giao cho',
        render: (row) => (row.kind === 'nhan_cong'
          ? `${row.farmer_name}${row.farmer_phone ? ` · ${row.farmer_phone}` : ''}`
          : `${row.machine_code} — ${row.machine_type_name ?? 'máy'}`),
      },
      { key: 'kind', label: 'Loại', render: (row) => badge(row.kind === 'nhan_cong' ? 'Nhân công' : 'Máy móc', 'neutral') },
      { key: 'planned_date', label: 'Ngày' },
      {
        key: 'status', label: 'Trạng thái',
        render: (row) => badge(ASSIGN_STATUS[row.status]?.label ?? row.status, ASSIGN_STATUS[row.status]?.tone ?? 'neutral'),
      },
      { key: 'decline_reason', label: 'Lý do từ chối', render: (row) => row.decline_reason ?? '—' },
      {
        key: 'act', label: '',
        render: (row) => (can('htx.write') && row.status !== 'hoan_thanh'
          ? el('span', { class: 'chip-row' }, [
              row.status === 'da_giao' ? el('button', {
                class: 'ghost small', text: '✓ Nhận',
                onclick: async () => {
                  await guard(api(`/assign/${row.id}/respond`, { body: { status: 'da_nhan' } }));
                  toast('Đã nhận việc.');
                  await ctx.drawPlan();
                },
              }) : null,
              row.status === 'da_giao' || row.status === 'da_nhan' ? el('button', {
                class: 'ghost small', text: '✕ Từ chối',
                onclick: async () => {
                  const reason = prompt('Lý do từ chối (bắt buộc, để Ban quản trị bố trí người khác):');
                  if (!reason) return;
                  await guard(api(`/assign/${row.id}/respond`, { body: { status: 'tu_choi', reason } }));
                  toast('Đã ghi nhận từ chối.');
                  await ctx.drawPlan();
                },
              }) : null,
              el('button', {
                class: 'ghost small', text: '🗑',
                onclick: async () => {
                  await guard(api(`/assign/${row.id}`, { method: 'DELETE' }));
                  toast('Đã huỷ phân công.');
                  await ctx.drawPlan();
                },
              }),
            ])
          : '—'),
      },
    ], assignments));
  }

  if (can('htx.write') && step.status === 'ke_hoach') {
    const selectedFarmers = new Set();
    const selectedMachines = new Set();

    const pickList = (items, selected, render) => el('div', { class: 'pick-list' }, items.map((item) =>
      el('label', { class: 'pick-item' }, [
        el('input', {
          type: 'checkbox',
          onchange: (event) => {
            if (event.target.checked) selected.add(item.id);
            else selected.delete(item.id);
          },
        }),
        render(item),
      ])));

    children.push(el('div', { class: 'grid cols-2' }, [
      el('div', {}, [
        el('strong', { text: 'Thành viên HTX' }),
        ctx.farmers.length
          ? pickList(ctx.farmers, selectedFarmers, (f) => `${f.full_name}${f.phone ? ` · ${f.phone}` : ''}`)
          : el('p', { class: 'muted', text: 'HTX chưa có thành viên nào trong danh sách.' }),
      ]),
      el('div', {}, [
        el('strong', { text: 'Máy móc, thiết bị' }),
        ctx.machines.length
          ? pickList(
              ctx.machines.filter((m) => m.condition === 'hoat_dong'),
              selectedMachines,
              (m) => `${m.code} — ${m.machine_type_name ?? ''}`,
            )
          : el('p', { class: 'muted', text: 'HTX chưa có máy nào đang hoạt động.' }),
      ]),
    ]));

    children.push(form([
      {
        name: 'role', label: 'Vai trò', type: 'select',
        options: ctx.meta.roles.map((r) => ({ value: r.code, label: r.label })),
      },
      { name: 'plannedDate', label: 'Ngày thực hiện', type: 'date', value: step.planned_date },
      { name: 'hours', label: 'Số giờ dự kiến', type: 'number', step: '0.5' },
      { name: 'note', label: 'Ghi chú' },
    ], async (values) => {
      const result = await api('/assign', {
        body: {
          ...values,
          planStepId: step.id,
          farmerIds: [...selectedFarmers],
          machineIds: [...selectedMachines],
        },
      });
      if (result.created.length) toast(`Đã phân công ${result.created.length} đối tượng.`);
      for (const warning of result.warnings ?? []) toast(warning, true);
      if (result.skipped.length) {
        toast(result.skipped.map((s) => `${s.target}: ${s.reason}`).join(' | '), true);
      }
      await ctx.drawPlan();
    }, { submitLabel: '👥 Phân công' }));
  }

  body.replaceChildren(...children.filter(Boolean));
  return el('div', { class: `plan-step ${step.status}` }, [head, body]);
}

// ===========================================================================
// Vật tư: mua sắm — tồn kho — cấp phát
// ===========================================================================

registerPage('htx-inputs', {
  title: 'Vật tư nông nghiệp',
  subtitle: 'Mua sắm → tồn kho theo lô → cấp phát xuống thửa ruộng, gắn thẳng vào hồ sơ truy xuất của vụ',
  async render(view, actions) {
    const { id: htxId } = await htxPicker(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!htxId) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    const [dashboard, stock, items, plots, farmers, issues, purchases] = await Promise.all([
      guard(api(`/inputs/dashboard?htxId=${htxId}`)),
      api(`/inputs/stock?htxId=${htxId}`),
      api(`/inputs/items?htxId=${htxId}`),
      api(`/mdm/plots?htxId=${htxId}`),
      api(`/mdm/farmers?htxId=${htxId}`).catch(() => []),
      api(`/inputs/issues?htxId=${htxId}`),
      api(`/inputs/purchases?htxId=${htxId}`),
    ]);

    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Dòng tồn kho', num(dashboard.stockLines), 'Quản lý theo LÔ, không gộp'),
        kpi('Lô đã hết hạn', num(dashboard.expiredLines), 'Không cấp phát được',
          dashboard.expiredLines ? 'critical' : 'good'),
        kpi('Sắp hết hạn (≤60 ngày)', num(dashboard.nearExpiryLines), 'Nên dùng trước',
          dashboard.nearExpiryLines ? 'warning' : 'good'),
        kpi('Giá trị đã mua', vnd(dashboard.totalPurchaseAmount, { compact: true }),
          `${num(dashboard.issueCount)} lần cấp phát cho ${num(dashboard.plotsServed)} thửa`),
      ]),

      can('htx.write')
        ? card('Mua vật tư & nhập kho', [
            el('p', { class: 'muted', text: 'Mỗi dòng mua tạo một lô tồn kho riêng. Ghi số lô và hạn sử dụng để về sau truy được lô nào đã xuống thửa nào.' }),
            form([
              {
                name: 'itemId', label: 'Vật tư', type: 'select', required: true,
                options: items.map((i) => ({
                  value: i.id,
                  label: `${i.name} (${CATEGORY_LABEL[i.category] ?? i.category})${i.permitted ? '' : ' — NGOÀI DANH MỤC'}`,
                })),
              },
              { name: 'qty', label: 'Số lượng', type: 'number', required: true, step: '0.01', min: '0' },
              { name: 'unitPrice', label: 'Đơn giá (đ)', type: 'number', step: '1', min: '0' },
              { name: 'batchNo', label: 'Số lô' },
              { name: 'expiryDate', label: 'Hạn sử dụng', type: 'date' },
              { name: 'supplier', label: 'Nhà cung cấp' },
              { name: 'invoiceNo', label: 'Số hoá đơn' },
              { name: 'purchaseDate', label: 'Ngày mua', type: 'date' },
            ], async (values) => {
              await api('/inputs/purchases', {
                body: {
                  htxId,
                  supplier: values.supplier,
                  invoiceNo: values.invoiceNo,
                  purchaseDate: values.purchaseDate || undefined,
                  lines: [{
                    itemId: values.itemId, qty: values.qty, unitPrice: values.unitPrice ?? 0,
                    batchNo: values.batchNo || undefined, expiryDate: values.expiryDate || undefined,
                  }],
                },
              });
              toast('Đã nhập kho.');
              await refresh();
            }, { submitLabel: '📥 Mua & nhập kho' }),
          ])
        : null,

      card('Tồn kho theo lô', table([
        { key: 'item_name', label: 'Vật tư' },
        { key: 'category', label: 'Nhóm', render: (row) => badge(CATEGORY_LABEL[row.category] ?? row.category, 'neutral') },
        { key: 'batch_no', label: 'Số lô', render: (row) => row.batch_no ?? '—' },
        { key: 'qty_on_hand', label: 'Còn lại', align: 'right', render: (row) => `${num(row.qty_on_hand, 2)} ${row.uom}` },
        {
          key: 'expiry_date', label: 'Hạn dùng',
          render: (row) => (!row.expiry_date ? '—'
            : row.expired ? badge(`${row.expiry_date} — hết hạn`, 'bad')
            : row.nearExpiry ? badge(`${row.expiry_date} — còn ${row.daysToExpiry} ngày`, 'warn')
            : row.expiry_date),
        },
        {
          key: 'phi_days', label: 'Cách ly', align: 'right',
          render: (row) => (row.phi_days ? badge(`${row.phi_days} ngày`, 'info') : '—'),
        },
        {
          key: 'permitted', label: 'Danh mục',
          render: (row) => (row.permitted ? badge('Được phép', 'good') : badge('NGOÀI DANH MỤC', 'bad')),
        },
      ], stock, { empty: 'Kho trống — mua vật tư để nhập kho.' })),

      can('htx.write') && stock.length
        ? card('Cấp phát xuống thửa ruộng', [
            el('p', { class: 'muted', text: 'Phiếu cấp phát tự gắn vào vụ đang canh tác của thửa, nên hồ sơ truy xuất VietGAP trả lời được: lô nào, hoạt chất gì, xuống thửa nào, ngày nào, ai nhận.' }),
            form([
              {
                name: 'stockId', label: 'Lô vật tư', type: 'select', required: true,
                options: stock.filter((s) => !s.expired && s.permitted).map((s) => ({
                  value: s.id,
                  label: `${s.item_name}${s.batch_no ? ` · lô ${s.batch_no}` : ''} — còn ${num(s.qty_on_hand, 2)} ${s.uom}`,
                })),
              },
              {
                name: 'plotId', label: 'Thửa ruộng', type: 'select', required: true,
                options: plots.map((p) => ({ value: p.id, label: `${p.code} — ${num(p.area_ha, 2)} ha` })),
              },
              {
                name: 'farmerId', label: 'Người nhận', type: 'select',
                options: [{ value: '', label: '— Không ghi nhận —' },
                  ...farmers.map((f) => ({ value: f.id, label: f.full_name }))],
              },
              { name: 'qty', label: 'Số lượng cấp', type: 'number', required: true, step: '0.01', min: '0' },
              { name: 'issueDate', label: 'Ngày cấp', type: 'date' },
              { name: 'note', label: 'Ghi chú' },
            ], async (values) => {
              const result = await api('/inputs/issues', {
                body: { ...values, farmerId: values.farmerId || null, issueDate: values.issueDate || undefined },
              });
              toast(`Đã cấp phát. Lô còn lại ${num(result.remainingQty, 2)}.`);
              for (const warning of result.warnings ?? []) toast(warning, true);
              await refresh();
            }, { submitLabel: '📤 Cấp phát' }),
          ])
        : null,

      card('Lịch sử cấp phát', table([
        { key: 'code', label: 'Phiếu' },
        { key: 'issue_date', label: 'Ngày' },
        { key: 'item_name', label: 'Vật tư' },
        { key: 'batch_no', label: 'Lô', render: (row) => row.batch_no ?? '—' },
        { key: 'qty', label: 'Số lượng', align: 'right', render: (row) => `${num(row.qty, 2)} ${row.uom}` },
        { key: 'plot_code', label: 'Thửa' },
        { key: 'step_name', label: 'Công đoạn', render: (row) => row.step_name ?? '—' },
        { key: 'farmer_name', label: 'Người nhận', render: (row) => row.farmer_name ?? '—' },
      ], issues, { empty: 'Chưa có phiếu cấp phát nào.' })),

      card('Phiếu mua vật tư', table([
        { key: 'code', label: 'Phiếu' },
        { key: 'purchase_date', label: 'Ngày mua' },
        { key: 'supplier', label: 'Nhà cung cấp', render: (row) => row.supplier ?? '—' },
        { key: 'invoice_no', label: 'Hoá đơn', render: (row) => row.invoice_no ?? '—' },
        { key: 'line_count', label: 'Số dòng', align: 'right', render: (row) => num(row.line_count) },
        { key: 'total_amount', label: 'Giá trị', align: 'right', render: (row) => vnd(row.total_amount) },
      ], purchases, { empty: 'Chưa có phiếu mua nào.' })),
    );
  },
});

// ===========================================================================
// Cấu hình HTX: mô hình vận hành & mã số thuế
// ===========================================================================

registerPage('htx-settings', {
  title: 'Cấu hình hợp tác xã',
  subtitle: 'Mô hình vận hành, mã số thuế và kích hoạt hồ sơ do Khuyến nông lập sẵn',
  async render(view, actions) {
    const { id: htxId, list } = await htxPicker(actions, () => { actions.replaceChildren(); this.render(view, actions); });
    if (!htxId) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    const [meta, current] = await Promise.all([
      api('/assign/models'),
      Promise.resolve(list.find((h) => h.id === htxId)),
    ]);
    const claimPreview = el('div');

    view.replaceChildren(
      card('Mô hình vận hành', [
        el('p', { class: 'muted', text: 'Mô hình quyết định AI được giao việc cho ai. Đổi mô hình bất cứ lúc nào; các phân công đã tạo không bị xoá.' }),
        el('div', { class: 'grid cols-2' }, meta.models.map((m) => el('div', {
          class: `model-card ${current?.operating_model === m.code ? 'active' : ''}`,
        }, [
          el('strong', { text: m.label }),
          el('p', { class: 'muted', text: m.description }),
          current?.operating_model === m.code
            ? badge('Đang áp dụng', 'good')
            : (can('htx.write') ? el('button', {
                class: 'small', text: 'Chuyển sang mô hình này',
                onclick: async () => {
                  await guard(api('/assign/operating-model', { method: 'PUT', body: { htxId, model: m.code } }));
                  toast(`Đã chuyển sang mô hình "${m.label}".`);
                  actions.replaceChildren();
                  await this.render(view, actions);
                },
              }) : null),
        ]))),
      ]),

      card('Mã số thuế', [
        el('p', { class: 'muted', text: 'Mã số thuế là định danh pháp lý duy nhất của HTX và là cầu nối để nhận lại dữ liệu do cán bộ Khuyến nông lập sẵn trên cơ sở dữ liệu dùng chung.' }),
        current?.tax_code
          ? el('div', { class: 'chip-row' }, [
              badge(`MST: ${current.tax_code}`, 'good'),
              current.claimed_at ? badge(`Đã kích hoạt ${dateTime(current.claimed_at)}`, 'good')
                : badge('Chưa kích hoạt', 'warn'),
              badge(current.origin === 'khuyennong' ? 'Hồ sơ do Khuyến nông lập' : 'Hồ sơ do HTX tự tạo', 'neutral'),
            ])
          : alert('Hồ sơ này chưa có mã số thuế.', 'warn'),
        can('mdm.write')
          ? form([{ name: 'taxCode', label: 'Mã số thuế (10 hoặc 13 chữ số)', required: true, value: current?.tax_code ?? '' }],
              async (values) => {
                await api(`/htx-registry/${htxId}/tax-code`, { method: 'PUT', body: values });
                toast('Đã lưu mã số thuế.');
                actions.replaceChildren();
                await this.render(view, actions);
              }, { submitLabel: 'Lưu mã số thuế' })
          : null,
      ]),

      can('htx.write')
        ? card('Kích hoạt hồ sơ do Khuyến nông lập sẵn', [
            el('p', { class: 'muted', text: 'Nếu cán bộ Khuyến nông đã khảo sát và lập hồ sơ HTX của bạn, nhập mã số thuế để xem trước và nhận lại toàn bộ thửa ruộng, thành viên, vụ canh tác đã có.' }),
            form([{ name: 'taxCode', label: 'Mã số thuế', required: true }], async (values) => {
              const preview = await api('/htx-registry/preview-claim', { body: values });
              claimPreview.replaceChildren(
                card(`Hồ sơ ${preview.cooperative.code} — ${preview.cooperative.name}`, [
                  preview.alreadyClaimed
                    ? alert(`Hồ sơ này đã được kích hoạt ngày ${String(preview.cooperative.claimed_at).slice(0, 10)}.`, 'warn')
                    : alert('Kích hoạt sẽ xác lập quyền sở hữu hồ sơ này cho tài khoản HTX. Dữ liệu dưới đây đã nằm sẵn trên cơ sở dữ liệu dùng chung.', 'info'),
                  el('div', { class: 'grid cols-4' }, [
                    kpi('Thửa ruộng', num(preview.inherits.plots), `${num(preview.inherits.plotAreaHa, 2)} ha`),
                    kpi('Thành viên', num(preview.inherits.farmers)),
                    kpi('Vụ canh tác', num(preview.inherits.cropCycles)),
                    kpi('Máy móc', num(preview.inherits.machines)),
                    kpi('Thống kê sản lượng', num(preview.inherits.harvestStatistics)),
                    kpi('Phiếu khảo sát', num(preview.inherits.surveyResponses)),
                  ]),
                  !preview.alreadyClaimed
                    ? el('button', {
                        class: 'small', text: '✓ Xác nhận kích hoạt',
                        onclick: async () => {
                          await guard(api('/htx-registry/claim', { body: { taxCode: values.taxCode } }));
                          toast('Đã kích hoạt hồ sơ — dữ liệu đã thuộc về HTX.');
                          actions.replaceChildren();
                          await this.render(view, actions);
                        },
                      })
                    : null,
                ]),
              );
            }, { submitLabel: '🔍 Xem trước dữ liệu thừa hưởng' }),
            claimPreview,
          ])
        : null,
    );
  },
});
