/**
 * PHÂN CÔNG CÔNG VIỆC THEO KẾ HOẠCH SẢN XUẤT — App Hợp tác xã.
 *
 * Luồng nghiệp vụ: chọn thửa ruộng → hiện kế hoạch sản xuất dự kiến của thửa →
 * chọn công đoạn → gán thành viên HTX và/hoặc máy móc, thiết bị.
 *
 * HAI MÔ HÌNH VẬN HÀNH HTX
 * ------------------------
 * Đây là điểm khác biệt cốt lõi, không phải một tuỳ chọn hiển thị:
 *
 *   tap_trung           Ban quản trị phân công CẢ nhân lực lẫn máy móc. Thành
 *                       viên nhận việc được giao và xác nhận/từ chối.
 *
 *   thanh_vien_chu_dong Thành viên tự chủ trên thửa của mình — Ban quản trị
 *                       KHÔNG giao việc nhân công cho họ được. Nhưng máy móc và
 *                       thiết bị dùng chung (drone phun thuốc, máy gặt...) vẫn
 *                       do Ban quản trị điều phối, vì đó là tài sản chung và
 *                       phải xếp lịch giữa các thửa.
 *
 * Chuyển đổi giữa hai mô hình là một thuộc tính của HTX, đổi được bất cứ lúc
 * nào; các phân công đã tạo trước đó không bị xoá.
 */
import { all, insert, one, run, update } from '../../platform/db/db.ts';
import { nowIso, uuid } from '../../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../../platform/audit/audit.ts';

export const OPERATING_MODELS = [
  {
    code: 'tap_trung',
    label: 'Ban quản trị phân công',
    description: 'Ban quản trị giao việc cho thành viên và điều phối máy móc trên toàn bộ thửa ruộng của HTX.',
  },
  {
    code: 'thanh_vien_chu_dong',
    label: 'Thành viên chủ động',
    description:
      'Thành viên tự tổ chức công việc trên thửa của mình. Ban quản trị chỉ điều phối máy móc, ' +
      'thiết bị dùng chung (drone phun thuốc, máy gặt) và theo dõi tiến độ.',
  },
];

export const ASSIGNMENT_ROLES = [
  { code: 'phu_trach', label: 'Phụ trách' },
  { code: 'ho_tro', label: 'Hỗ trợ' },
  { code: 'van_hanh_may', label: 'Vận hành máy' },
];

export const ASSIGNMENT_STATUS = {
  da_giao: 'Đã giao',
  da_nhan: 'Đã nhận',
  tu_choi: 'Từ chối',
  hoan_thanh: 'Hoàn thành',
  huy: 'Đã huỷ',
};

// =====================================================================
// Mô hình vận hành của HTX
// =====================================================================

export function getOperatingModel(htxId: string): string {
  const row = one<{ operating_model: string }>(
    'SELECT operating_model FROM cooperatives WHERE id = ?',
    [htxId],
  );
  if (!row) throw new Error('Không tìm thấy hợp tác xã.');
  return row.operating_model ?? 'tap_trung';
}

export function setOperatingModel(htxId: string, model: string, actor: AuditActor = {}): Record<string, unknown> {
  if (!OPERATING_MODELS.some((item) => item.code === model)) {
    throw new Error(`Mô hình vận hành không hợp lệ: "${model}".`);
  }
  const before = one<Record<string, unknown>>('SELECT * FROM cooperatives WHERE id = ?', [htxId]);
  if (!before) throw new Error('Không tìm thấy hợp tác xã.');

  update('cooperatives', htxId, { operating_model: model, updated_at: nowIso() });
  const after = one<Record<string, unknown>>('SELECT * FROM cooperatives WHERE id = ?', [htxId])!;
  logEvent({ module: 'htx', entityType: 'cooperatives', entityId: htxId, action: 'update', before, after }, actor);
  return after;
}

// =====================================================================
// Kế hoạch sản xuất theo THỬA RUỘNG
// =====================================================================

/**
 * Kế hoạch dự kiến của một thửa ruộng, kèm phân công hiện có của từng bước.
 * Đây là màn hình mà người phân công nhìn vào: thửa → công đoạn → ai làm.
 */
