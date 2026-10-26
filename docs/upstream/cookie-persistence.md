# 提议：让内置浏览器的工作区存储分区跨应用重启保留

> **状态：不采用。** 重启后重新登录可以接受，本插件不再要求这条改动；
> 本文只作为上游行为的记录保留。插件现在只在同一次运行内共用存储，
> 页面能读到的 cookie 另存一份供下次启动使用。


## 现象

`/lib/main.js` 中 `DesktopBrowserGuests` 给每个工作区一个分区：

```js
partitions = new Map()                    // workspace -> partition
partition = `dsh-sidebar-browser-${randomUUID()}`
session.fromPartition(partition)
```

分区名没有 `persist:` 前缀，且 uuid 每次启动都不同，因此是**进程内**存储。官方 README 已经写明：

> Cookies and Web storage do not survive application restart.

同一个工作区里的所有标签、所有会话共享这个分区，所以**同一运行期内**登录态是共享的；重启后全部丢失，用户需要重新登录每一个站点。

## 提议的最小改动

分区名按工作区稳定派生，并加 `persist:` 前缀：

```js
import { createHash } from 'node:crypto'

function workspacePartition(workspace) {
  const key = createHash('sha256').update(String(workspace ?? '')).digest('hex').slice(0, 16)
  return `persist:dsh-sidebar-browser-${key}`
}
```

- 解析不到工作区的会话继续用随机 `dsh-sidebar-browser-${randomUUID()}`（匿名、临时，不写盘）。
- `configureSession` 的权限、下载、导航策略不变，磁盘上只是 cookie 与 Web storage。
- 需要配套一个"清除浏览数据"入口（`session.clearStorageData()`），否则登录态无法由用户收回。
- 建议做成设置项（默认沿用当前不持久），因为持久化 = 登录票据落盘，共享机器上有风险。

## 影响面

- 只有分区命名与 `acquire` 的缓存键变化；lease 协议、`will-attach-webview` 白名单、`attachInput`、IPC 全不变。
- 老版本留在磁盘上的数据没有，首次升级后用户仍要登录一次；之后跨重启保留。
- 多窗口同一工作区会共用同一持久分区，这与当前的共享语义一致。

## 为什么插件侧做不到

`preload-app.cjs` 暴露的浏览器面只有 `acquire(workspace)` / `release(lease)` / `onOpenRequested(lease, cb)`；`browserAcquire` 的 IPC 只把 `workspace` 交给 `browserGuests.acquire`，没有分区参数。窗口的 `will-attach-webview` 只放行 `src = about:blank#<lease>` 且 `params.partition === lease.partition` 的 guest，插件无法自带分区。宿主插件进程拿不到 `electron` 模块（`createRequire` 报 `Cannot find module 'electron'`），也无法自己开 `BrowserWindow`。

因此：跨会话共享登录态插件已经免费获得；跨应用重启保留必须由产品侧改这一处。
