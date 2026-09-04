/**
 * Bộ đọc file Excel (.xlsx) không phụ thuộc thư viện ngoài.
 *
 * Hỗ trợ đủ cho luồng nhập liệu nghiệp vụ: nhiều sheet, shared strings, ô gộp
 * (merged cells), nhận diện ô ngày tháng theo định dạng số, và giữ nguyên vị
 * trí hàng/cột để dò dòng tiêu đề.
 */
import { readZipEntries, readZipFile } from './zip.ts';

export type CellValue = string | number | boolean | null;

export interface Cell {
  /** Giá trị đã chuẩn hoá: chuỗi, số, boolean hoặc null. */
  value: CellValue;
  /** Ngày tháng ISO (yyyy-mm-dd) nếu ô được định dạng kiểu ngày. */
  date?: string;
}

export interface Sheet {
  name: string;
  /** Ma trận ô theo hàng; chỉ số cột bắt đầu từ 0. */
  rows: Cell[][];
  /** Vùng ô gộp, dùng để suy tiêu đề nhiều tầng. */
  merges: { fromRow: number; toRow: number; fromCol: number; toCol: number }[];
}

export interface Workbook {
  sheets: Sheet[];
  sheet(name: string): Sheet | undefined;
}

/** Các mã định dạng số dựng sẵn của Excel biểu diễn ngày/giờ. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export function readWorkbook(buffer: Buffer): Workbook {
  const entries = readZipEntries(buffer);
  const read = (name: string): string | null => {
    const entry = entries.find((item) => item.name === name);
    return entry ? readZipFile(buffer, entry).toString('utf8') : null;
  };

  const workbookXml = read('xl/workbook.xml');
  if (!workbookXml) throw new Error('Không đọc được file Excel: thiếu xl/workbook.xml. File có đúng định dạng .xlsx không?');

  const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml'));
  const dateStyles = parseDateStyles(read('xl/styles.xml'));
  const relations = parseRelationships(read('xl/_rels/workbook.xml.rels'));

  const sheets: Sheet[] = [];
  for (const descriptor of matchAll(workbookXml, /<sheet\b[^>]*\/?>/g)) {
    const name = decodeXml(attr(descriptor, 'name') ?? `Sheet${sheets.length + 1}`);
    const rid = attr(descriptor, 'r:id') ?? '';
    let target = relations.get(rid);
    if (!target) continue;
    if (target.startsWith('/')) target = target.slice(1);
    else if (!target.startsWith('xl/')) target = `xl/${target}`;
    const sheetXml = read(target);
    if (!sheetXml) continue;
    sheets.push(parseSheet(name, sheetXml, sharedStrings, dateStyles));
  }

  return { sheets, sheet: (name: string) => sheets.find((item) => item.name === name) };
}

// ---------------------------------------------------------------------------
// Phân tích từng phần XML
// ---------------------------------------------------------------------------

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const result: string[] = [];
  for (const block of matchAll(xml, /<si\b[^>]*\/>|<si\b[^>]*(?<!\/)>[\s\S]*?<\/si>/g)) {
    const parts = [...matchAll(block, /<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m.replace(/<[^>]+>/g, '')));
    result.push(parts.join(''));
  }
  return result;
}

/** Trả về tập chỉ số style (cellXfs) tương ứng định dạng ngày tháng. */
function parseDateStyles(xml: string | null): Set<number> {
  const dateStyles = new Set<number>();
  if (!xml) return dateStyles;

  const customDateFormats = new Set<number>();
  for (const node of matchAll(xml, /<numFmt\b[^>]*\/?>/g)) {
    const id = Number(attr(node, 'numFmtId'));
    const code = decodeXml(attr(node, 'formatCode') ?? '');
    // Bỏ phần trong ngoặc kép rồi mới xét ký tự y/m/d để tránh nhầm với text.
    const stripped = code.replace(/"[^"]*"/g, '');
    if (/[yd]/i.test(stripped) || /m{3,}/i.test(stripped)) customDateFormats.add(id);
  }

  const cellXfsBlock = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(xml)?.[0] ?? '';
  let index = 0;
  for (const node of matchAll(cellXfsBlock, /<xf\b[^>]*\/?>/g)) {
    const numFmtId = Number(attr(node, 'numFmtId') ?? '0');
    if (BUILTIN_DATE_FORMATS.has(numFmtId) || customDateFormats.has(numFmtId)) dateStyles.add(index);
    index += 1;
  }
  return dateStyles;
}

function parseRelationships(xml: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const node of matchAll(xml, /<Relationship\b[^>]*\/?>/g)) {
    const id = attr(node, 'Id');
    const target = attr(node, 'Target');
    if (id && target) map.set(id, decodeXml(target));
  }
  return map;
}

