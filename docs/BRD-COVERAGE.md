# Ma trận bao phủ BRD / User Story — đợt cập nhật 09/2026

Tài liệu đối chiếu bốn bộ yêu cầu đính kèm với phần đã hiện thực trong mã nguồn:

| Bộ yêu cầu | Tệp nguồn | Trạng thái |
| --- | --- | --- |
| GIS — BRD v1.5 (FN-01..23, BR-01..74), Backlog v1.1 (38 story, epics A–H), bản mẫu `Mekong_Green_GIS_v1.3.html` | `src/agrigreen/gis/*`, `src/mdm/{lifecycle,geoImport}.ts`, `src/web/pages/gis.js`, `gis-admin.js` | Cao: đủ · TB: phần lớn · Thấp: hoãn |
| Bản đồ Cơ giới hoá — BRD v1.3 (FN-01..12, QT-01..03), Backlog v4.0 (26 story) | `src/agrigreen/cgh/{service,ops}.ts`, `src/web/pages/cgh.js` | Cao: đủ · TB: đủ · Thấp: một phần |
| App Hợp tác xã — Backlog v4.0 (48 story, epics A–K), bản mẫu `App Hợp tác xã_v5.1.html` | `src/agrigreen/htx/{service,fieldOps}.ts`, `src/mdm/varieties.ts`, `src/web/pages/htx.js` | Cao: đủ · TB: phần lớn · Thấp: hoãn |
| App Khuyến nông — BRD v1.0, Backlog v1.0 (52 story, epics A–L), bản mẫu `App_Khuyen_Nong_v5.0.html` | `src/agrigreen/khuyennong/{service,ops}.ts`, `src/platform/auth/users.ts`, `src/web/pages/kn.js` | Cao: đủ · TB: phần lớn · Thấp: hoãn |

Ký hiệu: **✔ đủ** — hiện thực và có kiểm thử hoặc màn hình; **◐ một phần** — có luồng chính, thiếu tinh chỉnh; **✖ hoãn** — chưa làm, nêu lý do.

Kiểm thử: `tests/brd-2026.test.ts` (quy tắc mới) cộng 282 test sẵn có; chạy `npm test`.

---

## 1. Giao diện theo bản mẫu HTML

| Bản mẫu | Điểm bám theo | Nơi hiện thực |
| --- | --- | --- |
| App Khuyến nông v5.0 | Font Be Vietnam Pro; menu trái nền xanh đậm gradient, nhóm menu đánh số "1. Quản lý địa bàn & HTX / 2. Nghiệp vụ khuyến nông / 3. Tiện ích & cá nhân"; thẻ người dùng có avatar; 4 thẻ KPI nhiều màu; thẻ chuyên mục thư viện tô màu; thẻ thời tiết; thanh cảnh báo khẩn | `styles.css` (theme `html[data-portal="kn"]`), `portals.js`, `kn.js` |
| App Hợp tác xã v5.1 | Nền sáng, menu trắng, xanh dương `#00A3E0` + xanh lá `#00C237`, chữ 15,5 px, bo góc 14/18; lối tắt dạng ô icon; ô chọn hoạt động dạng lưới emoji; wizard 4 bước; thẻ thống kê icon; điều hướng đáy trên điện thoại | theme `html[data-portal="htx"]`, `htx.js`, `.qtile`, `.opt-grid`, `.wizard-steps`, `.bottom-nav` |
| GIS v1.3 | Nền kem `#F5F4EC`, xanh canopy `#12A150`, rail icon 96 px, thanh trên mờ, bản đồ tràn khung, panel lớp nổi có bộ chuyển nền + công tắc, thẻ nguồn dữ liệu góc phải, chú giải & thước ở đáy, tấm chi tiết trượt phải, thanh thời gian replay, 4 khung nhìn Bản đồ · Mùa vụ & Cảnh báo · Lịch sử & Replay · Quản trị (tab) | theme `html[data-portal="gis"]`, `.gis-stage/.layers-panel/.sheet/.timebar`, `gis.js`, `gis-admin.js` |
| Chung | Trang đăng nhập hai cột (thông điệp + form, chọn nhanh tài khoản mẫu, hiện/ẩn mật khẩu); bộ icon SVG `icons.js`; hộp thoại/xác nhận thống nhất; biểu đồ cột SVG thuần; bảng đầu tô màu, zebra; in ấn | `index.html`, `app.js`, `styles.css` |

