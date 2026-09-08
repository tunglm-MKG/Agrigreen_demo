/**
 * CỔNG HIỆN TRƯỜNG — đội thu gom rơm của Mekong Green.
 *
 *   field-dashboard  Bảng điều hành thời gian thực: đội ở đâu, cuộn/gom/xuống ghe
 *                    bao nhiêu, rơm nào đang nằm ruộng quá hạn, ghe nào đang chạy
 *   field-plan       Lịch gặt → kế hoạch thu gom: đồng bộ, phân công tự động / tay
 *   field-record     Ghi nhận tại ruộng (đội trưởng, điện thoại): bắt đầu / chốt
 *                    từng công đoạn, ghi lượt xuống ghe → sinh chuyến TMS
 *   field-teams      Đội, thành viên, phương tiện
 *   field-report     Năng suất đội, thời gian công đoạn, sử dụng máy
 *
 * Nguyên tắc: màn hình đội trưởng phải dùng được bằng một tay trên ruộng —
 * nút to, ít chữ, GPS tự lấy; màn hình quản lý mới nhiều bảng.
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num, dateTime,
  toast, guard, can, form, state, createMap, mapContainer, LEAFLET_AVAILABLE,
} from '/app.js';

const STATUS_TONE = { cho_phan_cong: 'warn', da_phan_cong: 'info', dang_thuc_hien: 'good', hoan_thanh: 'neutral', huy: 'bad' };
const STAGE_TONE = { cho_thuc_hien: 'neutral', dang_thuc_hien: 'info', hoan_thanh: 'good' };
const STAGE_LABEL = { cho_thuc_hien: 'Chưa làm', dang_thuc_hien: 'Đang làm', hoan_thanh: 'Xong' };
const TEAM_STATE = { dang_lam: ['Đang làm', 'good'], cho_bat_dau: ['Có việc, chưa bắt đầu', 'info'], ranh: ['Rảnh', 'neutral'] };
const VEHICLE_STATUS = { san_sang: ['Sẵn sàng', 'good'], dang_dung: ['Đang dùng', 'info'], bao_duong: ['Bảo dưỡng', 'warn'], hong: ['Hỏng', 'bad'] };
const TEAM_STATUS = { hoat_dong: ['Hoạt động', 'good'], tam_nghi: ['Tạm nghỉ', 'warn'], giai_the: ['Giải thể', 'bad'] };

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date, days) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const shortDate = (value) => (value ? `${value.slice(8, 10)}/${value.slice(5, 7)}` : '—');
const tons = (value) => (value === null || value === undefined ? '—' : `${num(value, 1)} t`);

// Lựa chọn giữ qua các lần vẽ lại — mỗi thao tác đều vẽ lại cả trang.
let selectedJobId = null;
let selectedTeamId = null;
let recordTeamId = null;

/** Vị trí GPS của điện thoại; không lấy được thì trả null, không chặn thao tác. */
function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: 3500 },
    );
  });
}

function statusBadge(job) {
  return badge(job.statusLabel ?? job.status, STATUS_TONE[job.status] ?? 'neutral');
}

/** Ba ô công đoạn thu gọn: ●○○ kèm số tấn. */
function stageStrip(job) {
  return el('span', { class: 'chip-row' }, (job.stages ?? []).map((stage) =>
    badge(`${stage.label ?? stage.stage} ${stage.bales ? `${num(stage.bales)} cuộn` : (stage.quantity_tons !== null && stage.quantity_tons !== undefined ? num(stage.quantity_tons, 0) + 't' : '')}`.trim(),
      STAGE_TONE[stage.status] ?? 'neutral')));
}

function riskBadge(job) {
  return job.overdue ? badge(`⚠ ${job.daysOnField} ngày trên ruộng`, 'bad') : null;
}

function varianceBadge(pct) {
  if (pct === null || pct === undefined) return null;
  const abs = Math.abs(pct);
  return badge(`${pct > 0 ? '+' : ''}${num(pct, 1)}%`, abs > 15 ? 'bad' : abs > 5 ? 'warn' : 'good');
}

/** Đọc tệp ảnh thành data URI để gửi JSON — máy chủ đọc EXIF từ bản gốc. */
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Không đọc được tệp'));
  reader.readAsDataURL(file);
});

/**
 * Khối bằng chứng ảnh của một đối tượng: ảnh đã tải (viền xanh = đúng chỗ, đúng
 * lúc, có EXIF; viền vàng = có cờ) và nút chụp/tải thêm. Ảnh gửi nguyên bản để máy
 * chủ đọc được toạ độ và giờ chụp trong ảnh.
 */
function evidenceBlock(entityType, entityId, canUpload) {
  const list = el('div', { class: 'evidence-list' });
  const box = el('div', { class: 'evidence' }, [list]);
  const render = async () => {
    const items = await api(`/files?entityType=${entityType}&entityId=${entityId}`).catch(() => []);
    list.replaceChildren(...items.map((item) => el('a', { class: `evidence-item ${item.trusted ? 'trusted' : 'flagged'}`, href: item.url, target: '_blank', title: item.flagLabels.join('; ') || 'Bằng chứng tin được' }, [
      item.mime.startsWith('image/') ? el('img', { src: item.url, alt: item.fileName, loading: 'lazy' }) : el('div', { class: 'meta', text: item.fileName }),
      el('div', { class: 'meta' }, [
        el('div', { text: item.trusted ? '✓ đúng chỗ, đúng lúc' : `⚠ ${item.flags.length} cờ` }),
        el('div', { text: item.takenAt ? item.takenAt.slice(0, 16).replace('T', ' ') : 'không có giờ chụp' }),
        item.distanceM !== null && item.distanceM !== undefined ? el('div', { text: `cách ${num(item.distanceM)} m` }) : null,
      ]),
    ])));
    if (!items.length && !canUpload) list.replaceChildren(el('span', { class: 'muted', text: 'Chưa có ảnh bằng chứng' }));
  };
  if (canUpload) {
    const input = el('input', { type: 'file', accept: 'image/*,application/pdf', capture: 'environment', multiple: true });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      if (!files.length) return;
      const pos = await currentPosition();
      let flagged = 0;
      for (const file of files) {
        try {
          const saved = await api('/files', { body: {
            entityType, entityId, fileName: file.name, mime: file.type || 'image/jpeg', data: await readAsDataUrl(file),
            deviceLat: pos?.lat, deviceLng: pos?.lng,
          } });
          if (!saved.trusted) flagged += 1;
        } catch (error) { toast(`${file.name}: ${error.message}`, true); }
      }
      input.value = '';
      toast(flagged ? `Đã lưu ${files.length} ảnh — ${flagged} ảnh có cờ (xem chú thích khi rê chuột).` : `Đã lưu ${files.length} ảnh bằng chứng, đúng chỗ đúng lúc.`);
      await render();
    });
    box.append(el('label', { class: 'evidence-upload' }, ['📷 Chụp / tải ảnh bằng chứng', input]));
  }
  render();
  return box;
}

const JOB_COLUMNS = [
  { key: 'code', label: 'Mã' },
  { key: 'location_label', label: 'Vị trí' },
  { key: 'harvest_date', label: 'Ngày gặt', render: (row) => el('span', {}, [shortDate(row.harvest_date), row.harvest_confirmed ? badge('đã gặt', 'good') : badge('dự kiến', 'neutral')]) },
  { key: 'expected_straw_tons', label: 'Rơm (t)', align: 'right', render: (row) => num(row.expected_straw_tons, 0) },
  { key: 'team_name', label: 'Đội', render: (row) => row.team_name ?? el('span', { class: 'muted', text: 'chưa phân công' }) },
  { key: 'planned_date', label: 'Kế hoạch', render: (row) => shortDate(row.planned_date) },
  { key: 'status', label: 'Trạng thái', render: (row) => el('span', { class: 'chip-row' }, [statusBadge(row), riskBadge(row)]) },
  { key: 'stages', label: 'Công đoạn', render: stageStrip },
];

// ===========================================================================
// Bảng điều hành
// ===========================================================================

