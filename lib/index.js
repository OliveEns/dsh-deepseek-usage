/**
 * dsh-deepseek-usage — host half.
 *
 * 注册一个 HTTP 路由：
 *
 *   GET /api/deepseek-usage[?lang=zh|en]
 *   GET /api/deepseek-usage/holidays
 *
 * 返回（JSON）：
 *   {
 *     ok: true,
 *     balance: { isAvailable, total, currency },        // 官方余额接口（API Key）
 *     tier: { input, cacheRead, cacheWrite, output, model, known },
 *     next: { peak, at, ms },                           // 距下次峰谷切换（界面倒计时）
 *     peak,                                             // 当前是否高峰
 *     updatedAt, errors,
 *     pricing: { via, requested, provider, used, known } // 【内部诊断】界面不消费
 *   }
 *
 * 界面只使用 balance / tier / next / peak / errors：插件内部的取价路径属于诊断信息，
 * 保留在响应里供排查与测试，但不出现在 UI 上。
 * errors 只放"用户能理解且需要行动"的余额类失败，不含任何上游原文——上游错误消息
 * 可能带着凭据片段（undici 会把非法的 Authorization 值写进异常消息），直接透出等于
 * 把 Key 印在侧边栏上。
 *
 * `lang` 参数（zh 默认）只影响错误消息的语言；UI 其余文案由 client 端本地化。
 *
 * 单价数据源：lib/pricing.js 的内置 PRICE_TABLE（DeepSeek 官方峰谷定价快照）。
 * 官方调价时随插件版本更新该表——不联网抓取、不读写本地价格配置文件。
 * 只有官方路由（provider 见 pricing.js 的 OFFICIAL_PROVIDERS）上的官方模型才计价：
 * 第三方路由上的 deepseek-* 同名模型按各自规则扣费，用官方表算出来的数字与账单无关。
 *
 * 数据源：余额来自 DeepSeek 官方 GET /user/balance（API Key 经凭证服务解析，
 * 与 llm-deepseek 同一引用，不出本机）。本插件仅支持 DeepSeek 官方平台余额显示。
 *
 * 安全：路由只接受本机来源（见 isTrustedRequest）——与 DSH 自身的 /api 栅栏同一
 * 口径：Host 必须是回环地址或本监听器绑定的地址，跨站请求标记与异源 Origin 一律拒绝。
 * 另见 README 的"已知限制"：本机其它进程仍可直接访问该端口，这是本地工具的固有边界。
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  DEFAULT_MODEL,
  HOLIDAY_RANGES,
  hasHolidayCoverage,
  isPeak,
  nextChange,
  unitAt,
} from "./pricing.js";

const name = "dsh-deepseek-usage";
const inject = ["credentials", "webServer"];

const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** 与 llm-deepseek 适配器对齐的环境变量覆盖。注意：指向第三方网关时 API Key 会发给该地址。 */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const API_KEY_REF = credentialRef("DEEPSEEK_API_KEY");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/deepseek-usage";
/** 放假日期路由（浏览器侧启动拉一次，保证两边同一份日期表）。 */
const HOLIDAYS_PATH = "/api/deepseek-usage/holidays";
const TIMEOUT_MS = 15000;
/** 余额响应体上限：网关返回异常大 body 时不让它占满内存。 */
const MAX_BODY_BYTES = 64 * 1024;
/**
 * 余额快照缓存时长（毫秒）。客户端每 30s 心跳一次，多个标签页/多次点击会重复打
 * 官方余额接口；缓存把这段时间内的重复请求合并成一次。
 */
const BALANCE_CACHE_MS = 10_000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/**
 * 错误消息字典（zh/en）。只保留"余额为什么拿不到"这类用户能理解、且需要行动的
 * 信息；不拼接任何上游原文或异常消息。
 */