export function plotWorkPlan(plotId: string): Record<string, unknown> {
  const plot = one<{
    id: string; code: string; htx_id: string; area_ha: number; farmer_id: string | null;
    farmer_name: string | null; status: string;
  }>(
    `SELECT p.id, p.code, p.htx_id, p.area_ha, p.farmer_id, p.status, f.full_name AS farmer_name
       FROM plots p LEFT JOIN farmers f ON f.id = p.farmer_id
      WHERE p.id = ?`,
    [plotId],
  );
  if (!plot) throw new Error('Không tìm thấy thửa ruộng.');

  const cycle = one<{ id: string; code: string; sowing_date: string | null; season_name: string }>(
    `SELECT cc.id, cc.code, cc.sowing_date, s.name AS season_name
       FROM crop_cycles cc JOIN seasons s ON s.id = cc.season_id
      WHERE cc.plot_id = ? AND cc.status = 'dang_canh_tac'
      ORDER BY cc.created_at DESC LIMIT 1`,
    [plotId],
  );

  const model = getOperatingModel(plot.htx_id);
  if (!cycle) {
    return {
      plot, cycle: null, plan: null, steps: [], operatingModel: model,
      notice: 'Thửa ruộng chưa có vụ đang canh tác — mở vụ và lập kế hoạch sản xuất trước khi phân công.',
    };
  }

  const plan = one<{ id: string; code: string; protocol_name: string; anchor_date: string }>(
    `SELECT pl.id, pl.code, pl.anchor_date, pr.name AS protocol_name
       FROM production_plans pl JOIN production_protocols pr ON pr.id = pl.protocol_id
      WHERE pl.crop_cycle_id = ?`,
    [cycle.id],
  );
  if (!plan) {
    return {
      plot, cycle, plan: null, steps: [], operatingModel: model,
      notice: `Vụ ${cycle.code} chưa có kế hoạch sản xuất — lập kế hoạch từ một quy trình đã ban hành trước khi phân công.`,
    };
  }

  const steps = all<Record<string, unknown>>(
    `SELECT * FROM production_plan_steps WHERE plan_id = ? ORDER BY sort_order, planned_date`,
    [plan.id],
  ).map((step) => ({ ...step, assignments: listAssignments(String(step.id)) }));

  // Mô hình "thành viên chủ động" dựa vào CHỦ THỬA để biết ai được tự tổ chức
  // công việc. Thửa chưa gán chủ thì quy tắc không có gì để áp — nói rõ ra thay
  // vì âm thầm cho phép Ban quản trị giao việc cho bất kỳ ai.
  const notice = model === 'thanh_vien_chu_dong' && !plot.farmer_id
    ? `Thửa ${plot.code} chưa gán chủ thửa. HTX đang theo mô hình "Thành viên chủ động" nhưng quy tắc ` +
      'chỉ áp được khi biết ai là chủ thửa — hiện tại Ban quản trị vẫn giao việc được cho mọi thành viên. ' +
      'Hãy gán chủ thửa để mô hình có hiệu lực.'
    : null;

  return { plot, cycle, plan, steps, operatingModel: model, notice };
}

export function listAssignments(planStepId: string): Record<string, unknown>[] {
  return all(
    `SELECT a.*, f.full_name AS farmer_name, f.phone AS farmer_phone,
            m.code AS machine_code, mt.name AS machine_type_name
       FROM plan_step_assignments a
       LEFT JOIN farmers f ON f.id = a.farmer_id
       LEFT JOIN machines m ON m.id = a.machine_id
       LEFT JOIN machine_types mt ON mt.id = m.machine_type_id
      WHERE a.plan_step_id = ?
      ORDER BY a.created_at`,
    [planStepId],
  );
}

// =====================================================================
// Gán việc
// =====================================================================

export interface AssignInput {
  planStepId: string;
  /** Gán cho một hoặc nhiều thành viên cùng lúc. */
  farmerIds?: string[];
  /** Điều phối một hoặc nhiều máy/thiết bị. */
  machineIds?: string[];
  role?: string;
  plannedDate?: string;
  hours?: number;
  note?: string;
}

export interface AssignResult {
  created: Record<string, unknown>[];
  skipped: { target: string; reason: string }[];
  /** Cảnh báo cấp phân công, ví dụ mô hình vận hành chưa áp được. */
  warnings: string[];
}