registerPage('field-dashboard', {
  title: 'Điều hành thu gom rơm',
  subtitle: 'Thời gian thực: đội ở đâu, cuộn – gom – xuống ghe bao nhiêu, rơm nào đang nằm ruộng quá hạn',
  async render(view) {
    const data = await guard(api('/field/dashboard'));
    const k = data.kpis;
    const mapNode = mapContainer('field-map-canvas');

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Việc đang mở', num(k.activeJobs), `${num(k.running)} đang làm · ${num(k.unassigned)} chưa phân công`, k.unassigned ? 'warning' : undefined),
        kpi('Rơm đang nằm ruộng', `${num(k.strawOnField)} t`, 'Đã gặt, chưa cuộn xong'),
        kpi('Quá hạn cuộn (FM-02)', num(k.overdueJobs), `${num(k.overdueTons)} tấn có nguy cơ ẩm mục`, k.overdueJobs ? 'critical' : 'good'),
        kpi('Đội rảnh hôm nay', num(k.teamsIdle), `trên ${data.teams.length} đội hoạt động`, k.teamsIdle && k.unassigned ? 'warning' : undefined),
        kpi('Cuộn hôm nay', `${num(k.baledBalesToday)} cuộn`, `ước ${num(k.baledTonsToday, 1)} t · công đoạn 1 đã chốt`),
        kpi('Gom hôm nay', `${num(k.gatheredBalesToday)} cuộn`, `ước ${num(k.gatheredTonsToday, 1)} t · công đoạn 2 đã chốt`),
        kpi('Xuống ghe hôm nay', `${num(k.loadedBalesToday)} cuộn`, `${num(k.loadingsToday)} lượt · ${num(k.tripsCreatedToday)} chuyến TMS · ước ${num(k.loadedTonsToday, 1)} t`),
        kpi('Ghe chưa cân', num(k.unweighedLoadings), `ước ${num(k.unweighedTons)} t đang trên đường · ${num(k.weighedToday)} ghe cân hôm nay`, k.unweighedLoadings ? 'warning' : 'good'),
      ]),

      k.overdueJobs
        ? alert(`${k.overdueJobs} việc có rơm nằm ruộng quá ${data.overdue[0]?.daysOnField ?? 3} ngày chưa cuộn xong. ` +
            'Mỗi ngày trễ là độ ẩm tăng và giá bán giảm — xử lý trước mọi việc khác.', 'warn')
        : null,
      k.unassigned && k.teamsIdle
        ? alert(`${k.unassigned} việc chưa có đội trong khi ${k.teamsIdle} đội đang rảnh — vào "Kế hoạch thu gom" bấm phân công tự động.`, 'info')
        : null,

      el('div', { class: 'grid cols-2' }, [
        card('Bản đồ hiện trường', [
          el('p', { class: 'muted', text: 'Chấm tròn = việc thu gom (màu theo trạng thái, viền đỏ = quá hạn). Hình vuông = điểm đóng quân của đội.' }),
          mapNode,
        ]),
        card('Đội hôm nay', table([
          { key: 'name', label: 'Đội' },
          { key: 'state', label: 'Trạng thái', render: (row) => badge(...(TEAM_STATE[row.state] ?? [row.state, 'neutral'])) },
          { key: 'jobsToday', label: 'Việc', align: 'right' },
          { key: 'loadTons', label: 'Tải / năng lực', align: 'right', render: (row) => `${num(row.loadTons)} / ${num(row.capacityTons)} t` },
          { key: 'utilisationPct', label: 'Sử dụng', align: 'right', render: (row) => badge(`${row.utilisationPct}%`, row.utilisationPct > 100 ? 'bad' : row.utilisationPct > 80 ? 'warn' : 'good') },
          { key: 'vehiclesReady', label: 'Máy', render: (row) => `${row.vehiclesReady} sẵn sàng${row.vehiclesDown ? ` · ${row.vehiclesDown} hỏng/BD` : ''}` },
          { key: 'currentJobs', label: 'Đang ở', render: (row) => (row.currentJobs.length ? row.currentJobs.map((j) => j.location).join('; ') : '—') },
        ], data.teams)),
      ]),

      el('div', { class: 'grid cols-2' }, [
        card('Rơm quá hạn trên ruộng', table([
          { key: 'code', label: 'Mã' },
          { key: 'location_label', label: 'Vị trí' },
          { key: 'harvest_date', label: 'Gặt', render: (row) => shortDate(row.harvest_date) },
          { key: 'daysOnField', label: 'Ngày trên ruộng', align: 'right', render: (row) => badge(String(row.daysOnField), 'bad') },
          { key: 'expected_straw_tons', label: 'Tấn', align: 'right', render: (row) => num(row.expected_straw_tons, 0) },
          { key: 'team_name', label: 'Đội' },
          { key: 'note', label: 'Ghi chú' },
        ], data.overdue, { empty: 'Không có việc quá hạn — tốt.' })),
        card('Ghe / sà lan đang có hàng', table([
          { key: 'code', label: 'Chuyến' },
          { key: 'vehicle_code', label: 'Số hiệu' },
          { key: 'planned_tons', label: 'Tấn', align: 'right' },
          { key: 'to_label', label: 'Về' },
          { key: 'status', label: 'Trạng thái', render: (row) => badge(row.status === 'dang_chay' ? 'Đang chạy' : 'Chờ xuất bến', row.status === 'dang_chay' ? 'good' : 'info') },
        ], data.vesselsUnderway, { empty: 'Chưa có ghe nào đang chờ hoặc đang chạy' })),
      ]),

      card('Ghi nhận mới nhất từ hiện trường', table([
        { key: 'when', label: 'Lúc', render: (row) => dateTime(row.completed_at ?? row.started_at) },
        { key: 'team_name', label: 'Đội' },
        { key: 'job_code', label: 'Việc' },
        { key: 'location_label', label: 'Vị trí' },
        { key: 'label', label: 'Công đoạn', render: (row) => badge(row.label, row.completed_at ? 'good' : 'info') },
        { key: 'quantity_tons', label: 'Tấn', align: 'right', render: (row) => (row.completed_at ? num(row.quantity_tons, 1) : el('span', { class: 'muted', text: 'đang làm' })) },
        { key: 'recorded_by', label: 'Người ghi' },
      ], data.recent)),
    );

    if (!LEAFLET_AVAILABLE()) return;
    const map = createMap('field-map-canvas', [10.2, 105.5], 8);
    const colour = { cho_phan_cong: '#B0791C', da_phan_cong: '#2F6FB0', dang_thuc_hien: '#2F7D32', hoan_thanh: '#777' };
    for (const job of data.jobsForMap) {
      if (job.lat === null || job.lng === null) continue;
      window.L.circleMarker([job.lat, job.lng], {
        radius: Math.min(16, 6 + Math.sqrt(job.tons ?? 0) / 2),
        color: job.overdue ? '#B3261E' : colour[job.status] ?? '#777', weight: job.overdue ? 3 : 1.5,
        fillColor: colour[job.status] ?? '#777', fillOpacity: 0.65,
      }).bindPopup(`<strong>${job.code}</strong> · ${job.statusLabel}<br>${job.location}<br>${num(job.tons, 0)} tấn · ${job.team ?? 'chưa phân công'}` +
        (job.overdue ? '<br><span style="color:#B3261E">⚠ Quá hạn cuộn</span>' : '')).addTo(map);
    }
    for (const team of data.teams) {
      if (team.baseLat === null || team.baseLng === null) continue;
      window.L.marker([team.baseLat, team.baseLng], {
        icon: window.L.divIcon({ className: 'field-team-pin', html: `<div class="field-team-pin-box ${team.state}">${team.code.replace('DOI-0000', 'Đ')}</div>`, iconSize: [30, 20] }),
      }).bindPopup(`<strong>${team.name}</strong><br>${TEAM_STATE[team.state]?.[0] ?? team.state}<br>${team.loadTons}/${team.capacityTons} tấn hôm nay`).addTo(map);
    }
  },
});

// ===========================================================================
// Kế hoạch thu gom
// ===========================================================================

