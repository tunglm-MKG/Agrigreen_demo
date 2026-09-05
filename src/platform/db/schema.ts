/**
 * Lược đồ cơ sở dữ liệu hợp nhất cho toàn hệ sinh thái.
 *
 * Nguyên tắc thiết kế (AgriGreen ERP Product Vision v1.2, mục 3.2):
 *  - Một Master Data, nhiều phân hệ dùng chung: danh mục HTX / vùng trồng /
 *    thiết bị / Hub / kho / nhà máy / đối tác nằm ở bảng dùng chung, không
 *    phân hệ nào giữ bản sao riêng.
 *  - Multi-site & multi-entity từ ngày đầu: Hub / Kho / Nhà máy đều là danh mục
 *    mở rộng được, không hard-code một dòng.
 *  - Mọi phân hệ đều audit-trail: bảng `event_log` append-only là nguồn sự thật.
 */
import { all, db } from './db.ts';

export function migrate(): void {
  db().exec(SCHEMA);
  applyColumnMigrations();
}

/**
 * Bổ sung cột cho bảng đã tồn tại.
 *
 * `CREATE TABLE IF NOT EXISTS` không thêm cột vào bảng cũ, nên các cột phát
 * sinh sau khi hệ thống đã chạy phải được thêm bằng ALTER TABLE có kiểm tra.
 */
