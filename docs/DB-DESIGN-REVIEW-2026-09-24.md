# Rà soát thiết kế cơ sở dữ liệu theo 11 nguyên tắc — 24/09/2026

Đối tượng: `src/platform/db/schema.ts` (105 bảng, 1.145 cột), cách tách miền trong `domains.ts`, luồng dùng chung trong `sync/sharedFlows.ts`, và 7 tệp SQLite thực tế trong `data/`. Số liệu do script phân tích schema và `PRAGMA integrity_check / foreign_key_check / foreign_key_list` trên tệp thật cung cấp; không có con số nào là ước lượng.

## Tóm tắt

| # | Nguyên tắc | Đánh giá | Điểm chính |
| --- | --- | --- | --- |
| 1 | Tránh trùng lặp | **Khá** | Không bảng nào tồn tại ở hai tệp; 13 cột dẫn xuất (tồn kho, diện tích, số thành viên) được cập nhật trong giao dịch. Còn hai cột sao chép tên (`cgh_balance_snapshots.season_name`, `event_log.actor_name`) — chấp nhận được vì là ảnh chụp/nhật ký. |
| 2 | Khoá chính | **Tốt** | 105/105 bảng có khoá chính (101 khoá đơn TEXT UUID, 4 khoá tổ hợp). |
| 3 | Giá trị null | **Trung bình** | 441/1.145 cột cho phép NULL, trong đó 103 cột `*_id`. Phần lớn có chủ đích (quan hệ tuỳ chọn) nhưng một số cột nghiệp vụ nên bắt buộc (`machines.htx_id`, `support_tasks.htx_id`, `input_issues.crop_cycle_id`). |
| 4 | Toàn vẹn tham chiếu | **Yếu — cần xử lý** | 186 cột `*_id` nhưng chỉ 56 ràng buộc FOREIGN KEY được khai; **15 trong số đó bị gỡ khi tách miền** (SQLite không cho khoá ngoại trỏ sang tệp khác) → thực tế còn 41. Dữ liệu hiện tại sạch (0 vi phạm) nhờ kiểm tra ở tầng dịch vụ, nhưng không có gì bảo vệ ở tầng CSDL. |
| 5 | Tính nguyên tử | **Khá** | 22 cột JSON/GeoJSON: ranh giới, hình học tuyến, payload snapshot/mô phỏng, cấu hình — đúng chỗ (dữ liệu không truy vấn theo trường con). Ngoại lệ đáng xem: `survey_questions.options`, `field_job_stages.evidence_json`. |
| 6 | Chuẩn hoá | **Tốt** | Danh mục tách bảng (mùa vụ, giống, chủng loại máy, đơn vị hành chính); bảng nối `user_roles`, `group_permissions`; định mức và ngưỡng có phiên bản theo hiệu lực thay vì ghi đè. |
| 7 | Kiểu dữ liệu | **Trung bình** | Ngày giờ là TEXT ISO-8601 (172 cột) — phù hợp SQLite; 11 cột boolean là INTEGER 0/1; **19 cột tiền tệ dùng REAL** (số thực nhị phân) → sai số làm tròn khi cộng dồn công nợ; 68 cột trạng thái/enum là TEXT tự do, chỉ 3 ràng buộc CHECK toàn schema. |
| 8 | Chỉ mục | **Yếu — cần xử lý** | 14 chỉ mục tường minh cho 105 bảng; 96 bảng không có chỉ mục nào ngoài khoá chính/UNIQUE. Cột lọc nhiều nhất trong mã (`htx_id` 39 truy vấn, `user_id`, `facility_id`, `plan_id`, `crop_cycle_id`, `recipient_user_id`) đều chưa có chỉ mục. |
| 9 | Phân vùng schema | **Tốt** | 7 tệp theo hệ thống con (dùng chung 34 bảng, ERP 29, HTX 16, KN 14, CGH 7, Hiện trường 7, GIS 5); test bắt bảng mới chưa xếp miền; luồng dùng chung khai báo chủ sở hữu/người nhận. Đánh đổi là điểm 4 ở trên. |
| 10 | Bảo mật | **Trung bình** | Xác thực, phân quyền, phạm vi HTX, nhật ký append-only, che số điện thoại đều có. **Mật khẩu băm SHA-256 + salt một vòng** (không phải KDF) — chống dò yếu; dữ liệu cá nhân (SĐT, CCCD, email) lưu rõ; chưa mã hoá tệp CSDL. |
| 11 | Sao lưu & phục hồi | **Chưa có** | Không script sao lưu, không lịch, không kiểm tra khôi phục. Có WAL, chính sách lưu trữ nhật ký/snapshot và dọn `request_log`. Tệp `mekonggreen.legacy-single-file.db` 9,1 MB còn nằm trong `data/`. |

