/**
 * Danh mục 49 THAM SỐ ĐẦU VÀO MÔ PHỎNG — BRD Supply Chain Hub Simulation v1.4, FN-01.
 *
 * Đánh số liên tục 1–49 theo 6 nhóm dữ liệu (bản v1.3 đã đánh số lại).
 * Phân bổ theo nguồn — FN-01 AC-03 kiểm tra đúng con số này:
 *   23/49 "Có thể lấy từ nguồn thị trường"
 *   24/49 "Cần input giả định"  (mỗi tham số phải có bản ghi trong Assumption Register)
 *    2/49 "Khác" (hằng số cấu hình một lần / hành động chọn điểm của người dùng)
 */

export type Classification = 'thi_truong' | 'gia_dinh' | 'khac';

export interface ParameterDefinition {
  number: number;
  code: string;
  name: string;
  unit: string;
  group: string;
  classification: Classification;
  /** Giá trị mặc định. `null` nghĩa là CHƯA CHỐT — hệ thống không được tự suy ra. */
  base: number | null;
  min?: number | null;
  max?: number | null;
  /** Giá trị phi số (ví dụ hệ số hiệu chỉnh theo từng phương thức). */
  textValue?: Record<string, unknown>;
  /** Dữ liệu nằm ở bảng master data khác, không phải một con số cấu hình. */
  managedElsewhere?: string;
  source?: string;
  note?: string;
  /** Mã giả định tương ứng trong Assumption Register (Mục I.9). */
  assumption?: string;
}

const G1 = '1. Vùng nguyên liệu & hành chính';
const G2 = '2. Cấu hình Hub mặc định';
const G3 = '3. Hệ số nông nghiệp & thu gom';
const G4 = '4. Đơn giá chi phí';
const G5 = '5. Thông số kỹ thuật kho & thiết bị';
const G6 = '6. Giả định tài chính & đầu tư';

