/**
 * KHẢO SÁT THU THẬP DỮ LIỆU & HỒ SƠ HTX — Cổng Khuyến nông.
 *
 *   kn-surveys    Soạn / ban hành mẫu khảo sát, nhập phiếu, tổng hợp theo kỳ
 *   kn-plots      Vẽ thửa ruộng trên bản đồ rồi gán cho HTX và hộ dân
 *   kn-htx        Khởi tạo hồ sơ HTX theo mã số thuế, theo dõi hồ sơ chưa kích hoạt
 *
 * Điểm đáng chú ý của phiếu khảo sát: ba ô địa chỉ LỌC DẦN — chọn tỉnh mới hiện
 * xã của tỉnh đó, chọn xã mới hiện thôn/ấp của xã đó. Danh sách lấy thẳng theo
 * quan hệ cha–con trong cây hành chính nên không bao giờ lệch.
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num, dateTime,
  toast, guard, can, form, mapContainer, createMap, LEAFLET_AVAILABLE,
} from '/app.js';

const FREQ_LABEL = { tuan: 'Hàng tuần', thang: 'Hàng tháng', dot_xuat: 'Đột xuất' };
const KIND_LABEL = {
  text: 'Văn bản', number: 'Số', date: 'Ngày',
  select: 'Chọn một', multiselect: 'Chọn nhiều', boolean: 'Có / Không',
};

// ===========================================================================
// Bộ ba ô địa chỉ lọc dần: tỉnh → xã → thôn/ấp
// ===========================================================================

/**
 * Trả về một khối 3 ô select liên động và hàm đọc giá trị hiện tại.
 *
 * Mỗi cấp chỉ nạp danh sách sau khi cấp trên được chọn, nên không có chuyện
 * người dùng chọn được một ấp không thuộc xã đã chọn.
 */
function adminCascade() {
  const state = { provinceId: '', communeId: '', hamletId: '' };

  const hamletSelect = el('select', { name: 'hamletId', disabled: true }, [
    el('option', { value: '' }, ['— Chọn xã trước —']),
  ]);
  const communeSelect = el('select', { name: 'communeId', disabled: true }, [
    el('option', { value: '' }, ['— Chọn tỉnh trước —']),
  ]);
  const provinceSelect = el('select', { name: 'provinceId' }, [
    el('option', { value: '' }, ['— Đang tải —']),
  ]);

  const fill = (select, rows, placeholder) => {
    select.replaceChildren(
      el('option', { value: '' }, [placeholder]),
      ...rows.map((row) => el('option', { value: row.id }, [row.name])),
    );
    select.disabled = rows.length === 0;
  };

  provinceSelect.addEventListener('change', async (event) => {
    state.provinceId = event.target.value;
    state.communeId = '';
    state.hamletId = '';
    fill(hamletSelect, [], '— Chọn xã trước —');
    if (!state.provinceId) return fill(communeSelect, [], '— Chọn tỉnh trước —');
    const communes = await api(`/survey/admin-units?parentId=${state.provinceId}&level=commune`);
    fill(communeSelect, communes, '— Chọn xã/phường —');
  });

  communeSelect.addEventListener('change', async (event) => {
    state.communeId = event.target.value;
    state.hamletId = '';
    if (!state.communeId) return fill(hamletSelect, [], '— Chọn xã trước —');
    const hamlets = await api(`/survey/admin-units?parentId=${state.communeId}&level=ap`);
    fill(hamletSelect, hamlets, '— Chọn thôn/ấp —');
  });

  hamletSelect.addEventListener('change', (event) => { state.hamletId = event.target.value; });

  api('/survey/admin-units?level=province').then((rows) => {
    fill(provinceSelect, rows, '— Chọn tỉnh/thành —');
  });

  const node = el('div', { class: 'row' }, [
    el('label', {}, ['Tỉnh / Thành phố', provinceSelect]),
    el('label', {}, ['Xã / Phường', communeSelect]),
    el('label', {}, ['Thôn / Ấp', hamletSelect]),
  ]);

  return { node, value: () => ({ ...state }) };
}

// ===========================================================================
// Mẫu khảo sát
// ===========================================================================

