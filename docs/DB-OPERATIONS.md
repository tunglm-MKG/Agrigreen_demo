# Quy trình vận hành tệp cơ sở dữ liệu — Mekong Green

Cập nhật 24/09/2026 (sau rà soát 11 nguyên tắc). Áp dụng cho mọi môi trường chạy `npm start`.

## 1. Tệp và thư mục

| Đường dẫn | Nội dung | Ghi chú |
| --- | --- | --- |
| `data/mekonggreen.shared.db` | Dữ liệu dùng chung: tài khoản, HTX, nông hộ, thửa, máy, đơn vị hành chính, nhật ký | Tệp `main` của kết nối |
| `data/mekonggreen.{kn,htx,cgh,gis,erp,field}.db` | Sáu hệ thống con | ATTACH vào cùng kết nối khi khởi động |
| `data/*.db-journal` (hoặc `-wal/-shm` nếu đặt `SQLITE_JOURNAL_MODE=WAL`) | Nhật ký giao dịch SQLite | KHÔNG sao chép rời; sao lưu phải dùng `VACUUM INTO` hoặc script |
| `data/backups/<thời điểm>/` | Đợt sao lưu: 7 tệp + `manifest.json` | Tự chạy 5 phút sau khởi động và mỗi 24 giờ |
| `data/.keys/data-encryption.key` | Khoá AES-256 mã hoá cột CCCD | **Sao lưu riêng**, không nằm trong `data/backups/`; mất khoá là mất số CCCD |
| `data/uploads/` | Ảnh bằng chứng (tham chiếu từ bảng `attachments`) | Sao lưu bằng công cụ tệp thông thường |
| `archive/mekonggreen.legacy-single-file.db` | Bản một tệp trước khi tách miền (09/2026) | Chỉ để tra cứu; không được nạp |

Biến môi trường: `BACKUP_DIR`, `BACKUP_KEEP` (mặc định 14), `BACKUP_INTERVAL_HOURS` (0 = tắt), `DATA_ENCRYPTION_KEY` (64 hex, thay cho tệp khoá), `UPLOAD_DIR` (thư mục ảnh; `attachments.storage_path` là khoá tương đối với thư mục này), `SQLITE_JOURNAL_MODE` (mặc định TRUNCATE), `SUPER_ADMIN_PASSWORD` (mật khẩu SAdmin ban đầu; không đặt → sinh tạm, in log một lần, bắt đổi), `DEMO_ACCOUNT_PASSWORD` / `SEED_DEMO_DATA` (tài khoản trình diễn — không nạp ở production), `DATA_ENCRYPTION_KEY_ID` + `DATA_ENCRYPTION_KEYS_PREVIOUS` (xoay khoá: `npm run rotate-key`), `TRUSTED_PROXY_HOPS` (số lớp proxy để đọc IP từ X-Forwarded-For; Render/Fly = 1), `WEBHOOK_ALLOWED_HOSTS` (allowlist máy chủ webhook SMS/email), `LOGIN_MAX_PER_WINDOW` (mặc định 20/10 phút), `LEGACY_HASH_DEADLINE` (mặc định 2026-12-31), `SCRYPT_N`.

**Production bắt buộc có `DATA_ENCRYPTION_KEY`** (khởi động từ chối nếu thiếu); khoá tệp `.keys/` chỉ dành cho máy phát triển.

Nâng cấp từ bản một tệp (`data/mekonggreen.db`, trước 09/2026): chỉ cần đặt tệp cũ đúng chỗ và khởi động — `importLegacyDatabase()` sao lưu, nhập vào 7 tệp mới, đổi tên tệp cũ thành `.imported-*` và ghi `event_log`; nếu bộ tệp mới đã có dữ liệu thì KHÔNG nhập (cảnh báo trong log).

## 2. Khởi động: điều gì xảy ra với lược đồ

`migrate()` chạy mỗi lần khởi động, theo thứ tự và idempotent:

1. `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` toàn bộ lược đồ.
2. Thêm cột mới bằng `ALTER TABLE ADD COLUMN` (`COLUMN_ADDITIONS`).
3. Di trú dữ liệu một lần: `evidence_json` → bảng `field_stage_evidence`; JSON ngưỡng CGH → bảng `cgh_coverage_thresholds`.
4. **Dựng lại bảng** có định nghĩa khác lược đồ (`reconcileTables`): tạo bảng mới → chép cột chung → xoá bảng cũ → đổi tên (quy trình 12 bước của SQLite, tắt khoá ngoại trong lúc chạy). Nhờ vậy FOREIGN KEY, CHECK, NOT NULL, kiểu INTEGER mới áp được lên tệp cũ. Bảng nào dữ liệu cũ vi phạm ràng buộc mới sẽ bị **bỏ qua kèm cảnh báo** `[db] KHÔNG dựng lại được bảng …` — phải sửa dữ liệu rồi khởi động lại.
5. Tạo lại chỉ mục (bị mất khi dựng lại) và 80 chỉ mục hiệu năng.
6. Làm tròn cột tiền tệ về đồng; mã hoá số CCCD còn lưu rõ; chuyển `attachments.storage_path` tuyệt đối thành khoá tương đối; ghi phiên bản + băm lược đồ vào `schema_migrations`.
7. Sau seed: kho có tổng tồn nhưng chưa có lô → tạo lô tồn đầu kỳ (`ton_dau_ky`) để tổng tồn luôn dựng lại được từ lô.

