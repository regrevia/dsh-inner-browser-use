<!-- ui-copy-ignore -->
# Roadmap: from a working mirror to the best computer-use plugin

The bar is not "another browser driver". The bar is: an agent can finish a real
task in this browser with fewer turns, fewer tokens, fewer surprises than with
Codex, Claude Code, browser-use, Stagehand, Playwright MCP or any screenshot-only
computer-use model — and the person can watch it happen in the sidebar of the
chat that asked, while every other chat stays untouched.

Written as phases with a number attached, because a phase without a number is a
wish. Baselines come from `node scripts/bench.mjs`; every phase must move one.

## Where the competition actually wins

| Project | What it does well | What it costs |
| --- | --- | --- |
| Codex / Claude Code (computer + bash) | free-form shell, one action per turn, human can take over mid-run | no page structure, no refs, screenshots dominate context |
| browser-use | indexed DOM tree with stable element ids, action model, per-step memory | tree is big; a full read is thousands of tokens |
| Stagehand | `act` / `observe` / `extract` split, self-healing selectors, natural-language actions | server round trips; two model calls per step |
| Playwright MCP | accessibility tree with `ref` handles, deterministic waits | text-only; a page read is large; no live picture |
| Skyvern / CUA screenshot models | works on canvas apps and hostile DOM | ~1 image per step, slow and token-expensive |

Our position: **a real Chrome with a live, interactive mirror in the owning
chat, and a read model that is small by construction** — accessibility refs that
survive a read, viewport-only text, diffs instead of full re-reads, and one
batched tool for multi-step work. The mirror is not decoration: it is the human
takeover surface, and no other plugin can show it inside the asking chat without
stealing the column from other chats.

## Phase 0 — measurement (done when numbers exist)

- `scripts/bench.mjs`: launch→first frame, steady fps, frame KB, read ms /
  chars / approx tokens for a dense page, a text page and a light page, click,
  key, screenshot KB.
- Record every run in `docs/BENCH.md` with the commit; no phase is "done"
  without a before/after row.

## Phase 1 — read model that costs less (target: dense page read ≤ 1.2k tokens)

- Accessibility-tree walk with `ref` handles that stay valid across reads of the
  same page; only elements that exist in the tree get a number.
- Viewport-limited by default (`inView`), with `mode`: `text` (default),
  `links`, `forms`, `full`; `max_chars` budget; text deduplicated and
  truncation marked, never silent.
- `changed_only`: after an action, return only added / removed / changed refs —
  the browser-use and Playwright MCP gap.
- Stable refs: a read re-numbers nothing that did not change, so the model can
  act on numbers from an earlier read and gets a clear "ref 3 is gone, re-read"
  instead of clicking the wrong thing.

## Phase 2 — one call, many steps (target: a login flow in 1 tool call)

- `browser_do`: ordered steps with per-step waits (`wait_text`, `wait_gone`,
  `wait_idle`, `wait_url`), one result: what changed, the final URL, tokens spent
  on one read instead of five.
- Auto-wait after every action: navigation start/finish, DOM quiet, and
  `document.readyState`, so the next step never races the page.
- Ref errors are actionable: which ref, why it is gone, and one call that
  re-reads and retries once.

## Phase 3 — any operation (target: no "can't do that" left)

- Hover, drag, double-click, right-click, wheel with modifiers.
- `select` option by label or value; checkboxes and radios by label.
- File upload (`DOM.setFileInputFiles`), download capture with a returned path,
  print-to-PDF, full-page and element screenshots.
- Tabs: new / switch / close / list; iframes addressed by frame id; dialog
  accept/dismiss; `browser_eval` for the last 1% of cases; cookies read/write for
  debugging; console + failed requests surfaced in the state read.
- Keyboard: modifiers, shortcuts, clipboard paste, IME composition unchanged.

## Phase 4 — mirror latency and clarity (target: ≤120 ms input→painted, 60 fps idle)

- Adaptive JPEG quality and frame size: drop quality before dropping fps; send a
  small first frame, refine when idle.
- `Page.startScreencast` tuning (maxWidth/quality/everyNthFrame), Chrome flags
  that stop background throttling, `--disable-frame-rate-limit`.
- Client: decode off the main thread (`createImageBitmap`), draw only the newest
  frame, no layout thrash, ResizeObserver-driven backing-store sizing for a crisp
  picture at any pane width, DPR-aware.