registerPage('field-plan', {
  title: 'Kế hoạch thu gom',
  subtitle: 'Lịch gặt từ App HTX và trạng thái mùa vụ → việc thu gom → phân công tự động hoặc tay',
  async render(view, actions) {
    const [calendar, lookups] = await Promise.all([guard(api('/field/calendar?days=14')), api('/field/lookups')]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const manage = can('field.manage');
    const jobs = calendar.jobs;
    const activeTeams = lookups.teams.filter((team) => team.status === 'hoat_dong');
    let lastAuto = null;

    if (manage) {
      actions.append(
        el('button', { class: 'small', text: '⟳ Đồng bộ lịch gặt', onclick: async () => {
          const result = await guard(api('/field/calendar/sync', { body: { fromDate: today(), days: 14 } }));
          toast(`Đã tạo ${result.created} việc mới từ lịch gặt 14 ngày.`);
          await refresh();
        } }),
        el('button', { class: 'small', text: '⚡ Phân công tự động', onclick: async () => {
          lastAuto = await guard(api('/field/auto-assign', { body: { fromDate: today(), days: 14 } }));
          toast(`Xếp ${lastAuto.assigned.length} việc · ép xếp ${lastAuto.forced.length} · còn trống ${lastAuto.unassigned.length}`);
          sessionStorage.setItem('field-last-auto', JSON.stringify(lastAuto));
          await refresh();
        } }),
      );
    }
    try { lastAuto = JSON.parse(sessionStorage.getItem('field-last-auto') ?? 'null'); } catch { lastAuto = null; }

    const detail = el('div', { class: 'grid' });
    const showJob = async (jobId) => {
      selectedJobId = jobId;
      const job = await guard(api(`/field/jobs/${jobId}`));
      detail.replaceChildren(card(`${job.code} — ${job.location_label}`, [
        el('div', { class: 'chip-row' }, [
          statusBadge(job), riskBadge(job),
          badge(`Gặt ${shortDate(job.harvest_date)}${job.harvest_confirmed ? ' (đã gặt)' : ' (dự kiến)'}`, 'neutral'),
          badge(`${num(job.expected_straw_tons, 0)} tấn rơm`, 'info'),
          job.area_ha ? badge(`${num(job.area_ha, 1)} ha`, 'neutral') : null,
          job.destination_name ? badge(`→ ${job.destination_name}`, 'neutral') : badge('Chưa có Hub nhận', 'warn'),
        ]),
        job.note ? el('p', { class: 'muted', text: job.note }) : null,
        el('h4', { text: 'Kế hoạch công đoạn' }),
        table([
          { key: 'label', label: 'Công đoạn' },
          { key: 'planned', label: 'Kế hoạch', render: (row) => (row.planned_start ? `${shortDate(row.planned_start)} → ${shortDate(row.planned_end)}` : '—') },
          { key: 'status', label: 'Thực tế', render: (row) => badge(STAGE_LABEL[row.status] ?? row.status, STAGE_TONE[row.status]) },
          { key: 'started_at', label: 'Bắt đầu', render: (row) => (row.started_at ? dateTime(row.started_at) : '—') },
          { key: 'completed_at', label: 'Xong', render: (row) => (row.completed_at ? dateTime(row.completed_at) : '—') },
          { key: 'quantity_tons', label: 'Tấn', align: 'right', render: (row) => tons(row.quantity_tons) },
        ], job.stages),
        job.loadings.length
          ? table([
              { key: 'loaded_at', label: 'Lúc', render: (row) => dateTime(row.loaded_at) },
              { key: 'vessel_code', label: 'Ghe / sà lan' },
              { key: 'bales', label: 'Cuộn', align: 'right', render: (row) => (row.bales ? num(row.bales) : '—') },
              { key: 'tons', label: 'Ước (t)', align: 'right', render: (row) => num(row.tons, 1) },
              { key: 'weighed_kg', label: 'Cân (t)', align: 'right', render: (row) => (row.weighed_kg ? el('span', {}, [num(row.weighed_kg / 1000, 1), ' ', varianceBadge(row.variance_pct)]) : badge('chưa cân', 'warn')) },
              { key: 'destination_name', label: 'Về' },
              { key: 'trip_code', label: 'Chuyến TMS', render: (row) => (row.trip_code ? badge(row.trip_code, 'info') : badge('không tạo được', 'warn')) },
            ], job.loadings)
          : null,
        manage && ['cho_phan_cong', 'da_phan_cong'].includes(job.status)
          ? el('div', { class: 'grid cols-2' }, [
              el('div', {}, [
                el('strong', { text: job.team_id ? 'Đổi đội / ngày' : 'Phân công' }),
                form([
                  { name: 'teamId', label: 'Đội', type: 'select', required: true,
                    options: activeTeams.map((team) => ({ value: team.id, label: team.name, selected: team.id === job.team_id })) },
                  { name: 'plannedDate', label: 'Ngày bắt đầu cuộn', type: 'date', value: job.planned_date ?? (job.harvest_date < today() ? today() : job.harvest_date), required: true },
                  { name: 'note', label: 'Ghi chú' },
                ], async (values) => {
                  const result = await api(`/field/jobs/${jobId}/assign`, { body: { ...values, mode: 'manual' } });
                  toast(result.warnings.length ? `Đã phân công — ${result.warnings.length} cảnh báo` : 'Đã phân công.', result.warnings.length > 0);
                  if (result.warnings.length) window.alert(result.warnings.join('\n\n'));
                  await refresh();
                }, { submitLabel: 'Phân công', resetOnSuccess: false }),
              ]),
              el('div', { class: 'chip-row', style: 'align-items:flex-end' }, [
                job.status === 'da_phan_cong'
                  ? el('button', { class: 'small', text: 'Rút phân công', onclick: async () => {
                      await guard(api(`/field/jobs/${jobId}/unassign`, { body: {} })); toast('Đã rút phân công.'); await refresh();
                    } })
                  : null,
                el('button', { class: 'small', text: 'Huỷ việc', onclick: async () => {
                  const reason = window.prompt('Lý do huỷ việc thu gom này?');
                  if (!reason) return;
                  await guard(api(`/field/jobs/${jobId}/cancel`, { body: { reason } })); toast('Đã huỷ.'); await refresh();
                } }),
              ]),
            ])
          : null,
      ]));
    };

    const utilCell = (entry) => el('span', { class: 'chip-row' }, [
      badge(`${entry.loadTons}/${entry.capacityTons}`, entry.utilisationPct > 100 ? 'bad' : entry.utilisationPct > 80 ? 'warn' : entry.utilisationPct > 0 ? 'good' : 'neutral'),
    ]);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Việc 14 ngày tới', num(jobs.length), `${num(jobs.reduce((s, j) => s + Number(j.expected_straw_tons), 0))} tấn rơm`),
        kpi('Chưa phân công', num(jobs.filter((j) => j.status === 'cho_phan_cong').length), 'Cần xếp đội', jobs.some((j) => j.status === 'cho_phan_cong') ? 'warning' : 'good'),
        kpi('Năng lực đội / ngày', `${num(calendar.days[0]?.teams.reduce((s, t) => s + t.capacityTons, 0) ?? 0)} t`, `${activeTeams.length} đội hoạt động`),
        kpi('Ngưỡng FM-02', `${lookups.maxDaysAfterHarvest} ngày`, 'Rơm phải cuộn xong sau gặt'),
      ]),

      lastAuto
        ? card('Kết quả phân công tự động gần nhất', [
            el('div', { class: 'chip-row' }, [
              badge(`${lastAuto.created} việc mới từ lịch gặt`, 'neutral'),
              badge(`${lastAuto.assigned.length} xếp vừa năng lực`, 'good'),
              badge(`${lastAuto.forced.length} ép xếp — vượt năng lực`, lastAuto.forced.length ? 'warn' : 'neutral'),
              badge(`${lastAuto.unassigned.length} còn trống`, lastAuto.unassigned.length ? 'bad' : 'neutral'),
            ]),
            lastAuto.forced.length
              ? alert('Việc "ép xếp" đã có đội nhưng đội đó không đủ máy để cuộn xong trong hạn. Điều máy dự phòng, thuê thêm hoặc chia việc — hệ thống không tự quyết thay.', 'warn')
              : null,
            lastAuto.forced.length
              ? table([
                  { key: 'code', label: 'Mã' }, { key: 'location', label: 'Vị trí' }, { key: 'team', label: 'Đội' },
                  { key: 'plannedDate', label: 'Bắt đầu', render: (row) => shortDate(row.plannedDate) },
                  { key: 'tons', label: 'Tấn', align: 'right' },
                  { key: 'warnings', label: 'Cảnh báo', render: (row) => el('span', { class: 'muted', text: row.warnings.join(' · ') }) },
                ], lastAuto.forced)
              : null,
          ])
        : null,

      card('Lịch gặt 14 ngày — tải từng đội (tấn đã xếp / năng lực)', table([
        { key: 'date', label: 'Ngày', render: (row) => el('strong', { text: shortDate(row.date) }) },
        { key: 'expectedTons', label: 'Rơm dự kiến', align: 'right', render: (row) => (row.expectedTons ? `${num(row.expectedTons)} t` : '—') },
        { key: 'jobs', label: 'Việc', align: 'right', render: (row) => (row.jobs ? el('span', {}, [String(row.jobs), row.unassigned ? badge(`${row.unassigned} trống`, 'warn') : null]) : '—') },
        ...(calendar.days[0]?.teams ?? []).map((team, index) => ({
          key: `team-${index}`, label: team.name.replace(/^Đội (\d+) — .*/, 'Đội $1'),
          render: (row) => utilCell(row.teams[index]),
        })),
      ], calendar.days)),

      card('Việc thu gom', [
        el('p', { class: 'muted', text: 'Bấm một dòng để xem kế hoạch công đoạn và phân công.' }),
        table(JOB_COLUMNS, jobs, { onRowClick: (row) => showJob(row.id), rowClass: (row) => (row.id === selectedJobId ? 'selected' : null) }),
      ]),
      detail,

      manage
        ? card('Thêm việc thủ công', [
            el('p', { class: 'muted', text: 'Dùng khi HTX báo gặt qua điện thoại mà chưa có trên App HTX. Vị trí lấy theo toạ độ HTX; Hub nhận chọn tự động theo khoảng cách.' }),
            form([
              { name: 'htxId', label: 'Hợp tác xã', type: 'select', required: true, options: lookups.cooperatives.map((c) => ({ value: c.id, label: c.name })) },
              { name: 'locationLabel', label: 'Mô tả vị trí (cánh đồng, ấp)' },
              { name: 'harvestDate', label: 'Ngày gặt', type: 'date', required: true, value: today() },
              { name: 'expectedStrawTons', label: 'Rơm dự kiến (tấn)', type: 'number', step: '1', required: true },
              { name: 'areaHa', label: 'Diện tích (ha)', type: 'number', step: '0.1' },
            ], async (values) => {
              await api('/field/jobs', { body: { ...values, sourceType: 'manual', harvestConfirmed: values.harvestDate <= today() } });
              toast('Đã tạo việc thu gom.');
              await refresh();
            }, { submitLabel: '+ Tạo việc' }),
          ])
        : null,
    );
    if (selectedJobId && jobs.some((job) => job.id === selectedJobId)) await showJob(selectedJobId);
  },
});