registerPage('kn-surveys', {
  title: 'Khảo sát thu thập dữ liệu',
  subtitle: 'Mẫu khảo sát định kỳ tuần / tháng hoặc đột xuất — hiện trạng sản xuất, ngày bắt đầu chu kỳ, khó khăn của hộ dân và HTX',
  async render(view, actions) {
    const [templates, meta] = await Promise.all([
      guard(api('/survey/templates')), api('/survey/meta'),
    ]);

    let selectedId = templates.find((t) => t.status === 'ban_hanh')?.id ?? templates[0]?.id ?? null;
    const detail = el('div', { class: 'grid' });

    const drawDetail = async () => {
      if (!selectedId) return detail.replaceChildren();
      const [{ template, questions }, summary, responses] = await Promise.all([
        guard(api(`/survey/templates/${selectedId}`)),
        api(`/survey/templates/${selectedId}/summary`),
        api(`/survey/responses?templateId=${selectedId}`),
      ]);
      const editable = template.status === 'nhap' || Number(template.response_count ?? 0) === 0;

      detail.replaceChildren(
        card(`${template.code} — ${template.name}`, [
          el('div', { class: 'chip-row' }, [
            badge(FREQ_LABEL[template.frequency] ?? template.frequency, 'info'),
            badge(template.status === 'ban_hanh' ? 'Đã ban hành' : 'Bản nháp',
              template.status === 'ban_hanh' ? 'good' : 'neutral'),
            badge(`${questions.length} câu hỏi`, 'neutral'),
            badge(`${responses.length} phiếu`, 'neutral'),
          ]),
          template.purpose ? el('p', { class: 'muted', text: template.purpose }) : null,

          table([
            { key: 'sort_order', label: '#', align: 'right' },
            { key: 'code', label: 'Mã' },
            { key: 'label', label: 'Câu hỏi' },
            { key: 'kind', label: 'Kiểu', render: (row) => badge(KIND_LABEL[row.kind] ?? row.kind, 'neutral') },
            { key: 'uom', label: 'Đơn vị', render: (row) => row.uom ?? '—' },
            {
              key: 'required', label: 'Bắt buộc',
              render: (row) => (row.required ? badge('Bắt buộc', 'warn') : '—'),
            },
            {
              key: 'optionList', label: 'Lựa chọn',
              render: (row) => (row.optionList?.length ? row.optionList.join(' · ') : '—'),
            },
            {
              key: 'del', label: '',
              render: (row) => (editable && can('khuyennong.write')
                ? el('button', {
                    class: 'ghost small', text: '✕',
                    onclick: async () => {
                      await guard(api(`/survey/questions/${row.id}`, { method: 'DELETE' }));
                      toast('Đã xoá câu hỏi.');
                      await drawDetail();
                    },
                  })
                : '—'),
            },
          ], questions, { empty: 'Mẫu chưa có câu hỏi nào.' }),
        ], can('khuyennong.write') && template.status === 'nhap'
          ? el('button', {
              class: 'small', text: '✓ Ban hành',
              onclick: async () => {
                await guard(api(`/survey/templates/${selectedId}/publish`, { body: {} }));
                toast('Đã ban hành — bắt đầu nhận phiếu khảo sát.');
                actions.replaceChildren();
                await this.render(view, actions);
              },
            })
          : null),

        editable && can('khuyennong.write')
          ? card('Thêm câu hỏi', form([
              { name: 'label', label: 'Nội dung câu hỏi', required: true },
              {
                name: 'kind', label: 'Kiểu trả lời', type: 'select', required: true,
                options: meta.questionKinds.map((k) => ({ value: k.code, label: k.label })),
              },
              { name: 'uom', label: 'Đơn vị', placeholder: 'ha, tấn, kg…' },
              { name: 'options', label: 'Lựa chọn (ngăn bằng dấu ;)', placeholder: 'Kênh nội đồng; Trạm bơm; Nước trời' },
              {
                name: 'required', label: 'Bắt buộc trả lời', type: 'select',
                options: [{ value: '0', label: 'Không' }, { value: '1', label: 'Có' }],
              },
            ], async (values) => {
              await api(`/survey/templates/${selectedId}/questions`, {
                body: {
                  ...values,
                  required: values.required === '1',
                  options: values.options ? values.options.split(';').map((s) => s.trim()).filter(Boolean) : [],
                },
              });
              toast('Đã thêm câu hỏi.');
              await drawDetail();
            }, { submitLabel: '+ Thêm câu hỏi' }))
          : null,

        template.status === 'ban_hanh' && can('khuyennong.write')
          ? responseForm(template, questions, meta, drawDetail)
          : null,

        card('Tổng hợp theo kỳ', [
          el('div', { class: 'grid cols-4' }, [
            kpi('Tổng phiếu', num(summary.total)),
            kpi('Số kỳ đã khảo sát', num(summary.periods?.length ?? 0)),
          ]),
          el('h4', { text: 'Hiện trạng sản xuất' }),
          table([
            { key: 'label', label: 'Hiện trạng' },
            { key: 'n', label: 'Số phiếu', align: 'right', render: (row) => num(row.n) },
          ], summary.byStatus ?? [], { empty: 'Chưa có dữ liệu.' }),
          el('h4', { text: 'Theo xã/phường' }),
          table([
            { key: 'commune_name', label: 'Xã/Phường', render: (row) => row.commune_name ?? 'Không khai báo' },
            { key: 'n', label: 'Số phiếu', align: 'right', render: (row) => num(row.n) },
            { key: 'with_cycle_start', label: 'Đã khai ngày bắt đầu vụ', align: 'right', render: (row) => num(row.with_cycle_start) },
          ], summary.byCommune ?? [], { empty: 'Chưa có dữ liệu.' }),
        ]),

        card('Phiếu đã thu', table([
          { key: 'code', label: 'Phiếu' },
          { key: 'period', label: 'Kỳ' },
          { key: 'subject_kind', label: 'Đối tượng', render: (row) => (row.subject_kind === 'htx' ? 'HTX' : 'Hộ dân') },
          { key: 'subject_name', label: 'Tên' },
          {
            key: 'address', label: 'Địa bàn',
            render: (row) => [row.hamlet_name, row.commune_name, row.province_name].filter(Boolean).join(', ') || '—',
          },
          { key: 'cycle_start_date', label: 'Bắt đầu vụ', render: (row) => row.cycle_start_date ?? '—' },
          { key: 'production_status', label: 'Hiện trạng', render: (row) => row.production_status ?? '—' },
          { key: 'surveyed_at', label: 'Khảo sát lúc', render: (row) => dateTime(row.surveyed_at) },
        ], responses, { empty: 'Chưa có phiếu nào.' })),
      );
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Mẫu đã ban hành', num(templates.filter((t) => t.status === 'ban_hanh').length), null, 'good'),
        kpi('Bản nháp', num(templates.filter((t) => t.status === 'nhap').length)),
        kpi('Tổng phiếu đã thu', num(templates.reduce((acc, t) => acc + Number(t.response_count ?? 0), 0))),
      ]),

      can('khuyennong.write')
        ? card('Tạo mẫu khảo sát', form([
            { name: 'name', label: 'Tên mẫu', required: true },
            {
              name: 'frequency', label: 'Tần suất', type: 'select', required: true,
              options: meta.frequencies.map((f) => ({ value: f.code, label: `${f.label} — kỳ ghi dạng ${f.periodHint}` })),
            },
            {
              name: 'subjectScope', label: 'Đối tượng khảo sát', type: 'select',
              options: [
                { value: 'ca_hai', label: 'Cả hộ dân và HTX' },
                { value: 'ho_dan', label: 'Chỉ hộ dân' },
                { value: 'htx', label: 'Chỉ HTX' },
              ],
            },
            { name: 'purpose', label: 'Mục đích', type: 'textarea', rows: 2 },
          ], async (values) => {
            const created = await api('/survey/templates', { body: values });
            selectedId = created.id;
            toast('Đã tạo bản nháp — thêm câu hỏi rồi ban hành.');
            actions.replaceChildren();
            await this.render(view, actions);
          }, { submitLabel: '+ Tạo mẫu' }))
        : null,

      card('Danh mục mẫu khảo sát', table([
        { key: 'code', label: 'Mã' },
        { key: 'name', label: 'Tên mẫu' },
        { key: 'frequency', label: 'Tần suất', render: (row) => badge(FREQ_LABEL[row.frequency] ?? row.frequency, 'info') },
        { key: 'question_count', label: 'Câu hỏi', align: 'right', render: (row) => num(row.question_count) },
        { key: 'response_count', label: 'Phiếu', align: 'right', render: (row) => num(row.response_count) },
        {
          key: 'status', label: 'Trạng thái',
          render: (row) => badge(row.status === 'ban_hanh' ? 'Đã ban hành' : 'Nháp',
            row.status === 'ban_hanh' ? 'good' : 'neutral'),
        },
      ], templates, {
        empty: 'Chưa có mẫu khảo sát nào.',
        onRowClick: (row) => { selectedId = row.id; drawDetail(); },
        rowClass: (row) => (row.id === selectedId ? 'highlight' : null),
      })),

      detail,
    );

    await drawDetail();
  },
});

