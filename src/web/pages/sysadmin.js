/**
 * QUẢN TRỊ HỆ THỐNG — tài khoản, nhóm người dùng, phân quyền.
 *
 *   sys-users   Danh sách tài khoản: tạo, sửa hồ sơ, gán nhóm, khoá, đặt lại mật khẩu
 *   sys-groups  Nhóm người dùng và ma trận phân quyền chỉnh trực tiếp
 *
 * Nguyên tắc hiển thị: mọi thao tác nguy hiểm phải nói rõ hậu quả TRƯỚC khi làm,
 * và ma trận quyền phải phân biệt được ô nào là mặc định, ô nào đã bị chỉnh.
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num, dateTime,
  toast, guard, can, form, state, navigate, modal, confirmDialog, icon,
} from '/app.js';
import { PORTALS } from '/portals.js';

// ---------------------------------------------------------------------------
// Cơ cấu phân quyền 09/2026: SAdmin làm việc trong cổng Quản trị; muốn xem nghiệp vụ phải VÀO một hệ thống.
// ---------------------------------------------------------------------------
registerPage('sys-systems', {
  title: 'Các hệ thống con',
  subtitle: 'Mỗi hệ thống có quản trị riêng (nhóm *_admin). Quản trị nền tảng chỉ xem/thao tác nghiệp vụ SAU KHI vào hệ thống — mỗi phiên ở trong một hệ thống, có nhật ký',
  async render(view) {
    const [lookups, usersAll] = await Promise.all([guard(api('/admin/lookups')), api('/admin/user-views')]);
    const me = state.user ?? {};
    const systems = lookups.allSystems ?? [];
    const roleSystem = Object.fromEntries((lookups.assignableRoles ?? []).map((r) => [r.code, r.system]));
    const countBy = (code) => usersAll.filter((u) => (u.roles ?? []).some((r) => roleSystem[r] === code)).length;
    const adminsOf = (code) => usersAll.filter((u) => (u.roles ?? []).includes(`${code}_admin`)).map((u) => u.username);
    const enter = async (code) => {
      await guard(api('/auth/enter-system', { body: { system: code } }));
      const portal = PORTALS.find((p) => p.id === code);
      toast(`Đã vào ${portal?.name ?? code}. Mọi thao tác trong hệ thống này được ghi nhật ký với phiên quản trị.`);
      location.href = `${portal?.path ?? '/'}/`;
    };
    view.replaceChildren(
      me.activeSystem
        ? alert(`Phiên này đang ở trong ${systems.find((s) => s.code === me.activeSystem)?.label ?? me.activeSystem}. Vào hệ thống khác sẽ thay thế; "Rời hệ thống" để chỉ còn quyền quản trị nền tảng.`, 'info')
        : alert('Phiên này chưa vào hệ thống nào — chỉ dùng được các tính năng quản trị nền tảng. Chọn "Vào hệ thống" để xem nghiệp vụ.', 'info'),
      el('div', { class: 'portal-cards' }, systems.map((s) => {
        const portal = PORTALS.find((p) => p.id === s.code);
        const admins = adminsOf(s.code);
        return el('div', { class: 'portal-card', style: `--card-accent:${portal?.accent ?? '#555'}` }, [
          el('span', { class: 'portal-card-mark', text: portal?.mark ?? '▣' }),
          el('strong', { text: s.label }),
          el('p', { class: 'muted', text: `${num(countBy(s.code))} tài khoản · quản trị hệ thống: ${admins.length ? admins.join(', ') : 'chưa có'}` }),
          el('div', { class: 'chip-row' }, [
            me.activeSystem === s.code ? badge('Đang ở trong', 'good') : null,
            el('button', { class: 'small', onclick: () => enter(s.code) }, [icon('login', 14), me.activeSystem === s.code ? 'Mở cổng' : 'Vào hệ thống']),
            el('button', { class: 'small ghost', text: 'Tạo quản trị hệ thống', onclick: () => navigate('sys-users') }),
          ]),
        ]);
      })),
      me.activeSystem ? el('button', { class: 'ghost small', text: 'Rời hệ thống (chỉ còn quản trị nền tảng)', onclick: async () => { await guard(api('/auth/leave-system', { body: {} })); location.reload(); } }) : null,
    );
  },
});

registerPage('sys-health', {
  title: 'Sức khoẻ cơ sở dữ liệu & sao lưu',
  subtitle: 'Toàn vẹn từng tệp, tham chiếu xuyên miền, lược đồ, tồn kho khớp lô, sao lưu VACUUM INTO',
  async render(view) {
    const health = await guard(api('/admin/db-health'));
    const refresh = () => this.render(view);
    view.replaceChildren(
      card('Tình trạng', [
        el('div', { class: 'chip-row' }, [
          ...health.integrity.map((d) => badge(`${d.domain}: ${d.result === 'ok' ? 'toàn vẹn' : d.result}`, d.result === 'ok' ? 'good' : 'bad')),
          badge(`${health.indexes.reduce((a, d) => a + d.explicit, 0)} chỉ mục`, 'neutral'),
          health.schema ? badge(`lược đồ ${health.schema.version}${health.schema.upToDate ? '' : ' — chưa áp, khởi động lại'}`, health.schema.upToDate ? 'good' : 'warn') : null,
          health.stock ? badge(health.stock.length ? `${health.stock.length} kho lệch tổng tồn/lô` : 'tồn kho khớp lô', health.stock.length ? 'bad' : 'good') : null,
        ]),
      ]),
      card(`Tham chiếu xuyên miền (${health.orphans.length} quan hệ không có khoá ngoại ở tầng SQLite — kiểm ở tầng ghi + rà hằng ngày)`, [
        health.orphans.some((o) => o.orphans > 0)
          ? table([{ key: 'table', label: 'Bảng con' }, { key: 'column', label: 'Cột' }, { key: 'parent', label: 'Bảng cha' }, { key: 'orphans', label: 'Mồ côi', align: 'right' }, { key: 'sample', label: 'Ví dụ', render: (r) => r.sample.join(', ') }], health.orphans.filter((o) => o.orphans > 0), { plain: true })
          : alert('Không có bản ghi mồ côi — mọi tham chiếu xuyên miền đều còn bản ghi cha.', 'good'),
      ]),
      card('Sao lưu', [
        el('div', { class: 'chip-row' }, [el('button', { class: 'small', onclick: async () => { const r = await guard(api('/admin/db-backup', { body: {} })); toast(`${r.manifest.ok ? 'Đã sao lưu' : 'Sao lưu lỗi'}: ${r.manifest.files.length} tệp trong ${r.manifest.durationMs} ms.`); await refresh(); } }, [icon('database', 14), 'Sao lưu ngay'])]),
        table([
          { key: 'createdAt', label: 'Lúc', render: (r) => dateTime(r.createdAt) }, { key: 'ok', label: 'Kết quả', render: (r) => badge(r.ok ? 'Hợp lệ' : 'Lỗi', r.ok ? 'good' : 'bad') },
          { key: 'bytes', label: 'Dung lượng', align: 'right', render: (r) => `${num(r.bytes / 1024)} KB` }, { key: 'dir', label: 'Thư mục', render: (r) => el('code', { text: r.dir }) },
        ], health.backups, { plain: true, empty: 'Chưa có đợt sao lưu nào — sao lưu tự động chạy 5 phút sau khi khởi động và mỗi 24 giờ (BACKUP_INTERVAL_HOURS).' }),
      ]),
    );
  },
});

/** Nhãn trạng thái gửi email mật khẩu tạm (trả về từ máy chủ). */
const EMAIL_STATUS = {
  cho_gui: ['Đã xếp hàng gửi email', 'good'],
  cho_cau_hinh: ['Chưa cấu hình kênh email — email sẽ gửi khi quản trị viên cấu hình ở "Thông báo & kênh gửi"; hãy copy mật khẩu và gửi trực tiếp', 'warn'],
  khong_co_email: ['Tài khoản chưa có địa chỉ email — không gửi được', 'warn'],
};