// ===========================================================================
// Ghi nhận tại ruộng — màn hình đội trưởng
// ===========================================================================

registerPage('field-record', {
  title: 'Ghi nhận tại ruộng',
  subtitle: 'Bắt đầu / chốt từng công đoạn, ghi lượt xuống ghe — mỗi lượt là một chuyến vận tải',
  async render(view, actions) {
    const [teams, lookups, vesselList] = await Promise.all([guard(api('/field/teams')), api('/field/lookups'), can('tms.read') ? api('/vessels?status=hoat_dong').catch(() => []) : Promise.resolve([])]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const write = can('field.write');

    // Đội trưởng vào là thấy đội mình; quản lý chọn đội để xem.
    const mine = teams.find((team) => team.leader_user_id === state.user?.id);
    if (!recordTeamId || !teams.some((team) => team.id === recordTeamId)) recordTeamId = mine?.id ?? teams[0]?.id ?? null;
    const team = teams.find((t) => t.id === recordTeamId);
    if (!team) { view.replaceChildren(alert('Chưa có đội nào. Quản lý tạo đội ở mục "Đội & phương tiện".', 'warn')); return; }

    actions.append(el('div', { class: 'htx-picker' }, [
      el('span', { class: 'muted', text: 'Đội' }),
      el('select', { onchange: async (event) => { recordTeamId = event.target.value; selectedJobId = null; await refresh(); } },
        teams.map((t) => el('option', { value: t.id, selected: t.id === recordTeamId }, [t.name]))),
    ]));

    const jobs = (await api(`/field/jobs?teamId=${team.id}&limit=100`)).filter((job) => ['da_phan_cong', 'dang_thuc_hien'].includes(job.status));
    const vehicles = team.vehicles.filter((v) => !['bao_duong', 'hong'].includes(v.status));
    const detail = el('div', { class: 'grid' });

    const showJob = async (jobId) => {
      selectedJobId = jobId;
      const job = await guard(api(`/field/jobs/${jobId}`));
      const stageCards = job.stages.map((stage) => {
        const prev = job.stages.find((s) => s.sort_order === stage.sort_order - 1);
        const canStart = write && !stage.started_at && (!prev || prev.started_at) && stage.stage !== 'xuong_ghe';
        const canComplete = write && !stage.completed_at && (!prev || prev.completed_at) && (stage.started_at || canStart);
        const body = [];

        body.push(el('div', { class: 'chip-row' }, [
          badge(STAGE_LABEL[stage.status], STAGE_TONE[stage.status]),
          stage.planned_start ? badge(`KH ${shortDate(stage.planned_start)}–${shortDate(stage.planned_end)}`, 'neutral') : null,
          stage.started_at ? badge(`Bắt đầu ${dateTime(stage.started_at)}`, 'info') : null,
          stage.completed_at ? badge(`Xong ${dateTime(stage.completed_at)} · ${tons(stage.quantity_tons)}${stage.bales ? ` · ${num(stage.bales)} kiện` : ''}`, 'good') : null,
          stage.vehicle_code ? badge(`${stage.vehicle_name}`, 'neutral') : null,
        ]));
        body.push(evidenceBlock('field_job_stage', stage.id, write && !['huy'].includes(job.status)));

        if (stage.stage === 'xuong_ghe') {
          body.push(table([
            { key: 'loaded_at', label: 'Lúc', render: (row) => dateTime(row.loaded_at) },
            { key: 'vessel_code', label: 'Ghe / sà lan' },
            { key: 'bales', label: 'Cuộn', align: 'right', render: (row) => (row.bales ? num(row.bales) : '—') },
            { key: 'tons', label: 'Ước (t)', align: 'right', render: (row) => num(row.tons, 1) },
            { key: 'weighed_kg', label: 'Cân', align: 'right', render: (row) => (row.weighed_kg ? `${num(row.weighed_kg / 1000, 1)} t` : badge('chưa cân', 'neutral')) },
            { key: 'trip_code', label: 'Chuyến TMS', render: (row) => (row.trip_code ? badge(row.trip_code, 'info') : badge('không tạo được', 'warn')) },
            { key: 'grn_code', label: 'Kho', render: (row) => (row.grn_code ? badge(`${row.grn_code} · ${row.grn_status === 'da_duyet' ? 'đã duyệt' : 'chờ duyệt'}`, row.grn_status === 'da_duyet' ? 'good' : 'info') : row.notice_code ? badge(`${row.notice_code} · hàng đang tới`, 'neutral') : '—') },
          ], job.loadings, { empty: 'Chưa có lượt xuống ghe nào' }));
          if (write && !stage.completed_at && job.stages[1].started_at) {
            body.push(el('strong', { text: 'Ghi lượt xuống ghe' }));
            body.push(form([
              vesselList.length
                ? { name: 'vesselCode', label: 'Ghe / sà lan (danh mục; gõ số hiệu mới nếu chưa có)', type: 'select', required: true,
                    options: vesselList.map((v) => ({ value: v.code, label: `${v.code} — ${v.name ?? v.kindLabel}${v.expiry.state === 'het_han' ? ' ⚠ hết đăng kiểm' : v.expiry.state === 'sap_het_han' ? ` (còn ${v.expiry.daysLeft} ngày ĐK)` : ''}` })) }
                : { name: 'vesselCode', label: 'Số hiệu ghe / sà lan', required: true, placeholder: 'VD: AG-12345' },
              { name: 'vesselKind', label: 'Loại (bỏ qua nếu ghe có trong danh mục)', type: 'select', options: [{ value: 'ghe', label: 'Ghe (~4 000–4 500 cuộn)' }, { value: 'sa_lan', label: 'Sà lan' }] },
              { name: 'bales', label: `Số cuộn xuống ghe (≈ ${num(job.baleKg.kg, 1)} kg/cuộn → tấn tự ước)`, type: 'number', step: '1', required: true },
              { name: 'tons', label: 'Tấn — chỉ ghi nếu có cân tại bến, để trống thì ước theo cuộn', type: 'number', step: '0.5' },
              { name: 'driverName', label: 'Tài công' },
              { name: 'destinationFacilityId', label: 'Về Hub / nhà máy', type: 'select',
                options: [{ value: '', label: `Tự chọn gần nhất${job.destination_name ? ` (${job.destination_name})` : ''}` },
                  ...lookups.facilities.map((f) => ({ value: f.id, label: `${f.kind === 'hub' ? 'Hub' : 'Nhà máy'} — ${f.name}` }))] },
            ], async (values) => {
              const pos = await currentPosition();
              const result = await api(`/field/jobs/${jobId}/loadings`, { body: { ...values, tons: values.tons ?? undefined, destinationFacilityId: values.destinationFacilityId || undefined, ...(pos ?? {}) } });
              toast(result.trip
                ? `Đã ghi ${num(values.bales)} cuộn (ước ${num(result.loading.tons, 1)} t) lên ${values.vesselCode} → chuyến ${result.trip.code} (${num(result.trip.distance_km, 1)} km)`
                : 'Đã ghi lượt xuống ghe.');
              if (result.warnings.length) window.alert(result.warnings.join('\n\n'));
              await refresh();
            }, { submitLabel: '⚓ Ghi lượt xuống ghe' }));
            if (job.loadings.length) {
              body.push(el('button', { class: 'small', text: '✔ Chốt xuống ghe — hoàn thành việc', onclick: async () => {
                if (!window.confirm(`Chốt việc ${job.code} với ${num(job.loadings.reduce((s, l) => s + (l.bales ?? 0), 0))} cuộn (ước ${num(job.loadings.reduce((s, l) => s + l.tons, 0), 1)} t) đã xuống ${job.loadings.length} ghe?`)) return;
                const pos = await currentPosition();
                await guard(api(`/field/jobs/${jobId}/stages/xuong_ghe/complete`, { body: { ...(pos ?? {}) } }));
                toast('Việc đã hoàn thành.'); selectedJobId = null; await refresh();
              } }));
            }
          }
        } else if (canStart || canComplete) {
          body.push(el('div', { class: 'grid cols-2' }, [
            canStart
              ? el('div', {}, [
                  el('strong', { text: 'Bắt đầu' }),
                  form([
                    { name: 'vehicleId', label: 'Máy dùng', type: 'select', options: [{ value: '', label: '— không ghi máy —' }, ...vehicles.map((v) => ({ value: v.id, label: `${v.name} (${VEHICLE_STATUS[v.status]?.[0]})` }))] },
                  ], async (values) => {
                    const pos = await currentPosition();
                    await api(`/field/jobs/${jobId}/stages/${stage.stage}/start`, { body: { vehicleId: values.vehicleId || undefined, ...(pos ?? {}) } });
                    toast(`Đã bắt đầu ${stage.label.toLowerCase()}${pos ? ' (có GPS)' : ''}.`);
                    await refresh();
                  }, { submitLabel: `▶ Bắt đầu ${stage.label.toLowerCase()}` }),
                ])
              : null,
            canComplete
              ? el('div', {}, [
                  el('strong', { text: 'Chốt công đoạn' }),
                  form([
                    { name: 'bales', label: `Số cuộn đã ${stage.label.toLowerCase()} (≈ ${num(job.baleKg.kg, 1)} kg/cuộn → tấn tự ước)`, type: 'number', step: '1', required: true, value: stage.stage === 'cuon_rom' ? '' : (prev?.bales ?? '') },
                    { name: 'quantityTons', label: 'Tấn — chỉ ghi nếu có cân, để trống thì ước theo cuộn', type: 'number', step: '0.5' },
                    { name: 'note', label: 'Ghi chú' },
                  ], async (values) => {
                    const pos = await currentPosition();
                    const done = await api(`/field/jobs/${jobId}/stages/${stage.stage}/complete`, { body: {
                      bales: values.bales, quantityTons: values.quantityTons ?? undefined, note: values.note || undefined, ...(pos ?? {}),
                    } });
                    const saved = done.stages.find((s) => s.stage === stage.stage);
                    toast(`Đã chốt ${stage.label.toLowerCase()}: ${num(values.bales)} cuộn (ước ${num(saved?.quantity_tons, 1)} t).`);
                    await refresh();
                  }, { submitLabel: `✔ Chốt ${stage.label.toLowerCase()}` }),
                ])
              : null,
          ]));
        }

        return el('div', { class: `plan-step ${stage.status === 'hoan_thanh' ? 'da_thuc_hien' : ''}` }, [
          el('div', { class: 'plan-step-head' }, [
            el('div', { class: 'plan-step-order', text: String(stage.sort_order) }),
            el('div', { class: 'plan-step-main' }, [el('strong', { text: stage.label }), el('div', { class: 'muted', text: lookups.stages.find((s) => s.code === stage.stage)?.hint ?? '' })]),
          ]),
          el('div', { class: 'plan-step-body' }, body),
        ]);
      });

      detail.replaceChildren(card(`${job.code} — ${job.location_label}`, [
        el('div', { class: 'chip-row' }, [
          statusBadge(job), riskBadge(job),
          badge(`Gặt ${shortDate(job.harvest_date)}`, 'neutral'), badge(`${num(job.expected_straw_tons, 0)} tấn dự kiến`, 'info'),
          job.destination_name ? badge(`→ ${job.destination_name}`, 'neutral') : null,
        ]),
        job.overdue ? alert(job.riskLabel, 'warn') : null,
        el('div', { class: 'plan-steps' }, stageCards),
      ]));
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi(team.name, `${num(jobs.length)} việc`, `${team.leader_name ?? '—'} · ${team.members.length} người`),
        kpi('Đang làm', num(jobs.filter((j) => j.status === 'dang_thuc_hien').length), 'Có công đoạn đã bắt đầu'),
        kpi('Máy sẵn sàng', `${vehicles.length}/${team.vehicles.length}`, `${num(team.capacityTonsPerDay)} tấn cuộn / ngày`),
        kpi('Quá hạn', num(jobs.filter((j) => j.overdue).length), 'Rơm nằm ruộng quá 3 ngày', jobs.some((j) => j.overdue) ? 'critical' : 'good'),
      ]),
      write ? null : alert('Bạn chỉ có quyền xem. Ghi nhận công đoạn cần quyền "Ghi nhận công đoạn tại ruộng".', 'info'),
      card('Việc của đội', [
        el('p', { class: 'muted', text: 'Bấm việc để ghi nhận. Vị trí GPS được lấy tự động khi bấm bắt đầu / chốt.' }),
        table([
          { key: 'code', label: 'Mã' },
          { key: 'location_label', label: 'Vị trí' },
          { key: 'planned_date', label: 'Kế hoạch', render: (row) => shortDate(row.planned_date) },
          { key: 'expected_straw_tons', label: 'Tấn', align: 'right', render: (row) => num(row.expected_straw_tons, 0) },
          { key: 'status', label: 'Trạng thái', render: (row) => el('span', { class: 'chip-row' }, [statusBadge(row), riskBadge(row)]) },
          { key: 'stages', label: 'Công đoạn', render: stageStrip },
        ], jobs, { onRowClick: (row) => showJob(row.id), rowClass: (row) => (row.id === selectedJobId ? 'selected' : null), empty: 'Đội chưa có việc nào được phân công' }),
      ]),
      detail,
    );
    if (selectedJobId && jobs.some((job) => job.id === selectedJobId)) await showJob(selectedJobId);
  },
});

