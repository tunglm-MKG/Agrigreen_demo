/**
 * QUY TRÌNH SẢN XUẤT CHUẨN & KẾ HOẠCH SẢN XUẤT — App Hợp tác xã.
 *
 * Ba lớp nối tiếp nhau:
 *
 *   Quy trình chuẩn  →  Kế hoạch sản xuất của MỘT vụ  →  Xác nhận từng bước
 *   (VietGAP, SRP…)     (bung theo ngày xuống giống)     (kèm bằng chứng)
 *
 * Trước đây nhật ký canh tác là các bản ghi rời: nông dân nhớ gì ghi nấy, và
 * không có gì để đối chiếu xem đã canh tác đúng chuẩn hay chưa. Nay mỗi bản ghi
 * là một XÁC NHẬN đối với bước đã hoạch định, cho phép lệch thực tế nhưng buộc
 * nêu lý do khi lệch quá cửa sổ cho phép, và buộc đính bằng chứng ở những bước
 * mà quy trình yêu cầu.
 *
 * Các chốt chặn nghiệp vụ (đều có test):
 *   BR-01  Không có ngày xuống giống thì KHÔNG sinh được kế hoạch — hệ thống
 *          không tự đoán ngày neo.
 *   BR-02  Chỉ quy trình ở trạng thái "Ban hành" mới được áp dụng vào vụ.
 *   BR-03  Kế hoạch ghim PHIÊN BẢN quy trình tại thời điểm sinh; sửa quy trình
 *          sau đó không làm thay đổi kế hoạch đã phát hành.
 *   BR-04  Bước yêu cầu bằng chứng phải có đủ loại bằng chứng mới xác nhận được.
 *   BR-05  Lệch quá cửa sổ cho phép phải ghi lý do điều chỉnh.
 *   BR-06  Thời gian cách ly (PHI) sau phun thuốc phải được tôn trọng khi thu
 *          hoạch — vi phạm là lỗi an toàn thực phẩm, không phải cảnh báo suông.
 *   BR-07  Quy trình đã có kế hoạch sử dụng thì không sửa trực tiếp được; phải
 *          tạo phiên bản mới.
 *   BR-08  Quy trình rút ra từ một vụ đã hoàn thành luôn ở trạng thái NHÁP và
 *          ghi rõ thuộc tính nào KHÔNG suy ra được từ thực tế — người soạn phải
 *          rà lại trước khi ban hành.
 */
import { all, insert, one, run, transaction, update } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';

// =====================================================================
// Danh mục
// =====================================================================

export const PROTOCOL_STANDARDS = [
  { code: 'vietgap', label: 'VietGAP' },
  { code: 'srp', label: 'SRP (Sustainable Rice Platform)' },
  { code: 'huu_co', label: 'Hữu cơ' },
  { code: 'noi_bo', label: 'Quy trình nội bộ' },
];

export const EVIDENCE_KINDS = [
  { code: 'anh_hien_truong', label: 'Ảnh hiện trường' },
  { code: 'hoa_don_vat_tu', label: 'Hoá đơn / nhãn vật tư' },
  { code: 'phieu_kiem_nghiem', label: 'Phiếu kiểm nghiệm' },
  { code: 'ghi_chu', label: 'Ghi chú / biên bản' },
  { code: 'khac', label: 'Khác' },
];

export const STEP_STATUS = {
  ke_hoach: 'Theo kế hoạch',
  da_thuc_hien: 'Đã thực hiện',
  tre_han: 'Trễ hạn',
  bo_qua: 'Bỏ qua',
};

const DAY_MS = 86_400_000;

