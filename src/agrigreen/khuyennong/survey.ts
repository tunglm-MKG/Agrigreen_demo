/**
 * MẪU KHẢO SÁT THU THẬP DỮ LIỆU — App Khuyến nông.
 *
 * Cán bộ khuyến nông tạo mẫu khảo sát dùng lại được, chạy định kỳ theo tuần
 * hoặc tháng, hoặc phát sinh đột xuất (dịch hại, thiên tai). Mỗi phiếu trả lời
 * gắn với một hộ dân hoặc một HTX, kèm địa chỉ hành chính chọn theo cấp:
 * tỉnh → xã → thôn/ấp, mỗi cấp chỉ hiện các đơn vị thuộc cấp trên đã chọn.
 *
 * Các chốt chặn:
 *   SV-01  Chỉ mẫu đã BAN HÀNH mới nhận được phiếu trả lời.
 *   SV-02  Một đối tượng chỉ có MỘT phiếu trong một kỳ — nhập lại là cập nhật,
 *          không tạo bản trùng làm sai thống kê.
 *   SV-03  Câu hỏi bắt buộc phải có trả lời.
 *   SV-04  Đơn vị hành chính phải đúng quan hệ cha–con: ấp phải thuộc xã đã
 *          chọn, xã phải thuộc tỉnh đã chọn.
 *   SV-05  Kỳ khảo sát phải đúng định dạng của tần suất mẫu (tuần/tháng/ngày).
 */
import { all, insert, one, run, transaction, update } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';

export const SURVEY_FREQUENCIES = [
  { code: 'tuan', label: 'Định kỳ hàng tuần', periodHint: 'YYYY-Wnn (VD: 2026-W12)' },
  { code: 'thang', label: 'Định kỳ hàng tháng', periodHint: 'YYYY-MM (VD: 2026-04)' },
  { code: 'dot_xuat', label: 'Đột xuất', periodHint: 'YYYY-MM-DD (ngày khảo sát)' },
];

export const QUESTION_KINDS = [
  { code: 'text', label: 'Văn bản' },
  { code: 'number', label: 'Số' },
  { code: 'date', label: 'Ngày' },
  { code: 'select', label: 'Chọn một' },
  { code: 'multiselect', label: 'Chọn nhiều' },
  { code: 'boolean', label: 'Có / Không' },
];

export const PRODUCTION_STATUSES = [
  { code: 'chua_xuong_giong', label: 'Chưa xuống giống' },
  { code: 'ma_non', label: 'Mạ non' },
  { code: 'de_nhanh', label: 'Đẻ nhánh' },
  { code: 'lam_dong', label: 'Làm đòng' },
  { code: 'tro_bong', label: 'Trổ bông' },
  { code: 'chin', label: 'Chín' },
  { code: 'da_thu_hoach', label: 'Đã thu hoạch' },
  { code: 'bo_hoang', label: 'Bỏ hoang / không sản xuất' },
];

// =====================================================================
// Cây đơn vị hành chính — phục vụ dropdown lọc dần từ trên xuống
// =====================================================================

/**
 * Danh sách đơn vị hành chính con của một đơn vị cha.
 *
 * Ô "Xã" chỉ hiện xã thuộc tỉnh đã chọn; ô "Thôn/Ấp" chỉ hiện ấp thuộc xã đã
 * chọn. Truy vấn theo `parent_id` nên danh sách luôn khớp, không cần lọc ở
 * phía giao diện.
 */
export function adminChildren(parentId?: string | null, level?: string): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (parentId) { clauses.push('parent_id = ?'); params.push(parentId); }
  else clauses.push('parent_id IS NULL');
  if (level) { clauses.push('level = ?'); params.push(level); }
  return all(
    `SELECT id, code, name, level, parent_id, centroid_lat, centroid_lng
       FROM admin_units WHERE ${clauses.join(' AND ')} ORDER BY name`,
    params,
  );
}