- Pointer: keep the 1 ms path; add remote cursor shape to the pane cursor with a
  proper fallback, and a visible "the agent is acting" pulse that never moves the
  system cursor.

## Phase 5 — reliability and safety

- Human takeover (0.17.1): real input in the pane (click / text / wheel / key)
  holds the agent's next action for 6 s and says so; hover and move do not count;
  reads stay open; `browser_resume` takes the page back at once.
- Guarded actions (upload, download, close tab, buy-ish submits) can require a
  confirm flag. Shipped in 0.14.0 for the narrow case that matters most: an
  overlay in the way is cleared only when its own way out is a safe word
  (accept / agree / close / 同意 / 关闭 …) and the overlay says nothing about
  deleting, paying or signing out; otherwise it is reported, never taken.
  Since 0.15.0 the same clearing runs before every control-naming step of a
  `browser_do` batch, so a multi-step flow through a cookie wall fails zero times.
- Crash recovery: attach to a still-running Chrome, rebuild the page, keep the
  profile; a killed host never leaves a zombie Chrome.
- Every failure names what happened, what state the page is in, and the next
  call to make.
- A failure that is the browser's, not the page's, is said in those words: on
  Chrome's own error page a read, a click and a batch step all refuse with the
  `ERR_…` code and the way out, while the tab list, console, failed requests and
  address still answer, because those are how a stuck person finds out what
  happened.

## Phase 6 — proof and packaging

- `docs/BENCH.md` with before/after per phase; a competitor comparison table with
  measured numbers, not adjectives.
- `docs/VERIFY.md` walk-through that a stranger can run; `scripts/doctor.mjs`
  green; 3 linters zero errors; tests covering every new tool.
- Packed tarball, CHANGELOG per release, `0.x` bumps that match behaviour.
  0.13.4 and 0.14.0 shipped tarballs without `tools.js` and `read.js` — a clone
  hid it because the dev profile symlinks the repo. Since 0.15.0 a test walks the
  import graph against `files`, and another unpacks the tarball and imports it.

## Phase 7 — recovery inside the call, 0.16.0

The measured weak spot after Phase 5 was not speed but turns spent recovering:
every framework redraw invalidated the numbers from the last read, and the model
paid a full read plus a turn to get them back. 0.16.0 moves that into the call by
finding the control again by identity (kind + exact words + link destination),
refusing when the words are not unique. Measured at 462 ms against 445 ms for a
fresh control — 17 ms when needed, nothing when not.

Since 0.16.1 the count is visible: `browser_state` reports `refs followed N`,
and breadth asserts it moved after a redraw, so the next rounds can tell from
real sites whether redrawing is frequent enough to justify more work here.
Next in this direction: the same identity recovery for `browser_do` steps that
name a field by its label when the label element is rebuilt (today the step
falls back to a fresh read).

## Order of work

1. Phase 0 baseline. 2. Phase 1 + 2 together (they share the read model).
3. Phase 3 breadth. 4. Phase 4 numbers. 5. Phase 5 hardening. 6. Phase 6 proof,
then repeat the loop with whatever the numbers say is worst.

## Phase 8 — the shape of the browser, 0.17.0

Two things were wrong at the edge of the tool surface, and both were only
reachable on real sites.

The first was that the shape of the browser could not change. `browser_open`
accepted `headless: false` and answered success; when a browser was already
running nothing happened, because the flag was only read at launch. A site that
refuses a windowless browser (chatgpt.com on this machine: a "just a moment"
page forever, versus a login page in a windowed one) therefore had no way out
except killing a process by hand. Since 0.17.0 a request for the other shape
restarts the browser on the same profile, cookie jar and address — 21.6 s
windowless → windowed, 22.1 s back, 0 ms when the shape already matches — and
both `browser_open` and `browser_state` say which shape is in front of the
person.

The second was silence on a check page. A site asking for proof of a person is
not broken and not an error page, so every read returned it as content. Now
every read of it carries the way past: `headless false` on the same profile.

Next in this direction: a site that only accepts a window is still discovered by
the model, not by the plugin. The plugin could try the page in a window by itself
when the read shows a challenge, but that puts a window on the person's screen
without being asked — the current rule is that a person's screen is theirs.

## Phase 9 — the mirror has to exist before it can be seen, 0.18.0

Everything the plugin does is worth nothing if the person cannot see it, and the
failure is silent: the browser runs, reads work, and the column is empty because
the tab that draws it was never loaded. 0.18.0 makes that state say itself out
loud, with the one action that fixes it, and only pays the wait when a column was
actually requested.