Kết luận: nền tảng thiết kế hợp lý (khoá chính, chuẩn hoá, phân miền, truy vết). Ba việc phải làm trước khi dùng dữ liệu thật: **chỉ mục cho cột lọc**, **sao lưu có kiểm tra khôi phục**, và **bù toàn vẹn tham chiếu xuyên miền** (kèm nâng thuật toán băm mật khẩu).

---

## Chi tiết theo nguyên tắc

### 1. Tránh trùng lặp

- Không bảng nào xuất hiện ở hai tệp CSDL (kiểm trên 7 tệp thật). Bảng dùng chung nằm một chỗ ở tệp `shared`, các miền khác truy vấn qua ATTACH — không nhân bản dữ liệu.
- 13 cột dẫn xuất được lưu sẵn để đọc nhanh: `facilities.current_stock_tons`, `stock_lots.remaining_tons`, `plots.area_ha`, `crop_cycles.area_ha`, `cooperatives.member_count`, `registered_area_ha`, `farmers.reliability_score`, `stock_lots.risk_score`… Chúng được cập nhật trong cùng giao dịch với nghiệp vụ (đã siết lại ở phiếu xuất ngày 24/09). Rủi ro còn lại: `cooperatives.member_count` tăng khi tạo nông hộ nhưng không giảm khi nông hộ ngừng hoạt động.
- Hai cột sao chép tên: `cgh_balance_snapshots.season_name` (ảnh chụp có chủ đích — báo cáo phải giữ tên vụ tại thời điểm lưu) và `event_log.actor_name` (nhật ký phải đọc được cả khi tài khoản đã đổi tên). Chấp nhận.

### 2. Khoá chính và định danh duy nhất

- 105/105 bảng có khoá chính. 101 bảng dùng UUID dạng TEXT; 4 bảng dùng khoá tổ hợp (`user_roles`, `group_permissions`, `request_log`, `daily_snapshots`); `event_log` dùng INTEGER AUTOINCREMENT (đúng cho nhật ký append-only).
- Mã nghiệp vụ (`code`) tách khỏi khoá kỹ thuật và có UNIQUE (`HTX-00001`, `MAY-AG-00001`, `CSH-AG-00001`, `LR-…`).
- UUID TEXT 36 ký tự làm chỉ mục khoá chính lớn hơn INTEGER 5–6 lần; với quy mô hiện tại (tệp lớn nhất 1,1 MB) chưa đáng kể.

### 3. Giá trị null

- 441/1.145 cột cho phép NULL. Phần lớn là trường tuỳ chọn thật (địa chỉ, ghi chú, toạ độ chưa có).
- 103 cột `*_id` cho phép NULL. Hợp lý: `plots.farmer_id` (thửa chưa gán hộ), `users.htx_id` (tài khoản không thuộc HTX), `support_tasks.assignee_id` (chưa phân công). Nên xem lại thành NOT NULL: `machines.htx_id` (mã máy sinh theo tỉnh của HTX — máy không HTX làm hỏng quy tắc mã), `support_tasks.htx_id`, `input_issues.crop_cycle_id` (cấp phát phải gắn vụ để truy xuất), `stock_lots.item_id`.
- Cột số dẫn xuất có `DEFAULT 0` thay vì NULL (`area_ha`, `member_count`) — tốt cho tổng hợp nhưng làm mất phân biệt "chưa có dữ liệu" với "bằng 0". Bảng điều hành CGH đã xử lý ở tầng ứng dụng (mức "Chưa có dữ liệu").

### 4. Tính toàn vẹn tham chiếu

- Khai báo: 56 `FOREIGN KEY`. Hiệu lực trên tệp thật: **41**. Mười lăm ràng buộc bị gỡ vì con và cha nằm ở hai tệp khác nhau:
  `crop_cycles.plot_id → plots`, `crop_cycles.season_id → seasons`, `input_issues.plot_id → plots`, `input_items/input_purchases/input_stock/input_issues.htx_id → cooperatives`, `production_protocols.htx_id → cooperatives`, `plan_step_assignments.farmer_id → farmers`, `plan_step_assignments.machine_id → machines`, `productivity_norms.machine_type_id → machine_types`, `rental_listings.machine_id → machines`, `storage_zones.facility_id → facilities`, `straw_contracts.htx_id → cooperatives`, `straw_purchase_tickets.job_id → field_jobs`.
