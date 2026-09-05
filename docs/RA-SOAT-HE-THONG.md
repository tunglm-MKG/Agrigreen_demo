# Rà soát toàn hệ thống — đề xuất bổ sung và cải tiến

*Lập ngày 05/09/2026, sau khi bổ sung nhóm chức năng Quản lý hiện trường. Phạm vi: toàn bộ
AgriGreen Platform (KN, HTX, CGH, GIS, Hiện trường) và ERP nội bộ.*

Hệ thống hiện có **6 cổng, ~180 endpoint, 192 test**, phủ từ hoạch định đầu tư Hub đến
ghi nhật ký canh tác của nông dân. Phần rà soát này không liệt kê lại những gì đã có; nó
đi tìm **mắt xích còn hở** — chỗ dữ liệu phải chép tay từ phân hệ này sang phân hệ kia,
chỗ hệ thống biết mà không báo, và chỗ vận hành thật sẽ vấp trong tháng đầu triển khai.

## Tóm tắt: 5 việc đáng làm trước

| # | Đề xuất | Vì sao trước | Nỗ lực |
| --- | --- | --- | --- |
| 1 | **Ghe cập Hub tự đối chiếu với lượt xuống ghe** (hiện trường → cân → kho) | Đây là mắt hở lớn nhất còn lại của chuỗi rơm: 88 t ghi ở ruộng, cân được bao nhiêu ở Hub, hao hụt thuộc đội hay ghe — hôm nay không ai trả lời được từ dữ liệu | Vừa |
| 2 | **Tải ảnh bằng chứng thật** (kèm GPS + thời gian trong ảnh) | VietGAP, MRV và tranh chấp thuê máy đều cần ảnh; hiện chỉ có ô "dán link Zalo" — bằng chứng ở ngoài hệ thống thì không phải bằng chứng | Vừa |
| 3 | **Kênh thông báo chủ động** (Zalo OA / SMS / web push) | Hệ thống đã *biết* rơm quá hạn, thuốc chưa hết cách ly, kho quá ẩm — nhưng chỉ nói khi có người mở đúng màn hình. Cảnh báo không đến tay người cần thì bằng không | Vừa |
| 4 | **Hàng đợi offline + chống ghi trùng** cho App HTX và Cổng Hiện trường | Ruộng ĐBSCL mất sóng là chuyện thường; bấm lại khi mạng chập chờn hiện tạo hai lượt ghe, hai nhật ký | Vừa |
| 5 | **Đối chiếu giả định – thực tế** đưa số thật (tấn/đội/ngày, chi phí chuyến, hao hụt) về Finance duyệt thành tham số mới | Mô phỏng đầu tư đang chạy trên 49 giả định; hệ thống nay đã có số thật cho ít nhất 8 trong số đó nhưng chưa dùng | Nhỏ |

---

## A. Dữ liệu đi vào hệ thống — điểm vấp khi vận hành thật

### A1. Bằng chứng hình ảnh (P1)
Ba nơi đòi bằng chứng — bước VietGAP (`plan_step_evidence`), công đoạn thu gom
(`field_job_stages.evidence_json`), tranh chấp thuê máy — đều chỉ nhận **chuỗi ký tự**.
Không có endpoint nhận tệp; ảnh nằm ở Zalo hoặc Drive của cá nhân, mất theo người.

*Đề xuất.* Một bảng `attachments` dùng chung (entity_type, entity_id, sha256, mime, kích
cỡ, lat/lng/thời gian đọc từ EXIF, người tải) và một endpoint `POST /files` nhận
multipart, lưu vào `data/uploads/` theo băm nội dung (trùng ảnh không lưu hai lần). Ảnh
có EXIF lệch quá 300 m so với thửa hoặc lệch quá 24 h so với thời điểm ghi thì gắn cờ,
không chặn — tái dùng `verifyLocation` của App HTX. Không cần thư viện ngoài: Node đủ để
đọc EXIF cơ bản.

