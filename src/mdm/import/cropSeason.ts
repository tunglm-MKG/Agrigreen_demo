/**
 * Nhập dữ liệu vụ mùa theo đơn vị hành chính từ file điều tra Excel.
 *
 * Hỗ trợ hai bố cục thường gặp trong file của Chi cục Trồng trọt & BVTV:
 *
 *  A. Bảng phẳng — mỗi dòng là một xã/phường, các cột: Xã | Huyện | Diện tích
 *     gieo sạ | Ngày xuống giống | Ngày thu hoạch | Năng suất | Sản lượng…
 *
 *  B. Bảng chéo tiến độ — mỗi dòng là một xã, phía trên lặp lại nhiều khối
 *     "NGÀY THU HOẠCH" với ngày ở dòng kế tiếp và 3 cột con
 *     (Diện tích / NS khô / Sản lượng) cho từng đợt thu hoạch trong vụ.
 *
 * Khi file KHÔNG có cột ngày xuống giống, hệ thống suy ra từ ngày thu hoạch
 * theo thời gian sinh trưởng của vụ và gắn nhãn `suy_ra` — không trình bày
 * giá trị suy diễn như số liệu khai báo.
 */
import { all, insert, one, run, transaction } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';
import { cellDate, cellNumber, cellText, readWorkbook, type Sheet } from '../../platform/io/xlsx.ts';
import { geocode, jitter, normalizeName, resolveProvince, stripAdminPrefix } from '../gazetteer.ts';

/**
 * Thời gian sinh trưởng bình quân theo vụ (ngày) — dùng để suy ngược ngày
 * xuống giống khi file chỉ có ngày thu hoạch.
 */
const GROWTH_DAYS: Record<string, number> = { DX: 100, HT: 95, TD: 95 };

export interface CommuneSeasonRow {
  sheetRow: number;
  commune: string;
  district: string | null;
  provinceName: string | null;
  provinceCode: string | null;
  areaHa: number | null;
  sowingDate: string | null;
  sowingDateSource: 'khai_bao' | 'suy_ra' | null;
  harvestDate: string | null;
  yieldDryTonsPerHa: number | null;
  outputTons: number | null;
  riceVariety: string | null;
  lat: number | null;
  lng: number | null;
  geocodePrecision: 'huyen' | 'tinh' | null;
  /** Các mốc thu hoạch trong vụ (bố cục B). */
  progress: { asOfDate: string; areaHa: number; yieldDryTonsPerHa: number | null; outputTons: number }[];
  status: 'nhap_moi' | 'cap_nhat' | 'canh_bao' | 'bo_qua';
  issues: string[];
}

export interface CropSeasonReport {
  fileName: string;
  sheetName: string;
  layout: 'bang_phang' | 'bang_cheo_tien_do';
  dryRun: boolean;
  season: { id: string; code: string; name: string; created: boolean };
  defaultProvince: string | null;
  totalRows: number;
  inserted: number;
  updated: number;
  skipped: number;
  totals: { areaHa: number; outputTons: number; communes: number; harvestMilestones: number };
  sowingDateCoverage: { khai_bao: number; suy_ra: number; khong_co: number };
  issueSummary: { issue: string; count: number }[];
  rows: CommuneSeasonRow[];
}

const ALIASES = {
  commune: ['xa phuong', 'xa', 'phuong', 'ten xa', 'don vi', 'dia phuong'],
  district: ['huyen', 'khu vuc', 'huyen thi', 'quan huyen'],
  province: ['tinh', 'tinh thanh'],
  area: ['dtxg ha', 'dtxg', 'dien tich gieo sa', 'dien tich gieo trong', 'dien tich ha', 'dien tich', 'tong dt ha'],
  sowing: ['ngay xuong giong', 'ngay gieo sa', 'ngay sa', 'ngay gieo trong', 'thoi gian xuong giong'],
  harvest: ['ngay thu hoach', 'ngay du kien thu hoach', 'thoi gian thu hoach'],
  yieldDry: ['ns kho', 'nang suat kho', 'nang suat', 'ns'],
  output: ['san luong', 'san luong tan', 'san luong lua'],
  variety: ['giong lua', 'giong', 'co cau giong'],
};