const MESSAGES = {
  zh: {
    noKey: "未配置 DEEPSEEK_API_KEY",
    badKey: "DEEPSEEK_API_KEY 含有非法字符",
    balanceHttp: (status) => `余额接口 HTTP ${status}`,
    balanceTimeout: "余额接口超时",
    balanceNetwork: "余额接口无法连接",
    balancePayload: "余额接口返回了无法解析的内容",
    balanceEmpty: "余额接口没有返回余额",
    balanceUnavailable: "账户当前不可用",
    forbidden: "仅允许本机访问",
    method: "仅支持 GET",
    internal: "插件内部错误",
  },
  en: {
    noKey: "DEEPSEEK_API_KEY is not configured",
    badKey: "DEEPSEEK_API_KEY contains invalid characters",
    balanceHttp: (status) => `Balance API HTTP ${status}`,
    balanceTimeout: "Balance API timed out",
    balanceNetwork: "Balance API is unreachable",
    balancePayload: "Balance API returned an unreadable response",
    balanceEmpty: "Balance API returned no balance",
    balanceUnavailable: "The account is currently unavailable",
    forbidden: "Local access only",
    method: "GET only",
    internal: "Internal plugin error",
  },
};

/**
 * 放假日期表未覆盖当前年份时告警一次（每天一次）。
 *
 * 在请求路径上检查，而不是只在启动时：进程跨年长跑时，下一年的节假日仍按工作日
 * 计价，而这正是用户真正会看到错误价格的时段——只在启动时告警覆盖不到那一刻。
 */
let lastHolidayWarningDay = "";
function warnHolidayCoverage(ctx) {
  if (hasHolidayCoverage()) return;
  const now = Date.now();
  const day = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (day === lastHolidayWarningDay) return;
  lastHolidayWarningDay = day;
  const year = new Date(now + 8 * 60 * 60 * 1000).getUTCFullYear();
  ctx.logger.warn(
    `dsh-deepseek-usage: 内置放假日期表未覆盖 ${year} 年（仅收录到 ${HOLIDAY_RANGES.at(-1)?.[1] ?? "未知"}）`
      + `，${year} 年法定节假日白天会被当作高峰时段：请按国务院办公厅通知更新 lib/pricing.js 的 HOLIDAY_RANGES`
      + `（并同步 lib/client.js 的镜像表，并把 HOLIDAY_TABLE_THROUGH_YEAR 推到 ${year}）`,
  );
}

function sendJson(res, status, body) {
  // 已经发过响应头时再写一次会抛 ERR_HTTP_HEADERS_SENT，直接结束即可。
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

/** 容忍字符串/数字，返回有限数或 NaN。 */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 请求头里的 Host 是否是"本机"。
 *
 * 接受：回环地址（127/8 任意地址、::1、localhost）、本监听器绑定的地址。
 * 与 DSH 自己的 /api 栅栏同一口径（见 app.asar 的 isTrustedApiRequest）：只认回环
 * 会让 `--host <局域网IP>` 与 `--trusted-host` 部署下插件永久 403。
 */
function isLocalHost(req, bindHost) {
  const raw = req.headers.host;
  if (typeof raw !== "string" || raw === "") return false;
  const host = hostNameOf(raw);
  if (host === null) return false;
  if (host === "localhost" || host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "::ffff:127.0.0.1") return true;
  // 监听器绑定的地址（如 --host 10.0.0.7）同样是"自己"。
  if (typeof bindHost === "string" && bindHost !== "") {
    const bind = hostNameOf(bindHost);
    if (bind !== null && bind !== "" && host === bind) return true;
  }
  return false;
}

/**
 * 取 authority 里的主机名：小写、去掉端口与 IPv6 方括号。
 * IPv6 不能按冒号切（`::1` 切出空串），所以先剥方括号再处理。
 */
function hostNameOf(authority) {
  let host = authority.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return null;
    host = host.slice(1, end);
    return host;
  }
  const idx = host.lastIndexOf(":");
  if (idx !== -1 && host.indexOf(":") === idx) host = host.slice(0, idx);
  return host === "" ? null : host;
}

/**
 * 请求是否可以访问本插件的路由。
 *
 * 口径与 DSH 的 /api 栅栏一致：
 *   1. Host 必须是本机（回环或监听器绑定地址）；
 *   2. 浏览器标记为跨站的请求一律拒绝；
 *   3. 带 Origin 时，Origin 必须与 Host 同一 authority。
 * 这样任意网页都无法跨站读走余额，DNS rebinding（Host 变成攻击者域名）同样被挡下。
 */
