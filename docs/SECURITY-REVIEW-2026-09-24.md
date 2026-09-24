# Xử lý review bảo mật 24/09/2026 (nhánh `main`, commit `12a3ee8`)

Năm lỗi P1 đã tái hiện được trong review, cách sửa và cách kiểm chứng. Test tương ứng: `tests/security-2026-09-24.test.ts` (chạy qua HTTP thật với router của ứng dụng).

| # | Lỗi | Sửa | Kiểm chứng |
| --- | --- | --- | --- |
| 1 | Tài khoản HTX ghi/đọc được dữ liệu HTX khác (`htxId` tin từ người gọi) | Guard phạm vi `src/platform/auth/htxScope.ts` chạy trước **mọi** handler (`Router.guard`). Với tài khoản gắn HTX (Ban quản lý HTX, nông dân): `htxId` trong query/body khác HTX của mình → 403; thiếu `htxId` trên route HTX → tự điền HTX của mình (không còn "đọc tất cả"); mọi tham chiếu thực thể (thửa, vụ, lô vật tư, bước kế hoạch, phân công, nông hộ, phiếu mua, nhật ký) trong body, danh sách hàng loạt và tham số đường dẫn được truy về HTX sở hữu, khác → 403. Cán bộ khuyến nông, quản trị không bị ràng buộc. | `htx01` tạo phiếu mua cho HTX khác → 403, không ghi gì; đọc tồn/vụ/thửa HTX khác → 403; xác minh vị trí / kế hoạch / xoá thửa của HTX khác → 403; `canbo_tw` vẫn đọc được mọi HTX. |
| 2 | Nhận HTX theo MST đổi được HTX của người dùng khác (`userId` trong body) | `POST /htx-registry/claim` luôn gắn cho người đang đăng nhập; `userId` khác chỉ được chấp nhận khi có `admin.users`, ngược lại 403. | `htx01` gửi `userId` của `nongdan` → 403, HTX của `nongdan` không đổi. |
| 3 | Duyệt xuất kho thành công dù hết hàng, còn ghi công nợ cho hàng thiếu | `approveGoodsIssue` kiểm tồn **lại** trong cùng giao dịch: tồn kho (và tổng lô nếu kho quản lý theo lô) < số xuất → ném lỗi, giao dịch rollback, phiếu giữ `cho_duyet`, không bút toán. Bỏ `MAX(0, …)` che tồn âm; `shortfall` luôn 0 khi duyệt thành công. | Kho 10 t, hai phiếu 10 t: phiếu 1 duyệt → tồn 0; phiếu 2 → lỗi "Không đủ hàng", tồn vẫn 0, số bút toán không đổi. |
| 4 | Xuất số lượng âm làm tăng tồn | `createGoodsIssue` yêu cầu số hữu hạn > 0; `approveGoodsIssue` từ chối phiếu có số lượng không hợp lệ lọt vào bằng đường khác. | −5, 0, NaN, ∞ đều bị từ chối; phiếu bị sửa thành −5 trong CSDL không duyệt được, tồn không đổi. |
| 5 | Idempotency-Key phát lại phản hồi đăng nhập (token) cho yêu cầu sai mật khẩu | Router loại mọi route `/auth/*` khỏi cơ chế lưu/phát lại. | Đăng nhập đúng với khoá K → 200; đăng nhập sai với cùng K → 400, không header `Idempotency-Replayed`, không token. |

## Ghi chú triển khai

- Guard phạm vi là lớp bổ sung, không thay các kiểm tra sẵn có trong `api-brd.ts` (`scopedHtxId`) hay tầng service; hai lớp cùng tồn tại.
- Tài khoản có `htxId` nhưng vai trò không phải HTX (ví dụ cán bộ xã được gắn HTX phụ trách để tính phạm vi báo cáo) **không** bị guard ràng buộc — phạm vi của họ do `knOps.scopeOf` và `scopes.ts` quyết định.
- Danh sách khoá thực thể mà guard nhận diện nằm ở đầu `htxScope.ts` (`ENTITY_KEYS`, `PATH_ENTITY`); thêm route HTX mới có tham chiếu thực thể thì bổ sung vào đó.
