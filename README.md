# Mekong Green — AgriGreen Platform & ERP nội bộ

Hệ thống hợp nhất được xây dựng từ bộ tài liệu nghiệp vụ đã phê duyệt của Mekong Green:

| Tài liệu nguồn | Phân hệ đã hiện thực |
| --- | --- |
| BRD Mekong Green GIS v1.2 | Nền tảng bản đồ số GIS dùng chung (FN-01 → FN-22) |
| BRD App Khuyến nông v5.0 (APPROVED) | App Khuyến nông (FN-01 → FN-17) |
| BRD App Hợp tác xã v4.0 (APPROVED) | App Hợp tác xã (FN-01 → FN-16, SYS-01) |
| BRD Bản đồ số Cơ giới hoá v1.3 (APPROVED) | Bản đồ CGH + QT-01/QT-02/QT-03 (FN-01 → FN-12) |
| BRD Supply Chain Hub Simulation v1.4 | ERP — Planning & Network Simulation (FN-01 → FN-20) |
| BRD Module Warehouse AgriGreen v1.1 | ERP — Warehouse & Inventory (FN-01 → FN-39) |
| AgriGreen ERP Product Vision v1.2 | Kiến trúc 13 phân hệ, MDM, RBAC hợp nhất, Revenue Engine, MRV |
| Master Data.xlsx · MEKONG_GREEN_Requirement · Mekong green diagram | Mô hình dữ liệu chủ & luồng liên thông |
| PL1_DS HTX, THT tham gia Đề án 1 triệu ha lúa.xlsx | Nhập danh sách HTX + tự định vị (mục 3.1) |
| ĐIỀU TRA VỤ ĐX2526.xlsx | Nhập dữ liệu vụ mùa theo đơn vị hành chính (mục 3.2) |

Toàn bộ giao diện và thuật ngữ nghiệp vụ bằng **tiếng Việt**, theo UX-04 của BRD Simulation.

---

## 1. Chạy hệ thống

Yêu cầu: **Node.js ≥ 22.6** (dùng `node:sqlite` và tính năng chạy trực tiếp TypeScript).
**Không cần cài bất kỳ package nào** — dự án có 0 dependency.

```bash
cd mekong-green
npm start
```

Mở http://localhost:4173

Các lệnh khác:

```bash
npm run seed -- --reset
```

```bash
npm run demo
```

```bash
npm test
```

- `npm run seed -- --reset` — xoá và nạp lại dữ liệu nền (26 HTX ĐBSCL, 3 mùa vụ, 378 máy cơ giới, 7 tuyến đường thuỷ, nhà máy VFT, 49 tham số).
- `npm run demo` — chạy trọn vẹn nghiệp vụ trên dòng lệnh: đặt 5 Hub ứng viên → dựng 3 kịch bản → mô phỏng → so sánh → khuyến nghị → độ nhạy → phê duyệt tham số → kết xuất Hub sang kho → nhập kho → định tuyến TMS → cân đối cơ giới hoá.
- `npm test` — 192 test kiểm chứng các Acceptance Criteria trong BRD và luồng nhập Excel.

### Tài khoản mẫu (mật khẩu `123456`)

| Tài khoản | Vai trò | Dùng để thử |
| --- | --- | --- |
| `admin` | Quản trị nền tảng | Toàn quyền |
| `supplychain` | Supply Chain / Kế hoạch | Dựng & chạy kịch bản Hub, số hoá tuyến |
| `taichinh` | Tài chính | Phê duyệt tham số giả định (FN-01 BR-02) |
| `banlanhdao` | Ban lãnh đạo | Đánh dấu kịch bản "Chính thức", chốt ngưỡng ROI/Payback |
| `khonhap` | Vận hành kho/bãi | Cân nhập/xuất, giám sát môi trường, kiểm kê |
| `dieuphoi` | Điều phối vận tải | TMS, số hoá tuyến |
| `hientruong` | Điều hành hiện trường | Kế hoạch thu gom, phân công đội, bảng điều hành Cổng Hiện trường |
| `doitruong` | Đội trưởng thu gom rơm | Ghi nhận cuộn – gom – xuống ghe tại ruộng |
| `canbo_tw` / `canbo_xa` | Khuyến nông TW / xã | Thư viện kỹ thuật, nhiệm vụ hỗ trợ |
| `htx01` / `nongdan` | Ban quản lý HTX / Nông dân | Vẽ lô ruộng, mở vụ, nhật ký, khai báo sản lượng |
| `cuc_ktht` | Cục KTHT & PTNT | Chỉ xem (theo ràng buộc "Cục chỉ Xem" của BRD CGH) |
| `vvb` | Tổ chức kiểm định | Xem dữ liệu MRV |

---

## 1B. Sáu cổng (portal) riêng biệt

Hệ thống **không phải một ứng dụng gộp** mọi phân hệ vào một thanh điều hướng. Mỗi nhóm
người dùng vào một cổng riêng, có đường dẫn riêng, nhận diện riêng và **hệ thống chức năng
riêng theo đúng BRD của app đó**.

| Cổng | Đường dẫn | Đối tượng | Số chức năng |
| --- | --- | --- | --- |
| 🌱 Cổng Khuyến nông | `/kn/` | Trung tâm/Trạm Khuyến nông, Tổ KNCĐ | 14 |
| 👨‍🌾 Cổng Hợp tác xã | `/htx/` | Ban quản lý HTX, tổ hợp tác, nông dân | 13 |
| 🚜 Cổng Cơ giới hoá | `/cgh/` | Chi cục PTNT, Cục KTHT & PTNT, chủ máy | 9 |
| 🗺️ Nền tảng GIS dùng chung | `/gis/` | Quản trị dữ liệu nền | 7 |
| 🌾 Cổng Hiện trường | `/field/` | Đội thu gom rơm của Mekong Green, điều hành hiện trường | 7 |
| 🏭 ERP nội bộ Mekong Green | `/erp/` | Supply Chain, Kho vận, Tài chính, Ban lãnh đạo | 10 |

Trang gốc `/` là **màn hình chọn cổng**, chỉ hiển thị những cổng mà vai trò đăng nhập được
phép vào. Người dùng chỉ có một cổng (nông dân, cán bộ HTX — nhóm đông nhất) được đưa
**thẳng** vào cổng của mình, không phải qua một màn hình chọn chỉ có một ô. Ai có quyền ở
nhiều cổng thấy bộ chuyển cổng ở chân thanh bên.

**Tách cổng là tách trải nghiệm và phạm vi chức năng, KHÔNG tách dữ liệu.** Cả sáu cổng dùng
chung một phiên đăng nhập, một CSDL và một nền GIS — đúng nguyên tắc "dữ liệu dùng chung"
của AgriGreen Platform. Cấu hình cổng nằm ở [`src/web/portals.js`](src/web/portals.js).

### Quyền vào cổng tách khỏi quyền đọc dữ liệu

Đây là điểm dễ làm sai nhất. Ban quản lý HTX có `khuyennong.read` để đọc quy trình kỹ thuật
đã xuất bản, và có `reporting.read` để xem báo cáo dùng chung. Nếu lấy chính hai quyền đó
làm điều kiện vào cổng thì HTX sẽ mở được cả Cổng Khuyến nông lẫn ERP nội bộ — đúng luật
nhưng sai nghiệp vụ.

Vì vậy RBAC có thêm nhóm quyền `portal.*` **độc lập với quyền dữ liệu**:

| Vai trò | Cổng vào được |
| --- | --- |
| Quản trị nền tảng | Tất cả |
| Khuyến nông Trung ương | Khuyến nông · GIS · Cơ giới hoá |
| Khuyến nông tỉnh | Khuyến nông · GIS |
| Khuyến nông xã / Tổ KNCĐ | Khuyến nông · Hợp tác xã (làm việc trực tiếp cùng HTX) |
| Ban quản lý HTX · Nông dân | Hợp tác xã |
| Cục KTHT & PTNT | Cơ giới hoá |
| Supply Chain | ERP · GIS · Cơ giới hoá |
| Tài chính · Kho vận · TMS · VVB | ERP |
| Ban lãnh đạo | Tất cả (chỉ xem) |

Vào thẳng URL một cổng không có quyền sẽ nhận thông báo nêu rõ lý do và danh sách cổng
được phép, thay vì bị im lặng chuyển hướng.

---

## 1C. Kế hoạch sản xuất theo quy trình chuẩn (Cổng Hợp tác xã)

Nhật ký canh tác trước đây là các bản ghi rời rạc: nông dân nhớ gì ghi nấy. Cách đó không
chứng minh được đã canh tác theo chuẩn nào, vì **không có gì để đối chiếu**. Nay có ba lớp
nối tiếp:

```
Quy trình chuẩn      →   Kế hoạch sản xuất của MỘT vụ   →   Xác nhận từng bước
(VietGAP, SRP, hữu cơ)   (bung theo ngày xuống giống)       (điều chỉnh + bằng chứng)
```

**Quy trình chuẩn** là bản mẫu gồm các bước. Mỗi bước neo vào ngày xuống giống bằng *số ngày
lệch* (âm = trước khi sạ, 0 = ngày sạ), kèm cửa sổ thời gian được coi là đúng hạn, loại bằng
chứng bắt buộc, điểm kiểm soát và — với bước phun thuốc — **thời gian cách ly (PHI)**.

**Kế hoạch sản xuất** bung quy trình thành lịch cụ thể cho một vụ. Bộ seed có sẵn quy trình
`VIETGAP-LUA` 12 bước theo TCVN 11892-1:2017.

**Ghi nhật ký = xác nhận bước kế hoạch.** Bản ghi `farm_logs` vẫn được tạo (MRV và truy xuất
đọc từ đây, không đổi), nhưng gắn với bước kế hoạch qua `plan_step_id` và chỉ được chấp nhận
khi thoả các điều kiện của quy trình.

### Bảy chốt chặn nghiệp vụ

| Mã | Chốt chặn |
| --- | --- |
| BR-01 | Vụ chưa có ngày xuống giống thì **không sinh được kế hoạch** — hệ thống không tự đoán ngày neo |
| BR-02 | Chỉ quy trình đã **Ban hành** mới áp dụng được vào vụ |
| BR-03 | Kế hoạch **ghim phiên bản** quy trình tại thời điểm sinh; sửa quy trình sau đó không làm đổi kế hoạch đã phát hành |
| BR-04 | Bước yêu cầu bằng chứng phải có **đủ loại** bằng chứng mới xác nhận được |
| BR-05 | Lệch quá cửa sổ cho phép **phải ghi lý do** điều chỉnh |
| BR-06 | **Thời gian cách ly** sau phun thuốc CHẶN thu hoạch sớm — lỗi an toàn thực phẩm, không phải cảnh báo suông |
| BR-07 | Quy trình đã ban hành hoặc đang có kế hoạch dùng thì **không sửa trực tiếp**; phải tạo phiên bản mới |

