/**
 * Lõi ứng dụng web: gọi API, điều hướng, và các hàm dựng giao diện dùng chung.
 *
 * Ứng dụng chạy theo mô hình NHIỀU CỔNG (portal): mỗi nhóm người dùng vào một
 * đường dẫn riêng (/kn, /htx, /cgh, /gis, /erp, /field) với nhận diện và hệ thống
 * chức năng riêng. Xem `portals.js`. Trang gốc "/" là màn hình chọn cổng.
 *
 * Giao diện bám theo ba bản mẫu HTML (App Khuyến nông v5.0, App HTX v5.1, GIS
 * v1.3): theme của từng cổng được chọn qua `html[data-portal]` trong styles.css,
 * thanh bên có biểu tượng SVG (icons.js), điều hướng đáy trên điện thoại.
 */
import { PORTALS, portalFromPath, portalItems } from '/portals.js';
import { icon } from '/icons.js';

export { icon };

// `replaceChildren(null)` của DOM chèn chữ "null" vào trang. Các trang dựng có
// điều kiện (`cond ? node : null`) rất nhiều, nên lọc null/undefined/false một
// lần ở đây thay vì bắt từng trang tự lọc.
for (const method of ['replaceChildren', 'append', 'prepend']) {
  const original = Element.prototype[method];
  Element.prototype[method] = function patched(...nodes) {
    return original.apply(this, nodes.filter((n) => n !== null && n !== undefined && n !== false));
  };
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export const state = { user: null, permissions: new Set(), page: null, portal: null };

/** Các cổng mà vai trò hiện tại được phép vào. */
export function allowedPortals() {
  return PORTALS.filter((portal) => can(portal.permission) && portalItems(portal).some((item) => can(item.permission) && pages[item.id]));
}

// ---------------------------------------------------------------------------
// Chống ghi trùng + hàng đợi offline
//
// Mọi yêu cầu ghi mang một Idempotency-Key. Mất mạng giữa chừng thì thao tác
// thuộc danh sách cho phép được xếp vào hàng đợi (localStorage) và tự gửi lại
// với ĐÚNG khoá đó khi có mạng — máy chủ nhận hai lần cùng khoá chỉ chạy một lần.
// ---------------------------------------------------------------------------
const QUEUE_KEY = 'mg_offline_queue';
const QUEUEABLE = [
  /^\/field\/jobs\/[^/]+\/stages\/[^/]+\/(start|complete)$/,
  /^\/field\/jobs\/[^/]+\/loadings$/,
  /^\/htx\/farm-logs$/,
  /^\/htx\/farm-logs\/v2$/,
  /^\/files$/,
];
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export class QueuedOffline extends Error {
  constructor(pending) {
    super(`Mất mạng — thao tác đã được xếp hàng đợi và sẽ tự gửi khi có mạng (${pending} chờ gửi).`);
    this.queued = true;
  }
}

function readQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]'); } catch { return []; } }
function writeQueue(items) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch { /* đầy bộ nhớ */ } renderOfflineBar(); }
export function pendingQueue() { return readQueue().length; }

/** Lỗi HTTP có mã trạng thái và chi tiết máy chủ trả về (vd. 409 cần xác nhận, 423 khoá tạm). */
export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details ?? null;
  }
}

export async function api(path, options = {}) {
  const method = options.method ?? (options.body ? 'POST' : 'GET');
  const headers = options.body ? { 'Content-Type': 'application/json' } : {};
  const key = method !== 'GET' ? (options.idempotencyKey ?? newKey()) : null;
  if (key) headers['Idempotency-Key'] = key;
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method, headers, body: options.body ? JSON.stringify(options.body) : undefined, credentials: 'same-origin',
    });
  } catch (error) {
    if (key && !options.noQueue && QUEUEABLE.some((pattern) => pattern.test(path))) {
      const queue = readQueue();
      queue.push({ key, path, method, body: options.body ?? null, at: new Date().toISOString() });
      writeQueue(queue);
      throw new QueuedOffline(queue.length);
    }
    throw new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
  }
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = payload?.error ?? `Lỗi ${response.status}`;
    throw new ApiError(message, response.status, payload?.details ?? null);
  }
  return payload;
}

/**
 * Gọi API ghi; nếu máy chủ trả 409 "cần xác nhận" (thửa chồng lấn, năng suất
 * bất thường, chủ máy còn máy…) thì hiện hộp xác nhận và gọi lại với cờ xác nhận.
 * `confirmField` là tên trường máy chủ chờ (mặc định `confirm`).
 */
export async function apiConfirm(path, options = {}, confirmField = 'confirm') {
  try {
    return await api(path, options);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409 || !error.details?.needsConfirm) throw error;
    const extra = [];
    if (Array.isArray(error.details.overlaps) && error.details.overlaps.length) {
      extra.push(el('ul', {}, error.details.overlaps.slice(0, 6).map((o) => el('li', { text: `${o.plotName ?? o.plotId ?? o.id} — ${o.htxName ?? ''} ${o.overlapPct != null ? `(${pct(o.overlapPct)})` : ''}` }))));
    }
    if (error.details.anomaly) extra.push(el('p', { class: 'muted', text: error.details.anomaly }));
    if (error.details.machines) extra.push(el('p', { class: 'muted', text: `${error.details.machines} máy đang gắn với đối tượng này.` }));
    const ok = await confirmDialog(error.message, { title: 'Cần xác nhận', okLabel: 'Vẫn tiếp tục', extra });
    if (!ok) throw new Error('Đã huỷ theo yêu cầu.');
    return api(path, { ...options, body: { ...(options.body ?? {}), [confirmField]: true } });
  }
}

