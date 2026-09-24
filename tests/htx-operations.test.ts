/**
 * Kiểm thử các bổ sung cho App Hợp tác xã và App Khuyến nông:
 *
 *   1. Vẽ / vẽ lại đường bao thửa ruộng, hệ thống tự tính diện tích
 *   2. Phân công công đoạn cho thành viên và máy móc
 *   3. Mua sắm – tồn kho – cấp phát vật tư
 *   4. Hai mô hình vận hành HTX
 *   5. Mẫu khảo sát + dropdown hành chính lọc dần
 *   6. Khuyến nông vẽ thửa và gán cho HTX
 *   7. Khởi tạo HTX theo mã số thuế và kích hoạt thừa hưởng dữ liệu
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, configureDatabase, one, update } from '../src/platform/db/db.ts';

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-ops-')), 'test.db'));

const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const mdm = await import('../src/mdm/service.ts');
const registry = await import('../src/mdm/htxRegistry.ts');
const htx = await import('../src/agrigreen/htx/service.ts');
const production = await import('../src/agrigreen/htx/production.ts');
const assignment = await import('../src/agrigreen/htx/assignment.ts');
const inputs = await import('../src/agrigreen/htx/inputs.ts');
const survey = await import('../src/agrigreen/khuyennong/survey.ts');

migrate();
seedAll();

const actor = { name: 'test' };
const htxRow = one<{ id: string; lat: number; lng: number }>(
  'SELECT id, lat, lng FROM cooperatives WHERE lat IS NOT NULL LIMIT 1',
)!;
const season = one<{ id: string }>('SELECT id FROM seasons ORDER BY sort_order LIMIT 1')!;

/** Ô vuông ~0,01° cạnh, đặt lệch theo `offset` để mỗi thửa một chỗ. */
function square(offset: number, size = 0.01) {
  const lat = htxRow.lat + offset;
  const lng = htxRow.lng + offset;
  return [
    { lat, lng }, { lat: lat + size, lng },
    { lat: lat + size, lng: lng + size }, { lat, lng: lng + size },
  ];
}

let plotOffset = 0;
function newPlot(farmerId?: string) {
  plotOffset += 0.02;
  return mdm.createPlot(
    { htxId: htxRow.id, farmerId, boundary: square(plotOffset) }, actor,
  ) as { id: string; code: string; area_ha: number };
}

function newFarmer(name: string) {
  return mdm.createFarmer({ fullName: name, htxId: htxRow.id, phone: '0901234567' }, actor) as
    { id: string; full_name: string };
}

// ===========================================================================
// 1 & 6 — Vẽ đường bao, tự tính diện tích, vẽ lại
// ===========================================================================

test('Diện tích thửa ruộng do hệ thống TÍNH từ đường bao, không nhận từ người dùng', () => {
  const plot = newPlot();
  assert.ok(plot.area_ha > 0, 'phải tính ra diện tích dương');

  // Ô vuông 0,01° × 0,01° ở vĩ độ ~10° có diện tích xấp xỉ 121–122 ha.
  assert.ok(plot.area_ha > 100 && plot.area_ha < 140,
    `diện tích ${plot.area_ha} ha không hợp lý cho ô vuông 0,01 độ`);

  // Không có đường nào nhập diện tích trực tiếp: createPlot bỏ qua mọi giá trị
  // area_ha do người gọi truyền vào.
  const forged = mdm.createPlot(
    { htxId: htxRow.id, boundary: square(0.5), areaHa: 9_999 } as never, actor,
  ) as { area_ha: number };
  assert.ok(forged.area_ha < 200, 'diện tích do người dùng gửi lên phải bị bỏ qua');
});

test('Đường bao dưới 3 đỉnh bị từ chối', () => {
  assert.throws(
    () => mdm.createPlot({ htxId: htxRow.id, boundary: [{ lat: 10, lng: 105 }, { lat: 10.1, lng: 105 }] }, actor),
    /tối thiểu 3 đỉnh/,
  );
});

