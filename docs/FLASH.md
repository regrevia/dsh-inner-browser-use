# Flash 之后：把兼容性放在正确的位置上

Chrome 88（2021 年 1 月）拿掉 Flash，不是商业决定，是插件模型的失败：一个能直接操作音频、图形、网络和本地文件的第三方二进制，安全面等于浏览器本身，而它承担的内容又都可以用开放标准重写。结论对自研同样成立：**不要再造插件槽位，要造内容层的运行时。**

## 兼容的到底是什么

一个 SWF 只有四样东西是「约定」：

1. **标签流**——Shape/Sprite/Bitmap/Font/Sound/Frame 的二进制结构，决定画面怎么组出来；
2. **时间线**——`ShowFrame` 与帧率构成保留模式动画，帧可以跳、可以循环；
3. **AVM1 / AVM2 语义**——脚本看到的 DisplayObject、事件、`MovieClip`、`SharedObject`；
4. **安全模型**——跨域、socket 策略、本地存储。

只要这四样对得上，游戏就能跑。渲染用 Canvas2D 还是 WebGPU、时钟是实时还是虚拟、存储落 IndexedDB 还是宿主磁盘，**游戏看不见**。这就是「参考原理重做一个更好的」的立足点：兼容性锁在 AVM + 标签流，创新空间在其余全部。

## 分层设计

```
SWF ──▶ 摄入(读取标签流, 建 IR) ──▶ 显示列表 + 时间线 ──▶ 渲染(WebGPU, 损伤跟踪)
                                     │
                                     ├─ AVM 兼容核(Ruffle wasm / 自研 AVM1 解释器)
                                     ├─ 虚拟时钟(固定步长, 输入带时间戳)
                                     ├─ 能力沙箱(网络/存储/剪贴板 走宿主代理, 可录可回放)
                                     └─ 对象图内省(每帧把状态压成 JSON 差异, 给 agent 读)
```

四层的分工决定了「比 Flash 好」不是同一维度的竞速：

| 维度 | Flash 的做法 | 这里的做法 | 可测指标 |
|---|---|---|---|
| 启动 | 装插件、NPAPI/PPAPI 握手 | 页面内 wasm，零安装 | 首帧 ms |
| 安全 | 插件进程 + 沙箱补丁 | 无原生代码，网络存储全代理 | 无提权面 |
| 确定性 | 真实时钟，帧率随机器 | 固定步长虚拟时钟 + 输入时间戳 | 同输入同结果 |
| 内省 | 无（黑盒像素） | 显示列表与 AVM 状态可导出 | 状态 → JSON 字节数 |
| 传输 | 屏幕像素 | 损伤区域 + 增量 | 每帧 KB |
| 回放 | 无 | 事件日志可重放 | 重放一致率 |

## 已落地：PPAPI 分支做成插件里的开关（本版）

「兼容层」和「能立刻玩」不是二选一。插件现在有两套运行时，同一个 CDP 管线、同一个镜像、同一套工具，切换只是一次重启：

```
browser_open({ flash: true, url: 'http://aola.100bt.com/play/play.html?from_h5=true' })
```

开的时候宿主用 Electron 11.3.0（Chromium 87，最后一个还认 PPAPI 的 Chromium）当浏览器，关的时候切回 Chrome。输入注入、导航、读页面、镜像全都不用改，因为两边都说 CDP。

三条必须同时成立的条件（缺一条就报「Flash 缺失」，且症状会骗人）：

1. `--ppapi-flash-path` 指向 bundle **里的 Mach-O 可执行文件** `PepperFlashPlayer.plugin/Contents/MacOS/PepperFlashPlayer`，不是 `.plugin` 目录。指错目录时插件报 `No PPP_GetInterface in plugin library`——那是假象，不是导出缺失。
2. 必须加 `--no-sandbox`。否则 ppapi 进程报 `dlopen(...) (file system sandbox blocked open())`，页面提示没有 Flash。沙箱只对这一个隐藏的独立 profile 关，正常浏览器不关。
3. 宿主必须是 x86_64（Apple 芯片跑 Rosetta）：插件只有 i386/x86_64 切片，arm64 Electron 装不进它。所以下载固定取 `darwin-x64`。

