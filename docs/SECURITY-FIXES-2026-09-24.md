# Xử lý "Báo cáo đánh giá rủi ro an ninh thông tin" 24/09/2026

Đối chiếu 22 phát hiện của báo cáo (2 nghiêm trọng, 4 cao, 8 trung bình, 8 thấp). Test kiểm chứng: `tests/security-2026-09-24b.test.ts` (qua HTTP thật), `tests/htx-route-allowlist.test.ts`. Ba việc **ngoài mã nguồn** cần người vận hành làm được liệt kê ở cuối.

## Nghiêm trọng

| Mã | Phát hiện | Trạng thái | Cách xử lý |
| --- | --- | --- | --- |
| C-01 | Mật khẩu Super Admin nằm trong mã nguồn và README | **Đã xử lý** | Xoá hằng số; `ensureSuperAdmin()` chỉ dùng `SUPER_ADMIN_PASSWORD`, không có thì sinh mật khẩu tạm 16 ký tự, in log MỘT lần, `must_change_pw = 1`. CSDL có sẵn SAdmin từ bản cũ và không đặt biến môi trường → lần khởi động đầu tiên sau bản này **buộc đổi mật khẩu và huỷ phiên đang mở** (đánh dấu trong `system_config`, chỉ một lần). README, test, seed không còn chuỗi mật khẩu; test dùng biến môi trường. |
| C-02 | Tài khoản demo "123456" nạp tự động ở triển khai | **Đã xử lý** | `seedIfEmpty()` và seed demo HTX chỉ chạy khi `NODE_ENV != production` hoặc `SEED_DEMO_DATA=1` (render.yaml/fly.toml đặt `NODE_ENV=production`). Mật khẩu demo lấy từ `DEMO_ACCOUNT_PASSWORD`; không có thì mỗi tài khoản nhận mật khẩu tạm ngẫu nhiên in log một lần và phải đổi khi đăng nhập. README gỡ bảng tài khoản kèm mật khẩu. |

## Cao

| Mã | Phát hiện | Trạng thái | Cách xử lý |
| --- | --- | --- | --- |
| H-01 | IDOR tệp đính kèm | **Đã xử lý** | `assertEntityAccess(ctx, entityType, entityId, mode)` cho cả 4 route `/files`: HTX/nông dân phải sở hữu đối tượng (bảng ánh xạ 18 loại đối tượng → HTX chủ quản); loại chưa khai báo bị từ chối với mọi người (fail-closed); người không gắn HTX muốn tải lên/gỡ phải có quyền ghi tương ứng loại đối tượng. Nội dung tệp trả về `Content-Disposition: attachment` + `nosniff`. |
| H-02 | Không giới hạn kích thước thân yêu cầu | **Đã xử lý** | `readBody()` từ chối 413 theo `Content-Length` TRƯỚC khi đọc và đếm byte khi stream (huỷ kết nối khi vượt). Mặc định 1 MB; route `/files` 17 MB (`maxBodyBytes` theo route). |
| H-03 | Không có security header/CSP; Leaflet từ CDN không SRI; cookie thiếu Secure | **Đã xử lý** | Mọi phản hồi có CSP (`script-src 'self'`…), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP, HSTS khi qua HTTPS. Leaflet 1.9.4 tự host tại `src/web/vendor/leaflet/` (đã đối chiếu SRI công bố), bỏ handler `onerror` inline. Cookie `mg_session` thêm `Secure` khi `x-forwarded-proto = https`. |
| H-04 | Cổng mã truy cập vượt giới hạn bằng X-Forwarded-For giả | **Đã xử lý** | `clientIp()` chỉ tin XFF khi có `TRUSTED_PROXY_HOPS` (lấy phần tử thứ N từ phải), mặc định dùng địa chỉ socket; bộ đếm chuyển sang bảng `rate_limits` (SQLite) — bền qua restart, dùng chung giữa các máy. |

## Trung bình

