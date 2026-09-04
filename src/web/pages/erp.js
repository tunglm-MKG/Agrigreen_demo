import {
  api, registerPage, el, card, kpi, table, badge, alert, vnd, num, tons, pct, dateTime,
  toast, guard, can,
} from '/app.js';

// ===========================================================================
// Kho & Giám sát môi trường
// ===========================================================================

registerPage('warehouse', {
  title: 'Kho & Giám sát môi trường lưu trữ',
  subtitle: 'Nhập/xuất qua cân điện tử · cảm biến IoT ẩm–nhiệt · ưu tiên xuất theo RỦI RO XUỐNG CẤP (không dùng FEFO) · kiểm kê',
  async render(view, actions) {
    const facilities = (await guard(api('/mdm/facilities'))).filter((f) => f.kind !== 'plant');
    if (!facilities.length) {
      view.replaceChildren(alert('Chưa có Hub/kho vận hành nào. Chạy mô phỏng rồi dùng "Kết xuất Hub sang Module Warehouse" (FN-19) để tạo cơ sở vận hành đầu tiên.', 'info'));
      return;
    }
    let currentId = facilities[0].id;
    actions.append(el('label', { style: 'min-width:280px' }, [
      el('select', { onchange: (event) => { currentId = event.target.value; refresh(); } },
        facilities.map((f) => el('option', { value: f.id }, [`${f.code} — ${f.name}`]))),
    ]));

    const body = el('div', { class: 'grid' });
    view.replaceChildren(body);

    async function refresh() {
      const [environment, inventory, lots, priority, stocktakes, receipts, movement, quality] = await Promise.all([
        api(`/wh/environment?facilityId=${currentId}`), api(`/wh/reports/inventory?facilityId=${currentId}`),
        api(`/wh/lots?facilityId=${currentId}`), api(`/wh/issue-priority/${currentId}`),
        api('/wh/stocktakes'), api(`/wh/receipts?facilityId=${currentId}`),
        api(`/wh/reports/movement?facilityId=${currentId}`), api(`/wh/reports/quality?facilityId=${currentId}`),
      ]);
      const facility = facilities.find((f) => f.id === currentId);
      const thresholds = environment.thresholds ?? {};

      body.replaceChildren(
        el('div', { class: 'grid cols-4' }, [
          kpi('Tồn kho hiện tại', tons(facility.current_stock_tons), `Sức chứa ${tons(facility.capacity_tons)}`),
          kpi('Mức đầy', facility.capacity_tons > 0 ? pct((facility.current_stock_tons / facility.capacity_tons) * 100) : '—'),
          kpi('Nhập kỳ này', tons(movement.inbound?.tons ?? 0), `${num(movement.inbound?.n ?? 0)} phiếu GRN`),
          kpi('Cảnh báo đang mở', num((environment.activeAlerts ?? []).length),
            'Độ ẩm / nhiệt độ vượt ngưỡng', (environment.activeAlerts ?? []).length ? 'critical' : 'good'),
        ]),

        (environment.activeAlerts ?? []).length
          ? card('Cảnh báo môi trường (FN-10)', (environment.activeAlerts ?? []).map((item) =>
              el('div', { class: `alert ${item.level === 'nguy_hiem' ? 'bad' : 'warn'}` }, [
                `${dateTime(item.raised_at)} — ${item.message}`,
                can('warehouse.write')
                  ? el('button', {
                      class: 'ghost small', style: 'margin-left:10px',
                      text: 'Xác nhận đã xử lý',
                      onclick: async () => {
                        await guard(api(`/wh/alerts/${item.id}/ack`, { body: {} }));
                        refresh();
                      },
                    })
                  : null,
              ])))
          : null,

        el('div', { class: 'grid cols-2' }, [
          card('Giám sát môi trường theo khu vực (FN-09)', [
            el('p', { class: 'muted', text: `Ngưỡng hiện tại — độ ẩm: cảnh báo ${thresholds.humidityWarn}%, nguy hiểm ${thresholds.humidityCrit}%; nhiệt độ: cảnh báo ${thresholds.tempWarn}°C, nguy hiểm ${thresholds.tempCrit}°C (FN-37).` }),
            table(
              [
                { key: 'zone_code', label: 'Khu vực' },
                { key: 'zone_name', label: 'Tên' },
                { key: 'humidity_pct', label: 'Độ ẩm (%)', align: 'right', render: (row) => (row.humidity_pct === null ? '—' : badge(num(row.humidity_pct, 1), row.humidity_pct >= thresholds.humidityCrit ? 'bad' : row.humidity_pct >= thresholds.humidityWarn ? 'warn' : 'good')) },
                { key: 'temp_c', label: 'Nhiệt độ (°C)', align: 'right', render: (row) => (row.temp_c === null ? '—' : badge(num(row.temp_c, 1), row.temp_c >= thresholds.tempCrit ? 'bad' : row.temp_c >= thresholds.tempWarn ? 'warn' : 'good')) },
                { key: 'recorded_at', label: 'Cập nhật', render: (row) => dateTime(row.recorded_at) },
              ],
              environment.latestByZone ?? [],
              { empty: 'Chưa khai báo khu vực lưu trữ nào.' },
            ),
            can('warehouse.write')
              ? el('div', { class: 'chip-row' }, [
                  el('button', {
                    class: 'ghost small', text: '+ Khu vực lưu trữ',
                    onclick: async () => {
                      const code = prompt('Mã khu vực (VD: KV-B):');
                      if (!code) return;
                      await guard(api('/wh/zones', { body: { facilityId: currentId, code, name: `Khu vực ${code}`, capacityTons: 5000 } }));
                      refresh();
                    },
                  }),
                  el('button', {
                    class: 'ghost small', text: '📡 Mô phỏng số đo cảm biến',
                    onclick: async () => {
                      const zones = environment.latestByZone ?? [];
                      const zoneId = zones[0]?.zone_id;
                      const humidity = Number(prompt('Độ ẩm (%):', '23'));
                      const temp = Number(prompt('Nhiệt độ (°C):', '42'));
                      const result = await guard(api('/wh/sensors', {
                        body: { facilityId: currentId, zoneId, sensorId: 'IOT-DEMO', humidityPct: humidity, tempC: temp },
                      }));
                      toast(result.alerts.length ? `Sinh ${result.alerts.length} cảnh báo.` : 'Số đo trong ngưỡng an toàn.');
                      refresh();
                    },
                  }),
                ])
              : null,
          ]),

          card('Ưu tiên xuất kho theo rủi ro xuống cấp (FN-12/FN-19)', [
            el('p', { class: 'muted', text: 'Rơm không có hạn dùng nên KHÔNG dùng FEFO — thứ tự xuất tính theo tuổi lưu trữ, độ ẩm vượt ngưỡng và số lần cảnh báo môi trường của khu vực chứa lô.' }),
            table(
              [
                { key: 'code', label: 'Lô' },
                { key: 'htx_name', label: 'Nguồn gốc (HTX)' },
                { key: 'remaining_tons', label: 'Còn lại', align: 'right', render: (row) => tons(row.remaining_tons) },
                { key: 'age_days', label: 'Tuổi (ngày)', align: 'right' },
                {
                  key: 'risk_score', label: 'Điểm rủi ro', align: 'right',
                  render: (row) => badge(num(row.risk_score, 1), row.risk_score >= 60 ? 'bad' : row.risk_score >= 30 ? 'warn' : 'good'),
                },
              ],
              priority.slice(0, 15),
              { empty: 'Kho chưa có lô tồn nào.' },
            ),
          ]),
        ]),

        card('Nhập kho — cân điện tử & GRN (FN-02 → FN-06)', [
          table(
            [
              { key: 'code', label: 'Mã GRN' },
              { key: 'received_tons', label: 'Thực nhận', align: 'right', render: (row) => tons(row.received_tons) },
              { key: 'variance_tons', label: 'Lệch so với PO', align: 'right', render: (row) => (row.po_id ? tons(row.variance_tons) : '—') },
              { key: 'moisture_pct', label: 'Độ ẩm (%)', align: 'right', render: (row) => (row.moisture_pct === null ? '—' : badge(num(row.moisture_pct, 1), row.moisture_pct <= 14 ? 'good' : 'warn')) },
              {
                key: 'status', label: 'Trạng thái',
                render: (row) => (row.status === 'da_duyet'
                  ? badge('Đã duyệt', 'good')
                  : (can('warehouse.approve')
                      ? el('button', {
                          class: 'ghost small', text: 'Phê duyệt & ghi tăng tồn',
                          onclick: async () => {
                            await guard(api(`/wh/receipts/${row.id}/approve`, { body: {} }));
                            toast('Đã phê duyệt phiếu nhập — tồn kho tăng, sinh bản ghi MRV.');
                            refresh();
                          },
                        })
                      : badge('Chờ duyệt', 'warn'))),
              },
              { key: 'created_at', label: 'Tạo lúc', render: (row) => dateTime(row.created_at) },
            ],
            receipts.slice(0, 20),
            { empty: 'Chưa có phiếu nhập nào.' },
          ),
          can('warehouse.write')
            ? el('button', {
                class: 'small', text: '+ Cân nhập & tạo GRN',
                onclick: async () => {
                  const gross = Number(prompt('Khối lượng tổng (kg):', '32000'));
                  const tare = Number(prompt('Khối lượng bì (kg):', '12000'));
                  const weighing = await guard(api('/wh/weighings', {
                    body: { facilityId: currentId, direction: 'in', grossKg: gross, tareKg: tare, vehicleCode: '67C-00000' },
                  }));
                  const cooperatives = await api('/mdm/cooperatives');
                  const grn = await guard(api('/wh/receipts', {
                    body: { facilityId: currentId, weighingId: weighing.id, htxId: cooperatives[0]?.id, moisturePct: 13.5 },
                  }));
                  toast(`Đã tạo ${grn.code}: ${grn.received_tons} tấn.`);
                  refresh();
                },
              })
            : null,
        ]),

        el('div', { class: 'grid cols-2' }, [
          card('Kiểm kê (FN-20 → FN-23)', [
            table(
              [
                { key: 'code', label: 'Mã' },
                { key: 'planned_for', label: 'Kế hoạch' },
                { key: 'book_tons', label: 'Sổ sách', align: 'right', render: (row) => (row.book_tons === null ? '—' : tons(row.book_tons)) },
                { key: 'counted_tons', label: 'Thực tế', align: 'right', render: (row) => (row.counted_tons === null ? '—' : tons(row.counted_tons)) },
                { key: 'variance_tons', label: 'Chênh lệch', align: 'right', render: (row) => (row.variance_tons === null ? '—' : badge(tons(row.variance_tons), Math.abs(row.variance_tons) > 1 ? 'warn' : 'good')) },
                {
                  key: 'status', label: 'Trạng thái',
                  render: (row) => {
                    if (row.status === 'da_duyet') return badge('Đã duyệt', 'good');
                    if (row.status === 'cho_duyet' && can('warehouse.approve')) {
                      return el('button', {
                        class: 'ghost small', text: 'Duyệt & cập nhật tồn',
                        onclick: async () => {
                          await guard(api(`/wh/stocktakes/${row.id}/approve`, { body: {} }));
                          toast('Đã duyệt chênh lệch kiểm kê.');
                          refresh();
                        },
                      });
                    }
                    if (row.status === 'ke_hoach' && can('warehouse.write')) {
                      return el('button', {
                        class: 'ghost small', text: 'Nhập số đếm',
                        onclick: async () => {
                          const counted = Number(prompt('Khối lượng tồn thực tế (tấn):', '0'));
                          const reason = prompt('Nguyên nhân chênh lệch (nếu có):') ?? '';
                          await guard(api(`/wh/stocktakes/${row.id}/count`, { body: { countedTons: counted, reason } }));
                          refresh();
                        },
                      });
                    }
                    return badge(row.status, 'neutral');
                  },
                },
              ],
              stocktakes.filter((s) => s.facility_id === currentId),
              { empty: 'Chưa có phiếu kiểm kê nào.' },
            ),
            can('warehouse.write')
              ? el('button', {
                  class: 'ghost small', text: '+ Lập kế hoạch kiểm kê',
                  onclick: async () => {
                    await guard(api('/wh/stocktakes', { body: { facilityId: currentId, plannedFor: new Date().toISOString().slice(0, 10) } }));
                    refresh();
                  },
                })
              : null,
          ]),

          card('Báo cáo chất lượng lưu trữ (FN-26)', [
            el('p', { class: 'muted', text: quality.standard }),
            table(
              [
                { key: 'zone_code', label: 'Khu vực' },
                { key: 'avg_humidity', label: 'Ẩm TB', align: 'right' },
                { key: 'max_humidity', label: 'Ẩm cao nhất', align: 'right' },
                { key: 'avg_temp', label: 'Nhiệt TB', align: 'right' },
                { key: 'samples', label: 'Số mẫu', align: 'right' },
              ],
              quality.environment ?? [],
              { empty: 'Chưa có số đo cảm biến.' },
            ),
            table(
              [
                { key: 'level', label: 'Mức', render: (row) => badge(row.level === 'nguy_hiem' ? 'Nguy hiểm' : 'Cảnh báo', row.level === 'nguy_hiem' ? 'bad' : 'warn') },
                { key: 'metric', label: 'Chỉ tiêu', render: (row) => (row.metric === 'humidity' ? 'Độ ẩm' : 'Nhiệt độ') },
                { key: 'n', label: 'Số lần', align: 'right' },
              ],
              quality.alertCounts ?? [],
              { empty: 'Chưa có cảnh báo nào.' },
            ),
          ]),
        ]),

        card('Tồn kho theo khu vực & lô (FN-24)', table(
          [
            { key: 'zone_code', label: 'Khu vực' },
            { key: 'zone_name', label: 'Tên' },
            { key: 'capacity_tons', label: 'Sức chứa', align: 'right', render: (row) => tons(row.capacity_tons) },
            { key: 'stock_tons', label: 'Tồn', align: 'right', render: (row) => tons(row.stock_tons) },
            {
              key: 'fill', label: 'Mức đầy',
              render: (row) => el('div', { class: 'bar' }, [
                el('span', { style: `width:${row.capacity_tons > 0 ? Math.min(100, (row.stock_tons / row.capacity_tons) * 100) : 0}%` }),
              ]),
            },
          ],
          inventory.byZone ?? [],
        )),
      );
    }

    await refresh();
  },
});