Electron 11 的两个真实限制，代码里已按它们写：

- 它不会用当前 Chrome 的 profile 目录（会降级并上锁），Flash 分支固定用 `<profile>-flash` 独立目录；两边登录态各自独立。
- `/json/new` 在 Chromium 87 上是 404，单窗口应用也没有第二个窗口，所以 Flash 分支不建新页签：会话要页签时把唯一那个窗口导航过去。

### 起来之后还要证明它真在

端口能连上不等于插件装上了：`/json/version` 由浏览器进程回答，插件加载失败时它照样 200，页面只是画出一块黑。所以启动流程在端口就绪之后还问页面一句 `navigator.plugins`，只认名字里带 `Shockwave Flash` 的那条，结果存成浏览器自己的状态：

- `browser_open` 在正文里给一行 `flash runtime: plugin loaded (Shockwave Flash)`，或者 `open, but no Flash plugin is loaded — movies will not play; run scripts/flash-setup.mjs`；还没问到时写 `plugin not checked yet`，不猜。
- `browser_state` 的运行时行把「模式」和「插件」分开：`Flash-era runtime — plugin loaded (…)` / `— no Flash plugin is loaded`。
- `browser_prepare` 在真的找到 movie、但插件缺失时补一句「它们跑不起来」，免得把黑帧当成游戏还在加载。

问不到（页面崩溃、CDP 早断）时记 `null`——没有证据就不下结论，这跟「没装运行时」是两回事：后者在启动阶段就抛 `sidecar: no Flash runtime on this machine`。

实测数字（Apple 芯片 + Rosetta，1440×900）：

| 指标 | 值 |
|---|---|
| 冷启动到能驱动页面 | 1389 ms（首次含解压；同机热启 545–927 ms） |
| 页面首帧出图 | 约 8–10 s（SWF 自己的加载），之前是 11 KB 白帧 |
| 单帧 JPEG q72 | 96–103 KB |
| `capturePage` 取一帧 | 16 ms |
| 镜像 SSE 节奏 | 15 fps（66 ms 一轮），4 s 收 60 帧，均值 97.8 KB |
| PC 版判定 | 页面里出现 `EMBED .../weblogin/20171026_1.swf`、登录框是「多多号/手机/邮箱」而不是 H5 的样式 |

### 输入真的进到影片里（0.47.24）

起得来、画得出，不等于能玩：登录要打字，游戏要点击。这一版把 Flash 窗口的输入从头验到页面事件，修掉四个各自独立的问题，每一个都会让「点一下没反应」看起来像影片坏了：

1. **声音一开就起不来。** 宿主进程带着 `ELECTRON_RUN_AS_NODE=1`，Electron 11 把命令行当 Node 参数解析，报 `bad option: --mute-audio` 后直接退出。启动环境里删掉这个变量；声音开关改由 `DSH_FLASH_SOUND` 与运行中的 `/sound` 决定。
2. **输入模块加载错路径。** `runtime/flash-app/main.js` 在 `flash-app/` 里 `require('./flash-input.cjs')`，文件在上层目录；改 `../flash-input.cjs`，运行时才进得去。
3. **坐标被缩放两次。** `sendInputEvent` 的坐标就是 DIP，与 CSS 1:1，旧代码又乘了一次窗口缩放：点 40,30 落在 80,60。同时按下事件以 `buttons:0` 到达（拖动、选中都用不了），命名键 `ArrowUp` 以 `key="" keyCode=0` 到达。现在缩放乘法已删除，`mouseDown` 补 `leftButtonDown`，`mouseMove` 带住按下的键，命名键用 accelerator 名映射（`ArrowUp→Up`、`PageUp`、`Enter`、`Space`…）。
4. **桥接卡住时每个事件赔 1.2 秒。** 请求挂起而不是拒绝时，一次点击要等超时才退回去走 CDP，连续动作会慢到没法用。现在连续 2 次失败就放到 30 秒后再说，期间一个事件最多 1.2 秒，`browser_state` 会写一行 `flash input bypassed N s`，让人知道慢在哪；唤醒浏览器时清零，重新给一次机会。