Thêm hai ràng buộc ở mép: bước **bắt buộc không được bỏ qua** (bỏ qua bước tuỳ chọn thì phải
có lý do), và **không huỷ được kế hoạch đã có bước xác nhận kèm bằng chứng** — nhật ký sản
xuất là hồ sơ truy xuất nguồn gốc, không phải bản nháp.

### Tuân thủ ≠ hoàn thành

Hai chỉ số tách bạch, vì chứng nhận VietGAP xét **cả thời điểm thực hiện** chứ không chỉ việc
có làm hay không:

- **Tiến độ** = số bước đã thực hiện / tổng số bước.
- **Tuân thủ** = số bước **bắt buộc** thực hiện **đúng hạn** / tổng bước bắt buộc.

Làm đúng việc nhưng trễ hạn vẫn tính vào tiến độ mà **không** tính vào tuân thủ.

### Chiều ngược lại: rút quy trình từ một vụ đã hoàn thành

Ngoài luồng "áp quy trình xuống vụ", hệ thống đọc ngược lại một vụ **đã đi hết chu kỳ** và
dựng thành bản mẫu cho các vụ sau. Hai nguồn, chất lượng khác hẳn nhau:

| Nguồn | Suy ra được | Phải tự quyết định |
| --- | --- | --- |
| **Vụ có kế hoạch** | Toàn bộ thuộc tính bước kế thừa từ quy trình gốc; chỉ **mốc thời gian** tính lại theo ngày thực tế đã làm | — |
| **Vụ chỉ có nhật ký** | Làm việc gì, vào ngày nào | Cửa sổ thời gian · bước nào bắt buộc · bằng chứng · thời gian cách ly · điểm kiểm soát |

Với nguồn là kế hoạch, bảng xem trước có thêm cột **"So với kế hoạch cũ"** cho biết mỗi bước
thực tế dịch bao nhiêu ngày — đó chính là nội dung của việc cập nhật quy trình theo thực tế.

**BR-08** — quy trình rút ra luôn ở trạng thái **Nháp**, mô tả ghi rõ vụ nguồn, và màn hình
liệt kê thẳng những thuộc tính **không quan sát được** từ một vụ đơn lẻ thay vì lặng lẽ điền
giá trị mặc định. Ban hành ngay một bản mẫu rút từ đúng một vụ là biến một lần quan sát thành
chuẩn. Riêng vụ có phun thuốc mà nhật ký không ghi thời gian cách ly sẽ nhận cảnh báo riêng —
thiếu con số đó thì quy trình mới không chặn được thu hoạch sớm ở các vụ sau.

Bước bị **bỏ qua** trong vụ nguồn không được đưa vào quy trình mới, và hệ thống nói rõ điều đó.

### Liên kết với khai báo sản lượng

Vụ có kế hoạch thì khai báo sản lượng phải qua hai chốt: thời gian cách ly (BR-06) và các bước
bắt buộc đã xác nhận. Vụ **không** có kế hoạch vẫn khai báo được như trước — hệ thống không
bắt mọi HTX phải lập kế hoạch mới được ghi sản lượng.

Mã nguồn: [`src/agrigreen/htx/production.ts`](src/agrigreen/htx/production.ts),
giao diện [`src/web/pages/production.js`](src/web/pages/production.js).

---

## 1D. Vận hành hợp tác xã: thửa ruộng, phân công, vật tư

### Thửa ruộng — diện tích do hệ thống tính

Vẽ đường bao trên bản đồ (≥ 3 đỉnh), diện tích tính bằng công thức diện tích cầu.
**Không có đường nào nhập diện tích trực tiếp** — giá trị `areaHa` do người gọi gửi lên bị bỏ
qua, vì diện tích đi thẳng vào thống kê sản lượng và bài toán cân đối cơ giới hoá.

Vẽ lại đường bao thì diện tích tính lại và hàm trả về mức chênh lệch. Thửa **đang canh tác**
mà diện tích đổi ≥ 5% sẽ kèm cảnh báo, vì đó là thay đổi có hệ quả chứ không phải sửa chính tả.

Cả Cổng HTX và Cổng Khuyến nông đều vẽ được; trường `source` ghi rõ thửa do bên nào vẽ.

### Hai mô hình vận hành HTX

Đây là thuộc tính của HTX, đổi được bất cứ lúc nào và **không xoá phân công đã tạo**:

| Mô hình | Nhân công | Máy móc dùng chung |
| --- | --- | --- |
| **Ban quản trị phân công** | Ban quản trị giao việc cho mọi thành viên | Ban quản trị điều phối |
| **Thành viên chủ động** | Chỉ **chủ thửa** tự tổ chức việc trên thửa của mình | Ban quản trị vẫn điều phối |

Máy móc do Ban quản trị điều phối ở **cả hai** mô hình, vì đó là tài sản chung phải xếp lịch
giữa các thửa. Một máy không thể ở hai thửa cùng một ngày — hệ thống chỉ ra đúng thửa và công
đoạn đang chiếm lịch.

**Một khoảng trống được nói thẳng:** mô hình 2 dựa vào *chủ thửa* để biết ai được tự chủ. Thửa
chưa gán chủ thì quy tắc không có căn cứ để áp. Hệ thống vẫn cho phân công (chặn thì thửa vô
chủ thành không làm được việc) nhưng kèm cảnh báo rõ ràng ở cả màn hình lẫn kết quả API —
im lặng sẽ khiến Ban quản trị tưởng mô hình đang có hiệu lực.

Từ chối một phân công **bắt buộc nêu lý do**, để Ban quản trị biết mà bố trí người khác.

### Vật tư nông nghiệp: mua sắm → tồn kho → cấp phát

Khác hẳn Procurement của ERP (mua rơm nguyên liệu). Đây là chu trình nội bộ HTX cho phân bón
và thuốc BVTV, gắn tới tận **thửa ruộng và bước kế hoạch**, vì hồ sơ VietGAP đòi trả lời được
*lô thuốc nào đã xuống thửa nào, ngày nào, ai nhận* — một sổ kho ghi "xuất 50 kg urê" không
trả lời được câu đó.

| Mã | Chốt chặn |
| --- | --- |
| IN-01 | Tồn kho theo **LÔ**, không gộp — thu hồi lô lỗi mới lần ra được đúng những thửa đã dùng |
| IN-02 | Không cấp phát quá tồn kho của lô |
| IN-03 | Không cấp phát vật tư **đã hết hạn** |
| IN-04 | Thuốc **ngoài danh mục được phép** thì không cấp phát |
| IN-05 | Thuốc có thời gian cách ly được đối chiếu ngược với ngày thu hoạch dự kiến |
| IN-06 | Chỉ cấp vật tư cho thửa thuộc chính HTX giữ kho |

Danh mục seed có sẵn một hoạt chất **đã bị cấm** (Paraquat) để IN-04 có gì mà chặn.

---

## 1E. Khảo sát và hồ sơ HTX — App Khuyến nông

### Mẫu khảo sát định kỳ hoặc đột xuất

Mẫu dùng lại được, chạy theo tuần / tháng / đột xuất. Mỗi phiếu gắn với hộ dân hoặc HTX, kèm
thông tin cơ bản, **ngày bắt đầu chu kỳ sản xuất** và **hiện trạng sản xuất** (8 mức từ chưa
xuống giống tới đã thu hoạch).

| Mã | Chốt chặn |
| --- | --- |
| SV-01 | Chỉ mẫu **đã ban hành** mới nhận phiếu |
| SV-02 | Một đối tượng chỉ có **một** phiếu trong một kỳ — nhập lại là cập nhật, không tạo bản trùng |
| SV-03 | Câu hỏi bắt buộc phải có trả lời |
| SV-04 | Ấp phải thuộc xã đã chọn, xã phải thuộc tỉnh đã chọn |
| SV-05 | Kỳ khảo sát đúng định dạng của tần suất (`2026-W12` / `2026-04` / `2026-04-15`) |

### Địa chỉ hành chính lọc dần

Ba ô liên động: chọn tỉnh mới hiện xã **của tỉnh đó**, chọn xã mới hiện thôn/ấp **của xã đó**.
Danh sách truy vấn theo `parent_id` nên không bao giờ lệch. Cây hành chính có đủ ba cấp:
**6 tỉnh → 134 xã → 670 thôn/ấp**, dựng từ bảng tra địa danh sau sáp nhập 2025.

### Khởi tạo HTX theo mã số thuế

Cán bộ Khuyến nông đi địa bàn trước: lập hồ sơ HTX, vẽ thửa, ghi nhận thành viên — tất cả nằm
sẵn trên CSDL dùng chung. Sau đó HTX mới đăng ký tài khoản. Cầu nối là **mã số thuế**.

| Mã | Chốt chặn |
| --- | --- |
| MST-01 | Mã số thuế 10 hoặc 13 chữ số (13 số là đơn vị phụ thuộc, hiển thị `##########-###`) |
| MST-02 | Một MST chỉ gắn với **một** hồ sơ HTX |
| MST-03 | Hồ sơ đã kích hoạt thì không kích hoạt lại được |
| MST-04 | Xem trước **con số cụ thể** sẽ thừa hưởng trước khi bấm kích hoạt |

Kích hoạt **không sao chép dữ liệu** — dữ liệu vốn đã trỏ tới đúng `htx_id` đó. Kích hoạt chỉ
xác lập quyền sở hữu. Đó chính là điều làm "dữ liệu dùng chung" có ý nghĩa thực tế.

Mã nguồn: [`assignment.ts`](src/agrigreen/htx/assignment.ts) ·
[`inputs.ts`](src/agrigreen/htx/inputs.ts) ·
[`survey.ts`](src/agrigreen/khuyennong/survey.ts) ·
[`htxRegistry.ts`](src/mdm/htxRegistry.ts)

---

## 1F. Mạng lưới đường thuỷ: cấu trúc, tải trọng, cự ly tối ưu

### Tự động nhận diện cấu trúc mạng lưới

**Phạm vi, nói rõ để không hiểu nhầm:** hệ thống *không* nhận diện kênh rạch từ ảnh vệ tinh —
không có nguồn ảnh raster. Cái được tự động nhận diện là **cấu trúc mạng lưới** từ các tuyến
đã số hoá, và đó chính là chỗ dữ liệu vẽ tay hay hỏng:

| Loại | Vấn đề |
| --- | --- |
| **Giao cắt thiếu đỉnh** | Hai tuyến cắt nhau trên bản đồ nhưng không có đỉnh chung → thuật toán không rẽ được |
| **Nối chữ T thiếu đỉnh** | Đầu tuyến này nằm trên thân tuyến kia nhưng thiếu đỉnh nối |
| **Khe hở** | Hai đầu tuyến gần nhau nhưng chưa chạm, do số hoá |
| **Cơ sở ngoài tầm** | Hub / nhà máy cách mạng lưới quá bán kính tiếp cận 8 km |

Công cụ tách hai mức có chủ đích: `analyzeNetwork()` **chỉ báo cáo**, `rebuildNetwork()` mới ghi
dữ liệu. Khe hở ≤ **150 m** coi là lỗi số hoá và nối tự động; từ đó tới **1.000 m** chỉ báo cáo
để người dùng tự quyết; xa hơn không báo vì gần như chắc chắn là hai con kênh khác nhau — nối
bừa sẽ tạo ra một tuyến vận tải không tồn tại ngoài thực địa.

Phân tích **khả năng tiếp cận cơ sở** là phần trả lời thẳng câu hỏi khó chịu nhất: mạng lưới có
đẹp tới đâu mà nhà máy nằm cách bờ kênh 12 km thì mọi chặng đường thuỷ vẫn rơi về Haversine
hiệu chỉnh. Công cụ chỉ đích danh cơ sở nào, cách bao nhiêu km, và tuyến nào gần nhất.

### Rộng · sâu · tĩnh không cầu → tải trọng lưu thông

Ba thông số của tuyến đối chiếu với ba kích thước của phương tiện:

| Tuyến | ↔ | Phương tiện |
| --- | --- | --- |
| Chiều rộng lòng kênh | ↔ | Chiều rộng thân (beam) |
| Độ sâu luồng | ↔ | Mớn nước (draft) |
| Tĩnh không cầu | ↔ | Chiều cao tĩnh không (air draft) |

Ba biên an toàn được cộng thêm, vì con số vừa khít trên giấy là không đi được ngoài thực địa:
kênh phải rộng **1,5 lần** thân tàu, sâu hơn mớn nước **0,4 m**, và tĩnh không cao hơn tàu **0,5 m**.

| Phương tiện | Tải trọng | Rộng thân | Mớn nước | Tĩnh không | Tuyến phải đạt |
| --- | --- | --- | --- | --- | --- |
| Ghe | 100 t | 5,5 m | 1,4 m | 3,5 m | rộng 8,3 m · sâu 1,8 m · tĩnh không 4,0 m |
| Sà lan nhỏ | 1.000 t | 10 m | 2,5 m | 6 m | rộng 15 m · sâu 2,9 m · tĩnh không 6,5 m |
| Sà lan lớn | 2.000 t | 12 m | 3,2 m | 7 m | rộng 18 m · sâu 3,6 m · tĩnh không 7,5 m |

**Cầu, cống, âu thuyền là ràng buộc ĐIỂM** và có bảng riêng: một tuyến rộng 200 m sâu 8 m vẫn
chỉ đi được ghe nếu có một cây cầu tĩnh không 5 m chắn ngang. Ràng buộc lấy giá trị **bất lợi
nhất** trên toàn tuyến, và hệ thống chỉ rõ công trình nào đang khống chế.

Ba trạng thái được phân biệt rõ: **qua được**, **không qua được**, và **chưa kết luận được vì
thiếu số liệu**. Gộp "thiếu số liệu" vào "qua được" sẽ điều một sà lan 2.000 tấn vào con kênh
chưa ai đo độ sâu — nên tuyến thiếu số liệu bị loại khỏi định tuyến.

Độ sâu khai báo hiểu là **độ sâu khống chế mùa khô**. Khai theo mực nước mùa lũ sẽ cho kết luận
sai vào đúng lúc cần vận chuyển rơm nhất — vụ Đông Xuân thu hoạch giữa mùa khô.

### Cự ly tối ưu Hub → Nhà máy

Dijkstra trên mạng lưới, **lọc theo lớp phương tiện**: trả về đường ngắn nhất trong số những
tuyến phương tiện đó *đi được*, không phải đường ngắn nhất trên giấy. Con kênh tắt có thể chỉ
vừa ghe 100 tấn, còn sà lan 1.000 tấn phải đi vòng theo sông lớn — màn hình có bảng so sánh cả
ba lớp phương tiện trên cùng một chặng để thấy đúng đánh đổi đó.

Kết quả trả về cả **hình học đường đi** và **danh sách tuyến đi qua**, nên vẽ được lên bản đồ và
kiểm chứng được. Không tìm được đường thì nói rõ lý do thay vì trả về một con số trông như cự
ly thực tế.

Tải trọng **suy ra** được ưu tiên hơn `max_load_tons` nhập tay khi định tuyến: nó là kết quả đối
chiếu thông số kỹ thuật, còn số nhập tay chỉ là ghi chú của người số hoá.

Mã nguồn: [`vessels.ts`](src/platform/geo/vessels.ts) ·
[`waterwayNetwork.ts`](src/agrigreen/gis/waterwayNetwork.ts) ·
[`network.ts`](src/platform/geo/network.ts) · [`distance.ts`](src/platform/geo/distance.ts)

---

## 1G. Chia sẻ bản trình diễn cho người khác xem

### Cổng mã truy cập

Mọi tài khoản demo đều dùng mật khẩu `123456` và màn hình đăng nhập liệt kê sẵn danh sách —
trên máy thì tiện, đưa lên Internet thì ai có link cũng vào được quyền quản trị. Vì vậy có một
**cổng mã truy cập** đứng trước toàn bộ hệ thống:

```bash
DEMO_ACCESS_CODE=ma-cua-ban npm start
```

- **Không đặt biến này thì cổng tắt hoàn toàn** — chạy trên máy không phải nhập gì thêm.
- Cổng chặn **cả API**, không chỉ giao diện. Một cổng chỉ che màn hình đăng nhập mà để
  `/api/...` mở thì lấy dữ liệu bằng một lệnh `curl` là xong.
- `/health` luôn mở, nếu không nền tảng triển khai sẽ coi dịch vụ là hỏng và khởi động lại liên tục.
- Cookie chứa **dấu vân** của mã chứ không chứa mã gốc, nên người xem cookie không suy ngược ra
  mã để chia sẻ tiếp. **Đổi `DEMO_ACCESS_CODE` là thu hồi quyền xem của mọi người đã có link.**
- Sai quá 8 lần trong 10 phút thì IP đó bị chặn tạm — mã ngắn không có giới hạn này thì dò ra
  trong vài phút.

Đây là rào chắn cho bản trình diễn, **không phải** cơ chế xác thực người dùng: ai có mã cũng
thấy được mọi thứ. Phân quyền thật vẫn nằm ở màn hình đăng nhập phía sau.

### Triển khai

| | Render | Fly.io |
| --- | --- | --- |
| Tệp cấu hình | `render.yaml` | `fly.toml` + `Dockerfile` |
| Bước chuẩn bị | Không | Cài `flyctl` |
| Dữ liệu SQLite | Mất khi khởi động lại (gói miễn phí) | Giữ được nhờ volume |
| Khi không có truy cập | Ngủ sau 15 phút, đánh thức mất 30–60 giây | Ngủ, đánh thức vài giây |

Dữ liệu mất khi khởi động lại **không phải vấn đề với bản trình diễn**: `seedIfEmpty()` tự nạp
lại toàn bộ dữ liệu mẫu khi khởi động, nên dịch vụ tự phục hồi. Chỉ cần đĩa lưu trữ bền khi
muốn giữ những gì người xem nhập vào.

Cả hai tệp cấu hình đều có hướng dẫn từng bước ghi ngay trong phần chú thích đầu tệp.

**Xem và đổi mã truy cập sau khi đã triển khai:**

| Nền tảng | Đường đi |
| --- | --- |
| Render | Dashboard → dịch vụ → `Environment` → dòng `DEMO_ACCESS_CODE` → biểu tượng con mắt để xem, `Edit` để đổi |
| Fly.io | `fly secrets set DEMO_ACCESS_CODE=ma-moi` (secret không đọc lại được, chỉ đặt đè) |

Cả hai nền tảng đều tự khởi động lại dịch vụ sau khi đổi, mất khoảng một phút.

---

## 1H. Quản trị hệ thống: tài khoản, nhóm, phân quyền

Ma trận RBAC ban đầu nằm cứng trong mã nguồn. Điều đó ổn khi hệ thống mới có một
nhóm người dùng, nhưng khi đã có 13 nhóm trên 5 cổng thì mỗi lần một sở muốn cán
bộ xã xem thêm một báo cáo lại thành một lần sửa mã và triển khai lại. Nên ma
trận giờ có hai tầng:

- **Mặc định trong mã nguồn** — `ROLE_PERMISSIONS` tại [`rbac.ts`](src/platform/auth/rbac.ts), vẫn là nguồn chuẩn.
- **Ghi đè do quản trị viên đặt** — bảng `group_permissions`, cấp thêm (`granted = 1`) hoặc thu hồi (`granted = 0`) từng quyền.

Quyền hiệu lực = mặc định, rồi áp ghi đè. Giao diện luôn hiện **cả hai**: ô nào
lệch mặc định thì viền vàng kèm chú thích "Mặc định: có / không" và một nút trả
về mặc định. Không có dòng đó thì sau vài tháng không ai còn biết cấu hình đã bị
sửa ở đâu và vì sao.

`permissionsFor()` chạy trên mọi yêu cầu HTTP, nên phần ghi đè được giữ trong bộ
nhớ và chỉ nạp lại khi có thay đổi (`invalidatePermissionCache`) — truy vấn CSDL
mỗi request sẽ biến phân quyền thành nút thắt cổ chai của cả hệ thống.

### Bảy chốt chặn an toàn

