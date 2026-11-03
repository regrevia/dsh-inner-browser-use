## 0.47.24 — Flash 窗口里的输入真正进到影片：点中了、字进去了，每个动作 1–4 ms

- **点击坐标错了一倍，已修**。`sendInputEvent` 的坐标本来就是 DIP，与 CSS 1:1，旧桥接又乘了一次窗口缩放：`browser_click` 点 (40,30) 实际落在 (80,60)，游戏里点不中任何东西。缩放乘法删掉后实测点 (40,30) 命中页面 (40,30) 的元素，`buttons` 1 → 0。
- **按下事件以前到页面时没有按键状态**：普通 `mouseDown` 以 `buttons:0` 到达，拖动与选中都用不了。现在按下补 `leftButtonDown` 修饰位、移动带住已按下的键，拖动路径（`mouseMoved` + `mousePressed` + `mouseReleased`）才成立。
- **命名键以前是空键**：`ArrowUp` 以 `key="" keyCode=0` 到达页面，翻页、删除、回车都可能变成无操作。现在按 accelerator 名映射（`ArrowUp→Up`、`PageUp`、`Delete`、`Enter`、`Space`…），实测 `ArrowUp` 38、`PageUp` 33、`Delete` 46（真的删掉一个字符）、`Enter` 13，`key` 是真名；普通字符仍以字符本身进 `keyCode`，`keypress` 的 `charCode` 正确（a → 97），`input` 事件逐字到达（输入框从空到 `ab`、到 `xxxxxx`）。
- **输入契约抽成可测的纯模块**：新增 `runtime/flash-input.cjs`（`planInput` 决定状态码与事件，`MAX_INPUT_BYTES` 8 KB），`runtime/flash-app/main.js` 只负责读 body 与 `sendInputEvent`；`test/flash-input.test.mjs` 7 项钉住 405/413/500/503/400、坐标 1:1、按钮位、滚轮增量、命名键拼写、修饰键位。`test/sidecar.test.mjs` 的源码断言跟着改成 `sendInputEvent(plan.event)`。
- **桥接卡住时不再每个事件赔 1.2 秒**：请求挂起（而不是拒连）时，一次点击要等超时才退回 CDP，连续动作慢到没法用。现在连续 2 次失败就把桥接放 30 秒假，期间一个事件最多 1.2 秒、动作走 CDP；`browser_state` 多一行 `flash input bypassed N s` 让人知道慢在哪，唤醒浏览器时清零重新给机会。实测全部探针 `inputFails` 0、无回退。
- **声音一开就起不来的真 bug 修了**：宿主进程带着 `ELECTRON_RUN_AS_NODE=1`，Electron 11 把命令行当 Node 参数，报 `bad option: --mute-audio` 直接退出。启动环境删掉该变量后，`DSH_FLASH_SOUND=1` 启动成功（`alive` true、页面可读、键入 `ab` 落地），运行中 `/sound` 关→开都返回 true。
- **`main.js` 加载输入模块的路径错了**：`require('./flash-input.cjs')` 在 `flash-app/` 里找不到上层文件，改 `../flash-input.cjs`。
- **实测延迟（真实 Electron 11.3.0 窗口，无缩放）**：按下+松开中位 **1.3 ms**（p95 3.3、最大 10.6，首个含冷路径）、一次按键 **1.0 ms**（p95 1.6）、一次滚轮 **0.4 ms**、`humanType` 每字符 **3.5 ms**。0.47.23 之前那组 `pressMs 8 / keyMs 3` 是带错误缩放的管线，作废。
- **诚实边界**：以上是窗口里普通 HTML 的端到端证明——坐标、按钮位、命名键、文字落地走同一条桥接；影片内部（`loop.swf`）只验到「事件确实送进渲染进程」，游戏自身响应仍需真实游戏复核。`docs/FLASH.md` 新增一节写清四条根因与上表。

## 0.47.23 — 大页上也量了一遍：指纹 1.9 ms，读被预算截住

- **大页成本的第一个实测**：新基准 `scripts/bench-pagesize.mjs` 现发 1.6 KB / 43 KB / 344 KB 三档页面（344 KB / 2 514 个节点），同一套 headless Chrome、每行 7 次取中位。结果：**读 5–6 ms / 6 090 字**（`browser_read` 的预算截断，比 43 KB 的页只多 3–4 ms）、**view 14 ms / 2 820 字**、点 27–28 ms；0.47.22 加的 djb2 校验和在这张页上 **0.3 → 2.2 ms（+1.9）**，宿主 `pageMark` 整趟 **2.9 ms、仍是一次往返**。闸门钉住「校验和 ≤ 3 ms、整趟 < 10 ms」，8 项检查全过。
- **基准自己先踩了 0.47.21 的坑**：紧接着 read 的 view 会被判「没变化」只回 78 字提示，第一版就把 78 字当成 view 的结果。脚本改成每次 view 前改一个字符（`#tick`），量的才是真 view（1 717 / 2 822 / 2 820 字），并断言三档都回控件。
- **0.47.22 改完之后三条稳定性链重跑，全绿**：soak 24 轮 **10.5 s**、RSS **1 128 → 1 000 MB**、页数始终 1、3 次休息都归还内存；六页签 **812 MB / 8 进程 / 4 渲染进程 / 空闲 0.6%（稳态 0.08%）**，热开一页中位 **45 ms**，第 7 个会话 812 → 829 MB 不涨树；休息后内存归零、唤醒回原页 **661 ms**（自计 613 ms，0.47.3 时 389 ms，区间 389–661，机器负载不同）。
- 文档、`docs/MATURITY.md` 的六页签 / 长跑 / 休息唤醒 / 大页四行按这次的数字更新；`package.json` 加 `bench-size` 入口与文件清单；**295 测试**、`node --check`、`bench-actions --reps 8` 18 项、`bench-pagesize --reps 7` 8 项全绿。

## 0.47.22 — 页面变了一个字就算变了，实时打字不再补节奏

- **搜索框里的 480 字符：231 → 89 ms**（p95 237 → 99，同机同夹具 `--reps 8`）。0.47.19 把这条路径改成「开头真敲 + 其余一次提交」，0.47.21 又去掉了落值后的 `wait(30)`，剩下的 231 ms 几乎全是那几个键的 `Input.dispatchKeyEvent` 之间的 10–28 ms 停顿——那是替页面预支的节奏，不是页面要求的。现在只真敲**前 3 个键**（搜索框靠这几个键就开始过滤），其余一次 `Input.insertText` 提交；3 个键仍带 2–5 ms 间隔，边打边过滤的页面看到的还是 trusted 的逐键 `input`：夹具逐条核对到 4 个 `isTrusted` 的 `input`、长度 1→2→3 三次增长、之后一次批量提交、文字无损 468/468。提交偏移跟着前导长度走（上一版硬编码 `slice(8)` 配上 3 键就是这条路径唯一的正确性 bug，现在被测例钉住）。
- **内容变了却回答「没变化」的真 bug 修了**：`pageMark()` 是去重判断的指纹，原来是 `标题|地址|正文字数|控件数`，字数一样就算同一页——把 `ready` 换成 `error`、把 `1,200` 改成 `2,200`（同长度）都会被答「still here — nothing changed since the last read; the numbers above still work」，用户拿到的是过期页面。现在第 5 个字段是正文的 djb2 校验和，同长度替换立刻算变化。开销落在每次 `browser_read`、两条 `browser_view` 路径和每条动作回执上，实测没有可测代价：读 1 ms（与修前一样）、view 3 ms、点 16 → 17 ms、eval 0 ms。
- **基准行不再被「提示」冒充页面读取：0.47.21 报的读页数字是错的**。`scripts/bench-actions.mjs` 每行加了最小/最大字符数（`charsMin / charsMax`），并断言每一次 `read` 都必须是页面正文。一加就看出来：0.47.21 报的 `read` **701 字 / ≈176 token** 是 8 次里 2 次真读（约 2217 字）加 6 次「the text is the one above」提示（193 字）的均值，`view` 的 **1513 字 / ≈379 token** 同理（5 次真读 + 3 次提示）。**修正后的真实数字：读一页 2221 字 / ≈556 token，view 2310 字 / ≈578 token，延迟不变（1 / 3 ms）**；同一页再读仍是 193 字 / ≈49 token，再 view 78 字 / ≈20 token，去重没退化。`docs/MATURITY.md` 里旧的两处 token 数已一并更到这里。
- **295 测试全绿**（新增 `pageMark` 同长度替换回归、3 键节奏与无损提交断言），`node --check` 通过；`scripts/bench-actions.mjs --reps 8` **18 项检查全过**、`BENCH_EXIT=0`。

## 0.47.21 — 打完最后一个字就交还，不再补半帧静默

- **打字再快 25–45 ms，两轮下来累计减半**。`typeInto()` 两条快路径（一次粘贴、搜索框「开头 8 键 + 一次提交」）在确认落值后又各停 `wait(30)`，等于替调用方预支半帧。实测这段时间从来没人用：`browser_type` 打完立刻 `settle()`（本身至少两次读页 + 12 ms 间隔），`browser_do` 打完直接进下一步，回复都是一行确认。去掉后同机同夹具 `--reps 8`：**按字段名打 5 字符 114 → 78 ms**、**480 字符 118 → 84 ms**、**搜索框 480 字符 267 → 231 ms**、**按编号打 53 → 29 ms**。
- **从 0.47.19 算起这条链省了 56–100 ms**：按编号打 129 → 29 ms、按字段名打 143 → 78 ms、480 字符 140 → 84 ms。
- **延迟不影响新鲜度**：为确认「不打字后停」不会让下一次读拿到旧页面，专门做了延迟反应夹具——输入框的 `input` 监听分别用 `queueMicrotask` 和 `requestAnimationFrame` 写回显、另一个框用 `requestAnimationFrame` 把值改大写。三组各刷 5/3 次：大写读回 3/3 正确，随后一次 `browser_view` 两个回显都在。去掉等待后同一夹具打字中位 115 → 83 ms。
- **294 测试全绿**（新增「粘贴确认即返回、两条路径都不再停」一例，断言单次调用 < 20 ms），`ui-copy-lint` 55 error / 27 warning = 基线未变，`style-lint` 通过。

## 0.47.20 — 点完输入框不再等固定毫秒数，光标进去了就打

