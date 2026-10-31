## 等到变化，而不是去问（0.38.0）

`browser_wait` 以前在宿主侧每 100 毫秒读一次页面判断条件，命中与否都被凑到下一个整拍上。
现在一次调用把谓词和 `MutationObserver` 交给页面，满足条件的那次变化直接 resolve，回程只走
一次。

| 同一件事 | 0.37.0（宿主轮询） | 0.38.0（页面观察） |
| --- | --- | --- |
| 五次不同时相的等待，平均耗时 | 205 ms | 140 ms |
| 每次等待的探测来回 | 3 | 1 |
| `idle` 判定 | 固定间隔重读页面 | 350 ms 无变化即停，一次来回 |

`wait-late` 行就是上表：每次实验在等待开始的同一刻给页面装一个定时器，所以旧路径必然要走到
下一个 100 毫秒整拍，新路径不必。预算 600 ms，实测 140 ms。

## 只列该看的那一个（0.37.0，同一台本地页面，加了两个广告请求）

页面自己放一个 `<video src="/movie.mp4">`、一个 `<audio>`、fetch 一个 master 播放列表，再 fetch 两条广告（`/ads/preroll.mp4` 9 MB、`/px/beacon.mp4` 2 B）。不筛选时 5 条都在；默认列表剩 3 条，页面播放器那个标 `main` 排第一，`save: main` 存的就是它。

| 项 | 0.36.0 | 0.37.0 |
|---|---|---|
| 列表行数（同一页面 5 条请求） | 5 | 3，广告单独一行说数量 |
| 首行 | `1. video 20 B · /movie.mp4` | `1. main video 156 B · /movie.mp4` |
| 找人要的那个 | 数行号 / 猜地址 | `save: main` |
| 列表耗时 | 0 ms（纯内存） | 1 ms（多一次页面查询拿播放器与时长） |

`media-pick` 1 ms，预算 `media-pick: 150 ms`；`all: true` 回到 5 行。`media-sniff` 仍 0 ms（记录仍是网络日志附带的），`media-save` 4 ms、96 B、`6 parts joined`，`budget checks 17 ok`。

## 媒体嗅探与流保存（0.36.0，本地 http 页面，`scripts/bench.mjs`）

页面自己放 `<video>`、`<audio>` 并 fetch 一个 master 播放列表：加载完的那一刻网络记录里已经有 3 条，`media-sniff` 0 ms（没有额外请求，嗅探就是已有的网络记录）。保存 master → 1080 → 6 个片段，`media-save` 5 ms、96 B，报 `6 parts joined`；列表首行 59 字符。预算 `media-sniff: 400 ms`、`media-save: 500 ms` 均通过，`budget checks 16 ok`。

## Flash 镜像按栏改窗口（0.34.48，Electron Flash 运行时，右栏 747×1196）

Flash 路径原来采集一个固定的 1440×900 窗口，竖高右栏里上下留黑边。现在 `setViewport` 直接改窗口大小，采集源与栏同比例。

| 状态 | 窗口 | 画面占栏 | 单帧 |
|---|---|---|---|
| 0.34.47 | 1440×900 | 约 39% | 126 KB |
| 0.34.48 | 747×1196 | 100% | 111 KB |

轮询帧率 9 fps 不变（Flash 桥上限），改的是画面比例与单帧体积。

## 动画页下行节流（0.34.47，真实 Chrome headless，720×880，canvas 60 fps 动画）

| 状态 | 帧率 | 单帧 | 下行带宽 |
| --- | --- | --- | --- |
| 0.34.46 全推 | 60 fps | 11 KB | 654 KB/s |
| 0.34.47 空闲节流 | 30 fps | 11 KB | 326 KB/s |
| 0.34.47 指针活动（1.5 s 内） | 58 fps | 11 KB | 631 KB/s |

节流只作用于下行：`latest`、`seq`、`still()` 与输入路径不变；`browser_shot` 仍走独立整帧截图。

## 坏页读取成本（0.34.46，构造页：`querySelectorAll` 抛错被读 150 字符）

| 读取结果 | 字符 | 约 token |
| --- | --- | --- |
| 0.34.46 一行故障说明 | 150 | 45 |
| 0.34.45 同一页读成 0 控件 0 字 | 20 | 6（但模型会重试或猜内容，整轮更贵） |

## 点击与多步延迟（0.34.45，headless Chrome，本地页）

| 场景 | 0.34.45 | 0.34.44 |
| --- | --- | --- |
| `browser_do` 单步 | 73 / 83 ms | 98 / 112 ms |
| 遮挡点击（自动清掉横幅） | 72 / 77 ms | 97 / 112 ms |
| `browser_do` 20 步 | 2035 ms（102 ms/步） | 2151 ms |
| 崩溃恢复（换新标签页） | 1390 ms | ~1.5 s |

做法：`Page.frameStartedLoading` / `frameStoppedLoading` 打时间戳，点击后若页面已 `complete` 且没有新加载开始，`settle()` 一次求值就返回；预算不变（点击 ≤ 220、遮挡点击 ≤ 240、单步 ≤ 240、每步 ≤ 280、崩溃恢复 ≤ 2600 ms）。

## 真实站点读页成本（0.34.44，headless Chrome，720×880 栏宽，`scripts/readcost.mjs`）

| 页面 | 读法 | 字符 | 估算 token | 控件 |
| --- | --- | --- | --- | --- |
| GitHub 仓库首页（rust-lang/rust） | text | 2562 | 754 | 90 |
| 同上 | links | 3763 | 1107 | 90 |
| GitHub Topics · computer-use | links | 2590 | 762 | 90 |
| 同上 | text | 1939 | 570 | 90 |
| GitHub 登录表单 | forms | 218 | 64 | 4 |
| 同上 | text | 533 | 157 | 13 |

- 读页本身 1–21 ms；`max_chars` 只对长页生效（links 4600→2200：3763→2800 字符，1107→824 token），短页两种预算结果一致。
- 空读取重试：内容在 700 ms 后才写入的页面，一次 `browser_view` 用 614 ms 拿到内容（此前直接读到空页）。正常页面不进入该分支，延迟与 token 不变。

## 故障归因的 token 成本（0.34.43）