- 186 cột `*_id` nhưng chỉ 56 được khai FOREIGN KEY → khoảng 130 quan hệ chỉ được bảo vệ bằng mã ứng dụng (ví dụ `event_log.actor_id`, `notifications.recipient_user_id`, `weighings.facility_id`, `ledger_entries.partner_id`).
- `PRAGMA foreign_keys = ON` đã bật; `PRAGMA foreign_key_check` trên 7 tệp: 0 vi phạm; `integrity_check`: ok. Dữ liệu hiện sạch nhờ dịch vụ kiểm tra tồn tại trước khi ghi, nhưng thao tác trực tiếp (script, sửa tay) không bị chặn.
- Hành vi xoá: chỉ `sessions`, `user_roles` có `ON DELETE CASCADE`; các bảng nghiệp vụ dùng xoá mềm (`deleted_at`) — đúng hướng, nhưng bảng con không kiểm `deleted_at` của cha (thửa đã xoá mềm vẫn mở vụ được nếu gọi thẳng dịch vụ).

### 5. Tính nguyên tử

- 22 cột chứa JSON/GeoJSON. Đúng vai trò: ranh giới (`plots.boundary`, `cooperatives.boundary`, `admin_units.boundary`), hình học tuyến, payload snapshot/mô phỏng/đồng bộ, `system_config.value_json`, `before_json/after_json` của nhật ký.
- Nên tách khi cần truy vấn theo trường con: `field_job_stages.evidence_json` (ảnh/toạ độ minh chứng — đã có bảng `attachments` và `plan_step_evidence` làm mẫu), `survey_questions.options` (đáp án khảo sát — thống kê theo đáp án sẽ phải parse JSON).
- Địa chỉ HTX là một chuỗi `address`, trong khi đã có `province_id/commune_id` — chấp nhận được.

### 6. Chuẩn hoá

- Đạt 3NF ở các thực thể lõi: HTX – nông hộ – thửa – vụ – nhật ký; danh mục mùa vụ, giống lúa, chủng loại máy, đơn vị hành chính, vật tư tách bảng; quyền qua `user_roles` + `group_permissions`.
- Phiên bản theo hiệu lực thay vì ghi đè: `productivity_norms` (effective_from/to), ngưỡng cảnh báo CGH (mảng phiên bản trong `system_config`), `revenue_rules`. Điểm trừ: ngưỡng CGH lưu trong JSON của `system_config` thay vì bảng riêng, nên không có ràng buộc ở tầng CSDL.
- Bảng ảnh chụp (`cgh_balance_snapshots`, `daily_snapshots`, `simulation_results`) phi chuẩn có chủ đích — báo cáo không được trôi theo dữ liệu.

### 7. Loại dữ liệu

- Phân bố: TEXT 914 · REAL 165 · INTEGER 66. Ngày giờ TEXT ISO-8601 (172 cột) là lựa chọn chuẩn của SQLite, so sánh chuỗi đúng thứ tự thời gian.
- **Tiền tệ dùng REAL (19 cột: `ledger_entries.amount`, `straw_purchase_tickets.amount`, `rental_orders.platform_fee`, các `unit_price`…)**. Số thực nhị phân không biểu diễn chính xác phần thập phân; cộng dồn công nợ nhiều dòng sẽ lệch vài đồng. Khuyến nghị: lưu INTEGER theo đồng (VNĐ không có xu) hoặc làm tròn bắt buộc ở tầng ghi.
- Boolean là INTEGER 0/1 (11 cột) — chuẩn SQLite, nên bổ sung `CHECK (x IN (0,1))`.
- 68 cột enum/trạng thái là TEXT tự do, toàn schema chỉ có 3 CHECK; các giá trị hợp lệ chỉ ghi trong ghi chú. Một lỗi chính tả ở mã ứng dụng sẽ tạo trạng thái "ma" mà CSDL không bắt.

### 8. Chỉ mục

- Schema khai 14 chỉ mục tường minh; trên tệp thật: shared 7, erp 3, field 3, cgh 1, htx/kn/gis 0. 96/105 bảng chỉ có chỉ mục tự sinh của khoá chính/UNIQUE.
- Cột lọc phổ biến nhất trong mã nguồn (đếm mẫu `WHERE … = ?`): `htx_id` (39 truy vấn, chưa chỉ mục ở `plots`, `farmers`, `machines`, `input_*`, `support_tasks`, `crop_status`, `cultivation_plans`), `user_id` (19), `facility_id` (8+), `scenario_id`, `job_id`, `plan_id`, `plan_step_id`, `recipient_user_id`, `crop_cycle_id` (`farm_logs`, `harvest_declarations`, `production_plans`). Tất cả đang quét toàn bảng.
- Với dữ liệu trình diễn (vài trăm dòng) chưa thấy chậm; ở quy mô 1 triệu ha (hàng trăm nghìn thửa, hàng triệu nhật ký) đây là điểm nghẽn đầu tiên. Ưu tiên khoảng 40 chỉ mục đơn và vài chỉ mục kép (`farm_logs(crop_cycle_id, log_date)`, `notifications(recipient_user_id, read_at)`, `plots(htx_id, deleted_at)`, `support_tasks(htx_id, status)`).

