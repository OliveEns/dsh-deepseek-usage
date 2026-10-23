// dsh-deepseek-usage — browser half.
//
// 侧边栏底部用量卡片（注册进 `sidebar.footer.action` 槽位，独占一行，位于
// Cordis 面板按钮下方）。每 30 秒心跳一次：重算倒计时并重新拉取宿主路由
// `/api/deepseek-usage`（见 lib/index.js），因此余额、档单价与峰谷指示灯都随心跳更新，
// 跨过峰谷切换点后最多滞后一次心跳；点击卡片任意位置可立即刷新；还没拿到余额
// （宿主刚重启/接口刚起来）时按 QUICK_RETRY_MS 阶梯快速补几次请求，卡片几秒内收敛。
// 两种形态：
//   · 侧边栏展开——完整卡片：余额（放大显示，符号随币种）+ 当前模型档单价
//     （输入/输入缓存/输出，图标 + 数字，位于卡片右下角）+ 峰谷指示灯（右上角，
//     只有颜色）+ 距下次峰谷切换的倒计时（`2d 15h` / `5h 47m` / `23m`，与指示灯同行、
//     位于其左侧）。
//   · 侧边栏折叠——36px 图标栏里只有峰谷指示灯（见下方 `if (!wide)` 分支）。
//
// 设计约束（用户只关心"我还能花多少、这会儿什么价"）：
//   · 插件的内部信息——取价路径、模型改名、放假日期来源——一律不出现在 UI 上
//     （历史上圆点的 title 里塞过这些，已删除）。
//   · 唯一的交互是「点击卡片刷新」；没有可切换的提示态。
//   · 只有余额类错误（未配置 Key / 余额接口或网络失败）才置空卡片说明原因。
//   · 档单价与峰谷指示灯只对 DeepSeek 官方路由上的官方模型展示（宿主已按 provider
//     过滤）；其他模型不适用官方峰谷定价，整组隐藏，卡片只留余额。
//   · 没有数据时不编数字：余额与单价显示「—」，而不是 0.00 / 0。
// 样式仅使用 `--dsw-*` 主题变量（含兜底值），跟随明暗主题。
window.__ModuleLoader__.load({
	id: "@dougen/dsh-deepseek-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useCallback, useRef, useMemo } = react;
		const h = react.createElement;

		// ---- constants -------------------------------------------------
		// 卡片心跳：每 30 秒重算一次倒计时并重新取一次数（余额 + 当前档单价）。
		// 峰谷切换也因此不需要额外的检测逻辑——每次心跳都重新取数，切换后最多 30 秒翻正。
		const POLL_MS = 30 * 1000;
		const USAGE_PATH = "/api/deepseek-usage";
		// 放假日期：宿主路由（见 lib/index.js），浏览器启动时读一次，覆盖内置镜像表；
		// 读不到就继续用内置表（两边都是同一份国务院办公厅日期表）。
		const HOLIDAYS_PATH = "/api/deepseek-usage/holidays";
		// 常态卡片高度：上下 padding 8+12 + 金额行 minHeight 28 + 边框 2 = 50。
		// 无头 Chromium 实测常态卡片 50px，异常态用同一个 minHeight 兜住，侧边栏不跳动。
		const CARD_MIN_HEIGHT = 50;
		// 卡片还没拿到余额时的快速重试节奏（宿主刚重启、接口刚起来、或本次请求失败）：
		// 让空卡片在几秒内收敛，而不必等满下一次心跳。
		const QUICK_RETRY_MS = [4000, 8000, 15000, 30000];
		// 宿主错误文案的长度上限：上游异常文本可能很长，卡片高度不应被它撑开。
		const ERROR_MAX_CHARS = 120;

		// ---- i18n（DSH locale 服务；zh 为兜底）----
		// 注意：卡片上只出现「输入 / 输入缓存 / 输出」这三个标签。峰谷灯没有文字、
		// 没有 hover；倒计时统一用英文单位（d/h/m）且不带前缀，中英界面完全一致——
		// 插件内部的取价路径等一概不进 UI。
		const NS = "dsh-deepseek-usage";
		const ZH = {
			"price.input": "输入",
			"price.cache": "输入缓存",
			"price.output": "输出",
			"status.peak": "高峰时段",
			"status.idle": "空闲时段",
			"status.error": "余额读取失败",
			"card.label": "DeepSeek 用量，点击刷新",
		};
		const EN = {
			"price.input": "Input",
			"price.cache": "Input cache",
			"price.output": "Output",
			"status.peak": "Peak hours",
			"status.idle": "Off-peak hours",
			"status.error": "Balance unavailable",
			"card.label": "DeepSeek usage, click to refresh",
		};

		// ---- 倒计时文案（语言无关，故不进词典）----
		const SWITCHING = "switching";

		// ---- 峰谷规则（必须与 lib/pricing.js 的 isPeak / PEAK_WINDOWS /
		// PEAK_WEEKDAYS_ONLY / HOLIDAY_RANGES 保持一致；浏览器侧无法 import 宿主模块，
		// 只能镜像。2026 年起官方口径：法定节假日全天、调休上班的周末都是空闲时段，
		// 所以放假日期必须一起镜像，否则中秋/国庆白天会被误显示成高峰价）----
		const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
		const PEAK_WINDOWS = [[9, 12], [14, 18]];
		const PEAK_WEEKDAYS_ONLY = true;
		/** 可能的切换时刻（北京时间整点）：高峰窗口的起止整点，nextChange 逐日枚举它们。 */
		const BOUNDARY_HOURS = [...new Set(PEAK_WINDOWS.flat())].sort((a, b) => a - b);
		// 放假日期（含起止，闭区间）：国务院办公厅 2026 年节假日安排。
		const HOLIDAY_RANGES = [
			['2026-01-01', '2026-01-03'],
			['2026-02-15', '2026-02-23'],
			['2026-04-04', '2026-04-06'],
			['2026-05-01', '2026-05-05'],
			['2026-06-19', '2026-06-21'],
			['2026-09-25', '2026-09-27'],
			['2026-10-01', '2026-10-07'],
		];
		const DAY_MS = 24 * 60 * 60 * 1000;

		/** 把 [起, 止] 闭区间展开成日期键集合（`yyyy-mm-dd`）。 */
		function expandHolidayRanges(ranges) {
			const set = new Set();
			for (const [from, to] of ranges) {
				if (typeof from !== "string" || typeof to !== "string") continue;
				if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
				const start = Date.parse(from + 'T00:00:00Z');
				const end = Date.parse(to + 'T00:00:00Z');
				if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
				// 解析结果必须与输入同一天，否则输入本身不是合法日期（已滚动到别的日子）。
				if (new Date(start).toISOString().slice(0, 10) !== from) continue;
				if (new Date(end).toISOString().slice(0, 10) !== to) continue;
				for (let t = start; t <= end; t += DAY_MS) set.add(new Date(t).toISOString().slice(0, 10));
			}
			return set;
		}

		/** 内置镜像表：宿主不可达时的兜底，也是 isPeak/nextChange 的缺省集合。 */
		const BUILTIN_HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

		/** 该时刻所在北京时间日历日是否为法定节假日（放假日期）。 */
		function isHoliday(ms, days) {
			return days.has(new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10));
		}

		/**
		 * 某时刻是否为高峰时段（按北京时间；节假日全天与周末恒为空闲）。与 lib/pricing.js 的 isPeak 等价。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 isPeak 同一口径。
		 */
		function isPeak(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			if (isHoliday(now, days)) return false;
			const d = new Date(now + SHANGHAI_OFFSET_MS);
			if (PEAK_WEEKDAYS_ONLY) {
				const dow = d.getUTCDay();
				if (dow === 0 || dow === 6) return false;
			}
			const h = d.getUTCHours();
			return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
		}

		/**
		 * 距下一个计费时段边界的剩余时间；与 lib/pricing.js 的 nextChange 等价。
		 * 候选时刻是 PEAK_WINDOWS 起止整点落在各天的那些点，逐日枚举取第一个让 isPeak
		 * 翻转的，因此返回精确时刻（上限 32 天，覆盖春节长假 → 假期后首个工作日早晨）。
		 * 找不到切换点时 at 为 null——调用方据此显示「—」，不要当成"此刻在切换"。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 nextChange 同一口径。
		 */
		function nextChange(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			const current = isPeak(now, days);
			const hourMs = 60 * 60 * 1000;
			const dayStart = Date.parse(new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10) + 'T00:00:00Z') - SHANGHAI_OFFSET_MS;
			for (let day = 0; day < 32; day += 1) {
				const base = dayStart + day * DAY_MS;
				for (const hour of BOUNDARY_HOURS) {
					const at = base + hour * hourMs;
					if (at <= now) continue;
					const peak = isPeak(at, days);
					if (peak !== current) return { peak, at, ms: at - now };
				}
			}
			return { peak: !current, at: null, ms: 0 };
		}

		/** m/h/d 三档短标签（语言无关）。 */
		const _u = (v, u) => `${v}${u}`;

		/**
		 * 剩余毫秒 → 英文单位时长，最多两级：`2d 15h` / `5h 47m` / `23m` / `switching`。
		 * 不足 1 分钟显示 `switching`。向下取整，避免"还剩 59 秒却显示 1m"的反向偏差。
		 */
		function fmtCountdown(ms) {
			const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60000));
			const days = Math.floor(total / 1440);
			const hours = Math.floor((total % 1440) / 60);
			const minutes = total % 60;
			if (days > 0) return _u(days, "d") + " " + _u(hours, "h");
			if (hours > 0) return _u(hours, "h") + " " + _u(minutes, "m");
			return minutes > 0 ? _u(minutes, "m") : SWITCHING;
		}

		/**
		 * 金额 → 两位小数字符串。
		 * null / undefined / 空串都表示"没有拿到"，显示「—」：Number(null) 是 0，
		 * 直接转换会把"读不到余额"显示成"余额 0 元"。
		 */
		function money(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return n.toFixed(2);
		}

		/** 单价 → 去掉多余尾零的字符串；同样把"没有值"显示成「—」。 */
		function fmtPrice(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(parseFloat(n.toFixed(2)));
		}

		/** 币种 → 符号。未知币种显示代码本身（如 HKD 10.00），不假装成人民币。 */
		function currencySymbol(currency) {
			if (typeof currency !== "string" || currency === "") return "¥";
			const code = currency.trim().toUpperCase();
			if (code === "CNY" || code === "RMB") return "¥";
			if (code === "USD") return "$";
			if (code === "EUR") return "€";
			if (code === "JPY") return "¥";
			if (code === "GBP") return "£";
			return code + " ";
		}

		// 主题变量（带兜底值）
		const C = {
			bg: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
			border: "var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
			label: "var(--dsw-alias-label-primary, #111)",
			sub: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
			err: "var(--dsw-alias-state-error-primary, rgb(200,40,40))",
			peak: "var(--dsw-alias-state-warn-primary, rgb(230,120,0))",
			idle: "var(--dsw-alias-state-success-primary, rgb(34,160,80))",
			muted: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.35))",
		};

		const svgBase = {
			width: 12,
			height: 12,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2.2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			style: { flex: "none", display: "block" },
		};
		// 输入：右箭头指向右边界（→|，数据进入边界）
		const IconIn = () => h("svg", svgBase,
			h("path", { d: "M20 4v16" }),
			h("path", { d: "M20 12H6" }),
			h("path", { d: "M10 7l5 5-5 5" }));
		// 输出：左边界发出右箭头（|→，数据从边界流出）
		const IconOut = () => h("svg", svgBase,
			h("path", { d: "M4 4v16" }),
			h("path", { d: "M4 12h14" }),
			h("path", { d: "M14 7l5 5-5 5" }));
		// 缓存：闪电（缓存命中，快）
		const IconCache = () => h("svg", svgBase,
			h("path", { d: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" }));

		// ---- the widget -------------------------------------------------
		function UsageCell(props) {
			const ctx = props.ctx;
			const wide = !!props.wide;
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			// 倒计时走字用的心跳：每 30 秒 bump 一次，渲染时按当前时刻重算剩余时间。
			const [tick, setTick] = useState(0);
			const [holidayRanges, setHolidayRanges] = useState(() => HOLIDAY_RANGES);
			// 放假日期表：组件实例自己的集合（不做成模块级可变对象——同一页面挂两个实例
			// 时会互相覆盖，峰谷判定会无声翻转）。
			const holidayDays = useMemo(() => expandHolidayRanges(holidayRanges), [holidayRanges]);
			const mounted = useRef(true);
			// 请求序号：只有最后一次请求的结果可以写进 state。心跳、点击、设置事件
			// 会并发触发 load()，慢的旧响应回来得更晚，会把新数据盖掉。
			const requestSeq = useRef(0);
			// 快速重试：阶梯下标 + 定时器（宿主刚起来、余额接口还没返回时，几秒后自己再看一眼）。
			const retryStep = useRef(0);
			const retryTimer = useRef(null);
			// 页面可见性：后台标签页不做心跳（宿主每次都会真打一次官方余额接口）。
			const visible = useRef(typeof document === "undefined" || document.visibilityState !== "hidden");
			const locale = ctx && ctx.locale;

			// 订阅语言变化（DSH locale 服务；不可用时回退中文）。
			// 回退快照必须是同一个对象：每次调用返回新对象会让 useSyncExternalStore
			// 认为快照一直在变，触发无限重渲染。
			const FALLBACK_LOCALE_SNAPSHOT = { active: "zh", locales: [], revision: 0 };
			const lcSnap = react.useSyncExternalStore(
				(cb) => (locale && typeof locale.subscribe === "function" ? locale.subscribe(cb) : () => {}),
				() => (locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : FALLBACK_LOCALE_SNAPSHOT),
			);
			const lang = lcSnap && lcSnap.active === "en" ? "en" : "zh";
			// locale.bind(ns) 返回绑定命名空间的翻译函数；不可用时回退中文词典。
			const boundT = locale && typeof locale.bind === "function" ? locale.bind(NS) : null;
			const t = (key) => {
				try {
					if (boundT) {
						const v = boundT(key);
						if (typeof v === "string" && v !== key) return v;
					}
				} catch (e) { /* 词典不可用，回退中文 */ }
				return ZH[key] || key;
			};

			// 宿主还在后台忙（重启后首次余额、接口刚起来）时按 QUICK_RETRY_MS 阶梯补几次请求，
			// 让卡片几秒内收敛，不必等下一次心跳（POLL_MS）。失败同样按此节奏重试。
			// 判断依据只看"有没有拿到余额"，不依赖宿主内部字段。
			const cancelRetry = useCallback(() => {
				if (retryTimer.current !== null) {
					clearTimeout(retryTimer.current);
					retryTimer.current = null;
				}
			}, []);

			// 语言放进 ref：load 的身份不随语言变化，切中英文时不会重建心跳定时器、
			// 也不会让旧语言的在途请求回填到新语言的界面上。
			const langRef = useRef(lang);
			langRef.current = lang;

			// loadRef 让下面两个回调可以互相引用而不必谁先声明。
			const loadRef = useRef(null);

			/** 按 QUICK_RETRY_MS 阶梯安排一次补请求（用 ref 记录进度；卸载时清理）。 */
			const scheduleRetry = useCallback(() => {
				if (!mounted.current) return;
				const delay = QUICK_RETRY_MS[retryStep.current];
				if (delay === undefined) return;
				retryStep.current += 1;
				cancelRetry();
				retryTimer.current = setTimeout(() => {
					retryTimer.current = null;
					const run = loadRef.current;
					if (run) run();
				}, delay);
			}, [cancelRetry]);

			const load = useCallback(async () => {
				const seq = ++requestSeq.current;
				try {
					const res = await fetch(USAGE_PATH + "?lang=" + langRef.current, { cache: "no-store" });
					let body = null;
					try {
						body = await res.json();
					} catch (e) {
						body = null;
					}
					if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
						// 失败原因优先用宿主给的文案（未配置 Key / 余额接口异常，用户看得懂）；
						// 拿不到就用一句人话兜底——不把 HTTP 状态码这类传输细节摆到卡片上。
						throw new Error(body && typeof body.message === "string" && body.message !== "" ? body.message : "刷新失败，请稍后重试");
					}
					// 过期响应直接丢弃：晚到的旧结果不能盖掉新数据，也不能把刚填好的
					// 余额整个抹成错误态。
					if (!mounted.current || seq !== requestSeq.current) return;
					setData(body);
					setError("");
					// 成功即取消待发的补请求并复位阶梯，否则上一次失败排下的定时器会
					// 在几秒后再打一发，可能把这份好数据换成错误态。
					cancelRetry();
					retryStep.current = 0;
				} catch (e) {
					if (!mounted.current || seq !== requestSeq.current) return;
					const message = e instanceof Error ? e.message : String(e);
					setError(message.length > ERROR_MAX_CHARS ? message.slice(0, ERROR_MAX_CHARS) + "…" : message);
					scheduleRetry();
				}
			}, [cancelRetry, scheduleRetry]);

			loadRef.current = load;

			useEffect(() => {
				mounted.current = true;
				load();
				// 模型切换（写入 settings 触发 document-updated）时立即刷新，单价跟着变。
				let off = null;
				try {
					if (ctx && ctx.remote && typeof ctx.remote.$on === "function") {
						off = ctx.remote.$on("settings/document-updated", () => {
							load().catch(() => {});
						});
					}
				} catch (e) {
					off = null;
				}
				return () => {
					mounted.current = false;
					cancelRetry();
					try {
						if (typeof off === "function") off();
					} catch (e) { /* 忽略退订错误 */ }
				};
			}, [load, ctx, cancelRetry]);

			// ---- 放假日期表（宿主是唯一权威：启动时拉一次，只用于本地兜底计算）----
			// 浏览器侧必须镜像峰谷规则（无法 import 宿主模块），放假日期也就不该各写一份，
			// 否则放假那几天两边会算出不同结果。这里用组件自己的 holidayDays 集合，
			// 宿主返回的表覆盖内置镜像。
			useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch(HOLIDAYS_PATH, { cache: "no-store" });
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						if (cancelled || !res.ok || !body || body.ok !== true) return;
						if (Array.isArray(body.ranges) && body.ranges.length > 0) setHolidayRanges(body.ranges);
					} catch (e) { /* 读不到就用内置表继续 */ }
				})();
				return () => { cancelled = true; };
			}, []);

			// 页面可见性：隐藏时停心跳，回到前台补一次。
			useEffect(() => {
				if (typeof document === "undefined") return;
				const onChange = () => {
					visible.current = document.visibilityState !== "hidden";
					if (visible.current) load().catch(() => {});
				};
				document.addEventListener("visibilitychange", onChange);
				return () => document.removeEventListener("visibilitychange", onChange);
			}, [load]);

			// 心跳：每 POLL_MS 重算一次倒计时（setTick 触发重渲染）并重新取一次数。
			// 取数会带回最新的余额、峰谷状态与档单价，所以跨过峰谷切换点后单价与指示灯
			// 最多滞后一次心跳——不需要单独检测切换时刻。页面隐藏时不发请求。
			useEffect(() => {
				const timer = setInterval(() => {
					setTick((v) => v + 1);
					if (!visible.current) return;
					load().catch(() => {});
				}, POLL_MS);
				return () => clearInterval(timer);
			}, [load]);

			const balance = data && data.balance ? data.balance : null;
			const tier = data && data.tier ? data.tier : null;
			const symbol = currencySymbol(balance ? balance.currency : "");
			// 档单价与峰谷指示灯只对官方路由上的官方模型有意义：宿主已按 provider 过滤，
			// known=false 表示"这个模型的价格插件不知道"，档单价与峰谷都无从展示。
			// 数据还没到（tier 为 null）时同样不显示——宁可少显示，也不要显示 0。
			const priced = !!tier && tier.known !== false;
			// 卡片只显示"用户要的数字"：余额、当前档单价、状态圆点、距下次切换的倒计时。
			// 插件的内部信息（取价路径、模型改名）一律不进 UI，
			// 唯一的交互是点击卡片刷新。只有"余额类错误"（未配置 Key / 接口或网络失败）才
			// 把卡片置空并说明原因——否则余额是空的，用户无从判断。
			const errs = (Array.isArray(data && data.errors) ? data.errors : []).concat(error ? [error] : []);
			const blanked = errs.length > 0;
			// 每次渲染都以"当前时刻"求剩余时间；tick 每 30 秒 bump 一次触发这次重算。
			const nowMs = Date.now();
			const nextAt = (() => {
				const raw = data && data.next ? Number(data.next.at) : NaN;
				// 宿主给的切换时刻必须还在将来：旧响应或时钟漂移会让它落在过去，
				// 那样倒计时会卡在 switching。
				if (Number.isFinite(raw) && raw > nowMs) return raw;
				const age = data && Number(data.updatedAt) > 0 ? Math.max(0, nowMs - Number(data.updatedAt)) : 0;
				const local = nextChange(nowMs - age, holidayDays);
				return local.at !== null && local.at > nowMs ? local.at : null;
			})();
			void tick; // tick 只用来触发重渲染，值本身不参与计算
			const countdown = nextAt === null ? "—" : fmtCountdown(nextAt - nowMs);
			const dot = {
				width: 8,
				height: 8,
				borderRadius: "50%",
				flex: "none",
				background: data ? (data.peak ? C.peak : C.idle) : C.muted,
				boxShadow: "0 0 4px rgba(0,0,0,.3)",
			};
			// 圆点自身没有任何 hover（历史上的 title 里塞了价格表路径等内部信息，
			// 对用户毫无意义，已删除）；它只表达"现在是高峰还是空闲"，切换时刻由旁边的
			// 倒计时承担。
			// 点击卡片：唯一动作 = 刷新。
			const onCardClick = () => {
				load().catch(() => {});
			};

			// 折叠态（图标栏）：内容宽 36px（侧边栏 56px − 折叠态左右各 10px 内边距），
			// 只容得下峰谷指示灯，没有外框也没有底色（直接坐在侧边栏背景上）。
			// 指示灯仍是"点击刷新"的落点。
			// 非官方模型时这个栏里没有任何有意义的内容（余额在折叠态放不下），整块不渲染。
			// 余额读不到时圆点用错误色——绿灯会被读成"一切正常"。
			if (!wide) {
				if (!priced && !blanked) return null;
				const failed = blanked;
				return h("div", {
					style: {
						boxSizing: "border-box",
						flex: "none",
						padding: "4px 8px",
						cursor: "pointer",
						display: "flex",
						flexDirection: "row",
						alignItems: "center",
						userSelect: "none",
					},
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					onClick: () => load().catch(() => {}),
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							load().catch(() => {});
						}
					},
				}, h("span", {
					style: { ...dot, background: failed ? C.err : dot.background },
					role: "img",
					"aria-label": failed
						? t("status.error")
						: (data && data.peak ? t("status.peak") : t("status.idle")),
				}));
			}

			// 只有"余额类错误"（未配置 Key / 余额接口或网络失败）才走到这里：卡片置空、
			// 只显示原因文字，不画余额/单价/圆点/倒计时。minHeight 兜住常态卡片高度
			// （CARD_MIN_HEIGHT），侧边栏不跳动；文字多行时卡片自然变高。
			// 注意：这里不显示任何插件内部信息（取价路径、放假日期来源），历史上那批
			// 良性提示已随"去技术化"一起删除。
			// 折叠态（!wide）早在上面就返回了：它只有峰谷指示灯，没有文字空间。
			if (blanked) {
				return h("div", {
					style: {
						boxSizing: "border-box",
						flex: "1 1 100%",
						minWidth: 0,
						minHeight: CARD_MIN_HEIGHT,
						padding: "8px 10px",
						borderRadius: 10,
						border: "1px solid " + C.border,
						background: C.bg,
						color: C.label,
						cursor: "pointer",
						userSelect: "none",
						display: "flex",
						flexDirection: "column",
						justifyContent: "center",
						gap: 3,
						marginTop: 4,
						fontSize: "12px",
						lineHeight: "15px",
					},
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					onClick: onCardClick,
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onCardClick();
						}
					},
				},
					h("div", {
						style: { color: C.err, fontSize: 12, lineHeight: "16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
					}, errs.join(" | ")));
			}

			const Price = (icon, label, value) =>
				h("span", { style: { display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0, color: C.sub, whiteSpace: "nowrap" } },
					h("span", { style: { display: "inline-flex", alignItems: "center" }, title: label, "aria-hidden": "true" }, icon),
					h("span", { style: { fontWeight: 600 } }, fmtPrice(value)));

			return h("div", {
				style: {
					boxSizing: "border-box",
					flex: "1 1 100%",
					minWidth: 0,
					// 上 8 下 10。顶部保持 8px 不动，圆点才能继续紧贴右上角。
					// 下内边距 10 是单价行自己那行的呼吸空间。
					padding: "8px 10px 10px",
					borderRadius: 10,
					border: "1px solid " + C.border,
					background: C.bg,
					color: C.label,
					cursor: "pointer",
					userSelect: "none",
					display: "flex",
					flexDirection: "column",
					gap: 2,
					marginTop: 4,
					position: "relative",
					fontSize: "12px",
					lineHeight: "15px",
				},
				role: "button",
				tabIndex: 0,
				"aria-label": t("card.label"),
				onClick: onCardClick,
				onKeyDown: (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onCardClick();
					}
				},
			},
				// 金额行：余额 + 右侧「倒计时 + 峰谷圆点」。
				// 倒计时与圆点放在同一个 flex 行里、alignItems:center，两者圆心必然重合；
				// 整组 alignSelf:flex-start + 负 margin，让圆点距卡片顶/右各 8px。
				// 两个反面做法都试过并实测过：
				//   · alignSelf:center → 圆点被压到卡片中线，不再是"右上角"；
				//   · paddingTop:6    → 金额行被撑高，卡片被撑大，圆点反而更靠下。
				// 倒计时 flex:0 0 auto：窄侧边栏下先省略号截断，不挤压余额
				// （实测 "2d 23h" 在 170px 宽的卡片里仍放得下）。
				h("div", { style: { display: "flex", alignItems: "baseline", minHeight: 28, minWidth: 0, gap: 6 } },
					h("span", { style: { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", marginRight: 3, flex: "none" } }, symbol),
					h("span", { style: { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, money(balance ? balance.total : null)),
					// 负 margin 只挪动整组，不改变金额行高度（卡片高度由内边距决定）。
					// 实测：marginTop -4 与 marginRight -3 时，圆点距卡片顶、右各 8px
					// （右侧不能按"内边距 10 − 8"去推，内边距本就含在行宽里）。
					// 非官方模型时整组不渲染：没有官方峰谷时段，倒计时与指示灯都无从谈起。
					// 数据还没到时也不渲染：不画一个假的倒计时。
					priced && h("span", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginLeft: "auto", flex: "0 0 auto", alignSelf: "flex-start", marginTop: -4, marginRight: -3 } },
						// 倒计时：距下次峰谷切换的剩余时间（`2d 15h` / `5h 47m` / `23m` / `switching`）。
						// 纯英文单位、无前缀，中英界面一致。
						// 字号/字重刻意与右下角单价数字对齐（继承卡片正文 12px、fontWeight 600），
						// 让右上角这行和右下角单价行是同一套文字样式。
						h("span", {
							style: {
								fontWeight: 600,
								color: C.sub,
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
						}, countdown),
						// 峰谷指示灯：颜色 + 无障碍名称（色盲与读屏用户靠它分辨峰/谷）。
						h("span", { style: dot, role: "img", "aria-label": data && data.peak ? t("status.peak") : t("status.idle") }))),
				// 单价行：当前档单价，恒靠右下角。非官方模型时整行不渲染
				// （内置价格表算出的数字与它们的实际账单无关）。
				// 放在正常流里（不绝对定位）：绝对定位的行不参与卡片高度计算，余额位数一多
				// （¥1234567.89）单价行就压到余额文字上，圆点也被挤出卡片右边界。
				// marginTop:-10 把这一行提到金额行下方的空档里，卡片高度与原来一致，
				// 文字行之间仍留有间距。
				// 用 flex-end 而不是 space-between：容器只有一个子元素时 space-between 会把它
				// 推到最左侧（0.6.0 的回归点）。
				priced && h("span", {
					style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, minWidth: 0, marginTop: -10 },
				},
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, flex: "none" } },
						Price(h(IconIn, null), t("price.input"), tier.input),
						Price(h(IconCache, null), t("price.cache"), tier.cacheRead),
						Price(h(IconOut, null), t("price.output"), tier.output))));
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots", "remote", "locale"];

		function apply(ctx) {
			// 注册 i18n 词典（DSH locale 服务；不可用时组件回退中文）。
			// 用 ctx.effect 管理生命周期：插件卸载时词典随之撤销。
			try {
				if (ctx.effect && ctx.locale && typeof ctx.locale.register === "function") {
					ctx.effect(
						() => ctx.locale.register(NS, { zh: ZH, en: EN }),
						"dsh-deepseek-usage: dictionaries",
					);
				} else if (ctx.locale && typeof ctx.locale.register === "function") {
					ctx.locale.register(NS, { zh: ZH, en: EN });
				}
			} catch (e) { /* 词典注册失败不影响卡片 */ }
			// 注入本包样式：footerActions 换行（卡片独占一行）。
			const tagId = "dsh-deepseek-usage";
			if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-deepseek-usage";
				style.dataset.pluginCss = tagId;
				style.textContent = 'div[class*="footerActions"]{flex-wrap:wrap}';
				document.head.appendChild(style);
			}
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "dsh-usage", order: 100, label: "DeepSeek 用量" },
				(props) => h(UsageCell, { wide: props.wide, ctx }),
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数透出（供 test/client-layout.test.mjs 直接做确定性断言，不必模拟计时器）。
		exports.__internals = { nextChange, isPeak, fmtCountdown, money, fmtPrice, currencySymbol, expandHolidayRanges, isHoliday };
		return module.exports;
	}
});
