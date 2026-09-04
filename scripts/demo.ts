/**
 * Kịch bản trình diễn end-to-end: dựng 3 phương án đầu tư Hub, chạy mô phỏng,
 * so sánh theo TCO per Ton, chạy phân tích độ nhạy, rồi chuyển Hub tốt nhất
 * sang vận hành kho.
 *
 * Chạy: node scripts/demo.ts
 */
import { migrate } from '../src/platform/db/schema.ts';
import { seedIfEmpty } from '../src/seed.ts';
import { all, one } from '../src/platform/db/db.ts';
import * as params from '../src/erp/params/store.ts';
import * as sim from '../src/erp/simulation/service.ts';
import * as warehouse from '../src/erp/warehouse/service.ts';
import * as procurement from '../src/erp/procurement/service.ts';
import * as tms from '../src/erp/tms/service.ts';
import { balanceSupplyDemand, listMachines } from '../src/agrigreen/cgh/service.ts';
import * as rental from '../src/agrigreen/rental/service.ts';
import * as sales from '../src/erp/sales/service.ts';

const actor = { name: 'demo-script' };
const vnd = (value: number | null): string =>
  value === null ? 'Không xác định' : `${Math.round(value).toLocaleString('vi-VN')} đ`;
const tons = (value: number): string => `${Math.round(value).toLocaleString('vi-VN')} tấn`;

migrate();
seedIfEmpty();

console.log('\n═══ 1. Đặt Hub ứng viên trên bản đồ (FN-02) ═══');
// Các vị trí ứng viên đặt sát tuyến đường thuỷ đã số hoá — đây là lựa chọn có
// chủ đích: chỉ khi Hub tiếp giáp mạng lưới kênh rạch thì FN-08 BR-04 mới kích
// hoạt được phương án sà lan cho chặng dài Hub→Nhà máy.
const hubSpecs = [
  { name: 'Hub Long Xuyên (sông Hậu)', lat: 10.3800, lng: 105.4350 },
  { name: 'Hub Cần Thơ (sông Hậu)', lat: 10.0330, lng: 105.7830 },
  { name: 'Hub Cao Lãnh (sông Tiền)', lat: 10.4600, lng: 105.6400 },
  { name: 'Hub Mỹ Tho (sông Tiền)', lat: 10.3500, lng: 106.3600 },
  { name: 'Hub Bến Lức (Vàm Cỏ Đông)', lat: 10.7200, lng: 106.4000 },
];

const hubs = hubSpecs.map((spec) => {
  const existing = one<{ id: string; name: string }>('SELECT id, name FROM candidate_hubs WHERE name = ?', [spec.name]);
  if (existing) return existing;
  const hub = sim.createCandidateHub(spec, actor);
  console.log(`  ✓ ${hub.code} — ${hub.name} (${hub.lat}, ${hub.lng})`);
  return { id: hub.id, name: hub.name };
});

console.log('\n═══ 2. Dựng 3 kịch bản đầu tư (FN-14) ═══');
const plans: { name: string; hubIndexes: number[]; radius: number; capacity: number }[] = [
  { name: 'Phương án 2 Hub', hubIndexes: [0, 2], radius: 40, capacity: 90_000 },
  { name: 'Phương án 3 Hub', hubIndexes: [0, 1, 2], radius: 35, capacity: 70_000 },
  { name: 'Phương án 5 Hub', hubIndexes: [0, 1, 2, 3, 4], radius: 28, capacity: 45_000 },
];

const scenarioIds: string[] = [];
for (const plan of plans) {
  let scenario = one<{ id: string; code: string }>('SELECT id, code FROM scenarios WHERE name = ?', [plan.name]);
  if (!scenario) {
    const created = sim.createScenario({ name: plan.name, lifecycleYears: 10, discounted: false }, actor);
    scenario = { id: created.id, code: created.code };
  }
  for (const index of plan.hubIndexes) {
    sim.attachHub(scenario.id, hubs[index].id, { serviceRadiusKm: plan.radius, designCapacityTons: plan.capacity }, actor);
  }
  scenarioIds.push(scenario.id);
  console.log(`  ✓ ${scenario.code} — ${plan.name}: ${plan.hubIndexes.length} Hub, bán kính ${plan.radius} km`);
}

