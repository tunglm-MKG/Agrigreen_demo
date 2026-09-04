/**
 * Mạng lưới định tuyến (đường bộ / đường thủy) và thuật toán đường đi ngắn nhất.
 *
 * BRD Simulation FN-04 BR-02: khoảng cách đường thủy được tính bằng thuật toán
 * tìm đường đi ngắn nhất (Dijkstra) trên mạng lưới kênh rạch lưu thông được cho
 * sà lan — mạng lưới này có thể là dữ liệu chính thức hoặc các tuyến do người
 * dùng tự số hóa và đã được xác nhận (FN-20 BR-04).
 */
import { geodesicMeters, haversineKm, type LatLng } from './geo.ts';

export interface NetworkEdge {
  /** Mã tuyến nguồn (waterway/road segment). */
  routeId: string;
  routeCode?: string;
  points: LatLng[];
  /** Tải trọng tối đa lưu thông được (tấn) — FN-08 GIS / FN-20 thuộc tính tuyến. */
  maxLoadTons?: number | null;
}

interface GraphNode {
  key: string;
  point: LatLng;
}

/** Một cạnh trong đồ thị, mang theo tuyến nguồn để truy vết đường đi. */
interface GraphLink {
  to: string;
  meters: number;
  routeId: string;
  routeCode?: string;
}

/** Làm tròn toạ độ để nối các đỉnh trùng nhau giữa các tuyến (~11 m ở xích đạo). */
const SNAP_DECIMALS = 4;

function nodeKey(point: LatLng): string {
  return `${point.lat.toFixed(SNAP_DECIMALS)},${point.lng.toFixed(SNAP_DECIMALS)}`;
}

export class RoutingNetwork {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly adjacency = new Map<string, GraphLink[]>();

  constructor(edges: NetworkEdge[] = [], minLoadTons = 0) {
    for (const edge of edges) {
      if (minLoadTons > 0 && (edge.maxLoadTons ?? 0) < minLoadTons) continue;
      this.addEdge(edge);
    }
  }

  get isEmpty(): boolean {
    return this.nodes.size === 0;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  private addEdge(edge: NetworkEdge): void {
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1];
      const b = edge.points[i];
      const ka = nodeKey(a);
      const kb = nodeKey(b);
      if (ka === kb) continue;
      if (!this.nodes.has(ka)) this.nodes.set(ka, { key: ka, point: a });
      if (!this.nodes.has(kb)) this.nodes.set(kb, { key: kb, point: b });
      const meters = geodesicMeters(a, b);
      this.link(ka, kb, meters, edge);
      this.link(kb, ka, meters, edge);
    }
  }

  private link(from: string, to: string, meters: number, edge: NetworkEdge): void {
    const link: GraphLink = { to, meters, routeId: edge.routeId, routeCode: edge.routeCode };
    const list = this.adjacency.get(from);
    if (list) list.push(link);
    else this.adjacency.set(from, [link]);
  }

  /** Tìm đỉnh mạng lưới gần nhất với một điểm bất kỳ. */
  nearestNode(point: LatLng): { key: string; point: LatLng; distanceKm: number } | null {
    let best: { key: string; point: LatLng; distanceKm: number } | null = null;
    for (const node of this.nodes.values()) {
      const distanceKm = haversineKm(point, node.point);
      if (!best || distanceKm < best.distanceKm) {
        best = { key: node.key, point: node.point, distanceKm };
      }
    }
    return best;
  }

  /**
   * Đường đi ngắn nhất giữa hai điểm bất kỳ.
   *
   * `accessRadiusKm` là bán kính tối đa chấp nhận được để coi một điểm là "tiếp
   * giáp mạng lưới" (FN-08 BR-04b). Nếu điểm đầu hoặc điểm cuối nằm xa hơn bán
   * kính này, tuyến được coi là không khả dụng và hàm trả về null.
   */
  shortestPathKm(
    from: LatLng,
    to: LatLng,
    accessRadiusKm = 5,
  ): {
    distanceKm: number;
    accessKm: number;
    path: LatLng[];
    /** Các tuyến mà đường đi tối ưu chạy qua, theo thứ tự. */
    routeIds: string[];
    routeCodes: string[];
  } | null {
    const start = this.nearestNode(from);
    const end = this.nearestNode(to);
    if (!start || !end) return null;
    if (start.distanceKm > accessRadiusKm || end.distanceKm > accessRadiusKm) return null;

    const distances = new Map<string, number>([[start.key, 0]]);
    const previous = new Map<string, string>();
    // Ghi lại tuyến nguồn của cạnh dẫn tới mỗi đỉnh, để dựng danh sách tuyến đi qua.
    const viaRoute = new Map<string, { id: string; code?: string }>();
    const visited = new Set<string>();
    // Hàng đợi ưu tiên đơn giản: đủ nhanh cho quy mô mạng lưới kênh rạch ĐBSCL.
    const queue: { key: string; cost: number }[] = [{ key: start.key, cost: 0 }];

    while (queue.length) {
      queue.sort((a, b) => a.cost - b.cost);
      const current = queue.shift()!;
      if (visited.has(current.key)) continue;
      visited.add(current.key);
      if (current.key === end.key) break;

      for (const neighbour of this.adjacency.get(current.key) ?? []) {
        if (visited.has(neighbour.to)) continue;
        const candidate = current.cost + neighbour.meters;
        if (candidate < (distances.get(neighbour.to) ?? Infinity)) {
          distances.set(neighbour.to, candidate);
          previous.set(neighbour.to, current.key);
          viaRoute.set(neighbour.to, { id: neighbour.routeId, code: neighbour.routeCode });
          queue.push({ key: neighbour.to, cost: candidate });
        }
      }
    }

    const total = distances.get(end.key);
    if (total === undefined) return null;

    const path: LatLng[] = [];
    const routeIds: string[] = [];
    const routeCodes: string[] = [];
    let cursor: string | undefined = end.key;
    while (cursor) {
      const node = this.nodes.get(cursor);
      if (node) path.unshift(node.point);
      const via = viaRoute.get(cursor);
      if (via && routeIds[0] !== via.id) {
        routeIds.unshift(via.id);
        if (via.code) routeCodes.unshift(via.code);
      }
      cursor = previous.get(cursor);
    }

    return {
      distanceKm: total / 1000,
      accessKm: start.distanceKm + end.distanceKm,
      path,
      routeIds,
      routeCodes,
    };
  }
}