// ===========================================================================
// Đội & phương tiện
// ===========================================================================

registerPage('field-teams', {
  title: 'Đội & phương tiện',
  subtitle: 'Đội thu gom, thành viên, máy cuộn – máy kéo – ghe; năng lực máy cuộn quyết định kế hoạch',
  async render(view, actions) {
    const [teams, vehicles, lookups] = await Promise.all([guard(api('/field/teams')), api('/field/vehicles'), api('/field/lookups')]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const manage = can('field.manage');
    const unassigned = vehicles.filter((v) => !v.team_id);
    const detail = el('div', { class: 'grid' });

    const showTeam = (teamId) => {
      selectedTeamId = teamId;
      const team = teams.find((t) => t.id === teamId);
      if (!team) return;
      detail.replaceChildren(card(`${team.name}`, [
        el('div', { class: 'chip-row' }, [
          badge(...TEAM_STATUS[team.status]),
          badge(`${num(team.capacityTonsPerDay)} t cuộn/ngày${team.capacityDeclared ? '' : ' (mặc định)'}`, team.capacityDeclared ? 'info' : 'warn'),
          badge(`${team.openJobs} việc đang mở · ${num(team.openTons)} t`, 'neutral'),
          team.base_label ? badge(`📍 ${team.base_label}`, 'neutral') : null,
        ]),
        el('div', { class: 'grid cols-2' }, [
          el('div', {}, [
            el('h4', { text: 'Thành viên' }),
            table([
              { key: 'full_name', label: 'Họ tên' },
              { key: 'role', label: 'Vai trò', render: (row) => lookups.memberRoles[row.role] ?? row.role },
              { key: 'phone', label: 'Điện thoại' },
              { key: 'status', label: '', render: (row) => (manage
                ? el('select', { onchange: async (e) => { await guard(api(`/field/members/${row.id}/status`, { body: { status: e.target.value } })); toast('Đã cập nhật.'); await refresh(); } },
                    [['hoat_dong', 'Hoạt động'], ['tam_nghi', 'Tạm nghỉ'], ['nghi_viec', 'Nghỉ việc']].map(([v, l]) => el('option', { value: v, selected: row.status === v }, [l])))
                : badge(row.status, 'neutral')) },
            ], team.members),
            manage
              ? form([
                  { name: 'fullName', label: 'Họ tên', required: true },
                  { name: 'phone', label: 'Điện thoại' },
                  { name: 'role', label: 'Vai trò', type: 'select', options: Object.entries(lookups.memberRoles).map(([value, label]) => ({ value, label })) },
                ], async (values) => { await api(`/field/teams/${teamId}/members`, { body: values }); toast('Đã thêm thành viên.'); await refresh(); }, { submitLabel: '+ Thêm thành viên' })
              : null,
          ]),
          el('div', {}, [
            el('h4', { text: 'Phương tiện của đội' }),
            table([
              { key: 'name', label: 'Phương tiện' },
              { key: 'kind', label: 'Loại', render: (row) => lookups.vehicleKinds.find((k) => k.code === row.kind)?.label ?? row.kind },
              { key: 'capacity_value', label: 'Năng lực', render: (row) => (row.capacity_value ? `${num(row.capacity_value, 1)} ${row.capacity_unit}` : '—') },
              { key: 'status', label: 'Trạng thái', render: (row) => (manage
                ? el('select', { onchange: async (e) => { await guard(api(`/field/vehicles/${row.id}`, { method: 'PUT', body: { status: e.target.value } })); toast('Đã cập nhật.'); await refresh(); } },
                    Object.entries(VEHICLE_STATUS).map(([v, [l]]) => el('option', { value: v, selected: row.status === v }, [l])))
                : badge(...VEHICLE_STATUS[row.status])) },
              { key: 'act', label: '', render: (row) => (manage
                ? el('button', { class: 'small', text: 'Rút khỏi đội', onclick: async () => { await guard(api(`/field/vehicles/${row.id}`, { method: 'PUT', body: { teamId: '' } })); toast('Đã rút.'); await refresh(); } })
                : null) },
            ], team.vehicles, { empty: 'Đội chưa có phương tiện — kế hoạch dùng năng lực mặc định' }),
            manage && unassigned.length
              ? form([
                  { name: 'vehicleId', label: 'Điều chuyển phương tiện chưa có đội', type: 'select', options: unassigned.map((v) => ({ value: v.id, label: `${v.name} (${lookups.vehicleKinds.find((k) => k.code === v.kind)?.label})` })) },
                ], async (values) => { await api(`/field/vehicles/${values.vehicleId}`, { method: 'PUT', body: { teamId } }); toast('Đã điều chuyển.'); await refresh(); }, { submitLabel: '→ Điều về đội này' })
              : null,
          ]),
        ]),
        manage
          ? form([
              { name: 'status', label: 'Trạng thái đội', type: 'select', options: Object.entries(TEAM_STATUS).map(([value, [label]]) => ({ value, label, selected: team.status === value })) },
              { name: 'leaderName', label: 'Đội trưởng', value: team.leader_name ?? '' },
              { name: 'leaderPhone', label: 'Điện thoại', value: team.leader_phone ?? '' },
              { name: 'baseLabel', label: 'Điểm đóng quân', value: team.base_label ?? '' },
            ], async (values) => { await api(`/field/teams/${teamId}`, { method: 'PUT', body: values }); toast('Đã cập nhật đội.'); await refresh(); }, { submitLabel: 'Lưu', resetOnSuccess: false })
          : null,
      ]));
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đội hoạt động', num(teams.filter((t) => t.status === 'hoat_dong').length), `${teams.length} đội tổng`),
        kpi('Năng lực cuộn', `${num(teams.filter((t) => t.status === 'hoat_dong').reduce((s, t) => s + t.capacityTonsPerDay, 0))} t/ngày`, 'Tổng máy cuộn dùng được'),
        kpi('Phương tiện', num(vehicles.length), `${vehicles.filter((v) => ['bao_duong', 'hong'].includes(v.status)).length} hỏng / bảo dưỡng`),
        kpi('Chưa gán đội', num(unassigned.length), 'Có thể điều chuyển', unassigned.length ? 'warning' : undefined),
      ]),
      card('Danh sách đội', table([
        { key: 'code', label: 'Mã' },
        { key: 'name', label: 'Đội' },
        { key: 'leader_name', label: 'Đội trưởng' },
        { key: 'members', label: 'Người', align: 'right', render: (row) => row.members.length },
        { key: 'vehicles', label: 'Phương tiện', align: 'right', render: (row) => row.vehicles.length },
        { key: 'capacityTonsPerDay', label: 'Cuộn t/ngày', align: 'right', render: (row) => el('span', {}, [num(row.capacityTonsPerDay), row.capacityDeclared ? null : badge('mặc định', 'warn')]) },
        { key: 'openJobs', label: 'Việc mở', align: 'right' },
        { key: 'status', label: 'Trạng thái', render: (row) => badge(...TEAM_STATUS[row.status]) },
      ], teams, { onRowClick: (row) => showTeam(row.id), rowClass: (row) => (row.id === selectedTeamId ? 'selected' : null) })),
      detail,
      manage
        ? el('div', { class: 'grid cols-2' }, [
            card('Tạo đội mới', form([
              { name: 'name', label: 'Tên đội', required: true, placeholder: 'Đội 5 — Rạch Giá' },
              { name: 'leaderName', label: 'Đội trưởng' },
              { name: 'leaderPhone', label: 'Điện thoại' },
              { name: 'baseLabel', label: 'Điểm đóng quân' },
              { name: 'baseLat', label: 'Vĩ độ', type: 'number', step: '0.0001' },
              { name: 'baseLng', label: 'Kinh độ', type: 'number', step: '0.0001' },
            ], async (values) => { await api('/field/teams', { body: values }); toast('Đã tạo đội.'); await refresh(); }, { submitLabel: '+ Tạo đội' })),
            card('Thêm phương tiện', form([
              { name: 'name', label: 'Tên', required: true, placeholder: 'Máy cuộn Kubota #5.1' },
              { name: 'kind', label: 'Loại', type: 'select', options: lookups.vehicleKinds.map((k) => ({ value: k.code, label: `${k.label} (${k.capacityUnit})` })) },
              { name: 'capacityValue', label: 'Năng lực (máy cuộn: tấn/ngày — bắt buộc)', type: 'number', step: '0.5' },
              { name: 'plateNumber', label: 'Biển số / số hiệu' },
              { name: 'teamId', label: 'Gán cho đội', type: 'select', options: [{ value: '', label: '— để dự phòng —' }, ...teams.map((t) => ({ value: t.id, label: t.name }))] },
            ], async (values) => { await api('/field/vehicles', { body: { ...values, teamId: values.teamId || undefined } }); toast('Đã thêm phương tiện.'); await refresh(); }, { submitLabel: '+ Thêm phương tiện' })),
          ])
        : null,
    );
    if (selectedTeamId && teams.some((team) => team.id === selectedTeamId)) showTeam(selectedTeamId);
  },
});