/** Suy tên/mã vụ từ tên sheet hoặc tên file ("ĐX2526" → Đông Xuân 2025-2026). */
export function detectSeason(hint: string): { code: string; name: string; kind: string; year: number } | null {
  const text = normalizeName(hint);
  const match = /(dx|ht|td)\s*(\d{2})\s*(\d{2})?/.exec(text.replace(/\s+/g, ' '));
  if (!match) return null;
  const kind = match[1].toUpperCase();
  const startYear = 2000 + Number(match[2]);
  const label = { DX: 'Đông Xuân', HT: 'Hè Thu', TD: 'Thu Đông' }[kind] ?? kind;
  // Vụ Đông Xuân bắc cầu hai năm nên mã phải chứa cả hai, tránh trùng với vụ
  // Đông Xuân của niên vụ liền trước (ĐX2425 và ĐX2526 là hai vụ khác nhau).
  const endYear = match[3] ? 2000 + Number(match[3]) : null;
  const name = endYear ? `${label} ${startYear}-${endYear}` : `${label} ${startYear}`;
  const code = endYear ? `${kind}-${startYear}-${endYear}` : `${kind}-${startYear}`;
  return { code, name, kind, year: startYear };
}

export interface CropSeasonOptions {
  fileName?: string;
  sheetName?: string;
  dryRun?: boolean;
  /** Mã vụ ghi đè; nếu bỏ trống hệ thống tự suy từ tên sheet/file. */
  seasonCode?: string;
  /** Tỉnh mặc định khi file không có cột tỉnh (file điều tra thường của một tỉnh). */
  defaultProvince?: string;
}