- **按编号打字快了 59%，按字段名快了 20%**。以前点完控件一律先停：按 `ref` 打是固定 `wait(80)`，按 `field` 打是 `14–32` ms 的随机停，赌页面在这个窗口里把焦点交出来。实测这是打字里最贵的一段白等——页面通常一两帧就把光标放进去了。现在 `focusedAt()` 每 4 ms 问一次「指针下面那个控件是不是拿到了光标」，拿到立即往下走；问不到仍然等满原来的上限，慢页面待遇一字不变。同机同夹具 `--reps 8`：**`type_ref` 129 → 53 ms**、**`type_field` 143 → 114 ms**、**`type_long`（480 字符）140 → 118 ms**。
- **判断条件是「指针下那个控件里有光标」，不是「页面上有焦点」**：`document.elementFromPoint(x,y)` 与 `document.activeElement` 必须同在一棵子树里且那个控件可输入，所以「点新字段、旧字段还带着光标」不会被误判成已就位。
- **搜索框长文持平（268 → 267 ms）**：它贵在开头 8 个键的真人节奏和落值后的 30 ms 等待，不是点击后的等待；这一轮没碰键的节奏。
- **新增基准行 `type_ref`**：按 `browser_view` 给出的编号打一次，读数在计时窗外。之前这张表只有 `field` 一条路，读者会以为两种命名方式一样贵。
- **293 测试全绿**（新增「光标就位就返回、问不到等满预算」一例），`ui-copy-lint` 55 error / 27 warning = 基线未变，`style-lint` 通过。

## 0.47.19 — 搜索框里的长文不再一个字一个字敲

- **长文进搜索框：3.6 倍**。`typeInto()` 对提示词命中 `search|query|lookup|filter|搜索|筛选|查询` 的输入框一律走逐键真人节奏（页面靠这些键过滤列表，不能一次落值）。问题是字数一多这条规则就变成纯等待：480 字符的查询 480 次 `Input.dispatchKeyEvent`，实测 **997 ms**（`--reps 6` 中位）。现在改成「开头 8 个字照样真敲，剩下的部分一次 `Input.insertText` 提交」——过滤在前 8 个键已经发生，其后一次性提交不再改变结果，同一夹具同一段文字重测 **274 ms**（中位，`--reps 6`，`type_search_long` 行）。短文本、普通输入框、`mode: "dom"` 三条路都没动。
- **动作面基准补了三行契约**，因为原来那张表只有一个 `type` 行，读的人会以为「打字就是 101 ms」：`type_field`（给了非搜索字段 `Name`，走 `quickType` 一次落值）**122 ms**、`type_long`（480 字符进同一个普通输入框）**131 ms**、`type_search_long`（同一段进搜索框）**274 ms**，都含「移动 + 点击 + 清空」这一圈，与无目标裸打的 107 ms 并列写清。基准里另加第二个输入框 `<label>Name <input id="n">`，`type` 行每轮两个框都清空。
- **打字这一维和竞品的差距被拆开说**：Playwright MCP 的 4 ms 是一次 fill（页面直接看到值），DevTools MCP 的 208 ms 是逐键真事件但前面的聚焦点击没算进去；本项目 122 ms 里有约 70 ms 是「移动、点击、清空、等 30 ms 让页面反应」，不是按键本身。要一次落值仍走 `mode: "dom"`，页面上看得出来。
- 回归：`test/host.test.mjs` 那条打字契约单测加了长文搜索框分支——断言先 `keys:` 前 8 个字符、再 `paste:` 其余，且字数阈值（>160）以下仍全部真敲。292 测试全绿；`node scripts/bench-actions.mjs --reps 6` 全部检查通过。

## 0.47.18 — 逃出进程组的 Flash 助手也要收掉，按这台会话的端口认人

- **收尾多一层扫尾**：Flash 桥是一个 Electron 主进程加五个助手，正常走「自己的进程组一把 SIGKILL」；但 Electron 会把个别助手重挂到别的父进程下，那种助手既画画也**继续出声**，而主进程和端口都已经没了，普通检查看不见它。`putAway()` 在组杀之后读一次 `ps -E -Ao pid=,command=`（本机 39 ms / 372 KB），按环境里的 `DSH_FLASH_BRIDGE_PORT=<本会话的桥端口>` 认出残留并逐个 `SIGKILL`；端口只发过给这一台桥，所以不会碰另一个会话正在看的游戏。
- **为什么不用「argv 里有 runtime/flash-app」认人**：那个指纹是全机共享的，多个会话各开一个游戏就分不清了；端口和 `DSH_FLASH_UDD` 是每台桥独有。扫尾只在 macOS 做（`ps -E` 才带环境），且只在真开了 Flash 桥的会话、仅在关浏览器这一步跑一次，失败不阻断收尾。
- 回归 +1：`pidsWithMark()` 的解析单测——同一端口的助手全中、`94391` 不被 `9439` 前缀误伤、端口排在环境最后（行尾无空格）也认、空标记与空输入返回空。`scripts/check-flash-idle.mjs` 复跑：`pid 62480 is gone` / `the whole process group is gone` / 端口不再应答，`exit 0`。292 测试全绿。

## 0.47.17 — 动作这一维和竞品同跑道了，桥的输入不再「看着像成功」

- **同机同夹具三方对照**（`docs/BENCH.md`「动作面三方对照 — 0.47.17」）：本项目 0.47.17 / Playwright MCP 0.0.84 / Chrome DevTools MCP 1.12.0，各起自己的 headless Chrome，同一份页面、`--reps 8`、热身 2 次取中位，计时都在工具调用外面。同一页再读：本项目 0 ms / 193 字符（≈49 token），Playwright 7 ms / 8000 字符（≈2000 token，服务端硬截断），DevTools 5 ms / 5522 字符（≈1381 token）——两家都不去重。按文字点按钮：17 ms vs 537 ms vs 240 ms；打开一页：578 vs 556 vs 133 ms（DevTools 只回 `pageId`，不等真实地址与标题）；打字 101 vs 4 vs 208 ms，是三种不同契约，表里分开写清，不并成一根胜负曲线。
- **桥的输入回执改成读桥自己的 `{ok}`**：`flashInput()` 之前用 `reply.ok`（HTTP 状态）判断成没成，而桥 `/input` 的失败分支是 4xx/5xx 空 body、成功是 `200 {"ok":true}`——HTTP 200 只说明桥活着。现在解析回执体，`flashInput` 与 `flashKey` 都只在 `{ok:true}` 时算接住，`inputMs` 照记，失败退回调试协议。
- **悬停、打键、滚轮都不会再喂给一个冻结的渲染进程**：`hover()` 与 `flashKey()` 补了 `await this.revive()`（`mouse()`/`key()` 本来有）；`humanType()` 逐字走 `flashKey()`，所以真人节奏打字在冻结页上也能自己醒。`wheel()` 不再自己拼一份 `/input` 请求，复用 `flashInput('mouseWheel', …)`，两条路一起修。
- 回归 +1：`test/sidecar.test.mjs` 的 `input into a parked game wakes it first, and only a real yes counts` 钉住四件事——冻结页上先 `Page.setWebLifecycleState {state:'active'}` 再送输入、`key`/`flashKey`/`hover` 三条入口都如此、滚轮是一次带两个 delta 的 POST 且不回退到 CDP、桥回 `{ok:false}` 或 4xx 空 body 时返回 false 且不记 `lastFlashPoint`。291 测试全绿。

## 0.47.16 — 动作这一维第一次有自己的表，超上限关掉的页签会告诉聊天

- **`scripts/bench-actions.mjs`**：在 `tool.execute` 外面掐表，量模型真正付的那一圈——`browser_read` / `browser_view` / `browser_click` / `browser_type` / `browser_shot` / `browser_eval` / `browser_open`，页面动过和同一页再读分开记，连返回字符和 ≈token 一起给。目标里的「动作往返」这一维之前只有协议往返的 `action_rtt_ms`，没有工具面的数；现在有了，并进了 `docs/BENCH.md` 的「工具面动作耗时 — 0.47.16」。
- **超过 `MAX_TABS` 被关掉的页签，现在也会告诉聊天**：`trimTabs()` 关一个页签时把 id 记进 `expired` 并 `note()`，右栏和 `chatState()` 于是给的是「地址还在、点一下就回来」，不是一张停住的旧画面。之前只有空闲回收会记，超上限这条路径会漏。
- 回归 +2：`test/sidecar.test.mjs` 的 `one browser does not keep a renderer per chat` 现在同时断言被超上限关掉的那个聊天在 `expired` 里、没被关的不在；`test/client.test.mjs` 新增 `the sound switch is there only for a page that can make noise, and says what it did`，把 0.47.15 的开关钉住：只在 `sound.flash` 为真时出现、面子跟 `/sidecar/state` 回报的 `sound` 而不是跟点击、点一下只发一次 `POST /sidecar/sound`。

## 0.47.15 — 游戏声音有了开关，右栏自己就能按

- Flash 页默认静音（0.47.14 起连首帧都不出声），但静音之后没有「我要听」的入口：现在右栏地址栏旁多一个音符键，只在 Flash 页出现，按一下 `POST /sidecar/sound` → 桥 `/sound` → `webContents.setAudioMuted()`，再按一下关回去。键面按桥回报的状态画（`data-on="0"` 时压低透明度），不猜。
- `GET /sidecar/state` 新增 `sound` 字段：`flash` 是否在开、声音是否在放都由浏览器自己说，右栏据此决定显不显示这个键——普通 Chrome 页永远不出现。
- 回归 +2：`test/sidecar.test.mjs` 断言 `state()` 带 `sound`，`sound()` 只在桥真的接住时才改状态；`test/host.test.mjs` 断言路由先说清是哪个会话，浏览器没起时回 `{ok:false}` 而不是去启动一个。
- `DSH_FLASH_SOUND=1` 仍是启动默认；运行中改声音不需要重开游戏。

## 0.47.14 — 宿主要是猝死，桥自己走；页签不摊内存

- Flash 桥加了「父进程看门」：桥每 2 s 看一次 `process.ppid`，被 launchd 收养（父进程 `SIGKILL`/崩掉、没走到 `putAway()`）就 `app.exit(0)`。现场抓到过这种旧桥：无父进程、存活 3 h 以上、仍在画，0.47.11 之前还会出声；探针实测父进程退出后第 1 s 还在、第 2 s 整组消失、端口不应答。
- 首帧之前就静音：`--mute-audio` 是命令行开关，页面第一次绘制可能早于它生效；现在 `BrowserWindow` 建好即 `setAudioMuted(DSH_FLASH_SOUND !== '1')`，声音仍是 opt-in。
- 新增常备自检 `scripts/check-flash-idle.mjs`（隔离状态目录、`about:blank`）：起桥 → 拿一帧 → `putAway()` → 断言 pid、整个进程组、桥端口全部消失，`the bridge leaves nothing behind.`（`exit 0`）。
- 每页内存实测（1→6 页签、每步三次采样取中位，`docs/BENCH.md`）：总 RSS 883–1058 MB 来回，没有单调增长——页签数不是内存驱动，单步差值比「每页成本」还大，只有渲染进程数（≤4）随页签涨。
- 回归测试 +1：`test/package.test.mjs` 断言桥有父进程看守、首帧前静音、`/sound` 路由还在。