/**
 * Hộp thoại hiện mật khẩu tạm MỘT lần: ô chữ đơn cách có nút Sao chép (cả cặp tên đăng nhập +
 * mật khẩu) và trạng thái gửi email. Đóng là mất — máy chủ không lưu mật khẩu dạng đọc được.
 */
function credentialDialog({ title, username, temporaryPassword, email, revokedSessions }) {
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(`Đã sao chép ${label}.`); } catch { toast('Trình duyệt không cho phép sao chép tự động — hãy bôi đen và copy thủ công.', true); }
  };
  const pwBox = el('code', { class: 'mono', style: 'font-size:20px;letter-spacing:.08em;padding:8px 14px;border-radius:10px;background:var(--surface-2);user-select:all', text: temporaryPassword });
  const dlg = modal(title, [
    el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Tên đăng nhập' }), el('span', { class: 'v mono', text: username })]),
    el('div', { class: 'kv' }, [el('span', { class: 'k', text: 'Mật khẩu tạm' }), el('span', { class: 'v' }, [pwBox])]),
    el('div', { class: 'chip-row' }, [
      el('button', { class: 'small', onclick: () => copy(temporaryPassword, 'mật khẩu tạm') }, [icon('copy', 14), 'Sao chép mật khẩu']),
      el('button', { class: 'ghost small', onclick: () => copy(`Tên đăng nhập: ${username}\nMật khẩu tạm: ${temporaryPassword}\nĐăng nhập tại: ${location.origin}`, 'thông tin đăng nhập') }, [icon('copy', 14), 'Sao chép cả cặp']),
    ]),
    email ? alert(EMAIL_STATUS[email.status]?.[0] ?? email.status, EMAIL_STATUS[email.status]?.[1] ?? 'info') : el('p', { class: 'muted', text: 'Không gửi email — hãy chuyển mật khẩu tạm cho người dùng qua kênh an toàn.' }),
    revokedSessions !== undefined ? el('p', { class: 'muted', text: `Đã huỷ ${revokedSessions} phiên đang mở của tài khoản này.` }) : null,
    alert('Mật khẩu tạm chỉ hiện MỘT lần và không thể xem lại. Người dùng sẽ phải đổi mật khẩu mới (tối thiểu 8 ký tự, có chữ thường, chữ in hoa và chữ số) ở lần đăng nhập đầu.', 'warn'),
  ], [el('button', { text: 'Đã ghi lại, đóng', onclick: () => dlg.close() })], { dismissible: false });
  return dlg;
}

/**
 * Nhóm và tài khoản đang xem, giữ ở phạm vi module.
 *
 * Mỗi thay đổi quyền đều vẽ lại cả trang; nếu để biến trong hàm render thì sau
 * mỗi lần tick một ô, màn hình nhảy về nhóm đầu danh sách và người dùng mất chỗ
 * đang làm — đúng lúc họ cần tick liên tiếp nhiều ô.
 */
let lastGroupCode = null;
let lastUserId = null;

/** Gắn con vào khung nhìn, bỏ qua `null` của các điều kiện — nếu không DOM in ra chữ "null". */
const mount = (view, ...kids) => view.replaceChildren(...kids.filter((k) => k !== null && k !== undefined));

const STATUS = {
  active: { label: 'Hoạt động', tone: 'good' },
  locked: { label: 'Đã khoá', tone: 'bad' },
  pending: { label: 'Chờ kích hoạt', tone: 'warn' },
};

// ===========================================================================
// Tài khoản
// ===========================================================================