/** Biểu mẫu nhập một phiếu khảo sát, gồm thông tin cơ bản + địa chỉ lọc dần + câu hỏi. */
function responseForm(template, questions, meta, refresh) {
  const cascade = adminCascade();
  const answers = new Map();

  const questionFields = questions.map((question) => {
    const label = `${question.label}${question.uom ? ` (${question.uom})` : ''}${question.required ? ' *' : ''}`;
    let control;
    if (question.kind === 'select' || question.kind === 'boolean') {
      const options = question.kind === 'boolean' ? ['Có', 'Không'] : (question.optionList ?? []);
      control = el('select', {
        onchange: (event) => answers.set(question.id, event.target.value),
      }, [el('option', { value: '' }, ['— Chọn —']), ...options.map((o) => el('option', { value: o }, [o]))]);
    } else if (question.kind === 'multiselect') {
      control = el('select', {
        multiple: true, size: Math.min(4, (question.optionList ?? []).length || 3),
        onchange: (event) => answers.set(
          question.id, [...event.target.selectedOptions].map((o) => o.value).join('; '),
        ),
      }, (question.optionList ?? []).map((o) => el('option', { value: o }, [o])));
    } else {
      control = el('input', {
        type: question.kind === 'number' ? 'number' : question.kind === 'date' ? 'date' : 'text',
        step: question.kind === 'number' ? 'any' : undefined,
        oninput: (event) => answers.set(question.id, event.target.value),
      });
    }
    return el('label', {}, [label, control]);
  });

  const basic = el('div', { class: 'row' }, [
    el('label', {}, ['Đối tượng', el('select', { name: 'subjectKind' }, [
      ...(template.subject_scope !== 'htx' ? [el('option', { value: 'ho_dan' }, ['Hộ dân'])] : []),
      ...(template.subject_scope !== 'ho_dan' ? [el('option', { value: 'htx' }, ['Hợp tác xã'])] : []),
    ])]),
    el('label', {}, ['Kỳ khảo sát *', el('input', {
      name: 'period', required: true,
      placeholder: meta.frequencies.find((f) => f.code === template.frequency)?.periodHint,
    })]),
    el('label', {}, ['Tên hộ dân / HTX *', el('input', { name: 'subjectName', required: true })]),
    el('label', {}, ['Điện thoại', el('input', { name: 'phone' })]),
    el('label', {}, ['CCCD (hộ dân)', el('input', { name: 'nationalId' })]),
    el('label', {}, ['Mã số thuế (HTX)', el('input', { name: 'taxCode' })]),
  ]);

  const production = el('div', { class: 'row' }, [
    el('label', {}, ['Ngày bắt đầu chu kỳ sản xuất', el('input', { name: 'cycleStartDate', type: 'date' })]),
    el('label', {}, ['Hiện trạng sản xuất', el('select', { name: 'productionStatus' }, [
      el('option', { value: '' }, ['— Chọn —']),
      ...meta.productionStatuses.map((s) => el('option', { value: s.code }, [s.label])),
    ])]),
    el('label', {}, ['Địa chỉ chi tiết', el('input', { name: 'addressDetail', placeholder: 'Số nhà, tổ, tuyến kênh…' })]),
  ]);

  const errorBox = el('p', { class: 'login-error', hidden: true });

  const formEl = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      const data = new FormData(event.target);
      try {
        await api('/survey/responses', {
          body: {
            templateId: template.id,
            period: data.get('period'),
            subjectKind: data.get('subjectKind'),
            subjectName: data.get('subjectName'),
            phone: data.get('phone') || undefined,
            nationalId: data.get('nationalId') || undefined,
            taxCode: data.get('taxCode') || undefined,
            addressDetail: data.get('addressDetail') || undefined,
            cycleStartDate: data.get('cycleStartDate') || undefined,
            productionStatus: data.get('productionStatus') || undefined,
            ...cascade.value(),
            answers: [...answers.entries()]
              .filter(([, value]) => value !== '' && value !== null && value !== undefined)
              .map(([questionId, value]) => ({ questionId, value })),
          },
        });
        toast('Đã lưu phiếu khảo sát.');
        event.target.reset();
        answers.clear();
        await refresh();
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
      }
    },
  }, [
    basic,
    cascade.node,
    production,
    questionFields.length ? el('h4', { text: 'Nội dung khảo sát' }) : null,
    el('div', { class: 'row' }, questionFields),
    el('button', { type: 'submit', class: 'small', text: '💾 Lưu phiếu khảo sát' }),
  ]);

  return card('Nhập phiếu khảo sát', [
    el('p', { class: 'muted', text: 'Ba ô địa chỉ lọc dần: chọn tỉnh mới hiện xã của tỉnh đó, chọn xã mới hiện thôn/ấp của xã đó. Nhập lại cùng đối tượng trong cùng kỳ là cập nhật phiếu cũ, không tạo bản trùng.' }),
    formEl,
    errorBox,
  ]);
}