function addDays(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`).getTime();
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS,
  );
}

function parseKinds(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// =====================================================================
// Quy trình chuẩn
// =====================================================================

export interface ProtocolInput {
  code?: string;
  name: string;
  standard?: string;
  crop?: string;
  scope?: 'he_thong' | 'htx';
  htxId?: string | null;
  documentRef?: string;
  description?: string;
  /** Vụ canh tác mà quy trình này được rút ra từ đó (nếu có). */
  sourceCropCycleId?: string | null;
}

export function createProtocol(input: ProtocolInput, actor: AuditActor = {}): Record<string, unknown> {
  if (!input.name?.trim()) throw new Error('Quy trình phải có tên.');
  const scope = input.scope ?? 'he_thong';
  if (scope === 'htx' && !input.htxId) {
    throw new Error('Quy trình riêng của HTX phải gắn với một hợp tác xã cụ thể.');
  }
  const code = (input.code?.trim() || autoCode(input.standard ?? 'vietgap')).toUpperCase();
  const existing = one<{ version: number }>(
    'SELECT MAX(version) AS version FROM production_protocols WHERE code = ?',
    [code],
  );
  const record = {
    id: uuid(),
    code,
    name: input.name.trim(),
    standard: input.standard ?? 'vietgap',
    crop: input.crop ?? 'lua',
    version: (existing?.version ?? 0) + 1,
    scope,
    htx_id: scope === 'htx' ? input.htxId : null,
    status: 'nhap',
    document_ref: input.documentRef ?? null,
    description: input.description ?? null,
    source_protocol_id: null,
    source_crop_cycle_id: input.sourceCropCycleId ?? null,
    created_by: actor.name ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('production_protocols', record);
  logEvent({ module: 'htx', entityType: 'production_protocols', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

function autoCode(standard: string): string {
  const prefix = standard.replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'QT';
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM production_protocols');
  return `${prefix}-${String((count?.n ?? 0) + 1).padStart(3, '0')}`;
}

export interface StepInput {
  name: string;
  activity: string;
  stage?: string;
  offsetDays: number;
  windowDays?: number;
  mandatory?: boolean;
  evidenceKinds?: string[];
  phiDays?: number | null;
  controlPoint?: string;
  instruction?: string;
  sortOrder?: number;
}

export function addProtocolStep(protocolId: string, input: StepInput, actor: AuditActor = {}): Record<string, unknown> {
  const protocol = getProtocol(protocolId);
  if (!protocol) throw new Error('Không tìm thấy quy trình.');
  assertEditable(protocol);

  if (!input.name?.trim()) throw new Error('Bước quy trình phải có tên.');
  if (!Number.isFinite(input.offsetDays)) {
    throw new Error('Bước quy trình phải có số ngày lệch so với ngày xuống giống.');
  }
  const windowDays = input.windowDays ?? 3;
  if (windowDays < 0) throw new Error('Cửa sổ thời gian không được âm.');

  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM protocol_steps WHERE protocol_id = ?', [protocolId]);
  const record = {
    id: uuid(),
    protocol_id: protocolId,
    sort_order: input.sortOrder ?? (count?.n ?? 0) + 1,
    name: input.name.trim(),
    activity: input.activity,
    stage: input.stage ?? null,
    offset_days: Math.round(input.offsetDays),
    window_days: Math.round(windowDays),
    mandatory: input.mandatory === false ? 0 : 1,
    evidence_kinds: input.evidenceKinds?.length ? JSON.stringify(input.evidenceKinds) : null,
    phi_days: input.phiDays ?? null,
    control_point: input.controlPoint ?? null,
    instruction: input.instruction ?? null,
  };
  insert('protocol_steps', record);
  update('production_protocols', protocolId, { updated_at: nowIso() });
  logEvent({ module: 'htx', entityType: 'protocol_steps', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

export function removeProtocolStep(stepId: string, actor: AuditActor = {}): void {
  const step = one<{ id: string; protocol_id: string }>('SELECT id, protocol_id FROM protocol_steps WHERE id = ?', [stepId]);
  if (!step) throw new Error('Không tìm thấy bước quy trình.');
  assertEditable(getProtocol(step.protocol_id)!);
  run('DELETE FROM protocol_steps WHERE id = ?', [stepId]);
  logEvent({ module: 'htx', entityType: 'protocol_steps', entityId: stepId, action: 'delete', before: step }, actor);
}

/** BR-07: quy trình đã ban hành hoặc đã có kế hoạch dùng thì không sửa trực tiếp. */
function assertEditable(protocol: Record<string, unknown>): void {
  if (protocol.status === 'ban_hanh') {
    throw new Error(
      'Quy trình đã ban hành không sửa trực tiếp được. Hãy tạo phiên bản mới để giữ nguyên ' +
      'căn cứ của các kế hoạch đã phát hành theo phiên bản này.',
    );
  }
  const used = one<{ n: number }>('SELECT COUNT(*) AS n FROM production_plans WHERE protocol_id = ?', [protocol.id]);
  if ((used?.n ?? 0) > 0) {
    throw new Error(`Quy trình đang được ${used!.n} kế hoạch sản xuất sử dụng — hãy tạo phiên bản mới thay vì sửa.`);
  }
}

export function publishProtocol(protocolId: string, actor: AuditActor = {}): Record<string, unknown> {
  const protocol = getProtocol(protocolId);
  if (!protocol) throw new Error('Không tìm thấy quy trình.');
  const steps = listProtocolSteps(protocolId);
  if (!steps.length) throw new Error('Quy trình chưa có bước nào — không thể ban hành.');

  // Bước thu hoạch là mốc kết thúc; thiếu nó thì kế hoạch không có điểm dừng.
  if (!steps.some((step) => step.activity === 'thu_hoach')) {
    throw new Error('Quy trình phải có bước thu hoạch để kế hoạch sản xuất có điểm kết thúc.');
  }
  update('production_protocols', protocolId, { status: 'ban_hanh', updated_at: nowIso() });
  const after = getProtocol(protocolId)!;
  logEvent({ module: 'htx', entityType: 'production_protocols', entityId: protocolId, action: 'publish', before: protocol, after }, actor);
  return after;
}

/** Tạo phiên bản mới từ một quy trình đã ban hành, sao chép toàn bộ bước. */
export function cloneProtocol(
  protocolId: string,
  overrides: { name?: string; scope?: 'he_thong' | 'htx'; htxId?: string | null } = {},
  actor: AuditActor = {},
): Record<string, unknown> {
  const source = getProtocol(protocolId);
  if (!source) throw new Error('Không tìm thấy quy trình nguồn.');

  return transaction(() => {
    const scope = overrides.scope ?? (source.scope as 'he_thong' | 'htx');
    const created = createProtocol({
      code: scope === (source.scope as string) ? (source.code as string) : undefined,
      name: overrides.name ?? (source.name as string),
      standard: source.standard as string,
      crop: source.crop as string,
      scope,
      htxId: overrides.htxId ?? (source.htx_id as string | null),
      documentRef: source.document_ref as string,
      description: source.description as string,
    }, actor);
    update('production_protocols', created.id as string, { source_protocol_id: protocolId });

    for (const step of listProtocolSteps(protocolId)) {
      insert('protocol_steps', {
        id: uuid(),
        protocol_id: created.id,
        sort_order: step.sort_order,
        name: step.name,
        activity: step.activity,
        stage: step.stage,
        offset_days: step.offset_days,
        window_days: step.window_days,
        mandatory: step.mandatory,
        evidence_kinds: step.evidence_kinds,
        phi_days: step.phi_days,
        control_point: step.control_point,
        instruction: step.instruction,
      });
    }
    return getProtocol(created.id as string)!;
  });
}

export function getProtocol(id: string): Record<string, unknown> | null {
  return one('SELECT * FROM production_protocols WHERE id = ?', [id]);
}

export function listProtocols(filter: { status?: string; htxId?: string } = {}): Record<string, unknown>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) { clauses.push('p.status = ?'); params.push(filter.status); }
  // Một HTX nhìn thấy quy trình chuẩn hệ thống + quy trình riêng của chính mình.
  if (filter.htxId) { clauses.push("(p.scope = 'he_thong' OR p.htx_id = ?)"); params.push(filter.htxId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT p.*, c.name AS htx_name,
            (SELECT COUNT(*) FROM protocol_steps s WHERE s.protocol_id = p.id) AS step_count,
            (SELECT COUNT(*) FROM production_plans pl WHERE pl.protocol_id = p.id) AS plan_count
       FROM production_protocols p
       LEFT JOIN cooperatives c ON c.id = p.htx_id
       ${where}
      ORDER BY p.standard, p.code, p.version DESC`,
    params,
  );
}