test('Vẽ lại đường bao thì diện tích tính lại và báo mức chênh lệch', () => {
  const plot = newPlot();
  const before = plot.area_ha;

  // Vẽ lại nhỏ hơn một nửa.
  const updated = mdm.updatePlotBoundary(plot.id, square(plotOffset, 0.006), actor);
  assert.equal(updated.previousAreaHa, before);
  assert.ok(updated.area_ha < before, 'diện tích mới phải nhỏ hơn');
  assert.ok(updated.deltaHa < 0);
  assert.ok(updated.deltaPct < -50, `chênh lệch ${updated.deltaPct}% chưa phản ánh đúng`);
  assert.equal(updated.warnings.length, 0, 'thửa chưa mở vụ thì không cần cảnh báo');
});

test('Đổi diện tích thửa ĐANG CANH TÁC phải cảnh báo vì ảnh hưởng thống kê', () => {
  const plot = newPlot();
  htx.openCropCycle({ plotId: plot.id, seasonId: season.id, sowingDate: '2026-01-10' }, actor);

  const updated = mdm.updatePlotBoundary(plot.id, square(plotOffset, 0.006), actor);
  assert.equal(updated.warnings.length, 1);
  assert.match(String(updated.warnings[0]), /đang canh tác/);
  assert.match(String(updated.warnings[0]), /thống kê sản lượng/);
});

test('Khuyến nông vẽ thửa rồi gán cho HTX và thành viên', () => {
  const farmer = newFarmer('Nguyễn Văn Tám');
  // Cán bộ khuyến nông vẽ thửa (source ghi rõ nguồn), chưa gán chủ.
  plotOffset += 0.02;
  const plot = mdm.createPlot(
    { htxId: htxRow.id, boundary: square(plotOffset), source: 'app_khuyennong' }, actor,
  ) as { id: string; source: string; farmer_id: string | null };
  assert.equal(plot.source, 'app_khuyennong');
  assert.equal(plot.farmer_id, null);

  const assigned = mdm.assignPlot(plot.id, { htxId: htxRow.id, farmerId: farmer.id, name: 'Thửa Bắc kênh' }, actor);
  assert.equal(assigned.farmer_id, farmer.id);
  assert.equal(assigned.name, 'Thửa Bắc kênh');
});

test('Không gán được thửa cho thành viên của HTX khác', () => {
  const otherHtx = mdm.createCooperative(
    { name: 'HTX khác', lat: 10.5, lng: 105.5 }, actor,
  ) as { id: string };
  const outsider = mdm.createFarmer({ fullName: 'Người ngoài', htxId: otherHtx.id }, actor) as { id: string };
  const plot = newPlot();
  assert.throws(() => mdm.assignPlot(plot.id, { farmerId: outsider.id }, actor), /không thuộc HTX/);
});

// ===========================================================================
// 2 & 4 — Phân công công việc và hai mô hình vận hành
// ===========================================================================

/** Thửa có vụ + kế hoạch sản xuất, sẵn sàng để phân công. */
function plotWithPlan(farmerId?: string) {
  const plot = newPlot(farmerId);
  const cycle = htx.openCropCycle(
    { plotId: plot.id, seasonId: season.id, sowingDate: '2026-01-10' }, actor,
  ) as { id: string };
  const protocol = one<{ id: string }>(
    "SELECT id FROM production_protocols WHERE code = 'VIETGAP-LUA' AND status = 'ban_hanh'",
  )!;
  const plan = production.generatePlan({ cropCycleId: cycle.id, protocolId: protocol.id }, actor);
  const steps = production.listPlanSteps(plan.id as string);
  return { plot, cycle, plan, steps };
}

test('Chọn thửa ruộng thì thấy kế hoạch sản xuất dự kiến để phân công', () => {
  const { plot, steps } = plotWithPlan();
  const workPlan = assignment.plotWorkPlan(plot.id) as Record<string, unknown>;

  assert.ok(workPlan.plan, 'phải trả về kế hoạch của thửa');
  assert.equal((workPlan.steps as unknown[]).length, steps.length);
  assert.equal(workPlan.operatingModel, 'tap_trung');
  assert.equal(workPlan.notice, null);
});

test('Thửa chưa có kế hoạch thì nói rõ lý do, không trả về danh sách rỗng im lặng', () => {
  const plot = newPlot();
  const noCycle = assignment.plotWorkPlan(plot.id) as Record<string, unknown>;
  assert.equal(noCycle.plan, null);
  assert.match(String(noCycle.notice), /chưa có vụ đang canh tác/);

  htx.openCropCycle({ plotId: plot.id, seasonId: season.id, sowingDate: '2026-01-10' }, actor);
  const noPlan = assignment.plotWorkPlan(plot.id) as Record<string, unknown>;
  assert.equal(noPlan.plan, null);
  assert.match(String(noPlan.notice), /chưa có kế hoạch sản xuất/);
});

