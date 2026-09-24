// Cổng CodeQL cho CI (repo chưa bật GitHub Advanced Security nên không dùng Code scanning):
// đọc SARIF do codeql-action ghi ra, in từng cảnh báo, và THẤT BẠI khi còn cảnh báo mức error chưa được rà soát.
//
// Cảnh báo ĐÃ RÀ SOÁT và chấp nhận có chủ đích (xem docs/SECURITY-FIXES-2026-09-24.md):
//   - js/clear-text-logging ở users.ts / seed.ts / reset-sadmin.ts: mật khẩu tạm in log MỘT lần, bắt đổi khi đăng nhập (C-01/C-02);
//   - js/insufficient-password-hash ở ids.ts: hàm SHA-256 cũ chỉ để xác thực dữ liệu di trú, mọi hash mới là scrypt.
// Thêm mục mới vào ACCEPTED chỉ sau khi đã ghi lý do vào tài liệu bảo mật.
import { readdirSync, readFileSync } from 'node:fs';

const dir = process.argv[2] ?? 'codeql-results';
const ACCEPTED = {
  'js/clear-text-logging': [/^src\/platform\/auth\/users\.ts$/, /^src\/seed\.ts$/, /^scripts\/reset-sadmin\.ts$/],
  'js/insufficient-password-hash': [/^src\/platform\/util\/ids\.ts$/],
};

let errors = 0;
let open = 0;
let accepted = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sarif'))) {
  const sarif = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  for (const run of sarif.runs ?? []) {
    const rules = new Map();
    for (const r of run.tool?.driver?.rules ?? []) rules.set(r.id, r);
    for (const ext of run.tool?.extensions ?? []) for (const r of ext.rules ?? []) rules.set(r.id, r);
    for (const res of run.results ?? []) {
      if (res.suppressions?.length) continue;
      const loc = res.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri ?? '';
      const severity = rules.get(res.ruleId)?.properties?.['problem.severity'] ?? res.level ?? 'warning';
      const isAccepted = (ACCEPTED[res.ruleId] ?? []).some((re) => re.test(uri));
      console.log(`${isAccepted ? 'ACCEPTED' : String(severity).toUpperCase()} ${res.ruleId} ${uri}:${loc?.region?.startLine ?? '?'} ${(res.message?.text ?? '').slice(0, 140)}`);
      if (isAccepted) { accepted += 1; continue; }
      open += 1;
      if (severity === 'error') errors += 1;
    }
  }
}
console.log(`CodeQL: ${open} cảnh báo cần xử lý (${errors} mức error), ${accepted} đã rà soát và chấp nhận.`);
if (errors) process.exit(1);
