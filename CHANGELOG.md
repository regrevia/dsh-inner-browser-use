## 0.13.0

- **iframe 里的控件现在能读、能点、能输入。** 一次读会按主框架优先走一遍框架树，同进程 iframe 里的输入框、按钮和页面自己的控件一起编号；编号带框架槽位（`900000 + slot * 100000 + 局部号`），点击时先在那个框架里解析，再加框架在页面里的位置，输入仍按视口坐标发。Chrome 单独进程跑的跨域 iframe 没有上下文可读，但位置可算、仍可点。
- **点开的新页签会被跟过去。** 页面拿不到自己弹窗的句柄，所以动作之后问一次 DevTools 地址表：出现别的 page 目标，就把镜像导航到它的地址，再用 target 的 HTTP 接口关掉弹窗。看镜像的人会看到点击去了哪里，始终只有一个页面要驱动。
- **读的结果封顶在调用方要的行数。** 之前上限算的是候选控件数，于是 dense 页面一次读回 142 个控件；现在先按视口排序再截到 `max`，同一页 90 行，`full` 一次读从 917 降到 626 token。
- 测试：25 条单测通过；广度脚本 13 条全真（shadow 读/点、表单四个动作、`confirm()` 捕获与接受、iframe 读/输入/点击、弹窗跟随、失效 ref 拒绝）。

## 0.12.1

- **镜像只有一个主人。** 谁最后要浏览器，浏览器就归谁：插件记下 owner，别的会话再去连 `/sidecar/frames` 只会拿到 403，拿不到画面；`/sidecar/state` 会回 `owner`，页面每 2.5 秒对一次，不是主人的会话只留一句「这个浏览器属于发起它的会话」，不开流、不画画面，自己那边的页签也收掉。
- **输入和跳转跟着主人走。** `/sidecar/input`、`/sidecar/nav` 带着别的会话的 id 会被 403 拒绝；`/sidecar/open` 必须说明是哪个会话要的，不说明就 400，不会替谁猜。
- **换手是干净的。** 新会话拿到浏览器时，旧会话的页签同一刻关掉，不会两边同时显示。
- 测试：22 条，含 owner 认领与不共享、状态回 owner、open 不带会话被拒。

## 0.12.0

- **浏览器换成了自己的。** 不再驱动产品自带的浏览页签：插件自己起一个 headless Chrome，profile 在 `~/.dsh/inner-browser-use/chrome/default`，页面经 CDP 读取。旧的 `browser_*` 十个工具、`<webview>` guest 绑定、租约与快照整套删掉，右栏里的页签叫「后台浏览器」，和产品自己的浏览器不再共用。
- **右栏是实时画面。** `Page.startScreencast` 出 1440×900、质量 72 的 JPEG，每帧都发：约 25 帧每秒、单帧约 82 KB，从打开地址到第一帧约 850 ms。帧不排队，两个在途就丢后来的，读得慢会掉帧，但拿到的总是最新的。
- **两个指针各归各的。** 黑色箭头是模型的，输入一发出就动，实测 0.8–7 ms，不等下一帧；系统光标就是你自己的，悬停、点击、滚轮、按键都按真实输入送进页面，悬停不会带动箭头。页面自己的 CSS 光标也会带回来。
- **中文与退格。** 输入法合成的文字走 `insertText` 整段插入；Enter、Tab、Backspace、方向键等走 `dispatchKeyEvent`，Backspace 在页面上真的删掉一个字。
- **登录态活过重启。** 退出是请 Chrome 自己关（`Browser.close`），cookie 在这一步落盘；插件重载接上仍在运行的 Chrome，进程重启后打开同一个 profile 目录；空闲 15 分钟关掉，有右栏在看时把这段时钟重新起算。
- **会话定向照旧，机制换了。** `sidecar_open` 把 `sidecar-wanted` 只推给发起会话，页面在 `sidebarRight.mounted` 等于自己时才开镜像；没有轮询，也不会因为别处先要过就落到别人的右栏。
- **工具与路由。** 八个 `sidecar_*` 工具，七条同源路由（`/sidecar/frames`、`/sidecar/state`、`/sidecar/open`、`/sidecar/input`、`/sidecar/nav`、`/sidecar/stop`、`/downlink`）。页面只知道路由前缀，拿不到 Chrome 的调试地址。
- **升级须知。** `browser_*` 调用和 `/watch`、`/uplink`、`/push` 这些路由都不存在了；原来靠 guest 分区的登录态不做迁移，需在新的 profile 里重新登录一次。
- 测试：19 条，含「内置浏览器的路由已删除」「只注册 sidecar 工具」「停在停止状态时读状态不会启动浏览器」「镜像只在发起它的那个会话里开」。