## 0.47.13 — 冷启动不再是短板，复活与静音有了回归防线

- 冷启动五连测（`/tmp` 探针同量法，每次全新 `Sidecar` + 全新 profile）：433 / 445 / 453 / 459 / 603 ms，中位 **453 ms**。同机同夹具竞品：browser-use 713 ms、Stagehand 760 ms、CDT MCP 2185 ms、Playwright MCP 2755 ms —— 0.47.6 时唯一落后的一项已反超，幅度诚实记在 `docs/BENCH.md`。
- `test/sidecar.test.mjs` 新增两条行为回归：冻结页上的一次点击会先 `Page.setWebLifecycleState {state:'active'}` 再派发输入（`page.frozen` 归 false）；`sound(on)` 打 `POST /sound` 并回 `{on:true|false}`。286 测试全绿，防的是这一轮修掉的两个问题被下次重构悄悄改回去。
- `docs/BENCH.md` 新增冷启动五测表，并把「领先 36%，随负载浮动，别当固定值」写进原文。

## 0.47.12 — 回收后的页签会说一声

- 页签被回收时不再留下一张「看着还在、点着没反应」的旧帧：镜像上覆盖「页面已被回收，点一下恢复」，点一下按记住的地址重开（Flash 与普通页同一入口）。
- 修复前 `dropExpired()` 直接关掉整个右栏页签，人只看到画面消失；现在保留栏目、保留地址，恢复走 `/sidecar/open`。
- 0.47.11 资源复测（`scripts/bench-resource.mjs`，隔离状态目录）：空闲 CPU 均值 0.7%、空闲 RSS 551 MB、冻结后 550 MB / 0% CPU、唤醒 501 ms、`rested:true`，冷启动 563 ms —— 与 0.47.6 基准一致，进程组回收改动没有引入回归。

## 0.47.11 — 空闲后点击落空、静音与 Flash 进程回收

- 点一下就醒：被 quiet 阶梯冻结过的页面会丢掉调试协议送来的每一个输入事件，画面停在最后一帧，点击全落空。现在鼠标、滚轮、键盘在派发前先把页面唤醒，Flas​h 页面同时把镜像循环接回去（`revive()`）；探针：冻结后点击 ⇒ `frozen:false`、`casting:true`。
- 有人看的页面不冻结：`freeze()` 跳过 `frames` 非空的页面——那正是右栏正在显示的那一页，停下来的代价是「画面看着好好的，点不动」。
- 声音默认关：Flash 游戏 BGM 不再自动放到桌面上，`DSH_FLASH_SOUND=1` 才开；新增 `POST /sound` 可运行时切换（探针：开/关都 `ok:true`）。
- 进程组回收：Flash 运行时以独立进程组启动，SIGTERM 无效时用 `kill(-pid, SIGKILL)` 一次收掉 Electron 的 GPU/渲染子进程——之前它们能在后台继续出声几小时。
- 探针：`/tmp/probe-revive.mjs`、`/tmp/probe-watch.mjs` 均 exit 0；`node --check` 通过。

## 0.47.10

- 文档跟到实测：`docs/BENCH.md` 新增 0.47.9 Flash 镜像前后对照（1920×1120 / 113 KB / 27.8 fps / 首帧 189 ms / 拆除 `exit 0`）。
- `docs/MATURITY.md` 标题、`README.md` 与 `README.zh.md` 的对照口径统一成五家。

## 0.47.9

- 右栏画面 **分辨率翻倍**：离屏窗口按游戏尺寸的 2 倍（`DSH_FLASH_SCALE`，1–3，默认 2）开、`Emulation.setDeviceMetricsOverride` 的 `deviceScaleFactor` 同步取这个倍数，于是捕获面是 1920×1120 而页面/指针几何仍是 960×560 的 CSS 尺寸（`this.view` 不变、黑边与反算数学不变）。实测 `/frame.jpg` 从 960×560 变成 **1920×1120**（113 KB），镜像 **27.8 fps**（76 帧）、首帧 189 ms、按下 5 ms、松开 1 ms、按键 4 ms
- 桥的输入坐标跟着换算：`/input` 收到的点仍是游戏自己的像素，`sendInputEvent` 前乘当前倍数——不加这一步，2 倍窗口里所有点击都落在半个位置
- 收尾不再漏定时器：Flash 页的 `pollBridge` 循环原先在 `putAway()` 之后仍在跑（每 ~100 ms 一个 ref 掉的 `setTimeout`，进程永不退出、检查脚本只能被 `timeout` 杀掉）。现在拆除时先把页面的 `casting` 关掉、清掉观众，循环条件也加 `closing === null`；`check-flash-fit` 从 `exit 124` 变成 `exit 0`（12.2 s 跑完）
- 两条判据改对：`check-flash-fit` 断言「帧 = 内容框 × scale」而不是「帧 = 窗格」；`check-flash-mirror` 在静止的登录页上不再误判（先让指针在游戏上扫一遍拿到 78 帧再算 fps）
- 新增：`/shutdown` 路由，桥在回 `{closing:true}` 后 60 ms 自行 `app.quit()`（实测子进程 406 ms 后 `exitCode 0`），不再靠 SIGTERM→SIGKILL 兜底

## 0.47.8

- 镜像里的画面改成「游戏本身」，不再是「窗口」：Flash 桥先在页面里量出那块插件框，实测奥拉星是 **960×560** 的一块，钉在 1440×900 白页的左上角；此前 `/resize` 只把窗口（= 捕获缓冲）改成窗格尺寸，页面布局仍是 1440×900，于是游戏被拉到窗格比例、右侧留 166 px 白边，窗格比页面高时下面还多出 344 px 黑（1126×1244 帧实测）。现在窗口框到内容框上，帧就是游戏，比例正确、没有白边也没有黑条
- 桥用 `Emulation.setDeviceMetricsOverride` 把视口设成窗格，页面才知道栏变了宽度（只调 `setBounds` 不会让离屏窗口重排）；这一步被占用或失败时退回「按内容框取景」，画面依然正确
- `/resize` 回传 `{bounds, viewport, content}`，sidecar 采纳回传的框作为帧尺寸，不再假设「帧比例 = 窗格比例」；指针仍按帧坐标反算，实测 41 帧 23.8 fps、按下 6 ms、松开 4 ms、按键 2 ms，`responded: true`
- 「只在某些网站出现」的答案写进文档：普通页面走 CDP 截图并把视口强制成窗格尺寸，结构上不可能出现黑边；只有 Flash/插件页走离屏桥这条路径，所以这类条带只出现在这类页面（`docs/ARCHITECTURE.md`）
- 测试跟上新约定：内容框成为帧尺寸、回传失败时保留窗格形状；`scripts/probe-launch.mjs` 里那句 `process.exit(` 违反仓库纪律，删掉（284 个测试全过）

## 0.47.7

- 把「借用本机 Chrome 的登录」写清并做对：起的是同一个 Google Chrome 二进制，只是 `--user-data-dir` 指到插件自己的目录，所以 cookie 格式与加密和你日常用的 Chrome 一致——打开站、一次 `browser_login {action:"import", name:"…"}` 就把它搬过来，`use` 注回并重开页面（`README.md` / `README.zh.md` 新增「借用本机 Chrome 的登录」一节）
- 明确不共享 profile 目录的理由：Chrome 对 profile 是单例锁（你开着就打不开），直接打开还会按扩展与版本差异改写你的数据；只搬该站 cookie（`save` 时含该站 localStorage），不复制整个 profile，不上传
- macOS 挡这一步时把话说全：实测 `cp` Chrome 的 `Cookies` 直接 `Operation not permitted`（Keychain 里的 Chrome Safe Storage 密钥本身可读），所以报错从「give it Full Disk Access」改成具体路径——系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 打开 DSH，两个出口（profile 根目录、cookie 库）都改
- 未验证项照实留：本机 DSH 尚未获授权，`import` 端到端（解密 → 封库 → `use` 注回）在这台机器上还没有一次成功的实测；授权后需补一次

## 0.47.6

- 五家同机同法对照（本地 fixture、同一档无头 Chrome、先导航热机）：Playwright MCP 0.0.84、Chrome DevTools MCP 1.12.0、Stagehand 4.3.0、browser-use 0.13.14。四家都只测「不用模型」的那一层——开页、截图、读页、空闲、收尾，凡是要 LLM 猜坐标的路径一概不算，避免拿自己的确定性实现去赢别人的推理延迟
- 逐项结论（`docs/BENCH.md`「五家对照」段、`docs/measure-competitors-2026-11.json`）：空闲 CPU **0.33% 对 36–51%**（~100 倍）、空闲 RSS **459–552 MB 对 1265–1672 MB**（2.3–3.6 倍）、读同一页 **2302 字符对 5662–21396 字符**、收尾后归零并保留登录（两家竞品能归零但没有恢复面：Stagehand 52 ms 关掉后 profile 即删，browser-use 110 ms 关掉后进程树归 1）、热页签 raw 层 **20 ms 对 24–33 ms**。截图速度四家打平（48–71 ms），差别在回答形状
- 补齐「热页签」的内部账：`Target.getTargetInfo` 原来单独等一个往返，现在和 `Runtime.enable` / 视口设置同一批收，trace 里 `start` 从 **39 ms 降到 14–33 ms（中位 20）**；工具层（开页 + 回来一段页面文字）中位仍在 42–54 ms，多出来的是回给模型的文字，不是浏览器
- 被证伪并回退：把 `Browser.setDownloadBehavior` 提到浏览器层做一次、页签不再各自设置——冷启动、唤醒同时变差（唤醒 583–587 对 431–495 ms），收益只有 1 个往返，回退
- 记一条测量纪律：`bench-resource` 的唤醒值在这台机器上跨跑波动 394–866 ms（同一份代码连跑两轮可差 300 ms），单次采样不足以判断改动好坏；页签内部的 trace 段（9–33 ms vs 39 ms）比工具层中位稳定得多，性能判断以它为准，对外仍报范围
- 0.47.6 复测：冷启动 840 ms 中位（701–936，五次）、读 2 ms / 2174 字、截图 50 ms / 106 648 字节、动作往返 0 ms、单页空闲 491–515 MB / 0.33%、解冻 9–16 ms、休息归零、唤醒 0.39–0.59 s（负载相关）

## 0.47.5

