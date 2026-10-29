# Verify it works

Five minutes, one page, no debugger. Each step names what a failure looks like.

## Before you start

- The plugin is installed and enabled, `0.12.1` or later (`package.json`).
- The GUI page was reloaded after the install: the page half loads on a page load.
- Chrome sits at one of the paths in
  [COMPATIBILITY.md](COMPATIBILITY.md#where-chrome-is-looked-for).
- The app answers at `http://127.0.0.1:60930`.

## 1. The plugin answers

```bash
node scripts/doctor.mjs
```

One line per fact: the address, the browser (`not running` before the first
call), the profile name and directory, whether it exists, the page, viewers,
frames, pointer and the control endpoint. It only reads.

```bash
curl -s http://127.0.0.1:60930/dsh-inner-browser-use/sidecar/state
```

Expected before any tool call: `"alive":false`, `"profile":"default"`,
`"viewers":0`, `"error":""`.

- `not answering under /dsh-inner-browser-use`: the plugin is not loaded, or the
  app moved: set `DSH_BRIDGE` to its address.
- A 404 there: the plugin did not load, or an older build is on disk.

## 2. A tool opens its own page

Ask the model `用 browser_open 打开 https://www.bing.com`, or call it yourself.
Expected: the result names the address and title, and this chat's right column
shows the picture in a tab called **后台浏览器** or **Background browser**.
`doctor.mjs` now reads `attached, headless`, `viewers 1`, frames climbing.

- `"alive":true` with `"viewers":0`: the page half has not mounted the mirror.
  Reload the GUI page; a reload of the plugin alone does not rebuild the tab.
- `"alive":false` with a non-empty `"error"`: Chrome did not start. Check the
  binary at a listed path, and on macOS that the launch carried
  `--use-mock-keychain`.
- Frames flat while viewers is 1: the screencast stalled. `browser_stop`, then
  `browser_open` again.
- `"pointer":null`: no tool input yet; it fills on the first click or move.

## 3. Only the chat that asked

Switch to another chat: no mirror there, and the first chat keeps its own. A
call from the other chat drives the same browser; the tab stays put.

A mirror that opens in every chat means the page half is not comparing
`sidebarRight.mounted` and is running an older bundle: reload the GUI page.

## 4. Drive it by hand

- **Hover** the search field: your cursor turns into an I-beam, the black arrow
  does not move. An arrow that follows the mouse means the pointer paths are
  crossed.
- **Type** Chinese with `browser_type { "text": "…", "submit": true }`: the
  results page appears and the field holds characters, not boxes.
- **Backspace** with `browser_key { "key": "Backspace" }` in a filled field:
  one character goes. Nothing happening means the key reached the document.
- **Screenshot** with `browser_shot {}`: an absolute path under
  `~/.dsh-inner-browser-use/screenshots`. A black picture means the screencast
  was not running when the frame was taken.
- **The whole keyboard, on this machine**: `npm run keys` starts a real
  background Chrome, presses all 150 keys into a field, and checks what the page
  reported for each one (`key`, `code`, `keyCode`, shift) plus what the field
  typed. It then runs copy / cut / paste / select-all / undo / redo, caret keys,
  Tab focus, Enter, and a 180 ms hold. One JSON line, exit code 0 when every key
  matched. CI runs it on macOS and Windows in the `keys` job.
- **A shortcut by hand**: type `Hi`, press `browser_key { "key": "Mod+a" }`,
  type `X`: the field holds `X` and nothing before it. `Mod` is Command on macOS
  and Control elsewhere; `Ctrl+C/X/V/A/Z/Y` and `Ctrl+Shift+Z` run the same
  editing commands a person would.

## 5. Stop, then open again

`browser_stop` reads `"alive":false` and leaves the profile alone.
`browser_open https://www.bing.com` brings the same profile back, still signed
in from the first pass.

Signed out after the restart: Chrome came up on another profile, or was killed
instead of closed. The directory printed by `doctor.mjs` is the one that must
still hold the cookies.

## 6. Upgrading from 0.11.x

- The `browser_*` tools are gone; asking for one is an unknown-tool error.
- `GET /dsh-inner-browser-use/state` answers 404; only the routes in
  [ARCHITECTURE.md](ARCHITECTURE.md#routes) exist.
- The tab is called **后台浏览器** / **Background browser**; a tab still named
  内置浏览器 means the page half is stale: reload the GUI page.
- Guest-era logins are not migrated; sign in once in the new profile.

## Live

`node scripts/live.mjs` does the same work on the open internet, with no local
fixture: it opens `example.com` (566 ms), reads it, clicks the language link on
`wikipedia.org` and lands on `en.wikipedia.org` (2.3 s, the page's own load
included), goes back (URL back to `wikipedia.org`), reads ten list items out of
the Web scraping article in one call (3 ms, 1813 chars), visits a host that
cannot resolve, and types into a search box then presses Enter (1.3 s to a
results URL). Eight JSON lines; eight `true` is the bar. A site being
unreachable is reported as such and is not a plugin failure — the run says
which site and how long it waited.

Two of those checks are about failure rather than success. `live-dead-host`
opens `https://never-resolves-this.invalid/`, waits for the browser to give up,
then asks three tools — a read, a click, a batch — what the page says: all
three must answer "the network could not reach that address", and none may
quote the browser's own `ERR_…` text or `This site can't be reached` back as
page content. `live-dead-host-recovers` navigates from there to a real address
and requires the real page. The search check drives Bing by the box's words
(`field: '搜索词'`) rather than a control number, because a search box is a
`combobox` on one engine and an `input` on another; it used to use Wikipedia,
whose home page answers while its search redirect times out on this network —
three runs in a row failed there and said nothing about the tools.

None of the numbers are the plugin's own latency: they are dominated by the
site and the network, which is the point of having them next to the local
measurements in [BENCH.md](BENCH.md).

## The packed file is whole

A clone works even when `package.json`'s `files` list is wrong, because the repo
is right there. A tarball does not. After `npm pack`, the listing must contain
the four modules the host half imports:

```bash
tar tzf dsh-inner-browser-use-*.tgz | grep -E 'package/(tools|read)\.js'
```

Two lines, or the install will fail with `Cannot find module` on first call.
`node --test test/*.test.mjs` covers both halves of this: one test walks the
import graph and fails when an imported file is not in `files`, another unpacks
the tarball and imports it from outside the repo.

## Breadth

`node scripts/breadth.mjs` drives a shadow-DOM component, a form (type, select,
checkbox, submit), a native dialog, an iframe (read, type, click), a click that
opens a tab, and a dead ref against local pages, and prints one JSON line per
check. Forty-two `true` lines is the bar; a `false` line names the check that
broke. Two of them cover a cross-site frame, which Chrome runs in its own
process. Three cover a control under an overlay: the click clears a cookie
banner and lands (`under clicked`), typing into a field under the same banner
works, and a modal that offers to delete the account is reported without
anything being pressed. Two more drive the same overlay through `browser_do`:
a batch step clears the banner before it clicks, and a batch step fills a field
that was under it. One more counts the recoveries: after the redraw check, the
state line says at least one ref was followed to its new number. Three cover a
hand on the mirror: while the person is using it a read still works
(`hold-allows-read`), an action is refused and names both ways out
(`hold-refuses-action`), and `browser_resume` hands the page back so the same
click goes through (`resume-lets-go`).

## Who the mirror serves

The bar that matters most cannot be reached from `node --test`, because it is
about a column that belongs to one conversation. With DSH running:

```sh
node scripts/live-safety.mjs http://127.0.0.1:49552
```

It reads the state, then tries the two ways in — a frame stream and a
navigation — as a session that is not the owner. Both must answer 403, and the
owner's stream must answer 200. Three `true` lines is the bar; `open · owner
none` as the first line only means nothing is on screen, and the two refusals
still have to hold.
