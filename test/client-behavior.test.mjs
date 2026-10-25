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

/** 载入 client.js 并拿到注册进 sidebar.footer.action 槽位的组件。 */
function loadClient(runtime) {
  return loadSlots(runtime)['sidebar.footer.action'];
}

/** 载入 client.js 并返回按槽位名索引的注册组件表。 */
function loadSlots(runtime) {
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? runtime.react : {}));
  const mod = win.__def.factory((id) => (id === 'react' ? runtime.react : {}));
  const registered = {};
  const ctx = {
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
      bind: () => (k) => k,
      register: () => {},
    },
    remote: { $on: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      // 按槽位名分派：本插件注册两个槽位（sidebar.footer.action 与
      // plugins.detail.section），测试各自取自己要的那个。
      inject: (_n, fn) => fn(),
      register: (meta, comp) => { registered[meta.name] = comp; },
    },
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

/** 订阅用量形态的宿主响应（provider.kind = usage）。 */
const usageResponse = (windows) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'opencode', displayName: 'OpenCode', kind: 'usage', reason: null },
    balance: { isAvailable: null, total: null, currency: null },
    usage: { plan: null, windows },
    tier: { input: 2, known: false },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: [],
  }),
});

/** 不可查 provider 的宿主响应：errors 里带一句原因，读数全空。 */
const unsupportedResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'workbuddy', displayName: 'Workbuddy', kind: 'none', reason: 'unsupported' },
    balance: { isAvailable: null, total: null, currency: null },
    usage: null,
    tier: { input: 2, known: false },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: ['当前插件不支持 Workbuddy'],
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

// ---- 多提供商账户读数的渲染 ----------------------------------------------

test('订阅用量形态渲染出窗口标签与百分比', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(usageResponse([
    { key: '5h', percent: 4, resetsAt: null },
    { key: '7d', percent: 34, resetsAt: null },
  ]));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  // 最紧的窗口（34%）上屏；标签走内置中文词典（测试里 locale.bind 返回恒等，
  // t() 因此回退到 ZH）。
  assert.ok(text.includes('34%'), `订阅用量应显示百分比，实际 ${text}`);
  assert.ok(text.includes('7 天'), `应显示窗口标签，实际 ${text}`);
  assert.ok(!text.includes('—'), `拿到数据后不应有占位符，实际 ${text}`);
});

test('不可查的 provider：卡片置空说明原因，且不出现任何数字', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('当前插件不支持 Workbuddy'), `应显示原因，实际 ${text}`);
  // 不画读数、单价、圆点：卡片里只有那句原因。
  assert.ok(!/\d+%/.test(text), `不得出现百分比，实际 ${text}`);
  assert.ok(!text.includes('¥') && !text.includes('$'), `不得出现币种符号，实际 ${text}`);
});

test('不可查的 provider：卡片文字不是错误色', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();
  const out = renderCard(Comp, runtime).out;

  // 找到承载原因文字的那个 div，读它的 color。
  let reasonColor = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object' || reasonColor !== null) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const kids = node.children ?? [];
    const isReason = kids.some((c) => typeof c === 'string' && c.includes('当前插件不支持'));
    if (isReason && node.props && node.props.style) reasonColor = node.props.style.color;
    kids.forEach(walk);
  };
  walk(out);

  // `kind: none` 不是错误：用次要文字色陈述事实，不是错误红。
  const ERR = 'var(--dsw-alias-state-error-primary, rgb(200,40,40))';
  assert.notEqual(reasonColor, ERR, `不可查的提供商不该用错误色，实际 ${reasonColor}`);
  assert.equal(reasonColor, 'var(--dsw-alias-label-secondary, rgba(0,0,0,.55))');
});

test('折叠态下不可查且无错误时整块不渲染', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime, { wide: false });
  // 先回一个 kind=none 但无错误的响应（构造上不该出现，但渲染要稳）。
  usage()[0].resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: { id: 'workbuddy', displayName: 'Workbuddy', kind: 'none', reason: 'unsupported' },
      balance: { isAvailable: null, total: null, currency: null },
      usage: null,
      tier: { input: 2, known: false },
      next: { at: Date.now() + 3_600_000 },
      peak: false,
      errors: [],
    }),
  });
  await flush();
  assert.equal(renderCard(Comp, runtime, { wide: false }).out, null, '折叠态没有可显示内容时返回 null');
});

