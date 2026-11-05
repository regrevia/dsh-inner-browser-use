## 点击与右键：旧服务端会不会把按下回执后丢掉 — 0.47.29

同机、新进程、headless Chrome、本地页面，走 `apply()` 注册的真实路由
（`/sidecar/open` → `/sidecar/viewport` → `/sidecar/input`）。页面把自己的
`mousedown/mouseup/click/contextmenu` 回报给本地 fixture，不看截图、不读 CDP 结果。

```
node /tmp/r24-click.mjs           # 本仓库（0.47.29）
MODULE=old node /tmp/r24-click.mjs # /tmp/r23-base（0.47.28 的服务端）
```

| 同一请求 | 0.47.28 服务端 | 0.47.29 服务端 |
| --- | --- | --- |
| `/sidecar/state` 里的 `press` | 无 | `true` |
| `down` + `up` 的回执 | `200 ok` ×2 | `200 ok` ×2 |
| 页面收到的按下/抬起 | **0** | `mousedown buttons:1`、`mouseup buttons:0` |
| 页面收到的 `click` | **0** | 1 |
| `click button:'right'` | 左键，菜单 0 | `button:2 buttons:2` → `contextmenu button:2` → `mouseup buttons:0`，菜单 1 |

结论：0.47.28 的服务端把新面板的按下抬起**回执为成功却什么都没派发**，这正是
「右栏里左右键都点不动」；0.47.29 让面板先问能力（`press`），问不到就退回单一
`click`，问到了才发按下/抬起，右键按位掩码走同一条链路。

## 按住拖：协议里有没有 press-move-release — 0.47.28

同机、新进程、headless Chrome、本地页面，两条探针都走插件自己的代码：

- `/tmp/r23-drag.mjs`：直接驱动 `SidecarPage` 的鼠标原语，量「同一段轨迹能不能拖动」。
- `/tmp/r23-route.mjs`：起 `apply()` 注册的真实路由，用 HTTP 发 `{session, kind, fx, fy, fw, fh}`，
  页面把 `mousedown/mousemove/mouseup` 自己的坐标与 `buttons` 回报给本地 fixture 服务——
  这一条不含右栏 UI，但含协议解码、`pointAt()` 换算与 CDP 派发。

### 滑块拖动（页面 900×900，轨迹 x 210→880，25 步，每步 30 ms）

| 路径 | 按下 | 按住中的移动 | 拇指位移 | 页面判定 |
| --- | --- | --- | --- | --- |
| 旧：`click` 后跟 `hover` | 1 次 | `buttons:1` 的移动 **0** 条 | **0 px** | `dragged: false` |
| 新：`down` → 25 次 `pressed` 移动 → `up` | 1 次 | **25** 条 | **660 px** | `dragged: true` |

### 真实路由 + 页面自报（900×900 视口）

| 量 | 结果 |
| --- | --- |
| `hover` 50% 落点 | `(450, 450)`，与理想值一致 |
| 按下 | `(108, 324)`，`buttons: 1` |
| 按住中的移动 | 5 条，全部 `buttons: 1`，总位移 **539 px** |
| 抬起 | `(647, 324)`，`buttons: 0` |
| 松开后的移动里仍带着按住的 | **0** 条 |
| 没有按下过的移动里带按钮的（幽灵按住） | **0** 条 |

判据：`pressHeldAcrossMoves: true`、`releasedAtEnd: true`、`routeDrags: true`。
旧路径的 `mouseMoved` 一律发 `buttons: 1`，这一列在新路径上是 0。

## 镜像偏移：按比例传点，实测落点 — 0.47.27

同机、一次新进程、headless Chrome、本地页面（`node /tmp/r22-frac.mjs`，含
`DSH_INNER_BROWSER_STATE_DIR` 隔离）。页面是 10×10 的单元格，点在哪一格由
`document.elementFromPoint` 直接回答——这正是「点击有没有落在手指下面」的问题。

### 画面尺寸与页面一致（视口 700×900，页面 1440×900）

| 手指位置 | 目标格 | 旧路径像素 → 格 | 新路径像素 → 格 | 理想像素 |
| --- | --- | --- | --- | --- |
| 10% / 15% | `c1-1` | 144,135 → `c1-1` | 144,135 → `c1-1` | 144,135 |
| 50% / 50% | `c5-5` | 720,450 → `c5-5` | 720,450 → `c5-5` | 720,450 |
| 85% / 75% | `c8-7` | 1224,675 → `c8-7` | 1223,674 → `c8-7` | 1223,674 |

### 右栏以为 760×900、页面实际 1440×900（旧尺寸场景，即「偏移」的现场）

| 手指位置 | 目标格 | 旧路径像素 → 格 | 新路径像素 → 格 | 偏离 |
| --- | --- | --- | --- | --- |
| 10% / 15% | `c1-1` | 76,135 → `c0-1` | 144,135 → `c1-1` | 68 px |
| 50% / 50% | `c5-5` | 380,450 → `c2-5` | 720,450 → `c5-5` | 340 px |
| 85% / 75% | `c8-7` | 646,675 → `c4-7` | 1223,674 → `c8-7` | 577 px |

旧路径的偏差随位置变大（68 → 340 → 577），因为错的是一整个比例；新路径三档都精确。

### 画面画完、页面之后换了尺寸（1440×900 → 760×900）

| 手指位置 | 目标格 | 旧像素（旧画面上算的） | 新比例 |
| --- | --- | --- | --- |
| 85% / 75% | `c8-7` | 1223 → 页面外（`null`） | 645 → `c8-7` |
| 50% / 50% | `c5-5` | 720 → `c9-5` | 380 → `c5-5` |

比例在这一步才显出意义：同一根手指，页面换了大小之后仍然落在同一格。

### 一条输入的代价（同一进程，真实 Chrome）

| 项 | p50 | p95 | 最大 |
| --- | --- | --- | --- |
| hover 往返（`SidecarPage.hover`） | **16.5 ms** | 17.7 ms | 17.7 ms |
| 点击（`SidecarPage.input`） | **0.15 ms** | 1.9 ms | 1.9 ms |
| 连续 2 s、每 40 ms 一点 | 服务 **19.9 点/秒** | | |

结论：延迟不在服务端，所以在客户端的等待上——旧的 60 ms 节流下每个 hover 都在等上一条回话，
现在「最多一条在路上、最新的点覆盖等待中的点」；代理指针 60 ms 的 CSS 过渡已删。
边界：单纯移动鼠标不会让页面重绘，因此这段时间里 screencast 帧数为 0，不是丢帧。

## 镜像输入失灵：四个根因与修复后的实测 — 0.47.26

同机、一次新进程、headless Chrome、本地页面，脚本一次性（`node /tmp/r21-live.mjs`，
含 `DSH_INNER_BROWSER_STATE_DIR` 隔离）：

| 项 | 结果 |
| --- | --- |
| 帧与页签的对应 | 帧 `target` = 页面 `targetId`（`287A04652252B75C6B56933059F4187E`） |
| socket 必抛时一次点击 | 返回 `false`，`inputFails 1`，`inputFault "Input.dispatchMouseEvent"` |
| socket 永不回答时一次点击 | **1201 ms** 返回 `false`（旧实现会一直等或谎报成功） |
| 恢复后一次点击 | 返回 `true`，`inputFails 0`、`inputFault ""` |
| `markGone()` 之后 | 同一个流的观看者当场收到 **1 条** `{type:'gone'}`，没有新帧 |
| 主套件 | `npm test` → **308 项 / 0 失败** |

四个根因：输入失败被吞成 `200`；回收不通知、只在 ≤5 秒采样里出现；重建页签后第一下
点击打到新页；右栏客户端从不读回话。四条都改了，且都留了回归测试。

## Flash 镜像（0.47.9，单页，隔离状态目录）

同一台机器、同一个登录页（`account.100bt.com`，12:7 固定画面）、同一套脚本
（`scripts/check-flash-fit.mjs`、`scripts/check-flash-mirror.mjs`），每次都是全新 profile。

| 项 | 0.47.8（1×） | 0.47.9（2×） | 变化 |
| --- | --- | --- | --- |
| 捕获面 | 960×560 | **1920×1120** | 2.06× 像素 |
| JPEG | 91–98 KB | 113–114 KB | +20% 字节 |
| 帧率 | 23.8 fps | **27.8 fps**（76 帧） | +17% |
| 首帧 | 366 ms | **189 ms** | −48% |
| 按下 / 松开 / 按键 | 6 / 4 / 2 ms | 5 / 1 / 4 ms | 同量级 |
| 拆除到进程退出 | 不退出（`exit 124`，残留 1 个 ref 定时器） | **`exit 0`，12.2 s 跑完** | 无残留 |

