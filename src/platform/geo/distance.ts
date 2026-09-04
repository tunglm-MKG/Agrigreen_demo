/**
 * Dịch vụ tính khoảng cách theo phương thức vận chuyển.
 *
 * BRD Simulation FN-04:
 *  - BR-01: đường bộ tính bằng dịch vụ định tuyến trên mạng lưới đường bộ thực tế.
 *  - BR-02: đường thủy tính bằng shortest-path trên mạng lưới kênh rạch lưu
 *           thông được cho sà lan (dữ liệu chính thức hoặc tuyến tự số hóa đã
 *           được xác nhận — FN-20).
 *  - BR-03: nếu chưa có dữ liệu định tuyến → Haversine × hệ số hiệu chỉnh (#10).
 *  - BR-04: mỗi khoảng cách hiển thị KÈM NHÃN NGUỒN TÍNH.
 *  - BR-05: cache theo cặp toạ độ kèm ngày tính và nguồn tính.
 */
import { all, one, upsert } from '../db/db.ts';
import { digest, nowIso } from '../util/ids.ts';
import { haversineKm, type LatLng } from './geo.ts';
import { RoutingNetwork, type NetworkEdge } from './network.ts';
import { VESSEL_CLASSES, vesselByCode, type VesselClass } from './vessels.ts';

export type TransportMode = 'road' | 'waterway';

/** Nhãn nguồn tính — FN-04 BR-04 và FN-20 BR-05. */
export const DISTANCE_SOURCE = {
  ROUTED: 'routing_thuc_te',
  DIGITIZED: 'tuyen_so_hoa_noi_bo',
  ADJUSTED_HAVERSINE: 'haversine_hieu_chinh',
} as const;

export type DistanceSource = (typeof DISTANCE_SOURCE)[keyof typeof DISTANCE_SOURCE];

export const DISTANCE_SOURCE_LABEL: Record<DistanceSource, string> = {
  [DISTANCE_SOURCE.ROUTED]: 'Định tuyến thực tế',
  [DISTANCE_SOURCE.DIGITIZED]: 'Định tuyến trên tuyến số hóa nội bộ',
  [DISTANCE_SOURCE.ADJUSTED_HAVERSINE]: 'Haversine hiệu chỉnh',
};

export interface DistanceResult {
  distanceKm: number;
  mode: TransportMode;
  source: DistanceSource;
  sourceLabel: string;
  /** true khi cặp điểm KHÔNG tiếp giáp mạng lưới đường thủy (FN-08 BR-04b). */
  waterwayUnavailable?: boolean;
  computedAt: string;
}

export interface DistanceOptions {
  /** Hệ số hiệu chỉnh Haversine → thực tế theo phương thức (tham số #10). */
  correctionFactors: Record<TransportMode, number>;
  /** Bán kính tối đa để coi một điểm là tiếp giáp mạng lưới đường thủy (km). */
  waterwayAccessRadiusKm?: number;
  /** Tải trọng sà lan tối thiểu để lọc tuyến khả dụng (tấn). */
  minBargeLoadTons?: number;
  /** Bỏ qua cache — dùng khi Admin yêu cầu làm mới (BR-05). */
  refresh?: boolean;
}

interface RouteRow {
  id: string;
  mode: string;
  geometry: string;
  max_load_tons: number | null;
  derived_max_load_tons: number | null;
  code: string;
  status: string;
  data_source: string;
}

function loadNetwork(mode: TransportMode, minLoadTons: number): { network: RoutingNetwork; digitizedOnly: boolean } {
  // FN-20 BR-04 / AC-07: chỉ tuyến "Đã xác nhận" mới tham gia định tuyến.
  const rows = all<RouteRow>(
    `SELECT id, code, mode, geometry, max_load_tons, derived_max_load_tons, status, data_source
       FROM transport_routes WHERE mode = ? AND status = 'da_xac_nhan'`,
    [mode],
  );
  const edges: NetworkEdge[] = [];
  let hasOfficial = false;
  for (const row of rows) {
    if (row.data_source !== 'so_hoa_noi_bo') hasOfficial = true;
    const geometry = JSON.parse(row.geometry) as { type: string; coordinates: [number, number][] };
    const points: LatLng[] = geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    // Tải trọng SUY RA từ thông số kỹ thuật được ưu tiên hơn số nhập tay: nó là
    // kết quả đối chiếu rộng/sâu/tĩnh không với kích thước phương tiện, còn số
    // nhập tay chỉ là ghi chú của người số hoá.
    edges.push({
      routeId: row.id,
      routeCode: row.code,
      points,
      maxLoadTons: row.derived_max_load_tons ?? row.max_load_tons,
    });
  }
  return {
    network: new RoutingNetwork(edges, minLoadTons),
    digitizedOnly: rows.length > 0 && !hasOfficial,
  };
}

