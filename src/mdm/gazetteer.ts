/**
 * Bảng tra địa danh ĐBSCL + quy đổi địa giới hành chính CŨ → MỚI (sáp nhập 2025).
 *
 * Dùng cho luồng nhập Excel: file nghiệp vụ do các Sở/Chi cục lập vẫn ghi theo
 * tỉnh cũ (Kiên Giang, Sóc Trăng, Bạc Liêu…), trong khi hệ thống vận hành theo
 * 6 tỉnh/thành sau sáp nhập. Toạ độ huyện là toạ độ TRUNG TÂM HÀNH CHÍNH ở mức
 * ước lượng — đủ để định vị và điều phối ở mức hoạch định, KHÔNG thay thế khảo
 * sát GPS thực địa (rủi ro RS-02 của BRD Simulation).
 */

/** Quy đổi tỉnh cũ → tỉnh/thành sau sáp nhập 2025. */
export const PROVINCE_MERGER: Record<string, { newProvince: string; newCode: string }> = {
  'an giang': { newProvince: 'An Giang', newCode: 'AG' },
  'kien giang': { newProvince: 'An Giang', newCode: 'AG' },

  'dong thap': { newProvince: 'Đồng Tháp', newCode: 'DT' },
  'tien giang': { newProvince: 'Đồng Tháp', newCode: 'DT' },

  'vinh long': { newProvince: 'Vĩnh Long', newCode: 'VL' },
  'ben tre': { newProvince: 'Vĩnh Long', newCode: 'VL' },
  'tra vinh': { newProvince: 'Vĩnh Long', newCode: 'VL' },

  'can tho': { newProvince: 'Cần Thơ', newCode: 'CT' },
  'soc trang': { newProvince: 'Cần Thơ', newCode: 'CT' },
  'hau giang': { newProvince: 'Cần Thơ', newCode: 'CT' },

  'ca mau': { newProvince: 'Cà Mau', newCode: 'CM' },
  'bac lieu': { newProvince: 'Cà Mau', newCode: 'CM' },

  'tay ninh': { newProvince: 'Tây Ninh', newCode: 'TN' },
  'long an': { newProvince: 'Tây Ninh', newCode: 'TN' },
};

interface DistrictEntry {
  name: string;
  /** Tỉnh CŨ mà huyện này thuộc về — dùng để phát hiện dữ liệu ghi sai tỉnh. */
  oldProvince: string;
  lat: number;
  lng: number;
}

/**
 * Toạ độ trung tâm hành chính cấp huyện/thị xã/thành phố (trước sáp nhập).
 * Nguồn: vị trí trung tâm huyện lỵ, làm tròn ~0,01° (≈ 1 km).
 */
