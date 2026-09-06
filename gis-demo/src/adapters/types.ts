/**
 * HỢP ĐỒNG ADAPTER — R-01: mọi nguồn ngoài đi qua đúng một lớp này.
 *
 * Giao diện người dùng KHÔNG biết tên nguồn nào: nó chỉ hỏi adapter. Đổi
 * Open-Meteo sang Copernicus CDS là viết một adapter mới và đổi một dòng trong
 * registry — không tệp giao diện nào phải sửa.
 *
 * Tên trường tiếng Anh để hợp với mã; ý nghĩa đúng theo Phụ lục A.1 của brief:
 *   source()        → nguồn()
 *   valueAt()       → giá_trị_tại_điểm()
 *   series()        → chuỗi_thời_gian() — chỉ lớp có chiều thời gian
 *   updatedAt()     → mốc_cập_nhật()
 */

export type LayerStatus = 'song' | 'tinh';

export interface SourceInfo {
  /** Định danh lớp, ổn định, dùng trong URL. */
  id: string;
  /** Tên hiển thị của LỚP (không phải tên nguồn). */
  layerName: string;
  /** Nguồn dữ liệu thật sự — tên, chuỗi ghi nguồn bắt buộc, URL, giấy phép. */
  providerName: string;
  attribution: string;
  attributionUrl: string;
  license: string;
  status: LayerStatus;
  /** Mốc thời gian của DỮ LIỆU (không phải giờ máy chủ). */
  dataTimestamp: string | null;
  /** Với lớp tĩnh: ngày chụp / tải về. */
  snapshotDate: string | null;
  /** Đơn vị hiển thị của giá trị chính. */
  unit: string;
  /** Cách vẽ trên bản đồ. */
  render: 'raster' | 'points' | 'features';
  /** Chú giải cho raster. */
  legend?: { min: number; max: number; stops: { value: number; color: string; label?: string }[] };
  /** Ghi chú giới hạn — hiển thị nguyên văn trên màn hình. */
  caveat?: string;
  /** Lớp có chuỗi thời gian? */
  hasSeries: boolean;
  /** Thông tin thêm cho từng lớp (ví dụ danh sách biến thời tiết). */
  extra?: Record<string, unknown>;
}

export interface PointValue {
  value: number | null;
  unit: string;
  /** Mốc thời gian thực tế của dữ liệu trả về. */
  dataTimestamp: string | null;
  /** Nhãn phụ: tên biến, tên trạm gần nhất, khoảng cách... */
  label?: string;
  /** Các giá trị kèm theo (thời tiết trả nhiều biến). */
  details?: Record<string, { value: number | null; unit: string; label: string }>;
  /** Giá trị này có đến từ một lời gọi ngoài vừa thực hiện, hay từ bộ đệm / tệp tĩnh? */
  origin: 'cache' | 'live' | 'static';
}

export interface Series {
  label: string;
  unit: string;
  points: { t: string; v: number | null }[];
  dataTimestamp: string | null;
  origin: 'cache' | 'live' | 'static';
  note?: string;
}

export interface LayerAdapter {
  source(): SourceInfo;
  valueAt(lat: number, lng: number, at?: string): Promise<PointValue>;
  series?(lat: number, lng: number, from: string, to: string): Promise<Series>;
  updatedAt(): string | null;
  /** Dữ liệu vẽ lên bản đồ: ảnh phủ (raster) hoặc GeoJSON (points / features). */
  mapData(): Promise<
    | { kind: 'raster'; imageUrl: string; bbox: [number, number, number, number] }
    | { kind: 'geojson'; geojson: Record<string, unknown>; dataTimestamp?: string | null }
  >;
}

/** Khung bao ĐBSCL theo brief: vĩ độ 8,5–11,1 B, kinh độ 104,4–107,0 Đ. */
export const DELTA_BBOX: [number, number, number, number] = [104.4, 8.5, 107.0, 11.1];

export function insideDelta(lat: number, lng: number): boolean {
  return lng >= DELTA_BBOX[0] && lng <= DELTA_BBOX[2] && lat >= DELTA_BBOX[1] && lat <= DELTA_BBOX[3];
}
