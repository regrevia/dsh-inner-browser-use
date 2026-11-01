# 成熟度（0.47.1，2026-11）

结论：**可日常用，边界清楚**。能力面已经越过「能开网页」的层次，长跑与资源回收这条链路是本版
重点并且有实测；短板集中在跨平台验证（只有 macOS 真机跑过）和少数只有真机才能验的交互（Flash、
镜像上的手感）。

## 交付面

| | |
| --- | --- |
| 版本 / 许可 | 0.47.1 / MIT |
| 仓库 | github.com/regrevia/dsh-inner-browser-use（main 与远端一致） |
| npm | `dsh-inner-browser-use@0.47.1` |
| 代码 | 约 11.9k 行（index 956 · sidecar 3683 · tools 4111 · read 2039 · rest 124 · client 954） |
| 工具 | 39 个 `browser_*`，模型侧零配置 |
| 文档 | README ×2、ARCHITECTURE、VERIFY（10 节）、BENCH（24 个阶段）、RESOURCES、ARTIFACTS、COMPATIBILITY、FLASH、ROADMAP |
| 验证脚本 | 27 个 `scripts/`，含 live / live-safety / breadth / soak / rest / doctor |

## 证据链

| 项 | 结果 |
| --- | --- |
| 单元测试 | `node --test test/*.test.mjs` → **305 项，303 通过，2 项按环境跳过，0 失败** |
| 资源对照 | 同机同法：冷启动中位 **465–544 ms**（8 次 434–1079）、空闲 RSS 542–663 MB、空闲 CPU 0.15–1.0%、休息后 817–845 ms 唤醒；读同一页 2302 字（view）/ 2174 字（read）。竞品 Playwright MCP 冷启动 2755 ms / 1414 MB / 38.1% / 快照 7804 字、Chrome DevTools MCP 2185 ms / 1280 MB / 36.3% / 快照 5381 字（`docs/BENCH.md`、`docs/measure-competitors-2026-11.json`、`docs/measure-tokens-2026-11.json`） |
| 长跑 | soak 24 轮 + 3 次真实休息：40.3 s，内存 **1183 → 912 MB**，页数始终 1，24 次读全部有答案 |
| 休息/唤醒 | `npm run rest`：休息后内存 0、状态说 `stopped`，再读自愈回原页，唤醒 838–860 ms |
| 资源策略 | p95 学习窗口（90 s–15 min / 20 s–2 min）、内存预算 2400 MB、页签 LRU 10 min、崩溃循环守卫 |
| 串行化 | 关闭单飞 + 启动等待；旧版「休息与调用相撞」的 `CDP session is closed` 已复现并修复，soak 不再失败 |
| 不变量 | 一个 chat 一页；两点钟不会被别人抢；右栏只有本会话能开；镜像外会话一律 403 |

## 已经比同类强的地方

- **冻结而不是关闭**：有人看但没人用时停驻页面（DOM/滚动/登录态保留），不是一刀切关掉
- **查看器感知**：没人看才真释放；有人看最多停驻
- **时间自己学**：不是拍一个固定超时，是这个人用法的 95 分位
- **内存当策略**：超预算先收 LRU 页签、降码率，再决定休息
- **唤醒回原页**：0.82–0.85 s（竞品恢复是整棵重启 4.6–5.1 s），接着原地址，不是冷启动白页
- **冷启动**：0.43–0.66 s（中位 0.47–0.54 s），阶段拆解见 `docs/BENCH.md` 的「冷启动拆解」，`DSH_INNER_BROWSER_TRACE=1` 可自查
- **常驻成本**：6 个页签共用 4 个渲染进程，空闲 RSS 551 MB、空闲 CPU 0.03–0.32%；按同机同法测，竞品是 1280–1414 MB 和 36–38%
- 竞品对照与出处见 `docs/RESOURCES.md` 与 `docs/BENCH.md`（Playwright MCP 有 `--idle-timeout` 但只按时辰、Chrome DevTools MCP 没有、browser-use 只有 `keep_alive`、Stagehand 反而关掉 Chrome 节流）

## 短板（如实）

1. **跨平台**：只在 macOS + Chrome 上跑过；Windows/Linux 的进程树回收、`taskkill` 分支有代码但没实机验证（`COMPATIBILITY.md`）。
2. **真机交互**：Flash 分支需要本机 Electron 运行时可验证；镜像上的拖拽手感受帧率影响，只有 `adb`/人眼类检查，没有自动化回归。
3. **多 agent 隔离**：一个进程一台 Chrome、按 chat 分页；没有「每个 agent 独立浏览器」的强隔离档位（竞品同样没有做得更好的）。
4. **内存预算**：是策略而非硬限制；极端站点仍可能超过预算后再回收，不是提前拒绝。
5. **市场收录**：插件市场条目来自每日构建的 catalog，发版后自动跟上，无需 PR；本条目不代表示例/评分。

## 结论

从「能不能用」到「长期开着放不放心」这条线上，本版补齐了最后一段：没人用就真的不占资源，有人用就
立刻回来。剩下的风险主要是平台覆盖面与真机交互回归，不在核心链路。