| 场景 | 读取结果多出的内容 | 代价 |
| --- | --- | --- |
| 页面正常 | 0 字符 | 0 |
| 1 个 404 请求 + 1 个脚本错误 | 1 行，约 130 字符 | ≈33 token，替代 2 次排查调用（通常 ≥600 字符） |
| 同一页面再读 | 0 字符（已报过） | 0 |

## 点击与多步延迟（0.34.42，headless Chrome，本地页）

`node scripts/bench.mjs` 复现；末行 `budget` 是纳入退出码的预算断言。

| 场景 | 0.34.42 | 0.34.40 |
| --- | --- | --- |
| `browser_click` 普通页 | 97 ms | 439 ms |
| `browser_click` 横幅遮挡、自动清掉 | 107 ms | 593 ms |
| 被弹窗拦住的点击（拒绝） | 2 ms | — |
| `browser_do` 单步 | 95 ms | 440 ms |
| `browser_do` 20 步 | 2151 ms（108 ms/步） | 9067 ms |
| 崩溃恢复（换新标签页） | ~1.5 s | — |

预算：点击 ≤ 220 ms、遮挡点击 ≤ 240 ms、单步 ≤ 240 ms、20 步每步 ≤ 280 ms、崩溃恢复 ≤ 2600 ms。

## 点击与多步延迟（0.34.41，headless Chrome，本地页）

| 场景 | 耗时 |
| --- | --- |
| `browser_click` 普通页 | 141 ms |
| `browser_click` 横幅遮挡、自动清掉 | 235 ms |
| 被弹窗拦住的点击（拒绝） | 2 ms |
| `browser_do` 单步 | 131 ms |
| `browser_do` 20 步 | 3073 ms（154 ms/步） |
| 跟随点击开出的弹窗 | 22 ms |

`node scripts/bench.mjs` 复现；对照 0.34.40 的 439 / 593 / 440 / 9067 ms。

## 广度回归（0.34.40，headless Chrome，本地构造页）

`node scripts/breadth.mjs` — 66 项操作全通过：shadow DOM 读/点、表单输入/退格/清空、按字段名输入、下拉、勾选、提交、只读变化、画布编号与点选、截图尺寸、遮挡弹窗拒绝、失效 ref 跟随、断线恢复。

## 真实站点读页成本（0.34.39，headless Chrome，720×880 栏宽）

| 页面 | 字符 | 估算 token | 控件 |
| --- | --- | --- | --- |
| example.com | 976 | 305 | 1 |
| GitHub Topics · computer-use | 约 1.5k | 约 470 | 90 |

读页脚本此前因正则转义缺失整段无法解析，同一测例读出 0 控件 0 字符；修好后为上面数字。

## 读页 token 成本（0.34.38，构造页：300 行链接，字符预算 24000 以排除截断）

| 读法 | 字符 | 估算 token |
| --- | --- | --- |
| 列出全部控件（旧） | 9153 | 2860 |
| 控件折叠到 140 行（新） | 4277 | 1337 |

正文不再被编号挤到预算之外；被折叠的控件滚动后重新出现。

## 长文本输入延迟（0.34.37，真实 Chrome headless）

| 目标 | 方式 | 314 字符耗时 | 文本一致 |
| --- | --- | --- | --- |
| `<textarea>` | 逐键 `dispatchKeyEvent` | 1686 ms | 是 |
| `<textarea>` | 一次 `Input.insertText` | 2 ms | 是 |
| `contenteditable` | 一次 `Input.insertText` | 13 ms | 是 |

## 右栏尺寸下的镜像带宽（0.34.36，真实 Chrome headless，720×880）

| 页面 | 3–4 s 内帧数 | 帧率 | 平均单帧 | 带宽 |
| --- | --- | --- | --- | --- |
| 静态真实站点（example.com） | 3 | <1 fps | 47 KB | 47 KB/s |
| 注入 `requestAnimationFrame` 动画 | 181 / 3 s | ~60 fps | 15 KB | 875 KB/s |

结论：静止页面几乎不花带宽（Chrome 的 screencast 只在合成器变化时发帧）；满帧动画按列宽排版后单帧只有 15 KB，60 fps 总计约 875 KB/s，走本机 SSE 无压力，不设帧率上限以免牺牲延迟。「同一张图不重复发」这道闸真正省掉的是 Flash 轮询分支与 `still()` 连发（单测：3 次连发 → 1 张）。

## 镜像按右栏尺寸排版（0.34.35，真实 Chrome，`--headless=new`）

页面不再按 1440×900 排版，而是按右栏实测的尺寸排版；下表的 `inner` 是页面自己报告的 `innerWidth×innerHeight`，证明不是缩放图片而是重新排版。

| 请求尺寸 | 页面 inner | `Emulation.setDeviceMetricsOverride` + 重开 screencast | 一张整帧 `captureScreenshot` | 整帧 JPEG（纯色测试页） |
| --- | --- | --- | --- | --- |
| 720×880 | 720×880 | 41 ms | 39 ms | 11.7 KB |
| 520×1000 | 520×1000 | 34 ms | 33 ms | 11.3 KB |
| 1440×900 | 1440×900 | 49 ms | 47 ms | 17.4 KB |

冷启动到可排版 827 ms。点击链路在同一尺寸下实测：两次 `Input.dispatchMouseEvent`（按下+抬起）13 ms，页面 `mousedown` 处理器已计数，订阅后下一帧 8 ms 内到达。

## Phase 46 — 开玩前的体检，0.34.30

`npm run ready [url]` 跑新工具 `browser_prepare`，整条链路一次调用，自带 Chrome、跑完关掉：

| 页面 | 调用耗时 | 找到的输入面 | 帧率 | 按键 |
| --- | --- | --- | --- | --- |
| 4399《怪物小汽车》 | 3297 ms | frame 748×336（在屏幕外，先滚进来再点） | 页面 58 fps / 框架 59 fps | 没进到框架，工具直说「先点进框架一次」 |
| 奥拉星 `http://aoqi.100bt.com/` | 573 ms | — | — | —，地址已连不上，返回 Chrome 错误页说明 |