function isTrustedRequest(req, bindHost) {
  if (!isLocalHost(req, bindHost)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    const host = String(req.headers.host ?? "").toLowerCase();
    if (originHost !== host) return false;
  }
  return true;
}

/** 解析 ?lang= 参数。 */
function resolveQuery(req) {
  const url = req.url ?? "";
  const q = url.indexOf("?");
  const kv = q === -1 ? [] : url.slice(q + 1).split("&");
  let lang = "zh";
  for (const item of kv) {
    if (item === "lang=en" || item === "lang=en-US" || item === "lang=en-GB") lang = "en";
  }
  return { lang };
}

/**
 * API Key 是否能安全地放进 Authorization 头。
 * 凭据存储允许任意文本（多行值也是合法输入），而非法字符会让 undici 把整个
 * Authorization 值写进异常消息——那道消息会一路流到卡片上。
 */
function isUsableKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (key === "") return false;
  // HTTP 头值只允许可见 ASCII（不含空格与控制字符）。
  return /^[\x21-\x7e]+$/.test(key);
}

/** 余额响应体超限：与"无法解析"同一类问题。 */
class BalancePayloadError extends Error {}

/** 读取响应体，超过上限即视为失败。 */
async function readBoundedText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BalancePayloadError();
  const text = await response.text();
  // text.length 是 UTF-16 码元数；按字节算才不会让多字节内容绕过上限。
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new BalancePayloadError();
  return text;
}

/**
 * 取一次余额快照。
 *
 * @param key 已解析出的 API Key（调用方已做过形状校验）。
 * @returns {{ ok: boolean, balance: object, code: string|null, status?: number }}
 *   code 是失败分类（供 MESSAGES 选文案），成功时为 null。
 */
async function fetchBalance(ctx, lang, key) {
  const balance = { isAvailable: null, total: null, currency: null };

  let response;
  let text;
  try {
    response = await fetch(balanceUrl(), {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await readBoundedText(response);
  } catch (error) {
    if (error instanceof BalancePayloadError) {
      return { ok: false, balance, code: "balancePayload" };
    }
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, balance, code: "balanceTimeout" };
    }
    return { ok: false, balance, code: "balanceNetwork" };
  }

  if (!response.ok) return { ok: false, balance, code: "balanceHttp", status: response.status };

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, balance, code: "balancePayload" };
  }

  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const first = infos[0] || {};
  const total = toFinite(first.total_balance);
  balance.isAvailable = body?.is_available !== false;
  balance.currency = typeof first.currency === "string" ? first.currency : null;
  // total 缺失或非法时保留 null，由调用方当成"没拿到余额"，不要写 NaN（JSON 会变成
  // null，客户端 Number(null) 是 0，会把"读不到"显示成"余额 0 元"）。
  balance.total = Number.isFinite(total) ? total : null;
  if (balance.total === null) return { ok: false, balance, code: "balanceEmpty" };
  if (balance.isAvailable === false) return { ok: false, balance, code: "balanceUnavailable" };
  return { ok: true, balance, code: null };
}

/**
 * 余额快照缓存：同一时间窗内多个请求（多标签页、点击、心跳）共用一次上游调用。
 *
 * 只缓存成功结果——失败必须立刻能被下一次请求重试。缓存与在途请求都按 Key 值
 * 分桶：换了 Key 就不会命中旧 Key 的缓存，也不会复用旧 Key 的在途请求
 * （否则会短暂显示上一个 Key 的余额）。
 */
const balanceCache = new Map();
const balanceInFlight = new Map();

/** 丢掉过期的缓存条目：换 Key 频繁时 Map 会一直长。 */
function evictStaleCache(now) {
  for (const [key, entry] of balanceCache) {
    if (now - entry.at >= BALANCE_CACHE_MS) balanceCache.delete(key);
  }
}