// ===========================================================================
// Mua hàng / Bán hàng
// ===========================================================================

registerPage('trade', {
  title: 'Mua hàng (PO) & Bán hàng (SO)',
  subtitle: 'PR → PO → GRN → đối soát 3 chiều → đề nghị thanh toán · SO → giao hàng → hoá đơn → thu tiền',
  async render(view) {
    const [purchaseOrders, salesOrders, purchaseReport, salesReport, cooperatives, partners, facilities] = await Promise.all([
      guard(api('/po')), api('/so'), api('/po/reports/summary'), api('/so/reports/summary'),
      api('/mdm/cooperatives'), api('/mdm/partners'), api('/mdm/facilities'),
    ]);
    const hubs = facilities.filter((f) => f.kind !== 'plant');

    view.replaceChildren(
      card('Đơn mua từ HTX (Procure-to-Pay)', [
        table(
          [
            { key: 'code', label: 'Mã PO' },
            { key: 'htx_name', label: 'HTX cung ứng' },
            { key: 'facility_name', label: 'Giao về' },
            { key: 'ordered_tons', label: 'Khối lượng', align: 'right', render: (row) => tons(row.ordered_tons) },
            { key: 'unit_price', label: 'Đơn giá', align: 'right', render: (row) => vnd(row.unit_price) },
            { key: 'value', label: 'Giá trị', align: 'right', render: (row) => vnd(row.ordered_tons * row.unit_price, { compact: true }) },
            {
              key: 'status', label: 'Trạng thái',
              render: (row) => (row.status === 'nhap' && can('procurement.write')
                ? el('button', {
                    class: 'ghost small', text: 'Duyệt PO',
                    onclick: async () => {
                      await guard(api(`/po/${row.id}/approve`, { body: {} }));
                      toast('Đã duyệt đơn mua.');
                    },
                  })
                : badge(PO_STATUS[row.status] ?? row.status, row.status === 'duyet' ? 'good' : 'neutral')),
            },
            {
              key: 'match', label: 'Đối soát 3 chiều',
              render: (row) => el('button', {
                class: 'ghost small', text: 'Xem',
                onclick: async () => {
                  const match = await guard(api(`/po/${row.id}/match`));
                  alertDialog(`Đơn ${match.po.code}\n\nĐặt: ${match.po.ordered_tons} tấn\nĐã nhận (GRN duyệt): ${match.receivedTons} tấn (${match.receiptCount} phiếu)\nChênh lệch: ${match.varianceTons} tấn (${match.variancePct}%)\nPhải trả: ${vnd(match.payableAmount)}\nĐã ghi sổ: ${vnd(match.postedAmount)}\nKhớp: ${match.matched ? 'Có' : 'Chưa'}`);
                },
              }),
            },
          ],
          purchaseOrders,
          { empty: 'Chưa có đơn mua nào.' },
        ),
      ], can('procurement.write') ? el('button', {
        class: 'small', text: '+ Tạo đơn mua',
        onclick: async () => {
          const tonsInput = Number(prompt('Khối lượng đặt mua (tấn):', '500'));
          if (!tonsInput) return;
          const price = Number(prompt('Đơn giá (VNĐ/tấn):', '900000'));
          await guard(api('/po', {
            body: { htxId: cooperatives[0].id, facilityId: hubs[0]?.id ?? facilities[0].id, orderedTons: tonsInput, unitPrice: price },
          }));
          toast('Đã tạo đơn mua.');
        },
      }) : null),

      card('Đơn bán đầu ra (Order-to-Cash)', [
        table(
          [
            { key: 'code', label: 'Mã SO' },
            { key: 'partner_name', label: 'Khách hàng' },
            { key: 'facility_name', label: 'Xuất từ' },
            { key: 'ordered_tons', label: 'Khối lượng', align: 'right', render: (row) => tons(row.ordered_tons) },
            { key: 'unit_price', label: 'Đơn giá', align: 'right', render: (row) => vnd(row.unit_price) },
            { key: 'delivery_date', label: 'Ngày giao' },
            { key: 'status', label: 'Trạng thái', render: (row) => badge(SO_STATUS[row.status] ?? row.status, row.status === 'hoan_tat' ? 'good' : 'neutral') },
          ],
          salesOrders,
          { empty: 'Chưa có đơn bán nào.' },
        ),
      ], can('sales.write') ? el('button', {
        class: 'small', text: '+ Tạo đơn bán',
        onclick: async () => {
          const tonsInput = Number(prompt('Khối lượng bán (tấn):', '300'));
          if (!tonsInput) return;
          const price = Number(prompt('Đơn giá (VNĐ/tấn):', '1400000'));
          const result = await guard(api('/so', {
            body: { partnerId: partners.find((p) => p.kind === 'customer').id, facilityId: hubs[0]?.id ?? facilities[0].id, orderedTons: tonsInput, unitPrice: price },
          }));
          if (result.stockWarning) toast(result.stockWarning, true);
          else toast('Đã tạo đơn bán.');
        },
      }) : null),

      el('div', { class: 'grid cols-2' }, [
        card('Báo cáo mua hàng theo HTX', table(
          [
            { key: 'code', label: 'Mã HTX' },
            { key: 'name', label: 'HTX' },
            { key: 'orders', label: 'Số đơn', align: 'right' },
            { key: 'ordered_tons', label: 'Khối lượng', align: 'right', render: (row) => tons(row.ordered_tons) },
            { key: 'amount', label: 'Giá trị', align: 'right', render: (row) => vnd(row.amount, { compact: true }) },
          ],
          purchaseReport.byHtx ?? [],
        )),
        card('Báo cáo bán hàng theo khách hàng', table(
          [
            { key: 'code', label: 'Mã' },
            { key: 'name', label: 'Khách hàng' },
            { key: 'orders', label: 'Số đơn', align: 'right' },
            { key: 'tons', label: 'Khối lượng', align: 'right', render: (row) => tons(row.tons) },
            { key: 'revenue', label: 'Doanh thu', align: 'right', render: (row) => vnd(row.revenue, { compact: true }) },
          ],
          salesReport.byPartner ?? [],
        )),
      ]),
    );
  },
});