`browser_prepare` 的判断顺序：连不上就直说 → 读页面 → 挑画布/框架（优先屏幕内的，否则滚进视野）→ 有 Flash 影片就说这个浏览器放不了 → 数帧率（页面与最大的框架各数一遍）→ 派一个真键看它是否真的到达框架 → 一行结论。

## Phase 45 — 两种操作方式的实际差别，0.34.29

同一张本地页（按钮 + 输入框，页面在捕获阶段记下每个事件的类型和 `isTrusted`），`npm run modes`：

| 路径 | 受信任事件 | pointerdown | click | keydown | input | 写进值 |
| --- | --- | --- | --- | --- | --- | --- |
| human 点按钮 | 3 | 1 | 1 | – | – | – |
| dom 点按钮 | 0 | 1 | 1 | – | – | – |
| human 输入 abc | 11 | – | – | 3 | 3 | abc |
| dom 输入 abc | 0 | – | – | 0 | 1 | abc |

`trustedEvents` 是这张表里唯一真正的分界：真人路径全为 true，`dom` 路径全为 false。要过反自动化、要看指针轨迹、要按键有 `code` 的游戏，只有 human 能走；被浮层盖住、被脚本接管了按键的登录框，`dom` 一次就过。

## Phase 44 — 真站页游场地，0.34.28

`node scripts/check-game.mjs <url>`，真 Chrome、自己的 profile、跑完自己关掉。两个真站：

| 站点 | 空闲时页面刷新 | 全屏截图（`browser_shot` 同类）| 按住 `d` 200 ms 到达页面 |
| --- | --- | --- | --- |
| 奥拉星 `http://aoqi.100bt.com/` | **27 fps** | 中位数 **68 ms** | 是 |
| 4399 `https://www.4399.com/` | **59.8 fps** | 中位数 **148 ms** | 是 |

两个落地页都**没有 canvas**：游戏本体在链接后面，要么登录要么再点进去一层，所以这组数字说明的是「真站能不能实时跑」，不是「游戏画面已经能读」。

诚实的一层：按键到达页面这件事在真站已经证实（页面自己记录的 `keydown`/`keyup`），但 4399 这种整屏重绘的页面，一张全屏图 1.8 MB、148 ms —— 做实时画面要压、要裁、要降缩放，这一层还没做，别拿它当「已经能玩」。

## Phase 43 — 页游级输入：按住、组合键、按住鼠标，0.34.26

本地画布页（每帧重绘，页面自己记录 `keydown`/`keyup`/`pointerdown`/`pointerup` 时间戳），真 Chrome，`node scripts/bench.mjs`：

| 项 | 数字 |
| --- | --- |
| `browser_key` 带 `hold_ms: 300` 整次调用 | **305 ms**（含 300 ms 按住，收尾 5 ms） |
| 页面测到的按住时长 | **301 ms** |
| `ArrowLeft+ArrowUp` | 两键都收到 `keydown`，都收到 `keyup`，顺序为倒序松开 |
| `browser_click` 带 `hold_ms: 200` 页面测到 | **211 ms** |

对照 0.34.25 之前：同样的按住被 `settle` 拖到 727 ms，等于 0.7 s 才走一步——页游里这就是掉帧。

## Phase 42 — the reload path, proved by two instances, 0.34.25

`npm run adopt`（真 Chrome，临时 profile `adopt-check`，临时状态目录）：

| 项 | 数字 |
| --- | --- |
| 第一个实例冷启动到页面可用 | 675 ms |
| 第二个实例（模拟重载后的半边）接管 | 162 ms |
| 第二个实例自己起的 Chrome | `null`（没有起第二个） |
| 浏览器进程 | 同一个 pid，接管后仍活着 |
| 页签与标题 | `title: "kept"`，内容原样 |

这就是重载后「接回同一个浏览器、不重启、不丢页签和登录」的机器证据；之前只有手工重载才能走到这条路。

## Phase 41 — the read tool that had never run, 0.34.23

`node scripts/bench.mjs`（本机 headless 页面，Chrome 复用 `bench` profile）：

| 项 | 数字 |
| --- | --- |
| 首次画面（复用已在跑的浏览器） | 133 ms |
| 首帧字节 | 76 KB |
| 帧率 | 60 fps |
| 镜像延迟 | 中位 8 ms / 最大 8 ms |
| 遮挡检测 | 中位 3 ms / 最大 15 ms |
| 点一下（普通页 / 有遮罩，含读回） | 439 / 590 ms，遮罩那次 `cleared: true` |
| 一步 `browser_do` | 440 / 590 ms |
| 截图 | 73 ms / 115 KB |
| 读 dense 页 text 档 | 6 ms / 1484 字 / ≈436 token |
| 读 dense 页 forms 档 | 1 ms / 432 字 / ≈127 token |
| 再读同一页 | 1–2 ms，给出「没有变化」一行 |
| `changed_only` | 58 字 / ≈17 token（整页 1505 字） |

这轮 bench 的作用不是数字，而是**它第一次跑到 `browser_view` 就报 `ReferenceError` 退出**：那个工具在真实会话里同样会失败，而单测只测了它的纯函数部分。修完之后 bench 一次性跑完，数字在上面。

## Phase 40 — the poll that names its chat, 0.34.19

The adoption rule from 0.34.16 never fired for the column itself: the pane
polled `/sidecar/state` without a session, the host treated that as anonymous,
and a reload could still leave the mirror empty over a live browser. The pane now
names its chat, and asks again the moment a claim succeeds.

No performance change was expected; the full bench was re-run anyway so the
numbers under it are current (commit 0.34.19, local pages):

| Label | Value |
| --- | --- |
| launch → first frame | 1029 ms |
| steady stream | 60 fps, 76 KB per frame |
| mirror delay (12 samples) | median 9 ms, max 13 ms |
| dense page, text | 6 ms, 1484 chars, ≈436 tokens |
| dense page, forms | 2 ms, 432 chars, ≈127 tokens |

## Phase 39 — count what is on the screen, not what is in the DOM, 0.34.17

`readFrames` counts child frames; the page's own count filters to frames that
occupy the screen. Taking the larger made a hidden 1×1 frame claim a blind spot.

- `blindSpots` now lets the page's visible count win; the reader's count is the
  fallback for when the page could not count.