| Mã | Chốt chặn | Vì sao |
| --- | --- | --- |
| SA-01 | Không thu hồi quyền của nhóm quản trị nền tảng | Một thao tác nhầm là khoá cứng cả hệ thống, không còn ai vào sửa lại |
| SA-02 | Không hạ cấp / khoá / tự xoá nhóm của **chính mình** | Tránh tự nhốt mình ra ngoài |
| SA-03 | Luôn còn ít nhất một quản trị nền tảng đang hoạt động | Chặn ở tầng nghiệp vụ, không chỉ cảnh báo trên giao diện |
| SA-04 | Tài khoản phải thuộc ít nhất một nhóm | Không nhóm = không vào được cổng nào, tài khoản thành rác |
| SA-05 | Không xoá nhóm hệ thống, không xoá nhóm còn người dùng | Xoá nhóm đang dùng là âm thầm tước quyền một loạt người |
| SA-06 | Khoá tài khoản là **xoá luôn phiên đang mở** | Khoá mà phiên cũ vẫn chạy thì việc khoá vô nghĩa |
| SA-07 | Mật khẩu tạm chỉ hiện **một lần**, buộc đổi ở lần đăng nhập đầu | Mật khẩu tạm còn đọc lại được thì không còn là tạm |

SA-06 đóng hai lỗ hổng thật: `userFromToken` trước đây không kiểm tra trạng thái
tài khoản, nên một tài khoản bị khoá **sau khi** đã đăng nhập vẫn dùng được phiên
cũ cho tới khi hết hạn. Nay phiên bị xoá ngay tại thời điểm khoá, và mọi phiên
còn sót cũng chết ở lần dùng kế tiếp.

### Hai màn hình

| Màn hình | Làm được gì |
| --- | --- |
| 👤 Tài khoản người dùng | Tạo tài khoản (sinh mật khẩu tạm), sửa hồ sơ, đổi nhóm, khoá/mở, đặt lại mật khẩu, thu hồi phiên. Mỗi tài khoản có bảng **"quyền đến từ nhóm nào"** — trả lời câu hỏi hay gặp nhất khi phân quyền: vì sao người này vào được màn hình đó |
| 🛡️ Nhóm & phân quyền | 13 nhóm, ma trận 40 quyền chia 7 mảng, tick trực tiếp và có hiệu lực ngay. Tạo được nhóm tuỳ chỉnh (bắt đầu từ rỗng, không kế thừa) |

Mọi thao tác đều ghi vào nhật ký truy vết dùng chung
([`audit.ts`](src/platform/audit/audit.ts)) kèm người thực hiện và giá trị trước/sau.

Mã nguồn: [`admin.ts`](src/platform/auth/admin.ts) ·
[`rbac.ts`](src/platform/auth/rbac.ts) · [`users.ts`](src/platform/auth/users.ts) ·
[`sysadmin.js`](src/web/pages/sysadmin.js)

---

## 1I. Quản lý hiện trường — đội thu gom rơm của Mekong Green

Mekong Green không mua rơm đã đóng kiện; công ty tự đưa đội xuống ruộng ngay sau khi máy
gặt đi qua: **cuộn** rơm thành kiện → **gom** kiện ra bờ kênh → **đưa xuống ghe / sà lan**.
Ba công đoạn này quyết định hai thứ mà mọi phân hệ khác chỉ nhận kết quả: rơm có kịp thu
trước khi ẩm mục hay không, và ghe có hàng để chạy hay không.

Module đứng giữa ba nguồn dữ liệu sẵn có, không nhập tay lại thứ đã có:

| Nguồn | Cho biết | Cách nối |
| --- | --- | --- |
| App HTX | Ngày gặt dự kiến từng thửa; khai báo sản lượng khi gặt xong | `declareHarvest` tự tạo / cập nhật việc thu gom với cờ **rơm đã có thật** |
| Trạng thái mùa vụ (GIS) | Ngày gặt dự kiến cấp HTX, tổng rơm cả vụ | Đồng bộ lịch gặt 14 ngày; mỗi việc là ước tính **một ngày gặt** (tổng vụ ÷ 20) |
| CGH | Danh mục máy | Phương tiện của đội liên kết `machine_id` |
| TMS | Chuyến ghe / sà lan | **Mỗi lượt xuống ghe sinh một chuyến đường thuỷ** tới Hub / nhà máy gần nhất, ngay lúc đội trưởng bấm ghi |

### Kế hoạch từ lịch gặt — tự động hoặc tay

Năng lực đội = tổng năng lực máy cuộn dùng được (tấn/ngày). Phân công tự động chạy hai lượt:
đội gần nhất còn năng lực trong 3 ngày sau gặt; việc không vừa đội nào vẫn được xếp cho
đội gần nhất ít tải nhất nhưng tách riêng thành nhóm **ép xếp** kèm cảnh báo. Để trống là
cách tệ nhất — rơm vẫn nằm ruộng và không ai chịu trách nhiệm; ép xếp có cờ đỏ cho quản
lý thấy đúng chỗ thiếu đội. Phân công tay được vượt năng lực nhưng phải thấy cảnh báo.

Kế hoạch công đoạn suy từ khối lượng ÷ năng lực: 90 tấn với đội 40 tấn/ngày = 3 ngày
cuộn, gom kéo dài thêm một ngày, xuống ghe bắt đầu từ ngày thứ hai khi đã có kiện ở bờ.

### Tám chốt chặn

| Mã | Chốt chặn | Vì sao |
| --- | --- | --- |
| FM-01 | Không cuộn rơm trước ngày gặt | Rơm chưa có thì không có gì để cuộn |
| FM-02 | Rơm phải cuộn xong trong 3 ngày sau gặt; quá hạn gắn cờ, không chặn | Rơm vẫn phải thu, nhưng ai cũng phải thấy nó đang mục |
| FM-03 | Chỉ **hoàn thành** công đoạn khi công đoạn trước đã hoàn thành; được **bắt đầu** khi công đoạn trước đã bắt đầu | Gom song song với cuộn là thực tế; chốt gom trước khi cuộn xong là số liệu giả |
| FM-04 | Khối lượng không tăng qua công đoạn: gom ≤ cuộn, xuống ghe ≤ gom | Rơm không tự sinh ra giữa hai công đoạn |
| FM-05 | Mỗi lượt xuống ghe = một chuyến TMS; TMS lỗi không chặn ghi nhận, chỉ cảnh báo | Hiện trường không được kẹt vì phân hệ khác |
| FM-06 | Phân công tự động không xếp quá năng lực; tay được vượt nhưng có cảnh báo | Máy chỉ cuộn được bấy nhiêu tấn một ngày |
| FM-07 | Chỉ đội đang hoạt động mới nhận việc | — |
| FM-08 | Đồng bộ lịch gặt chạy lại không sinh việc trùng | Bấm hai lần không thành hai việc |

Khối lượng xuống ghe **không nhập tay**: là tổng các lượt ghe đã ghi — mỗi lượt có số hiệu
ghe, tài công, tấn, Hub nhận, và mã chuyến TMS để kho đối chiếu.

### Màn hình

| Màn hình | Ai dùng | Làm gì |
| --- | --- | --- |
| 📱 Ghi nhận tại ruộng | Đội trưởng (điện thoại) | Bấm bắt đầu / chốt từng công đoạn, GPS lấy tự động; ghi lượt xuống ghe → thấy ngay mã chuyến |
| 🛰️ Bảng điều hành | Điều hành | Thời gian thực: đội ở đâu, cuộn – gom – xuống ghe hôm nay, rơm quá hạn, ghe đang chạy, bản đồ |
| 📅 Kế hoạch thu gom | Điều hành | Lịch gặt 14 ngày × tải từng đội; đồng bộ, phân công tự động / tay, thêm việc thủ công |
| 👷 Đội & phương tiện | Điều hành | Đội, thành viên, máy; điều chuyển máy dự phòng; trạng thái hỏng / bảo dưỡng |
| 📈 Năng suất | Điều hành, Ban lãnh đạo | Tấn cuộn – gom – xuống ghe theo đội, tỷ lệ thu hồi, giờ từng công đoạn, gặt → ghe, mức sử dụng máy |

Vai trò mới: **Điều hành hiện trường** (`field_manager`, vào cả Cổng Hiện trường và ERP) và
**Đội trưởng thu gom rơm** (`field_crew`, chỉ Cổng Hiện trường, không vào ERP). Supply Chain và
Điều phối vận tải có quyền lập kế hoạch; Ban lãnh đạo xem.

Rà soát toàn hệ thống và các đề xuất tiếp theo (đối chiếu ghe – cân ở Hub, ảnh bằng chứng,
thông báo Zalo, offline…): [`docs/RA-SOAT-HE-THONG.md`](docs/RA-SOAT-HE-THONG.md).

Mã nguồn: [`erp/field/service.ts`](src/erp/field/service.ts) ·
[`web/pages/field.js`](src/web/pages/field.js) · [`tests/field.test.ts`](tests/field.test.ts)

---

## 2. Kiến trúc

```
src/
  platform/            Lõi dùng chung cho MỌI phân hệ
    db/                node:sqlite + lược đồ hợp nhất (không phân hệ nào giữ bản sao dữ liệu chủ)
    http/              Router + RBAC middleware (không phụ thuộc framework)
    auth/              Tài khoản, phiên, MA TRẬN RBAC HỢP NHẤT cho cả 5 nhóm đối tượng
    audit/             Event log append-only · snapshot theo ngày · replay · chính sách lưu trữ
    sync/              Nhật ký đồng bộ, retry backoff, dead-letter
    geo/               Haversine · geodesic Vincenty · diện tích polygon · Dijkstra trên mạng lưới
                       · DistanceService có cache và NHÃN NGUỒN TÍNH
    io/                Bộ đọc ZIP + XLSX tự viết (phục vụ nhập file Excel)
  mdm/                 Master Data & Configuration Hub
    gazetteer.ts       Bảng tra địa danh ĐBSCL + quy đổi địa giới sau sáp nhập 2025
    import/            Importer danh sách HTX và dữ liệu vụ mùa
  agrigreen/
    gis/               Nền GIS dùng chung + FN-20 số hoá & đo tuyến đường thuỷ
    khuyennong/        App Khuyến nông
    htx/               App Hợp tác xã
    cgh/               Bản đồ số Cơ giới hoá (QT-01/02/03)
    rental/            Sàn cơ giới hoá (vòng đời lệnh thuê + xử lý tranh chấp)
  erp/
    params/            Danh mục 49 tham số + phiên bản bộ tham số + phê duyệt giả định
    simulation/        LÕI MÔ PHỎNG — FN-04 → FN-12, FN-17, FN-18
    warehouse/         Nhập/xuất/kiểm kê/IoT/MRV
    procurement/ sales/ tms/ finance/ reporting/
  web/                 Giao diện (vanilla ESM + Leaflet), tiếng Việt
  api.ts               ~150 endpoint REST, mỗi endpoint gắn một quyền RBAC
```

Nguyên tắc kiến trúc được tuân thủ theo ERP Product Vision v1.2 mục 3.2:

1. **Multi-site từ ngày đầu** — Hub / Kho / Bãi / Nhà máy đều là bản ghi trong `facilities`, không hard-code.
2. **Một Master Data** — HTX, thửa ruộng, thiết bị, đối tác, mùa vụ nằm ở `src/mdm`; Simulation, Warehouse, CGH, Khuyến nông, App HTX đều đọc từ đó.
3. **RBAC nhất quán** — một ma trận duy nhất tại `src/platform/auth/rbac.ts` (xử lý rủi ro "RBAC chưa hợp nhất" mức Cao).
4. **Giao dịch vận hành = giao dịch MRV** — mỗi GRN / phiếu xuất / chuyến vận chuyển tự sinh bản ghi MRV có checksum.
5. **Audit-trail toàn hệ thống** — mọi thay đổi ghi vào `event_log` append-only.
6. **Ranh giới Payment ↔ Finance** — Rental chỉ ghi trạng thái escrow; Finance chỉ tiêu thụ kết quả để tính phí/đối soát.

---

## 3. Nhập dữ liệu từ Excel

Màn hình **Nhập dữ liệu Excel** (nhóm AgriGreen Platform) nhận trực tiếp file nghiệp vụ
do các Sở/Chi cục lập, không cần chỉnh sửa file trước. Bộ đọc `.xlsx` được viết từ đầu
(`src/platform/io/`) nên vẫn giữ cam kết 0 dependency.

Quy trình bắt buộc hai bước: **Kiểm tra trước** (không ghi dữ liệu) → xem báo cáo đối
chiếu → **Nhập vào hệ thống**. Không có đường nhập thẳng, vì dữ liệu nguồn thực tế luôn
có sai lệch cần người dùng quyết định.

### 3.1 Danh sách HTX / THT → tự định vị trên bản đồ

- Nhận diện cột theo từ điển nhãn (`Tên HTX`, `Xã`, `Huyện`, `SĐT`, `Diện tích (ha)`…),
  chấp nhận cả file dùng **dòng nhóm tỉnh** (`Tỉnh An Giang`) thay cho cột Tỉnh.
- **Quy đổi địa giới hành chính sau sáp nhập 2025**: 12 tỉnh cũ → 6 tỉnh/thành.
  Kiên Giang → An Giang · Sóc Trăng, Hậu Giang → Cần Thơ · Bạc Liêu → Cà Mau ·
  Trà Vinh, Bến Tre → Vĩnh Long · Tiền Giang → Đồng Tháp · Long An → Tây Ninh.
- **Định vị tự động** theo bảng tra huyện ĐBSCL (`src/mdm/gazetteer.ts`, ~140 huyện),
  phân tán tất định để marker không chồng khít. Mỗi điểm mang nhãn **độ chính xác**:
  `cấp huyện` hoặc `cấp tỉnh` — dòng ở mức tỉnh là danh sách việc cần khảo sát GPS (RS-02).
- Xử lý đúng các huyện trùng tên (nhiều "Châu Thành") bằng cách ưu tiên huyện thuộc
  đúng tỉnh khai báo.
- Toàn bộ thông tin khác (địa chỉ, người liên lạc, SĐT, diện tích) vào **danh mục HTX
  dùng chung**, nên App Khuyến nông, App HTX, Bản đồ CGH, Simulation và Warehouse
  dùng lại ngay mà không cần nhập lại.

Kết quả trên file thật (1.231 HTX/THT):

| Chỉ tiêu | Kết quả |
| --- | --- |
| Định vị tới cấp huyện | 1.172 (95,2%) |
| Chỉ tới cấp tỉnh — cần khảo sát GPS | 59 |
| Quy đổi địa giới | 949 HTX thuộc 6 tỉnh cũ |
| Dòng có cảnh báo cần rà soát | 91 |

Ba nhóm cảnh báo hệ thống phát hiện được trong file nguồn:

1. **21 HTX bị xếp nhầm tỉnh** — các huyện Gò Công, Cai Lậy, Cái Bè (Tiền Giang) nằm
   trong nhóm "Tỉnh Bạc Liêu". Hệ thống đặt toạ độ theo huyện, **giữ nguyên tỉnh như file
   ghi** và gợi ý chuyển sang Đồng Tháp — không tự ý xếp lại.
2. **58 dòng thiếu địa chỉ/huyện** (toàn bộ nhóm Trà Vinh và Hậu Giang) — đặt tạm ở
   trung tâm tỉnh, gắn nhãn cần khảo sát.
3. **Sai chính tả huyện** được nhận qua bảng bí danh: Giồng Giềng → Giồng Riềng,
   Tháo Mười → Tháp Mười, Thạch Trị → Thạnh Trị…

Số điện thoại lưu dạng số trong Excel (mất số 0 đầu) được khôi phục tự động.

### 3.2 Dữ liệu vụ mùa theo đơn vị hành chính

Nhận hai bố cục file thường gặp:

- **Bảng phẳng** — mỗi dòng một xã: `Xã | Huyện | Diện tích gieo sạ | Ngày xuống giống |
  Ngày thu hoạch | Năng suất | Sản lượng | Giống lúa`.
- **Bảng chéo tiến độ** — như sheet `THU HOẠCH ĐX2526`: mỗi dòng một xã, phía trên lặp
  nhiều khối `NGÀY THU HOẠCH` với ngày ở dòng kế tiếp và 3 cột con
  (Diện tích / NS khô / Sản lượng) cho từng đợt thu hoạch.

Xử lý tự động: quy đổi số sê-ri ngày của Excel; điền xuống giá trị huyện cho ô gộp; tách
riêng hai bảng đặt cạnh nhau trong cùng sheet (Đông Xuân và vụ Mùa dùng trùng mốc ngày);
sinh mã vụ phân biệt niên vụ bắc cầu hai năm (`ĐX2526` → `DX-2025-2026`, không đè lên
`DX-2024-2025`).

**Về ngày xuống giống.** File mẫu đính kèm chỉ có *ngày thu hoạch*. Khi file có cột
"Ngày xuống giống", hệ thống dùng thẳng số liệu gốc và gắn nhãn `khai báo`. Khi không có,
hệ thống **suy ra** = ngày thu hoạch − thời gian sinh trưởng của vụ (ĐX 100 ngày,
HT/TĐ 95 ngày) và gắn nhãn `suy ra`. Hai loại này luôn hiển thị tách bạch trên báo cáo
và trên bản đồ — giá trị suy diễn không bao giờ được trình bày như số liệu khai báo.

Kết quả trên sheet `THU HOẠCH ĐX2526`: 105 đơn vị hành chính · 624.046 ha gieo sạ ·
2.418.437 tấn · 110 mốc thu hoạch · 100/105 định vị tới cấp huyện.

Dữ liệu vào bảng `commune_crop_seasons` + `commune_harvest_progress`, và hiện lên nền GIS
dùng chung qua lớp **"Lịch thời vụ theo xã"** (màu theo tháng thu hoạch) — dùng để nhận
diện vùng thu hoạch đồng loạt, bố trí máy gặt và lịch thu gom rơm.

---

## 4. Lõi mô phỏng & hoạch định chi phí

Chuỗi tính toán trong `src/erp/simulation/engine.ts`:

```
FN-04 Khoảng cách (routing thực tế / tuyến số hoá / Haversine hiệu chỉnh — luôn kèm nhãn nguồn)
  → FN-05 Vùng phục vụ (một bán kính duy nhất; HTX chồng lấn chỉ tính vào Hub gần nhất)
  → FN-06 Total Available → Collectable → Delivered Supply theo 3 mùa vụ
  → FN-07 Collection Cost
  → ★ MÔ PHỎNG LUỒNG RƠM THEO NGÀY (bổ sung ngoài BRD) — quyết định khối lượng từng chặng
  → FN-08 Transportation Cost theo TỪNG HTX + chọn phương thức + số chuyến + đội xe + lead time
  → FN-09 Peak Inventory (lấy từ mô phỏng) → diện tích kho/sân bãi → số máy ép kiện & xe nâng
  → FN-10 CAPEX (3 cấu phần) / OPEX (tách Warehouse ↔ Handling theo quyết định B8)
  → FN-11 Total Delivered Logistics Cost & Cost per Ton
  → FN-12 TCO · TCO per Ton · ROI · Payback Period
  ⟂ FN-17 No-Hub Baseline (Ruộng → Nhà máy) làm mẫu số đối chứng
  ⟂ FN-18 Phân tích độ nhạy one-at-a-time + biểu đồ tornado
```

Các quyết định nghiệp vụ B1–B8 của v1.3 được hiện thực đúng nguyên văn:

- **B1** — `Total Delivered Logistics Cost` **không** gồm giá mua rơm.
- **B2** — `TCO per Ton` là cột xếp hạng mặc định.
- **B3** — sản lượng lúa thống kê là **nguồn duy nhất**; tham số "Năng suất lúa bình quân" không tồn tại.
- **B4** — kịch bản = 1..n Hub; mọi chỉ số tài chính tổng hợp ở cấp kịch bản.
- **B5** — một bán kính phục vụ duy nhất, không vành đai đồng tâm; một bộ đơn giá thu gom cho toàn bán kính.
- **B6** — khoảng cách Ruộng→Hub tính theo **từng HTX**; bình quân gia quyền chỉ để hiển thị.
- **B7** — RBAC đã tách vai trò (vượt yêu cầu V1 một-role, nhưng giữ nguyên hành vi: quyền phê duyệt tham số và quyền đánh dấu "Chính thức" tách khỏi quyền dựng kịch bản).
- **B8** — Handling = nhân sự + bảo trì; Warehouse = điện/nhiên liệu + thuê mặt bằng + OPEX khác.

### Các chốt chặn nghiệp vụ đã cài đặt

