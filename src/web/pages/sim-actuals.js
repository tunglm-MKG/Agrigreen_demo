/**
 * GIẢ ĐỊNH – THỰC TẾ — tham số mô phỏng đặt cạnh số thật từ vận hành.
 *
 * Mỗi dòng: giả định đang duyệt · thực tế trong kỳ · cỡ mẫu · độ lệch · cơ sở tính.
 * "Đề xuất giá trị mới" ghi số thật vào tham số qua đúng luồng phê duyệt sẵn có —
 * Tài chính duyệt lại, hệ thống không tự đổi giả định.
 */
import { api, registerPage, el, card, kpi, table, badge, alert, num, dateTime, toast, guard, can } from '/app.js';

const FIT_TONE = { khop: 'good', lech_nhe: 'warn', lech_lon: 'bad', chua_du_du_lieu: 'neutral', chua_co_gia_dinh: 'neutral' };
const CLASSIFICATION = { thi_truong: 'Nguồn thị trường', gia_dinh: 'Cần input giả định', khac: 'Khác' };

let selectedDays = 90;
let expandedCode = null;

registerPage('sim-actuals', {
  title: 'Giả định – thực tế',
  subtitle: 'Số thật từ ghe đã cân, chuyến đã chạy, ruộng đã cuộn — đặt cạnh tham số mô phỏng đang dùng',
  async render(view, actions) {
    const data = await guard(api(`/sim/actuals?days=${selectedDays}`));
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const writable = can('simulation.write');
    const s = data.summary;

    actions.append(el('div', { class: 'chip-row' }, [30, 90, 180, 365].map((days) => el('button', {
      class: `chip${selectedDays === days ? ' active' : ''}`, text: `${days} ngày`,
      onclick: async () => { selectedDays = days; await refresh(); },
    }))));

    const fmt = (value, unit) => (value === null || value === undefined ? '—' : `${num(value, Number.isInteger(value) ? 0 : (Math.abs(value) < 10 ? 2 : 1))}${unit ? ` ${unit}` : ''}`);
    const deviation = (row) => {
      if (row.deviationPct === null) return badge(row.fitLabel, FIT_TONE[row.fit]);
      return el('span', { class: 'chip-row' }, [
        badge(`${row.deviationPct > 0 ? '+' : ''}${num(row.deviationPct, 1)}%`, FIT_TONE[row.fit]),
        row.withinRange === false ? badge('ngoài khoảng min–max', 'bad') : null,
      ]);
    };

    const detail = (row) => el('div', { class: 'grid', style: 'padding:8px 12px 14px; gap:6px' }, [
      el('div', { class: 'muted', text: `Cơ sở tính: ${row.basis}` }),
      el('div', { class: 'muted', text: `Nguồn: ${row.source} · ${row.sampleLabel} (cần ≥ ${row.minSamples})` }),
      row.valueMin !== null ? el('div', { class: 'muted', text: `Khoảng cho phép của tham số: ${fmt(row.valueMin)} – ${fmt(row.valueMax)}` }) : null,
      row.approvedBy ? el('div', { class: 'muted', text: `Giả định hiện tại do ${row.approvedBy} phê duyệt ${dateTime(row.approvedAt)}` }) : el('div', { class: 'muted', text: 'Giả định hiện tại CHƯA được phê duyệt' }),
      writable && row.suggested !== null && row.fit !== 'khop'
        ? el('div', {}, [el('button', { class: 'small', text: `↗ Đề xuất giá trị mới ${fmt(row.suggested, row.unit)}`, onclick: async () => {
            if (!window.confirm(`Đổi giả định "${row.name}" từ ${fmt(row.assumed)} sang ${fmt(row.suggested)} ${row.unit ?? ''}?\n\nPhê duyệt cũ sẽ mất hiệu lực; Tài chính phải duyệt lại và kịch bản chỉ còn "Tham khảo" tới lúc đó.`)) return;
            const result = await guard(api(`/sim/actuals/${row.code}/propose`, { body: { days: selectedDays } }));
            toast(`Đã ghi ${fmt(result.parameter.value_base, row.unit)} vào tham số #${row.number} — chờ Tài chính duyệt.`);
            await refresh();
          } })])
        : row.fit === 'khop' ? el('div', { class: 'muted', text: 'Trong ngưỡng khớp — không cần đổi.' }) : null,
    ]);

    const rows = [];
    for (const row of data.items) {
      rows.push(row);
      if (expandedCode === row.code) rows.push({ __detail: row });
    }

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Tham số đo được', `${num(s.withData)}/${num(s.compared)}`, `${num(s.notComparable)} tham số khác chưa có cách đo thực tế`),
        kpi('Khớp (≤ 5 %)', num(s.matching), 'Giả định đứng vững', s.matching ? 'good' : undefined),
        kpi('Lệch nhẹ (5–15 %)', num(s.minor), 'Nên xem lại ở kỳ duyệt tới', s.minor ? 'warning' : undefined),
        kpi('Lệch lớn (> 15 %)', num(s.major), s.outOfRange ? `${s.outOfRange} ngoài khoảng min–max` : 'Đề xuất giá trị mới ngay', s.major ? 'critical' : 'good'),
      ]),
      alert(`Kỳ đối chiếu ${data.from} → ${data.to}. Số thực tế chỉ tính từ dữ liệu ĐÃ XÁC NHẬN: ghe đã cân, chuyến đã hoàn thành, việc đã gặt thật. Chưa đủ mẫu thì ghi "chưa đủ dữ liệu", không đưa ra một con số từ hai quan sát.`, 'info'),
      card('Đối chiếu từng tham số', [
        el('p', { class: 'muted', text: 'Bấm một dòng để xem cơ sở tính và đề xuất giá trị mới. Đề xuất đi qua đúng luồng phê duyệt FN-01: phê duyệt cũ mất hiệu lực, một phiên bản bộ tham số mới được sinh.' }),
        table([
          { key: 'number', label: '#', align: 'right', render: (row) => (row.__detail ? '' : `#${row.number}`) },
          { key: 'name', label: 'Tham số', render: (row) => (row.__detail ? detail(row.__detail) : el('div', {}, [el('strong', { text: row.name }), el('div', { class: 'muted', text: `${CLASSIFICATION[row.classification] ?? row.classification}${row.unit ? ` · ${row.unit}` : ''}` })])) },
          { key: 'assumed', label: 'Giả định', align: 'right', render: (row) => (row.__detail ? '' : el('span', {}, [fmt(row.assumed), row.approvedBy ? null : badge('chưa duyệt', 'warn')])) },
          { key: 'actual', label: `Thực tế ${selectedDays} ngày`, align: 'right', render: (row) => (row.__detail ? '' : el('strong', { text: fmt(row.actual) })) },
          { key: 'samples', label: 'Mẫu', align: 'right', render: (row) => (row.__detail ? '' : badge(`${row.samples}/${row.minSamples}`, row.samples >= row.minSamples ? 'good' : 'neutral')) },
          { key: 'fit', label: 'Lệch', render: (row) => (row.__detail ? '' : deviation(row)) },
        ], rows, {
          onRowClick: (row) => { if (row.__detail) return; expandedCode = expandedCode === row.code ? null : row.code; refresh(); },
          rowClass: (row) => (row.__detail ? 'detail-row' : (row.code === expandedCode ? 'selected' : null)),
        }),
      ]),
    );
  },
});
