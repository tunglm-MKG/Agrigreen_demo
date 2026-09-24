# Cơ cấu phân quyền — điều chỉnh 24/09/2026

Yêu cầu: mỗi hệ thống con (Khuyến nông, Hợp tác xã, Cơ giới hoá, GIS, ERP, Hiện trường) có **quản trị hệ thống riêng**, toàn quyền quản trị trong hệ thống đó nhưng không xem, không can thiệp hệ thống khác; **SAdmin** có một cổng Quản trị hệ thống tách riêng và phải **"vào" hệ thống** nào muốn xem tính năng của hệ thống đó.

## 1. Ba tầng quản trị

| Tầng | Nhóm | Thấy gì | Làm gì | Không làm gì |
| --- | --- | --- | --- | --- |
| Quản trị nền tảng | `platform_admin` (SAdmin) | Cổng **Quản trị hệ thống** (`/sysadmin/`): tài khoản toàn hệ thống, nhóm & ma trận quyền, phân cấp quản trị, sức khoẻ CSDL & sao lưu, miền dữ liệu, kênh gửi, nhật ký | Mọi thứ quản trị; nghiệp vụ của một hệ thống **sau khi vào hệ thống đó** | Không xem nghiệp vụ khi chưa vào hệ thống; mỗi phiên chỉ ở trong một hệ thống |
| Quản trị hệ thống con | `kn_admin`, `htx_admin`, `cgh_admin`, `gis_admin`, `erp_admin`, `field_admin` | Đúng một cổng của hệ thống mình; màn *Tài khoản & phân quyền*, *Phân cấp quản trị* trong cổng đó | Toàn bộ nghiệp vụ trong miền của hệ thống (đọc/ghi/duyệt); tạo tài khoản, gán nhóm **thuộc hệ thống mình** (kể cả nhóm quản trị hệ thống mình), khoá, đặt lại mật khẩu; uỷ quyền phạm vi tỉnh/HTX trong hệ thống | Không vào cổng khác; không đọc/ghi dữ liệu hệ thống khác (cán bộ KN đọc HTX được, quản trị KN thì không); không sửa ma trận nhóm–quyền; không cấu hình nền tảng; không thấy tài khoản hệ thống khác và SAdmin |
| Quản trị theo phạm vi (đã có) | Uỷ quyền `admin_scopes` cấp tỉnh / HTX | Tài khoản của hệ thống mình trong tỉnh/HTX đó | Tạo/gán nhóm nghiệp vụ trong phạm vi (SA-08…SA-12) | Không gán nhóm quản trị hệ thống; không uỷ quyền tiếp |

Quyền của nhóm quản trị hệ thống con được **tính từ mã** (`systemAdminPermissions()` trong `rbac.ts`): cổng của mình + mọi quyền trong miền nghiệp vụ của hệ thống (`khuyennong.*`, `htx.*`, `cgh.*` + `rental.*`, `gis.*`, ERP = `simulation/warehouse/procurement/sales/tms/finance/mrv.*`, `field.*`) + dữ liệu dùng chung chỉ đọc (`mdm.read`, `gis.read`, `reporting.read`; `mdm.write` nếu nhóm nghiệp vụ của hệ thống có) + `admin.users`, `admin.delegate`. Test `tests/system-admins.test.ts` khẳng định không nhóm quản trị nào có quyền miền của hệ thống khác.

Nhóm quản trị hệ thống tạo ra **phạm vi cấp hệ thống ngầm** (`role:<nhóm>` trong `scopesOf`), nên mọi luật SA-08…SA-12 áp dụng nguyên vẹn; phạm vi này chỉ thu hồi bằng cách gỡ nhóm.

## 2. SAdmin phải "vào" hệ thống

