# Bảng nguồn dữ liệu — SPIKE-GIS-LAYERS-001

*Cập nhật từ mục 5 của brief theo những gì THỰC SỰ dùng. Ngày lấy: 06/09/2026.*

| Lớp | Nguồn thực dùng | Phiên bản / độ phân giải | Cách lấy | Giấy phép | Ghi nguồn hiển thị | Lấy ngày | Kết luận cho sản phẩm thật |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Thời tiết | **Open-Meteo** — Forecast API (hiện tại) + Archive API (lịch sử, ERA5) | Hiện tại: mô hình tổng hợp ~ 9–11 km; lịch sử: ERA5/ERA5-Land, dữ liệu từ 1940, dùng từ 01/01/2015 | API sống qua adapter, bộ đệm 60 phút (hiện tại) / 24 giờ (lịch sử) theo ô 0,1° | CC BY 4.0; **tier miễn phí chỉ cho đánh giá / làm mẫu** | "Weather data by Open-Meteo.com" + liên kết | Sống | Phải mua gói thương mại, tự vận hành mã AGPLv3, hoặc đổi sang ERA5 (Copernicus CDS) / NASA POWER — chỉ cần viết adapter mới |
| Thổ nhưỡng | **SoilGrids 2.0** (ISRIC) — WCS `maps.isric.org` | 250 m, tầng 0–5 cm, giá trị mean; ba thuộc tính: pH (H₂O), sét, carbon hữu cơ | GetCoverage 4 ô/thuộc tính, GeoTIFF int16 DEFLATE → lưới Float32 1 150×1 088 + PNG 575×544 (91–231 KB) | CC BY 4.0, thương mại được | "© ISRIC — World Soil Information / SoilGrids" | 06/09/2026 | Dùng được; phủ ~57 % khung bao (phần còn lại là biển và mặt nước). Ước lượng mô hình toàn cầu, không thay phân tích mẫu đất |
| Địa hình | **Copernicus DEM GLO-90** qua AWS Open Data (`copernicus-dem-90m`) | 90 m (DSM, EGM2008), 12 ô 1°×1°, bản 2022; giảm mẫu 3× → ~270 m, lưới 1 039×1 039, PNG 520×520 (276 KB) | Tải 12 COG (tổng ~40 MB), giải mã float32 DEFLATE predictor 3, ghép, cắt | Giấy phép Copernicus DEM — thương mại được, ghi nguồn bắt buộc | "© Copernicus DEM" | 06/09/2026 | **Lệch brief**: brief ghi GLO-30. GLO-30 cũng công khai trên cùng bucket (`copernicus-dem-30m`), ~400 MB cho khung bao; demo dùng GLO-90 để tải một lần nhanh. Đổi sang GLO-30 chỉ là đổi hằng số trong `fetchStatic.ts`. Lưu ý DSM là cao độ MẶT (gồm cây, nhà) |
| Mực nước | **MRC Data Portal** — *chưa nạp được* | — | Portal cho xem/vẽ miễn phí; **tải dữ liệu thô cần giấy phép PDIES + phí**. API near-real-time của trang monitoring (`api.mrcmekong.org/api/v1/time-series/telemetry/recent`) trả **401** không có khoá — demo không lấy khoá nhúng trong trình duyệt của họ | Thủ tục PDIES | "Nguồn: Ủy hội sông Mê Công quốc tế (MRC)" khi có CSV; hiện là "DỮ LIỆU MINH HOẠ" | — | Lớp chạy trên **chuỗi minh hoạ có nhãn**; nạp `data/import/mrc-water-level.csv` (xuất từ portal theo PDIES) là có số thật. Trước sản phẩm thật: ký PDIES, đọc điều kiện tái phân phối |
| Xâm nhập mặn | **Viện Khoa học Thủy lợi miền Nam** — bản tin PDF công khai trên `siwrr.org.vn` | Mùa khô 2025: bản tin ngày 11/3/2025 (số theo từng cửa sông). Mùa khô 2026: thông báo số 11/TB-VKHTLMN ngày 20/3/2026 (số gộp các cửa sông Cửu Long) | **Nhập tay** 12 dòng vào `data/salinity-siwrr.json`, đúng câu chữ bản tin; vị trí vẽ nội suy theo trục cửa sông (xấp xỉ của đội demo) | Số liệu đã công bố; trích dẫn | "Nguồn: Viện Khoa học Thủy lợi miền Nam, bản tin ngày dd/mm/yyyy" + liên kết PDF | 06/09/2026 | Không có API; mỗi mùa khô nhập tay 1–3 bản tin. Có thể thoả thuận với Viện để nhận bản tin định kỳ |
| Nền bản đồ | **OpenStreetMap** — tile đã render | Zoom ≤ 17 | Trình duyệt tải tile; thử lần lượt OSMF → OSM France → CARTO Positron | ODbL — chỉ dùng nền render (R-02), không tải vector | "© OpenStreetMap contributors" (+ tên nhà render) | Sống | **Phát hiện**: DNS của VNPT (máy thử) trả *non-existent domain* cho `tile.openstreetmap.org`; OSM France và CARTO tới được. Sản phẩm thật: nhà cung cấp tile thương mại hoặc tự vận hành |

## Nguồn đã khảo sát nhưng không dùng

| Nguồn | Vì sao không |
| --- | --- |
| SoilGrids REST point API (`rest.isric.org`) | Trả `null` cho nhiều điểm đồng bằng (mặt nước 250 m), chậm ~1–2 s/điểm; WCS cho cả vùng một lần tốt hơn và không phụ thuộc mạng lúc bấm |
| Copernicus DEM GLO-30 | Cùng nguồn, ~10× dung lượng; để ngoài spike, đổi được bằng một hằng số |
| MRC API telemetry | 401 — cần khoá; không lấy khoá nhúng của trang MRC (vượt kiểm soát truy cập) |
| Bản tin mặn của Trung tâm Dự báo KTTV Quốc gia (qua báo chí) | Có số theo từng sông và mới hơn (4/2026) nhưng **không nằm trong danh sách nguồn của brief**; giữ đúng nguồn Viện. Đề nghị CEO quyết nếu muốn thêm |
| Địa chất | Loại theo brief §3 |

## Tệp sinh ra khi tải (không đưa vào git)

`gis-demo/data/rasters/*.f32` (lưới Float32, 4–5 MB mỗi lớp), `gis-demo/data/gis-demo.db` (CSDL riêng). Chạy lại bằng `npm run gis-demo:fetch`; mô tả từng lưới nằm trong `data/sources.json` và `data/rasters/*.json` (URL, ngày tải, phiên bản, giấy phép).