几何仍以 CSS 尺寸为准（`this.view` = 960×560），黑边与指针反算不受 2× 影响；
`DSH_FLASH_SCALE`（1–3，默认 2）与 `DSH_FLASH_JPEG_QUALITY`（默认 84）是两个旋钮。

## 冷启动：五次独立新进程 — 0.47.12

0.47.6 那轮报的是「840 ms（701–936，五次）」。同一量法重跑（`browser_open` + `browser_view`
经工具层，每次全新 `Sidecar`、全新 profile、无头 Chrome，隔离状态目录）：

| 次 | 1 | 2 | 3 | 4 | 5 | 中位 | 区间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.47.12 | 433 ms | 445 ms | 453 ms | 459 ms | 603 ms | **453 ms** | 433–603 ms |

同机同夹具的竞品冷启动：browser-use **713 ms**、Stagehand **760 ms**、CDT MCP 2185 ms、
Playwright MCP 2755 ms。这一项 0.47.6 时还是我们唯一落后的一项，现在反过来了；领先幅度不大
（比 browser-use 快 36%），且随机器负载浮动，别当固定值用。

## 每页成本：1→6 页签 — 0.47.14

同样是无头 Chrome、隔离状态目录、本地 fixture（`<h1>tab</h1>` + 3000 字占位）。每开一页等
3.5 s，跑一次整棵进程树（`ps -Ao pid,ppid,rss`，从浏览器 pid 往下递归求和）取三次、间隔
900 ms，取中位。表格里 `spread` 是三次采样的极差。

| 页签 | 总 RSS 中位 | spread | 比上一页 |
| --- | --- | --- | --- |
| 1 | 1058 MB | ±10 | — |
| 2 | 985 MB | ±1 | −73 |
| 3 | 883 MB | ±6 | −102 |
| 4 | 1035 MB | ±27 | +152 |
| 5 | 992 MB | ±94 | −43 |
| 6 | 1039 MB | ±71 | +47 |

结论只有一条：**页签数不驱动内存**。1→6 页始终在 883–1058 MB 之间来回，没有单调增长；
页签换页时旧渲染进程被回收、共享页被重算，单步差值（−102…+152）比「每页成本」大得多，
所以这张表不能拿来做减法算「一页多少 MB」。真正随页签增长的只有渲染进程数（最多 4 个），
成本大头是浏览器基线本身。对照：竞品在**一个页签**上就是 1265–1672 MB（`0.47.6` 五家表）。

## 桥的收尾：主动关 vs 父进程猝死 — 0.47.14

`scripts/check-flash-idle.mjs`（隔离状态目录、`about:blank`、不动任何人的会话）：

| 场景 | 判据 | 结果 |
| --- | --- | --- |
| 插件主动收尾 | `putAway()` 后 4 s，桥的 pid、整组、端口 | pid 消失、组空、端口不应答，`the bridge leaves nothing behind.` |
| 宿主猝死（父进程 `exit` 不掉用 `putAway`） | 父进程退出后逐秒看桥的进程组 | 第 1 s 还在，第 2 s 整组消失、端口不应答 |

第二行是 0.47.14 前真实漏过的那一类：父进程被 `SIGKILL` 或崩掉后桥被 launchd 收养，仍在
画、仍占着 profile，早期版本还会出声；现场抓到过存活 3 h 以上、无父进程的旧桥。现在桥自己
每 2 s 看一次 `process.ppid`，被收养就 `app.exit(0)`。收尾路径与回归测试见
`test/package.test.mjs` 的 `the Flash runtime outlives nobody and starts silent`。

## 五家对照：同一台机器、同一个 fixture、同一档无头 Chrome — 0.47.6

量的是「不用模型」的那一层：开页、截图、读页、空闲、收尾。要 LLM 猜坐标的路径（Stagehand 的
`act`、browser-use 的 agent 循环）不算进来——拿确定性实现去赢别人的推理延迟没有意义，也不该
拿它当卖点。原始记录 `docs/measure-competitors-2026-11.json`，各家脚本在 `docs/BENCH.md` 末尾
「竞品怎么量的」一节。

| 项目 | 冷启动 | 热页签 | 截图（中位 / 字节） | 读同一页 | 空闲 CPU | 空闲 RSS | 收尾 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| this plugin 0.47.6 | 840 ms（701–936，五次） | 工具层 42–54 ms，内部 `start` **20 ms** | 51 ms / 106 648（+路径 223 字符） | **2302 字符 / 2 ms** | **0.33%** | **459–552 MB** | 休息 → 0 MB，保留登录，醒来 0.39–0.59 s |
| Playwright MCP 0.0.84 | 2755 ms | 45 ms | 51 ms / 75 483（回答 100 644 字符 base64） | 7804 字符 | 38.1% | 1414 MB | 关整棵树，回来是冷启动 4.6–5.1 s |
| Chrome DevTools MCP 1.12.0 | 2185 ms | 130 ms | 48 ms / 287 400（回答 383 200 字符 base64） | 5381 字符 | 36.3% | 1280 MB | 无空闲时钟，进程在就在 |
| Stagehand 4.3.0 | 760 ms | 60 ms（含一次 256 ms 离群） | 67 ms / 76 153（`Uint8Array`） | 21 396 字符 | 41.8% | 1265 MB | `close()` 52 ms → 2 MB，profile 一起删 |
| browser-use 0.13.14 | 713 ms | 27 ms（裸 `new_page`） | 71 ms / 175 021 | 5662 字符（裸 `innerText`） | 51.3% | 1672 MB | `stop()` 110 ms → 2 MB，靠 `keep_alive` 决定关不关 |

**赢在哪，怎么赢的**

- 空闲 CPU 是数量级差距：0.33% 对 36–51%。四家竞品都让 Chrome 一直以「有前台观众」的档位跑；本插件没有观众就冻结页面（`Page.setWebLifecycleState: frozen`），冻结停 CPU 不停内存，所以 CPU 掉到噪声、RSS 还在
- 空闲 RSS 2.3–3.6 倍：单页 459–552 MB 对 1265–1672 MB。Stagehand 与 browser-use 各自起了一个额外的 Node/Python 宿主进程（10–16 个进程），本插件同口径 8 个进程 / 4 个渲染进程
- 读页成本：同一页 2302 字符对 5662–21396 字符。本插件给的是「控件 + 可见文字」的结构视图（`browser_view` 2302 字），browser-use 的 5662 是裸 `innerText`（一次性 `page.evaluate`，1 ms），Stagehand 的 21 396 是整棵 a11y 快照。口径不同，只报各自默认口径下的字符数，不排名
- 收尾：四家都能把进程关掉。差别在后面——竞品关掉就是关掉（Stagehand 连 profile 一起删），本插件休息后内存归零、页面与登录留着，回来 0.39–0.59 s。冷启动 4.6–5.1 s 对 0.39 s，这是「回来一次」的真实成本差

**没赢的地方，照实写**

- 冷启动绝对值还是最慢的一档：840 ms 中位（701–936）对 Stagehand 760、browser-use 713。前两家把 Chrome 起在自己进程里、没有「等 DevTools 端口 + 建 CDP 会话 + 装页面设置」这几段；本插件的冷启动大头在 Chrome 自身（0.5 s 上下），已经拆开量过（`docs/BENCH.md`「冷启动拆解」段）
- 热页签工具层没变快：42–54 ms 对改前 41–45 ms，在噪声里。真正的改善在内部 trace 的 `start` 段（39 → 14–33 ms，中位 20），多出来的 20–30 ms 是回给模型的那段页面文字——它换来的是「开完就知道页面上有什么」，不是白花的
- 截图速度四家打平（48–71 ms）：成本在 `Page.captureScreenshot`，换实现不会更快。差别只在回答形状——本插件落文件回路径（223 字符），竞品把 base64 塞进回答（100 644 / 383 200 字符）
- 唤醒值波动大：同一份代码在这台机器上跨跑 394–866 ms。凡是只有一个样本的数字都不可信；这条已写进 `docs/VERIFY.md` 的测量纪律

## 读过的站第二次更便宜（0.45.0，本地页面，`scripts/check-sites.mjs`）

同一台机器、无头 Chrome、两个本地 origin。第一次走老路（整页读），第二次之后用学到的默认值。
所有数字来自一次真实运行，不是估算。