registerPage('sys-users', {
  title: 'Tài khoản người dùng',
  subtitle: 'Khởi tạo, phân nhóm, khoá và đặt lại mật khẩu — mọi thay đổi đều vào nhật ký truy vết',
  async render(view, actions) {
    const [dashboard, users, groupsAll, lookups, meta] = await Promise.all([
      guard(api('/admin/dashboard')), api('/admin/user-views'), api('/admin/groups'), api('/admin/lookups'), api('/admin/permissions'),
    ]);
    // SA-09: admin theo phạm vi chỉ thấy và gán được nhóm thuộc hệ thống mình quản.
    const assignable = new Set(lookups.assignableRoles.map((r) => r.code));
    const groups = groupsAll.filter((g) => lookups.superAdmin || assignable.has(g.code));
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const detail = el('div', { class: 'grid' });
    const provinceName = (id) => lookups.provinces.find((p) => p.id === id)?.name ?? null;
    const htxName = (id) => lookups.cooperatives.find((c) => c.id === id)?.name ?? null;

    const showDetail = async (userId) => {
      lastUserId = userId;
      const info = await guard(api(`/admin/users/${userId}`));
      detail.replaceChildren(card(`${info.username} — ${info.fullName}`, [
        el('div', { class: 'chip-row' }, [
          badge(STATUS[info.status]?.label ?? info.status, STATUS[info.status]?.tone ?? 'neutral'),
          ...info.roleLabels.map((label) => badge(label, 'info')),
          info.provinceId ? badge(`Tỉnh: ${provinceName(info.provinceId) ?? info.provinceId}`, 'neutral') : null,
          info.htxId ? badge(`HTX: ${htxName(info.htxId) ?? info.htxId}`, 'neutral') : null,
          info.mustChangePassword ? badge('Phải đổi mật khẩu', 'warn') : null,
          ...(info.adminScopes ?? []).map((sc) => badge(`Quản trị: ${sc.label}`, 'good')),
        ]),

        el('h4', { text: 'Quyền của tài khoản — theo từng nhóm' }),
        el('p', { class: 'muted', text: 'Hàng là quyền, cột là nhóm tài khoản đang thuộc; ô tick là quyền nhóm đó mang lại. Bảng chỉ để xem — đổi quyền của nhóm ở màn "Nhóm & phân quyền" (ảnh hưởng mọi người trong nhóm).' }),
        info.hasAllPermissions
          ? alert('Tài khoản có toàn quyền hệ thống (nhóm quản trị nền tảng).', 'warn')
          : permissionMatrixReadOnly(meta, info.byGroup),
        can('admin.groups') && !info.hasAllPermissions
          ? el('button', { class: 'small ghost', text: '🛡️ Mở bảng phân quyền nhóm', onclick: () => navigate('sys-groups') })
          : null,

        can('admin.users')
          ? el('div', { class: 'grid cols-2' }, [
              el('div', {}, [
                el('strong', { text: 'Cập nhật hồ sơ' }),
                form([
                  { name: 'fullName', label: 'Họ tên', required: true, value: info.fullName },
                  { name: 'email', label: 'Email', value: info.email ?? '' },
                  { name: 'phone', label: 'Điện thoại', value: info.phone ?? '' },
                ], async (values) => {
                  await api(`/admin/users/${userId}`, { method: 'PUT', body: values });
                  toast('Đã cập nhật hồ sơ.');
                  await refresh();
                }, { submitLabel: 'Lưu hồ sơ' }),
              ]),
              el('div', {}, [
                el('strong', { text: 'Nhóm người dùng' }),
                el('p', { class: 'muted', text: 'Tài khoản phải thuộc ít nhất một nhóm, nếu không sẽ không vào được cổng nào.' }),
                groupPicker(groups, info.roles, async (selected) => {
                  await guard(api(`/admin/users/${userId}/roles`, { method: 'PUT', body: { roles: selected } }));
                  toast('Đã cập nhật nhóm — quyền có hiệu lực ngay.');
                  await refresh();
                }),
              ]),
            ])
          : null,
      ]));
    };

    mount(view,
      dashboard.scoped
        ? alert(`Bạn đang quản trị trong phạm vi: ${dashboard.scopes.join('; ')}. Chỉ thấy và chỉ thao tác được trên tài khoản thuộc phạm vi này (SA-08); chỉ gán được nhóm của hệ thống mình quản (SA-09).`, 'info')
        : null,
      el('div', { class: 'grid cols-4' }, [
        kpi(dashboard.scoped ? 'Tài khoản trong phạm vi' : 'Tổng tài khoản', num(dashboard.totalUsers),
          `${num(dashboard.activeUsers)} hoạt động · ${num(dashboard.lockedUsers)} đã khoá`),
        dashboard.scoped
          ? kpi('Phạm vi', num(lookups.scopes.length), lookups.scopes.map((sc) => sc.label).join(' · '))
          : kpi('Quản trị nền tảng', num(dashboard.platformAdmins),
            'Hệ thống luôn phải còn ít nhất một',
            dashboard.platformAdmins <= 1 ? 'warning' : 'good'),
        kpi('Phiên đang mở', num(dashboard.activeSessions), 'Trên toàn hệ thống'),
        kpi('Phải đổi mật khẩu', num(dashboard.mustChangePassword),
          'Vừa được đặt lại mật khẩu tạm',
          dashboard.mustChangePassword ? 'warning' : 'good'),
      ]),

      !dashboard.scoped && dashboard.platformAdmins <= 1
        ? alert(
            'Chỉ còn MỘT tài khoản quản trị nền tảng đang hoạt động. Mất tài khoản đó là không còn ai ' +
            'vào sửa lại hệ thống — nên cấp quyền quản trị cho thêm một người nữa.', 'warn')
        : null,

      can('admin.users')
        ? card('Tạo tài khoản mới', [
            el('p', { class: 'muted', text: 'Hệ thống sinh mật khẩu tạm đạt chuẩn (≥ 8 ký tự, chữ thường, chữ hoa, chữ số) và buộc người dùng đổi ở lần đăng nhập đầu. Mật khẩu tạm hiện MỘT lần để copy; có thể gửi kèm qua email.' }),
            form([
              { name: 'username', label: 'Tên đăng nhập', required: true },
              { name: 'fullName', label: 'Họ tên', required: true },
              { name: 'email', label: 'Email' },
              { name: 'phone', label: 'Điện thoại' },
              {
                name: 'role', label: 'Nhóm ban đầu', type: 'select', required: true,
                options: groups.map((g) => ({ value: g.code, label: `${g.label}${g.isSystem ? '' : ' (tuỳ chỉnh)'}` })),
              },
              // SA-12: phạm vi tỉnh / HTX thì danh sách chỉ còn tỉnh / HTX của mình.
              { name: 'provinceId', label: 'Tỉnh', type: 'select', options: [{ value: '', label: '— không gắn tỉnh —' }, ...lookups.provinces.map((p) => ({ value: p.id, label: p.name }))] },
              { name: 'htxId', label: 'Hợp tác xã (nếu là tài khoản HTX)', type: 'select', options: [{ value: '', label: '— không —' }, ...lookups.cooperatives.map((c) => ({ value: c.id, label: c.name }))] },
              { name: 'sendEmail', label: 'Gửi email mật khẩu tạm tới địa chỉ email ở trên', type: 'checkbox', value: true },
            ], async (values) => {
              if (values.sendEmail && !values.email) throw new Error('Đã chọn gửi email nhưng chưa nhập địa chỉ email.');
              const result = await api('/admin/users', {
                body: { ...values, roles: [values.role], provinceId: values.provinceId || undefined, htxId: values.htxId || undefined, sendEmail: Boolean(values.sendEmail) },
              });
              credentialDialog({ title: `Đã tạo tài khoản ${result.user.username}`, username: result.user.username, temporaryPassword: result.temporaryPassword, email: result.email });
              await refresh();
            }, { submitLabel: '+ Tạo tài khoản' }),
          ])
        : null,

      card('Danh sách tài khoản', table([
        { key: 'username', label: 'Tên đăng nhập' },
        { key: 'fullName', label: 'Họ tên' },
        {
          key: 'roleLabels', label: 'Nhóm',
          render: (row) => el('span', { class: 'chip-row' }, row.roleLabels.map((l) => badge(l, 'info'))),
        },
        { key: 'provinceId', label: 'Tỉnh / HTX', render: (row) => [provinceName(row.provinceId), htxName(row.htxId)].filter(Boolean).join(' · ') || '—' },
        { key: 'permissionCount', label: 'Số quyền', align: 'right', render: (row) => num(row.permissionCount) },
        {
          key: 'activeSessions', label: 'Phiên mở', align: 'right',
          render: (row) => (row.activeSessions ? badge(num(row.activeSessions), 'good') : '—'),
        },
        { key: 'lastLoginAt', label: 'Đăng nhập gần nhất', render: (row) => (row.lastLoginAt ? dateTime(row.lastLoginAt) : '—') },
        {
          key: 'status', label: 'Trạng thái',
          render: (row) => badge(STATUS[row.status]?.label ?? row.status, STATUS[row.status]?.tone ?? 'neutral'),
        },
        {
          key: 'act', label: '',
          render: (row) => (can('admin.users')
            ? el('span', { class: 'chip-row' }, [
                el('button', {
                  class: 'ghost small', text: row.status === 'active' ? '🔒 Khoá' : '🔓 Mở khoá',
                  onclick: async () => {
                    if (row.status === 'active' && !window.confirm(
                      `Khoá tài khoản ${row.username}?\n\n` +
                      'Mọi phiên đang mở của người này bị huỷ ngay lập tức, họ sẽ bị đẩy ra khỏi hệ thống.',
                    )) return;
                    const result = await guard(api(`/admin/users/${row.id}/set-status`, {
                      body: { status: row.status === 'active' ? 'locked' : 'active' },
                    }));
                    toast(row.status === 'active'
                      ? `Đã khoá và huỷ ${result.revokedSessions} phiên đang mở.`
                      : 'Đã mở khoá tài khoản.');
                    await refresh();
                  },
                }),
                el('button', {
                  class: 'ghost small', text: '🔑 Đặt lại mật khẩu',
                  onclick: async () => {
                    const sendEmail = el('input', { type: 'checkbox', checked: row.email ? true : null, disabled: row.email ? null : true });
                    const ok = await confirmDialog(`Đặt lại mật khẩu cho ${row.username}? Người này bị đăng xuất khỏi mọi thiết bị và phải dùng mật khẩu tạm để vào lại.`, {
                      title: 'Đặt lại mật khẩu', okLabel: 'Đặt lại',
                      extra: [el('label', { class: 'pick-item' }, [sendEmail, row.email ? `Gửi mật khẩu tạm qua email (${row.email})` : 'Tài khoản chưa có email — sẽ chỉ hiện mật khẩu để copy'])],
                    });
                    if (!ok) return;
                    const result = await guard(api(`/admin/users/${row.id}/reset-pw`, { body: { sendEmail: sendEmail.checked } }));
                    credentialDialog({ title: `Đã đặt lại mật khẩu cho ${row.username}`, username: row.username, temporaryPassword: result.temporaryPassword, email: result.email, revokedSessions: result.revokedSessions });
                    await refresh();
                  },
                }),
                row.activeSessions
                  ? el('button', {
                      class: 'ghost small', text: '⏏ Đăng xuất',
                      onclick: async () => {
                        const result = await guard(api(`/admin/users/${row.id}/revoke-sessions`, { body: {} }));
                        toast(`Đã đăng xuất ${result.revokedSessions} phiên. Mật khẩu giữ nguyên.`);
                        await refresh();
                      },
                    })
                  : null,
              ])
            : '—'),
        },
      ], users, {
        onRowClick: (row) => showDetail(row.id),
        rowClass: (row) => (row.status !== 'active' ? 'muted-row' : null),
      })),

      detail,
    );

    // Mở lại đúng tài khoản đang xem sau khi trang vẽ lại.
    if (lastUserId && users.some((user) => user.id === lastUserId)) await showDetail(lastUserId);
  },
});