export function importCropSeason(
  buffer: Buffer,
  options: CropSeasonOptions = {},
  actor: AuditActor = {},
): CropSeasonReport {
  const workbook = readWorkbook(buffer);
  const sheet = options.sheetName
    ? workbook.sheet(options.sheetName)
    : pickBestSheet(workbook.sheets);
  if (!sheet) throw new Error('Không tìm thấy sheet dữ liệu vụ mùa trong file Excel.');

  // ---- Xác định vụ ----
  const hint = options.seasonCode ?? `${sheet.name} ${options.fileName ?? ''}`;
  const detected = detectSeason(hint) ?? detectSeason(options.fileName ?? '');
  if (!detected) {
    throw new Error(
      'Không xác định được mùa vụ từ tên sheet/file. Hãy chọn vụ thủ công (ví dụ mã "DX-2025") ' +
      'hoặc đặt tên sheet theo dạng "ĐX2526".',
    );
  }
  const season = ensureSeason(detected, Boolean(options.dryRun));

  const provinceResolution = options.defaultProvince ? resolveProvince(options.defaultProvince) : null;

  const layout = detectLayout(sheet);
  const rows = layout === 'bang_cheo_tien_do'
    ? parseProgressLayout(sheet, provinceResolution, detected.kind)
    : parseFlatLayout(sheet, provinceResolution, detected.kind);

  // ---- Ghi dữ liệu ----
  let inserted = 0;
  let updated = 0;
  if (!options.dryRun) {
    transaction(() => {
      for (const row of rows) {
        if (row.status === 'bo_qua') continue;
        const existing = one<{ id: string }>(
          `SELECT id FROM commune_crop_seasons WHERE season_id = ?
             AND COALESCE(province_code, '') = ? AND COALESCE(district, '') = ? AND commune = ?`,
          [season.id, row.provinceCode ?? '', row.district ?? '', row.commune],
        );
        const id = existing?.id ?? uuid();
        const record = {
          id,
          season_id: season.id,
          province_code: row.provinceCode,
          province_name: row.provinceName,
          district: row.district,
          commune: row.commune,
          area_ha: row.areaHa ?? 0,
          sowing_date: row.sowingDate,
          sowing_date_source: row.sowingDateSource,
          harvest_date: row.harvestDate,
          yield_dry_tons_per_ha: row.yieldDryTonsPerHa,
          output_tons: row.outputTons,
          rice_variety: row.riceVariety,
          lat: row.lat,
          lng: row.lng,
          geocode_precision: row.geocodePrecision,
          source_file: options.fileName ?? null,
          updated_at: nowIso(),
        };
        if (existing) {
          run('DELETE FROM commune_crop_seasons WHERE id = ?', [id]);
          updated += 1;
        } else {
          inserted += 1;
        }
        insert('commune_crop_seasons', record);

        for (const milestone of row.progress) {
          insert('commune_harvest_progress', {
            id: uuid(),
            commune_season_id: id,
            as_of_date: milestone.asOfDate,
            area_ha: milestone.areaHa,
            yield_dry_tons_per_ha: milestone.yieldDryTonsPerHa,
            output_tons: milestone.outputTons,
          });
        }
      }
    });

    logEvent(
      {
        module: 'khuyennong',
        entityType: 'commune_crop_seasons',
        action: 'create',
        after: { season: season.code, file: options.fileName, inserted, updated, layout },
        note: 'Nhập dữ liệu vụ mùa theo đơn vị hành chính từ Excel',
      },
      actor,
    );
  }

  const issueSummary = new Map<string, number>();
  for (const row of rows) {
    for (const issue of row.issues) {
      const key = issue.replace(/"[^"]*"/g, '"…"');
      issueSummary.set(key, (issueSummary.get(key) ?? 0) + 1);
    }
  }

  return {
    fileName: options.fileName ?? 'khong-ro-ten.xlsx',
    sheetName: sheet.name,
    layout,
    dryRun: Boolean(options.dryRun),
    season: { id: season.id, code: season.code, name: season.name, created: season.created },
    defaultProvince: provinceResolution?.newProvince ?? null,
    totalRows: rows.length,
    inserted,
    updated,
    skipped: rows.filter((r) => r.status === 'bo_qua').length,
    totals: {
      areaHa: round(rows.reduce((sum, r) => sum + (r.areaHa ?? 0), 0)),
      outputTons: round(rows.reduce((sum, r) => sum + (r.outputTons ?? 0), 0)),
      communes: rows.filter((r) => r.status !== 'bo_qua').length,
      harvestMilestones: rows.reduce((sum, r) => sum + r.progress.length, 0),
    },
    sowingDateCoverage: {
      khai_bao: rows.filter((r) => r.sowingDateSource === 'khai_bao').length,
      suy_ra: rows.filter((r) => r.sowingDateSource === 'suy_ra').length,
      khong_co: rows.filter((r) => !r.sowingDateSource).length,
    },
    issueSummary: [...issueSummary.entries()].map(([issue, count]) => ({ issue, count })).sort((a, b) => b.count - a.count),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Nhận diện bố cục
// ---------------------------------------------------------------------------

function pickBestSheet(sheets: Sheet[]): Sheet | undefined {
  // Ưu tiên sheet có cột ngày (thu hoạch / xuống giống) vì chứa thông tin thời vụ.
  const scored = sheets.map((sheet) => {
    const head = sheet.rows.slice(0, 8).flat().map((c) => normalizeName(cellText(c))).join(' ');
    let score = 0;
    if (/ngay xuong giong|ngay gieo sa/.test(head)) score += 10;
    if (/ngay thu hoach/.test(head)) score += 6;
    if (/xa phuong|xa/.test(head)) score += 2;
    if (/dtxg|dien tich/.test(head)) score += 1;
    return { sheet, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].sheet : sheets[0];
}

function detectLayout(sheet: Sheet): 'bang_phang' | 'bang_cheo_tien_do' {
  for (const row of sheet.rows.slice(0, 8)) {
    const headers = row.map((c) => normalizeName(cellText(c)));
    const harvestBlocks = headers.filter((h) => h === 'ngay thu hoach').length;
    if (harvestBlocks >= 2) return 'bang_cheo_tien_do';
  }
  return 'bang_phang';
}

function findHeaderRow(sheet: Sheet): { rowIndex: number; columns: Record<string, number> } | null {
  for (let rowIndex = 0; rowIndex < Math.min(12, sheet.rows.length); rowIndex += 1) {
    const columns: Record<string, number> = {};
    (sheet.rows[rowIndex] ?? []).forEach((cell, columnIndex) => {
      const header = normalizeName(cellText(cell));
      if (!header) return;
      for (const [field, aliases] of Object.entries(ALIASES)) {
        if (columns[field] !== undefined) continue;
        if ((aliases as string[]).includes(header)) columns[field] = columnIndex;
      }
    });
    if (columns.commune !== undefined) return { rowIndex, columns };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bố cục A — bảng phẳng
// ---------------------------------------------------------------------------

function parseFlatLayout(
  sheet: Sheet,
  province: ReturnType<typeof resolveProvince>,
  seasonKind: string,
): CommuneSeasonRow[] {
  const header = findHeaderRow(sheet);
  if (!header) {
    throw new Error('Không nhận diện được cột "Xã/phường" trong sheet. Kiểm tra lại dòng tiêu đề.');
  }
  const { columns } = header;
  const rows: CommuneSeasonRow[] = [];
  // Ô gộp: cột huyện chỉ ghi ở dòng đầu mỗi nhóm, các dòng sau để trống.
  let lastDistrict: string | null = null;

  for (let rowIndex = header.rowIndex + 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const cells = sheet.rows[rowIndex] ?? [];
    const commune = cellText(cells[columns.commune]);
    if (!commune || isSummaryRow(commune)) continue;
    lastDistrict = cellText(cells[columns.district ?? -1]) || lastDistrict;

    const row = buildRow(
      rowIndex, commune,
      lastDistrict,
      columns.province !== undefined ? cellText(cells[columns.province]) : null,
      province, seasonKind,
    );
    row.areaHa = cellNumber(cells[columns.area ?? -1]);
    row.sowingDate = cellDate(cells[columns.sowing ?? -1]);
    row.harvestDate = cellDate(cells[columns.harvest ?? -1]);
    row.yieldDryTonsPerHa = cellNumber(cells[columns.yieldDry ?? -1]);
    row.outputTons = cellNumber(cells[columns.output ?? -1]);
    row.riceVariety = cellText(cells[columns.variety ?? -1]) || null;
    finalizeSowing(row, seasonKind);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Bố cục B — bảng chéo tiến độ thu hoạch
// ---------------------------------------------------------------------------

function parseProgressLayout(
  sheet: Sheet,
  province: ReturnType<typeof resolveProvince>,
  seasonKind: string,
): CommuneSeasonRow[] {
  const header = findHeaderRow(sheet);
  if (!header) throw new Error('Không nhận diện được cột "Xã/phường" trong sheet tiến độ thu hoạch.');
  const { columns } = header;

  // Dòng tiêu đề chứa các khối "NGÀY THU HOẠCH"; dòng kế tiếp chứa ngày thực tế;
  // dòng sau nữa chứa 3 cột con Diện tích / NS khô / Sản lượng.
  const blocks: { column: number; date: string }[] = [];
  const headerCells = sheet.rows[header.rowIndex] ?? [];
  const dateRow = sheet.rows[header.rowIndex + 1] ?? [];

  // Một sheet có thể chứa NHIỀU bảng đặt cạnh nhau (ví dụ "THU HOẠCH LÚA VỤ
  // ĐÔNG XUÂN" và "THU HOẠCH VỤ MÙA" dùng chung các mốc ngày). Chỉ lấy bảng đầu
  // tiên: dừng ở cột xuất hiện tiêu đề "STT" thứ hai.
  let endColumn = headerCells.length;
  for (let columnIndex = columns.commune + 1; columnIndex < headerCells.length; columnIndex += 1) {
    if (normalizeName(cellText(headerCells[columnIndex])) === 'stt') {
      endColumn = columnIndex;
      break;
    }
  }

  const seenDates = new Set<string>();
  headerCells.slice(0, endColumn).forEach((cell, columnIndex) => {
    if (normalizeName(cellText(cell)) !== 'ngay thu hoach') return;
    // Ngày có thể nằm ngay dưới hoặc lệch vài cột do ô gộp.
    for (let offset = 0; offset < 3; offset += 1) {
      const date = cellDate(dateRow[columnIndex + offset]);
      if (!date) continue;
      if (seenDates.has(date)) return; // khối trùng ngày → thuộc bảng khác
      seenDates.add(date);
      blocks.push({ column: columnIndex, date });
      return;
    }
  });

  const subHeaderRow = sheet.rows[header.rowIndex + 2] ?? [];
  const rows: CommuneSeasonRow[] = [];
  // Ô gộp: cột "Khu vực" (huyện) chỉ ghi ở dòng đầu mỗi nhóm xã.
  let lastDistrict: string | null = null;

  for (let rowIndex = header.rowIndex + 3; rowIndex < sheet.rows.length; rowIndex += 1) {
    const cells = sheet.rows[rowIndex] ?? [];
    const commune = cellText(cells[columns.commune]);
    if (!commune || isSummaryRow(commune)) continue;
    lastDistrict = cellText(cells[columns.district ?? -1]) || lastDistrict;

    const row = buildRow(
      rowIndex, commune,
      lastDistrict,
      null, province, seasonKind,
    );
    row.areaHa = cellNumber(cells[columns.area ?? -1]);

    let cumulativeArea = 0;
    let cumulativeOutput = 0;
    let lastHarvestDate: string | null = null;

    for (const block of blocks) {
      // Trong mỗi khối, 3 cột con theo thứ tự Diện tích | NS khô | Sản lượng.
      const start = findSubColumn(subHeaderRow, block.column);
      const areaHa = cellNumber(cells[start]) ?? 0;
      const yieldDry = cellNumber(cells[start + 1]);
      const outputTons = cellNumber(cells[start + 2]) ?? 0;
      if (areaHa <= 0 && outputTons <= 0) continue;
      row.progress.push({ asOfDate: block.date, areaHa, yieldDryTonsPerHa: yieldDry, outputTons });
      cumulativeArea += areaHa;
      cumulativeOutput += outputTons;
      lastHarvestDate = block.date;
    }

    row.harvestDate = row.progress[0]?.asOfDate ?? null; // mốc thu hoạch ĐẦU TIÊN
    row.outputTons = cumulativeOutput || null;
    row.yieldDryTonsPerHa = cumulativeArea > 0 ? round(cumulativeOutput / cumulativeArea, 2) : null;
    if (cumulativeArea > 0 && row.areaHa && cumulativeArea > row.areaHa * 1.05) {
      row.issues.push(
        `Diện tích thu hoạch luỹ kế (${round(cumulativeArea)} ha) vượt diện tích gieo sạ (${round(row.areaHa)} ha) — kiểm tra lại file nguồn.`,
      );
      row.status = 'canh_bao';
    }
    if (lastHarvestDate && row.progress.length === 0) row.harvestDate = lastHarvestDate;

    finalizeSowing(row, seasonKind);
    rows.push(row);
  }
  return rows;
}

/** Tìm cột con "Diện tích" của một khối ngày thu hoạch. */
function findSubColumn(subHeaderRow: { value: unknown }[], blockColumn: number): number {
  for (let offset = 0; offset < 3; offset += 1) {
    if (normalizeName(cellText(subHeaderRow[blockColumn + offset] as never)) === 'dien tich') {
      return blockColumn + offset;
    }
  }
  return blockColumn;
}

// ---------------------------------------------------------------------------
// Tiện ích chung
// ---------------------------------------------------------------------------

function buildRow(
  sheetRow: number,
  commune: string,
  district: string | null,
  declaredProvince: string | null,
  fallbackProvince: ReturnType<typeof resolveProvince>,
  seasonKind: string,
): CommuneSeasonRow {
  const province = declaredProvince ? resolveProvince(declaredProvince) ?? fallbackProvince : fallbackProvince;
  const issues: string[] = [];

  const row: CommuneSeasonRow = {
    sheetRow: sheetRow + 1,
    commune,
    district,
    provinceName: province?.newProvince ?? null,
    provinceCode: province?.newCode ?? null,
    areaHa: null,
    sowingDate: null,
    sowingDateSource: null,
    harvestDate: null,
    yieldDryTonsPerHa: null,
    outputTons: null,
    riceVariety: null,
    lat: null,
    lng: null,
    geocodePrecision: null,
    progress: [],
    status: 'nhap_moi',
    issues,
  };

  if (!province) {
    row.status = 'bo_qua';
    issues.push('Chưa xác định được tỉnh — chọn "Tỉnh mặc định" khi nhập file hoặc bổ sung cột Tỉnh.');
    return row;
  }

  // Định vị: ưu tiên huyện, nếu không có thì thử coi tên xã như một huyện
  // (file điều tra hay ghi tên huyện ở cột "Xã, phường" với các đơn vị cấp huyện).
  const located = geocode(district ?? commune, province.declared, province.newCode);
  const spread = jitter(located.lat, located.lng, `${commune}|${district ?? ''}`, sheetRow);
  row.lat = spread.lat;
  row.lng = spread.lng;
  row.geocodePrecision = located.precision;
  if (located.precision === 'tinh') {
    issues.push(`Không tra được huyện cho xã "${commune}" — tạm đặt tại trung tâm tỉnh ${province.newProvince}.`);
    row.status = 'canh_bao';
  }
  return row;
}

/** Suy ngày xuống giống từ ngày thu hoạch nếu file không khai báo. */
function finalizeSowing(row: CommuneSeasonRow, seasonKind: string): void {
  if (row.sowingDate) {
    row.sowingDateSource = 'khai_bao';
    return;
  }
  if (!row.harvestDate) return;
  const days = GROWTH_DAYS[seasonKind] ?? 100;
  const harvest = new Date(`${row.harvestDate}T00:00:00Z`);
  if (Number.isNaN(harvest.getTime())) return;
  harvest.setUTCDate(harvest.getUTCDate() - days);
  row.sowingDate = harvest.toISOString().slice(0, 10);
  row.sowingDateSource = 'suy_ra';
  row.issues.push(
    `File không có cột "Ngày xuống giống" — hệ thống suy ra ${row.sowingDate} = ngày thu hoạch − ${days} ngày ` +
    'sinh trưởng của vụ. Giá trị này được gắn nhãn "suy ra", không phải số liệu khai báo.',
  );
}

function isSummaryRow(value: string): boolean {
  const text = normalizeName(value);
  return ['tong', 'tong cong', 'cong', 'tong so', 'toan tinh', 'tong hop'].includes(text);
}

function ensureSeason(
  detected: { code: string; name: string; kind: string; year: number },
  dryRun: boolean,
): { id: string; code: string; name: string; created: boolean } {
  const existing = one<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM seasons WHERE code = ?',
    [detected.code],
  );
  if (existing) return { ...existing, created: false };

  const months: Record<string, [number, number]> = { DX: [11, 3], HT: [4, 8], TD: [8, 12] };
  const [startMonth, endMonth] = months[detected.kind] ?? [1, 12];
  const record = {
    id: uuid(),
    code: detected.code,
    name: detected.name,
    year: detected.year,
    start_month: startMonth,
    end_month: endMonth,
    sort_order: { DX: 1, HT: 2, TD: 3 }[detected.kind] ?? 9,
  };
  if (!dryRun) insert('seasons', record);
  return { id: record.id, code: record.code, name: record.name, created: true };
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Danh sách sheet trong file — để giao diện cho người dùng chọn. */
export function listSheets(buffer: Buffer): { name: string; rows: number; columns: number }[] {
  return readWorkbook(buffer).sheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.length,
    columns: sheet.rows[0]?.length ?? 0,
  }));
}

export function listCommuneCropSeasons(seasonId?: string): Record<string, unknown>[] {
  const sql = `SELECT ccs.*, s.name AS season_name,
                      (SELECT COUNT(*) FROM commune_harvest_progress p WHERE p.commune_season_id = ccs.id) AS milestones
               FROM commune_crop_seasons ccs JOIN seasons s ON s.id = ccs.season_id`;
  return seasonId
    ? all(`${sql} WHERE ccs.season_id = ? ORDER BY ccs.province_name, ccs.district, ccs.commune`, [seasonId])
    : all(`${sql} ORDER BY ccs.province_name, ccs.district, ccs.commune LIMIT 2000`);
}

export function communeHarvestProgress(communeSeasonId: string): Record<string, unknown>[] {
  return all('SELECT * FROM commune_harvest_progress WHERE commune_season_id = ? ORDER BY as_of_date', [communeSeasonId]);
}
