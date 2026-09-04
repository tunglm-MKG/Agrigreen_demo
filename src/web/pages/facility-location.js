/**
 * Hộp thoại chọn lại vị trí cơ sở vận hành trên bản đồ.
 *
 * Dùng chung cho Nhà máy đầu ra, Hub và Kho — mọi cơ sở đều là bản ghi trong
 * cùng danh mục multi-site nên chỉ cần một công cụ.
 */
import {
  api, el, card, badge, alert, num, toast, guard, mapContainer, createMap, LEAFLET_AVAILABLE,
} from '/app.js';

const KIND_LABEL = { hub: 'Hub trung chuyển', warehouse: 'Kho', yard: 'Bãi', plant: 'Nhà máy đầu ra' };

/**
 * Mở trình chọn vị trí.
 *
 * @param {object} facility bản ghi cơ sở hiện tại
 * @param {{onSaved?:(result:object)=>void, onClose?:()=>void}} hooks
 * @returns {HTMLElement} thẻ card để chèn vào trang
 */
export function facilityLocationEditor(facility, hooks = {}) {
  const original = { lat: Number(facility.lat), lng: Number(facility.lng) };
  let picked = { ...original };

  const mapId = `loc-map-${facility.id}`;
  const readout = el('div', { class: 'grid cols-3' });
  const warningBox = el('div');
  const latInput = el('input', { type: 'number', step: '0.000001', value: original.lat, id: `${mapId}-lat` });
  const lngInput = el('input', { type: 'number', step: '0.000001', value: original.lng, id: `${mapId}-lng` });

  let map = null;
  let marker = null;
  let originalMarker = null;
  let line = null;

  function movedKm() {
    const R = 6371.0088;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(picked.lat - original.lat);
    const dLng = toRad(picked.lng - original.lng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(original.lat)) * Math.cos(toRad(picked.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function refresh() {
    latInput.value = picked.lat.toFixed(6);
    lngInput.value = picked.lng.toFixed(6);
    const distance = movedKm();
    readout.replaceChildren(
      el('div', { class: 'kpi' }, [
        el('div', { class: 'label', text: 'Vị trí hiện lưu' }),
        el('div', { class: 'value', style: 'font-size:15px', text: `${original.lat.toFixed(6)}, ${original.lng.toFixed(6)}` }),
      ]),
      el('div', { class: 'kpi' }, [
        el('div', { class: 'label', text: 'Vị trí mới chọn' }),
        el('div', { class: 'value', style: 'font-size:15px', text: `${picked.lat.toFixed(6)}, ${picked.lng.toFixed(6)}` }),
      ]),
      el('div', { class: 'kpi' }, [
        el('div', { class: 'label', text: 'Dịch chuyển' }),
        el('div', {
          class: 'value',
          style: `font-size:15px; color: var(--${distance > 0.001 ? 'gold' : 'muted'})`,
          text: distance > 0.001 ? `${distance.toFixed(3)} km` : 'chưa thay đổi',
        }),
      ]),
    );
    if (map && marker) {
      marker.setLatLng([picked.lat, picked.lng]);
      if (line) line.setLatLngs([[original.lat, original.lng], [picked.lat, picked.lng]]);
    }
  }

  function setPicked(lat, lng) {
    picked = { lat: Number(Number(lat).toFixed(6)), lng: Number(Number(lng).toFixed(6)) };
    refresh();
  }

  const body = [
    el('p', { class: 'muted', text: 'Nhấp vào bản đồ hoặc kéo ghim đỏ tới đúng vị trí, hoặc nhập trực tiếp toạ độ. Ghim xám là vị trí đang lưu trong hệ thống.' }),
    readout,
    el('div', { class: 'row' }, [
      el('label', {}, ['Vĩ độ (lat)', latInput]),
      el('label', {}, ['Kinh độ (lng)', lngInput]),
      el('button', {
        class: 'ghost small',
        text: '↳ Áp dụng toạ độ đã nhập',
        onclick: () => {
          const lat = Number(latInput.value);
          const lng = Number(lngInput.value);
          if (!Number.isFinite(lat) || Math.abs(lat) > 90) return toast('Vĩ độ không hợp lệ.', true);
          if (!Number.isFinite(lng) || Math.abs(lng) > 180) return toast('Kinh độ không hợp lệ.', true);
          setPicked(lat, lng);
          if (map) map.setView([lat, lng], Math.max(map.getZoom(), 13));
        },
      }),
      el('button', { class: 'ghost small', text: '↺ Về vị trí cũ', onclick: () => {
        setPicked(original.lat, original.lng);
        if (map) map.setView([original.lat, original.lng], map.getZoom());
      } }),
    ]),
    mapContainer(mapId, 'tall'),
    warningBox,
    el('div', { class: 'chip-row' }, [
      el('button', {
        class: 'small',
        text: '💾 Lưu vị trí',
        onclick: async () => {
          if (movedKm() <= 0.001) return toast('Vị trí chưa thay đổi.', true);
          const result = await guard(api(`/mdm/facilities/${facility.id}`, {
            method: 'PUT',
            body: { lat: picked.lat, lng: picked.lng },
          }));
          toast(`Đã lưu vị trí mới — dịch chuyển ${result.movedKm} km.`);
          renderAfterSave(result);
          hooks.onSaved?.(result);
        },
      }),
      el('button', {
        class: 'ghost small', text: 'Đóng',
        onclick: () => { container.remove(); hooks.onClose?.(); },
      }),
    ]),
  ];

  const container = card(
    `Vị trí — ${facility.code} · ${facility.name}`,
    body,
    badge(KIND_LABEL[facility.kind] ?? facility.kind, facility.kind === 'plant' ? 'info' : 'neutral'),
  );

  function renderAfterSave(result) {
    original.lat = Number(result.facility.lat);
    original.lng = Number(result.facility.lng);
    const notes = [
      alert(
        `Đã cập nhật toạ độ và dọn ${result.clearedDistanceCache} bản ghi cache khoảng cách dùng toạ độ cũ ` +
        '(FN-04 BR-05 — khoảng cách được cache theo cặp toạ độ).',
        'good',
      ),
    ];
    if (result.staleScenarios.length) {
      notes.push(alert(
        `${result.staleScenarios.length} kịch bản đã mô phỏng nay LỖI THỜI vì khoảng cách Ruộng→Nhà máy và ` +
        `Hub→Nhà máy đã đổi: ${result.staleScenarios.map((s) => `${s.code} (${s.name})`).join(', ')}. ` +
        'Hãy mở Hub Planner và chạy lại mô phỏng cho các kịch bản này.',
        'warn',
      ));
    }
    warningBox.replaceChildren(...notes);
    if (originalMarker && map) originalMarker.setLatLng([original.lat, original.lng]);
    refresh();
  }

  // Khởi tạo bản đồ sau khi thẻ đã được gắn vào DOM.
  setTimeout(() => {
    if (!LEAFLET_AVAILABLE()) return;
    map = createMap(mapId, [original.lat, original.lng], 13);
    if (!map) return;
    const L = window.L;

    originalMarker = L.circleMarker([original.lat, original.lng], {
      radius: 8, color: '#7C8B82', fillColor: '#FFFFFF', fillOpacity: 0.9, weight: 2,
    }).bindTooltip('Vị trí đang lưu').addTo(map);

    line = L.polyline([[original.lat, original.lng], [picked.lat, picked.lng]], {
      color: '#9C6414', weight: 2, dashArray: '5 4',
    }).addTo(map);

    marker = L.marker([picked.lat, picked.lng], { draggable: true })
      .bindTooltip('Vị trí mới — kéo để chỉnh', { permanent: false })
      .addTo(map);
    marker.on('dragend', (event) => {
      const position = event.target.getLatLng();
      setPicked(position.lat, position.lng);
    });
    map.on('click', (event) => setPicked(event.latlng.lat, event.latlng.lng));
  }, 60);

  refresh();
  return container;
}

export { KIND_LABEL };