| Quy tắc | Hành vi hệ thống |
| --- | --- |
| FN-01 BR-03 | Mỗi lần lưu tham số (kể cả phê duyệt) sinh một phiên bản bộ tham số mới; kịch bản đã lưu giữ nguyên phiên bản cũ. Thao tác **không làm dữ liệu đổi** — phê duyệt hàng loạt khi không còn gì chờ duyệt, hoặc duyệt lại đúng người đã duyệt — **không** sinh phiên bản rỗng |
| FN-01 BR-04 | **Chặn** đánh dấu "Chính thức" khi còn tham số giả định chưa phê duyệt, kèm danh sách cụ thể |
| FN-01 AC-06 | Từ chối giá trị ≤ 0 cho đơn giá/định mức/tải trọng, không lưu một phần |
| FN-02 AC-02 | Từ chối tạo Hub tại nơi không có dữ liệu vùng nguyên liệu |
| FN-02 BR-04 | Chặn xoá Hub đang dùng trong kịch bản đã mô phỏng, liệt kê kịch bản tham chiếu |
| FN-04 BR-04 | Mọi khoảng cách hiển thị kèm nhãn: *Định tuyến thực tế* / *Định tuyến trên tuyến số hoá nội bộ* / *Haversine hiệu chỉnh* |
| FN-05 BR-02 | HTX nằm trong nhiều bán kính chỉ tính vào Hub gần nhất — tổng sản lượng kịch bản không bị cộng trùng |
| FN-11 BR-04 | Delivered Supply = 0 → hiển thị "Không xác định", không chia cho 0 |
| FN-12 BR-03 | Cost/Ton ≥ baseline → "Không hoàn vốn", **không** hiển thị số âm |
| FN-14 BR-02 | Chặn so sánh kịch bản khác vòng đời hoặc khác chế độ chiết khấu |
| FN-14 BR-04 | Cảnh báo khi so sánh khác phiên bản bộ tham số + hành động "Tính lại theo bộ tham số hiện tại" |
| FN-15 BR-03 | Chưa chốt ngưỡng #48/#49 → **không** sinh kết luận "Nên/Không nên đầu tư" |
| FN-20 BR-03 | Chiều dài tuyến do hệ thống tính; API không nhận `length` từ client |
| FN-20 BR-04 | Chỉ tuyến "Đã xác nhận" tham gia định tuyến; tuyến "Nháp" bị loại |
| QT-03 (CGH) | Bản ghi Admin đã "khoá" không bị App HTX ghi đè |
| Warehouse | Ưu tiên xuất theo **rủi ro xuống cấp**, không theo FEFO |

---

## 4B. Kế hoạch vận chuyển hai phương thức & mô phỏng luồng rơm theo ngày

Đây là phần **bổ sung ngoài BRD v1.4**, hiện thực đúng phương án vận hành thực tế của
Mekong Green. Mã nguồn: `src/erp/simulation/flow.ts`.

### 4B.1 Hai phương thức vận chuyển

| | Trong mùa thu hoạch | Ngoài mùa thu hoạch |
| --- | --- | --- |
| Phương tiện | **Ghe 100 tấn** (chở ~90 tấn rơm rời — giới hạn bởi *thể tích*, không phải tải trọng) | **Sà lan 1.000 hoặc 2.000 tấn**, chở **đầy tải** |
| Chặng | Ruộng → Nhà máy (ưu tiên) và Ruộng → Hub (phần vượt) | Hub → Nhà máy |
| Quy tắc | Rơm gặt xong chở **thẳng** về nhà máy, trần đúng bằng **lượng tiêu thụ trong ngày**; phần vượt đưa về Hub | Sà lan chỉ rời bến khi gom **đủ một chuyến đầy**; chuyến non tải chỉ xảy ra khi *dọn kho cuối kỳ* và được **đếm riêng** |
| Xử lý tại Hub | Rơm về Hub được **băm và nén** → phát sinh chi phí `#55` và hao hụt riêng `#56` | — |

### 4B.2 Công suất Hub = tồn kho tối đa

Định nghĩa của `design_capacity_tons` đã đổi: đây là **lượng rơm tối đa Hub chứa được tại
một thời điểm** (tấn rơm đã băm/nén), không phải sản lượng thông qua hàng năm. Hệ quả:

- Rơm vượt sức chứa **không** được im lặng bỏ qua mà ghi nhận là *rơm phải bỏ lại tại ruộng*.
- Cảnh báo cấp Hub đổi nghĩa: `kho đầy N ngày/năm` (thiếu sức chứa) hoặc `chỉ dùng X% sức chứa`
  (đầu tư dư) — thay cho cảnh báo "thiếu hụt so với công suất thiết kế" cũ.

### 4B.3 Cách mô phỏng

1. **Dựng đường cong nguồn cung theo ngày** cho từng HTX. Ưu tiên **ngày thu hoạch thực tế**
   từ file điều tra vụ mùa (App Khuyến nông); vụ nào chưa có dữ liệu thì suy diễn cửa sổ
   `#57` ngày cuối tháng kết thúc vụ, phân bố hình thang. Nhãn nguồn (`thực tế` / `suy diễn`)
   hiển thị trên dashboard.
   *File điều tra ghi theo **đợt** (thường mỗi tuần), nên sản lượng mỗi đợt được trải đều ra
   khoảng thời gian nó đại diện — nếu để nguyên, mô hình sẽ thấy một đỉnh 26.000 tấn trong
   một ngày và kết luận sai rằng gần như không thể chở thẳng về nhà máy.*
2. **Chạy 730 ngày, chỉ lấy năm thứ hai.** Năm đầu là giai đoạn khởi động để tồn kho đầu kỳ
   phản ánh vận hành ổn định; nếu giả định Hub rỗng ngày 01/01 sẽ tạo một đợt thiếu hụt giả.
3. **Mỗi ngày**, theo thứ tự: (a) ghe chở thẳng về nhà máy, ưu tiên HTX gần nhà máy nhất, trần
   bằng tiêu thụ ngày; (b) phần vượt về Hub, trừ hao hụt băm/nén, chặn bởi sức chứa còn lại;
   (c) nhà máy tiêu thụ; (d) điều sà lan đầy tải từ Hub tồn kho lớn nhất khi lượng rơm chở
   thẳng dự kiến những ngày tới không đủ nuôi nhà máy.

### 4B.4 Kết quả mô phỏng thay thế heuristic cũ (đóng rủi ro RS-06)

FN-09 BR-02 dùng `Peak Inventory = Collectable cả năm × hệ số tồn kho cao điểm (#35)`, và BRD
tự ghi nhận đây là **rủi ro RS-06** cần thay bằng mô hình tồn kho thực ở Phase 2. Hệ thống nay
lấy **tồn kho cao nhất trong năm từ mô phỏng theo ngày** làm cơ sở tính diện tích kho và CAPEX;
`sizing.peakInventorySource` ghi rõ giá trị đến từ đâu, và heuristic cũ chỉ còn là đường lui khi
mô phỏng không chạy được.

Trên dữ liệu mẫu, khác biệt rất lớn: hệ số `#35 = 0,3` cho ra ~30.000 tấn/Hub, trong khi mô phỏng
cho tồn kho đỉnh chỉ 13.000 tấn — tức **kho đang được thiết kế dư khoảng 2,3 lần**.

### 4B.5 Tham số mở rộng (#50–#57)

BRD chốt đúng 49 tham số và FN-01 AC-03 kiểm tra con số đó, nên nhóm dưới đây nằm ở danh sách
riêng `FLOW_PARAMETER_EXTENSION`, không chèn vào bộ 49. Chúng vẫn thuộc nhóm *cần input giả định*
nên vẫn bị FN-01 BR-04 chặn cho tới khi được phê duyệt.

| # | Mã | Giá trị gốc | Ý nghĩa |
| --- | --- | --- | --- |
| 50 | `boat_registered_tons` | 100 tấn | Tải trọng đăng ký của ghe |
| 51 | `boat_straw_payload_tons` | 90 tấn | Rơm rời thực chở mỗi chuyến ghe |
| 52 | `barge_small_payload_tons` | 1.000 tấn | Sà lan nhỏ, chặng Hub→NM ngoài vụ |
| 53 | `barge_large_payload_tons` | 2.000 tấn | Sà lan lớn |
| 54 | `plant_operating_days` | 330 ngày | Cơ sở tính tiêu thụ mỗi ngày của nhà máy |
| 55 | `hub_processing_cost` | 120.000 đ/tấn | Băm và nén tại Hub |
| 56 | `hub_processing_loss_pct` | 2 % | Hao hụt riêng của khâu băm/nén |
| 57 | `harvest_window_days` | 45 ngày | Cửa sổ thu hoạch khi chưa có ngày thực tế |

Tải trọng sà lan cấu hình ở **cấp cặp Hub–Kịch bản** (`scenario_hubs.barge_payload_tons`), nên
cùng một Hub có thể chạy sà lan 1.000 tấn ở kịch bản này và 2.000 tấn ở kịch bản khác.

### 4B.6 Ảnh hưởng tới chi phí

Chặng vận chuyển tăng từ 2 lên **3**, khối lượng mỗi chặng do mô phỏng quyết định thay vì suy từ
hệ số:

| Chặng | Phương tiện | Khối lượng |
| --- | --- | --- |
| Ruộng → Nhà máy | Ghe 100 tấn | Phần chở thẳng, do trần tiêu thụ ngày quyết định |
| Ruộng → Hub | Ghe 100 tấn | Phần vượt trần tiêu thụ ngày |
| Hub → Nhà máy | Sà lan 1.000/2.000 tấn | Lượng thực xuất kho, theo số chuyến đầy tải mô phỏng đếm được |

Chi phí băm/nén chỉ áp cho phần rơm **thực sự đi qua Hub** — rơm chở thẳng không phát sinh khoản này.

---

## 5. Hai khoảng trống trong tài liệu — cần BA/Tài chính chốt

Khi hiện thực đúng nguyên văn công thức, hai vấn đề dưới đây lộ ra. Hệ thống **giữ nguyên công thức BRD** và bổ sung chỉ số phụ có nhãn rõ ràng, không tự ý sửa đặc tả.

### 5.1 TCO per Ton không so sánh được với cột No-Hub Baseline

- FN-12 BR-01: `TCO = CAPEX + Σ OPEX(t)`.
- FN-10 BR-03: `OPEX` chỉ gồm nhân sự + điện/nhiên liệu + bảo trì + thuê mặt bằng — **không** gồm Collection Cost và Transportation Cost.
- Hệ quả: phương án No-Hub (CAPEX = 0, OPEX Hub = 0) luôn có `TCO per Ton = 0` và luôn đứng đầu bảng xếp hạng, mâu thuẫn với FN-14 AC-04 vốn yêu cầu No-Hub là một cột so sánh có ý nghĩa.

**Đã xử lý:** giữ `TCO per Ton` đúng công thức BRD và làm cột xếp hạng mặc định (BR-03); bổ sung cột **"Chi phí vòng đời đầy đủ chuỗi / tấn"** = `CAPEX + Σ Total Delivered Logistics Cost(t)` — đây là cột duy nhất đối chiếu được Hub với No-Hub. Cột No-Hub được ghim cuối bảng kèm cảnh báo giải thích.

### 5.2 Mô hình tuyến tính theo tấn·km ước tính THẤP lợi ích của Hub

