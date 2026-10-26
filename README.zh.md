# dsh-inner-browser-use

**让 agent 直接操作 DeepSeek Harness 右侧栏里那个内置浏览器——不是再开一个窗口。**

模型可以打开网址、把页面读成带编号的控件、点击、输入、执行脚本。你能看见它做每一步：指针移到目标上，落点有涟漪。页面就跑在产品自己租用的 `<webview>` 里，分区和 cookie 都没换，所以你手动登录过的那页，就是 agent 操作的那页。

> **关于名字：** *inner* 指 Harness 侧边栏里内置的浏览器。这个插件不另开窗口，也不接管 Chrome。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `browser_navigate` | 在本文的内置浏览器里打开网址，返回页面。 |
| `browser_view` | 返回地址、标题、可见文字，以及 `#1 … #80` 编号的控件。 |
| `browser_click` | 点击一个编号控件，返回跳转后的页面。 |
| `browser_type` | 往一个编号输入框里写字，可选回车。 |
| `browser_script` | 执行 JavaScript，返回最后一个表达式。 |
| `browser_selection` | 返回页面里选中的文字。 |
| `browser_copy` | 把选中内容、或某个编号控件的文字，复制到剪贴板。 |
| `browser_screenshot` | 存一张当前画面的 PNG，返回文件路径。 |
| `browser_download` | 把网页给的文件存进本对话的项目目录。网页自己开始的下载也落在同一个目录，触发它的那次调用会报出路径。 |
| `browser_upload` | 把本机文件塞进一个编号的文件框。 |

每次调用都可见：指针先滑到控件上，套一个光圈，页面会先把目标滚进视野。

第一次调用会自己把标签页开出来：侧边栏里出现**内置浏览器**，不用先点 `+`。那是产品自己的标签页——同样的标签类型、同样的地址栏、同样的分区——插件只借用它，不往「开始」里加任何东西。你手动开的那页，就是 agent 操作的那页。

## 安装

```bash
git clone https://github.com/regrevia/dsh-inner-browser-use
```

然后在 DeepSeek Harness 里：**插件 → 从文件夹安装**，选中该目录。或命令行：

```bash
dsh plugin install /path/to/dsh-inner-browser-use
```

也可以直接装打包好的发布版，不用 clone、不用 npm 账号：

```bash
dsh plugin install https://github.com/regrevia/dsh-inner-browser-use/releases/download/v0.11.30/dsh-inner-browser-use-0.11.30.tgz
```

装好后**插件**列表里出现 *内置浏览器*。需要桌面版，因为侧边栏浏览器是桌面能力。

## 使用

1. 打开你想让它浏览的那个会话。
2. 直接提要求：*「打开 example.com，告诉我标题」*。第一次调用会把内置浏览器在右侧栏开出来；自己按 **+ → 内置浏览器** 也是同一个标签页。

标签属于会话：每个会话在同一套内置浏览器里各有一页。会话里还没开过时，工具会替你在那里开。

## 数据双向流动

- **页面 → 聊天：** `browser_script` 返回字符串，`browser_screenshot` 存成 PNG，模型可以把页面内容写进对话，也可以把图片路径交给你。
- **选中即用：** `browser_selection` 把你在页面里选中的文字交到对话里；`browser_copy` 把它压进剪贴板，⌘V 就粘进输入框。
- **聊天 → 页面：** `browser_type` 写进输入框；`browser_script` 可以设置那些没法输入的字段。

## 它不做什么

- **不另开浏览器。** 没有新窗口，没有 Chrome 配置目录，没有 CDP 镜像。
- **只有页面能读到的 cookie 才活过重启。** 访客分区在内存里，页面能读到的 cookie 按工作区存到 `~/.dsh/inner-browser-use/cookies/`，该工作区的侧边栏再次打开时写回；只存在 `HttpOnly` cookie 里的登录要重新输密码。
- **截图只有可视区域。** `<webview>` 抓到的是看得见的那块，不是整页；要拍长页面先滚动。
- **一个工作区一个分区。** 同一工作区的两个会话共用浏览器存储，和内置浏览器开两个标签时一样。
- **没有新窗口、没有权限弹窗。** 想在新的窗口打开的链接留在当前页里。
- **没有标签时会替你开。** 会话里还没有内置浏览器时，第一次调用就在那里开一页；你自己开的那页同样会被接管。

## 兼容

| | |
| --- | --- |
| Harness | 桌面版，且侧边栏浏览器存在 |
| 标签 kind | `browser`，就是内置浏览器自己那个 |
| 运行环境 | Node 20+ |
| 许可 | MIT |

链路细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，版本边界见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 开发

```bash
node --test test/*.test.mjs
```

宿主半边是零依赖 ESM，客户端半边是动态客户端模块，都没有构建步骤，应用直接加载。

## 许可

MIT © regrevia
