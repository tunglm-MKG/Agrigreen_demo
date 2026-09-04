/**
 * Reporting & BI hợp nhất — dashboard vận hành, tài chính và MRV.
 *
 * Cũng cung cấp bộ kết xuất CSV/HTML dùng chung cho FN-16 (Simulation),
 * FN-29 (Warehouse) và FN-10 (Bản đồ CGH): "File xuất phải giữ đúng số liệu
 * đang hiển thị trên màn hình tại thời điểm xuất (không tính lại)."
 */
import { all, one } from '../../platform/db/db.ts';
import { nowIso } from '../../platform/util/ids.ts';
import { syncHealth } from '../../platform/sync/sync.ts';
import { mrvSummary } from '../warehouse/service.ts';
import { profitAndLoss, reconciliation } from '../finance/service.ts';

export function executiveDashboard(): Record<string, unknown> {
  const year = new Date().getUTCFullYear();
  return {
    generatedAt: nowIso(),
    supply: one(
      `SELECT COUNT(DISTINCT c.id) AS cooperatives,
              COALESCE(SUM(hs.paddy_tons), 0) AS paddy_tons,
              COALESCE(SUM(hs.planted_area_ha), 0) AS planted_area_ha
       FROM cooperatives c LEFT JOIN harvest_statistics hs ON hs.htx_id = c.id
       WHERE c.status = 'active'`,
    ),
    network: {
      facilities: all("SELECT kind, COUNT(*) AS n, COALESCE(SUM(capacity_tons),0) AS capacity, COALESCE(SUM(current_stock_tons),0) AS stock FROM facilities GROUP BY kind"),
      scenarios: one('SELECT COUNT(*) AS total, SUM(CASE WHEN status = \'chinh_thuc\' THEN 1 ELSE 0 END) AS official FROM scenarios'),
      candidateHubs: one('SELECT COUNT(*) AS total, SUM(CASE WHEN status = \'da_mo_phong\' THEN 1 ELSE 0 END) AS simulated FROM candidate_hubs'),
    },
    operations: {
      inboundTons: one("SELECT COALESCE(SUM(received_tons),0) AS tons FROM goods_receipts WHERE status = 'da_duyet'"),
      outboundTons: one("SELECT COALESCE(SUM(issued_tons),0) AS tons FROM goods_issues WHERE status = 'da_duyet'"),
      openAlerts: one('SELECT COUNT(*) AS n FROM env_alerts WHERE acknowledged_at IS NULL'),
      trips: all('SELECT status, COUNT(*) AS n FROM trips GROUP BY status'),
    },
    finance: profitAndLoss(`${year}-01-01`, `${year}-12-31`),
    mrv: mrvSummary(),
    integrations: syncHealth(),
  };
}

/** Bảng xếp hạng kịch bản theo TCO per Ton — phục vụ trình Ban lãnh đạo. */
export function scenarioLeaderboard(): Record<string, unknown>[] {
  const rows = all<{ scenario_id: string; payload_json: string; live_status: string }>(
    `SELECT sr.scenario_id, sr.payload_json, s.status AS live_status FROM simulation_results sr
     JOIN (SELECT scenario_id, MAX(computed_at) AS latest FROM simulation_results GROUP BY scenario_id) m
       ON m.scenario_id = sr.scenario_id AND m.latest = sr.computed_at
     JOIN scenarios s ON s.id = sr.scenario_id`,
  );
  return rows
    .map((row) => {
      const result = JSON.parse(row.payload_json);
      return {
        code: result.scenarioCode,
        name: result.scenarioName,
        // Trạng thái đọc trực tiếp từ bảng scenarios, không lấy từ snapshot kết
        // quả (kịch bản có thể được đánh dấu "Chính thức" sau lần mô phỏng cuối).
        status: row.live_status,
        hubCount: result.hubCount,
        deliveredTons: result.deliveredTons,
        costPerTon: result.costs.costPerTon,
        tcoPerTon: result.financial.tcoPerTon,
        roiPct: result.financial.roiPct,
        paybackYears: result.financial.paybackYears,
        plantDemandCoveragePct: result.plantDemandCoveragePct,
        parameterSetVersion: result.parameterSetVersion,
      };
    })
    .sort((a, b) => (a.tcoPerTon ?? Infinity) - (b.tcoPerTon ?? Infinity));
}

export function financeDashboard(from: string, to: string): Record<string, unknown> {
  return { pnl: profitAndLoss(from, to), reconciliation: reconciliation({ from, to }) };
}

// ---------------------------------------------------------------------------
// Kết xuất báo cáo
// ---------------------------------------------------------------------------

export function toCsv(rows: Record<string, unknown>[], columns?: { key: string; label: string }[]): string {
  if (!rows.length) return '';
  const cols = columns ?? Object.keys(rows[0]).map((key) => ({ key, label: key }));
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = cols.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) => cols.map((c) => escape(row[c.key])).join(',')).join('\n');
  // BOM để Excel đọc đúng tiếng Việt.
  return `﻿${header}\n${body}`;
}

/**
 * Kết xuất báo cáo dạng HTML in được (thay cho PDF, không cần thư viện ngoài —
 * người dùng dùng chức năng "In → Lưu thành PDF" của trình duyệt).
 *
 * Mọi giá trị "Thiếu baseline" / "Không xác định" được xuất NGUYÊN TRẠNG,
 * không thay bằng 0 hay ô trống (FN-16 AC-03).
 */
export function toPrintableReport(input: {
  title: string;
  subtitle?: string;
  provenance: Record<string, string | number | null>;
  sections: { heading: string; rows: Record<string, unknown>[]; columns?: { key: string; label: string }[] }[];
}): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '<em>Không xác định</em>';
    if (typeof value === 'number') return value.toLocaleString('vi-VN');
    if (typeof value === 'object') return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
    return escapeHtml(String(value));
  };
  const sections = input.sections
    .map((section) => {
      if (!section.rows.length) return `<h2>${escapeHtml(section.heading)}</h2><p><em>Không có dữ liệu</em></p>`;
      const cols = section.columns ?? Object.keys(section.rows[0]).map((key) => ({ key, label: key }));
      return `<h2>${escapeHtml(section.heading)}</h2>
<table><thead><tr>${cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
<tbody>${section.rows.map((row) => `<tr>${cols.map((c) => `<td>${cell(row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    })
    .join('\n');

  const provenance = Object.entries(input.provenance)
    .map(([key, value]) => `<li><strong>${escapeHtml(key)}:</strong> ${cell(value)}</li>`)
    .join('');

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<style>
  body{font-family:'Segoe UI',system-ui,sans-serif;margin:32px;color:#142722}
  h1{font-size:22px;margin-bottom:4px} h2{font-size:16px;margin-top:24px;border-bottom:1px solid #D7E0D2;padding-bottom:4px}
  .sub{color:#46584F;margin-top:0}
  table{border-collapse:collapse;width:100%;font-size:12px;margin-top:8px}
  th,td{border:1px solid #D7E0D2;padding:6px 8px;text-align:left}
  th{background:#E6ECE2}
  ul.provenance{background:#F4F7F2;border:1px solid #D7E0D2;padding:12px 12px 12px 28px;font-size:12px}
  @media print{body{margin:12mm}}
</style></head><body>
<h1>${escapeHtml(input.title)}</h1>
<p class="sub">${escapeHtml(input.subtitle ?? '')}</p>
<ul class="provenance">${provenance}</ul>
${sections}
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char]!);
}