## 0.11.45

- **镜像只出现在向它要页面的那个会话。** 删掉页面每 4 秒自己查一次状态再开标签的轮询：`sidecar_open` 把 `sidecar-wanted` 推给发起会话，页面收到后只在 `sidebarRight.mounted` 等于自己时才开标签。别的会话不会被展开，也不会被顶到前面。
- **两个指针各归各的。** 面板恢复系统光标——你的鼠标就是原来的指针，悬停只作为 `mouseMoved` 转给页面，不再改模型指针的状态；黑色箭头只跟随工具自己发出的输入。
- **降延迟。** 截图降到 1152×720 / 质量 62 并开 `optimizeForSpeed`，SSE 关掉 Nagle，页面按帧刷新合并，一帧只画最新的。模型的指针另走一条小消息，页面不用重绘也能立刻跟上，空闲页面上箭头不再等下一帧。
- **登录态活过重启。** 关浏览器走 `Browser.close` 让 cookie 落盘；有画面在看时不按空闲超时关掉；补上崩溃恢复气泡的开关。
- 测试：`sidecar-wanted` 定向开启、无轮询两条（client 36、host 40）。 <!-- ui-copy-ignore -->

## 0.11.44

- **一个会话一个页面。** 页面第一次被认领时记住元素与 guest 号（`getWebContentsId`），之后每次调用先走这份绑定，不再每次重新查找一遍 DOM 再拿到"看起来一样"的另一个页面。
- **页面丢了就说丢了。** 绑定的元素被卸载、guest 被换掉时记 `page-lost`，宿主直接报错让调用方重新 `browser_navigate`；不再偷偷开一个同 URL 的隐藏页顶替（`keepResident` 对该会话拒绝）。 <!-- ui-copy-ignore -->
- **`rememberTab` 真正被调用。** `hasTab` 从此能读到事实，"这个会话有过产品浏览器页面"这条保护才生效。
- **不再自己关标签、不再自己整页刷新。** `tidyTabs` 变成空操作；构建变化触发的 `location.replace` / `reload` 改为需要 `dshib:auto-reload=1` 才执行。
- 测试：绑定/丢失/不顶替/不关标签/不自动刷新共 4 条（client 33、host 38）。 <!-- ui-copy-ignore -->

## 0.11.43

- 插件自带用法说明：人说要「用网页端 / 浏览器 / 上 ChatGPT 做」时，直接在本会话右栏开页操作到底，不再先问。

## 0.11.42

- 页面已经在这个会话里，只是右栏停在开始列表：按一下右栏自己的浏览器入口，把那一页带到前面。
- 日志里成功开页不再记成拒绝。

## 0.11.41

- 一个会话只留一页：页面还在连的时候再要一次，不再另开一页，调用也不会落到上一次没建好的那一页上。

## 0.11.40

- 切走再切回：这个会话原来的页面被原样搬回侧栏，不再因为离开而丢掉状态，也不会新开一页顶替。
- 人没点关闭，插件就不关侧栏、不关标签：页面看不见时只是让到一边，列和标签都留在原地。
- 标签栏的例行心跳不再被当成「开标签」的回话记进日志。

## 0.11.39

- 切到别的对话再切回来，这个对话的网页还在原来那一页：看不见不是页面没了，不再另开一份页面顶替，表单里填的、滚动到的位置都还在。
- 只有自己打开的页面才会被关掉；产品自己画的那个浏览器不会被这里删掉，调用结束也不会把人的标签带走。
- 认右栏不再互相递归查找，找不到时不会把栈走穿。
- 打开标签的回话只认它自己那个对话：按时间窗口把另一个对话的标签配给它是过去串楼的来源。
- 标签栏只点这个对话自己的浏览器标签，不再点最后一个；多开的浏览器标签才收，文件标签不动。
- 后台调用不再要求页面在眼前：读取、点击、填写在看不见的页面上照常执行，只有截图需要页面可见。

## 0.11.38