- 补上「截图」这一维度：同机同法量三家（同一台本地 fixture、先导航热机、连拍四次取中位）——本插件 **51 ms**（43–52）、Playwright MCP 51 ms（50–54）、Chrome DevTools MCP 48 ms（46–53）。**速度是打平**：这一项的成本在 Chrome 的 `Page.captureScreenshot`（合成 + 抓帧 + PNG 编码），换个工具不会变快
- 差别不在速度，在回来的东西：本插件把图落成文件，回答里只回 **223 字符 + 路径**（PNG 106 648 字节；模型能看图时另附附件），两家竞品把 base64 塞进每个回答——Playwright 100 644 字符、DevTools 383 200 字符。字节数受各自默认视口影响，不作编码效率排名
- `npm run bench` 新增截图段：连拍四次取中位、断言 ≤ 1000 ms，并把 `shot_ms` / `shot_median_ms` / `shot_bytes` / `shot_text_chars` 写进 JSON。它防的不是「比竞品慢」（本来一样快），而是以后有人往截图路径里塞同步等待或重试
- 被证伪并回退：给 `Page.captureScreenshot` 加 `optimizeForSpeed`（用更大的文件换更快的编码）。八轮交替采样中位 41 ms 对 41 ms，字节从 98 352 涨到 129 696（+32%），换不到速度，`sidecar.js` 一行未动
- 0.47.5 复测：冷启动 840 ms、读 2 ms / 2174 字、截图 51 ms / 106 648 字节、动作往返 0 ms、单页空闲 30 秒 552 MB / 0.62%、解冻 6 ms、休息归零、**唤醒 394 ms**

## 0.47.4

- 补上「热页签」这一段：一个已经起来的浏览器里，再开一页要多久，此前只有「第 1 页」的冷数字。同机同法（同一台本地 fixture、同一个已经就绪的浏览器、连开五页，页签创建 + 导航都算在内）：**中位 41 ms**（41–72），Playwright MCP 中位 45 ms（40–87），Chrome DevTools MCP 中位 130 ms（127–136）。这一项和 Playwright 打平、比 DevTools MCP 快 3.2 倍，不是领先，文档里照实写
- `scripts/check-tabs.mjs` 现在给每个页签记 `open_ms`，并断言热页签中位 ≤ 150 ms（`npm run tabs`）。以前这个数字只打印在 `ok` 行里，没有上限，回退到几百毫秒也看不出来
- 0.47.4 复测：六页签 922 MB / 8 进程 / 4 渲染进程，空闲平均 0.5%、稳态 -0.24%（负值是 ps 整数秒的采样噪声，判据仍是 ≤ 2），第七个会话 `pages 6`

## 0.47.3

- 「唤醒 801 ms」这个数是量错了，不是浏览器慢：bench 在 rest 的 `Browser.close` 还在飞的时候就开始计时，把**属于休息的 360 ms 关机等待**算进了唤醒。改成等 `closing` 落定、进程树真的不在之后才开始计时，同一台机器同一份负载量到 **389 ms**（trace：`closing 0 · browser 205 · socket 101 · cdp 7 · page 33`）。真实使用时人回来总在休息结束之后，所以 389 ms 才是他会经历的那个数
- 六页签的空闲 CPU 也改成等它凉下来再算：原来 12 秒五个样本里第一个还带着开页尾巴，报 1.36%。现在采 20 秒，前三个窗口丢掉，报**平均 0.9%、稳态 0.24%** 一个核（`npm run tabs` 会同时给 `avg_pct` 与 `settled_pct`）
- 这两处都只是把测量口径改对，插件行为一行没动，所以本轮不宣称性能提升；能对上竞品的数字因此更硬：醒来 0.39–0.44 s 对整棵重启 4.6–5.1 s，六页签 864–921 MB（跑与跑之间机器负载不同）、始终 8 进程 / 4 渲染进程、每页约 +2 MB
- npm 包里补上 `CHANGELOG.md`（0.47.2 的 tarball 里没有它）
- 0.47.3 复测：冷启动 448–471 ms、读 2 ms / 2174 字、动作往返 0 ms、单页空闲 30 秒 661 MB / 0.9%、解冻 5 ms、休息归零、**唤醒 389 ms**

## 0.47.2

- 修一个真的会让第二个会话开不出页的竞态：任何一次快照都会给页面留一个 2 秒的「跟随弹窗」窗口（`armFollow`），而另一个会话这时候开的页签在浏览器看来就是一个新 page target —— 它被当成弹窗 `Target.closeTarget` 关掉，正在握手的 CDP 当场断开，工具收到 `Page.enable: sidecar closed`。`scripts/check-tabs.mjs` 里 0.47.1 就是死在 tab 1 → tab 2 那一步；两张会话相隔 1.5 秒打开即可复现
- 两道闸：`openTab` 在向浏览器要页签之前先 `disarmFollow()`，并且整段创建过程把 `making` 记上；任何页面看到「自己这台 sidecar 正在开页签」就不再把新 target 记成弹窗。真实弹窗（点击打开）路径不变，`adoptOpened` 照旧接管
- 新增 `npm run tabs`（`scripts/check-tabs.mjs`）：六个会话各开一页，量整棵进程树的 RSS / 进程数 / 渲染进程数，然后停手 12 秒量空闲 CPU，第七个会话验证上限。本机实测：六页 864 → 876 MB（**每多一页约 +2 MB**）、始终 8 个进程 / 4 个渲染进程、空闲 **1.36%** 一个核；第七个会话把页数留在 6、内存 873 MB，没有多出一条进程树
- 空闲 CPU 不再被启动时的平均占用污染：`ps` 的 `%cpu` 是进程自启动以来的平均值，浏览器刚起来那十秒怎么量都是 9% 以上。改成采两次 CPU 时间取斜率，同一台机器同一份负载量到 1.36%（样本 4.8 / 1.6 / 0 / 0.4 / 0）
- 回归测试两条（`test/tabs.test.mjs`）：忙时新 target 不被记成弹窗、闲时仍会被记；`bind()` 注入的 `busy()` 跟着 `making` 走。全量 307 项、0 失败
- 0.47.2 复测：冷启动 596 ms、读 1 ms / 2174 字、动作往返 0 ms、空闲 30 秒 551 MB / 1.73%、解冻 12 ms、休息归零、唤醒 801 ms

## 0.47.1

- 冷启动里那 1.2 秒不是 Chrome，是我们在等一个「会不会有人看」的画面：`browser_open` 以前最多等 1200 ms，现在有面板可显示时最多等 250 ms，没有面板可显示时不等。冷启动中位 **1703 → 465–544 ms**（8 次 434–1079 ms），这一条是主要来源
- 想知道另外那 0.5 秒花在哪不用猜了：`DSH_INNER_BROWSER_TRACE=1` 在 stderr 打一行阶段账（`closing · login · browser · socket · cdp · page · cookies · cast · navigate`，累计毫秒），`docs/BENCH.md` 的「冷启动拆解」给了改前改后的逐阶段对照
- 等 Chrome 的两处轮询不再先无条件睡一轮：调试端口发现从 5 ms 起步、放宽到 100 ms；`/json/list` 找页面 target 从 10 ms 起步、每轮 +15 ms、封顶 100 ms。`socket` 阶段 128–212 → 103–191 ms
- 读一页到底要多少 token 有数字了：同一张本地页（40 段正文 + 60 个链接），本插件 `browser_view` 返回 **2302 字**、`browser_read` 返回 **2174 字**；Playwright MCP `browser_snapshot` 7804 字、Chrome DevTools MCP `take_snapshot` 5381 字。原始记录 `docs/measure-tokens-2026-11.json`，脚本 `/tmp/compbench/tok.mjs` 的思路写进了本版
- `npm run bench` 多报一个 `view_chars`：冷启动那次读取返回多少字符也进 JSON，以后 token 成本不用另开脚本量
- 诚实说明：端口轮询那两处合计只省约 40–100 ms，冷启动变快的主因是第一条；bench 里没有面板可显示，所以走的是「不等」那条路，真实会话有右栏时会多等最多 250 ms

## 0.47.0

- 冷启动、空闲内存、空闲 CPU 三项不再靠猜：新增 `scripts/bench-resource.mjs`（`npm run bench`），一次跑完冷启动、读一次、点一次、空闲 30 秒、冻结、休息、唤醒八个阶段，每项都是这台机器上的真实进程数、RSS 和 CPU 秒
- 六个页签不需要六个渲染进程：Chrome 命令行加上 `--renderer-process-limit=4`，本机实测空闲内存 660 → 551 MB、冷启动 2186 → 1703 ms，页签上限仍是 6，四个进程仍把不相关站点隔开
- 后台那堆没人要的活全部关掉：`--disable-background-networking`、`--disable-component-update`、`--disable-domain-reliability`、`--disable-breakpad`、`--no-pings`、`--disable-extensions`、`--disable-default-apps`，并把 `Translate / MediaRouter / OptimizationHints / InterestFeedContentSuggestions / CalculateNativeWinOcclusion` 一起从功能表里去掉；空闲 CPU 从 1.87% 降到 0.03–0.32%
- 冻结前先真的松手：`shed()` 在 `Page.setWebLifecycleState` 之前调用 `gc()` 和 `Memory.simulatePressureNotification('critical')`（配合 `--js-flags=--expose-gc`），冻结后 CPU 归 0，RSS 在 812 → 511 MB 那一档能看到实际回收；不是每次都掉，掉多少取决于页面自己攒了多少缓存，这一点照实写进 `docs/BENCH.md`
- 被停驻的页签在任何复用路径上都会先醒：`tabFor`、`openTab` 的两处直接复用和并发合并那条路都补了 `thaw()`，以前只有 `ensure()` 这一条会醒，别的路径把冻结页当成活页读
- 想自己比参数不用改源码：`DSH_INNER_BROWSER_CHROME_FLAGS` 接受一串空格分隔的额外开关，只追加、不替换
- 和四家竞品做了同机同法的对照，测量明细落进 `docs/measure-competitors-2026-11.json`，结论写进 `docs/BENCH.md` 与 `docs/RESOURCES.md`：本插件冷启动中位 1703 ms（Playwright MCP 2755、Chrome DevTools MCP 2185）、空闲 RSS 551 MB（1414 / 1280）、空闲 CPU 0.03–0.32%（38.1% / 36.3%）、动作往返 0–1 ms、休息后内存归零 838 ms 唤醒回原页
- 说清楚对方也有跟我们重叠的能力：Playwright MCP 有 `--idle-timeout`（无头默认一小时）且实测确实会关掉整个浏览器，差别在时机和「谁在看」——它不看有没有人在看，也不会先冻结、再关；Chrome DevTools MCP 没有任何空闲机制

## 0.46.0

