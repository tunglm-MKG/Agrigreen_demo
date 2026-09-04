/**
 * QUY TRÌNH SẢN XUẤT CHUẨN & KẾ HOẠCH SẢN XUẤT — Cổng Hợp tác xã.
 *
 * Ba màn hình nối tiếp nhau đúng theo dòng nghiệp vụ:
 *
 *   htx-protocols  Soạn / ban hành quy trình chuẩn (VietGAP, SRP, hữu cơ…)
 *   htx-plan       Bung quy trình thành kế hoạch cho một vụ, theo ngày xuống giống
 *   (xác nhận)     Ghi nhật ký = xác nhận bước kế hoạch, có điều chỉnh + bằng chứng
 *
 * Màn hình quy trình cũng được đăng ký cho Cổng Khuyến nông, vì quy trình chuẩn
 * thường do cơ quan chuyên môn ban hành rồi HTX áp dụng.
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num, dateTime,
  toast, guard, can, form, navigate,
} from '/app.js';

const STANDARD_LABEL = {
  vietgap: 'VietGAP', srp: 'SRP', huu_co: 'Hữu cơ', noi_bo: 'Nội bộ',
};
const EVIDENCE_LABEL = {
  anh_hien_truong: 'Ảnh hiện trường', hoa_don_vat_tu: 'Hoá đơn / nhãn vật tư',
  phieu_kiem_nghiem: 'Phiếu kiểm nghiệm', ghi_chu: 'Ghi chú / biên bản', khac: 'Khác',
};
const ACTIVITY_LABEL = {
  lam_dat: 'Làm đất', gieo_sa: 'Gieo sạ', bon_phan: 'Bón phân', phun_thuoc: 'Phun thuốc',
  tuoi: 'Tưới nước', rut_nuoc_awd: 'Rút nước (AWD)', thu_hoach: 'Thu hoạch',
};
const STEP_TONE = {
  ke_hoach: 'neutral', da_thuc_hien: 'good', tre_han: 'warn', bo_qua: 'neutral',
};
const STEP_LABEL = {
  ke_hoach: 'Theo kế hoạch', da_thuc_hien: 'Đã thực hiện', tre_han: 'Trễ hạn', bo_qua: 'Bỏ qua',
};

const HTX_STORAGE_KEY = 'mekong-green.htx';

function savedHtxId(list) {
  let saved = null;
  try { saved = localStorage.getItem(HTX_STORAGE_KEY); } catch { saved = null; }
  if (saved && list.some((h) => h.id === saved)) return saved;
  return list[0]?.id ?? null;
}

// ===========================================================================
// Quy trình sản xuất chuẩn
// ===========================================================================

const protocolsPage = {
  title: 'Quy trình sản xuất chuẩn',
  subtitle: 'Bản mẫu VietGAP / SRP / hữu cơ — mỗi bước neo theo ngày xuống giống, có bằng chứng bắt buộc và điểm kiểm soát',
  async render(view, actions) {
    const [protocols, meta, derivable] = await Promise.all([
      guard(api('/production/protocols')), api('/production/standards'),
      api('/production/derivable-cycles').catch(() => []),
    ]);

    let selectedId = protocols.find((p) => p.status === 'ban_hanh')?.id ?? protocols[0]?.id ?? null;
    const detail = el('div', { class: 'grid' });
    const derivePreview = el('div');

    /**
     * Xem trước quy trình sẽ rút ra từ vụ đã chọn.
     *
     * Bản xem trước nói thẳng những gì KHÔNG suy ra được từ một vụ đơn lẻ (cửa
     * sổ thời gian, bước nào bắt buộc, bằng chứng, thời gian cách ly) thay vì
     * lặng lẽ điền giá trị mặc định rồi để người dùng tưởng đó là dữ liệu thật.
     */
    const showDerivePreview = async (cycleId) => {
      if (!cycleId) return derivePreview.replaceChildren();
      let preview;
      try {
        preview = await api(`/production/cycles/${cycleId}/derive-preview`);
      } catch (error) {
        return derivePreview.replaceChildren(alert(error.message, 'bad'));
      }

      derivePreview.replaceChildren(
        el('div', { class: 'chip-row', style: 'margin-top:10px' }, [
          badge(preview.source === 'ke_hoach' ? 'Nguồn: kế hoạch đã thực hiện' : 'Nguồn: nhật ký ghi rời',
            preview.source === 'ke_hoach' ? 'good' : 'warn'),
          badge(`${preview.steps.length} bước`, 'neutral'),
          badge(`Neo theo ngày sạ ${preview.anchorDate}`, 'neutral'),
        ]),
        el('p', { class: 'muted', text: preview.sourceLabel }),

        ...preview.warnings.map((text) => alert(text, 'warn')),

        preview.notDerived.length
          ? alert(
              'Những thuộc tính sau KHÔNG quan sát được từ một vụ và đang lấy giá trị mặc định — ' +
              `phải rà lại trước khi ban hành: ${preview.notDerived.join(' ')}`,
              'warn')
          : alert('Mọi thuộc tính của bước được kế thừa từ quy trình gốc; chỉ mốc thời gian được tính lại theo ngày thực tế đã làm.', 'info'),

        table([
          { key: 'sortOrder', label: '#', align: 'right' },
          { key: 'name', label: 'Bước' },
          { key: 'activity', label: 'Hoạt động', render: (row) => ACTIVITY_LABEL[row.activity] ?? row.activity },
          { key: 'actualDate', label: 'Ngày đã làm' },
          {
            key: 'offsetDays', label: 'Ngày lệch', align: 'right',
            render: (row) => (row.offsetDays === 0 ? 'Ngày sạ' : row.offsetDays > 0 ? `+${row.offsetDays}` : `${row.offsetDays}`),
          },
          {
            key: 'shiftDays', label: 'So với kế hoạch cũ', align: 'right',
            render: (row) => (row.shiftDays === null ? '—'
              : row.shiftDays === 0 ? badge('Đúng lịch', 'good')
              : badge(`${row.shiftDays > 0 ? '+' : ''}${row.shiftDays} ngày`, 'warn')),
          },
          {
            key: 'mandatory', label: 'Bắt buộc',
            render: (row) => badge(row.mandatory ? 'Bắt buộc' : 'Tuỳ chọn', row.mandatory ? 'warn' : 'neutral'),
          },
          {
            key: 'evidenceKinds', label: 'Bằng chứng',
            render: (row) => (row.evidenceKinds.length
              ? el('span', { class: 'chip-row' }, row.evidenceKinds.map((k) => badge(EVIDENCE_LABEL[k] ?? k, 'info')))
              : '—'),
          },
          {
            key: 'phiDays', label: 'Cách ly', align: 'right',
            render: (row) => (row.phiDays ? badge(`${row.phiDays} ngày`, 'bad')
              : row.activity === 'phun_thuoc' ? badge('Chưa có', 'bad') : '—'),
          },
        ], preview.steps),

        form([
          { name: 'name', label: 'Tên quy trình mới', required: true,
            value: `Quy trình rút từ vụ ${preview.cropCycle.code}` },
          {
            name: 'standard', label: 'Chuẩn áp dụng', type: 'select', required: true,
            options: (meta.standards ?? []).map((st) => ({
              value: st.code, label: st.label, selected: st.code === 'noi_bo',
            })),
          },
          {
            name: 'scope', label: 'Phạm vi', type: 'select',
            options: [
              { value: 'htx', label: 'Riêng HTX này' },
              { value: 'he_thong', label: 'Quy trình chuẩn hệ thống' },
            ],
          },
        ], async (values) => {
          const created = await api('/production/protocols/from-cycle', {
            body: { ...values, cropCycleId: cycleId, htxId: preview.cropCycle.htxId },
          });
          selectedId = created.id;
          toast(`Đã tạo bản nháp ${created.code} v${created.version} — rà lại rồi ban hành.`);
          actions.replaceChildren();
          await this.render(view, actions);
        }, { submitLabel: '⤵ Tạo quy trình từ vụ này' }),
      );
    };

    const drawDetail = async () => {
      if (!selectedId) return detail.replaceChildren();
      const { protocol, steps } = await guard(api(`/production/protocols/${selectedId}`));
      const editable = protocol.status === 'nhap' && Number(protocol.plan_count ?? 0) === 0;

      detail.replaceChildren(
        card(`${protocol.code} v${protocol.version} — ${protocol.name}`, [
          el('div', { class: 'chip-row' }, [
            badge(STANDARD_LABEL[protocol.standard] ?? protocol.standard, 'info'),
            badge(protocol.status === 'ban_hanh' ? 'Đã ban hành' : protocol.status === 'ngung' ? 'Ngừng áp dụng' : 'Bản nháp',
              protocol.status === 'ban_hanh' ? 'good' : 'neutral'),
            badge(protocol.scope === 'he_thong' ? 'Quy trình chuẩn hệ thống' : `Riêng ${protocol.htx_name ?? 'HTX'}`, 'neutral'),
            badge(`${steps.length} bước`, 'neutral'),
          ]),
          protocol.document_ref ? el('p', { class: 'muted', text: `Căn cứ: ${protocol.document_ref}` }) : null,
          protocol.description ? el('p', { class: 'muted', text: protocol.description }) : null,

          table([
            { key: 'sort_order', label: '#', align: 'right' },
            { key: 'name', label: 'Bước' },
            { key: 'activity', label: 'Hoạt động', render: (row) => ACTIVITY_LABEL[row.activity] ?? row.activity },
            {
              key: 'offset_days', label: 'Ngày (so với xuống giống)', align: 'right',
              render: (row) => (row.offset_days === 0 ? 'Ngày sạ'
                : row.offset_days < 0 ? `${row.offset_days}` : `+${row.offset_days}`),
            },
            { key: 'window_days', label: 'Cửa sổ', align: 'right', render: (row) => `±${row.window_days} ngày` },
            {
              key: 'mandatory', label: 'Bắt buộc',
              render: (row) => badge(row.mandatory ? 'Bắt buộc' : 'Tuỳ chọn', row.mandatory ? 'warn' : 'neutral'),
            },
            {
              key: 'evidence_kinds', label: 'Bằng chứng',
              render: (row) => {
                const kinds = row.evidence_kinds ? JSON.parse(row.evidence_kinds) : [];
                return kinds.length
                  ? el('span', { class: 'chip-row' }, kinds.map((k) => badge(EVIDENCE_LABEL[k] ?? k, 'info')))
                  : '—';
              },
            },
            {
              key: 'phi_days', label: 'Cách ly', align: 'right',
              render: (row) => (row.phi_days ? badge(`${row.phi_days} ngày`, 'bad') : '—'),
            },
            {
              key: 'remove', label: '',
              render: (row) => (editable && can('htx.write')
                ? el('button', {
                    class: 'ghost small', text: '✕',
                    onclick: async () => {
                      await guard(api(`/production/steps/${row.id}`, { method: 'DELETE' }));
                      toast('Đã xoá bước.');
                      await drawDetail();
                    },
                  })
                : '—'),
            },
          ], steps, { empty: 'Quy trình chưa có bước nào.' }),

          steps.some((s) => s.control_point)
            ? el('details', { class: 'raw' }, [
                el('summary', { class: 'muted', text: 'Điểm kiểm soát & hướng dẫn từng bước' }),
                el('div', { class: 'list' }, steps.filter((s) => s.control_point || s.instruction).map((s) =>
                  el('div', { class: 'list-item', style: 'cursor:default' }, [
                    el('div', { class: 'title', text: s.name }),
                    s.control_point ? el('div', { class: 'muted', text: `Kiểm soát: ${s.control_point}` }) : null,
                    s.instruction ? el('div', { class: 'muted', text: s.instruction }) : null,
                  ]))),
              ])
            : null,
        ], can('htx.write')
          ? el('span', { class: 'chip-row' }, [
              protocol.status === 'nhap'
                ? el('button', {
                    class: 'small', text: '✓ Ban hành',
                    onclick: async () => {
                      await guard(api(`/production/protocols/${selectedId}/publish`, { body: {} }));
                      toast('Đã ban hành — HTX áp dụng vào vụ được rồi.');
                      await this.render(view, (actions.replaceChildren(), actions));
                    },
                  })
                : null,
              el('button', {
                class: 'ghost small', text: '⎘ Tạo phiên bản mới',
                onclick: async () => {
                  await guard(api(`/production/protocols/${selectedId}/clone`, { body: {} }));
                  toast('Đã tạo phiên bản mới ở trạng thái nháp — sửa rồi ban hành.');
                  await this.render(view, (actions.replaceChildren(), actions));
                },
              }),
            ])
          : null),

        editable && can('htx.write')
          ? card('Thêm bước vào quy trình', [
              el('p', { class: 'muted', text: 'Số ngày lệch tính từ ngày xuống giống: số âm là việc làm trước khi sạ, 0 là chính ngày sạ. Cửa sổ là biên độ được coi là đúng hạn — thực hiện lệch quá biên độ này khi xác nhận sẽ bị bắt ghi lý do.' }),
              form([
                { name: 'name', label: 'Tên bước', required: true },
                {
                  name: 'activity', label: 'Hoạt động', type: 'select', required: true,
                  options: Object.entries(ACTIVITY_LABEL).map(([value, label]) => ({ value, label })),
                },
                { name: 'stage', label: 'Giai đoạn', placeholder: 'VD: Đẻ nhánh' },
                { name: 'offsetDays', label: 'Ngày lệch', type: 'number', required: true, value: '0' },
                { name: 'windowDays', label: 'Cửa sổ (±ngày)', type: 'number', value: '3' },
                {
                  name: 'mandatory', label: 'Mức độ', type: 'select',
                  options: [{ value: '1', label: 'Bắt buộc' }, { value: '0', label: 'Tuỳ chọn' }],
                },
                {
                  name: 'evidenceKinds', label: 'Bằng chứng bắt buộc', type: 'select',
                  options: [{ value: '', label: '— Không yêu cầu —' },
                    ...(meta.evidenceKinds ?? []).map((e) => ({ value: e.code, label: e.label }))],
                },
                { name: 'phiDays', label: 'Cách ly sau phun (ngày)', type: 'number', placeholder: 'Chỉ với bước phun thuốc' },
                { name: 'controlPoint', label: 'Điểm kiểm soát' },
                { name: 'instruction', label: 'Hướng dẫn', type: 'textarea', rows: 2 },
              ], async (values) => {
                await api(`/production/protocols/${selectedId}/steps`, {
                  body: {
                    ...values,
                    mandatory: values.mandatory !== '0',
                    evidenceKinds: values.evidenceKinds ? [values.evidenceKinds] : [],
                    phiDays: values.phiDays ?? null,
                  },
                });
                toast('Đã thêm bước vào quy trình.');
                await drawDetail();
              }, { submitLabel: '+ Thêm bước' }),
            ])
          : (protocol.status === 'ban_hanh'
              ? alert('Quy trình đã ban hành nên không sửa trực tiếp được — điều này giữ nguyên căn cứ của các kế hoạch đã phát hành. Muốn thay đổi, hãy tạo phiên bản mới.', 'info')
              : null),
      );
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Quy trình đã ban hành', num(protocols.filter((p) => p.status === 'ban_hanh').length),
          'Sẵn sàng áp dụng vào vụ', 'good'),
        kpi('Bản nháp', num(protocols.filter((p) => p.status === 'nhap').length)),
        kpi('Đang được áp dụng',
          num(protocols.reduce((acc, p) => acc + Number(p.plan_count ?? 0), 0)),
          'Số kế hoạch sản xuất đang dùng các quy trình này'),
      ]),

      can('htx.write')
        ? card('Soạn quy trình mới', form([
            { name: 'name', label: 'Tên quy trình', required: true, placeholder: 'VD: Quy trình canh tác lúa theo VietGAP' },
            {
              name: 'standard', label: 'Chuẩn áp dụng', type: 'select', required: true,
              options: (meta.standards ?? []).map((s) => ({ value: s.code, label: s.label })),
            },
            { name: 'code', label: 'Mã quy trình', placeholder: 'Bỏ trống để hệ thống tự sinh' },
            { name: 'documentRef', label: 'Văn bản căn cứ', placeholder: 'VD: TCVN 11892-1:2017' },
            { name: 'description', label: 'Mô tả', type: 'textarea', rows: 2 },
          ], async (values) => {
            const created = await api('/production/protocols', { body: values });
            selectedId = created.id;
            toast('Đã tạo bản nháp quy trình — thêm các bước rồi ban hành.');
            await this.render(view, (actions.replaceChildren(), actions));
          }, { submitLabel: '+ Tạo quy trình' }))
        : null,

      can('htx.write') && derivable.length
        ? card('Rút quy trình từ một vụ đã hoàn thành', [
            el('p', { class: 'muted', text: 'Đi ngược chiều với luồng thông thường: thay vì áp quy trình xuống vụ, hệ thống đọc lại một vụ đã đi hết chu kỳ và dựng thành bản mẫu để lặp lại cho các vụ sau.' }),
            el('label', {}, ['Vụ nguồn', el('select', {
              onchange: (event) => showDerivePreview(event.target.value),
            }, [el('option', { value: '' }, ['— Chọn vụ đã hoàn thành —']),
              ...derivable.map((c) => el('option', { value: c.id }, [
                `${c.code} — lô ${c.plot_code} · ${c.season_name}` +
                ` · ${c.source === 'ke_hoach' ? 'có kế hoạch' : `${c.log_count} bản ghi nhật ký`}`,
              ]))])]),
            derivePreview,
          ])
        : null,

      card('Danh mục quy trình', table([
        { key: 'code', label: 'Mã' },
        { key: 'version', label: 'Phiên bản', align: 'right', render: (row) => `v${row.version}` },
        { key: 'name', label: 'Tên quy trình' },
        { key: 'standard', label: 'Chuẩn', render: (row) => badge(STANDARD_LABEL[row.standard] ?? row.standard, 'info') },
        { key: 'step_count', label: 'Số bước', align: 'right', render: (row) => num(row.step_count) },
        { key: 'plan_count', label: 'Kế hoạch dùng', align: 'right', render: (row) => num(row.plan_count) },
        {
          key: 'status', label: 'Trạng thái',
          render: (row) => badge(row.status === 'ban_hanh' ? 'Đã ban hành' : row.status === 'ngung' ? 'Ngừng' : 'Nháp',
            row.status === 'ban_hanh' ? 'good' : 'neutral'),
        },
        { key: 'updated_at', label: 'Cập nhật', render: (row) => dateTime(row.updated_at) },
      ], protocols, {
        empty: 'Chưa có quy trình nào.',
        onRowClick: (row) => { selectedId = row.id; drawDetail(); },
        rowClass: (row) => (row.id === selectedId ? 'highlight' : null),
      })),

      detail,
    );

    await drawDetail();
  },
};