| 页面 | 第一次 | 学到之后 | 省下 | 说明 |
| --- | --- | --- | --- | --- |
| 300 个按钮的页面，`browser_view` | 1801 字符 | 760 字符（`map: 90 controls`） | 58% | 两次之后自动改成地标视图，并说明「this site reads big」 |
| 12000 字文档，`browser_read` | 6096 字符（满预算） | 3726 字符（截到 3500） | 39% | 截断处自带 `cut at 3500 characters`，用 `max_chars` 可要全文 |

- 学的尺子量的是页面本身，不是这次输出：`read.js` 的 `chars` 在截断前取值，所以第一次就把整篇长度记下来，不会被 3500 的预算越读越小
- 显式 `mode` / `query` / `max_chars` 一律优先；学到的是默认值，附一句带数字的理由
- 记录写在 `sites.json`，每进程最多每 2 秒一次；两次运行之间只留计数，不留正文
- `scripts/check-look.mjs`：12×8 的字母网格，三次看共 639 字符，全程没有图片 token
- `scripts/soak.mjs`：无头浏览器 24 轮开页/读页/截图/重读，34.9 秒，进程树内存 1440 → 1287 MB（−153 MB），页数始终 1，8 次截图、24 次读；没有页签或内存随轮数上涨

## 读页先读正文（0.44.0，本地页面，`scripts/bench.mjs`）

同一台机器、同一档预算。旧法是按页面顺序把预算灌满的整页读。

| 页面 | 旧法字符 | 新法字符 | 省下 | 答案 |
| --- | --- | --- | --- | --- |
| 九成是菜单、答案在正文（900 字预算） | 1500 | 88 | 94% | 旧法读不到，新法读到 |
| 定价表（900 字预算） | 679 | 109 | 84% | 价格与列名同一行 |

- `read-noise` 2 ms、`read-table` 2 ms，两项预算 300 ms 全过（26 项全过）
- 表格行形如 `Plan: Pro | Price per month: $84`，列名来自表头，一行就是一条记录
- 标题路径 `Plans \u203a Trial` 印在证据上方；与最近标题相同、或超过 90 字时退回最近标题
- 既有数字没有回退：`read-answer` 90 字 / 92%、`read-miss` 438 字 / 79%、`read-tabs` 90 字 / 90%（与 0.43.0 相同）

## 一次读穿过登录墙（0.43.0，本地页面，`scripts/bench.mjs`）

同一页：带 cookie 时是账户页，不带时是一个只有密码框的登录页。留一个登录（vault），清掉页面的 cookie 与 localStorage 后读它。

| 路径 | 调用 | 毫秒 | 字 |
| --- | --- | --- | --- |
| 撞墙后读→list→use→再读 | 4 | 217 | 139 |
| 撞墙后只读一次 | 1 | 112 | 220 |

- 一路上 `recovered: true`：内容来自恢复后的页面（「forty two days」），不是墙上的文字
- 两个名字都覆盖这个站时：`namesBoth: true`、`guessed: false`——名字都列出来，一个都不放回去
- 导入本机浏览器登录（合成库，真实钥匙串路径）：`login-import` 1 次调用 / 111 毫秒 / 1 个 cookie 封存 / 回复里不含任何 cookie 值
- 预算：`login-wall: 1600 ms`、`login-import: 700 ms`，24 项全过

## 答案在另一个页签（0.42.0）

两个页签：前台一页在讲别的事，后台另一页才有答案。左边是旧做法——切过去、再读一遍；
右边是一次跨页读。

| 项 | 切页签读两遍 | 一次跨页读 |
| --- | --- | --- |
| 调用次数 | 2 | 1 |
| 回来的字符数 | 879 | 90 |
| 省下 | — | 90% |
| 出处 | 要自己记 | 每段标页签标题 |
| 读这一趟 | 7 ms | 5–6 ms |

跨页只在当前页答不上来时发生，正常命中路径的延迟不变（`read-answer` 仍是 1172 → 90 字）。

## 问了但页面没答（0.41.0）

同一张故事页，问一个页面里根本没有的词（`quantum chromodynamics`）。左边是旧的兜底：
把整页当答案交出去；右边是现在只给最近的三段加一句说明。

| 项 | 整页兜底 | 最近几段 |
| --- | --- | --- |
| 回来的字符数 | 2089 | 438 |
| 折合 token | 614 | 129 |
| 省下 | — | 79% |
| 最近几段 | — | 3 段（每段 ≤ 260 字） |
| 是否明说没答上 | 否 | 是 |
| 读这一趟 | — | 7 ms |

命中路径的 `read-answer` 行不受影响（1172 → 90 字，省 92%）。

## 只读答案那几句（0.40.0）

同一张本地故事页：24 段会议记录里夹着一段账单说明，问题是「退款多久到账」。一条路按段
落读（`sentences: false`），另一条走默认的句子级证据。

| 项 | 整页段落 | 句子证据 |
| --- | --- | --- |
| 回来的字符数 | 1172 | 90 |
| 折合 token | 345 | 26 |
| 答案还在 | 是 | 是（`30 days`） |
| 命中的块 / 总块 | 8 / 49 | 1 / 49 |
| 读这一趟 | — | 11 ms |

省下 92%，`read-answer` 预算 250 ms。句子级这一步没有新增进程、没有模型、没有依赖：分句、
打分、去重都在已有的阅读调用里完成。同一批里的 `read` / `read-repeat` / `read-changed` 行与
0.39.0 持平（`dense` 6 ms / 337 token，`full` 6 ms / 624 token）。

## 登录能留、能切、关得掉（0.39.0）

本地页签在加载时写一个会话 cookie 和一个 `localStorage` 令牌，然后用工具层实际走一遍：保存 → 清空浏览器里的一切 → 切回。磁盘上那一份同时用字符串搜一遍。

| 项 | 结果 |
| --- | --- |
| `browser_login {action:"save"}` | 2 ms，8 个 cookie |
| `browser_login {action:"use"}`（清空后切回、重开页面） | 105 ms |
| 切回后 cookie 与 `localStorage` | 都在（`signedIn: true`） |
| 密文里能否搜到 cookie 值 / 令牌 | 搜不到（`sealed: true`） |
| 预算 | `login-vault: 1600 ms`，19 项全过 |

`browser_state` 另外报两行：当前进程树占多少内存（含渲染进程），以及没人用的话还有多久关闭——两者都来自 `ps` 一次采样和已有的空闲计时器，不额外起进程。关闭策略没变：右栏关掉约 1 分钟、没人碰约 15 分钟回收整个浏览器，页签 10 分钟不动、最多 6 个。

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

## Phase 25 — 和竞品同机同法的资源对照，0.47.0

竞品数字不是估的：`@playwright/mcp` 0.0.84 与 `chrome-devtools-mcp` 1.12.0 用同一个
`/tmp/compbench/bench.mjs`、同一台机器（macOS 27.2 / arm64 / Node 24.16 / Chrome
156.0.8078.80，无头、`--use-mock-keychain`）、同一目标页（example.com），每项重复取
min/median/max。原始记录（含每进程 RSS、失败点、方法说明）在
`docs/measure-competitors-2026-11.json`，可直接对账。

本插件一侧由 `scripts/bench-resource.mjs`（`npm run bench`）产出，同一套量法：真实进程树
RSS、`ps -o time` 累计 CPU、同一页的读写往返。本地页面 /page（40 段正文＋60 个链接）。

| what | this plugin 0.47.0 | Playwright MCP 0.0.84 | Chrome DevTools MCP 1.12.0 |
| --- | --- | --- | --- |
| 冷启动到可驱动页 | **1703–1757 ms**（机器忙时 2411） | 2464 / 2755 / 2887 | 1596 / 2185 / 2337 |
| 读一页 | **2–3 ms**，2174 字 | 工具往返 24 ms（示例页） | 工具往返 15 ms |
| 点/执行一次 | **0–1 ms** | 未单独计时 | 未单独计时 |
| 空闲 RSS（整棵进程树） | **551 MB** / 8 进程 | 1414 MB / 9 进程（Chrome 1290） | 1280 MB / 8 进程（Chrome 1109） |
| 空闲 CPU（单核占比） | **0.03–0.32%**（30 s 均值） | 38.1%（0–150 s 均值） | 36.3% |
| 冻结（有人看、没人用） | CPU 0%，RSS 511–550 MB，唤醒 5–15 ms | 无此状态 | 无此状态 |
| 休息（没人看） | **RSS 0**，唤醒 838–860 ms 回原页原地址 | 整棵关掉后冷启动 5133 ms | 无空闲回收 |
| 页签切换 | 一个 `browser_tabs` 调用 | 3416 ms（其中 3392 是打开 wikipedia） | 2918 ms（2903 是打开） |

