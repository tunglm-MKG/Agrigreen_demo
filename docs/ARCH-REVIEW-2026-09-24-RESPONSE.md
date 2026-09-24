# Phản hồi review kiến trúc & thiết kế dữ liệu 24/09/2026

Đối chiếu với tệp "Review KT&TKDL 260924" (review commit `12a3ee8`, kiểm lại `6d3b028`). Trạng thái tính tại commit này. Mỗi mục ghi rõ **đã xử lý / một phần / chưa** và test kiểm chứng (`tests/arch-review-2026-09-24.test.ts`, `tests/legacy-import.test.ts`, `tests/db-constraints.test.ts`, `tests/db-ops.test.ts`).

## Kết luận ngắn

Đợt này đóng toàn bộ 4 phát hiện của lượt kiểm lại (R1–R4), 6/8 phát hiện kiến trúc P1 (A01–A07 trừ A08 chỉ một phần), 3/5 mục mô hình dữ liệu (D02, D03, D05; D04 một phần) và 3 mục vận hành (O01–O03). Hai việc lớn còn lại là **mô hình thửa ổn định/phiên bản ranh giới (D01)** và **SecurityContext bắt buộc cho mọi command/query (A08)** — cả hai là thay đổi mô hình rộng, được ghi thành quyết định kiến trúc ở cuối tài liệu.

## Lượt kiểm lại 6d3b028

| Mã | Phát hiện | Trạng thái | Cách xử lý |
| --- | --- | --- | --- |
| R1 | `/inputs/purchases//ID` lách guard sở hữu | **Đã xử lý** | Router chuẩn hoá đường dẫn MỘT LẦN (`normalizePath`: gộp `//`, bỏ `/` cuối) và dùng cùng chuỗi cho routing, idempotency, nhật ký và guard; `Context` mang `path` + `routePath`; guard kiểm thêm trên mẫu route đã khớp với params đã parse (`/inputs/purchases/:id` → id). Test: 4 biến thể URL đều 403. |
| R2 | HTX xem/huỷ lệnh thuê của HTX khác | **Đã xử lý** | `RentalScope` theo CÁC BÊN trong giao dịch: bên thuê (`renter_htx_id`) và bên cho thuê (HTX sở hữu máy). `listOrders/listDisputes` lọc theo hai bên; `advanceOrder` áp ma trận chuyển trạng thái theo vai trò (bên thuê chỉ huỷ khi mới đặt lịch hoặc mở tranh chấp; bên cho thuê xác nhận/thực hiện/hoàn thành); `bookOrder/openDispute` kiểm bên. Không chặn thuê chéo HTX. |
| R3 | Duyệt xuất không lô nhưng báo đủ | **Đã xử lý** | Lô là nguồn sự thật: không có lô = không có hàng; phân bổ ghi `issue_allocations`, tổng phân bổ phải bằng lượng xuất (kiểm trong giao dịch); `shortfall` chỉ = 0 sau khi xác minh. Tồn không rõ lô (seed/nhập tay) được quy đổi MỘT LẦN thành lô tồn đầu kỳ đánh dấu `ton_dau_ky`; sau đó tổng tồn luôn dựng lại từ lô nên sửa tay `current_stock_tons` không tạo hàng ma. |
| R4 | Thửa liền kề bị coi là chồng lấn | **Đã xử lý** | `polygonsOverlap` phân biệt *touches* và *overlap*: đỉnh phải nằm HẲN trong, tâm nằm hẳn trong, cạnh phải CẮT THẬT SỰ (không tính chạm/collinear). Test: chung cạnh → không chồng; cắt nhau, chứa nhau → có. |

## Phát hiện kiến trúc

