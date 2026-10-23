# @dougen/dsh-deepseek-usage

<!-- 渲染器会给标题 id 加 `user-content-` 前缀（npm 页面、GitHub 都是），跳转链接要用带前缀的锚点 -->
[中文文档](#user-content-中文文档)

A sidebar plugin for the **DeepSeek Harness (DSH) Web UI** that answers two questions without leaving the app: **how much balance is left**, and **what the model costs right now** — the second one for official DeepSeek models, whose prices the built-in table and DeepSeek's peak/off-peak windows cover.

![DeepSeek usage card / 用量卡片](https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot.png)

## What it does

- **Balance** in the sidebar footer: your DeepSeek account balance (the symbol follows the account currency: `¥` / `$`).
- **Unit prices of the active model**: input / input cache / output for the billing window in effect right now. They change when you switch models and when the peak/off-peak window flips.
- **Peak / off-peak dot with a countdown**: orange during peak hours (Mon–Fri, excluding Chinese public holidays, 9:00–12:00 and 14:00–18:00 Beijing Time), green otherwise — weekends, public holidays and the make-up workdays that fall on a weekend are all off-peak; next to it, the time left until the next switch (`2d 15h`, `5h 47m`, `23m`).
- **Unit prices and the peak/off-peak dot are for official DeepSeek routes only.** The plugin prices a model only when it is served by DeepSeek's own route (`deepseek-official` / `deepseek-account`) *and* its model id is in the built-in table. A third-party route that happens to offer a model called `deepseek-flash` is priced by its own contract, so the built-in table and DeepSeek's peak/off-peak windows do not apply to it — the card then shows the balance alone, because any figure derived from them would not match your bill. An official model that is newer than this plugin release is also left unpriced until the table catches up.
- Refreshes every 30 seconds, and immediately when you click the card or switch models. Follows the app light/dark theme and the DSH language (Chinese / English).
- While the first response is still in flight the card shows a placeholder (`—`) rather than a number it does not have yet.

## DSH compatibility

| DSH | Plugin version |
| --- | --- |
| `0.2.x` (`0.2.0-rc.1` and later) | `0.11.0` and later |
| `0.1.x` (`0.1.0-rc.6` and later) | `0.10.x`, or `0.11.0` and later |

`dsh --version` prints your DSH version. Installing without a version picks the newest compatible release; name an exact version (`@dougen/dsh-deepseek-usage@0.10.2`) when the newest does not match your DSH.

## Install, uninstall, common errors

### Install

1. Configure `DEEPSEEK_API_KEY` in DSH (model settings).
2. `dsh plugin --profile web add @dougen/dsh-deepseek-usage`
3. Restart `dsh web` and open the URL it prints — the card sits at the bottom of the sidebar, below the Cordis panel button.

### Uninstall

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

Then restart `dsh web`.

### A blank card means the balance could not be read

The card then shows the reason instead of numbers:

- **`DEEPSEEK_API_KEY` is not configured** — set it in DSH settings and restart.
- **The key contains characters an HTTP header cannot carry** (a stray newline from a copy-paste) — re-copy it without the line break.
- **The balance request failed or timed out** — click the card to retry.
- **The account is reported as unavailable** — the balance API answered, but with `is_available: false`.
- **`DEEPSEEK_BASE_URL` points at a third-party gateway** — the official balance endpoint `https://api.deepseek.com/user/balance` may be unavailable or answer differently; only DeepSeek's official platform is supported.

The card never shows an upstream error message verbatim: transport details stay in the host's log, and the card carries a short, actionable line instead.

### Prices differ from the official page

- Prices are the built-in table `PRICE_TABLE` in `lib/pricing.js`, a snapshot of the official pricing page. It changes only when a new version of the plugin ships — there is no local price file and no background sync.
- The card shows unit prices and the peak/off-peak dot only for a model served by DeepSeek's own route (`deepseek-official` / `deepseek-account`) whose id is in the table (`deepseek-flash`, `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner` and the legacy names). A third-party route offering a model with the same name is priced by its own contract, so the card hides both instead of showing a figure that would not match your bill.
- An official model newer than this plugin release is not in the table either, and the card hides prices for it until the table is updated — the plugin does not guess a price from the model name.
- Off-peak days come from the holiday table `HOLIDAY_RANGES` in `lib/pricing.js`. The State Council usually publishes next year's arrangement in November; update it then, together with `HOLIDAY_TABLE_THROUGH_YEAR`. Until you do, holidays are treated as ordinary workdays and the card shows peak prices during them; the host logs a warning once a day while the table does not cover the current year.

## How it works

- The **host half** (`lib/index.js`, `lib/pricing.js`) registers `GET /api/deepseek-usage`. Per request it reads the API key from DSH credentials, asks the official balance API, resolves the active model's price from the built-in price table, and answers with balance, tier prices, the peak flag and the next switch time. `GET /api/deepseek-usage/holidays` hands the browser half the same public-holiday table.
- The **browser half** (`lib/client.js`) renders that answer into the `sidebar.footer.action` slot, re-reads it every 30 seconds, and refreshes on click or on a model change. The peak state and the countdown come from the same answer, so the card itself holds no pricing logic.
- The two routes answer only to local callers: the `Host` header must name a loopback address (or the address the server is bound to), cross-site browser requests and foreign `Origin` headers are refused, and only `GET` is accepted. A local process on the same machine can still read the route — that is inherent to a local tool.

---

## 中文文档

一个 **DeepSeek Harness（DSH）网页界面**的侧边栏插件：不离开 DSH 就能知道**账号还剩多少钱**；当前用的是 DeepSeek 官方模型时，还能看到**它现在什么价**——内置价格表与官方峰谷时段覆盖的正是这些模型。

### 这个插件做什么

- **余额**：侧边栏底部显示 DeepSeek 账号余额（符号随账号币种 `¥` / `$`）。
- **当前模型的档单价**：输入 / 输入缓存 / 输出，按此刻生效的计费时段显示；切换模型、跨过峰谷切换点时会跟着变。
- **峰谷指示灯 + 倒计时**：高峰（周一至周五、不含中国法定节假日，9:00–12:00、14:00–18:00 北京时间）橙色，其余时间绿色——周末、法定节假日全天，以及调休上班的周末都是空闲；指示灯旁给出距下次切换的剩余时间（`2d 15h`、`5h 47m`、`23m`）。
- **档单价与峰谷指示灯只对 DeepSeek 官方路由上的官方模型显示**。只有模型由 DeepSeek 自有路由（`deepseek-official` / `deepseek-account`）提供、且模型 id 在内置表里，卡片才给价。第三方路由上恰好也叫 `deepseek-flash` 的模型按它自己的合约计费，内置价格表与官方峰谷时段对它不成立，卡片只显示余额——据此算出的数字与实际账单不符。比本插件版本更新的官方模型同样不估价，直到价格表更新：插件不会按模型名猜价格。
- 每 30 秒自动刷新；点击卡片或切换模型时立即刷新。跟随应用明暗主题与 DSH 语言（中文 / English）。
- 第一次响应还没回来时，卡片显示占位符 `—`，而不是一个它并不拥有的数字。

### DSH 版本对应关系

| DSH | 插件版本 |
| --- | --- |
| `0.2.x`（`0.2.0-rc.1` 起） | `0.11.0` 及以后 |
| `0.1.x`（`0.1.0-rc.6` 起） | `0.10.x`，或 `0.11.0` 及以后 |

`dsh --version` 查看当前 DSH 版本。不带版本号安装会取最新的兼容版本；最新版与你的 DSH 不匹配时，用 `@dougen/dsh-deepseek-usage@0.10.2` 这样的完整版本号指定。

### 安装、卸载与常见错误

安装：

1. 在 DSH 设置（模型页）里配置 `DEEPSEEK_API_KEY`。
2. `dsh plugin --profile web add @dougen/dsh-deepseek-usage`
3. 重启 `dsh web`，打开它打印的地址：卡片位于侧边栏底部、Cordis 面板按钮下方。

卸载：

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

然后重启 `dsh web`。

卡片空白说明余额没读到，此时卡片会写明原因：

- **没有配置 `DEEPSEEK_API_KEY`**：在 DSH 设置里配置后重启。
- **Key 里含有 HTTP 头带不了的字符**（比如粘贴时带进一个换行）：重新复制，去掉换行。
- **余额接口失败或超时**：点击卡片重试。
- **账户当前不可用**：余额接口有响应，但 `is_available` 为 false。
- **`DEEPSEEK_BASE_URL` 指向第三方中转**：官方余额接口 `https://api.deepseek.com/user/balance` 可能不可用或返回异常，本插件只支持 DeepSeek 官方平台。

卡片不会原样显示上游的错误消息：传输层细节留在宿主日志里，卡片上只放一句简短、能行动的话。

价格与官方不一致时：

- 价格是 `lib/pricing.js` 的内置表 `PRICE_TABLE`（官方价格页的快照），只在发布新版本时更新——没有本地价格文件，也没有后台同步。
- 只有当前模型由 DeepSeek 自有路由（`deepseek-official` / `deepseek-account`）提供、且模型 id 在内置表里（`deepseek-flash`、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner` 及旧名），卡片才显示档单价与峰谷指示灯；第三方路由上同名模型按它自己的合约计费，没有官方峰谷定价，卡片把这两项都隐藏，而不是显示一个与实际账单不符的数字。
- 比本插件版本更新的官方模型同样不在表里，卡片会隐藏价格，直到价格表更新——插件不按模型名猜价。
- 放假日期维护在 `lib/pricing.js` 的 `HOLIDAY_RANGES`。国务院办公厅通常在前一年 11 月发布次年安排，届时更新，同时把 `HOLIDAY_TABLE_THROUGH_YEAR` 往前推一年；未更新前，节假日会按普通工作日处理，白天显示高峰价，宿主日志会每天提醒一次。

### 简单的工作原理

- **宿主侧**（`lib/index.js`、`lib/pricing.js`）注册 `GET /api/deepseek-usage`：每次请求读取 DSH 凭据里的 API Key、调用官方余额接口、从内置价格表解析当前模型档单价，返回余额、档单价、峰谷状态与下次切换时刻；`GET /api/deepseek-usage/holidays` 把同一份法定节假日表交给浏览器侧。
- **浏览器侧**（`lib/client.js`）把这份响应渲染进 `sidebar.footer.action` 槽位，每 30 秒重新读一次，点击卡片或模型变化时立即刷新；峰谷状态与倒计时同样来自这次响应，界面自身不做计价逻辑。
- 两条路由只回答本机请求：`Host` 必须是回环地址（或服务器绑定的地址），跨站浏览器请求与异源 `Origin` 一律拒绝，只接受 `GET`。同一台机器上的本地进程仍能读到该路由——这是本地工具的固有边界。

## License

MIT