const DISTRICTS: DistrictEntry[] = [
  // ---- An Giang (cũ) ----
  { name: 'Long Xuyên', oldProvince: 'An Giang', lat: 10.386, lng: 105.436 },
  { name: 'Châu Đốc', oldProvince: 'An Giang', lat: 10.700, lng: 105.118 },
  { name: 'Tân Châu', oldProvince: 'An Giang', lat: 10.800, lng: 105.244 },
  { name: 'An Phú', oldProvince: 'An Giang', lat: 10.800, lng: 105.100 },
  { name: 'Châu Phú', oldProvince: 'An Giang', lat: 10.550, lng: 105.200 },
  { name: 'Châu Thành', oldProvince: 'An Giang', lat: 10.420, lng: 105.280 },
  { name: 'Chợ Mới', oldProvince: 'An Giang', lat: 10.450, lng: 105.420 },
  { name: 'Phú Tân', oldProvince: 'An Giang', lat: 10.620, lng: 105.350 },
  { name: 'Thoại Sơn', oldProvince: 'An Giang', lat: 10.260, lng: 105.260 },
  { name: 'Tri Tôn', oldProvince: 'An Giang', lat: 10.420, lng: 104.990 },
  { name: 'Tịnh Biên', oldProvince: 'An Giang', lat: 10.600, lng: 105.000 },
  { name: 'Nhơn Hội', oldProvince: 'An Giang', lat: 10.900, lng: 105.060 },
  { name: 'Phước Hưng', oldProvince: 'An Giang', lat: 10.750, lng: 105.100 },

  // ---- Kiên Giang (cũ) ----
  { name: 'Rạch Giá', oldProvince: 'Kiên Giang', lat: 10.012, lng: 105.081 },
  { name: 'Hà Tiên', oldProvince: 'Kiên Giang', lat: 10.383, lng: 104.488 },
  { name: 'An Biên', oldProvince: 'Kiên Giang', lat: 9.820, lng: 105.050 },
  { name: 'An Minh', oldProvince: 'Kiên Giang', lat: 9.650, lng: 104.980 },
  { name: 'Châu Thành Kiên Giang', oldProvince: 'Kiên Giang', lat: 9.950, lng: 105.180 },
  { name: 'Giang Thành', oldProvince: 'Kiên Giang', lat: 10.420, lng: 104.660 },
  { name: 'Giồng Riềng', oldProvince: 'Kiên Giang', lat: 9.930, lng: 105.300 },
  { name: 'Gò Quao', oldProvince: 'Kiên Giang', lat: 9.720, lng: 105.280 },
  { name: 'Hòn Đất', oldProvince: 'Kiên Giang', lat: 10.200, lng: 104.900 },
  { name: 'Kiên Lương', oldProvince: 'Kiên Giang', lat: 10.280, lng: 104.620 },
  { name: 'Tân Hiệp', oldProvince: 'Kiên Giang', lat: 10.100, lng: 105.250 },
  { name: 'U Minh Thượng', oldProvince: 'Kiên Giang', lat: 9.600, lng: 105.100 },
  { name: 'Vĩnh Thuận', oldProvince: 'Kiên Giang', lat: 9.520, lng: 105.250 },
  { name: 'Phú Quốc', oldProvince: 'Kiên Giang', lat: 10.227, lng: 103.960 },
  { name: 'Kiên Hải', oldProvince: 'Kiên Giang', lat: 9.800, lng: 104.630 },

  // ---- Đồng Tháp (cũ) ----
  { name: 'Cao Lãnh', oldProvince: 'Đồng Tháp', lat: 10.460, lng: 105.635 },
  { name: 'Sa Đéc', oldProvince: 'Đồng Tháp', lat: 10.293, lng: 105.756 },
  { name: 'Hồng Ngự', oldProvince: 'Đồng Tháp', lat: 10.805, lng: 105.320 },
  { name: 'Lấp Vò', oldProvince: 'Đồng Tháp', lat: 10.360, lng: 105.520 },
  { name: 'Lai Vung', oldProvince: 'Đồng Tháp', lat: 10.280, lng: 105.650 },
  { name: 'Tam Nông', oldProvince: 'Đồng Tháp', lat: 10.720, lng: 105.550 },
  { name: 'Thanh Bình', oldProvince: 'Đồng Tháp', lat: 10.580, lng: 105.490 },
  { name: 'Tháp Mười', oldProvince: 'Đồng Tháp', lat: 10.550, lng: 105.830 },
  { name: 'Tân Hồng', oldProvince: 'Đồng Tháp', lat: 10.880, lng: 105.450 },
  { name: 'Châu Thành Đồng Tháp', oldProvince: 'Đồng Tháp', lat: 10.240, lng: 105.820 },

  // ---- Tiền Giang (cũ) ----
  { name: 'Mỹ Tho', oldProvince: 'Tiền Giang', lat: 10.360, lng: 106.365 },
  { name: 'Cai Lậy', oldProvince: 'Tiền Giang', lat: 10.420, lng: 106.120 },
  { name: 'Cái Bè', oldProvince: 'Tiền Giang', lat: 10.350, lng: 105.930 },
  { name: 'Châu Thành Tiền Giang', oldProvince: 'Tiền Giang', lat: 10.400, lng: 106.280 },
  { name: 'Chợ Gạo', oldProvince: 'Tiền Giang', lat: 10.380, lng: 106.470 },
  { name: 'Gò Công', oldProvince: 'Tiền Giang', lat: 10.360, lng: 106.670 },
  { name: 'Gò Công Đông', oldProvince: 'Tiền Giang', lat: 10.350, lng: 106.750 },
  { name: 'Gò Công Tây', oldProvince: 'Tiền Giang', lat: 10.350, lng: 106.580 },
  { name: 'Tân Phước', oldProvince: 'Tiền Giang', lat: 10.520, lng: 106.200 },
  { name: 'Tân Phú Đông', oldProvince: 'Tiền Giang', lat: 10.250, lng: 106.720 },

  // ---- Vĩnh Long (cũ) ----
  { name: 'Vĩnh Long', oldProvince: 'Vĩnh Long', lat: 10.253, lng: 105.972 },
  { name: 'Bình Tân', oldProvince: 'Vĩnh Long', lat: 10.150, lng: 105.720 },
  { name: 'Bình Minh', oldProvince: 'Vĩnh Long', lat: 10.050, lng: 105.800 },
  { name: 'Long Hồ', oldProvince: 'Vĩnh Long', lat: 10.230, lng: 105.980 },
  { name: 'Mang Thít', oldProvince: 'Vĩnh Long', lat: 10.160, lng: 106.080 },
  { name: 'Tam Bình', oldProvince: 'Vĩnh Long', lat: 10.050, lng: 105.980 },
  { name: 'Trà Ôn', oldProvince: 'Vĩnh Long', lat: 9.970, lng: 105.930 },
  { name: 'Vũng Liêm', oldProvince: 'Vĩnh Long', lat: 10.050, lng: 106.180 },

  // ---- Bến Tre (cũ) ----
  { name: 'Bến Tre', oldProvince: 'Bến Tre', lat: 10.243, lng: 106.375 },
  { name: 'Ba Tri', oldProvince: 'Bến Tre', lat: 10.040, lng: 106.600 },
  { name: 'Bình Đại', oldProvince: 'Bến Tre', lat: 10.200, lng: 106.700 },
  { name: 'Châu Thành Bến Tre', oldProvince: 'Bến Tre', lat: 10.300, lng: 106.320 },
  { name: 'Chợ Lách', oldProvince: 'Bến Tre', lat: 10.240, lng: 106.130 },
  { name: 'Giồng Trôm', oldProvince: 'Bến Tre', lat: 10.130, lng: 106.480 },
  { name: 'Mỏ Cày Nam', oldProvince: 'Bến Tre', lat: 10.100, lng: 106.350 },
  { name: 'Mỏ Cày Bắc', oldProvince: 'Bến Tre', lat: 10.180, lng: 106.280 },
  { name: 'Thạnh Phú', oldProvince: 'Bến Tre', lat: 9.950, lng: 106.550 },

  // ---- Trà Vinh (cũ) ----
  { name: 'Trà Vinh', oldProvince: 'Trà Vinh', lat: 9.934, lng: 106.345 },
  { name: 'Càng Long', oldProvince: 'Trà Vinh', lat: 9.970, lng: 106.210 },
  { name: 'Cầu Kè', oldProvince: 'Trà Vinh', lat: 9.880, lng: 106.050 },
  { name: 'Tiểu Cần', oldProvince: 'Trà Vinh', lat: 9.820, lng: 106.190 },
  { name: 'Châu Thành Trà Vinh', oldProvince: 'Trà Vinh', lat: 9.850, lng: 106.360 },
  { name: 'Cầu Ngang', oldProvince: 'Trà Vinh', lat: 9.790, lng: 106.450 },
  { name: 'Trà Cú', oldProvince: 'Trà Vinh', lat: 9.720, lng: 106.280 },
  { name: 'Duyên Hải', oldProvince: 'Trà Vinh', lat: 9.620, lng: 106.500 },

  // ---- Cần Thơ (cũ) ----
  { name: 'Ninh Kiều', oldProvince: 'Cần Thơ', lat: 10.033, lng: 105.783 },
  { name: 'Bình Thủy', oldProvince: 'Cần Thơ', lat: 10.060, lng: 105.740 },
  { name: 'Cái Răng', oldProvince: 'Cần Thơ', lat: 9.990, lng: 105.800 },
  { name: 'Ô Môn', oldProvince: 'Cần Thơ', lat: 10.110, lng: 105.630 },
  { name: 'Thốt Nốt', oldProvince: 'Cần Thơ', lat: 10.260, lng: 105.530 },
  { name: 'Cờ Đỏ', oldProvince: 'Cần Thơ', lat: 10.120, lng: 105.430 },
  { name: 'Phong Điền', oldProvince: 'Cần Thơ', lat: 10.000, lng: 105.660 },
  { name: 'Thới Lai', oldProvince: 'Cần Thơ', lat: 10.020, lng: 105.550 },
  { name: 'Vĩnh Thạnh', oldProvince: 'Cần Thơ', lat: 10.200, lng: 105.350 },

  // ---- Sóc Trăng (cũ) ----
  { name: 'Sóc Trăng', oldProvince: 'Sóc Trăng', lat: 9.602, lng: 105.974 },
  { name: 'Châu Thành Sóc Trăng', oldProvince: 'Sóc Trăng', lat: 9.680, lng: 105.900 },
  { name: 'Kế Sách', oldProvince: 'Sóc Trăng', lat: 9.800, lng: 105.980 },
  { name: 'Long Phú', oldProvince: 'Sóc Trăng', lat: 9.610, lng: 106.120 },
  { name: 'Mỹ Tú', oldProvince: 'Sóc Trăng', lat: 9.660, lng: 105.750 },
  { name: 'Mỹ Xuyên', oldProvince: 'Sóc Trăng', lat: 9.530, lng: 105.950 },
  { name: 'Ngã Năm', oldProvince: 'Sóc Trăng', lat: 9.550, lng: 105.640 },
  { name: 'Thạnh Trị', oldProvince: 'Sóc Trăng', lat: 9.500, lng: 105.800 },
  { name: 'Trần Đề', oldProvince: 'Sóc Trăng', lat: 9.510, lng: 106.130 },
  { name: 'Cù Lao Dung', oldProvince: 'Sóc Trăng', lat: 9.600, lng: 106.250 },
  { name: 'Vĩnh Châu', oldProvince: 'Sóc Trăng', lat: 9.330, lng: 105.990 },

  // ---- Hậu Giang (cũ) ----
  { name: 'Vị Thanh', oldProvince: 'Hậu Giang', lat: 9.784, lng: 105.470 },
  { name: 'Vị Thủy', oldProvince: 'Hậu Giang', lat: 9.800, lng: 105.550 },
  { name: 'Long Mỹ', oldProvince: 'Hậu Giang', lat: 9.650, lng: 105.550 },
  { name: 'Phụng Hiệp', oldProvince: 'Hậu Giang', lat: 9.800, lng: 105.800 },
  { name: 'Châu Thành Hậu Giang', oldProvince: 'Hậu Giang', lat: 9.950, lng: 105.850 },
  { name: 'Châu Thành A', oldProvince: 'Hậu Giang', lat: 9.930, lng: 105.680 },
  { name: 'Ngã Bảy', oldProvince: 'Hậu Giang', lat: 9.810, lng: 105.820 },

  // ---- Bạc Liêu (cũ) ----
  { name: 'Bạc Liêu', oldProvince: 'Bạc Liêu', lat: 9.294, lng: 105.724 },
  { name: 'Hòa Bình', oldProvince: 'Bạc Liêu', lat: 9.320, lng: 105.550 },
  { name: 'Vĩnh Lợi', oldProvince: 'Bạc Liêu', lat: 9.350, lng: 105.660 },
  { name: 'Phước Long', oldProvince: 'Bạc Liêu', lat: 9.430, lng: 105.490 },
  { name: 'Hồng Dân', oldProvince: 'Bạc Liêu', lat: 9.570, lng: 105.460 },
  { name: 'Đông Hải', oldProvince: 'Bạc Liêu', lat: 9.200, lng: 105.450 },
  { name: 'Giá Rai', oldProvince: 'Bạc Liêu', lat: 9.250, lng: 105.430 },

  // ---- Cà Mau (cũ) ----
  { name: 'Cà Mau', oldProvince: 'Cà Mau', lat: 9.177, lng: 105.150 },
  { name: 'Thới Bình', oldProvince: 'Cà Mau', lat: 9.350, lng: 105.100 },
  { name: 'Trần Văn Thời', oldProvince: 'Cà Mau', lat: 9.100, lng: 105.000 },
  { name: 'U Minh', oldProvince: 'Cà Mau', lat: 9.350, lng: 104.950 },
  { name: 'Cái Nước', oldProvince: 'Cà Mau', lat: 8.950, lng: 105.000 },
  { name: 'Đầm Dơi', oldProvince: 'Cà Mau', lat: 8.950, lng: 105.280 },
  { name: 'Năm Căn', oldProvince: 'Cà Mau', lat: 8.750, lng: 105.000 },
  { name: 'Ngọc Hiển', oldProvince: 'Cà Mau', lat: 8.650, lng: 104.950 },
  { name: 'Phú Tân Cà Mau', oldProvince: 'Cà Mau', lat: 8.900, lng: 104.850 },

  // ---- Long An (cũ) ----
  { name: 'Tân An', oldProvince: 'Long An', lat: 10.530, lng: 106.410 },
  { name: 'Kiến Tường', oldProvince: 'Long An', lat: 10.770, lng: 105.870 },
  { name: 'Bến Lức', oldProvince: 'Long An', lat: 10.650, lng: 106.420 },
  { name: 'Cần Đước', oldProvince: 'Long An', lat: 10.550, lng: 106.600 },
  { name: 'Cần Giuộc', oldProvince: 'Long An', lat: 10.610, lng: 106.660 },
  { name: 'Châu Thành Long An', oldProvince: 'Long An', lat: 10.440, lng: 106.420 },
  { name: 'Mộc Hóa', oldProvince: 'Long An', lat: 10.780, lng: 105.940 },
  { name: 'Tân Hưng', oldProvince: 'Long An', lat: 10.870, lng: 105.530 },
  { name: 'Tân Thạnh', oldProvince: 'Long An', lat: 10.630, lng: 105.960 },
  { name: 'Tân Trụ', oldProvince: 'Long An', lat: 10.550, lng: 106.490 },
  { name: 'Thạnh Hóa', oldProvince: 'Long An', lat: 10.660, lng: 106.190 },
  { name: 'Thủ Thừa', oldProvince: 'Long An', lat: 10.600, lng: 106.360 },
  { name: 'Vĩnh Hưng', oldProvince: 'Long An', lat: 10.900, lng: 105.720 },
  { name: 'Đức Hòa', oldProvince: 'Long An', lat: 10.880, lng: 106.400 },
  { name: 'Đức Huệ', oldProvince: 'Long An', lat: 10.890, lng: 106.240 },

  // ---- Tây Ninh (cũ) ----
  { name: 'Tây Ninh', oldProvince: 'Tây Ninh', lat: 11.310, lng: 106.098 },
  { name: 'Gò Dầu', oldProvince: 'Tây Ninh', lat: 11.080, lng: 106.260 },
  { name: 'Trảng Bàng', oldProvince: 'Tây Ninh', lat: 11.030, lng: 106.360 },
];