export function listProtocolSteps(protocolId: string): Record<string, unknown>[] {
  return all(
    'SELECT * FROM protocol_steps WHERE protocol_id = ? ORDER BY sort_order, offset_days',
    [protocolId],
  );
}

// =====================================================================
// Rút quy trình từ một vụ đã hoàn thành
// =====================================================================

export interface DerivedStepPreview {
  sortOrder: number;
  name: string;
  activity: string;
  stage: string | null;
  /** Ngày thực tế đã làm, so với ngày xuống giống. */
  offsetDays: number;
  actualDate: string;
  windowDays: number;
  mandatory: boolean;
  evidenceKinds: string[];
  phiDays: number | null;
  controlPoint: string | null;
  instruction: string | null;
  /** Thuộc tính nào lấy được từ thực tế, thuộc tính nào phải đặt mặc định. */
  derivedFrom: 'ke_hoach' | 'nhat_ky';
  /** Với nguồn là kế hoạch: chênh lệch giữa ngày thực tế và ngày dự kiến gốc. */
  originalOffsetDays: number | null;
  shiftDays: number | null;
}

export interface DerivePreview {
  cropCycle: Record<string, unknown>;
  anchorDate: string;
  source: 'ke_hoach' | 'nhat_ky';
  sourceLabel: string;
  steps: DerivedStepPreview[];
  /** Những gì KHÔNG suy ra được từ một vụ và phải do người soạn quyết định. */
  notDerived: string[];
  warnings: string[];
}

/** Mặc định cho các thuộc tính không quan sát được từ một vụ đơn lẻ. */
const DEFAULT_WINDOW_DAYS = 3;

/**
 * Đọc một vụ đã hoàn thành và dựng bản xem trước của quy trình rút ra từ đó.
 *
 * Hai nguồn, chất lượng khác nhau rõ rệt:
 *
 *   (a) Vụ CÓ kế hoạch — các bước đã được soạn sẵn, nên mọi thuộc tính (bắt
 *       buộc, cửa sổ, bằng chứng, cách ly, điểm kiểm soát) đều mang theo được.
 *       Chỉ MỐC THỜI GIAN là tính lại theo ngày thực tế đã làm. Đây thực chất là
 *       "cập nhật quy trình theo thực tế".
 *
 *   (b) Vụ KHÔNG có kế hoạch — chỉ có nhật ký rời. Từ đó chỉ quan sát được:
 *       làm việc gì, vào ngày nào. KHÔNG quan sát được bước nào bắt buộc, cửa sổ
 *       bao nhiêu ngày là chấp nhận được, cần bằng chứng gì, cách ly bao lâu.
 *       Những thuộc tính đó nhận giá trị mặc định và được liệt kê trong
 *       `notDerived` để người soạn rà lại — hệ thống không bịa ra chúng.
 */
