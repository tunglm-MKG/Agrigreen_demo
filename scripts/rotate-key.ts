/**
 * Xoay khoá mã hoá cột (đánh giá bảo mật 24/09/2026, M-05).
 *
 * Cách dùng (dừng máy chủ trước):
 *   DATA_ENCRYPTION_KEY=<khoá mới> DATA_ENCRYPTION_KEY_ID=k2 \
 *   DATA_ENCRYPTION_KEYS_PREVIOUS="k1:<khoá cũ>" node scripts/rotate-key.ts
 *
 * Mọi giá trị đang mã hoá bằng khoá cũ (CCCD nông hộ/phiếu khảo sát, token kênh gửi) được giải mã
 * bằng khoá cũ và mã hoá lại bằng khoá hiện hành. Sau khi chạy xong và khởi động lại thành công,
 * có thể bỏ DATA_ENCRYPTION_KEYS_PREVIOUS.
 */
import { migrate } from '../src/platform/db/schema.ts';
import { encryptionKeyStatus, rotateEncryptedFields } from '../src/platform/security/fieldCrypto.ts';
import { rotateChannelSecrets } from '../src/platform/notify/service.ts';

migrate();
const status = encryptionKeyStatus();
console.log(`Khoá hiện hành: ${status.kid} (${status.source}); khoá cũ đọc được: ${status.previousKids.join(', ') || 'không'}`);
const fields = rotateEncryptedFields();
const secrets = rotateChannelSecrets();
console.log(`Đã mã hoá lại ${fields} giá trị cột PII và ${secrets} bí mật kênh gửi bằng khoá ${status.kid}.`);