registerPage('htx-protocols', protocolsPage);

// Cơ quan khuyến nông ban hành quy trình chuẩn cho toàn địa bàn.
registerPage('kn-protocols', {
  ...protocolsPage,
  title: 'Quy trình sản xuất chuẩn',
  subtitle: 'Ban hành quy trình VietGAP / SRP / hữu cơ để các HTX trên địa bàn áp dụng vào kế hoạch sản xuất',
});

// ===========================================================================
// Kế hoạch sản xuất của một vụ
// ===========================================================================

registerPage('htx-plan', {
  title: 'Kế hoạch sản xuất',
  subtitle: 'Bung quy trình chuẩn thành lịch cụ thể theo ngày xuống giống; ghi nhật ký = xác nhận từng bước kèm bằng chứng',
  async render(view, actions) {
    const cooperatives = await guard(api('/mdm/cooperatives'));
    const htxId = savedHtxId(cooperatives);
    if (!htxId) return view.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));

    actions.append(el('label', { class: 'htx-picker' }, [
      el('span', { class: 'muted', text: 'HTX:' }),
      el('select', {
        onchange: (event) => {
          try { localStorage.setItem(HTX_STORAGE_KEY, event.target.value); } catch { /* bỏ qua */ }
          actions.replaceChildren();
          this.render(view, actions);
        },
      }, cooperatives.map((h) => el('option', { value: h.id, selected: h.id === htxId }, [`${h.code} — ${h.name}`]))),
    ]));

    const [cycles, plans, protocols] = await Promise.all([
      api(`/htx/crop-cycles?htxId=${htxId}`),
      api(`/production/plans?htxId=${htxId}`),
      api('/production/protocols?status=ban_hanh'),
    ]);
    const active = cycles.filter((c) => c.status === 'dang_canh_tac');
    const planByCycle = new Map(plans.map((p) => [p.crop_cycle_id, p]));
    const withoutPlan = active.filter((c) => !planByCycle.has(c.id));

    let selectedPlanId = plans[0]?.id ?? null;
    const detail = el('div', { class: 'grid' });

    const drawPlan = async () => {
      if (!selectedPlanId) return detail.replaceChildren();
      const { plan, steps, progress } = await guard(api(`/production/plans/${selectedPlanId}`));

      detail.replaceChildren(
        card(`${plan.code} — vụ ${plan.crop_cycle_code} (lô ${plan.plot_code})`, [
          el('div', { class: 'chip-row' }, [
            badge(`${plan.protocol_code} v${plan.protocol_version}`, 'info'),
            badge(STANDARD_LABEL[plan.standard] ?? plan.standard, 'info'),
            badge(`Neo vào ngày xuống giống ${plan.anchor_date}`, 'neutral'),
            badge(plan.status === 'hoan_thanh' ? 'Đã hoàn thành' : 'Đang thực hiện',
              plan.status === 'hoan_thanh' ? 'good' : 'neutral'),
          ]),
          el('div', { class: 'grid cols-4', style: 'margin-top:10px' }, [
            kpi('Tiến độ', `${progress.doneSteps}/${progress.totalSteps}`, `${progress.completionPct}% số bước`),
            kpi('Tuân thủ quy trình', `${progress.compliancePct}%`,
              'Bước bắt buộc thực hiện ĐÚNG HẠN / tổng bước bắt buộc',
              progress.compliancePct >= 90 ? 'good' : progress.compliancePct >= 60 ? 'warning' : 'critical'),
            kpi('Bước quá hạn', num(progress.overdueSteps), 'Đã qua ngày dự kiến + cửa sổ',
              progress.overdueSteps ? 'critical' : 'good'),
            kpi('Bước kế tiếp', progress.nextStep?.name ?? '— Không còn —',
              progress.nextStep ? `Dự kiến ${progress.nextStep.planned_date}` : 'Mọi bước đã xử lý'),
          ]),
          progress.compliancePct < 100 && progress.mandatoryDone === progress.mandatorySteps
            ? alert('Đã làm đủ bước bắt buộc nhưng có bước trễ hạn — hồ sơ vẫn ghi nhận độ lệch, vì chứng nhận VietGAP xét cả thời điểm thực hiện chứ không chỉ việc có làm hay không.', 'warn')
            : null,
        ], can('htx.write') && plan.status !== 'hoan_thanh'
          ? el('button', {
              class: 'ghost small', text: '🗑 Huỷ kế hoạch',
              onclick: async () => {
                await guard(api(`/production/plans/${selectedPlanId}`, { method: 'DELETE' }));
                toast('Đã huỷ kế hoạch.');
                actions.replaceChildren();
                await this.render(view, actions);
              },
            })
          : null),

        card('Các bước kế hoạch', el('div', { class: 'plan-steps' },
          steps.map((step) => planStepRow(step, drawPlan)))),
      );
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Vụ đang canh tác', num(active.length)),
        kpi('Vụ đã có kế hoạch', num(plans.length), null, 'good'),
        kpi('Vụ chưa lập kế hoạch', num(withoutPlan.length),
          'Nhật ký của các vụ này vẫn là ghi chép tự do',
          withoutPlan.length ? 'warning' : 'good'),
        kpi('Quy trình khả dụng', num(protocols.length), 'Đã ban hành, áp dụng được ngay'),
      ]),

      can('htx.write') && withoutPlan.length
        ? card('Lập kế hoạch sản xuất cho một vụ', [
            el('p', { class: 'muted', text: 'Hệ thống bung các bước của quy trình thành lịch cụ thể, neo vào ngày xuống giống của vụ. Vụ chưa khai ngày xuống giống thì không lập được kế hoạch — hệ thống không tự đoán ngày neo.' }),
            protocols.length
              ? form([
                  {
                    name: 'cropCycleId', label: 'Vụ canh tác', type: 'select', required: true,
                    options: withoutPlan.map((c) => ({
                      value: c.id,
                      label: `${c.code} — lô ${c.plot_code}${c.sowing_date ? ` (sạ ${c.sowing_date})` : ' (CHƯA CÓ NGÀY SẠ)'}`,
                    })),
                  },
                  {
                    name: 'protocolId', label: 'Quy trình áp dụng', type: 'select', required: true,
                    options: protocols.map((p) => ({
                      value: p.id,
                      label: `${p.code} v${p.version} — ${p.name} (${p.step_count} bước)`,
                    })),
                  },
                  { name: 'anchorDate', label: 'Ngày neo (bỏ trống = ngày xuống giống)', type: 'date' },
                ], async (values) => {
                  const created = await api('/production/plans', {
                    body: { ...values, anchorDate: values.anchorDate || undefined },
                  });
                  selectedPlanId = created.id;
                  toast(`Đã lập kế hoạch ${created.code}.`);
                  actions.replaceChildren();
                  await this.render(view, actions);
                }, { submitLabel: '📅 Lập kế hoạch' })
              : alert('Chưa có quy trình nào được ban hành. Vào "Quy trình sản xuất" để soạn và ban hành trước.', 'info'),
          ])
        : null,

      plans.length
        ? card('Kế hoạch sản xuất của HTX', table([
            { key: 'code', label: 'Mã kế hoạch' },
            { key: 'crop_cycle_code', label: 'Vụ' },
            { key: 'plot_code', label: 'Lô' },
            { key: 'protocol_name', label: 'Quy trình' },
            { key: 'anchor_date', label: 'Ngày neo' },
            {
              key: 'progress', label: 'Tiến độ', align: 'right',
              render: (row) => `${row.progress.doneSteps}/${row.progress.totalSteps}`,
            },
            {
              key: 'compliance', label: 'Tuân thủ', align: 'right',
              render: (row) => badge(`${row.progress.compliancePct}%`,
                row.progress.compliancePct >= 90 ? 'good' : row.progress.compliancePct >= 60 ? 'warn' : 'bad'),
            },
            {
              key: 'status', label: 'Trạng thái',
              render: (row) => badge(row.status === 'hoan_thanh' ? 'Hoàn thành' : 'Đang thực hiện',
                row.status === 'hoan_thanh' ? 'good' : 'neutral'),
            },
          ], plans, {
            onRowClick: (row) => { selectedPlanId = row.id; drawPlan(); },
            rowClass: (row) => (row.id === selectedPlanId ? 'highlight' : null),
          }))
        : alert('HTX chưa có kế hoạch sản xuất nào.', 'info'),

      detail,
    );

    await drawPlan();
  },
});