Next in this direction: the drawing half could re-attach by itself. A tab that
reloads re-subscribes on its own, but a tab that never loaded the half cannot be
told to — that is a load-order problem, so the fix belongs in how the panel half
is delivered, not in the wait.

## Phase 10 — words are not where the field is, 0.19.0

The tool used to treat "the control that says Email" as "the field called
Email". Real forms separate the two, so the writing step now resolves the words
to the element that takes text, and says which one it used.

Next in this direction: the same resolution for `browser_type` when the caller
names a field by its words instead of a ref, and for date/time pickers where the
visible box is a div and the real input is hidden beside it.

## Phase 11 — say where, not which number, 0.20.0

Typing by name is in. The same resolution is what other steps should be able to
use when the caller knows the destination but not the number — the next place
worth doing this is `browser_select` (choose an option by the field it belongs
to), and after that the date/time case where the visible box is a div and the
real input sits hidden beside it.

## Phase 12 — the same words, the same place, 0.21.0

`browser_select` joined `browser_type` and `browser_do` on the shared resolver.
Left in this direction: the date/time case where the box the user sees is a div
and the real input is hidden beside it, and `browser_click` on a control whose
words are split across sibling nodes (`<span>Sign</span><span>in</span>`).

## Phase 13 — the page's spelling is not the caller's, 0.22.0

Whitespace is normalised in both halves now (tool side and in-page side). Next
in this line: the date/time box where the visible box is a div and the real
input is hidden beside it, which needs the resolver to accept a hidden target
and click the thing in front of it.

## Phase 14 — behind the box, 0.23.0

Both halves now resolve a name to a place: visible field, hidden field behind a
visible box, words split over nodes, words outside the wrapper. Next: a page
whose visible box is a `<canvas>` or an `<iframe>` — nothing in the tree to
name, so the fallback has to be a picture plus a click, not a name lookup.

## Phase 16 — a file, not a path, 0.25.0

`browser_grab` returns a path. Next: say one line about the picture (size, and
whether it is mostly one colour) so a model that cannot open files still learns
"the chart is blank" without a full read.

## Phase 17 — a picture nobody can see, 0.26.0

The description is coarse on purpose. Next: when a page's answer is a picture,
let a read say so in one line ("the answer is a picture, and it is blank") so a
model that cannot open files does not need the tool at all to notice a failure.

## Phase 18 — a picture that never arrived, 0.27.0

A picture is only an answer if it loaded. Next: report a large picture element
whose source failed (`naturalWidth === 0`) as a broken picture rather than
staying silent, since that is the commonest way a generated image "disappears".

## Phase 19 — the same picture again, 0.28.0

Reads are stateless: the same page costs the same tokens twice. Next: remember
the last read of a page by address and say only what changed, with a hard reset
when the address or the document changes.

## Phase 20 — two browsers, one conversation, 0.29.0

The column is a real browser, so the model inside it can be a reviewer, not just
a tool: hand it the repository address, ask for a review, read the answer back
through the same mirror, and take the next round from it. Nothing opens on the
desktop while that happens: a site that refuses a headless build gets a window
at -3000,-3000, and the column shows the only picture.

## Phase 21 — a review round that closes the loop, 0.30.0

`browser_ask` sends and returns an answer. Next: a round trip that carries the
repository address there and the review back, and records in the round log which
commit the review was about, so a later round can tell whether the advice was
already taken.

## Phase 22 — the reviewer sees the code, not a description of it, 0.31.0

The round log now records what was asked and what came back. Next: paste the
diff the review is about into the same message (bounded, so the column does not
fill with code), and let a later round say which points were already acted on,
so the loop stops repeating advice.

## Phase 23 — the drawing half, 0.31.0

A page that never shipped an image still has a canvas or a video frame; take
that surface as the picture when the page has no file to grab.

## Phases 24–39, condensed

The phases above were written one at a time as the work happened; the run from
0.32 to 0.34.18 is dense enough that the per-phase prose lives in
`docs/BENCH.md` and the changelog. What each one changed, in one line:

| Version | Phase | What it moved |
| --- | --- | --- |
| 0.32.0 | 22 | the diff a review is about travels with the request |
| 0.33.0 | 22b | the mirror outlives the visit: claim, takeover, remembered address |
| 0.33.2 | 22c | a duplicate registration cannot take the pane down |
| 0.34.0 | 23 | one tab per chat, a UA that does not say "headless", typing that looks like hands |
| 0.34.1 | 24 | a ref is checked against what the control says before it is used |
| 0.34.2 | 25 | one chat cannot take another chat's page; a password never comes back in a result |
| 0.34.3 | 26 | a picture reaches the model as a picture; read state is per chat |
| 0.34.4 | 27 | an empty mirror says what to do; remembering an address is written, not crashed |
| 0.34.5 | 28 | one ownership gate for every acting route |
| 0.34.6 | 29 | one tab per chat even when two calls race |
| 0.34.7 | 30 | a live cookie is never overwritten by a stale copy |
| 0.34.8 | 31 | a cold first tab in 0.6 s instead of 21 s |
| 0.34.9 | 32 | a plugin reload no longer closes the browser |
| 0.34.10 | 33 | a call log never shows another chat's calls |
| 0.34.11 | 34 | the column offers "restore the last page" in one click |
| 0.34.12 | 35 | every write needs the chat that asked for it |
| 0.34.13 | 36 | a review round is verifiable: each point marked fixed / verified / invalid / open |
| 0.34.14 | 36b | a reload must not cost the browser: the watchdog follows the application pid |
| 0.34.15 | 37 | an observation admits its blind spot: pictures, canvases, videos, frames; an error page says so |
| 0.34.16 | 38 | a reload does not blank the mirror: the owning chat's poll adopts the running browser |
| 0.34.17 | 39 | the blind-spot frame count follows the screen, not the DOM |
| 0.34.18 | — | the adoption rule is a named function with a test |

## 页游这一档（2026-10-28 起）

- 操作方式已分叉（0.34.29）：`browser_mode` 每个聊天记一种，`human` / `dom` 单次可覆盖。页游默认 human，登录/表单默认 dom 更省事。
- Flash 判死：headless Chrome 里 Ruffle 交得上 swf 但起不了画面（26 秒，canvas 0、metadata 0），不承诺。真页游只能走站方 H5 / 微端 / 老 360 浏览器，页面上线前先用 `scripts/probe-flash.mjs` 问一句它要不要 Flash。
- 开玩前先体检：`browser_prepare` 一次调用给出输入面、帧率、按键是否真的到得了框架、以及 Flash 结论（0.34.30）。4399《怪物小汽车》实测页面 58 fps、框架 59 fps —— 不少「Flash 小游戏」其实已经是 H5，先体检再下结论；`npm run ready <url>` 可复现。
- 读 SWF 标签流（`npm run swf`）：尺寸、帧率、AVM 版本、资源构成，FWS/CWS 都读，ZWS 明确报不支持（0.34.32）。
- 空白画面的两种原因分开报（`viewers` / `listening chats` / `asks.log`），并在「浏览器在跑、没人画」时自己向所属会话补发一次开页签请求（0.34.31）。

输入这一层已经到位：按住键、组合键、按住鼠标，一项 300 ms 的按住整次调用 305 ms，事件由页面自己证实。实时画面沿用同一条 CDP 帧路（60 fps、镜像延迟中位数 8 ms）。

还差的一层是「看」：4399 / 7k7k / 奥拉星这类页游把画面画在 canvas 上，文本树里没有可读的东西，判断走位、Boss 血条、按钮位置都要靠像素。本会话的模型没有视觉能力，所以这里的正确做法不是假装能玩，而是把可判读的信号做出来：canvas 局部像素采样、颜色/区域变化率、画面是否在动（`blind` 行已经在报 canvas 数量）。有视觉能力的模型接着用同一套帧路就能玩。

## Where the next round should go

Ranked by what a real task still loses:

1. **End-to-end proof of the places unit tests cannot reach.** The restore-in-one-click
   path (0.34.11) and the mirror coming back after a reload (0.34.16) were checked by
   HTTP and by pid, not by a person clicking. A browser-level test that opens the
   column, kills the driver, and clicks restore is the missing evidence.
2. **One-click "open here" when this chat has no seat.** `state.chats` can lack this
   chat, and the column then only tells the model to call `browser_open`. The button
   belongs in the column.
3. **Competitor behaviours still unmatched.** Playwright MCP's accessibility refs are
   ours, and the blind line covers the vision-less read; Stagehand v4's
   act/observe/extract split with cached selectors is only partly ours, and its
   self-healing of a selector between rounds has no equivalent here.
4. **Token numbers for a real session, not a synthetic page.** Reads are measured on
   fixed pages; an actual 20-step task has never had its cumulative token cost
   recorded.