- Live: two frames (400×300 and 1×1) → `blind.frames` 1, exactly one line.

## Phase 38 — a reload must not blank the mirror, 0.34.16

`/sidecar/state` answered from the new plugin instance, which owns nothing until
something calls `open`: after a reload the owning chat's own poll said
`alive:false`, hence "no page open" in the column while Chrome was fine.

- The owning chat's state poll adopts the running browser and the tab remembered
  for it before answering.
- Live: `/dsh-unlag/reload` 200 → state `alive True`, url `https://www.doubao.com/chat/`,
  Chrome pid 12833 with 11 m uptime, i.e. attached rather than relaunched.
- Non-owning chats and empty `session` polls still answer without spawning anything.

## Phase 37 — an observation that admits its blind spot, 0.34.15

A text read and a screenshot claim to show the page. Both are lossy, and the loss
was silent: a chart wired as `<canvas>`, a generated image with no alt text, a
video, a cross-origin frame — nothing in the text said "there is something here
you cannot read". A model then planned as if the page were fully described.

- `readPage` counts the unreadable visible things on the page and in frames, and `renderPage` prints exactly one line when the count is non-zero; zero adds no line (measured token cost of the feature is 0 on pages that have nothing to hide).
- `chrome-error://` is no longer rendered as an empty page: it says the page did not load and names `browser_nav`.
- `navigate` retries that error page once (300 ms + 8 s cap). Cold launch on a fresh profile: first navigation recovered on the retry; an unreachable host still returns `bad` in well under the cap.
- `browser_shot` without an image channel appends what the result is missing and which tool fills it; file path alone is no longer the whole answer.
- Suite: 101 tests, 0 failures.

## Phase 36 — a reload must not cost the browser, 0.34.14

- 根因：交接看门狗 `while kill -0 ${process.pid}` 盯的是插件实例 pid，`dsh-unlag` 重载换 pid 后看门狗立刻 kill 共享 Chrome —— 镜像白屏、会话掉回 about:blank。
- 改为盯应用 pid（`ps -o ppid=` 向上走到顶）+ `watcher.json` 去重；实测 node 14185 的应用 pid 是 13663。
- `ensure()` 无活页面时回落到 `rememberedTab(id)`，首开即回原地址。
- 测试 97 条全绿。

## Phase 35 — a review round that can be checked off, 0.34.13## Phase 35 — a review round that can be checked off, 0.34.13

- `markRound()` 追加 verdict 行，`lastRound()` 折回 `marks`；`brief({already})` 只保留 open 条目，实测提问里出现「Already handled from your previous review」，已处理点不再重复。
- 工具面新增 `browser_review_verdict`（`mark: [{point,status,evidence}]`，状态枚举 fixed/verified/invalid/open）；越界编号丢弃、未知状态记为 open。
- 测试 92 → 96 条全绿。

## Phase 34 — one gate in front of every write, 0.34.12## Phase 34 — one gate in front of every write, 0.34.12

- `acting()` 统一 400（未命名会话）与 403（非持有者）；实测匿名 `POST /sidecar/nav` → 400 `which chat asked for it`，非持有者 `POST /sidecar/stop` → 403，持有者 `forget` → 200。
- 测试 90 → 92 条，全绿；文案与样式 lint 无 error。

## Phase 33 — a lost picture comes back in one click, 0.34.11

- 实测「切走 / 重载后画面没了」的下一步：`/sidecar/state?session=…` 与画面流 hello 都给出 `chat.remembered`（该会话最后地址）。
- 右栏在没有画面且 `remembered` 有值时显示「恢复上次的页面」，点击 POST `/sidecar/open` 并重连画面流。
- 同一会话第二次 open 命中已有标签页：107 ms（三次实测 2.08 s / 0.107 s / 0.108 s，首次含导航）。

## Phase 32 — a call log belongs to its chat, 0.34.10

`GET /sidecar/state` returned the last 40 mirror calls of every chat, each with
an eight-character session id: one conversation could read where another had
been browsing. The list is now filtered to the caller's own chat. The owner and
the list of listening chats stay global, because those are what the column needs
to claim the mirror.

## Phase 31 — a reload keeps the mirror, 0.34.9

`ctx.effect` cleanup ran `sidecar.shutdown()`, so each plugin reload closed
Chrome. The page disappeared from the column and the next open was a cold
start again. Cleanup now hands the browser to the next driver: cookies and a
login snapshot hit disk, the browser keeps running, and a detached watcher
closes it only after the app process is gone.

| after a `dsh-unlag` reload | before | now |
|---|---|---|
| browser | closed, page lost | still running, page kept |
| next interaction | cold launch (≈0.6 s, was 21 s) | attach, no launch |

## Phase 30 — a brand-new chat's first tab, 0.34.8

A fresh profile with no memory of a page means `openTab` asks for `about:blank`.
`navigate` then polled for a non-blank address, which a blank page never becomes,
and spent all 200 tries. Every first open of a new chat paid it.

| cold start, fresh profile (`about:blank`) | before | now |
|---|---|---|
| round 1 | 21 322 ms | 817 ms |
| round 2 | 20 882 ms | 607 ms |
| round 3 | 20 900 ms | 516 ms |
| page settings round trips | 4 | 1 |

Measured with three launches of `Sidecar#ensure` against a throwaway profile;
the first launch is now about 26× faster than before.

## Phase 29 — a stale session cookie is not written back, 0.34.7

`restoreSessionCookies` replayed every kept session cookie on launch, including
ones the browser already had. A rotated `sessionid` from the note would replace
the current one, and the site answers a retired session with a sign-in page.

| case | before | now |
|---|---|---|
| note holds sessionid, browser holds rotated one | old value written | nothing written |
| note holds a cookie the browser lost | written | written |
| cookie key | — | domain + path + name |

86 tests complete the suite in about 2 s.

## Phase 28 — one chat, one tab, even in parallel, 0.34.6

`tabFor` checked `pages`, then did async work, then wrote `pages`: two calls that
started together both missed the map and both opened a tab. The orphan tab kept
a live page nobody could see or stop.

| case | before | now |
|---|---|---|
| two parallel calls, cold chat | 2 tabs, 1 orphan | 1 tab |
| later call with another address | its own tab | same tab, navigated |
| leftover pending note | — | cleared in `finally` |

