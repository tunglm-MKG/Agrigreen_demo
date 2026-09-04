/**
 * KHỞI TẠO HỒ SƠ HTX THEO MÃ SỐ THUẾ VÀ KÍCH HOẠT TÀI KHOẢN.
 *
 * Bài toán thực tế: cán bộ Khuyến nông đi địa bàn trước, lập hồ sơ HTX, vẽ thửa
 * ruộng, ghi nhận thành viên — tất cả nằm sẵn trên CSDL dùng chung. Sau đó HTX
 * mới đăng ký tài khoản. Nếu không có cầu nối, HTX sẽ tạo hồ sơ thứ hai và toàn
 * bộ công sức khảo sát thành dữ liệu mồ côi.
 *
 * Cầu nối là MÃ SỐ THUẾ — định danh pháp lý duy nhất của HTX. Khuyến nông tạo hồ
 * sơ kèm MST; HTX kích hoạt tài khoản bằng chính MST đó và thừa hưởng nguyên vẹn
 * dữ liệu đã có.
 *
 * Các chốt chặn:
 *   MST-01  Mã số thuế Việt Nam gồm 10 hoặc 13 chữ số (13 chữ số là mã đơn vị
 *           phụ thuộc, dạng 10 số + 3 số). Sai định dạng thì từ chối ngay.
 *   MST-02  Một MST chỉ gắn với MỘT hồ sơ HTX.
 *   MST-03  Hồ sơ đã được kích hoạt thì không ai kích hoạt lại được.
 *   MST-04  Kích hoạt là hành động có hệ quả: bàn giao toàn bộ thửa ruộng, thành
 *           viên, vụ canh tác cho tài khoản HTX. Hàm trả về đúng những gì được
 *           bàn giao để màn hình xác nhận hiển thị trước khi người dùng đồng ý.
 */
import { all, one, update } from '../platform/db/db.ts';
import { nowIso } from '../platform/util/ids.ts';
import { logEvent, type AuditActor } from '../platform/audit/audit.ts';
import { createCooperative } from './service.ts';

/** MST-01 — chuẩn hoá và kiểm tra định dạng mã số thuế. */
export function normalizeTaxCode(raw: string): string {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length !== 10 && digits.length !== 13) {
    throw new Error(
      `Mã số thuế "${raw}" không hợp lệ — mã số thuế Việt Nam gồm 10 chữ số ` +
      '(hoặc 13 chữ số với đơn vị phụ thuộc).',
    );
  }
  return digits.length === 13 ? `${digits.slice(0, 10)}-${digits.slice(10)}` : digits;
}

export function findByTaxCode(taxCode: string): Record<string, unknown> | null {
  return one('SELECT * FROM cooperatives WHERE tax_code = ?', [normalizeTaxCode(taxCode)]);
}

export interface RegisterInput {
  taxCode: string;
  name: string;
  provinceId?: string | null;
  communeId?: string | null;
  address?: string;
  contactName?: string;
  contactPhone?: string;
  lat?: number;
  lng?: number;
  memberCount?: number;
  registeredAreaHa?: number;
  operatingModel?: string;
}

/**
 * Cán bộ Khuyến nông khởi tạo hồ sơ HTX trên địa bàn.
 *
 * Hồ sơ ở trạng thái CHƯA KÍCH HOẠT: dữ liệu đã nằm trên CSDL dùng chung và mọi
 * phân hệ đọc được ngay, nhưng chưa có tài khoản HTX nào sở hữu nó.
 */
