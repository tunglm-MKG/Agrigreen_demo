/**
 * Kiểm thử mạng lưới đường thuỷ:
 *
 *   1. Tự động nhận diện cấu trúc mạng lưới (giao cắt, nối chữ T, khe hở)
 *   2. Thông số rộng / sâu / tĩnh không cầu → suy ra tải trọng lưu thông
 *   3. Đường đi TỐI ƯU Hub → Nhà máy, có ràng buộc theo lớp phương tiện
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

configureDatabase(join(mkdtempSync(join(tmpdir(), 'mekong-ww-')), 'test.db'));

const { migrate } = await import('../src/platform/db/schema.ts');
const { seedAll } = await import('../src/seed.ts');
const ww = await import('../src/agrigreen/gis/waterways.ts');
const wnet = await import('../src/agrigreen/gis/waterwayNetwork.ts');
const vessels = await import('../src/platform/geo/vessels.ts');
const { DistanceService } = await import('../src/platform/geo/distance.ts');

migrate();
seedAll();

const actor = { name: 'test' };

function service() {
  return new DistanceService({
    correctionFactors: { road: 1.3, waterway: 1.45 },
    waterwayAccessRadiusKm: 8,
    refresh: true,
  });
}

/** Tạo một tuyến đã xác nhận với thông số kỹ thuật cho trước. */
function route(
  name: string,
  points: { lat: number; lng: number }[],
  spec: { widthM?: number; depthM?: number; clearanceM?: number } = {},
) {
  const created = ww.createRoute({
    name, mode: 'waterway', points,
    widthM: spec.widthM, depthM: spec.depthM, clearanceM: spec.clearanceM,
  }, actor) as { route: { id: string; code: string } };
  ww.setRouteStatus(created.route.id, 'da_xac_nhan', actor);
  return created.route;
}

// ===========================================================================
// 2 — Tải trọng lưu thông suy ra từ thông số kỹ thuật
// ===========================================================================

test('Tải trọng suy ra từ rộng / sâu / tĩnh không, không phải số nhập tay', () => {
  // Kênh rộng và sâu, không có cầu → sà lan lớn nhất qua được.
  const big = route('Sông lớn test', [
    { lat: 10.10, lng: 105.10 }, { lat: 10.20, lng: 105.20 },
  ], { widthM: 200, depthM: 8 });
  const bigCapacity = wnet.deriveRouteCapacity(big.id, actor);
  assert.equal(bigCapacity.maxLoadTons, 2_000);
  assert.equal(bigCapacity.certainty, 'du_lieu_day_du');

  // Cùng kênh đó, thêm một cây cầu tĩnh không 5 m → chỉ còn ghe qua được.
  wnet.addStructure({
    routeId: big.id, name: 'Cầu thấp test', kind: 'cau',
    lat: 10.15, lng: 105.15, clearanceHeightM: 5, clearanceWidthM: 40, depthM: 6,
  }, actor);
  const afterBridge = wnet.deriveRouteCapacity(big.id, actor);
  assert.equal(afterBridge.maxLoadTons, 100, 'một cây cầu thấp hạ cả tuyến xuống mức ghe');
  assert.equal(afterBridge.constraints.limitingStructure, 'Cầu thấp test');

  // Ghi vào CSDL để định tuyến dùng được.
  const stored = one<{ derived_max_load_tons: number; derived_vessel_code: string }>(
    'SELECT derived_max_load_tons, derived_vessel_code FROM transport_routes WHERE id = ?', [big.id],
  )!;
  assert.equal(stored.derived_max_load_tons, 100);
  assert.equal(stored.derived_vessel_code, 'ghe_100t');
});

test('Thiếu số liệu KHÔNG được coi là đi được', () => {
  const unknown = route('Kênh chưa đo test', [
    { lat: 10.30, lng: 105.10 }, { lat: 10.35, lng: 105.15 },
  ], { widthM: 100 }); // chỉ có chiều rộng, chưa đo độ sâu

  const capacity = wnet.deriveRouteCapacity(unknown.id, actor);
  assert.equal(capacity.certainty, 'thieu_du_lieu');
  assert.equal(capacity.maxLoadTons, 0, 'thiếu độ sâu thì không kết luận tải trọng');
  assert.ok(capacity.reasons.some((r) => r.includes('độ sâu')));
});

test('Không lớp phương tiện nào qua được thì nói rõ lý do', () => {
  const tiny = route('Rạch nhỏ test', [
    { lat: 10.40, lng: 105.10 }, { lat: 10.42, lng: 105.12 },
  ], { widthM: 4, depthM: 0.8 });
  const capacity = wnet.deriveRouteCapacity(tiny.id, actor);
  assert.equal(capacity.maxLoadTons, 0);
  assert.equal(capacity.certainty, 'du_lieu_day_du');
  assert.ok(capacity.reasons.some((r) => r.includes('Ghe 100 tấn')), 'phải nêu ngay cả ghe cũng không qua');
});

