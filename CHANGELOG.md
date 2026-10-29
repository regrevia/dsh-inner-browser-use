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