/**
 * Ma trận CHỈ XEM: hàng là quyền (nhãn tiếng Việt, gom theo mảng), cột là các nhóm của
 * một tài khoản, ô tick khi nhóm đó cấp quyền. Cột cuối "Hiệu lực" là hợp của các nhóm.
 */
function permissionMatrixReadOnly(meta, byGroup) {
  const groups = byGroup ?? [];
  const has = (g, code) => g.permissions.includes(code);
  const head = el('tr', {}, [
    el('th', { class: 'perm-sticky', text: 'Quyền' }),
    ...groups.map((g) => el('th', { class: 'perm-col' }, [el('div', { class: 'perm-col-name', text: g.label })])),
    el('th', { class: 'perm-col' }, [el('div', { class: 'perm-col-name', text: 'Hiệu lực' })]),
  ]);
  const rows = [];
  for (const section of meta.groups) {
    const perms = section.permissions.filter((p) => groups.some((g) => has(g, p.code)));
    if (!perms.length) continue; // bỏ mảng tài khoản không có quyền nào — bảng ngắn hơn, dễ đọc hơn
    rows.push(el('tr', { class: 'perm-section-row' }, [el('td', { colspan: groups.length + 2, text: section.group })]));
    for (const p of perms) {
      rows.push(el('tr', {}, [
        el('td', { class: 'perm-sticky' }, [el('div', { text: p.label }), el('div', { class: 'muted perm-code', text: p.code })]),
        ...groups.map((g) => el('td', { class: 'perm-tick' }, [el('input', { type: 'checkbox', checked: has(g, p.code), disabled: true })])),
        el('td', { class: 'perm-tick effective' }, [el('input', { type: 'checkbox', checked: true, disabled: true })]),
      ]));
    }
  }
  if (!rows.length) return el('p', { class: 'muted', text: 'Các nhóm của tài khoản này chưa được cấp quyền nào.' });
  return el('div', { class: 'perm-matrix-wrap compact' }, [el('table', { class: 'perm-matrix' }, [el('thead', {}, [head]), el('tbody', {}, rows)])]);
}

