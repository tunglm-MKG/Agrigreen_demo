/**
 * Bộ icon nét mảnh (stroke) dùng chung cho thanh điều hướng và các nút — cùng phong
 * cách với ba bản mẫu giao diện (App Khuyến nông v5.0, App HTX v5.1, GIS v1.3).
 * Mọi icon là path 24×24, stroke = currentColor để đổi màu theo theme.
 */
const PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  map: '<path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/>',
  library: '<path d="M4 19.5V5a1 1 0 011-1h1a1 1 0 011 1v14.5"/><path d="M10.5 19.5V4a1 1 0 011-1h1a1 1 0 011 1v15.5"/><path d="M17 19.5V7a1 1 0 011-1h1a1 1 0 011 1v12.5"/><path d="M3 19.5h18"/>',
  training: '<path d="M3 8l9-4 9 4-9 4z"/><path d="M7 10.5V16c0 1.7 2.2 3 5 3s5-1.3 5-3v-5.5"/>',
  phone: '<path d="M4 5c0 8 7 15 15 15l2-3-4-2-2 2c-2-1-5-4-6-6l2-2-2-4z"/>',
  building: '<path d="M3 21V9l6-4 6 4v12"/><path d="M15 21V11l6 4v6"/><path d="M7 13h2M7 17h2"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 19c0-3 2.5-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14c2.8 0 5 1.8 5 4.5"/>',
  logout: '<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 8l-4 4 4 4M6 12h10"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12l3 3 5-6"/>',
  megaphone: '<path d="M3 11v2a2 2 0 002 2h1l5 3V6L6 9H5a2 2 0 00-2 2z"/><path d="M15 9a4 4 0 010 6M18 7a7 7 0 010 10"/>',
  price: '<path d="M4 18l5-6 4 3 7-9"/><path d="M15 6h5v5"/>',
  plot: '<path d="M4 6l7-2 9 3v11l-7 2-9-3z"/><path d="M11 4v15M4 6l9 3M13 9l7-3"/>',
  seed: '<path d="M12 21V12"/><path d="M12 12c-4 0-7-3-7-7 4 0 7 3 7 7z"/><path d="M12 12c4 0 7-3 7-7-4 0-7 3-7 7z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  log: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h6M9 16h6"/>',
  check: '<path d="M5 12l4 4L19 7"/>',
  harvest: '<path d="M12 21V9"/><path d="M12 9c-2-3-5-4-8-3 1 3 4 5 8 3z"/><path d="M12 9c2-3 5-4 8-3-1 3-4 5-8 3z"/><path d="M12 15c-2-3-5-4-8-3 1 3 4 5 8 3z"/><path d="M12 15c2-3 5-4 8-3-1 3-4 5-8 3z"/>',
  money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  tractor: '<circle cx="7" cy="17" r="3"/><circle cx="18" cy="18" r="2"/><path d="M4 14V9h6l2 5h4v-3h3v7"/><path d="M10 9V6h4v3"/>',
  support: '<path d="M20 15a3 3 0 01-3 3H8l-4 3V6a3 3 0 013-3h10a3 3 0 013 3z"/><path d="M12 8v4M12 15h.01"/>',
  weather: '<circle cx="8" cy="9" r="3.5"/><path d="M6 18h11a3.5 3.5 0 000-7 5 5 0 00-9.5 1.5"/>',
  news: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M7 9h6M7 13h10M7 17h10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.2-1.6l2-1.6-2-3.4-2.4 1a7 7 0 00-2.8-1.6L13 2h-4l-.6 2.8a7 7 0 00-2.8 1.6l-2.4-1-2 3.4 2 1.6A7 7 0 003 12a7 7 0 00.2 1.6l-2 1.6 2 3.4 2.4-1a7 7 0 002.8 1.6L9 22h4l.6-2.8a7 7 0 002.8-1.6l2.4 1 2-3.4-2-1.6A7 7 0 0019 12z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  tag: '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  bell: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path d="M10 21h4"/>',
  history: '<path d="M4 12a8 8 0 108-8"/><path d="M4 4v5h5"/><path d="M12 8v5l3 2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  scale: '<path d="M12 3v18M6 21h12"/><path d="M5 7h14"/><path d="M5 7l-3 6h6zM19 7l-3 6h6z"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  forecast: '<path d="M3 17l5-5 4 4 5-7 4 3"/><path d="M3 21h18"/>',
  upload: '<path d="M12 17V5"/><path d="M7 10l5-5 5 5"/><path d="M4 19h16"/>',
  wrench: '<path d="M14 6a4 4 0 105 5L9 21l-3-3z"/><path d="M14 6l4-3"/>',
  ruler: '<path d="M3 17l14-14 4 4L7 21z"/><path d="M8 12l2 2M11 9l2 2M14 6l2 2"/>',
  handshake: '<path d="M8 12l3 3a2 2 0 003 0l5-5-3-3-3 2-3-2H6l-3 3z"/><path d="M11 15l2 2a2 2 0 003 0l1-1"/>',
  boat: '<path d="M4 16l2 4h12l2-4z"/><path d="M4 16l8-2 8 2"/><path d="M12 4v10M12 4l5 7H7z"/>',
  water: '<path d="M12 3c4 5 6 8 6 11a6 6 0 01-12 0c0-3 2-6 6-11z"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-2 6-4 2 2-6z"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z"/>',
  grid: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  pin: '<path d="M12 21s6-5.5 6-11a6 6 0 10-12 0c0 5.5 6 11 6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  truck: '<path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  factory: '<path d="M3 21V10l5 3V10l5 3V10l5 3V5h3v16z"/><path d="M7 17h2M12 17h2M17 17h2"/>',
  refresh: '<path d="M20 12a8 8 0 01-14 5.3L4 15"/><path d="M4 20v-5h5"/><path d="M4 12a8 8 0 0114-5.3L20 9"/><path d="M20 4v5h-5"/>',
  download: '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  rain: '<path d="M7 15a5 5 0 01.7-9.9A6 6 0 0119 8a4 4 0 01-1 7"/><path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-1.5 4 1.5 4H5"/>',
  leaf: '<path d="M4 20c0-8 6-14 16-16-2 10-8 16-16 16z"/><path d="M4 20l8-8"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  mobile: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  gps: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4l11-11-4-4L4 16z"/><path d="M13 7l4 4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  print: '<path d="M6 9V4h12v5"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14v6h12v-6"/>',
  star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.3L12 17.5l-5.6 2.9 1.1-6.3L3 9.7l6.2-.9z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};

/** Trả về chuỗi SVG (dùng với `html:`) hoặc node (dùng với `el`). */
export function iconSvg(name, size = 20, cls = 'ico') {
  const path = PATHS[name] ?? PATHS.grid;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export function icon(name, size = 20, cls = 'ico') {
  const wrap = document.createElement('span');
  wrap.className = 'ico-wrap';
  wrap.innerHTML = iconSvg(name, size, cls);
  return wrap.firstElementChild;
}

export const ICON_NAMES = Object.keys(PATHS);