// ===========================================================================
// Báo cáo năng suất
// ===========================================================================

registerPage('field-report', {
  title: 'Năng suất hiện trường',
  subtitle: 'Tấn cuộn – gom – xuống ghe theo đội, thời gian từng công đoạn, mức sử dụng máy',
  async render(view, actions) {
    const from = sessionStorage.getItem('field-report-from') ?? addDays(today(), -30);
    const to = sessionStorage.getItem('field-report-to') ?? today();
    const report = await guard(api(`/field/report?from=${from}&to=${to}`));

    actions.append(form([
      { name: 'from', label: 'Từ', type: 'date', value: from, required: true },
      { name: 'to', label: 'Đến', type: 'date', value: to, required: true },
    ], async (values) => {
      sessionStorage.setItem('field-report-from', values.from); sessionStorage.setItem('field-report-to', values.to);
      actions.replaceChildren(); await this.render(view, actions);
    }, { submitLabel: 'Xem', resetOnSuccess: false }));

    const hours = (value) => (value === null || value === undefined ? '—' : `${num(value, 1)} h`);
    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Việc hoàn thành', num(report.totals.jobsCompleted), `${report.periodDays} ngày`),
        kpi('Rơm đã cuộn', `${num(report.totals.baledTons)} t`, 'Tổng các đội'),
        kpi('Rơm đã xuống ghe', `${num(report.totals.loadedTons)} t`, report.totals.baledTons ? `${Math.round((report.totals.loadedTons / report.totals.baledTons) * 100)}% lượng đã cuộn` : ''),
        kpi('Hao hụt cuộn → ghe', `${num(report.totals.baledTons - report.totals.loadedTons)} t`, 'Rơm rơi vãi, ướt, bỏ lại'),
      ]),
      card('Theo đội', [
        el('p', { class: 'muted', text: 'Tỷ lệ thu hồi = cuộn được / rơm dự kiến. Thời gian gặt → ghe tính từ 6h sáng ngày gặt tới lượt xuống ghe cuối.' }),
        table([
          { key: 'name', label: 'Đội' },
          { key: 'jobsCompleted', label: 'Việc', align: 'right' },
          { key: 'areaHa', label: 'ha', align: 'right', render: (row) => num(row.areaHa, 1) },
          { key: 'baledTons', label: 'Cuộn (t)', align: 'right', render: (row) => num(row.baledTons, 1) },
          { key: 'gatheredTons', label: 'Gom (t)', align: 'right', render: (row) => num(row.gatheredTons, 1) },
          { key: 'loadedTons', label: 'Xuống ghe (t)', align: 'right', render: (row) => num(row.loadedTons, 1) },
          { key: 'recoveryPct', label: 'Thu hồi', align: 'right', render: (row) => (row.recoveryPct === null ? '—' : badge(`${row.recoveryPct}%`, row.recoveryPct >= 90 ? 'good' : row.recoveryPct >= 75 ? 'warn' : 'bad')) },
          { key: 'avgHoursBaling', label: 'Cuộn', align: 'right', render: (row) => hours(row.avgHoursBaling) },
          { key: 'avgHoursGathering', label: 'Gom', align: 'right', render: (row) => hours(row.avgHoursGathering) },
          { key: 'avgHoursLoading', label: 'Xuống ghe', align: 'right', render: (row) => hours(row.avgHoursLoading) },
          { key: 'avgLeadHoursHarvestToVessel', label: 'Gặt → ghe', align: 'right', render: (row) => hours(row.avgLeadHoursHarvestToVessel) },
        ], report.teams),
      ]),
      card('Sử dụng phương tiện', table([
        { key: 'code', label: 'Mã' },
        { key: 'name', label: 'Phương tiện' },
        { key: 'team_name', label: 'Đội', render: (row) => row.team_name ?? el('span', { class: 'muted', text: 'dự phòng' }) },
        { key: 'status', label: 'Trạng thái', render: (row) => badge(...(VEHICLE_STATUS[row.status] ?? [row.status, 'neutral'])) },
        { key: 'days_used', label: 'Ngày dùng', align: 'right', render: (row) => num(row.days_used ?? 0) },
        { key: 'utilisationPct', label: 'Sử dụng', align: 'right', render: (row) => badge(`${row.utilisationPct}%`, row.utilisationPct >= 60 ? 'good' : row.utilisationPct > 0 ? 'warn' : 'neutral') },
        { key: 'tons_handled', label: 'Tấn qua máy', align: 'right', render: (row) => num(row.tons_handled ?? 0, 1) },
      ], report.vehicles)),
    );
  },
});

