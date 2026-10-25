# dsh-inner-browser-use

**让 agent 直接操作 DeepSeek Harness 右侧栏里那个内置浏览器——不是再开一个窗口。**

模型可以打开网址、把页面读成带编号的控件、点击、输入、执行脚本。你能看见它做每一步：指针移到目标上，落点有涟漪。页面就跑在产品自己租用的 `<webview>` 里，分区和 cookie 都没换，所以你手动登录过的那页，就是 agent 操作的那页。

> **关于名字：** *inner* 指 Harness 侧边栏里内置的浏览器。这个插件不另开窗口，也不接管 Chrome。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `browser_navigate` | 在本文的侧边栏标签里打开网址，返回页面。 |
| `browser_view` | 返回地址、标题、可见文字，以及 `#1 … #80` 编号的控件。 |
| `browser_click` | 点击一个编号控件，返回跳转后的页面。 |
| `browser_type` | 往一个编号输入框里写字，可选回车。 |
| `browser_script` | 执行 JavaScript，返回最后一个表达式。 |
| `browser_screenshot` | 存一张当前画面的 PNG，返回文件路径。 |
| `browser_upload` | 把本机文件塞进一个编号的文件框。 |

每次调用都可见：指针先滑到控件上，套一个光圈，页面会先把目标滚进视野。

## 安装

```bash
git clone https://github.com/regrevia/dsh-inner-browser-use
```

然后在 DeepSeek Harness 里：**插件 → 从文件夹安装**，选中该目录。或命令行：

```bash
dsh plugin install /path/to/dsh-inner-browser-use
```

装好后**插件**列表里出现 *内置浏览器*。需要桌面版，因为侧边栏浏览器是桌面能力。

## 使用

1. 打开你想让它浏览的那个会话。
2. 右侧栏按 **+**，选 **内置浏览器**。
3. 直接提要求：*「打开 example.com，告诉我标题」*。

标签属于会话。会话里没打开标签时，工具会直说，不会自己去猜。

## 数据双向流动

- **页面 → 聊天：** `browser_script` 返回字符串，`browser_screenshot` 存成 PNG，模型可以把页面内容写进对话，也可以把图片路径交给你。
- **聊天 → 页面：** `browser_type` 写进输入框；`browser_script` 可以设置那些没法输入的字段。

## 它不做什么

- **不另开浏览器。** 没有新窗口，没有 Chrome 配置目录，没有 CDP 镜像。
- **活不过重启。** 访客分区在内存里，重启应用后密码登录的页面要重新登录一次；应用不重启期间，关标签再打开 cookie 还在。
- **截图只有可视区域。** `<webview>` 抓到的是看得见的那块，不是整页；要拍长页面先滚动。
- **一个工作区一个分区。** 同一工作区的两个会话共用浏览器存储，和内置浏览器开两个标签时一样。
- **没有下载、弹窗、权限弹窗。** 访客是沙箱的。要把字节弄出来（图片、文件），用 `browser_script` 在页内读。
- **需要标签先开着。** 没有标签时工具返回一句提示，不会替你开。

## 兼容

| | |
| --- | --- |
| Harness | 桌面版，且侧边栏浏览器存在 |
| 标签 kind | `inner-browser-use`，不覆盖内置的 `browser` |
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