// ---- 插件页状态表 ---------------------------------------------------------

/** 收集一处 props.style 里出现的颜色值。 */
function colorOf(node) {
  const style = node && node.props && node.props.style;
  return style && typeof style === 'object' && typeof style.color === 'string' ? style.color : null;
}

test('状态表：不支持的提供商显示"不适用"而非红色"查询失败"', async () => {
  const runtime = makeRuntime();
  const slots = loadSlots(runtime);
  const Section = slots['plugins.detail.section'];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      current: 'deepseek-official',
      accounts: [
        { id: 'deepseek-official', displayName: 'DeepSeek', kind: 'balance', status: 'ok', refs: [], token: null, balance: { isAvailable: true, total: 110, currency: 'CNY' }, usage: null, current: true, reason: null },
        { id: 'moonshotai', displayName: 'Moonshot', kind: 'balance', status: 'error', refs: [], token: null, balance: null, usage: null, current: false, reason: null },
        { id: 'google', displayName: 'Google', kind: 'none', status: 'error', refs: [], token: null, balance: null, usage: null, current: false, reason: 'cloudAuthOnly' },
      ],
      errors: [],
    }),
  });
  const el = Section({ t: (k) => k, subject: { kind: 'bundle', pkg: { name: '@dougen/dsh-deepseek-usage' } } });
  runtime.render(() => el.type(el.props));
  await flush();
  const { out } = runtime.render(() => el.type(el.props));

  const statuses = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const text = (node.children ?? []).filter((c) => typeof c === 'string').join('');
    if (text.startsWith('accounts.status.')) statuses.push({ text, color: colorOf(node) });
    (node.children ?? []).forEach(walk);
  };
  walk(out);

  const byText = Object.fromEntries(statuses.map((s) => [s.text, s.color]));
  assert.equal(byText['accounts.status.ok'], 'var(--dsw-alias-state-success-primary, rgb(34,160,80))');
  // 真失败仍然标红：这是用户需要行动的信号。
  assert.equal(byText['accounts.status.error'], 'var(--dsw-alias-state-error-primary, rgb(200,40,40))');
  // 不支持的提供商：中性 tertiary 色，不是错误色。
  assert.equal(byText['accounts.status.unsupported'], 'var(--dsw-alias-label-tertiary, rgba(0,0,0,.4))');
  assert.ok(!Object.hasOwn(byText, 'accounts.status.error') || byText['accounts.status.unsupported'] !== byText['accounts.status.error']);
});

test('状态表只出现在本插件的详情页', async () => {
  const runtime = makeRuntime();
  const Section = loadSlots(runtime)['plugins.detail.section'];
  const t = (k) => k;

  // 别的 bundle：不渲染。`plugins.detail.section` 是所有详情页共用的 slot，
  // 只判断 kind === 'bundle' 会让面板出现在每个插件页上。
  assert.equal(
    Section({ t, subject: { kind: 'bundle', pkg: { name: '@deepseek-ai/dsh-client-ui-cordis' } } }),
    null,
    '别的 bundle 的详情页不该出现本插件的面板',
  );
  // 行页面与官方插件页面同理。
  assert.equal(
    Section({ t, subject: { kind: 'row', pkg: { name: '@dougen/dsh-deepseek-usage' }, row: { rowId: 'x' } } }),
    null,
    '行页面不是 bundle 页面',
  );
  assert.equal(Section({ t, subject: { kind: 'item', id: 'agent-loop' } }), null, '官方插件页面不该出现');
  // subject 缺失也不能崩。
  assert.equal(Section({ t }), null);

  // 本插件的 bundle 页面：渲染一块 section（注册返回的是组件元素，
  // 真正的 <section> 在组件返回值里）。
  const own = Section({ t, subject: { kind: 'bundle', pkg: { name: '@dougen/dsh-deepseek-usage' } } });
  assert.notEqual(own, null);
  const rendered = runtime.render(() => own.type(own.props));
  assert.equal(rendered.out.type, 'section');
});
