# Báo cáo spike — SPIKE-GIS-LAYERS-001

*Ngày 06/09/2026 · Đường quy trình Discovery / Spike · Đầu ra 3 theo brief §8, giữ dưới 2 trang.*

## 1. Kết quả tiêu chí đạt (brief §7)

| # | Tiêu chí | Ngưỡng | Kết quả | Cách đo |
| --- | --- | --- | --- | --- |
| 1 | Bản đồ hiển thị đủ 5 lớp | 5/5 | **5/5 hiển thị** — nhưng lớp mực nước chạy trên *chuỗi minh hoạ có nhãn*, chưa có số MRC | Mở từng lớp trên trình duyệt |
| 2 | Tải bản đồ lần đầu, 4G, điện thoại phổ thông | ≤ 5 s | **Ước đạt.** Đo nội bộ: sẵn sàng 44–55 ms; vỏ ứng dụng 39 kB + Leaflet CDN ~150 kB + ảnh phủ raster 91–283 kB + tile nền. Ở 4G ~5 Mbit/s tổng ~0,6 MB ≈ 1–2 s. **Chưa đo trên điện thoại thật qua 4G** — mục còn nợ | `performance.getEntriesByType('navigation')`, kích cỡ tệp |
| 3 | Phản hồi khi bấm một điểm | ≤ 2 s | **Đạt**: lớp tĩnh 9–20 ms; thời tiết 1,3 s lần đầu (gọi nguồn), < 20 ms khi trúng bộ đệm | Đo từ trình duyệt, 5 lớp, cùng một điểm |
| 4 | Chuỗi thời tiết lịch sử 12 tháng tại một điểm | ≤ 3 s | **Đạt**: 1,4 s lần đầu (365 điểm, 18,6 kB), 0,37 s lần sau; năm 2015 trả đủ từ 01/01/2015 | Đo từ trình duyệt |
| 5 | Lớp có nhãn nguồn và mốc thời gian trên màn hình | 5/5 | **5/5** — khối nguồn cố định góc trái, chuỗi ghi nguồn lấy từ adapter, nhãn *sống* / *tĩnh — chụp ngày* | Test tự động `F-05 / R-04` + kiểm mắt |
| 6 | Lời gọi API ngoài nằm ngoài lớp adapter | 0 | **0** | Test tự động rà toàn bộ `src/` ngoài `adapters/`, `fetch/`: không `fetch(`, không URL ngoài; giao diện không chứa tên nguồn |
| 7 | Bản ghi hình học OSM trong CSDL demo | 0 | **0** | Test tự động rà `sqlite_master`; không `osm2pgsql`/overpass/pbf trong mã |
| 8 | Lời gọi API ngoài trong phiên xem 5 phút | ≤ 50 | **8** trong phiên thử nặng (đổi 5 lớp, bấm 6 điểm, 2 chuỗi); bộ đệm 60 phút theo ô 0,1° | `/api/stats`, bảng `external_calls` |
| 9 | Chạy trên trình duyệt di động | Có | **Có** — khung 375×812: thanh chọn lớp, khối nguồn, ghim, bảng kết quả trượt lên | Giả lập thiết bị trong trình duyệt; **chưa thử trên máy thật** |

**Kết luận: 8/9 đạt, tiêu chí 2 ước đạt nhưng chưa đo trên máy thật.** Tiêu chí 1 đạt về hiển thị
nhưng phải đọc kèm ghi chú: mực nước là minh hoạ cho tới khi có CSV MRC.

## 2. Nguồn khó dùng hơn dự kiến — và vì sao

**MRC (mực nước) — khó nhất.** Portal cho xem và vẽ miễn phí; tải dữ liệu thô đi qua PDIES
(giấy phép + phí). API near-real-time mà trang monitoring của MRC dùng trả 401 khi không có
khoá. Lấy khoá nhúng trong trình duyệt của họ là vượt kiểm soát truy cập, không phải "nguồn
mở" — demo không làm. Kết quả: lớp chạy trên chuỗi minh hoạ, nhãn đỏ trên màn hình; nạp
CSV là có số thật. Đây đúng là rủi ro #10 của brief hiện ra sớm hơn dự kiến.

**Mặn (VKHTLMN) — dễ hơn dự kiến về nguồn, khó ở dạng.** Bản tin là PDF scan trên website
Viện, có số theo từng cửa sông (11/3/2025) nhưng bản 2026 chỉ có số gộp. Nhập tay 12 dòng.
Không có toạ độ: vị trí vẽ là nội suy theo trục cửa sông của đội demo — nhãn nói rõ.

**Nền bản đồ — bất ngờ thật sự.** DNS của VNPT (máy thử) không phân giải
`tile.openstreetmap.org`. Demo thêm dự phòng OSM France → CARTO, tự chuyển sau 3 tile lỗi.
Người thuyết trình dùng mạng khác có thể không gặp; người xem dùng VNPT sẽ thấy nền chuyển.

