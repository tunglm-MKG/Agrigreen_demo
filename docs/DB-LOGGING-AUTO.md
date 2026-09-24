# Tự động ghi nhật ký cấp cơ sở dữ liệu (DB-Level Audit Logging)

## Tổng quan

Hệ thống sử dụng hai tầng nhật ký bổ sung cho nhau:

| Tầng | Cơ chế | Actor context | Tệp |
|------|--------|---------------|------|
| **Ứng dụng** | `logEvent()` gọi thủ công từ service | Đầy đủ (id, tên, IP, request_id) | `src/platform/audit/audit.ts` |
| **Cơ sở dữ liệu** | Trigger AFTER INSERT / AFTER UPDATE | Không có (ghi `actor_name = 'system'`) | `src/platform/db/triggers.ts` |

Bản ghi trigger có `source = 'system'` và `note = 'db_trigger'` để phân biệt với bản ghi ứng dụng.

## Tại sao cần trigger?

1. **Lưới an toàn**: nếu một đường mã quên gọi `logEvent()`, trigger vẫn bắt thay đổi
2. **Phát hiện bỏ sót**: truy vấn `SELECT * FROM event_log WHERE note = 'db_trigger'` cho thấy bảng nào đang thiếu `logEvent()` ở tầng ứng dụng
3. **Không can thiệp code nghiệp vụ**: trigger hoạt động trong suốt, không thay đổi flow hiện tại

## Nguyên tắc hoạt động

### AFTER INSERT
- Ghi `action = 'create'`
- `after_json` = json_object(...) của tất cả cột trong bản ghi NEW
- `module` suy từ miền dữ liệu (domains.ts → TABLE_DOMAIN)

### AFTER UPDATE
- Ghi `action = 'update'`
- `before_json` = json_object(...) của OLD, `after_json` = json_object(...) của NEW
- **Chỉ ghi khi có thay đổi thật sự**: bỏ qua khi chỉ `updated_at` thay đổi (tránh noise)

### Bảng loại trừ
Trigger KHÔNG được tạo cho các bảng kỹ thuật/nhật ký:
- `event_log` (tránh đệ quy vô hạn)
- `sessions`, `request_log`, `rate_limits`, `sync_log`, `schema_migrations`
- `distance_cache`, `gps_logs`, `system_config`, `daily_snapshots`
- `retention_policy`, `shared_sync_cursor`, `password_resets`

## Auto-logging wrappers (db.ts)

Ngoài trigger, `db.ts` cung cấp ba wrapper tiện lợi:

```ts
import { insertWithLog, updateWithLog, upsertWithLog } from './platform/db/db.ts';

// Chèn + tự ghi nhật ký (đầy đủ actor context)
insertWithLog('straw_contracts', data, { module: 'erp', actor: ctx.actor });

// Cập nhật + tự ghi nhật ký (đọc before tự động)
updateWithLog('farmers', farmerId, changes, { module: 'htx', actor: ctx.actor });

// Upsert + tự ghi nhật ký (tự nhận create/update)
upsertWithLog('machines', machineData, { module: 'cgh', actor: ctx.actor });
```

Các wrapper này:
- Gọi `logEvent()` tự động ngay sau mutation
- Đọc bản ghi cũ (before) trước khi update
- Mang đầy đủ thông tin actor: id, tên, IP, request_id (qua `currentRequest()`)

## Quản lý trigger

- Trigger được tạo lại mỗi lần chạy `migrate()` (DROP IF EXISTS + CREATE)
- Cột mới thêm vào bảng sẽ tự động xuất hiện trong json_object sau lần migrate kế tiếp
- Để tắt trigger cho một bảng: thêm tên bảng vào `EXCLUDED_TABLES` trong `triggers.ts`
- Để xem trigger đã tạo: `SELECT name FROM sqlite_master WHERE type = 'trigger'`

## Truy vấn hữu ích

```sql
-- Bản ghi chỉ có từ trigger (service quên gọi logEvent)
SELECT * FROM event_log WHERE note = 'db_trigger' ORDER BY occurred_at DESC;

-- Đếm trigger-only theo bảng (ưu tiên thêm logEvent cho bảng nhiều nhất)
SELECT entity_type, COUNT(*) AS cnt
FROM event_log WHERE note = 'db_trigger'
GROUP BY entity_type ORDER BY cnt DESC;

-- So sánh trigger vs. app logs cho cùng entity
SELECT entity_type, entity_id, action,
       SUM(CASE WHEN note = 'db_trigger' THEN 1 ELSE 0 END) AS trigger_logs,
       SUM(CASE WHEN note IS NULL OR note <> 'db_trigger' THEN 1 ELSE 0 END) AS app_logs
FROM event_log
GROUP BY entity_type, entity_id, action
HAVING trigger_logs > 0 AND app_logs = 0;
```
