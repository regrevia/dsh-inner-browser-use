## 0.34.7

- A session cookie kept for the next launch is no longer written over a cookie
  the browser already holds. Chrome's cookie store is the newer news: sites
  rotate their session id, and replaying the old value at every launch made a
  working sign-in look like it had been kicked out. This is the likely cause of
  the repeated 「被踢出」 seen on Doubao: the note held a session id the site had
  already retired, and every browser start handed it back.
- 86 unit tests pass (new: a live cookie is never overwritten).

## 0.34.6

- One tab per chat even when two calls start at the same instant: the second
  call for a chat waits for the tab already being opened and then follows its
  own address in it, instead of opening a twin that nothing holds. Before, a
  parallel `sidecar_view` + `sidecar_nav` could leave an orphan tab driving a
  page the mirror never showed.
- 85 unit tests pass (new: the concurrent-open case).

## 0.34.5

- One ownership gate for every acting route: `/sidecar/frames`, `/sidecar/input`
  and `/sidecar/nav` all ask the same `held(session)` question and give the same
  403 with the current owner, instead of three copies that a future route could
  forget. A new host test drives the wire: a chat that does not hold the mirror
  is refused on all three, and the holder is named back.
- 84 unit tests pass.

## 0.34.4

- An empty mirror says what to do instead of only that nothing is open:
  「还没有打开的页面，在上方地址栏输入网址」 / "No page open; type an address above".
- `tabs.json` only ever holds chats and addresses: a non-chat key such as
  `chat-a` from an older probe is neither written nor restored. The stale entry
  in the live file is removed.
