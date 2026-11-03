# 成熟度（0.47.24，2026-11）

结论：**可日常用，边界清楚**。能力面已经越过「能开网页」的层次，长跑与资源回收这条链路是本版
重点并且有实测；短板集中在跨平台验证（只有 macOS 真机跑过）和少数只有真机才能验的交互（Flash、
镜像上的手感）。

## 交付面

| | |
| --- | --- |
| 版本 / 许可 | 0.47.24 / MIT |
| 仓库 | github.com/regrevia/dsh-inner-browser-use（main 与远端一致） |
| npm | `dsh-inner-browser-use@0.47.24` |
| 代码 | 约 12.3k 行（index 986 · sidecar 3986 · tools 4185 · read 2039 · rest 124 · client 1004） |
| 工具 | 39 个 `browser_*`，模型侧零配置 |
| 文档 | README ×2、ARCHITECTURE、VERIFY（10 节）、BENCH（27 个阶段）、RESOURCES、ARTIFACTS、COMPATIBILITY、FLASH、ROADMAP |
| 验证脚本 | 32 个 `scripts/`，含 live / live-safety / breadth / soak / rest / tabs / doctor / flash-fit / flash-idle / bench-actions / bench-pagesize |

## 证据链

| 项 | 结果 |
| --- | --- |
| 单元测试 | `node --test test/*.test.mjs` → **295 项，0 失败**（普通 shell；应用内还会多跑宿主进程专属的几项） |
| 资源对照 | 同机同法：冷启动中位 **465–544 ms**（多次采样 434–1079，0.47.3 两次 448 / 471）、空闲 RSS 542–663 MB、空闲 CPU 0.15–1.0%、从静止的休息醒来 **389 ms**；读同一页 2302 字（view）/ 2174 字（read）。竞品 Playwright MCP 冷启动 2755 ms / 1414 MB / 38.1% / 快照 7804 字、Chrome DevTools MCP 2185 ms / 1280 MB / 36.3% / 快照 5381 字（`docs/BENCH.md`、`docs/measure-competitors-2026-11.json`、`docs/measure-tokens-2026-11.json`） |
| 五家对照 | 同机同法、都只量「不用模型」的那一层（开页/截图/读页/空闲/收尾），竞品为 Playwright MCP 0.0.84、Chrome DevTools MCP 1.12.0、Stagehand 4.3.0、browser-use 0.13.14：空闲 CPU **0.33% 对 36–51%**、空闲 RSS **459–552 MB 对 1265–1672 MB**、读同一页 **2302 字符对 5662–21396**、热页签内部 `start` **20 ms** 对 24–33 ms、截图 48–71 ms 四家打平（`docs/BENCH.md`「五家对照」段、`docs/measure-competitors-2026-11.json`）。没赢的照实写：热页签工具层 42–54 ms 对 browser-use 裸 `new_page` 27 ms；冷启动这一项 0.47.6 时落后（840 ms 对 760/713 ms），0.47.13 五次重测中位 **453 ms** 已反超，幅度有限、随负载浮动（`docs/BENCH.md`「冷启动」段） |
| 六个页签 | `npm run tabs`（0.47.23 重跑）：812 MB、8 进程 / **4 渲染进程**不变、空闲 **0.6%**（稳态 0.08%）一个核；热浏览器再开一页中位 **45 ms**；第 7 个会话拿到自己的页、树不长（812 → 829 MB、8 → 10 进程、仍 4 渲染进程） |
| 每页成本 | 1→6 页签、每步 3 次采样取中位：总 RSS **883–1058 MB 来回**、无单调增长，单步差值（−102…+152 MB）大于采样极差（1–94 MB）也大于「每页」本身——页签数不是内存驱动因素，只有渲染进程数（≤4）随页签涨（`docs/BENCH.md`「每页成本」段） |
| Flash 收尾 | `scripts/check-flash-idle.mjs`：`putAway()` 后 pid、整个进程组、桥端口全消失（`exit 0`）；组杀之后再读一次 `ps -E`，按 `DSH_FLASH_BRIDGE_PORT=<本会话端口>` 收掉逃出进程组的助手（这类助手会继续出声，而主进程已没），扫描 39 ms 且只碰自己的桥；父进程不辞而别时桥自己 2 s 内 `app.exit(0)`（之前抓到过无父、存活 3 h 以上、仍在画的旧桥），首帧前即静音 |
| Flash 输入 | 真实 Electron 11.3.0 窗口、无缩放桥接：按下+松开 **1.3 ms**（p95 3.3）、一次按键 **1.0 ms**（p95 1.6）、滚轮 **0.4 ms**、`humanType` 每字符 **3.5 ms**；点 (40,30) 命中页面 (40,30)、`buttons` 1 → 0；`ArrowUp` 38 / `PageUp` 33 / `Delete` 46 / `Enter` 13，键入落到焦点框（空 → `ab` → `xxxxxx`）；`DSH_FLASH_SOUND=1` 启动成功、运行中 `/sound` 关开皆 true；全部探针 `inputFails` 0（旧缩放管线报的 `pressMs 8 / keyMs 3` 作废，`docs/FLASH.md`「输入真的进到影片里 — 0.47.24」） |
| 长跑 | `npm run soak`（0.47.23 重跑，0.47.22 改完之后）：24 轮 **10.5 s**，内存 **1128 → 1000 MB**（增长 −128 MB，天花板 2500），页数始终 1，3 次休息都归还内存，24 次读全部有答案 |
| 热页签 | 热浏览器里再开一页（新建页签 + 导航，同一本地 fixture）：**中位 41–45 ms**（41–72）；Playwright MCP 中位 45 ms（40–87）、Chrome DevTools MCP 中位 130 ms（127–136）。与 Playwright 打平、比 DevTools MCP 快 3.2 倍，`npm run tabs` 断言中位 ≤ 150 ms（`docs/BENCH.md` 的「热页签」段） |
| 打字 | 同夹具同 `--reps 8`：按编号打 **29 ms**（0.47.19 时 129 ms）、按字段名打 5 字符 **79 ms**（143 ms）、480 字符 **84 ms**（140 ms）、搜索框 480 字符 **89 ms**（0.47.21 时 231 ms、0.47.18 时 997 ms；开头 3 个键仍是真敲，页面照样看到 trusted 的逐键 `input`）；点击后按「光标就位」轮询、落值后不再补 `wait(30)`，两次都只少不多（`docs/BENCH.md`「点击到开打 — 0.47.20」「打字收尾 — 0.47.21」） |
| 截图 | `npm run bench` 连拍四次取中位：**51 ms**（43–52）/ PNG 106 648 字节，回答只 223 字符 + 路径；同机同法 Playwright MCP 51 ms（回答带 base64 100 644 字符）、Chrome DevTools MCP 48 ms（383 200 字符）。速度打平（成本在 Chrome 的 `captureScreenshot`），差别在文本通道与是否落文件；给 `captureScreenshot` 加 `optimizeForSpeed` 实测 41 对 41 ms、字节 +32%，已证伪回退（`docs/BENCH.md` 的「一张截图五十毫秒」段） |
| 大页成本 | `node scripts/bench-pagesize.mjs --reps 7`（0.47.23 新增）：1.6 KB / 43 KB / **344 KB（2 514 节点）** 三档同夹具，读 **5–6 ms / 6 090 字**（预算截断，比 43 KB 的页只多 3–4 ms）、view **14 ms / 2 820 字**、点 27–28 ms；0.47.22 的 djb2 校验和在这张页上 **0.3 → 2.2 ms（+1.9）**，宿主 `pageMark` 整趟 **2.9 ms / 一次往返**；闸门「校验和 ≤ 3 ms、整趟 < 10 ms」，8 项全过（`docs/BENCH.md`「大页成本 — 0.47.23」段） |
| 工具面动作 | `scripts/bench-actions.mjs`：在 `tool.execute` 外面掐表（页面动过之后 / 同一页再读分开量）。读 **0–1 ms / 2221 字 / ≈556 token**，同一页再读 **0 ms / 193 字 / ≈49 token**；view **3 ms / 2310 字 / ≈578 token**，再看 **2 ms / 78 字 / ≈20 token**；点 **17 ms**、打 5 个字 **101–108 ms**（真人 10–28 ms/字的按键节奏）、截图 **49–50 ms**、eval **0 ms**、冷开一页 **578–687 ms**（`docs/BENCH.md`「工具面动作耗时」段；0.47.21 表里读 1713 / view 1698 是「真读与去重提示混合」的均值，0.47.22 的基准按每次最小字符数重算并钉住，见「去重与真读 — 0.47.22」段） |
| 动作面三方对照 | 同机、同夹具、同流程（各自 headless Chrome，`--reps 8`，热身 2 次取中位，计时在工具调用外面）：同一页再读 **0 ms / 193 字（≈49 token）** 对 Playwright MCP 0.0.84 **7 ms / 8000 字（≈2000）** 对 Chrome DevTools MCP 1.12.0 **5 ms / 5522 字（≈1381）**，两家都不去重、8000 是服务端硬截断；点按钮 **17 ms** 对 **537 / 240 ms**；打 5 个字 **101 ms** 对 **4 / 208 ms**（三种不同契约：本项是真人节奏、Playwright 是一次 fill、DevTools 是逐键真事件且要先点一下才聚焦）；截图 49 对 43 / 40 ms（回执形状不同）；打开一页 **578** 对 **556 / 133 ms**（DevTools 只回 `pageId`，不等真实地址与标题）（`docs/BENCH.md`「动作面三方对照」段） |
| 休息/唤醒 | `npm run rest`（0.47.23 重跑）：休息后内存 0、状态说 `stopped`、原因写进记录，再读自愈回原地址且内容还在；唤醒 **661 ms**（sidecar 自计 613 ms），同一脚本 0.47.3 时量到 389 ms，区间按 **389–661 ms** 记（机器负载不同；旧口径把休息自己的 360 ms 关机等待算进唤醒，报 801 ms） |
| 资源策略 | p95 学习窗口（90 s–15 min / 20 s–2 min）、内存预算 2400 MB、页签 LRU 10 min、崩溃循环守卫 |
| 串行化 | 关闭单飞 + 启动等待；旧版「休息与调用相撞」的 `CDP session is closed` 已复现并修复，soak 不再失败 |
| 不变量 | 一个 chat 一页；两点钟不会被别人抢；右栏只有本会话能开；镜像外会话一律 403 |