/**
 * Gán công đoạn cho thành viên và/hoặc máy móc.
 *
 * Chốt chặn theo mô hình vận hành: ở mô hình "thành viên chủ động", Ban quản trị
 * không giao việc NHÂN CÔNG cho người khác — chỉ chủ thửa mới tự nhận việc trên
 * thửa của mình. Máy móc thì cả hai mô hình đều do Ban quản trị điều phối.
 */
export function assignWork(input: AssignInput, actor: AuditActor = {}): AssignResult {
  const step = one<{ id: string; plan_id: string; name: string; activity: string; planned_date: string; status: string }>(
    'SELECT id, plan_id, name, activity, planned_date, status FROM production_plan_steps WHERE id = ?',
    [input.planStepId],
  );
  if (!step) throw new Error('Không tìm thấy công đoạn trong kế hoạch.');
  if (step.status === 'da_thuc_hien') throw new Error('Công đoạn đã thực hiện — không phân công thêm.');
  if (step.status === 'bo_qua') throw new Error('Công đoạn đã được đánh dấu bỏ qua.');

  const context = one<{ htx_id: string; plot_id: string; plot_farmer_id: string | null; plot_code: string }>(
    `SELECT p.htx_id, p.id AS plot_id, p.farmer_id AS plot_farmer_id, p.code AS plot_code
       FROM production_plans pl
       JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id
       JOIN plots p ON p.id = cc.plot_id
      WHERE pl.id = ?`,
    [step.plan_id],
  );
  if (!context) throw new Error('Không xác định được thửa ruộng của kế hoạch.');

  const model = getOperatingModel(context.htx_id);
  const plannedDate = input.plannedDate ?? step.planned_date;
  const created: Record<string, unknown>[] = [];
  const skipped: { target: string; reason: string }[] = [];
  const warnings: string[] = [];

  if (model === 'thanh_vien_chu_dong' && !context.plot_farmer_id && (input.farmerIds ?? []).length) {
    warnings.push(
      `Thửa ${context.plot_code} chưa gán chủ thửa nên quy tắc "Thành viên chủ động" không áp được — ` +
      'phân công nhân công vẫn thực hiện như mô hình tập trung. Gán chủ thửa để quy tắc có hiệu lực.',
    );
  }

  for (const farmerId of input.farmerIds ?? []) {
    const farmer = one<{ id: string; full_name: string; htx_id: string; status: string }>(
      'SELECT id, full_name, htx_id, status FROM farmers WHERE id = ?',
      [farmerId],
    );
    if (!farmer) { skipped.push({ target: farmerId, reason: 'Không tìm thấy thành viên.' }); continue; }
    if (farmer.htx_id !== context.htx_id) {
      skipped.push({ target: farmer.full_name, reason: 'Thành viên không thuộc HTX quản lý thửa ruộng này.' });
      continue;
    }
    if (farmer.status !== 'active') {
      skipped.push({ target: farmer.full_name, reason: 'Thành viên đang ngừng hoạt động.' });
      continue;
    }
    // Chốt chặn mô hình vận hành.
    if (model === 'thanh_vien_chu_dong' && context.plot_farmer_id && farmer.id !== context.plot_farmer_id) {
      skipped.push({
        target: farmer.full_name,
        reason:
          `HTX đang vận hành theo mô hình "Thành viên chủ động": thửa ${context.plot_code} do chủ thửa tự ` +
          'tổ chức công việc, Ban quản trị không giao việc nhân công cho người khác. Máy móc thì vẫn điều phối được.',
      });
      continue;
    }
    const existing = one<{ id: string }>(
      'SELECT id FROM plan_step_assignments WHERE plan_step_id = ? AND farmer_id = ?',
      [input.planStepId, farmerId],
    );
    if (existing) { skipped.push({ target: farmer.full_name, reason: 'Đã được giao công đoạn này.' }); continue; }

    created.push(insertAssignment({
      planStepId: input.planStepId, kind: 'nhan_cong', farmerId,
      role: input.role ?? 'phu_trach', plannedDate, hours: input.hours, note: input.note,
    }, actor));
  }

  for (const machineId of input.machineIds ?? []) {
    const machine = one<{ id: string; code: string; condition: string; htx_id: string | null }>(
      'SELECT id, code, condition, htx_id FROM machines WHERE id = ?',
      [machineId],
    );
    if (!machine) { skipped.push({ target: machineId, reason: 'Không tìm thấy máy.' }); continue; }
    if (machine.condition !== 'hoat_dong') {
      skipped.push({
        target: machine.code,
        reason: `Máy đang ở tình trạng "${machine.condition}" — không điều phối được.`,
      });
      continue;
    }
    // Một máy không thể ở hai nơi cùng một ngày.
    const clash = one<{ plot_code: string; step_name: string }>(
      `SELECT p.code AS plot_code, s.name AS step_name
         FROM plan_step_assignments a
         JOIN production_plan_steps s ON s.id = a.plan_step_id
         JOIN production_plans pl ON pl.id = s.plan_id
         JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id
         JOIN plots p ON p.id = cc.plot_id
        WHERE a.machine_id = ? AND a.planned_date = ?
          AND a.status IN ('da_giao', 'da_nhan') AND a.plan_step_id <> ?`,
      [machineId, plannedDate, input.planStepId],
    );
    if (clash) {
      skipped.push({
        target: machine.code,
        reason: `Đã được điều phối ngày ${plannedDate} cho thửa ${clash.plot_code} (${clash.step_name}).`,
      });
      continue;
    }
    const existing = one<{ id: string }>(
      'SELECT id FROM plan_step_assignments WHERE plan_step_id = ? AND machine_id = ?',
      [input.planStepId, machineId],
    );
    if (existing) { skipped.push({ target: machine.code, reason: 'Đã được điều phối cho công đoạn này.' }); continue; }

    created.push(insertAssignment({
      planStepId: input.planStepId, kind: 'may_moc', machineId,
      role: 'van_hanh_may', plannedDate, hours: input.hours, note: input.note,
    }, actor));
  }

  if (!created.length && !skipped.length) {
    throw new Error('Chưa chọn thành viên hoặc máy móc nào để phân công.');
  }
  return { created, skipped, warnings };
}

