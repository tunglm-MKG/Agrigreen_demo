/**
 * NỀN BẢN ĐỒ — OpenStreetMap CHỈ dùng tile đã render (R-02). Không tải, không
 * import, không lưu hình học vector OSM.
 *
 * Danh sách dự phòng theo thứ tự: khảo sát 06/09/2026 cho thấy DNS của một ISP
 * trong nước (VNPT) trả "non-existent domain" cho tile.openstreetmap.org, trong khi
 * OSM France và CARTO (đều là bản render của dữ liệu OSM, cùng nghĩa vụ ghi nguồn
 * ODbL) vẫn tới được. Trình duyệt thử lần lượt; đây là cấu hình duy nhất về nền —
 * đổi nhà cung cấp tile thương mại về sau là đổi ở đây.
 */
export interface TileProvider { name: string; url: string; attribution: string }

export const BASEMAP = {
  attribution: '© OpenStreetMap contributors',
  attributionUrl: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL — chỉ dùng nền đã render (R-02); không tải vector',
  note: 'Máy chủ tile công cộng: chỉ chấp nhận ở mức demo. Vượt demo phải dùng nhà cung cấp tile hoặc tự vận hành.',
  providers(): TileProvider[] {
    const configured = process.env.GIS_DEMO_TILE_URL
      ? [{ name: 'Cấu hình (GIS_DEMO_TILE_URL)', url: process.env.GIS_DEMO_TILE_URL, attribution: '© OpenStreetMap contributors' }]
      : [];
    return configured.concat([
      { name: 'OpenStreetMap (OSMF)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
      { name: 'OpenStreetMap France', url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors, tiles © OSM France' },
      { name: 'CARTO Positron', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors © CARTO' },
    ]);
  },
};