function parseSheet(name: string, xml: string, sharedStrings: string[], dateStyles: Set<number>): Sheet {
  const rows: Cell[][] = [];

  for (const rowXml of matchAll(xml, /<row\b[^>]*\/>|<row\b[^>]*(?<!\/)>[\s\S]*?<\/row>/g)) {
    const rowIndex = Number(attr(rowXml, 'r') ?? rows.length + 1) - 1;
    const cells: Cell[] = [];
    for (const cellXml of matchAll(rowXml, /<c\b[^>]*\/>|<c\b[^>]*(?<!\/)>[\s\S]*?<\/c>/g)) {
      const ref = attr(cellXml, 'r') ?? '';
      const colIndex = ref ? columnIndex(ref) : cells.length;
      cells[colIndex] = parseCell(cellXml, sharedStrings, dateStyles);
    }
    rows[rowIndex] = cells;
  }

  const merges = [...matchAll(xml, /<mergeCell\b[^>]*\/?>/g)].map((node) => {
    const range = attr(node, 'ref') ?? 'A1:A1';
    const [from, to] = range.split(':');
    return {
      fromRow: rowIndexOf(from), toRow: rowIndexOf(to ?? from),
      fromCol: columnIndex(from), toCol: columnIndex(to ?? from),
    };
  });

  // Chuẩn hoá: lấp các hàng/ô trống để chỉ số hàng–cột luôn đúng vị trí Excel.
  const width = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
  const normalized = Array.from({ length: rows.length }, (_, r) =>
    Array.from({ length: width }, (_, c) => rows[r]?.[c] ?? { value: null }));

  return { name, rows: normalized, merges };
}

function parseCell(xml: string, sharedStrings: string[], dateStyles: Set<number>): Cell {
  const type = attr(xml, 't') ?? 'n';
  const styleIndex = Number(attr(xml, 's') ?? '-1');

  if (type === 'inlineStr') {
    const parts = [...matchAll(xml, /<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m.replace(/<[^>]+>/g, '')));
    return { value: parts.join('') || null };
  }

  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(xml)?.[1];
  if (raw === undefined) return { value: null };
  const text = decodeXml(raw);

  if (type === 's') return { value: sharedStrings[Number(text)] ?? null };
  if (type === 'str' || type === 'e') return { value: text };
  if (type === 'b') return { value: text === '1' };

  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return { value: text };
  if (dateStyles.has(styleIndex)) {
    return { value: numeric, date: excelSerialToIsoDate(numeric) ?? undefined };
  }
  return { value: numeric };
}

// ---------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------

/**
 * Quy đổi số sê-ri ngày của Excel sang ISO date.
 * Excel coi 1900 là năm nhuận (lỗi lịch sử) nên mốc quy đổi là 1899-12-30.
 */
export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return null;
  const millis = Math.round((serial - 25_569) * 86_400_000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Chuyển tham chiếu ô ("BC12") thành chỉ số cột bắt đầu từ 0. */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1] ?? 'A';
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function rowIndexOf(ref: string): number {
  return Number(/(\d+)$/.exec(ref)?.[1] ?? '1') - 1;
}

function attr(xml: string, name: string): string | null {
  const match = new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`).exec(xml);
  return match ? match[1] : null;
}

function* matchAll(text: string, pattern: RegExp): Generator<string> {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    yield match[1] ?? match[0];
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/** Lấy giá trị ô dạng chuỗi đã cắt khoảng trắng thừa. */
export function cellText(cell: Cell | undefined): string {
  if (!cell || cell.value === null || cell.value === undefined) return '';
  if (typeof cell.value === 'number') return String(cell.value);
  return String(cell.value).replace(/\s+/g, ' ').trim();
}

/** Lấy giá trị ô dạng số; trả về null nếu ô trống hoặc không phải số. */
export function cellNumber(cell: Cell | undefined): number | null {
  if (!cell || cell.value === null || cell.value === undefined || cell.value === '') return null;
  if (typeof cell.value === 'number') return cell.value;
  // Chấp nhận "1.234,5" và "1,234.5" — định dạng số Việt Nam và quốc tế.
  const text = String(cell.value).trim().replace(/\s/g, '');
  if (!text || text === '-') return null;
  const normalized = /,\d{1,2}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Lấy giá trị ô dạng ngày ISO (từ định dạng ngày của Excel hoặc chuỗi dd/mm/yyyy). */
export function cellDate(cell: Cell | undefined): string | null {
  if (!cell) return null;
  if (cell.date) return cell.date;
  if (typeof cell.value === 'number') return excelSerialToIsoDate(cell.value);
  const text = cellText(cell);
  const match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(text);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return null;
}