export const PARAMETER_CATALOG: ParameterDefinition[] = [
  // ---------- Nhóm 1: Vùng nguyên liệu & hành chính (#1–#12) ----------
  {
    number: 1, code: 'admin_boundaries', name: 'Ranh giới tỉnh/thành sau sáp nhập (2025)',
    unit: 'Polygon (kinh/vĩ độ)', group: G1, classification: 'thi_truong', base: null,
    managedElsewhere: 'admin_units',
    source: 'Cục Thống kê / nền tảng GIS (Nghị quyết sáp nhập 2025)',
    note: 'RS-09: chưa có shapefile/GeoJSON chính thức — bản seed dùng ranh giới minh hoạ.',
  },
  {
    number: 2, code: 'htx_directory', name: 'Danh sách hợp tác xã (tên, địa bàn)',
    unit: 'Danh mục', group: G1, classification: 'thi_truong', base: null,
    managedElsewhere: 'cooperatives',
    source: 'Liên minh HTX cấp tỉnh; Sở NN&MT',
  },
  {
    number: 3, code: 'htx_coordinates', name: 'Toạ độ GPS của từng HTX/vùng nguyên liệu',
    unit: 'Độ (lat, lng)', group: G1, classification: 'thi_truong', base: null,
    managedElsewhere: 'cooperatives.lat/lng',
    source: 'Khảo sát GPS thực địa hoặc số hoá từ ảnh vệ tinh',
    note: 'RS-02: toạ độ thiếu/sai lệch làm hỏng toàn bộ khoảng cách theo từng HTX.',
  },
  {
    number: 4, code: 'planted_area', name: 'Diện tích gieo trồng theo HTX/vùng',
    unit: 'ha', group: G1, classification: 'thi_truong', base: null,
    managedElsewhere: 'harvest_statistics.planted_area_ha',
    note: 'Quyết định B3: CHỈ dùng để hiển thị và đối chiếu, không còn là input tính sản lượng.',
  },
  {
    number: 5, code: 'paddy_output', name: 'Sản lượng lúa theo HTX/vùng/mùa vụ (thống kê mùa vụ trước)',
    unit: 'tấn/mùa vụ', group: G1, classification: 'thi_truong', base: null,
    managedElsewhere: 'harvest_statistics.paddy_tons',
    note: 'Quyết định B3: NGUỒN DUY NHẤT của Total Available Supply (FN-06 BR-01).',
    assumption: 'AS-16',
  },
  {
    number: 6, code: 'farmer_count', name: 'Số nông hộ liên kết theo HTX',
    unit: 'hộ', group: G1, classification: 'thi_truong', base: null,
    managedElsewhere: 'cooperatives.member_count',
  },
  {
    number: 7, code: 'season_calendar', name: 'Lịch mùa vụ (Đông Xuân / Hè Thu / Thu Đông)',
    unit: 'Khoảng thời gian', group: G1, classification: 'thi_truong', base: null,
    managedElsewhere: 'seasons',
  },
  {
    number: 8, code: 'leg_distances', name: 'Khoảng cách Field→Hub, Hub→Plant và Field→Plant',
    unit: 'km', group: G1, classification: 'thi_truong', base: null,
    managedElsewhere: 'distance_cache (tính động theo FN-04 BR-01–BR-05)',
    note: 'Không phải giá trị cấu hình tĩnh — tính lại cho từng cặp toạ độ mỗi khi đặt Hub.',
  },
  {
    number: 9, code: 'waterway_network', name: 'Mạng lưới đường thủy/kênh rạch lưu thông được cho sà lan',
    unit: 'Line/Polyline (GIS)', group: G1, classification: 'gia_dinh', base: null,
    managedElsewhere: 'transport_routes (mode = waterway)',
    note: 'RS-01 — hạng mục dữ liệu rủi ro cao nhất. FN-20 cho phép tự số hoá trong hệ thống.',
    assumption: 'AS-05',
  },
  {
    number: 10, code: 'distance_correction', name: 'Hệ số hiệu chỉnh khoảng cách (Haversine → thực tế) theo phương thức',
    unit: 'Lần (hệ số nhân ≥ 1)', group: G1, classification: 'gia_dinh', base: 1.3, min: 1.15, max: 1.5,
    textValue: { road: 1.3, waterway: 1.45 },
    note: 'Logistics hiệu chỉnh bằng cách so Haversine với cự ly thực đo của ≥ 10–15 tuyến/phương thức.',
    assumption: 'AS-06',
  },
  {
    number: 11, code: 'plant_coordinates', name: 'Toạ độ GPS Nhà máy VFT',
    unit: 'Độ (lat, lng)', group: G1, classification: 'khac', base: null,
    managedElsewhere: 'facilities (kind = plant)',
    note: 'Hằng số cấu hình một lần — V1 chỉ có một nhà máy đầu ra cố định.',
  },
  {
    number: 12, code: 'plant_annual_demand', name: 'Nhu cầu rơm hàng năm của Nhà máy VFT',
    unit: 'tấn/năm', group: G1, classification: 'thi_truong', base: 240_000, min: 180_000, max: 300_000,
    source: 'Chủ đầu tư Nhà máy VFT cung cấp',
    note: 'Ràng buộc cấp mạng lưới — FN-06 BR-05, FN-14 BR-05.',
  },

  // ---------- Nhóm 2: Cấu hình Hub mặc định (#13–#16) ----------
  {
    number: 13, code: 'default_service_radius_km', name: 'Bán kính phục vụ mặc định cho Hub mới',
    unit: 'km', group: G2, classification: 'gia_dinh', base: 30, min: 20, max: 45,
    note: 'Quyết định B5: V1 dùng MỘT bán kính duy nhất, không chia vành đai đồng tâm.',
    assumption: 'AS-08',
  },
  {
    number: 14, code: 'default_design_capacity_tons', name: 'Công suất thiết kế mặc định cho Hub mới',
    unit: 'tấn/năm', group: G2, classification: 'gia_dinh', base: 60_000, min: 40_000, max: 90_000,
    assumption: 'AS-08',
  },
  {
    number: 15, code: 'distance_error_threshold_pct', name: 'Ngưỡng sai số khoảng cách chấp nhận được',
    unit: '%', group: G2, classification: 'gia_dinh', base: 10, min: 5, max: 15,
    note: 'Tiêu chí chấp nhận của FN-04 AC-02.',
    assumption: 'AS-09',
  },
  {
    number: 16, code: 'hub_coordinates', name: 'Toạ độ vị trí Hub ứng viên',
    unit: 'Độ (lat, lng)', group: G2, classification: 'khac', base: null,
    managedElsewhere: 'candidate_hubs',
    note: 'Người dùng chọn trực tiếp trên bản đồ — không tính vào nhóm thị trường/giả định.',
  },

  // ---------- Nhóm 3: Hệ số nông nghiệp & thu gom (#17–#19) ----------
  {
    number: 17, code: 'straw_to_paddy_ratio', name: 'Hệ số rơm/lúa (tỷ lệ phụ phẩm)',
    unit: 'tấn rơm / tấn lúa', group: G3, classification: 'gia_dinh', base: 1.0, min: 0.9, max: 1.35,
    source: 'Tài liệu khoa học/FAO (~1–1,35), cần hiệu chỉnh theo giống lúa địa phương',
    assumption: 'AS-01',
  },
  {
    number: 18, code: 'collectable_ratio', name: 'Hệ số thu gom khả thi',
    unit: '% (Collectable / Total Available)', group: G3, classification: 'gia_dinh', base: 45, min: 30, max: 60,
    assumption: 'AS-02',
  },
  {
    number: 19, code: 'loss_ratio', name: 'Hệ số hao hụt/tổn thất rơm trong lưu kho & vận chuyển',
    unit: '%', group: G3, classification: 'gia_dinh', base: 5, min: 3, max: 10,
    note: 'Delivered Supply = Collectable Supply × (1 − hệ số) — FN-06 BR-04.',
    assumption: 'AS-03',
  },

  // ---------- Nhóm 4: Đơn giá chi phí (#20–#28) ----------
  {
    number: 20, code: 'collection_labour_price', name: 'Đơn giá nhân công thu gom',
    unit: 'VNĐ/tấn', group: G4, classification: 'gia_dinh', base: 180_000, min: 140_000, max: 240_000,
    assumption: 'AS-04',
  },
  {
    number: 21, code: 'collection_consumable_price', name: 'Đơn giá công cụ/dụng cụ tiêu hao thu gom',
    unit: 'VNĐ/tấn', group: G4, classification: 'gia_dinh', base: 45_000, min: 30_000, max: 70_000,
    assumption: 'AS-04',
  },
  {
    number: 22, code: 'road_freight_rate', name: 'Đơn giá vận chuyển đường bộ',
    unit: 'đ/tấn/km', group: G4, classification: 'thi_truong', base: 2_200, min: 1_800, max: 2_900,
    source: 'Biểu giá vận tải hàng hoá; Hiệp hội vận tải; giá nhiên liệu công bố',
  },
  {
    number: 23, code: 'waterway_freight_rate', name: 'Đơn giá vận chuyển đường thủy',
    unit: 'đ/tấn/km', group: G4, classification: 'thi_truong', base: 900, min: 650, max: 1_250,
    source: 'Biểu giá cước sà lan khu vực ĐBSCL',
  },
  {
    number: 24, code: 'warehouse_build_price', name: 'Đơn giá xây dựng kho',
    unit: 'triệu đ/m²', group: G4, classification: 'thi_truong', base: 3.5, min: 2.8, max: 4.6,
    source: 'Suất vốn đầu tư xây dựng hiện hành; báo giá nhà thầu',
  },
  {
    number: 25, code: 'yard_build_price', name: 'Đơn giá xây dựng sân bãi',
    unit: 'triệu đ/m²', group: G4, classification: 'thi_truong', base: 0.9, min: 0.6, max: 1.4,
    note: 'Bổ sung tại v1.3 — trước đó FN-10 BR-01 dùng đơn giá này nhưng thiếu dòng tham số.',
  },
  {
    number: 26, code: 'equipment_price', name: 'Đơn giá thiết bị (máy ép kiện, xe nâng)',
    unit: 'triệu đ/máy', group: G4, classification: 'thi_truong', base: 850, min: 650, max: 1_100,
    textValue: { balePress: 850, forklift: 620 },
    note: 'FN-10 BR-01 dùng hai đơn giá riêng — lưu trong textValue: { balePress, forklift }.',
    source: 'Báo giá/catalogue nhà cung cấp thiết bị',
  },
  {
    number: 27, code: 'road_feasible_distance_km', name: 'Ngưỡng cự ly khả thi cho vận chuyển đường bộ',
    unit: 'km', group: G4, classification: 'gia_dinh', base: 120, min: 80, max: 180,
    note: 'Điều kiện kích hoạt gợi ý chuyển sang đường thủy — FN-08 BR-04b.',
    assumption: 'AS-07',
  },
  {
    number: 28, code: 'land_lease_price', name: 'Đơn giá thuê đất/mặt bằng Hub',
    unit: 'VNĐ/m²/năm', group: G4, classification: 'gia_dinh', base: 45_000, min: 25_000, max: 80_000,
    note: 'Chỉ áp dụng khi chọn phương án THUÊ; phương án mua đặt 0 và chi phí đất nằm ở #39.',
    assumption: 'AS-11',
  },

  // ---------- Nhóm 5: Thông số kỹ thuật kho & thiết bị (#29–#38) ----------
  {
    number: 29, code: 'warehouse_area_norm', name: 'Định mức diện tích kho',
    unit: 'm²/tấn', group: G5, classification: 'thi_truong', base: 0.85, min: 0.6, max: 1.2,
  },
  {
    number: 30, code: 'yard_area_norm', name: 'Định mức diện tích sân bãi',
    unit: 'm²/tấn', group: G5, classification: 'thi_truong', base: 0.6, min: 0.4, max: 0.9,
  },
  {
    number: 31, code: 'bale_press_capacity', name: 'Công suất máy ép kiện',
    unit: 'tấn/máy/năm', group: G5, classification: 'thi_truong', base: 18_000, min: 12_000, max: 25_000,
  },
  {
    number: 32, code: 'forklift_capacity', name: 'Công suất xe nâng',
    unit: 'tấn/máy/năm', group: G5, classification: 'thi_truong', base: 25_000, min: 18_000, max: 35_000,
  },
  {
    number: 33, code: 'truck_payload_tons', name: 'Tải trọng bình quân xe tải',
    unit: 'tấn/chuyến', group: G5, classification: 'thi_truong', base: 15, min: 10, max: 22,
  },
  {
    number: 34, code: 'barge_payload_tons', name: 'Tải trọng bình quân sà lan',
    unit: 'tấn/chuyến', group: G5, classification: 'thi_truong', base: 300, min: 150, max: 600,
  },
  {
    number: 35, code: 'peak_inventory_factor', name: 'Hệ số tồn kho cao điểm',
    unit: 'lần (tỷ lệ trên sản lượng cả năm)', group: G5, classification: 'gia_dinh',
    base: 0.3, min: 0.2, max: 0.45,
    note: 'RS-06: V1 dùng hệ số thay cho mô hình tồn kho theo tháng — ảnh hưởng trực tiếp CAPEX.',
    assumption: 'AS-10',
  },
  {
    number: 36, code: 'road_speed_kmh', name: 'Tốc độ bình quân đường bộ',
    unit: 'km/h', group: G5, classification: 'thi_truong', base: 40, min: 30, max: 55,
  },
  {
    number: 37, code: 'waterway_speed_kmh', name: 'Tốc độ bình quân đường thủy',
    unit: 'km/h', group: G5, classification: 'thi_truong', base: 12, min: 8, max: 16,
  },
  {
    number: 38, code: 'handling_hours_per_trip', name: 'Thời gian bốc/xếp bình quân mỗi chuyến',
    unit: 'giờ/chuyến', group: G5, classification: 'thi_truong', base: 3.5, min: 2, max: 6,
  },

  // ---------- Nhóm 6: Giả định tài chính & đầu tư (#39–#49) ----------
  {
    number: 39, code: 'capex_other', name: 'CAPEX ngoài xây dựng/thiết bị (đất, pháp lý, dự phòng…)',
    unit: 'triệu đ', group: G6, classification: 'gia_dinh', base: 12_000, min: 8_000, max: 20_000,
    assumption: 'AS-11',
  },
  {
    number: 40, code: 'staff_count', name: 'Số nhân sự vận hành Hub (định biên)',
    unit: 'người', group: G6, classification: 'gia_dinh', base: 18, min: 12, max: 28,
    assumption: 'AS-12',
  },
  {
    number: 41, code: 'staff_salary_month', name: 'Lương bình quân nhân sự vận hành',
    unit: 'VNĐ/người/tháng', group: G6, classification: 'gia_dinh', base: 9_500_000, min: 8_000_000, max: 13_000_000,
    assumption: 'AS-12',
  },
  {
    number: 42, code: 'utility_cost_year', name: 'Chi phí điện/nhiên liệu vận hành Hub',
    unit: 'VNĐ/năm', group: G6, classification: 'gia_dinh', base: 1_800_000_000, min: 1_200_000_000, max: 2_800_000_000,
    assumption: 'AS-12',
  },
  {
    number: 43, code: 'maintenance_rate_pct', name: 'Tỷ lệ bảo trì thiết bị hàng năm',
    unit: '% trên giá trị thiết bị', group: G6, classification: 'gia_dinh', base: 6, min: 4, max: 10,
    assumption: 'AS-12',
  },
  {
    number: 44, code: 'discount_rate_pct', name: 'Tỷ lệ chiết khấu (discount rate) cho TCO',
    unit: '%/năm', group: G6, classification: 'gia_dinh', base: 10, min: 8, max: 14,
    assumption: 'AS-13',
  },
  {
    number: 45, code: 'opex_escalation_pct', name: 'Tỷ lệ tăng chi phí OPEX hàng năm (escalation)',
    unit: '%/năm', group: G6, classification: 'gia_dinh', base: 5, min: 3, max: 8,
    assumption: 'AS-13',
  },
  {
    number: 46, code: 'ramp_up_pct', name: 'Tỷ lệ sản lượng năm đầu so với mức ổn định (ramp-up)',
    unit: '%', group: G6, classification: 'gia_dinh', base: 60, min: 40, max: 85,
    assumption: 'AS-13',
  },
  {
    number: 47, code: 'lifecycle_years', name: 'Số năm vòng đời so sánh',
    unit: 'năm', group: G6, classification: 'gia_dinh', base: 10, min: 7, max: 15,
    assumption: 'AS-13',
  },
  {
    number: 48, code: 'min_roi_pct', name: 'Ngưỡng ROI tối thiểu để khuyến nghị đầu tư',
    unit: '%', group: G6, classification: 'gia_dinh', base: null,
    note: 'CHƯA CHỐT (AS-14 / RS-08). FN-15 BR-03: không sinh kết luận "Nên/Không nên đầu tư" cho tới khi có ngưỡng.',
    assumption: 'AS-14',
  },
  {
    number: 49, code: 'max_payback_years', name: 'Ngưỡng Payback Period tối đa chấp nhận được',
    unit: 'năm', group: G6, classification: 'gia_dinh', base: null,
    note: 'CHƯA CHỐT (AS-14 / RS-08) — cùng workshop với #48.',
    assumption: 'AS-14',
  },
];

