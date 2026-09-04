/**
 * CỔNG KHUYẾN NÔNG — hệ thống chức năng riêng theo BRD App Khuyến nông.
 *
 * Trước đây toàn bộ app nằm gọn trong MỘT trang; nay tách thành các màn hình
 * độc lập đúng theo nhóm chức năng của BRD, để cán bộ khuyến nông làm việc theo
 * nghiệp vụ chứ không phải cuộn qua một trang dài.
 *
 *   FN-03/04  Cây tổ chức 3 cấp          → kn-org
 *   FN-07/08  Chỉ đạo điều hành          → kn-broadcast
 *   FN-10/11  Thư viện kỹ thuật & tin tức → kn-library
 *   FN-12     Đào tạo ToT                 → kn-training
 *   FN-13/14  Nhiệm vụ hỗ trợ HTX         → kn-tasks
 *   FN-15     Danh bạ trực hỗ trợ         → kn-directory
 *   FN-16/17  Giá cả thị trường           → kn-prices
 *   FN-05/06  Bản đồ vùng & thửa          → kn-map
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, num, pct, dateTime,
  toast, guard, can, form, mapContainer, createMap, LEAFLET_AVAILABLE, navigate,
} from '/app.js';

export const ORG_LEVEL = { trung_uong: 'Trung ương', tinh: 'Tỉnh', xa: 'Xã / Tổ KNCĐ' };
const ARTICLE_KIND = { quy_trinh: 'Quy trình kỹ thuật', tai_lieu: 'Tài liệu', tin_tuc: 'Tin tức' };
const TASK_STATUS = {
  moi: { label: 'Mới', tone: 'bad' }, tiep_nhan: { label: 'Đã tiếp nhận', tone: 'warn' },
  dang_xu_ly: { label: 'Đang xử lý', tone: 'info' }, hoan_thanh: { label: 'Hoàn thành', tone: 'good' },
  dong: { label: 'Đã đóng', tone: 'neutral' },
};
const FLOW = ['moi', 'tiep_nhan', 'dang_xu_ly', 'hoan_thanh', 'dong'];
const nextStatus = (status) => FLOW[Math.min(FLOW.indexOf(status) + 1, FLOW.length - 1)];
const nextLabel = (status) => ({ moi: 'Tiếp nhận', tiep_nhan: 'Xử lý', dang_xu_ly: 'Hoàn thành', hoan_thanh: 'Đóng' })[status] ?? '—';

// ===========================================================================
// FN-01/02 — Bảng điều hành
// ===========================================================================

registerPage('kn-dashboard', {
  title: 'Bảng điều hành Khuyến nông',
  subtitle: 'Tình hình nhiệm vụ, nội dung chuyên môn và mạng lưới cán bộ trên toàn địa bàn',
  async render(view, actions) {
    const [dashboard, articles, directory, tasks, courses] = await Promise.all([
      guard(api('/kn/dashboard')), api('/kn/articles'), api('/kn/directory'),
      api('/kn/tasks'), api('/kn/courses'),
    ]);

    if (can('khuyennong.publish')) {
      actions.append(el('button', {
        class: 'ghost small', text: '⇪ Đẩy nội dung sang Cổng HTX (FN-07)',
        onclick: async () => {
          const result = await guard(api('/kn/push-to-app-htx', { body: {} }));
          toast(`Đã đồng bộ ${result.recordCount} bản ghi sang Cổng Hợp tác xã.`);
        },
      }));
    }

    const counts = Object.fromEntries((dashboard.tasks ?? []).map((row) => [row.status, row.n]));
    const open = (counts.moi ?? 0) + (counts.tiep_nhan ?? 0) + (counts.dang_xu_ly ?? 0);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Nhiệm vụ mới', num(counts.moi ?? 0), 'Tự sinh từ Cổng HTX (FN-14)', (counts.moi ?? 0) ? 'critical' : 'good'),
        kpi('Đang xử lý', num((counts.tiep_nhan ?? 0) + (counts.dang_xu_ly ?? 0)), `${num(open)} nhiệm vụ chưa đóng`),
        kpi('Nội dung đã xuất bản', num(articles.filter((a) => a.status === 'published').length),
          `${articles.length} nội dung trong thư viện`),
        kpi('Cán bộ đang trực', num(directory.filter((o) => o.on_duty).length),
          `${directory.length} cán bộ trong danh bạ`),
      ]),

      dashboard.overdueTasks?.length
        ? card('⚠️ Nhiệm vụ quá hạn tiếp nhận (> 3 ngày)', [
            alert(`${dashboard.overdueTasks.length} nhiệm vụ chưa được tiếp nhận quá 3 ngày — vi phạm cam kết phản hồi với HTX.`, 'bad'),
            table([
              { key: 'code', label: 'Mã' },
              { key: 'title', label: 'Nội dung' },
              { key: 'created_at', label: 'Tạo lúc', render: (row) => dateTime(row.created_at) },
            ], dashboard.overdueTasks),
          ], el('button', { class: 'ghost small', text: 'Mở danh sách nhiệm vụ →', onclick: () => navigate('kn-tasks') }))
        : null,

      el('div', { class: 'grid cols-2' }, [
        card('Nhiệm vụ gần đây', table([
          { key: 'code', label: 'Mã' },
          { key: 'title', label: 'Nội dung' },
          { key: 'htx_name', label: 'HTX' },
          {
            key: 'status', label: 'Trạng thái',
            render: (row) => badge(TASK_STATUS[row.status]?.label ?? row.status, TASK_STATUS[row.status]?.tone ?? 'neutral'),
          },
        ], tasks.slice(0, 8), { empty: 'Chưa có nhiệm vụ nào.' }),
          el('button', { class: 'ghost small', text: 'Xem tất cả →', onclick: () => navigate('kn-tasks') })),

        card('Khoá đào tạo sắp tới', table([
          { key: 'title', label: 'Khoá đào tạo' },
          { key: 'start_date', label: 'Bắt đầu' },
          { key: 'enrolled', label: 'Học viên', align: 'right', render: (row) => `${num(row.enrolled)}/${num(row.capacity)}` },
        ], courses.slice(0, 8), { empty: 'Chưa có khoá đào tạo nào.' }),
          el('button', { class: 'ghost small', text: 'Xem tất cả →', onclick: () => navigate('kn-training') })),
      ]),
    );
  },
});

// ===========================================================================
// FN-03/04 — Cây tổ chức khuyến nông 3 cấp
// ===========================================================================

registerPage('kn-org', {
  title: 'Cây tổ chức khuyến nông 3 cấp',
  subtitle: 'Trung ương → Tỉnh → Xã / Tổ Khuyến nông cộng đồng (FN-03, FN-04)',
  async render(view) {
    const tree = await guard(api('/kn/org-tree'));
    const flat = flatten(tree);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đơn vị cấp tỉnh', num(flat.filter((n) => n.level === 'tinh').length)),
        kpi('Tổ KNCĐ / cấp xã', num(flat.filter((n) => n.level === 'xa').length)),
        kpi('Tổng đầu mối', num(flat.length), 'Mỗi đầu mối là một phạm vi phân quyền dữ liệu'),
      ]),
      el('div', { class: 'split' }, [
        card('Sơ đồ tổ chức', renderTree(tree)),
        can('khuyennong.write')
          ? card('Thêm đầu mối tổ chức (FN-04)', [
              el('p', { class: 'muted', text: 'Đầu mối cấp dưới kế thừa phạm vi dữ liệu của đầu mối cha; xoá đầu mối cha sẽ kéo theo toàn bộ nhánh nên hệ thống không cho xoá trực tiếp.' }),
              form([
                { name: 'code', label: 'Mã đầu mối', required: true, placeholder: 'VD: KN-AG-CHOMOI' },
                { name: 'name', label: 'Tên đơn vị', required: true },
                {
                  name: 'level', label: 'Cấp', type: 'select', required: true,
                  options: Object.entries(ORG_LEVEL).map(([value, label]) => ({ value, label })),
                },
                {
                  name: 'parentId', label: 'Trực thuộc', type: 'select',
                  options: [{ value: '', label: '— Không (cấp cao nhất) —' },
                    ...flat.map((n) => ({ value: n.id, label: `${n.code} — ${n.name}` }))],
                },
              ], async (values) => {
                await api('/kn/org-nodes', { body: { ...values, parentId: values.parentId || null } });
                toast('Đã thêm đầu mối tổ chức.');
                await this.render(view);
              }, { submitLabel: '+ Thêm đầu mối' }),
            ])
          : card('Danh sách đầu mối', table([
              { key: 'code', label: 'Mã' },
              { key: 'name', label: 'Tên đơn vị' },
              { key: 'level', label: 'Cấp', render: (row) => badge(ORG_LEVEL[row.level] ?? row.level, 'neutral') },
            ], flat)),
      ]),
    );
  },
});

function flatten(nodes, depth = 0, out = []) {
  for (const node of nodes) {
    out.push({ ...node, depth });
    if (node.children?.length) flatten(node.children, depth + 1, out);
  }
  return out;
}

function renderTree(nodes, depth = 0) {
  return el('div', { class: 'list' }, nodes.map((node) => el('div', {}, [
    el('div', { class: 'list-item', style: `margin-left:${depth * 16}px; cursor:default` }, [
      el('div', { class: 'title', text: node.name }),
      el('div', { class: 'muted', text: `${node.code} · ${ORG_LEVEL[node.level] ?? node.level}` }),
    ]),
    node.children?.length ? renderTree(node.children, depth + 1) : null,
  ])));
}

// ===========================================================================
// FN-07/08 — Chỉ đạo điều hành (broadcast)
// ===========================================================================

registerPage('kn-broadcast', {
  title: 'Chỉ đạo điều hành',
  subtitle: 'Phát chỉ đạo xuống các đầu mối trong phạm vi quản lý; mỗi chỉ đạo sinh nhiệm vụ theo dõi (FN-07, FN-08)',
  async render(view) {
    const [tree, tasks] = await Promise.all([guard(api('/kn/org-tree')), api('/kn/tasks')]);
    const flat = flatten(tree);
    const directives = tasks.filter((t) => t.origin !== 'app_htx');

    view.replaceChildren(
      card('Phát chỉ đạo mới', [
        el('p', { class: 'muted', text: 'Chỉ đạo được gửi tới đầu mối đã chọn VÀ toàn bộ nhánh cấp dưới. Mỗi đơn vị nhận sẽ có một nhiệm vụ riêng để theo dõi tiến độ, thay vì một thông báo không ai chịu trách nhiệm.' }),
        form([
          { name: 'title', label: 'Tiêu đề chỉ đạo', required: true },
          { name: 'content', label: 'Nội dung', type: 'textarea', rows: 3, required: true },
          {
            name: 'orgNodeId', label: 'Phạm vi', type: 'select', required: true,
            options: flat.map((n) => ({ value: n.id, label: `${'— '.repeat(n.depth)}${n.name} (${ORG_LEVEL[n.level] ?? n.level})` })),
          },
          { name: 'dueDate', label: 'Hạn xử lý', type: 'date' },
        ], async (values) => {
          const result = await api('/kn/broadcast', { body: values });
          toast(`Đã phát chỉ đạo tới ${result.recipients ?? result.created ?? 0} đầu mối.`);
          await this.render(view);
        }, { submitLabel: '📢 Phát chỉ đạo' }),
      ]),

      card('Chỉ đạo đã phát & tiến độ tiếp nhận', table([
        { key: 'code', label: 'Mã' },
        { key: 'title', label: 'Nội dung' },
        { key: 'org_name', label: 'Đơn vị nhận' },
        { key: 'due_date', label: 'Hạn' },
        {
          key: 'status', label: 'Trạng thái',
          render: (row) => badge(TASK_STATUS[row.status]?.label ?? row.status, TASK_STATUS[row.status]?.tone ?? 'neutral'),
        },
        { key: 'created_at', label: 'Phát lúc', render: (row) => dateTime(row.created_at) },
      ], directives, { empty: 'Chưa phát chỉ đạo nào.' })),
    );
  },
});

// ===========================================================================
// FN-10/11 — Thư viện kỹ thuật & tin tức
// ===========================================================================

registerPage('kn-library', {
  title: 'Thư viện kỹ thuật & tin tức',
  subtitle: 'Quy trình kỹ thuật, tài liệu và tin tức; chỉ nội dung ĐÃ XUẤT BẢN mới hiển thị ở Cổng HTX (FN-10, FN-11)',
  async render(view, actions) {
    const [articles, tree] = await Promise.all([guard(api('/kn/articles')), api('/kn/org-tree')]);
    const flat = flatten(tree);

    if (can('khuyennong.publish')) {
      actions.append(el('button', {
        class: 'ghost small', text: '⇪ Đẩy nội dung đã xuất bản sang Cổng HTX',
        onclick: async () => {
          const result = await guard(api('/kn/push-to-app-htx', { body: {} }));
          toast(`Đã đồng bộ ${result.recordCount} bản ghi.`);
        },
      }));
    }

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đã xuất bản', num(articles.filter((a) => a.status === 'published').length), 'Hiển thị ở Cổng HTX', 'good'),
        kpi('Bản nháp', num(articles.filter((a) => a.status !== 'published').length), 'Chưa hiển thị cho nông dân'),
        kpi('Quy trình kỹ thuật', num(articles.filter((a) => a.kind === 'quy_trinh').length)),
        kpi('Tin tức', num(articles.filter((a) => a.kind === 'tin_tuc').length)),
      ]),

      can('khuyennong.write')
        ? card('Soạn nội dung mới', form([
            { name: 'title', label: 'Tiêu đề', required: true },
            {
              name: 'kind', label: 'Loại nội dung', type: 'select', required: true,
              options: Object.entries(ARTICLE_KIND).map(([value, label]) => ({ value, label })),
            },
            {
              name: 'scopeNodeId', label: 'Phạm vi áp dụng', type: 'select',
              options: [{ value: '', label: '— Toàn hệ thống —' },
                ...flat.map((n) => ({ value: n.id, label: n.name }))],
            },
            { name: 'summary', label: 'Tóm tắt', type: 'textarea', rows: 2 },
            { name: 'body', label: 'Nội dung', type: 'textarea', rows: 4 },
          ], async (values) => {
            await api('/kn/articles', { body: { ...values, scopeNodeId: values.scopeNodeId || null } });
            toast('Đã tạo bản nháp. Cần XUẤT BẢN thì nông dân mới thấy.');
            await this.render(view, actions);
          }, { submitLabel: '+ Tạo bản nháp' }))
        : null,

      card('Danh mục nội dung', table([
        { key: 'code', label: 'Mã' },
        { key: 'title', label: 'Tiêu đề' },
        { key: 'kind', label: 'Loại', render: (row) => badge(ARTICLE_KIND[row.kind] ?? row.kind, 'neutral') },
        { key: 'scope_name', label: 'Phạm vi', render: (row) => row.scope_name ?? 'Toàn hệ thống' },
        {
          key: 'status', label: 'Trạng thái',
          render: (row) => (row.status === 'published'
            ? badge('Đã xuất bản', 'good')
            : (can('khuyennong.publish')
                ? el('button', {
                    class: 'ghost small', text: 'Xuất bản',
                    onclick: async () => {
                      await guard(api(`/kn/articles/${row.id}/publish`, { body: {} }));
                      toast('Đã xuất bản nội dung.');
                      await this.render(view, actions);
                    },
                  })
                : badge('Nháp', 'neutral'))),
        },
        { key: 'updated_at', label: 'Cập nhật', render: (row) => dateTime(row.updated_at) },
      ], articles, { empty: 'Thư viện chưa có nội dung nào.' })),
    );
  },
});

// ===========================================================================
// FN-13/14 — Nhiệm vụ hỗ trợ HTX
// ===========================================================================

registerPage('kn-tasks', {
  title: 'Nhiệm vụ hỗ trợ HTX',
  subtitle: 'Yêu cầu từ Cổng HTX tự động thành nhiệm vụ; theo dõi vòng đời Mới → Tiếp nhận → Xử lý → Hoàn thành → Đóng (FN-13, FN-14)',
  async render(view) {
    const tasks = await guard(api('/kn/tasks'));
    let filter = 'all';

    const body = el('div');
    const draw = () => {
      const rows = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
      body.replaceChildren(table([
        { key: 'code', label: 'Mã' },
        { key: 'title', label: 'Nội dung' },
        { key: 'htx_name', label: 'HTX' },
        { key: 'origin', label: 'Nguồn', render: (row) => badge(row.origin === 'app_htx' ? 'Cổng HTX' : 'Chỉ đạo', 'neutral') },
        { key: 'due_date', label: 'Hạn' },
        {
          key: 'status', label: 'Trạng thái',
          render: (row) => badge(TASK_STATUS[row.status]?.label ?? row.status, TASK_STATUS[row.status]?.tone ?? 'neutral'),
        },
        { key: 'created_at', label: 'Tạo lúc', render: (row) => dateTime(row.created_at) },
        {
          key: 'action', label: '',
          render: (row) => (can('khuyennong.write') && row.status !== 'dong'
            ? el('button', {
                class: 'ghost small', text: nextLabel(row.status),
                onclick: async () => {
                  await guard(api(`/kn/tasks/${row.id}/advance`, { body: { status: nextStatus(row.status) } }));
                  toast('Đã cập nhật nhiệm vụ.');
                  await this.render(view);
                },
              })
            : '—'),
        },
      ], rows, { empty: 'Không có nhiệm vụ nào ở trạng thái này.' }));
    };

    const counts = Object.fromEntries(FLOW.map((st) => [st, tasks.filter((t) => t.status === st).length]));

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, FLOW.map((st) =>
        kpi(TASK_STATUS[st].label, num(counts[st] ?? 0), null,
          st === 'moi' && counts[st] ? 'critical' : st === 'hoan_thanh' ? 'good' : null))),

      card('Danh sách nhiệm vụ', [
        el('div', { class: 'chip-row' }, [
          el('button', {
            class: 'ghost small', text: 'Tất cả',
            onclick: () => { filter = 'all'; draw(); },
          }),
          ...FLOW.map((st) => el('button', {
            class: 'ghost small', text: TASK_STATUS[st].label,
            onclick: () => { filter = st; draw(); },
          })),
        ]),
        body,
      ]),
    );
    draw();
  },
});

// ===========================================================================
// FN-15 — Danh bạ trực hỗ trợ
// ===========================================================================

registerPage('kn-directory', {
  title: 'Danh bạ trực hỗ trợ',
  subtitle: 'Nông dân ở Cổng HTX gọi thẳng cán bộ đang trực theo địa bàn và chuyên môn (FN-15)',
  async render(view) {
    const [directory, tree] = await Promise.all([guard(api('/kn/directory')), api('/kn/org-tree')]);
    const flat = flatten(tree);

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đang trực', num(directory.filter((o) => o.on_duty).length), 'Hiển thị cho nông dân ngay lúc này', 'good'),
        kpi('Tổng cán bộ', num(directory.length)),
        kpi('Đầu mối có người trực',
          num(new Set(directory.filter((o) => o.on_duty).map((o) => o.org_node_id)).size),
          `trên ${flat.length} đầu mối`),
      ]),

      can('khuyennong.write')
        ? card('Thêm / cập nhật cán bộ', form([
            { name: 'fullName', label: 'Họ tên', required: true },
            {
              name: 'orgNodeId', label: 'Đơn vị', type: 'select', required: true,
              options: flat.map((n) => ({ value: n.id, label: `${n.name} (${ORG_LEVEL[n.level] ?? n.level})` })),
            },
            { name: 'phone', label: 'Điện thoại', required: true },
            { name: 'specialty', label: 'Chuyên môn', placeholder: 'VD: Bảo vệ thực vật' },
            {
              name: 'onDuty', label: 'Trạng thái trực', type: 'select',
              options: [{ value: '1', label: 'Đang trực' }, { value: '0', label: 'Không trực' }],
            },
          ], async (values) => {
            await api('/kn/directory', { body: { ...values, onDuty: values.onDuty === '1' } });
            toast('Đã cập nhật danh bạ.');
            await this.render(view);
          }, { submitLabel: 'Lưu cán bộ' }))
        : null,

      card('Danh bạ', table([
        { key: 'full_name', label: 'Cán bộ' },
        { key: 'org_name', label: 'Đơn vị' },
        { key: 'level', label: 'Cấp', render: (row) => badge(ORG_LEVEL[row.level] ?? row.level, 'neutral') },
        { key: 'phone', label: 'Điện thoại' },
        { key: 'specialty', label: 'Chuyên môn' },
        {
          key: 'on_duty', label: 'Trực',
          render: (row) => badge(row.on_duty ? 'Đang trực' : 'Không trực', row.on_duty ? 'good' : 'neutral'),
        },
      ], directory, { empty: 'Danh bạ trống.' })),
    );
  },
});

// ===========================================================================
// FN-16/17 — Giá cả thị trường
// ===========================================================================

registerPage('kn-prices', {
  title: 'Giá cả thị trường',
  subtitle: 'Bảng giá theo mặt hàng và vùng, kèm biến động so với lần công bố trước (FN-16, FN-17)',
  async render(view) {
    const prices = await guard(api('/kn/prices'));

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Mặt hàng theo dõi', num(new Set(prices.map((p) => p.commodity)).size)),
        kpi('Đang tăng giá', num(prices.filter((p) => p.trend === 'tang').length), null, 'good'),
        kpi('Đang giảm giá', num(prices.filter((p) => p.trend === 'giam').length), null, 'critical'),
        kpi('Bản ghi giá', num(prices.length)),
      ]),

      can('khuyennong.write')
        ? card('Công bố giá mới', [
            el('p', { class: 'muted', text: 'Mỗi lần công bố là một bản ghi mới theo ngày — hệ thống tự tính biến động so với lần công bố gần nhất của cùng mặt hàng và vùng, không ghi đè lịch sử giá.' }),
            form([
              { name: 'commodity', label: 'Mặt hàng', required: true, placeholder: 'VD: Lúa OM5451' },
              { name: 'region', label: 'Vùng', required: true, placeholder: 'VD: An Giang' },
              { name: 'price', label: 'Giá', type: 'number', required: true, step: '1' },
              { name: 'unit', label: 'Đơn vị', required: true, value: 'đ/kg' },
              { name: 'priceDate', label: 'Ngày áp dụng', type: 'date', required: true },
              { name: 'source', label: 'Nguồn', placeholder: 'VD: Sở NN&MT' },
            ], async (values) => {
              await api('/kn/prices', { body: values });
              toast('Đã công bố giá mới.');
              await this.render(view);
            }, { submitLabel: '+ Công bố giá' }),
          ])
        : null,

      card('Bảng giá hiện hành', table([
        { key: 'commodity', label: 'Mặt hàng' },
        { key: 'region', label: 'Vùng' },
        { key: 'price', label: 'Giá', align: 'right', render: (row) => `${num(row.price)} ${row.unit}` },
        {
          key: 'change', label: 'Biến động', align: 'right',
          render: (row) => (row.changePct === null || row.changePct === undefined ? '—'
            : badge(`${row.change > 0 ? '▲' : row.change < 0 ? '▼' : '■'} ${pct(Math.abs(row.changePct))}`,
                row.trend === 'tang' ? 'good' : row.trend === 'giam' ? 'bad' : 'neutral')),
        },
        { key: 'price_date', label: 'Ngày' },
        { key: 'source', label: 'Nguồn' },
      ], prices, { empty: 'Chưa có dữ liệu giá.' })),
    );
  },
});

// ===========================================================================
// FN-12 — Đào tạo ToT
// ===========================================================================

registerPage('kn-training', {
  title: 'Đào tạo ToT',
  subtitle: 'Khoá đào tạo giảng viên nguồn và ghi danh học viên từ các HTX (FN-12)',
  async render(view) {
    const courses = await guard(api('/kn/courses'));

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Khoá đào tạo', num(courses.length)),
        kpi('Tổng học viên', num(courses.reduce((acc, c) => acc + (c.enrolled ?? 0), 0))),
        kpi('Còn chỗ',
          num(courses.reduce((acc, c) => acc + Math.max(0, (c.capacity ?? 0) - (c.enrolled ?? 0)), 0)),
          'Tổng chỗ trống trên tất cả khoá'),
      ]),

      can('khuyennong.write')
        ? card('Mở khoá đào tạo', form([
            { name: 'title', label: 'Tên khoá', required: true },
            { name: 'startDate', label: 'Ngày bắt đầu', type: 'date', required: true },
            { name: 'endDate', label: 'Ngày kết thúc', type: 'date' },
            { name: 'capacity', label: 'Số chỗ', type: 'number', required: true, min: '1' },
            { name: 'location', label: 'Địa điểm' },
          ], async (values) => {
            await api('/kn/courses', { body: values });
            toast('Đã mở khoá đào tạo.');
            await this.render(view);
          }, { submitLabel: '+ Mở khoá' }))
        : null,

      card('Danh sách khoá đào tạo', table([
        { key: 'code', label: 'Mã' },
        { key: 'title', label: 'Khoá đào tạo' },
        { key: 'start_date', label: 'Bắt đầu' },
        { key: 'location', label: 'Địa điểm' },
        {
          key: 'enrolled', label: 'Học viên', align: 'right',
          render: (row) => {
            const full = (row.enrolled ?? 0) >= (row.capacity ?? 0);
            return badge(`${num(row.enrolled)}/${num(row.capacity)}`, full ? 'warn' : 'good');
          },
        },
        { key: 'status', label: 'Trạng thái' },
        {
          key: 'enrol', label: '',
          render: (row) => (can('khuyennong.write') && (row.enrolled ?? 0) < (row.capacity ?? 0)
            ? el('button', {
                class: 'ghost small', text: '+ Ghi danh',
                onclick: async () => {
                  const name = prompt('Họ tên học viên:');
                  if (!name) return;
                  await guard(api(`/kn/courses/${row.id}/enrol`, { body: { name } }));
                  toast('Đã ghi danh học viên.');
                  await this.render(view);
                },
              })
            : '—'),
        },
      ], courses, { empty: 'Chưa có khoá đào tạo nào.' })),
    );
  },
});

// ===========================================================================
// FN-05/06 — Bản đồ vùng khuyến nông
// ===========================================================================

registerPage('kn-map', {
  title: 'Bản đồ vùng khuyến nông',
  subtitle: 'Mạng lưới đầu mối, HTX phụ trách và tình hình mùa vụ trên nền GIS dùng chung (FN-05, FN-06)',
  async render(view) {
    const [networkMap, bundle] = await Promise.all([
      guard(api('/kn/network-map')),
      api('/gis/map-bundle').catch(() => ({ layers: {} })),
    ]);
    const mapNode = mapContainer('kn-map-canvas', 'tall');

    view.replaceChildren(
      el('div', { class: 'grid cols-4' }, [
        kpi('Đầu mối trên bản đồ', num(networkMap.nodes?.length ?? 0)),
        kpi('HTX phụ trách', num(networkMap.cooperatives?.length ?? (bundle.layers?.cooperatives?.length ?? 0))),
      ]),
      card('Bản đồ mạng lưới khuyến nông', [
        el('p', { class: 'muted', text: 'Nền bản đồ, ranh giới hành chính và toạ độ HTX lấy từ Nền tảng GIS dùng chung — mọi cổng đọc cùng một nguồn dữ liệu.' }),
        mapNode,
      ]),
    );

    if (!LEAFLET_AVAILABLE()) return;
    const map = createMap('kn-map-canvas');
    const L = window.L;
    for (const htx of (bundle.layers?.cooperatives ?? [])) {
      if (htx.lat === null || htx.lng === null) continue;
      L.circleMarker([htx.lat, htx.lng], {
        radius: 4, color: '#1C8C74', fillColor: '#1C8C74', fillOpacity: 0.55, weight: 1,
      }).bindTooltip(`${htx.code} — ${htx.name}`).addTo(map);
    }
    for (const node of (networkMap.nodes ?? [])) {
      if (node.lat === null || node.lng === null || node.lat === undefined) continue;
      L.marker([node.lat, node.lng]).bindTooltip(`${node.name} (${ORG_LEVEL[node.level] ?? node.level})`).addTo(map);
    }
  },
});