console.log('\n═══ 3. Chạy mô phỏng (FN-04 → FN-12, FN-17) ═══');
for (const id of scenarioIds) {
  const result = sim.runSimulation(id, {}, actor);
  console.log(`\n  ▸ ${result.scenarioName} — bộ tham số v${result.parameterSetVersion}`);
  console.log(`    Số HTX phục vụ           : ${result.hubs.reduce((n, h) => n + h.cooperativeCount, 0)}`);
  console.log(`    Total Available Supply   : ${tons(result.totalAvailableTons)}`);
  console.log(`    Collectable Supply       : ${tons(result.collectableTons)}`);
  console.log(`    Delivered Supply         : ${tons(result.deliveredTons)}`);
  console.log(`    Đáp ứng nhu cầu nhà máy  : ${result.plantDemandCoveragePct}%`);
  console.log(`    CAPEX                    : ${vnd(result.capex.total)}`);
  console.log(`    OPEX năm 1               : ${vnd(result.opex.total)}`);
  console.log(`    Collection Cost          : ${vnd(result.costs.collectionCost)}`);
  console.log(`    Transportation Cost      : ${vnd(result.costs.transportationCost)} ` +
              `(Ruộng→Hub ${vnd(result.costs.transportationFieldHub)}, Hub→NM ${vnd(result.costs.transportationHubPlant)})`);
  console.log(`    Warehouse / Handling     : ${vnd(result.costs.warehouseCost)} / ${vnd(result.costs.handlingCost)}`);
  console.log(`    Total Delivered Logistics: ${vnd(result.costs.totalDeliveredLogisticsCost)}`);
  console.log(`    Cost per Ton             : ${vnd(result.costs.costPerTon)} (${result.costs.costPerTonNote})`);
  console.log(`    TCO (10 năm)             : ${vnd(result.financial.tco)}`);
  console.log(`    TCO per Ton  ★           : ${vnd(result.financial.tcoPerTon)}`);
  console.log(`    Baseline Cost/Ton        : ${vnd(result.financial.baselineCostPerTon)} — ${result.financial.baselineSourceLabel}`);
  console.log(`    ROI                      : ${result.financial.roiPct === null ? 'Thiếu baseline' : `${result.financial.roiPct}%`}`);
  console.log(`    Payback                  : ${describePayback(result.financial.paybackStatus, result.financial.paybackYears)}`);
  if (result.warnings.length) {
    console.log(`    Cảnh báo (${result.warnings.length}):`);
    for (const warning of result.warnings.slice(0, 3)) console.log(`      • ${warning}`);
  }
}

console.log('\n═══ 4. So sánh & xếp hạng theo TCO per Ton (FN-14 BR-03) ═══');
const comparison = sim.compareScenarios(scenarioIds);
if (comparison.blocked) {
  console.log(`  ⛔ ${comparison.blocked}`);
} else {
  console.log('  Hạng  Kịch bản                              Hub   Delivered      TCO/Ton   Vòng đời/tấn      Cost/Ton  Đáp ứng');
  comparison.rows.forEach((row, index) => {
    console.log(
      `  ${String(index + 1).padStart(4)}  ${row.name.padEnd(36).slice(0, 36)}  ${String(row.hubCount).padStart(3)}  ` +
      `${tons(row.deliveredTons).padStart(12)}  ${vnd(row.tcoPerTon).padStart(11)}  ${vnd(row.lifecycleCostPerTon).padStart(13)}  ` +
      `${vnd(row.costPerTon).padStart(12)}  ${String(row.plantDemandCoveragePct).padStart(6)}%`,
    );
  });
  for (const warning of comparison.warnings) console.log(`  ⚠ ${warning}`);
}

console.log('\n═══ 5. Khuyến nghị đầu tư (FN-15) ═══');
const best = comparison.rows.find((row) => !row.isBaselineColumn);
if (best) {
  const recommendation = sim.recommend(best.scenarioId);
  console.log(`  ${recommendation.label}`);
  for (const reason of recommendation.reasons) console.log(`    • ${reason}`);
}