export function can(permission) {
  return state.permissions.has('*') || state.permissions.has(permission);
}

// ---------------------------------------------------------------------------
// Định dạng số/tiền tiếng Việt
// ---------------------------------------------------------------------------

export const NOT_AVAILABLE = 'Không xác định';

export function vnd(value, options = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return NOT_AVAILABLE;
  if (options.compact && Math.abs(value) >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ đ`;
  }
  if (options.compact && Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr đ`;
  }
  return `${Math.round(value).toLocaleString('vi-VN')} đ`;
}

export function num(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return NOT_AVAILABLE;
  return Number(value).toLocaleString('vi-VN', { maximumFractionDigits: digits });
}

export function tons(value) {
  if (value === null || value === undefined) return NOT_AVAILABLE;
  return `${num(value)} tấn`;
}

export function pct(value, digits = 1) {
  if (value === null || value === undefined) return NOT_AVAILABLE;
  return `${Number(value).toFixed(digits)}%`;
}

export function dateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('vi-VN');
}

export function dateOnly(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('vi-VN');
}

/** Chữ cái đầu của họ tên để làm avatar (tối đa 2 ký tự). */
export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// ---------------------------------------------------------------------------
// Dựng DOM
// ---------------------------------------------------------------------------

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function card(title, children, actions) {
  const header = title
    ? el('h3', {}, [title, actions ? el('span', { class: 'chip-row' }, [].concat(actions)) : null])
    : null;
  return el('div', { class: 'card' }, [header, ...[].concat(children)]);
}

/**
 * Thẻ chỉ số. Hàng 4 thẻ đầu trang tự tô màu theo bản mẫu; `iconName` (icons.js)
 * hiện ở góc phải.
 */
export function kpi(label, value, sub, tone, iconName) {
  return el('div', { class: 'kpi' }, [
    iconName ? el('span', { class: 'kpi-ico' }, [icon(iconName, 18)]) : null,
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value, style: tone ? `color: var(--${tone})` : null }),
    sub ? el('div', { class: 'sub', text: sub }) : null,
  ]);
}

/** Thẻ thống kê kiểu App HTX: ô biểu tượng màu + số + nhãn. */
export function statCard(iconName, number, label, tone = '') {
  return el('div', { class: 'card stat-card' }, [
    el('span', { class: `stat-ic ${tone}` }, [icon(iconName, 22)]),
    el('div', {}, [el('div', { class: 'num', text: number }), el('div', { class: 'lab', text: label })]),
  ]);
}

export function badge(text, tone = 'neutral') {
  return el('span', { class: `badge ${tone}`, text });
}

export function alert(text, tone = 'info') {
  return el('div', { class: `alert ${tone}` }, [text]);
}

export function emptyState(text = 'Chưa có dữ liệu', iconName = 'grid') {
  return el('div', { class: 'empty' }, [icon(iconName, 32), el('span', { text })]);
}

/** Tiêu đề khu vực có mô tả ngắn và hành động bên phải. */
export function sectionHead(title, description, actions) {
  return el('div', { class: 'section-head' }, [
    el('div', {}, [el('h3', { text: title }), description ? el('p', { text: description }) : null]),
    actions ? el('div', { class: 'chip-row' }, [].concat(actions)) : null,
  ]);
}

/**
 * Bảng dữ liệu. `columns` = [{ key, label, align, render }].
 * Giá trị null/undefined hiển thị "Không xác định" — không thay bằng 0 hay ô
 * trống (FN-13 AC-03, FN-16 AC-03).
 */
export function table(columns, rows, options = {}) {
  const head = el('tr', {}, columns.map((column) =>
    el('th', { class: column.align === 'right' ? 'num' : null, text: column.label })));
  const body = rows.map((row, index) => {
    const tr = el('tr', { class: options.rowClass ? options.rowClass(row, index) : null },
      columns.map((column) => {
        const rendered = column.render ? column.render(row, index) : row[column.key];
        const isNode = rendered instanceof Node;
        return el('td', { class: column.align === 'right' ? 'num' : null },
          isNode ? [rendered] : [rendered === null || rendered === undefined ? NOT_AVAILABLE : String(rendered)]);
      }));
    if (options.onRowClick) {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => options.onRowClick(row, index));
    }
    return tr;
  });
  return el('div', { class: `table-wrap${options.plain ? ' plain' : ''}` }, [
    el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body.length ? body : [
      el('tr', {}, [el('td', { colspan: columns.length, class: 'muted', text: options.empty ?? 'Chưa có dữ liệu' })]),
    ])]),
  ]);
}

export function field(label, input) {
  return el('label', {}, [label, input]);
}

export function input(name, attrs = {}) {
  return el('input', { name, ...attrs });
}

export function select(name, options, attrs = {}) {
  return el('select', { name, ...attrs },
    options.map((option) => el('option', { value: option.value, selected: option.selected }, [option.label])));
}

/**
 * Biểu mẫu nhập liệu dùng chung cho các cổng nghiệp vụ.
 *
 * `fields` là mảng { name, label, type, options, value, required, placeholder, step, hint }.
 * `onSubmit(values)` nhận đối tượng đã gom; ném lỗi thì thông báo hiện tại chỗ,
 * không làm mất dữ liệu người dùng đã gõ (HTX US-NFR: không mất dữ liệu đã nhập).
 */