- 没人用的浏览器现在会自己停：右栏点 x 之后若没有别的栏在看，一分钟后就整个关掉（cookies 先存好），内存归零；下次调用自己开回来，回到同一个地址、同一页，唤醒 0.3–1.1 秒
- 时间不是我拍的数字，是从这个人怎么用推出来的：`rest.js` 记住最近 64 次调用的间隔，取 95 分位 × 6（夹在 90 秒到 15 分钟）当休息窗口，× 2（夹在 20 秒到 2 分钟）当「先停手」窗口。每两秒点一次的人两分钟就收，每 90 秒回来一次的人能等九分钟；没有历史时用下限，新进程不会守着不存在的规律干等
- 只看不关：栏还开着但 agent 早就不动了，走的是「停驻」而不是关闭——截图流停掉、页面冻结（`Page.setWebLifecycleState`），DOM、滚动位置、登录态都还在，动一下立刻接着用；只有栏关掉且没人看时才真的释放
- 看一眼不花钱：内存每 30 秒称一次整棵进程树（默认预算 2400 MB，`DSH_INNER_BROWSER_MEMORY_MB` 可改）。超了先把没人用的页签按 LRU 收掉、截图流降级；还超且没人看就直接休息，不等时钟；人在看时不会因为超一次就关掉
- 长跑会撞的几件事各自有对策：休息和下一次调用同时发生时，关闭单飞、启动等上一台走完（旧版这里会把新连接关掉，soak 第 8 轮复现过）；十分钟内崩三次就拒绝再启动并说明原因；页签 10 分钟没人用就回收，正在推流或有弹窗的跳过
- `browser_state` 现在说人话：`rests in 4 min unless used` / `parked while no pane watches` / `stopped — the next call opens it (326 ms last time)` / `parked pages 2`，外加内存占用与预算、累计休息次数、唤醒耗时
- `scripts/soak.mjs` 扩成同时压休息链路：24 轮里每 8 轮把浏览器真的放走再唤醒，断言「休息时内存为 0」「回来后只有一页」「页数从没变成 2」。本机实测 40.1 秒、内存 1427 → 956 MB、3 次休息、24 次读全部有答案
- 新增 `scripts/check-rest.mjs`：无头端到端走「开页 → 看状态 → 休息 → 状态说 stopped、内存 0 → 再读一次自己醒来 → 还是原来那页那地址」，并断言 `browser_state` 休息前后都说对
- 新增 `rest.js` 纯策略模块与 9 个测试：分位、夹取、超长间隔视为新会话、有人看时不休息
- 竞品对照写进 `docs/RESOURCES.md`：Playwright MCP 只有一个整点 idle 超时、Chrome DevTools MCP 完全没有、browser-use 只有 `keep_alive` 布尔、Stagehand 反过来把 Chrome 的节流全关掉；四家都没有「冻结而不是关闭」「查看器感知」「内存当策略」

## 0.45.0

- 同一个站读到第二次，浏览器自己记住这个站长什么样：按 origin 记下页面字数、控件数、正文长度的滑动平均，`browser_view` 和 `browser_read` 每次都更新它；记的是页面本身的大小，不是这次被预算截掉的输出
- 第二次之后，控件多或页面大的站，`browser_view` 默认先给 `map:` 地标视图；文章长的站，`browser_read` 默认截到 3500 字。两边都附一句带实测数字的理由（`this site reads big (2 read(s), ~2946 chars of page, ~90 controls)`），不是悄悄改行为
- 学到的是默认值，不是答案：显式 `mode`、`query`、`max_chars` 一律盖过学到的值；一个站只读一次不算学会
- 本地实测（`scripts/check-sites.mjs`）：300 个按钮的页第一次 1801 字 → 第三次 760 字（省 58%）；12000 字的文档第一次 6096 字 → 第三次 3726 字（省 39%），截断处自带 `cut at 3500 characters`
- 记录落在 `sites.json`（可用 `DSH_INNER_BROWSER_STATE_DIR` 改位置），每进程最多每 2 秒写一次，只留计数不留正文
- 新增 `browser_look`：自己画自己的页面（游戏、canvas、Flash）不再只能截图。画面在 Node 里解成 PNG 再压成字母网格，12×8 一块屏幕一个字母、同色同字母，约 200 字符；再看一次只报变了的格子，全程没有图片 token。`scripts/check-look.mjs` 三次看共 639 字符
- 新增 `scripts/soak.mjs`：一个无头浏览器、一个页签、24 轮开页/读页/截图/重读，每几轮采一次进程树内存与页数；本机 34.9 秒、内存 1440 → 1287 MB、页数始终 1，泄漏不再靠下周的机器变慢来发现
- Flash：切换回普通页面后重新问一次页面的插件列表，不再沿用切换前的结论
- 新增 `scripts/check-sites.mjs` 与 `scripts/check-look.mjs` 两条端到端，`npm run sites` / `npm run look` / `npm run soak`

## 0.44.0

- 一页里九成是菜单时，读的预算不再先喂给菜单：页内阅读器给每一块打一个「像正文」的 0–1 分（链接密度、句子标点密度、长度），整页超出预算就按这个分挑，挑完再还原成页面顺序。本地噪声页：整页 1500 字 → 88 字（省 94%）；同样 900 字预算下旧法通篇是菜单、读不到答案，新法读到了
- 每段带完整标题路径（`Plans \u203a Trial`），不再只有最近一个标题：一条事实在页面哪个位置能直接看出来。路径不比最近标题多说就不重复，超过 90 字也不占地方
- 表格按行读：一行就是 `列名: 值 | 列名: 值`，列名取自表头第一行，行的质量固定 0.95。本地定价表 679 字 → 109 字（省 84%），答案和列名落在同一行
- 排序和证据共用一个质量先验：命中同样词的菜单碎片压不过解释这些词的段落，选中后仍然按页面顺序排
- 新增 7 个测试（`test/blocks.test.mjs`：手搭一个假页面直接跑页内脚本，覆盖标题路径、表格行、紧凑预算取舍、`trailOf` 的三条回落规则），bench 26 项预算全过
- 没有拿省字换答案：`read-answer` 90 字 / 92%、`read-miss` 438 字 / 79%、`read-tabs` 90 字 / 90%，与 0.43.0 完全一致

## 0.43.0

- 页面把内容藏在登录墙后面时，`browser_read` 自己动手：撞墙后如果恰好有一个留着的登录覆盖这个站，就把登录放回去、重开页面、再读一遍，答案和平时一样一次调用端回来；原本这条路要 4 次往返（读→list→use→再读）
- 不替你选账号：零个匹配就照实说撞墙，两个以上就把名字都列出来让你 `use`，绝不在两个账号之间猜；不想让它动手就传 `signin: false`，只报告墙
- 墙上的页面不进读缓存：同一页恢复前后不会互相污染，跨页签读也不会拿墙页的文字当证据
- 新增 `browser_login {action: "import"}`：本机 Chrome/Brave/Edge 里已经登着的站，一条命令读出来封存成一个名字，不用装扩展、不用配对码、不用复制 profile；磁盘上那一份仍然加密，钥匙仍在系统钥匙串
- 读的是副本：Cookie 库被浏览器锁着，先复制 `Cookies`（连同 `-wal`/`-shm`）到临时目录再读，副本用完即删；打不开的值（Chrome 127+ 应用绑定加密）只计数、如实说「有 N 个打不开」，不猜、不打印任何 cookie 值
- 本机实测：撞墙后旧路 4 次调用 / 217 毫秒 / 139 字 → 新路 1 次调用 / 112 毫秒 / 220 字；导入 1 次调用 / 111 毫秒 / 1 个 cookie 封存、页面上已登录
- 平台边界写清楚：macOS 上要读真实浏览器 cookie 库需给 DSH「完全磁盘访问」，不给就直说这一句，不做绕行；本机没有这个权限，因此真实 profile 由合成库 + 真实钥匙串两条路验证，`browser_login {action:"import"}` 的端到端只用合成库
- 新增 14 个测试（`test/chromecookies.test.mjs` 7 个、`test/vault.test.mjs` 7 个），bench 24 项预算全过

## 0.42.0

- 答案在另一个页签里时，不必再切过去读第二遍：`browser_read` 发现当前页答不上来，会顺手读这个会话自己开着的其它页签，一次调用就把答案连同出处（页签标题）端回来；只有答不上来时才会读别的页签，正常一问一答的延迟不变
- 能读的只有这个会话自己占着的页签：别的会话的页签、没人认领的页签都不碰，一栏一个页签的规矩不变；最多再读三个、每条临时连接读完就关
- 出处不丢：每条证据前面标着它来自哪个页签（`## story page`），合并后总长度仍然只受 `max_chars` 一个上限约束；不想跨页签读就传 `across: false`
- 顺手修掉一个会让跨页读落空的旧毛病：浏览器「清理没人用的页签」不认会话认领的页签，进程里第一次读时会把认领过的页签当野页签关掉；现在认领过的页签算有主
- 本地两页实测：同一问题，切页签读两遍 879 字 / 两次调用 / 7 毫秒 → 一次 90 字 / 一次调用 / 5–6 毫秒，省 90%，答案与出处都在
- 新增 3 个跨页测试（答案在另一页、哑页签不拖累、都没答上时各给一句近邻），`260 tests / 260 pass / 0 fail`，bench 22 项预算全过

## 0.41.0

- 问了但页面答不上来时，不再把整页端回来：`browser_read` 只回最近的三段（每段掐到 260 字以内）加一句「没有直接回答」，并说明整页要用 `browser_view` 拿
- 这一条是给「问错了词」兜底的：整页回传原本是这个工具最贵的一条路径，长页面上一次 miss 就是五六千字；现在 miss 和 hit 一样便宜
- 本地故事页实测：问一个页面完全没有的词，整页 2089 字 / 614 token → 438 字 / 129 token，省 79%，7 毫秒，仍指出页面在讲什么
- 全量测试 `257 tests / 257 pass / 0 fail`，bench 21 项预算全过

## 0.40.0

- 带着问题读页面，回来的不再是一整篇：先在页面内按段落排序，把段落切成句子，句子按词频和稀有度打分，再乘上标题命中、所在段落的相关度、链接密度三个先验；只留下覆盖了问题大部分权重的句子
- 问一个词也能找到另一个写法：`refunds` / `refund`、`install` / `installing` 这类词形差异会先折叠再比对，不必猜页面用的是哪个形式
- 整页都有的词不再稀释判断：`to`、`the` 这类几乎每段都出现的词不参与打分；只命中一个高频词的句子按覆盖比例折算，不会被当成证据端上来
- 选句不是「分最高的几句」：每挑一句先减掉与已选句子的重复度（MMR），再按字符预算装箱，最后按原文顺序还原，读起来还是文章的样子
- 本地故事页实测：问「退款多久到账」，整页 1172 字 / 345 token → 90 字 / 26 token，省 92%，答案仍在，11 毫秒
- 新增 6 个测试（中英文断句、缩写不拆句、菜单不冒充证据、字符预算、重复句去重、证据 vs 整页），`257 tests / 257 pass / 0 fail`

## 0.39.0