> 0.47.1 把这张表的冷启动一行改掉了：同一套量法下中位 465–544 ms。原因和逐阶段账在下面的
> 「冷启动拆解」一节；这一节保留 0.47.0 当时的数字，不回头改历史。

读法：

- 冷启动和 Chrome DevTools MCP 同一量级（中位 1703 vs 2185 ms），比 Playwright MCP 快一
  档；它最低一档 1596 ms 仍比我们的中位低，这一项不能算全面领先。
- 空闲 CPU 差约两个数量级，来源是它默认不做任何节流，而我们把后台网络、组件更新、崩溃
  上报、翻译/媒体路由全关掉，再把页面冻结。
- 空闲内存大约是一半：`--renderer-process-limit=4` 让 6 个页签共享 4 个渲染进程。
- 休息后的唤醒 838–860 ms，对方恢复要整棵重启 4.6–5.1 s；但 Playwright MCP 确实有
  `--idle-timeout`（无头默认一小时），只是不区分有没有人在看、也不先冻结再关。这一条是
  「更细」而不是「只有我们有」。

### 这一版为数字做的改动

| change | measured effect |
| --- | --- |
| `--renderer-process-limit=4` | 空闲 RSS 660 → 551 MB；冷启动 2186 → 1703 ms |
| 关掉后台网络 / 组件更新 / 崩溃上报 / 扩展 / 默认应用，功能表减去 5 项 | 空闲 CPU 1.87% → 0.03–0.32% |
| `shed()`：冻结前 `gc()` + `Memory.simulatePressureNotification('critical')` | 冻结后 CPU 恒为 0；RSS 在有的轮次 812 → 511 MB，有的轮次不掉——掉多少取决于页面攒了多少缓存，不承诺固定回收量 |
| 复用路径统一 `thaw()` | 冻结页被 `tabFor` / `openTab` / 并发合并任一路径拿到时都会先醒，不再当成活页读 |
| 与 `--disable-gpu`、`--process-per-site`、`--renderer-process-limit=2/3` 对比 | gpu 关掉内存反升到 737 MB、空闲 CPU 8%；process-per-site 686 MB；limit=2 577 MB；limit=3 548 MB；limit=4 **540–551 MB** 且冷启动最好 |

### 方法上的边界

- 竞品的 RSS 是逐进程相加，共享页会重复计一次；我们同一量法，所以对比成立，绝对值偏高。
- 竞品的空闲 CPU 高，一部分是 Chrome 自己在后台干活；用 `sleep 8` 走同一量法得 0.00
  CPU-s、再用 `top -l 2` 交叉验证过，不是量法造成的。
- 页签切换那两行主要花在 wikipedia 加载上（同一工具换 example.com 是 65 / 151 ms），
  不是工具开销，别拿去当工具性能比较。

## 醒来是 0.39 秒，不是 0.80 — 0.47.3

0.47.2 之前 `npm run bench` 报「唤醒 801 ms」，这个数把休息自己的账算到了唤醒头上。
bench 的流程是「触发 rest → 等到进程树内存为 0 → 立刻唤醒」，而那一刻 `Browser.close`
的 promise 还在飞：`shutdown()` 单飞（single-flight）把这次关闭记在 `closing` 上，
下一秒的 `launch()` 在开头 `await this.closing`，于是它先等了 360 ms 才轮到启动浏览器。

同一次运行的两行 trace 把这个说得很清楚：

```
cold: closing 0 · browser 301 · socket 388 · cdp 398 · page 418 · cookies 418 · cast 419 · navigate 524
warm: closing 360 · browser 565 · socket 689 · cdp 700 · page 714 · cookies 715 · cast 715 · navigate 822
```

warm 那行 822 ms 里有 360 ms 是「上一个浏览器还在走」，而真实的人不会在浏览器关到一半时回来。
现在 bench 在开始计时前先等 `closing` 落定、`sidecar.state().alive` 变成 `true`，同一份负载：

| 项 | 0.47.2 口径（关机在飞） | 0.47.3 口径（静止的 rest 之后） |
| --- | --- | --- |
| 唤醒总时间 | 801 ms | **389 ms**（同一次 trace 的阶段账 347 ms） |
| 其中 `closing` | 360 ms | 0 |
| 其余（browser → 能读第一页） | 441 ms | 347 ms |

这不是把慢的藏起来：竞品那边的 `restart_ms` 是 4.5–5.1 秒的整棵重启，量法本来就是
「进程完全不在之后，到能读第一个页面」。改口径只是让两边问的是同一个问题。
真出现「关到一半人回来了」，插件仍然是等关闭完成再用同一个 profile 启动——宁可多等
360 ms，也不让一个还在写的 profile 被新浏览器打开。

## 热页签：和 Playwright 打平，比 DevTools MCP 快 3.2 倍 — 0.47.4

冷启动和唤醒量的是「第一个页面」，可日常最常发生的是「浏览器已经开着，再开一页」。
这一项以前只有 `check-tabs` 打印的一串 `open … ms`，没有跟竞品同法比过。

量法（`/tmp/compbench/warm.mjs` 与本仓库同款 fixture，两侧完全相同）：

1. 一台本地 `http.server` 页面，带 120 个 filler 词，不是 `about:blank`；
2. 先用工具的导航把它打开一次，让浏览器进入「热」状态（此时进程树、socket、渲染器都在）；
3. 连开五页，每一页都「新建页签 + 导航到同一个地址」，从工具调用发出到调用返回计时；
4. 五次的**中位**作为结论，同时留全部样本。

| 工具 | 五页（ms） | 中位 |
| --- | --- | --- |
| 本插件 0.47.4 | 72 · 47 · 45 · 41 · 43 | **41–45** |
| Playwright MCP 0.0.84 | 45 · 82 · 42 · 40 · 87 | **45** |
| Chrome DevTools MCP 1.12.0 | 136 · 127 · 133 · 128 · 130 | **130** |

读法要诚实：

- 对 Playwright MCP 是**打平**，不是领先。两边都是「在新 target 上导航」，都省不掉这一次导航；
  我们的优势在冷启动（0.44–0.66 s 对 2.76 s）、空闲消耗和唤醒，不在开页本身。
- 对 Chrome DevTools MCP 快 3.2 倍，原因是对面每个新页要 `new_page` 后再由模型决定下一步，
  而它是单页模型（`select_page` 切换），多页路径本来就重。
- `check-tabs` 里第一页（tab 1）是冷启动，不进这个中位；从 tab 2 起才是热页签。

这条现在是**防止回退**的闸：`npm run tabs` 断言热页签中位 ≤ 150 ms，并打印每个页签的 `open_ms`。

## 一张截图五十毫秒：三家一样快，差别在回来的东西 — 0.47.5

截图是三家都有的动作，却一直没进过对照表。这次补上，同机、同 fixture、同一步：

1. 一台本地页：`<h1>` 加 120 行 `<p>`，`127.0.0.1` 随机端口，不是 `about:blank`；
2. 先导航一次让浏览器热起来，再连拍四次，从调用发出到返回计时；
3. 本插件走 `browser_shot`（`/tmp/compbench/shot-ours.mjs`），Playwright MCP 走 `browser_take_screenshot`、
   Chrome DevTools MCP 走 `take_screenshot`（`/tmp/compbench/shot.mjs`，`--headless`、mock keychain）；
4. 四次**中位**作为结论，另记 PNG 字节数和回答里真正带回来的负载。

| 工具 | 四次（ms） | 中位 | 回来的东西 |
| --- | --- | --- | --- |
| 本插件 0.47.5 | 43 · 51 · 52 · 50 | **51** | 223 字符文本 + PNG 文件路径（106 648 字节），路由能看图时另附附件 |
| Playwright MCP 0.0.84 | 54 · 50 · 51 · 50 | **51** | 文本 329 字符 + base64 100 644 字符 |
| Chrome DevTools MCP 1.12.0 | 50 · 46 · 53 · 47 | **48** | 文本 49 字符 + base64 383 200 字符 |

读法要诚实：

