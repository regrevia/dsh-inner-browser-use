# 文件落在哪里

浏览器产生的东西——截图、抓下来的图、打印的 PDF、存下的视频——落在**当前项目里**，跟会话工作目录走；不在项目根目录，也不散在 home 下。

```
<项目>/.dsh/browser/<会话>/<种类>/
```

- **项目**：会话的工作目录。换项目就换目录，产出跟着项目走，方便直接拷进仓库或用项目里的工具看。
- **会话**：会话 id 去掉 `session-` 后的前 8 位，例如 `72557d6e`。同一项目里两个会话各存各的，不会互相覆盖。
- **种类**：`shots/` 是 `browser_shot` 的截图，`pictures/` 是 `browser_grab` 抓的图，`pdf/` 是 `browser_pdf` 打印的文档，`media/` 是 `browser_media` 存下的视频、音频和流。

`browser_look` 不落文件：它把屏幕读成字母网格直接返回，用来反复看画面变化。

文件名默认带时间戳（`shot-20261028-124500.png`），给了 `name` 就用它；名字里的分隔符、连续点、开头点都会被去掉，跳不出这个目录。`browser_state` 的 `files` 一行给出当前实际落点。

每个种类保留最新 40 个文件，旧的自动删，免得跑一天的会话留下一个没人翻得动的文件夹。开着的文件不会被删掉（尽力删除，失败就留着）。

`<项目>/.dsh/browser/.gitignore` 写一行 `*`，所以截图不会进 `git status`；这个文件只在项目里写。调用环境里没有项目信息时，落到 `~/.dsh-inner-browser-use/artifacts/no-project/`，不猜，也不写 `.gitignore`。

`DSH_INNER_BROWSER_ARTIFACTS` 能把整个落点换到一个固定目录（测试用，也方便把产出收到别处），此时不写 `.gitignore`。

## 整个目录

```
<项目>/.dsh/browser/                 截图、抓图、PDF、媒体（见上）
~/.dsh-inner-browser-use/
  artifacts/no-project/              没有项目时的产出
  chrome/                            浏览器自己的数据：登录态、Cookie、缓存
  logins/                            按名字留住的登录，一个名字一个文件，加密
  vault.key                          钥匙串拿不到钥匙时的替代文件，只有本人可读
  flash/                             Flash 播放器运行时，第一次用 flash:true 才装
  browser.log                        最近一次浏览器启动和页面记录
  asks.log                           人问过什么、答了什么
  tabs.json / mirror.json / flash.json / watcher.json   上次开着哪些页
```

`chrome/session-cookies.json` 是 Chrome 退出时会丢的会话 cookie，加密后存在 profile 旁边；`logins/` 与 `vault.key` 由 `browser_login` 和启动时自动保存的登录备份共用，不要手动改或删，要清就用 `browser_login({action:"drop"})`。`chrome/` 其余部分是浏览器进程自己在读写，不要手动改；要清登录态，用 `browser_open` 的档位或插件自己的入口，别删目录里的某个文件。

测试里用 `DSH_INNER_BROWSER_ARTIFACTS` 指向临时目录，不写真实 home。
