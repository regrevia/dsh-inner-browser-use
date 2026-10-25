# dsh-inner-browser-use

**Lets an agent drive the built-in sidebar browser of DeepSeek Harness — the one already in the right panel, not a new window.**

The agent navigates, reads the page as numbered controls, clicks, types, and runs JavaScript. You watch it happen: a pointer moves to each target and ripples where it lands. Everything runs inside the `<webview>` the product already leases, with the same partition and the same cookies, so a page you signed into by hand is the page the agent works on.

> **On the name:** *inner* means the browser built into the Harness sidebar. This plugin opens no window of its own and never attaches to Chrome.

## What you get

| Tool | What it does |
| --- | --- |
| `browser_navigate` | Opens a URL in this chat's built-in browser and returns the page. |
| `browser_view` | Returns the address, title, visible text, and every control as `#1 … #80`. |
| `browser_click` | Clicks one numbered control and returns the page it leads to. |
| `browser_type` | Types into one numbered field, optionally pressing Enter. |
| `browser_script` | Evaluates JavaScript and returns the last expression. |
| `browser_selection` | Returns the text currently selected in the page. |
| `browser_copy` | Copies the selection, or one control's text, to the clipboard. |
| `browser_screenshot` | Saves a PNG of the tab and returns its path. |
| `browser_download` | Saves a file the page offers into this chat's project folder. A file the page starts saving on its own lands there too, and the call that caused it reports the path. |
| `browser_upload` | Attaches a local file to a numbered file field. |

Every call is visible: the pointer travels to the control, a ring marks it, and the page scrolls the target into view first.

The first call opens the tab for you: the page half hears that a chat needs one and opens **内置浏览器** in the right sidebar. That tab is the product's own — same tab kind, same address bar, same partition — and this plugin adds nothing to the guide pane. A tab you opened by hand is the tab the agent drives.

## Where files land

The tab reports the folder its chat works in when it connects, and everything this plugin writes goes under one
folder of that working directory:

```
.dsh-inner-browser-use/
  .gitignore     keeps the folder out of your project's own version control
  screenshots/   PNGs from browser_screenshot
  downloads/     files the page offered to browser_download
```

## Install

```bash
git clone https://github.com/regrevia/dsh-inner-browser-use
```

Then in DeepSeek Harness: **Plugins → Install from folder**, and pick the clone. Or from a shell:

```bash
dsh plugin install /path/to/dsh-inner-browser-use
```

The plugin appears under **Plugins** as *内置浏览器*. It needs the Desktop app, because the sidebar browser is a Desktop capability.

## Use

1. Open the chat you want the agent to browse for.
2. Ask the agent for something on a page: *"打开 example.com，告诉我标题"*. The first call opens the built-in browser in the right panel; pressing **+ → 内置浏览器** yourself lands on the same tab.

The tab is per chat: each chat has its own in the same built-in browser. A call for a chat that never opened one opens it there.

## Drag data both ways

- **Page → chat:** `browser_script` returns strings and `browser_screenshot` saves a PNG, so the agent can read what the page shows and quote it — or hand you the image path — in the conversation.
- **Chat → page:** `browser_type` puts text into a field; `browser_script` can set values the page cannot be typed into.
- **Page → chat, by hand:** select text on the page and a **Drag to chat** handle appears in the tab's
  status row. Drag it into the conversation to carry that text with you. After the agent downloads something
  for this chat, the same handle carries that file, so a page's picture or PDF can be dropped into the chat
  as an attachment without leaving the app. The agent gets the same content through `browser_selection`,
  `browser_copy` and `browser_download`.

## What it will not do

- **It does not create a second browser.** No new window, no Chrome profile, no CDP mirror.
- **A sign-in outlives a restart only when the page can read its cookie.** The guest partition lives in memory; the cookies this page can see are kept per workspace in `~/.dsh/inner-browser-use/cookies/` and written back when that workspace's pane opens again. A login held only in an `HttpOnly` cookie needs the password again.
- **Screenshots are viewport-sized.** A `<webview>` captures what is visible, not the whole scroll height; scroll first, then capture.
- **One partition per workspace.** Two chats in the same workspace share the browser's storage, exactly as two tabs of the built-in browser do.
- **No popups or permission prompts.** A link that wants a new window stays in the tab it is in. A file the page
  offers comes out through `browser_download`, which saves it into this chat's project folder and hands the path
  back to the conversation. A file the page starts saving by itself needs no call: it lands in the same folder,
  and the call that pressed the link reports where it went.
- **It opens the tab only when a call needs it.** A call for the chat you are reading may open the right
  panel; a call for any other chat gets a page out of sight instead, so the panel stays as you arranged it.
  At most three such pages are kept, and the oldest goes first.
- **A capture of a chat you are not looking at.** Reading, clicking and typing work on a tab that chat already
  had, because they drive the page itself; a tab is opened only for the chat on screen. Pixels come from a surface the app is drawing, and a view
  behind another tab of the same pane is not drawn: the capture tries to bring this chat's tab forward, and if the
  page still has no surface it says so in a couple of seconds instead of waiting. Read what you need from the page
  instead — `browser_script` returns the same content.

## Compatibility

| | |
| --- | --- |
| Harness | Desktop app, sidebar browser present |
| Tab kind | `browser` — the built-in browser's own kind |
| Host | Node 20+ |
| License | MIT |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the wire and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for version limits.

## Develop

```bash
node --test test/*.test.mjs
```

The host half is plain ESM with no dependencies; the client half is a dynamic client module with no build step. Both are loaded by the app as-is.

- **The page comes back on its own.** The pane is rebuilt from time to time; when that leaves the view blank, the
  next tool call reopens the page that chat was last told to open, so a run is not interrupted by it.

## License

MIT © regrevia