Trước khi nâng phiên bản có thay đổi lược đồ: **sao lưu** (`npm run backup`), khởi động thử trên bản sao (`npm run restore -- <đợt> --target data/thu-nghiem`, rồi trỏ thư mục làm việc vào đó) và đọc log khởi động.

## 3. Sao lưu

```bash
npm run backup                      # data/backups/<thời điểm>/, giữ 14 đợt
npm run backup -- --dir D:/bk --keep 30
npm run backup -- --list
npm run backup -- --verify data/backups/2026-09-24T02-00-00
```

Mỗi đợt có `manifest.json`: băm SHA-256, `integrity_check`, số bảng của từng tệp. Sao lưu do máy chủ chạy (lịch hoặc nút *Sao lưu ngay*) đi qua khoá ghi: 7 lệnh `VACUUM INTO` chạy liền nhau trên cùng kết nối, không giao dịch nào chen giữa → điểm sao lưu **nhất quán xuyên tệp**. `npm run backup` từ tiến trình khác chỉ nhất quán TỪNG tệp — dùng khi máy chủ đã dừng hoặc chấp nhận sai lệch nhỏ giữa các miền. `--verify` đối chiếu lại băm và integrity; đợt hỏng bị từ chối khi khôi phục. Nên đồng bộ `data/backups/` và `data/.keys/` sang máy khác (rsync, đĩa mạng) — sao lưu cùng đĩa với máy chủ không chống được hỏng đĩa.

Trên giao diện: GIS → Quản trị → Tích hợp → *Sức khoẻ cơ sở dữ liệu* (Sao lưu ngay, 10 đợt gần nhất, `quick_check`, bản ghi mồ côi).

## 4. Khôi phục

1. Dừng máy chủ (không còn tiến trình giữ tệp `.db`).
2. `npm run backup -- --verify <đợt>` phải báo hợp lệ.
3. `npm run restore -- <đợt>` (ghi đè `data/mekonggreen.*.db`, xoá `-wal/-shm` cũ), hoặc `--target <thư mục>/mekonggreen.db` để khôi phục sang chỗ khác.
4. Đảm bảo `data/.keys/data-encryption.key` (hoặc `DATA_ENCRYPTION_KEY`) đúng với thời điểm sao lưu — nếu không, cột CCCD hiện `[không giải mã được]`.
5. Khởi động lại; kiểm tra log `migrate()` và màn Sức khoẻ CSDL.

Diễn tập mỗi quý: khôi phục sang thư mục thử nghiệm, đăng nhập, mở vài màn hình HTX/ERP, ghi kết quả vào nhật ký vận hành.

## 5. Toàn vẹn dữ liệu

- Khoá ngoại cùng miền: SQLite kiểm (`PRAGMA foreign_keys = ON`).
- Khoá ngoại xuyên miền (≈80 quan hệ trong `CROSS_DOMAIN_REFS`): kiểm ở `db.insert/update/upsert` và rà hằng ngày (`dailyIntegrityScan`, ghi `event_log` loại `db_integrity` khi có mồ côi).
- Kiểm tay: `PRAGMA <miền>.integrity_check;` và `PRAGMA foreign_key_check;` trên kết nối đã ATTACH; hoặc gọi `GET /api/admin/db-health`.
- Không sửa dữ liệu bằng công cụ SQLite ngoài khi máy chủ đang chạy; nếu buộc phải, sao lưu trước và chạy `PRAGMA foreign_key_check` sau.

## 6. Dung lượng và dọn dẹp

- `retention_policy` dọn `event_log`/snapshot theo cấu hình ở GIS → Quản trị → Lưu trữ; `request_log` (chống ghi trùng) tự xoá sau 24 giờ.
- Mặc định `journal_mode = TRUNCATE`, `synchronous = FULL`: COMMIT xuyên 7 tệp là nguyên tử cả khi mất điện (SQLite dùng super-journal; WAL không có bảo đảm này). Chỉ đặt `SQLITE_JOURNAL_MODE=WAL` khi chấp nhận rủi ro đó để lấy tốc độ ghi; khi ấy `-wal` lớn bất thường → `PRAGMA wal_checkpoint(TRUNCATE)` lúc máy chủ nghỉ.
- `VACUUM` toàn tệp chỉ khi đã xoá lượng lớn dữ liệu; sao lưu định kỳ dùng `VACUUM INTO` nên bản sao luôn gọn.

## 7. Bảo mật tệp

- Thư mục `data/` chỉ cho tài khoản chạy dịch vụ đọc/ghi; bật mã hoá đĩa trên máy chủ.
- Mật khẩu người dùng băm scrypt; CCCD mã hoá AES-256-GCM; số điện thoại che ở API trừ khi có quyền và `reveal=1` (được ghi nhật ký `pii_access`).
- Không sao chép `data/` sang máy cá nhân để "xem thử": dùng đợt sao lưu đã xoá cột nhạy cảm hoặc môi trường thử nghiệm.