### A2. Offline và chống ghi trùng (P1)
`syncOfflineLogs` đã có ở phía máy chủ nhưng giao diện **không có hàng đợi**: mất mạng
là mất thao tác. Ngược lại, mạng chập chờn khiến người dùng bấm hai lần → hai bản ghi
(POST không có khoá chống lặp).

*Đề xuất.* (a) Header `Idempotency-Key` cho mọi route ghi, lưu 24 h trong bảng
`request_log`; gửi lại cùng khoá trả về kết quả cũ. (b) Service worker + IndexedDB giữ
hàng đợi thao tác cho hai màn hình đứng ruộng: *Nhật ký canh tác* và *Ghi nhận tại ruộng*;
đồng bộ khi có mạng, hiển thị "3 thao tác chờ gửi" để người dùng yên tâm.

### A3. Kênh thông báo chủ động (P1)
Hệ thống tính ra nhiều cảnh báo tốt — FM-02 rơm quá hạn, BR-06 vi phạm cách ly thuốc,
kho quá ẩm, đề xuất thiếu máy — nhưng **không có kênh nào đẩy ra ngoài** (không bảng
`notifications`, không outbox, không adapter). Người phải mở đúng trang mới thấy.

*Đề xuất.* Bảng `notifications` (người nhận, kênh, nội dung, trạng thái gửi) + tiến trình
outbox chạy trong `server.ts` + hai adapter đầu: Zalo OA (kênh phổ biến nhất với nông dân
ĐBSCL) và web push cho quản lý. Mọi cảnh báo hiện có chỉ cần gọi thêm `notify()`.

### A4. Thời tiết nối vào kế hoạch thu gom (P2)
Bảng `weather_observations` tồn tại nhưng không phân hệ nào đọc. Mưa là lý do số một
khiến rơm không cuộn được và ẩm mục — đúng rủi ro FM-02 đang theo dõi.

*Đề xuất.* Nhập dự báo 7 ngày theo toạ độ (Open-Meteo, không cần khoá) mỗi 6 giờ;
`autoAssign` tránh xếp cuộn vào ngày mưa > 10 mm và cảnh báo việc đã xếp trúng ngày mưa.
Đây là cải tiến rẻ vì hàm phân công đã có chỗ cắm (vòng lặp chọn ngày).

### A5. Kiểm tra dữ liệu đầu vào tập trung (P2)
Nhiều route dùng `body(ctx) as never` và để service tự kiểm. Lỗi chỉ hiện dưới dạng thông
báo tiếng Việt khi chạm tới — tốt cho người dùng, nhưng thiếu một lớp kiểm kiểu/định dạng
thống nhất (ngày, số, mã).

*Đề xuất.* Một bộ kiểm nhẹ tự viết (không dependency): `schema({ harvestDate: 'date',
tons: 'number>0' })` cho các route ghi; trả 400 kèm tên trường. Chừng 150 dòng.

---

## B. Chuỗi rơm khép kín — các mắt xích còn hở

### B1. Ghe cập Hub → đối chiếu tự động (P1)
Mỗi lượt xuống ghe nay sinh một chuyến TMS (FM-05). Nhưng khi ghe cập Hub, cân
(`weighings`) và phiếu nhập (`goods_receipts`) **không tự tham chiếu về chuyến và về lượt
ghe** — nhân viên kho phải tự tìm. Hậu quả: không tính được hao hụt theo đội / theo ghe,
không phát hiện ghe khai 88 t cân 71 t.

*Đề xuất.* `completeTrip` với `ref_type = field_job` tự tạo `inbound_notices` mang
`trip_id`; phiếu cân bắt buộc chọn chuyến đang chờ; báo cáo *đối soát ba chiều*
hiện trường – chuyến – cân theo đội và theo số hiệu ghe. Chênh lệch > 5 % gắn cờ.

### B2. Lô rơm có định danh từ ruộng tới khách hàng (P1)
`stock_lots` ở kho không biết lô đến từ thửa nào; `field_jobs` không biết rơm của mình
thành lô nào. Với MRV và tín chỉ carbon, **chain-of-custody** là yêu cầu cứng của tổ chức
kiểm định.