| Mã | Phát hiện | Trạng thái | Cách xử lý |
| --- | --- | --- | --- |
| A01 | ATTACH + WAL không nguyên tử xuyên tệp khi crash | **Đã xử lý** | Đổi `journal_mode = TRUNCATE`, `synchronous = FULL` cho cả 7 tệp: SQLite dùng super-journal nên COMMIT xuyên tệp nguyên tử cả khi mất điện. Ứng dụng một tiến trình, một kết nối đồng bộ nên không mất lợi ích đồng thời của WAL. Ghi đè bằng `SQLITE_JOURNAL_MODE=WAL` nếu chấp nhận đánh đổi. Đính chính câu sai trong báo cáo DB cũ. |
| A02 | Toàn vẹn tham chiếu mất, service không bù đủ | **Đã xử lý** | 41 FK cùng miền + 83 tham chiếu xuyên miền kiểm khi ghi và rà hằng ngày (đợt trước); đợt này thêm kiểm quan hệ sở hữu: khu vực phải thuộc kho (`assertZoneOfFacility` ở nhập kho/kiểm kê), lệnh thuê theo bên, cấp phát phải gắn vụ của thửa. Phiếu nhập trỏ kho/PO không tồn tại nay bị FK/tham chiếu xuyên miền chặn ngay khi tạo. |
| A03 | Tổng tồn và tồn theo lô hai nguồn sự thật | **Đã xử lý** | Bảng `stock_movements` (bất biến: nhap/xuat/dieu_chinh/ton_dau_ky) và `issue_allocations`; `facilities.current_stock_tons` là số chiếu dựng lại sau mỗi giao dịch (`syncFacilityStock`); kiểm kê điều chỉnh Ở CẤP LÔ (tăng → lô điều chỉnh; giảm → trừ lô theo rủi ro, không âm); bỏ `MAX(0, …)`. `stockConsistency()` hiển thị lệch (nếu có) trên màn Sức khoẻ CSDL và báo cáo vận động. |
| A04 | Audit không cùng transaction với dữ liệu | **Đã xử lý** | Mọi yêu cầu ghi (POST/PUT/PATCH/DELETE) chạy trong `unitOfWork`: BEGIN → guard + handler → COMMIT, lỗi ở đâu cũng ROLLBACK toàn bộ (nghiệp vụ, event_log, outbox, idempotency). `transaction()` lồng được bằng SAVEPOINT. Khoá ghi trong tiến trình tuần tự hoá yêu cầu ghi và tác vụ nền. Test: trigger làm event_log lỗi → tên HTX không đổi. Chưa làm: outbox tích hợp có aggregate version/schema version (xem "chưa làm"). |
| A05 | Snapshot/replay bỏ sót sự kiện cùng ngày | **Đã xử lý** | `daily_snapshots` thêm `captured_at`, `last_event_id`; replay lấy snapshot gần nhất ≤ ngày rồi áp sự kiện theo `id > last_event_id` tới hết ngày; `captureSnapshot` từ chối ngày ≠ hôm nay; snapshot chạy tự động mỗi ngày trong vòng quét. Snapshot vẫn không phải backup — backup thật ở `backup.ts` (đợt trước) và nay đi qua khoá ghi nên 7 `VACUUM INTO` là một điểm nhất quán xuyên tệp. |
| A06 | Không có đường nhập từ tệp hợp nhất cũ | **Đã xử lý** | `importLegacyDatabase()` chạy sau `migrate()` và TRƯỚC `seedIfEmpty()`: phát hiện `data/mekonggreen.db` cũ, chỉ nhập khi bộ tệp mới còn trống, sao lưu tệp cũ, chép từng bảng theo cột chung (đếm nhập/bỏ), `foreign_key_check`, ghi `event_log`, đổi tên tệp cũ `.imported-*`; lỗi → ROLLBACK và dừng khởi động, không seed đè. Test dùng chính tệp legacy 99 bảng: 26 HTX, 14 tài khoản. |
| A07 | Schema cài mới ≠ nâng cấp | **Đã xử lý** | `reconcileTables()` (đợt trước) làm bản nâng cấp đúng bằng bản cài mới (kể cả `UNIQUE tax_code`); đợt này thêm `schema_migrations` (phiên bản, băm nội dung lược đồ, số bảng dựng lại/bỏ qua) và `schemaStatus()` trên `/admin/db-health`. Test: `upToDate = true`, UNIQUE(tax_code) tồn tại. |
| A08 | Phạm vi tenant chưa là invariant | **Một phần** | Guard toàn cục theo route/params chuẩn hoá (R1) + policy theo bên cho sàn thuê (R2) + ràng buộc sở hữu ở kho. Chưa có `SecurityContext` bắt buộc trong chữ ký mọi command/query — xem quyết định kiến trúc. |

