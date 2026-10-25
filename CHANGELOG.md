# Changelog

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
- The pane's address row is an address bar: type a host or a full address and press Enter to load it in this
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

- The package declares the host it needs (`>=0.2.0`), so the card can say which
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

- Fixed the ask stream going to a half that no longer exists: after the host half
  is reloaded (every install), the page's stream still looked open and reached
  nothing, so a call waited and then reported "no tab answered". The heartbeat
  reply now names the half serving it, and a page that hears a new name reopens
  its stream — no page reload needed after an install.

## 0.3.3

- The tab body gets its workspace under a name React keeps: `key` is reserved by
  React and never reaches a component, which is why the first tab to open failed
  with `options.key is not a function`.
- A chat and its tab do not always share an id, so the page now reports the tab
  it opened and the host routes that chat to it. Two open tabs no longer rely on
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

- Host bridge over same-origin HTTP: `GET /downlink` (SSE), `POST /uplink`, `POST /push`, `GET /state`.
- Five tools: `browser_navigate`, `browser_view`, `browser_click`, `browser_type`, `browser_script`.
- Client tab kind `inner-browser-use` on the `sidebar.right.pane.tab` slot, leasing a `<webview>` from the Desktop main process with the workspace's own partition.
- In-page runtime: numbered controls, real pointer and ripple, scroll-into-view, genuine mouse and keyboard events.
- Per-chat seats with a single-tab fallback; a closed tab rejects waiters, a silent one times out.
- Client heartbeat on the state route, so install problems are diagnosable without a debugger.
- 10 host tests, no dependencies, no build step.