---

## 2. GIS — BRD v1.5

| Mã | Yêu cầu | Trạng thái | Hiện thực |
| --- | --- | --- | --- |
| FN-01/02 | Lớp nền đường phố / vệ tinh / địa hình, đổi nhanh, dự phòng nhà cung cấp | ✔ | `createMap` 3 lớp có tự chuyển nguồn; bộ chuyển nền trong panel lớp |
| FN-03 | Cấu hình bảng màu mùa vụ, ngưỡng kho, nền mặc định, chu kỳ thời tiết; kiểm HEX; khôi phục mặc định | ✔ | `gis/admin.ts` `setCropPalette/setCapacityThresholds/setSimpleConfig/resetConfig`; tab Cấu hình |
| FN-04 | HTX: tạo/sửa, vẽ vùng hoặc đặt điểm, vô hiệu hoá có lý do ≥ 20 ký tự và báo ảnh hưởng, khôi phục | ✔ | `lifecycle.setBoundary/deactivateCooperative/cooperativeImpact/reactivateCooperative`; tab HTX |
| FN-05 | Kho/Hub/Nhà máy: thêm, sức chứa, xoá mềm/khôi phục, nhập tay dự phòng | ✔ | `lifecycle.softDelete/restore`, `gisAdmin.manualEntry`; tab Kho/Hub |
| FN-06 | Thửa: polygon theo zoom ≥ 13 & viewport, tải KML/GeoJSON, xoá mềm | ✔ | `gis.buildMapBundle` (bbox), `geoImport.parseSpatialFile`, `lifecycle.importFeatures('plot')`; tab Thửa |
| FN-07 | Ranh giới hành chính 2025: nạp GeoJSON/KML, xem trước khớp/không khớp, áp dụng | ✔ | `gisAdmin.previewAdminBoundaries/applyAdminBoundaries`; tab Ranh giới HC |
| FN-08/09 | Đường bộ / đường thuỷ với tải trọng; lọc tuyến đủ tải | ✔ | `/gis/routes/suitable?mode&load`; ô lọc tải trọng trong panel lớp, tô xanh tuyến đủ tải |
| FN-10/11 | Điểm HTX, cơ sở; tìm kiếm HTX/kho/xã | ✔ | Ô tìm trên thanh trên với gợi ý, bay tới & mở tấm chi tiết |
| FN-12 | Heatmap giai đoạn mùa vụ từ App HTX | ✔ | lớp `crop_heatmap`, khung nhìn Mùa vụ & Cảnh báo (biểu đồ + bảng) |
| FN-13 | Cảnh báo vùng chín rộ 3/7/14 ngày | ✔ | `/gis/harvest-alerts?days=` với chip chọn số ngày |
| FN-14 | Widget dung lượng kho theo ngưỡng | ✔ | lớp `capacity_widgets`, chú giải ngưỡng, tấm chi tiết có thanh % đầy |
| FN-15 | Thời tiết & cảnh báo theo tỉnh | ✔ | lớp `weather` (ghim nhiệt độ, nhấp nháy khi cảnh báo); bảng dự báo |
| FN-16 | Cấp bản đồ chuẩn hoá cho TMS | ✔ | nút "Cấp cho TMS" (`/gis/publish/tms`) |
| FN-17 | Lịch sử thay đổi theo đối tượng (trước/sau) | ✔ | `lifecycle.historyOf`; tab Nhật ký, nút lịch sử ở từng dòng |
| FN-18 | Snapshot hàng ngày, chính sách lưu trữ | ✔ | `/audit/snapshot`, `/audit/retention`; tab Lưu trữ, nút "Chụp snapshot" |
| FN-19 | Replay trạng thái theo ngày với thanh thời gian, phát/tạm dừng, dòng sự kiện | ✔ | khung nhìn Lịch sử & Replay (`/audit/replay/:date`) |
| FN-20 | Số hoá & đo tuyến đường thuỷ | ✔ (sẵn có) | trang `waterways` |
| FN-21 | Tích hợp App HTX / Bản đồ CGH / ERP / TMS, GIS chỉ hiển thị kết quả CGH | ✔ | `gisAdmin.integrationOverview`; tab Tích hợp; thẻ nguồn trên bản đồ |
| FN-22/23 | Giám sát đồng bộ, dead-letter, thử lại, mô phỏng lỗi | ✔ | `gisAdmin.syncMonitor/retryOne/simulateFailure`; tab Đồng bộ |
| BR-52 | Nhập tay dự phòng; nguồn quay lại phải hỏi trước khi ghi đè | ✔ | `pendingOverrides/resolveOverride` |
| Thấp | Đo diện tích/khoảng cách tự do trên bản đồ, in bản đồ ra PDF, phân quyền lớp theo vai trò | ✖ hoãn | chưa có yêu cầu dữ liệu đầu vào; in dùng chức năng in trình duyệt |