## Mô hình dữ liệu

| Mã | Phát hiện | Trạng thái | Cách xử lý |
| --- | --- | --- | --- |
| D01 | Thửa trộn với vụ (tạo plot mới mỗi vụ) | **Chưa** | Cần `land_parcels` + `parcel_versions` + `crop_cycles` tham chiếu phiên bản; đụng tới GIS, HTX, khuyến nông, báo cáo diện tích. Ghi thành ADR-03 với phạm vi và thứ tự chuyển đổi. |
| D02 | Ràng buộc phụ thuộc TypeScript | **Đã xử lý** (đợt trước) | 61 CHECK (boolean + enum), NOT NULL, FK, tiền tệ INTEGER; đợt này thêm CHECK cho `stock_movements.kind`, `quantity_tons <> 0`, `issue_allocations.tons > 0`. UNIQUE có thành phần nullable (`survey_responses`) vẫn còn — cần quyết định khoá nghiệp vụ với BA. |
| D03 | Finance cộng AP vào chi phí; đối soát không lọc | **Đã xử lý** | `profitAndLoss` chỉ tính EXPENSE; AP/AR là công nợ; kết quả gắn `basis = operational_estimate` và ghi chú rõ không phải sổ kế toán kép; `reconciliation` áp cùng bộ lọc cho mọi bảng con. Sổ kép/khoá kỳ/thanh toán một phần: ADR-04. |
| D04 | Thiếu lineage mô phỏng và import | **Một phần** | Mỗi kết quả mô phỏng lưu `lineage` (phiên bản thuật toán, phiên bản tham số, băm SHA-256 của toàn bộ đầu vào sống, số lượng HTX/thống kê/Hub). Import batch/row provenance: chưa. |
| D05 | Chỉ mục và không gian | **Một phần** | Thêm chỉ mục theo EXPLAIN của truy vấn thật: `stock_lots(facility_id, status, risk_score DESC, received_at)` (hết `SCAN` + `TEMP B-TREE`), `ledger_entries(facility_id, entry_date)`, `survey_responses(template_id, period, subject_kind)`. Spatial index/PostGIS: ADR-01. |

## Vận hành

| Mã | Phát hiện | Trạng thái | Cách xử lý |
| --- | --- | --- | --- |
| O01 | Hàng đợi offline dùng chung, mất khi 401/5xx | **Đã xử lý** | Khoá localStorage theo người dùng (`mg_offline_queue:<userId>`), mỗi mục mang `userId` + `opId`; thao tác của tài khoản khác không được gửi bằng phiên hiện tại; 401/403/5xx giữ mục lại và báo; chỉ lỗi nghiệp vụ 4xx mới bỏ; localStorage đầy → báo lỗi thay vì báo "đã xếp hàng". IndexedDB: chưa cần ở kích thước hàng đợi hiện tại. |
| O02 | Retry không handler, scheduler thiếu, outbox gửi trùng | **Đã xử lý** | Đăng ký retry handler cho `khuyennong_content`, `warehouse_to_lakehouse`, `cgh_operational`; dataset không handler → dead-letter có lý do (không im lặng); `processRetries` và snapshot chạy trong vòng quét 10 phút; outbox claim/lease (`dang_gui` + `claimed_at`, lease 5 phút, cờ chống chồng lượt); tác vụ nền đi qua khoá ghi. Worker riêng: ADR-02. |
| O03 | Backup chưa có hợp đồng; storage_path tuyệt đối; Docker quyền ghi | **Đã xử lý** | `attachments.storage_path` là khoá tương đối với `UPLOAD_DIR` (di trú bản ghi cũ khi khởi động, đọc được cả hai dạng); Dockerfile `chown node:node /app/data`; quy trình backup/restore/diễn tập trong `docs/DB-OPERATIONS.md`, backup máy chủ là điểm nhất quán xuyên tệp. RPO/RTO cụ thể: cần nghiệp vụ chốt. |