test('Gán một công đoạn cho NHIỀU thành viên cùng lúc', () => {
  const { steps } = plotWithPlan();
  const a = newFarmer('Thành viên A');
  const b = newFarmer('Thành viên B');

  const result = assignment.assignWork({
    planStepId: steps[0].id as string, farmerIds: [a.id, b.id], role: 'phu_trach',
  }, actor);

  assert.equal(result.created.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(assignment.listAssignments(steps[0].id as string).length, 2);

  // Gán lại người đã có thì bỏ qua, không tạo bản trùng.
  const again = assignment.assignWork({ planStepId: steps[0].id as string, farmerIds: [a.id] }, actor);
  assert.equal(again.created.length, 0);
  assert.match(again.skipped[0].reason, /Đã được giao/);
});

test('Máy hỏng không điều phối được; một máy không ở hai thửa cùng ngày', () => {
  const { steps: stepsA } = plotWithPlan();
  const { steps: stepsB } = plotWithPlan();
  const machine = one<{ id: string; code: string }>(
    "SELECT id, code FROM machines WHERE condition = 'hoat_dong' AND htx_id = ? LIMIT 1", [htxRow.id],
  );
  if (!machine) return; // bộ seed không có máy cho HTX này

  const first = assignment.assignWork({
    planStepId: stepsA[0].id as string, machineIds: [machine.id], plannedDate: '2026-01-05',
  }, actor);
  assert.equal(first.created.length, 1);

  // Cùng ngày, thửa khác → phải báo trùng lịch, không im lặng cho qua.
  const clash = assignment.assignWork({
    planStepId: stepsB[0].id as string, machineIds: [machine.id], plannedDate: '2026-01-05',
  }, actor);
  assert.equal(clash.created.length, 0);
  assert.match(clash.skipped[0].reason, /Đã được điều phối ngày 2026-01-05/);

  // Ngày khác thì được.
  const other = assignment.assignWork({
    planStepId: stepsB[0].id as string, machineIds: [machine.id], plannedDate: '2026-01-07',
  }, actor);
  assert.equal(other.created.length, 1);

  // Máy hỏng thì từ chối.
  update('machines', machine.id, { condition: 'hong' });
  const { steps: stepsC } = plotWithPlan();
  const broken = assignment.assignWork({
    planStepId: stepsC[0].id as string, machineIds: [machine.id], plannedDate: '2026-02-01',
  }, actor);
  assert.equal(broken.created.length, 0);
  assert.match(broken.skipped[0].reason, /hong/);
  update('machines', machine.id, { condition: 'hoat_dong' });
});

test('MÔ HÌNH 2 — thành viên chủ động: Ban quản trị không giao việc nhân công cho người khác', () => {
  const owner = newFarmer('Chủ thửa');
  const other = newFarmer('Người khác');
  const { plot, steps } = plotWithPlan(owner.id);

  assignment.setOperatingModel(htxRow.id, 'thanh_vien_chu_dong', actor);
  try {
    // Giao cho người KHÔNG phải chủ thửa → bị chặn.
    const blocked = assignment.assignWork({
      planStepId: steps[0].id as string, farmerIds: [other.id],
    }, actor);
    assert.equal(blocked.created.length, 0);
    assert.match(blocked.skipped[0].reason, /Thành viên chủ động/);

    // Chủ thửa tự nhận việc trên thửa của mình → được.
    const allowed = assignment.assignWork({
      planStepId: steps[0].id as string, farmerIds: [owner.id],
    }, actor);
    assert.equal(allowed.created.length, 1);

    // Máy móc dùng chung vẫn do Ban quản trị điều phối ở CẢ HAI mô hình.
    const machine = one<{ id: string }>(
      "SELECT id FROM machines WHERE condition = 'hoat_dong' AND htx_id = ? LIMIT 1", [htxRow.id],
    );
    if (machine) {
      const dispatched = assignment.assignWork({
        planStepId: steps[1].id as string, machineIds: [machine.id], plannedDate: '2026-03-15',
      }, actor);
      assert.equal(dispatched.created.length, 1, 'điều phối máy phải được phép ở mô hình 2');
    }

    assert.equal((assignment.plotWorkPlan(plot.id) as Record<string, unknown>).operatingModel,
      'thanh_vien_chu_dong');
  } finally {
    assignment.setOperatingModel(htxRow.id, 'tap_trung', actor);
  }
});

test('MÔ HÌNH 2 — thửa chưa gán chủ thì quy tắc không áp được, hệ thống phải nói rõ', () => {
  // Không có chủ thửa thì không có ai để "tự chủ", nên quy tắc mất căn cứ.
  // Cho phép phân công là đúng (nếu chặn thì thửa vô chủ thành không làm được),
  // nhưng phải nói ra — im lặng sẽ khiến Ban quản trị tưởng mô hình đang có hiệu lực.
  const { plot, steps } = plotWithPlan();
  const farmer = newFarmer('Người bất kỳ');

  assignment.setOperatingModel(htxRow.id, 'thanh_vien_chu_dong', actor);
  try {
    const workPlan = assignment.plotWorkPlan(plot.id) as Record<string, unknown>;
    assert.match(String(workPlan.notice), /chưa gán chủ thửa/);

    const result = assignment.assignWork({
      planStepId: steps[0].id as string, farmerIds: [farmer.id],
    }, actor);
    assert.equal(result.created.length, 1, 'vẫn phân công được');
    assert.equal(result.warnings.length, 1, 'nhưng phải kèm cảnh báo');
    assert.match(result.warnings[0], /chưa gán chủ thửa/);
  } finally {
    assignment.setOperatingModel(htxRow.id, 'tap_trung', actor);
  }
});

test('Chuyển đổi mô hình linh hoạt, không xoá phân công đã tạo', () => {
  const { steps } = plotWithPlan();
  const farmer = newFarmer('Thành viên C');
  assignment.assignWork({ planStepId: steps[0].id as string, farmerIds: [farmer.id] }, actor);
  const before = assignment.listAssignments(steps[0].id as string).length;

  assignment.setOperatingModel(htxRow.id, 'thanh_vien_chu_dong', actor);
  assert.equal(assignment.getOperatingModel(htxRow.id), 'thanh_vien_chu_dong');
  assert.equal(assignment.listAssignments(steps[0].id as string).length, before,
    'đổi mô hình không được xoá phân công cũ');

  assignment.setOperatingModel(htxRow.id, 'tap_trung', actor);
  assert.equal(assignment.getOperatingModel(htxRow.id), 'tap_trung');
  assert.throws(() => assignment.setOperatingModel(htxRow.id, 'mo_hinh_la', actor), /không hợp lệ/);
});

test('Từ chối phân công phải nêu lý do', () => {
  const { steps } = plotWithPlan();
  const farmer = newFarmer('Thành viên D');
  const result = assignment.assignWork({ planStepId: steps[0].id as string, farmerIds: [farmer.id] }, actor);
  const id = result.created[0].id as string;

  assert.throws(() => assignment.respondToAssignment(id, { status: 'tu_choi' }, actor), /phải nêu lý do/);

  const declined = assignment.respondToAssignment(
    id, { status: 'tu_choi', reason: 'Trùng lịch gia đình' }, actor,
  );
  assert.equal(declined.status, 'tu_choi');
  assert.equal(declined.decline_reason, 'Trùng lịch gia đình');

  // Bảng việc của thành viên chỉ còn việc đang hiệu lực.
  assert.equal(assignment.workloadForFarmer(farmer.id).length, 0);
});

// ===========================================================================
// 3 — Vật tư: mua sắm, tồn kho, cấp phát
// ===========================================================================

function buyItem(itemCode: string, qty: number, extra: Record<string, unknown> = {}) {
  const item = one<{ id: string }>('SELECT id FROM input_items WHERE code = ?', [itemCode])!;
  const purchase = inputs.createPurchase({
    htxId: htxRow.id, supplier: 'Đại lý VTNN Bình Minh', purchaseDate: '2026-01-05',
    lines: [{ itemId: item.id, qty, unitPrice: 12_000, batchNo: `LOT-${itemCode}-${qty}`, ...extra }],
  }, actor) as Record<string, unknown>;
  const stock = all<{ id: string; qty_on_hand: number }>(
    'SELECT id, qty_on_hand FROM input_stock WHERE purchase_id = ?', [purchase.id],
  )[0];
  return { item, purchase, stock };
}

test('Mua vật tư nhập kho theo LÔ, không cộng dồn thành một con số', () => {
  const item = one<{ id: string }>("SELECT id FROM input_items WHERE code = 'VT-URE'")!;
  inputs.createPurchase({
    htxId: htxRow.id, purchaseDate: '2026-01-05',
    lines: [
      { itemId: item.id, qty: 500, unitPrice: 12_000, batchNo: 'LO-A', expiryDate: '2027-01-01' },
      { itemId: item.id, qty: 300, unitPrice: 12_500, batchNo: 'LO-B', expiryDate: '2027-06-01' },
    ],
  }, actor);

  const batches = inputs.stockOnHand(htxRow.id).filter((row) => row.batch_no === 'LO-A' || row.batch_no === 'LO-B');
  assert.equal(batches.length, 2, 'hai lô phải là hai dòng tồn kho riêng');

  const summary = inputs.stockSummary(htxRow.id).find((row) => row.item_id === item.id)!;
  assert.ok(Number(summary.batch_count) >= 2, 'bảng tổng hợp mới gộp lô để hiển thị');
});

test('IN-02 — không cấp phát quá tồn kho của lô', () => {
  const { stock } = buyItem('VT-DAP', 100);
  const plot = newPlot();
  assert.throws(
    () => inputs.issueToPlot({ stockId: stock.id, plotId: plot.id, qty: 150 }, actor),
    /chỉ còn 100/,
  );
});

test('IN-03 — không cấp phát vật tư đã hết hạn', () => {
  const { stock } = buyItem('VT-KALI', 50, { expiryDate: '2026-01-20' });
  const plot = newPlot();
  assert.throws(
    () => inputs.issueToPlot({ stockId: stock.id, plotId: plot.id, qty: 10, issueDate: '2026-03-01' }, actor),
    /hết hạn/,
  );
});

test('IN-04 — thuốc ngoài danh mục được phép thì không cấp phát', () => {
  const { stock } = buyItem('VT-BVTV-CAM', 5);
  const plot = newPlot();
  assert.throws(
    () => inputs.issueToPlot({ stockId: stock.id, plotId: plot.id, qty: 1 }, actor),
    /không nằm trong danh mục được phép/,
  );
});

test('IN-06 — chỉ cấp vật tư cho thửa thuộc chính HTX giữ kho', () => {
  const { stock } = buyItem('VT-NPK', 200);
  const otherHtx = mdm.createCooperative({ name: 'HTX ngoài', lat: 10.6, lng: 105.6 }, actor) as { id: string };
  const foreignPlot = mdm.createPlot(
    { htxId: otherHtx.id, boundary: square(1.2) }, actor,
  ) as { id: string };
  assert.throws(
    () => inputs.issueToPlot({ stockId: stock.id, plotId: foreignPlot.id, qty: 10 }, actor),
    /không thuộc HTX/,
  );
});

test('Cấp phát trừ đúng tồn kho và gắn vào vụ để truy xuất', () => {
  const { stock, item } = buyItem('VT-URE', 400);
  const { plot, cycle, steps } = plotWithPlan();

  const result = inputs.issueToPlot({
    stockId: stock.id, plotId: plot.id, qty: 120,
    planStepId: steps[4].id as string, issueDate: '2026-01-28',
  }, actor);

  assert.equal(result.remainingQty, 280);
  assert.equal(result.issue.crop_cycle_id, cycle.id, 'phải tự gắn vào vụ đang canh tác');
  assert.equal(result.warnings.length, 0);

  const trace = inputs.inputTraceability(cycle.id) as Record<string, unknown>;
  assert.equal(trace.totalIssues, 1);
  const issued = (trace.issues as Record<string, unknown>[])[0];
  assert.equal(issued.item_id, item.id);
  assert.equal(issued.batch_no, 'LOT-VT-URE-400', 'truy xuất phải lần ra đúng số lô');
});

test('IN-05 — cấp thuốc có cách ly sát ngày thu hoạch thì cảnh báo', () => {
  const { plot, cycle } = plotWithPlan();
  const harvest = one<{ planned_date: string }>(
    `SELECT s.planned_date FROM production_plan_steps s
       JOIN production_plans pl ON pl.id = s.plan_id
      WHERE pl.crop_cycle_id = ? AND s.activity = 'thu_hoach'`,
    [cycle.id],
  )!;
  // Thuốc cách ly 21 ngày, cấp phát chỉ 5 ngày trước ngày thu hoạch dự kiến.
  const issueDate = new Date(
    new Date(`${harvest.planned_date}T00:00:00Z`).getTime() - 5 * 86_400_000,
  ).toISOString().slice(0, 10);

  const { stock } = buyItem('VT-BVTV-02', 10, { expiryDate: '2027-12-31' });
  const result = inputs.issueToPlot(
    { stockId: stock.id, plotId: plot.id, qty: 2, issueDate }, actor,
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /cách ly 21 ngày/);
  assert.match(result.warnings[0], /dời lịch/);
});

// ===========================================================================
// 5 — Khảo sát và cây hành chính lọc dần
// ===========================================================================

test('Dropdown hành chính lọc dần: xã theo tỉnh, ấp theo xã', () => {
  const provinces = survey.adminChildren(null, 'province');
  assert.ok(provinces.length > 0, 'phải có tỉnh ở gốc');

  const province = provinces[0];
  const communes = survey.adminChildren(province.id as string, 'commune');
  assert.ok(communes.length > 0, `tỉnh ${province.name} phải có xã`);
  assert.ok(communes.every((c) => c.parent_id === province.id), 'mọi xã trả về phải thuộc tỉnh đã chọn');

  const commune = communes[0];
  const hamlets = survey.adminChildren(commune.id as string, 'ap');
  assert.ok(hamlets.length > 0, `xã ${commune.name} phải có thôn/ấp`);
  assert.ok(hamlets.every((h) => h.parent_id === commune.id), 'mọi ấp trả về phải thuộc xã đã chọn');

  // Xã của tỉnh khác không được lọt vào danh sách.
  if (provinces.length > 1) {
    const otherCommunes = survey.adminChildren(provinces[1].id as string, 'commune');
    const overlap = otherCommunes.filter((c) => communes.some((x) => x.id === c.id));
    assert.equal(overlap.length, 0);
  }

  const path = survey.adminPath(hamlets[0].id as string);
  assert.equal(path.length, 3, 'đường dẫn phải đủ tỉnh → xã → ấp');
  assert.equal(path[0].level, 'province');
  assert.equal(path[2].level, 'ap');
});

test('Cây hành chính phủ đủ CẢ các tỉnh đã bị sáp nhập', () => {
  // Bảng sáp nhập dùng khoá chuẩn hoá không dấu. Tra bằng tên có dấu sẽ trượt và
  // toàn bộ huyện của Kiên Giang, Tiền Giang, Bến Tre... biến mất khỏi cây.
  const provinces = survey.adminChildren(null, 'province');
  assert.equal(provinces.length, 6);

  for (const province of provinces) {
    const communes = survey.adminChildren(province.id as string, 'commune');
    assert.ok(communes.length > 0, `tỉnh ${province.name} không có xã nào`);
  }

  const communeCount = all("SELECT id FROM admin_units WHERE level = 'commune'").length;
  assert.ok(communeCount > 100,
    `mới có ${communeCount} xã — dấu hiệu các tỉnh bị sáp nhập đang bị bỏ sót`);
  assert.equal(
    all("SELECT id FROM admin_units WHERE level = 'ap'").length, communeCount * 5,
    'mỗi xã phải có đủ 5 thôn/ấp',
  );
});

test('SV-04 — ấp không thuộc xã đã chọn thì từ chối phiếu', () => {
  const template = one<{ id: string }>("SELECT id FROM survey_templates WHERE code = 'KS-HTSX'")!;
  const questions = survey.listQuestions(template.id);
  const required = questions.filter((q) => q.required);

  const provinces = survey.adminChildren(null, 'province');
  const communes = survey.adminChildren(provinces[0].id as string, 'commune');
  const hamletsOfOther = survey.adminChildren(communes[1].id as string, 'ap');

  assert.throws(() => survey.submitResponse({
    templateId: template.id, period: '2026-04', subjectKind: 'ho_dan',
    subjectName: 'Hộ Nguyễn Văn A',
    provinceId: provinces[0].id as string,
    communeId: communes[0].id as string,
    hamletId: hamletsOfOther[0].id as string,
    answers: required.map((q) => ({ questionId: q.id as string, value: q.kind === 'number' ? 1 : 'Kênh nội đồng' })),
  }, actor), /không thuộc xã đã chọn/);
});

test('SV-01/SV-03/SV-05 — mẫu phải ban hành, câu bắt buộc phải trả lời, kỳ đúng định dạng', () => {
  const draft = survey.createTemplate({ name: 'Mẫu nháp', frequency: 'thang' }, actor) as { id: string };
  survey.addQuestion(draft.id, { label: 'Câu hỏi', required: true }, actor);
  assert.throws(() => survey.submitResponse({
    templateId: draft.id, period: '2026-04', subjectKind: 'ho_dan', subjectName: 'A',
  }, actor), /chưa được ban hành/);

  const template = one<{ id: string }>("SELECT id FROM survey_templates WHERE code = 'KS-HTSX'")!;
  const required = survey.listQuestions(template.id).filter((q) => q.required);

  // Thiếu câu bắt buộc.
  assert.throws(() => survey.submitResponse({
    templateId: template.id, period: '2026-04', subjectKind: 'ho_dan', subjectName: 'B',
  }, actor), /bắt buộc chưa có trả lời/);

  // Kỳ sai định dạng của tần suất "tháng".
  assert.throws(() => survey.submitResponse({
    templateId: template.id, period: '2026-W12', subjectKind: 'ho_dan', subjectName: 'B',
    answers: required.map((q) => ({ questionId: q.id as string, value: q.kind === 'number' ? 1 : 'Kênh nội đồng' })),
  }, actor), /không đúng định dạng YYYY-MM/);
});

test('SV-02 — nhập lại cùng đối tượng trong cùng kỳ là CẬP NHẬT, không tạo bản trùng', () => {
  const template = one<{ id: string }>("SELECT id FROM survey_templates WHERE code = 'KS-HTSX'")!;
  const required = survey.listQuestions(template.id).filter((q) => q.required);
  const farmer = newFarmer('Hộ khảo sát');
  const answers = (area: number) => required.map((q) => ({
    questionId: q.id as string, value: q.kind === 'number' ? area : 'Kênh nội đồng',
  }));

  const first = survey.submitResponse({
    templateId: template.id, period: '2026-05', subjectKind: 'ho_dan',
    farmerId: farmer.id, subjectName: farmer.full_name,
    cycleStartDate: '2026-04-20', productionStatus: 'ma_non',
    answers: answers(2.5),
  }, actor);

  const second = survey.submitResponse({
    templateId: template.id, period: '2026-05', subjectKind: 'ho_dan',
    farmerId: farmer.id, subjectName: farmer.full_name,
    cycleStartDate: '2026-04-22', productionStatus: 'de_nhanh',
    answers: answers(3.1),
  }, actor);

  assert.equal(second.id, first.id, 'phải cập nhật đúng phiếu cũ');
  assert.equal(second.code, first.code);
  assert.equal(second.production_status, 'de_nhanh');
  assert.equal(second.cycle_start_date, '2026-04-22');

  // Câu trả lời cũ bị thay, không cộng dồn.
  const numeric = (second.answers as Record<string, unknown>[]).find((a) => a.kind === 'number')!;
  assert.equal(numeric.value_number, 3.1);
  assert.equal(
    survey.listResponses({ templateId: template.id, period: '2026-05' }).length, 1,
    'chỉ được có một phiếu cho đối tượng này trong kỳ',
  );
});

test('Tổng hợp khảo sát gom theo hiện trạng sản xuất và theo xã', () => {
  const template = one<{ id: string }>("SELECT id FROM survey_templates WHERE code = 'KS-HTSX'")!;
  const summary = survey.surveySummary(template.id) as Record<string, unknown>;
  assert.ok(Number(summary.total) >= 1);
  const statuses = summary.byStatus as Record<string, unknown>[];
  assert.ok(statuses.some((row) => row.label && row.n));
});

// ===========================================================================
// 7 — Khởi tạo HTX theo mã số thuế và kích hoạt
// ===========================================================================

test('MST-01 — mã số thuế phải 10 hoặc 13 chữ số', () => {
  assert.equal(registry.normalizeTaxCode('1600 123 456'), '1600123456');
  assert.equal(registry.normalizeTaxCode('1600123456001'), '1600123456-001');
  assert.throws(() => registry.normalizeTaxCode('12345'), /không hợp lệ/);
  assert.throws(() => registry.normalizeTaxCode('abc'), /không hợp lệ/);
});

test('Khuyến nông lập hồ sơ HTX kèm MST; MST không được trùng', () => {
  const created = registry.registerByExtension({
    taxCode: '1600999888', name: 'HTX Tân Tiến', contactName: 'Ông Ba', contactPhone: '0919000111',
    lat: 10.42, lng: 105.48,
  }, actor);

  assert.equal(created.tax_code, '1600999888');
  assert.equal(created.origin, 'khuyennong');
  assert.equal(created.claimed_at, null, 'hồ sơ mới lập chưa được kích hoạt');

  assert.throws(() => registry.registerByExtension({ taxCode: '1600999888', name: 'HTX trùng MST' }, actor),
    /đã gắn với hồ sơ/);
});

test('HTX kích hoạt bằng MST thì thừa hưởng dữ liệu Khuyến nông đã lập', () => {
  const created = registry.registerByExtension({
    taxCode: '1600777666', name: 'HTX Thới Bình', lat: 10.44, lng: 105.52,
  }, actor) as { id: string };

  // Cán bộ khuyến nông vẽ sẵn 2 thửa và ghi nhận 3 thành viên.
  plotOffset += 0.05;
  mdm.createPlot({ htxId: created.id, boundary: square(plotOffset), source: 'app_khuyennong' }, actor);
  plotOffset += 0.02;
  mdm.createPlot({ htxId: created.id, boundary: square(plotOffset), source: 'app_khuyennong' }, actor);
  for (const name of ['Hộ 1', 'Hộ 2', 'Hộ 3']) {
    mdm.createFarmer({ fullName: name, htxId: created.id }, actor);
  }

  // Xem trước phải nói rõ sẽ nhận được gì TRƯỚC khi bấm kích hoạt.
  const preview = registry.previewClaim('1600777666');
  assert.equal(preview.alreadyClaimed, false);
  assert.equal(preview.inherits.plots, 2);
  assert.equal(preview.inherits.farmers, 3);
  assert.ok(preview.inherits.plotAreaHa > 0);

  const claimed = registry.claimByTaxCode({ taxCode: '1600777666' }, actor);
  assert.ok(claimed.claimedAt);
  assert.equal(claimed.inherits.plots, 2, 'dữ liệu vẫn nguyên vẹn sau khi kích hoạt');

  // MST-03
  assert.throws(() => registry.claimByTaxCode({ taxCode: '1600777666' }, actor), /đã được kích hoạt/);
});

test('Kích hoạt bằng MST chưa có hồ sơ thì nói rõ, không tạo hồ sơ rỗng', () => {
  assert.throws(() => registry.previewClaim('1600111222'), /Chưa có hồ sơ nào/);
  assert.equal(all("SELECT id FROM cooperatives WHERE tax_code = '1600111222'").length, 0);
});

test('Danh sách hồ sơ Khuyến nông lập nhưng HTX chưa kích hoạt', () => {
  const pending = registry.pendingClaims();
  const codes = pending.map((row) => row.tax_code);
  assert.ok(codes.includes('1600999888'), 'HTX Tân Tiến chưa kích hoạt phải nằm trong danh sách');
  assert.ok(!codes.includes('1600777666'), 'HTX đã kích hoạt phải rời khỏi danh sách');
});

test('Gán MST cho hồ sơ HTX đã có, chặn trùng và chặn đổi sau khi đã kích hoạt', () => {
  const target = mdm.createCooperative({ name: 'HTX chưa có MST', lat: 10.7, lng: 105.7 }, actor) as { id: string };
  const updated = registry.setTaxCode(target.id, '1600555444', actor);
  assert.equal(updated.tax_code, '1600555444');

  assert.throws(() => registry.setTaxCode(target.id, '1600999888', actor), /đã gắn với/);

  const claimedHtx = one<{ id: string }>("SELECT id FROM cooperatives WHERE tax_code = '1600777666'")!;
  assert.throws(() => registry.setTaxCode(claimedHtx.id, '1600333222', actor), /đã kích hoạt/);
});
