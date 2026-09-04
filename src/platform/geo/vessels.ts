/**
 * PHƯƠNG TIỆN THUỶ VÀ ĐIỀU KIỆN LƯU THÔNG TRÊN TUYẾN
 *
 * Câu hỏi nghiệp vụ: "tuyến kênh này cho ghe hay sà lan bao nhiêu tấn đi được?"
 * Trả lời được câu đó cần bốn thông số của tuyến và ba kích thước của phương tiện:
 *
 *   Tuyến kênh                       Phương tiện
 *   ─────────────────────            ─────────────────────
 *   Chiều rộng lòng kênh    ↔        Chiều rộng thân (beam)
 *   Độ sâu luồng            ↔        Mớn nước (draft)
 *   Tĩnh không cầu          ↔        Chiều cao tĩnh không (air draft)
 *
 * Ba biên an toàn được cộng thêm, vì con số vừa khít trên giấy là không đi được
 * ngoài thực địa:
 *
 *   - Bề rộng: kênh phải rộng hơn thân tàu một hệ số để còn chỗ tránh nhau và
 *     chịu ảnh hưởng dòng chảy. Kênh rộng đúng bằng thân sà lan là kênh chỉ đi
 *     được một chiều và không có sai số lái.
 *   - Độ sâu: cần khoảng nước dưới đáy (under-keel clearance). Sà lan chạm đáy
 *     ở luồng cạn là mắc cạn, không phải "đi chậm hơn".
 *   - Tĩnh không: cần dự trữ cho triều cường và hàng xếp trên boong.
 *
 * Độ sâu khai báo hiểu là ĐỘ SÂU KHỐNG CHẾ MÙA KHÔ (điểm cạn nhất trên tuyến ở
 * thời điểm bất lợi nhất). Khai theo mực nước mùa lũ sẽ cho ra kết luận sai vào
 * đúng lúc cần vận chuyển rơm nhất — vụ Đông Xuân thu hoạch giữa mùa khô.
 */

export interface VesselClass {
  code: string;
  label: string;
  /** Tải trọng đăng ký (tấn). */
  tons: number;
  /** Chiều rộng thân (m). */
  beamM: number;
  /** Mớn nước khi đầy tải (m). */
  draftM: number;
  /** Chiều cao tĩnh không tính từ mặt nước (m). */
  airDraftM: number;
  note?: string;
}

/**
 * Các lớp phương tiện dùng trong chuỗi cung ứng rơm.
 *
 * Kích thước lấy theo phương tiện thuỷ nội địa phổ biến ở ĐBSCL. Đây là GIẢ ĐỊNH
 * kỹ thuật, chỉnh được khi có thông số đăng kiểm thực tế của đội phương tiện.
 */
export const VESSEL_CLASSES: VesselClass[] = [
  {
    code: 'ghe_100t', label: 'Ghe 100 tấn', tons: 100,
    beamM: 5.5, draftM: 1.4, airDraftM: 3.5,
    note: 'Phương tiện chủ lực chặng Ruộng → Nhà máy và Ruộng → Hub trong mùa thu hoạch.',
  },
  {
    code: 'sa_lan_1000t', label: 'Sà lan 1.000 tấn', tons: 1_000,
    beamM: 10, draftM: 2.5, airDraftM: 6,
    note: 'Chặng Hub → Nhà máy ngoài mùa thu hoạch.',
  },
  {
    code: 'sa_lan_2000t', label: 'Sà lan 2.000 tấn', tons: 2_000,
    beamM: 12, draftM: 3.2, airDraftM: 7,
  },
];

/** Biên an toàn — tách riêng để chỉnh được mà không phải sửa logic. */
export const SAFETY_MARGINS = {
  /** Kênh phải rộng tối thiểu beam × hệ số này. */
  widthFactor: 1.5,
  /** Khoảng nước dưới đáy tàu (m). */
  underKeelM: 0.4,
  /** Dự trữ tĩnh không dưới gầm cầu (m). */
  airGapM: 0.5,
};

export interface WaterwayConstraints {
  /** Chiều rộng lòng kênh hẹp nhất trên đoạn (m). */
  widthM?: number | null;
  /** Độ sâu khống chế mùa khô (m). */
  depthM?: number | null;
  /** Tĩnh không thấp nhất của công trình vượt sông trên đoạn (m). */
  clearanceM?: number | null;
}

export interface PassCheck {
  passes: boolean;
  /** Lý do không qua được — rỗng khi qua được. */
  blockers: string[];
  /** Thông số nào chưa khai báo (không kết luận được, khác với không qua được). */
  unknown: string[];
}