async function readBalanceCached(ctx, lang) {
  const now = Date.now();
  let key = "";
  try {
    const hit = await ctx.credentials.resolve(API_KEY_REF);
    if (hit === void 0) return { ok: false, balance: { isAvailable: null, total: null, currency: null }, code: "noKey" };
    key = typeof hit.value === "string" ? hit.value.trim() : "";
  } catch {
    return { ok: false, balance: { isAvailable: null, total: null, currency: null }, code: "balanceNetwork" };
  }
  if (!isUsableKey(key)) {
    return { ok: false, balance: { isAvailable: null, total: null, currency: null }, code: "badKey" };
  }
  evictStaleCache(now);
  const cached = balanceCache.get(key);
  if (cached !== undefined && now - cached.at < BALANCE_CACHE_MS) return cached.value;
  const pending = balanceInFlight.get(key);
  if (pending !== undefined) return pending;
  const request = fetchBalance(ctx, lang, key)
    .then((value) => {
      if (value.ok) balanceCache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      balanceInFlight.delete(key);
    });
  balanceInFlight.set(key, request);
  return request;
}

function apply(ctx) {
  const bindHost = typeof ctx.webServer?.host === "string" ? ctx.webServer.host : "";

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: HOLIDAYS_PATH,
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "method", message: MESSAGES.zh.method });
        }
        if (!isTrustedRequest(req, bindHost)) {
          return sendJson(res, 403, { ok: false, error: "forbidden", message: MESSAGES.zh.forbidden });
        }
        sendJson(res, 200, { ok: true, ranges: HOLIDAY_RANGES });
      },
    }),
    "dsh-deepseek-usage: holidays route",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, 405, { ok: false, error: "method", message: MESSAGES.zh.method });
          }
          // ---- 仅本机访问：拦截 DNS rebinding、跨站读取与局域网直连 ----
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: MESSAGES.zh.forbidden });
          }

          const { lang } = resolveQuery(req);
          const msg = MESSAGES[lang] || MESSAGES.zh;

          // 放假日期表过期时告警（每天一次）。放在请求路径上，跨年长跑也能覆盖到。
          try {
            warnHolidayCoverage(ctx);
          } catch { /* 告警失败不影响卡片 */ }

          // ---- 当前模型当前档单价（展示用）----
          let model = DEFAULT_MODEL;
          let provider = "";
          try {
            const adm = ctx.get("agentDefaultModel");
            const selection = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
            if (selection && typeof selection.model === "string") model = selection.model;
            if (selection && typeof selection.provider === "string") provider = selection.provider;
          } catch {}
          // 时刻在余额请求之后再取：请求耗时会跨过峰谷边界，先取会让 peak / 单价 /
          // 倒计时三者互相矛盾（显示橙色高峰灯却给着空闲价）。
          const now = Date.now();
          const unit = unitAt(model, now, provider);

          const errors = [];

          // ---- 余额（官方接口，API Key）----
          const snapshot = await readBalanceCached(ctx, lang);
          const balance = snapshot.balance;
          if (!snapshot.ok) {
            const code = snapshot.code;
            errors.push(
              code === "balanceHttp"
                ? msg.balanceHttp(snapshot.status)
                : typeof msg[code] === "function"
                  ? msg[code]()
                  : msg[code] ?? msg.balanceNetwork,
            );
          }

          // ---- 距下一次峰谷切换（界面用它在指示灯旁显示倒计时）----
          const next = nextChange(now);

          sendJson(res, 200, {
            ok: true,
            balance,
            peak: isPeak(now),
            //   peak = 切换后所处的时段，at = 切换时刻，ms = 剩余毫秒
            next,
            tier: {
              input: unit.input,
              cacheRead: unit.cacheRead,
              cacheWrite: unit.cacheWrite,
              output: unit.output,
              model: unit.model,
              known: unit.known,
            },
            // 【内部诊断】取价路径：界面不再展示（卡片去技术化），保留字段
            // 供排查问题与回归测试使用。
            pricing: {
              via: unit.via,                        // exact | alias | fallback
              requested: unit.requested,            // 当前启用的模型 id
              provider: unit.provider,              // 当前路由的 provider id
              used: unit.model,                     // 实际取价使用的模型 id
              known: unit.known,                    // false = 不计价，界面隐藏单价
            },
            updatedAt: now,
            errors,
          });
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-usage: request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, {
            ok: false,
            error: "internal",
            message: MESSAGES.zh.internal,
          });
        }
      },
    }),
    "dsh-deepseek-usage: route",
  );
}

export { name, inject, apply };