- 留存的登录凭据不再明文落盘：会话 cookie 和登录备份用 AES-256-GCM 封装后写盘，密钥放在系统钥匙串里（拿不到才退回只有本人可读的密钥文件）；旧版本留下的明文记录照读，读进来就重封
- 新增 `browser_login`：`save` 把当前登录按名字留存（cookie 加上各站的 localStorage），`list` 看有哪些、`use` 直接切回那个账号并重开页面，`drop` 忘掉；同一站点多个账号存成不同名字即可，换会话、重启都还在
- 浏览器什么时候让位看得见了：`browser_state` 报它现在占多少内存、没人用的话还有多久关闭；右栏关掉约一分钟后回收、没人碰约一刻钟后回收、页签十分钟不动且最多六个，规则本身不变
- 实测保存一次 2 毫秒，切回登录 105 毫秒（含重开页面）；对磁盘上的密文搜不到 cookie 值和 localStorage 里的令牌
- 新增 6 个留存测试（封装往返、篡改拒读、明文兼容、多账号、越界名字），`251 tests / 251 pass / 0 fail`

## 0.38.0

- 等页面变化不再每 100 毫秒问一次：页面自己盯住变化，改完那一刻就回，一个来回而不是来回问
- 同一页面五次实测，平均值 205 → 140 毫秒，探测来回 3 次 → 1 次
- `idle` 改成「350 毫秒没有任何变化」才算停：动画多的页面和空页面一样便宜，不会把还在变的页面当成停稳
- 等到时间上限会直接说 `still moving`，不再把没停稳的页面报成 `idle`

## 0.37.0

- `browser_media` 只先给你要的东西：页面自己的 `<video>` / `<audio>` 正在播的那个标 `main` 排第一，广告位和统计请求默认不出现（`all: true` 才展开），`save: main` 直接存它。
- 判断「广告」看地址本身（ad 位、preroll、pixel/beacon、tracker、常见广告域），不看文件大小——页面上最大的文件经常是贴片广告；小到像信标的文件也压到后面。
- 资源嗅探有了开关：`browser_media({ watch: false })` 停掉这个页面的记录并清空列表，`watch: true` 再开。默认开着，因为记录是网络日志附带的，不额外发请求。
- 列表一行一个：`1. main video 2:13 1.2 GB · <地址>`，时长来自页面的播放器；被挡住的广告单独一行说数量，`all: true` 看全。
- 目录规划写清楚：`~/.dsh-inner-browser-use/` 根下只有 `artifacts/`（给人看的产出，按项目/会话/种类）、`chrome/`（登录态与缓存）、`flash/`（播放器运行时）和三份记录文件，`docs/ARTIFACTS.md` 一张图看完。
- 流保存不变：按 `height` 选最高档、6 路并发取片段、带 init 段、AES-128 加密拒绝；新增的挑选只影响列什么、存哪个。
- 新增 3 个测试（广告识别、排序、分数），`245 tests / 243 pass / 0 fail`。

## 0.36.0

页面播过的视频和声音，直接就能留下——不装 yt-dlp，不多发一次请求。

- 新增 `browser_media`：列出页面已经请求过的视频、音频和流（带大小、去重、新的在前），`save: <行号>` 或地址片段存一个。想留下的东西本来就在页面的网络记录里，所以「嗅探」没有额外代价：bench 里页面加载完的那一刻就已经有 3 条（video / audio / stream），`media-sniff` 0 ms。
- 流会自己拼好：master 播放列表按 `height` 选最高不超过的一档，media 播放列表里的片段按顺序并发取回（宽度 6）拼成一个文件，`init` 段在最前面；AES-128 加密的明确拒绝，不假装成功。bench `media-save`：master → 1080 → 6 段，5 ms，96 B，报 `6 parts joined`。
- 存的时候带页面自己的 cookie、UA 和 referer，登录后才给的文件照样拿得到；落在 `~/.dsh-inner-browser-use/artifacts/<项目>/<会话>/media/`，和截图、图片、PDF 同一套规则。
- 列表只回一行一条（bench 首行 59 字符）：行号在前，地址截到 160 字符，超过 12 条提示用 `find` 收窄。工具面没有变宽——`browser_state` 不加字段，嗅探与保存都在同一个工具里。
- Flash 是开关：默认关，`browser_open` 带 `flash:true` 才装并起那条路径，`flash:false` 回到普通 Chrome；两条路都只把画面送进本会话右栏，不开窗、不进 Dock、不进菜单栏。
- 新增 `media.js`（纯解析，无 IO）和 8 个测试：master 最优先、变体绝对化、`pickVariant` 上限与回退、片段顺序与 `init`、加密标记、两种 `planOf`、`isMedia` 正反表、`gather` 保序且并发不超 6；另有 1 条页面级测试确认「同一地址只记一次、新的在前」。全套 `242 tests / 240 pass / 0 fail`，bench `budget checks 16 ok`。

## 0.35.3

- 按文字点击不再一个编号问一次页面：一次读过的十几个编号被整页重绘作废后，旧代码挨个 `Runtime.evaluate` 确认，现在一次往返就问清「哪一个还在」。bench `ref-batch`（12 个编号）6 ms → 1 ms，−83%。
- 页面把按钮换了说法也点得到：没有标签逐字重复时，取唯一最接近的那个（"submit order" → "Place order"）；两个标签同样接近就不猜，仍回 "No control says …"。bench `find-near` 新增用例 18 ms 通过。
- `browser_click` 按文字：0.35.2 的 12 次往返口径下测 13–18 ms，预算 `find-text: 90 ms`。
- 新增 2 个测试：12 个候选只问页面一次；近似匹配只在唯一胜出时采纳。全套 `234 tests / 232 pass / 0 fail`。

## 0.35.2

关掉的镜像真的会关掉，看局部不再付整屏的钱。

- 侧栏关掉后一直挂着 GitHub：帧流在「等浏览器起来」的那几秒里就被关掉了，那时摘连接的函数还是空壳，于是 sink 永远留着，`viewers` 恒为 1，Chrome 因此永不休息，下次挂载又按「仍归我」把同一页画回来。现在关连接会被记住，`watch` 一返回就立刻摘掉。
- `Bridge` 按会话记一份帧流，`/sidecar/forget` 顺手挂断：`sidecar.watched()` 才可能归零，60 秒空闲回收真的会跑。一个页面刷得比旧连接关得快时最多留 4 条，旧的先断。
- `browser_tabs` 关掉最后一页等同于交还镜像：以前 owner 留在磁盘上，下次 poll 判成「把页签装回来」，所以关完立刻重现；现在顺手 forget，并且没人看时照常进入休息。
- `browser_shot` 新增 `region: [x, y, w, h]`（页面像素）：只截一块，游戏、图表、局部放大不必为整屏付图像 token。`full` 与 `ref` 行为不变。
- 新增 2 个 host 测试：关镜像会挂断仍在连接的帧流；一个会话的帧流不会堆叠。`npm test` 230 pass / 0 fail。

## 0.35.1

每一步更短、更快：点一下之后不再空等，确认行也不再重复它已经说过的东西。

- 判断「这次点击有没有开新页签」先看一次页签列表；没有就听浏览器的开页通知，最多等 8 ms，通知一到立刻返回，不再把 25 ms 的窗口一轮一轮跑完。按引用点 38 → 19 ms，按文字点 53 → 35 ms，`browser_do` 单步 52 → 35 ms。`Open now` 与 `Open later` 两种弹窗仍按原样跟随。
- 动作确认行不再说两遍地址：同一行里的地址已经写明去了哪里，跨页只说换页，页内锚点只报 `#item-1`。
- 点过的控件不再重复：焦点行与本次点击同名时省掉；输入框带值时保留，值是这一步的新信息。
- 20 步连续操作的输出 4858 → 3825 字符（约 1429 → 1125 token，少 21%）。
- 压紧 bench 预算：`do-session` 280 → 110 ms，新增 `popup-wait` 40 ms，性能回退会被直接测出来。`npm test` 229 pass / 0 fail。

## 0.35.0

同一个地址不再列成两行，被浏览器收掉的页签也不会自己回来：

- `browser_tabs` 里同一个地址只占一行：会话持有那一页时，由它代表该地址，底栏里同址的空白页不再重复列出。留下的行保持浏览器顺序，`useTab` / `closeTab` 的序号仍指向同一行。此前这段去重读错了对象，`browser_tabs` 会直接抛错。
- 被浏览器回收的页签不会再被下一次轮询重新展开：右栏确认收回后只关一次，host 也不再把它 adopt 回来。
- 右栏尺寸变化只发一次请求，删掉最多五次的阶梯重试；浏览器还在启动就错过一次，下一帧画面本身就带尺寸。
- 补四条单测：同址一行、两址两行、休息到点收浏览器、有人看则继续续时。`npm test` 228 pass / 0 fail。

## 0.34.99

右栏镜像里页面缩成中间一张小图的问题修掉了，关掉的镜像也不会再在后台占着浏览器：

- 画面尺寸现在由真正画在屏幕上的那个元素决定，不再依赖上一次量到的栏宽。图片铺满整块画面区域、由它自己在里面按比例居中（宽高 100% + object-fit: contain）。此前宽高是渲染时用记忆中的栏宽算出来的，栏刚打开或窗口条刚出现那一次如果量到旧尺寸，就会画成几十像素的小图，四周全是空白。
- 指针与光标的落点从同一张图上现量（图片在画面里的实际矩形），尺寸对不上时点击仍落在看到的位置。
- 人关掉镜像后，浏览器一分钟后就收掉，不再空转十五分钟：关掉时如果没有任何画面在播，空闲计时直接按一分钟起算；期间 agent 再要用浏览器会照常把它拉起来。关掉同时停止推流，CPU 与显存不再为一张没人看的画面花。
- 长跑留下的 `asks.log` 不再无限增长：每次写入都看体积，超过 256 KiB 只留尾部 128 KiB（此前每 512 次写入才检查一次，一度涨到 660 KB）。
- 渲染几何与「没人看时算零个观众」各补一条单测；`npm test` 220 pass / 0 fail。

## 0.34.98

关掉的镜像不再自己回来。根因不在关闭按钮，而在关闭之后的三个入口各自都能把它重新画出来，现在逐个堵住：