console.log('\n═══ 6. Phân tích độ nhạy (FN-18) ═══');
if (best) {
  const sensitivity = sim.runSensitivity(best.scenarioId, undefined, actor);
  console.log(`  Phương pháp: ${sensitivity.method}`);
  console.log(`  Biên độ lớn nhất so với chi phí vòng đời/tấn gốc: ${sensitivity.swingPct}%` +
              `${sensitivity.highSensitivity ? '  ⚠ Kết quả phụ thuộc mạnh vào giả định' : ''}`);
  console.log('  Tornado (5 tham số ảnh hưởng lớn nhất — theo chi phí vòng đời đầy đủ chuỗi/tấn):');
  for (const row of sensitivity.rows.slice(0, 5)) {
    console.log(`    #${String(row.number).padStart(2)} ${row.name.padEnd(46).slice(0, 46)} ` +
                `${vnd(row.lifecycleCostPerTon.min).padStart(13)} … ${vnd(row.lifecycleCostPerTon.max).padStart(13)}  (biên độ ${vnd(row.swing)})`);
  }
  if (sensitivity.skipped.length) {
    console.log(`  Bị loại khỏi phân tích: ${sensitivity.skipped.map((s) => s.name).join(', ')}`);
  }
}

console.log('\n═══ 7. Kiểm soát tham số giả định (FN-01 BR-02 / BR-04) ═══');
const unapproved = params.unapprovedAssumptions();
console.log(`  Tham số giả định chưa phê duyệt: ${unapproved.length}/49`);
try {
  if (best) sim.markOfficial(best.scenarioId, actor);
} catch (error) {
  console.log(`  ⛔ ${(error as Error).message.slice(0, 180)}…`);
}
console.log('  → Phê duyệt toàn bộ tham số giả định rồi thử lại:');
const approval = params.approveAllAssumptions('Trưởng bộ phận Tài chính', actor);
console.log(approval.approved
  ? `  ✓ Đã phê duyệt ${approval.approved} tham số — sinh bộ tham số v${approval.version}.`
  : `  ✓ Không còn tham số giả định nào chờ duyệt — giữ nguyên bộ tham số v${approval.version}.`);
if (best) {
  // FN-14 BR-04: tính lại kịch bản theo bộ tham số hiện tại (các lần phê duyệt
  // ở trên đã sinh ra phiên bản bộ tham số mới).
  sim.recalculateWithCurrentParams(best.scenarioId, actor);
  sim.markOfficial(best.scenarioId, actor);
  console.log('  ✓ Kịch bản đã được đánh dấu "Chính thức".');
}

console.log('\n═══ 8. Kết xuất Hub sang Module Warehouse (FN-19) ═══');
let facilityId: string | null = null;
if (best) {
  const result = sim.latestResult(best.scenarioId)!;
  const topHub = result.hubs.slice().sort((a, b) => b.deliveredTons - a.deliveredTons)[0];
  const handover = sim.exportHubToWarehouse(best.scenarioId, topHub.hubId, actor) as { facilityId: string; payload: any };
  facilityId = handover.facilityId;
  console.log(`  ✓ ${topHub.name} → cơ sở vận hành ${handover.payload.hubCode}`);
  console.log(`    Sức chứa ${tons(handover.payload.warehouseCapacityTons)} · kho ${Math.round(handover.payload.warehouseAreaM2).toLocaleString('vi-VN')} m²` +
              ` · sân bãi ${Math.round(handover.payload.yardAreaM2).toLocaleString('vi-VN')} m²` +
              ` · ${handover.payload.balePressCount} máy ép kiện · ${handover.payload.forkliftCount} xe nâng`);
}