The fix is a per-chat promise in `opening`, joined by the second caller.

## Phase 27 — one gate for the mirror, 0.34.5

Three routes each carried their own copy of the ownership check. Copies drift:
a route added later is exactly the one nobody remembers to guard.

| case | result |
|---|---|
| rival chat → `/sidecar/input` | 403, owner named |
| rival chat → `/sidecar/nav` | 403, owner named |
| rival chat → `/sidecar/frames` | 403, no stream opened |
| unit tests | 84 |

The gate reads one function, so the question "may this chat act?" has one answer
in one place.

## Phase 26 — a screenshot the model can see, 0.34.3

Observation was structured text only: `browser_shot` wrote a PNG and returned
a path, which is a file name the model cannot look at. Codex and Claude Code
both hand screenshots back as image content, and that is the difference
between planning from the picture and guessing.

| case | before | now |
|---|---|---|
| route with image input | path only | path + image block, same call |
| route without image input | path | path, no image block, no error |
| no attachment store | path | path |
| read state across chats | one shared object | one per chat |
| unit tests | 79 | 81 |

Same-call cost: the PNG is already in memory for the file write, so the image
block adds one attachment save, no extra round trip and no second screenshot.

<!-- ui-copy-ignore -->
# Measured, not claimed

`node scripts/bench.mjs` on a local page, headless, profile of its own. One JSON
line per measurement; a phase is only done when its row improves.

Method: a dense page (20 inputs, 120 links, two buttons), a text page (~60
paragraphs), a light page. The dense page carries a viewport-fixed counter,
because Chrome sends screencast frames only for visible change — measuring an
idle page measures nothing.

## Baseline — 0.12.1, before phase 1

| What | Number |
| --- | --- |
| launch → first frame | 506 ms (cold profile) |
| steady mirror | 60 fps, 72 KB/frame |
| click → next frame | 13 ms |
| click round trip | 1 ms |
| key round trip | 13 ms |
| screenshot | 82 ms, 133 KB PNG |
| read: dense page | 4.7k chars ≈ **1383 tokens** |
| read: text page | 8.0k chars ≈ **2363 tokens** |
| read: light page | 69 chars ≈ 20 tokens |

Targets: dense read ≤ 1200 tokens, text read ≤ 1500 tokens with the useful part
kept, click → painted ≤ 120 ms (already 13 ms; the number to protect), and a
batch of five steps in one tool call.

## After phase 1 + 2 — read model v2 and batched steps

Same bench, same machine. Read numbers are what a model actually receives with
the default budget (4600 chars of page text).

| What | Baseline | Now |
| --- | --- | --- |
| read: dense page | 1383 tokens | **436** tokens (90 controls, 1.5k chars) — `links` 514, `forms` 127, `full` 624 |
| read: text page | 2363 tokens | **1130** tokens (screenful only, budget 4600) |
| read: light page | 20 tokens | 17 tokens |
| read round trip | ~30 ms | **1–4 ms** |
| refs across reads | new numbers every read | **stable** (same refs, ticker-only text changes) |
| click round trip | 1 ms | 1 ms |
| key round trip | 13 ms | 0–2 ms |
| launch → first frame | 506 ms | 129–539 ms (cold/warm profile) |
| steady mirror | 60 fps, 72 KB/frame | 60 fps, 76 KB/frame |
| screenshot | 82 ms / 133 KB | 79–86 ms / 115 KB |

The win is structural: the old read took `document.body.innerText` (8k chars on
the text page); the new one walks the viewport, dedupes parent text, numbers
controls with refs that survive reads, and caps the text at the budget. Reading
again returns the same numbers, so a batch of steps costs one read instead of
one per step.

## What one step costs the model

Measured on the live tool surface (`/tmp/probe6.mjs`, 2026-10-27). Before this
pass every action answered with a full page read; now it answers with one line
and reads only when `read: true` is passed.

| step | reply | ≈ tokens |
| --- | --- | --- |
| click | `ok click 1 · https://… · Title` (60 chars) | 18 |
| type | `ok type · https://… · Title · focus email = a@b.c` (77) | 23 |
| key | `ok Enter · https://… · Title` (65) | 20 |
| check | `I agree is now on` (17) | 6 |
| select | `chose Beta · https://… · Title · focus …` (65) | 20 |
| wait | `saw hello` (9) | 3 |
| console / failed | `error: message` or `no request failed` (17–47) | 6–14 |
| dialog | `alert: sure?` (12) | 4 |
| cookie | one line per cookie, up to 40 | — |
| full read (dense page) | 1484 chars | 436 |

A ten-step batch therefore spends ~150 tokens on confirmations instead of
~4 400, and the page itself is read once when it changes.

## Notes

- Screencast frames are change-driven. A page with nothing moving sends nothing;
  that is Chrome behaving, not the mirror failing. After an agent action the host
  should force one frame so the person sees the result of a step that changed
  nothing visible.
- A tall page whose only animation is below the fold produces no frames: the
  viewport is what is captured.

## Phase 3 — frames and popups, 0.13.0

Same bench, same page. Two changes landed: controls are capped at the read's own
`max` after viewport-first sorting (the cap was applied to candidates, not to the
answer), and a read now also asks for the frame tree.

| What | Before | After |
| --- | --- | --- |
| read: dense, `full` | 3118 chars, 142 controls ≈ 917 tokens | 2128 chars, 90 controls ≈ **626 tokens** |
| read: dense, `text` | 1510 chars, 142 controls ≈ 444 tokens | 1510 chars, 90 controls ≈ 444 tokens |
| read: text page | 13 ms | 13 ms (one frame-tree call, ~1 ms) |
| launch → first frame | 506 ms | 479 ms |
| click round trip | 1 ms | 2 ms |
| key round trip | 13 ms | 2 ms |
| screenshot | 82 ms, 133 KB | 77 ms, 113 KB |

`browser_extract` on a 30-row list: 1106 chars for all 30 rows (≈330 tokens),
against 1291 chars for the same page read as text — and at a 500-char read
budget the text read stops around row 12 while the list still returns 30.