// ===========================================================================
// Cân tại nhà máy & đối soát — số thật về từng lượt ghe (FM-09, FM-10)
// ===========================================================================

registerPage('field-weighing', {
  title: 'Cân nhà máy & đối soát',
  subtitle: 'Ở ruộng đếm cuộn, về nhà máy mới cân — mỗi ghe ghi cả số cuộn và số cân, lệch quá 5 % gắn cờ',
  async render(view, actions) {
    const from = sessionStorage.getItem('field-recon-from') ?? addDays(today(), -30);
    const to = sessionStorage.getItem('field-recon-to') ?? today();
    const [pending, recon, lookups] = await Promise.all([
      guard(api('/field/weighings/pending')), api(`/field/reconciliation?from=${from}&to=${to}`), api('/field/lookups'),
    ]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const canWeigh = can('warehouse.write') || can('field.manage');
    const kg = recon.baleKg;
    const kgSource = { can_htx: 'học từ cân của HTX', can_he_thong: 'học từ các lượt đã cân', cau_hinh: 'cấu hình', mac_dinh: 'mặc định — chưa có lượt cân nào' };

    actions.append(form([
      { name: 'from', label: 'Từ', type: 'date', value: from, required: true },
      { name: 'to', label: 'Đến', type: 'date', value: to, required: true },
    ], async (values) => {
      sessionStorage.setItem('field-recon-from', values.from); sessionStorage.setItem('field-recon-to', values.to); await refresh();
    }, { submitLabel: 'Xem', resetOnSuccess: false }));

    let selected = null;
    const weighBox = el('div', { class: 'grid' });
    const showWeighForm = (row) => {
      selected = row.id;
      weighBox.replaceChildren(card(`Cân ghe ${row.vessel_code} — ${row.job_code}`, [
        el('div', { class: 'chip-row' }, [
          badge(`${num(row.bales ?? 0)} cuộn đếm ở ruộng`, 'info'), badge(`ước ${num(row.tons, 1)} t`, 'neutral'),
          badge(`xuống ghe ${dateTime(row.loaded_at)}`, 'neutral'), row.trip_code ? badge(`chuyến ${row.trip_code}`, 'neutral') : null,
        ]),
        el('p', { class: 'muted', text: 'Ghi tổng và bì như phiếu cân, hoặc ghi thẳng khối lượng tịnh. Số cuộn đếm lại ở nhà máy là tuỳ chọn nhưng giúp tách hao hụt do rơi vãi khỏi hao hụt do ẩm.' }),
        form([
          { name: 'grossKg', label: 'Tổng (kg) — ghe có hàng', type: 'number', step: '10' },
          { name: 'tareKg', label: 'Bì (kg) — ghe rỗng', type: 'number', step: '10' },
          { name: 'netKg', label: 'Hoặc: tịnh (kg)', type: 'number', step: '10' },
          { name: 'plantBales', label: 'Số cuộn đếm lại tại nhà máy', type: 'number', step: '1' },
          { name: 'facilityId', label: 'Cân tại', type: 'select', options: lookups.facilities.map((f) => ({ value: f.id, label: `${f.kind === 'hub' ? 'Hub' : 'Nhà máy'} — ${f.name}`, selected: f.name === row.destination_name })) },
          { name: 'note', label: 'Ghi chú' },
        ], async (values) => {
          const result = await api(`/field/loadings/${row.id}/weigh`, { body: {
            grossKg: values.grossKg ?? undefined, tareKg: values.tareKg ?? undefined, netKg: values.netKg ?? undefined,
            plantBales: values.plantBales ?? undefined, facilityId: values.facilityId || undefined, note: values.note || undefined,
          } });
          toast(`${result.flagged
            ? `Cân ${num(result.netKg / 1000, 1)} t — LỆCH ${num(result.variancePct, 1)}% so với ước, đã báo điều hành.`
            : `Cân ${num(result.netKg / 1000, 1)} t — khớp ước tính (${num(result.variancePct ?? 0, 1)}%).`} Phiếu nhập ${result.goodsReceipt.code} chờ kho duyệt${result.tripCost ? ` · cước ghe ${num(result.tripCost)} đ` : ''}.`, Boolean(result.flagged));
          selected = null;
          await refresh();
        }, { submitLabel: '⚖️ Ghi cân' }),
      ]));
    };

    const reconColumns = (labelKey, label) => [
      { key: labelKey, label, render: (row) => row[labelKey] ?? el('span', { class: 'muted', text: 'chưa gán' }) },
      { key: 'loadings', label: 'Lượt ghe', align: 'right' },
      { key: 'weighed', label: 'Đã cân', align: 'right', render: (row) => `${row.weighed}/${row.loadings}` },
      { key: 'bales', label: 'Cuộn (ruộng)', align: 'right', render: (row) => num(row.bales ?? 0) },
      { key: 'baleDiff', label: 'Cuộn lệch', align: 'right', render: (row) => (row.baleDiff === null ? '—' : badge(`${row.baleDiff > 0 ? '+' : ''}${num(row.baleDiff)}`, row.baleDiff < 0 ? 'warn' : 'neutral')) },
      { key: 'estTons', label: 'Ước (t)', align: 'right', render: (row) => num(row.estTons, 1) },
      { key: 'weighedTons', label: 'Cân (t)', align: 'right', render: (row) => num(row.weighedTons, 1) },
      { key: 'variancePct', label: 'Lệch', align: 'right', render: (row) => varianceBadge(row.variancePct) ?? '—' },
      { key: 'avgBaleKg', label: 'kg/cuộn', align: 'right', render: (row) => (row.avgBaleKg ? num(row.avgBaleKg, 1) : '—') },
      { key: 'flagged', label: 'Cờ', align: 'right', render: (row) => (row.flagged ? badge(String(row.flagged), 'bad') : '—') },
    ];

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Ghe chờ cân', num(pending.length), `ước ${num(pending.reduce((s, r) => s + r.tons, 0))} t · ${num(pending.reduce((s, r) => s + (r.bales ?? 0), 0))} cuộn`, pending.length ? 'warning' : 'good'),
        kpi('kg / cuộn đang dùng', `${num(kg.kg, 1)} kg`, `${kgSource[kg.source] ?? kg.source}${kg.samples ? ` · ${kg.samples} lượt` : ''}`),
        kpi('Lệch trong kỳ', num(recon.byTeam.reduce((s, r) => s + r.flagged, 0)), `lượt lệch quá ${recon.thresholdPct}%`, recon.byTeam.some((r) => r.flagged) ? 'warning' : 'good'),
        kpi('Đã cân trong kỳ', `${num(recon.byTeam.reduce((s, r) => s + r.weighedTons, 0))} t`, `ước trước đó ${num(recon.byTeam.reduce((s, r) => s + r.estTons, 0))} t`),
      ]),
      pending.some((r) => r.hours_since_loading > 48)
        ? alert(`${pending.filter((r) => r.hours_since_loading > 48).length} ghe đã xuống hàng quá 48 giờ mà chưa cân — chưa cân thì chưa đối chiếu, chưa trả tiền được.`, 'warn')
        : null,
      card('Ghe chờ cân', [
        el('p', { class: 'muted', text: canWeigh ? 'Bấm một dòng để ghi phiếu cân. Phiếu đi vào phân hệ kho và đóng chuyến TMS với số tấn thật.' : 'Bạn chỉ có quyền xem; ghi cân cần quyền nhập kho hoặc điều hành hiện trường.' }),
        table([
          { key: 'vessel_code', label: 'Ghe / sà lan' },
          { key: 'job_code', label: 'Việc' },
          { key: 'location_label', label: 'Từ' },
          { key: 'team_name', label: 'Đội' },
          { key: 'bales', label: 'Cuộn', align: 'right', render: (row) => num(row.bales ?? 0) },
          { key: 'tons', label: 'Ước (t)', align: 'right', render: (row) => num(row.tons, 1) },
          { key: 'destination_name', label: 'Về' },
          { key: 'hours_since_loading', label: 'Đã đi', align: 'right', render: (row) => badge(`${num(row.hours_since_loading)} h`, row.hours_since_loading > 48 ? 'bad' : row.hours_since_loading > 24 ? 'warn' : 'neutral') },
          { key: 'trip_status', label: 'Chuyến', render: (row) => (row.trip_code ? badge(`${row.trip_code} · ${row.trip_status === 'dang_chay' ? 'đang chạy' : 'chờ'}`, 'info') : badge('không có', 'warn')) },
          { key: 'notice_code', label: 'Báo kho', render: (row) => (row.notice_code ? badge(row.notice_code, 'neutral') : '—') },
        ], pending, { onRowClick: canWeigh ? (row) => showWeighForm(row) : undefined, rowClass: (row) => (row.id === selected ? 'selected' : null), empty: 'Mọi ghe đã cân — tốt.' }),
      ]),
      weighBox,
      el('div', { class: 'grid cols-2' }, [
        card('Đối soát theo đội', table(reconColumns('team_name', 'Đội'), recon.byTeam, { empty: 'Chưa có lượt ghe trong kỳ' })),
        card('Đối soát theo HTX', table(reconColumns('htx_name', 'HTX'), recon.byHtx, { empty: 'Chưa có lượt ghe trong kỳ' })),
      ]),
      card('Lượt đã cân gần nhất', table([
        { key: 'weighed_at', label: 'Cân lúc', render: (row) => dateTime(row.weighed_at) },
        { key: 'vessel_code', label: 'Ghe' },
        { key: 'job_code', label: 'Việc' },
        { key: 'team_name', label: 'Đội' },
        { key: 'bales', label: 'Cuộn ruộng', align: 'right', render: (row) => num(row.bales ?? 0) },
        { key: 'plant_bales', label: 'Cuộn nhà máy', align: 'right', render: (row) => (row.plant_bales ? num(row.plant_bales) : '—') },
        { key: 'tons', label: 'Ước (t)', align: 'right', render: (row) => num(row.tons, 1) },
        { key: 'weighed_kg', label: 'Cân (t)', align: 'right', render: (row) => num(row.weighed_kg / 1000, 1) },
        { key: 'variance_pct', label: 'Lệch', align: 'right', render: (row) => varianceBadge(row.variance_pct) },
        { key: 'grn_code', label: 'Phiếu nhập', render: (row) => (row.grn_code ? badge(`${row.grn_code} · ${row.grn_status === 'da_duyet' ? 'đã duyệt' : 'chờ duyệt'}`, row.grn_status === 'da_duyet' ? 'good' : 'info') : '—') },
      ], recon.recent, { empty: 'Chưa có lượt nào được cân trong kỳ' })),
    );
  },
});