export function previewProtocolFromCycle(cropCycleId: string): DerivePreview {
  const cycle = one<{
    id: string; code: string; sowing_date: string | null; status: string; area_ha: number;
    plot_code: string; htx_id: string; season_name: string; variety: string | null;
  }>(
    `SELECT cc.id, cc.code, cc.sowing_date, cc.status, cc.area_ha, cc.variety,
            p.code AS plot_code, p.htx_id, s.name AS season_name
       FROM crop_cycles cc
       JOIN plots p ON p.id = cc.plot_id
       JOIN seasons s ON s.id = cc.season_id
      WHERE cc.id = ?`,
    [cropCycleId],
  );
  if (!cycle) throw new Error('Không tìm thấy vụ canh tác.');

  // Quy trình là bản mẫu để LẶP LẠI, nên chỉ rút từ vụ đã đi hết chu kỳ.
  if (cycle.status !== 'da_hoan_thanh_vu') {
    throw new Error(
      `Vụ ${cycle.code} chưa hoàn thành. Chỉ rút quy trình từ vụ đã đi hết chu kỳ và khai báo ` +
      'sản lượng — một vụ đang dở dang không phải là bản mẫu để lặp lại.',
    );
  }
  if (!cycle.sowing_date) {
    throw new Error(
      `Vụ ${cycle.code} không có ngày xuống giống nên không tính được mốc thời gian của từng bước.`,
    );
  }

  const anchor = cycle.sowing_date;
  const warnings: string[] = [];
  const notDerived: string[] = [];
  const plan = planForCycle(cropCycleId);

  let steps: DerivedStepPreview[];
  let source: 'ke_hoach' | 'nhat_ky';
  let sourceLabel: string;

  if (plan) {
    source = 'ke_hoach';
    sourceLabel = `Kế hoạch ${plan.code} theo quy trình ${plan.protocol_code} v${plan.protocol_version}`;
    const planSteps = all<Record<string, unknown>>(
      `SELECT * FROM production_plan_steps
        WHERE plan_id = ? AND status = 'da_thuc_hien' AND actual_date IS NOT NULL
        ORDER BY actual_date, sort_order`,
      [plan.id],
    );
    if (!planSteps.length) {
      throw new Error('Kế hoạch của vụ này không có bước nào được xác nhận thực hiện.');
    }
    const skipped = all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM production_plan_steps WHERE plan_id = ? AND status = 'bo_qua'",
      [plan.id],
    );
    if ((skipped[0]?.n ?? 0) > 0) {
      warnings.push(
        `${skipped[0].n} bước bị bỏ qua trong vụ này KHÔNG được đưa vào quy trình mới. ` +
        'Nếu đó là bước cần giữ, hãy thêm lại thủ công sau khi tạo.',
      );
    }

    steps = planSteps.map((step, index) => {
      const actualDate = String(step.actual_date);
      const offsetDays = daysBetween(anchor, actualDate);
      const originalOffset = daysBetween(anchor, String(step.planned_date));
      return {
        sortOrder: index + 1,
        name: String(step.name),
        activity: String(step.activity),
        stage: (step.stage as string) ?? null,
        offsetDays,
        actualDate,
        windowDays: Number(step.window_days),
        mandatory: Boolean(step.mandatory),
        evidenceKinds: parseKinds(step.evidence_kinds),
        phiDays: step.phi_days === null || step.phi_days === undefined ? null : Number(step.phi_days),
        controlPoint: (step.control_point as string) ?? null,
        instruction: (step.instruction as string) ?? null,
        derivedFrom: 'ke_hoach',
        originalOffsetDays: originalOffset,
        shiftDays: offsetDays - originalOffset,
      };
    });
  } else {
    source = 'nhat_ky';
    sourceLabel = 'Nhật ký canh tác ghi rời (vụ không lập kế hoạch)';
    const logs = all<{ log_date: string; activity: string; detail: string | null }>(
      'SELECT log_date, activity, detail FROM farm_logs WHERE crop_cycle_id = ? ORDER BY log_date, created_at',
      [cropCycleId],
    );
    if (!logs.length) throw new Error('Vụ này không có nhật ký canh tác nào để rút quy trình.');

    // Gộp các bản ghi trùng ngày + trùng hoạt động thành một bước.
    const merged = new Map<string, { log_date: string; activity: string; detail: string | null }>();
    for (const log of logs) {
      const key = `${log.log_date}|${log.activity}`;
      if (!merged.has(key)) merged.set(key, log);
    }
    if (merged.size < logs.length) {
      warnings.push(`Đã gộp ${logs.length - merged.size} bản ghi trùng ngày và trùng hoạt động.`);
    }

    steps = [...merged.values()].map((log, index) => ({
      sortOrder: index + 1,
      name: log.detail?.trim() || activityLabel(log.activity),
      activity: log.activity,
      stage: null,
      offsetDays: daysBetween(anchor, log.log_date),
      actualDate: log.log_date,
      windowDays: DEFAULT_WINDOW_DAYS,
      mandatory: true,
      evidenceKinds: [],
      phiDays: null,
      controlPoint: null,
      instruction: null,
      derivedFrom: 'nhat_ky',
      originalOffsetDays: null,
      shiftDays: null,
    }));

    notDerived.push(
      `Cửa sổ thời gian cho phép — đang đặt mặc định ±${DEFAULT_WINDOW_DAYS} ngày cho mọi bước.`,
      'Bước nào bắt buộc, bước nào tuỳ chọn — đang đặt tất cả là bắt buộc.',
      'Loại bằng chứng cần đính kèm — chưa yêu cầu bằng chứng ở bước nào.',
      'Thời gian cách ly sau phun thuốc — không quan sát được từ nhật ký, phải nhập tay.',
      'Điểm kiểm soát và hướng dẫn thực hiện từng bước.',
    );
    if (steps.some((step) => step.activity === 'phun_thuoc')) {
      warnings.push(
        'Vụ này có bước phun thuốc nhưng nhật ký không ghi thời gian cách ly. ' +
        'Phải nhập thời gian cách ly trước khi ban hành, nếu không quy trình sẽ không chặn được thu hoạch sớm.',
      );
    }
  }

  if (!steps.some((step) => step.activity === 'thu_hoach')) {
    warnings.push('Chưa có bước thu hoạch — phải bổ sung thì mới ban hành được quy trình.');
  }

  return {
    cropCycle: {
      id: cycle.id, code: cycle.code, plotCode: cycle.plot_code, seasonName: cycle.season_name,
      sowingDate: cycle.sowing_date, areaHa: cycle.area_ha, variety: cycle.variety, htxId: cycle.htx_id,
    },
    anchorDate: anchor,
    source,
    sourceLabel,
    steps,
    notDerived,
    warnings,
  };
}

function activityLabel(activity: string): string {
  return ({
    lam_dat: 'Làm đất', gieo_sa: 'Gieo sạ', bon_phan: 'Bón phân', phun_thuoc: 'Phun thuốc',
    tuoi: 'Tưới nước', rut_nuoc_awd: 'Rút nước (AWD)', thu_hoach: 'Thu hoạch',
  } as Record<string, string>)[activity] ?? activity;
}

/**
 * Tạo quy trình mới từ một vụ đã hoàn thành.
 *
 * BR-08: quy trình sinh ra luôn ở trạng thái NHÁP, kèm mô tả ghi rõ nguồn gốc và
 * những thuộc tính chưa suy ra được. Ban hành thẳng một bản mẫu rút từ đúng MỘT
 * vụ là biến một lần quan sát thành chuẩn — người soạn phải rà trước.
 */