/**
 * Bí danh cho các cách viết khác / lỗi chính tả thường gặp trong file nghiệp vụ.
 * Khoá là dạng đã chuẩn hoá (bỏ dấu, chữ thường).
 */
const ALIASES: Record<string, string> = {
  'giong gieng': 'Giồng Riềng',
  'thao muoi': 'Tháp Mười',
  'tan thach': 'Tân Thạnh',
  'thach tri': 'Thạnh Trị',
  'nga nam': 'Ngã Năm',
  'nga bay': 'Ngã Bảy',
  'vi thuy': 'Vị Thủy',
  'go cong': 'Gò Công',
  'thanh pho go cong': 'Gò Công',
  'chau thanh a': 'Châu Thành A',
  'my tho': 'Mỹ Tho',
  'sa dec': 'Sa Đéc',
  'hong ngu': 'Hồng Ngự',
  'cao lanh': 'Cao Lãnh',
  'long xuyen': 'Long Xuyên',
  'chau doc': 'Châu Đốc',
  'tan chau': 'Tân Châu',
  'rach gia': 'Rạch Giá',
  'ha tien': 'Hà Tiên',
  'ca mau': 'Cà Mau',
  'bac lieu': 'Bạc Liêu',
  'soc trang': 'Sóc Trăng',
  'tra vinh': 'Trà Vinh',
  'ben tre': 'Bến Tre',
  'vinh long': 'Vĩnh Long',
  'vi thanh': 'Vị Thanh',
  'tan an': 'Tân An',
  'kien tuong': 'Kiến Tường',
  'gia rai': 'Giá Rai',
  'cai lay': 'Cai Lậy',
};

