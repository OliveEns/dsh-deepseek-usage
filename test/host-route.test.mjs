// 宿主侧路由的确定性断言：信任围栏、错误文案不外泄、余额缺失不伪装成 0。
// `@deepseek-ai/dsh-credentials` 不在本地安装，用 loader 钩子给它一个桩。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const CREDENTIALS_STUB = `
export function credentialRef(name) { return { kind: 'credential-ref', name }; }
export default { credentialRef };
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-credentials') {
      return { url: 'data:text/javascript,' + encodeURIComponent(CREDENTIALS_STUB), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { apply } = await import('../lib/index.js');

/**
 * 默认的 fetch 桩：返回一份正常余额。所有会打上游的用例都靠它，
 * 测试不联网（"回环地址的各种写法都被接受" 那个用例原本会真的打一次
 * api.deepseek.com）。
 */
const defaultFetch = async () => new Response(JSON.stringify({
  is_available: true,
  balance_infos: [{ total_balance: '12.34', currency: 'CNY' }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

const originalFetch = globalThis.fetch;
globalThis.fetch = defaultFetch;
test.after(() => { globalThis.fetch = originalFetch; });

/** 造一个最小的 ctx：记录注册进来的路由，可注入凭据与取价。 */
let keySeq = 0;
function makeCtx(options = {}) {
  const routes = new Map();
  // 每个 ctx 用不同的 Key：宿主按 Key 值缓存余额快照，测试之间不能互相命中。
  keySeq += 1;
  const key = options.key === undefined ? `sk-test-${keySeq}` : options.key;
  const ctx = {
    logger: { warn() {} },
    credentials: {
      resolve: async () => (key === null ? undefined : { value: key }),
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return {
          currentSelection: () => ({
            provider: options.provider ?? 'deepseek-official',
            model: options.model ?? 'deepseek-flash',
          }),
        };
      }
      return undefined;
    },
    effect(fn) {
      fn();
      return () => {};
    },
    webServer: {
      host: options.bindHost ?? '127.0.0.1',
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  return { ctx, routes };
}

/** 造一个最小的 req/res。 */
function makeReq(headers = {}, url = '/api/deepseek-usage?lang=zh', method = 'GET') {
  return { headers, url, method };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headersSent: false,
    body: undefined,
    writeHead(status) { res.statusCode = status; res.headersSent = true; },
    end(chunk) { res.body = chunk; },
  };
  return res;
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

test('非 GET 方法被拒绝', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({}, '/api/deepseek-usage', 'POST'));
  assert.equal(res.status, 405);
});

test('非本机 Host 被拒绝', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  for (const host of ['evil.example:64452', '10.0.0.7:64452']) {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host }));
    assert.equal(res.status, 403, `${host} 应被拒绝`);
  }
});

test('回环地址的各种写法都被接受', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  for (const host of ['127.0.0.1:64452', '127.0.0.2:64452', 'localhost:64452', '[::1]:64452', '[::ffff:127.0.0.1]:64452']) {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host }));
    assert.notEqual(res.status, 403, `${host} 应被接受`);
  }
});

test('监听器绑定的地址也被接受（--host 部署）', async () => {
  const { ctx, routes } = makeCtx({ bindHost: '10.0.0.7' });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '10.0.0.7:64452' }));
  assert.notEqual(res.status, 403);
});

test('绑定地址是 IPv6 时同样认得出来', async () => {
  const { ctx, routes } = makeCtx({ bindHost: '::1' });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '[::1]:64452' }));
  assert.notEqual(res.status, 403);
});

test('跨站请求与异源 Origin 被拒绝', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const route = routes.get('/api/deepseek-usage');
  const crossSite = await call(route, makeReq({ host: '127.0.0.1:64452', 'sec-fetch-site': 'cross-site' }));
  assert.equal(crossSite.status, 403);
  const foreignOrigin = await call(route, makeReq({ host: '127.0.0.1:64452', origin: 'http://evil.example' }));
  assert.equal(foreignOrigin.status, 403);
  const sameOrigin = await call(route, makeReq({ host: '127.0.0.1:64452', origin: 'http://127.0.0.1:64452' }));
  assert.notEqual(sameOrigin.status, 403);
});

test('未配置 Key 时只给出可行动的文案', async () => {
  const { ctx, routes } = makeCtx({ key: null });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.errors, ['未配置 DEEPSEEK_API_KEY']);
  assert.equal(res.body.balance.total, null, '没有余额时是 null，不是 0');
});

test('Key 含非法字符时不把 Key 写进响应', async () => {
  const { ctx, routes } = makeCtx({ key: 'sk-live\nsecond-line' });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.errors.length, 1);
  assert.ok(!JSON.stringify(res.body).includes('sk-live'), '响应里不得出现 Key');
  assert.ok(!JSON.stringify(res.body).includes('second-line'), '响应里不得出现 Key 的其余部分');
});