const PO_STATUS = { nhap: 'Nháp', duyet: 'Đã duyệt', dang_giao: 'Đang giao', hoan_thanh: 'Hoàn thành', huy: 'Huỷ' };
const SO_STATUS = { nhap: 'Nháp', xac_nhan: 'Đã xác nhận', dang_giao: 'Đang giao', da_giao: 'Đã giao', hoan_tat: 'Hoàn tất' };

function alertDialog(message) {
  window.alert(message);
}

// ===========================================================================
// TMS
// ===========================================================================

registerPage('tms', {
  title: 'Điều phối vận tải (TMS)',
  subtitle: 'Routing đa tiêu chí đường bộ/thuỷ trên mạng lưới đã số hoá · ePOD/e-bill · đối chiếu chi phí thực tế vs kế hoạch',
  async render(view) {
    const [trips, variance, facilities] = await Promise.all([
      guard(api('/tms/trips')), api('/tms/cost-variance'), api('/mdm/facilities'),
    ]);

    const plannerBox = el('div');
    const totals = variance.totals ?? {};

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Số chuyến', num(totals.trips ?? 0)),
        kpi('Chi phí kế hoạch', vnd(totals.planned ?? 0, { compact: true })),
        kpi('Chi phí thực tế', vnd(totals.actual ?? 0, { compact: true }),
          variance.variancePct === null ? '' : `Lệch ${pct(variance.variancePct)}`,
          (variance.variance ?? 0) > 0 ? 'warning' : 'good'),
        kpi('Phát thải vận tải', `${num((totals.co2 ?? 0) / 1000, 2)} tấn CO₂`, 'Hệ số IPCC theo phương thức'),
      ]),

      card('Định tuyến đa tiêu chí', [
        el('div', { class: 'row' }, [
          el('label', {}, ['Điểm đi', el('select', { id: 'tms-from' }, facilities.map((f) => el('option', { value: f.id }, [f.name])))]),
          el('label', {}, ['Điểm đến', el('select', { id: 'tms-to' }, facilities.map((f) => el('option', { value: f.id, selected: f.kind === 'plant' }, [f.name])))]),
          el('label', {}, ['Khối lượng (tấn)', el('input', { id: 'tms-tons', type: 'number', value: '300' })]),
          el('label', {}, ['Tiêu chí', el('select', { id: 'tms-criteria' }, [
            el('option', { value: 'cost' }, ['Chi phí thấp nhất']),
            el('option', { value: 'time' }, ['Thời gian ngắn nhất']),
            el('option', { value: 'emission' }, ['Phát thải thấp nhất']),
          ])]),
          el('button', { class: 'small', text: 'Tính tuyến', onclick: () => plan() }),
        ]),
        plannerBox,
      ]),

      card('Chuyến vận chuyển', table(
        [
          { key: 'code', label: 'Mã chuyến' },
          { key: 'mode', label: 'Phương thức', render: (row) => badge(row.mode === 'waterway' ? 'Đường thuỷ' : 'Đường bộ', row.mode === 'waterway' ? 'info' : 'neutral') },
          { key: 'from_label', label: 'Từ' },
          { key: 'to_label', label: 'Đến' },
          { key: 'distance_km', label: 'Cự ly (km)', align: 'right', render: (row) => num(row.distance_km, 1) },
          { key: 'planned_tons', label: 'KH (tấn)', align: 'right', render: (row) => num(row.planned_tons) },
          { key: 'actual_tons', label: 'TT (tấn)', align: 'right', render: (row) => num(row.actual_tons) },
          { key: 'planned_cost', label: 'CP kế hoạch', align: 'right', render: (row) => vnd(row.planned_cost, { compact: true }) },
          { key: 'actual_cost', label: 'CP thực tế', align: 'right', render: (row) => vnd(row.actual_cost, { compact: true }) },
          { key: 'co2_kg', label: 'CO₂ (kg)', align: 'right', render: (row) => num(row.co2_kg) },
          {
            key: 'status', label: 'Trạng thái',
            render: (row) => {
              if (!can('tms.write')) return badge(TRIP_STATUS[row.status] ?? row.status, 'neutral');
              if (row.status === 'ke_hoach') {
                return el('button', {
                  class: 'ghost small', text: 'Xuất phát',
                  onclick: async () => { await guard(api(`/tms/trips/${row.id}/depart`, { body: {} })); toast('Chuyến đã xuất phát.'); },
                });
              }
              if (row.status === 'dang_chay') {
                return el('button', {
                  class: 'ghost small', text: 'Hoàn thành',
                  onclick: async () => {
                    const actual = Number(prompt('Khối lượng thực giao (tấn):', String(row.planned_tons)));
                    await guard(api(`/tms/trips/${row.id}/complete`, { body: { actualTons: actual } }));
                    toast('Đã hoàn thành chuyến — sinh bản ghi MRV.');
                  },
                });
              }
              return badge(TRIP_STATUS[row.status] ?? row.status, 'good');
            },
          },
        ],
        trips,
        { empty: 'Chưa có chuyến vận chuyển nào.' },
      )),

      card('Đối chiếu chi phí theo phương thức', table(
        [
          { key: 'mode', label: 'Phương thức', render: (row) => (row.mode === 'waterway' ? 'Đường thuỷ' : 'Đường bộ') },
          { key: 'trips', label: 'Số chuyến', align: 'right' },
          { key: 'planned', label: 'Kế hoạch', align: 'right', render: (row) => vnd(row.planned, { compact: true }) },
          { key: 'actual', label: 'Thực tế', align: 'right', render: (row) => vnd(row.actual, { compact: true }) },
          { key: 'tons', label: 'Khối lượng', align: 'right', render: (row) => tons(row.tons) },
          { key: 'co2_kg', label: 'CO₂ (kg)', align: 'right', render: (row) => num(row.co2_kg) },
        ],
        variance.byMode ?? [],
      )),
    );

    async function plan() {
      const fromId = document.getElementById('tms-from').value;
      const toId = document.getElementById('tms-to').value;
      const from = facilities.find((f) => f.id === fromId);
      const to = facilities.find((f) => f.id === toId);
      const tonsValue = Number(document.getElementById('tms-tons').value);
      const criteria = document.getElementById('tms-criteria').value;
      const result = await guard(api('/tms/plan-route', {
        body: { from: { lat: from.lat, lng: from.lng }, to: { lat: to.lat, lng: to.lng }, tons: tonsValue, criteria },
      }));
      plannerBox.replaceChildren(
        table(
          [
            { key: 'mode', label: 'Phương thức', render: (row) => (row.mode === 'waterway' ? 'Đường thuỷ' : 'Đường bộ') },
            { key: 'available', label: 'Khả dụng', render: (row) => badge(row.available ? 'Có' : 'Không tiếp giáp mạng lưới', row.available ? 'good' : 'bad') },
            { key: 'distanceKm', label: 'Cự ly (km)', align: 'right', render: (row) => num(row.distanceKm, 1) },
            { key: 'sourceLabel', label: 'Nguồn tính', render: (row) => badge(row.sourceLabel, row.sourceLabel.includes('Haversine') ? 'warn' : 'good') },
            { key: 'cost', label: 'Chi phí', align: 'right', render: (row) => vnd(row.cost) },
            { key: 'leadTimeHours', label: 'Lead time (h)', align: 'right', render: (row) => num(row.leadTimeHours, 1) },
            { key: 'trips', label: 'Số chuyến', align: 'right' },
            { key: 'co2Kg', label: 'CO₂ (kg)', align: 'right', render: (row) => num(row.co2Kg) },
          ],
          result.options,
          { rowClass: (row) => (row.mode === result.recommended?.mode ? 'highlight' : null) },
        ),
        result.recommended
          ? el('div', { class: 'chip-row' }, [
              alert(`Khuyến nghị theo tiêu chí đã chọn: ${result.recommended.mode === 'waterway' ? 'Đường thuỷ' : 'Đường bộ'}.`, 'good'),
              can('tms.write')
                ? el('button', {
                    class: 'small', text: '+ Tạo chuyến theo khuyến nghị',
                    onclick: async () => {
                      await guard(api('/tms/trips', {
                        body: {
                          mode: result.recommended.mode,
                          from: { lat: from.lat, lng: from.lng }, to: { lat: to.lat, lng: to.lng },
                          fromLabel: from.name, toLabel: to.name, plannedTons: tonsValue,
                        },
                      }));
                      toast('Đã tạo chuyến vận chuyển.');
                    },
                  })
                : null,
            ])
          : alert('Không có phương thức khả dụng cho cặp điểm này.', 'warn'),
        el('p', { class: 'muted', text: result.note }),
      );
    }
  },
});