function cacheKey(from: LatLng, to: LatLng, mode: TransportMode): string {
  return digest([from.lat.toFixed(6), from.lng.toFixed(6), to.lat.toFixed(6), to.lng.toFixed(6), mode]);
}

export class DistanceService {
  private readonly networks = new Map<TransportMode, { network: RoutingNetwork; digitizedOnly: boolean }>();

  private readonly options: DistanceOptions;

  constructor(options: DistanceOptions) {
    this.options = options;
  }

  private network(mode: TransportMode) {
    let entry = this.networks.get(mode);
    if (!entry) {
      entry = loadNetwork(mode, mode === 'waterway' ? (this.options.minBargeLoadTons ?? 0) : 0);
      this.networks.set(mode, entry);
    }
    return entry;
  }

  /** Xoá cache mạng lưới trong bộ nhớ (gọi sau khi số hóa thêm tuyến). */
  invalidate(): void {
    this.networks.clear();
  }

  distance(from: LatLng, to: LatLng, mode: TransportMode): DistanceResult {
    const key = cacheKey(from, to, mode);
    if (!this.options.refresh) {
      const cached = one<{ distance_km: number; source: string; computed_at: string }>(
        'SELECT distance_km, source, computed_at FROM distance_cache WHERE id = ?',
        [key],
      );
      if (cached) {
        return {
          distanceKm: cached.distance_km,
          mode,
          source: cached.source as DistanceSource,
          sourceLabel: DISTANCE_SOURCE_LABEL[cached.source as DistanceSource] ?? cached.source,
          computedAt: cached.computed_at,
        };
      }
    }

    const computed = this.compute(from, to, mode);
    upsert('distance_cache', {
      id: key,
      from_lat: from.lat,
      from_lng: from.lng,
      to_lat: to.lat,
      to_lng: to.lng,
      mode,
      distance_km: computed.distanceKm,
      source: computed.source,
      computed_at: computed.computedAt,
    });
    return computed;
  }

  private compute(from: LatLng, to: LatLng, mode: TransportMode): DistanceResult {
    const { network, digitizedOnly } = this.network(mode);
    const straight = haversineKm(from, to);

    if (!network.isEmpty) {
      const routed = network.shortestPathKm(
        from,
        to,
        mode === 'waterway' ? (this.options.waterwayAccessRadiusKm ?? 5) : 25,
      );
      if (routed) {
        // Cộng thêm chặng tiếp cận từ điểm thực tế tới mạng lưới.
        const distanceKm = routed.distanceKm + routed.accessKm;
        const source = digitizedOnly ? DISTANCE_SOURCE.DIGITIZED : DISTANCE_SOURCE.ROUTED;
        return {
          distanceKm: round(distanceKm),
          mode,
          source,
          sourceLabel: DISTANCE_SOURCE_LABEL[source],
          computedAt: nowIso(),
        };
      }
      if (mode === 'waterway') {
        // Không tiếp giáp mạng lưới kênh rạch → chặng này không đủ điều kiện đi
        // đường thủy (FN-08 BR-04b). Vẫn trả về ước lượng nhưng gắn cờ rõ ràng.
        return {
          distanceKm: round(straight * this.factor(mode)),
          mode,
          source: DISTANCE_SOURCE.ADJUSTED_HAVERSINE,
          sourceLabel: DISTANCE_SOURCE_LABEL[DISTANCE_SOURCE.ADJUSTED_HAVERSINE],
          waterwayUnavailable: true,
          computedAt: nowIso(),
        };
      }
    }

    // BR-03: chưa có dữ liệu định tuyến → Haversine × hệ số hiệu chỉnh.
    return {
      distanceKm: round(straight * this.factor(mode)),
      mode,
      source: DISTANCE_SOURCE.ADJUSTED_HAVERSINE,
      sourceLabel: DISTANCE_SOURCE_LABEL[DISTANCE_SOURCE.ADJUSTED_HAVERSINE],
      waterwayUnavailable: mode === 'waterway',
      computedAt: nowIso(),
    };
  }