FN-08 BR-06 nêu rõ V1 không tính phí cố định mỗi chuyến, phí tối thiểu hay chi phí chiều rỗng. Trong mô hình đó, đưa rơm qua Hub luôn làm quãng đường dài hơn đi thẳng, nên **lợi ích kinh tế duy nhất của Hub là chuyển được chặng dài sang sà lan** (đơn giá đường thuỷ ~900 đ/tấn·km so với đường bộ ~2.200 đ/tấn·km).

Điều này ảnh hưởng trực tiếp tới việc chọn vị trí: chỉ Hub **tiếp giáp mạng lưới kênh rạch** mới kích hoạt được phương án sà lan (FN-08 BR-04). Trong dữ liệu mẫu, 5 Hub ứng viên được đặt trên sông Hậu / sông Tiền / Vàm Cỏ Đông đúng vì lý do này — và kết quả cho thấy `Transportation Cost` chặng Hub→Nhà máy giảm ~45% so với khi Hub nằm xa tuyến thuỷ.

**Khuyến nghị:** Logistics xác nhận mức sai lệch chấp nhận được của mô hình tuyến tính (BR-06 đã nêu là hạng mục cần xác nhận trước go-live); nếu lớn, bổ sung cấu phần phí cố định mỗi chuyến ở Phase 2 — khi đó lợi ích gom hàng của Hub mới phản ánh đúng.

**Cập nhật sau khi có mô hình dòng chảy (mục 4B):** mô phỏng theo ngày đã làm lộ ra giá trị thật
của Hub mà mô hình tấn·km không thấy được. Trên dữ liệu mẫu, nhà máy chỉ có rơm thu hoạch tại
ruộng trong **125/365 ngày**; 240 ngày còn lại hoàn toàn phụ thuộc tồn kho Hub. Phương án No-Hub
vì thế không chỉ đắt hơn — nó **không vận hành được**: nhà máy sẽ dừng máy suốt các tháng 1–3,
6, 9–10. Đây là lập luận đầu tư mạnh hơn nhiều so với chênh lệch đơn giá đường thuỷ, và nó chỉ
xuất hiện khi mô hình có trục thời gian.

