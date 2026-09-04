/**
 * Nhập danh sách HTX/THT từ file Excel và tự động định vị trên bản đồ.
 *
 * Luồng: đọc file → nhận diện cột → quy đổi tỉnh cũ → tỉnh sau sáp nhập 2025 →
 * định vị theo huyện (hoặc tỉnh nếu thiếu huyện) → kiểm tra dữ liệu → ghi vào
 * danh mục HTX DÙNG CHUNG (bảng `cooperatives`), nơi App Khuyến nông, App HTX,
 * Bản đồ CGH, Simulation và Warehouse cùng đọc.
 *
 * Nguyên tắc: KHÔNG nhập mù. Mỗi dòng đều có kết luận (nhập / cảnh báo / bỏ
 * qua) kèm lý do, và toạ độ luôn mang nhãn ĐỘ CHÍNH XÁC để người dùng biết
 * dòng nào cần khảo sát GPS thực địa (rủi ro RS-02).
 */
import { all, insert, one, transaction, update } from '../../platform/db/db.ts';
import { nowIso, sequenceCode, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { cellNumber, cellText, readWorkbook, type Sheet } from '../../platform/io/xlsx.ts';
import {
  extractCommune, geocode, jitter, normalizeName, resolveProvince, stripAdminPrefix,
} from '../gazetteer.ts';

export type RowStatus = 'nhap_moi' | 'cap_nhat' | 'canh_bao' | 'bo_qua';

export interface CooperativeRowResult {
  sheetRow: number;
  name: string;
  declaredProvince: string | null;
  newProvince: string | null;
  district: string | null;
  commune: string | null;
  address: string | null;
  contactName: string | null;
  contactPhone: string | null;
  areaHa: number | null;
  lat: number | null;
  lng: number | null;
  geocodePrecision: 'huyen' | 'tinh' | null;
  matchedDistrict: string | null;
  /** Tỉnh sau sáp nhập được GỢI Ý khi huyện trong file không thuộc tỉnh khai báo. */
  suggestedProvince: string | null;
  status: RowStatus;
  issues: string[];
  code?: string;
}

export interface ImportReport {
  fileName: string;
  sheetName: string;
  dryRun: boolean;
  totalRows: number;
  inserted: number;
  updated: number;
  skipped: number;
  warned: number;
  /** Thống kê theo tỉnh sau sáp nhập. */
  byProvince: { province: string; count: number; declaredAs: string[] }[];
  /** Quy đổi địa giới đã thực hiện. */
  conversions: { from: string; to: string; count: number }[];
  geocodeQuality: { huyen: number; tinh: number; khong_dinh_vi: number };
  issueSummary: { issue: string; count: number }[];
  rows: CooperativeRowResult[];
}

/** Từ điển nhận diện cột — chấp nhận nhiều cách đặt tiêu đề khác nhau. */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['ten htx', 'ten hop tac xa', 'ten htx tht', 'ten don vi', 'ten to hop tac', 'htx'],
  address: ['xa', 'dia chi', 'xa phuong', 'ap xa', 'dia ban'],
  district: ['huyen', 'quan huyen', 'huyen thi', 'khu vuc', 'huyen tp'],
  province: ['tinh', 'tinh thanh', 'tinh thanh pho'],
  contactName: ['nguoi lien lac', 'nguoi dai dien', 'giam doc', 'chu nhiem', 'ho ten'],
  contactPhone: ['sdt', 'so dien thoai', 'dien thoai', 'phone'],
  areaHa: ['dien tich ha', 'dien tich', 'dt ha', 'dtxg ha', 'quy mo ha'],
  memberCount: ['so thanh vien', 'thanh vien', 'so ho', 'so nong ho'],
};

interface ColumnMap {
  headerRow: number;
  columns: Partial<Record<keyof typeof COLUMN_ALIASES, number>>;
}

