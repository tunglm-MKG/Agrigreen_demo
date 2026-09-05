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
  toast, guard, can, form, state,
} from '/app.js';

/**
 * Nhóm và tài khoản đang xem, giữ ở phạm vi module.
 *
 * Mỗi thay đổi quyền đều vẽ lại cả trang; nếu để biến trong hàm render thì sau
 * mỗi lần tick một ô, màn hình nhảy về nhóm đầu danh sách và người dùng mất chỗ
 * đang làm — đúng lúc họ cần tick liên tiếp nhiều ô.
 */
let lastGroupCode = null;
let lastUserId = null;

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
    const [dashboard, users, groups] = await Promise.all([
      guard(api('/admin/dashboard')), api('/admin/user-views'), api('/admin/groups'),
    ]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };
    const detail = el('div', { class: 'grid' });

    const showDetail = async (userId) => {
      lastUserId = userId;
      const info = await guard(api(`/admin/users/${userId}`));
      detail.replaceChildren(card(`${info.username} — ${info.fullName}`, [
        el('div', { class: 'chip-row' }, [
          badge(STATUS[info.status]?.label ?? info.status, STATUS[info.status]?.tone ?? 'neutral'),
          ...info.roleLabels.map((label) => badge(label, 'info')),
          info.mustChangePassword ? badge('Phải đổi mật khẩu', 'warn') : null,
        ]),

        el('h4', { text: 'Quyền đến từ nhóm nào' }),
        el('p', { class: 'muted', text: 'Bảng này trả lời câu hỏi hay gặp nhất khi phân quyền: vì sao người này vào được màn hình đó.' }),
        info.hasAllPermissions
          ? alert('Tài khoản có toàn quyền hệ thống (nhóm quản trị nền tảng).', 'warn')
          : table([
              { key: 'label', label: 'Nhóm' },
              {
                key: 'permissions', label: 'Quyền',
                render: (row) => (row.permissions.length
                  ? el('span', { class: 'chip-row' }, row.permissions.map((p) => badge(p, 'neutral')))
                  : el('span', { class: 'muted', text: 'Nhóm này chưa được cấp quyền nào' })),
              },
            ], info.byGroup),

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

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Tổng tài khoản', num(dashboard.totalUsers),
          `${num(dashboard.activeUsers)} hoạt động · ${num(dashboard.lockedUsers)} đã khoá`),
        kpi('Quản trị nền tảng', num(dashboard.platformAdmins),
          'Hệ thống luôn phải còn ít nhất một',
          dashboard.platformAdmins <= 1 ? 'warning' : 'good'),
        kpi('Phiên đang mở', num(dashboard.activeSessions), 'Trên toàn hệ thống'),
        kpi('Phải đổi mật khẩu', num(dashboard.mustChangePassword),
          'Vừa được đặt lại mật khẩu tạm',
          dashboard.mustChangePassword ? 'warning' : 'good'),
      ]),

      dashboard.platformAdmins <= 1
        ? alert(
            'Chỉ còn MỘT tài khoản quản trị nền tảng đang hoạt động. Mất tài khoản đó là không còn ai ' +
            'vào sửa lại hệ thống — nên cấp quyền quản trị cho thêm một người nữa.', 'warn')
        : null,

      can('admin.users')
        ? card('Tạo tài khoản mới', [
            el('p', { class: 'muted', text: 'Không đặt mật khẩu thì hệ thống sinh mật khẩu tạm và buộc người dùng đổi ở lần đăng nhập đầu. Mật khẩu tạm chỉ hiện MỘT lần.' }),
            form([
              { name: 'username', label: 'Tên đăng nhập', required: true },
              { name: 'fullName', label: 'Họ tên', required: true },
              { name: 'email', label: 'Email' },
              { name: 'phone', label: 'Điện thoại' },
              {
                name: 'role', label: 'Nhóm ban đầu', type: 'select', required: true,
                options: groups.map((g) => ({ value: g.code, label: `${g.label}${g.isSystem ? '' : ' (tuỳ chỉnh)'}` })),
              },
            ], async (values) => {
              const result = await api('/admin/users', {
                body: { ...values, roles: [values.role] },
              });
              window.alert(
                `Đã tạo tài khoản ${result.user.username}.\n\n` +
                `Mật khẩu tạm: ${result.temporaryPassword}\n\n` +
                'Ghi lại ngay — mật khẩu này không hiện lại lần nào nữa.',
              );
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
                    if (!window.confirm(
                      `Đặt lại mật khẩu cho ${row.username}?\n\n` +
                      'Người này bị đăng xuất khỏi mọi thiết bị và phải dùng mật khẩu tạm để vào lại.',
                    )) return;
                    const result = await guard(api(`/admin/users/${row.id}/reset-pw`, { body: {} }));
                    window.alert(
                      `Mật khẩu tạm của ${row.username}: ${result.temporaryPassword}\n\n` +
                      `Đã huỷ ${result.revokedSessions} phiên đang mở.\n` +
                      'Ghi lại ngay — mật khẩu này không hiện lại lần nào nữa.',
                    );
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
  title: 'Nhóm người dùng & phân quyền',
  subtitle: 'Điều chỉnh quyền của từng nhóm ngay trên giao diện, không phải sửa mã nguồn và triển khai lại',
  async render(view, actions) {
    const [groups, meta] = await Promise.all([
      guard(api('/admin/groups')), api('/admin/permissions'),
    ]);
    const refresh = async () => { actions.replaceChildren(); await this.render(view, actions); };

    let selectedCode = groups.some((g) => g.code === lastGroupCode) ? lastGroupCode : (groups[0]?.code ?? null);
    const matrix = el('div', { class: 'grid' });

    const drawMatrix = () => {
      const group = groups.find((g) => g.code === selectedCode);
      if (!group) return matrix.replaceChildren();

      const isRoot = group.defaultPermissions.includes('*');
      const effective = new Set(group.effectivePermissions);
      const defaults = new Set(group.defaultPermissions);
      const overridden = new Map(group.overrides.map((o) => [o.permission, o.granted]));

      matrix.replaceChildren(card(`Quyền của nhóm: ${group.label}`, [
        el('div', { class: 'chip-row' }, [
          badge(group.isSystem ? 'Nhóm hệ thống' : 'Nhóm tuỳ chỉnh', group.isSystem ? 'neutral' : 'info'),
          badge(`${group.userCount} người dùng`, 'neutral'),
          badge(`${isRoot ? 'toàn quyền' : `${effective.size} quyền`}`, 'good'),
          group.overrides.length ? badge(`${group.overrides.length} ô đã chỉnh`, 'warn') : null,
        ]),
        group.description ? el('p', { class: 'muted', text: group.description }) : null,

        isRoot
          ? alert(
              'Nhóm quản trị nền tảng luôn có toàn quyền và không điều chỉnh được. Cho phép thu hồi quyền ' +
              'của nhóm này thì một thao tác nhầm là khoá cứng cả hệ thống, không còn ai vào sửa lại.', 'info')
          : el('div', {}, [
              el('p', { class: 'muted', text: 'Ô có viền vàng là đã chỉnh khác mặc định. Bỏ chọn rồi chọn lại sẽ giữ trạng thái ghi đè; bấm "Trả về mặc định" ở từng dòng để xoá ghi đè và theo lại mã nguồn.' }),
              ...meta.groups.map((section) => el('div', { class: 'perm-section' }, [
                el('h4', { text: section.group }),
                el('div', { class: 'perm-grid' }, section.permissions.map((permission) => {
                  const isOn = effective.has(permission.code);
                  const isDefault = defaults.has(permission.code);
                  const isOverridden = overridden.has(permission.code);
                  return el('div', { class: `perm-cell ${isOverridden ? 'overridden' : ''}` }, [
                    el('label', { class: 'pick-item' }, [
                      el('input', {
                        type: 'checkbox', checked: isOn, disabled: !can('admin.users'),
                        onchange: async (event) => {
                          const wanted = event.target.checked;
                          try {
                            await api(`/admin/groups/${group.code}/permission`, {
                              method: 'PUT',
                              body: { permission: permission.code, granted: wanted },
                            });
                            toast(`${wanted ? 'Đã cấp' : 'Đã thu hồi'}: ${permission.label}`);
                            await refresh();
                          } catch (error) {
                            event.target.checked = !wanted;
                            toast(error.message, true);
                          }
                        },
                      }),
                      el('span', {}, [
                        permission.label,
                        el('span', { class: 'muted perm-code', text: permission.code }),
                      ]),
                    ]),
                    isOverridden
                      ? el('button', {
                          class: 'ghost small', text: `↺ Mặc định: ${isDefault ? 'có' : 'không'}`,
                          onclick: async () => {
                            await guard(api(`/admin/groups/${group.code}/permission`, {
                              method: 'PUT', body: { permission: permission.code, granted: null },
                            }));
                            toast('Đã trả về mặc định.');
                            await refresh();
                          },
                        })
                      : null,
                  ]);
                })),
              ])),
            ]),
      ], can('admin.users') && !isRoot
        ? el('span', { class: 'chip-row' }, [
            group.overrides.length
              ? el('button', {
                  class: 'ghost small', text: '↺ Khôi phục toàn bộ về mặc định',
                  onclick: async () => {
                    await guard(api(`/admin/groups/${group.code}/reset`, { body: {} }));
                    toast('Đã khôi phục quyền mặc định của nhóm.');
                    await refresh();
                  },
                })
              : null,
            !group.isSystem
              ? el('button', {
                  class: 'ghost small', text: '🗑 Xoá nhóm',
                  onclick: async () => {
                    if (!window.confirm(`Xoá nhóm "${group.label}"?`)) return;
                    await guard(api(`/admin/groups/${group.code}`, { method: 'DELETE' }));
                    toast('Đã xoá nhóm.');
                    await refresh();
                  },
                })
              : null,
          ])
        : null));
    };

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Tổng số nhóm', num(groups.length),
          `${num(groups.filter((g) => !g.isSystem).length)} nhóm tuỳ chỉnh`),
        kpi('Nhóm đã chỉnh quyền', num(groups.filter((g) => g.overrides.length).length),
          'Khác với mặc định trong mã nguồn'),
        kpi('Nhóm chưa có người dùng', num(groups.filter((g) => !g.userCount).length)),
      ]),

      alert(
        'Ma trận gốc nằm trong mã nguồn và là mặc định. Điều chỉnh ở đây lưu dạng GHI ĐÈ, nên khi hệ thống ' +
        'bổ sung quyền mới cho một nhóm, nhóm đó nhận được ngay thay vì đứng yên ở ảnh chụp cũ. ' +
        'Đổi lại, bạn cần biết ô nào đang lệch khỏi mặc định — chúng được đánh dấu viền vàng.',
        'info'),

      can('admin.users')
        ? card('Tạo nhóm mới', [
            el('p', { class: 'muted', text: 'Nhóm mới bắt đầu từ KHÔNG có quyền nào. Cấp từng quyền cần thiết thay vì sao chép một nhóm sẵn có rồi bớt đi — cách sau hay để sót quyền thừa.' }),
            form([
              { name: 'code', label: 'Mã nhóm', required: true, placeholder: 'ke-toan-htx' },
              { name: 'label', label: 'Tên hiển thị', required: true, placeholder: 'Kế toán HTX' },
              { name: 'description', label: 'Mô tả' },
            ], async (values) => {
              const created = await api('/admin/groups', { body: values });
              selectedCode = created.code;
              lastGroupCode = created.code;
              toast(`Đã tạo nhóm ${created.label}. Cấp quyền cho nhóm ở bảng bên dưới.`);
              await refresh();
            }, { submitLabel: '+ Tạo nhóm' }),
          ])
        : null,

      card('Danh sách nhóm', table([
        { key: 'label', label: 'Nhóm' },
        { key: 'code', label: 'Mã' },
        {
          key: 'isSystem', label: 'Loại',
          render: (row) => badge(row.isSystem ? 'Hệ thống' : 'Tuỳ chỉnh', row.isSystem ? 'neutral' : 'info'),
        },
        { key: 'userCount', label: 'Người dùng', align: 'right', render: (row) => num(row.userCount) },
        {
          key: 'effectivePermissions', label: 'Số quyền', align: 'right',
          render: (row) => (row.defaultPermissions.includes('*')
            ? badge('Toàn quyền', 'warn')
            : num(row.effectivePermissions.length)),
        },
        {
          key: 'overrides', label: 'Đã chỉnh', align: 'right',
          render: (row) => (row.overrides.length ? badge(num(row.overrides.length), 'warn') : '—'),
        },
      ], groups, {
        onRowClick: (row) => { selectedCode = row.code; lastGroupCode = row.code; drawMatrix(); },
        rowClass: (row) => (row.code === selectedCode ? 'highlight' : null),
      })),

      matrix,
    );

    drawMatrix();
  },
});

// ===========================================================================
// Thông báo & kênh gửi
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

    view.replaceChildren(
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