const TRIP_STATUS = { ke_hoach: 'Kế hoạch', dang_chay: 'Đang chạy', hoan_thanh: 'Hoàn thành', huy: 'Huỷ' };

// ===========================================================================
// Tài chính & MRV
// ===========================================================================

registerPage('finance', {
  title: 'Tài chính, Revenue Engine & MRV',
  subtitle: 'Đối soát công nợ đa bên · 3 mô hình doanh thu · so sánh CAPEX/OPEX thực tế với dự phóng mô phỏng',
  async render(view) {
    const year = new Date().getUTCFullYear();
    const [pnl, reconciliation, rules, entries, mrv, facilities] = await Promise.all([
      guard(api(`/reports/finance?from=${year}-01-01&to=${year}-12-31`)),
      api('/finance/reconciliation'), api('/finance/revenue-rules'),
      api('/finance/entries'), api('/mrv/summary'), api('/mdm/facilities'),
    ]);
    const totals = mrv.totals ?? {};
    const operating = facilities.filter((f) => f.origin_scenario_id);

    const varianceBox = el('div');

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Doanh thu', vnd(pnl.pnl?.revenue ?? 0, { compact: true }), `Kỳ ${year}`),
        kpi('Chi phí', vnd(pnl.pnl?.expense ?? 0, { compact: true })),
        kpi('Phải thu (AR)', vnd(pnl.pnl?.receivables ?? 0, { compact: true })),
        kpi('Phải trả (AP)', vnd(pnl.pnl?.payables ?? 0, { compact: true })),
      ]),

      card('Ranh giới kiến trúc', alert('Payment (Core Service) vận hành cổng thanh toán / ví giữ tiền / giải ngân dùng chung cho mọi sàn. Finance chỉ tiêu thụ kết quả giao dịch để tính phí, đối soát công nợ và kế toán — không triển khai lại hạ tầng thanh toán.', 'info')),

      el('div', { class: 'grid cols-2' }, [
        card('Công nợ phải trả HTX', table(
          [
            { key: 'code', label: 'Mã HTX' },
            { key: 'name', label: 'HTX' },
            { key: 'total', label: 'Còn phải trả', align: 'right', render: (row) => vnd(row.total, { compact: true }) },
          ],
          reconciliation.payablesByHtx ?? [],
          { empty: 'Không có công nợ phải trả.' },
        )),
        card('Công nợ phải thu khách hàng', table(
          [
            { key: 'code', label: 'Mã' },
            { key: 'name', label: 'Khách hàng' },
            { key: 'total', label: 'Còn phải thu', align: 'right', render: (row) => vnd(row.total, { compact: true }) },
          ],
          reconciliation.receivablesByPartner ?? [],
          { empty: 'Không có công nợ phải thu.' },
        )),
      ]),

      card('Revenue Engine — 3 mô hình kiếm tiền', table(
        [
          { key: 'code', label: 'Mã' },
          { key: 'name', label: 'Quy tắc' },
          { key: 'kind', label: 'Loại', render: (row) => badge(REVENUE_KIND[row.kind] ?? row.kind, 'neutral') },
          { key: 'applies_to', label: 'Áp dụng cho' },
          { key: 'rate_pct', label: 'Tỷ lệ', align: 'right', render: (row) => (row.rate_pct === null ? '—' : pct(row.rate_pct, 0)) },
          { key: 'fixed_amount', label: 'Cố định', align: 'right', render: (row) => (row.fixed_amount === null ? '—' : vnd(row.fixed_amount, { compact: true })) },
          { key: 'active', label: 'Hiệu lực', render: (row) => badge(row.active ? 'Đang áp dụng' : 'Tắt', row.active ? 'good' : 'neutral') },
        ],
        rules,
      )),

      card('Theo dõi hậu đầu tư — CAPEX/OPEX thực tế vs dự phóng mô phỏng (SM-04)', [
        operating.length
          ? el('div', { class: 'row' }, [
              el('label', {}, ['Cơ sở vận hành', el('select', {
                id: 'variance-facility',
                onchange: (event) => loadVariance(event.target.value),
              }, operating.map((f) => el('option', { value: f.id }, [f.name])))]),
            ])
          : alert('Chưa có cơ sở nào được kết xuất từ kịch bản mô phỏng (FN-19) để đối chiếu.', 'info'),
        varianceBox,
      ]),

      el('div', { class: 'grid cols-2' }, [
        card('Dữ liệu MRV & tín chỉ carbon', [
          el('div', { class: 'grid cols-2' }, [
            kpi('CO₂ tránh được', `${num((totals.co2_avoided_kg ?? 0) / 1000, 2)} tấn`, 'Đốt rơm ngoài đồng (IPCC EFDB)'),
            kpi('CO₂ phát thải vận tải', `${num((totals.co2_emitted_kg ?? 0) / 1000, 2)} tấn`),
          ]),
          table(
            [
              { key: 'source_module', label: 'Phân hệ' },
              { key: 'n', label: 'Bản ghi', align: 'right' },
              { key: 'tons', label: 'Khối lượng', align: 'right', render: (row) => tons(row.tons) },
            ],
            mrv.byModule ?? [],
          ),
          can('mrv.write')
            ? el('button', {
                class: 'ghost small', text: '⇪ Đồng bộ lên Data Lakehouse',
                onclick: async () => {
                  const result = await guard(api('/mrv/sync-lakehouse', { body: {} }));
                  toast(`Đã đẩy ${result.recordCount} bản ghi MRV (${result.status}).`);
                },
              })
            : null,
        ]),
        card('Sổ cái gần đây', table(
          [
            { key: 'entry_date', label: 'Ngày' },
            { key: 'account', label: 'Tài khoản', render: (row) => badge(row.account, ACCOUNT_TONE[row.account] ?? 'neutral') },
            { key: 'description', label: 'Diễn giải' },
            { key: 'amount', label: 'Số tiền', align: 'right', render: (row) => vnd(row.amount, { compact: true }) },
            { key: 'status', label: 'Trạng thái', render: (row) => badge(row.status === 'da_thanh_toan' ? 'Đã thanh toán' : 'Ghi sổ', row.status === 'da_thanh_toan' ? 'good' : 'neutral') },
          ],
          entries.slice(0, 25),
          { empty: 'Sổ cái chưa có bút toán nào.' },
        )),
      ]),
    );

    async function loadVariance(facilityId) {
      const data = await guard(api(`/finance/budget-vs-actual/${facilityId}`));
      varianceBox.replaceChildren(
        data.planned
          ? el('div', {}, [
              el('div', { class: 'grid cols-4' }, [
                kpi('CAPEX dự phóng', vnd(data.planned.capex, { compact: true })),
                kpi('CAPEX thực tế', vnd(data.actual.capex, { compact: true }),
                  data.variance?.capexPct === null ? '' : `Lệch ${pct(data.variance.capexPct)}`),
                kpi('OPEX dự phóng', vnd(data.planned.opex, { compact: true })),
                kpi('OPEX thực tế', vnd(data.actual.opex, { compact: true }),
                  data.variance?.opexPct === null ? '' : `Lệch ${pct(data.variance.opexPct)}`),
              ]),
              el('p', { class: 'muted', text: data.note }),
            ])
          : alert(data.note, 'info'),
      );
    }

    if (operating.length) await loadVariance(operating[0].id);
  },
});

const REVENUE_KIND = {
  transaction_fee: 'Phí giao dịch', subscription: 'Subscription / Data Licensing', carbon_share: 'Chia sẻ doanh thu carbon',
};
const ACCOUNT_TONE = { AP: 'warn', AR: 'info', REVENUE: 'good', EXPENSE: 'neutral', CAPEX: 'neutral' };