/** Danh sách nhóm có ô chọn, kèm nút lưu. */
function groupPicker(groups, current, onSave) {
  const selected = new Set(current);
  const list = el('div', { class: 'pick-list' }, groups.map((group) =>
    el('label', { class: 'pick-item' }, [
      el('input', {
        type: 'checkbox',
        checked: selected.has(group.code),
        onchange: (event) => {
          if (event.target.checked) selected.add(group.code);
          else selected.delete(group.code);
        },
      }),
      el('span', {}, [
        group.label,
        el('span', { class: 'muted', text: ` · ${group.effectivePermissions.length} quyền` }),
      ]),
    ])));

  return el('div', {}, [
    list,
    el('button', {
      class: 'small', text: 'Lưu nhóm', style: 'margin-top:8px',
      onclick: () => onSave([...selected]),
    }),
  ]);
}

// ===========================================================================
// Nhóm người dùng & ma trận phân quyền
// ===========================================================================

registerPage('sys-groups', {
  title: 'Nhóm & phân quyền',
  subtitle: 'Một bảng: hàng là quyền, cột là nhóm (cấp). Tick ô cần cấp, bấm Lưu.',
  async render(view, actions) {
    const [groups, meta, lookups] = await Promise.all([
      guard(api('/admin/groups')), api('/admin/permissions'), api('/admin/lookups'),
    ]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const editable = can('admin.groups');

    // Nhóm → hệ thống (để lọc cột). Nhóm tuỳ chỉnh không thuộc hệ thống nào.
    const systemOf = Object.fromEntries((lookups.assignableRoles ?? []).map((r) => [r.code, r.system]));
    const systemLabel = Object.fromEntries((lookups.allSystems ?? []).map((sys) => [sys.code, sys.label]));
    let filter = sessionStorage.getItem('perm-matrix-filter') ?? 'all';
    const visibleGroups = () => groups.filter((g) => {
      if (filter === 'all') return true;
      if (filter === 'custom') return !g.isSystem;
      return systemOf[g.code] === filter;
    });

    // Thay đổi chờ lưu: khoá "nhóm|quyền" → true/false. Lưu một lần, không gọi API mỗi ô.
    const pending = new Map();
    const saveBar = el('div', { class: 'save-bar', hidden: true });
    const drawSaveBar = () => {
      saveBar.hidden = pending.size === 0;
      saveBar.replaceChildren(
        el('strong', { text: `${pending.size} thay đổi chưa lưu` }),
        el('button', { class: 'small', text: '💾 Lưu', onclick: async () => {
          let ok = 0;
          for (const [key, granted] of pending) {
            const [code, permission] = key.split('|');
            try { await api(`/admin/groups/${code}/permission`, { method: 'PUT', body: { permission, granted } }); ok += 1; }
            catch (error) { toast(`${code} · ${permission}: ${error.message}`, true); }
          }
          toast(`Đã lưu ${ok}/${pending.size} thay đổi.`);
          pending.clear();
          await refresh();
        } }),
        el('button', { class: 'small ghost', text: 'Huỷ', onclick: () => { pending.clear(); drawMatrix(); drawSaveBar(); } }),
      );
    };

    const matrixHost = el('div', { class: 'perm-matrix-wrap' });
    const drawMatrix = () => {
      const cols = visibleGroups();
      const head = el('tr', {}, [
        el('th', { class: 'perm-sticky', text: 'Quyền' }),
        ...cols.map((g) => el('th', { class: 'perm-col' }, [
          el('div', { class: 'perm-col-name', text: g.label }),
          el('div', { class: 'muted', text: `${g.userCount} người${g.overrides.length ? ` · ${g.overrides.length} đã chỉnh` : ''}` }),
          g.overrides.length && editable
            ? el('button', { class: 'ghost small', text: '↺ mặc định', title: 'Bỏ mọi chỉnh sửa của nhóm này, theo lại mã nguồn', onclick: async () => {
                if (!window.confirm(`Trả nhóm "${g.label}" về quyền mặc định?`)) return;
                await guard(api(`/admin/groups/${g.code}/reset`, { body: {} })); toast('Đã trả về mặc định.'); await refresh();
              } })
            : null,
        ])),
      ]);
      const rows = [];
      for (const section of meta.groups) {
        rows.push(el('tr', { class: 'perm-section-row' }, [el('td', { colspan: cols.length + 1, text: section.group })]));
        for (const permission of section.permissions) {
          rows.push(el('tr', {}, [
            el('td', { class: 'perm-sticky' }, [el('div', { text: permission.label }), el('div', { class: 'muted perm-code', text: permission.code })]),
            ...cols.map((g) => {
              const root = g.defaultPermissions.includes('*');
              const key = `${g.code}|${permission.code}`;
              const effective = pending.has(key) ? pending.get(key) : g.effectivePermissions.includes(permission.code);
              const overridden = g.overrides.some((o) => o.permission === permission.code);
              const cell = el('td', { class: `perm-tick${overridden ? ' overridden' : ''}${pending.has(key) ? ' pending' : ''}`, title: root ? 'Quản trị nền tảng luôn có toàn quyền' : (overridden ? `Đã chỉnh — mặc định: ${g.defaultPermissions.includes(permission.code) ? 'có' : 'không'}` : '') });
              const box = el('input', { type: 'checkbox', checked: root || effective, disabled: root || !editable });
              box.addEventListener('change', () => {
                const original = g.effectivePermissions.includes(permission.code);
                if (box.checked === original) pending.delete(key); else pending.set(key, box.checked);
                cell.classList.toggle('pending', pending.has(key));
                drawSaveBar();
              });
              cell.append(box);
              return cell;
            }),
          ]));
        }
      }
      matrixHost.replaceChildren(el('table', { class: 'perm-matrix' }, [el('thead', {}, [head]), el('tbody', {}, rows)]));
    };

    const filterBar = el('div', { class: 'chip-row' }, [
      ...[['all', 'Tất cả nhóm'], ...(lookups.allSystems ?? []).map((sys) => [sys.code, sys.label]), ['custom', 'Nhóm tuỳ chỉnh']].map(([key, label]) =>
        el('button', { class: `chip${filter === key ? ' active' : ''}`, text: label, onclick: () => { filter = key; sessionStorage.setItem('perm-matrix-filter', key); filterBar.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.textContent === label)); drawMatrix(); } })),
    ]);
    void systemLabel;

    mount(view,
      el('div', { class: 'grid cols-4' }, [
        kpi('Nhóm (cấp)', num(groups.length), `${num(groups.filter((g) => !g.isSystem).length)} nhóm tuỳ chỉnh`),
        kpi('Quyền', num(meta.groups.reduce((n, sec) => n + sec.permissions.length, 0)), `${meta.groups.length} mảng chức năng`),
        kpi('Nhóm đã chỉnh', num(groups.filter((g) => g.overrides.length).length), 'Khác mặc định trong mã nguồn'),
        kpi('Chưa có người', num(groups.filter((g) => !g.userCount).length), 'Nhóm không ai dùng'),
      ]),
      editable ? null : alert('Bạn chỉ xem được. Sửa ma trận nhóm–quyền là việc của quản trị nền tảng (SA-10).', 'info'),
      card('Ma trận nhóm – quyền', [
        el('p', { class: 'muted', text: 'Tick ô để cấp, bỏ tick để thu hồi, rồi bấm Lưu ở thanh dưới. Ô nền vàng là đã chỉnh khác mặc định; rê chuột để xem mặc định. Cột Quản trị nền tảng luôn toàn quyền.' }),
        filterBar,
        matrixHost,
      ]),
      saveBar,
      editable
        ? el('details', { class: 'perm-new-group' }, [
            el('summary', { text: '+ Tạo nhóm (cấp) mới' }),
            el('p', { class: 'muted', text: 'Nhóm mới bắt đầu từ không có quyền nào — tick từng quyền cần thiết trong bảng trên.' }),
            form([
              { name: 'code', label: 'Mã nhóm', required: true, placeholder: 'ke-toan-htx' },
              { name: 'label', label: 'Tên hiển thị', required: true, placeholder: 'Kế toán HTX' },
              { name: 'description', label: 'Mô tả' },
            ], async (values) => {
              const created = await api('/admin/groups', { body: values });
              toast(`Đã tạo nhóm ${created.label}.`);
              await refresh();
            }, { submitLabel: '+ Tạo nhóm' }),
          ])
        : null,
    );
    drawMatrix();
  },
});