Live run (`npm run live`), 8 checks, all true on the open internet: open
example.com in 566 ms, read it for 785 chars, click the language link on
wikipedia.org and land on en.wikipedia.org in 2.3 s, go back to
www.wikipedia.org, extract ten list rows from the Web scraping article in 3 ms
(1813 chars), visit a host that cannot resolve (1.3 s to the browser's own
error page, where a read, a click and a batch all refuse instead of quoting it),
recover from there to a real page, and type into a search box and reach a
results URL in 1.3 s. These are wall-clock end to end including the site's own
load; the local numbers below are where the driver's own cost lives. Two hosts
were unusable from this machine and are not plugin problems: Hacker News (12 s
connect timeout, confirmed with curl) and Wikipedia's search redirect, which
answers on the home page and times out on the query — the search check runs on
Bing now, driven by the box's words rather than a control number.

Breadth run (`npm run breadth`), 33 checks, all true: open shadow DOM read and
click, form typing, select, checkbox, submit, `confirm()` seen and accepted,
iframe read, iframe typing, iframe click, cross-site frame read and click,
popup followed, download saved, network responses listed, a file uploaded
into a file input, the page printed to a PDF, a changed-only read, names from `for=` and `aria-labelledby`, a click found by its words, a login filled by field names in one call,
stale ref refused, a crash picked back up on the same page, a list read as 30 rows, a click under a full-screen cookie banner clears the banner and lands on the
control, typing into a field under that banner works the same way, and an
overlay that offers to delete the account is reported but never accepted.

## Phase 4 — what a change costs

| What | Number |
| --- | --- |
| change in the page → frame ready for the column | 7 ms median, 7 ms max (12 samples) |
| `changed_only` after a field changes, dense page | 58 chars ≈ **17 tokens** (whole page: 444) |
| read: text page, `changed_only` | 42 chars ≈ 12 tokens (whole page: 1517) |
| renderer crashed → readable page again | **1.39 s** (detect, fresh tab, same address) |

The mirror's delay is measured from the moment the page is told to change to
the frame object the column would draw — capture, JPEG, and the CDP hop. It is
the part of the latency that belongs to this side; what a person sees adds the
browser's compositing and the SSE hop, both smaller.

A cross-site frame (Chrome runs it in its own process) costs one more round
trip than a same-process one: its controls arrive in the same read, and the
frame's corner is one `DOM.getFrameOwner` plus one call on the owner element.

## Phase 5 — what an overlay costs

| What | Number |
| --- | --- |
| the "what is on top of this control" probe | **1 ms median, 2 ms max** (5 samples) — the same `Runtime.evaluate` hop, no round trip added |
| `browser_click` on an uncovered control | 460 ms median (3 runs, page-load settle included) |
| `browser_click` on the same control under a cookie banner | 630 ms median (3 runs) — the banner's own Accept click, a 150 ms beat, a re-probe, then the intended click |
| the same under a modal that offers to delete the account | 456 ms — reported, nothing pressed |
| one `browser_do` step on an uncovered control | 458 ms median (3 runs) |
| the same step under the cookie banner | 633 ms median (3 runs) — cleared, then the step ran |

A batch pays it once per step that has something over it, not once per call: a
banner cleared by step 1 is gone for steps 2..n, so a five-step flow through a
cookie wall costs one extra step's worth of time, not five.

The probe costs nothing when nothing is in the way, which is the common case;
the covered case pays about 170 ms to clear the banner and land the click in
the same call, instead of making the model spend a whole extra turn (a read, a
click, another read) telling it to close the banner first.

## Phase 6 — what a stale number costs, 0.16.0

A ref is a number for an element. A page that redraws a list, a table, a card
grid — React, Vue, Svelte, or plain `innerHTML` — throws every element away and
makes new ones, so the numbers from the last read stop pointing anywhere. The
control is still on screen, saying the same words, usually in the same place.

Before this phase that cost two round trips: the call came back `That control is
gone`, the model read the page again to get a new number, then used it. The work
is now done inside the call, by looking the control up by what it is.

| What | Number |
| --- | --- |
| `browser_click` on a control the page just redrew | **462 ms median, 483 ms max** (8 samples) — one extra read of the page's visible text, 600 chars, to find the control again |
| `browser_click` on a control that was not redrawn | 445 ms median, 446 ms max (8 runs) — the probe costs nothing when the number is still good |
| stale refs recovered this way | **8/8** |
| a control that really left the page | still refused, `Call browser_view and use the new number` — 2/2 in the breadth suite |

So the recovery costs about **17 ms** when it is needed and nothing when it is
not, against a model round trip of two calls plus the tokens of a fresh read.

What counts as the same control: the same words and the same kind. A button does
not become a field; a field never passes for the button beside it; a link keeps
its destination, because the same words pointing somewhere else is a different
thing to click. The words have to appear **exactly once** on the page — two
"Delete" buttons in two rows are a choice only the person can make, so that case
still asks for a read.

The call says what it did: `(the page redrew, so "Learn more" has a new number — used where it is now)`, so the model knows its old number is not the one to keep
using. On the live network the same thing happened on example.com: a link
replaced by an identical clone, one click, 4.4 s including the iana.org page
load, straight to `https://www.iana.org/help/example-domains`.

## Phase 7 — what changing the shape of the browser costs, 0.17.0

A site that refuses a windowless browser is the one case where the shape has to
change mid-session. Changing it restarts the browser, so it costs a cold start:

| what | median | notes |
| --- | --- | --- |
| windowless → windowed, same profile and page | 21.6 s | one process, cold start |
| windowed → windowless, same profile and page | 22.1 s | one process, cold start |
| asking for the shape it already has | 0 ms | nothing is restarted |

Measured through the tool layer (`browser_open` → `browser_state` → `ps` spawn
args), profile `probe-tool`, 1 run each; the same-shape row is the third call in
the same run. A browser start on this machine is 20–22 s either way, so the
switch is not what costs — the process is.

Reading a check page costs nothing: the sentence is built from the title already
in the read, and a normal page gets `''` for one comparison.

## Phase 8 — saying it when nobody is drawing, 0.18.0

The mirror is drawn by the tab in the chatting column, and that tab attaches
while the page is loading. Waiting for it costs nothing when it arrives, and a
bounded wait is the difference between a silent `viewers 0` and a sentence:

| what | cost |
| --- | --- |
| `browser_open` with a tab watching | 0 ms |
| `browser_open` with nothing watching | ≤ 1.2 s, and the line says so |
| `browser_open` when the chat has no column to draw into | 0 ms (no wait) |
| building the sentence on a normal state read | 0 ms, one comparison |

Measured with `/tmp/probe-unseen.mjs` (tool layer, example.com, profile
`probe-tool`): 1344 ms with nothing watching and no column asked for, 3236 ms in
the first version of the same wait that did not skip the case where no column was
ever requested — the whole difference was the wasted 1.2 s.

## Phase 9 — finding the field behind the words, 0.19.0

A read of a `/bare` form (two div labels, two bare inputs, no aria anywhere on
the fields) and one `{field: "Work email"}` step:

| what | result |
| --- | --- |
| the click lands on the field, not on the div | yes, value `me@x.y` in `input[name=wk]` |
| the second, untouched field | still empty |
| the tool's own words | `typed into "Work email"` |
| worst case when nothing matches | one extra in-page query, then the old behaviour |

The query walks the open shadow roots (capped at 400) and, per visible editable
element, builds a list of candidate names from real labels, `aria-labelledby`,
`aria-label`, `placeholder`, `title`, `name`, `label[for]`, the element right
before it, and its wrapper's text — then scores exact (3) / contains (2) /
reverse-contains (1).

## Phase 10 — typing by name, 0.20.0

| what the caller has | what it used to take | now |
| --- | --- | --- |
| a name for the field, no number | read the page, find the number, then type | one `browser_type` with `field`, one round trip |
| the field's words live in a div | click landed on the div, text went wherever focus was | resolved to the field, `typed into "Work email"` |
| a banner over the field | typed under the banner | banner cleared first, then typed |

Breadth check `type-by-words` on the `/bare` form: value lands in
`input[name=wk]`, the page does not move (no stray Enter).

## Phase 11 — choosing a dropdown by name, 0.21.0

`/bare` now carries a `select[name=seats]` whose only name on screen is a div
saying `Seats`. One `browser_select` with `field: "Seats"`, `value: "Two"`:

| what | result |
| --- | --- |
| the value after the call | `2` |
| the tool's own words | `chose Two in Seats` (on-screen name, not `name="seats"`) |
| a wrong option | answered with the first 12 options instead of a page read |
| round trips to do it | one; no read beforehand, no read after |

The naming rules (`labelSpot` and `selectSpot`) now live in one shared in-page
block, so the two steps cannot drift apart.

## Phase 12 — words split across nodes, 0.22.0

`/words` now carries `<button><span>Sign</span><span>in</span></button>`, which
the page reports as `Signin`.

| what | result |
| --- | --- |
| `{text: "Sign in"}` before | not found; caller had to fall back to a number |
| `{text: "Sign in"}` now | clicked, title changes, `ok click "Sign in"` |
| extra work | none: the same single control list, one comparison changed |

Exact equality still wins over the squeezed form, so `Sign in` never lands on
`Sign up` when both exist.

## Phase 13 — the field behind the box, 0.23.0

`/bare` gains the date-picker shape: a visible rounded box with a transparent
`<input>` laid over it, its words in a div two levels up.

| what | before | now |
| --- | --- | --- |
| `{field: "Birthday"}` | not found, fell back to clicking the div | found the hidden input, clicked its visible box |
| value after one `browser_do` step | whatever already had focus | `2001-02-03` in `#bd`, `typed into "Birthday"` |
| extra round trips | read the page, guess a number | none |

The visible-box rule: a candidate is usable when it, or its nearest visible
ancestor, has a real box — so a 0-opacity input still counts if it covers
something the person can see.

## Phase 15 — the answer is the picture, 0.25.0

`/pic` is one 140x90 PNG and nothing else.

| what | result |
| --- | --- |
| `browser_grab` | 6 ms, `picture-check.png`, 140x90 |
| before | three round trips: list the images, ask for the full address, fetch it |

A picture page has no text at all, so a read of it costs one line and no tokens;
the picture comes back as a file path the person can open.

## Phase 16 — say what the picture looks like, 0.26.0

Two 140x90 PNGs: one a gradient, one a single colour.

| page | what `browser_grab` answers | time |
| --- | --- | --- |
| `/pic` | `... 140x90 a picture with detail` | 21 ms (first, page cold) |
| `/flat` | `... 140x90 mostly one colour` | 4 ms |

The sampling is 32x32 inside the page, so it costs no round trip and its result
travels in the same line as the path.

## Phase 17 — the answer is a picture, in the read itself, 0.27.0

| page | read line | extra round trips |
| --- | --- | --- |
| `/pic` (gradient, no words) | `picture 140x90 a picture with detail "Chart" — browser_grab saves it as a file` | 0 |
| `/flat` (single colour) | `picture 140x90 mostly one colour "Chart" — …` | 0 |
| `/words` (text page) | no picture line | 0 |

The sampling is 32x32 inside the page, in the same call that reads the page, so a
blank chart is visible before anything is saved.

## Phase 18 — the picture that never arrived, 0.28.0

| page | read line | time |
| --- | --- | --- |
| `/broken` (320x240 `<img>` pointing at a 404, no words) | `picture 320x240 "Chart" did not load — the page may need a reload, or the picture is gone` | 123 ms (cold page) |

A failed image collapses to an error icon, so the declared `width`/`height` is
what the page meant to show; the read reports that size, not the icon's.

## Phase 19 — the page said again, 0.29.0

| read | characters | time |
| --- | --- | --- |
| first read of `/dense` (40 paragraphs) | 2057 | — |
| second read, nothing changed | 105 | 1 ms |

The comparison is free: both reads already happened. Only the report shrinks.
A changed scroll offset is still reported, so "nothing changed" is never a lie.

## Phase 20 — one call carries the question and the answer, 0.30.0

| step | before | `browser_ask` |
| --- | --- | --- |
| type the message | `browser_type` + `submit` | same, inside the call |
| read the page | `browser_view` | — |
| read it again until the answer stops growing | 2–6 more `browser_view` calls | — |
| **turns for a chat reply** | 3–7 | **1** |
| measured `browser_ask` on `/chat` (answer over 2 arrivals, 700 ms tail) | — | 2.5 s, one turn |

