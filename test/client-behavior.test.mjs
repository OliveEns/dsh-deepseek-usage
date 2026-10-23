// 客户端行为验证：并发乱序、重试阶梯、卸载后不写状态。
// 用真实的 lib/client.js + 可控 fetch + 迷你 React 运行时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/**
 * 组件的心跳（30s interval）与补请求定时器会让 Node 的事件循环一直活着，
 * 测试进程就退不出来。这里把 interval 换成 unref 的版本：它照样被记录、
 * 照样能被触发，但不再阻止进程退出。
 */
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const handle = realSetInterval(fn, ms, ...rest);
  handle.unref?.();
  return handle;
};

// ---- 迷你 React：支持状态、effect、依赖比较 ----
function makeRuntime() {
  const state = [];
  const effects = [];
  let cursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = { current: init };
      return state[i];
    },
    useMemo: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, value: fn() };
      return state[i].value;
    },
    useCallback: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, fn };
      return state[i].fn;
    },
    useEffect: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        state[i] = { deps };
        effects.push({ fn, i });
      }
    },
    useSyncExternalStore: (_sub, snap) => snap(),
  };
  return {
    react,
    state,
    /** 渲染一次并执行新增的 effect（模拟 React 的 commit）。 */
    render(fn) {
      cursor = 0;
      const out = fn();
      const pending = effects.splice(0, effects.length);
      const cleanups = [];
      for (const e of pending) {
        const cleanup = e.fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      return { out, cleanups };
    },
  };
}

/** 载入 client.js 并拿到注册进槽位的组件。 */
function loadClient(runtime) {
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? runtime.react : {}));
  const mod = win.__def.factory((id) => (id === 'react' ? runtime.react : {}));
  let registered = null;
  const ctx = {
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
      bind: () => (k) => k,
      register: () => {},
    },
    remote: { $on: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: { inject: (_n, fn) => fn(), register: (_meta, comp) => { registered = comp; } },
  };
  mod.apply(ctx);
  return registered;
}

/** 渲染槽位组件：它返回的是一个元素，真正的组件在 element.type 里。 */
function renderCard(Comp, runtime, props = { wide: true }) {
  const element = Comp(props);
  return runtime.render(() => element.type(element.props));
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.children) return node.children.map(textOf).join('');
  return '';
}

const okResponse = (total) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    balance: { total, currency: 'CNY' },
    tier: { input: 2, cacheRead: 0.04, output: 8, known: true },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: [],
  }),
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 可控 fetch：把请求挂起，测试自己决定何时、以什么结果返回。 */
function makePendingFetch() {
  const pending = [];
  globalThis.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  return {
    pending,
    usage: () => pending.filter((p) => p.url.startsWith('/api/deepseek-usage?')),
  };
}

test('晚到的旧响应不覆盖新数据', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  assert.equal(usage().length, 1, '挂载后应发出一次余额请求');

  renderCard(Comp, runtime).out.props.onClick();
  assert.equal(usage().length, 2, '点击应发出第二次余额请求');

  usage()[1].resolve(okResponse(999));
  await flush();
  assert.ok(textOf(renderCard(Comp, runtime).out).includes('999.00'));

  usage()[0].resolve(okResponse(1));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('999.00'), `旧响应不得覆盖新数据，实际 ${text}`);
});

test('晚到的旧失败不抹掉新余额', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  renderCard(Comp, runtime).out.props.onClick();
  usage()[1].resolve(okResponse(777));
  await flush();
  usage()[0].resolve({ ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }) });
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('777.00'), `旧失败不得抹掉新余额，实际 ${text}`);
  assert.ok(!text.includes('boom'), '旧失败的文案不应上屏');
});

test('失败按阶梯补请求；成功一次会取消待发的补请求并复位阶梯', async () => {
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  let scheduled = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000) {
      delays.push(ms);
      scheduled.push(fn);
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  let mode = 'fail';
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return mode === 'fail'
      ? { ok: false, status: 500, json: async () => ({ ok: false, message: 'x' }) }
      : okResponse(42);
  };

  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();
  assert.ok(delays.includes(4000), `失败后应安排 4s 补请求，实际 ${delays.join(',')}`);

  // 补请求还挂着的时候，一次成功必须把它撤掉：否则它到点后再打一发，
  // 若那次失败就会把刚拿到的余额换成错误态。
  // 4s 的阶梯等不起，改为直接验证"待发的那个定时器被清掉了"。
  const cleared = [];
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (handle) => {
    cleared.push(handle);
    return realClearTimeout(handle);
  };
  const before = calls.length;
  mode = 'ok';
  renderCard(Comp, runtime).out.props.onClick();
  await flush();
  assert.equal(delays.length, 1, `成功后不应再安排补请求，实际 ${delays.join(',')}`);
  assert.ok(cleared.length > 0, '成功后必须清掉待发的补请求定时器');
  globalThis.clearTimeout = realClearTimeout;
  globalThis.setTimeout = realSetTimeout;
});

test('一次失败后再成功：错误文案消失，余额显示出来', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  // 第一次失败
  usage()[0].resolve({ ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }) });
  await flush();
  let text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('boom'), `失败时应显示错误，实际 ${text}`);

  // 再点一次并成功
  renderCard(Comp, runtime).out.props.onClick();
  usage()[1].resolve(okResponse(6.66));
  await flush();
  text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('6.66'), `成功后应显示余额，实际 ${text}`);
  assert.ok(!text.includes('boom'), '成功后错误文案必须消失');
});

test('宿主返回的假期表覆盖内置表：峰谷判定跟着宿主走', async () => {
  // 宿主可以把接下来 11 天标成假期。那些天里没有高峰/空闲翻转点，
  // 下一个切换点要等到第 12 天（一个工作日）的 09:00 —— 倒计时会显示"十几天"。
  // 若组件用的是内置表而不是宿主返回的这份，倒计时会指向今天的下一个整点（不到一天）。
  const { pending } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);

  const ranges = [];
  const base = Date.now();
  for (let i = 0; i < 11; i += 1) {
    // 假期按北京时间的日历日算，这里也要用北京日期（比 UTC 多 8 小时）。
    const d = new Date(base + i * 86400000 + 8 * 3600_000);
    ranges.push([d.toISOString().slice(0, 10), d.toISOString().slice(0, 10)]);
  }
  const holidays = pending.find((p) => p.url.includes('/holidays'));
  assert.ok(holidays, '挂载后应拉一次假期表');
  holidays.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, ranges }),
  });
  await flush();

  const usage = pending.find((p) => p.url.startsWith('/api/deepseek-usage?'));
  usage.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      balance: { total: 1, currency: 'CNY' },
      tier: { input: 2, known: true },
      next: { at: null, ms: 0 },
      peak: true,
      errors: [],
    }),
  });
  await flush();

  const text = textOf(renderCard(Comp, runtime).out);
  // 倒计时按 "d h" 计数：宿主表生效时至少 10 天。
  assert.ok(/1[01]d \d{1,2}h/.test(text), `倒计时应按宿主的假期表指向十几天后，实际 ${text}`);
});

test('卸载后不再写入状态', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const { cleanups } = renderCard(Comp, runtime);
  cleanups.forEach((c) => c());
  usage()[0].resolve(okResponse(1));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(!text.includes('1.00'), `卸载后不得写入状态，实际 ${text}`);
});