/** Một dòng bước kế hoạch, mở ra được form xác nhận kèm bằng chứng. */
function planStepRow(step, refresh) {
  const body = el('div', { class: 'plan-step-body', hidden: true });
  const kinds = step.requiredEvidenceKinds ?? [];
  const evidenceFiles = [];

  const header = el('div', {
    class: 'plan-step-head',
    onclick: () => { body.hidden = !body.hidden; },
  }, [
    el('span', { class: 'plan-step-order', text: String(step.sort_order) }),
    el('div', { class: 'plan-step-main' }, [
      el('strong', { text: step.name }),
      el('div', { class: 'muted' }, [
        `${ACTIVITY_LABEL[step.activity] ?? step.activity} · dự kiến ${step.planned_date} (±${step.window_days} ngày)`,
        step.actual_date ? ` · thực hiện ${step.actual_date}` : '',
      ]),
    ]),
    el('span', { class: 'chip-row' }, [
      step.mandatory ? badge('Bắt buộc', 'warn') : badge('Tuỳ chọn', 'neutral'),
      step.phi_days ? badge(`Cách ly ${step.phi_days}n`, 'bad') : null,
      step.overdue ? badge('Quá hạn', 'bad') : null,
      badge(STEP_LABEL[step.status] ?? step.status, STEP_TONE[step.status] ?? 'neutral'),
      step.status === 'da_thuc_hien' && step.onTime === false
        ? badge(`Lệch ${step.deviation_days > 0 ? '+' : ''}${step.deviation_days} ngày`, 'bad')
        : null,
    ]),
  ]);

  const details = [];
  if (step.control_point) details.push(el('p', { class: 'muted', text: `Điểm kiểm soát: ${step.control_point}` }));
  if (step.instruction) details.push(el('p', { class: 'muted', text: step.instruction }));
  if (step.deviation_reason) details.push(alert(`Lý do điều chỉnh: ${step.deviation_reason}`, 'warn'));

  if (step.evidence?.length) {
    details.push(el('p', { class: 'muted', text: 'Bằng chứng đã đính:' }));
    details.push(el('div', { class: 'chip-row' }, step.evidence.map((item) =>
      badge(`${EVIDENCE_LABEL[item.kind] ?? item.kind}${item.label ? `: ${item.label}` : ''}`, 'good'))));
  }

  if (step.status === 'ke_hoach' && can('htx.write')) {
    if (kinds.length) {
      details.push(el('p', { class: 'muted' }, [
        'Bằng chứng bắt buộc: ',
        ...kinds.map((k) => badge(EVIDENCE_LABEL[k] ?? k, step.missingEvidence.includes(k) ? 'bad' : 'good')),
      ]));
    }

    // Chọn tệp bằng chứng — đọc thành data URI ngay trên trình duyệt.
    const fileList = el('div', { class: 'muted', text: 'Chưa chọn tệp nào.' });
    if (kinds.length) {
      details.push(el('div', { class: 'row' }, [
        el('label', {}, ['Loại bằng chứng', el('select', { name: 'evidenceKind' },
          kinds.map((k) => el('option', { value: k }, [EVIDENCE_LABEL[k] ?? k])))]),
        el('label', {}, ['Tệp đính kèm', el('input', {
          type: 'file', accept: 'image/*,.pdf',
          onchange: async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 2_000_000) {
              toast('Tệp lớn hơn 2 MB — hãy chụp lại ở độ phân giải thấp hơn.', true);
              event.target.value = '';
              return;
            }
            const kindSelect = event.target.closest('.row').querySelector('select[name=evidenceKind]');
            const content = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(file);
            });
            evidenceFiles.push({
              kind: kindSelect.value, label: file.name, fileName: file.name,
              mimeType: file.type, content,
            });
            fileList.textContent = evidenceFiles
              .map((f) => `${EVIDENCE_LABEL[f.kind] ?? f.kind}: ${f.fileName}`).join(' · ');
            event.target.value = '';
          },
        })]),
      ]));
      details.push(fileList);
    }

    details.push(form([
      { name: 'actualDate', label: 'Ngày thực hiện', type: 'date', required: true, value: step.planned_date },
      { name: 'deviationReason', label: 'Lý do điều chỉnh (nếu lệch quá cửa sổ)' },
      { name: 'detail', label: 'Ghi chú thực tế', type: 'textarea', rows: 2 },
      { name: 'inputName', label: 'Vật tư sử dụng' },
      { name: 'inputQty', label: 'Số lượng', type: 'number', step: '0.01' },
      { name: 'inputUom', label: 'Đơn vị', placeholder: 'kg / lít' },
    ], async (values) => {
      await api(`/production/steps/${step.id}/confirm`, {
        body: { ...values, evidence: evidenceFiles },
      });
      toast('Đã xác nhận bước — nhật ký sản xuất được ghi kèm bằng chứng.');
      await refresh();
    }, { submitLabel: '✓ Xác nhận đã thực hiện' }));

    if (!step.mandatory) {
      details.push(el('button', {
        class: 'ghost small', text: 'Bỏ qua bước này',
        onclick: async () => {
          const reason = prompt('Lý do bỏ qua bước này:');
          if (!reason) return;
          await guard(api(`/production/steps/${step.id}/skip`, { body: { reason } }));
          toast('Đã đánh dấu bỏ qua.');
          await refresh();
        },
      }));
    }
  }

  body.replaceChildren(...details.filter(Boolean));
  return el('div', { class: `plan-step ${step.status}` }, [header, body]);
}

export { protocolsPage };