// ===========================================================================
// THAM SỐ MỞ RỘNG — Mô hình dòng chảy rơm theo ngày (ngoài phạm vi BRD v1.4)
// ===========================================================================
//
// BRD v1.4 chốt đúng 49 tham số và FN-01 AC-03 kiểm tra con số đó, nên nhóm
// tham số dưới đây được tách riêng thay vì chèn vào bộ 49. Chúng phục vụ yêu
// cầu bổ sung của khách hàng: mô phỏng luồng rơm thực tế theo ngày với hai
// phương thức vận chuyển (ghe trong mùa thu hoạch, sà lan ngoài vụ).
//
// Mọi tham số ở đây thuộc nhóm "cần input giả định" nên vẫn phải được phê duyệt
// trước khi kịch bản được đánh dấu "Chính thức" (FN-01 BR-04).

const G7 = '7. Mô hình dòng chảy rơm (bổ sung ngoài BRD v1.4)';

export const FLOW_PARAMETER_EXTENSION: ParameterDefinition[] = [
  {
    number: 50, code: 'boat_registered_tons', name: 'Tải trọng đăng ký của ghe chở rơm',
    unit: 'tấn/chuyến', group: G7, classification: 'gia_dinh', base: 100, min: 60, max: 150,
    note: 'Phương tiện chủ lực TRONG mùa thu hoạch: chở rơm rời từ ruộng thẳng về nhà máy hoặc về Hub.',
  },
  {
    number: 51, code: 'boat_straw_payload_tons', name: 'Khối lượng rơm thực chở mỗi chuyến ghe',
    unit: 'tấn/chuyến', group: G7, classification: 'gia_dinh', base: 90, min: 50, max: 140,
    note: 'Rơm rời cồng kềnh nên ghe 100 tấn chỉ chở được ~90 tấn — giới hạn bởi THỂ TÍCH, không phải tải trọng.',
  },
  {
    number: 52, code: 'barge_small_payload_tons', name: 'Tải trọng sà lan nhỏ (ngoài vụ)',
    unit: 'tấn/chuyến', group: G7, classification: 'gia_dinh', base: 1_000, min: 500, max: 1_500,
    note: 'Chặng Hub→Nhà máy ngoài mùa thu hoạch, chở ĐẦY TẢI vì rơm đã băm và nén tại Hub.',
  },
  {
    number: 53, code: 'barge_large_payload_tons', name: 'Tải trọng sà lan lớn (ngoài vụ)',
    unit: 'tấn/chuyến', group: G7, classification: 'gia_dinh', base: 2_000, min: 1_500, max: 3_000,
    note: 'Lựa chọn thay thế sà lan nhỏ; cấu hình theo từng cặp Hub–Kịch bản.',
  },
  {
    number: 54, code: 'plant_operating_days', name: 'Số ngày vận hành nhà máy trong năm',
    unit: 'ngày/năm', group: G7, classification: 'gia_dinh', base: 330, min: 300, max: 365,
    note: 'Nhu cầu tiêu thụ mỗi ngày = Nhu cầu rơm hàng năm (#12) ÷ số ngày vận hành.',
  },
  {
    number: 55, code: 'hub_processing_cost', name: 'Chi phí băm và nén rơm tại Hub',
    unit: 'VNĐ/tấn', group: G7, classification: 'gia_dinh', base: 120_000, min: 70_000, max: 200_000,
    note: 'Chỉ áp cho phần rơm ĐI QUA Hub; rơm chở thẳng ruộng→nhà máy không phát sinh chi phí này.',
  },
  {
    number: 56, code: 'hub_processing_loss_pct', name: 'Hao hụt khi băm và nén tại Hub',
    unit: '%', group: G7, classification: 'gia_dinh', base: 2, min: 0, max: 6,
    note: 'Hao hụt riêng của khâu chế biến tại Hub, cộng thêm vào hệ số hao hụt chung (#19).',
  },
  {
    number: 57, code: 'harvest_window_days', name: 'Số ngày thu hoạch rộ của một vụ',
    unit: 'ngày', group: G7, classification: 'gia_dinh', base: 45, min: 20, max: 90,
    note: 'Dùng để dựng đường cong nguồn cung theo ngày khi chưa có dữ liệu ngày thu hoạch thực tế ' +
      'từ file điều tra vụ mùa. Khi đã nhập file, hệ thống ưu tiên ngày thu hoạch thực tế.',
  },
];

/** Toàn bộ tham số được nạp vào hệ thống: 49 của BRD + nhóm mở rộng. */
export const ALL_PARAMETERS: ParameterDefinition[] = [...PARAMETER_CATALOG, ...FLOW_PARAMETER_EXTENSION];

/** Kiểm tra tính toàn vẹn của danh mục — dùng bởi test và bởi FN-01 AC-03. */
export function catalogIntegrity(): {
  total: number;
  byClassification: Record<Classification, number>;
  duplicateNumbers: number[];
  missingNumbers: number[];
} {
  const byClassification: Record<Classification, number> = { thi_truong: 0, gia_dinh: 0, khac: 0 };
  const seen = new Map<number, number>();
  for (const parameter of PARAMETER_CATALOG) {
    byClassification[parameter.classification] += 1;
    seen.set(parameter.number, (seen.get(parameter.number) ?? 0) + 1);
  }
  const duplicateNumbers = [...seen.entries()].filter(([, n]) => n > 1).map(([number]) => number);
  const missingNumbers: number[] = [];
  for (let i = 1; i <= 49; i += 1) if (!seen.has(i)) missingNumbers.push(i);
  return { total: PARAMETER_CATALOG.length, byClassification, duplicateNumbers, missingNumbers };
}