console.log('\n═══ 9. Vòng vận hành kho (Warehouse FN-02 → FN-12) ═══');
if (facilityId) {
  const zone = warehouse.addStorageZone({ facilityId, code: 'KV-A', name: 'Khu vực A — kho có mái', zoneType: 'covered', capacityTons: 8_000 }, actor);
  const htx = one<{ id: string }>('SELECT id FROM cooperatives ORDER BY code LIMIT 1')!;
  const po = procurement.createPurchaseOrder(
    { htxId: htx.id, facilityId, orderedTons: 20, unitPrice: 900_000, expectedDate: new Date().toISOString().slice(0, 10) },
    actor,
  ) as { id: string; code: string };
  procurement.approvePurchaseOrder(po.id, actor);

  const weighing = warehouse.recordWeighing({ facilityId, direction: 'in', grossKg: 32_400, tareKg: 12_000, vehicleCode: '67C-12345' }, actor) as { id: string };
  const grn = warehouse.createGoodsReceipt(
    { facilityId, poId: po.id, zoneId: String(zone.id), htxId: htx.id, weighingId: weighing.id, moisturePct: 13.4, impurityPct: 3.1 },
    actor,
  ) as { id: string; code: string; received_tons: number; variancePct: number; requiresVarianceReport: boolean };
  console.log(`  ✓ ${po.code} → ${grn.code}: nhận ${grn.received_tons} tấn (lệch ${grn.variancePct}% so với PO` +
              `${grn.requiresVarianceReport ? ' — cần lập biên bản' : ''})`);
  warehouse.approveGoodsReceipt(grn.id, actor);

  const reading = warehouse.ingestSensorReading({ facilityId, zoneId: String(zone.id), sensorId: 'IOT-A1', humidityPct: 23.5, tempC: 41.2 });
  for (const alert of reading.alerts) console.log(`  ⚠ [${(alert as any).level}] ${(alert as any).message}`);

  const priority = warehouse.suggestedIssueOrder(facilityId);
  console.log(`  Ưu tiên xuất kho theo rủi ro xuống cấp: ${priority.length} lô, lô đầu ${priority[0]?.code} (điểm rủi ro ${priority[0]?.risk_score})`);

  const match = procurement.threeWayMatch(po.id) as any;
  console.log(`  Đối soát 3 chiều: đặt ${match.po.ordered_tons} tấn · nhận ${match.receivedTons} tấn · phải trả ${vnd(match.payableAmount)}`);
}

console.log('\n═══ 10. TMS — định tuyến đa tiêu chí ═══');
if (facilityId) {
  const facility = one<{ lat: number; lng: number; name: string }>('SELECT lat, lng, name FROM facilities WHERE id = ?', [facilityId])!;
  const plant = one<{ lat: number; lng: number }>("SELECT lat, lng FROM facilities WHERE kind = 'plant' LIMIT 1")!;
  const plan = tms.planRoute({ from: { lat: facility.lat, lng: facility.lng }, to: { lat: plant.lat, lng: plant.lng }, tons: 300 }) as any;
  for (const option of plan.options) {
    console.log(`  ${option.mode === 'road' ? 'Đường bộ ' : 'Đường thủy'}: ${option.distanceKm} km · ${vnd(option.cost)} · ` +
                `${option.leadTimeHours} h · ${option.co2Kg} kgCO2 · ${option.sourceLabel}${option.available ? '' : ' (không khả dụng)'}`);
  }
  console.log(`  → Khuyến nghị theo chi phí: ${plan.recommended?.mode ?? 'không có'}`);
}

console.log('\n═══ 11. Sàn cơ giới hoá — vòng đời lệnh thuê ═══');
{
  const machines = listMachines({ condition: 'hoat_dong' }).slice(0, 6);
  const htx = one<{ id: string }>('SELECT id FROM cooperatives ORDER BY code LIMIT 1')!;
  for (const machine of machines) {
    if (one('SELECT id FROM rental_listings WHERE machine_id = ?', [machine.id as string])) continue;
    rental.createListing(
      { machineId: machine.id as string, pricePerHa: 900_000 + (Number(machine.year_made) % 5) * 150_000, serviceRadiusKm: 30 },
      actor,
    );
  }
  const listings = rental.searchListings({});
  console.log(`  ✓ ${listings.length} tin đăng đang hoạt động`);
  if (listings.length && !rental.listOrders().length) {
    const order = rental.bookOrder(
      {
        listingId: String(listings[0].id), renterHtxId: htx.id, areaHa: 25,
        from: new Date().toISOString().slice(0, 10),
        to: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      },
      actor,
    ) as { id: string; code: string; amount: number; platform_fee: number };
    console.log(`  ✓ ${order.code}: ${vnd(order.amount)} (phí nền tảng ${vnd(order.platform_fee)})`);
    rental.advanceOrder(order.id, 'xac_nhan', actor);
    rental.advanceOrder(order.id, 'thuc_hien', actor);
    rental.advanceOrder(order.id, 'hoan_thanh', actor);
    console.log('  ✓ Lệnh hoàn thành → escrow giải ngân, phí nền tảng ghi nhận sang Finance');

    const disputed = rental.bookOrder(
      {
        listingId: String(listings[Math.min(1, listings.length - 1)].id), renterHtxId: htx.id, areaHa: 12,
        from: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
        to: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      },
      actor,
    ) as { id: string; code: string };
    rental.advanceOrder(disputed.id, 'xac_nhan', actor);
    rental.openDispute({ orderId: disputed.id, reason: 'Máy gặt hỏng giữa buổi, trễ lịch 1 ngày' }, actor);
    console.log(`  ⚠ ${disputed.code}: đã mở khiếu nại — chờ Admin xử lý tranh chấp`);
  }
}

