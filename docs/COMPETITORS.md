# 竞品对照（2026-11）

本文件只写可核对的事实与差异，不写「我们更强」的结论。所有外部数字附来源，我们自己的数字来自同机测量（`docs/measure-competitors-2026-11.json`）。

## 一、ego(lite) / ego-browser——目前最直接的对手

来源：[仓库](https://github.com/citrolabs/ego-lite)（21.5k stars，MIT 发布 skill，浏览器本体是免费下载的独立应用）、[文档](https://lite.ego.app/document/)、[自测页](https://lite.ego.app/)。

它的结构：

- **自带一个 Chromium 分支**，跑成独立 app，不是插件；首次启动导入 Chrome 的 cookie / 登录 / 扩展 / 书签。
- **Space**：浏览器内隔离工作区，人一个、每个 agent 一个，互不抢标签页，可以并行。
- **ego-browser skill**：写进各 agent 的 skills 目录，agent 写一段 JS 调 `snapshot / fill / click / wait / navigate / capture`，一次执行多步；另有 `js()` 页内上下文与裸 CDP。
- **引擎层快照**：在自改的 Chromium 里生成语义快照，声称覆盖跨域 iframe、shadow DOM、第三方 widget。
- 官方文档里明确列了 **DeepSeek Harness** 的接法（Full access + 从本地 Web UI 调 `ego-browser`）——也就是说它把我们当成宿主之一，用户可以在「装 ego」和「用我们的栏」之间二选一。

它的自测（Real-World Bench，31 个真实站点任务，同一个 agent `pi` + `gpt-5.6-sol`，自建 rubric 判分）：398 s / 93.5% / $1.64 每任务；同场 playwright-cli 648 s / 71% / $3.42，browser-harness 615 s / 77.4% / $2.43，chrome-devtools-cli 587 s / 61.3% / $4.95。

**怎么读这组数字**：单次运行、无重复、判分方即产品方（页面自己也写明「Disclosure: we build ego(lite)」），而且「代码式调用」的优势主要来自把多步压进一次 JS 执行——那是协议形态的差异，不是快照质量的差异。它能证明「ego 在自家 rubric 下快」，不能证明「在任意任务上快」。我们不引用它当事实，只当对手的话术基线。

## 二、Codex 侧的浏览器操控，实际有三条路

1. **ChatGPT 桌面内置浏览器 + Computer Use**：Codex / ChatGPT Work 能开页、点、输、截图、验证，用 `@Browser` 引用。**Codex CLI 与 IDE 扩展没有这个浏览器**（[官方文档](https://developers.openai.com/codex/browser) 首行明写）。内置浏览器是**独立 profile**，不共享你日常标签页、cookie、登录。云浏览器同理不碰个人会话。
2. **浏览器扩展（Codex for Chrome）**：借用户真实的 Chrome / Edge / Brave 标签页，逐站点授权。
3. **外接工具**：[Playwright MCP](https://github.com/microsoft/playwright-mcp)（39.2k stars，可访问性树快照，官方自己建议 coding agent 改用 CLI+SKILLS 省 token）、[agent-browser](https://github.com/vercel-labs/agent-browser)（45.5k stars，Rust CLI + 后台 daemon + `@e1` ref）、[Browser Harness](https://github.com/browser-use/browser-harness)（18.9k stars，CDP 接真实 Chrome，agent 自己补 helper）。

这三条路的共同代价：**要么另起一个浏览器 / profile（丢登录态），要么在 Chrome 144+ 里开远程调试并「允许整个浏览器」（权限面很大）**，而且都发生在聊天窗口之外——用户看不见 agent 在点什么。

## 三、我们真实的位置

同一台机器、同一个本地 fixture、同一套 headless Chrome，2026-11-02 五方测量（`docs/BENCH.md`）：冷启 840 ms（Stagehand 760 / browser-use 713；0.47.13 五次重测中位 453 ms）、热标签页工具 42–54 ms、读取 2302 字符（Stagehand 21396 / browser-use 5662）、空闲 CPU 0.67 %（36–51 %）、空闲 RSS 459–552 MB（1265–1672 MB）、休止后唤醒 0.39–0.59 s。

工具面 40 个模型可见（`tools.js` 共导出 57 个）：`browser_open/view/read/find/click/type/key/scroll/drag/select/check/hover`、`browser_eval`、`browser_do`（一串动作一次调用）、`browser_network/console/failed/cookie/clipboard/downloads/tabs/dialog`、`browser_shot/pdf/grab`、`browser_login`、`browser_media`（流媒体拼接保存）、`browser_prepare/look`（canvas / 游戏 / Flash）、`browser_ask/review`。

**我们赢的地方（已测）**：拖拽跟手——50 点拖拽在 8 ms 门限下 45 点/秒、裸门限 46 点/秒、点间最大间隔 18–19 ms，改前 40 ms 门限只有 15 点/秒 / 52–61 ms（`node scripts/drag-rate.mjs`）；不装第二个浏览器、不导登录、不开远程调试、不申请 Full access；镜像就在会话右栏，人看得见 agent 在点什么；空闲几乎不耗电；读页面只有对手 1/2–1/9 的字符量。

**我们输的地方（必须承认）**：
- 高 DPI 镜像：0.47.60 起按面板缩放渲染（2× 面板拿到 1800×1400 帧），0.47.62 回退——覆盖态下这台 Chrome 按设备像素读指针，实测 2× 面板 (500,400) 落到 (250,200)。现在一律一 CSS 像素一图像像素：点得准，但 Retina / Windows 150% 上的小字仍被放大显示，这一档我们不如原生桌面浏览器。
- 快照深度：我们的 `browser_view/read` 走 DOM/可访问性树，**跨域 iframe 与 shadow DOM 里层没有专门处理**；ego 靠改引擎拿这块，这是它最硬的护城河。
- 并行：ego 的 Space 是多个隔离浏览上下文；我们是一个右栏 + 最多 6 个后台标签页，没有「每个 agent 一个隔离空间」的语义。
- 长任务的调用次数：ego 一次 JS 跑多步；我们的 `browser_do` 已能串步，但没有页内 helper 库，复杂流程仍是一步一调用。

## 四、超过它的四条线（按可验证性排序，不是按好听程度）

1. **把快照深度补齐到 iframe / shadow DOM**。用 CDP `DOM.getDocument({pierce:true})` + `Target.setAutoAttach({flatten:true})` 逐帧取树，与主文档合并，ref 带帧前缀。验收：一个三层嵌套 iframe + open shadow root 的本地 fixture，`browser_view` 能读到的可点元素数（现在 / 改后），并进 `scripts/`。这条达标后，「ego 快照更强」这句话就不成立一半。
2. **页内批量执行**。`browser_eval` 已存在，再加一组页内 helper（`click/fill/waitFor/snapshot` 组合）与 `browser_do` 的 `eval` 步骤，让复杂流程压进一次调用。验收：同一脚本任务（表单 + 校验 + 提交 + 读回）在两种形态下的**工具调用次数与字符数**，写进 BENCH。
3. **后台空间**：把 `MAX_TABS` 的 6 个标签页明确成「一个镜像 + 若干后台运行」，加会话级命名与切换（右栏只显示当前那个）。验收：3 个页面并行抓取的墙钟时间 vs 串行，并证明空闲 CPU 不上去。语义上不假装是 ego 的隔离 Space，如实说明是同一浏览器内的标签页。
4. **可复现的基准**。ego 的 31 任务 rubric 不公开、单次跑。我们把 `scripts/bench-actions.mjs` 扩成固定 fixture + 固定脚本 + N 次重复 + 每轮日志落盘，公开命令任何人可跑。赢法不是数字更大，是**别人能复核**——这正好打它最弱的地方。

顺带两条成本极低的：README 功能列表补上 pane 拖拽与右键；`docs/BENCH.md` 并入 r19/r20 的输入延迟证据。

## 五、不做什么

- 不做 Chromium 分支。改引擎意味着每次 Chrome 升级都要跟，且要在用户机器上装第二个浏览器——这恰好是我们所有优势的来源。
- 不做「Swarm 式」并行空间。右栏是全局唯一可见栏，硬造多个隔离空间会踩宿主会话规则。
- 不引用 ego 的自测数字当我们的落后证据，也不把它的 rubric 当行业标准。