*Đề xuất.* Sinh `lot_code` tại lượt xuống ghe (một ghe = một lô), truyền qua chuyến,
kho nhận theo lô. Hồ sơ truy xuất (`traceabilityRecord` của App HTX) nối tiếp được tới lô
kho và đơn bán — một mã, một chuỗi.

### B3. Phiếu mua rơm và công nợ HTX (P2)
Finance có AR/AP nhưng **không có chứng từ mua rơm** sinh từ số liệu hiện trường. Trả tiền
cho HTX theo tấn cuộn hay tấn cân ở Hub, giá nào, đã trả chưa — hiện nằm ngoài hệ thống.

*Đề xuất.* `straw_purchase_tickets` sinh khi việc hoàn thành (tấn theo cân Hub nếu có, tạm
theo tấn xuống ghe nếu chưa), đơn giá theo hợp đồng HTX (mục D1), đẩy vào AP. HTX xem
được công nợ trên Cổng HTX.

### B4. Khoán đội và chi phí thu gom thực (P2)
Báo cáo năng suất đã có tấn/đội. Chưa có **đơn giá khoán** (đ/tấn cuộn, đ/tấn xuống ghe)
→ không ra chi phí thu gom thực tế/tấn — con số mà tham số mô phỏng đang giả định.

*Đề xuất.* Bảng đơn giá khoán theo đội và thời kỳ; báo cáo chi phí/tấn theo đội, theo
HTX; đưa vào B5.