## 3. Bản đồ Cơ giới hoá — BRD v1.3 / Backlog v4.0

| Mã | Yêu cầu | Trạng thái | Hiện thực |
| --- | --- | --- | --- |
| US-CFG-01 | Chủng loại máy: ngừng sử dụng / kích hoạt, xoá khi chưa tham chiếu | ✔ | `cghOps.setMachineTypeActive/deleteMachineType`; tab Chủng loại |
| US-CFG-02 | Định mức có văn bản, khoảng hiệu lực không chồng, đóng hiệu lực | ✔ | `cgh.addProductivityNorm`, `cghOps.closeNorm`; trang Định mức |
| US-CFG-03 | Ngưỡng cảnh báo theo phiên bản, mốc tăng dần, áp đúng vụ | ✔ | `cgh.coverageThresholds(onDate)`, `cghOps.addThresholdVersion`; tab Ngưỡng |
| US-CFG-04 | Lịch sử cấu hình không ghi đè | ✔ | `cghOps.configHistory`; tab Lịch sử |
| US-OWN-01 | Chủ sở hữu: mã `CSH-<tỉnh>-xxxxx`, 4 loại, liên kết HTX, vô hiệu hoá kèm máy có xác nhận | ✔ | `cgh.createMachineOwner`, `cghOps.deactivateOwner` (409 cần xác nhận) |
| US-MAC-01 | Máy: mã `MAY-<tỉnh>-xxxxx`, SN/số khung bắt buộc & duy nhất, ngày sở hữu, nhiên liệu, công suất, lịch sử, vô hiệu hoá | ✔ | `cgh.createMachine`, `cghOps.updateMachine/deactivateMachine/machineHistory` |
| US-MAC-02 | Nhập hàng loạt hai chế độ Cập nhật / Thay thế, báo lỗi theo dòng, cấm cột mã máy | ✔ | `cghOps.importMachines`, `/cgh/machines/import` |
| US-MAC-03 (BR-09) | Số máy của HTX tại thời điểm T | ✔ | `cghOps.machineCountAt`; ô "Số máy tại ngày" trong panel chi tiết |
| US-MAP-01..03 | Bản đồ mức đáp ứng: lọc vụ/khâu/mức, tìm HTX/xã/máy/chủ, panel chi tiết | ✔ | `cghOps.quickSearch/htxDetail`; trang Bản đồ |
| US-ANL-01 | Cân đối theo tỉnh, lưu kết quả theo vụ | ✔ | `cghOps.balanceByProvince/saveBalanceSnapshot`; trang Cân đối 3 tab |
| US-RPT-01 | Báo cáo từ kết quả đã lưu, tiêu đề ngày xuất & vụ, CSV, in | ✔ | `cghOps.report`, `/cgh/report.csv`; trang Báo cáo |
| US-RPT-02 | Đối chiếu hai vụ, đánh dấu phần chỉ có ở một vụ | ✔ | `cghOps.compareSeasons`, `/cgh/compare.csv` |
| US-DASH-01 | 4 thẻ, HTX cần ưu tiên, máy theo khâu/tỉnh, xu hướng vụ, khối vận hành cho Admin, banner đồng bộ lỗi 3 lần | ✔ | `cghOps.dashboardV2` |
| US-LOG-01 | Nhật ký đăng nhập / tài khoản / truy cập bị từ chối, lọc ≤ 90 ngày | ✔ | `router.ts` ghi `access_denied`, `cghOps.activityLog`; trang Nhật ký |
| Thấp | Xuất PDF có dấu, gửi báo cáo email tự động cho CGH | ◐ | in qua trình duyệt; lịch gửi báo cáo dùng chung `report_schedules` (`system: 'cgh'`) chưa có màn hình riêng |