function insertAssignment(
  input: {
    planStepId: string; kind: string; farmerId?: string; machineId?: string;
    role: string; plannedDate: string; hours?: number; note?: string;
  },
  actor: AuditActor,
): Record<string, unknown> {
  const record = {
    id: uuid(),
    plan_step_id: input.planStepId,
    kind: input.kind,
    farmer_id: input.farmerId ?? null,
    machine_id: input.machineId ?? null,
    role: input.role,
    planned_date: input.plannedDate,
    hours: input.hours ?? null,
    note: input.note ?? null,
    status: 'da_giao',
    responded_at: null,
    decline_reason: null,
    assigned_by: actor.name ?? null,
    created_at: nowIso(),
  };
  insert('plan_step_assignments', record);
  logEvent({ module: 'htx', entityType: 'plan_step_assignments', entityId: record.id, action: 'create', after: record }, actor);
  return record;
}

/** Thành viên nhận việc, từ chối (kèm lý do), hoặc báo hoàn thành. */
export function respondToAssignment(
  assignmentId: string,
  input: { status: 'da_nhan' | 'tu_choi' | 'hoan_thanh'; reason?: string },
  actor: AuditActor = {},
): Record<string, unknown> {
  const before = one<Record<string, unknown>>('SELECT * FROM plan_step_assignments WHERE id = ?', [assignmentId]);
  if (!before) throw new Error('Không tìm thấy phân công.');
  if (before.status === 'huy') throw new Error('Phân công đã bị huỷ.');
  if (input.status === 'tu_choi' && !input.reason?.trim()) {
    // Từ chối im lặng khiến người phân công không biết phải điều ai khác.
    throw new Error('Từ chối một phân công phải nêu lý do để Ban quản trị bố trí người khác.');
  }

  update('plan_step_assignments', assignmentId, {
    status: input.status,
    responded_at: nowIso(),
    decline_reason: input.status === 'tu_choi' ? input.reason!.trim() : null,
  });
  const after = one<Record<string, unknown>>('SELECT * FROM plan_step_assignments WHERE id = ?', [assignmentId])!;
  logEvent({ module: 'htx', entityType: 'plan_step_assignments', entityId: assignmentId, action: 'update', before, after }, actor);
  return after;
}

