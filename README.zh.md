# dsh-inner-browser-use

一个由 agent 自己养的 Chrome，实时投到 DeepSeek Harness 的右栏里。

agent 打开网页、读页面、点、输入、滚动。这个浏览器是独立的 Chrome 进程，用自己的磁盘
profile，不是产品自带的那个浏览页签：右栏放的是它的画面，而画面上的鼠标仍然是你自己的。

## 工具

| 工具 | 作用 |
| --- | --- |
| `sidecar_open` | 启动浏览器（已在跑就复用）并打开一个地址。传 `headless: false` 会改为在桌面上开真实窗口。 |
| `sidecar_view` | 返回地址、标题、编号成 `1 … 120` 的控件，以及可见文字。 |
| `sidecar_click` | 点编号控件，或点 `x`/`y` 坐标。`double: true` 双击。 |
| `sidecar_type` | 往焦点输入框输入文字，也可以先点一个编号控件。中文整段送进去。`submit: true` 回车提交。 |
| `sidecar_key` | 按一个键：Enter、Tab、Escape、Backspace、Delete、上下左右、Home、End、PageUp、PageDown。 |
| `sidecar_scroll` | 在页面中心滚轮，也可以指定 `x`/`y`。`dy: 600` 约一屏。 |
| `sidecar_shot` | 存一张原尺寸 PNG 到 `~/.dsh-inner-browser-use/screenshots`，返回路径。 |
| `sidecar_state` | 报浏览器在不在跑、用的哪个 profile、地址、标题，以及有几个右栏在看它。 |

`sidecar_view` 一次给一页文本：

```
https://example.com
Example Domain

1 [a] More information
7 [input] Search
```

编号到下一次读之前都有效。任何改动页面的操作都会顺带返回一次新的读取。

## 右栏

那一栏显示的是浏览器的画面，按会话自己的流发 JPEG：1440×900，质量 72，每帧都发；静止
页面上约 82 KB 一帧、每秒 25 帧。

画面上有两个指针：

- **黑色箭头是 agent。** 它标在 agent 上一次点击的落点上，新的点击一发出箭头就动，不等
  页面重绘。
- **鼠标是你自己的。** 悬停、点击、滚轮、按键都当作真实输入交给浏览器，所以对拦截脚本点击
  的站也照常管用。移动鼠标不会带动黑色箭头。

画面上方那行地址就是地址栏：输入域名回车，页面换成它；旁边是后退、前进、刷新。你在编辑时
它不会跟着页面跳。

输入分两路进来：输入法合成的文字（中文、emoji 等）整段插入，按键则按原样送过去，所以
Backspace 在页面上删掉的是一个字。

右栏只在向它要过页面的那个会话里打开。别的会话调用工具时用的是同一个浏览器，但不会抢走
别人正在看的这一栏。

## 登录态

profile 是独立目录：`~/.dsh/inner-browser-use/chrome/default`。它在产品自己的浏览数据之外
——那份数据是每个进程临时建的，进程一退就没了，所以在这里登过的账号第二天还在。

- **插件重载。** 重载会接上仍在运行的那个 Chrome，页面也还在原处。
- **Harness 重启。** 重新打开同一个目录，cookie、`localStorage` 和 Chrome 存下的密码都留着。
- **退出。** 关浏览器是请它自己关（`Browser.close`），Chrome 在这一步才把 cookie 落盘；空闲
  15 分钟会关掉，有右栏在看时不计这段空闲。

profile 之外只写一样东西：`~/.dsh-inner-browser-use/screenshots/` 里的截图。

## 实测

| | |
| --- | --- |
| 打开页面到第一帧 | 约 850 ms，含网络加载 |
| 单帧 | 1440×900 JPEG，约 82 KB |
| 画面 | 约 25 帧每秒 |
| 指针移动到箭头跟上 | 0.8–7 ms |

## 安装

```bash
git clone https://github.com/regrevia/dsh-inner-browser-use
dsh plugin install /path/to/dsh-inner-browser-use
```

在应用里走 **插件 → 从文件夹安装**，选这个仓库目录。要装打包好的 tgz，就在该目录里打一个再装：

```bash
npm pack                                  # 得到 dsh-inner-browser-use-0.12.1.tgz
dsh plugin install ./dsh-inner-browser-use-0.12.1.tgz
```

装好后在 **插件** 里显示为 *后台浏览器*。机器上要有 Google Chrome 或 Chromium，细节见
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 使用

1. 打开你想让 agent 代跑的会话。
2. 直接说要页面上的什么事：*「打开 example.com，告诉我标题」*。

第一次调用会启动浏览器，并把镜像放进这个会话的右栏。没有调用就不会有东西自己打开：没要过
页面的会话，右栏保持原样。

## 框架、下载、网络

- **iframe 能读，跨站也能。** 不管是和页面共用进程，还是 Chrome 单独给一个进程，里面的控件都和页面自己的控件一样有编号；点击按框架在页面上的实际位置落点。
- **下载会落到磁盘。** 点一下就下载的文件写在这个浏览器自己的 profile 目录里，`sidecar_downloads` 报出文件名、大小和到达时间。
- **能看到网络。** `sidecar_network` 倒序列出页面请求了什么，自己用接口填内容、屏幕上又看不出原因的页面，不用截图去猜。

## 不做什么

- **不动你自己的 Chrome。** 浏览器跑在单独的 profile 上，和你正在用的窗口没有关系。
- **视口固定。** 1440×900、桌面布局，不缩放，也不模拟手机。
- **一次一页。** 点开新页签的链接会被跟过去：镜像落到新页面，弹窗随即关掉，不会留下第二个页面要选。

## 兼容性

| | |
| --- | --- |
| Harness | 0.2.0 及以上 |
| Chrome | Google Chrome、Chromium 或 Canary，112 及以上 |
| 运行时 | Node 20 及以上 |
| 许可 | MIT |

细节在 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)，两半怎么连起来在
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

```bash
node --test test/*.test.mjs
```

服务端那一半是零依赖 ESM，页面那一半是运行时加载的客户端模块，都不需要构建。

## 许可

MIT © regrevia