export function createProtocolFromCycle(
  input: {
    cropCycleId: string;
    name?: string;
    standard?: string;
    scope?: 'he_thong' | 'htx';
    htxId?: string | null;
    code?: string;
  },
  actor: AuditActor = {},
): Record<string, unknown> {
  const preview = previewProtocolFromCycle(input.cropCycleId);

  return transaction(() => {
    const scope = input.scope ?? 'htx';
    const provenance = [
      `Rút từ vụ ${preview.cropCycle.code} (lô ${preview.cropCycle.plotCode}, ${preview.cropCycle.seasonName}),`,
      `xuống giống ${preview.anchorDate}. Nguồn: ${preview.sourceLabel}.`,
      preview.notDerived.length
        ? `Cần rà lại trước khi ban hành: ${preview.notDerived.join(' ')}`
        : 'Mọi thuộc tính bước được kế thừa từ quy trình gốc; chỉ mốc thời gian tính lại theo thực tế.',
    ].join(' ');

    const protocol = createProtocol({
      code: input.code,
      name: input.name?.trim() || `Quy trình rút từ vụ ${preview.cropCycle.code}`,
      standard: input.standard ?? 'noi_bo',
      scope,
      htxId: scope === 'htx' ? (input.htxId ?? (preview.cropCycle.htxId as string)) : null,
      description: provenance,
      sourceCropCycleId: input.cropCycleId,
    }, actor);

    for (const step of preview.steps) {
      insert('protocol_steps', {
        id: uuid(),
        protocol_id: protocol.id,
        sort_order: step.sortOrder,
        name: step.name,
        activity: step.activity,
        stage: step.stage,
        offset_days: step.offsetDays,
        window_days: step.windowDays,
        mandatory: step.mandatory ? 1 : 0,
        evidence_kinds: step.evidenceKinds.length ? JSON.stringify(step.evidenceKinds) : null,
        phi_days: step.phiDays,
        control_point: step.controlPoint,
        instruction: step.instruction,
      });
    }

    logEvent({
      module: 'htx', entityType: 'production_protocols', entityId: protocol.id as string,
      action: 'derive', after: { sourceCropCycleId: input.cropCycleId, source: preview.source, steps: preview.steps.length },
    }, actor);

    return { ...getProtocol(protocol.id as string)!, derivedFrom: preview.source, warnings: preview.warnings, notDerived: preview.notDerived };
  });
}

/** Các vụ đã hoàn thành, đủ điều kiện rút quy trình. */
export function cyclesEligibleForDerivation(htxId?: string): Record<string, unknown>[] {
  const sql = `SELECT cc.id, cc.code, cc.sowing_date, cc.area_ha, cc.variety,
                      p.code AS plot_code, p.htx_id, s.name AS season_name,
                      (SELECT COUNT(*) FROM farm_logs fl WHERE fl.crop_cycle_id = cc.id) AS log_count,
                      (SELECT pl.id FROM production_plans pl WHERE pl.crop_cycle_id = cc.id) AS plan_id,
                      (SELECT hd.harvest_date FROM harvest_declarations hd WHERE hd.crop_cycle_id = cc.id) AS harvest_date
                 FROM crop_cycles cc
                 JOIN plots p ON p.id = cc.plot_id
                 JOIN seasons s ON s.id = cc.season_id
                WHERE cc.status = 'da_hoan_thanh_vu' AND cc.sowing_date IS NOT NULL`;
  const rows = htxId
    ? all<Record<string, unknown>>(`${sql} AND p.htx_id = ? ORDER BY cc.created_at DESC`, [htxId])
    : all<Record<string, unknown>>(`${sql} ORDER BY cc.created_at DESC`);
  return rows
    .filter((row) => Number(row.log_count) > 0 || row.plan_id)
    .map((row) => ({ ...row, source: row.plan_id ? 'ke_hoach' : 'nhat_ky' }));
}

// =====================================================================
// Kế hoạch sản xuất
// =====================================================================

/**
 * Bung quy trình thành kế hoạch cho một vụ canh tác.
 *
 * BR-01: neo vào NGÀY XUỐNG GIỐNG của vụ. Vụ chưa khai ngày xuống giống thì
 * dừng lại và nói rõ, thay vì lấy ngày hôm nay làm mốc — một kế hoạch neo sai
 * ngày còn tệ hơn không có kế hoạch.
 */