export function cancelAssignment(assignmentId: string, actor: AuditActor = {}): void {
  const before = one<Record<string, unknown>>('SELECT * FROM plan_step_assignments WHERE id = ?', [assignmentId]);
  if (!before) throw new Error('Không tìm thấy phân công.');
  if (before.status === 'hoan_thanh') throw new Error('Phân công đã hoàn thành — không huỷ được.');
  run('DELETE FROM plan_step_assignments WHERE id = ?', [assignmentId]);
  logEvent({ module: 'htx', entityType: 'plan_step_assignments', entityId: assignmentId, action: 'delete', before }, actor);
}

/** Bảng việc của một thành viên: những gì đang được giao và hạn thực hiện. */
export function workloadForFarmer(farmerId: string): Record<string, unknown>[] {
  return all(
    `SELECT a.*, s.name AS step_name, s.activity, s.planned_date AS step_planned_date,
            p.code AS plot_code, cc.code AS crop_cycle_code
       FROM plan_step_assignments a
       JOIN production_plan_steps s ON s.id = a.plan_step_id
       JOIN production_plans pl ON pl.id = s.plan_id
       JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id
       JOIN plots p ON p.id = cc.plot_id
      WHERE a.farmer_id = ? AND a.status IN ('da_giao', 'da_nhan')
      ORDER BY a.planned_date`,
    [farmerId],
  );
}

/** Lịch điều phối máy móc của HTX — tránh chồng lịch giữa các thửa. */
export function machineSchedule(htxId: string, fromDate?: string, toDate?: string): Record<string, unknown>[] {
  const clauses = ['p.htx_id = ?', "a.kind = 'may_moc'", "a.status IN ('da_giao','da_nhan','hoan_thanh')"];
  const params: unknown[] = [htxId];
  if (fromDate) { clauses.push('a.planned_date >= ?'); params.push(fromDate); }
  if (toDate) { clauses.push('a.planned_date <= ?'); params.push(toDate); }

  return all(
    `SELECT a.id, a.planned_date, a.status, a.hours,
            m.code AS machine_code, mt.name AS machine_type_name, mt.stage,
            s.name AS step_name, s.activity, p.code AS plot_code, p.area_ha
       FROM plan_step_assignments a
       JOIN machines m ON m.id = a.machine_id
       LEFT JOIN machine_types mt ON mt.id = m.machine_type_id
       JOIN production_plan_steps s ON s.id = a.plan_step_id
       JOIN production_plans pl ON pl.id = s.plan_id
       JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id
       JOIN plots p ON p.id = cc.plot_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.planned_date, m.code`,
    params,
  );
}

/** Tổng hợp phân công của một HTX để hiển thị trên bảng điều hành. */
export function assignmentSummary(htxId: string): Record<string, unknown> {
  const rows = all<{ status: string; kind: string; n: number }>(
    `SELECT a.status, a.kind, COUNT(*) AS n
       FROM plan_step_assignments a
       JOIN production_plan_steps s ON s.id = a.plan_step_id
       JOIN production_plans pl ON pl.id = s.plan_id
       JOIN crop_cycles cc ON cc.id = pl.crop_cycle_id
       JOIN plots p ON p.id = cc.plot_id
      WHERE p.htx_id = ?
      GROUP BY a.status, a.kind`,
    [htxId],
  );
  const total = rows.reduce((acc, row) => acc + row.n, 0);
  const declined = rows.filter((row) => row.status === 'tu_choi').reduce((acc, row) => acc + row.n, 0);
  const pending = rows.filter((row) => row.status === 'da_giao').reduce((acc, row) => acc + row.n, 0);
  return {
    operatingModel: getOperatingModel(htxId),
    total,
    pending,
    declined,
    byKind: {
      nhan_cong: rows.filter((r) => r.kind === 'nhan_cong').reduce((acc, r) => acc + r.n, 0),
      may_moc: rows.filter((r) => r.kind === 'may_moc').reduce((acc, r) => acc + r.n, 0),
    },
    rows,
  };
}