export function registerByExtension(input: RegisterInput, actor: AuditActor = {}): Record<string, unknown> {
  const taxCode = normalizeTaxCode(input.taxCode);
  // MST-02
  const existing = findByTaxCode(taxCode);
  if (existing) {
    throw new Error(
      `Mã số thuế ${taxCode} đã gắn với hồ sơ "${existing.name}" (${existing.code}). ` +
      'Mỗi mã số thuế chỉ có một hồ sơ HTX — hãy bổ sung vào hồ sơ đã có.',
    );
  }
  if (!input.name?.trim()) throw new Error('Hồ sơ HTX phải có tên.');

  const created = createCooperative({
    name: input.name.trim(),
    provinceId: input.provinceId ?? undefined,
    communeId: input.communeId ?? undefined,
    address: input.address,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    lat: input.lat,
    lng: input.lng,
    memberCount: input.memberCount,
    registeredAreaHa: input.registeredAreaHa,
  } as never, actor) as Record<string, unknown>;

  update('cooperatives', created.id as string, {
    tax_code: taxCode,
    origin: 'khuyennong',
    operating_model: input.operatingModel ?? 'tap_trung',
    updated_at: nowIso(),
  });

  const record = one<Record<string, unknown>>('SELECT * FROM cooperatives WHERE id = ?', [created.id])!;
  logEvent({
    module: 'mdm', entityType: 'cooperatives', entityId: created.id as string,
    action: 'register', after: { taxCode, origin: 'khuyennong' },
  }, actor);
  return record;
}

export interface ClaimPreview {
  cooperative: Record<string, unknown>;
  alreadyClaimed: boolean;
  inherits: {
    plots: number;
    plotAreaHa: number;
    farmers: number;
    cropCycles: number;
    harvestStatistics: number;
    machines: number;
    surveyResponses: number;
  };
}

/**
 * Xem trước những gì tài khoản HTX sẽ thừa hưởng khi kích hoạt bằng MST.
 *
 * Hiển thị con số cụ thể trước khi bấm nút, thay vì để người dùng kích hoạt rồi
 * mới biết mình vừa nhận (hoặc không nhận được) gì.
 */
export function previewClaim(taxCode: string): ClaimPreview {
  const cooperative = findByTaxCode(taxCode);
  if (!cooperative) {
    throw new Error(
      `Chưa có hồ sơ nào gắn với mã số thuế ${normalizeTaxCode(taxCode)}. ` +
      'Nếu HTX chưa được cán bộ Khuyến nông khảo sát, hãy tạo hồ sơ mới thay vì kích hoạt.',
    );
  }
  const htxId = cooperative.id as string;
  const count = (sql: string) => Number(one<{ n: number }>(sql, [htxId])?.n ?? 0);

  return {
    cooperative,
    alreadyClaimed: Boolean(cooperative.claimed_at),
    inherits: {
      plots: count('SELECT COUNT(*) AS n FROM plots WHERE htx_id = ?'),
      plotAreaHa: Math.round(
        Number(one<{ s: number }>('SELECT IFNULL(SUM(area_ha),0) AS s FROM plots WHERE htx_id = ?', [htxId])?.s ?? 0) * 100,
      ) / 100,
      farmers: count('SELECT COUNT(*) AS n FROM farmers WHERE htx_id = ?'),
      cropCycles: count(
        'SELECT COUNT(*) AS n FROM crop_cycles cc JOIN plots p ON p.id = cc.plot_id WHERE p.htx_id = ?',
      ),
      harvestStatistics: count('SELECT COUNT(*) AS n FROM harvest_statistics WHERE htx_id = ?'),
      machines: count('SELECT COUNT(*) AS n FROM machines WHERE htx_id = ?'),
      surveyResponses: count('SELECT COUNT(*) AS n FROM survey_responses WHERE htx_id = ?'),
    },
  };
}

/**
 * HTX kích hoạt tài khoản bằng mã số thuế và nhận toàn bộ dữ liệu đã có.
 *
 * Không có bước "sao chép dữ liệu" nào ở đây — dữ liệu vốn đã nằm trên CSDL dùng
 * chung và tham chiếu tới đúng `htx_id` này. Kích hoạt chỉ là xác lập quyền sở
 * hữu: đánh dấu hồ sơ đã được nhận và gắn tài khoản vào HTX. Đó chính là điều
 * làm cho "dữ liệu dùng chung" có ý nghĩa thực tế.
 */