- **速度是打平**。48–51 ms 的差别在一个样本的抖动里，这一项的成本在 Chrome 的
  `Page.captureScreenshot`：合成、抓帧、PNG 编码，谁调它都要付这笔钱。截图的快慢不会被工具变快。
- **字节不能直接比**：三家各自默认视口不同（本插件这一页可视区 1425×900，PNG 约 104 KB；
  DevTools MCP 的同一页是 287 KB；Playwright MCP 是 75 KB）。字节数只说明「同一张图在不同视口下多大」，
  不是编码效率的排名。
- **真正的差别是文本通道**：本插件把图落成文件、回答里只回路径和 223 字符，图只在模型能看时
  作为附件过去；两家竞品把 base64 放进每一个回答里，100–383 KB。同样的图、同样的看图成本，
  但我们这边不把 base64 挤进文本，路径还能留给后面再用。
- **被证伪并回退**：试过给 `Page.captureScreenshot` 加 `optimizeForSpeed`（用更大文件换更快编码）。
  八轮交替采样中位 41 ms 对 41 ms，字节从 98 352 涨到 129 696（+32%），换不到速度，不采纳。

这条现在是闸：`npm run bench` 新增一段截图测量，连拍四次取中位，断言 ≤ 1000 ms，
并把 `shot_ms` / `shot_median_ms` / `shot_bytes` / `shot_text_chars` 写进 JSON——
它防的不是「比竞品慢」（本来一样快），而是某天有人把同步等待或重试塞进截图路径。

## 六个页签到底花多少 — 0.47.2

0.47.0 的 `--renderer-process-limit=4` 一直只有「一个页面」的数字，页签上限是 6，
六页的真实曲线没人量过。`scripts/check-tabs.mjs`（`npm run tabs`）就是补这一段：
六个会话各开一页本地页，每开一页称一次整棵进程树；六页齐了停手 12 秒量空闲 CPU；
第七个会话验证「上限 6、不许多出一条进程树」。

| 页签 | RSS | 进程 | 渲染进程 | 开页耗时 |
| --- | --- | --- | --- | --- |
| 1 | 864 MB | 8 | 4 | 606 ms（冷启动） |
| 2 | 868 MB | 8 | 4 | 55 ms |
| 3 | 871 MB | 8 | 4 | 41 ms |
| 4 | 873 MB | 8 | 4 | 40 ms |
| 5 | 875 MB | 8 | 4 | 42 ms |
| 6 | 876 MB | 8 | 4 | 41 ms |
| 第 7 个会话 | 873 MB | 8 | 4 | 页数停在 6，LRU 收掉一页 |

读法：

- **每多一页约 +2 MB**，不是每页一份渲染进程。第 2–6 页各 40–55 ms，冷启动那次
  606 ms 是 Chrome 本身，不是页签。渲染进程数从第 1 页起就封在 4，`--renderer-process-limit=4`
  在这里是生效的，不是只在 bench 的单页场景生效。
- **空闲 CPU 1.36%**（12 秒五个样本 4.8 / 1.6 / 0 / 0.4 / 0）。第一个样本含前一次开页的尾巴，
  之后基本归 0。
- 这里量的是 `ps` 的 RSS 求和，macOS 会把共享页重复计入每个进程，所以绝对值和活动监视器
  不一致；竞品用同一套方法量，比较才有意义（见 Phase 25）。

量法上有一处必须说清楚：`ps -o %cpu` 是**进程自启动以来的平均占用**，浏览器刚起来那十秒
无论现在多闲都显示 9% 以上。这一版改成读两次累计 CPU 时间取斜率（`clock_seconds`）再除以
真实间隔，才算得出「现在」的占用。同一份负载，旧口径 9.62%、新口径 1.36%。

0.47.3 再把采样窗口拉到 20 秒，并丢掉前三个还在收开页尾巴的窗口，同一份负载：

| 量法 | 结果 |
| --- | --- |
| 旧：12 秒五个样本全算 | 1.36%（4.8 / 1.6 / 0 / 0.4 / 0） |
| 中：20 秒八个样本全算 | 0.9% |
| 新：20 秒丢掉前 7.5 秒 | **0.24%** |

`npm run tabs` 现在同时打 `avg_pct` 与 `settled_pct`，两个数都留在 JSON 里，
所以「平均」和「稳态」不会被混成一个数字。

## 多会话开页的竞态 — 0.47.2

同一份 harness 在 0.47.1 上根本走不到六页：tab 1 开完、tab 2 开页时报
`Page.enable: sidecar closed`。两页相隔 1.5 秒也会复现，`/tmp/t2.mjs` 三会话最小复现
同样是第 2 个会话失败。

原因不在 Chrome，在我们自己的弹窗跟随：任何一次快照都会 `armFollow(2000)`，给「点击后
过一会儿才弹出的窗口」留 2 秒窗口；另一个会话这时开的页签在浏览器里就是一个新的 page
target，于是被 `adoptOpened()` 当成弹窗 `Target.closeTarget` 关掉——而它的 CDP 还在
握手中。`/json/new` 返回的 target 在 `SidecarPage.start()` 成功之后才 `claim()` 成
本会话的页签，所以在 `start()` 期间它既不是 sibling、也不是 owned，正好是合法的关闭对象。

两道闸：

1. `openTab()` 向浏览器要页签之前先 `disarmFollow()`；
2. 整段创建过程 `making++`，任何已绑定页面在 `making > 0` 时都不把新 target 记成弹窗
   （`bind()` 注入的 `busy()`）。

真实弹窗路径不变：点击打开、`adoptOpened` 接管、导航到弹窗地址都照旧，`test/tabs.test.mjs`
两条新用例分别锁住「忙时不记弹窗」和「闲时仍记弹窗」。

0.47.3 复核了这两道闸没有把真弹窗一起关掉：`npm run bench` 26 项全过，其中
`popup-wait` 中位 **10 ms**（上限 40），`crash-recovery` 1403 ms，`mirror-fps` 29.7；
`npm run tabs` 六页签 864–921 MB、4 渲染进程、稳态 0.24%，第七个会话 `pages 6`。


## 冷启动拆解 — 那 1.2 秒在等谁，0.47.1

0.47.0 的冷启动中位 1703 ms，比同机 Chrome DevTools MCP 的 2185 ms 快，但没有解释：这
1703 ms 里哪些是 Chrome 自己，哪些是我们等的。这一版给 `launch()` 加了阶段打点
（`DSH_INNER_BROWSER_TRACE=1`，stderr 一行），把一次无头冷启动拆成 10 段，然后按段落改。

打点下的原始一次（`sidecar-start: … · closing 0 · login 1 · browser 608 · socket 799 ·
cdp 821 · page 866 · cookies 866 · cast 869 · navigate 996`，总值 997 ms）：

| 阶段（相邻差） | 改前 | 改后 | 这一阶段在干什么 |
| --- | --- | --- | --- |
| `closing` | 0–366 ms | 0–371 ms | 等上一次 `Browser.close` 收尾（单飞，方差来自有没有在休息） |
| `login` | 0–1 ms | 0–1 ms | 登录态目录 |
| `browser`（spawn + 调试端口发现） | 524–606 ms | 156–608 ms | 拉起 Chrome，读 `DevToolsActivePort`；机器冷热差异全在这 |
| `socket`（找到页面 target） | **128–212 ms** | **103–191 ms** | 轮询 `/json/list` 直到有 `page` target |
| `cdp` | 13–20 ms | 12–23 ms | WebSocket 握手 |
| `page` | 14–37 ms | 15–45 ms | 页面域初始化 |
| `cookies` | 1 ms | 0–1 ms | 种登录 cookie |
| `cast` | 2 ms | 0–2 ms | 屏幕推流准备 |
| `navigate` | **107–229 ms** | **103–224 ms** | 首个地址真的加载完 |

三处改动，都只动等待、不动功能：

| change | measured effect |
| --- | --- |
| 调试端口发现不再先无条件睡一轮，改成 5 ms 起步、逐步放宽到 100 ms 的轮询 | `browser` 阶段下限从 524 ms 到 156 ms（上限仍由 Chrome 自己决定） |
| `/json/list` 轮询同样 10 ms 起步、每轮 +15 ms，封顶 100 ms | `socket` 阶段 128–212 → 103–191 ms，均值约省 40 ms |
| `browser_open` 不再为一个「会不会有人看」的画面等 1200 ms；没有面板可显示时不等，有面板时最多等 250 ms | 冷启动 **1703 ms → 465 ms（中位）**，8 次 434–1079 ms |