function applyColumnMigrations(): void {
  const additions: { table: string; column: string; definition: string }[] = [
    // Kích cỡ sà lan dùng cho chặng Hub→Nhà máy ngoài mùa thu hoạch (1000/2000 tấn).
    { table: 'scenario_hubs', column: 'barge_payload_tons', definition: 'REAL' },
    // Nhật ký canh tác nay có thể là XÁC NHẬN một bước trong kế hoạch sản xuất.
    // Để trống nghĩa là hoạt động phát sinh ngoài kế hoạch — vẫn ghi nhận được.
    { table: 'farm_logs', column: 'plan_step_id', definition: 'TEXT' },
    // Truy vết nguồn gốc: quy trình được rút ra từ vụ canh tác nào.
    { table: 'production_protocols', column: 'source_crop_cycle_id', definition: 'TEXT' },
    // Tuyến đường thuỷ: tải trọng SUY RA từ thông số kỹ thuật, kèm mức tin cậy.
    // max_load_tons cũ là số nhập tay; hai cột này là kết quả hệ thống tính.
    { table: 'transport_routes', column: 'derived_max_load_tons', definition: 'REAL' },
    { table: 'transport_routes', column: 'derived_vessel_code', definition: 'TEXT' },
    { table: 'transport_routes', column: 'derived_certainty', definition: 'TEXT' },
    { table: 'transport_routes', column: 'derived_at', definition: 'TEXT' },
    // Định danh pháp lý HTX + mô hình vận hành + nguồn gốc hồ sơ.
    // UNIQUE không thêm được bằng ALTER nên ràng buộc trùng MST do service kiểm.
    { table: 'cooperatives', column: 'tax_code', definition: 'TEXT' },
    { table: 'cooperatives', column: 'operating_model', definition: "TEXT NOT NULL DEFAULT 'tap_trung'" },
    { table: 'cooperatives', column: 'origin', definition: "TEXT NOT NULL DEFAULT 'htx'" },
    { table: 'cooperatives', column: 'claimed_at', definition: 'TEXT' },
    { table: 'cooperatives', column: 'claimed_by', definition: 'TEXT' },
  ];
  for (const addition of additions) {
    const columns = all<{ name: string }>(`PRAGMA table_info(${addition.table})`);
    if (!columns.length) continue;
    if (columns.some((column) => column.name === addition.column)) continue;
    db().exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`);
  }
}

const SCHEMA = /* sql */ `
-- =====================================================================
-- 0. NỀN TẢNG: tài khoản, phân quyền, nhật ký
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  must_change_pw  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | locked | pending
  org_node_id     TEXT,                             -- vị trí trên cây tổ chức khuyến nông
  htx_id          TEXT,                             -- HTX liên kết (App HTX BR-02)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL,
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =====================================================================
-- NHÓM NGƯỜI DÙNG VÀ PHÂN QUYỀN ĐỘNG
--
-- Ma trận RBAC gốc nằm trong mã nguồn (rbac.ts) và là baseline. Hai bảng dưới
-- đây cho phép quản trị viên điều chỉnh mà không phải sửa mã và triển khai lại:
--
--   user_groups        Nhóm do quản trị viên tạo thêm, ngoài các vai trò hệ thống.
--   group_permissions  Ghi đè quyền cho MỘT nhóm: cấp thêm hoặc thu hồi bớt.
--
-- Lưu dạng GHI ĐÈ thay vì lưu trọn bộ quyền hiệu lực là có chủ đích: khi mã
-- nguồn bổ sung quyền mới cho một vai trò hệ thống, vai trò đó nhận được ngay,
-- thay vì đứng yên ở ảnh chụp cũ. Bù lại, giao diện phải chỉ rõ ô nào là mặc
-- định và ô nào đã bị ghi đè — nếu không người dùng sẽ không hiểu vì sao quyền
-- tự đổi sau một lần cập nhật hệ thống.
-- =====================================================================

CREATE TABLE IF NOT EXISTS user_groups (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  -- Nhóm hệ thống (định nghĩa trong rbac.ts) không xoá và không đổi tên được;
  -- chỉ được ghi đè quyền. Nhóm tuỳ chỉnh thì sửa xoá thoải mái.
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_permissions (
  group_code  TEXT NOT NULL,
  permission  TEXT NOT NULL,
  -- 1 = cấp thêm so với mặc định; 0 = thu hồi so với mặc định.
  granted     INTEGER NOT NULL,
  changed_by  TEXT,
  changed_at  TEXT NOT NULL,
  PRIMARY KEY (group_code, permission)
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- GIS FN-17: nhật ký sự kiện append-only cho MỌI lớp dữ liệu.
CREATE TABLE IF NOT EXISTS event_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  TEXT NOT NULL,
  actor_id     TEXT,
  actor_name   TEXT,
  module       TEXT NOT NULL,       -- gis | simulation | warehouse | htx | ...
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  action       TEXT NOT NULL,       -- create | update | delete | approve | export | sync
  before_json  TEXT,
  after_json   TEXT,
  source       TEXT,                -- ui | api | integration | system
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_log_day ON event_log(substr(occurred_at, 1, 10));
CREATE INDEX IF NOT EXISTS idx_event_log_entity ON event_log(entity_type, entity_id);

-- GIS FN-18: snapshot trạng thái toàn hệ thống theo ngày.
CREATE TABLE IF NOT EXISTS daily_snapshots (
  snapshot_date TEXT NOT NULL,
  layer         TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  record_count  INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, layer)
);

-- GIS FN-20: chính sách lưu trữ & dọn dẹp dữ liệu lịch sử.
CREATE TABLE IF NOT EXISTS retention_policy (
  id                    TEXT PRIMARY KEY,
  event_log_days        INTEGER NOT NULL DEFAULT 730,
  snapshot_days         INTEGER NOT NULL DEFAULT 365,
  compact_after_days    INTEGER NOT NULL DEFAULT 90,
  updated_at            TEXT NOT NULL
);

-- GIS FN-21/FN-22: nhật ký & retry đồng bộ tích hợp.
CREATE TABLE IF NOT EXISTS sync_log (
  id             TEXT PRIMARY KEY,
  system         TEXT NOT NULL,     -- app_htx | ban_do_cgh | erp | tms
  direction      TEXT NOT NULL,     -- inbound | outbound
  dataset        TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  record_count   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,     -- success | failed | dead_letter | retrying
  attempt        INTEGER NOT NULL DEFAULT 1,
  next_retry_at  TEXT,
  error_message  TEXT,
  payload_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_log(status, next_retry_at);

-- =====================================================================
-- 1. MASTER DATA & CONFIGURATION HUB
-- =====================================================================

CREATE TABLE IF NOT EXISTS admin_units (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  -- province | commune | ap  (đơn vị hành chính sau sáp nhập 2025; ap = thôn/ấp/khóm)
  level       TEXT NOT NULL,
  parent_id   TEXT,
  boundary    TEXT,                 -- GeoJSON Polygon
  centroid_lat REAL,
  centroid_lng REAL
);

CREATE TABLE IF NOT EXISTS cooperatives (       -- Danh mục HTX (dùng chung)
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,          -- Mã HTX: hệ thống tự sinh (CGH BR-01)
  name           TEXT NOT NULL,
  province_id    TEXT,
  commune_id     TEXT,
  address        TEXT,
  contact_name   TEXT,
  contact_phone  TEXT,
  lat            REAL,
  lng            REAL,
  boundary       TEXT,                          -- GeoJSON Polygon (ranh giới vùng HTX)
  registered_area_ha REAL DEFAULT 0,            -- diện tích đăng ký hành chính (KHÁC diện tích canh tác theo vụ)
  member_count   INTEGER DEFAULT 0,
  -- Mã số thuế: định danh pháp lý duy nhất của HTX. Khuyến nông khởi tạo hồ sơ
  -- kèm MST; khi HTX kích hoạt tài khoản và điền đúng MST thì nhận lại toàn bộ
  -- dữ liệu đã có sẵn trên CSDL dùng chung (thửa ruộng, thành viên, vụ...).
  tax_code       TEXT UNIQUE,
  -- tap_trung            = Ban quản trị phân công việc cho thành viên
  -- thanh_vien_chu_dong  = thành viên tự chủ trên thửa của mình; Ban quản trị
  --                        chỉ điều phối máy móc, thiết bị dùng chung
  operating_model TEXT NOT NULL DEFAULT 'tap_trung',
  origin         TEXT NOT NULL DEFAULT 'htx',   -- htx | khuyennong
  claimed_at     TEXT,
  claimed_by     TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS farmers (            -- Hồ sơ nông hộ
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  national_id   TEXT,
  htx_id        TEXT NOT NULL,
  address       TEXT,
  reliability_score REAL DEFAULT 0,             -- điểm tin cậy 1-5 (Requirement nhóm 9)
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS plots (              -- Thửa ruộng / lô ruộng (GIS polygon)
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT,
  htx_id       TEXT NOT NULL,
  farmer_id    TEXT,
  boundary     TEXT,                            -- GeoJSON Polygon do cán bộ/nông dân vẽ
  area_ha      REAL NOT NULL DEFAULT 0,         -- hệ thống TỰ TÍNH từ polygon
  centroid_lat REAL,
  centroid_lng REAL,
  soil_type    TEXT,
  status       TEXT NOT NULL DEFAULT 'chua_mo_vu', -- chua_mo_vu | dang_canh_tac | da_hoan_thanh_vu
  source       TEXT NOT NULL DEFAULT 'app_htx',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS seasons (            -- Danh mục mùa vụ (Đông Xuân / Hè Thu / Thu Đông)
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  year        INTEGER NOT NULL,
  start_month INTEGER NOT NULL,
  end_month   INTEGER NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- Sản lượng lúa thống kê theo HTX × mùa vụ.
-- Simulation FN-06 BR-01 (quyết định B3): đây là NGUỒN DUY NHẤT của Total Available Supply.
CREATE TABLE IF NOT EXISTS harvest_statistics (
  id             TEXT PRIMARY KEY,
  htx_id         TEXT NOT NULL,
  season_id      TEXT NOT NULL,
  planted_area_ha REAL NOT NULL DEFAULT 0,      -- chỉ để hiển thị/đối chiếu (tham số #4)
  paddy_tons     REAL NOT NULL DEFAULT 0,       -- tham số #5
  source         TEXT NOT NULL DEFAULT 'gso',
  recorded_at    TEXT NOT NULL,
  UNIQUE (htx_id, season_id),
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (season_id) REFERENCES seasons(id)
);

CREATE TABLE IF NOT EXISTS facilities (         -- Hub / Kho / Bãi / Nhà máy đầu ra (multi-site)
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,                  -- hub | warehouse | yard | plant
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  province_id   TEXT,
  capacity_tons REAL DEFAULT 0,
  current_stock_tons REAL DEFAULT 0,
  annual_demand_tons REAL DEFAULT 0,            -- tham số #12 cho nhà máy đầu ra
  status        TEXT NOT NULL DEFAULT 'active', -- draft | active | closed
  origin_scenario_id TEXT,                      -- FN-19: Hub chuyển từ kịch bản sang vận hành
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_zones (      -- Khu vực lưu trữ trong một bãi/kho
  id           TEXT PRIMARY KEY,
  facility_id  TEXT NOT NULL,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  zone_type    TEXT NOT NULL DEFAULT 'covered', -- outdoor | covered | closed | container
  capacity_tons REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (facility_id) REFERENCES facilities(id)
);

CREATE TABLE IF NOT EXISTS partners (           -- Đối tác mua / NCC / tổ chức kiểm định
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- customer | vendor | vvb | buyer
  tax_code    TEXT,
  contact     TEXT,
  address     TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS items (              -- Item master (rơm theo loại, dược liệu, vật tư)
  id        TEXT PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  uom       TEXT NOT NULL DEFAULT 'tấn',
  category  TEXT NOT NULL DEFAULT 'straw'
);

CREATE TABLE IF NOT EXISTS machine_types (      -- Danh mục chủng loại máy (CGH FN-02)
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  stage         TEXT NOT NULL,                  -- khâu sản xuất: tự gán theo chủng loại
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS machine_owners (     -- Hồ sơ chủ sở hữu máy (CGH FN-04)
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,             -- Mã CSH tự sinh
  name        TEXT NOT NULL,
  owner_type  TEXT NOT NULL,                    -- thanh_vien_htx | htx | doanh_nghiep | khac
  htx_id      TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS machines (           -- Hồ sơ máy móc - thiết bị (CGH FN-05)
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,         -- Mã máy tự sinh
  machine_type_id TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  htx_id          TEXT,
  brand           TEXT,
  model           TEXT,
  serial_number   TEXT,
  chassis_number  TEXT,
  year_made       INTEGER,
  capacity_ha_per_season REAL DEFAULT 0,
  condition       TEXT NOT NULL DEFAULT 'hoat_dong', -- hoat_dong | bao_tri | hong | ngung_hoat_dong
  condition_source TEXT NOT NULL DEFAULT 'nhap_tay', -- app_htx | nhap_tay  (QT-03)
  condition_locked INTEGER NOT NULL DEFAULT 0,       -- bản ghi Admin đã "khóa" (QT-03 mục 3)
  condition_updated_at TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (machine_type_id) REFERENCES machine_types(id),
  FOREIGN KEY (owner_id) REFERENCES machine_owners(id)
);

-- CGH FN-02c: định mức năng suất (ha/máy/vụ) do DCRD ban hành, có ngày hiệu lực.
CREATE TABLE IF NOT EXISTS productivity_norms (
  id               TEXT PRIMARY KEY,
  machine_type_id  TEXT NOT NULL,
  stage            TEXT NOT NULL,
  ha_per_machine_season REAL NOT NULL,
  effective_from   TEXT NOT NULL,
  effective_to     TEXT,
  document_ref     TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (machine_type_id) REFERENCES machine_types(id)
);

-- CGH: diện tích canh tác & lịch mùa vụ theo vùng × vụ (nguồn App HTX, fallback nhập tay).
CREATE TABLE IF NOT EXISTS cultivation_plans (
  id           TEXT PRIMARY KEY,
  htx_id       TEXT NOT NULL,
  season_id    TEXT NOT NULL,
  area_ha      REAL NOT NULL DEFAULT 0,
  stage_start  TEXT,
  stage_end    TEXT,
  source       TEXT NOT NULL DEFAULT 'nhap_tay', -- app_htx | nhap_tay
  locked       INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  UNIQUE (htx_id, season_id)
);

-- Dữ liệu vụ mùa theo ĐƠN VỊ HÀNH CHÍNH (xã/phường), nhập từ file điều tra của
-- Chi cục Trồng trọt & BVTV. Khác cultivation_plans (theo HTX) ở chỗ đơn vị
-- quan sát là địa giới hành chính, nên dùng được cả khi chưa map được về HTX.
CREATE TABLE IF NOT EXISTS commune_crop_seasons (
  id             TEXT PRIMARY KEY,
  season_id      TEXT NOT NULL,
  province_code  TEXT,
  province_name  TEXT,
  district       TEXT,
  commune        TEXT NOT NULL,
  area_ha        REAL NOT NULL DEFAULT 0,
  sowing_date    TEXT,
  -- khai_bao = có trong file; suy_ra = tính ngược từ ngày thu hoạch
  sowing_date_source TEXT,
  harvest_date   TEXT,
  yield_dry_tons_per_ha REAL,
  output_tons    REAL,
  rice_variety   TEXT,
  lat            REAL,
  lng            REAL,
  geocode_precision TEXT,
  source_file    TEXT,
  updated_at     TEXT NOT NULL,
  -- Hai huyện khác nhau trong cùng tỉnh có thể có xã trùng tên.
  UNIQUE (season_id, province_code, district, commune)
);

-- Tiến độ thu hoạch theo từng mốc ngày (file điều tra ghi nhiều đợt trong vụ).
CREATE TABLE IF NOT EXISTS commune_harvest_progress (
  id                TEXT PRIMARY KEY,
  commune_season_id TEXT NOT NULL,
  as_of_date        TEXT NOT NULL,
  area_ha           REAL NOT NULL DEFAULT 0,
  yield_dry_tons_per_ha REAL,
  output_tons       REAL NOT NULL DEFAULT 0,
  UNIQUE (commune_season_id, as_of_date),
  FOREIGN KEY (commune_season_id) REFERENCES commune_crop_seasons(id) ON DELETE CASCADE
);

-- =====================================================================
-- 2. GIS DÙNG CHUNG
-- =====================================================================

CREATE TABLE IF NOT EXISTS gis_layers (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,        -- base | infrastructure | natural | dynamic
  visible_default INTEGER NOT NULL DEFAULT 1,
  min_zoom    INTEGER NOT NULL DEFAULT 0,
  max_zoom    INTEGER NOT NULL DEFAULT 22,
  style_json  TEXT
);

-- GIS FN-07 (đường bộ) & FN-08 (đường thủy) + Simulation FN-20 (tuyến tự số hóa).
CREATE TABLE IF NOT EXISTS transport_routes (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  mode           TEXT NOT NULL,       -- road | waterway
  road_class     TEXT,                -- FN-07: phân loại đường bộ
  max_load_tons  REAL,                -- FN-07/FN-08: tải trọng tối đa
  width_m        REAL,                -- FN-08: chiều rộng lòng kênh
  depth_m        REAL,                -- FN-08: độ sâu
  clearance_m    REAL,                -- tĩnh không cầu
  geometry       TEXT NOT NULL,       -- GeoJSON LineString
  length_m       REAL NOT NULL,       -- hệ thống tự tính (FN-20 BR-03: không cho nhập tay)
  data_source    TEXT NOT NULL DEFAULT 'so_hoa_noi_bo', -- so_hoa_noi_bo | chinh_thuc | osm
  status         TEXT NOT NULL DEFAULT 'nhap',          -- nhap | da_xac_nhan (FN-20 BR-04)
  -- Tải trọng SUY RA từ rộng/sâu/tĩnh không, khác max_load_tons nhập tay.
  derived_max_load_tons REAL,
  derived_vessel_code   TEXT,
  derived_certainty     TEXT,
  derived_at            TEXT,
  province_id    TEXT,
  note           TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- =====================================================================
-- CÔNG TRÌNH VƯỢT SÔNG TRÊN TUYẾN ĐƯỜNG THUỶ
--
-- Cầu, cống, âu thuyền là ràng buộc ĐIỂM trên tuyến: cả tuyến rộng và sâu tới
-- đâu cũng vô nghĩa nếu có một cây cầu tĩnh không 4 m chắn ngang. Tách bảng
-- riêng vì một tuyến có nhiều công trình, và tĩnh không thấp nhất trong số đó
-- mới là con số quyết định sà lan nào qua được.
-- =====================================================================

CREATE TABLE IF NOT EXISTS waterway_structures (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  route_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'cau',   -- cau | cong | au_thuyen | duong_day_dien
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  -- Tĩnh không thông thuyền (m), đo từ mực nước cao nhất thiết kế.
  clearance_height_m REAL,
  -- Khẩu độ khoang thông thuyền (m) — hẹp hơn lòng kênh ở vị trí cầu.
  clearance_width_m  REAL,
  -- Độ sâu luồng ngay tại công trình, thường cạn hơn do bồi lắng chân trụ.
  depth_m       REAL,
  survey_date   TEXT,
  data_source   TEXT NOT NULL DEFAULT 'khao_sat',  -- khao_sat | ho_so_thiet_ke | uoc_luong
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (route_id) REFERENCES transport_routes(id) ON DELETE CASCADE
);

-- FN-04 BR-05: cache khoảng cách theo cặp toạ độ, kèm ngày tính và nguồn tính.
CREATE TABLE IF NOT EXISTS distance_cache (
  id          TEXT PRIMARY KEY,      -- hash(from, to, mode)
  from_lat    REAL NOT NULL,
  from_lng    REAL NOT NULL,
  to_lat      REAL NOT NULL,
  to_lng      REAL NOT NULL,
  mode        TEXT NOT NULL,         -- road | waterway
  distance_km REAL NOT NULL,
  source      TEXT NOT NULL,         -- routing_thuc_te | tuyen_so_hoa_noi_bo | haversine_hieu_chinh
  computed_at TEXT NOT NULL
);

-- GIS FN-10/FN-11: thời tiết dự báo & cảnh báo.
CREATE TABLE IF NOT EXISTS weather_observations (
  id           TEXT PRIMARY KEY,
  area_id      TEXT NOT NULL,        -- admin_units.id
  observed_for TEXT NOT NULL,        -- ngày
  rainfall_mm  REAL,
  humidity_pct REAL,
  temp_c       REAL,
  kind         TEXT NOT NULL DEFAULT 'forecast', -- forecast | realtime
  severity     TEXT,                 -- null | canh_bao | nguy_hiem
  headline     TEXT,
  received_at  TEXT NOT NULL
);

-- GIS FN-12/FN-13: trạng thái mùa vụ & cảnh báo sản lượng (nhận từ App HTX).
CREATE TABLE IF NOT EXISTS crop_status (
  id             TEXT PRIMARY KEY,
  htx_id         TEXT NOT NULL,
  season_id      TEXT NOT NULL,
  stage          TEXT NOT NULL,      -- lam_dat | gieo_sa | sinh_truong | chin | thu_hoach | sau_thu_hoach
  expected_harvest_date TEXT,
  expected_yield_tons REAL DEFAULT 0,
  straw_tons     REAL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  UNIQUE (htx_id, season_id)
);

-- =====================================================================
-- 3. APP KHUYẾN NÔNG
-- =====================================================================

CREATE TABLE IF NOT EXISTS org_nodes (          -- Cây tổ chức khuyến nông 3 cấp (FN-03)
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  level      TEXT NOT NULL,          -- trung_uong | tinh | xa | to_knc?
  parent_id  TEXT,
  admin_unit_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_articles ( -- FN-10/FN-11: thư viện kỹ thuật & tin tức
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- quy_trinh | tai_lieu | tin_tuc
  summary      TEXT,
  body         TEXT,
  crop         TEXT,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | published | archived
  scope_node_id TEXT,
  published_at TEXT,
  author_id    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tasks (      -- FN-14: nhiệm vụ hỗ trợ (tự sinh từ App HTX)
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  htx_id        TEXT,
  farmer_id     TEXT,
  plot_id       TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  category      TEXT NOT NULL DEFAULT 'ky_thuat', -- ky_thuat | sau_benh | thiet_bi | khac
  priority      TEXT NOT NULL DEFAULT 'binh_thuong',
  status        TEXT NOT NULL DEFAULT 'moi',       -- moi | tiep_nhan | dang_xu_ly | hoan_thanh | dong
  assignee_id   TEXT,
  origin        TEXT NOT NULL DEFAULT 'app_htx',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolution    TEXT
);

CREATE TABLE IF NOT EXISTS extension_officers ( -- FN-15: danh bạ trực hỗ trợ
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  full_name   TEXT NOT NULL,
  phone       TEXT NOT NULL,
  org_node_id TEXT NOT NULL,
  specialty   TEXT,
  on_duty     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS market_prices (      -- FN-16/FN-17: giá cả thị trường
  id          TEXT PRIMARY KEY,
  commodity   TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT 'VNĐ/kg',
  price       REAL NOT NULL,
  price_date  TEXT NOT NULL,
  region      TEXT,
  source      TEXT,
  UNIQUE (commodity, price_date, region)
);

CREATE TABLE IF NOT EXISTS training_courses (   -- FN-12: quản trị đào tạo ToT
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  location    TEXT,
  org_node_id TEXT,
  capacity    INTEGER DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'planned'
);

CREATE TABLE IF NOT EXISTS training_enrollments (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL,
  trainee_name TEXT NOT NULL,
  htx_id     TEXT,
  phone      TEXT,
  status     TEXT NOT NULL DEFAULT 'registered',
  FOREIGN KEY (course_id) REFERENCES training_courses(id)
);

-- =====================================================================
-- 4. APP HỢP TÁC XÃ
-- =====================================================================

CREATE TABLE IF NOT EXISTS crop_cycles (        -- FN-10: khai báo mở vụ mới
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  plot_id        TEXT NOT NULL,
  season_id      TEXT NOT NULL,
  variety        TEXT,
  sowing_date    TEXT,
  expected_harvest_date TEXT,
  area_ha        REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'dang_canh_tac', -- dang_canh_tac | da_hoan_thanh_vu
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (plot_id) REFERENCES plots(id),
  FOREIGN KEY (season_id) REFERENCES seasons(id)
);

CREATE TABLE IF NOT EXISTS farm_logs (          -- FN-11: nhật ký canh tác (+ AWD cho MRV)
  id            TEXT PRIMARY KEY,
  crop_cycle_id TEXT NOT NULL,
  log_date      TEXT NOT NULL,
  activity      TEXT NOT NULL,      -- lam_dat | gieo_sa | bon_phan | phun_thuoc | tuoi | rut_nuoc_awd | thu_hoach
  detail        TEXT,
  input_name    TEXT,
  input_qty     REAL,
  input_uom     TEXT,
  photo_url     TEXT,
  lat           REAL,
  lng           REAL,
  recorded_by   TEXT,
  synced        INTEGER NOT NULL DEFAULT 1,   -- hỗ trợ offline-first
  created_at    TEXT NOT NULL,
  FOREIGN KEY (crop_cycle_id) REFERENCES crop_cycles(id)
);

-- =====================================================================
-- QUY TRÌNH SẢN XUẤT CHUẨN & KẾ HOẠCH SẢN XUẤT
--
-- Nhật ký canh tác trước đây là các bản ghi rời rạc: nông dân nhớ gì ghi nấy.
-- Cách đó không chứng minh được đã canh tác theo chuẩn nào, vì không có gì để
-- đối chiếu. Nay bổ sung hai lớp:
--
--   (1) QUY TRÌNH CHUẨN (VietGAP, SRP, hữu cơ...) — bản mẫu gồm các bước, mỗi
--       bước neo vào ngày xuống giống bằng số ngày lệch, có cửa sổ thời gian
--       cho phép, loại bằng chứng bắt buộc và điểm kiểm soát.
--   (2) KẾ HOẠCH SẢN XUẤT — bung quy trình ra thành lịch cụ thể cho MỘT vụ,
--       theo đúng ngày xuống giống của vụ đó.
--
-- Ghi nhật ký khi đó trở thành XÁC NHẬN một bước kế hoạch: có thể lệch ngày so
-- với dự kiến (kèm lý do) và phải đính bằng chứng nếu bước yêu cầu.
-- =====================================================================

CREATE TABLE IF NOT EXISTS production_protocols (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  standard      TEXT NOT NULL DEFAULT 'vietgap',  -- vietgap | srp | huu_co | noi_bo
  crop          TEXT NOT NULL DEFAULT 'lua',
  version       INTEGER NOT NULL DEFAULT 1,
  -- he_thong = quy trình chuẩn do Khuyến nông ban hành, mọi HTX dùng được;
  -- htx      = quy trình riêng của một HTX (thường sao chép rồi chỉnh).
  scope         TEXT NOT NULL DEFAULT 'he_thong',
  htx_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'nhap',     -- nhap | ban_hanh | ngung
  document_ref  TEXT,
  description   TEXT,
  source_protocol_id TEXT,
  -- Vụ canh tác đã hoàn thành mà quy trình này được rút ra từ đó (nếu có).
  source_crop_cycle_id TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (code, version),
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS protocol_steps (
  id            TEXT PRIMARY KEY,
  protocol_id   TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  activity      TEXT NOT NULL,          -- khớp FARM_ACTIVITIES của nhật ký
  stage         TEXT,                   -- giai đoạn sinh trưởng, chỉ để hiển thị
  -- Neo theo NGÀY XUỐNG GIỐNG của vụ: âm = trước khi sạ (làm đất), 0 = ngày sạ.
  offset_days   INTEGER NOT NULL DEFAULT 0,
  window_days   INTEGER NOT NULL DEFAULT 3,  -- lệch trong khoảng này coi là đúng hạn
  mandatory     INTEGER NOT NULL DEFAULT 1,
  -- Danh sách loại bằng chứng bắt buộc, JSON: ["anh_hien_truong","hoa_don_vat_tu"]
  evidence_kinds TEXT,
  -- Thời gian cách ly sau phun thuốc (ngày) — VietGAP bắt buộc với thuốc BVTV.
  phi_days      INTEGER,
  control_point TEXT,                   -- điểm kiểm soát / ngưỡng phải đạt
  instruction   TEXT,
  FOREIGN KEY (protocol_id) REFERENCES production_protocols(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS production_plans (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  crop_cycle_id    TEXT NOT NULL UNIQUE,   -- mỗi vụ chỉ có một kế hoạch đang hiệu lực
  protocol_id      TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,       -- ghim phiên bản tại thời điểm sinh kế hoạch
  anchor_date      TEXT NOT NULL,          -- ngày xuống giống dùng để tính lịch
  status           TEXT NOT NULL DEFAULT 'dang_thuc_hien', -- dang_thuc_hien | hoan_thanh | huy
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (crop_cycle_id) REFERENCES crop_cycles(id),
  FOREIGN KEY (protocol_id) REFERENCES production_protocols(id)
);

CREATE TABLE IF NOT EXISTS production_plan_steps (
  id               TEXT PRIMARY KEY,
  plan_id          TEXT NOT NULL,
  protocol_step_id TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  name             TEXT NOT NULL,
  activity         TEXT NOT NULL,
  stage            TEXT,
  planned_date     TEXT NOT NULL,
  window_days      INTEGER NOT NULL DEFAULT 3,
  mandatory        INTEGER NOT NULL DEFAULT 1,
  evidence_kinds   TEXT,
  phi_days         INTEGER,
  control_point    TEXT,
  instruction      TEXT,
  -- ke_hoach | da_thuc_hien | tre_han | bo_qua
  status           TEXT NOT NULL DEFAULT 'ke_hoach',
  actual_date      TEXT,
  deviation_days   INTEGER,
  deviation_reason TEXT,
  farm_log_id      TEXT,
  confirmed_by     TEXT,
  confirmed_at     TEXT,
  FOREIGN KEY (plan_id) REFERENCES production_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (farm_log_id) REFERENCES farm_logs(id)
);

CREATE TABLE IF NOT EXISTS plan_step_evidence (
  id            TEXT PRIMARY KEY,
  plan_step_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- anh_hien_truong | hoa_don_vat_tu | phieu_kiem_nghiem | ghi_chu | khac
  label         TEXT,
  file_name     TEXT,
  mime_type     TEXT,
  content       TEXT,            -- data URI hoặc ghi chú dạng văn bản
  lat           REAL,
  lng           REAL,
  captured_at   TEXT,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (plan_step_id) REFERENCES production_plan_steps(id) ON DELETE CASCADE
);

-- =====================================================================
-- PHÂN CÔNG CÔNG VIỆC THEO KẾ HOẠCH SẢN XUẤT
--
-- Một bước kế hoạch trên một thửa ruộng được giao cho thành viên HTX và/hoặc
-- máy móc. Hai mô hình vận hành HTX quyết định AI được giao việc cho ai:
--   tap_trung           — Ban quản trị phân công nhân lực và máy móc.
--   thanh_vien_chu_dong — thành viên tự làm trên thửa của mình; Ban quản trị
--                         chỉ điều phối máy móc, thiết bị dùng chung (drone...).
-- =====================================================================

CREATE TABLE IF NOT EXISTS plan_step_assignments (
  id             TEXT PRIMARY KEY,
  plan_step_id   TEXT NOT NULL,
  -- nhan_cong = giao cho người; may_moc = điều phối máy/thiết bị
  kind           TEXT NOT NULL,
  farmer_id      TEXT,
  machine_id     TEXT,
  role           TEXT,                    -- phu_trach | ho_tro | van_hanh_may
  planned_date   TEXT,
  hours          REAL,
  note           TEXT,
  -- da_giao | da_nhan | tu_choi | hoan_thanh | huy
  status         TEXT NOT NULL DEFAULT 'da_giao',
  responded_at   TEXT,
  decline_reason TEXT,
  assigned_by    TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (plan_step_id, farmer_id, machine_id),
  FOREIGN KEY (plan_step_id) REFERENCES production_plan_steps(id) ON DELETE CASCADE,
  FOREIGN KEY (farmer_id) REFERENCES farmers(id),
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);

-- =====================================================================
-- VẬT TƯ NÔNG NGHIỆP CỦA HTX: MUA SẮM → TỒN KHO → CẤP PHÁT
--
-- Khác hẳn module Procurement của ERP Mekong Green (mua rơm nguyên liệu).
-- Đây là chu trình nội bộ HTX cho phân bón và thuốc bảo vệ thực vật, gắn thẳng
-- vào thửa ruộng và bước kế hoạch để phục vụ truy xuất VietGAP: mỗi lần cấp
-- phát biết rõ lô vật tư nào, xuống thửa nào, cho bước nào.
-- =====================================================================

CREATE TABLE IF NOT EXISTS input_items (        -- Danh mục vật tư
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,             -- phan_bon | thuoc_bvtv | giong | khac
  uom           TEXT NOT NULL DEFAULT 'kg',
  active_ingredient TEXT,                  -- hoạt chất (thuốc BVTV)
  -- Thời gian cách ly bắt buộc của hoạt chất — dùng để kiểm tra VietGAP.
  phi_days      INTEGER,
  -- Nằm trong danh mục được phép sử dụng hay không (VietGAP bắt buộc kiểm tra).
  permitted     INTEGER NOT NULL DEFAULT 1,
  permit_ref    TEXT,
  htx_id        TEXT,                      -- NULL = danh mục dùng chung
  created_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS input_purchases (    -- Phiếu mua vật tư của HTX
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  htx_id        TEXT NOT NULL,
  supplier      TEXT,
  invoice_no    TEXT,
  purchase_date TEXT NOT NULL,
  -- nhap | da_nhan (đã nhập kho) | huy
  status        TEXT NOT NULL DEFAULT 'nhap',
  total_amount  REAL NOT NULL DEFAULT 0,
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id)
);

CREATE TABLE IF NOT EXISTS input_purchase_lines (
  id            TEXT PRIMARY KEY,
  purchase_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  batch_no      TEXT,
  expiry_date   TEXT,
  qty           REAL NOT NULL,
  unit_price    REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (purchase_id) REFERENCES input_purchases(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES input_items(id)
);

CREATE TABLE IF NOT EXISTS input_stock (        -- Tồn kho theo LÔ, không gộp
  id            TEXT PRIMARY KEY,
  htx_id        TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  batch_no      TEXT,
  expiry_date   TEXT,
  qty_on_hand   REAL NOT NULL DEFAULT 0,
  unit_cost     REAL NOT NULL DEFAULT 0,
  purchase_id   TEXT,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (item_id) REFERENCES input_items(id)
);

CREATE TABLE IF NOT EXISTS input_issues (       -- Phiếu cấp phát xuống thửa ruộng
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  htx_id        TEXT NOT NULL,
  stock_id      TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  plot_id       TEXT NOT NULL,
  crop_cycle_id TEXT,
  plan_step_id  TEXT,                      -- gắn với bước kế hoạch để truy xuất
  farmer_id     TEXT,                      -- người nhận vật tư
  qty           REAL NOT NULL,
  issue_date    TEXT NOT NULL,
  note          TEXT,
  issued_by     TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (htx_id) REFERENCES cooperatives(id),
  FOREIGN KEY (stock_id) REFERENCES input_stock(id),
  FOREIGN KEY (item_id) REFERENCES input_items(id),
  FOREIGN KEY (plot_id) REFERENCES plots(id)
);

-- =====================================================================
-- MẪU KHẢO SÁT THU THẬP DỮ LIỆU — App Khuyến nông
--
-- Khảo sát định kỳ (tuần/tháng) hoặc đột xuất. Mỗi phiếu trả lời gắn với hộ dân
-- hoặc HTX và địa chỉ hành chính chọn theo cấp: tỉnh → xã → thôn/ấp.
-- =====================================================================

CREATE TABLE IF NOT EXISTS survey_templates (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  purpose       TEXT,
  -- tuan | thang | dot_xuat
  frequency     TEXT NOT NULL DEFAULT 'dot_xuat',
  -- Phạm vi đối tượng: ho_dan | htx | ca_hai
  subject_scope TEXT NOT NULL DEFAULT 'ca_hai',
  org_node_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'nhap',   -- nhap | ban_hanh | ngung
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS survey_questions (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  code          TEXT NOT NULL,
  label         TEXT NOT NULL,
  -- text | number | date | select | multiselect | boolean
  kind          TEXT NOT NULL DEFAULT 'text',
  uom           TEXT,
  options       TEXT,                      -- JSON mảng lựa chọn
  required      INTEGER NOT NULL DEFAULT 0,
  help_text     TEXT,
  FOREIGN KEY (template_id) REFERENCES survey_templates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  template_id   TEXT NOT NULL,
  -- Kỳ khảo sát: 2026-W12 (tuần), 2026-04 (tháng), hoặc ngày với đợt đột xuất.
  period        TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,             -- ho_dan | htx
  farmer_id     TEXT,
  htx_id        TEXT,
  subject_name  TEXT NOT NULL,
  phone         TEXT,
  national_id   TEXT,
  tax_code      TEXT,
  province_id   TEXT,
  commune_id    TEXT,
  hamlet_id     TEXT,
  address_detail TEXT,
  lat           REAL,
  lng           REAL,
  -- Hai trường nghiệp vụ được hỏi ở mọi đợt khảo sát hiện trạng sản xuất.
  cycle_start_date TEXT,
  production_status TEXT,
  surveyed_at   TEXT NOT NULL,
  surveyed_by   TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (template_id, period, subject_kind, farmer_id, htx_id),
  FOREIGN KEY (template_id) REFERENCES survey_templates(id)
);

CREATE TABLE IF NOT EXISTS survey_answers (
  id            TEXT PRIMARY KEY,
  response_id   TEXT NOT NULL,
  question_id   TEXT NOT NULL,
  value_text    TEXT,
  value_number  REAL,
  FOREIGN KEY (response_id) REFERENCES survey_responses(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES survey_questions(id)
);

CREATE TABLE IF NOT EXISTS harvest_declarations ( -- FN-12: khai báo sản lượng sau thu hoạch
  id            TEXT PRIMARY KEY,
  crop_cycle_id TEXT NOT NULL,
  harvest_date  TEXT NOT NULL,
  paddy_tons    REAL NOT NULL DEFAULT 0,
  straw_tons    REAL NOT NULL DEFAULT 0,
  straw_state   TEXT,               -- rai_dong | da_cat | da_cuon_kien | san_sang_thu_gom
  moisture_pct  REAL,
  declared_by   TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (crop_cycle_id) REFERENCES crop_cycles(id)
);

CREATE TABLE IF NOT EXISTS gps_logs (           -- SYS-01: ghi nhận lịch sử toạ độ
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  context     TEXT NOT NULL,        -- ve_ranh_gioi | ghi_nhat_ky | xac_thuc_vi_tri
  ref_id      TEXT,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  REAL,
  captured_at TEXT NOT NULL
);

-- =====================================================================
-- 5. SÀN CƠ GIỚI HÓA (Rental Marketplace)
-- =====================================================================

CREATE TABLE IF NOT EXISTS rental_listings (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  machine_id     TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  price_per_ha   REAL NOT NULL DEFAULT 0,
  price_per_day  REAL NOT NULL DEFAULT 0,
  service_radius_km REAL NOT NULL DEFAULT 20,
  available_from TEXT,
  available_to   TEXT,
  status         TEXT NOT NULL DEFAULT 'active',  -- active | paused | closed
  created_at     TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);

CREATE TABLE IF NOT EXISTS rental_orders (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  listing_id     TEXT NOT NULL,
  renter_htx_id  TEXT NOT NULL,
  plot_id        TEXT,
  area_ha        REAL NOT NULL DEFAULT 0,
  scheduled_from TEXT NOT NULL,
  scheduled_to   TEXT NOT NULL,
  amount         REAL NOT NULL DEFAULT 0,
  platform_fee   REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'dat_lich', -- dat_lich | xac_nhan | thuc_hien | hoan_thanh | tranh_chap | huy
  escrow_status  TEXT NOT NULL DEFAULT 'chua_giu', -- chua_giu | dang_giu | da_giai_ngan | hoan_tien
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES rental_listings(id)
);

CREATE TABLE IF NOT EXISTS rental_disputes (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'mo',       -- mo | dang_xu_ly | dong
  resolution  TEXT,
  opened_by   TEXT,
  created_at  TEXT NOT NULL,
  closed_at   TEXT,
  FOREIGN KEY (order_id) REFERENCES rental_orders(id)
);

-- =====================================================================
-- 6. ERP — THAM SỐ MÔ PHỎNG & KỊCH BẢN ĐẦU TƯ
-- =====================================================================

-- FN-01: 49 tham số đầu vào, phân loại nguồn, min/base/max (chuẩn bị cho FN-18).
CREATE TABLE IF NOT EXISTS parameters (
  id             TEXT PRIMARY KEY,
  number         INTEGER NOT NULL UNIQUE,        -- STT 1..49
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  unit           TEXT,
  group_name     TEXT NOT NULL,
  classification TEXT NOT NULL,                  -- thi_truong | gia_dinh | khac
  value_base     REAL,
  value_min      REAL,
  value_max      REAL,
  text_value     TEXT,
  data_source    TEXT,                           -- BR-02: nguồn dữ liệu (nhóm thị trường)
  source_date    TEXT,
  approved_by    TEXT,                           -- BR-02: người phê duyệt (nhóm giả định)
  approved_at    TEXT,
  note           TEXT,
  updated_at     TEXT NOT NULL
);

-- FN-01 BR-03: mỗi lần lưu thay đổi tạo một phiên bản bộ tham số mới.
CREATE TABLE IF NOT EXISTS parameter_sets (
  id           TEXT PRIMARY KEY,
  version      INTEGER NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  note         TEXT,
  payload_json TEXT NOT NULL,                    -- snapshot toàn bộ 49 tham số
  checksum     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_hubs (      -- FN-02: Hub ứng viên
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  province_id TEXT,
  status      TEXT NOT NULL DEFAULT 'nhap',      -- nhap | da_mo_phong
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenarios (           -- FN-14: kịch bản đầu tư (1..n Hub)
  id                 TEXT PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT,
  plant_id           TEXT NOT NULL,              -- nhà máy đầu ra (VFT)
  parameter_set_version INTEGER,                 -- BR-03/BR-04
  lifecycle_years    INTEGER NOT NULL DEFAULT 10,
  discounted         INTEGER NOT NULL DEFAULT 0, -- FN-12 BR-05: chế độ chiết khấu
  status             TEXT NOT NULL DEFAULT 'tham_khao', -- tham_khao | chinh_thuc
  baseline_mode      TEXT NOT NULL DEFAULT 'no_hub',    -- no_hub | scenario | manual
  baseline_manual_cost_per_ton REAL,
  baseline_scenario_id TEXT,
  simulated_at       TEXT,
  created_by         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- FN-02 BR-03: cấu hình riêng theo cặp Hub–Kịch bản.
CREATE TABLE IF NOT EXISTS scenario_hubs (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL,
  hub_id           TEXT NOT NULL,
  service_radius_km REAL NOT NULL,
  design_capacity_tons REAL NOT NULL,
  mode_field_hub   TEXT NOT NULL DEFAULT 'auto', -- auto | road | waterway  (FN-08 BR-04c override)
  mode_hub_plant   TEXT NOT NULL DEFAULT 'auto',
  land_mode        TEXT NOT NULL DEFAULT 'mua',  -- mua | thue  (FN-10 BR-03)
  sort_order       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (scenario_id, hub_id),
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE,
  FOREIGN KEY (hub_id) REFERENCES candidate_hubs(id)
);

-- Kết quả mô phỏng đã lưu (TECH-05: truy vết quyết định đầu tư).
CREATE TABLE IF NOT EXISTS simulation_results (
  id            TEXT PRIMARY KEY,
  scenario_id   TEXT NOT NULL,
  parameter_set_version INTEGER NOT NULL,
  computed_at   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);

-- FN-18: kết quả phân tích độ nhạy.
CREATE TABLE IF NOT EXISTS sensitivity_results (
  id            TEXT PRIMARY KEY,
  scenario_id   TEXT NOT NULL,
  parameter_set_version INTEGER NOT NULL,
  computed_at   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  stale         INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);

-- FN-19: nhật ký kết xuất Hub sang Module Warehouse.
CREATE TABLE IF NOT EXISTS hub_handovers (
  id           TEXT PRIMARY KEY,
  scenario_id  TEXT NOT NULL,
  hub_id       TEXT NOT NULL,
  facility_id  TEXT,
  payload_json TEXT NOT NULL,
  exported_by  TEXT,
  exported_at  TEXT NOT NULL
);

-- =====================================================================
-- 7. ERP — VẬN HÀNH (PO / SO / WAREHOUSE / TMS / FINANCE)
-- =====================================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  htx_id        TEXT NOT NULL,
  facility_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  season_id     TEXT,
  ordered_tons  REAL NOT NULL,
  unit_price    REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'nhap',   -- nhap | duyet | dang_giao | hoan_thanh | huy
  expected_date TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  approved_by   TEXT,
  approved_at   TEXT
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  partner_id    TEXT NOT NULL,
  facility_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  ordered_tons  REAL NOT NULL,
  unit_price    REAL NOT NULL,
  delivery_date TEXT,
  status        TEXT NOT NULL DEFAULT 'nhap',   -- nhap | xac_nhan | dang_giao | da_giao | hoan_tat
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_notices (    -- WH FN-01: thông báo lô hàng đến từ TMS
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  facility_id   TEXT NOT NULL,
  po_id         TEXT,
  trip_id       TEXT,
  eta           TEXT,
  expected_tons REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'cho_den',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weighings (          -- WH FN-02/FN-14/FN-30: cân điện tử
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  facility_id  TEXT NOT NULL,
  direction    TEXT NOT NULL,        -- in | out
  vehicle_code TEXT,
  gross_kg     REAL NOT NULL,
  tare_kg      REAL NOT NULL,
  net_kg       REAL NOT NULL,
  device_id    TEXT,
  weighed_at   TEXT NOT NULL,
  ref_id       TEXT
);

CREATE TABLE IF NOT EXISTS goods_receipts (     -- WH FN-04: GRN
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  po_id         TEXT,
  facility_id   TEXT NOT NULL,
  zone_id       TEXT,
  htx_id        TEXT,
  plot_id       TEXT,
  season_id     TEXT,
  weighing_id   TEXT,
  received_tons REAL NOT NULL,
  variance_tons REAL NOT NULL DEFAULT 0,
  moisture_pct  REAL,
  impurity_pct  REAL,
  harvest_date  TEXT,
  origin_lat    REAL,
  origin_lng    REAL,
  status        TEXT NOT NULL DEFAULT 'cho_duyet', -- cho_duyet | da_duyet | tu_choi
  approved_by   TEXT,
  approved_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goods_issues (       -- WH FN-13: phiếu xuất kho
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  so_id        TEXT,
  facility_id  TEXT NOT NULL,
  issued_tons  REAL NOT NULL,
  weighing_id  TEXT,
  trip_id      TEXT,
  status       TEXT NOT NULL DEFAULT 'cho_duyet',
  approved_by  TEXT,
  approved_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_lots (         -- Lô tồn kho, gắn nguồn gốc MRV
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  facility_id   TEXT NOT NULL,
  zone_id       TEXT,
  grn_id        TEXT,
  htx_id        TEXT,
  plot_id       TEXT,
  item_id       TEXT,
  quantity_tons REAL NOT NULL,
  remaining_tons REAL NOT NULL,
  received_at   TEXT NOT NULL,
  moisture_pct  REAL,
  risk_score    REAL NOT NULL DEFAULT 0,  -- WH FN-12: điểm rủi ro xuống cấp
  status        TEXT NOT NULL DEFAULT 'ton'
);

CREATE TABLE IF NOT EXISTS env_readings (       -- WH FN-08/FN-31: cảm biến IoT
  id          TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL,
  zone_id     TEXT,
  sensor_id   TEXT NOT NULL,
  humidity_pct REAL,
  temp_c      REAL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_env_zone_time ON env_readings(zone_id, recorded_at);

CREATE TABLE IF NOT EXISTS env_thresholds (     -- WH FN-37
  id            TEXT PRIMARY KEY,
  facility_id   TEXT,
  humidity_warn REAL NOT NULL DEFAULT 18,
  humidity_crit REAL NOT NULL DEFAULT 22,
  temp_warn     REAL NOT NULL DEFAULT 40,
  temp_crit     REAL NOT NULL DEFAULT 55,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS env_alerts (         -- WH FN-10
  id          TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL,
  zone_id     TEXT,
  level       TEXT NOT NULL,        -- canh_bao | nguy_hiem
  metric      TEXT NOT NULL,        -- humidity | temperature
  value       REAL NOT NULL,
  threshold   REAL NOT NULL,
  message     TEXT NOT NULL,
  raised_at   TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE IF NOT EXISTS stocktakes (         -- WH FN-20..23
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  facility_id  TEXT NOT NULL,
  zone_id      TEXT,
  planned_for  TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'dinh_ky',
  status       TEXT NOT NULL DEFAULT 'ke_hoach', -- ke_hoach | dang_kiem | cho_duyet | da_duyet
  book_tons    REAL,
  counted_tons REAL,
  variance_tons REAL,
  reason       TEXT,
  approved_by  TEXT,
  approved_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (              -- TMS: chuyến vận chuyển
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  mode          TEXT NOT NULL,       -- road | waterway
  vehicle_code  TEXT,
  driver_name   TEXT,
  from_lat      REAL NOT NULL,
  from_lng      REAL NOT NULL,
  to_lat        REAL NOT NULL,
  to_lng        REAL NOT NULL,
  from_label    TEXT,
  to_label      TEXT,
  distance_km   REAL NOT NULL DEFAULT 0,
  planned_tons  REAL NOT NULL DEFAULT 0,
  actual_tons   REAL NOT NULL DEFAULT 0,
  planned_cost  REAL NOT NULL DEFAULT 0,
  actual_cost   REAL NOT NULL DEFAULT 0,
  co2_kg        REAL NOT NULL DEFAULT 0,
  departed_at   TEXT,
  arrived_at    TEXT,
  status        TEXT NOT NULL DEFAULT 'ke_hoach', -- ke_hoach | dang_chay | hoan_thanh | huy
  ref_type      TEXT,
  ref_id        TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_documents (     -- ePOD / e-bill
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- epod | ebill
  code       TEXT NOT NULL UNIQUE,
  signer     TEXT,
  signed_at  TEXT,
  payload_json TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (     -- Finance: AR/AP + doanh thu nền tảng
  id          TEXT PRIMARY KEY,
  entry_date  TEXT NOT NULL,
  account     TEXT NOT NULL,          -- AP | AR | REVENUE | EXPENSE | CAPEX
  partner_id  TEXT,
  htx_id      TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  facility_id TEXT,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'VND',
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'ghi_so',  -- ghi_so | da_thanh_toan | qua_han
  due_date    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue_rules (      -- Finance Revenue Engine
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- transaction_fee | subscription | carbon_share
  rate_pct     REAL,
  fixed_amount REAL,
  applies_to   TEXT,                  -- rental | straw_trade | carbon
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mrv_records (        -- Traceability & MRV Data Bridge
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  source_module TEXT NOT NULL,        -- warehouse | tms | po | so
  ref_type     TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  htx_id       TEXT,
  plot_id      TEXT,
  lat          REAL,
  lng          REAL,
  occurred_at  TEXT NOT NULL,
  quantity_tons REAL NOT NULL DEFAULT 0,
  co2_avoided_kg REAL NOT NULL DEFAULT 0,
  co2_emitted_kg REAL NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
`;