- 当前聊天没有右侧栏时，带地址的调用会把页面放进这个聊天自己的浏览器标签，并展开它自己的侧栏：人能看见页面，指针也有落点。
- 不在人眼前的聊天仍然用看不见的页面，不占侧栏、不抢焦点。
- 等待产品标签出现的时间从 1.6 秒放宽到 4 秒，避免刚展开就判定没有页面。

## 0.11.37

- 没有调用就不导航：右栏不会自己把页面换到某个地址，也不会自己把别的对话看过的页面开出来。上一次的地址只在你再让它做事的时候才用上。

## 0.11.36

- 右栏属于哪个对话，按“这个对话自己的那一格”来认，不再按 id 对号：别的对话的栏、标签、焦点都不会被碰到。
- 后台调用的页面和右栏里那个标签用同一份 cookie：看过一次登录的网站，后台继续用的时候还是登录着的。
- 空标签不再产生：没有地址就不开标签，只把这一格已有的标签调到前面。
- 去掉排查用的上报和一段没人再走的旧路。

## 0.11.35

- 标签丢了页面又只剩起点页时，按这个对话上次的地址把页面开回来：刷新、切回来之后直接是网页，不用再点一次。
- 不在屏幕上的对话也按它自己的 id 要标签，标签落在它自己的栏里；当前对话的右栏不会被顶到前面。

## 0.11.34

- 每个对话的浏览器标签按对话记住：同一个对话再来调用就复用它，空标签不再越开越多。
- 调用要用的地址跟着请求一起送下来：标签按这次要用的地址打开，不再先给一张空白页。
- 标签只留下“上次打开”的卡片时，页面自己把它按回网页：切回对话、刷新之后都是正常网页，不停在这张卡片上。
- 另一个对话发起的调用只按该对话自己的 id 要标签，不会把别人的右栏顶到前面；只在栏里立标签仍然只发生在当前对话。

## 0.11.33

页面不会在一次调用进行中为了追版本而刷新：那一下正在看的页面会整块重来，看起来就像崩了。调用结束后它照旧追到发布版。

## 0.11.32

追发布版失败过的窗口以前会一直停在旧版：连刷六次后就再也不刷了。现在过了六次先等十分钟，最多十二次；期间修好的版本仍能被它追上，而不会变成反复刷新。

## 0.11.31

页面现做的文件送不出来时，现在会说清是哪一个：超过 7 MB 的、或一次已经收了六个的，回复里点名文件和原因，而不是安静少一个。压缩包、表格、文档、PDF 都按同一条路走：落到这个对话的文件夹，路径直接给出来。

## 0.11.30

上一版里页面会为了追发布版反复刷新，六秒内连刷六次才停：判断条件里混进了版本号，而版本号只有重启 app 才会变。现在只看构建标记，刷一次就停；刚打开、还没有标记的页面直接当作当前版，不再无谓刷新。页面已是最新但 app 还旧时，页面记一条 `app-older` 就继续工作。

## 0.11.29

这一版只修一处：页面自己回到发布版时，地址里会带上构建标记；以前这个标记写进了 app 自己的同名开关，会顺带切走界面。现在换成一个 app 不读的名字，并把旧地址里残留的开关去掉。

## 0.11.28

- 页面里现做的文件（压缩包、表格、文档）下载后直接进这个对话的文件夹，不再只认普通下载链接。
- 没在前台的窗口也会自己回到发布的那一版。

## 0.11.27

- 存下来的旧一版不再占住窗口：页面会连着把文件本身重新读一遍，再从新的一版起来；试几次拿不到就停，不会一直自己刷新。
- 页面加载后不再留下调试用的痕迹。

## 0.11.26

- 页面只开在正在看的那个会话里：别的会话不再被塞进一个新的浏览器。
- 切回自己会话再调用即可，侧边栏直接是上次那一页。 <!-- ui-copy-ignore -->

## 0.11.25

- 不在屏幕上的页面也能打开：留出的位置可见可绘，不再被隐藏。

## 0.11.24

- 窗口里开着对话框时，页面也会自己换成新的一版。

## 0.11.23

- 一栏页面关了又开，不会再被记成「已经有页面」。

## 0.11.22

- 页面丢了就再开一个：不在屏幕上的会话不会被一个空壳挡住。

## 0.11.7

The column that a call needs is expanded through the control the product already shows, so a chat whose right panel was never opened gets one; a page that is served a new build reloads into it by itself, carrying the build in its address.