export function claimByTaxCode(
  input: { taxCode: string; userId?: string; operatingModel?: string },
  actor: AuditActor = {},
): ClaimPreview & { claimedAt: string } {
  const preview = previewClaim(input.taxCode);
  // MST-03
  if (preview.alreadyClaimed) {
    throw new Error(
      `Hồ sơ "${preview.cooperative.name}" đã được kích hoạt ngày ` +
      `${String(preview.cooperative.claimed_at).slice(0, 10)}. ` +
      'Nếu đây là nhầm lẫn, liên hệ quản trị nền tảng để xử lý.',
    );
  }

  const htxId = preview.cooperative.id as string;
  const claimedAt = nowIso();
  const values: Record<string, unknown> = {
    claimed_at: claimedAt,
    claimed_by: input.userId ?? actor.id ?? actor.name ?? null,
    updated_at: claimedAt,
  };
  if (input.operatingModel) values.operating_model = input.operatingModel;
  update('cooperatives', htxId, values);

  // Gắn tài khoản đang đăng nhập vào HTX vừa nhận, nếu có.
  if (input.userId) {
    const user = one<{ id: string }>('SELECT id FROM users WHERE id = ?', [input.userId]);
    if (user) update('users', input.userId, { htx_id: htxId });
  }

  logEvent({
    module: 'mdm', entityType: 'cooperatives', entityId: htxId,
    action: 'claim', after: { taxCode: normalizeTaxCode(input.taxCode), inherits: preview.inherits },
  }, actor);

  return { ...previewClaim(input.taxCode), claimedAt };
}

/** Hồ sơ do Khuyến nông lập nhưng HTX chưa kích hoạt — danh sách cần đôn đốc. */
export function pendingClaims(): Record<string, unknown>[] {
  return all(
    `SELECT c.id, c.code, c.name, c.tax_code, c.contact_name, c.contact_phone,
            c.created_at, au.name AS commune_name,
            (SELECT COUNT(*) FROM plots p WHERE p.htx_id = c.id) AS plot_count,
            (SELECT COUNT(*) FROM farmers f WHERE f.htx_id = c.id) AS farmer_count
       FROM cooperatives c
       LEFT JOIN admin_units au ON au.id = c.commune_id
      WHERE c.origin = 'khuyennong' AND c.claimed_at IS NULL AND c.tax_code IS NOT NULL
      ORDER BY c.created_at DESC`,
  );
}

/** Gán / sửa mã số thuế cho một hồ sơ HTX đã có. */
export function setTaxCode(htxId: string, taxCode: string, actor: AuditActor = {}): Record<string, unknown> {
  const normalized = normalizeTaxCode(taxCode);
  const before = one<Record<string, unknown>>('SELECT * FROM cooperatives WHERE id = ?', [htxId]);
  if (!before) throw new Error('Không tìm thấy hợp tác xã.');

  const clash = one<{ id: string; name: string; code: string }>(
    'SELECT id, name, code FROM cooperatives WHERE tax_code = ? AND id <> ?',
    [normalized, htxId],
  );
  if (clash) {
    throw new Error(`Mã số thuế ${normalized} đã gắn với "${clash.name}" (${clash.code}).`);
  }
  if (before.claimed_at && before.tax_code && before.tax_code !== normalized) {
    throw new Error(
      'Hồ sơ đã kích hoạt bằng mã số thuế hiện tại — đổi mã số thuế sẽ làm mất liên kết ' +
      'với tài khoản đang sở hữu. Liên hệ quản trị nền tảng.',
    );
  }

  update('cooperatives', htxId, { tax_code: normalized, updated_at: nowIso() });
  const after = one<Record<string, unknown>>('SELECT * FROM cooperatives WHERE id = ?', [htxId])!;
  logEvent({ module: 'mdm', entityType: 'cooperatives', entityId: htxId, action: 'update', before, after }, actor);
  return after;
}