export function generatePlan(
  input: { cropCycleId: string; protocolId: string; anchorDate?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const cycle = one<{ id: string; code: string; sowing_date: string | null; status: string }>(
    'SELECT id, code, sowing_date, status FROM crop_cycles WHERE id = ?',
    [input.cropCycleId],
  );
  if (!cycle) throw new Error('Không tìm thấy vụ canh tác.');
  if (cycle.status !== 'dang_canh_tac') throw new Error('Vụ đã đóng — không lập kế hoạch sản xuất mới.');

  const anchor = input.anchorDate ?? cycle.sowing_date;
  if (!anchor) {
    throw new Error(
      `Vụ ${cycle.code} chưa có ngày xuống giống. Kế hoạch sản xuất neo toàn bộ mốc thời gian vào ` +
      'ngày xuống giống, nên cần khai báo ngày này trước (hoặc chỉ định ngày neo khi lập kế hoạch).',
    );
  }

  const protocol = getProtocol(input.protocolId);
  if (!protocol) throw new Error('Không tìm thấy quy trình.');
  // BR-02
  if (protocol.status !== 'ban_hanh') {
    throw new Error(`Quy trình "${protocol.name}" chưa được ban hành — không áp dụng vào vụ sản xuất được.`);
  }
  const steps = listProtocolSteps(input.protocolId);
  if (!steps.length) throw new Error('Quy trình không có bước nào.');

  const existing = one<{ id: string }>('SELECT id FROM production_plans WHERE crop_cycle_id = ?', [input.cropCycleId]);
  if (existing) {
    throw new Error('Vụ này đã có kế hoạch sản xuất. Huỷ kế hoạch cũ trước khi lập kế hoạch mới.');
  }

  return transaction(() => {
    const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM production_plans');
    const plan = {
      id: uuid(),
      code: `KHSX-${String((count?.n ?? 0) + 1).padStart(5, '0')}`,
      crop_cycle_id: input.cropCycleId,
      protocol_id: input.protocolId,
      // BR-03: ghim phiên bản quy trình tại thời điểm sinh kế hoạch.
      protocol_version: Number(protocol.version),
      anchor_date: anchor,
      status: 'dang_thuc_hien',
      created_by: actor.name ?? null,
      created_at: nowIso(),
    };
    insert('production_plans', plan);

    for (const step of steps) {
      insert('production_plan_steps', {
        id: uuid(),
        plan_id: plan.id,
        protocol_step_id: step.id,
        sort_order: step.sort_order,
        name: step.name,
        activity: step.activity,
        stage: step.stage,
        planned_date: addDays(anchor, Number(step.offset_days)),
        window_days: step.window_days,
        mandatory: step.mandatory,
        evidence_kinds: step.evidence_kinds,
        phi_days: step.phi_days,
        control_point: step.control_point,
        instruction: step.instruction,
        status: 'ke_hoach',
        actual_date: null,
        deviation_days: null,
        deviation_reason: null,
        farm_log_id: null,
        confirmed_by: null,
        confirmed_at: null,
      });
    }

    logEvent({ module: 'htx', entityType: 'production_plans', entityId: plan.id, action: 'create', after: plan }, actor);
    return getPlan(plan.id)!;
  });
}

export function cancelPlan(planId: string, actor: AuditActor = {}): void {
  const plan = one<{ id: string; status: string }>('SELECT id, status FROM production_plans WHERE id = ?', [planId]);
  if (!plan) throw new Error('Không tìm thấy kế hoạch sản xuất.');
  const confirmed = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM production_plan_steps WHERE plan_id = ? AND status = 'da_thuc_hien'",
    [planId],
  );
  if ((confirmed?.n ?? 0) > 0) {
    throw new Error(
      `Kế hoạch đã có ${confirmed!.n} bước được xác nhận thực hiện kèm bằng chứng — không huỷ được. ` +
      'Nhật ký sản xuất là hồ sơ truy xuất nguồn gốc, không phải bản nháp.',
    );
  }
  run('DELETE FROM production_plans WHERE id = ?', [planId]);
  logEvent({ module: 'htx', entityType: 'production_plans', entityId: planId, action: 'delete', before: plan }, actor);
}

export function getPlan(planId: string): Record<string, unknown> | null {
  return one(
    `SELECT pl.*, pr.name AS protocol_name, pr.standard, pr.code AS protocol_code,
            cc.code AS crop_cycle_code, cc.sowing_date, cc.area_ha,
            p.code AS plot_code, p.htx_id
       FROM production_plans pl
       JOIN production_protocols pr ON pr.id = pl.protocol_id
       JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id
       JOIN plots p ON p.id = cc.plot_id
      WHERE pl.id = ?`,
    [planId],
  );
}

export function planForCycle(cropCycleId: string): Record<string, unknown> | null {
  const row = one<{ id: string }>('SELECT id FROM production_plans WHERE crop_cycle_id = ?', [cropCycleId]);
  return row ? getPlan(row.id) : null;
}

export function listPlans(htxId?: string): Record<string, unknown>[] {
  const sql = `SELECT pl.*, pr.name AS protocol_name, pr.standard,
                      cc.code AS crop_cycle_code, p.code AS plot_code, p.htx_id
                 FROM production_plans pl
                 JOIN production_protocols pr ON pr.id = pl.protocol_id
                 JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id
                 JOIN plots p ON p.id = cc.plot_id`;
  const rows = htxId
    ? all(`${sql} WHERE p.htx_id = ? ORDER BY pl.created_at DESC`, [htxId])
    : all(`${sql} ORDER BY pl.created_at DESC`);
  return rows.map((plan) => ({ ...plan, progress: planProgress(plan.id as string) }));
}

/** Các bước của kế hoạch, kèm bằng chứng đã đính và tình trạng đúng/trễ hạn. */
export function listPlanSteps(planId: string): Record<string, unknown>[] {
  const steps = all<Record<string, unknown>>(
    'SELECT * FROM production_plan_steps WHERE plan_id = ? ORDER BY sort_order, planned_date',
    [planId],
  );
  const today = nowIso().slice(0, 10);
  return steps.map((step) => {
    const evidence = all(
      'SELECT id, kind, label, file_name, mime_type, captured_at, created_at FROM plan_step_evidence WHERE plan_step_id = ? ORDER BY created_at',
      [step.id],
    );
    const requiredKinds = parseKinds(step.evidence_kinds);
    const providedKinds = new Set(evidence.map((item) => String(item.kind)));
    const missingEvidence = requiredKinds.filter((kind) => !providedKinds.has(kind));

    // Quá hạn = chưa thực hiện và đã qua ngày dự kiến + cửa sổ cho phép.
    const dueDate = addDays(String(step.planned_date), Number(step.window_days));
    const overdue = step.status === 'ke_hoach' && today > dueDate;

    return {
      ...step,
      evidence,
      requiredEvidenceKinds: requiredKinds,
      missingEvidence,
      dueDate,
      overdue,
      onTime: step.status === 'da_thuc_hien'
        ? Math.abs(Number(step.deviation_days ?? 0)) <= Number(step.window_days)
        : null,
    };
  });
}