### 9. Phân vùng schema

- Tách 7 tệp theo hệ thống con, ATTACH vào một kết nối, WAL từng tệp; `TABLE_DOMAIN` là nguồn sự thật và test bắt bảng chưa xếp miền; `SHARED_FLOWS` (26 luồng) ghi rõ chủ sở hữu, đồng tác giả và người nhận của từng bảng dùng chung.
- Ưu điểm: sao lưu/khôi phục theo miền, dễ tách dịch vụ sau này, ranh giới dữ liệu rõ. Nhược điểm: mất khoá ngoại xuyên miền (mục 4) và giao dịch xuyên tệp phụ thuộc vào SQLite ATTACH (vẫn nguyên tử trong một kết nối, nhưng không còn nếu tách tiến trình).
- Còn tệp `mekonggreen.legacy-single-file.db` (9,1 MB, 99 bảng) trong `data/` — bản cũ trước khi tách, nên chuyển vào thư mục sao lưu.

### 10. Bảo mật dữ liệu

- Có: xác thực phiên (token ngẫu nhiên 24 byte, hết hạn 12 giờ, huỷ khi khoá/đặt lại), khoá sau 5 lần sai, chính sách mật khẩu, phân quyền theo vai trò + nhóm + phạm vi tỉnh/HTX, guard phạm vi HTX cho mọi route, nhật ký append-only không có API sửa/xoá, ghi cả truy cập bị từ chối và truy cập dữ liệu cá nhân (`pii_access`), che số điện thoại mặc định, cổng mã truy cập cho bản demo, không log giá trị token/mật khẩu.
- Thiếu:
  - **Băm mật khẩu**: `sha256(salt:password)` một vòng. Đây là hàm băm nhanh, không phải KDF; khi lộ tệp CSDL có thể dò hàng tỷ mật khẩu/giây. Cần scrypt/argon2 (Node có `scryptSync` sẵn), nâng cấp trong suốt khi người dùng đăng nhập.
  - Dữ liệu cá nhân (`farmers.national_id`, `phone`, `email`, `zalo_user_id`) lưu rõ; chưa có mã hoá cột hay mã hoá tệp. Tối thiểu nên mã hoá `national_id` và giới hạn cột trả về theo vai trò.
  - Không tách quyền ở tầng CSDL (SQLite không có người dùng) → toàn bộ kiểm soát nằm ở ứng dụng; tệp `data/` phải được bảo vệ bằng quyền hệ điều hành và mã hoá đĩa.
  - Cột `notifications.body` từng chứa mật khẩu tạm — đã xoá sau khi gửi (24/09), nhưng trong lúc chờ gửi vẫn ở dạng rõ.

### 11. Sao lưu và phục hồi

- Chưa có: script sao lưu, lịch chạy, luân chuyển bản cũ, kiểm tra khôi phục, tài liệu quy trình. WAL giúp chống hỏng khi mất điện nhưng không thay được sao lưu.
- Có sẵn nền để làm: `PRAGMA integrity_check` (đang ok cả 7 tệp), `VACUUM INTO` của SQLite cho phép sao lưu nóng nhất quán từng tệp; chính sách lưu trữ nhật ký/snapshot (`retention_policy`) và dọn `request_log` đã chạy định kỳ.
- Môi trường demo hiện tại reset khi khởi động lại (đĩa tạm) — báo cáo UAT đã nêu; bất kỳ kế hoạch sao lưu nào cũng cần đĩa bền hoặc đích ngoài máy chủ.

---

## Đã thực hiện (cùng ngày 24/09/2026)

Ba việc ưu tiên 1–4 ở bảng dưới đã được triển khai và có test riêng trong `tests/db-ops.test.ts` (341/341 test đạt):