- 宿主记住的「谁拥有这面镜子」在多轮开关后仍留在 `mirror.json` 里，面板关了它还在；现在关一次就清内存也清盘，刷新、重载、重连都读不到旧主人。
- 无人在看的浏览器每 10 秒会让原会话「再画一次」（keepalive），而会话里挂着的 `/downlink` 连接在面板关掉后仍活着，于是每次都被重新开出一个页签。现在这条请求带上 `reason: 'keepalive'`：只有面板确实还在时才刷新，面板不在就什么都不做；agent 或人明确要求打开时才是 `'ask'`，不受这条限制。
- 客户端关一次就在本会话记下关闭时刻，重连/切换会话触发的 `restore()` 不再算「明确请求」；比关闭更旧的请求重放也不补开。后来新的明确请求仍然能开。
- 关闭通知改用 `sendBeacon`：普通请求会在面板卸载的同一刻被浏览器取消，beacon 在页面卸载之后送到，宿主一定收得到。会话切换触发的关闭不发这个通知，避免晚到的通知把刚接管的新会话所有权抹掉。
- 新增 5 条单测覆盖以上每条路径（含磁盘持久化、`needsTab` 不再重新认领、keepalive 帧与 ask 帧的区别、关掉的页签不会被 nudge 画回来）；`npm test` 217 pass / 0 fail。

## 0.34.97

- 会话的窗口清单改按「谁真的开过这个窗口」认领：别的会话的页签不会因为页签顺序变化漏进来，自己切走再切回也不会丢（此前只按当前页反推），认领有上限、页签关掉即失效。
- 列表面板拿到浏览器实际接受的尺寸后直接按它画，画面不再因为尺寸反馈晚一拍而留下黑边。
- 新增两条窗口归属单测；`npm test` 213 pass / 0 fail。
- 基准（`node scripts/bench.mjs`）：读 4 ms、点击 2 ms、do-session 20 步 1 015 ms（51 ms/步，1 429 tokens）、截图 66 ms / 115 KB、崩溃恢复 1 403 ms。

## 0.34.96

- 右栏镜像上方多了窗口条：列出这台后台浏览器里属于本会话的窗口（站点自己开的窗口也算），点一下切过去，镜像只显示当前的这一个；别的会话的页面不会出现在这条里。
- 会话切到自己的另一个窗口时，尺寸按这个窗口算，画面不再被压缩在角上。
- 点右栏页签上的关闭，由浏览器侧收尾，不再几秒后自己弹回来。
- 提示词和 `browser_open` 都收紧了：连通性、可达性、「服务起没起」用 `web_fetch` 或 `curl`，不开浏览器；只有明确要求用浏览器/网页端才开。
- 单测 211 pass / 0 fail。

## 0.34.95

- **PDF 不再是空白页**：Chrome 无头进程画不出 PDF，右栏只会是一张白图，模型会以为地址是空的。现在识别主文档的 `application/pdf`，把字节用带会话 cookie 的请求取回归档到该 profile 的 `downloads/`（实测 13 KB 样例 554 ms，首字节 `%PDF-`），读取结果直接写明文件绝对路径，可交 `envoy_read` 或本地阅读器。
- **新元素提示**：`browser_view` 与上一次读比对，附一行 `new since the read before: 12, 13`；超过 12 个不列（说明整页都在变，不是增量），省下为找新按钮再读整页。
- **人机协同延迟实测**（后台 Chrome，输入到下一帧 JPEG 就绪）：点击派发 2 ms，出帧中位 13 ms、最坏 17 ms；悬停 8 ms。镜像里手动操作与本地浏览器同一量级，这组数字进 README 而不是形容词。
- **兼容性**：PDF 状态跨查看器导航保持（PDF 查看器把同一页签导航到自己的 `chrome-extension://` 页，此前会被当成"换了文档"清空）。
- **调研对齐**（2025–2026 开源 browser-agent）：行业已统一到"文本/a11y + 编号 ref + 按需截图"；步数比截图毫秒更值钱（planning 占 >50% 延迟）；本插件已有稳定 ref、`changed_only` 差异、`map` 地标、查询读，无视觉模型是优势而非妥协。后续照抄优先级：ref 用稳定节点 id 跨步不变、丢 ignored/不可见节点、步间缓存失效按导航/滚动/焦点判定。
- **可回归**：新增 `npm run pdf`（`scripts/check-pdf.mjs`），真实打开 PDF 并断言识别、落盘、首字节 `%PDF`；本次实测 `{"ok":true,"ms":783,"kb":13,"head":"%PDF"}`。
- **本轮数字**：单测 211 pass / 0 fail；bench 11 项预算全过（click 4 ms、hard-forms 326 ms、do-session 52 ms/步、20 步 1,429 tokens、shot 76 ms/114 KB、crash-recovery 1,443 ms）。
- `ui-copy-lint` 34 error 与 HEAD 基线逐条一致（均为非 UI 代码上的 dev-term/status-dump 误报），`style-lint` 通过，`zh-lint` 0 error。

## 0.34.94

读和动作都不再为「跟上一次一样」付第二遍钱，点完也知道到底发生没发生。

- `browser_read` 带缓存：同一页（地址 + 标题 + 正文长度 + 节点数一致）本会话读过，再读只回一行「unchanged … (4520 chars)」，正文不重发；`force: true` 拿全文。实测 nodejs.org/about 整页 4,520 字符，缓存命中回 190 字符，**约 4%**。
- `browser_read` 的 `query` 一个块都没命中时，自动降级为整页读并标明「没命中，所以给整页」，模型不用再猜一次词、再来一轮。
- 点 / 输入 / 按键的结果行多了结论：`· navigated to …`、`· reloaded`、`· content changed`、`· no visible change`；Flash 页按帧计数说 `· screen updated` / `· no frame change`。判据用已有的 `pageMark`（标题|地址|正文长度|节点数），一次取样 **1 ms**。
- `settle` 的稳态判据把节点数与正文长度也算进去：`readyState` 说 complete 但页面还在自己填内容时，不再提前返回。
- `browser_view` 新增 `map` 模式，给大页面先看地标：各类控件各多少个、去重后带编号的控件、正文多少字，不带正文。rust-lang/rust 实测 **1,100 字符 / 18 ms**，整页读是 6,000 字符（还在截断处），**约 18%**。
- 跨 frame/shadow root 的 ref 早在 0.34.79–0.34.93 就在同一套编号里（frame 起点 900000），本轮补了测试与说明，不再单列。
- 单测 205 pass / 0 fail；`bench.mjs` 11 项全过（click 4 ms、mirror 30 fps / 327 KB/s、do-session 60 ms/步）。

## 0.34.87

一个链接不再自动开浏览器，多会话也不再各养一个渲染进程。

- 提示词收紧：只有人明确说要看网页/用浏览器才开始；只给链接、读文章、单个链接正文、文档、搜索结果摘要、GitHub 仓库或 PR 页面，先用 `web_fetch` 或 envoy，读不到就说明原因问一句。单测锁住这条规则。
- 资源本来就是复用的：一个后台 Chrome 进程 + 每会话一个页签，不是每会话一个浏览器；浏览器在最后一个镜像断开 15 分钟后关闭。
- 新增页签上限 6：超出时关掉最久没动且没人观看的页签（屏幕上正在看的那页永不关），地址已存盘，下次打开直接回来。
- 首次调用时清掉上一次插件加载遗留的页签（保留各会话记住的地址）：本机实测一个长期 profile 从 152 个页签降到 4 个，Chrome 常驻内存 12.0 GB → 1.1 GB。
- 单测 189 pass / 0 fail。

## 0.34.86

这个插件只做「要动手」的网页，不再把所有网页任务都吸过来。

- 提示词改成分界：明确说「用网页端 / 在浏览器里」，或任务要登录、点按、填表、多步操作、看画面，或页面靠 JS 渲染、`web_fetch` 只拿到空壳且 envoy 也取不到内容时才开；读一篇公开文章、单个链接正文、文档、搜索结果摘要，先用 `web_fetch` 或 envoy，不为静态页开浏览器。
- 「直接开始、不问、不另起外部 Chrome、画面只留在本会话右栏、做完保留」这些原有行为不变；单测锁住这条分界（提示词必须同时出现 `web_fetch`、`envoy` 与「不要用它」）。
- 单测 187 pass / 0 fail。

## 0.34.85

按键路径不再为「证明页面还活着」反复付费，工具延迟跟着掉下来。

- 每次工具调用原来都向页面要一次存活回答；现在一秒内的回答直接复用，崩溃会在动作本身报错，不会把画面永久挂在空页上。`browser_key` 单键 26 → **7 ms**，点击 **2 ms**，截图 **75 ms / 115 KB**，`do-session` 20 步 **53 ms/步**（1300 → 1069 ms），崩溃恢复 1407 ms 后仍回到同一地址。
- 顺带把两处每次按键都在写盘的东西挪进内存：Flash 开关状态与「这个会话上次停在哪一页」的记录；改值才落盘，按键不再排队等磁盘。
- `npm test` 不再依赖 shell 展开通配符：Windows + Node 20 上 `node --test test/*.test.mjs` 会被原样交给 Node，直接找不到文件。脚本改成显式文件列表，三个 Node 版本同一份命令。
- 单测 187 pass / 0 fail（新增一条：存活回答在 1 秒内被复用，过期后重新检查）。

## 0.34.84

键盘冒烟在 macOS 与 Windows 都真跑通；从按下到画面出现有数字了。

- CI 的 `keys` job 两台机器都是绿的：macos-latest 与 windows-latest 的真实 Chrome 上，150/150 键、10 项快捷键全过。这是「换平台还能按键」的证据，不是本机推断。
- 新增「键到画面」延迟：`npm run keys` 现在起一次录屏，记录按键到下一帧送达的间隔（本机中位 18 ms，样本 9–24 ms）。这个数才是右栏照片的体感来源，以前只量到 CDP。
- 服务端的按键分支抽成 `keyEvent()`：客户端发什么就解析成页面该看到的 `key`/`code`/`keyCode`/修饰位/文本/编辑命令，松开不带文本，自动重复不当成新命令；单测直接钉住这层，不用起浏览器。
- Windows 上的五个测试误报修掉：路径比较统一成正斜杠、`client.js` 读取先归一化 CRLF、`package.json files` 的导入图归一化分隔符、Windows 没有信号量所以只断言 taskkill 路径；仓库加 `.gitattributes` 强制 LF 检出。
- 测试 186 pass / 0 fail。

## 0.34.83

整块键盘：150 个键逐个在真实 Chrome 里按下，跨平台快捷键走浏览器命令。