- Phiên có cột `sessions.active_system`. `POST /auth/enter-system {system}` đặt hệ thống đang làm việc (chỉ `platform_admin`), `POST /auth/leave-system` rời; cả hai ghi `event_log` (`admin_session`, `enter_system` / `leave_system`).
- Guard `enforceSuperAdminSystemContext` (sau `enforceHtxScope`): với người có quyền `*`, route được phân loại theo quyền gác route (`systemOfPermission`) rồi theo tiền tố đường dẫn:
  - `admin` (`/admin`, `/audit`, `/sync`, `/rbac`, `/auth`, `/notifications`, `/files`) → luôn mở;
  - hệ thống con → chỉ mở khi `active_system` đúng hệ thống đó, ngược lại **403 `enter_system_required`**;
  - `shared` (`mdm.*`, `reporting.*`) → mở khi đã ở trong bất kỳ hệ thống nào.
- Giao diện: SAdmin đăng nhập vào màn chọn cổng với **Quản trị hệ thống** đứng đầu; các cổng nghiệp vụ ghi "Cần vào hệ thống trước khi xem". Mở một cổng nghiệp vụ mà phiên chưa ở trong hệ thống đó → màn xác nhận *Vào hệ thống X?*; vào xong, thanh trên cùng hiện dải "SAdmin trong X · Rời". Trang *Các hệ thống & vào hệ thống* trong cổng Quản trị liệt kê 6 hệ thống, số tài khoản, ai là quản trị hệ thống, nút vào/rời.
- Người dùng khác không bị guard này đụng tới; họ không dùng được `enter-system` (403).

## 3. Cổng Quản trị hệ thống (`/sysadmin/`)

| Nhóm | Trang |
| --- | --- |
| Hệ thống con | Các hệ thống & vào hệ thống (`sys-systems`) |
| Tài khoản & phân quyền | Tài khoản toàn hệ thống (`sys-users`), Phân cấp quản trị (`sys-scopes`), Nhóm & ma trận phân quyền (`sys-groups`) |
| Nền tảng | Sức khoẻ CSDL & sao lưu (`sys-health`, chuyển từ GIS → Quản trị → Tích hợp), Miền dữ liệu & đồng bộ (`sys-data`), Thông báo & kênh gửi (`sys-notify`), Nhật ký & đồng bộ (`admin`) |

Các cổng nghiệp vụ chỉ còn nhóm *Quản trị hệ thống* gồm hai trang `sys-users` và `sys-scopes` — đủ cho quản trị hệ thống con làm việc trong cổng của mình. Quyền vào cổng này là `portal.sysadmin`, không nhóm nào ngoài `platform_admin` được cấp (kể cả qua ghi đè nhóm — bị `assertRolesAllowed`/ma trận từ chối vì không nằm trong danh mục cấp được).

## 4. Tài khoản trình diễn

Seed (chỉ ngoài production, hoặc `SEED_DEMO_DATA=1`) tạo `qtri_kn`, `qtri_htx`, `qtri_cgh`, `qtri_gis`, `qtri_erp`, `qtri_field` với nhóm quản trị tương ứng; `qtri_kn_ag` vẫn là quản trị Khuyến nông **cấp tỉnh** (uỷ quyền phạm vi). CSDL có từ trước sẽ được bổ sung các tài khoản này khi khởi động (`ensureSystemAdminDemoAccounts`) với mật khẩu theo `DEMO_ACCOUNT_PASSWORD` hoặc mật khẩu tạm in log.

## 5. Kiểm chứng

`tests/system-admins.test.ts`: quyền cách ly của 6 nhóm quản trị; quản trị KN chỉ thấy/tạo/sửa tài khoản KN, không gán nhóm ERP, không gọi được API ERP/HTX, không sửa nhóm–quyền, không đụng cấu hình; phạm vi từ nhóm không gỡ được như uỷ quyền; SAdmin bị chặn tới khi vào đúng hệ thống, chuyển hệ thống thay thế chứ không cộng dồn, rời thì đóng hết, có nhật ký; phân loại route. `tests/portals.test.ts` (7 cổng), `tests/htx-route-allowlist.test.ts`, `tests/scopes.test.ts`, `tests/sysadmin.test.ts` giữ nguyên hành vi. 382/382 test đạt.
