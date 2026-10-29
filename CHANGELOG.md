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