export function form(fields, onSubmit, options = {}) {
  const errorBox = el('p', { class: 'login-error', hidden: true });
  const controls = fields.map((f) => {
    const attrs = {
      required: f.required ?? false,
      placeholder: f.placeholder ?? '',
      value: f.value ?? '',
      step: f.step,
      min: f.min,
      max: f.max,
      rows: f.rows,
      title: f.hint,
    };
    if (f.type === 'select') return field(f.label, select(f.name, f.options ?? [], { required: attrs.required }));
    if (f.type === 'textarea') {
      return field(f.label, el('textarea', { name: f.name, rows: f.rows ?? 3, placeholder: attrs.placeholder }, [f.value ?? '']));
    }
    if (f.type === 'checkbox') return el('label', { class: 'pick-item' }, [el('input', { type: 'checkbox', name: f.name, checked: f.value ? true : null }), f.label]);
    return field(f.label, input(f.name, { ...attrs, type: f.type ?? 'text' }));
  });

  const formEl = el('form', {
    class: `row${options.stacked ? ' stack' : ''}`,
    onsubmit: async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      const data = new FormData(event.target);
      const values = {};
      for (const f of fields) {
        const raw = data.get(f.name);
        if (f.type === 'checkbox') values[f.name] = raw !== null;
        else values[f.name] = f.type === 'number' ? (raw === '' || raw === null ? null : Number(raw)) : raw;
      }
      const submit = event.target.querySelector('button[type=submit]');
      if (submit) submit.disabled = true;
      try {
        await onSubmit(values);
        if (options.resetOnSuccess !== false) event.target.reset();
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
      } finally {
        if (submit) submit.disabled = false;
      }
    },
  }, [...controls, el('button', { type: 'submit', class: options.stacked ? '' : 'small', text: options.submitLabel ?? 'Lưu' })]);

  return el('div', {}, [formEl, errorBox]);
}

export function rawJson(label, data) {
  return el('details', { class: 'raw' }, [
    el('summary', { class: 'muted', text: label }),
    el('pre', { text: JSON.stringify(data, null, 2) }),
  ]);
}

/** Dãy chip lọc: `items` = [{ value, label }], gọi `onChange(value)`; trả về node và hàm set. */
export function chips(items, current, onChange) {
  const row = el('div', { class: 'chip-row' });
  let value = current;
  const draw = () => row.replaceChildren(...items.map((item) => el('button', {
    class: `chip${item.value === value ? ' active' : ''}`, text: item.label,
    onclick: () => { value = item.value; draw(); onChange(value); },
  })));
  draw();
  return row;
}

/**
 * Bộ tab: `defs` = [{ id, label, render(panel) }]. Chỉ dựng tab khi mở.
 * Trả về node chứa cả thanh tab và panel; `node.show(id)` để chuyển tab.
 */
export function tabs(defs, options = {}) {
  const bar = el('div', { class: 'tabs' });
  const panel = el('div', { class: 'tab-panel' });
  const wrap = el('div', { class: 'tabs-wrap' }, [bar, panel]);
  let current = null;
  const show = async (id) => {
    const def = defs.find((d) => d.id === id) ?? defs[0];
    if (!def) return;
    current = def.id;
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === current));
    panel.replaceChildren(el('p', { class: 'muted', text: 'Đang tải…' }));
    try {
      panel.replaceChildren();
      await def.render(panel);
    } catch (error) {
      console.error(`[tab ${def.id}]`, error);
      panel.replaceChildren(alert(`Không tải được: ${error.message}`, 'bad'));
    }
    options.onChange?.(current);
  };
  bar.replaceChildren(...defs.map((d) => el('button', { dataset: { tab: d.id }, onclick: () => show(d.id) }, [d.icon ? icon(d.icon, 16) : null, d.label])));
  wrap.show = show;
  show(options.initial ?? defs[0]?.id);
  return wrap;
}

/**
 * Hộp thoại. `content` là node/mảng node; `actions` là mảng button. Trả về { close, node }.
 */
export function modal(title, content, actions = [], options = {}) {
  const root = document.getElementById('modal-root');
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); options.onClose?.(); };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  const box = el('div', { class: `modal${options.wide ? ' wide' : ''}` }, [
    el('div', { class: 'modal-head' }, [el('h3', { text: title }), el('button', { class: 'x', 'aria-label': 'Đóng', onclick: close }, [icon('x', 18)])]),
    el('div', { class: 'modal-body' }, [].concat(content)),
    actions.length ? el('div', { class: 'modal-foot' }, actions) : null,
  ]);
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (event) => { if (event.target === backdrop && options.dismissible !== false) close(); } }, [box]);
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  return { close, node: box };
}

/** Hộp xác nhận trả về Promise<boolean>. */
export function confirmDialog(message, options = {}) {
  return new Promise((resolve) => {
    const dialog = modal(options.title ?? 'Xác nhận', [el('p', { text: message }), ...(options.extra ?? [])], [
      el('button', { class: 'ghost', text: options.cancelLabel ?? 'Huỷ', onclick: () => { dialog.close(); resolve(false); } }),
      el('button', { class: options.danger ? 'danger' : '', text: options.okLabel ?? 'Đồng ý', onclick: () => { dialog.close(); resolve(true); } }),
    ], { onClose: () => resolve(false), dismissible: false });
  });
}

