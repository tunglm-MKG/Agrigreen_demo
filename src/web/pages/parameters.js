import {
  api, registerPage, el, card, kpi, table, badge, alert, num, dateTime, toast, guard, can,
} from '/app.js';

const CLASSIFICATION = {
  thi_truong: { label: 'Nguồn thị trường', tone: 'good' },
  gia_dinh: { label: 'Cần input giả định', tone: 'warn' },
  khac: { label: 'Khác', tone: 'neutral' },
};

registerPage('parameters', {
  title: 'Quản trị dữ liệu nền — 49 tham số mô phỏng (FN-01)',
  subtitle: 'Phân loại nguồn · phê duyệt giả định · quản lý phiên bản bộ tham số',
  async render(view, actions) {
    const writable = can('simulation.write');
    const canApprove = can('simulation.param_approve');

    const body = el('div', { class: 'grid' });
    view.replaceChildren(body);

    actions.append(el('button', {
      class: 'ghost small', text: '↻ Tải lại', onclick: () => refresh(),
    }));

    let filter = 'all';

    async function refresh() {
      const [data, sets] = await Promise.all([guard(api('/sim/parameters')), api('/sim/parameter-sets')]);
      const integrity = data.integrity;

      const summary = el('div', { class: 'grid cols-4' }, [
        kpi('Tổng số tham số', `${integrity.total}/49`,
          integrity.duplicateNumbers.length || integrity.missingNumbers.length
            ? 'Có STT trùng hoặc thiếu' : 'Không trùng, không thiếu STT',
          integrity.duplicateNumbers.length || integrity.missingNumbers.length ? 'critical' : 'good'),
        kpi('Nguồn thị trường', num(integrity.byClassification.thi_truong), 'Cần lưu nguồn + ngày cập nhật (BR-02)'),
        kpi('Cần input giả định', num(integrity.byClassification.gia_dinh), 'Cần người phê duyệt trước khi dùng chính thức'),
        kpi('Chưa phê duyệt', num(data.unapproved.length),
          data.unapproved.length ? 'Kịch bản chỉ ở trạng thái "Tham khảo"' : 'Đủ điều kiện đánh dấu "Chính thức"',
          data.unapproved.length ? 'warning' : 'good'),
      ]);

      const banner = data.unapproved.length
        ? alert(`FN-01 BR-04: còn ${data.unapproved.length} tham số giả định chưa có người phê duyệt — hệ thống CHẶN đánh dấu kịch bản là "Chính thức".`, 'warn')
        : alert('Toàn bộ tham số giả định đã được phê duyệt — kịch bản có thể chuyển sang trạng thái "Chính thức".', 'good');

      const filters = el('div', { class: 'chip-row' }, [
        ['all', 'Tất cả'],
        ['gia_dinh', 'Cần input giả định'],
        ['thi_truong', 'Nguồn thị trường'],
        ['unapproved', 'Chưa phê duyệt'],
        ['undefined', 'Chưa có giá trị'],
      ].map(([key, label]) => el('button', {
        class: `chip${filter === key ? ' active' : ''}`, text: label,
        onclick: () => { filter = key; refresh(); },
      })));

      const rows = data.parameters.filter((parameter) => {
        if (filter === 'all') return true;
        if (filter === 'unapproved') return parameter.classification === 'gia_dinh' && parameter.value_base !== null && !parameter.approved_by;
        if (filter === 'undefined') return parameter.value_base === null;
        return parameter.classification === filter;
      });

      const managed = new Map(data.catalogNotes.map((note) => [note.number, note.managedElsewhere]));

      const grid = table(
        [
          { key: 'number', label: '#', align: 'right' },
          { key: 'name', label: 'Tên tham số' },
          { key: 'unit', label: 'Đơn vị' },
          {
            key: 'classification', label: 'Phân loại',
            render: (row) => badge(CLASSIFICATION[row.classification].label, CLASSIFICATION[row.classification].tone),
          },
          {
            key: 'value_base', label: 'Giá trị', align: 'right',
            render: (row) => (managed.has(row.number)
              ? el('span', { class: 'muted', text: `→ ${managed.get(row.number)}` })
              : el('input', {
                  type: 'number', step: 'any', value: row.value_base ?? '', style: 'width:130px',
                  disabled: !writable, placeholder: 'chưa chốt',
                  onchange: async (event) => {
                    const value = event.target.value === '' ? null : Number(event.target.value);
                    try {
                      await api(`/sim/parameters/${row.code}`, { method: 'PUT', body: { valueBase: value } });
                      toast(`Đã cập nhật #${row.number}. Bộ tham số tăng lên phiên bản mới (BR-03).`);
                      refresh();
                    } catch (error) {
                      toast(error.message, true);
                      event.target.value = row.value_base ?? '';
                    }
                  },
                })),
          },
          {
            key: 'value_min', label: 'Min', align: 'right',
            render: (row) => (row.classification === 'khac' ? '—' : el('input', {
              type: 'number', step: 'any', value: row.value_min ?? '', style: 'width:100px', disabled: !writable,
              onchange: (event) => saveRange(row.code, { valueMin: event.target.value === '' ? null : Number(event.target.value) }),
            })),
          },
          {
            key: 'value_max', label: 'Max', align: 'right',
            render: (row) => (row.classification === 'khac' ? '—' : el('input', {
              type: 'number', step: 'any', value: row.value_max ?? '', style: 'width:100px', disabled: !writable,
              onchange: (event) => saveRange(row.code, { valueMax: event.target.value === '' ? null : Number(event.target.value) }),
            })),
          },
          {
            key: 'source', label: 'Nguồn / Phê duyệt',
            render: (row) => {
              if (row.classification === 'gia_dinh') {
                if (row.value_base === null) return badge('Chưa chốt giá trị', 'bad');
                return row.approved_by
                  ? badge(`✓ ${row.approved_by} · ${dateTime(row.approved_at).slice(0, 10)}`, 'good')
                  : (canApprove
                      ? el('button', {
                          class: 'ghost small', text: 'Phê duyệt',
                          onclick: async () => {
                            await guard(api(`/sim/parameters/${row.code}/approve`, { body: {} }));
                            toast(`Đã phê duyệt tham số #${row.number}.`);
                            refresh();
                          },
                        })
                      : badge('Chưa phê duyệt', 'warn'));
              }
              return el('span', { class: 'muted', text: row.data_source ?? '—' });
            },
          },
          { key: 'note', label: 'Ghi chú', render: (row) => el('span', { class: 'muted', text: row.note ?? '' }) },
        ],
        rows,
      );

      const setsCard = card('Phiên bản bộ tham số (FN-01 BR-03)', [
        el('p', { class: 'muted', text: 'Mỗi lần lưu thay đổi dữ liệu nền tạo một phiên bản mới. Kịch bản đã lưu giữ nguyên phiên bản tại thời điểm mô phỏng, nên kết quả cũ không bị thay đổi khi cập nhật tham số.' }),
        table(
          [
            { key: 'version', label: 'Phiên bản', align: 'right', render: (row) => `v${row.version}` },
            { key: 'created_at', label: 'Thời điểm', render: (row) => dateTime(row.created_at) },
            { key: 'created_by', label: 'Người thực hiện' },
            { key: 'note', label: 'Nội dung thay đổi' },
            { key: 'checksum', label: 'Checksum', render: (row) => el('code', { text: row.checksum.slice(0, 12) }) },
          ],
          sets.slice(0, 25),
        ),
      ], writable ? el('button', {
        class: 'ghost small', text: '+ Chốt phiên bản',
        onclick: async () => {
          const note = prompt('Ghi chú cho phiên bản bộ tham số:') ?? 'Chốt thủ công';
          await guard(api('/sim/parameter-sets', { body: { note } }));
          refresh();
        },
      }) : null);

      body.replaceChildren(summary, banner, card('Bộ 49 tham số đầu vào', [filters, grid]), setsCard);
    }

    async function saveRange(code, patch) {
      try {
        await api(`/sim/parameters/${code}`, { method: 'PUT', body: patch });
        toast('Đã lưu khoảng min/max — dùng cho phân tích độ nhạy (FN-18).');
      } catch (error) {
        toast(error.message, true);
      }
    }

    await refresh();
  },
});