# Changelog

## 0.11.21

- 标签页里没有页面时，页面就在侧栏里由插件打开：位置就在你看着的那一栏。

## 0.11.20

- 不在屏幕上的会话只在侧栏之外干自己的活，不再请求任何标签页。

## 0.11.19

- 不在屏幕上的会话也能让它的页面干完活：页面在侧栏之外打开，用同一份登录状态，不动你正在看的窗口。

## 0.11.18

- 一个会话只开一次浏览器标签；插件更新后只在屏幕上的那个会话把标签找回来，别的会话不再凭空开空的标签页。

## 0.11.17

- A call made from a chat the app is not showing no longer opens that chat or
  its right column: it stops there and names the chat to open, so a
  conversation someone is reading keeps the page and the column it has.
- The product's browser tab is empty until a page is asked for, so a call for a
  tab holding nothing gives it the page that chat last had before driving it.

## 0.11.16

- A file name a page asks for is flattened to its last part, and a test now
  holds that a name with `..` still lands inside the downloads folder.

## 0.11.15

- A chat that named no project keeps its files under the account's home,
  instead of the folder the app was started in.

## 0.11.14

- The send-button lookup that runs inside the page is lifted out of the shipped
  code and tested: near, far, absent, and disabled all answer as intended.

## 0.11.13

- Every column still up gets its tab back after an update, once per chat, and
  the page it had is loaded again instead of a blank one.

## 0.11.12

- An update of this plugin no longer costs the page: when the column is already
  up, the tab this chat had comes back on its own, without pressing anything.
- A tab that never appeared is asked for again on the next call.

## 0.11.11

- The arrow stays where it acted for twenty seconds instead of eight, so you can
  look over and see where the press landed.
- A send reports the point it pressed, so a call that placed no arrow says so.

## 0.11.10

- The page each chat last had is remembered in one place, so a remount reads it
  back the same way. A test covers it.

## 0.11.9

- Typing with send presses the page's own send control: the pointer travels to it
  and the ring marks the press, so a page that sends by button shows the click the
  agent made.
- A page offers up to 400 controls; a listing shows eighty and counts the rest, so
  a composer below the fold is reachable.

## 0.11.8

- What the tab is showing is remembered as it navigates, so a rebuilt pane reopens
  that page instead of an older one.

## 0.11.7

The column that a call needs is expanded through the control the product already shows, so a chat whose right panel was never opened gets one; a page that is served a new build reloads into it by itself, carrying the build in its address.

## 0.11.6

- A page running the previous copy is named, with the one step that fixes it,
  instead of being driven: that copy would open a look-alike tab of its own.

## 0.11.5

- A chat whose right column was never opened now gets it, docked, before the
  page goes in, so a call does not end at a column that was never there. The
  chat keeps its width; nothing is covered.

## 0.11.4

- The page the product owns is driven where it is: no hidden container of ours
  is added to the chat page, so nothing can shift its layout.

## 0.11.3

- A tab the product did not actually open is reported as not opened, so a call
  stops waiting on a page that will never answer.

## 0.11.2

- A call finds its own chat's page. It reads the browser tab the product keeps
  for that chat instead of the right-most guest on the page, so a call can no
  longer drive a page that belongs to another conversation.
- The address bar is typed into from that chat's panel too, which works before
  its page exists.
- A workspace controller that cannot name a chat's folder no longer leaves a
  rejected promise behind: the key falls back to the chat itself.

## 0.11.1

- A call with no browser open for its chat says what happens next instead of
  pointing at a tab strip this plugin no longer uses.
- Every heartbeat names whether the page drives the product's own tab, so an
  older page is visible in the state route instead of guessing why a call hangs.
- The docs read the shipped model: one browser tab, the product's, found and
  driven rather than created.

## 0.11.0

- A file the page starts saving by itself needs no second call: the bytes land in
  this chat's project folder, and the call that pressed the link reports where
  they went. The header keeps another site from writing into that folder.

## 0.10.1

- The column the person is reading is never widened or overlaid by this plugin: in the native model the panel is the product's own, opened by opening its tab, so this plugin no longer asks for a presentation mode.
- A page from a build that parked its own guest can no longer cover the chat: leftovers are removed at boot, and a parked guest is never taken for the product's page.
- The first probe after a page load reports the window it landed in, so a column that looks wrong names the node that caused it.

