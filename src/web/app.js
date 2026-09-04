/**
 * Lõi ứng dụng web: gọi API, điều hướng, và các hàm dựng giao diện dùng chung.
 *
 * Ứng dụng chạy theo mô hình NHIỀU CỔNG (portal): mỗi nhóm người dùng vào một
 * đường dẫn riêng (/kn, /htx, /cgh, /gis, /erp) với nhận diện và hệ thống chức
 * năng riêng. Xem `portals.js`. Trang gốc "/" là màn hình chọn cổng.
 */
import { PORTALS, portalFromPath, portalItems } from '/portals.js';

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export const state = { user: null, permissions: new Set(), page: null, portal: null };

/** Các cổng mà vai trò hiện tại được phép vào. */
export function allowedPortals() {
  return PORTALS.filter((portal) => can(portal.permission) && portalItems(portal).some((item) => can(item.permission) && pages[item.id]));
}

export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = payload?.error ?? `Lỗi ${response.status}`;
    throw new Error(message);
  }
  return payload;
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

export function kpi(label, value, sub, tone) {
  return el('div', { class: 'kpi' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value, style: tone ? `color: var(--${tone})` : null }),
    sub ? el('div', { class: 'sub', text: sub }) : null,
  ]);
}

export function badge(text, tone = 'neutral') {
  return el('span', { class: `badge ${tone}`, text });
}

export function alert(text, tone = 'info') {
  return el('div', { class: `alert ${tone}`, text });
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
  return el('div', { class: 'table-wrap' }, [
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
 * `fields` là mảng { name, label, type, options, value, required, placeholder, step }.
 * `onSubmit(values)` nhận đối tượng đã gom; ném lỗi thì thông báo hiện tại chỗ,
 * không làm mất dữ liệu người dùng đã gõ.
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
      rows: f.rows,
    };
    if (f.type === 'select') return field(f.label, select(f.name, f.options ?? [], { required: attrs.required }));
    if (f.type === 'textarea') {
      return field(f.label, el('textarea', { name: f.name, rows: f.rows ?? 3, placeholder: attrs.placeholder }, [f.value ?? '']));
    }
    return field(f.label, input(f.name, { ...attrs, type: f.type ?? 'text' }));
  });

  const formEl = el('form', {
    class: 'row',
    onsubmit: async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      const data = new FormData(event.target);
      const values = {};
      for (const f of fields) {
        const raw = data.get(f.name);
        values[f.name] = f.type === 'number' ? (raw === '' || raw === null ? null : Number(raw)) : raw;
      }
      try {
        await onSubmit(values);
        if (options.resetOnSuccess !== false) event.target.reset();
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
      }
    },
  }, [...controls, el('button', { type: 'submit', class: 'small', text: options.submitLabel ?? 'Lưu' })]);

  return el('div', {}, [formEl, errorBox]);
}

export function rawJson(label, data) {
  return el('details', { class: 'raw' }, [
    el('summary', { class: 'muted', text: label }),
    el('pre', { text: JSON.stringify(data, null, 2) }),
  ]);
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

export function createMap(id, center = [10.2, 105.8], zoom = 8) {
  if (!LEAFLET_AVAILABLE()) return null;
  // scrollWheelZoom tắt mặc định để con lăn chuột cuộn trang chứ không zoom bản
  // đồ; dùng nút +/- hoặc Ctrl + con lăn để phóng to/thu nhỏ.
  const map = window.L.map(id, { scrollWheelZoom: false }).setView(center, zoom);
  map.getContainer().addEventListener('wheel', (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
      map.setZoom(map.getZoom() + (event.deltaY < 0 ? 1 : -1));
    }
  }, { passive: false });

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

  street.addTo(map);
  // UX-01: luôn duy trì tối thiểu một lớp nền; cho phép đổi Đường phố/Vệ tinh/Địa hình.
  window.L.control.layers(
    { 'Đường phố': street, 'Vệ tinh': satellite, 'Địa hình': terrain },
    {}, { position: 'topright' },
  ).addTo(map);
  return map;
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

export async function navigate(id) {
  const page = pages[id];
  if (!page) return;
  state.page = id;
  // Giữ nguyên đường dẫn cổng; chỉ trang trong cổng nằm ở hash.
  history.replaceState(null, '', `${state.portal ? state.portal.path : ''}/#${id}`);
  document.querySelectorAll('#nav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === id);
  });
  document.getElementById('page-title').textContent = page.title;
  document.getElementById('page-subtitle').textContent = page.subtitle ?? '';
  const actions = document.getElementById('page-actions');
  actions.replaceChildren();
  const view = document.getElementById('view');
  view.replaceChildren(el('p', { class: 'muted', text: 'Đang tải…' }));
  try {
    await page.render(view, actions);
  } catch (error) {
    // Ghi stack ra console để dò lỗi; người dùng chỉ thấy thông điệp ngắn gọn.
    console.error(`[${id}] không dựng được trang:`, error);
    view.replaceChildren(alert(`Không tải được trang: ${error.message}`, 'bad'));
  }
}

function buildNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren();
  for (const group of (state.portal?.nav ?? [])) {
    const visible = group.items.filter((item) => can(item.permission) && pages[item.id]);
    if (!visible.length) continue;
    const container = el('div', { class: 'nav-group' }, [el('span', { text: group.group })]);
    for (const item of visible) {
      container.append(el('button', {
        dataset: { page: item.id },
        text: item.label,
        onclick: () => navigate(item.id),
      }));
    }
    nav.append(container);
  }
}

// ---------------------------------------------------------------------------
// Khởi động
// ---------------------------------------------------------------------------

export async function boot() {
  const me = await api('/auth/me').catch(() => ({ anonymous: true }));
  if (me?.anonymous) {
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
  // (Nông dân và cán bộ HTX là số đông; bắt họ qua một màn hình chọn chỉ có một
  // ô là thêm một bước vô nghĩa.)
  if (!requestedPortal && allowed.length === 1) {
    location.replace(`${allowed[0].path}/${location.hash}`);
    return;
  }

  // "/" hoặc cổng không tồn tại/không có quyền → màn hình chọn cổng.
  if (!requestedPortal || !allowed.includes(requestedPortal)) {
    if (requestedPortal && !allowed.includes(requestedPortal)) {
      // Vào thẳng URL một cổng không có quyền: nói rõ lý do thay vì im lặng đổi trang.
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

  document.getElementById('user-box').replaceChildren(
    el('div', {}, [
      el('strong', { text: me.fullName }),
      el('div', { class: 'muted', text: (me.roleLabels ?? []).join(' · ') }),
    ]),
  );
  buildPortalSwitch(allowed, requestedPortal);
  buildNav();

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

/** Đặt tên, khẩu hiệu, biểu tượng và màu nhấn theo cổng đang mở. */
function applyPortalIdentity(portal) {
  document.title = `${portal.name} — Mekong Green`;
  document.documentElement.style.setProperty('--brand', portal.accent);
  document.getElementById('portal-mark').textContent = portal.mark;
  document.getElementById('portal-name').textContent = portal.short;
  document.getElementById('portal-tagline').textContent = 'AgriGreen Platform';
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
      title: portal.tagline,
    }, [el('span', { class: 'mark', text: portal.mark }), portal.short]));
  }
  box.append(el('a', { class: 'portal-link muted', href: '/', text: '⌂ Tất cả các cổng' }));
}

/** Màn hình chọn cổng tại "/" — thay cho một thanh điều hướng gộp tất cả. */
function renderPortalPicker(me, allowed, warning) {
  document.title = 'Chọn cổng — Mekong Green';
  document.documentElement.style.removeProperty('--brand');
  const root = document.getElementById('portal-picker');
  root.replaceChildren(
    el('div', { class: 'picker-inner' }, [
      el('div', { class: 'brand' }, [
        el('span', { class: 'brand-mark', text: '🌾' }),
        el('div', {}, [
          el('h1', { text: 'Mekong Green' }),
          el('p', { text: 'AgriGreen Platform & ERP nội bộ' }),
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

/**
 * Khởi động ứng dụng. Được gọi bởi `boot.js` SAU khi mọi trang đã đăng ký.
 *
 * Lưu ý kiến trúc: app.js KHÔNG được tự `await import()` các trang, vì các trang
 * lại import ngược app.js — top-level await trong một chu trình ESM như vậy sẽ
 * khoá cứng (deadlock) và không trang nào được đăng ký.
 */
export function bootstrap() {
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const errorBox = document.getElementById('login-error');
    errorBox.textContent = '';
    try {
      await api('/auth/login', { body: { username: form.get('username'), password: form.get('password') } });
      await boot();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });

  document.getElementById('logout').addEventListener('click', async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    location.reload();
  });

  return boot();
}