| Mã | Phát hiện | Trạng thái | Cách xử lý |
| --- | --- | --- | --- |
| M-01 | Không giới hạn đăng nhập theo IP | **Đã xử lý** | 20 lần / 10 phút theo IP (`LOGIN_MAX_PER_WINDOW`), 429 + `Retry-After`, song song với khoá 15 phút theo tài khoản. Route đăng nhập chạy ngoài giao dịch yêu cầu để số lần sai vẫn được lưu khi handler ném lỗi. |
| M-02 | Mật khẩu tạm lưu 24 giờ trong bảng chống trùng | **Đã xử lý** | Route option `sensitive: true` (tạo tài khoản, đặt lại mật khẩu, đổi mật khẩu, cấu hình kênh, đăng nhập): không lưu phản hồi và không phát lại. |
| M-03 | SSRF qua URL webhook | **Đã xử lý** | `assertSafeWebhookUrl()`: chỉ https, không user:pass, chặn localhost/*.internal/*.local, phân giải DNS và chặn dải riêng/loopback/link-local/CGNAT/IPv4-mapped, allowlist `WEBHOOK_ALLOWED_HOSTS`; kiểm lúc lưu **và trước mỗi lần gửi**; fetch `redirect: 'error'`, timeout 10 giây. |
| M-04 | Token kênh gửi lưu rõ | **Đã xử lý** | Token Zalo/SMS/email mã hoá AES-256-GCM trong `system_config`; giá trị cũ được mã hoá khi khởi động (`rotateChannelSecrets`). Sao lưu: khuyến nghị đồng bộ off-host (DB-OPERATIONS); mã hoá thư mục sao lưu là việc của hạ tầng. |
| M-05 | Khoá PII cạnh dữ liệu, không xoay được | **Đã xử lý** | Production **từ chối khởi động** nếu thiếu `DATA_ENCRYPTION_KEY`; định dạng mới `enc2:<kid>:…` có định danh khoá; vòng khoá `DATA_ENCRYPTION_KEYS_PREVIOUS`; `npm run rotate-key` mã hoá lại toàn bộ; render.yaml sinh khoá bằng `generateValue`. Khoá tệp chỉ còn cho máy phát triển. |
| M-06 | Phạm vi HTX "mặc định cho qua" | **Đã xử lý** | Đảo chiều: `HTX_ROUTE_ALLOWLIST` (232 route đã rà soát) — tài khoản HTX gọi route ngoài danh sách bị 403 dù RBAC cho phép; test duyệt toàn bộ router báo đỏ khi có route mới chưa khai báo hoặc dòng rác. |
| M-07 | Lỗi kỹ thuật lọt ra client | **Đã xử lý** | `friendlyError()` chỉ trả nguyên văn lỗi nghiệp vụ (Error thuần, không `code`/`errno`, không dấu vết đường dẫn/stack/mã hệ thống); còn lại trả thông điệp chung mã SYS và ghi log máy chủ. |
| M-08 | Không CI/CD | **Đã xử lý (mã)** | `.github/workflows/ci.yml`: `npm test` (Node 24), gitleaks, CodeQL, Trivy config. Bật Secret scanning / Push protection / branch protection là thao tác trên GitHub (xem việc ngoài mã). |

## Thấp

| Mã | Phát hiện | Trạng thái | Cách xử lý |
| --- | --- | --- | --- |
| L-01 | Không xác thực loại tệp theo nội dung | **Đã xử lý** | `contentMatchesMime()`: đối chiếu magic bytes JPEG/PNG/WebP/HEIC/PDF, lệch → từ chối. Antivirus: ngoài phạm vi. |
| L-02 | .gitignore thiếu journal; tệp dữ liệu đã commit | **Đã xử lý** | Thêm `data/*.db-journal`, `data/uploads/`; `git rm --cached` 7 journal và 2 ảnh. |
| L-03 | Phiên không xoay khi đổi mật khẩu/quyền | **Đã xử lý** | `changePassword` huỷ mọi phiên khác (giữ phiên đang thao tác); `setUserRoles` huỷ toàn bộ phiên của tài khoản. |
| L-04 | Chống CSRF chỉ SameSite | **Đã xử lý** | Kiểm `Origin` (phải trùng host) và `Sec-Fetch-Site: cross-site` cho mọi yêu cầu ghi; API không còn diễn giải `x-www-form-urlencoded`. |
| L-05 | innerHTML không escape | **Đã xử lý** | `escapeHtml()` dùng chung trong app.js; field.js escape mã đội, tên đội, trạng thái, số liệu trong popup. |
| L-06 | Ảnh nền ghim theo tag | **Đã xử lý** | `FROM node:24-alpine@sha256:ebfe2f…` (digest index đa kiến trúc 24/09/2026); Trivy trong CI. |
| L-07 | SPA fallback trả 200 cho mọi đường dẫn | **Đã xử lý** | Chỉ fallback khi `Accept: text/html` và đường dẫn không có phần mở rộng; còn lại 404 thật. |
| L-08 | Hash SHA-256 cũ vô thời hạn | **Đã xử lý** | `LEGACY_HASH_DEADLINE` (mặc định 2026-12-31): sau hạn, đăng nhập bằng hash cũ vẫn được nhưng bị buộc đặt mật khẩu mới; `legacyHashCount()` để theo dõi. |

## Việc ngoài mã nguồn — người vận hành phải làm

1. **Đổi mật khẩu SAdmin trên mọi môi trường đang chạy** ngay lần đăng nhập tới (hệ thống sẽ bắt đổi); nếu chuỗi cũ được dùng lại ở dịch vụ khác, đổi ở đó trước. Đổi `DEMO_ACCESS_CODE`; rà `event_log` (`entity_type = login`) tìm đăng nhập lạ.
2. **Xoá bí mật khỏi lịch sử git** (`git filter-repo --replace-text` với chuỗi mật khẩu cũ) rồi force-push — việc này viết lại lịch sử của repo dùng chung nên chưa thực hiện tự động; coi mọi bí mật từng nằm trong lịch sử là đã lộ.
3. Trên GitHub: bật **Secret scanning + Push protection**, **branch protection** cho `main` (bắt buộc CI xanh). Trên Render/Fly: đặt `SUPER_ADMIN_PASSWORD`, `DATA_ENCRYPTION_KEY` (render.yaml đã khai `generateValue`), `TRUSTED_PROXY_HOPS=1`, `NODE_ENV=production`; chỉ bật `SEED_DEMO_DATA=1` khi cố ý.
4. Rà soát tuân thủ Nghị định 13/2023/NĐ-CP (hồ sơ đánh giá tác động, chính sách lưu trữ, quy trình xoá theo yêu cầu) — ngoài phạm vi mã.