/** Hỏi một dòng văn bản (vd. lý do xoá). Trả về chuỗi hoặc null khi huỷ. */
export function promptDialog(title, options = {}) {
  return new Promise((resolve) => {
    const box = options.multiline ? el('textarea', { rows: 3, placeholder: options.placeholder ?? '' }) : el('input', { placeholder: options.placeholder ?? '', value: options.value ?? '' });
    const err = el('p', { class: 'login-error' });
    const dialog = modal(title, [options.message ? el('p', { class: 'muted', text: options.message }) : null, box, err], [
      el('button', { class: 'ghost', text: 'Huỷ', onclick: () => { dialog.close(); resolve(null); } }),
      el('button', { text: options.okLabel ?? 'Xác nhận', onclick: () => {
        const value = box.value.trim();
        if (options.minLength && value.length < options.minLength) { err.textContent = `Cần tối thiểu ${options.minLength} ký tự.`; return; }
        dialog.close(); resolve(value);
      } }),
    ], { onClose: () => resolve(null), dismissible: false });
    setTimeout(() => box.focus(), 30);
  });
}

/**
 * Biểu đồ cột SVG thuần (không thư viện). `series` = [{ label, value, color, value2 }].
 * `options` = { height, unit, format, stacked:false, secondLabel }.
 */
export function svgBarChart(series, options = {}) {
  const width = 640;
  const height = options.height ?? 220;
  const padL = 44; const padR = 12; const padT = 16; const padB = 34;
  const values = series.flatMap((s) => [Number(s.value) || 0, Number(s.value2) || 0]);
  const max = Math.max(1, ...values) * 1.1;
  const innerW = width - padL - padR; const innerH = height - padT - padB;
  const n = Math.max(1, series.length);
  const slot = innerW / n;
  const hasSecond = series.some((s) => s.value2 != null);
  const barW = Math.min(hasSecond ? slot * 0.32 : slot * 0.55, 56);
  const fmt = options.format ?? ((v) => num(v, 1));
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'bars-chart');
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(svgNs, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text != null) node.textContent = text;
    svg.append(node);
    return node;
  };
  for (let i = 0; i <= 4; i += 1) {
    const y = padT + innerH - (innerH * i) / 4;
    add('line', { x1: padL, x2: width - padR, y1: y, y2: y, class: 'grid-line' });
    add('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end' }, fmt((max * i) / 4));
  }
  series.forEach((s, i) => {
    const cx = padL + slot * i + slot / 2;
    const draw = (val, offset, color) => {
      const h = Math.max(0, (Number(val) || 0) / max * innerH);
      add('rect', { x: cx + offset - barW / 2, y: padT + innerH - h, width: barW, height: h, rx: 6, fill: color });
      if (val != null && h > 0) add('text', { x: cx + offset, y: padT + innerH - h - 5, 'text-anchor': 'middle', class: 'val' }, fmt(val));
    };
    if (hasSecond) {
      draw(s.value, -barW * 0.55, s.color ?? 'var(--brand)');
      draw(s.value2, barW * 0.55, s.color2 ?? 'var(--accent)');
    } else draw(s.value, 0, s.color ?? 'var(--brand)');
    add('text', { x: cx, y: height - 12, 'text-anchor': 'middle' }, String(s.label).slice(0, 14));
  });
  if (options.unit) add('text', { x: padL, y: 10 }, options.unit);
  return svg;
}

/** Tải tệp từ API (cookie phiên tự gửi kèm) — dùng cho xuất CSV/PDF. */
export function downloadUrl(path, fileName) {
  const a = el('a', { href: `/api${path}`, download: fileName ?? '' });
  document.body.append(a);
  a.click();
  a.remove();
}

let toastTimer;
export function toast(message, isError = false) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast${isError ? ' error' : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 7000 : 3500);
}