## Phase 21 — a review round that closes the loop, 0.31.0

| step | before | `browser_review` |
| --- | --- | --- |
| write the request (repo, commit, focus) | by hand, every round | built from three fields |
| send it, wait for the answer | `browser_ask` | same call |
| turn the answer into a list | read it, retype it | parsed, numbering kept |
| know what the last round was about | — | round log, with the commit and the time |
| **turns for a review round** | 3–7 + bookkeeping | **1** |
| measured round on `/chat` (echoed question + 2-item list) | — | 2.6 s, 2 points |

## Phase 21b — an answer that is not an answer, 0.31.1

A chat box on a page that is not signed in still accepts text, still redraws,
and still looks busy. Three cheap checks keep that from being reported as a
review.

| what the page does | before | now | cost |
| --- | --- | --- | --- |
| keeps the words in the box | waits 4 s, then reads the page | says so at 0.5 s | 1 evaluate |
| redraws but never shows the message | the new words were the answer | says the page did not take it | none (text compare) |
| shows the message, no reply | "answered in prose" | "has the message but has not answered yet" | none (text compare) |
| real page, signed out (Doubao) | a review-shaped paragraph of menu chips | the sign-in is named, 2.6 s | — |

## Phase 22 — the change travels with the request, 0.32.0

The reviewer inside the column cannot open a repository. Asking it to review
"the newest commit" of a repository it cannot see is asking for a guess.

| request | what the reviewer gets | cost |
| --- | --- | --- |
| repo + commit | an address and a hash it cannot open | 1 message |
| repo + commit + diff | the change itself, capped at 5000 characters | +diff characters in that one message |

Measured: `review-carries-diff` green in 2.6 s; the recorded round carries
`+const cap = 60` verbatim.

## Phase 22b — the mirror outlives the visit, 0.33.0

A column tab only exists while the chat is on screen. The ask used to be a
single frame pushed at request time: if that chat had no stream, the frame was
lost and the mirror never appeared on return.

| situation | before | now |
| --- | --- | --- |
| the chat is on screen | tab opens | tab opens |
| the chat is elsewhere, then returns | nothing | tab is waiting |
| the page was reloaded | nothing | tab is waiting |
| the ask is 3 minutes old | nothing | nothing (spent) |
| a different chat comes back | nothing | nothing (not its mirror) |

Data flow never needed the column: measured with zero viewers — boot 626 ms,
click and read back 114 ms, read 4 ms, shot 48 ms / 12.5 KB.

## Phase 22c — a duplicate cannot take the pane down, 0.33.2

A scan of the six shipped modules finds no repeated top-level name, no module
imported twice, no two tools with one name, one tab id and one style sheet.
The two places a reload can still meet itself are guarded instead of trusted:

| case | before | now |
| --- | --- | --- |
| same tool name registered again | thrown error, surface down | warning, first one kept |
| same tab mounted again | possible duplicate registration | no-op |
| style sheet re-applied | second sheet stacked | replaced by id |
| two mount entry points | possible double effect | one entry per half |

Guards are covered by `test/no-duplicate.test.mjs` plus a double-mount test:
65 unit tests, 66 breadth checks, 20 packaged files.

## Phase 25 — one chat cannot take another chat's page, 0.34.2

The audit on 0.34.0 named five things a driver written for one chat got wrong.
Each was reproduced against 0.34.1 first: two were already fixed (the
`sessionScope`/`KEYS` import, and every `ensure()` route already carrying a
session), three were real.

| What | Before | Now |
| --- | --- | --- |
| popup lookup | any non-main tab, then navigated or closed | only a target that is neither this page nor another chat's (`isForeign`) |
| focused password in a result line | echoed the `.value` (`DUMMY_SECRET_123`) | name only, value always empty |
| `browser_do` on a step that did not land | kept going, typed into the wrong page | stops at that step, says to re-plan |
| overlay that would not clear | clicked the control under it anyway | refuses the click/typing, names the overlay |
| `changed_only` twice | repeated the same change | diff becomes the new baseline |
| `/sidecar/state` | top-level `url` could be another chat's tab | `?session=` adds `chat.url/title/viewers` (live: doubao page, viewers 1) |
| suite | 77 pass | 79 pass (isolation, leak) |

## Phase 24 — a number that is checked before it is used, 0.34.1

| What | Before | Now |
| --- | --- | --- |
| ref on a control whose words changed | pressed the new control | refused, says both words (0 ms extra on an unchanged ref) |
| sidecar call after a hot reload | `sessionScope is not defined` | works; the Host half is checked by a test |

## Phase 23 — one tab per chat, typing that looks like hands, 0.34.0

The browser used to be one page for the whole app, so any chat could navigate
the page another chat was reading. Tabs are now per chat; one windowless Chrome
and one profile still back all of them, so a login is shared and an address is
not.

| what | measured |
| --- | --- |
| first chat, browser cold | 725 ms to a driven page |
| second chat, own tab | 1 round trip, no second Chrome |
| chat A navigates | chat B's URL and the first tab unchanged |
| frames per chat | `/sidecar/frames?session=` streams only that tab |
| paste, 46 chars | 5 ms |
| human typing, 46 chars | 1965–2238 ms (43–49 ms per char) |
| human typing, >160 chars | 8-char bursts, 16–58 ms gaps, ≈6 ms per char |
| headless UA | desktop Chrome UA, no `HeadlessChrome` |
| suite | 70 pass, breadth 66, ui-copy clean |

## Flash 分支（Electron 11.3.0 / Chromium 87，1440×900，Apple 芯片 + Rosetta）

| what | measured |
| --- | --- |
| cold start to a driven page | 1389 ms（热启 545–927 ms） |
| first painted frame | 8–10 s（SWF 自己的加载；之前是 11 KB 白帧） |
| one frame via capturePage | 16 ms |
| frame size, JPEG q72 | 96–103 KB |
| mirror SSE | 15 fps（66 ms 一轮），4 s 收 60 帧，均值 97.8 KB |
| switch cost | 一次浏览器重启（`browser_open({flash:true})` → `browser_open({flash:false})`） |