/** Dò dòng tiêu đề và ánh xạ cột trong 15 dòng đầu của sheet. */
export function detectColumns(sheet: Sheet): ColumnMap | null {
  for (let rowIndex = 0; rowIndex < Math.min(15, sheet.rows.length); rowIndex += 1) {
    const row = sheet.rows[rowIndex] ?? [];
    const columns: ColumnMap['columns'] = {};
    row.forEach((cell, columnIndex) => {
      const header = normalizeName(cellText(cell));
      if (!header) return;
      for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (columns[field as keyof typeof COLUMN_ALIASES] !== undefined) continue;
        if (aliases.includes(header)) columns[field as keyof typeof COLUMN_ALIASES] = columnIndex;
      }
    });
    // Tối thiểu phải có cột tên HTX để coi là dòng tiêu đề hợp lệ.
    if (columns.name !== undefined) return { headerRow: rowIndex, columns };
  }
  return null;
}

export interface ImportOptions {
  fileName?: string;
  sheetName?: string;
  /** true = chỉ xem trước, không ghi vào CSDL. */
  dryRun?: boolean;
  /** Cập nhật HTX đã tồn tại (khớp theo tên + tỉnh) thay vì bỏ qua. */
  updateExisting?: boolean;
}

export function importCooperatives(
  buffer: Buffer,
  options: ImportOptions = {},
  actor: AuditActor = {},
): ImportReport {
  const workbook = readWorkbook(buffer);
  const sheet = options.sheetName ? workbook.sheet(options.sheetName) : workbook.sheets[0];
  if (!sheet) throw new Error('Không tìm thấy sheet dữ liệu trong file Excel.');

  const map = detectColumns(sheet);
  if (!map) {
    throw new Error(
      'Không nhận diện được cột "Tên HTX" trong file. Cần có dòng tiêu đề chứa một trong các nhãn: ' +
      COLUMN_ALIASES.name.join(', ') + '.',
    );
  }

  const { columns } = map;
  const rows: CooperativeRowResult[] = [];
  const conversions = new Map<string, { from: string; to: string; count: number }>();
  const provinceStats = new Map<string, { count: number; declaredAs: Set<string> }>();

  // Tỉnh hiện hành khi file dùng dòng nhóm ("Tỉnh An Giang") thay vì cột Tỉnh.
  let groupProvince: ReturnType<typeof resolveProvince> = null;
  let groupProvinceRaw = '';

  for (let rowIndex = map.headerRow + 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const row = sheet.rows[rowIndex] ?? [];
    const name = cellText(row[columns.name!]);
    if (!name) continue;

    // Dòng nhóm tỉnh: có tên bắt đầu bằng "Tỉnh"/"Thành phố" và bỏ trống địa chỉ + huyện.
    const looksLikeGroup = /^(tỉnh|thành phố|tp\.?)\s+/i.test(name)
      && !cellText(row[columns.address ?? -1])
      && !cellText(row[columns.district ?? -1]);
    if (looksLikeGroup) {
      groupProvinceRaw = name.replace(/^(tỉnh|thành phố|tp\.?)\s+/i, '').trim();
      groupProvince = resolveProvince(groupProvinceRaw);
      continue;
    }

    const declaredProvinceRaw = columns.province !== undefined
      ? cellText(row[columns.province]) || groupProvinceRaw
      : groupProvinceRaw;
    const province = columns.province !== undefined && cellText(row[columns.province])
      ? resolveProvince(cellText(row[columns.province]))
      : groupProvince;

    const address = cellText(row[columns.address ?? -1]) || null;
    const district = cellText(row[columns.district ?? -1]) || null;
    const issues: string[] = [];

    const result: CooperativeRowResult = {
      sheetRow: rowIndex + 1,
      name,
      declaredProvince: declaredProvinceRaw || null,
      newProvince: province?.newProvince ?? null,
      district,
      commune: address ? extractCommune(address) : null,
      address,
      contactName: cellText(row[columns.contactName ?? -1]) || null,
      contactPhone: normalizePhone(cellText(row[columns.contactPhone ?? -1])),
      areaHa: cellNumber(row[columns.areaHa ?? -1]),
      lat: null,
      lng: null,
      geocodePrecision: null,
      matchedDistrict: null,
      suggestedProvince: null,
      status: 'nhap_moi',
      issues,
    };

    if (!province) {
      result.status = 'bo_qua';
      issues.push(declaredProvinceRaw
        ? `Không quy đổi được tỉnh "${declaredProvinceRaw}" sang địa giới sau sáp nhập 2025.`
        : 'Không xác định được tỉnh của dòng này (thiếu cột Tỉnh và không có dòng nhóm tỉnh phía trên).');
      rows.push(result);
      continue;
    }

    if (province.converted) {
      const key = `${province.declared}→${province.newProvince}`;
      const entry = conversions.get(key) ?? { from: province.declared, to: province.newProvince, count: 0 };
      entry.count += 1;
      conversions.set(key, entry);
    }

    // ---- Định vị ----
    const located = geocode(district ?? '', declaredProvinceRaw, province.newCode);
    const spread = jitter(located.lat, located.lng, `${name}|${district ?? ''}`, rowIndex);
    result.lat = spread.lat;
    result.lng = spread.lng;
    result.geocodePrecision = located.precision;
    result.matchedDistrict = located.matchedDistrict;

    if (located.precision === 'tinh') {
      issues.push(district
        ? `Không tra được huyện "${district}" — tạm đặt tại trung tâm tỉnh ${province.newProvince}, cần khảo sát GPS.`
        : `Dòng không có thông tin huyện/xã — tạm đặt tại trung tâm tỉnh ${province.newProvince}, cần khảo sát GPS.`);
    }
    if (located.districtProvinceMismatch) {
      // Tên huyện là bằng chứng cụ thể hơn dòng nhóm tỉnh, nên toạ độ lấy theo
      // huyện; tỉnh vẫn giữ như file khai báo và hệ thống GỢI Ý tỉnh đúng để
      // người dùng quyết định — không tự ý xếp lại tỉnh.
      const suggested = resolveProvince(located.actualOldProvince ?? '');
      result.suggestedProvince = suggested?.newProvince ?? null;
      issues.push(
        `Huyện "${district}" thuộc tỉnh ${located.actualOldProvince} chứ không phải ${province.declared} như file ghi. ` +
        `Toạ độ đặt theo huyện; gợi ý xếp HTX này vào ${suggested?.newProvince ?? 'tỉnh tương ứng'} — cần xác nhận với file nguồn.`,
      );
    }
    if (result.areaHa !== null && result.areaHa <= 0) {
      issues.push('Diện tích ≤ 0 — bỏ qua giá trị diện tích.');
      result.areaHa = null;
    }
    if (result.contactPhone && !/^0\d{9,10}$/.test(result.contactPhone)) {
      issues.push(`Số điện thoại "${result.contactPhone}" không đúng định dạng 10–11 số.`);
    }

    // ---- Trùng lặp ----
    const existing = one<{ id: string; code: string }>(
      'SELECT id, code FROM cooperatives WHERE lower(name) = lower(?) AND province_id = (SELECT id FROM admin_units WHERE code = ?)',
      [name, province.newCode],
    );
    if (existing) {
      result.code = existing.code;
      result.status = options.updateExisting ? 'cap_nhat' : 'bo_qua';
      if (!options.updateExisting) issues.push(`Đã tồn tại HTX cùng tên trong ${province.newProvince} (${existing.code}).`);
    } else if (issues.length) {
      result.status = 'canh_bao';
    }

    const stat = provinceStats.get(province.newProvince) ?? { count: 0, declaredAs: new Set<string>() };
    stat.count += 1;
    if (province.declared) stat.declaredAs.add(province.declared);
    provinceStats.set(province.newProvince, stat);

    rows.push(result);
  }

  // ---- Ghi dữ liệu ----
  let inserted = 0;
  let updated = 0;
  if (!options.dryRun) {
    transaction(() => {
      const provinceIds = new Map(
        all<{ id: string; code: string }>('SELECT id, code FROM admin_units').map((u) => [u.code, u.id]),
      );
      let sequence = one<{ n: number }>('SELECT COUNT(*) AS n FROM cooperatives')?.n ?? 0;

      for (const row of rows) {
        if (row.status === 'bo_qua') continue;
        const resolution = resolveProvince(row.declaredProvince ?? '');
        const provinceId = resolution ? provinceIds.get(resolution.newCode) ?? null : null;
        const timestamp = nowIso();

        if (row.status === 'cap_nhat' && row.code) {
          const target = one<{ id: string }>('SELECT id FROM cooperatives WHERE code = ?', [row.code]);
          if (!target) continue;
          update('cooperatives', target.id, {
            province_id: provinceId,
            address: row.address,
            contact_name: row.contactName,
            contact_phone: row.contactPhone,
            lat: row.lat,
            lng: row.lng,
            registered_area_ha: row.areaHa ?? 0,
            updated_at: timestamp,
          });
          updated += 1;
          continue;
        }

        sequence += 1;
        const code = sequenceCode('HTX', sequence, 5);
        insert('cooperatives', {
          id: uuid(),
          code,
          name: row.name,
          province_id: provinceId,
          commune_id: null,
          address: row.address,
          contact_name: row.contactName,
          contact_phone: row.contactPhone,
          lat: row.lat,
          lng: row.lng,
          boundary: null,
          registered_area_ha: row.areaHa ?? 0,
          member_count: 0,
          status: 'active',
          created_at: timestamp,
          updated_at: timestamp,
        });
        row.code = code;
        inserted += 1;
      }
    });

    logEvent(
      {
        module: 'mdm',
        entityType: 'cooperatives',
        action: 'create',
        after: { source: options.fileName ?? 'excel', inserted, updated, total: rows.length },
        source: 'ui',
        note: 'Nhập danh sách HTX từ Excel',
      },
      actor,
    );
  }

  const issueSummary = new Map<string, number>();
  for (const row of rows) {
    for (const issue of row.issues) {
      // Gom nhóm theo mẫu câu, bỏ phần tên riêng để thống kê gọn.
      const key = issue.replace(/"[^"]*"/g, '"…"');
      issueSummary.set(key, (issueSummary.get(key) ?? 0) + 1);
    }
  }

  return {
    fileName: options.fileName ?? 'khong-ro-ten.xlsx',
    sheetName: sheet.name,
    dryRun: Boolean(options.dryRun),
    totalRows: rows.length,
    inserted,
    updated,
    skipped: rows.filter((r) => r.status === 'bo_qua').length,
    warned: rows.filter((r) => r.issues.length > 0 && r.status !== 'bo_qua').length,
    byProvince: [...provinceStats.entries()]
      .map(([province, stat]) => ({ province, count: stat.count, declaredAs: [...stat.declaredAs] }))
      .sort((a, b) => b.count - a.count),
    conversions: [...conversions.values()].sort((a, b) => b.count - a.count),
    geocodeQuality: {
      huyen: rows.filter((r) => r.geocodePrecision === 'huyen').length,
      tinh: rows.filter((r) => r.geocodePrecision === 'tinh').length,
      khong_dinh_vi: rows.filter((r) => r.geocodePrecision === null).length,
    },
    issueSummary: [...issueSummary.entries()]
      .map(([issue, count]) => ({ issue, count }))
      .sort((a, b) => b.count - a.count),
    rows,
  };
}

/**
 * Chuẩn hoá số điện thoại.
 *
 * Excel thường lưu SĐT dưới dạng SỐ nên số 0 đứng đầu bị mất ("0782977704" →
 * 782977704). Hàm này khôi phục số 0 đó và cắt mã quốc gia 84 nếu có.
 */
function normalizePhone(value: string): string | null {
  if (!value) return null;
  let digits = value.replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('84') && digits.length >= 11) digits = `0${digits.slice(2)}`;
  if (!digits.startsWith('0') && (digits.length === 9 || digits.length === 10)) digits = `0${digits}`;
  return digits;
}