export async function guard(promise) {
  try {
    return await promise;
  } catch (error) {
    toast(error.message, true);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Bản đồ (Leaflet qua CDN, có phương án dự phòng khi không có mạng)
// ---------------------------------------------------------------------------

export const LEAFLET_AVAILABLE = () => typeof window.L !== 'undefined' && !window.__leafletMissing;

export function mapContainer(id, extraClass = '') {
  if (!LEAFLET_AVAILABLE()) {
    return el('div', { class: `map map-fallback ${extraClass}` }, [
      el('div', {}, [
        el('strong', { text: 'Không tải được thư viện bản đồ' }),
        el('p', { class: 'muted', text: 'Nền bản đồ Leaflet/OpenStreetMap cần kết nối internet. Các bảng số liệu bên dưới vẫn hoạt động bình thường.' }),
      ]),
    ]);
  }
  return el('div', { id, class: `map ${extraClass}` });
}

/**
 * Danh mục nhà cung cấp lớp nền, xếp theo thứ tự ưu tiên cho từng loại.
 *
 * TECH-01 yêu cầu nền bản đồ "hỗ trợ thay thế được nhiều nhà cung cấp". Một số
 * mạng nội bộ chặn hoặc không phân giải được tên miền của OpenStreetMap, nên
 * mỗi loại nền có nhiều nguồn dự phòng và hệ thống tự chuyển khi nguồn đầu
 * không tải được ô nào.
 */
export const BASEMAP_PROVIDERS = {
  street: [
    {
      name: 'OpenStreetMap',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      subdomains: 'abc', maxZoom: 19, attribution: '© OpenStreetMap',
    },
    {
      name: 'Esri World Street Map',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      subdomains: '', maxZoom: 19, attribution: 'Esri — World Street Map',
    },
    {
      name: 'CARTO Voyager',
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      subdomains: 'abcd', maxZoom: 20, attribution: '© CARTO © OpenStreetMap',
    },
  ],
  satellite: [
    {
      name: 'Esri World Imagery',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      subdomains: '', maxZoom: 19, attribution: 'Esri — World Imagery',
    },
  ],
  terrain: [
    {
      name: 'Esri World Topo Map',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      subdomains: '', maxZoom: 19, attribution: 'Esri — World Topo Map',
    },
    {
      name: 'OpenTopoMap',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      subdomains: 'abc', maxZoom: 17, attribution: '© OpenTopoMap',
    },
  ],
};

/** Nhà cung cấp đã được xác nhận tải được trong phiên này (dùng lại cho bản đồ sau). */
const providerCache = new Map();

/**
 * Lớp nền tự phục hồi: nếu nhà cung cấp đầu tiên không tải được ô nào, tự
 * chuyển sang nguồn dự phòng kế tiếp thay vì để bản đồ trắng.
 */
function resilientTileLayer(kind, label, onProviderChange) {
  const providers = BASEMAP_PROVIDERS[kind];
  let index = Math.max(0, providers.findIndex((p) => p.name === providerCache.get(kind)));
  let errors = 0;
  let loaded = 0;

  // Không bao giờ truyền subdomains = undefined: Util.setOptions của Leaflet
  // ghi đè cả khoá có giá trị undefined, xoá mất mặc định 'abc' và làm
  // _getSubdomain() ném lỗi ngay khi tạo ô đầu tiên.
  const build = (provider) => {
    const options = { maxZoom: provider.maxZoom, attribution: provider.attribution };
    if (provider.subdomains) options.subdomains = provider.subdomains;
    return options;
  };

  const layer = window.L.tileLayer(providers[index].url, build(providers[index]));

  layer.on('tileload', () => {
    loaded += 1;
    if (loaded === 1) providerCache.set(kind, providers[index].name);
  });

  layer.on('tileerror', () => {
    errors += 1;
    // Chỉ đổi nguồn khi CHƯA có ô nào tải được — lỗi lẻ tẻ ở rìa bản đồ là bình thường.
    if (loaded > 0 || errors < 2 || index >= providers.length - 1) return;
    const previous = providers[index];
    index += 1;
    errors = 0;
    const next = providers[index];
    layer.options.maxZoom = next.maxZoom;
    layer.options.attribution = next.attribution;
    layer.options.subdomains = next.subdomains || 'abc';
    layer.setUrl(next.url);
    // Ghi công phải khớp nguồn ảnh đang phục vụ — Leaflet không tự cập nhật
    // control khi options.attribution đổi sau lúc khởi tạo.
    const attributionControl = layer._map?.attributionControl;
    if (attributionControl) {
      attributionControl.removeAttribution(previous.attribution);
      attributionControl.addAttribution(next.attribution);
    }
    onProviderChange?.(label, next.name, index === providers.length - 1);
  });

  return layer;
}

/**
 * Tạo bản đồ với 3 lớp nền (Đường phố / Vệ tinh / Địa hình).
 * `options.layersControl = false` để tự dựng bộ chuyển nền (GIS dùng panel nổi);
 * khi đó dùng `setBasemap(map, 'satellite')`. `options.scrollZoom` bật zoom bằng con lăn.
 */
export function createMap(id, center = [10.2, 105.8], zoom = 8, options = {}) {
  if (!LEAFLET_AVAILABLE()) return null;
  // scrollWheelZoom tắt mặc định để con lăn chuột cuộn trang chứ không zoom bản
  // đồ; dùng nút +/- hoặc Ctrl + con lăn để phóng to/thu nhỏ.
  const map = window.L.map(id, { scrollWheelZoom: Boolean(options.scrollZoom), zoomControl: options.zoomControl !== false }).setView(center, zoom);
  if (!options.scrollZoom) {
    map.getContainer().addEventListener('wheel', (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        map.setZoom(map.getZoom() + (event.deltaY < 0 ? 1 : -1));
      }
    }, { passive: false });
  }

  let notified = false;
  const announce = (label, providerName, isLast) => {
    if (notified) return;
    notified = true;
    toast(
      `Nền bản đồ "${label}" đã tự chuyển sang ${providerName}` +
      (isLast ? ' (nguồn dự phòng cuối cùng).' : ' vì nguồn ưu tiên không truy cập được.'),
    );
  };

  const street = resilientTileLayer('street', 'Đường phố', announce);
  const satellite = resilientTileLayer('satellite', 'Vệ tinh', announce);
  const terrain = resilientTileLayer('terrain', 'Địa hình', announce);
  map.__basemaps = { street, satellite, terrain };
  map.__basemap = 'street';

  street.addTo(map);
  // UX-01: luôn duy trì tối thiểu một lớp nền; cho phép đổi Đường phố/Vệ tinh/Địa hình.
  if (options.layersControl !== false) {
    window.L.control.layers(
      { 'Đường phố': street, 'Vệ tinh': satellite, 'Địa hình': terrain },
      {}, { position: 'topright' },
    ).addTo(map);
  }
  return map;
}

export function setBasemap(map, kind) {
  if (!map?.__basemaps?.[kind]) return;
  for (const [k, layer] of Object.entries(map.__basemaps)) {
    if (k === kind) { if (!map.hasLayer(layer)) layer.addTo(map); layer.bringToBack(); } else if (map.hasLayer(layer)) map.removeLayer(layer);
  }
  map.__basemap = kind;
}

// ---------------------------------------------------------------------------
// Điều hướng
// ---------------------------------------------------------------------------

// Danh mục điều hướng nay thuộc về TỪNG CỔNG — xem `portals.js`.
// app.js chỉ còn giữ sổ đăng ký trang và cơ chế điều hướng dùng chung.
const pages = {};

export function registerPage(id, definition) {
  pages[id] = definition;
}

/** Lấy định nghĩa trang đã đăng ký — dùng khi một màn hình phục vụ nhiều cổng. */
export function getPage(id) {
  return pages[id];
}

export async function navigate(id, params) {
  const page = pages[id];
  if (!page) return;
  state.page = id;
  state.pageParams = params ?? null;
  // Giữ nguyên đường dẫn cổng; chỉ trang trong cổng nằm ở hash.
  history.replaceState(null, '', `${state.portal ? state.portal.path : ''}/#${id}`);
  document.querySelectorAll('#nav button, #bottom-nav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === id);
  });
  closeSidebar();
  document.getElementById('page-title').textContent = page.title;
  document.getElementById('page-subtitle').textContent = page.subtitle ?? '';
  const actions = document.getElementById('page-actions');
  actions.replaceChildren();
  const view = document.getElementById('view');
  view.className = `view${page.fullBleed ? ' full-bleed' : ''}`;
  view.replaceChildren(el('p', { class: 'muted', style: 'padding:16px', text: 'Đang tải…' }));
  window.scrollTo({ top: 0 });
  try {
    await page.render(view, actions, params ?? {});
  } catch (error) {
    // Ghi stack ra console để dò lỗi; người dùng chỉ thấy thông điệp ngắn gọn.
    console.error(`[${id}] không dựng được trang:`, error);
    view.className = 'view';
    view.replaceChildren(alert(`Không tải được trang: ${error.message}`, 'bad'));
  }
}