## 0.10.0

- The tools drive the browser the product ships: the page lives in the sidebar's
  own browser tab, with its address bar, its back and forward buttons and its
  corner menu, instead of a second browser this plugin drew.
- That tab keeps the sign-ins itself, in the partition the product gives each
  workspace, so a page opens signed in across sessions without the plugin
  writing cookies.
- The plugin no longer offers a browser tab of its own; a browser-like tab drawn
  by a plugin is not the browser.

## 0.9.0

- A sign-in survives the app closing when the site keeps it in a cookie the page
  can read: those are filed per workspace in a file only its user can read, and
  put back the next time that workspace's pane opens.
- A chat you are not reading is told the page is not the one being read, instead
  of the column moving to show it.

## 0.8.15

- A tool call for a chat you are not reading no longer brings the right column
  forward, even when it needs a picture; the answer says what the page holds
  instead of moving what you are looking at.

## 0.8.14

- A chat the person is not reading answers from a page out of sight instead of
  taking the right column, and the row above the page offers the file it just
  downloaded to the chat as well as the selected text.

## 0.8.13

- A saved image shows where the assistant acted, even when the action finished
  before the image was taken.

## 0.8.12

- A call that cannot get the panel now answers with the reason and what to do about it, instead of waiting out the opening
  window first.

## 0.8.11

- The line above the page says what the assistant is doing there right now, and goes back to the page's own state when the
  step ends.

## 0.8.10

- A chat's folder is resolved even when its own tab never named one, so the state page and the files a page hands over
  always point inside that chat's project folder.

## 0.8.9

- The chat on screen is read from its header once, without a diagnostic pass, and the panel is taken only for that chat or
  for a chat that already has a page here.

## 0.8.8

- The panel is taken only for the chat the person is looking at, and the watch that tells which chat that is now measures
  the header's sized container instead of an empty cell, so it keeps answering while the chat scrolls.

## 0.8.7

- A chat whose header is kept mounted but off screen no longer counts as the chat on screen, so the panel is taken only
  when the person is actually looking at the chat that asked.

## 0.8.6

- The right panel is only taken for the chat on screen. A chat that is not on screen leaves the panel as it is, so no
  empty column appears when the person switches chat mid-call.

## 0.8.5

- A page that lost its surface because the right panel was closed is shown again on the next call, instead of the call
  failing as if no page existed. The panel is given back only when no page mounted at all.

## 0.8.4

- `/state` reports the folder each connected chat writes into, so the place a file will land can be seen without
  asking the model to run a call.

## 0.8.3

- One work folder per chat, with a folder per kind of file: `.dsh-inner-browser-use/screenshots/` for images and
  `.dsh-inner-browser-use/downloads/` for files the page offered. A project's root gains a single hidden name.
- That folder carries its own `.gitignore`, so a chat reading pages never shows up in your project's `git status`.

## 0.8.2

- Files the page offers and screenshots of it now land in the folder the chat works in, under
  `.dsh-inner-browser-use/`, instead of the app's own profile. The tab reports its workspace when it connects, so the
  call knows where the chat lives without asking.

## 0.8.1

- The right panel no longer opens for a chat you are not looking at. Whether a page is on screen is read from the
  space the pane is given, not from which tab mounted last, so a call from a background chat leaves the panel alone.
- A panel opened on the chance that a page would appear is given back if the page never does, and a panel left
  showing nothing after you switch chats is closed instead of staying as a blank strip.

## 0.8.0

- Select text on the page and a **Drag to chat** handle appears in the tab's status row. Drag it into the
  conversation to take that text with you. The page is read while the tab is on screen, so the handle has the
  text before the drag starts.
- The README said the opposite of the code in three places: that files cannot be downloaded, that the tab has to
  be open already, and that there is no way to drag a page fragment into the chat. All three now describe what
  actually happens.

## 0.7.3

- This chat's browser tab comes forward while a call drives it, so the page is there to see and to photograph.
  Another chat's tab still never comes forward, and the column that belongs to nobody stays shut.
- A page marked hidden is drawn again by bringing the page itself forward, not only the box around it. It kept its
  size but was never painted, which is why every image of it came back blank.
- A page already in this chat's pane is left mounted instead of being opened again, which used to close the page
  the call was about to use and rebuild it from scratch.