/** Tiến độ và tỷ lệ tuân thủ của một kế hoạch. */
export function planProgress(planId: string): Record<string, unknown> {
  const steps = listPlanSteps(planId);
  const mandatory = steps.filter((step) => step.mandatory);
  const done = steps.filter((step) => step.status === 'da_thuc_hien');
  const mandatoryDone = mandatory.filter((step) => step.status === 'da_thuc_hien');
  const mandatoryOnTime = mandatoryDone.filter((step) => step.onTime === true);
  const overdue = steps.filter((step) => step.overdue);
  const skipped = steps.filter((step) => step.status === 'bo_qua');

  return {
    totalSteps: steps.length,
    doneSteps: done.length,
    mandatorySteps: mandatory.length,
    mandatoryDone: mandatoryDone.length,
    overdueSteps: overdue.length,
    skippedSteps: skipped.length,
    completionPct: steps.length ? Math.round((done.length / steps.length) * 1000) / 10 : 0,
    // Tuân thủ = bước BẮT BUỘC thực hiện ĐÚNG HẠN / tổng bước bắt buộc.
    // Làm đúng việc nhưng trễ hạn vẫn là không tuân thủ quy trình.
    compliancePct: mandatory.length
      ? Math.round((mandatoryOnTime.length / mandatory.length) * 1000) / 10
      : 0,
    nextStep: steps.find((step) => step.status === 'ke_hoach') ?? null,
  };
}

// =====================================================================
// Xác nhận bước kế hoạch
// =====================================================================

export interface ConfirmInput {
  actualDate?: string;
  deviationReason?: string;
  detail?: string;
  inputName?: string;
  inputQty?: number;
  inputUom?: string;
  lat?: number;
  lng?: number;
  evidence?: {
    kind: string; label?: string; fileName?: string; mimeType?: string;
    content?: string; lat?: number; lng?: number; capturedAt?: string;
  }[];
}

/**
 * Xác nhận một bước kế hoạch đã thực hiện.
 *
 * Đây là điểm thay thế cho việc "ghi nhật ký tự do": bản ghi nhật ký vẫn được
 * tạo (để MRV và truy xuất dùng lại nguyên vẹn), nhưng gắn với bước kế hoạch và
 * chỉ được chấp nhận khi thoả các điều kiện của quy trình.
 */
export function confirmPlanStep(
  stepId: string,
  input: ConfirmInput,
  actor: AuditActor = {},
): Record<string, unknown> {
  const step = one<Record<string, unknown>>('SELECT * FROM production_plan_steps WHERE id = ?', [stepId]);
  if (!step) throw new Error('Không tìm thấy bước kế hoạch.');
  if (step.status === 'da_thuc_hien') throw new Error('Bước này đã được xác nhận thực hiện.');

  const plan = one<{ id: string; crop_cycle_id: string; status: string }>(
    'SELECT id, crop_cycle_id, status FROM production_plans WHERE id = ?',
    [step.plan_id],
  );
  if (!plan) throw new Error('Không tìm thấy kế hoạch sản xuất.');

  const actualDate = input.actualDate ?? nowIso().slice(0, 10);
  const deviation = daysBetween(String(step.planned_date), actualDate);
  const windowDays = Number(step.window_days);

  // BR-05: lệch quá cửa sổ cho phép thì phải nêu lý do. Hệ thống không im lặng
  // chấp nhận một mốc lệch cả tuần so với quy trình đã cam kết.
  if (Math.abs(deviation) > windowDays && !input.deviationReason?.trim()) {
    throw new Error(
      `Thực hiện lệch ${deviation > 0 ? 'muộn' : 'sớm'} ${Math.abs(deviation)} ngày so với kế hoạch ` +
      `(cửa sổ cho phép ±${windowDays} ngày) — phải ghi lý do điều chỉnh.`,
    );
  }

  // BR-04: đủ loại bằng chứng bắt buộc mới được xác nhận.
  const requiredKinds = parseKinds(step.evidence_kinds);
  if (requiredKinds.length) {
    const provided = new Set([
      ...all<{ kind: string }>('SELECT kind FROM plan_step_evidence WHERE plan_step_id = ?', [stepId]).map((e) => e.kind),
      ...(input.evidence ?? []).map((e) => e.kind),
    ]);
    const missing = requiredKinds.filter((kind) => !provided.has(kind));
    if (missing.length) {
      const labels = missing.map((kind) => EVIDENCE_KINDS.find((e) => e.code === kind)?.label ?? kind);
      throw new Error(`Bước này bắt buộc có bằng chứng: ${labels.join(', ')}. Hãy đính kèm trước khi xác nhận.`);
    }
  }

  // BR-06: kiểm tra thời gian cách ly khi bước đang xác nhận là THU HOẠCH.
  if (step.activity === 'thu_hoach') {
    const violation = checkPreHarvestInterval(String(plan.id), actualDate);
    if (violation) throw new Error(violation);
  }

  return transaction(() => {
    // Bản ghi nhật ký vẫn được tạo — hồ sơ truy xuất và MRV đọc từ đây.
    const logId = uuid();
    insert('farm_logs', {
      id: logId,
      crop_cycle_id: plan.crop_cycle_id,
      log_date: actualDate,
      activity: step.activity,
      detail: input.detail ?? String(step.name),
      input_name: input.inputName ?? null,
      input_qty: input.inputQty ?? null,
      input_uom: input.inputUom ?? null,
      photo_url: null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      recorded_by: actor.name ?? null,
      synced: 1,
      created_at: nowIso(),
      plan_step_id: stepId,
    });

    for (const item of input.evidence ?? []) {
      addEvidence(stepId, item, actor);
    }

    const onTime = Math.abs(deviation) <= windowDays;
    update('production_plan_steps', stepId, {
      status: 'da_thuc_hien',
      actual_date: actualDate,
      deviation_days: deviation,
      deviation_reason: input.deviationReason?.trim() || null,
      farm_log_id: logId,
      confirmed_by: actor.name ?? null,
      confirmed_at: nowIso(),
    });

    // Kế hoạch tự đóng khi mọi bước bắt buộc đã xong.
    const progress = planProgress(String(plan.id));
    if (progress.mandatoryDone === progress.mandatorySteps && Number(progress.mandatorySteps) > 0) {
      update('production_plans', String(plan.id), { status: 'hoan_thanh' });
    }

    logEvent({
      module: 'htx', entityType: 'production_plan_steps', entityId: stepId,
      action: 'confirm', before: step, after: { actualDate, deviation, onTime },
    }, actor);

    return { ...one('SELECT * FROM production_plan_steps WHERE id = ?', [stepId])!, farmLogId: logId, deviationDays: deviation, onTime };
  });
}