function visibleNav() {
  return (state.portal?.nav ?? []).map((group) => ({
    ...group,
    items: group.items.filter((item) => can(item.permission) && pages[item.id]),
  })).filter((group) => group.items.length);
}

function navButton(item) {
  return el('button', {
    dataset: { page: item.id },
    title: item.label,
    onclick: () => navigate(item.id),
  }, [icon(item.icon ?? 'grid', 20), el('span', { class: 'lbl', text: item.label })]);
}

function buildNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren();
  for (const group of visibleNav()) {
    const container = el('div', { class: 'nav-group' }, [el('span', { text: group.group })]);
    for (const item of group.items) container.append(navButton(item));
    nav.append(container);
  }
  buildBottomNav();
}

/** Điều hướng đáy trên điện thoại: 4 mục đầu của cổng + "Thêm" mở thanh bên. */
function buildBottomNav() {
  const bar = document.getElementById('bottom-nav');
  if (!bar) return;
  const items = visibleNav().flatMap((g) => g.items);
  const quick = (state.portal?.quick ?? []).map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const chosen = (quick.length ? quick : items).slice(0, 4);
  bar.replaceChildren(
    ...chosen.map((item) => el('button', { dataset: { page: item.id }, onclick: () => navigate(item.id) }, [icon(item.icon ?? 'grid', 22), item.shortLabel ?? item.label.replace(/^\d+\.\s*/, '').split(' ').slice(0, 2).join(' ')])),
    el('button', { onclick: () => toggleSidebar(true) }, [icon('more', 22), 'Thêm']),
  );
}

let drawerBackdrop = null;
function toggleSidebar(open) {
  const sidebar = document.getElementById('sidebar');
  const willOpen = open ?? !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', willOpen);
  if (willOpen && !drawerBackdrop) {
    drawerBackdrop = el('div', { class: 'drawer-backdrop', onclick: () => toggleSidebar(false) });
    document.body.append(drawerBackdrop);
  } else if (!willOpen && drawerBackdrop) {
    drawerBackdrop.remove();
    drawerBackdrop = null;
  }
}
function closeSidebar() { if (document.getElementById('sidebar')?.classList.contains('open')) toggleSidebar(false); }

// ---------------------------------------------------------------------------
// Khởi động
// ---------------------------------------------------------------------------

export async function boot() {
  const me = await api('/auth/me').catch(() => ({ anonymous: true }));
  if (me?.anonymous) {
    document.documentElement.dataset.portal = '';
    document.getElementById('login').hidden = false;
    document.getElementById('shell').hidden = true;
    document.getElementById('portal-picker').hidden = true;
    return;
  }
  state.user = me;
  state.permissions = new Set(me.permissions ?? []);
  document.getElementById('login').hidden = true;

  // ---- Phân giải cổng từ đường dẫn ----
  const requestedPortal = portalFromPath(location.pathname);
  const allowed = allowedPortals();

  if (!allowed.length) {
    document.getElementById('shell').hidden = true;
    document.getElementById('portal-picker').hidden = false;
    renderPortalPicker(me, []);
    return;
  }
  // Người dùng chỉ có MỘT cổng thì không việc gì phải chọn — vào thẳng.
  if (!requestedPortal && allowed.length === 1) {
    location.replace(`${allowed[0].path}/${location.hash}`);
    return;
  }

  // "/" hoặc cổng không tồn tại/không có quyền → màn hình chọn cổng.
  if (!requestedPortal || !allowed.includes(requestedPortal)) {
    if (requestedPortal && !allowed.includes(requestedPortal)) {
      renderPortalPicker(me, allowed, `Tài khoản của bạn không có quyền vào ${requestedPortal.name}.`);
    } else {
      renderPortalPicker(me, allowed);
    }
    document.getElementById('shell').hidden = true;
    document.getElementById('portal-picker').hidden = false;
    return;
  }

  state.portal = requestedPortal;
  document.getElementById('portal-picker').hidden = true;
  document.getElementById('shell').hidden = false;
  applyPortalIdentity(requestedPortal);
  renderUser(me);
  buildPortalSwitch(allowed, requestedPortal);
  buildNav();
  mountBell();
  watchConnectivity();
  if (navigator.onLine && pendingQueue()) flushQueue();

  const items = portalItems(requestedPortal).filter((item) => can(item.permission) && pages[item.id]);
  const requested = location.hash.slice(1);
  const target = items.find((item) => item.id === requested) ?? items[0];
  if (!target) {
    document.getElementById('view').replaceChildren(
      alert('Cổng này chưa có chức năng nào khả dụng với vai trò của bạn.', 'warn'),
    );
    return;
  }
  await navigate(target.id);
}