- The attempt to read an image from outside the page is gone: this half runs where the window is out of reach, so
  the answer was always nothing.

## 0.7.2

- Asking for an image no longer depends on the page being painted: the window that owns the view reads it through
  its own renderer, so a drive that runs while the chat's browser is behind the chat still returns a real picture.
- The surface a background view borrows is returned at the end of the call. Left in place it held another chat's
  hidden view laid out in front of the app, which grew a column that belonged to nobody.
- A page is only brought forward in the window the person is already looking at. Another chat's drive used to open
  that window's side column with nothing in it, and its own controls moved where they do not belong.

## 0.7.1

- A saved file comes back in the same answer when it is text and under 200 kB, so the chat can quote it without
  another trip through the machine. A picture, an archive or a large file still stays on disk only.
- A file with no name in its address is saved as `page.html` — or the extension its type implies — instead of
  `download`, so the desktop opens it with the right program.
- Asking for a page brings this chat's browser tab forward, so the drive is visible while the chat does it.
- A view the app is not drawing is parked out of sight before it is driven. Before, every call against a tab in
  the background failed with the guest's "Script failed to execute", which said nothing about the cause.
- A view that stays without a surface answers that the page is in a background tab, instead of the guest error.

## 0.7.0

- `browser_download` saves a file the page offers (a deliverable card, a "Download" link, a signed address) into
  `<chat folder>/.dsh-inner-browser-use/downloads/`, and returns the path. Files reach the disk as bytes over the
  same relative route: the tab reads them, the plugin writes them, so nothing depends on the app's download handling.
- A page whose own network rules forbid the address does not stop the save: the plugin's page half fetches the
  address itself and streams it through the same route. Nothing machine-specific is written into the repository.
- A transfer only reaches the folder of the call that opened it; the ticket dies with the call, and a name
  is used once, so an existing file is never overwritten.
- The pane's address row is an address bar: type a host or a full address and press Enter to load it in this <!-- ui-copy-ignore -->
  chat's page. Before, the row only reported where the page was.
- A pane that starts again opens where it was left. The page was remembered in memory only, so a plugin reload
  or a closed tab came back blank while the chat believed it still had a page open.
- A page keeps its own storage, one per project folder: cookies and logins are not shared with the app's other
  browser tabs, which is why a site can look different there.
- `browser_script` no longer answers `null` when the script throws: a runtime error keeps the message it threw,
  and only a script that will not parse falls back to the async wrapper.

## 0.6.13

- `browser_script` answers with the script's completion value again: the guest
  ran the code inside a function body and threw the value away, so `1 + 1` and
  `const a = 40; a + 2` both read `null`. Code that needs a function body (a
  top-level `await` or `return`) still gets one.
- The pane header shows the page it holds and updates on navigation; the guest
  is the only half that knows the address.

## 0.6.12

- The package declares the host it needs (`>=0.2.0`), so the card can say which <!-- ui-copy-ignore -->
  hosts it runs on instead of leaving it unknown.
- `.gitignore` covers tarballs and env files; `files[]` no longer names a
  directory that does not exist.

## 0.6.11

- A chat with no pane showing still answers: when a call arrives and no page is
  mounted, the page half mounts one out of sight and serves the call there, so
  nothing has to be clicked first. A pane that appears takes the chat back.
- `docs/VERIFY.md` records the eight calls measured in the app.

## 0.6.10

- `docs/COMPATIBILITY.md` names the capture limit, what is still unverified, and the
  five calls that check an install.

## 0.6.9

- The package is installable from the registry: it is no longer marked private,
  and `npm pack` produces thirteen files.

## 0.6.8

- The selection and copy tools have their own tests, so the calls the page answers
  for them are covered even before the next start loads them.

## 0.6.7

- A click says where the pointer landed (`Clicked #2 [button] clicked at 120,160`),
  and the pointer stays in place for eight seconds instead of under three.
- A page that still reports itself is never reloaded, so a call cannot throw away
  what the chat was looking at.

## 0.6.6

- `docs/VERIFY.md` now lists what each tool returned when it was run against the
  live pane, so a claim can be checked against the page rather than the code.

## 0.6.5

- A chat's page comes back by itself after the pane is remounted: the next tool
  call reopens the page that chat was last told to open, instead of acting on a
  blank view. The frame `why:"restore"` records it.

## 0.6.4