/** Bỏ dấu tiếng Việt và chuẩn hoá về chữ thường để so khớp. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bỏ tiền tố cấp hành chính ("TP.", "Thị xã", "Huyện", "Quận"…). */
export function stripAdminPrefix(value: string): string {
  return normalizeName(value)
    .replace(/^(thanh pho|tp|tx|thi xa|thi tran|tt|huyen|h|quan|q|xa|phuong|p)\s+/, '')
    .trim();
}

export interface ProvinceResolution {
  /** Tên tỉnh như ghi trong file. */
  declared: string;
  /** Tỉnh/thành sau sáp nhập 2025. */
  newProvince: string;
  newCode: string;
  /** true nếu tên tỉnh trong file khác tên sau sáp nhập (đã được quy đổi). */
  converted: boolean;
}

/** Quy đổi tên tỉnh (cũ hoặc mới) sang tỉnh/thành sau sáp nhập 2025. */
export function resolveProvince(declared: string): ProvinceResolution | null {
  const key = stripAdminPrefix(declared.replace(/^(tỉnh|Tỉnh|TỈNH)\s+/, ''));
  const merged = PROVINCE_MERGER[key];
  if (!merged) return null;
  return {
    declared: declared.trim(),
    newProvince: merged.newProvince,
    newCode: merged.newCode,
    converted: normalizeName(merged.newProvince) !== key,
  };
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  /** Mức chi tiết đạt được: 'huyen' chính xác hơn 'tinh'. */
  precision: 'huyen' | 'tinh';
  matchedDistrict: string | null;
  /** true khi huyện tra được KHÔNG thuộc tỉnh khai báo trong file. */
  districtProvinceMismatch: boolean;
  /** Tỉnh cũ thực tế của huyện tra được (khi có mismatch). */
  actualOldProvince: string | null;
}