/** Đặt tên, khẩu hiệu, biểu tượng và theme (qua html[data-portal]) theo cổng đang mở. */
function applyPortalIdentity(portal) {
  document.title = `${portal.name} — Mekong Green`;
  document.documentElement.dataset.portal = portal.id;
  document.documentElement.style.removeProperty('--brand');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', portal.accent);
  document.getElementById('portal-mark').textContent = portal.mark;
  document.getElementById('portal-name').textContent = portal.short;
  document.getElementById('portal-tagline').textContent = portal.tagline2 ?? 'AgriGreen Platform';
}

/** Thẻ người dùng ở thanh bên + huy hiệu vai trò ở thanh trên. */
function renderUser(me) {
  const roles = (me.roleLabels ?? []).join(' · ');
  document.getElementById('user-box').replaceChildren(
    el('span', { class: 'avatar', text: initials(me.fullName) }),
    el('div', { class: 'who' }, [el('b', { text: me.fullName }), el('span', { text: roles || me.username, title: roles })]),
  );
  const primary = me.roleLabels?.[0] ?? '';
  document.getElementById('topbar-user')?.replaceChildren(
    el('span', { class: 'role-pill', title: `${me.fullName} · ${roles}` }, [icon('user', 15), el('span', { text: primary })]),
  );
}

/** Bộ chuyển cổng ở chân thanh bên — chỉ hiện khi người dùng có quyền ở ≥ 2 cổng. */
function buildPortalSwitch(allowed, current) {
  const box = document.getElementById('portal-switch');
  box.replaceChildren();
  if (allowed.length < 2) return;
  box.append(el('span', { class: 'switch-label', text: 'Chuyển cổng' }));
  for (const portal of allowed) {
    if (portal.id === current.id) continue;
    box.append(el('a', {
      class: 'portal-link',
      href: `${portal.path}/`,
      title: portal.name,
    }, [el('span', { class: 'mark', text: portal.mark }), el('span', { text: portal.short })]));
  }
  box.append(el('a', { class: 'portal-link muted', href: '/', title: 'Tất cả các cổng' }, [el('span', { class: 'mark', text: '⌂' }), el('span', { text: 'Tất cả các cổng' })]));
}

/** Màn hình chọn cổng tại "/" — thay cho một thanh điều hướng gộp tất cả. */
function renderPortalPicker(me, allowed, warning) {
  document.title = 'Chọn cổng — Mekong Green';
  document.documentElement.dataset.portal = '';
  document.documentElement.style.removeProperty('--brand');
  const root = document.getElementById('portal-picker');
  root.replaceChildren(
    el('div', { class: 'picker-inner' }, [
      el('div', { class: 'brand' }, [
        el('span', { class: 'brand-mark', text: '🌾' }),
        el('div', {}, [
          el('h1', { text: 'Mekong Green' }),
          el('p', { text: 'AgriGreen Platform & ERP nội bộ — chọn cổng nghiệp vụ để bắt đầu' }),
        ]),
      ]),
      el('p', { class: 'muted picker-hello' }, [
        el('strong', { text: me.fullName }), ' · ', (me.roleLabels ?? []).join(' · '),
      ]),
      warning ? alert(warning, 'warn') : null,
      allowed.length
        ? el('div', { class: 'portal-cards' }, allowed.map((portal) => el('a', {
            class: 'portal-card',
            href: `${portal.path}/`,
            style: `--card-accent:${portal.accent}`,
          }, [
            el('span', { class: 'portal-card-mark', text: portal.mark }),
            el('strong', { text: portal.name }),
            el('p', { class: 'muted', text: portal.tagline }),
            el('p', { class: 'portal-card-audience', text: portal.audience }),
          ])))
        : alert('Tài khoản của bạn chưa được cấp quyền vào cổng nào. Liên hệ quản trị nền tảng.', 'bad'),
      el('button', {
        class: 'ghost small', text: 'Đăng xuất',
        onclick: async () => { await api('/auth/logout', { body: {} }).catch(() => {}); location.href = '/'; },
      }),
    ]),
  );
}

/** Gửi lại hàng đợi offline theo thứ tự; dừng ở thao tác đầu tiên còn mất mạng. */
export async function flushQueue() {
  let queue = readQueue();
  if (!queue.length) return { sent: 0, dropped: 0 };
  let sent = 0;
  let dropped = 0;
  while (queue.length) {
    const item = queue[0];
    try {
      await api(item.path, { method: item.method, body: item.body, idempotencyKey: item.key, noQueue: true });
      sent += 1;
    } catch (error) {
      if (/Không kết nối được/.test(error.message)) break; // vẫn mất mạng — giữ lại, thử sau
      // Lỗi nghiệp vụ (400): gửi lại cũng không qua — bỏ khỏi hàng đợi và báo.
      dropped += 1;
      toast(`Thao tác lúc ${item.at.slice(11, 16)} bị từ chối: ${error.message}`, true);
    }
    queue = queue.slice(1);
    writeQueue(queue);
  }
  if (sent) toast(`Đã gửi ${sent} thao tác chờ từ lúc mất mạng.`);
  return { sent, dropped };
}

