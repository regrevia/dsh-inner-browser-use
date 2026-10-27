# dsh-inner-browser-use

A Chrome that the agent owns, mirrored into the right column of DeepSeek Harness.

The agent opens pages, reads them, clicks, types and scrolls. The browser is a separate
Chrome with its own profile on disk, not the tab the product ships: the column shows a
live picture of that browser, and your own cursor keeps working on the picture.

## Tools

| Tool | What it does |
| --- | --- |
| `sidecar_open` | Starts the browser (or reuses the running one) and opens an address. `headless: false` shows a real window on the desktop instead. |
| `sidecar_view` | Returns the address, the title, every control as `1 … 120`, and the visible text. |
| `sidecar_click` | Clicks a numbered control, or an `x`/`y` point. `double: true` double-clicks. |
| `sidecar_type` | Types text into the focused field, or clicks a numbered control first. Chinese goes in as one string. `submit: true` presses Enter. |
| `sidecar_key` | Presses one key: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down, Home, End, PageUp, PageDown. |
| `sidecar_scroll` | Scrolls the wheel at the centre of the page, or at `x`/`y`. `dy: 600` is about a screen down. |
| `sidecar_shot` | Saves a full-size PNG into `~/.dsh-inner-browser-use/screenshots` and returns the path. |
| `sidecar_state` | Reports whether the browser runs, which profile it uses, its address and title, and how many columns are showing it. |

`sidecar_view` answers with one page of text:

```
https://example.com
Example Domain

1 [a] More information
7 [input] Search
```

Numbers stay valid until the next read. Anything that changes the page returns a fresh read.

## The column

The pane is a picture of the browser, sent as JPEG over the session's own stream: 1440×900,
quality 72, every frame, about 82 KB and 25 per second on a page at rest.

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
| Screenshot | 77 ms, 113 KB |

## Install

```bash
git clone https://github.com/regrevia/dsh-inner-browser-use
dsh plugin install /path/to/dsh-inner-browser-use
```

In the app: **Plugins → Install from folder**, and pick the clone. To install the packed
tarball instead, build it from that directory and install the file:

```bash
npm pack                                  # writes dsh-inner-browser-use-0.13.2.tgz
dsh plugin install ./dsh-inner-browser-use-0.13.2.tgz
```

The plugin appears under **Plugins** as *Background browser*. It needs Google Chrome or
Chromium on the machine; see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Use

1. Open the chat you want the agent to browse for.
2. Ask for something on a page: *"open example.com and tell me the title"*.

The first call starts the browser and puts its mirror in this chat's right column. Nothing
opens before a call: a chat that never asked for a page keeps its column as it was.

## Frames, downloads, network

- **Frames are read, including cross-site ones.** Controls inside an iframe are numbered like
  the page's own, whether Chrome shares the page's process or runs the frame apart; a click in
  either lands where the frame actually sits.
- **A download lands on disk.** A click that saves a file writes it into the browser's own
  profile folder, and `sidecar_downloads` names it, its size and when it arrived.
- **The network is visible.** `sidecar_network` lists what the page asked for, newest first,
  so a page that fills itself in from an address can be understood without a screenshot.

## What it does not do

- **It does not touch your Chrome.** The browser runs from a separate profile with no
  connection to the window you are using.
- **The viewport is fixed.** 1440×900, desktop layout, no resizing and no mobile emulation.
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
