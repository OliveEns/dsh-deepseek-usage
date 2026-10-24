// 浏览器侧的确定性断言：缺失值语义、倒计时、币种、假期集合、峰谷规则。
// 加载真实的 lib/client.js（stub loader + 桩 React），不模拟计时器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---- 极简 React 桩：只提供 useState / useEffect / useCallback / useRef / useMemo ----
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_sub, snap) => snap(),
};

const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
new Function('window', 'require', source)(win, (id) => (id === 'react' ? reactStub : {}));
const mod = win.__def.factory((id) => (id === 'react' ? reactStub : {}));
const I = mod.__internals;

const at = (iso) => Date.parse(iso);

test('缺失的金额显示占位符而不是 0', () => {
  assert.equal(I.money(null), '—');
  assert.equal(I.money(undefined), '—');
  assert.equal(I.money(''), '—');
  assert.equal(I.fmtPrice(null), '—');
  assert.equal(I.fmtPrice(undefined), '—');
  assert.equal(I.fmtPrice(''), '—');
});

test('真正的 0 仍然显示 0', () => {
  assert.equal(I.money(0), '0.00');
  assert.equal(I.fmtPrice(0), '0');
});

test('金额与单价按既有格式显示', () => {
  assert.equal(I.money(12.345), '12.35');
  assert.equal(I.money(1234.5), '1234.50');
  assert.equal(I.fmtPrice(0.04), '0.04');
  assert.equal(I.fmtPrice(8), '8');
  assert.equal(I.fmtPrice(2.5), '2.5');
});

test('币种映射到符号，未知币种显示代码', () => {
  assert.equal(I.currencySymbol('CNY'), '¥');
  assert.equal(I.currencySymbol('USD'), '$');
  assert.equal(I.currencySymbol('EUR'), '€');
  assert.equal(I.currencySymbol('JPY'), '¥');
  assert.equal(I.currencySymbol('HKD'), 'HKD ');
  assert.equal(I.currencySymbol(null), '¥');
});

test('倒计时的边界', () => {
  assert.equal(I.fmtCountdown(0), 'switching');
  assert.equal(I.fmtCountdown(59_400), 'switching');
  assert.equal(I.fmtCountdown(60_000), '1m');
  assert.equal(I.fmtCountdown(3 * 3600_000 + 47 * 60_000), '3h 47m');
  assert.equal(I.fmtCountdown(2 * 86400_000 + 15 * 3600_000), '2d 15h');
  assert.equal(I.fmtCountdown(NaN), 'switching');
});

test('放假日期集合：闭区间展开，非法日期被跳过', () => {
  const days = I.expandHolidayRanges([
    ['2026-10-01', '2026-10-07'],
    ['2027-02-30', '2027-03-02'], // 非法日期：不得滚动成 03-02
  ]);
  assert.equal(days.has('2026-10-01'), true);
  assert.equal(days.has('2026-10-07'), true);
  assert.equal(days.has('2026-10-08'), false);
  assert.equal(days.has('2027-02-28'), false);
  assert.equal(days.has('2027-03-02'), false);
});

test('放假日期集合是实例级的：两个实例互不覆盖', () => {
  // 组件各自持有自己的集合：宿主返回的表只影响那一个实例。
  const a = I.expandHolidayRanges([['2026-10-01', '2026-10-07']]);
  const b = I.expandHolidayRanges([['2026-01-01', '2026-01-03']]);
  assert.equal(a.has('2026-10-01'), true);
  assert.equal(a.has('2026-01-01'), false);
  assert.equal(b.has('2026-01-01'), true);
  assert.equal(b.has('2026-10-01'), false);
});

test('峰谷：法定节假日与周末空闲，工作日高峰', () => {
  const days = I.expandHolidayRanges([['2026-10-01', '2026-10-07']]);
  assert.equal(I.isPeak(at('2026-10-08T10:00:00+08:00'), days), true);
  assert.equal(I.isPeak(at('2026-10-01T10:00:00+08:00'), days), false, '国庆');
  assert.equal(I.isPeak(at('2026-10-10T10:00:00+08:00'), days), false, '周六');
  assert.equal(I.isPeak(at('2026-10-11T10:00:00+08:00'), days), false, '周日');
});