/** Đường dẫn từ gốc tới một đơn vị — dùng để hiển thị địa chỉ đầy đủ. */
export function adminPath(unitId: string): Record<string, unknown>[] {
  const path: Record<string, unknown>[] = [];
  let current = one<{ id: string; name: string; level: string; parent_id: string | null }>(
    'SELECT id, name, level, parent_id FROM admin_units WHERE id = ?', [unitId],
  );
  let guard = 0;
  while (current && guard < 10) {
    path.unshift(current);
    current = current.parent_id
      ? one('SELECT id, name, level, parent_id FROM admin_units WHERE id = ?', [current.parent_id])
      : null;
    guard += 1;
  }
  return path;
}

/** SV-04 — kiểm tra quan hệ cha–con của bộ ba tỉnh / xã / ấp. */
function assertAdminChain(provinceId?: string | null, communeId?: string | null, hamletId?: string | null): void {
  if (communeId) {
    const commune = one<{ parent_id: string | null; name: string }>(
      'SELECT parent_id, name FROM admin_units WHERE id = ?', [communeId],
    );
    if (!commune) throw new Error('Không tìm thấy xã/phường đã chọn.');
    if (provinceId && commune.parent_id !== provinceId) {
      throw new Error(`Xã "${commune.name}" không thuộc tỉnh đã chọn.`);
    }
  }
  if (hamletId) {
    const hamlet = one<{ parent_id: string | null; name: string }>(
      'SELECT parent_id, name FROM admin_units WHERE id = ?', [hamletId],
    );
    if (!hamlet) throw new Error('Không tìm thấy thôn/ấp đã chọn.');
    if (communeId && hamlet.parent_id !== communeId) {
      throw new Error(`Thôn/ấp "${hamlet.name}" không thuộc xã đã chọn.`);
    }
    if (!communeId) throw new Error('Phải chọn xã/phường trước khi chọn thôn/ấp.');
  }
}

// =====================================================================
// Mẫu khảo sát
// =====================================================================