- A capture brings this chat's browser tab to the front before it gives up, and
  when that still yields no surface the message names the tab to open.
- The page each chat was last told to open is reported when a capture finds a
  guest the app left blank.

## 0.6.3

- A capture of a page the app is not drawing gives up in a couple of seconds and
  says which chat to open, instead of a sentence about panels and timers.
- A guest the plugin adds to the page is never attached by the app, so the
  out-of-sight renderer that 0.6.0 described is gone rather than shipped broken.

## 0.6.2

- A capture that cannot get pixels gives up in a few seconds instead of
  fifteen, and parks the page on its second try.

## 0.6.1

- A chat that is not on screen keeps its page laid out out of sight, so a
  capture shows the page as it is now rather than a reloaded copy.
- `browser_script` can be run twice: each run gets its own scope.

## 0.6.0

- A capture from a chat you are not looking at renders the same page in a
  second guest on the same session partition and takes the pixels from there,
  instead of refusing.

  Corrected in `0.6.10`: that second guest never produced pixels — a guest that
  is not drawn cannot be captured — so the claim above is wrong. Pixels still
  need the chat's page on screen; every other tool does not.

## 0.5.5

- The readme says plainly that pixels need that chat's page on screen, while
  reading, clicking and typing do not.
- A test covers the second try after a page came back.

## 0.5.4

- A capture that cannot find its page now records which view was in front and
  how big the page body was.

## 0.5.3

- A page that has just come back takes the call on the second try instead of
  failing the first one.

## 0.5.2

- A capture can open what it needs: the pane and the tab are now reachable from
  the moment the page loads, not only after a chat asks for one. Before this, a
  screenshot was the first thing a chat asked for and it had nothing to open.

## 0.5.1

- The pointer marks where a click or a typing goes, stays there for a moment so
  it can be seen, then fades.

## 0.5.0

- A tool call only ever acts on the chat that asked. Each call names its chat,
  and a page that is not on screen is never brought forward over whatever the
  person is looking at: the call says the page is not on screen instead. What
  still crosses chats is the right pane itself, which the app owns.
- The log records the controller surface once, for the next step.

## 0.4.8

- The log records the right column's size before and after a capture tries to
  open it, so a pane that never opens is told apart from one that closes again.

## 0.4.7

- The pane stays open while the capture waits. Switching the pane's active tab
  made the built-in browser report itself hidden, which collapsed the column the
  capture had just opened, so the pane is now re-asserted on every wait.

## 0.4.6

- The measurement behind an empty capture reaches the page root, so a pane that
  is closed and a tab that is merely behind another can be told apart.

## 0.4.5

- A capture that finds no pixels now writes the page's own layout chain to the
  plugin log: each ancestor's size and display, so the reason is measured
  instead of guessed.

## 0.4.4

- A capture brings its own tab forward. Opening the pane was not enough: a tab
  that stays mounted behind the pane's active tab has no box on screen, so the
  capture stayed empty. Opening the kind now focuses the tab that is already
  there, and the kind holds one tab per chat instead of several.

## 0.4.3

- Opening the right pane works. `layout` has to be in the plugin's inject list,
  not only in the list passed to one nested scope: the nested read threw
  "cannot get property layout without inject", so the pane stayed closed and
  every screenshot of it came back empty.

## 0.4.2

- A capture no longer trusts the webview element's own width. The element
  reported 0×0 while its page was 575×1080, so a screenshot failed before it
  tried. The capture now measures the box, opens the pane when the box is empty,
  follows the guest that is actually mounted, and tries three times.
- A capture that still comes back empty names the geometry it saw, so the next
  report is a measurement rather than "no image".

## 0.4.1

- The tab has a real height. The guest is laid out inside a column that had no
  height to give it, so the page could render at 0×0 and captures came back
  empty. The body is now a flex item of the pane, with a viewport between it and
  the guest — the same chain the shipped browser pane uses. (The 0×0 reading was
  reproduced; which ancestor caused it was not, so the sharing of the shipped
  chain is the fix, not a proven root cause.)
- A capture puts the pane on screen first when the guest has no size, and a guest
  that is still off screen reports its size instead of "no image".

## 0.4.0

- `browser_screenshot` returns again. The panel's PNG is handed back as a data
  URL string, because the image Buffer does not cross the desktop bridge, and the
  guest debugger this build exposes has no `Page.captureScreenshot` to use. Each
  stage now has its own budget, so a slow attach fails as "attach timed out"
  instead of a bare timeout.