Ngoài ra, phân tích độ nhạy được xếp hạng theo **chi phí vòng đời đầy đủ chuỗi/tấn** thay vì TCO/Ton: nếu dùng TCO/Ton, bốn tham số trọng yếu mà FN-18 BR-01 yêu cầu (#20, #21 đơn giá thu gom và #22, #23 đơn giá vận chuyển) sẽ luôn cho biên độ bằng 0 và biểu đồ tornado mất ý nghĩa.

---

## 6. Trạng thái dữ liệu nền

Dữ liệu seed là **dữ liệu MINH HOẠ** để hệ thống chạy được ngay. Theo Mục I.11 của BRD Simulation, các hạng mục sau phải được thay bằng dữ liệu thật trước khi dùng cho quyết định đầu tư:

| Hạng mục | Trạng thái seed | Rủi ro liên quan |
| --- | --- | --- |
| Ranh giới hành chính sau sáp nhập 2025 | Hộp bao minh hoạ cho 6 tỉnh | RS-09 |
| Toạ độ GPS từng HTX | Toạ độ gần đúng theo địa bàn | RS-02 |
| Sản lượng lúa theo HTX × mùa vụ | Số liệu minh hoạ | AS-16 |
| Mạng lưới kênh rạch cho sà lan | 7 tuyến chính vẽ theo trục sông thật, gắn nhãn "Số hoá nội bộ" | **RS-01 (cao nhất)**, AS-05 |
| Hệ số hiệu chỉnh khoảng cách | road 1.30 / waterway 1.45 | AS-06 |
| 24 tham số giả định | Có giá trị mặc định, **chưa phê duyệt** | RS-03 |
| Ngưỡng ROI (#48) & Payback (#49) | **Để trống có chủ ý** | AS-14, RS-08 |

Hai tham số #48/#49 để `null` là cố ý: đó là cách hệ thống thể hiện FN-15 BR-03 — chưa có ngưỡng thì không được sinh khuyến nghị đầu tư.

---

## 7. Truy vết chức năng

### AgriGreen Platform

| Mã | Chức năng | Vị trí |
| --- | --- | --- |
| GIS FN-01/02 | Tài khoản, cấu hình hiển thị dùng chung | `platform/auth`, `agrigreen/gis/service.ts` |
| GIS FN-03/04/05 | Danh sách & toạ độ HTX/Hub/thửa/kho | `mdm/service.ts` |
| GIS FN-06 | Ranh giới đa cấp + polygon thửa tải theo viewport | `gis/service.ts::buildMapBundle` |
| GIS FN-07/08 | Giao thông đường bộ / đường thuỷ (tải trọng, rộng, sâu) | `gis/waterways.ts` |
| GIS — Mạng lưới thuỷ | Nhận diện cấu trúc, dựng lại, công trình vượt sông | `gis/waterwayNetwork.ts` |
| GIS — Phương tiện | Kích thước ghe/sà lan, biên an toàn, điều kiện lưu thông | `platform/geo/vessels.ts` |
| GIS FN-10/11 | Thời tiết dự báo & cảnh báo nguy hiểm | `gis/service.ts::weatherLayer` |
| GIS FN-12 | Heatmap trạng thái mùa vụ (bảng màu cấu hình được) | `gis/service.ts::cropHeatmap` |
| GIS FN-13 | Cảnh báo sản lượng chín rộ 1–3 ngày | `gis/service.ts::harvestAlerts` |
| GIS FN-14 | Widget dung lượng kho trên marker | `gis/service.ts::capacityWidgets` |
| GIS FN-15/16 | Tiếp nhận dữ liệu & cấp bản đồ chuẩn hoá cho TMS | `gis/service.ts::ingest/publishStandardBundle` |
| Nhập Excel | Bộ đọc .xlsx tự viết (ZIP + XML) | `platform/io/zip.ts`, `platform/io/xlsx.ts` |
| Nhập Excel | Bảng tra địa danh & quy đổi địa giới 2025 | `mdm/gazetteer.ts` |
| Nhập Excel | Importer HTX + định vị + báo cáo kiểm tra | `mdm/import/cooperatives.ts` |
| Nhập Excel | Importer vụ mùa theo đơn vị hành chính | `mdm/import/cropSeason.ts` |
| GIS FN-17→20 | Event log · snapshot · replay · lưu trữ | `platform/audit/audit.ts` |
| GIS FN-21/22 | Nhật ký & retry đồng bộ, dead-letter | `platform/sync/sync.ts` |
| **Cổng Khuyến nông** | 10 màn hình chức năng riêng | `web/pages/kn.js` |
| **Cổng Hợp tác xã** | 8 màn hình chức năng riêng | `web/pages/htx.js` |
| **Cổng Cơ giới hoá** | 9 màn hình chức năng riêng | `web/pages/cgh.js` |
| Sàn cơ giới hoá | Dùng chung Cổng CGH ↔ Cổng HTX | `web/pages/rental.js` |
| Cấu hình cổng | Đường dẫn, nhận diện, nav từng cổng | `web/portals.js` |
| Quyền vào cổng | `portal.kn/htx/cgh/gis/erp` tách khỏi quyền dữ liệu | `platform/auth/rbac.ts` |
| Quản trị SA-01→07 | Tài khoản, nhóm, ma trận quyền chỉnh trực tiếp | `platform/auth/admin.ts` |
| Phân quyền động | Mặc định mã nguồn + ghi đè `group_permissions`, cache trong bộ nhớ | `platform/auth/rbac.ts::permissionsFor` |
| Màn hình quản trị | Tài khoản · Nhóm & phân quyền | `web/pages/sysadmin.js` |
| KN FN-03 | Cây tổ chức khuyến nông 3 cấp | `khuyennong/service.ts::orgTree` |
| KN FN-05 | Vẽ ranh giới thửa, hệ thống tự tính diện tích | `mdm/service.ts::createPlot` |
| KN FN-10→17 | Thư viện, nhiệm vụ, danh bạ, giá, đào tạo | `khuyennong/service.ts` |
| HTX FN-07→13 | Lô ruộng, GPS, vụ, nhật ký, sản lượng, hỗ trợ | `agrigreen/htx/service.ts` |
| HTX — Kế hoạch SX | Quy trình chuẩn, kế hoạch theo vụ, xác nhận bước, bằng chứng | `agrigreen/htx/production.ts` |
| HTX — Phân công | Gán công đoạn cho thành viên/máy, hai mô hình vận hành | `agrigreen/htx/assignment.ts` |
| HTX — Vật tư | Mua sắm, tồn kho theo lô, cấp phát xuống thửa | `agrigreen/htx/inputs.ts` |
| KN — Khảo sát | Mẫu khảo sát định kỳ/đột xuất, cây hành chính 3 cấp | `agrigreen/khuyennong/survey.ts` |
| KN — Hồ sơ HTX | Khởi tạo theo MST, kích hoạt thừa hưởng dữ liệu | `mdm/htxRegistry.ts` |
| HTX SYS-01 | Ghi nhận lịch sử toạ độ | `htx/service.ts::recordGps` |
| CGH FN-02→10 | Định mức, hồ sơ máy, cân đối, dự báo, báo cáo | `agrigreen/cgh/service.ts` |
| Sàn CGH | Tin đăng, vòng đời lệnh thuê, escrow, tranh chấp | `agrigreen/rental/service.ts` |

### ERP nội bộ

| Mã | Chức năng | Vị trí |
| --- | --- | --- |
| SIM FN-01 | 49 tham số, phân loại, phê duyệt, phiên bản | `erp/params/` |
| SIM FN-02→12, 17 | Toàn bộ lõi mô phỏng | `erp/simulation/engine.ts` |
| SIM FN-13→16, 18, 19 | Dashboard, so sánh, khuyến nghị, xuất báo cáo, độ nhạy, kết xuất Hub | `erp/simulation/service.ts` |
| SIM FN-20 | Số hoá & đo tuyến (GeoJSON/KML in/out) | `agrigreen/gis/waterways.ts` |
| WH FN-01→39 | Nhập/giám sát/xuất/kiểm kê/báo cáo/MRV/tích hợp | `erp/warehouse/service.ts` |
| PO / SO | Procure-to-Pay, Order-to-Cash, đối soát 3 chiều | `erp/procurement/`, `erp/sales/` |
| TMS | Routing đa tiêu chí, ePOD/e-bill, đối chiếu chi phí | `erp/tms/service.ts` |
| Hiện trường FM-01→08 | Đội, phương tiện, kế hoạch từ lịch gặt, phân công 2 lượt, ghi nhận 3 công đoạn, lượt ghe → chuyến TMS | `erp/field/service.ts` |
| **Cổng Hiện trường** | 5 màn hình riêng + TMS, GIS dùng chung | `web/pages/field.js` |
| Finance | AR/AP, Revenue Engine 3 mô hình, carbon 45/55, budget vs actual | `erp/finance/service.ts` |
| Reporting | Dashboard hợp nhất, xếp hạng kịch bản, xuất CSV/HTML in được | `erp/reporting/service.ts` |

---

## 8. Kiểm thử

`npm test` chạy 192 test viết theo đúng Acceptance Criteria của BRD, ví dụ:

- `FN-01 AC-03` — danh mục đúng 49 tham số, 23 thị trường / 24 giả định / 2 khác, không trùng/thiếu STT.
- `FN-05 AC-03` — vùng phục vụ chồng lấn: mỗi HTX chỉ xuất hiện ở đúng một Hub.
- `FN-08 AC-03` — đổi toạ độ của **một** HTX làm đổi Transportation Cost (chứng minh không dùng bình quân).
- `FN-11 AC-02` — Cost/Ton cấp kịch bản là bình quân **gia quyền theo sản lượng**, không phải bình quân số học.
- `FN-12 AC-04` — Cost/Ton ≥ baseline → "Không hoàn vốn", không trả số âm.
- `FN-20 AC-04` — sai số đo chiều dài geodesic ≤ 1%.
- Dòng chảy rơm — lượng chở thẳng Ruộng→Nhà máy **không vượt** tiêu thụ mỗi ngày của nhà máy.
- Dòng chảy rơm — **cân bằng vật chất**: thu gom = chở thẳng + về Hub + bỏ lại tại ruộng.
- Dòng chảy rơm — tồn kho mô phỏng **không bao giờ vượt** sức chứa Hub, ở mọi ngày trong 365 ngày.
- Dòng chảy rơm — sà lan chở đầy tải; chuyến non tải bị chặn cận trên và chỉ là dọn kho cuối kỳ.
- `RS-06` — Peak Inventory lấy từ mô phỏng theo ngày, không còn dùng hệ số ước lượng.
- Chi phí băm/nén chỉ áp cho phần rơm **đi qua Hub**.
- Sửa một ô cấu hình Hub **không** reset các ô còn lại về mặc định (lỗi hồi quy đã sửa).
- Mỗi cổng được gác bằng quyền `portal.*` riêng, không dùng quyền đọc dữ liệu làm cửa vào.
- `SA-01` — không thu hồi được quyền của nhóm quản trị nền tảng, kể cả khi ghi thẳng vào bảng ghi đè.
- `SA-03` — hạ cấp quản trị nền tảng cuối cùng bị chặn; hạ cấp khi còn người thứ hai thì cho qua.
- `SA-06` — khoá tài khoản xoá luôn phiên đang mở, và phiên còn sót không dùng lại được.
- Ghi đè quyền có hiệu lực **ngay** ở request kế tiếp, không cần khởi động lại.
- `FM-04` — gom nhiều hơn cuộn, xuống ghe nhiều hơn gom đều bị từ chối; báo cáo phản ánh đúng thứ tự giảm.
- `FM-05` — lượt xuống ghe sinh chuyến TMS đường thuỷ tham chiếu đúng việc, đúng số hiệu ghe, đúng tấn.
- Khai báo sản lượng trên App HTX tự sinh việc thu gom; vụ đã có việc từ lịch dự kiến thì **cập nhật**, không tạo việc thứ hai.
- Phân công tự động: việc 500 tấn "vừa" 85 tấn/ngày nếu chia 6 ngày — nhưng không cuộn xong trong hạn FM-02, nên đi vào nhóm ép xếp có cờ.
- Ba app nghiệp vụ đã tách cổng và mỗi cổng có ≥ 7 màn hình chức năng theo BRD.
- Ban quản lý HTX đọc được nội dung khuyến nông nhưng **không** vào được Cổng Khuyến nông.
- Mọi trang khai báo trong `portals.js` đều thực sự được đăng ký ở một module trang.
- Phê duyệt hàng loạt khi không còn tham số chờ duyệt **không** đẩy số phiên bản bộ tham số lên.
- Phê duyệt lại đúng người đã duyệt không sinh phiên bản, nhưng **đổi người** phê duyệt thì có.
- Kế hoạch sản xuất bung đúng lịch theo ngày xuống giống (offset âm/0/dương).
- Bước yêu cầu bằng chứng bị chặn khi thiếu **bất kỳ** loại bằng chứng nào.
- Lệch quá cửa sổ mà không ghi lý do bị chặn; ghi lý do thì qua nhưng **vẫn tính là không đúng hạn**.
- Thời gian cách ly sau phun thuốc chặn thu hoạch sớm đúng đến từng ngày.
- Quy trình đã ban hành không sửa được; bản sao chép giữ đủ bước và lên phiên bản 2.
- Xác nhận bước sinh đúng một bản ghi nhật ký trỏ ngược về bước kế hoạch.
- Chỉ rút được quy trình từ vụ **đã hoàn thành** và có dữ liệu (nhật ký hoặc kế hoạch).
- Rút từ vụ có kế hoạch: mốc thời gian tính lại theo thực tế, thuộc tính khác kế thừa nguyên vẹn.
- Rút từ vụ chỉ có nhật ký: **không bịa** thời gian cách ly hay bằng chứng, liệt kê rõ phần chưa suy ra được.
- Bản ghi nhật ký trùng ngày + trùng hoạt động được gộp thành một bước, có báo số lượng đã gộp.
- Quy trình rút ra dùng được cho vụ sau **sau khi ban hành**, lịch dịch đúng theo ngày sạ mới.
- Diện tích thửa do hệ thống tính; giá trị `areaHa` người dùng gửi lên bị bỏ qua.
- Vẽ lại đường bao thửa **đang canh tác** đổi ≥ 5% thì kèm cảnh báo ảnh hưởng thống kê.
- Mô hình "Thành viên chủ động" chặn giao việc nhân công cho người không phải chủ thửa,
  nhưng **vẫn** cho Ban quản trị điều phối máy móc dùng chung.
- Thửa chưa gán chủ thì mô hình 2 mất căn cứ — hệ thống cảnh báo thay vì im lặng.
- Một máy không được điều phối cho hai thửa trong cùng một ngày.
- Tồn kho vật tư tách theo lô; chặn cấp quá tồn, hết hạn, ngoài danh mục, sai HTX.
- Cấp thuốc sát ngày thu hoạch dự kiến thì cảnh báo vi phạm thời gian cách ly.
- Dropdown hành chính lọc dần đúng quan hệ cha–con; cây phủ đủ 6 tỉnh sau sáp nhập.
- Nhập lại phiếu khảo sát cùng đối tượng trong cùng kỳ là **cập nhật**, không tạo bản trùng.
- Kích hoạt HTX bằng MST thừa hưởng đúng số thửa/thành viên đã xem trước; không kích hoạt lại được.
- Một cây cầu tĩnh không thấp hạ tải trọng cả tuyến xuống mức ghe; gỡ cầu thì tuyến trở lại.
- Thiếu độ sâu thì **không** kết luận tải trọng — không gộp "chưa đo" vào "đi được".
- Kênh rộng đúng bằng thân tàu vẫn không qua được (biên an toàn có hiệu lực).
- Công trình đặt cách tuyến quá xa bị từ chối, không tạo ràng buộc ma.
- Phát hiện hai tuyến cắt nhau thiếu đỉnh và dựng lại làm giảm số cụm rời.
- Khe hở nhỏ nối được tự động, khe hở lớn bị bỏ qua **kèm lý do**, không nối bừa.
- Sà lan không được định tuyến qua tuyến nó không lọt, dù tuyến đó ngắn hơn.
- Phương tiện càng lớn thì số tuyến đi được càng ít — bất biến của bảng tổng hợp năng lực.
- Cổng mã truy cập chặn **cả API** chứ không chỉ giao diện; `/health` vẫn mở.
- Cookie cổng không chứa mã gốc; đổi mã là vô hiệu hoá mọi cookie đã phát.
- `QT-03` — bản ghi đã khoá không nhận đồng bộ từ App HTX.
- Quy đổi địa giới 2025 đúng cho cả 12 tỉnh cũ; huyện trùng tên chọn đúng tỉnh khai báo.
- Phát hiện huyện bị xếp nhầm tỉnh và gợi ý tỉnh đúng.
- Phân tán toạ độ là tất định — chạy lại import cho cùng vị trí.
- Quy đổi số sê-ri ngày Excel; mã vụ bắc cầu hai năm không trùng vụ liền trước.

---

## 9. Ghi chú kỹ thuật

- **0 dependency.** Chạy thẳng `.ts` bằng tính năng type-stripping của Node ≥ 22.6, dữ liệu trong `node:sqlite`. Vì vậy mã nguồn chỉ dùng cú pháp TypeScript "erasable" (không `enum`, không parameter property).
- **Bản đồ (TECH-01 — thay được nhà cung cấp):** Leaflet qua CDN. Mỗi loại lớp nền
  (Đường phố / Vệ tinh / Địa hình) khai báo **nhiều nguồn xếp theo thứ tự ưu tiên** tại
  `BASEMAP_PROVIDERS` trong `web/app.js`. Nếu nguồn ưu tiên không tải được ô nào — mạng
  nội bộ chặn hoặc không phân giải được tên miền — hệ thống **tự chuyển sang nguồn dự
  phòng** và cập nhật lại dòng ghi công cho khớp nguồn ảnh đang phục vụ, kèm thông báo
  cho người dùng. Thứ tự hiện tại:
  - Đường phố: OpenStreetMap → Esri World Street Map → CARTO Voyager
  - Vệ tinh: Esri World Imagery
  - Địa hình: Esri World Topo Map → OpenTopoMap

  Muốn dùng nhà cung cấp khác (Mapbox, VietMap, tile tự host) chỉ cần thêm một mục vào
  danh sách tương ứng. Khi Leaflet không tải được, bản đồ hiển thị thông báo dự phòng và
  mọi bảng số liệu vẫn hoạt động bình thường.
- **Xuất PDF:** báo cáo sinh ra HTML in được (`/api/sim/scenarios/:id/report.html`), người dùng dùng *In → Lưu thành PDF*. Không nhúng thư viện PDF để giữ nguyên tắc 0 dependency.
- **Cơ sở dữ liệu** nằm ở `data/mekonggreen.db`. Xoá file này rồi chạy `npm run seed` để khởi tạo lại từ đầu.