// ===========================================================================
// Vẽ thửa ruộng và gán cho HTX
// ===========================================================================

registerPage('kn-plots', {
  title: 'Vẽ thửa ruộng & gán cho HTX',
  subtitle: 'Cán bộ khuyến nông vẽ ranh giới thửa trên bản đồ; hệ thống tự tính diện tích rồi gán thửa cho HTX và hộ dân',
  async render(view, actions) {
    const cooperatives = await guard(api('/mdm/cooperatives'));
    let currentHtx = cooperatives[0]?.id ?? null;

    actions.append(el('label', { class: 'htx-picker' }, [
      el('span', { class: 'muted', text: 'HTX:' }),
      el('select', {
        onchange: (event) => { currentHtx = event.target.value; refresh(); },
      }, cooperatives.map((h) => el('option', { value: h.id }, [`${h.code} — ${h.name}`]))),
    ]));

    const body = el('div', { class: 'grid' });
    view.replaceChildren(body);

    async function refresh() {
      if (!currentHtx) return body.replaceChildren(alert('Chưa có hợp tác xã nào.', 'warn'));
      const [plots, farmers] = await Promise.all([
        guard(api(`/mdm/plots?htxId=${currentHtx}`)),
        api(`/mdm/farmers?htxId=${currentHtx}`).catch(() => []),
      ]);

      const mapNode = mapContainer('kn-plot-map', 'tall');
      const drawing = [];
      const counter = el('span', { class: 'muted', text: '0 điểm' });
      let map = null;
      let shapes = [];
      let editingPlotId = null;

      const redraw = () => {
        counter.textContent = editingPlotId
          ? `${drawing.length} điểm — đang vẽ lại thửa`
          : `${drawing.length} điểm`;
        if (!LEAFLET_AVAILABLE() || !map) return;
        shapes.forEach((shape) => map.removeLayer(shape));
        shapes = [];
        if (drawing.length >= 2) {
          shapes.push(window.L.polygon(drawing.map((p) => [p.lat, p.lng]),
            { color: '#C85A22', weight: 2, fillOpacity: 0.2 }).addTo(map));
        }
        drawing.forEach((point) => {
          shapes.push(window.L.circleMarker([point.lat, point.lng],
            { radius: 4, color: '#C85A22', fillOpacity: 1 }).addTo(map));
        });
      };

      const save = async () => {
        if (drawing.length < 3) return toast('Ranh giới thửa ruộng phải có tối thiểu 3 đỉnh.', true);
        if (editingPlotId) {
          const updated = await guard(api(`/mdm/plots/${editingPlotId}/boundary`, {
            method: 'PUT', body: { boundary: drawing },
          }));
          toast(`Đã cập nhật ${updated.code}: ${updated.areaLabel} (${updated.deltaHa >= 0 ? '+' : ''}${num(updated.deltaHa, 3)} ha).`);
          for (const warning of updated.warnings ?? []) toast(warning, true);
        } else {
          const created = await guard(api('/mdm/plots', {
            body: { htxId: currentHtx, boundary: drawing, source: 'app_khuyennong' },
          }));
          toast(`Đã tạo thửa ${created.code} — diện tích ${created.areaLabel} (hệ thống tự tính).`);
        }
        drawing.length = 0;
        editingPlotId = null;
        await refresh();
      };

      body.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Thửa của HTX', num(plots.length),
            `${num(plots.reduce((acc, p) => acc + p.area_ha, 0), 2)} ha`),
          kpi('Do Khuyến nông vẽ', num(plots.filter((p) => p.source === 'app_khuyennong').length),
            'Nguồn được ghi trên từng thửa'),
          kpi('Chưa gán chủ thửa', num(plots.filter((p) => !p.farmer_id).length), null,
            plots.filter((p) => !p.farmer_id).length ? 'warning' : 'good'),
        ]),

        el('div', { class: 'split' }, [
          card('Thửa ruộng của HTX', [
            table([
              { key: 'code', label: 'Mã thửa' },
              { key: 'area_ha', label: 'Diện tích (ha)', align: 'right', render: (row) => num(row.area_ha, 4) },
              {
                key: 'source', label: 'Nguồn',
                render: (row) => badge(row.source === 'app_khuyennong' ? 'Khuyến nông' : 'App HTX', 'neutral'),
              },
              { key: 'farmer_name', label: 'Chủ thửa', render: (row) => row.farmer_name ?? '—' },
              {
                key: 'act', label: '',
                render: (row) => (can('mdm.write')
                  ? el('span', { class: 'chip-row' }, [
                      el('button', {
                        class: 'ghost small', text: '✎ Vẽ lại',
                        onclick: () => {
                          editingPlotId = row.id;
                          drawing.length = 0;
                          redraw();
                          toast(`Đang vẽ lại ${row.code} — nhấp các đỉnh mới rồi bấm Lưu.`);
                        },
                      }),
                      el('button', {
                        class: 'ghost small', text: '👤 Gán chủ',
                        onclick: async () => {
                          if (!farmers.length) return toast('HTX chưa có thành viên nào để gán.', true);
                          const name = prompt(
                            `Gán thửa ${row.code} cho thành viên nào?\n\n` +
                            farmers.map((f, i) => `${i + 1}. ${f.full_name}`).join('\n'),
                          );
                          const index = Number(name) - 1;
                          if (!(index >= 0 && index < farmers.length)) return;
                          await guard(api(`/mdm/plots/${row.id}/assign`, {
                            method: 'PUT', body: { farmerId: farmers[index].id },
                          }));
                          toast(`Đã gán ${row.code} cho ${farmers[index].full_name}.`);
                          await refresh();
                        },
                      }),
                    ])
                  : '—'),
              },
            ], plots, { empty: 'HTX chưa có thửa nào — vẽ trên bản đồ để tạo.' }),

            can('mdm.write')
              ? el('div', {}, [
                  el('p', { class: 'muted', text: 'Nhấp ≥ 3 điểm theo viền thửa rồi bấm Lưu. Diện tích do hệ thống tính bằng công thức diện tích cầu — không nhập tay được.' }),
                  el('div', { class: 'chip-row' }, [
                    el('button', { class: 'small', text: '💾 Lưu thửa', onclick: save }),
                    el('button', { class: 'ghost small', text: '↶ Xoá điểm cuối', onclick: () => { drawing.pop(); redraw(); } }),
                    el('button', {
                      class: 'ghost small', text: '🗑 Xoá hết',
                      onclick: () => { drawing.length = 0; editingPlotId = null; redraw(); },
                    }),
                    counter,
                  ]),
                ])
              : null,
          ]),
          card('Bản đồ vẽ thửa', mapNode),
        ]),
      );

      if (LEAFLET_AVAILABLE()) {
        const htx = cooperatives.find((c) => c.id === currentHtx);
        map = createMap('kn-plot-map', [htx?.lat ?? 10.2, htx?.lng ?? 105.8], 12);
        map.on('click', (event) => {
          drawing.push({ lat: Number(event.latlng.lat.toFixed(6)), lng: Number(event.latlng.lng.toFixed(6)) });
          redraw();
        });
        for (const plot of plots) {
          if (!plot.boundaryGeo) continue;
          window.L.geoJSON(plot.boundaryGeo, { style: { color: '#3E7A3A', weight: 2, fillOpacity: 0.2 } })
            .bindTooltip(`${plot.code} — ${num(plot.area_ha, 4)} ha`).addTo(map);
        }
      }
      redraw();
    }

    await refresh();
  },
});

