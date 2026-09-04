import {
  api, registerPage, el, card, kpi, table, badge, alert, num, dateTime,
  toast, guard, can, mapContainer, createMap, LEAFLET_AVAILABLE,
} from '/app.js';

const STATUS = {
  nhap_moi: { label: 'Sẽ nhập mới', tone: 'good' },
  cap_nhat: { label: 'Sẽ cập nhật', tone: 'info' },
  canh_bao: { label: 'Nhập kèm cảnh báo', tone: 'warn' },
  bo_qua: { label: 'Bỏ qua', tone: 'bad' },
};

/** Đọc file người dùng chọn thành base64 để gửi kèm JSON. */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không đọc được file.'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

registerPage('import', {
  title: 'Nhập dữ liệu từ Excel',
  subtitle: 'Danh sách HTX → tự định vị trên bản đồ · Dữ liệu vụ mùa theo đơn vị hành chính · tự quy đổi địa giới cũ sang địa giới sau sáp nhập 2025',
  async render(view) {
    let mode = 'cooperatives';
    let file = null;
    let base64 = null;
    let sheets = [];
    let report = null;

    const dropZone = el('div', { class: 'card' });
    const optionsBox = el('div', { class: 'card' });
    const reportBox = el('div');

    const tabs = el('div', { class: 'chip-row' }, [
      ['cooperatives', '① Danh sách HTX / THT'],
      ['cropSeason', '② Dữ liệu vụ mùa theo địa giới'],
    ].map(([key, label]) => el('button', {
      class: `chip${mode === key ? ' active' : ''}`,
      text: label,
      onclick: (event) => {
        mode = key;
        [...event.target.parentElement.children].forEach((chip) => chip.classList.remove('active'));
        event.target.classList.add('active');
        report = null;
        renderOptions();
        reportBox.replaceChildren();
      },
    })));

    view.replaceChildren(card('Loại dữ liệu cần nhập', tabs), dropZone, optionsBox, reportBox);

    // ---------------- Chọn file ----------------
    const fileInput = el('input', {
      type: 'file',
      accept: '.xlsx',
      onchange: async (event) => {
        file = event.target.files?.[0] ?? null;
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.xlsx')) {
          return toast('Chỉ hỗ trợ định dạng .xlsx (Excel 2007 trở lên). File .xls cũ cần lưu lại thành .xlsx.', true);
        }
        toast(`Đang đọc ${file.name}…`);
        base64 = await readFileAsBase64(file);
        const info = await guard(api('/import/sheets', { body: { fileName: file.name, contentBase64: base64 } }));
        sheets = info.sheets;
        renderDropZone();
        renderOptions();
        toast(`Đã đọc ${file.name}: ${sheets.length} sheet.`);
      },
    });

    function renderDropZone() {
      dropZone.replaceChildren(
        el('h3', { text: 'Chọn file Excel' }),
        fileInput,
        file
          ? el('div', { style: 'margin-top:10px' }, [
              el('div', { class: 'chip-row' }, [
                badge(file.name, 'info'),
                badge(`${(file.size / 1024).toFixed(0)} KB`, 'neutral'),
                badge(`${sheets.length} sheet`, 'neutral'),
              ]),
              sheets.length
                ? table(
                    [
                      { key: 'name', label: 'Sheet' },
                      { key: 'rows', label: 'Số dòng', align: 'right', render: (row) => num(row.rows) },
                      { key: 'columns', label: 'Số cột', align: 'right', render: (row) => num(row.columns) },
                    ],
                    sheets,
                  )
                : null,
            ])
          : el('p', { class: 'muted', text: 'Hệ thống tự nhận diện dòng tiêu đề và tên cột — không cần sửa file trước khi nhập.' }),
      );
    }

    // ---------------- Tuỳ chọn nhập ----------------
    function renderOptions() {
      if (!file) {
        optionsBox.replaceChildren(
          el('h3', { text: 'Tuỳ chọn' }),
          alert('Chọn file Excel ở trên để bắt đầu.', 'info'),
        );
        return;
      }
      const sheetSelect = el('select', { id: 'imp-sheet' },
        sheets.map((sheet, index) => el('option', { value: sheet.name, selected: index === 0 }, [`${sheet.name} (${sheet.rows} dòng)`])));

      const common = [
        el('label', {}, ['Sheet dữ liệu', sheetSelect]),
      ];

      if (mode === 'cropSeason') {
        common.push(
          el('label', {}, ['Tỉnh mặc định (khi file không có cột Tỉnh)', el('select', { id: 'imp-province' },
            ['', 'An Giang', 'Đồng Tháp', 'Vĩnh Long', 'Cần Thơ', 'Cà Mau', 'Tây Ninh', 'Kiên Giang', 'Sóc Trăng', 'Hậu Giang', 'Bạc Liêu', 'Trà Vinh', 'Bến Tre', 'Tiền Giang', 'Long An']
              .map((name) => el('option', { value: name }, [name || '— Không chọn —'])))]),
          el('label', {}, ['Mã vụ (bỏ trống để tự suy từ tên sheet)', el('input', { id: 'imp-season', placeholder: 'VD: ĐX2526' })]),
        );
      } else {
        common.push(
          el('label', {}, ['HTX đã tồn tại', el('select', { id: 'imp-update' }, [
            el('option', { value: 'no' }, ['Bỏ qua (giữ nguyên bản ghi cũ)']),
            el('option', { value: 'yes' }, ['Cập nhật theo file']),
          ])]),
        );
      }

      optionsBox.replaceChildren(
        el('h3', { text: 'Tuỳ chọn nhập' }),
        el('div', { class: 'row' }, common),
        el('div', { class: 'chip-row', style: 'margin-top:12px' }, [
          el('button', { class: 'small', text: '🔍 Kiểm tra trước (không ghi dữ liệu)', onclick: () => run(true) }),
          el('button', {
            class: 'ghost small', text: '💾 Nhập vào hệ thống', disabled: !report || report.dryRun === false,
            id: 'imp-commit', onclick: () => run(false),
          }),
        ]),
        el('p', { class: 'muted', text: 'Luôn chạy "Kiểm tra trước" để xem báo cáo đối chiếu; chỉ khi kết quả hợp lý mới ghi vào dữ liệu dùng chung.' }),
      );
    }

    async function run(dryRun) {
      if (!file || !base64) return toast('Chưa chọn file.', true);
      const payload = {
        fileName: file.name,
        contentBase64: base64,
        sheetName: document.getElementById('imp-sheet')?.value,
        dryRun,
      };
      let result;
      if (mode === 'cooperatives') {
        payload.updateExisting = document.getElementById('imp-update')?.value === 'yes';
        toast(dryRun ? 'Đang kiểm tra danh sách HTX…' : 'Đang nhập vào hệ thống…');
        result = await guard(api('/import/cooperatives', { body: payload }));
        report = result;
        renderCooperativeReport(result);
      } else {
        payload.defaultProvince = document.getElementById('imp-province')?.value || undefined;
        payload.seasonCode = document.getElementById('imp-season')?.value || undefined;
        toast(dryRun ? 'Đang kiểm tra dữ liệu vụ mùa…' : 'Đang nhập vào hệ thống…');
        result = await guard(api('/import/crop-season', { body: payload }));
        report = result;
        renderCropSeasonReport(result);
      }
      const commitButton = document.getElementById('imp-commit');
      if (commitButton) commitButton.disabled = !dryRun;
      toast(dryRun
        ? 'Đã kiểm tra xong — xem báo cáo bên dưới.'
        : `Đã nhập: ${result.inserted} bản ghi mới, ${result.updated} cập nhật.`);
    }

    // ---------------- Báo cáo: danh sách HTX ----------------
    function renderCooperativeReport(result) {
      const previewRows = result.rows.slice(0, 300);
      const problemRows = result.rows.filter((row) => row.issues.length);

      reportBox.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Tổng số dòng', num(result.totalRows), result.dryRun ? 'Chưa ghi vào hệ thống' : 'Đã ghi vào hệ thống'),
          kpi('Định vị cấp huyện', num(result.geocodeQuality.huyen),
            `${((result.geocodeQuality.huyen / Math.max(result.totalRows, 1)) * 100).toFixed(1)}% tổng số`, 'good'),
          kpi('Chỉ định vị được cấp tỉnh', num(result.geocodeQuality.tinh), 'Cần khảo sát GPS bổ sung (RS-02)',
            result.geocodeQuality.tinh ? 'warning' : 'good'),
          kpi(result.dryRun ? 'Sẽ bỏ qua' : 'Đã bỏ qua', num(result.skipped),
            `${num(result.warned)} dòng có cảnh báo`, result.skipped ? 'critical' : 'good'),
        ]),

        card('Quy đổi địa giới hành chính (sáp nhập 2025)', [
          result.conversions.length
            ? table(
                [
                  { key: 'from', label: 'Tỉnh ghi trong file' },
                  { key: 'arrow', label: '', render: () => '→' },
                  { key: 'to', label: 'Tỉnh sau sáp nhập' },
                  { key: 'count', label: 'Số HTX', align: 'right', render: (row) => num(row.count) },
                ],
                result.conversions,
              )
            : alert('File đã dùng tên tỉnh sau sáp nhập — không cần quy đổi.', 'info'),
          el('h4', { text: 'Phân bổ theo tỉnh sau sáp nhập' }),
          table(
            [
              { key: 'province', label: 'Tỉnh/Thành' },
              { key: 'count', label: 'Số HTX', align: 'right', render: (row) => num(row.count) },
              { key: 'declaredAs', label: 'Gộp từ (theo file)', render: (row) => row.declaredAs.join(', ') },
            ],
            result.byProvince,
          ),
        ]),

        result.issueSummary.length
          ? card('Vấn đề dữ liệu cần rà soát', table(
              [
                { key: 'count', label: 'Số dòng', align: 'right', render: (row) => num(row.count) },
                { key: 'issue', label: 'Nội dung' },
              ],
              result.issueSummary,
            ))
          : null,

        problemRows.length
          ? card(`Chi tiết ${problemRows.length} dòng có cảnh báo`, table(
              [
                { key: 'sheetRow', label: 'Dòng', align: 'right' },
                { key: 'name', label: 'Tên HTX' },
                { key: 'district', label: 'Huyện (file)' },
                { key: 'newProvince', label: 'Tỉnh sau sáp nhập' },
                {
                  key: 'suggestedProvince', label: 'Gợi ý',
                  render: (row) => (row.suggestedProvince ? badge(`→ ${row.suggestedProvince}`, 'warn') : '—'),
                },
                { key: 'issues', label: 'Cảnh báo', render: (row) => row.issues.join(' ') },
              ],
              problemRows.slice(0, 200),
            ))
          : null,

        card(`Xem trước dữ liệu (${previewRows.length}/${result.totalRows} dòng đầu)`, table(
          [
            { key: 'sheetRow', label: 'Dòng', align: 'right' },
            { key: 'name', label: 'Tên HTX' },
            { key: 'newProvince', label: 'Tỉnh' },
            { key: 'district', label: 'Huyện' },
            { key: 'commune', label: 'Xã' },
            { key: 'contactName', label: 'Người liên lạc' },
            { key: 'contactPhone', label: 'SĐT' },
            { key: 'areaHa', label: 'Diện tích (ha)', align: 'right', render: (row) => (row.areaHa === null ? '—' : num(row.areaHa)) },
            { key: 'coords', label: 'Toạ độ', render: (row) => (row.lat === null ? '—' : `${row.lat.toFixed(4)}, ${row.lng.toFixed(4)}`) },
            {
              key: 'geocodePrecision', label: 'Độ chính xác',
              render: (row) => badge(row.geocodePrecision === 'huyen' ? 'Cấp huyện' : 'Cấp tỉnh',
                row.geocodePrecision === 'huyen' ? 'good' : 'warn'),
            },
            { key: 'status', label: 'Kết quả', render: (row) => badge(STATUS[row.status].label, STATUS[row.status].tone) },
          ],
          previewRows,
        )),

        card('Vị trí các HTX vừa định vị', [
          el('p', { class: 'muted', text: 'Điểm màu xanh = định vị tới cấp huyện; màu cam = chỉ tới cấp tỉnh, cần khảo sát GPS thực địa để nâng độ chính xác.' }),
          mapContainer('import-map', 'tall'),
        ]),
      );

      drawPreviewMap(result.rows);
    }

    // ---------------- Báo cáo: dữ liệu vụ mùa ----------------
    function renderCropSeasonReport(result) {
      reportBox.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Đơn vị hành chính', num(result.totals.communes), `Bố cục: ${result.layout === 'bang_cheo_tien_do' ? 'bảng chéo tiến độ thu hoạch' : 'bảng phẳng'}`),
          kpi('Diện tích gieo sạ', `${num(result.totals.areaHa)} ha`),
          kpi('Sản lượng', `${num(result.totals.outputTons)} tấn`, `${num(result.totals.harvestMilestones)} mốc thu hoạch`),
          kpi('Mùa vụ', result.season.name, result.season.created ? 'Vụ mới — sẽ được tạo trong danh mục' : 'Dùng vụ đã có trong danh mục'),
        ]),

        card('Ngày xuống giống', [
          el('div', { class: 'grid cols-3' }, [
            kpi('Khai báo trong file', num(result.sowingDateCoverage.khai_bao), 'Số liệu gốc', 'good'),
            kpi('Hệ thống suy ra', num(result.sowingDateCoverage.suy_ra), 'Từ ngày thu hoạch − thời gian sinh trưởng', 'warning'),
            kpi('Không xác định', num(result.sowingDateCoverage.khong_co), 'Thiếu cả ngày gieo sạ lẫn ngày thu hoạch'),
          ]),
          result.sowingDateCoverage.suy_ra
            ? alert(
                `File này không có cột "Ngày xuống giống" nên ${result.sowingDateCoverage.suy_ra} dòng được SUY RA từ ngày thu hoạch ` +
                'trừ đi thời gian sinh trưởng của vụ. Các giá trị đó được lưu kèm nhãn "suy ra" và không được trình bày như số liệu khai báo. ' +
                'Nếu file điều tra có cột ngày xuống giống, hệ thống sẽ tự nhận và dùng số liệu gốc.',
                'warn',
              )
            : null,
        ]),

        result.issueSummary.length
          ? card('Vấn đề dữ liệu cần rà soát', table(
              [
                { key: 'count', label: 'Số dòng', align: 'right', render: (row) => num(row.count) },
                { key: 'issue', label: 'Nội dung' },
              ],
              result.issueSummary,
            ))
          : null,

        card(`Xem trước dữ liệu vụ mùa (${Math.min(result.rows.length, 300)}/${result.totalRows} dòng)`, table(
          [
            { key: 'sheetRow', label: 'Dòng', align: 'right' },
            { key: 'commune', label: 'Xã/Phường' },
            { key: 'district', label: 'Huyện' },
            { key: 'provinceName', label: 'Tỉnh sau sáp nhập' },
            { key: 'areaHa', label: 'DT gieo sạ (ha)', align: 'right', render: (row) => (row.areaHa === null ? '—' : num(row.areaHa)) },
            {
              key: 'sowingDate', label: 'Ngày xuống giống',
              render: (row) => (row.sowingDate
                ? el('span', {}, [row.sowingDate, ' ', badge(row.sowingDateSource === 'khai_bao' ? 'khai báo' : 'suy ra',
                    row.sowingDateSource === 'khai_bao' ? 'good' : 'warn')])
                : '—'),
            },
            { key: 'harvestDate', label: 'Thu hoạch (mốc đầu)' },
            { key: 'progress', label: 'Số mốc', align: 'right', render: (row) => num(row.progress.length) },
            { key: 'yieldDryTonsPerHa', label: 'NS khô (t/ha)', align: 'right', render: (row) => (row.yieldDryTonsPerHa === null ? '—' : num(row.yieldDryTonsPerHa, 2)) },
            { key: 'outputTons', label: 'Sản lượng (tấn)', align: 'right', render: (row) => (row.outputTons === null ? '—' : num(row.outputTons)) },
            { key: 'status', label: 'Kết quả', render: (row) => badge(STATUS[row.status].label, STATUS[row.status].tone) },
          ],
          result.rows.slice(0, 300),
        )),

        card('Bản đồ lịch thời vụ', [
          el('p', { class: 'muted', text: 'Màu điểm theo tháng xuống giống — dùng để nhận diện vùng gieo sạ đồng loạt và vùng lệch vụ.' }),
          mapContainer('import-map', 'tall'),
        ]),
      );

      drawPreviewMap(result.rows.map((row) => ({
        ...row,
        name: `${row.commune}${row.district ? ` (${row.district})` : ''}`,
      })), 'season');
    }

    // ---------------- Bản đồ xem trước ----------------
    function drawPreviewMap(rows, kind = 'htx') {
      if (!LEAFLET_AVAILABLE()) return;
      setTimeout(() => {
        const map = createMap('import-map', [10.2, 105.7], 8);
        if (!map) return;
        const L = window.L;
        const points = [];
        for (const row of rows) {
          if (row.lat === null || row.lng === null) continue;
          const color = kind === 'season'
            ? sowingColor(row.sowingDate)
            : row.geocodePrecision === 'huyen' ? '#1C8C74' : '#C85A22';
          points.push([row.lat, row.lng]);
          L.circleMarker([row.lat, row.lng], {
            radius: 5, color, fillColor: color, fillOpacity: 0.75, weight: 1,
          })
            .bindTooltip(row.name)
            .bindPopup(kind === 'season'
              ? `<strong>${row.name}</strong><br>Diện tích: ${num(row.areaHa)} ha<br>Xuống giống: ${row.sowingDate ?? '—'} (${row.sowingDateSource ?? 'không có'})<br>Thu hoạch: ${row.harvestDate ?? '—'}<br>Sản lượng: ${num(row.outputTons)} tấn`
              : `<strong>${row.name}</strong><br>${row.district ?? ''} — ${row.newProvince ?? ''}<br>Độ chính xác: ${row.geocodePrecision === 'huyen' ? 'cấp huyện' : 'cấp tỉnh'}<br>${row.contactName ?? ''} ${row.contactPhone ?? ''}`)
            .addTo(map);
        }
        if (points.length) map.fitBounds(points, { padding: [24, 24] });
      }, 60);
    }

    renderDropZone();
    renderOptions();
  },
});

/** Bảng màu theo tháng xuống giống (vụ Đông Xuân trải từ tháng 11 đến tháng 1). */
function sowingColor(date) {
  if (!date) return '#9AA5A0';
  const month = Number(date.slice(5, 7));
  return ['#8B5E3C', '#1C8C74', '#3E7A3A', '#7AAE68', '#D9A441', '#C85A22',
    '#A3372A', '#6E9BBE', '#2A78D6', '#9C6414', '#5B4B8A', '#4A7C59'][month - 1] ?? '#9AA5A0';
}