// ===========================================================================

registerPage('sys-notify', {
  title: 'Thông báo & kênh gửi',
  subtitle: 'Hệ thống biết thì phải nói: chuông trong ứng dụng luôn bật; Zalo OA và SMS cần cấu hình',
  async render(view, actions) {
    const [channels, problems] = await Promise.all([guard(api('/notifications/channels')), api('/notifications/problems')]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    actions.append(el('button', { class: 'small', text: '⟳ Quét cảnh báo & gửi ngay', onclick: async () => {
      const result = await guard(api('/notifications/scan', { body: {} }));
      toast(`Quét xong: ${Object.entries(result.scan).map(([k, v]) => `${k} ${v}`).join(' · ')} — gửi ${result.outbox.sent}, lỗi ${result.outbox.failed}.`);
      await refresh();
    } }));

    const channelCard = (key, info, fields) => card(info.label, [
      el('div', { class: 'chip-row' }, [
        badge(info.configured ? 'Đã cấu hình' : 'Chưa cấu hình', info.configured ? 'good' : 'warn'),
        info.sent !== undefined ? badge(`${num(info.sent)} đã gửi`, 'neutral') : null,
        info.queued ? badge(`${num(info.queued)} chờ gửi`, 'info') : null,
        info.waitingConfig ? badge(`${num(info.waitingConfig)} chờ cấu hình`, 'warn') : null,
        info.failed ? badge(`${num(info.failed)} lỗi`, 'bad') : null,
        info.recipients !== undefined ? badge(`${num(info.recipients)} người có Zalo id`, 'neutral') : null,
      ]),
      info.note ? el('p', { class: 'muted', text: info.note }) : null,
      fields && can('admin.config')
        ? form(fields, async (values) => {
            for (const [k, v] of Object.entries(values)) if (v) await api('/notifications/channels', { method: 'PUT', body: { key: k, value: v } });
            toast('Đã lưu cấu hình — các thông báo đang chờ sẽ được gửi ở lượt kế tiếp (≤ 30 giây).');
            await refresh();
          }, { submitLabel: 'Lưu' })
        : null,
    ]);

    mount(view,
      el('p', { class: 'muted', text: 'Mỗi thông báo tạo một dòng cho từng người nhận × từng kênh. Kênh chưa cấu hình không bị bỏ qua âm thầm: dòng nằm ở trạng thái "chờ cấu hình" cho tới khi bạn điền bên dưới. Giá trị token không ghi vào nhật ký.' }),
      el('div', { class: 'grid cols-2' }, [
        channelCard('inapp', channels.inapp, null),
        channelCard('zalo', channels.zalo, [
          { name: 'notify.zalo_access_token', label: 'Zalo OA access token', type: 'password', placeholder: channels.zalo.configured ? '•••••• (đã có — nhập để đổi)' : 'Dán token từ Zalo Official Account' },
        ]),
        channelCard('sms', channels.sms, [
          { name: 'notify.sms_gateway_url', label: 'URL cổng SMS (POST JSON {to, text})', placeholder: 'https://sms.nhacungcap.vn/api/send' },
          { name: 'notify.sms_gateway_token', label: 'Token cổng SMS', type: 'password' },
        ]),
        channelCard('email', channels.email, [
          { name: 'notify.email_webhook_url', label: 'URL webhook email (POST JSON {to, subject, text, from})', placeholder: 'https://mail.donvi.vn/api/send' },
          { name: 'notify.email_webhook_token', label: 'Token webhook email', type: 'password' },
          { name: 'notify.email_from', label: 'Địa chỉ người gửi', placeholder: 'no-reply@mekonggreen.vn' },
        ]),
        channelCard('webpush', channels.webpush, null),
      ]),
      card('Dòng chờ / lỗi gần nhất', table([
        { key: 'created_at', label: 'Tạo lúc', render: (row) => dateTime(row.created_at) },
        { key: 'username', label: 'Người nhận' },
        { key: 'channel', label: 'Kênh' },
        { key: 'title', label: 'Tiêu đề' },
        { key: 'status', label: 'Trạng thái', render: (row) => badge({ cho_gui: 'Chờ gửi', loi: 'Lỗi', cho_cau_hinh: 'Chờ cấu hình' }[row.status] ?? row.status, row.status === 'loi' ? 'bad' : 'warn') },
        { key: 'attempts', label: 'Lần thử', align: 'right' },
        { key: 'last_error', label: 'Lỗi cuối', render: (row) => row.last_error ?? '—' },
      ], problems, { empty: 'Không có dòng nào chờ hay lỗi.' })),
    );
  },
});

// ===========================================================================
// Phân cấp quản trị — uỷ quyền phạm vi (SA-11)
// ===========================================================================

registerPage('sys-scopes', {
  title: 'Phân cấp quản trị',
  subtitle: 'Mỗi hệ thống con, mỗi cấp một admin riêng — super admin uỷ quyền, admin cấp hệ thống uỷ quyền tiếp trong hệ thống mình',
  async render(view, actions) {
    const [scopes, lookups, users] = await Promise.all([guard(api('/admin/scopes')), api('/admin/lookups'), api('/admin/user-views')]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const systemLabel = (code) => lookups.allSystems.find((s) => s.code === code)?.label ?? code;
    const bySystem = {};
    for (const sc of scopes) (bySystem[sc.system] ??= []).push(sc);

    const grantForm = () => {
      const scopeType = el('select', { name: 'scopeType' }, [
        ...(lookups.superAdmin ? [el('option', { value: 'system' }, ['Toàn hệ thống'])] : []),
        el('option', { value: 'province' }, ['Cấp tỉnh']),
        el('option', { value: 'htx' }, ['Cấp hợp tác xã']),
      ]);
      const system = el('select', { name: 'system' }, lookups.systems.map((s) => el('option', { value: s.code }, [s.label])));
      const scopeId = el('select', { name: 'scopeId' });
      const user = el('select', { name: 'userId' }, users.filter((u) => !u.isPlatformAdmin).map((u) => el('option', { value: u.id }, [`${u.username} — ${u.fullName} (${u.roleLabels.join(', ')})`])));
      const note = el('input', { name: 'note', placeholder: 'Ghi chú (tuỳ chọn)' });
      const fillScopeId = () => {
        const type = scopeType.value;
        scopeId.replaceChildren(...(type === 'province'
          ? lookups.provinces.map((p) => el('option', { value: p.id }, [p.name]))
          : type === 'htx' ? lookups.cooperatives.map((c) => el('option', { value: c.id }, [c.name])) : [el('option', { value: '' }, ['— không áp dụng —'])]));
        scopeId.disabled = type === 'system';
      };
      scopeType.addEventListener('change', fillScopeId); fillScopeId();
      const error = el('p', { class: 'login-error', hidden: true });
      return el('div', {}, [
        el('div', { class: 'row' }, [
          el('label', {}, ['Tài khoản được uỷ quyền', user]),
          el('label', {}, ['Hệ thống', system]),
          el('label', {}, ['Cấp', scopeType]),
          el('label', {}, ['Đơn vị', scopeId]),
          el('label', {}, ['Ghi chú', note]),
          el('button', { class: 'small', text: '+ Uỷ quyền', onclick: async () => {
            error.hidden = true;
            try {
              const sc = await api('/admin/scopes', { body: { userId: user.value, system: system.value, scopeType: scopeType.value, scopeId: scopeId.value || undefined, note: note.value || undefined } });
              toast(`Đã uỷ quyền: ${sc.label}.`); await refresh();
            } catch (e) { error.textContent = e.message; error.hidden = false; }
          } }),
        ]),
        error,
      ]);
    };

    mount(view,
      el('div', { class: 'grid cols-4' }, [
        kpi('Phạm vi đã uỷ quyền', num(scopes.length), `${new Set(scopes.map((s) => s.userId)).size} tài khoản`),
        kpi('Cấp hệ thống', num(scopes.filter((s) => s.scopeType === 'system').length), 'Được uỷ quyền tiếp trong hệ thống mình'),
        kpi('Cấp tỉnh', num(scopes.filter((s) => s.scopeType === 'province').length), 'Chỉ quản cán bộ tỉnh mình'),
        kpi('Cấp HTX', num(scopes.filter((s) => s.scopeType === 'htx').length), 'Chỉ quản người của HTX mình'),
      ]),
      alert(lookups.superAdmin
        ? 'Bạn là quản trị nền tảng: uỷ quyền được mọi hệ thống, mọi cấp. Ma trận nhóm–quyền vẫn chỉ có bạn sửa (SA-10).'
        : `Bạn quản trị toàn hệ thống ${lookups.systems.map((s) => s.label).join(', ')} — uỷ quyền được phạm vi tỉnh / HTX trong hệ thống đó; không nhân bản quyền toàn hệ thống (SA-11).`, 'info'),
      card('Uỷ quyền mới', [
        el('p', { class: 'muted', text: 'Người được uỷ quyền phải đã thuộc một nhóm của hệ thống đó — nếu không họ không vào được cổng để quản trị. Gán nhóm ở màn Tài khoản trước.' }),
        grantForm(),
      ]),
      ...Object.entries(bySystem).map(([code, list]) => card(systemLabel(code), table([
        { key: 'username', label: 'Tài khoản' },
        { key: 'fullName', label: 'Họ tên' },
        { key: 'scopeType', label: 'Cấp', render: (r) => badge(lookups.scopeTypes[r.scopeType], r.scopeType === 'system' ? 'good' : r.scopeType === 'province' ? 'info' : 'neutral') },
        { key: 'scopeName', label: 'Đơn vị', render: (r) => r.scopeName ?? '— toàn hệ thống —' },
        { key: 'grantedBy', label: 'Uỷ quyền bởi', render: (r) => `${r.grantedBy ?? '—'} · ${dateTime(r.grantedAt)}` },
        { key: 'note', label: 'Ghi chú', render: (r) => r.note ?? '—' },
        { key: 'act', label: '', render: (r) => el('button', { class: 'small ghost', text: 'Thu hồi', onclick: async () => {
          if (!window.confirm(`Thu hồi phạm vi "${r.label}" của ${r.username}?`)) return;
          await guard(api(`/admin/scopes/${r.id}`, { method: 'DELETE' })); toast('Đã thu hồi.'); await refresh();
        } }) },
      ], list))),
      scopes.length ? null : alert('Chưa có phạm vi nào được uỷ quyền — mọi việc quản trị đang dồn về quản trị nền tảng.', 'warn'),
    );
  },
});

// ===========================================================================
// Miền dữ liệu & luồng đồng bộ dữ liệu dùng chung
// ===========================================================================

registerPage('sys-data', {
  title: 'Miền dữ liệu & đồng bộ',
  subtitle: 'Mỗi hệ thống con một tệp CSDL riêng; dữ liệu dùng chung ở một tệp và chảy sang từng hệ thống theo luồng đã khai',
  async render(view, actions) {
    const data = await guard(api('/admin/data-domains'));
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const mb = (b) => `${(b / 1_048_576).toFixed(2)} MB`;
    const receiverOf = (code) => data.sync.receivers.find((r) => r.system === code);
    mount(view,
      el('div', { class: 'grid cols-4' }, [
        kpi('Tệp CSDL', num(data.files.length), `${data.files.reduce((s, f) => s + f.tableCount, 0)} bảng`),
        kpi('Dung lượng', mb(data.files.reduce((s, f) => s + f.sizeBytes, 0)), 'Gồm WAL đang mở'),
        kpi('Luồng dùng chung', num(data.sync.flows.length), `${data.sync.flows.reduce((s, f) => s + f.events, 0)} thay đổi đã ghi`),
        kpi('Hệ thống còn nợ đồng bộ', num(data.sync.receivers.filter((r) => r.pending > 0).length), 'Chưa ack hết feed', data.sync.receivers.some((r) => r.pending > 0) ? 'warning' : 'good'),
      ]),
      data.sync.uncovered.length ? alert(`Bảng dùng chung chưa có luồng: ${data.sync.uncovered.join(', ')} — khai trong sharedFlows.ts.`, 'warn') : null,
      card('Tệp cơ sở dữ liệu theo miền', table([
        { key: 'label', label: 'Miền', render: (f) => el('div', {}, [el('strong', { text: f.label }), el('div', { class: 'muted', text: f.description })]) },
        { key: 'path', label: 'Tệp', render: (f) => el('code', { text: f.path.split(/[\\/]/).pop() }) },
        { key: 'sizeBytes', label: 'Dung lượng', align: 'right', render: (f) => mb(f.sizeBytes) },
        { key: 'tableCount', label: 'Bảng', align: 'right', render: (f) => `${f.tableCount}/${f.declared}` },
      ], data.files)),
      card('Luồng dữ liệu dùng chung: ai ghi, ai nhận', [
        el('p', { class: 'muted', text: 'Mỗi thực thể dùng chung có một chủ sở hữu và danh sách hệ thống nhận. Hệ thống con chỉ được ghi vào thứ mình là chủ hoặc đồng chủ; nguồn sự thật của mọi thay đổi là nhật ký truy vết.' }),
        table([
          { key: 'label', label: 'Thực thể', render: (f) => el('div', {}, [el('strong', { text: f.label }), el('div', { class: 'muted', text: f.entity })]) },
          { key: 'owner', label: 'Chủ (ghi)', render: (f) => el('span', { class: 'chip-row' }, [badge(f.owner, 'good'), ...(f.coWriters ?? []).map((w) => badge(w, 'info'))]) },
          { key: 'receivers', label: 'Nhận', render: (f) => el('span', { class: 'chip-row' }, f.receivers.map((r) => badge(r === '*' ? 'mọi hệ thống' : r, 'neutral'))) },
          { key: 'events', label: 'Thay đổi', align: 'right', render: (f) => num(f.events) },
          { key: 'lastChange', label: 'Gần nhất', render: (f) => (f.lastChange ? dateTime(f.lastChange) : '—') },
          { key: 'why', label: 'Vì sao', render: (f) => el('span', { class: 'muted', text: f.why }) },
        ], data.sync.flows),
      ]),
      card('Con trỏ đồng bộ của từng hệ thống con', [
        el('p', { class: 'muted', text: 'Cùng một tiến trình, các hệ thống đọc thẳng CSDL dùng chung nên không cần sao chép. Con trỏ ở đây là cho hệ thống con tách ra chạy riêng: kéo feed qua API, xử lý, rồi ack.' }),
        table([
          { key: 'system', label: 'Hệ thống' },
          { key: 'flows', label: 'Nhận', render: (r) => `${r.flows.length} thực thể` },
          { key: 'cursor', label: 'Đã ack tới', align: 'right' },
          { key: 'pending', label: 'Còn chờ', align: 'right', render: (r) => (r.pending ? badge(num(r.pending), 'warn') : badge('0', 'good')) },
          { key: 'acked', label: 'Ack lần cuối', render: (r) => (r.acked ? dateTime(r.acked) : '—') },
          { key: 'act', label: '', render: (r) => el('button', { class: 'small', text: 'Kéo feed & ack', onclick: async () => {
            const feed = await guard(api(`/sync/shared/feed?system=${r.system}&limit=500`));
            if (feed.events.length) await api('/sync/shared/ack', { body: { system: r.system, seq: feed.cursor } });
            toast(`${r.system}: nhận ${feed.events.length} thay đổi${feed.events.length ? `, ack tới #${feed.cursor}` : ''}.`);
            await refresh();
          } }) },
        ], data.sync.receivers),
      ]),
    );
    void receiverOf;
  },
});