### B5. Đối chiếu giả định – thực tế (P1, nỗ lực nhỏ)
Mô phỏng đầu tư Hub chạy trên 49 tham số giả định có quy trình phê duyệt tốt. Hệ thống
nay đã có **số thật** cho ít nhất tám tham số: công suất máy cuộn (#31), khối lượng rơm
mỗi ghe (#51), tải trọng xe (#33), cước vận tải đường thuỷ/bộ (chi phí thực của chuyến
TMS), tồn kho đỉnh (kho), hao hụt, tỷ lệ rơm/lúa (#17), chi phí thu gom. Nhưng không có
màn hình nào đặt hai cột cạnh nhau.

*Đề xuất.* Trang "Giả định – thực tế" trong Tham số mô phỏng: mỗi tham số có cột *giả
định đang duyệt*, *thực tế 90 ngày*, *độ lệch*, nút "Đề xuất giá trị mới" đi vào đúng luồng
phê duyệt đã có. Đây là cách duy nhất để mô phỏng tự tốt lên theo thời gian.

### B6. Dự báo cầu năng lực thu gom 4 tuần (P2)
Phân công tự động nhìn 14 ngày, nhưng quyết định *điều đội sang tỉnh khác* hay *thuê thêm
máy* cần nhìn 4–6 tuần. Dữ liệu đã có: lịch gặt cấp xã từ Excel (`commune_crop_seasons`),
khảo sát khuyến nông, trạng thái mùa vụ HTX.

*Đề xuất.* Biểu đồ tuần × vùng: rơm dự kiến vs. tổng năng lực đội đang đóng gần đó;
tô đỏ tuần thiếu. Một truy vấn gộp, một màn hình.

---

## C. Nền tảng, chất lượng dữ liệu, an toàn

### C1. Sao lưu và giữ dữ liệu (P1 khi lên production)
Không có lệnh sao lưu; gói Render miễn phí mất tệp SQLite mỗi lần khởi động lại. Với bản
trình diễn thì `seedIfEmpty` cứu được; với dữ liệu thật thì không.

*Đề xuất.* `npm run backup` (WAL checkpoint + sao chép + nén, giữ 30 bản), chạy theo lịch
trong `server.ts`; bật đĩa bền trên Render; tài liệu khôi phục.

### C2. Bảo mật tài khoản (P1 khi lên production)
Đã tốt: băm mật khẩu có salt, phiên HttpOnly, khoá tài khoản xoá phiên, mã truy cập
cho bản demo. Còn thiếu: (a) tài khoản seed dùng `123456` mà **không buộc đổi**; (b)
không giới hạn tốc độ `/auth/login` (chỉ cổng mã truy cập có); (c) phiên không hết hạn.

*Đề xuất.* Khi `NODE_ENV=production`: bật `must_change_pw` cho mọi tài khoản seed, giới
hạn 10 lần đăng nhập sai / 15 phút / IP + tài khoản, phiên hết hạn sau 12 giờ không dùng.
Ba thay đổi nhỏ, đều có sẵn hạ tầng.

### C3. Phân trang và chỉ mục (P2)
Các hàm `list*` trả tới 100–5 000 dòng một lần. Với 26 HTX mẫu thì nhanh; với 1 257 HTX
đã nhập và hàng chục nghìn thửa, trang *Thửa ruộng* và *Nhật ký* sẽ chậm rõ.

*Đề xuất.* Phân trang theo con trỏ cho jobs / logs / plots / event_log; thêm chỉ mục
cho các cột lọc hay dùng (`plots.htx_id`, `farm_logs.crop_cycle_id`, `event_log.entity_id`).

### C4. Lịch sử thay đổi theo đối tượng (P2)
`event_log` ghi đủ trước/sau cho mọi thao tác nhưng chỉ xem được dạng dòng chảy toàn hệ
thống. Câu hỏi thực tế là "ai đã đổi diện tích thửa này, khi nào".

*Đề xuất.* Tab *Lịch sử* trên thửa, việc thu gom, HTX, kịch bản — một truy vấn theo
`entity_type + entity_id`, hiển thị diff. Không cần bảng mới.

### C5. Kiểm thử giao diện (P3)
192 test đều ở tầng nghiệp vụ; giao diện kiểm bằng tay. Việc lần này đã lộ hai lỗi chỉ
thấy trên trình duyệt (mất nhóm đang chọn sau khi lưu; năng lực đội trừ nhầm máy đang chạy
nhìn thấy ở KPI).

*Đề xuất.* Không thêm dependency: script `npm run ui-check` khởi động server, mở từng
trang trong trình duyệt headless có sẵn của máy phát triển (Edge/Chrome qua
`--remote-debugging`), bắt lỗi console và đếm phần tử chính. Chạy trước mỗi lần đẩy mã.

### C6. Ràng buộc dữ liệu ở tầng CSDL (P3)
Nhiều bảng dùng `TEXT` cho khoá ngoại không khai báo `FOREIGN KEY`, và trạng thái là chuỗi
tự do. Service kiểm tốt nên chưa gây lỗi, nhưng nhập Excel hoặc sửa tay CSDL có thể tạo
dữ liệu mồ côi.

*Đề xuất.* Thêm `CHECK (status IN (...))` cho các cột trạng thái và khoá ngoại cho các
bảng mới (đã làm ở nhóm hiện trường); chạy `PRAGMA foreign_key_check` trong `npm test`.

---

## D. Nghiệp vụ mở rộng đáng giá

### D1. Hợp đồng thu mua rơm với HTX (P2)
Việc thu gom hiện không biết HTX nào có hợp đồng, cam kết bao nhiêu tấn, giá nào. Ưu tiên
phân công (`priority`) đang nhập tay.

*Đề xuất.* `straw_contracts` (HTX, vụ, tấn cam kết, giá, thời hạn) → `priority` tự tính
theo hợp đồng, phiếu mua rơm (B3) lấy giá từ đây, Cổng HTX xem tiến độ giao so với cam kết.

### D2. Danh mục ghe / sà lan và đơn giá thuê (P2)
TMS nhận `vehicle_code` tự do. Ghe phần lớn thuê ngoài; không có danh mục chủ ghe, lớp
tàu (đã có `VESSEL_CLASSES` để tính lưu thông) và đơn giá → chi phí vận tải thực không
đối chiếu được với hợp đồng thuê.

*Đề xuất.* `vessels` (số hiệu, chủ, lớp tàu, tải trọng, giấy tờ hết hạn) + `vessel_rates`;
lượt xuống ghe chọn từ danh mục (vẫn cho nhập mới tại chỗ); cảnh báo ghe hết hạn đăng kiểm.

### D3. Giờ máy, nhiên liệu, bảo dưỡng (P2)
Chi phí lớn nhất của đội cuộn là dầu và hỏng máy giữa vụ. Hiện chỉ có trạng thái
sẵn sàng / hỏng.

*Đề xuất.* `vehicle_logs` (giờ máy đầu–cuối ca, lít dầu, sửa chữa) ghi cùng lúc chốt công
đoạn; lịch bảo dưỡng theo giờ máy; chi phí nhiên liệu/tấn theo máy và theo đội.

### D4. Kiểm vị trí khi ghi nhận hiện trường (P2, nỗ lực nhỏ)
GPS được lấy tự động khi bấm bắt đầu / chốt nhưng **không so với vị trí việc**. App HTX đã
có `verifyLocation(plotId, point, 300 m)`.

*Đề xuất.* Dùng lại hàm đó cho `startStage` / `completeStage`: lệch quá 1 km thì gắn cờ
"ghi từ xa" (không chặn — đội trưởng có thể ghi ở bờ kênh cách ruộng vài trăm mét).

### D5. Sàn rơm cho bên thứ ba (P3)
Revenue rules đã có phí giao dịch "sàn phụ phẩm rơm" (3 %) nhưng chưa có sàn. Khi Mekong
Green không thu hết (mô phỏng cho thấy chỉ 125/365 ngày có rơm), HTX bán cho ai?

*Đề xuất.* Mô hình như sàn cơ giới hoá đã có (tin đăng, lệnh, escrow, tranh chấp) áp cho
rơm; việc thu gom bị huỷ vì "HTX bán bên khác" đi thẳng vào sàn.

---

## E. Giới hạn của nhóm chức năng Hiện trường vừa bổ sung — cần biết khi dùng

1. Việc lập từ **trạng thái mùa vụ cấp HTX** là ước tính rơm *một ngày gặt* (tổng vụ ÷ 20
   ngày). Lịch **cấp thửa** từ App HTX (`crop_cycles`) mới là nguồn chuẩn; HTX mở vụ trên
   App HTX càng nhiều, kế hoạch càng đúng.
2. Bằng chứng công đoạn hiện là ghi chú / link — chờ A1.
3. GPS ghi kèm nhưng chưa so với vị trí việc — chờ D4.
4. Ghe cập Hub chưa tự đối chiếu — chờ B1. Cho tới lúc đó, số "xuống ghe" là số đội
   trưởng khai, không phải số cân.
5. Phân công tự động chọn đội theo **khoảng cách thẳng** từ điểm đóng quân; chưa tính
   đường bộ thật hay việc đội đang ở ruộng khác (vị trí cuối cùng đã ghi). Với các đội
   đóng cách nhau 30–60 km như hiện nay, sai số này chấp nhận được.

---

## Lộ trình gợi ý

| Đợt | Nội dung | Kết quả nhìn thấy |
| --- | --- | --- |
| 1 (2–3 tuần) | B1 đối chiếu ghe–cân, B2 lô rơm, A1 ảnh bằng chứng, D4 kiểm vị trí, C2 bảo mật production | Chuỗi rơm khép kín từ ruộng tới kho; bằng chứng nằm trong hệ thống |
| 2 (2–3 tuần) | A3 thông báo Zalo, A2 offline + chống trùng, C1 sao lưu, B5 giả định–thực tế | Người đúng nhận cảnh báo đúng lúc; mô phỏng bắt đầu học từ số thật |
| 3 (3–4 tuần) | B3 phiếu mua rơm, D1 hợp đồng, D2 danh mục ghe, B4 khoán đội, A4 thời tiết | Tiền và chi phí đi theo tấn rơm thật; kế hoạch tránh ngày mưa |
| 4 | B6 dự báo 4 tuần, D3 giờ máy, C3 phân trang, C4 lịch sử, C5 kiểm thử UI, D5 sàn rơm | Vận hành ở quy mô 1 000+ HTX |