/** Bỏ qua một bước không áp dụng cho vụ này — bước BẮT BUỘC thì không bỏ được. */
export function skipPlanStep(stepId: string, reason: string, actor: AuditActor = {}): Record<string, unknown> {
  const step = one<Record<string, unknown>>('SELECT * FROM production_plan_steps WHERE id = ?', [stepId]);
  if (!step) throw new Error('Không tìm thấy bước kế hoạch.');
  if (step.status === 'da_thuc_hien') throw new Error('Bước đã xác nhận thực hiện — không bỏ qua được.');
  if (step.mandatory) {
    throw new Error(
      `Bước "${step.name}" là bắt buộc theo quy trình — không được bỏ qua. ` +
      'Nếu thực tế không làm bước này thì vụ không còn đạt chuẩn đã đăng ký.',
    );
  }
  if (!reason?.trim()) throw new Error('Bỏ qua một bước phải có lý do.');

  update('production_plan_steps', stepId, {
    status: 'bo_qua',
    deviation_reason: reason.trim(),
    confirmed_by: actor.name ?? null,
    confirmed_at: nowIso(),
  });
  logEvent({ module: 'htx', entityType: 'production_plan_steps', entityId: stepId, action: 'skip', before: step, after: { reason } }, actor);
  return one('SELECT * FROM production_plan_steps WHERE id = ?', [stepId])!;
}

export function addEvidence(
  stepId: string,
  item: { kind: string; label?: string; fileName?: string; mimeType?: string; content?: string; lat?: number; lng?: number; capturedAt?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const step = one<{ id: string }>('SELECT id FROM production_plan_steps WHERE id = ?', [stepId]);
  if (!step) throw new Error('Không tìm thấy bước kế hoạch.');
  if (!item.kind) throw new Error('Bằng chứng phải có loại.');

  const record = {
    id: uuid(),
    plan_step_id: stepId,
    kind: item.kind,
    label: item.label ?? null,
    file_name: item.fileName ?? null,
    mime_type: item.mimeType ?? null,
    content: item.content ?? null,
    lat: item.lat ?? null,
    lng: item.lng ?? null,
    captured_at: item.capturedAt ?? nowIso(),
    uploaded_by: actor.name ?? null,
    created_at: nowIso(),
  };
  insert('plan_step_evidence', record);
  logEvent({ module: 'htx', entityType: 'plan_step_evidence', entityId: record.id, action: 'create', after: { ...record, content: null } }, actor);
  return { ...record, content: undefined };
}

export function listEvidence(stepId: string): Record<string, unknown>[] {
  return all('SELECT * FROM plan_step_evidence WHERE plan_step_id = ? ORDER BY created_at', [stepId]);
}

/**
 * BR-06 — Thời gian cách ly trước thu hoạch (Pre-Harvest Interval).
 *
 * VietGAP bắt buộc: sau khi phun thuốc BVTV phải chờ đủ số ngày cách ly mới
 * được thu hoạch. Đây là kiểm tra an toàn thực phẩm thật, nên hệ thống CHẶN
 * chứ không chỉ cảnh báo — một lô lúa thu hoạch sớm hơn PHI là lô không đạt.
 */
export function checkPreHarvestInterval(planId: string, harvestDate: string): string | null {
  const sprays = all<{ name: string; actual_date: string; phi_days: number }>(
    `SELECT name, actual_date, phi_days FROM production_plan_steps
      WHERE plan_id = ? AND status = 'da_thuc_hien' AND phi_days IS NOT NULL AND actual_date IS NOT NULL`,
    [planId],
  );
  for (const spray of sprays) {
    const earliest = addDays(spray.actual_date, Number(spray.phi_days));
    if (harvestDate < earliest) {
      return (
        `Vi phạm thời gian cách ly: bước "${spray.name}" thực hiện ngày ${spray.actual_date} ` +
        `yêu cầu cách ly ${spray.phi_days} ngày, sớm nhất được thu hoạch từ ${earliest}. ` +
        `Ngày thu hoạch khai báo (${harvestDate}) chưa đủ thời gian cách ly.`
      );
    }
  }
  return null;
}

/** Hồ sơ truy xuất một vụ: quy trình áp dụng, từng bước, bằng chứng. */
export function traceabilityRecord(cropCycleId: string): Record<string, unknown> | null {
  const plan = planForCycle(cropCycleId);
  if (!plan) return null;
  const steps = listPlanSteps(String(plan.id)).map((step) => ({
    ...step,
    evidenceCount: (step.evidence as unknown[]).length,
  }));
  return { plan, progress: planProgress(String(plan.id)), steps };
}
