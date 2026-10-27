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

- `sidecar_do`: ordered steps with per-step waits (`wait_text`, `wait_gone`,
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
  accept/dismiss; `sidecar_eval` for the last 1% of cases; cookies read/write for
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
  reads stay open; `sidecar_resume` takes the page back at once.
- Guarded actions (upload, download, close tab, buy-ish submits) can require a
  confirm flag. Shipped in 0.14.0 for the narrow case that matters most: an
  overlay in the way is cleared only when its own way out is a safe word
  (accept / agree / close / 同意 / 关闭 …) and the overlay says nothing about
  deleting, paying or signing out; otherwise it is reported, never taken.
  Since 0.15.0 the same clearing runs before every control-naming step of a
  `sidecar_do` batch, so a multi-step flow through a cookie wall fails zero times.
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

Since 0.16.1 the count is visible: `sidecar_state` reports `refs followed N`,
and breadth asserts it moved after a redraw, so the next rounds can tell from
real sites whether redrawing is frequent enough to justify more work here.
Next in this direction: the same identity recovery for `sidecar_do` steps that
name a field by its label when the label element is rebuilt (today the step
falls back to a fresh read).

## Order of work

1. Phase 0 baseline. 2. Phase 1 + 2 together (they share the read model).
3. Phase 3 breadth. 4. Phase 4 numbers. 5. Phase 5 hardening. 6. Phase 6 proof,
then repeat the loop with whatever the numbers say is worst.

## Phase 8 — the shape of the browser, 0.17.0

Two things were wrong at the edge of the tool surface, and both were only
reachable on real sites.

The first was that the shape of the browser could not change. `sidecar_open`
accepted `headless: false` and answered success; when a browser was already
running nothing happened, because the flag was only read at launch. A site that
refuses a windowless browser (chatgpt.com on this machine: a "just a moment"
page forever, versus a login page in a windowed one) therefore had no way out
except killing a process by hand. Since 0.17.0 a request for the other shape
restarts the browser on the same profile, cookie jar and address — 21.6 s
windowless → windowed, 22.1 s back, 0 ms when the shape already matches — and
both `sidecar_open` and `sidecar_state` say which shape is in front of the
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

Next in this direction: the same resolution for `sidecar_type` when the caller
names a field by its words instead of a ref, and for date/time pickers where the
visible box is a div and the real input is hidden beside it.