// ===========================================================================
// Hồ sơ HTX theo mã số thuế
// ===========================================================================

registerPage('kn-htx', {
  title: 'Hồ sơ hợp tác xã',
  subtitle: 'Khuyến nông khởi tạo hồ sơ HTX gắn mã số thuế; HTX kích hoạt tài khoản bằng MST để thừa hưởng dữ liệu dùng chung',
  async render(view, actions) {
    const [pending, cooperatives] = await Promise.all([
      guard(api('/htx-registry/pending')), api('/mdm/cooperatives'),
    ]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Hồ sơ chờ HTX kích hoạt', num(pending.length),
          'Khuyến nông đã lập, HTX chưa nhận', pending.length ? 'warning' : 'good'),
        kpi('Tổng HTX trên hệ thống', num(cooperatives.length)),
        kpi('Đã có mã số thuế', num(cooperatives.filter((c) => c.tax_code).length),
          'MST là cầu nối duy nhất giữa hai bên'),
      ]),

      can('khuyennong.write')
        ? card('Khởi tạo hồ sơ HTX', [
            el('p', { class: 'muted', text: 'Hồ sơ lập ra nằm ngay trên cơ sở dữ liệu dùng chung: vẽ thửa, ghi nhận thành viên, khảo sát được luôn. Khi HTX kích hoạt tài khoản bằng đúng mã số thuế này, toàn bộ dữ liệu thuộc về họ.' }),
            form([
              { name: 'taxCode', label: 'Mã số thuế (10 hoặc 13 chữ số)', required: true, placeholder: '1600123456' },
              { name: 'name', label: 'Tên hợp tác xã', required: true },
              { name: 'contactName', label: 'Người đại diện' },
              { name: 'contactPhone', label: 'Điện thoại' },
              { name: 'address', label: 'Địa chỉ' },
              { name: 'lat', label: 'Vĩ độ', type: 'number', step: 'any' },
              { name: 'lng', label: 'Kinh độ', type: 'number', step: 'any' },
              { name: 'memberCount', label: 'Số thành viên', type: 'number', min: '0' },
              {
                name: 'operatingModel', label: 'Mô hình vận hành dự kiến', type: 'select',
                options: [
                  { value: 'tap_trung', label: 'Ban quản trị phân công' },
                  { value: 'thanh_vien_chu_dong', label: 'Thành viên chủ động' },
                ],
              },
            ], async (values) => {
              const created = await api('/htx-registry/register', { body: values });
              toast(`Đã tạo hồ sơ ${created.code} — MST ${created.tax_code}. HTX kích hoạt bằng MST này.`);
              await refresh();
            }, { submitLabel: '+ Khởi tạo hồ sơ' }),
          ])
        : null,

      card('Hồ sơ chờ HTX kích hoạt', [
        el('p', { class: 'muted', text: 'Danh sách để cán bộ đôn đốc HTX đăng ký tài khoản. Dữ liệu đã lập vẫn dùng được ngay cho thống kê, chỉ chưa có tài khoản HTX nào sở hữu.' }),
        table([
          { key: 'code', label: 'Mã HTX' },
          { key: 'name', label: 'Tên' },
          { key: 'tax_code', label: 'Mã số thuế' },
          { key: 'commune_name', label: 'Địa bàn', render: (row) => row.commune_name ?? '—' },
          { key: 'contact_name', label: 'Người đại diện', render: (row) => row.contact_name ?? '—' },
          { key: 'contact_phone', label: 'Điện thoại', render: (row) => row.contact_phone ?? '—' },
          { key: 'plot_count', label: 'Thửa đã vẽ', align: 'right', render: (row) => num(row.plot_count) },
          { key: 'farmer_count', label: 'Thành viên', align: 'right', render: (row) => num(row.farmer_count) },
          { key: 'created_at', label: 'Lập lúc', render: (row) => dateTime(row.created_at) },
        ], pending, { empty: 'Không còn hồ sơ nào chờ kích hoạt.' }),
      ]),

      card('Toàn bộ hợp tác xã', table([
        { key: 'code', label: 'Mã' },
        { key: 'name', label: 'Tên' },
        { key: 'tax_code', label: 'MST', render: (row) => row.tax_code ?? badge('Chưa có', 'warn') },
        {
          key: 'origin', label: 'Nguồn hồ sơ',
          render: (row) => badge(row.origin === 'khuyennong' ? 'Khuyến nông lập' : 'HTX tự tạo', 'neutral'),
        },
        {
          key: 'claimed_at', label: 'Kích hoạt',
          render: (row) => (row.claimed_at ? badge(String(row.claimed_at).slice(0, 10), 'good') : badge('Chưa', 'neutral')),
        },
        { key: 'member_count', label: 'Thành viên', align: 'right', render: (row) => num(row.member_count) },
      ], cooperatives, { empty: 'Chưa có HTX nào.' })),
    );
  },
});