## 4. App Hợp tác xã — Backlog v4.0

| Mã | Yêu cầu | Trạng thái | Hiện thực |
| --- | --- | --- | --- |
| US-AUTH | Đăng nhập tên/SĐT, khoá 5 lần sai, thông điệp rõ | ✔ | `users.login`, `LoginError` → HTTP 423 |
| US-HH-01..03 | Nông hộ: thêm (SĐT đúng định dạng, không trùng), sửa, nhập hàng loạt, danh sách kèm thửa/diện tích | ✔ | `/htx/farmers*`, `lifecycle.farmersWithPlots/importFarmers/updateFarmer`; trang Nông dân |
| US-PLOT-01..05 | Vẽ ≥ 4 điểm, GPS thiết bị, kiểm chồng lấn (cùng HTX xác nhận, khác HTX chặn), tải KML/GeoJSON, dán toạ độ, xác minh vị trí | ✔ | `lifecycle.createPlotChecked/findOverlaps`, `/htx/plots*`; trang Thửa ruộng |
| US-CAT-01/02 | Danh mục giống lúa (ngày sinh trưởng, dải năng suất, SOP mặc định), ẩn khi đang dùng | ✔ | `mdm/varieties.ts`, `/mdm/rice-varieties*` |
| US-SEASON-01..04 | Wizard 4 bước, ngày sạ −15/+30, giống → SOP tự gán & tạo kế hoạch, mở nhiều thửa, sao chép vụ trước | ✔ | `htxOps.openSeasonV2/openSeasonBulk/previousSeasonConfig`; trang Mùa vụ |
| US-LOG-01..05 | Nhật ký: hoạt động, vật tư, ảnh, GPS (khớp/không khớp/thiếu/không có thiết bị), máy đã dùng, ghi nhiều thửa, offline | ✔ | `htxOps.addFarmLogV2/addFarmLogsBulk/gpsStatusFor`; hàng đợi offline `app.js` |
| US-APPR-01/02 | Duyệt / yêu cầu bổ sung; chỉ bản đã duyệt vào số liệu; cờ "tạm tính" | ✔ | `htxOps.pendingLogs/reviewFarmLog`; trang Duyệt nhật ký; `knOps.summaryReportRows.provisional` |
| US-HARV-01..03 | Khai sản lượng với cảnh báo bất thường theo giống (409 xác nhận), khai nhiều vụ, tình trạng rơm, độ ẩm | ✔ | `htxOps.declareHarvestV2/declareHarvestBulk/yieldAnomaly` |
| US-DASH | Thẻ số liệu, biểu đồ dự kiến vs thực tế theo vụ, năng suất theo giống, thời tiết, bản tin khẩn, lối tắt | ✔ | `htxOps.yieldDashboard`; trang Bảng điều hành |
| US-RPT-01..03 | Báo cáo sản lượng theo vụ, CSV, in, lịch gửi tuần/tháng/quý | ✔ | `htxOps.harvestReportRows`, `report_schedules` + `runDueReportSchedules` |
| US-NEWS-01..03 | Bản tin theo chuyên mục, tìm kiếm, tin khẩn xếp đầu, đếm lượt xem | ✔ | `htxOps.newsFeed/markArticleViewed`; trang Bản tin |
| US-HTXSTATUS | Vô hiệu hoá HTX khoá tài khoản; kích hoạt lại mở khoá | ✔ | `lifecycle.deactivateCooperative/reactivateCooperative` |
| Thấp | Gửi lịch báo cáo qua email thật, ứng dụng di động gốc, quét mã QR vật tư | ✖ hoãn | chưa có máy chủ email; hàng đợi `report_schedules` ghi log "đã gửi" |