- 83 unit tests pass (new: remembering and restoring a chat's address).

## 0.34.3

- `sidecar_shot` now hands the picture to the model instead of only a path:
  when the active route declares image input, the PNG is stored as an
  attachment and returned as an image block beside the text. A captcha, a
  chart, a canvas or a broken layout can be planned from what is on screen.
  The tool still returns the path, and stays text-only when the route cannot
  take images or no attachment store is mounted.
- Read state is per chat: refs, the diff baseline and the last shape belong to
  the chat that read the page. Before, chat B's read replaced chat A's
  baseline, so A's `changed_only` diffed against a page it never saw and a ref
  from A could be matched against B's control.
- 81 unit tests pass (new: per-chat state, image block only when present).

## 0.34.2

- **别的会话的页面不再被当成自己的弹窗接管。** 之前一次「找新开的弹窗」会在浏览器所有标签里挑一个不属于主标签的页，把它的地址当成本会话的弹窗，随后导航走；`adoptOpened` 还会把它关掉——一个会话的 `sidecar_open` 就可能把另一个会话正在看的页面拿走。现在每张页面知道自己的 target，浏览器把其它会话的 target 交给它作为 `siblings`，候选必须不是自己、也不在别人名下，否则一律不接管、不关闭（`isForeign`，单测覆盖「别的会话的标签 / 真正的新标签 / 自己 / 空」四种）。
- **密码不再出现在工具结果里。** `brief()` 读聚焦控件的 `.value`，登录页一聚焦密码框，结果行就把密码原样回显（实测复现 `DUMMY_SECRET_123`）。现在 `type=password` 的框只报名字、值恒为空；这条读法被抽成 `BRIEF_JS`，单测用假 DOM 直接跑它，防止再退回去。
- **批量动作真的失败即停。** `sidecar_do` 之前只在「编号失效」这一种文字出现时停，`did not see`、`still at a different address`、找不到按钮都算成功继续跑，后面的步骤就打进一个根本没到的页面。现在步骤自己返回 `blocked`，批处理看到就停在当步，并说明从当前页面重新规划。
- **遮罩没关掉时不硬点。** 检测到遮罩、点了「Accept」它还在，以前照样按原坐标点下去（点中的是遮罩），现在回一句「仍被遮住，未点击/未输入」，让人先处理它。
- **`changed_only` 之后基线前进。** 以前只做 diff、不更新上一次读取，同一段变化会每读一次再说一遍；现在 diff 完就把它当新基线。
- **`GET /sidecar/state?session=` 报本会话的页面。** 顶层 `url` 是浏览器第一张标签（可能是别人的），本会话自己的地址/标题/观看者数在 `chat` 里（豆包页实测：`chat.url=https://www.doubao.com/chat/`、`title=豆包 …`、`viewers=1`，而顶层仍是别人的 `about:blank`）。
- 单测 77 → 79（新增 `test/isolation.test.mjs`、`test/leak.test.mjs`；`test/refs.test.mjs` 的「借用必须 import」检查不再给全大写常量开例外——`KEYS` 正是从这个缺口漏过去的）。

## 0.34.1

- A tool the Host half borrowed from the tool surface was used before it was
  imported, so after a hot reload every sidecar call answered
  `sessionScope is not defined`. The import is there now, and a test reads the
  Host half and refuses a borrowed name that was not imported.
- A number from a read is checked against what the control says before it is
  pressed: if "Send" turned into "Stop", the call is refused with the two
  words instead of pressing it. Taken from Oxrail's rule that a ref is bound
  to a revision and re-verified before an action.

## 0.34.0

- **每个会话一个标签页，谁也拿不走谁的页面。** 之前浏览器是单例、只有一张页面：另一个会话随手 `sidecar_open` 就把你正在看的页面导航走了（这次就发生了——豆包页被换成了本地 `assets/pet/index.html`）。现在按会话分标签页：同一个无窗口 Chrome、同一个 profile（登录照旧共享），每个会话第一次要页面时开自己的标签，`sidecar_open`、输入、读取、页签切换、关闭页签都只作用于自己那一张；`GET /sidecar/frames?session=` 也只推该会话的标签。会话 A 导航到 `example.com` 后，会话 B 的地址、会话 A 最早的那张标签都不动（真机实测：boot 725 ms，两页互不影响）。
- **不再以“无窗口”被认出来。** 之前 `--headless=new` 让每个请求都带 `HeadlessChrome`，会检查 UA 的站点整页降级；现在用真实桌面 Chrome 的 UA 启动，窗口依旧在屏幕外。
- **打字像人，不再整段粘贴。** 粘贴（`Input.insertText` 一次性整段）是最容易被判成机器的那一个事件。现在按字派发按键：头和结尾逐字、中间小段，间隔 16–110 ms 随机，句号逗号后多停一下；长文自动加速（>160 字按 8 字一段），46 字消息 1.97 s（整段粘贴 5 ms），600 字约 4 s。点击前也有两三步小幅移动加停顿，不是瞬移。
- 单测 65 → 70（新增 `test/session.test.mjs`：无会话用第一张标签、一个会话只开一次、断开的标签被遗忘、带会话只导航自己的、两个会话地址互不影响）。

## 0.33.2

- **重复变量、重复注册不再有机会崩。** 全仓扫过一遍：没有重复的顶层声明、没有同文件重复 import、没有同名工具、页签 id 与样式表各只有一份；样式表重载时按 id 替换而不是叠一张。两半的注册点都加了保护——同名工具重复注册只是警告，重复挂同一个页签直接当无操作，不会把整块面板带崩。
- 新增 `test/no-duplicate.test.mjs`（7 项）把这件事变成回归测试：顶层重名、重复 import、工具重名、页签常量唯一、单一入口、单一样式表、打包清单完整；另加“同一套工具挂两次只是警告”的挂载测试。单测 57 → 65。

## 0.33.1

- **关掉页签就是不要了。** 补开的逻辑不能把用户主动关掉的镜像又变回来：关闭页签会同时撤掉这次请求，回到会话时栏里保持关闭。单测 56 → 57。

## 0.33.0

- **镜像请求不再因为“你不在页面”而丢。** 之前请求镜像时如果没有活着的连接，那一帧就消失了：切到别的会话、刷新页面、重开界面之后回来，栏里是空的。现在请求被记住，回到该会话的瞬间页签自己出现；两分钟前的旧请求不补开；别的会话依旧收不到。
- **视频帧也能取。** `sidecar_grab` 现在把 `<video>` 的当前帧画出来存成图片（之前只有 `<canvas>`），画面不用以文件形式存在，也不要求视频在播放。
- 单测 55 → 56（新增“离开时的请求会补上 / 旧请求作废 / 别的会话收不到”），广度 65 → 66（`grab-video-frame`，160x120，299 ms）。
- 无观察者时的链路实测：启动 626 ms、点击并读回 114 ms、读 4 ms、截图 48 ms / 12.5 KB。

## 0.32.0

- **改动跟着请求一起走。** `sidecar_review` 新增 `diff`：评审者打不开仓库，就把这次改动（diff，最多 5000 字符，超了标 `… (trimmed)`）放进发过去的消息里，它看的是代码本身，而不是对代码的描述。
- 单测补了三条断言（不传 diff 时不出现该段、传了原样带上、超长截断）；广度加一条 `review-carries-diff`，核对记录里的问题确实带着 diff。
- 广度 64 → 65 条，单测 55 条不变，包内 20 个文件。

## 0.31.1

- **没送出去的请求不再冒充答案。** 按下回车半秒后，如果那句话还留在输入框里，说明页面根本没收到：直接说“the words are still in the box…”，并提示可能是要先登录，而不是等四秒再回一段页面上的噪音。
- **页面变了，也要看它有没有记住你发的话。** 只靠“文字变多了”会把首页轮播、推荐词当成回答；现在要求页面里出现刚发出去的那句话，否则直说“the page changed but does not show the message: it did not take what was sent”，页面提到登录就补一句先去登录。
- **登录墙按墙说。** 页面确实收到、回的却是“请先登录”时，评审结果写“the page is asking to sign in first”，并附上它当时那句话，不再说“答了一段散文”。
- **发出去但没回话，也照实说。** 页面上只有刚发的那句、没有回答时，评审结果写“the page has the message but has not answered yet”，不把这段当成“答了一段散文”。
- 实测：`/nochat`（有框不收）0.5 s 内说清；`/wall`（只回登录提示）2.6 s 说清它没记住发出的话；真实页 Doubao 未登录时，2.6 s 判出“只有消息没有回答”。
- 广度 63 → 64 条；单测仍 55 条。

## 0.31.0

- **一轮评审，闭环落地。** 新工具 `sidecar_review`：把「仓库地址 + 看哪个 commit + 重点看什么」拼成一段请求，交给页面里的聊天，等它答完，从回答里拆出条目（扁平成一行也能拆），写进本轮记录；下次再问时能说出「上一轮是几分钟前、针对哪个 commit」。
- **回答里的列表不再被当成一段话。** 读页面会把一段回答压成一行，原来的分条只认换行；现在同时认 `- `、`• `、`2. ` 这些标记，并跳过页面回显的问题，实测 `/chat` 一轮 2.6 s 拿回 2 条。
- 工具数 30 → 31；单测 55 条，广度 62 条。

## 0.30.0

- **一句话交给页面里的聊天，答案在同一次调用里回来。** 新工具 `sidecar_ask`：自动找到页面上的输入框（或用 ref 指定），点进去、输入、回车，然后等到回答不再变化，把新出现的那段文字带回来。给右栏里的 ChatGPT 派活、让它看仓库提意见、让它出素材 prompt，都不用“输入→读一次→再读一次”。
- 实测：`/chat` fixture（回答分两段到达，700 ms 收尾）→ 2.5 s 返回 `Answer: …`；无回答时 4 s 后回 “no answer after … the page still says: …”，不会挂死。
- 工具数 29 → 30；单测 54 条，广度 61 条。

## 0.29.0

- **被拒 headless 时，窗口放在屏幕外。** 有些站点只认带窗口的浏览器；现在那扇窗口出现在 `-3000,-3000`，桌面上看不到，会话右栏的镜像是唯一画面。默认仍然是 headless。
- **读同一页第二次只回一行。** 地址、标题、文字、控件都没变时，`sidecar_view` 返回 `still at <地址> — nothing changed since the last read; the numbers above still work`（只移动了滚动位置会附一句）。实测：长文页 2057 字符 → 105 字符，1 ms。
- 实测：窗口模式启动参数含 `--window-position=-3000,-3000`；广度 60 条、单测 53 条全真。

## 0.28.0

- **图没加载出来，读取会说出来。** 大图位上的 `<img>` 失败了（`naturalWidth` 为 0）以前完全静默，页面上只是空一块；现在 `sidecar_view` 多一行 `picture 320x240 "Chart" did not load — the page may need a reload, or the picture is gone`，带 curt 的下一步动作。失效图会缩成一个错误图标，所以尺寸取页面声明值，不是渲染框。
- 实测：`/broken`（320×240、指向 404 的图）→ 一行 123 ms 内返回；正常图与有字页面不受影响。
- 测试：52 条单测；广度 59 条全真。

## 0.27.0

- **一次读取就说清"答案是张图"。** 页面几乎没字、只有一张大图时，`sidecar_view` 现在直接多一行：`picture 140x90 a picture with detail "Chart" — sidecar_grab saves it as a file`；纯色图则是 `mostly one colour`，空白图表在读取这一步就暴露，不用先存文件再看。行内采样 32×32，随同一次读取返回，不多一次往返。
- 有字的页面不会出现这一行（`no-picture-noise`）；小于 64px 或 8000 平方像素的小图标也不算答案。
- 实测：`/pic` → `picture 140x90 a picture with detail`；`/flat` → `picture 140x90 mostly one colour`。
- 测试：51 条单测；广度 56 条全真。

## 0.26.0

- **存下来的图带一句描述。** `sidecar_grab` 以前只回路径和尺寸，模型打不开文件就只能猜。现在图在页面里先缩到 32×32 采样一次，回一行「路径 宽x高 + 大面积单色 / 只有几种颜色 / 有细节」，空白图表和真图表一眼分清。
- 实测：140×90 渐变图 → `a picture with detail`（21 ms，含首帧）、140×90 纯色图 → `mostly one colour`（4 ms）。采样本身几乎没有成本。
- 测试：50 条单测；广度 55 条全真。

## 0.25.0

- **把页面上的图直接存成文件。** 图表、AI 生成的图、画板，答案就是那张图本身，文本树里没有字能代表它。现在 `sidecar_grab {ref?, count?, name?}` 取页面上最大的图（或某个控件里的图），带着当前登录状态在页面里读出来，落到 `~/.dsh-inner-browser-use/screenshots/`，回一行「路径 宽x高」。画布走 `toDataURL`，`<img>` 走 `fetch(credentials: include)`，所以签名会过期的图、要 cookie 的图都能拿到。
- 实测：140×90 的图存下来 6 ms，读到的 PNG 头与实际尺寸一致（`grab-picture`）。
- 测试：50 条单测；广度 53 条全真。

## 0.23.0

- **藏在可见框后面的真输入，也能按名字找到并写进去。** 日期/时间选择器常见写法是：用户看见一个带样式的 div，真正的 `<input>` 铺在上面但 `opacity: 0`。之前解析器只认「看得见的输入」，于是 `{field: "Birthday"}` 找不到，只能退回点 div，再由页面自己决定焦点去哪。现在先找可见输入，找不到就允许隐藏输入，并取**它自己或最近一层可见祖先的框**作为落点：点的是用户看见的那块，写进去的是真输入。
- **词可能在包装层外面。** 上一条还差一步：`<div class="lbl">Birthday</div><div class="dp"><input opacity:0></div>` 里，词是输入的「祖父」的兄弟。命名候选因此往上走三层，把每层前面的文本也算进来——这是表单组件库最常见的结构。
- 测试：48 条单测（`labelSpot` 的隐藏目标与 `boxOf`）；广度 49 条全真（新增 `do-field-behind`：`/bare` 加透明框日期输入，按 `Birthday` 写入后断言值）。

## 0.22.0

- **词被拆成几个节点的按钮，也能按词点到。** `<button><span>Sign</span><span>in</span></button>` 这种写法（React 组件库、i18n 把词切开都常见）在页面上读出来是 `Signin`——没有空格。以前 `{text: "Sign in"}` 找不到，只能改用编号或坐标。现在比较时把空白去掉再比，`Sign in` / `Signin` / `sign  in` 都指同一个控件。
- **结果里写回调用方自己的写法。** 只在「去空白后才相等」时，输出用调用方给的那句（`ok click "Sign in"`），不用页面的 `Signin`——人写的是前者，页面上的拼接是副作用。
- 同样的比较也进了页内那半身（`labelSpot` / `selectSpot` 的打分），所以 div 里写 `Work email`、字段叫 `workemail` 这种也能对上。
- 测试：47 条单测（新增去空白比较的等价/不等价用例）；广度 48 条全真（新增 `click-split-words`：`/words` 加拆分节点按钮，按 `Sign in` 点中）。

## 0.21.0

- **下拉框也能按名字选。** `sidecar_select` 以前只要编号；现在 `{field: "Seats", value: "Two"}` 就行——它在页面里找那个「叫这几个字」的下拉，选好选项，回一句 `chose Two in Seats`。选项对不上时把前 12 个选项念出来，不用再读一遍页面。
- **同一个页面解析件，两处共用。** `labelSpot` 里那套「影子根、什么叫什么、打分」抽成 `NAME_PRELUDE`，`selectSpot` 直接复用；两处行为不会再各写一遍、各错一遍。
- **报名字时优先屏幕上那句话。** 顺序改成 真 label → aria-labelledby → aria-label → placeholder → title → `label[for]` → 紧跟前面的文本 → 外层容器文字 → 最后才是 `name` 属性。`name="seats"` 不再把结果写成 `chose Two in seats`，而是用户看到的 `Seats`。
- 测试：46 条单测（`selectSpot` 的接口与转义、`sidecar_select` 的 `field` 契约）；广度 47 条全真（新增 `select-by-words`：`/bare` 加了带 div 标签的 `select[name=seats]`，按词选中 Two，断言值变成 `2`）。

## 0.20.0

- **`sidecar_type` 也能按名字找字段了。** 之前它只认编号（`ref`），而编号得先读一遍页面才有——为了打一行字先读整页，是最常见的几秒浪费。现在给 `field: "Work email"` 就行，它自己把词解析到能收文本的元素（同 0.19.0：真 label、aria、placeholder、name、前面的文本、只包一个输入的外层），点进去再打，结果里写清楚打进了哪个字段。
- **一份解析逻辑，两处用。** 写入这一步原来在 `sidecar_do` 里内联，现在抽成 `fieldByName`（找哪儿）+ `writeAt`（点、清、打、回车），`sidecar_do` 和 `sidecar_type` 共用；遮罩先清的规矩也就跟着统一了。
- 一处顺手修掉的错：新分支最初把「回车」写成了 `submit !== true`，等于默认每次都在回车；改回 `=== true` 并由广度检查 `type-by-words` 守住（只打字不回车，值对、页面不动）。
- 测试：45 条单测（新增 `sidecar_type` 的 `field` 参数契约）；广度 46 条全真（新增 `type-by-words`）。

## 0.19.0

- **词在 div 里、输入框光秃秃的表单，现在能把字打进对的框。** 真实表单里 `<div class="label">Work email</div>` 底下跟一个没有任何 label / aria / placeholder 的 input，是极常见的一种写法（Ant Design、MUI、自绘表单都这样）。以前的 `{field: "Work email"}` 只会找「说这几个字的控件」，找到那个 div，点它——焦点没落到任何输入框，字就打在「原来有焦点的地方」，静默地错格。现在点之前先确认：命中控件本身能收文本就直接点；不能，就在页面里找这几个字真正对应的可编辑元素（真 label、aria-labelledby、aria-label、placeholder、name、紧跟在前面的文本、只包一个输入的父容器），滚到可见处再点。
- **只装一层词也能对上，但不会乱点。** 名字完全相等记 3 分、包含 2 分、反向包含 1 分，取得分最高的可见字段；没有任何字段及格就回到老路，并且结果文字里写明打进了哪个字段（`typed into "Work email"`），错格至少看得见，不再无声。
- 遮罩依旧先清：横幅盖住词也盖住字段，所以「清遮罩」用的是带字的那个控件，清完再找字段。0.17.1 那条 `after Accept on a banner, typed into "Note"` 仍然成立。
- 测试：44 条单测（新增 `labelSpot`：词只当数据不当代码，引号不会破坏探测）；广度 45 条全真，新增两条真页面检查 `do-field-bare` / `do-field-bare-second`——`/bare` 页里两个 div 标签加裸 input，第一步打第一个框、断言第二个框仍是空，第二步打第二个框。

## 0.18.0

- **右栏没在画的时候，浏览器会自己说出来。** 镜像是「发起会话右栏里的那块画面」，而画它的那一半是跟着页面加载进来的：插件是在本页载入之后才装好的话，那一半根本没加载，于是浏览器照常在跑、化学元素照常在读，人却在屏幕上找不到任何画面——`sidecar_state` 只给一行 `viewers 0`，读起来像 bug，不像「刷新一下就对了」。这一轮就是从这个坑里出来的：本会话正是这样，浏览器开着、能读能点，右栏一片空。现在 `sidecar_open` 与 `sidecar_state` 在没人画的时候直接写清：`Nothing is drawing the mirror in the column yet — this page was loaded before the mirror was, so refresh it once. The window on screen is the same browser.` 一句话说清「画面在哪、为什么没有、怎么出」。
- **这句话不花钱也不拖延。** 只有这一桌真要了右栏（`want` 被调用）才去等画面接上，最多等 1.2 s，通常经在页面加载里就接上了、0 ms；没人要右栏时一次都不等——探针里 `sidecar_open` 从 3.2 s 回到 1.3 s（example.com，冷启动含在内，差的正是这 1.2 s 的空等）。
- 测试：43 条单测（新增一条：没人画的时候给那句话且句子里必须带 `refresh`，有人画的时候一个字都不多）；广度 43 条全真（新增 `mirror-honest`，在这个没有画手的进程里必须说出「刷新一次」）。真机探针 `/tmp/probe-unseen.mjs` 用工具层直接跑：`sidecar_open` 首行与 `sidecar_state` 末行都是这句话原文。

## 0.17.1

- **人把手放到镜像上时，模型不会再在他手指底下点。** 右栏的镜像是给人看的，也是可以给人用的：登录要人自己扫、验证码要人自己填、有些字段只有人知道填什么。以前这中间有个空档——人正在输入框里打字，模型的下一次点击落下去，轻则焦点跳走，重则按到旁边的按钮上，人只看到字打进了别处。现在镜像里的真实输入（点击、输入、滚轮、按键）会把页面交给人在手上，之后的动作在 6 秒内回一句 `the person is using the mirror (N s more) — nothing was sent.`，并且明说两条出路：等人弄完再重复这次调用，或者 `sidecar_resume` 立刻收回。没派发的动作不算一次点击，所以不会在页面上留下半个操作。
- **只是把鼠标挪过去不算接手。** 悬停和移动是纯粹的指针探测（看这个位置该显示什么光标），每次划过都会发，如果那也算「人在用」，模型会永远动不了。所以只认真正的输入：点击、文字、滚轮、按键。等待也只有 6 秒——一次误触付出的是一两秒，不是一整轮。
- **人动手的时候，读页仍然放行。** 知道屏幕上现在是什么，恰恰是判断「该不该等」的前提；而且读不改变页面。`sidecar_view` / `sidecar_extract` / `sidecar_eval` / `sidecar_shot` / `sidecar_wait` 不受影响，`sidecar_click` / `sidecar_type` / `sidecar_key` / `sidecar_scroll` / `sidecar_hover` / `sidecar_select` / `sidecar_upload` / `sidecar_do` 受管。
- **`sidecar_state` 说出人手在不在。** 多一行 `person free` / `person using it (N s left)`，配合已有的 `viewers` 和 `owner`：屏幕上有人、人在动手、模型在等，三件事都能从一行状态里看出来。
- 测试：42 条单测不变；广度 42 条全真（新增 `hold-allows-read`、`hold-refuses-action`、`resume-lets-go`）。等待是进程内的一次判断，不加浏览器往返：拒绝路径 0 ms，放行路径与原来相同。

## 0.17.0

- **「换个窗口的浏览器」以前是句空话。** 有些网站只在有窗口的浏览器里才肯把页面交出来（本机实测 chatgpt.com：无窗口时一直停在「请稍候…」的验证页，同样地址换成有窗口的浏览器，1 秒内就是登录页）。`sidecar_open` 的 `headless: false` 一直是「下次启动生效」——浏览器已经开着的话，改的只是一个没人再读的字段，调用照旧成功返回，页面照旧过不去。要让它生效只能自己去 `pkill` 进程，这不是模型该干的事。现在请求换个形态时，驱动会自己收掉旧进程、用同一个 profile、同一份登录、同一个地址重开：无窗口 → 有窗口 21.6 s、有窗口 → 无窗口 22.1 s（干净的冷启动时间，`docs/BENCH.md` Phase 7），而同形态的重复调用仍然 0 ms，一次都不重启。窗口形态也写进回话：`sidecar_open` 在有窗口时第一行就说 `The browser is showing a window this time ... Same profile, same logins.`，`sidecar_state` 多一行 `showing a window` / `no window`——屏幕上多出一个窗口是人的事，不该由人去猜它是谁。
- **卡在验证页时，工具说出路，而不是让人再读一遍。** 这类页面（`Just a moment...` / `请稍候…` / `Checking your browser` / 地址里带 `__cf_chl`）不是错误页，也不会自己好，再读一次、再点一次都一样。现在所有读和动页面的工具在读到它时都附一句：这是网站在确认浏览器后面是不是人，无窗口的浏览器过不去，`sidecar_open` 带 `headless false` 会用同一个 profile、同一份登录开一个窗口。省掉的是「读到验证页 → 不知道怎么办 → 换个地址或放弃」这种整轮空转。
- **顺手修掉一个只在接管已开浏览器时出现的崩溃。** 驱动里「人在镜像上动过手」这条记录只由 `humanUse()` 建立，从构造函数里缺着；正常新开的浏览器一路上都会先建立它，所以从没炸过。但插件重载时会接管已经在跑的那个浏览器（为了不把人登出），这条路不建立记录，于是之后任何一次要判断「人是不是刚在动」的调用都抛 `Cannot read properties of undefined (reading 'at')`——整个工具面在这一刻全废。现在构造时就有一份空记录，读的时候也不假设它存在。广度脚本是先在验证页那一步撞上的（那是第一条在人动手之前就走读工具的检查），所以顺手让 `crashed` 那行带上错误栈的头两帧：一条红行要能指向文件行号，否则只能靠猜。
- 测试：42 条单测（新增两条：换形态必重启一次且回到同一地址、没人碰过的浏览器一上来就「可以动手」且记录丢了也不抛）；广度 41 条全真（新增 `check-page-named`：验证页必须说出路、普通页面必须闭嘴）。真机验证走的是工具层而不是单测桩：`sidecar_open({headless:false})` 之后 `ps` 里的进程参数确实不再带 `--headless=new`，`sidecar_state` 跟着从 `no window` 变成 `showing a window`，切回无窗口时再变回来（两次各约 22 s，同一形态的第三次调用 0 ms）。

## 0.16.1

- **0.16.0 的找回现在会被数出来。** 页面重画之后按「它是什么」把控件找回来这件事一直在悄悄发生，谁也说不清真实网站上到底多久一次——所以判断值不值得继续投，只能靠猜。`sidecar_state` 多一行 `refs followed N`，累计本进程里成功找回的次数（只数真的换了新编号又接着做的，找不到、或文字不唯一而回绝的不算）。广度里新增 `follow-counted`：重画检查跑过之后，状态行必须 ≥ 1，数字和那行原文一起打印出来，避免「加了计数器但从来没人读」。
- 广度 38 条全真（原 37），单测 39 条不变。
## 0.16.0

- **页面自己重画之后，旧编号不再是死路。** 框架（React / Vue / Svelte，或干脆 `innerHTML`）重画一块列表、一张表格时会丢掉所有元素再新建一批，于是上一次读到的编号指向已经不存在的节点——而那个控件还在屏幕上、还是那几句话，通常还在原来的位置。以前这一下要花两个回合：调用回 `That control is gone`，模型再读一次页面拿新编号，再用它。现在这一步在调用内部做完：按「它是什么」而不是「它排第几」把控件找回来。
- **什么算同一个控件。** 同样的文字、同样的类型。按钮不会变成输入框；输入框也不会顶替它旁边的按钮；链接还要求去向一样，因为同样文字的另一个链接是另一件该不该点的事。文字必须在页面上**只出现一次**——两行里各有一个 `Delete` 是只有人能做的选择，那种情况照样要读一次，不猜。
- **跟随的时候会说出来。** 回话里多一句 `(the page redrew, so "Learn more" has a new number — used where it is now)`，模型因此知道自己手里的旧编号不该继续用。真正消失的控件仍回 `Call sidecar_view and use the new number`。
- **代价是 17 ms。** 重画过的控件一次点击 462 ms 中位、483 ms 最大（8 次），没重画的 445 ms 中位（8 次）——探针在编号仍有效时什么都不做。换掉的是模型的两三次调用加一次重读的 token（`docs/BENCH.md` Phase 6）。找回成功率 8/8。
- **这条在真网上也成立。** example.com 上的链接被换成同样的克隆节点后，一次点击 4.4 s 落到 `https://www.iana.org/help/example-domains`；Bing 结果页上重画一个结果链接，546 ms 内接着点下去。新增 live 检查 `live-redraw-survives`，live 从 8 条变 9 条，9/9 全绿。
- **动手的一共八个工具加批量步骤。** `click` / `type` / `hover` / `select` / `shot`（裁剪）/ `drag` / `check` 和 `sidecar_do` 的每一步都走同一条找回逻辑（`findAgain` / `followRef`），批量的每一行仍是一行。
- 测试：39 条单测（新增两条身份判定：重画后按文字与类型认回来、输入框不顶替按钮且链接要去向一致）；广度 37 条全真（新增 `ref-follows-redraw`、`ref-refuses-really-gone`）。广度里的 `/redraw` 页面用 `createElement` 重画而不是拼接字符串——fixture 里嵌套引号会让 `onclick` 变成语法错误，页面只剩一个空 `div`，检查那时挂得莫名其妙。

## 0.15.0

- **网站连不上时，工具不再把 Chrome 自己的报错页当成网站念回来。** Chrome 打不开地址时会把标签留在 `chrome-error://chromewebdata/`，而那个页面的 `readyState` 就是 `complete`——所以「等页面加载完」这类判断完全看不出区别。`unreachable()` 早就存在，但只有 `sidecar_open` 和 `sidecar_nav` 调它，于是 `sidecar_view` / `sidecar_click` / `sidecar_type` / `sidecar_do` 会把「无法访问此网站 · ERR_CONNECTION_CLOSED · 重新加载 · 详情」当成页面正文和一个有 3 个控件的页面交给模型：模型于是去点「重新加载」，把一次网络故障变成一串假进度。现在所有读和动作的工具都先看一眼地址，是浏览器自己的错误页就直接回绝，并把 `ERR_` 代号念出来（域名写错和代理挂了要分得清），再给出路：`the network could not reach that address — the browser stopped on its own error page (ERR_NAME_NOT_RESOLVED), which is not the site. Nothing on it is page content. Use sidecar_nav with another address, or fix the connection this machine needs.` 批量调用里某一步跳到错误页就停在那一步并说明，不再往「This site can't be reached」里输入文字。
- **报浏览器本身的那几个工具仍然可用。** 页签列表、控制台、失败请求、地址、cookie、剪贴板、下载、弹窗都走 `withRawPage`，因为人在卡住的时候正是靠它们判断发生了什么；只有读内容和动页面被拦。`sidecar_nav` 也照旧能在错误页上工作——否则就没法从错误页走开。
- **这条在真网上验过，不是只在单测里成立。** 新增两条 live 检查：打开 `https://never-resolves-this.invalid/`，读到 `ERR_` 且不是网站正文；同一页上读、点、批量三种调用全部回绝；然后导航回 example.com 必须真的回到真实页面（1319 ms / 1328 ms）。live 从 6 条变 8 条，8/8 全绿。
- **顺手修掉一条一直在说谎的 live 检查。** `live-search` 一直用维基的搜索框，而这台机器上维基首页能开、搜索跳转却超时（`curl` 3 次里 1.3–2.1 s 返回 302，浏览器里却 24 s 停在错误页），连着三次跑挂在同一个地方，说的却不是插件的事。改用 Bing，并且按输入框自己的文字（`field: '搜索词'`）而不是控件编号去驱动——同一个搜索框，在一个引擎上是 `combobox`、在另一个上是 `input`，写死编号的检查本来就很脆。1.3 s 到结果页。
- 测试：37 条单测（新增两条：错误页被认出来、真实页面一次比较就说空话；错误代号是从页面上问出来的，不是拿标题顶替）；广度 35 条全真。
- **装出来的包一直是残的——现在修好了。** `package.json` 的 `files` 只列了 `index.js`、`sidecar.js`、`client.js`，漏掉 `tools.js` 与 `read.js`；`index.js` 第 123 行却 `import { sidecarTools } from './tools.js'`。0.13.4、0.14.0 的 tarball 里都没有这两个文件：`tar tzf … | grep tools.js` 是空的，把包装进干净目录后 `import` 直接 `Cannot find module`。开发环境一直正常，因为 profile 里的插件目录是指向仓库的符号链接，`files` 根本没参与解析——这条只在真装包的时候炸，而真正装包的人正是用户。现在两个文件都进了 `files`（tarball 从 17 个文件变 19 个），并加了两条守护测试：一条走真实的 import 图，逐个断言「被 import 的本地文件必须在 `files` 里」；另一条把磁盘上那个 tarball 真正解开、在包外 `import` 主半边的四个模块。把 `files` 里的两行删掉再跑，测试立刻红在 `tools.js is imported but not listed in package.json files`。
- **一次批量调用里，遮罩也只挡一次。** 0.14.0 的「挡住就先关掉再点」只长在 `sidecar_click` 和 `sidecar_type` 上，`sidecar_do` 的每一步仍旧直接按坐标点——于是「点开搜索、输入、回车」这种批量流程，第一步就被 cookie 横幅吃掉，整串静默失败，还得模型自己回头发现。现在 `runStep` 里凡是按 `ref`、按文字、按字段名定位的步骤，都先过同一个探针：挡路的是带安全出口的横幅就点掉、确认没了、再执行这一步；每一步的编号行里只多一小句 `after Accept on a banner, `，五步流程也只付一次这个代价（第一步清掉的横幅对后面几步已经不在了）。
- **批量步骤的措辞保持一行。** 单步结果本来就是「编号 + 一句话」，遮罩说明写成前置从句而不是另起一行，`1. after Accept on a banner, clicked "Under the banner"`，读起来还是一步一行，token 只多十来个字符。挡路的遮罩没有安全出口时（要删除、要支付）照样只报告，批量不会替人按下去——`guarded-overlay` 那条广度检查盯的正是这个边界。
- 探针的代价还是可忽略：有东西挡路时一步 633 ms，没东西时 458 ms（各 3 次中位，`docs/BENCH.md` 的 Phase 5 新增两行），也就是「关掉横幅」这一步约 175 ms，换掉的是模型本来要花的一整个回合（读一次、点一次、再读一次）。
- 真实网站回归照旧全绿：`npm run live` 6/6，打开 example.com 672 ms、按文字点到维基英文版 3.1 s、维基搜索 3.8 s（都在网站自己的加载时间里）。
- 测试：35 条单测（新增一条 `coverLead`：在横幅上返回 `after Accept on a banner, `、在干净页面上返回空串且一次鼠标都不发、出口是「Pay now」时也不代按；新增两条打包检查，见上）；广度脚本 35 条全真，新增 `do-through-overlay`（批量步骤点穿横幅，标题变 `under clicked`）与 `do-field-overlay`（批量步骤在横幅下把 `#note` 填成 `kept`）。

## 0.14.0

- **横幅挡着就自己关掉，再点你要点的那个。** 0.13.3 只把「an overlay covers it: We use cookies to remember you. Accept」说出来，等模型自己再发一次点击去关横幅——多一次读、多一个回合。现在同一个页面内的探针顺手找横幅自己的出口：弹层本身或它的容器够大（宽 ≥ 视口 60%、高 ≥ 50%），里面的按钮文字落在「接受 / 同意 / 允许 / 关闭 / 确定 / 知道了 / accept / agree / allow / close / dismiss / got it / i agree」这一小撮里，就点它、再确认挡着的东西没了、然后按原坐标点你要的控件，结果里两行都写清楚：`an overlay covers it: We use cookies… — the click landed beneath it` / `clicked Accept on it first, then the control`。`sidecar_click` 与 `sidecar_type`（给 `ref` 点聚焦那一步）都走这条路，一次调用把事办完。
- **只关「无害的那一类」，剩下的照样如实报告。** 出口文字是闭集，而且弹层正文里出现 delete / remove / purchase / pay / buy / sign out / 删除 / 支付 / 购买 / 注销 / 退出登录 / 转账 就完全不碰——「Delete this account? Delete forever」这种遮罩仍然只报不说，绝不在人的名义下按下去。广度脚本里 `guarded-overlay` 就是盯这条：必须报出遮罩、必须没点、标题必须没变。
- 探针仍然只在给 `ref` 时跑，仍是同一次 `Runtime.evaluate`，正常点击的延迟没有变化；出口按钮必须完整落在视口内、面积至少 2×2，找不到就退回原来的「只报告」。压测把这条也量了（`docs/BENCH.md` 的 Phase 5）：探针本身中位 1 ms，没东西挡路时点一下 460 ms，被横幅挡住时 630 ms（点掉横幅、等 150 ms、再确认、再点），「删除账号」那种遮罩 456 ms 且什么都不按。
- 测试：32 条单测（新增一条：出口词是闭集、带 delete/pay 风险词时不关）；广度脚本 33 条全真，`covered-click` 现在要求点击真的穿透（`under clicked`）且结果里两条都出现，新增 `type-through-overlay`（横幅下的输入框输入成功、值为 `held`）与 `guarded-overlay`。`npm run live` 仍 6/6，且数字比 0.13.4 那次更好：打开 example.com 517 ms（原 752）、按文字点到维基英文版 3.6 s（原 11.8 s）、维基搜索 5.2 s（原 5.3 s）。

## 0.13.4

- **工具在真实网站上跑通了，不只是本地夹具。** 新增 `scripts/live.mjs`（`npm run live`）：不开本地服务器，直接走公网——打开 example.com（752 ms）、读它、在 wikipedia.org 上按文字点语言链接落到 en.wikipedia.org（11.8 s，含页面自己加载的时间）、返回后 URL 回到 wikipedia.org、一次调用从「Web scraping」条目里读出十条列表（2 ms、1813 字符）、在维基搜索框里输入并回车（5.3 s 到结果页）。6 条全真。数字主要被网站和网络占掉，正因为如此才和 [BENCH.md](docs/BENCH.md) 里的本地延迟放在一起看。
- 这一步也顺手证明了按文字点击在真实页面上成立：维基首页的语言链接渲染出来是「English — Wikipedia — The Free」，带上后面的说明文字也能点到；本地点选夹具里没有这种拼在一起的控件名。
- 站点连不上会如实写成「某站在 30 秒内没有回应」，不算插件失败；今天这台机器上 Hacker News 就属于这一类，于是列表检查改用维基条目。

## 0.13.3

- **点了没反应，现在会说是谁挡着。** 真实网站上最常见的失败不是点不到，而是点到了：cookie 横幅、遮罩弹层盖在按钮上，坐标对了、点击也真的发出去了，页面却毫无变化。`sidecar_click` 和 `sidecar_type` 在按下去之前先问页面「这个点上最上面的是谁」，如果那不是目标控件也不在它里面，工具结果末尾会多一行「an overlay covers it: We use cookies to remember you. Accept — the click landed beneath it」。模型于是知道该先关横幅，而不是把同一次点击重试到超时。
- 这一问只在给 `ref` 时发生（点坐标没有「本来想点谁」），iframe 里的控件跳过——跨进程序列化不了覆盖元素；零额外往返的两条页面内检查，正常点击的延迟没有变化。
- 测试：31 条单测（新增一条：覆盖检查确实问 `elementFromPoint`）；广度脚本 31 条全真，新增 `covered-click`：整屏遮罩下的按钮点下去仍返回被谁盖住，并带上遮罩上的文字。

## 0.13.2

- **镜像是人的，也是模型的。** 人在右栏里自己点、滚、输入之后，下一次工具结果会多一行「the person also used the page: click at 412,181, 4 s ago」，说清是哪种动作、落在哪、多久以前；同一次接手只说一遍，看过就不再重复。模型因此知道页面被人挪过，不会拿旧位置的下一次点击。悬停和移动不算接手——那是看，不是改。
- **列表读成行，不用整页读。** 新增 `sidecar_extract`：给一个 CSS 选择器，列表项一行一条返回，带链接（同站的只给路径，省掉重复的域名），默认最多 40 行、可到 200；`ref` 可以把范围限定在某个控件里。整页读在预算内会被截断，列表再长也读不全；这个工具把 30 行一次读完：1106 字符，同一页整页读 1291 字符，500 字符预算下整页读拿到第 12 行就断，列表还能到第 30 行。
- 测试：30 条单测（新增三条：接手只报一次、悬停不算接手、没有选择器时说清要什么）；广度脚本 30 条全真，新增 `person-note`、`extract-rows`。

## 0.13.1

- **清空字段在 macOS 上真的清空。** `sidecar_type { clear: true }` 先按全选再退格，之前按的是 Control+A：在 macOS 上那是「移到行首」，于是新文字接在旧文字后面（`a@b.c` 变 `a@ba@b.c`），表单还会因为邮箱不合法而提交不动。现在按这台机器的全选键（macOS 用 Command，其余用 Control），快捷键被页面吞掉时在页面里选中剩余文字，下一次输入直接替换。
- **`sidecar_do` 的每一步也能清空。** `{ field: "Email", text: "a@b.c", clear: true }`，同样走上面的清空路径，一次调用改完已有内容的字段。
- 测试：27 条单测（新增两条：全选键按平台、快捷键被吞时页面内选中）；广度脚本 27 条全真，其中 Backspace 与表单提交两条之前是红的。

## 0.13.0

- **多标签页。** `sidecar_tabs` 列出现有页面、把镜像切到其中一个、关掉其中一个；关掉正在显示的那个时自动回到相邻页。镜像仍在同一会话，页面切走不丢状态。

- **iframe 里的控件现在能读、能点、能输入。** 一次读会按主框架优先走一遍框架树，同进程 iframe 里的输入框、按钮和页面自己的控件一起编号；编号带框架槽位（`900000 + slot * 100000 + 局部号`），点击时先在那个框架里解析，再加框架在页面里的位置，输入仍按视口坐标发。Chrome 单独进程跑的跨域 iframe 没有上下文可读，但位置可算、仍可点。
- **镜面延迟有数。** 页面改动到帧可画，中位 9 ms，最慢 17 ms（12 次采样），压测脚本会跟着一起跑。
- **只读变化比整页便宜。** 动完一处再问 `changed_only`，dense 页从 444 token 降到 17：变了什么、变成了什么，都在那几行里。
- **能看到网络。** 页面请求什么、回了什么状态，`sidecar_network` 倒序列出方法、状态、类型和地址，读的是浏览器已经收到的那份，不动页面，所以弹窗开着也能问。
- **下载会落到磁盘。** 页面一开始就把 Chrome 的下载目录指到 `<profile>/downloads`，点一下保存的文件写在那儿；`sidecar_downloads` 按时间倒序列出文件名、字节数、到达时间，还在下的 `.crdownload` 不列。
- **跨站 iframe（Chrome 单独进程跑的那种）现在也能读能点。** 这种框架不在页面的框架树里，而是自己的 target：插件记住 Chrome 给的 session，读就发到那个进程，编号仍按框架槽位排；角落位置问页面（`DOM.getFrameOwner` + 取 owner 的矩形），因为框架自己的进程看不见自己贴在哪。
- **点开的新页签会被跟过去。** 页面拿不到自己弹窗的句柄，所以动作之后问一次 DevTools 地址表：出现别的 page 目标，就把镜像导航到它的地址，再用 target 的 HTTP 接口关掉弹窗。看镜像的人会看到点击去了哪里，始终只有一个页面要驱动。
- **读的结果封顶在调用方要的行数。** 之前上限算的是候选控件数，于是 dense 页面一次读回 142 个控件；现在先按视口排序再截到 `max`，同一页 90 行，`full` 一次读从 917 降到 626 token。
- 测试：25 条单测通过；广度脚本 25 条全真（shadow 读/点、表单四个动作、`confirm()` 捕获与接受、同进程 iframe 读/输入/点击、跨站 iframe 读/点击、弹窗跟随、下载落盘、网络响应、文件上传、打印 PDF、只读变化、`for`/`aria-labelledby` 命名、按文字点击、按字段名一次填完登录、失效 ref 拒绝、渲染进程崩了自动接回同页）。

- **崩了也能接回来（1.4 秒）。** 渲染进程死掉时，下一次调用会在同一地址起一个新浏览器，而不是从此报错；宽度脚本里把页面真崩一次，测回来还是那一页。

**不用先读也能点。** `sidecar_click { text: "Sign in" }` 自己找到那行字再点，省掉一次 view；行文仍是「点了什么、到哪一页」。

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