冷启动改后八次：434、439、444、465、623、658、1020、1079 ms，中位 465–544 ms。剩下的大头
是 Chrome spawn（156–608 ms，取决于系统缓存和机器负载），已经不是我们能压的量；再往下压
只能减少一次 Chrome 启动，那是休息策略的事，不是这里的事。

### 同一次改动换来的读取成本

同一张本地页（40 段正文 + 60 个链接），三家用各自「读一页」的工具，比返回的字符数——这是
模型真正要付的 token：

| tool | chars | 里面有什么 |
| --- | --- | --- |
| 本插件 `browser_view` | **2302** | 可见文字 + 可点控件的编号 |
| 本插件 `browser_read` | **2174** | 只有正文和链接，没有控件 |
| Playwright MCP `browser_snapshot` | 7804 | 同样的页面，每个控件一行 `uid=` |
| Chrome DevTools MCP `take_snapshot` | 5381 | 同上，另一个格式 |

原始记录在 `docs/measure-tokens-2026-11.json`；竞品用 `/tmp/compbench/tok.mjs` 同一个
fixture、同一台机器跑出来，取一次快照的返回文本长度。

### 方法上的边界

- 打点总量是热机器墙钟，`closing` 一项 0 对 371 ms 就能把总量拉出 371 ms 的差；所以跨轮只
  比同一阶段的相邻差，不比总量的绝对高低。
- 冷启动中位变快的主因是「不再等观看者」这一条，而不是端口轮询那两条；后者合计约 40–100 ms。
  三条分开报，不合并成一个「快了 3 倍」。
- bench 里没有面板可显示（`host.want` 不存在），所以走的是「不等」那条路；真实会话里右栏
  存在时会最多等 250 ms，这一档没算进上面的 465 ms。
- `idle CPU` 的 30 s 均值在小样本上跳动大：本轮 8 次里 0.15–1.0%，竞品那一栏是同一量法的
  38.1% / 36.3%，差距的量级不受这点噪声影响。

## Phase 24 — 长期运行的资源回收，0.46.0

一台窗口隐藏的 Chrome 空转一晚就是几百 MB。这一版把「多久收」交给用法自己决定：记住这个人
最近 64 次调用之间的间隔，取 95 分位，休息乘 6、可逆停驻乘 2，各自夹在上下限里；有人看时
永不关闭、只冻结。关闭与启动串行，避免休息和下一次调用撞在一起。

| what | measured |
| --- | --- |
| 20 次调用、间隔 20 秒 | p95 20 s → 休息 120 s，停驻 40 s |
| 30 次调用、间隔 90 秒 | p95 90 s → 休息 540 s，停驻 180 s |
| 没有历史的新进程 | 用下限：休息 90 s，停驻 20 s |
| 右栏关掉（`/sidecar/forget`） | 60 s 后休息，内存归零 |
| 唤醒 | 326–1010 ms，回到同一页同一地址 |
| soak 24 轮＋3 次真实休息 | 40.1 s，内存 1427 → 956 MB，页数始终 1 |
| soak 16 轮＋2 次真实休息 | 26.8 s，内存 1308 → 900 MB |
| 休息与调用相撞 | 关闭单飞、启动等待；0.45.0 会在第 8 轮把新连接关掉（已复现、已修） |
| 内存预算 | 2400 MB / 30 s 一次称重；超预算先收 LRU 页签、降码率，无人看才休息 |
| 崩溃循环 | 10 分钟内 3 次 → 拒绝启动并说明原因 |
| suite | 42 pass（sidecar）· rest 9 pass · soak/rest 端到端全过 |

## 工具面动作耗时 — 0.47.16

前面几节量的是协议往返；模型付的钱是工具调用外面那一圈——认控件、等页面、把结果整成它能读的字。`scripts/bench-actions.mjs` 因此在 `tool.execute` 外面掐表，跟 `browser_*` 走同一条路。夹具是一个本地进程里现起的页（一个 h1、一个只有输入框和按钮的表单、40 句 × 44 字的段落、60 条列表项），headless Chrome，`--reps 12`，先各跑 2 次热身再记；`read` / `view` 每次计时前先把页面上一个 tick 节点改掉（改的那一下不算在计时里），所以量到的是「页面真的动了之后要付多少」，另两行是「同一页再读」的去重路径。

| 动作 | 中位 | p95 | 最大 | 返回字符 | ≈token |
| --- | --- | --- | --- | --- | --- |
| `browser_read`（页面动过） | 1 ms | 1 ms | 2 ms | 1545 | 387 |
| `browser_read`（同一页再读） | 0 ms | 1 ms | 4 ms | 193 | 49 |
| `browser_view`（页面动过） | 3 ms | 3 ms | 6 ms | 1373 | 344 |
| `browser_view`（同一页再看） | 2 ms | 5 ms | 6 ms | 194 | 49 |
| `browser_click`（按文字点） | 17 ms | 18 ms | 18 ms | 43 | 11 |
| `browser_type`（5 个字符） | 108 ms | 114 ms | 122 ms | 48 | 12 |
| `browser_shot`（当前屏） | 50 ms | 51 ms | 52 ms | 224 | 56 |
| `browser_eval` | 0 ms | 1 ms | 1 ms | 7 | 2 |
| `browser_open`（冷，一个页） | 633–687 ms | — | — | — | — |

怎么读这张表：

- **重复读是白拿的**：同一页、同一形状再读一次，387 → 49 token、344 → 49 token，时间是 0–2 ms。这是本项目和竞品拉开差距的地方——Playwright MCP / Chrome DevTools MCP 每读一次都是整页重新渲染一次给模型。
- **`browser_type` 的 108 ms 不是卡**：5 个字符按 10–28 ms/字的真人节奏落键（0.34.x 起就这么做，页面上看到的是逐键 keydown + input，不是一次性 setValue）。要更快就走 `mode: "dom"`。
- **`browser_click` 的 17 ms** 是已经知道点哪个之后的三次 CDP 发送；0.34.42 那张表里的 97 ms 含一次读页找控件，夹具不同，不能相减。
- 这些数没有和竞品同夹具横比：五家对照那节的数字是 0.47.6 用 `docs/RESOURCES.md` 的协议量的，动作这一维要在同一台机、同一个页、同一个「先读再点」流程下重跑才能并表。0.47.17 补上了这一轮，见下一节。

`node scripts/bench-actions.mjs --reps 12 --json out.json` 复现；末行是 JSON，`actions.<名字>.{median,p95,min,max,chars}` 与 `tokens`，任何一项中位 ≥ 500 ms 或最大 ≥ 2000 ms 会进退出码。

## 动作面三方对照 — 0.47.17（同机、同夹具、同流程）

上一节的数字只有自己。这一轮把同一张表搬到同一条跑道上：三套东西各起**自己的** Chrome（同一个二进制），顺序跑、不并发，page 都是本机临时端口上的同一份 fixture（一个 h1、一个只有输入框和按钮的表单、40 句 × 44 字的段落、60 条列表项）。`--reps 8`，每个动作先热身 2 次再记，取中位；计时都在工具调用外面——本项目是 `tool.execute` 外面，两家 MCP 是 `tools/call` 的 JSON-RPC 往返外面，都不含 `initialize` / `tools/list`。

| 动作 | 本项目 0.47.17 | Playwright MCP 0.0.84 | Chrome DevTools MCP 1.12.0 |
| --- | --- | --- | --- |
| 打开一页 | 578 ms | 556 ms | **133 ms** |
| 第一次读页 | **0 ms** / 1713 字符 | 10 ms / 8000 字符 | 5 ms / 5522 字符 |
| 同一页再读 | **0 ms** / 193 字符（≈49 token） | 7 ms / 8000 字符（≈2000 token） | 5 ms / 5522 字符（≈1381 token） |
| `browser_view`（第一次 / 再看） | 3 ms / 1698 · 2 ms / 194 | —（无独立 view） | —（无独立 view） |
| 按文字点一个按钮 | **17 ms** / 43 字符 | 537 ms / 233 字符 | 240 ms / 35 字符 |
| 往输入框打 5 个字符 | 101 ms / 48 字符 | **4 ms** / 100 字符 | 208 ms / 18 字符 |
| 截当前屏 | 49 ms / 224 字符 + 图 | 43 ms / 329 字符 + 图 | 40 ms / 49 字符 + 图 |
| 求值 | **0 ms** | 未测（工具名对不上夹具） | 未测 |
| 工具总数 | 24 | 25 | 32 |

怎么读这张表（不看这几条就会读错）：