## 5. App Khuyến nông — BRD v1.0 / Backlog v1.0

| Mã | Yêu cầu | Trạng thái | Hiện thực |
| --- | --- | --- | --- |
| US-AUTH-01..03 | Đăng nhập SĐT/tên, khoá 5 lần/15 phút, chính sách mật khẩu, ghi nhật ký đăng nhập | ✔ | `users.login/passwordWeaknesses`, `LoginError` |
| US-DASH-01/02 | Bảng điều hành theo phạm vi TW/tỉnh/xã; cờ "tạm tính" | ✔ | `knOps.scopeOf/scopedDashboard`; trang Bảng điều hành |
| US-HTX-01/04 | Danh sách HTX trong phạm vi, khai báo máy móc theo chủng loại | ✔ | `knOps.cooperativesInScope/declareMachinery`; trang HTX & cơ giới hoá |
| US-PLOT-01..03 | Cán bộ vẽ thửa cho HTX bất kỳ (≥ 4 điểm, chồng lấn) | ✔ | `/mdm/plots/checked`; trang Vẽ thửa (sẵn có) dùng chung luật |
| US-TASK-01..04 | SLA 24h, leo thang tự động lên TTKN tỉnh, chuyển tiếp thủ công, phân công hàng loạt, cảnh báo khẩn theo vùng | ✔ | `knOps.tasksWithSla/escalateOverdueTasks/escalateTask/bulkAssignTasks/regionalAlert` |
| US-LIB-01..06 | Chuyên mục, tin khẩn, hướng dẫn địa phương gắn quy trình gốc + nhãn tỉnh, tìm kiếm có gợi ý, thông báo theo vùng khi xuất bản | ✔ | `knOps.createArticleV2/publishArticleV2/searchArticles`; trang Thư viện |
| US-PRICE-01..04 | Bảng giá, bản tin giá ngày (chỉ khi có giá hôm nay), danh sách theo dõi ngưỡng, quét tự động | ✔ | `knOps.publishPriceBulletin/setWatch/scanWatchlists` |
| US-RPT-01..03 | Báo cáo tổng hợp theo phạm vi, CSV/in, lịch gửi | ✔ | `knOps.summaryReportRows`, `/kn/reports/summary.csv` |
| FN-03/04, FN-12, FN-15 | Cây tổ chức, đào tạo ToT, danh bạ trực | ✔ (sẵn có, làm lại giao diện) | `kn.js` |
| Thấp | Khảo sát nâng cao có nhánh điều kiện, chat trực tiếp với nông dân, đồng bộ Zalo OA | ✖ hoãn | ngoài phạm vi nền tảng web hiện tại |

---

## 6. Hạ tầng dùng chung đã bổ sung

- **Cột & bảng mới** (`schema.ts`): `users.failed_attempts/locked_until/lock_reason/last_login_at`; `farm_logs.approval_status/approved_by/review_note/gps_status/gps_distance_m/machines_json`; `plots|facilities|cooperatives.deleted_at…`; `knowledge_articles.category/urgent/parent_id/region_label/view_count`; `machines.owned_since/deactivated_at/status/fuel/power_hp`; bảng `rice_varieties`, `htx_machinery_declarations`, `price_watchlist`, `cgh_balance_snapshots`, `report_schedules`.
- **Tiến trình nền** (`server.ts`): leo thang SLA, quét ngưỡng giá, chạy lịch gửi báo cáo cùng vòng quét cảnh báo 10 phút.
- **HTTP**: 409 `needsConfirm` cho thao tác cần xác nhận (giao diện tự hiện hộp xác nhận rồi gọi lại với cờ), 423 cho tài khoản bị khoá, ghi `access_denied` khi thiếu quyền.
- **Dữ liệu trình diễn** (`seedDemoHtx.ts`): nông hộ, thửa, mùa vụ đã/đang canh tác, nhật ký ở các trạng thái GPS/duyệt, một yêu cầu hỗ trợ — chỉ chạy khi CSDL chưa có thửa.