## 已经比同类强的地方

- **冻结而不是关闭**：有人看但没人用时停驻页面（DOM/滚动/登录态保留），不是一刀切关掉
- **查看器感知**：没人看才真释放；有人看最多停驻
- **时间自己学**：不是拍一个固定超时，是这个人用法的 95 分位
- **内存当策略**：超预算先收 LRU 页签、降码率，再决定休息
- **唤醒回原页**：**0.39–0.44 s**（竞品恢复是整棵重启 4.6–5.1 s），接着原地址，不是冷启动白页；计时从休息彻底结束开始，人回来不会遇到「关到一半」
- **冷启动**：五次独立新进程中位 **453 ms**（433–603），同机竞品 713 / 760 / 2185 / 2755 ms；阶段拆解见 `docs/BENCH.md` 的「冷启动拆解」，`DSH_INNER_BROWSER_TRACE=1` 可自查
- **重复读不花第二遍钱**：同一页、同一形状再读，429 → 49 token（read）/ 425 → 49 token（view），0–2 ms 就答完——竞品每次读都是整页重渲染一遍
- **声音可控**：Flash 默认静音（首帧前即静音），右栏音符键实时开关，状态由桥回报、`/sidecar/state` 广播；运行中改声音不用重开游戏
- **常驻成本**：6 个页签共用 4 个渲染进程（`npm run tabs` 实测 864–921 MB、空闲 0.9%、稳态 0.24%），单页空闲 RSS 551 MB、空闲 CPU 0.03–0.32%；按同机同法测，竞品是 1280–1414 MB 和 36–38%
- 竞品对照与出处见 `docs/RESOURCES.md` 与 `docs/BENCH.md`（Playwright MCP 有 `--idle-timeout` 但只按时辰、Chrome DevTools MCP 没有、browser-use 只有 `keep_alive`、Stagehand 反而关掉 Chrome 节流）

## 短板（如实）

1. **跨平台**：只在 macOS + Chrome 上跑过；Windows/Linux 的进程树回收、`taskkill` 分支有代码但没实机验证（`COMPATIBILITY.md`）。
2. **真机交互**：Flash 分支需要本机 Electron 运行时可验证；镜像上的拖拽手感受帧率影响，只有 `adb`/人眼类检查，没有自动化回归。
3. **多 agent 隔离**：一个进程一台 Chrome、按 chat 分页；没有「每个 agent 独立浏览器」的强隔离档位（竞品同样没有做得更好的）。
4. **内存预算**：是策略而非硬限制；极端站点仍可能超过预算后再回收，不是提前拒绝。
5. **市场收录**：条目来自每日构建的 catalog，发版后自动跟上，无需 PR；本条目不代表示例/评分。当前核对（2026-11-03）：catalog 构建收录 **0.47.5**，npm 已发 **0.47.22**，按设计滞后一到两个 nightly（条目里没有版本字段，版本由 npm 解析）。

## 结论

从「能不能用」到「长期开着放不放心」这条线上，本版补齐了最后一段：没人用就真的不占资源，有人用就
立刻回来。剩下的风险主要是平台覆盖面与真机交互回归，不在核心链路。