- **读页的 token 差距是真的，但两家的字数是上限不是全量**：Playwright MCP 每次快照恰好 8000 字符（`--reps 8` 八次全是 8000，页比这长，是服务端截断），DevTools MCP 每次 5522 字符；两家**再读一次都重新发整页**。本项目第一次 1713 字符是「只给能读的字」，再看一次 193 字符是「这页没变，上面那段就是」。同样读三遍：本项目 ≈487 token，另两家 ≈6000 / ≈4143 token。
- **点击 14–31 倍不是同一件事的 14 倍**：Playwright MCP 的 `browser_click` 自带可操作性等待（等到可点、稳定、不被遮）并在动作后重新快照，537 ms 里大头是它自己等的；而且它的 `[ref=e6]` 在**任何**后续快照后失效，所以同一条流程里它必须「快照 → 立刻点」，那次快照的时间没算进 537。DevTools MCP 的 240 ms 是 `pageId` + `uid` 直接点，比 Playwright 省一半。本项目的 17 ms 是「已经知道点哪个」之后的三次 CDP 发送（移、按、抬），命中测试在调用前就做完了。
- **打字这一行是三种契约，不是快慢**：Playwright 的 4 ms 是一次 fill（页面上看到的是值直接出现）；DevTools 的 208 ms 是逐键真事件，但它要先点一下输入框才有焦点，那一步的成本没算进这行；本项目的 101 ms 是刻意的真人节奏（10–28 ms/字，页面上是 keydown + input）。要一次落值走 `mode: "dom"`，页面上看得出来。
- **打开一页**：DevTools MCP 的 133 ms 最快，因为它只回 `pageId`、不等标题也不等真实地址；本项目的 578 ms 里含等到非 `about:blank` 的真实 URL 与标题。这不是同一份回执，不能只看毫秒。
- 截图三家都 40–50 ms，差别在回执形状：本项目给的是绝对路径 + 224 字符，另两家是 base64/内联图或 `Uint8Array`（同屏 PNG 106 648 B vs 75 483 B，见 0.47.6 那节）。

复现：本项目 `node scripts/bench-actions.mjs --reps 8 --json out.json`；两家 MCP 用 `/tmp/compbench2/bench.mjs`（`--only playwright|chrome-devtools --reps 8`，各起自己的 headless Chrome，`--use-mock-keychain`）。两家的数都来自实测，不是估算；MCP 语义（Playwright 的 `target` 是字符串 ref、ref 会被下一次快照作废；DevTools 每个页面工具都要数字 `pageId`、`type_text` 不收 `uid`）是在这份脚本里踩出来的，写在 `docs/RESOURCES.md` 的读数笔记里。

## 打字契约 — 0.47.19（同机、同夹具、`--reps 6`）

夹具是一张本地页面：一个 `<label>Search <input id="q">`、一个 `<label>Name <input id="n">`、一个 Go 按钮。
`browser_type` 五种用法各跑 8 次、前 2 次热身丢弃，取中位；每轮跑完用 `browser_eval` 把两个输入框清空，
所以每轮都从空框开始。计时在 `tool.execute` 外面。

| 用法 | 中位 | p95 | max | 回执字符 |
| --- | --- | --- | --- | --- |
| `type`（不给目标，页面上没焦点） | 107 ms | 110 ms | 124 ms | 48 |
| `type_field`（`field: "Name"`，普通输入框，5 字符） | 122 ms | 141 ms | 149 ms | 58 |
| `type_long`（`field: "Name"`，480 字符） | 131 ms | 143 ms | 147 ms | 113 |
| `type_search_long`（`field: "Search"`，480 字符） | **274 ms** | 279 ms | 326 ms | 117 |
| 0.47.18 同一条：搜索框 480 字符 | 997 ms | — | 1037 ms | 117 |

怎么读：

- **字数和耗时脱钩的才是快路**：`type_long` 480 字符 131 ms 与 `type_field` 5 字符 122 ms 只差 9 ms，因为两行都走
  `quickType`——两次 `Runtime.evaluate` 读值 + 一次 `Input.insertText`，写完再读一次确认。耗时的大头是调用前的
  「移动三小步 + 按下抬起 + 清空旧值 + 30 ms 等页面反应」，约 70 ms，按键本身不到 10 ms。
- **搜索框的 997 → 274 ms 是这一轮修掉的那条**：页面靠 keydown 过滤，所以开头 8 个字仍是真键（8 × 10–28 ms），
  其余一次提交。剩下的 274 ms 里约 150 ms 是那 8 个真键的节奏，约 70 ms 是移动/点击/清空，真正可再压的只有
  「要不要连 8 个键都省掉」——省掉就不再是搜索框该有的行为了。
- **`type`（107 ms）和 `type_field`（122 ms）不是同一件事**：裸打时页面上没有焦点，`quickType` 读到的
  `document.activeElement` 是 body，两头一致（都是空）于是判定「没落值」，退回逐键真人节奏；给了字段才会先点击
  那个框。这一行留在表里是为了说明「101–108 ms 不是打字慢，是没目标」。
- **和竞品对照请看上一节的注意事项**：Playwright MCP 的 4 ms 是 fill，DevTools MCP 的 208 ms 不含它必须先做的
  聚焦点击，两家都没有真人节奏这条契约。本项目要一次落值用 `mode: "dom"`，回执会说 `typed into`。

第二次 `--reps 8` 复跑：`type` 101 / `type_field` 133 / `type_long` 132 / `type_search_long` **267 ms**，
与上表同量级（搜索框那条 997 → 274 → 267）。

复现：`node scripts/bench-actions.mjs --reps 6 --json out.json`（`actions.type_field` / `actions.type_long` /
`actions.type_search_long` 三行）。

## 点击到开打 — 0.47.20（同机、同夹具、`--reps 8`）

两次运行隔几分钟、同一夹具同一 profile：前一次是旧代码（固定等待），后一次是 `focusedAt()` 轮询焦点。

| 行 | 固定等待 | 轮询焦点 | 变化 |
| --- | --- | --- | --- |
| `type_ref`（按 `browser_view` 的编号打 5 字符） | 129 ms | **53 ms** | −59% |
| `type_field`（按字段名打 5 字符） | 143 ms | **114 ms** | −20% |
| `type_long`（按字段名打 480 字符） | 140 ms | **118 ms** | −16% |
| `type_search_long`（搜索框 480 字符） | 268 ms | 267 ms | 持平 |
| `type`（无目标裸打） | 93 ms | 96 ms | 噪声 |

怎么读：

- `type_ref` 省下的 76 ms 几乎全是原来那句固定 `wait(80)`：页面通常一两帧内就把光标放进字段，剩下的七十多毫秒是白等。
- 上限和原固定等待的最大值相同（`ref` 80 ms、`field` 32 ms），每 4 ms 问一次，所以「慢页面」的最坏情况不变；唯一的行为差别是**快页面提前返回**。
- 判定用 `document.elementFromPoint(x, y)` 与 `document.activeElement` 是否同在一棵子树里且那个控件可输入，不是「页面上有焦点」——「点新字段、旧字段还带着光标」不会被误判。
- `type_search_long` 持平，说明这一轮没碰键的节奏：它贵在开头 8 个键和落值后的 30 ms 等待。
- `type` 那行的 93→96 ms 是噪声，同一夹具前后两次都在 ±10 ms 内浮动。

复现：`node scripts/bench-actions.mjs --reps 8 --json out.json`，看 `actions.type_ref` / `actions.type_field` /
`actions.type_long` / `actions.type_search_long`。

## 打字收尾 — 0.47.21（同机、同夹具、`--reps 8`）

上一轮把「点击后等光标」换成了条件轮询，这一轮把「落值后再等 30 ms」整段去掉。两次运行同夹具同 profile，前一次保留两处 `wait(30)`：

| 行 | 有 30 ms 静默（0.47.20） | 无静默（0.47.21） | 变化 |
| --- | --- | --- | --- |
| `type_field`（按字段名打 5 字符） | 114 ms | **78 ms** | −32% |
| `type_long`（按字段名打 480 字符） | 118 ms | **84 ms** | −29% |
| `type_search_long`（搜索框 480 字符） | 267 ms | **231 ms** | −13% |
| `type_ref`（按编号打 5 字符） | 53 ms | **29 ms** | −45% |
| `type`（无目标裸打） | 96 ms | 99 ms | 噪声 |