输入约定抽成纯模块 `runtime/flash-input.cjs`（`planInput` 决定状态码与事件），`runtime/flash-app/main.js` 只负责读 body 和调用 `sendInputEvent`，`test/flash-input.test.mjs` 用 7 项测试钉住 405/413/500/503/400、坐标 1:1、按钮位、滚轮增量、命名键拼写与修饰键。实测（Apple 芯片 + Rosetta，真实 Electron 11.3.0 窗口，页面是自带 HTML）：

| 指标 | 值 |
|---|---|
| 按下+松开一次（中位 / p95 / 最大） | 1.3 / 3.3 / 10.6 ms（首个含冷路径） |
| 一次按键（按下+抬起） | 1.0 / 1.6 / 2.2 ms |
| 一次滚轮 | 0.4 ms |
| `humanType` 每字符 | 3.5 ms |
| 坐标 | 点 (40,30) 命中 (40,30) 的 `#near`，`buttons` 1 → 0 |
| 键入 | 焦点框里 `value` 从空到 `ab`、到 `xxxxxx`，`input` 事件逐字到达 |
| 命名键 | `ArrowUp` 38、`PageUp` 33、`Delete` 46（删掉一个字符）、`Enter` 13，`key` 为真名 |
| 声音 | `DSH_FLASH_SOUND=1` 启动成功，运行中 `/sound` 关→开都返回 true，`browser_state` 报 `sound: on` |
| 熔断 | 全部探针 `inputFails` 0，无 30 秒回退 |

上一版用带缩放的桥接量到 `pressMs 8 / releaseMs 0 / keyMs 3`，那组数字对应的是「坐标已经错了」的管线，作废。仍要说清：这些是**窗口里普通 HTML** 的端到端证明——坐标、按钮位、命名键、文字落地都走同一条桥接，但影片内部（`loop.swf`）的输入回路只验到「事件确实送到渲染进程」，影片自己的响应还要真实游戏复核。

**不能随包分发 Adobe Flash Player**：插件本体留在本机状态目录（`~/.dsh/inner-browser-use/flash/plugin/`），由 `npm run flash:setup` 从本机已有的安装里找/拷，找不到就明说；Ruffle 那条路（MIT/BSD）仍是可分发的那条。

## 分阶段

- **M0 摄入（已发布）**：读 SWF 标签流，给出尺寸/帧率/AVM/资源构成。`runtime/swf.mjs` + `npm run swf`。
- **MP 立刻能玩（本版）**：PPAPI 分支 + 插件开关，见上节；`npm run flash:setup` 备运行时。
- **M1 能跑**：自托管 Ruffle + 宿主路由 + `embed/object` 自动 polyfill，在一个真实 SWF 上量首帧、fps、字节数。
- **M2 能读**：把 Ruffle 的 player 对象与显示列表接到 `browser_eval`，agent 直接读游戏状态，不用截图。
- **M3 更快**：损伤跟踪 + 增量帧传输；对同一游戏给出「Flash 版 vs 这里」的毫秒与 CPU 对比。

## 诚实边界

- AVM2 的兼容上限由兼容核决定；Ruffle 官方口径是「多数游戏能玩，仍有 API 缺口」，具体游戏要实测。
- Stage3D、加密 SWF、依赖本地插件的网游登录器，不在 M1–M3 的承诺内。
- ZWS（LZMA）本版明确拒绝；补 LZMA 是一天的事，但先要有真实影片来验证。