test('Biên an toàn được áp: kênh vừa khít thân tàu vẫn không qua được', () => {
  const beam = vessels.VESSEL_CLASSES[1].beamM; // sà lan 1.000 tấn: 10 m
  const exact = vessels.canPass(vessels.VESSEL_CLASSES[1], { widthM: beam, depthM: 5, clearanceM: 20 });
  assert.equal(exact.passes, false, 'kênh rộng đúng bằng thân tàu là không đủ chỗ lái');

  const enough = vessels.canPass(vessels.VESSEL_CLASSES[1], {
    widthM: beam * vessels.SAFETY_MARGINS.widthFactor, depthM: 5, clearanceM: 20,
  });
  assert.equal(enough.passes, true);

  // Mớn nước cần thêm khoảng nước dưới đáy.
  const draft = vessels.VESSEL_CLASSES[1].draftM;
  assert.equal(vessels.canPass(vessels.VESSEL_CLASSES[1], { widthM: 30, depthM: draft, clearanceM: 20 }).passes, false);
  assert.equal(
    vessels.canPass(vessels.VESSEL_CLASSES[1], {
      widthM: 30, depthM: draft + vessels.SAFETY_MARGINS.underKeelM, clearanceM: 20,
    }).passes, true,
  );
});

test('Công trình phải nằm trên tuyến — toạ độ sai chỗ bị từ chối', () => {
  const line = route('Kênh test vị trí', [
    { lat: 10.50, lng: 105.10 }, { lat: 10.55, lng: 105.15 },
  ], { widthM: 60, depthM: 5 });
  assert.throws(
    () => wnet.addStructure({ routeId: line.id, name: 'Cầu lạc', lat: 9.0, lng: 104.0 }, actor),
    /cách tuyến/,
  );
});

test('Xoá công trình thì tải trọng được tính lại, không giữ giá trị cũ', () => {
  const line = route('Kênh test xoá cầu', [
    { lat: 10.60, lng: 105.10 }, { lat: 10.65, lng: 105.15 },
  ], { widthM: 200, depthM: 8 });
  const bridge = wnet.addStructure({
    routeId: line.id, name: 'Cầu tạm', lat: 10.62, lng: 105.12, clearanceHeightM: 3.5,
  }, actor) as { id: string };
  // Ghe cần 3,5 m tĩnh không + 0,5 m dự trữ = 4,0 m, nên cầu 3,5 m chặn cả ghe.
  assert.equal(wnet.deriveRouteCapacity(line.id).maxLoadTons, 0, 'cầu 3,5 m chặn cả ghe');

  wnet.removeStructure(bridge.id, actor);
  assert.equal(wnet.deriveRouteCapacity(line.id).maxLoadTons, 2_000, 'gỡ cầu thì tuyến trở lại bình thường');
});

// ===========================================================================
// 1 — Nhận diện cấu trúc mạng lưới
// ===========================================================================

test('Nhận diện hai tuyến CẮT NHAU nhưng không có đỉnh chung', () => {
  // Hai đường chéo cắt nhau ở giữa, không tuyến nào có đỉnh tại giao điểm.
  route('Chéo A test', [{ lat: 11.00, lng: 106.00 }, { lat: 11.10, lng: 106.10 }], { widthM: 80, depthM: 5 });
  route('Chéo B test', [{ lat: 11.10, lng: 106.00 }, { lat: 11.00, lng: 106.10 }], { widthM: 80, depthM: 5 });

  const analysis = wnet.analyzeNetwork();
  const crossing = analysis.findings.filter((f) => f.kind === 'giao_cat');
  assert.ok(crossing.length >= 1, 'phải phát hiện giao cắt');
  assert.ok(crossing.every((f) => f.autoFixable));

  // Trước khi dựng lại: hai tuyến này là hai cụm rời.
  const before = wnet.analyzeNetwork();
  const rebuilt = wnet.rebuildNetwork({}, actor);
  assert.ok(rebuilt.verticesInserted >= 2, 'phải chèn đỉnh vào cả hai tuyến');
  assert.ok(
    rebuilt.analysisAfter.componentCount < before.componentCount,
    'dựng lại phải làm giảm số cụm rời',
  );
  assert.equal(
    rebuilt.analysisAfter.findings.filter((f) => f.kind === 'giao_cat').length, 0,
    'không còn giao cắt thiếu đỉnh',
  );
});