/**
 * Một phương tiện có đi qua đoạn tuyến này được không.
 *
 * Phân biệt rõ ba trạng thái: QUA ĐƯỢC, KHÔNG QUA ĐƯỢC, và CHƯA KẾT LUẬN ĐƯỢC vì
 * thiếu số liệu. Gộp "thiếu số liệu" vào "qua được" sẽ điều một sà lan 2.000 tấn
 * vào con kênh chưa ai đo độ sâu.
 */
export function canPass(vessel: VesselClass, constraints: WaterwayConstraints): PassCheck {
  const blockers: string[] = [];
  const unknown: string[] = [];

  const requiredWidth = vessel.beamM * SAFETY_MARGINS.widthFactor;
  if (constraints.widthM === null || constraints.widthM === undefined) {
    unknown.push('chiều rộng lòng kênh');
  } else if (constraints.widthM < requiredWidth) {
    blockers.push(
      `rộng ${constraints.widthM} m < ${requiredWidth.toFixed(1)} m cần cho thân tàu ${vessel.beamM} m`,
    );
  }

  const requiredDepth = vessel.draftM + SAFETY_MARGINS.underKeelM;
  if (constraints.depthM === null || constraints.depthM === undefined) {
    unknown.push('độ sâu luồng');
  } else if (constraints.depthM < requiredDepth) {
    blockers.push(
      `sâu ${constraints.depthM} m < ${requiredDepth.toFixed(1)} m cần cho mớn nước ${vessel.draftM} m`,
    );
  }

  const requiredClearance = vessel.airDraftM + SAFETY_MARGINS.airGapM;
  // Không có cầu trên đoạn thì không có ràng buộc tĩnh không — đây là trường hợp
  // "không có công trình", khác hẳn "có cầu nhưng chưa đo tĩnh không".
  if (constraints.clearanceM !== null && constraints.clearanceM !== undefined) {
    if (constraints.clearanceM < requiredClearance) {
      blockers.push(
        `tĩnh không cầu ${constraints.clearanceM} m < ${requiredClearance.toFixed(1)} m cần cho chiều cao ${vessel.airDraftM} m`,
      );
    }
  }

  return { passes: blockers.length === 0 && unknown.length === 0, blockers, unknown };
}

export interface VesselVerdict {
  /** Lớp phương tiện lớn nhất đi được; null nếu không lớp nào qua được. */
  vessel: VesselClass | null;
  maxLoadTons: number;
  /** Kết luận có chắc chắn không, hay đang thiếu số liệu. */
  certainty: 'du_lieu_day_du' | 'thieu_du_lieu';
  reasons: string[];
  perVessel: { code: string; label: string; tons: number; passes: boolean; blockers: string[]; unknown: string[] }[];
}

/**
 * Tải trọng tối đa lưu thông được trên một đoạn tuyến.
 *
 * Trả về lớp phương tiện LỚN NHẤT còn đi qua được. Thiếu số liệu thì `certainty`
 * là `thieu_du_lieu` và `maxLoadTons` bằng 0 — hệ thống không đoán.
 */
export function maxVessel(constraints: WaterwayConstraints): VesselVerdict {
  const perVessel = VESSEL_CLASSES.map((vessel) => {
    const check = canPass(vessel, constraints);
    return {
      code: vessel.code, label: vessel.label, tons: vessel.tons,
      passes: check.passes, blockers: check.blockers, unknown: check.unknown,
    };
  });

  const passing = VESSEL_CLASSES.filter((vessel, index) => perVessel[index].passes);
  const largest = passing.length ? passing[passing.length - 1] : null;
  const anyUnknown = perVessel.some((row) => row.unknown.length > 0);

  const reasons: string[] = [];
  if (anyUnknown) {
    const missing = [...new Set(perVessel.flatMap((row) => row.unknown))];
    reasons.push(`Chưa khai báo: ${missing.join(', ')} — không kết luận được tải trọng lưu thông.`);
  }
  if (!largest && !anyUnknown) {
    const smallest = perVessel[0];
    reasons.push(`Ngay cả ${smallest.label} cũng không qua được: ${smallest.blockers.join('; ')}.`);
  }

  return {
    vessel: largest,
    maxLoadTons: largest?.tons ?? 0,
    certainty: anyUnknown ? 'thieu_du_lieu' : 'du_lieu_day_du',
    reasons,
    perVessel,
  };
}

export function vesselByCode(code: string): VesselClass | null {
  return VESSEL_CLASSES.find((vessel) => vessel.code === code) ?? null;
}

/** Lớp phương tiện nhỏ nhất chở được khối lượng yêu cầu. */
export function vesselForTons(tons: number): VesselClass | null {
  return VESSEL_CLASSES.find((vessel) => vessel.tons >= tons) ?? null;
}