- 按键表补齐：F1–F12、Insert、Numpad0–9 / NumpadEnter / NumpadAdd / Subtract / Multiply / Divide / Decimal、CapsLock、NumLock、ScrollLock、PrintScreen、Pause、ContextMenu、音量与媒体键，以及美式键盘全部标点与其 Shift 半键（`` ` ``/`~`、`-`/`_`、`=`/`+`、`[`/`{`、`]`/`}`、`\`/`|`、`;`/`:`、`'`/`"`、`,`/`<`、`.`/`>`、`/`/`?`，`1`–`0` 对应 `!@#$%^&*()`）。每个键带浏览器真正上报的 `key`、`code`、`keyCode`；Shift 半键自动带 shift 位并按字符插入。
- `keySpec()` 认得人写的名字（`esc`/`return`/`del`/`up`/`space`/`f5`，大小写不敏感），未知键报错而不是静默按错；`modifierBits()` 统一解析 `Alt/Option`、`Ctrl/Control`、`Meta/Cmd/Command/Super/Win`、`Shift`，新增平台无关的 `Mod`（macOS 是 Command，Windows/Linux 是 Control）。
- 快捷键不再只有粘贴：`Ctrl/Cmd+C/X/V/A/Z/Y` 与 `Ctrl/Cmd+Shift+Z` 映射到 CDP 编辑命令 copy / cut / paste / selectAll / undo / redo，两个命令键都认，字段、输入框、可编辑区真正生效。
- 客户端把键盘完整转发：非打印键（F 键等）不再漏给宿主（以前 F5 会刷新 GUI），按下转发 `keydown`、松开转发 `keyup`，自动重复带 `repeat`，IME 组合中的键仍属于输入法；纯修饰键只随 `modifiers` 走。
- 新增 `scripts/keyboard.mjs`（`npm run keys`）：起一个真实后台 Chrome，把 150 个键逐个按进输入框，核对页面收到的 `key`/`code`/`keyCode`/shift 与写入的字符，再跑复制、剪切、粘贴、全选删除、撤销、重做、Home/End/方向键光标、Tab 换焦点、Enter 换行、按住 180 ms 的 down→up 间隔。本机 macOS 结果：150/150 键、10 项快捷键全过，单键往返 1 ms，全程 2.4 s。CI 增加 `keys` job，在 macos-latest 与 windows-latest 的真实 Chrome 上各跑一遍。
- 测试 184 pass / 0 fail。

## 0.34.82

一次点击就是一次点击；工具改叫浏览器；键盘补齐 Shift 与 ⌘V。

- 撤回 0.34.81 的「移位补点」：不重试、不二次点击，按下即响应。控件在半空中挪走属于少数派，宁可那一下不中，也不让每次正常点击都背上额外判断。（0.34.81 未对外发布。）
- 大写字母真正是大写：`A` 现在带 `shift` 位送出 `key:'A'`、`text:'A'`，不再降级成 `a`。`pressKey` / `pressChord` 统一按键规格里的 `shift` 补修饰位。
- ⌘V / Ctrl+V 能粘贴：客户端不再丢弃带修饰键的按键，转发 Alt 1 / Ctrl 2 / ⌘ 4 / Shift 8；服务端对 `v/V` + ⌘/Ctrl 走 CDP 的 `commands:['paste']`，`page.key` 把 `commands` 透传给 `Input.dispatchKeyEvent`。真实探测：输入框先输入 `Hi`，`⌘V` 后为 `HiPASTED-TEXT`。
- 所有 34 个工具从 `sidecar_*` 改名为 `browser_*`（工具操作的是右栏那个「后台浏览器」，`sidecar` 是内部机制）。页签标题定为「**后台浏览器**」，和宿主自带的「浏览器」页签分开——那个会接管聊天里的外链，是一个 webview；这个是独立的后台 Chrome，只把画面镜像进右栏，模型用 `browser_*` 驱动。系统提示写明「说的是右栏那个后台浏览器，不是宿主自带的『浏览器』页签：页面跑在独立的后台 Chrome 里」。旧名不保留别名，避免工具表翻倍；升级后请把调用里的前缀换掉。
- 从页签栏 × 关掉镜像后不再自己回来：页签描述补 `onClose → closeHere()`，所有关闭路径都会 `POST /sidecar/forget`，宿主 keepalive 的 ask 随之清空。
- 测试 178 pass / 0 fail。

## 0.34.81

点击多一次兜底：控件在按下前后挪了位置，就再点一次它现在所在的位置。

- 仅当「按下前后页面指纹完全一致」且控件中心相对点击点移动超过 3 px 时才补点一次，其余路径零开销、零重复点击风险（`hold_ms`、双击、右键、无 ref 的点位点击都不走这条路）。
- 新的 bench 场景 `moving-target`：按下时控件自己移位（`mousedown` 里左移 240 px），点击仍落地——`66/68/72 ms、hits 1/1/1`；`budget checks 12、over []、ok:true`。
- `do-session` 20 步回到 **59 ms/步**（上一版 70，指纹命中时不再多跑一次），token **1156**；单击 31 ms、双击 44 ms、`cover-click` 51/2 ms、`do-step` 68 ms。
- 说明：真实站点上「按下后控件跑掉」是少数派，这条兜底在 *没有发生变化* 时最可能触发，正常点击不会被它拖慢；因此 bench 断言的是「动画/移位控件上点击仍落地」，不是「兜底必然被走到」。
## 0.34.80

点击之后，页面到底动没动，现在会明说。

- `browser_click` 在按下前后各取一次页面的廉价指纹（地址、标题、元素数、正文长度；Flash 页用帧计数），两者相同就在回话里加一句 `nothing on the page changed`。点中了死控件、点到被遮住的区域、点得太早，都不再被当成成功让模型盲点第二次。
- 这是事实而不是重试：不重复触发点击，不会把提交类按钮点两遍。
- 代价与收益：`do-session` 20 步从 55 → **70 ms/步**（每步多两次指纹 evaluate，约 15 ms），token 持平（**1156**，只在页面没动时才多 30 字符）；点击单次 31 ms、double-click 44 ms、`cover-click` 51/2 ms、`popup-click` 170/50 ms，`budget ok:true`。
- Flash 路径不受影响：`npm run flash-tools` 点击中位 27 ms、回话 22 字符、`ok:true`（帧在动，不会误报「没变化」）。
- 新测试：Flash 帧指纹随帧变化、不回答的页面返回空串而不是错答案；`测试 177/177 pass`。
## 0.34.79

Flash 路径多了一道不依赖网络的回归门禁：`npm run flash-local`。

- 新脚本 `scripts/check-flash-local.mjs`：自己起一个 127.0.0.1 的 http 服务，页面上嵌仓库自带的 `test/fixtures/loop.swf`，走同一条 Flash 桥取帧、送输入，跑完关浏览器与服务器。站点被限流或抖动的那几分钟，不再是插件回归的证据。
- 覆盖点：电影是否画出来（`painted > 1`）、帧是否到达观看者（≥3 帧、≥2 种不同帧）、首帧到达时间、按下/抬起/按键的端到端耗时、以及桥 `POST /input` 是否直接收下输入（不再绕调试协议）。
- 实测：`firstFrameMs 255、painted 5、press 9 ms、release 1 ms、key 3 ms、fed 200 ok:true`，退出码 0。
- 探针自身修了两处误判：`/input` 的事件名是 Electron 的 `mouseMove`（写成 `mouseMoved` 会被桥拒绝成 500）；静帧电影不该用帧率判据（帧率仍由 `check-flash-mirror` 对真实站点量）。
- 新 fixture：`test/fixtures/loop.swf`（12 帧、不停止），`scripts/make-swf-fixture.mjs --loop` 可重生；`test/fixtures/tiny.swf` 语义不变。
## 0.34.78

重复读同一页时，读的开头不再重念地址。

- `browser_view`：地址与上一读相同时，渲染结果去掉那一行，直接从标题/控件开始；同一页再读一次的「没变化」回话也从 `still at <整条地址> …` 变成 `still here — nothing changed since the last read; the numbers above still work`。新增 `withoutSeenAddress()`，与 0.34.77 的 `oncePerPage()` 共用一份「已说过的地址」记录。
- 实测（`npm run flash-tools`，奥拉星登录页）：首读 740 字符；同页再读 **78 字符（−89%）**、三次读 78；点击 22 字符、输入 13 字符；点击中位 44 ms、输入 15 ms，`ok:true`。
- 门禁抗噪：站点自身请求失败的那几分钟（实测 `page trouble: 1 request failed`、点击中位 712 ms）不再被判成插件回归——降级时跳过延迟判据，只保 token 判据。
- 新测试：地址未说过则保留、说过则去掉、换页重新给全；`测试 176/176 pass`。
## 0.34.77

每一步不再重复说地址。

- 动作回话（点击/输入/按键/滚动/悬停/上传/导航）里的地址只在**第一次出现和变化时**给全；同一页的后续步骤只说标题与焦点。`browser_view` 已给过地址，所以紧接着的第一次动作就已经省掉。新增 `oncePerPage()`，按页面对象记上一次说过的地址，读与动作共用。
- 实测（`npm run flash-tools`，奥拉星登录页，5 轮）：点击回话 **116 → 22 字符**（−81%），输入回话 **107 → 13 字符**（−88%）；点击中位 26 ms、输入 9 ms 不变。
- `check-flash-tools.mjs` 判据从「首条 < 700 字符」收紧为**每一条 < 300 字符**，省 token 不会再退化回去。
- 新测试：地址首说全、再说省、换页重说、无标题时仍回一句；`测试 175/175 pass`。
## 0.34.76

脚本不再用 `process.exit()` 掐断自己。

- `scripts/` 与 `tools/` 里 15 处硬退出改成 `process.exitCode`：脚本只拥有自己的进程，但硬退出会跳过已排队的清理，静态检查每次都把它记成崩溃风险，读日志的人要逐条排掉。退出码与行为不变（`save-client` 空输入仍然拒绝、`flash-setup --dry-run` 仍然 1、`doctor` 仍然 0）。
- 收尾的 `check-flash-*` 三个门禁同样改成退出码，跑完进程自己结束。
- 新增一条测试：扫 `scripts/` 与 `tools/` 断言无 `process.exit(`，并真跑一次 `save-client` 确认拒绝仍以 1 退出；`package.test.mjs` 4 条。
- `npm run flash-hidden` / `flash-mirror` / `flash-tools` 三个门禁脚本进 `files`（tarball 29 个文件，已用 `npm pack --dry-run` 核对），装好即可自检。
- `测试 174/174 pass`。
## 0.34.75

Flash 页面上的一次工具调用，从「等超时再读一遍 DOM」变成「等下一帧、问桥」。

- 点击后原来要跑完弹窗检查 + 轮询 `readyState`，在离屏插件页上是白等；现在 Flash 页在 `settle` 里直接等下一帧（桥每 40 ms 出一帧），并把这段放到了弹窗查找之前。
- 收尾那句 `ok click …` 原来调 `Runtime.evaluate` 读地址标题，而插件正占着主线程，一次 150 ms；Flash 页改问桥的 `/info`，同一条信息几毫秒。
- 工具层实测（奥拉星 PC 登录页，5 轮取中位数，`npm run flash-tools`）：点击 **209 → 28 ms**（最慢 48 ms），输入 **→ 14 ms**，`browser_view` 31 ms / 740 字符，回话 116 / 107 字符。
- 新增 `scripts/check-flash-tools.mjs`，跑真实工具定义并给出中位数，`ok:true` 才算过。
- `测试 173/173 pass`。