  /**
   * ĐƯỜNG ĐI TỐI ƯU giữa hai điểm, kèm hình học tuyến và các tuyến đi qua.
   *
   * Với đường thuỷ, `vesselCode` lọc bỏ những tuyến mà phương tiện đó không đi
   * lọt. Đây là điểm khác biệt so với "đường ngắn nhất" thuần tuý: con kênh ngắn
   * nhất có thể chỉ vừa ghe 100 tấn, còn sà lan 1.000 tấn phải đi vòng theo sông
   * lớn. Trả về đường ngắn nhất trong số những tuyến ĐI ĐƯỢC, không phải đường
   * ngắn nhất trên giấy.
   */
  optimalRoute(
    from: LatLng,
    to: LatLng,
    mode: TransportMode,
    vesselCode?: string,
  ): {
    found: boolean;
    distanceKm: number;
    accessKm: number;
    path: LatLng[];
    routeIds: string[];
    routeCodes: string[];
    source: DistanceSource;
    sourceLabel: string;
    vessel: VesselClass | null;
    reason: string | null;
  } {
    const vessel = mode === 'waterway' && vesselCode ? vesselByCode(vesselCode) : null;
    const minLoadTons = vessel?.tons ?? (mode === 'waterway' ? (this.options.minBargeLoadTons ?? 0) : 0);

    // Mạng lưới lọc theo tải trọng của chính phương tiện đang xét.
    const entry = loadNetwork(mode, minLoadTons);
    const straight = haversineKm(from, to);

    if (!entry.network.isEmpty) {
      const routed = entry.network.shortestPathKm(
        from, to, mode === 'waterway' ? (this.options.waterwayAccessRadiusKm ?? 5) : 25,
      );
      if (routed) {
        const source = entry.digitizedOnly ? DISTANCE_SOURCE.DIGITIZED : DISTANCE_SOURCE.ROUTED;
        return {
          found: true,
          distanceKm: round(routed.distanceKm + routed.accessKm),
          accessKm: round(routed.accessKm),
          path: routed.path,
          routeIds: routed.routeIds,
          routeCodes: routed.routeCodes,
          source,
          sourceLabel: DISTANCE_SOURCE_LABEL[source],
          vessel,
          reason: null,
        };
      }
    }

    return {
      found: false,
      distanceKm: round(straight * this.factor(mode)),
      accessKm: 0,
      path: [],
      routeIds: [],
      routeCodes: [],
      source: DISTANCE_SOURCE.ADJUSTED_HAVERSINE,
      sourceLabel: DISTANCE_SOURCE_LABEL[DISTANCE_SOURCE.ADJUSTED_HAVERSINE],
      vessel,
      reason: vessel
        ? `Không có tuyến ${mode === 'waterway' ? 'đường thuỷ' : 'đường bộ'} liên thông nào đủ điều kiện cho ${vessel.label}. ` +
          'Khoảng cách trả về là ước lượng Haversine hiệu chỉnh, không phải cự ly thực tế.'
        : 'Hai điểm không tiếp giáp mạng lưới đã số hoá — khoảng cách là ước lượng Haversine hiệu chỉnh.',
    };
  }

  /**
   * So sánh mọi lớp phương tiện trên cùng một chặng.
   *
   * Bảng này trả lời trực tiếp câu hỏi vận hành: đi ghe thì gần hơn bao nhiêu,
   * và sà lan lớn nhất còn đi được là loại nào.
   */
  routeOptions(from: LatLng, to: LatLng): {
    vesselCode: string;
    vesselLabel: string;
    tons: number;
    found: boolean;
    distanceKm: number;
    routeCodes: string[];
    reason: string | null;
  }[] {
    return VESSEL_CLASSES.map((vessel) => {
      const result = this.optimalRoute(from, to, 'waterway', vessel.code);
      return {
        vesselCode: vessel.code,
        vesselLabel: vessel.label,
        tons: vessel.tons,
        found: result.found,
        distanceKm: result.distanceKm,
        routeCodes: result.routeCodes,
        reason: result.reason,
      };
    });
  }

  /** Có tuyến đường thủy khả dụng giữa hai điểm hay không (FN-08 BR-04b). */
  hasWaterwayAccess(from: LatLng, to: LatLng): boolean {
    const { network } = this.network('waterway');
    if (network.isEmpty) return false;
    return network.shortestPathKm(from, to, this.options.waterwayAccessRadiusKm ?? 5) !== null;
  }

  private factor(mode: TransportMode): number {
    const value = this.options.correctionFactors[mode];
    return value && value >= 1 ? value : 1;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
