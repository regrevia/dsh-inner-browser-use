# 文件落在哪里

浏览器产生的东西——截图、抓下来的图、打印的 PDF——不落在项目根目录，也不散在 home 下。固定规则：

```
~/.dsh-inner-browser-use/artifacts/<项目>/<会话>/<种类>/
```

- **项目**：会话工作目录的文件夹名，加路径哈希前 6 位，例如 `dsh-inner-browser-use-a1b2c3`。同名文件夹、不同路径不会混。
- **会话**：会话 id 去掉 `session-` 后的前 8 位，例如 `72557d6e`。同一项目里两个会话各存各的。
- **种类**：`shots/` 是 `browser_shot` 的截图，`pictures/` 是 `browser_grab` 抓的图，`pdf/` 是 `browser_pdf` 打印的文档，`media/` 是 `browser_media` 存下的视频、音频和流。

文件名默认带时间戳（`shot-20261028-124500.png`），给了 `name` 就用它；名字里的分隔符、连续点、开头点都会被去掉，跳不出这个目录。

每个种类保留最新 40 个文件，旧的自动删，免得跑一天的会话留下一个没人翻得动的文件夹。开着的文件不会被删掉（尽力删除，失败就留着）。

调用环境里没有项目或会话信息时，落到 `no-project/no-chat/<种类>/`，不猜。

## 整个目录

```
~/.dsh-inner-browser-use/
  artifacts/<项目>/<会话>/<种类>/   给人看的产出，只在这里（见上）
  chrome/                          浏览器自己的数据：登录态、Cookie、缓存
  flash/                           Flash 播放器运行时，第一次用 flash:true 才装
  browser.log                     最近一次浏览器启动和页面记录
  asks.log                        人问过什么、答了什么
  tabs.json / mirror.json / flash.json / watcher.json   上次开着哪些页
```

`chrome/` 是浏览器进程自己在读写，不要手动改；要清登录态，用 `browser_open` 的档位或插件自己的入口，别删目录里的某个文件。上面这些都在一个根目录下，卸载插件前想留产出就拷 `artifacts/`。

测试里用 `DSH_INNER_BROWSER_ARTIFACTS` 指向临时目录，不写真实 home。
