/**
 * Kiểm thử các tiêu chí chấp nhận (Acceptance Criteria) cốt lõi của
 * BRD Supply Chain Hub Simulation v1.4.
 *
 * Chạy: npm test
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureDatabase, all, one, update } from '../src/platform/db/db.ts';

// Mỗi lần chạy test dùng một CSDL tạm riêng biệt.
configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-test-')), 'test.db'));

const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const params = await import('../src/erp/params/store.ts');
const { catalogIntegrity } = await import('../src/erp/params/catalog.ts');
const sim = await import('../src/erp/simulation/service.ts');
const { computeSizing, computeCapex, computeOpex } = await import('../src/erp/simulation/engine.ts');
const geo = await import('../src/platform/geo/geo.ts');
const waterways = await import('../src/agrigreen/gis/waterways.ts');
const cgh = await import('../src/agrigreen/cgh/service.ts');
const htxApp = await import('../src/agrigreen/htx/service.ts');
const warehouse = await import('../src/erp/warehouse/service.ts');
const mdm = await import('../src/mdm/service.ts');

migrate();
seedAll();

const actor = { name: 'test' };

// ---------------------------------------------------------------------------
// FN-01 — Quản trị dữ liệu nền
// ---------------------------------------------------------------------------

test('FN-01 AC-03 — danh mục có đúng 49 tham số, không trùng, không thiếu STT', () => {
  const integrity = catalogIntegrity();
  assert.equal(integrity.total, 49);
  assert.deepEqual(integrity.duplicateNumbers, []);
  assert.deepEqual(integrity.missingNumbers, []);
  // Phân bổ theo nguồn đúng như BRD nêu: 23 thị trường / 24 giả định / 2 khác.
  assert.equal(integrity.byClassification.thi_truong, 23);
  assert.equal(integrity.byClassification.gia_dinh, 24);
  assert.equal(integrity.byClassification.khac, 2);
});

test('FN-01 AC-04 — mỗi lần lưu thay đổi làm số phiên bản bộ tham số tăng đúng 1', () => {
  const before = params.currentParameterSetVersion();
  params.updateParameter('road_freight_rate', { valueBase: 2_300 }, actor);
  assert.equal(params.currentParameterSetVersion(), before + 1);
  params.updateParameter('road_freight_rate', { valueBase: 2_200 }, actor);
  assert.equal(params.currentParameterSetVersion(), before + 2);
});

test('FN-01 AC-06 — từ chối giá trị âm hoặc bằng 0 cho đơn giá/định mức/tải trọng', () => {
  assert.throws(() => params.updateParameter('road_freight_rate', { valueBase: 0 }, actor), /lớn hơn 0/);
  assert.throws(() => params.updateParameter('truck_payload_tons', { valueBase: -5 }, actor), /lớn hơn 0/);
  // Không lưu một phần: giá trị cũ vẫn giữ nguyên.
  assert.equal(params.getParameter('road_freight_rate')?.value_base, 2_200);
});

test('FN-01 BR-02 — chỉ tham số nhóm "giả định" mới cần/được phê duyệt', () => {
  assert.throws(() => params.approveParameter('road_freight_rate', 'Tài chính', actor), /Cần input giả định/);
});

test('BR-03 — phê duyệt hàng loạt khi KHÔNG còn gì để duyệt thì không sinh phiên bản mới', () => {
  // Lần đầu: còn tham số chưa duyệt → phải sinh một phiên bản.
  const pendingBefore = params.unapprovedAssumptions().length;
  const versionBefore = params.currentParameterSetVersion();
  const first = params.approveAllAssumptions('Ban lãnh đạo', actor);
  assert.equal(first.approved, pendingBefore);
  assert.equal(params.currentParameterSetVersion(), pendingBefore ? versionBefore + 1 : versionBefore);

  // Lần hai và ba: không còn gì để duyệt → KHÔNG được đẩy số phiên bản lên.
  // Nếu sinh phiên bản rỗng, kịch bản đã lưu sẽ lệch phiên bản với bộ tham số
  // hiện hành và FN-14 BR-04 cảnh báo "so sánh khác bộ tham số" một cách vô cớ.
  const versionAfterFirst = params.currentParameterSetVersion();
  const second = params.approveAllAssumptions('Ban lãnh đạo', actor);
  const third = params.approveAllAssumptions('Người khác', actor);

  assert.equal(second.approved, 0);
  assert.equal(third.approved, 0);
  assert.equal(second.version, versionAfterFirst);
  assert.equal(third.version, versionAfterFirst);
  assert.equal(params.currentParameterSetVersion(), versionAfterFirst,
    'gọi lặp lại không được đẩy số phiên bản lên');
});

test('BR-03 — phê duyệt LẠI đúng người đã duyệt cũng không sinh phiên bản mới', () => {
  const code = 'straw_to_paddy_ratio';
  params.approveParameter(code, 'Tài chính', actor);
  const version = params.currentParameterSetVersion();
  const approvedAt = params.getParameter(code)?.approved_at;

  params.approveParameter(code, 'Tài chính', actor);
  assert.equal(params.currentParameterSetVersion(), version, 'duyệt lại y hệt không đổi dữ liệu');
  assert.equal(params.getParameter(code)?.approved_at, approvedAt, 'không được ghi đè ngày phê duyệt');

  // Nhưng đổi NGƯỜI phê duyệt là một thay đổi thật → vẫn phải sinh phiên bản.
  params.approveParameter(code, 'Ban lãnh đạo', actor);
  assert.equal(params.currentParameterSetVersion(), version + 1);
  assert.equal(params.getParameter(code)?.approved_by, 'Ban lãnh đạo');
});

// ---------------------------------------------------------------------------
// FN-02 / FN-05 / FN-06 — Hub, vùng phục vụ, sản lượng
// ---------------------------------------------------------------------------

const hubA = sim.createCandidateHub({ name: 'Hub test A', lat: 10.3800, lng: 105.4350 }, actor);
const hubB = sim.createCandidateHub({ name: 'Hub test B', lat: 10.4600, lng: 105.6400 }, actor);

test('FN-02 AC-02 — từ chối tạo Hub ở nơi không có dữ liệu vùng nguyên liệu', () => {
  assert.throws(
    () => sim.createCandidateHub({ name: 'Hub giữa Biển Đông', lat: 13.5, lng: 112.0 }, actor),
    /Không có dữ liệu vùng nguyên liệu/,
  );
});

const scenario = sim.createScenario({ name: 'Kịch bản kiểm thử', lifecycleYears: 10 }, actor);
sim.attachHub(scenario.id, hubA.id, { serviceRadiusKm: 40, designCapacityTons: 60_000 }, actor);
sim.attachHub(scenario.id, hubB.id, { serviceRadiusKm: 40, designCapacityTons: 60_000 }, actor);
const result = sim.runSimulation(scenario.id, {}, actor);

test('FN-05 AC-03 — vùng phục vụ chồng lấn: mỗi HTX chỉ được tính vào đúng một Hub', () => {
  const assigned = result.hubs.flatMap((hub) => hub.cooperatives.map((c) => c.code));
  assert.equal(new Set(assigned).size, assigned.length, 'Có HTX bị tính trùng ở hai Hub');
});

test('FN-06 AC-01 — chuỗi Total Available → Collectable → Delivered khớp công thức BR-01/02/04', () => {
  const p = params.resolveParams(result.parameterSetVersion);
  for (const hub of result.hubs) {
    for (const htx of hub.cooperatives) {
      for (const season of htx.seasons) {
        const expectedAvailable = season.paddyTons * p.strawToPaddyRatio;
        const expectedCollectable = expectedAvailable * p.collectableRatio;
        const expectedDelivered = expectedCollectable * (1 - p.lossRatio);
        assert.ok(Math.abs(season.totalAvailableTons - expectedAvailable) < 1);
        assert.ok(Math.abs(season.collectableTons - expectedCollectable) < 1);
        assert.ok(Math.abs(season.deliveredTons - expectedDelivered) < 1);
      }
    }
  }
});

test('FN-06 AC-03 — tổng Delivered của kịch bản bằng tổng của các Hub thành viên', () => {
  const sum = result.hubs.reduce((acc, hub) => acc + hub.deliveredTons, 0);
  assert.ok(Math.abs(result.deliveredTons - sum) < 1);
});

test('FN-06 BR-05 — cảnh báo cấp nhà máy tách riêng khỏi cảnh báo cấp Hub', () => {
  if (result.deliveredTons < result.plant.annualDemandTons) {
    assert.ok(result.plantDemandWarning, 'Thiếu cảnh báo cấp nhà máy');
    assert.match(result.plantDemandWarning!, /không đáp ứng nhu cầu nhà máy/);
  }
});

// ---------------------------------------------------------------------------
// FN-04 / FN-08 — Khoảng cách và chi phí vận chuyển
// ---------------------------------------------------------------------------

test('FN-04 AC-03 — mọi khoảng cách đều có nhãn nguồn tính', () => {
  for (const hub of result.hubs) {
    assert.ok(hub.distanceToPlantSourceLabel.length > 0);
    for (const htx of hub.cooperatives) {
      assert.ok(htx.distanceToHubSourceLabel.length > 0);
      assert.ok(htx.distanceToPlantSourceLabel.length > 0);
    }
  }
});

test('FN-04 AC-04 — với N HTX trong bán kính, hệ thống trả về N khoảng cách riêng, không gộp bình quân', () => {
  for (const hub of result.hubs) {
    assert.equal(hub.cooperatives.length, hub.cooperativeCount);
    const distances = hub.cooperatives.map((c) => c.distanceToHubKm);
    assert.equal(distances.length, hub.cooperativeCount);
    if (hub.cooperativeCount > 1) {
      assert.ok(new Set(distances).size > 1, 'Mọi HTX có cùng khoảng cách — nghi ngờ dùng bình quân');
    }
  }
});

test('FN-08 AC-01/AC-02 — chi phí tách riêng 3 chặng; mỗi chặng dùng đúng phương tiện', () => {
  const p = params.resolveParams(result.parameterSetVersion);
  for (const hub of result.hubs) {
    const legs = hub.legs;
    assert.equal(legs.length, 3);
    assert.equal(legs[0].leg, 'field_plant');
    assert.equal(legs[1].leg, 'field_hub');
    assert.equal(legs[2].leg, 'hub_plant');

    // Chặng ruộng đi bằng GHE (chở ~90 tấn rơm rời), không phải sà lan.
    const direct = legs[0];
    assert.equal(direct.mode, 'waterway');
    assert.equal(direct.trips, direct.tons > 0 ? Math.ceil(direct.tons / p.boatStrawPayloadTons) : 0);

    // Chặng Hub → Nhà máy dùng số chuyến sà lan do mô phỏng đếm được.
    const barge = legs[2];
    assert.equal(barge.trips, (hub.flow?.fullBargeTrips ?? 0) + (hub.flow?.partialBargeTrips ?? 0));

    // Tổng khối lượng ba chặng ruộng phải khớp Collectable Supply của Hub.
    assert.ok(Math.abs(direct.tons + legs[1].tons - hub.collectableTons) / hub.collectableTons < 0.02);
  }
});

// ---------------------------------------------------------------------------
// Mô hình dòng chảy rơm theo ngày (yêu cầu bổ sung ngoài BRD v1.4)
// ---------------------------------------------------------------------------

test('Dòng chảy — chở thẳng Ruộng→Nhà máy không vượt lượng tiêu thụ mỗi ngày của nhà máy', () => {
  const flow = result.flow;
  // Trần lý thuyết: mỗi ngày có thu hoạch chỉ nhận tối đa 1 ngày tiêu thụ.
  const ceiling = flow.plantDailyDemandTons * flow.harvestDays;
  assert.ok(flow.harvestDays > 0, 'phải có ngày thu hoạch');
  assert.ok(flow.directFieldPlantTons <= ceiling * 1.001,
    `chở thẳng ${flow.directFieldPlantTons} vượt trần ${ceiling}`);
});

test('Dòng chảy — có khoảng thời gian không thu hoạch và Hub phải tồn kho để bù', () => {
  const flow = result.flow;
  assert.ok(flow.noHarvestDays > 0, 'phải có ngày không có rơm thu hoạch tại ruộng');
  assert.ok(flow.harvestWindows.length > 0);
  // Ngoài vụ nhà máy sống bằng rơm xuất kho từ Hub.
  assert.ok(flow.hubPlantTons > 0);
});

test('Dòng chảy — sà lan chở ĐẦY TẢI, chuyến non tải chỉ là dọn kho cuối kỳ', () => {
  for (const hub of result.flow.hubs) {
    if (hub.shippedToPlantTons <= 0) continue;
    const trips = hub.fullBargeTrips + hub.partialBargeTrips;
    // Chuyến đầy tải chở đúng tải trọng, chuyến non tải chở ít hơn — nên tổng
    // khối lượng phải nằm giữa hai cận này.
    assert.ok(hub.shippedToPlantTons >= hub.fullBargeTrips * hub.bargePayloadTons - 1);
    assert.ok(hub.shippedToPlantTons <= trips * hub.bargePayloadTons + 1);
    // Khi tồn kho từng đạt ít nhất một tải sà lan thì phải có chuyến đầy tải.
    if (hub.peakInventoryTons >= hub.bargePayloadTons) assert.ok(hub.fullBargeTrips > 0);
  }
});

test('Dòng chảy — công suất Hub là TỒN KHO TỐI ĐA, tồn kho mô phỏng không được vượt', () => {
  for (const hub of result.flow.hubs) {
    if (hub.maxInventoryTons <= 0) continue;
    assert.ok(hub.peakInventoryTons <= hub.maxInventoryTons + 1,
      `${hub.name}: tồn kho ${hub.peakInventoryTons} vượt sức chứa ${hub.maxInventoryTons}`);
    for (const value of hub.inventoryCurve) {
      assert.ok(value <= hub.maxInventoryTons + 1);
    }
    assert.equal(hub.inventoryCurve.length, 365);
  }
});

test('Dòng chảy — cân bằng vật chất: thu gom = chở thẳng + về Hub + bỏ lại', () => {
  const flow = result.flow;
  const balance = flow.directFieldPlantTons + flow.fieldHubTons + flow.uncollectedTons;
  assert.ok(Math.abs(balance - result.collectableTons) / result.collectableTons < 0.02,
    `lệch cân bằng: ${balance} vs ${result.collectableTons}`);
});

test('Cấu hình Hub — sửa một ô không được reset các ô còn lại về mặc định', () => {
  const before = sim.listScenarioHubs(scenario.id)[0] as Record<string, number>;
  sim.attachHub(scenario.id, String(before.hub_id), { bargePayloadTons: 2_000 }, actor);
  const after = sim.listScenarioHubs(scenario.id)[0] as Record<string, number>;
  assert.equal(after.barge_payload_tons, 2_000);
  assert.equal(after.service_radius_km, before.service_radius_km);
  assert.equal(after.design_capacity_tons, before.design_capacity_tons);
  sim.attachHub(scenario.id, String(before.hub_id), { bargePayloadTons: before.barge_payload_tons }, actor);
});

test('RS-06 — Peak Inventory lấy từ mô phỏng theo ngày, không còn dùng hệ số ước lượng', () => {
  for (const hub of result.hubs) {
    if (!hub.flow || hub.flow.peakInventoryTons <= 0) continue;
    assert.equal(hub.sizing.peakInventorySource, 'mo_phong_theo_ngay');
    assert.equal(hub.sizing.peakInventoryTons, hub.flow.peakInventoryTons);
  }
});

test('Chi phí băm và nén chỉ áp cho phần rơm ĐI QUA Hub', () => {
  const p = params.resolveParams(result.parameterSetVersion);
  for (const hub of result.hubs) {
    const expected = Math.round((hub.flow?.receivedFromFieldTons ?? 0) * p.hubProcessingCostPerTon);
    assert.ok(Math.abs(hub.opex.processing - expected) <= 1);
  }
});

test('FN-08 AC-03 — thay đổi khoảng cách của đúng MỘT HTX làm đổi Transportation Cost (Field→Hub)', () => {
  const hub = result.hubs.find((h) => h.cooperativeCount > 1)!;
  const target = hub.cooperatives[0];
  const baseline = hub.costs.transportationFieldHub;

  // Dịch chuyển toạ độ HTX ra xa hơn rồi mô phỏng lại.
  const originalLat = target.lat;
  update('cooperatives', target.htxId, { lat: originalLat + 0.15 });
  const rerun = sim.runSimulation(scenario.id, { refreshDistances: true }, actor);
  const changed = rerun.hubs.find((h) => h.hubId === hub.hubId)!;
  assert.notEqual(changed.costs.transportationFieldHub, baseline);

  update('cooperatives', target.htxId, { lat: originalLat });
  sim.runSimulation(scenario.id, { refreshDistances: true }, actor);
});

// ---------------------------------------------------------------------------
// FN-09 / FN-10 — Kho bãi, thiết bị, CAPEX/OPEX
// ---------------------------------------------------------------------------

test('FN-09 AC-01/AC-03 — diện tích theo định mức; số máy làm tròn lên, tối thiểu 1 khi có sản lượng', () => {
  const p = params.resolveParams();
  const sizing = computeSizing(50_000, p);
  assert.ok(Math.abs(sizing.warehouseAreaM2 - sizing.warehouseCapacityTons * p.warehouseAreaNormM2PerTon) < 1);
  assert.equal(sizing.balePressCount, Math.max(1, Math.ceil(50_000 / p.balePressCapacityTonsYear)));
  assert.equal(sizing.forkliftCount, Math.max(1, Math.ceil(50_000 / p.forkliftCapacityTonsYear)));

  const tiny = computeSizing(1, p);
  assert.equal(tiny.balePressCount, 1);
  assert.equal(tiny.forkliftCount, 1);

  const empty = computeSizing(0, p);
  assert.equal(empty.balePressCount, 0);
});

test('FN-09 AC-04 — mọi kết quả sizing có nhãn "ước tính"', () => {
  assert.match(computeSizing(10_000, params.resolveParams()).estimateNotice, /Ước tính/);
});

test('FN-10 AC-02/AC-03 — tổng CAPEX bằng tổng 3 cấu phần; Handling + Warehouse = OPEX', () => {
  const p = params.resolveParams();
  const sizing = computeSizing(50_000, p);
  const capex = computeCapex(sizing, p);
  assert.equal(capex.total, capex.construction + capex.equipment + capex.other);
  assert.equal(capex.construction, capex.warehouseConstruction + capex.yardConstruction);
  assert.equal(capex.equipment, capex.balePress + capex.forklift);

  const opex = computeOpex(sizing, capex, 'mua', p);
  assert.equal(opex.handlingCostAnnual + opex.warehouseCostAnnual, opex.total);
  // BR-02: cơ sở tính bảo trì là CAPEX_thiết bị, không gồm xây dựng.
  assert.equal(opex.maintenance, Math.round(capex.equipment * p.maintenanceRate));
});

test('FN-10 BR-03 — phương án THUÊ mặt bằng làm tăng OPEX, phương án MUA thì bằng 0', () => {
  const p = params.resolveParams();
  const sizing = computeSizing(50_000, p);
  const capex = computeCapex(sizing, p);
  assert.equal(computeOpex(sizing, capex, 'mua', p).landLease, 0);
  assert.ok(computeOpex(sizing, capex, 'thue', p).landLease > 0);
});

// ---------------------------------------------------------------------------
// FN-11 / FN-12 / FN-17 — Chi phí/tấn và chỉ số đầu tư
// ---------------------------------------------------------------------------

test('FN-11 AC-01 — Cost/Ton = Total Delivered Logistics Cost ÷ Delivered Supply và 4 cấu phần khớp tổng', () => {
  const costs = result.costs;
  const sumParts =
    costs.collectionCost + costs.warehouseCost + costs.handlingCost + costs.transportationCost;
  assert.ok(Math.abs(sumParts - costs.totalDeliveredLogisticsCost) < 2);
  assert.ok(
    Math.abs((costs.costPerTon ?? 0) - costs.totalDeliveredLogisticsCost / result.deliveredTons) < 1,
  );
  assert.match(costs.costPerTonNote, /chưa gồm khấu hao đầu tư/);
});

test('FN-11 AC-02 — Cost/Ton cấp kịch bản KHÔNG phải bình quân số học Cost/Ton của các Hub', () => {
  const arithmetic =
    result.hubs.reduce((acc, hub) => acc + (hub.costs.costPerTon ?? 0), 0) / result.hubs.length;
  const weighted = result.costs.totalDeliveredLogisticsCost / result.deliveredTons;
  assert.ok(Math.abs((result.costs.costPerTon ?? 0) - weighted) < 1);
  if (result.hubs.length > 1) assert.notEqual(Math.round(arithmetic), Math.round(weighted));
});

test('FN-17 AC-02 — No-Hub Baseline có CAPEX = 0, Warehouse Cost = 0, Handling Cost = 0', () => {
  assert.equal(result.baseline.capex, 0);
  assert.equal(result.baseline.warehouseCost, 0);
  assert.equal(result.baseline.handlingCost, 0);
  assert.ok(result.baseline.available);
  assert.ok((result.baseline.baselineCostPerTon ?? 0) > 0);
});

test('FN-12 AC-04 — Cost/Ton ≥ baseline thì Payback hiển thị "Không hoàn vốn", không trả số âm', () => {
  const financial = result.financial;
  if ((financial.baselineCostPerTon ?? 0) <= (result.costs.costPerTon ?? 0)) {
    assert.equal(financial.paybackStatus, 'khong_hoan_von');
    assert.equal(financial.paybackYears, null);
  }
  assert.ok(financial.paybackYears === null || financial.paybackYears > 0);
});

test('FN-12 AC-05 — nguồn baseline luôn được ghi kèm kết quả', () => {
  assert.ok(result.financial.baselineSourceLabel.length > 0);
  assert.ok(['no_hub', 'scenario', 'manual', 'thieu_baseline'].includes(result.financial.baselineSource));
});

test('FN-12 BR-01 — TCO = CAPEX + Σ OPEX(t) với escalation theo FN-10 BR-06', () => {
  const p = params.resolveParams(result.parameterSetVersion);
  let expected = result.capex.total;
  for (let t = 1; t <= result.financial.lifecycleYears; t += 1) {
    expected += result.opex.total * (1 + p.opexEscalation) ** (t - 1);
  }
  assert.ok(Math.abs(result.financial.tco - expected) / expected < 0.001);
});

// ---------------------------------------------------------------------------
// FN-14 — So sánh kịch bản
// ---------------------------------------------------------------------------

test('FN-14 BR-02 — chặn so sánh khi khác vòng đời hoặc khác chế độ chiết khấu', () => {
  const other = sim.createScenario({ name: 'Kịch bản 7 năm', lifecycleYears: 7 }, actor);
  sim.attachHub(other.id, hubA.id, { serviceRadiusKm: 30 }, actor);
  sim.runSimulation(other.id, {}, actor);
  const comparison = sim.compareScenarios([scenario.id, other.id]);
  assert.ok(comparison.blocked, 'Phải chặn so sánh giữa hai vòng đời khác nhau');
  assert.match(comparison.blocked!, /số năm vòng đời/);
});

test('FN-14 AC-02/AC-04 — bảng so sánh xếp theo TCO/Ton tăng dần và có cột No-Hub Baseline (CAPEX = 0)', () => {
  const comparison = sim.compareScenarios([scenario.id]);
  assert.equal(comparison.blocked, null);
  const baselineRow = comparison.rows.find((row) => row.isBaselineColumn);
  assert.ok(baselineRow, 'Thiếu cột đối chứng No-Hub Baseline');
  assert.equal(baselineRow!.capex, 0);
  const scenarioRows = comparison.rows.filter((row) => !row.isBaselineColumn);
  for (let i = 1; i < scenarioRows.length; i += 1) {
    assert.ok((scenarioRows[i - 1].tcoPerTon ?? Infinity) <= (scenarioRows[i].tcoPerTon ?? Infinity));
  }
});

// ---------------------------------------------------------------------------
// FN-15 — Khuyến nghị
// ---------------------------------------------------------------------------

test('FN-15 AC-02 — chưa chốt ngưỡng #48/#49 thì KHÔNG sinh kết luận đầu tư', () => {
  const recommendation = sim.recommend(scenario.id);
  assert.equal(recommendation.available, false);
  assert.equal(recommendation.verdict, null);
  assert.match(recommendation.label, /Chưa có ngưỡng/);
});

// ---------------------------------------------------------------------------
// FN-20 — Số hoá & đo tuyến đường thuỷ
// ---------------------------------------------------------------------------

test('FN-20 BR-01 — tuyến phải có tối thiểu 2 đỉnh', () => {
  assert.throws(
    () => waterways.createRoute({ name: 'Tuyến lỗi', mode: 'waterway', points: [{ lat: 10, lng: 105 }] }, actor),
    /tối thiểu 2 đỉnh/,
  );
});

test('FN-20 AC-04 — sai số chiều dài so với chuẩn geodesic ≤ 1%', () => {
  // Một cung 1 độ vĩ tuyến ≈ 110.574 m trên ellipsoid WGS84.
  const meters = geo.geodesicMeters({ lat: 10, lng: 105 }, { lat: 11, lng: 105 });
  assert.ok(Math.abs(meters - 110_574) / 110_574 < 0.01, `Sai số quá lớn: ${meters} m`);
});

test('FN-20 BR-03 — chiều dài do hệ thống tính, không nhận giá trị người dùng nhập', () => {
  const created = waterways.createRoute(
    {
      name: 'Rạch kiểm thử',
      mode: 'waterway',
      points: [{ lat: 10.20, lng: 105.60 }, { lat: 10.25, lng: 105.65 }],
      // Trường length_m không tồn tại trong RouteInput — client không thể ghi đè.
    },
    actor,
  );
  const expected = geo.polylineLengthMeters([{ lat: 10.20, lng: 105.60 }, { lat: 10.25, lng: 105.65 }]);
  assert.ok(Math.abs(created.route.length_m - expected) < 1);
  assert.match(created.lengthLabel, /km|m/);
});

test('FN-20 AC-07 — tuyến "Nháp" KHÔNG tham gia định tuyến', () => {
  const draft = waterways.createRoute(
    { name: 'Tuyến nháp', mode: 'waterway', points: [{ lat: 9.5, lng: 105.9 }, { lat: 9.6, lng: 106.0 }] },
    actor,
  );
  assert.equal(draft.route.status, 'nhap');
  const routable = waterways.listRoutes({ mode: 'waterway', status: 'da_xac_nhan' });
  assert.ok(!routable.some((route) => route.id === draft.route.id));
});

test('FN-20 — xuất GeoJSON kèm ghi chú giá trị ước lượng (BR-07)', () => {
  const geojson = waterways.exportGeoJson({ mode: 'waterway' }) as any;
  assert.equal(geojson.type, 'FeatureCollection');
  assert.ok(geojson.features.length > 0);
  assert.match(geojson.features[0].properties.disclaimer, /không có giá trị pháp lý/);
});

// ---------------------------------------------------------------------------
// Bản đồ Cơ giới hoá — QT-01 / QT-02
// ---------------------------------------------------------------------------

test('CGH QT-01/QT-02 — số máy cần = diện tích ÷ định mức; phân loại mức đáp ứng đúng ngưỡng', () => {
  assert.equal(cgh.classifyCoverage(130), 'thua');
  assert.equal(cgh.classifyCoverage(90), 'du');
  assert.equal(cgh.classifyCoverage(70), 'can_chu_y');
  assert.equal(cgh.classifyCoverage(40), 'thieu');
  assert.equal(cgh.classifyCoverage(null), 'chua_co_du_lieu');

  const balance = cgh.balanceSupplyDemand();
  assert.ok(balance.rows.length > 0);
  for (const row of balance.rows.slice(0, 30)) {
    if (row.normHaPerMachine && row.requiredMachines !== null) {
      assert.equal(row.requiredMachines, Math.ceil(row.areaHa / row.normHaPerMachine));
    }
  }
});

test('CGH QT-03 — bản ghi đã khoá không nhận đồng bộ từ App HTX', () => {
  const machine = one<{ id: string }>('SELECT id FROM machines LIMIT 1')!;
  cgh.lockMachineCondition(machine.id, true, actor);
  const blocked = cgh.applyConditionUpdate(machine.id, 'hong', 'app_htx', actor);
  assert.equal(blocked.applied, false);
  const manual = cgh.applyConditionUpdate(machine.id, 'bao_tri', 'nhap_tay', actor);
  assert.equal(manual.applied, true);
  cgh.lockMachineCondition(machine.id, false, actor);
});

// ---------------------------------------------------------------------------
// App Hợp tác xã — vòng đời lô ruộng
// ---------------------------------------------------------------------------

test('App HTX — vòng đời lô ruộng đóng sau khi khai báo sản lượng, không mở lại được', () => {
  const htx = one<{ id: string }>('SELECT id FROM cooperatives LIMIT 1')!;
  const season = one<{ id: string }>('SELECT id FROM seasons ORDER BY sort_order LIMIT 1')!;
  const plot = mdm.createPlot(
    {
      htxId: htx.id,
      boundary: [
        { lat: 10.40, lng: 105.40 }, { lat: 10.41, lng: 105.40 },
        { lat: 10.41, lng: 105.41 }, { lat: 10.40, lng: 105.41 },
      ],
    },
    actor,
  );
  assert.ok(plot.area_ha > 0, 'Diện tích phải được hệ thống tự tính từ polygon');

  const cycle = htxApp.openCropCycle({ plotId: plot.id, seasonId: season.id }, actor) as { id: string };
  assert.throws(() => htxApp.openCropCycle({ plotId: plot.id, seasonId: season.id }, actor), /đang canh tác/);

  htxApp.addFarmLog({ cropCycleId: cycle.id, activity: 'gieo_sa' }, actor);
  htxApp.declareHarvest({ cropCycleId: cycle.id, paddyTons: 12, strawTons: 6 }, actor);
  assert.throws(() => htxApp.openCropCycle({ plotId: plot.id, seasonId: season.id }, actor), /Đã hoàn thành vụ/);
});

// ---------------------------------------------------------------------------
// Warehouse — ngưỡng môi trường và ưu tiên xuất theo rủi ro
// ---------------------------------------------------------------------------

test('Warehouse FN-10 — vượt ngưỡng độ ẩm/nhiệt độ sinh cảnh báo đúng mức', () => {
  const facility = one<{ id: string }>("SELECT id FROM facilities WHERE kind = 'plant' LIMIT 1")!;
  const thresholds = warehouse.getThresholds(facility.id);
  const safe = warehouse.ingestSensorReading({ facilityId: facility.id, sensorId: 'T1', humidityPct: thresholds.humidityWarn - 5, tempC: 25 });
  assert.equal(safe.alerts.length, 0);
  const critical = warehouse.ingestSensorReading({ facilityId: facility.id, sensorId: 'T1', humidityPct: thresholds.humidityCrit + 2, tempC: thresholds.tempCrit + 1 });
  assert.equal(critical.alerts.length, 2);
  assert.ok(critical.alerts.every((alert) => (alert as any).level === 'nguy_hiem'));
});

test('Warehouse FN-13 — không cho xuất quá tồn kho hiện có', () => {
  const facility = one<{ id: string }>("SELECT id FROM facilities WHERE kind = 'plant' LIMIT 1")!;
  assert.throws(() => warehouse.createGoodsIssue({ facilityId: facility.id, issuedTons: 1_000_000 }, actor), /không đủ/);
});

// ---------------------------------------------------------------------------
// Nhật ký & truy vết
// ---------------------------------------------------------------------------

test('FN-01 BR-01 / TECH-05 — mọi thay đổi dữ liệu nền đều có nhật ký truy vết', () => {
  const events = all<{ entity_type: string; action: string }>(
    "SELECT entity_type, action FROM event_log WHERE module = 'simulation'",
  );
  assert.ok(events.some((event) => event.entity_type === 'parameters' && event.action === 'update'));
  assert.ok(events.some((event) => event.entity_type === 'scenarios' && event.action === 'simulate'));
});