- A tool call can no longer steer another chat's tab. Every open page hears the
  ask, so a page now opens the asking chat's tab by id; opening "the current
  chat" is allowed only when the mounted pane is that same chat.
- `browser_selection` returns what is selected in the page, so the agent can quote
  it here. `browser_copy` puts the selection, or one numbered control's text, on
  the clipboard for a paste into the chat.

## 0.3.6

- A PNG now comes from the guest's own debugger, which answers with base64 in
  this page. The panel's capture is still the fallback.

## 0.3.5

- `browser_screenshot` works again: the first capture of a guest that has not
  painted yet fails inside the compositor, so it is retried once, and the PNG is
  written without depending on a Node global the plugin context may not expose.

## 0.3.4

- Fixed the ask stream going to a half that no longer exists: after the host half <!-- ui-copy-ignore -->
  is reloaded (every install), the page's stream still looked open and reached
  nothing, so a call waited and then reported "no tab answered". The heartbeat
  reply now names the half serving it, and a page that hears a new name reopens
  its stream — no page reload needed after an install.

## 0.3.3

- The tab body gets its workspace under a name React keeps: `key` is reserved by
  React and never reaches a component, which is why the first tab to open failed
  with `options.key is not a function`.
- A chat and its tab do not always share an id, so the page now reports the tab
  it opened and the host routes that chat to it. Two open tabs no longer rely on <!-- ui-copy-ignore -->
  "the only seat".

## 0.3.2

- Fixed the reason a call never opened its tab: the page half read
  `ctx.sidebarRight` without asking for the service, so it only ever saw
  `undefined` and the ask was dropped in silence. It now runs its listener on a
  scope injected with `layout` and `sidebarRight`, and reports `phase:"wired"`
  once that scope is live.

## 0.3.1

- The page opens the tab in its own chat first (`openTab`), and falls back to the
  chat id (`openTabIn`) only when that refuses — the id path alone could decline
  silently, which is what a call then reported as "no tab answered".
- Every step of that handshake now reports itself: `phase:"open"` says which path
  ran, and `guest-opening` / `guest-ready` / `guest-error` say whether the tab
  body leased a browser at all. `GET /state` shows the last one.

## 0.3.0

- Tools open the tab themselves: a call with no tab asks the page over a new
  `GET /watch` stream, and the page opens this chat's tab before the call runs.
  A call waits `openWaitMs` (8 s) for that tab, then fails with one sentence.
- One tab ask per burst: a second call for the same chat within 3 s does not ask
  again, and a call with no page listening never silences the next ask.
- `GET /state` reports whether the page half is alive: a heartbeat carries its
  age and `fresh` goes false after a minute, so a plugin whose page half never
  loaded no longer looks installed-and-fine.
- The tab type no longer contributes a card to the guide pane, so the plugin
  adds nothing to any pane it does not own; `test/client.test.mjs` asserts that.
- Client-half tests run the page module in Node with a fake module loader, so
  registration and the auto-open handshake are covered without a browser.

## 0.2.0

- `browser_screenshot`: captures the tab's viewport and writes a PNG under
  `.dsh-inner-browser-use/` in the chat's working directory, returning the path.
- `browser_upload`: reads a local file and attaches it to a numbered file field
  through an in-page `File` and `DataTransfer`, with an 8 MB ceiling.
- Tests now cover both new tools, including the bytes that cross the wire.

## 0.1.0

First release.

- Host bridge over same-origin HTTP: `GET /downlink` (SSE), `POST /uplink`, `POST /push`, `GET /state`. <!-- ui-copy-ignore -->
- Five tools: `browser_navigate`, `browser_view`, `browser_click`, `browser_type`, `browser_script`.
- Client tab kind `inner-browser-use` on the `sidebar.right.pane.tab` slot, leasing a `<webview>` from the Desktop main process with the workspace's own partition.
- In-page runtime: numbered controls, real pointer and ripple, scroll-into-view, genuine mouse and keyboard events.
- Per-chat seats with a single-tab fallback; a closed tab rejects waiters, a silent one times out.
- Client heartbeat on the state route, so install problems are diagnosable without a debugger.
- 10 host tests, no dependencies, no build step. <!-- ui-copy-ignore -->