test('峰谷窗口按北京时间判定', () => {
  const days = I.expandHolidayRanges([]);
  const day = (hhmm) => at(`2026-10-22T${hhmm}:00+08:00`);
  assert.equal(I.isPeak(day('08:59'), days), false);
  assert.equal(I.isPeak(day('09:00'), days), true);
  assert.equal(I.isPeak(day('11:59'), days), true);
  assert.equal(I.isPeak(day('12:00'), days), false);
  assert.equal(I.isPeak(day('13:59'), days), false);
  assert.equal(I.isPeak(day('14:00'), days), true);
  assert.equal(I.isPeak(day('17:59'), days), true);
  assert.equal(I.isPeak(day('18:00'), days), false);
});

test('倒计时落在精确的整点边界上', () => {
  const days = I.expandHolidayRanges([]);
  const n = nextChangeOf(days);
  assert.equal(new Date(n.at).toISOString(), '2026-10-22T04:00:00.000Z', '12:00 切出高峰');
  assert.equal(n.peak, false);
  const n2 = I.nextChange(at('2026-10-22T12:00:00+08:00'), days);
  assert.equal(new Date(n2.at).toISOString(), '2026-10-22T06:00:00.000Z', '14:00 切入高峰');
  assert.equal(n2.peak, true);
});

// ---- 多提供商账户读数 -----------------------------------------------------

/** 账户读数的窗口标签需要一个本地化函数；测试用恒等函数。 */
const t = (k) => k;

test('余额形态：币种符号 + 金额', () => {
  const lead = I.accountLead('balance', { balance: { total: 12.34, currency: 'CNY' } }, t);
  assert.equal(lead.symbol, '¥');
  assert.equal(lead.value, '12.34');
  const usd = I.accountLead('balance', { balance: { total: 49.58894, currency: 'USD' } }, t);
  assert.equal(usd.symbol, '$');
  assert.equal(usd.value, '49.59');
});

test('余额缺失显示占位符，不显示 0', () => {
  const lead = I.accountLead('balance', { balance: { total: null, currency: 'CNY' } }, t);
  assert.equal(lead.symbol, '¥');
  assert.equal(lead.value, '—');
  const none = I.accountLead('balance', null, t);
  assert.equal(none.value, '—');
});

test('订阅用量形态：取最紧窗口的百分比', () => {
  const account = {
    usage: {
      windows: [
        { key: '5h', percent: 4, resetsAt: null },
        { key: '7d', percent: 34, resetsAt: null },
        { key: '30d', percent: 12, resetsAt: null },
      ],
    },
  };
  const lead = I.accountLead('usage', account, t);
  assert.equal(lead.symbol, 'accounts.window.7d', '符号位是窗口标签的 key（由界面本地化）');
  assert.equal(lead.value, '34%');
});

test('订阅用量：没有窗口或读数缺失时是占位符', () => {
  assert.equal(I.accountLead('usage', { usage: { windows: [] } }, t).value, '—');
  assert.equal(I.accountLead('usage', null, t).value, '—');
  // 百分比不是数字时不当成 0。
  const bad = I.accountLead('usage', { usage: { windows: [{ key: '5h', percent: null }] } }, t);
  assert.equal(bad.value, '—');
});

test('OAuth 形态与用量形态同构', () => {
  const account = { usage: { windows: [{ key: '5h', percent: 33, resetsAt: 1789882800000 }] } };
  const lead = I.accountLead('oauth', account, t);
  assert.equal(lead.symbol, 'accounts.window.5h');
  assert.equal(lead.value, '33%');
});

test('不可查的 provider：符号与数值都是占位符', () => {
  const lead = I.accountLead('none', { balance: { total: 99, currency: 'CNY' } }, t);
  assert.equal(lead.symbol, '');
  assert.equal(lead.value, '—', 'none 形态不得显示任何数字');
});

test('百分比：null 是占位符，真 0 是 0%', () => {
  assert.equal(I.percentText(null), '—');
  assert.equal(I.percentText(undefined), '—');
  assert.equal(I.percentText(''), '—');
  assert.equal(I.percentText('n/a'), '—');
  assert.equal(I.percentText(0), '0%');
  assert.equal(I.percentText(23.4), '23%');
  assert.equal(I.percentText(99.6), '100%');
});

function nextChangeOf(days) {
  return I.nextChange(at('2026-10-22T11:00:00+08:00'), days);
}
