# dsh-inner-browser-use

A Chrome that the agent owns, mirrored into the right column of DeepSeek Harness.

The agent opens pages, reads them, clicks, types and scrolls. The browser is a separate
Chrome with its own profile on disk, not the tab the product ships: the column shows a
live picture of that browser, and your own cursor keeps working on the picture.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_open` | Starts the browser (or reuses the running one) and opens an address. `headless: false` shows a real window on the desktop instead. |
| `browser_view` | Returns the address, the title, every control as `1 … 120`, and the visible text. |
| `browser_extract` | Returns the items a CSS selector matches, one compact line each with its link, instead of the whole page. |
| `browser_click` | Clicks a numbered control, or an `x`/`y` point. `double: true` double-clicks. A cookie banner or modal over the control is cleared first, then the click happens. |
| `browser_type` | Types text into the focused field, or clicks a numbered control first. Chinese goes in as one string. `submit: true` presses Enter. |
| `browser_key` | Presses one key: Enter, Tab, Escape, Backspace, Delete, Insert, arrows, Home, End, PageUp, PageDown, F1-F12, the numeric keypad, letters, digits, punctuation and every shifted symbol, plus ContextMenu, CapsLock, PrintScreen and media keys. `Ctrl`/`Alt`/`Shift`/`Meta`/`Mod` modifiers, chords with `+`, and `Ctrl+C/X/V/A/Z/Y` run the real editing commands. |
| `browser_scroll` | Scrolls the wheel at the centre of the page, or at `x`/`y`. `dy: 600` is about a screen down. |
| `browser_shot` | Saves a full-size PNG into `~/.dsh-inner-browser-use/screenshots` and returns the path. |
| `browser_state` | Reports whether the browser runs, which profile it uses, its address and title, and how many columns are showing it. |

`browser_view` answers with one page of text:

```
https://example.com
Example Domain

1 [a] More information
7 [input] Search
```

Numbers stay valid until the next read. Anything that changes the page returns a fresh read.

## The column

The pane is a picture of the browser, sent as JPEG over the session's own stream: quality 72,
every frame, about 82 KB and 25 per second on a page at rest. The page is laid out at the size
of the column, so the picture fills the frame instead of sitting letterboxed inside it.

Two pointers live on that picture:

- **The black arrow** is the agent. It marks where its last click landed, and it moves the
  moment a new one is dispatched, without waiting for the page to repaint.
- **Your cursor** is the real one. Hovering, clicking, the wheel and keystrokes are sent to
  the browser as real mouse and keyboard input, so a site that rejects scripted clicks still
  works. Moving your mouse never moves the black arrow.

The address row above the picture is an address bar: type an address and press Enter, or use
back, forward and reload. The field follows the page except while you are editing it.

Typing arrives two ways: composed text (Chinese, emoji, anything the input method produces)
lands as one insertion, and keys arrive as themselves, so Backspace deletes one character on
the page.

The pane opens only in the session that asked for it. A tool call in another session drives
the same browser without taking the column that someone else is reading.

## Logins

The profile is a directory of its own: `~/.dsh/inner-browser-use/chrome/default`. It sits
outside the product's browser storage, which is created per process and gone on restart, so a
sign-in here is still there the next day.

- **Plugin reload.** A reload adopts the Chrome that is still running, with the page it was on.
- **Harness restart.** The same directory is opened again, so cookies, `localStorage` and
  passwords that Chrome saved all survive.
- **Shutdown.** The browser is asked to close rather than killed, which is when Chrome writes
  the last of its cookies; an idle browser is closed after 15 minutes, and the clock stops
  while a column is watching.

Screenshots are the only thing written outside the profile:
`~/.dsh-inner-browser-use/screenshots/`.

## Measured

| | |
| --- | --- |
| Navigate to first frame | ~850 ms, network included |
| Frame | 1440×900 JPEG, ~82 KB |
| Stream | ~25 frames per second |
| Pointer move to arrow | 0.8–7 ms |
| Read, dense page | 444 tokens (1510 chars, 90 controls) |
| Read round trip | 1–4 ms |
| Click round trip | 2 ms |
| Key round trip | 7 ms |
| Key to next frame | 15–18 ms |
| Screenshot | 75 ms, 115 KB |

## Install

```bash
git clone https://github.com/regrevia/dsh-inner-browser-use
dsh plugin install /path/to/dsh-inner-browser-use
```

In the app: **Plugins → Install from folder**, and pick the clone. To install the packed
tarball instead, build it from that directory and install the file:

```bash
npm pack                                  # writes dsh-inner-browser-use-0.16.0.tgz
dsh plugin install ./dsh-inner-browser-use-0.16.0.tgz
```

The plugin appears under **Plugins** as *Background browser*. It needs Google Chrome or
Chromium on the machine; see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## When it opens

Only when the person asks for it by name: "in the browser", "on the web page",
"open this site", "click it for me". A link on its own is not a request.

- A public article, one link's text, docs, a GitHub repo or PR: read it with
  `web_fetch` or Envoy. No browser, no Chrome process.
- If the page needs a login, is an empty shell to `web_fetch`, or needs a click,
  say why and ask once instead of starting a browser on your own.
- Asked for, it starts without a question and never opens a second, external
  Chrome. The picture stays in this chat's right column and stays open when the
  work is done.

One browser is shared by every chat (see [Sharing](#sharing)), so opening one is
a tab, not a second Chrome.

## Use

1. Open the chat you want the agent to browse for.
2. Ask for something on a page: *"open example.com and tell me the title"*.

The first call starts the browser and puts its mirror in this chat's right column. Nothing
opens before a call: a chat that never asked for a page keeps its column as it was.

## Sharing

Every chat uses the same background Chrome: one process, one tab per chat, and
each tab's address saved so it can be closed and reopened cheaply. Past six
chats the oldest tab nobody is watching is closed (a watched tab — the one on
someone's screen — never is). Tabs an earlier plugin load left behind are closed
on first use: one profile used for weeks otherwise keeps a renderer per chat that
ever opened it. Nothing is launched per chat, and the browser itself is closed 15
minutes after the last mirror is detached.

## Frames, downloads, network

- **Frames are read, including cross-site ones.** Controls inside an iframe are numbered like
  the page's own, whether Chrome shares the page's process or runs the frame apart; a click in
  either lands where the frame actually sits.
- **A download lands on disk.** A click that saves a file writes it into the browser's own
  profile folder, and `browser_downloads` names it, its size and when it arrived.
- **The network is visible.** `browser_network` lists what the page asked for, newest first,
  so a page that fills itself in from an address can be understood without a screenshot.
- **An overlay does not eat the action.** A cookie banner over the button is cleared the way a
  person would clear it, then the click lands — in the same call, and in every step of a
  `browser_do` batch. Anything offering to delete, pay or sign out is reported instead.

## What it does not do

- **It does not touch your Chrome.** The browser runs from a separate profile with no
  connection to the window you are using.
- **The layout viewport is the column, nothing more.** Desktop layout, no mobile emulation, no
touch emulation; a very narrow column is laid out narrow rather than zoomed out.
- **One page at a time.** A link that opens a tab is followed — the mirror lands on the new
  page and the popup closes — so there is never a second page to choose between.

## Compatibility

| | |
| --- | --- |
| Harness | 0.2.0 or newer |
| Chrome | Google Chrome, Chromium or Canary, 112 or newer |
| Runtime | Node 20 or newer |
| License | MIT |

Details in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md); how the halves connect in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```bash
node --test test/*.test.mjs
```

The server half is zero-dependency ESM, the page half is a client module loaded at runtime.
Neither has a build step.

## License

MIT © regrevia