## Quyết định kiến trúc (ADR) — việc còn lại và lý do

- **ADR-01 — Giữ modular monolith trên SQLite một tiến trình cho giai đoạn hiện tại.** Với TRUNCATE journal, giao dịch xuyên 7 tệp nguyên tử; khoá ghi tuần tự hoá ghi; mọi ranh giới nghiệp vụ liên quan (nhập kho–lô–công nợ–vận động) nằm trong một `unitOfWork`. Điều kiện chuyển sang PostgreSQL nhiều schema + PostGIS: nhiều tiến trình/worker thật, cần RLS, hoặc phép giao hình học/spatial index cho GIS nghiệp vụ. Khi đó `TABLE_DOMAIN` đã cho sẵn ánh xạ bảng → schema.
- **ADR-02 — Worker/durable jobs.** Chưa tách tiến trình. Đã có claim/lease cho outbox và retry có handler; khi đo thấy mô phỏng/import làm tăng độ trễ request thì tách worker đọc cùng `notifications`/`sync_log` (đã có cột lease).
- **ADR-03 — Thửa ổn định.** Mô hình đích: `land_parcels` (định danh vĩnh viễn) → `parcel_versions` (ranh giới/diện tích theo thời gian) → `crop_cycles` tham chiếu `parcel_version_id`. Chuyển đổi: tạo parcel từ plot hiện có (1–1), gắn version đầu = ranh giới hiện tại, `plots` giữ làm view tương thích một thời gian; sửa `openCropCycle` để mở vụ mới trên cùng parcel; báo cáo diện tích vật lý dùng version hiệu lực, diện tích gieo trồng dùng vụ. Cần BA chốt quy tắc tách/gộp thửa trước khi làm.
- **ADR-04 — Kế toán.** `ledger_entries` là sổ nghiệp vụ; báo cáo hiện gắn nhãn "ước tính vận hành". Khi cần báo cáo kế toán: journal_entries/lines cân bằng Nợ–Có, kỳ kế toán, invoice/payment/allocation, bút toán đảo, giá vốn.
- **ADR-05 — SecurityContext.** Bước kế: đưa `{ user, htxId, provinceId, scopes }` vào chữ ký của các command có phạm vi (HTX, KN, kho) thay vì `AuditActor`; guard toàn cục giữ vai trò lớp phòng thủ thứ hai. Làm theo từng module, bắt đầu từ HTX và kho.
- **Import lineage.** `import_batch` (checksum tệp, mapping version, người duyệt) + `import_rows` (sheet/hàng, lỗi, bản ghi đích). Gắn với luồng nhập HTX/nông hộ/máy hiện có.

## Số liệu sau đợt này (đo trên tệp thật)

| Chỉ số | Trước review | Nay |
| --- | --- | --- |
| FOREIGN KEY hiệu lực | 41 | 86 |
| Bảng có CHECK | 0 | 52 (64 ràng buộc CHECK) |
| Chỉ mục khai báo riêng | 17 | 102 |
| Journal | WAL ×7 (không nguyên tử xuyên tệp) | TRUNCATE ×7 + super-journal |
| Yêu cầu ghi trong giao dịch | không | 100 % (unitOfWork) |
| Test | 335/337 | 359/359 |
