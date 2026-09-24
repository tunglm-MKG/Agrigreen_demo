/**
 * Kiểm thử cổng mã truy cập cho bản trình diễn công khai.
 *
 * Điểm cần bảo vệ: cổng phải chặn CẢ API chứ không chỉ giao diện. Một cổng chỉ
 * che màn hình đăng nhập mà để `/api/...` mở là không chặn được gì — dữ liệu
 * vẫn lấy ra bằng một lệnh curl.
 */
process.env.SUPER_ADMIN_PASSWORD ??= 'KiemThu-SAdmin-2026';
process.env.DEMO_ACCOUNT_PASSWORD ??= '123456';
process.env.DATA_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const gate = await import('../src/platform/http/accessGate.ts');

/** Yêu cầu HTTP giả lập, đủ dùng cho lớp cổng. */
function request(options: { cookie?: string; method?: string; ip?: string } = {}): IncomingMessage {
  return {
    method: options.method ?? 'GET',
    headers: {
      cookie: options.cookie,
      'x-forwarded-for': options.ip,
    },
    socket: { remoteAddress: options.ip ?? '127.0.0.1' },
    on: () => undefined,
  } as unknown as IncomingMessage;
}

function response(): ServerResponse & { statusCode2: number | null; body: string } {
  const captured = {
    statusCode2: null as number | null,
    body: '',
    writeHead(status: number) { captured.statusCode2 = status; return captured; },
    end(chunk?: string) { if (chunk) captured.body = chunk; return captured; },
  };
  return captured as unknown as ServerResponse & { statusCode2: number | null; body: string };
}

function withCode<T>(code: string | undefined, fn: () => T): T {
  const previous = process.env.DEMO_ACCESS_CODE;
  if (code === undefined) delete process.env.DEMO_ACCESS_CODE;
  else process.env.DEMO_ACCESS_CODE = code;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DEMO_ACCESS_CODE;
    else process.env.DEMO_ACCESS_CODE = previous;
  }
}

/** Cùng công thức dấu vân mà module dùng để đặt cookie. */
function fingerprint(code: string): string {
  return createHash('sha256').update(`mekong-green:${code}`).digest('hex').slice(0, 32);
}

test('Không đặt DEMO_ACCESS_CODE thì cổng TẮT hoàn toàn', () => {
  withCode(undefined, () => {
    assert.equal(gate.gateEnabled(), false);
    assert.equal(gate.hasAccess(request()), true, 'chạy trên máy không phải nhập gì thêm');
    assert.equal(gate.handleGate(request(), response(), '/'), false, 'cổng không can thiệp');
  });
  // Chuỗi rỗng cũng coi như không đặt — tránh bật cổng với mã rỗng.
  withCode('   ', () => assert.equal(gate.gateEnabled(), false));
});

test('Bật cổng thì chặn CẢ giao diện lẫn API', () => {
  withCode('mekong2026', () => {
    for (const path of ['/', '/kn/', '/app.js', '/api/mdm/cooperatives', '/api/auth/me']) {
      const res = response();
      assert.equal(gate.handleGate(request(), res, path), true, `${path} phải bị chặn`);
      assert.equal(res.statusCode2, 401, `${path} phải trả 401`);
    }
  });
});

test('Trang kiểm tra sức khoẻ luôn mở', () => {
  withCode('mekong2026', () => {
    // Chặn /health sẽ khiến nền tảng triển khai coi dịch vụ là hỏng và khởi
    // động lại liên tục.
    assert.equal(gate.handleGate(request(), response(), '/health'), false);
  });
});

test('Cookie đúng dấu vân thì đi qua; cookie giả mạo thì không', () => {
  withCode('mekong2026', () => {
    const valid = `mg_access=${fingerprint('mekong2026')}`;
    assert.equal(gate.hasAccess(request({ cookie: valid })), true);

    for (const forged of ['mg_access=deadbeef', 'mg_access=', 'mg_access=mekong2026']) {
      assert.equal(gate.hasAccess(request({ cookie: forged })), false, `${forged} không được qua`);
    }
  });
});

test('Cookie KHÔNG chứa mã gốc — người xem cookie không suy ngược ra mã', () => {
  withCode('mekong2026', () => {
    const cookieValue = fingerprint('mekong2026');
    assert.ok(!cookieValue.includes('mekong2026'));
    assert.equal(cookieValue.length, 32);
    // Đổi mã thì dấu vân đổi theo, cookie cũ mất hiệu lực.
    assert.notEqual(fingerprint('mekong2026'), fingerprint('mekong2027'));
  });

  withCode('mekong2027', () => {
    const oldCookie = `mg_access=${fingerprint('mekong2026')}`;
    assert.equal(gate.hasAccess(request({ cookie: oldCookie })), false,
      'đổi mã phải vô hiệu hoá mọi cookie đã phát');
  });
});

test('Đổi mã là cách thu hồi quyền xem đã chia sẻ', () => {
  const shared = `mg_access=${fingerprint('ma-cu')}`;
  withCode('ma-cu', () => assert.equal(gate.hasAccess(request({ cookie: shared })), true));
  withCode('ma-moi', () => assert.equal(gate.hasAccess(request({ cookie: shared })), false));
});