test('Khe hở nhỏ nối được tự động; khe hở lớn chỉ báo cáo', () => {
  route('Khe nhỏ A', [{ lat: 12.00, lng: 106.00 }, { lat: 12.02, lng: 106.02 }], { widthM: 60, depthM: 4 });
  // Cách đầu tuyến trên khoảng 100 m — trong ngưỡng nối tự động.
  route('Khe nhỏ B', [{ lat: 12.0209, lng: 106.0209 }, { lat: 12.04, lng: 106.04 }], { widthM: 60, depthM: 4 });
  // Cách khoảng 470 m — vẫn được báo cáo nhưng vượt ngưỡng nối tự động 150 m.
  route('Khe lớn C', [{ lat: 12.20, lng: 106.20 }, { lat: 12.22, lng: 106.22 }], { widthM: 60, depthM: 4 });
  route('Khe lớn D', [{ lat: 12.2230, lng: 106.2230 }, { lat: 12.25, lng: 106.25 }], { widthM: 60, depthM: 4 });

  const analysis = wnet.analyzeNetwork();
  const gaps = analysis.findings.filter((f) => f.kind === 'khe_ho');
  assert.ok(gaps.length >= 2, 'phải thấy cả khe nhỏ lẫn khe lớn');
  assert.ok(gaps.some((f) => f.autoFixable), 'khe nhỏ phải nối được');
  assert.ok(gaps.some((f) => !f.autoFixable), 'khe lớn không được nối tự động');

  const rebuilt = wnet.rebuildNetwork({ joinGaps: true }, actor);
  assert.ok(rebuilt.gapsJoined.length >= 1, 'phải nối được khe nhỏ');
  assert.ok(
    rebuilt.skipped.some((s) => s.reason.includes('vượt ngưỡng')),
    'khe lớn phải bị bỏ qua kèm lý do, không nối bừa',
  );

  // Không bật tuỳ chọn thì không nối khe hở nào.
  const conservative = wnet.rebuildNetwork({}, actor);
  assert.equal(conservative.gapsJoined.length, 0);
});

test('Tuyến "Nháp" không tham gia phân tích mạng lưới (FN-20 BR-04)', () => {
  const draft = ww.createRoute({
    name: 'Tuyến nháp test', mode: 'waterway',
    points: [{ lat: 13.00, lng: 107.00 }, { lat: 13.05, lng: 107.05 }],
  }, actor) as { route: { id: string } };

  const analysis = wnet.analyzeNetwork();
  assert.ok(
    !analysis.facilityAccess.some((f) => f.nearestRouteCode === 'WW-DRAFT'),
    'tuyến nháp không xuất hiện trong phân tích',
  );
  const confirmedIds = all<{ id: string }>(
    "SELECT id FROM transport_routes WHERE mode='waterway' AND status='da_xac_nhan'",
  ).map((r) => r.id);
  assert.ok(!confirmedIds.includes(draft.route.id));
});

test('Báo cáo cơ sở KHÔNG tiếp cận được mạng lưới đường thuỷ', () => {
  const analysis = wnet.analyzeNetwork();
  assert.ok(analysis.facilityAccess.length > 0, 'phải liệt kê hub và nhà máy');

  const plant = analysis.facilityAccess.find((f) => f.kind === 'plant');
  assert.ok(plant, 'phải có nhà máy trong danh sách');
  assert.ok(plant!.nearestKm >= 0);

  // Đưa nhà máy ra giữa nơi không có kênh nào → phải báo mất kết nối.
  const before = { lat: plant!.lat, lng: plant!.lng };
  update('facilities', plant!.id, { lat: 15.5, lng: 108.5 });
  const moved = wnet.analyzeNetwork();
  const movedPlant = moved.facilityAccess.find((f) => f.kind === 'plant')!;
  assert.equal(movedPlant.connected, false);
  assert.ok(moved.disconnectedFacilities >= 1);
  assert.ok(
    moved.notes.some((n) => n.includes('vượt bán kính tiếp cận')),
    'phải nói rõ hệ quả: mọi chặng đường thuỷ rơi về Haversine hiệu chỉnh',
  );
  update('facilities', plant!.id, before);
});

// ===========================================================================
// 3 — Đường đi tối ưu có ràng buộc phương tiện
// ===========================================================================