和 0.47.19 的固定等待基线并排看，这条链两轮共省：`type_ref` 129 → 29 ms、`type_field` 143 → 78 ms、`type_long` 140 → 84 ms、`type_search_long` 268 → 231 ms。

为什么可以直接去掉：

- `quickType()` 返回 `true` 的条件就是**回读到了新值**，DOM 已经改完；`Input.insertText` 触发的 `input` 监听在返回前就跑完了。
- 两个调用方本来就接着读页面：`browser_type` 走 `settle()`（两次读页、至少 12 ms 间隔、页面 `complete` 才放行），`browser_do` 走下一步。回复本身是一行「typed into …」，不含页面快照，所以这段静默从来没有让回复更新鲜。
- 延迟反应夹具（`queueMicrotask` / `requestAnimationFrame` 写回显、`requestAnimationFrame` 改大写）验证：去掉静默后大写读回 3/3 正确，随后的 `browser_view` 两个回显都在，同一夹具打字中位 115 → 83 ms。

复现：`node scripts/bench-actions.mjs --reps 8 --json out.json`。

## 打字节奏 — 0.47.22（同机、同夹具、`--reps 8`）

搜索框那条路径上一轮还在真敲 8 个键、键间带 10–28 ms 停顿，这一轮只真敲前 3 个键、键间 2–5 ms，
其余一次 `Input.insertText` 提交。同夹具同 profile，前后两次运行：

| 行 | 0.47.21 | 0.47.22 | 变化 |
| --- | --- | --- | --- |
| `type_search_long`（搜索框 480 字符） | 231 ms（p95 237 / max 239） | **89 ms**（p95 99 / max 107） | −61% |
| `type_field`（按字段名打 5 字符） | 78 ms | 79 ms | 噪声 |
| `type_long`（按字段名打 480 字符） | 84 ms | 84 ms | 同 |
| `type_ref`（按编号打 5 字符） | 29 ms | 29 ms | 同 |
| `type`（无目标裸打 5 字符） | 99 ms | 102 ms | 噪声 |

为什么 3 个键够：页面要在打字过程中过滤，只需要看到几个 trusted 的 `input` 事件开始第一次过滤，
之后一次批量提交不会改变它对外呈现的结果。夹具逐条核对过：4 个 `input` 事件全是 `isTrusted`，
长度按 1→2→3 增长，随后一次提交，文字无损（468/468 字符），提交偏移跟着前导长度走。

## 去重与真读 — 0.47.22（同机、同夹具、`--reps 8`）

这一轮给 `pageMark()`（去重判断用的页面指纹）加了正文校验和，于是顺手在基准里加了每行**最小/最大**
字符数，并断言「每一次 `read` 都必须是页面正文」。加完才发现上一轮那张表里两行的字符数不是单一东西的均值：

| 行 | 0.47.21 均值字符（≈token） | 0.47.22 均值字符（8 次的最小–最大，≈token） | 中位 |
| --- | --- | --- | --- |
| `read`（页面动过） | 701（≈176）——8 次里 2 次真读、6 次提示 | **2221**（2217–2224，≈556）——8 次全是真读 | 0 → 1 ms |
| `read_repeat`（同一页再读） | 193（≈49） | 193（193，≈49） | 0 ms |
| `view`（页面动过） | 1513（≈379）——8 次里 5 次真读、3 次提示 | **2310**（2306–2313，≈578）——8 次全真读 | 3 ms |
| `view_repeat`（同一页再看） | 194（≈49） | 78（78，≈20） | 2 ms |

均值里的混合可以算出来：`(2 × 2217 + 6 × 193) / 8 = 699`（对上 701），`(5 × 2310 + 3 × 194) / 8 = 1515`（对上 1513）。
也就是说 0.47.21 报的「读一页 ≈176 token」实际是「2 次读页 + 6 次『上面那段就是』」的平均，**低估了真读成本约 3 倍**。
延迟本来就分不开（提示和真读都是 0–1 ms），所以错的只有字符与 token 这两列，0.47.22 的基准用 `charsMin` 把它钉住。

去重本身没有退化：同一页再读还是 193 字符 / ≈49 token，再 view 78 字符 / ≈20 token。
校验和的开销落在每次 `browser_read`、两条 `browser_view` 路径和每条动作回执上，实测读 1 ms、view 3 ms、
点 16 → 17 ms、eval 0 ms，与上一轮同量级。

复现：`node scripts/bench-actions.mjs --reps 8 --json out.json`（末行 JSON 里每行多两个字段 `charsMin` / `charsMax`）。

## 大页成本 — 0.47.23（同机、同夹具、`node scripts/bench-pagesize.mjs --reps 7`）

0.47.22 给 `pageMark()` 加了正文 djb2 校验和，每次读、两条 view 路径和每条动作回执都要多走一遍
`body.innerText`。夹具只有 2215 字，看不出这笔钱；这一节把它放到 344 KB / 2514 个节点上量，
同时确认「大页」不会把读取通道拖垮。三种页面由同一个本地进程现发，同一个 headless 浏览器依次打开，
每行 7 次取中位（`--json` 落盘）。

| 页面 | 正文 | 节点 | 读 | view | 点 | 指纹（数长度 → 加校验和） | 宿主 `pageMark` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| small | 1 645 字 | 26 | 1–2 ms / 1 672 字 | 3 ms / 1 717 字 | 28 ms | 0 → 0 ms（+0） | 0.3 ms |
| medium | 43 754 字 | 334 | 2 ms / 6 092 字 | 6 ms / 2 822 字 | 25 ms | 0 → 0.1 ms（+0.1） | 1.0 ms |
| large | 343 913 字 | 2 514 | 5–6 ms / 6 090 字 | 14 ms / 2 820 字 | 27–28 ms | 0.3 → 2.2 ms（**+1.9**） | 2.9 ms |

三件事：

- **指纹的钱花在正文长度上，不在校验和上**。344 KB 的页，只数字数 0.3–0.4 ms，加 djb2 是 1.9–2.2 ms，
  即每秒约 170 MB 的 charCodeAt 循环；这笔开销只有页子这么大时才出现，而同一时刻 `innerText`
  本身、序列化、CDP 往返都在这条路上，`pageMark` 整趟仍是 **2.9 ms、一次往返**。基准钉的闸门是
  「校验和 ≤ 3 ms、整趟 < 10 ms」，退化会红。
- **读被预算截住，不是被大页拖慢**：344 KB 的页读出来是 **6 090 字**（`browser_read` 的预算），
  耗时 5–6 ms——比 43 KB 的页只多 3–4 ms，因为多数正文根本没序列化。view 14 ms / 2 820 字同理，
  大页不会把「看一眼」变成几万 token。
- **78 字那行是去重提示，不是页面**：紧接着 read 的 view 会被判「没变化」只回一句提示。这一节
  每次 view 前把 `#tick` 改一个字，量的才是真 view（1 717 / 2 822 / 2 820 字）；0.47.21 基准
  踩过的同一个坑，这次在脚本里就用打点躲掉了。

8 项检查全过：三档都有正文、大页被截到预算内、读 < 200 ms、view 回的是控件不是提示、
大页校验和 ≤ 3 ms、整趟指纹 < 10 ms。复现：
`node scripts/bench-pagesize.mjs --reps 7 --json out.json`。

## 稳定性核验 — 0.47.23（0.47.22 改完之后重跑）

改指纹和打字路径之后，长跑、六页签、休息唤醒三条链各重跑一次，确认没有把资源回收弄坏：

- `npm run soak`：24 轮 **10.5 s**，RSS **1 128 → 1 000 MB**（增长 −128 MB，天花板 2 500 MB），
  页数始终 1，3 次真实休息每次都把内存还回去，24 次读全部有答案。
- `npm run tabs`：热浏览器再开一页中位 **45 ms**（63 / 47 / 41 / 45 / 43），六页签 **812 MB**、
  8 进程 / **4 渲染进程**、空闲 **0.6%**（稳态 **0.08%**）一个核；第 7 个会话拿到自己的页、
  树没多长（812 → 829 MB、8 → 10 进程、仍 4 渲染进程）。
- `npm run rest`：休息后内存归零、状态说 `stopped`、原因写在记录里；再读自愈回原地址、
  页面内容还在，**唤醒 661 ms**（sidecar 自计 613 ms）。同一套脚本 0.47.3 时量到 389 ms，
  这次机器更忙，区间按 **389–661 ms** 记——量的是「关到一半回来」不会发生，不是追一个最小数。

三条链都是 `EXIT=0`，没有任何一项退化到需要修。