| Việc | Cách làm | Tệp |
| --- | --- | --- |
| Chỉ mục (NT 8) | 80 chỉ mục `CREATE INDEX IF NOT EXISTS` trong `PERFORMANCE_INDEXES`, tạo ở cuối `migrate()` sau khi thêm cột; kiểm cột tồn tại trước nên CSDL cũ khởi động vẫn an toàn. Phủ `htx_id`, `user_id`, `facility_id`, `plan_id`, `crop_cycle_id`, `recipient_user_id` và các cặp lọc (`status`, ngày). | `src/platform/db/schema.ts` |
| Sao lưu & phục hồi (NT 11) | `backupAll()` chạy `VACUUM <miền> INTO` cho 7 tệp → `data/backups/<thời điểm>/` + `manifest.json` (SHA-256, `integrity_check`, số bảng); `verifyBackup()` đối chiếu băm và integrity; `restoreBackup()` xoá `-wal/-shm` rồi chép đè; luân chuyển giữ 14 đợt. Máy chủ tự chạy 5 phút sau khởi động và mỗi 24 giờ. CLI `npm run backup` / `npm run restore`. Nút *Sao lưu ngay* và danh sách đợt trên màn GIS → Quản trị → Tích hợp. Quy trình diễn tập trong README. | `src/platform/db/backup.ts`, `scripts/backup.ts`, `scripts/restore.ts`, `src/server.ts` |
| Băm mật khẩu (NT 10) | scrypt (N=16384, r=8, p=1, 32 byte, tiền tố `scrypt$`), so khớp hằng thời gian. Hash SHA-256 cũ vẫn đăng nhập được và được băm lại bằng scrypt với salt mới ngay lần đăng nhập thành công đầu tiên — không cần đặt lại mật khẩu hàng loạt. | `src/platform/auth/users.ts` |
| Khoá ngoại xuyên miền (NT 4) | `CROSS_DOMAIN_REFS` liệt kê 15 quan hệ; `insert()`/`update()` kiểm bản ghi cha trước khi ghi (lỗi tiếng Việt "Tham chiếu không tồn tại"); `findOrphans()` rà mồ côi, `dailyIntegrityScan()` chạy mỗi ngày ghi `event_log` khi phát hiện; kết quả hiển thị trên màn Sức khoẻ CSDL kèm `quick_check` từng tệp. | `src/platform/db/domains.ts`, `db.ts`, `integrity.ts`, `src/api-brd.ts` |

Chưa làm: mã hoá cột `national_id`, khai FOREIGN KEY cho các cột `*_id` cùng miền còn thiếu, và các mục 5–8.

## Việc đề xuất, theo thứ tự ưu tiên

| Ưu tiên | Việc | Phạm vi | Công sức |
| --- | --- | --- | --- |
| 1 | Bổ sung ~40 chỉ mục cho cột lọc/khoá ngoại nóng qua `CREATE INDEX IF NOT EXISTS` trong `migrate()` (áp cho CSDL cũ khi khởi động) | Nguyên tắc 8 | Nhỏ, không đổi dữ liệu |
| 2 | Script `scripts/backup.ts`: `VACUUM INTO` từng tệp miền → thư mục có dấu thời gian, `integrity_check` bản sao, giữ N bản gần nhất; script khôi phục; chạy định kỳ; tài liệu diễn tập | Nguyên tắc 11 | Nhỏ–vừa |
| 3 | Nâng băm mật khẩu sang scrypt, tự nâng cấp khi đăng nhập thành công; mã hoá cột `national_id` | Nguyên tắc 10 | Vừa |
| 4 | Bù 15 khoá ngoại xuyên miền bằng kiểm tra ở tầng ghi (`assertExists`) + tác vụ đêm rà bản ghi mồ côi và báo trên màn Đồng bộ; khai FOREIGN KEY cho các cột `*_id` cùng miền còn thiếu | Nguyên tắc 4 | Vừa |
| 5 | Tiền tệ về INTEGER đồng (hoặc làm tròn bắt buộc khi ghi) cho 19 cột; thêm CHECK cho boolean và các cột trạng thái quan trọng (`status`, `condition`, `approval_status`) | Nguyên tắc 7 | Vừa, cần di trú dữ liệu |
| 6 | Siết NOT NULL cho `machines.htx_id`, `support_tasks.htx_id`, `input_issues.crop_cycle_id`, `stock_lots.item_id`; giảm `member_count` khi nông hộ ngừng | Nguyên tắc 3, 1 | Nhỏ |
| 7 | Tách `field_job_stages.evidence_json` sang `attachments`; đưa ngưỡng CGH từ `system_config` sang bảng có phiên bản | Nguyên tắc 5, 6 | Vừa |
| 8 | Chuyển `mekonggreen.legacy-single-file.db` ra khỏi `data/`; ghi quy trình vận hành tệp CSDL | Nguyên tắc 9, 11 | Rất nhỏ |