export function createTemplate(
  input: {
    code?: string; name: string; purpose?: string; frequency?: string;
    subjectScope?: string; orgNodeId?: string | null;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  if (!input.name?.trim()) throw new Error('Mẫu khảo sát phải có tên.');
  const frequency = input.frequency ?? 'dot_xuat';
  if (!SURVEY_FREQUENCIES.some((f) => f.code === frequency)) {
    throw new Error(`Tần suất không hợp lệ: "${frequency}".`);
  }
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM survey_templates');
  const record = {
    id: uuid(),
    code: (input.code?.trim() || `KS-${String((count?.n ?? 0) + 1).padStart(3, '0')}`).toUpperCase(),
    name: input.name.trim(),
    purpose: input.purpose ?? null,
    frequency,
    subject_scope: input.subjectScope ?? 'ca_hai',
    org_node_id: input.orgNodeId ?? null,
    status: 'nhap',
    created_by: actor.name ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('survey_templates', record);
  logEvent({ module: 'khuyennong', entityType: 'survey_templates', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function addQuestion(
  templateId: string,
  input: {
    code?: string; label: string; kind?: string; uom?: string;
    options?: string[]; required?: boolean; helpText?: string; sortOrder?: number;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const template = getTemplate(templateId);
  if (!template) throw new Error('Không tìm thấy mẫu khảo sát.');
  if (template.status === 'ban_hanh') {
    const used = one<{ n: number }>('SELECT COUNT(*) AS n FROM survey_responses WHERE template_id = ?', [templateId]);
    if ((used?.n ?? 0) > 0) {
      throw new Error(
        `Mẫu đã có ${used!.n} phiếu trả lời — thêm câu hỏi lúc này sẽ làm các phiếu cũ khuyết dữ liệu. ` +
        'Hãy tạo mẫu mới cho đợt khảo sát tiếp theo.',
      );
    }
  }
  if (!input.label?.trim()) throw new Error('Câu hỏi phải có nội dung.');
  const kind = input.kind ?? 'text';
  if (!QUESTION_KINDS.some((k) => k.code === kind)) throw new Error(`Kiểu câu hỏi không hợp lệ: "${kind}".`);
  if ((kind === 'select' || kind === 'multiselect') && !input.options?.length) {
    throw new Error('Câu hỏi dạng lựa chọn phải có danh sách lựa chọn.');
  }

  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM survey_questions WHERE template_id = ?', [templateId]);
  const order = input.sortOrder ?? (count?.n ?? 0) + 1;
  const record = {
    id: uuid(),
    template_id: templateId,
    sort_order: order,
    code: (input.code?.trim() || `C${String(order).padStart(2, '0')}`).toUpperCase(),
    label: input.label.trim(),
    kind,
    uom: input.uom ?? null,
    options: input.options?.length ? JSON.stringify(input.options) : null,
    required: input.required ? 1 : 0,
    help_text: input.helpText ?? null,
  };
  insert('survey_questions', record);
  update('survey_templates', templateId, { updated_at: nowIso() });
  logEvent({ module: 'khuyennong', entityType: 'survey_questions', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function removeQuestion(questionId: string, actor: AuditActor = {}): void {
  const question = one<{ id: string; template_id: string }>(
    'SELECT id, template_id FROM survey_questions WHERE id = ?', [questionId],
  );
  if (!question) throw new Error('Không tìm thấy câu hỏi.');
  const used = one<{ n: number }>('SELECT COUNT(*) AS n FROM survey_answers WHERE question_id = ?', [questionId]);
  if ((used?.n ?? 0) > 0) throw new Error('Câu hỏi đã có dữ liệu trả lời — không xoá được.');
  run('DELETE FROM survey_questions WHERE id = ?', [questionId]);
  logEvent({ module: 'khuyennong', entityType: 'survey_questions', entityId: questionId, action: 'delete', before: question }, actor);
}

export function publishTemplate(templateId: string, actor: AuditActor = {}): Record<string, unknown> {
  const template = getTemplate(templateId);
  if (!template) throw new Error('Không tìm thấy mẫu khảo sát.');
  const questions = listQuestions(templateId);
  if (!questions.length) throw new Error('Mẫu khảo sát chưa có câu hỏi nào — không thể ban hành.');
  update('survey_templates', templateId, { status: 'ban_hanh', updated_at: nowIso() });
  const after = getTemplate(templateId)!;
  logEvent({ module: 'khuyennong', entityType: 'survey_templates', entityId: templateId, action: 'publish', before: template, after }, actor);
  return after;
}

export function getTemplate(id: string): Record<string, unknown> | null {
  return one('SELECT * FROM survey_templates WHERE id = ?', [id]);
}

export function listTemplates(filter: { status?: string } = {}): Record<string, unknown>[] {
  const where = filter.status ? 'WHERE t.status = ?' : '';
  return all(
    `SELECT t.*,
            (SELECT COUNT(*) FROM survey_questions q WHERE q.template_id = t.id) AS question_count,
            (SELECT COUNT(*) FROM survey_responses r WHERE r.template_id = t.id) AS response_count
       FROM survey_templates t ${where} ORDER BY t.created_at DESC`,
    filter.status ? [filter.status] : [],
  );
}

export function listQuestions(templateId: string): Record<string, unknown>[] {
  return all<Record<string, unknown>>(
    'SELECT * FROM survey_questions WHERE template_id = ? ORDER BY sort_order',
    [templateId],
  ).map((row) => ({ ...row, optionList: row.options ? JSON.parse(String(row.options)) : [] }));
}

// =====================================================================
// Phiếu trả lời
// =====================================================================

/** SV-05 — kỳ khảo sát phải khớp định dạng của tần suất. */
function assertPeriodFormat(frequency: string, period: string): void {
  const patterns: Record<string, { re: RegExp; hint: string }> = {
    tuan: { re: /^\d{4}-W\d{2}$/, hint: 'YYYY-Wnn, ví dụ 2026-W12' },
    thang: { re: /^\d{4}-\d{2}$/, hint: 'YYYY-MM, ví dụ 2026-04' },
    dot_xuat: { re: /^\d{4}-\d{2}-\d{2}$/, hint: 'YYYY-MM-DD, ví dụ 2026-04-15' },
  };
  const rule = patterns[frequency];
  if (rule && !rule.re.test(period)) {
    throw new Error(`Kỳ khảo sát "${period}" không đúng định dạng ${rule.hint}.`);
  }
}

export interface SurveyResponseInput {
  templateId: string;
  period: string;
  subjectKind: 'ho_dan' | 'htx';
  farmerId?: string | null;
  htxId?: string | null;
  subjectName: string;
  phone?: string;
  nationalId?: string;
  taxCode?: string;
  provinceId?: string | null;
  communeId?: string | null;
  hamletId?: string | null;
  addressDetail?: string;
  lat?: number;
  lng?: number;
  cycleStartDate?: string;
  productionStatus?: string;
  surveyedAt?: string;
  answers?: { questionId: string; value: string | number | boolean | null }[];
}

/**
 * Ghi nhận một phiếu khảo sát. Nhập lại cùng đối tượng trong cùng kỳ là CẬP NHẬT
 * phiếu cũ (SV-02) — cán bộ đi khảo sát thường phải bổ sung thông tin sau, và
 * tạo bản trùng sẽ làm sai mọi con số thống kê theo kỳ.
 */
export function submitResponse(input: SurveyResponseInput, actor: AuditActor = {}): Record<string, unknown> {
  const template = getTemplate(input.templateId);
  if (!template) throw new Error('Không tìm thấy mẫu khảo sát.');
  // SV-01
  if (template.status !== 'ban_hanh') {
    throw new Error(`Mẫu "${template.name}" chưa được ban hành — chưa nhận phiếu trả lời.`);
  }
  if (template.subject_scope !== 'ca_hai' && template.subject_scope !== input.subjectKind) {
    throw new Error(
      `Mẫu này chỉ khảo sát ${template.subject_scope === 'ho_dan' ? 'hộ dân' : 'hợp tác xã'}.`,
    );
  }
  if (!input.subjectName?.trim()) throw new Error('Phiếu khảo sát phải có tên đối tượng.');
  assertPeriodFormat(String(template.frequency), input.period);
  assertAdminChain(input.provinceId, input.communeId, input.hamletId);

  if (input.productionStatus && !PRODUCTION_STATUSES.some((s) => s.code === input.productionStatus)) {
    throw new Error(`Hiện trạng sản xuất không hợp lệ: "${input.productionStatus}".`);
  }

  const questions = listQuestions(input.templateId);
  const answerMap = new Map((input.answers ?? []).map((a) => [a.questionId, a.value]));
  // SV-03
  for (const question of questions) {
    if (!question.required) continue;
    const value = answerMap.get(String(question.id));
    if (value === undefined || value === null || value === '') {
      throw new Error(`Câu hỏi bắt buộc chưa có trả lời: "${question.label}".`);
    }
  }

  return transaction(() => {
    const existing = one<{ id: string; code: string }>(
      `SELECT id, code FROM survey_responses
        WHERE template_id = ? AND period = ? AND subject_kind = ?
          AND IFNULL(farmer_id,'') = IFNULL(?,'') AND IFNULL(htx_id,'') = IFNULL(?,'')`,
      [input.templateId, input.period, input.subjectKind, input.farmerId ?? null, input.htxId ?? null],
    );

    const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM survey_responses');
    const values = {
      template_id: input.templateId,
      period: input.period,
      subject_kind: input.subjectKind,
      farmer_id: input.farmerId ?? null,
      htx_id: input.htxId ?? null,
      subject_name: input.subjectName.trim(),
      phone: input.phone ?? null,
      national_id: input.nationalId ?? null,
      tax_code: input.taxCode ?? null,
      province_id: input.provinceId ?? null,
      commune_id: input.communeId ?? null,
      hamlet_id: input.hamletId ?? null,
      address_detail: input.addressDetail ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      cycle_start_date: input.cycleStartDate ?? null,
      production_status: input.productionStatus ?? null,
      surveyed_at: input.surveyedAt ?? nowIso(),
      surveyed_by: actor.name ?? null,
    };

    let responseId: string;
    if (existing) {
      responseId = existing.id;
      update('survey_responses', responseId, values);
      run('DELETE FROM survey_answers WHERE response_id = ?', [responseId]);
    } else {
      responseId = uuid();
      insert('survey_responses', {
        id: responseId,
        code: `PKS-${String((count?.n ?? 0) + 1).padStart(5, '0')}`,
        ...values,
        created_at: nowIso(),
      });
    }

    for (const question of questions) {
      const raw = answerMap.get(String(question.id));
      if (raw === undefined || raw === null || raw === '') continue;
      const numeric = question.kind === 'number' ? Number(raw) : null;
      insert('survey_answers', {
        id: uuid(),
        response_id: responseId,
        question_id: question.id,
        value_text: question.kind === 'number' ? null : String(raw),
        value_number: numeric !== null && Number.isFinite(numeric) ? numeric : null,
      });
    }

    logEvent({
      module: 'khuyennong', entityType: 'survey_responses', entityId: responseId,
      action: existing ? 'update' : 'create', after: values,
    }, actor);
    return getResponse(responseId)!;
  });
}

export function getResponse(id: string): Record<string, unknown> | null {
  const response = one<Record<string, unknown>>(
    `SELECT r.*, t.name AS template_name, t.frequency,
            pv.name AS province_name, cm.name AS commune_name, hm.name AS hamlet_name
       FROM survey_responses r
       JOIN survey_templates t ON t.id = r.template_id
       LEFT JOIN admin_units pv ON pv.id = r.province_id
       LEFT JOIN admin_units cm ON cm.id = r.commune_id
       LEFT JOIN admin_units hm ON hm.id = r.hamlet_id
      WHERE r.id = ?`,
    [id],
  );
  if (!response) return null;
  const answers = all(
    `SELECT a.*, q.label, q.kind, q.uom, q.code AS question_code, q.sort_order
       FROM survey_answers a JOIN survey_questions q ON q.id = a.question_id
      WHERE a.response_id = ? ORDER BY q.sort_order`,
    [id],
  );
  return { ...response, answers };
}

export function listResponses(filter: { templateId?: string; period?: string; communeId?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.templateId) { clauses.push('r.template_id = ?'); params.push(filter.templateId); }
  if (filter.period) { clauses.push('r.period = ?'); params.push(filter.period); }
  if (filter.communeId) { clauses.push('r.commune_id = ?'); params.push(filter.communeId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT r.id, r.code, r.period, r.subject_kind, r.subject_name, r.phone,
            r.cycle_start_date, r.production_status, r.surveyed_at, r.surveyed_by,
            t.name AS template_name,
            pv.name AS province_name, cm.name AS commune_name, hm.name AS hamlet_name
       FROM survey_responses r
       JOIN survey_templates t ON t.id = r.template_id
       LEFT JOIN admin_units pv ON pv.id = r.province_id
       LEFT JOIN admin_units cm ON cm.id = r.commune_id
       LEFT JOIN admin_units hm ON hm.id = r.hamlet_id
       ${where}
      ORDER BY r.surveyed_at DESC`,
    params,
  );
}

/** Tổng hợp một đợt khảo sát: số phiếu, phân bố hiện trạng sản xuất theo địa bàn. */
export function surveySummary(templateId: string, period?: string): Record<string, unknown> {
  const clauses = ['r.template_id = ?'];
  const params: unknown[] = [templateId];
  if (period) { clauses.push('r.period = ?'); params.push(period); }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const byStatus = all<{ production_status: string | null; n: number }>(
    `SELECT r.production_status, COUNT(*) AS n FROM survey_responses r ${where}
      GROUP BY r.production_status ORDER BY n DESC`,
    params,
  );
  const byCommune = all(
    `SELECT cm.name AS commune_name, COUNT(*) AS n,
            SUM(CASE WHEN r.cycle_start_date IS NOT NULL THEN 1 ELSE 0 END) AS with_cycle_start
       FROM survey_responses r LEFT JOIN admin_units cm ON cm.id = r.commune_id
       ${where} GROUP BY cm.name ORDER BY n DESC`,
    params,
  );
  const periods = all(
    `SELECT r.period, COUNT(*) AS n FROM survey_responses r WHERE r.template_id = ?
      GROUP BY r.period ORDER BY r.period DESC`,
    [templateId],
  );
  const total = byStatus.reduce((acc, row) => acc + row.n, 0);

  return {
    total,
    byStatus: byStatus.map((row) => ({
      code: row.production_status,
      label: PRODUCTION_STATUSES.find((s) => s.code === row.production_status)?.label ?? 'Không khai báo',
      n: row.n,
    })),
    byCommune,
    periods,
  };
}