function renderOfflineBar() {
  const bar = document.getElementById('offline-bar');
  if (!bar) return;
  const pending = pendingQueue();
  const offline = !navigator.onLine;
  if (!offline && !pending) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.replaceChildren(
    el('span', { text: offline ? '📵 Đang mất mạng — dữ liệu nhập được lưu tạm trên máy' : '📶 Có mạng' }),
    pending ? el('span', { text: `· ${pending} thao tác chờ gửi` }) : null,
    pending && !offline ? el('button', { text: 'Gửi ngay', onclick: () => flushQueue() }) : null,
  );
}

function watchConnectivity() {
  window.addEventListener('online', () => { renderOfflineBar(); flushQueue(); });
  window.addEventListener('offline', renderOfflineBar);
  setInterval(() => { if (navigator.onLine && pendingQueue()) flushQueue(); }, 60_000);
  renderOfflineBar();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Chuông thông báo — cùng một chuông trên mọi cổng
// ---------------------------------------------------------------------------
let lastSeenNotification = null;

function mountBell() {
  const host = document.getElementById('topbar-tools');
  if (!host) return;
  const count = el('span', { class: 'count', hidden: true });
  const panel = el('div', { class: 'bell-panel', hidden: true });
  const button = el('button', { class: 'bell', title: 'Thông báo', 'aria-label': 'Thông báo' }, [icon('bell', 18), count]);
  host.replaceChildren(button, panel);

  const draw = (data) => {
    count.hidden = !data.unread;
    count.textContent = String(data.unread);
    panel.replaceChildren(
      el('header', {}, [
        el('strong', { text: data.unread ? `${data.unread} chưa đọc` : 'Không có thông báo mới' }),
        data.unread ? el('button', { class: 'small ghost', text: 'Đánh dấu đã đọc hết', onclick: async () => { await api('/notifications/read', { body: { ids: 'all' } }); await poll(); } }) : null,
      ]),
      ...(data.items.length ? data.items.map((item) => el('div', {
        class: `notif ${item.severity} ${item.read_at ? '' : 'unread'}`,
        onclick: async () => {
          if (!item.read_at) await api('/notifications/read', { body: { ids: [item.id] } }).catch(() => undefined);
          panel.hidden = true;
          if (item.link) {
            const [path, hash] = item.link.split('#');
            if (path && path !== `${location.pathname}`) location.href = item.link; else if (hash) await navigate(hash);
          }
          await poll();
        },
      }, [
        el('span', { class: 'dot' }),
        el('div', {}, [el('div', { class: 'title', text: item.title }), el('div', { class: 'body', text: item.body }), el('div', { class: 'when', text: dateTime(item.created_at) })]),
      ])) : [el('p', { class: 'muted', style: 'padding:12px', text: 'Cảnh báo dịch hại, thời tiết, nhiệm vụ quá hạn, cách ly thuốc, kho, cân lệch… sẽ hiện ở đây.' })]),
    );
    // Trình duyệt cho phép thì báo cả khi đang ở tab khác.
    const newest = data.items[0];
    if (newest && !newest.read_at && lastSeenNotification && newest.id !== lastSeenNotification && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(newest.title, { body: newest.body }); } catch { /* bỏ qua */ }
    }
    if (newest) lastSeenNotification = newest.id;
  };
  const poll = async () => {
    try { draw(await api('/notifications?limit=20')); } catch { /* mất mạng — giữ nội dung cũ */ }
  };
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined);
  });
  document.addEventListener('click', (event) => { if (!host.contains(event.target)) panel.hidden = true; });
  poll();
  setInterval(poll, 45_000);
}

// ---------------------------------------------------------------------------
// Màn hình đăng nhập
// ---------------------------------------------------------------------------
function mountLogin() {
  const formEl = document.getElementById('login-form');
  // Không hiển thị bất kỳ tài khoản/mật khẩu mẫu nào trên trang đăng nhập.
  document.getElementById('toggle-pw')?.addEventListener('click', () => {
    const pw = formEl.elements.password;
    pw.type = pw.type === 'password' ? 'text' : 'password';
  });
  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const errorBox = document.getElementById('login-error');
    const submit = event.target.querySelector('button[type=submit]');
    errorBox.textContent = '';
    submit.disabled = true;
    try {
      await api('/auth/login', { body: { username: String(form.get('username')).trim(), password: form.get('password') } });
      await boot();
    } catch (error) {
      // 423: tài khoản bị khoá (5 lần sai / khoá thủ công) — máy chủ đã nêu rõ thời điểm mở khoá.
      errorBox.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

/**
 * Khởi động ứng dụng. Được gọi bởi `boot.js` SAU khi mọi trang đã đăng ký.
 *
 * Lưu ý kiến trúc: app.js KHÔNG được tự `await import()` các trang, vì các trang
 * lại import ngược app.js — top-level await trong một chu trình ESM như vậy sẽ
 * khoá cứng (deadlock) và không trang nào được đăng ký.
 */
export function bootstrap() {
  mountLogin();
  document.getElementById('logout').addEventListener('click', async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    location.reload();
  });
  document.getElementById('menu-btn')?.addEventListener('click', () => toggleSidebar());
  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && pages[id] && id !== state.page) navigate(id);
  });
  return boot();
}