/** Toạ độ trung tâm 6 tỉnh/thành sau sáp nhập — dùng khi không tra được huyện. */
const NEW_PROVINCE_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  AG: { lat: 10.210, lng: 105.260 },
  DT: { lat: 10.410, lng: 105.980 },
  VL: { lat: 10.140, lng: 106.200 },
  CT: { lat: 9.820, lng: 105.730 },
  CM: { lat: 9.230, lng: 105.380 },
  TN: { lat: 11.100, lng: 106.200 },
};

/**
 * Định vị theo tên huyện; nếu không tra được thì lùi về trung tâm tỉnh.
 *
 * `declaredOldProvince` là tỉnh ghi trong file — dùng để phát hiện trường hợp
 * huyện bị xếp nhầm tỉnh (dữ liệu nguồn có lỗi này ở nhóm Bạc Liêu chứa các
 * huyện của Tiền Giang).
 */
export function geocode(
  districtName: string,
  declaredOldProvince: string,
  newProvinceCode: string,
): GeocodeResult {
  const fallback = NEW_PROVINCE_CENTROIDS[newProvinceCode] ?? { lat: 10.2, lng: 105.8 };
  const cleaned = stripAdminPrefix(districtName ?? '');
  if (!cleaned) {
    return {
      ...fallback, precision: 'tinh', matchedDistrict: null,
      districtProvinceMismatch: false, actualOldProvince: null,
    };
  }

  const declaredKey = stripAdminPrefix(declaredOldProvince.replace(/^(tỉnh|Tỉnh)\s+/, ''));
  const canonical = ALIASES[cleaned] ?? null;

  // 1) Ưu tiên huyện trùng tên NẰM ĐÚNG tỉnh khai báo (xử lý các "Châu Thành").
  const sameProvince = DISTRICTS.find(
    (d) => stripAdminPrefix(d.oldProvince) === declaredKey &&
      (stripAdminPrefix(d.name) === cleaned ||
       stripAdminPrefix(d.name) === `${cleaned} ${declaredKey}` ||
       stripAdminPrefix(d.name) === stripAdminPrefix(canonical ?? '')),
  );
  if (sameProvince) {
    return {
      lat: sameProvince.lat, lng: sameProvince.lng, precision: 'huyen',
      matchedDistrict: sameProvince.name, districtProvinceMismatch: false, actualOldProvince: sameProvince.oldProvince,
    };
  }

  // 2) Tra toàn quốc — nếu trúng thì huyện đó thuộc tỉnh khác với file khai báo.
  const anywhere = DISTRICTS.find(
    (d) => stripAdminPrefix(d.name) === cleaned || stripAdminPrefix(d.name) === stripAdminPrefix(canonical ?? ''),
  );
  if (anywhere) {
    return {
      lat: anywhere.lat, lng: anywhere.lng, precision: 'huyen',
      matchedDistrict: anywhere.name, districtProvinceMismatch: true, actualOldProvince: anywhere.oldProvince,
    };
  }

  return {
    ...fallback, precision: 'tinh', matchedDistrict: null,
    districtProvinceMismatch: false, actualOldProvince: null,
  };
}

/** Tách tên xã/phường/thị trấn ra khỏi chuỗi địa chỉ tự do. */
export function extractCommune(address: string): string | null {
  const match = /(?:^|[,;]\s*)(xã|phường|thị trấn|tt)\.?\s*([^,;]+)/i.exec(address ?? '');
  return match ? match[2].trim().replace(/[,.]$/, '') : null;
}

/**
 * Phân tán nhẹ các điểm trùng toạ độ để marker không chồng khít lên nhau.
 * Dịch chuyển tối đa ~1,5 km và mang tính TẤT ĐỊNH theo khoá, nên chạy lại
 * import vẫn cho cùng vị trí.
 */
export function jitter(lat: number, lng: number, key: string, index: number): { lat: number; lng: number } {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const angle = ((Math.abs(hash) % 360) + index * 37) * (Math.PI / 180);
  const radius = 0.004 + ((Math.abs(hash) % 100) / 100) * 0.010; // ~0,4–1,5 km
  return {
    lat: Number((lat + radius * Math.sin(angle)).toFixed(6)),
    lng: Number((lng + radius * Math.cos(angle)).toFixed(6)),
  };
}

export function listDistricts(): DistrictEntry[] {
  return DISTRICTS;
}