test('上游异常不会把异常原文送到浏览器', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:443 (internal)'); };
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.errors, ['余额接口无法连接']);
    assert.ok(!JSON.stringify(res.body).includes('10.0.0.7'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('余额单飞按 Key 分桶：换 Key 不会复用旧 Key 的在途请求', async () => {
  // 第一次请求用 sk-A 并挂起（模拟慢响应）；期间凭据换成 sk-B，
  // 第二个请求必须发自己的上游调用，而不是复用 sk-A 的在途 promise。
  let holdFirst = true;
  globalThis.fetch = async () => {
    if (holdFirst) {
      holdFirst = false;
      return new Promise(() => {}); // 永不返回：模拟慢响应
    }
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ total_balance: '99.99', currency: 'CNY' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let currentKey = 'sk-A';
  const { ctx, routes } = makeCtx();
  ctx.credentials.resolve = async () => ({ value: currentKey });
  apply(ctx);
  const route = routes.get('/api/deepseek-usage');

  void call(route, makeReq({ host: '127.0.0.1:64452' })); // 挂起，不等它
  currentKey = 'sk-B';
  const second = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(second.body.balance.total, 99.99, '换 Key 后必须拿到新 Key 的余额');
});

test('放假日期表过期时宿主会告警（每天一次）', async () => {
  const warnings = [];
  const { ctx, routes } = makeCtx();
  ctx.logger = { warn: (m) => warnings.push(String(m)) };
  apply(ctx);

  // 表覆盖当年时不该告警。
  await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(warnings.filter((w) => w.includes('放假日期表未覆盖')).length, 0, '表覆盖当年时不应告警');

  // 把时钟拨到 2027：表还没覆盖那一年，必须告警，且文案要指出该改哪个常量。
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + 400 * 86400000; // 往后推 400 天
  try {
    await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    const warns = warnings.filter((w) => w.includes('放假日期表未覆盖'));
    assert.equal(warns.length, 1, '表未覆盖当年时必须告警一次');
    assert.ok(warns[0].includes('HOLIDAY_TABLE_THROUGH_YEAR'), `告警文案应指出要改的常量，实际：${warns[0]}`);
  } finally {
    Date.now = realNow;
  }
});

test('宿主内部异常时返回 502，且不把异常原文送进响应', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  // 让 handler 内部抛异常，落到最外层的 catch（502 路径）。
  const realNow = Date.now;
  Date.now = () => { throw new Error('内部故障 sk-live-SECRET-KEY 片段'); };
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(res.status, 502);
    assert.equal(res.body.message, '插件内部错误');
    assert.ok(!JSON.stringify(res.body).includes('SECRET'), '502 响应里不得出现异常原文');
  } finally {
    Date.now = realNow;
  }
});

test('余额缓存按 Key 分桶：换 Key 后不会命中旧 Key 的缓存', async () => {
  const upstream = [];
  globalThis.fetch = async () => {
    upstream.push('call');
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ total_balance: upstream.length === 1 ? '11.11' : '99.99', currency: 'CNY' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let currentKey = 'sk-cache-A';
  const { ctx, routes } = makeCtx();
  ctx.credentials.resolve = async () => ({ value: currentKey });
  apply(ctx);
  const route = routes.get('/api/deepseek-usage');

  const first = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(first.body.balance.total, 11.11);

  // 同一个 Key 再问：命中缓存，不再打上游。
  const again = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(again.body.balance.total, 11.11);
  assert.equal(upstream.length, 1, '同一个 Key 的第二次请求应命中缓存');

  // 换 Key：不能命中旧 Key 的缓存，必须打自己的上游调用。
  currentKey = 'sk-cache-B';
  const other = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(other.body.balance.total, 99.99, '换 Key 后必须拿到新 Key 的余额');
  assert.equal(upstream.length, 2, '换 Key 后必须重新打上游');
});

test('余额缺失时报错而不是伪装成 0 元', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ is_available: true, balance_infos: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(res.body.balance.total, null, 'total 必须是 null');
    assert.deepEqual(res.body.errors, ['余额接口没有返回余额']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('响应体超限时按"无法解析"处理，不当成网络故障', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('x'.repeat(70 * 1024), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.deepEqual(res.body.errors, ['余额接口返回了无法解析的内容']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('账户不可用时给出可行动的文案', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    is_available: false,
    balance_infos: [{ total_balance: '1.00', currency: 'CNY' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.deepEqual(res.body.errors, ['账户当前不可用']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('官方路由上的模型给单价，第三方路由上的模型不给', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: [{ total_balance: '12.34', currency: 'CNY' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const official = makeCtx({ provider: 'deepseek-official', model: 'deepseek-flash' });
    apply(official.ctx);
    const a = await call(official.routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(a.body.tier.known, true);
    // 单价随峰谷时段变化（高峰 2 / 空闲 1），断言"是表里的数"而不是某个具体值。
    assert.ok([1, 2].includes(a.body.tier.input), `单价应来自价格表，实际 ${a.body.tier.input}`);
    assert.equal(a.body.tier.model, 'deepseek-flash');

    const router = makeCtx({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' });
    apply(router.ctx);
    const b = await call(router.routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(b.body.tier.known, false, '第三方路由的模型不该计价');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('假期路由也只接受本机来源', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const route = routes.get('/api/deepseek-usage/holidays');
  const ok = await call(route, makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/holidays'));
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.ranges));
  const denied = await call(route, makeReq({ host: 'evil.example' }, '/api/deepseek-usage/holidays'));
  assert.equal(denied.status, 403);
});

