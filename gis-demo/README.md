# Demo lớp dữ liệu nền ĐBSCL — SPIKE-GIS-LAYERS-001

Bản demo bản đồ **tách hoàn toàn** khỏi AgriGreen: CSDL riêng, không đăng nhập, chạy bằng
một lệnh. Mục tiêu là kiểm chứng phản ứng người xem với năm lớp dữ liệu nền, không phải
xây tính năng.

```bash
npm run gis-demo:fetch   # một lần: tải thổ nhưỡng + địa hình (~45 MB), cắt theo ĐBSCL, dựng ảnh phủ
npm run gis-demo         # http://localhost:4190 — không cần đăng nhập
```

Không có `gis-demo:fetch`, demo vẫn chạy: hai lớp raster hiện "chưa tải dữ liệu", ba lớp còn lại đủ.

## Trên màn hình

- **Một lớp mỗi lần**, chọn bằng drop-list ở thanh trên (theo yêu cầu, thay cho bật/tắt nhiều lớp của F-02). Có thanh độ trong suốt.
- **Khối nguồn luôn nhìn thấy** (F-05, R-03): tên lớp · nguồn có liên kết · mốc dữ liệu · nhãn *● Dữ liệu sống* hoặc *■ Dữ liệu tĩnh — chụp ngày dd/mm/yyyy*. Lớp đang chạy số minh hoạ có thêm dòng cảnh báo đỏ.
- **Bấm một điểm** (F-03): giá trị của lớp đang bật tại điểm đó; thời tiết và mực nước mở thêm **biểu đồ chuỗi theo khoảng ngày** (F-04, thời tiết từ 01/01/2015).
- **24 lô mẫu minh hoạ** (F-06), tắt/bật riêng, ghim tâm ở mức thu nhỏ.
- Chạy trên điện thoại (F-07): thanh trên cố định, bảng kết quả trượt từ dưới lên.

## Năm lớp

| Lớp | Chế độ | Nguồn thực dùng |
| --- | --- | --- |
| Thời tiết | **Sống** — API, đệm 60 phút | Open-Meteo (tier miễn phí, chỉ demo) |
| Thổ nhưỡng (pH, sét, carbon hữu cơ) | Tĩnh — raster tải một lần | SoilGrids 2.0, 250 m |
| Địa hình | Tĩnh — raster tải một lần | Copernicus DEM GLO-90 (brief ghi GLO-30 — xem báo cáo) |
| Mực nước | Tĩnh — nạp CSV | MRC Data Portal; **chưa có CSV → chuỗi minh hoạ có nhãn** |
| Xâm nhập mặn | Tĩnh — nhập tay | Bản tin VKHTLMN 11/3/2025 và 20/3/2026 |

Chi tiết, giấy phép, ngày lấy: [SOURCES.md](SOURCES.md). Kết quả tiêu chí và khuyến nghị: [SPIKE-REPORT.md](SPIKE-REPORT.md).

## Kiến trúc — hợp đồng adapter (R-01)

```
gis-demo/
  src/adapters/types.ts        hợp đồng: source() · valueAt() · series() · updatedAt() · mapData()
  src/adapters/openMeteo.ts    thời tiết — nguồn sống duy nhất, mọi lời gọi qua callExternal() để đếm
  src/adapters/staticRaster.ts thổ nhưỡng + địa hình — đọc lưới trong bộ nhớ, không gọi mạng
  src/adapters/mrcWaterLevel.ts mực nước — CSV → CSDL demo; chưa có thì minh hoạ có nhãn
  src/adapters/siwrrSalinity.ts mặn — bảng nhập tay data/salinity-siwrr.json
  src/adapters/basemap.ts      nền OSM đã render, danh sách dự phòng
  src/adapters/registry.ts     nơi DUY NHẤT biết lớp nào dùng nguồn nào
  src/raster/geotiff.ts        bộ đọc GeoTIFF tối giản (tiled, DEFLATE, predictor 2/3)
  src/raster/grid.ts, png.ts   lưới Float32 + ảnh phủ PNG, không thư viện
  src/fetch/fetchStatic.ts     tải một lần, ghi data/sources.json
  src/server.ts                API + tệp tĩnh; không route nào gọi ra ngoài
  src/db.ts                    SQLite riêng: bộ đệm, đếm lời gọi ngoài, nhật ký không PII
  web/                         Leaflet + JS thuần; KHÔNG biết tên nguồn nào
  data/salinity-siwrr.json     bảng mặn nhập tay (có trích dẫn nguyên văn bản tin)
  data/import/                 đặt mrc-water-level.csv vào đây (cột: station_code,station_name,river,lat,lng,day,level_m)
```

Giao diện chỉ hỏi adapter: đổi Open-Meteo sang Copernicus CDS là viết một adapter và đổi một dòng trong
`registry.ts`; `web/` không sửa gì. Test `tests/gis-demo.test.ts` rà mã để bắt vi phạm: URL ngoài
ngoài thư mục adapter, tên nguồn viết cứng trong giao diện, bảng hình học OSM trong CSDL.

## API

```
GET /api/layers                      danh sách lớp (source() của từng adapter) + nền + biến thổ nhưỡng
GET /api/layers/:id/map              dữ liệu vẽ: {kind:'raster', imageUrl, bbox} hoặc {kind:'geojson', geojson}
GET /api/layers/:id/image            PNG raster tĩnh (soil-ph, soil-clay, soil-soc, terrain)
GET /api/layers/:id/value?lat&lng    giá trị tại điểm — F-03
GET /api/layers/:id/series?lat&lng&from&to   chuỗi thời gian — F-04
GET /api/plots                       lô mẫu minh hoạ — F-06
GET /api/stats                       số lời gọi ngoài 5 / 60 phút — tiêu chí 8
```

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `GIS_DEMO_PORT` | 4190 | Cổng máy chủ |
| `GIS_DEMO_DB` | gis-demo/data/gis-demo.db | CSDL riêng của demo |
| `GIS_DEMO_TILE_URL` | — | Nền bản đồ ưu tiên (ví dụ nhà cung cấp tile thương mại) |
| `GIS_DEMO_MRC_CSV` | gis-demo/data/import/mrc-water-level.csv | Tệp mực nước xuất từ MRC |

## Những điều demo KHÔNG làm (brief §2, A.5)

Không ghi vào CSDL AgriGreen; không dữ liệu hộ, thửa thật, ảnh hiện trường; không import hình học OSM;
không cào web; không thêm nguồn ngoài mục 5 của brief.