test('Đường đi tối ưu trả về hình học và danh sách tuyến đi qua', () => {
  const hub = one<{ lat: number; lng: number }>(
    "SELECT lat, lng FROM candidate_hubs WHERE code = 'HUB-0003'",
  );
  const plant = one<{ lat: number; lng: number }>("SELECT lat, lng FROM facilities WHERE kind='plant' LIMIT 1")!;
  if (!hub) return;

  const result = service().optimalRoute(hub, plant, 'waterway');
  if (!result.found) {
    // Mạng lưới seed có thể chưa nối tới nhà máy — khi đó phải nói rõ lý do,
    // không im lặng trả về một con số trông như cự ly thực tế.
    assert.equal(result.source, 'haversine_hieu_chinh');
    assert.ok(result.reason && result.reason.length > 0);
    return;
  }
  assert.ok(result.path.length >= 2, 'phải trả về hình học đường đi');
  assert.ok(result.routeCodes.length >= 1, 'phải biết đi qua những tuyến nào');
  assert.ok(result.distanceKm > 0);
});

test('Ràng buộc phương tiện loại bỏ tuyến mà sà lan không đi lọt', () => {
  // Hai tuyến song song nối cùng hai điểm: đường tắt hẹp và đường vòng rộng.
  const a = { lat: 14.00, lng: 106.00 };
  const b = { lat: 14.20, lng: 106.00 };

  // Đường tắt: thẳng, ngắn, nhưng chỉ vừa ghe.
  route('Tắt hẹp test', [a, { lat: 14.10, lng: 106.00 }, b], { widthM: 12, depthM: 2.0, clearanceM: 4.5 });
  // Đường vòng: dài hơn nhưng sà lan 1.000 tấn qua được.
  route('Vòng rộng test', [a, { lat: 14.10, lng: 106.12 }, b], { widthM: 60, depthM: 5, clearanceM: 20 });

  for (const id of all<{ id: string }>(
    "SELECT id FROM transport_routes WHERE name IN ('Tắt hẹp test','Vòng rộng test')",
  )) wnet.deriveRouteCapacity(id.id, actor);

  const svc = service();
  const byGhe = svc.optimalRoute(a, b, 'waterway', 'ghe_100t');
  const byBarge = svc.optimalRoute(a, b, 'waterway', 'sa_lan_1000t');

  assert.ok(byGhe.found && byBarge.found, 'cả hai phương tiện đều phải tìm được đường');
  assert.ok(
    byGhe.distanceKm < byBarge.distanceKm,
    `ghe phải đi được đường tắt ngắn hơn (${byGhe.distanceKm} vs ${byBarge.distanceKm} km)`,
  );
  assert.ok(byGhe.routeCodes.some((code) => code === routeCodeOf('Tắt hẹp test')));
  assert.ok(
    !byBarge.routeCodes.some((code) => code === routeCodeOf('Tắt hẹp test')),
    'sà lan không được đi qua tuyến mà nó không lọt',
  );
});

function routeCodeOf(name: string): string {
  return one<{ code: string }>('SELECT code FROM transport_routes WHERE name = ?', [name])!.code;
}

test('Bảng so sánh mọi lớp phương tiện trên cùng một chặng', () => {
  const a = { lat: 14.00, lng: 106.00 };
  const b = { lat: 14.20, lng: 106.00 };
  const options = service().routeOptions(a, b);

  assert.equal(options.length, vessels.VESSEL_CLASSES.length);
  assert.ok(options.every((row) => row.vesselLabel && row.tons > 0));

  const ghe = options.find((row) => row.vesselCode === 'ghe_100t')!;
  const barge2000 = options.find((row) => row.vesselCode === 'sa_lan_2000t')!;
  assert.ok(ghe.found);
  // Sà lan 2.000 tấn không lọt tuyến tắt; nếu tuyến vòng cũng không đủ thì phải
  // báo không đi được kèm lý do, chứ không trả số như thể đi được.
  if (!barge2000.found) assert.ok(barge2000.reason && barge2000.reason.includes('Sà lan 2.000 tấn'));
});

test('Tổng hợp năng lực mạng lưới theo lớp phương tiện', () => {
  wnet.deriveAllCapacities(actor);
  const overview = wnet.capacityOverview() as Record<string, unknown>;
  const byVessel = overview.byVessel as { code: string; routeCount: number; lengthKm: number }[];

  assert.equal(byVessel.length, vessels.VESSEL_CLASSES.length);
  // Phương tiện càng lớn thì số tuyến đi được càng ít hoặc bằng — không thể nhiều hơn.
  for (let i = 1; i < byVessel.length; i += 1) {
    assert.ok(
      byVessel[i].routeCount <= byVessel[i - 1].routeCount,
      `${byVessel[i].code} đi được nhiều tuyến hơn ${byVessel[i - 1].code} là vô lý`,
    );
  }
  assert.ok(Number(overview.totalRoutes) > 0);
});