**Thổ nhưỡng, địa hình — đúng dự kiến.** WCS của ISRIC và bucket AWS của Copernicus mở,
tải một lần ~45 MB. Chi phí nằm ở bộ đọc GeoTIFF tự viết (không thư viện): 130 dòng, đã
kiểm trên tệp thật của cả hai nguồn. **Lệch brief**: dùng GLO-90 thay GLO-30 để tải nhanh
(~10× nhẹ hơn); đổi lại là một hằng số.

**Thời tiết — đúng dự kiến.** Tier miễn phí Open-Meteo hoạt động, trễ ~1,3 s mỗi lời gọi
mới từ Việt Nam; bộ đệm 60 phút giữ số lời gọi ở mức một chữ số.

## 3. Ước lượng công sức đưa từng lớp lên sản phẩm thật

| Lớp | Việc phải làm | Công sức | Phần dùng lại từ demo |
| --- | --- | --- | --- |
| Thời tiết | Chốt nguồn (gói thương mại Open-Meteo / ERA5 CDS / NASA POWER), viết adapter mới, đệm phía máy chủ dùng chung, cảnh báo mưa cho kế hoạch thu gom | 1–2 tuần | Hợp đồng adapter, bộ đệm, cách hiển thị; đổi 1 tệp |
| Thổ nhưỡng | Tải GLO đủ độ phân giải, cắt theo tỉnh, chuyển sang tile pyramid (hoặc dùng WMS ISRIC có kiểm tải), thêm tầng sâu hơn | 1 tuần | Bộ đọc GeoTIFF, lưới, PNG, adapter |
| Địa hình | Đổi GLO-30, tile pyramid, thêm chỉ số ngập (cao độ so với mực triều) — đây mới là thứ chi phối vị trí hub cùng sức chịu tải nền | 1–2 tuần | Như trên |
| Mực nước | Ký PDIES với MRC (thời gian hành chính, không phải kỹ thuật), pipeline nhập định kỳ, đọc kỹ điều kiện tái phân phối; song song cân nhắc trạm đo của Đài KTTV khu vực Nam Bộ | 1 tuần kỹ thuật + hành chính không ước được | Adapter, bảng, nạp CSV |
| Xâm nhập mặn | Quy trình nhập tay mỗi bản tin (1–3 lần/mùa khô), hoặc thoả thuận nhận số liệu trạm với Viện; số hoá trục sông thật để vẽ đúng | 2–3 ngày + thoả thuận | Bảng nhập tay, adapter |
| Nền bản đồ | Nhà cung cấp tile thương mại hoặc tự vận hành; bỏ máy chủ tile công cộng | 2–3 ngày | Cấu hình `basemap.ts` |

**Dùng lại được:** lớp adapter và hợp đồng, bộ đọc raster, cách dựng khối nguồn, bộ test
rà mã. **Phải viết lại:** giao diện (demo là JS thuần một tệp; sản phẩm nằm trong cổng
GIS của AgriGreen), lưu trữ raster (tile pyramid thay ảnh phủ đơn), pipeline cập nhật.

## 4. Khuyến nghị: giữ lớp nào, bỏ lớp nào

| Lớp | Khuyến nghị | Lý do |
| --- | --- | --- |
| Địa hình | **Giữ, ưu tiên 1** | Rẻ, mở, thương mại được; kết hợp mực triều ra được bản đồ nguy cơ ngập cho vị trí hub và bãi rơm |
| Thời tiết | **Giữ** | Nguồn thay thế sẵn; giá trị tức thời cho kế hoạch cuộn rơm (A4 trong bản rà soát hệ thống) |
| Xâm nhập mặn | **Giữ ở dạng tĩnh theo mùa** | Không có API, nhưng chi phí nhập tay thấp và người xem phản ứng mạnh với lớp này; phải giữ nhãn "chụp ngày" |
| Thổ nhưỡng | **Giữ nhưng hạ kỳ vọng** | 250 m là ước lượng mô hình; hữu ích để nhìn vùng phèn / than bùn, không thay phân tích mẫu đất |
| Mực nước | **Chờ quyết định PDIES** | Không có dữ liệu thô thì lớp chỉ là hình vẽ; đừng đưa vào phạm vi sản phẩm cho tới khi giấy phép xong |

## 5. Việc tồn đọng ghi thành dòng (brief §10)

1. Tier miễn phí Open-Meteo chỉ hợp lệ ở mức demo — chốt phương án trước khi có người dùng ngoài.
2. Ký PDIES với MRC hoặc bỏ lớp mực nước.
3. Đo tiêu chí 2 và 9 trên điện thoại phổ thông qua 4G thật.
4. Quyết định GLO-30 hay GLO-90.
5. Có nên thêm bản tin mặn của Trung tâm Dự báo KTTV Quốc gia (không trong danh sách brief, số mới hơn và theo từng sông)?
6. Nhà cung cấp tile nền cho sản phẩm thật.

*Mã nguồn: `gis-demo/` · Bảng nguồn: `gis-demo/SOURCES.md` · 18 test tự động trong `tests/gis-demo.test.ts`.*