console.log('\n═══ 12. Bán hàng đầu ra & chuyến vận chuyển ═══');
if (facilityId) {
  const partner = one<{ id: string; name: string }>("SELECT id, name FROM partners WHERE kind = 'customer' LIMIT 1")!;
  const outbound = one<{ lat: number; lng: number; name: string }>('SELECT lat, lng, name FROM facilities WHERE id = ?', [facilityId])!;
  const factory = one<{ lat: number; lng: number; name: string }>("SELECT lat, lng, name FROM facilities WHERE kind = 'plant' LIMIT 1")!;
  if (!one('SELECT id FROM sales_orders LIMIT 1')) {
    const so = sales.createSalesOrder(
      {
        partnerId: partner.id, facilityId, orderedTons: 20, unitPrice: 1_400_000,
        deliveryDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      },
      actor,
    ) as { id: string; code: string; stockWarning: string | null };
    sales.advanceSalesOrder(so.id, 'xac_nhan', actor);
    console.log(`  ✓ ${so.code} cho ${partner.name}${so.stockWarning ? ` — ${so.stockWarning}` : ''}`);

    const trip = tms.createTrip(
      {
        mode: 'waterway', from: { lat: outbound.lat, lng: outbound.lng }, to: { lat: factory.lat, lng: factory.lng },
        fromLabel: outbound.name, toLabel: factory.name, plannedTons: 20,
        vehicleCode: 'SA-LAN-01', refType: 'sales_order', refId: so.id,
      },
      actor,
    ) as { id: string; code: string; distance_km: number; planned_cost: number };
    tms.departTrip(trip.id, actor);
    const done = tms.completeTrip(trip.id, { actualTons: 19.4 }, actor) as { actual_cost: number; co2_kg: number };
    warehouse.issueTripDocument({ tripId: trip.id, kind: 'epod', signer: 'Đại diện nhà máy VFT' }, actor);
    warehouse.issueTripDocument({ tripId: trip.id, kind: 'ebill', signer: 'Đội vận tải thuỷ' }, actor);
    console.log(`  ✓ ${trip.code}: ${Math.round(trip.distance_km)} km · kế hoạch ${vnd(trip.planned_cost)} · thực tế ${vnd(done.actual_cost)} · ${done.co2_kg} kgCO₂ · đã ký ePOD + e-bill`);
  }
}

console.log('\n═══ 13. Cân đối cung–cầu cơ giới hoá (CGH QT-01/QT-02) ═══');
const balance = balanceSupplyDemand();
console.log(`  Tổng số dòng cân đối: ${balance.summary.total} · Thiếu ${balance.summary.thieu} · Cần chú ý ${balance.summary.can_chu_y} · Đủ ${balance.summary.du} · Thừa ${balance.summary.thua}`);
console.log(`  Tổng nhu cầu ${balance.summary.totalRequired} máy · năng lực ${balance.summary.totalOperational} máy đang hoạt động`);
for (const row of balance.rows.filter((r) => r.level === 'thieu').slice(0, 5)) {
  console.log(`    • ${row.htxCode} ${row.htxName} — khâu ${row.stage}: cần ${row.requiredMachines}, có ${row.operationalMachines} (${row.coveragePct}%)`);
}

console.log('\n✔ Hoàn tất kịch bản trình diễn.\n');

function describePayback(status: string, years: number | null): string {
  switch (status) {
    case 'hoan_von': return `${years} năm`;
    case 'khong_hoan_von': return 'Không hoàn vốn';
    case 'khong_hoan_von_trong_ky': return 'Không hoàn vốn trong vòng đời so sánh';
    default: return 'Thiếu baseline';
  }
}
