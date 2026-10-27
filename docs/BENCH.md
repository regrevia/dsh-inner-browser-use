<!-- ui-copy-ignore -->
# Measured, not claimed

`node scripts/bench.mjs` on a local page, headless, profile of its own. One JSON
line per measurement; a phase is only done when its row improves.

Method: a dense page (20 inputs, 120 links, two buttons), a text page (~60
paragraphs), a light page. The dense page carries a viewport-fixed counter,
because Chrome sends screencast frames only for visible change — measuring an
idle page measures nothing.

## Baseline — 0.12.1, before phase 1

| What | Number |
| --- | --- |
| launch → first frame | 506 ms (cold profile) |
| steady mirror | 60 fps, 72 KB/frame |
| click → next frame | 13 ms |
| click round trip | 1 ms |
| key round trip | 13 ms |
| screenshot | 82 ms, 133 KB PNG |
| read: dense page | 4.7k chars ≈ **1383 tokens** |
| read: text page | 8.0k chars ≈ **2363 tokens** |
| read: light page | 69 chars ≈ 20 tokens |

Targets: dense read ≤ 1200 tokens, text read ≤ 1500 tokens with the useful part
kept, click → painted ≤ 120 ms (already 13 ms; the number to protect), and a
batch of five steps in one tool call.

## After phase 1 + 2 — read model v2 and batched steps

Same bench, same machine. Read numbers are what a model actually receives with
the default budget (4600 chars of page text).

| What | Baseline | Now |
| --- | --- | --- |
| read: dense page | 1383 tokens | **436** tokens (90 controls, 1.5k chars) — `links` 514, `forms` 127, `full` 624 |
| read: text page | 2363 tokens | **1130** tokens (screenful only, budget 4600) |
| read: light page | 20 tokens | 17 tokens |
| read round trip | ~30 ms | **1–4 ms** |
| refs across reads | new numbers every read | **stable** (same refs, ticker-only text changes) |
| click round trip | 1 ms | 1 ms |
| key round trip | 13 ms | 0–2 ms |
| launch → first frame | 506 ms | 129–539 ms (cold/warm profile) |
| steady mirror | 60 fps, 72 KB/frame | 60 fps, 76 KB/frame |
| screenshot | 82 ms / 133 KB | 79–86 ms / 115 KB |

The win is structural: the old read took `document.body.innerText` (8k chars on
the text page); the new one walks the viewport, dedupes parent text, numbers
controls with refs that survive reads, and caps the text at the budget. Reading
again returns the same numbers, so a batch of steps costs one read instead of
one per step.

## What one step costs the model

Measured on the live tool surface (`/tmp/probe6.mjs`, 2026-10-27). Before this
pass every action answered with a full page read; now it answers with one line
and reads only when `read: true` is passed.

| step | reply | ≈ tokens |
| --- | --- | --- |
| click | `ok click 1 · https://… · Title` (60 chars) | 18 |
| type | `ok type · https://… · Title · focus email = a@b.c` (77) | 23 |
| key | `ok Enter · https://… · Title` (65) | 20 |
| check | `I agree is now on` (17) | 6 |
| select | `chose Beta · https://… · Title · focus …` (65) | 20 |
| wait | `saw hello` (9) | 3 |
| console / failed | `error: message` or `no request failed` (17–47) | 6–14 |
| dialog | `alert: sure?` (12) | 4 |
| cookie | one line per cookie, up to 40 | — |
| full read (dense page) | 1484 chars | 436 |

A ten-step batch therefore spends ~150 tokens on confirmations instead of
~4 400, and the page itself is read once when it changes.

## Notes

- Screencast frames are change-driven. A page with nothing moving sends nothing;
  that is Chrome behaving, not the mirror failing. After an agent action the host
  should force one frame so the person sees the result of a step that changed
  nothing visible.
- A tall page whose only animation is below the fold produces no frames: the
  viewport is what is captured.

## Phase 3 — frames and popups, 0.13.0

Same bench, same page. Two changes landed: controls are capped at the read's own
`max` after viewport-first sorting (the cap was applied to candidates, not to the
answer), and a read now also asks for the frame tree.

| What | Before | After |
| --- | --- | --- |
| read: dense, `full` | 3118 chars, 142 controls ≈ 917 tokens | 2128 chars, 90 controls ≈ **626 tokens** |
| read: dense, `text` | 1510 chars, 142 controls ≈ 444 tokens | 1510 chars, 90 controls ≈ 444 tokens |
| read: text page | 13 ms | 13 ms (one frame-tree call, ~1 ms) |
| launch → first frame | 506 ms | 479 ms |
| click round trip | 1 ms | 2 ms |
| key round trip | 13 ms | 2 ms |
| screenshot | 82 ms, 133 KB | 77 ms, 113 KB |

`sidecar_extract` on a 30-row list: 1106 chars for all 30 rows (≈330 tokens),
against 1291 chars for the same page read as text — and at a 500-char read
budget the text read stops around row 12 while the list still returns 30.

Live run (`npm run live`), 8 checks, all true on the open internet: open
example.com in 566 ms, read it for 785 chars, click the language link on
wikipedia.org and land on en.wikipedia.org in 2.3 s, go back to
www.wikipedia.org, extract ten list rows from the Web scraping article in 3 ms
(1813 chars), visit a host that cannot resolve (1.3 s to the browser's own
error page, where a read, a click and a batch all refuse instead of quoting it),
recover from there to a real page, and type into a search box and reach a
results URL in 1.3 s. These are wall-clock end to end including the site's own
load; the local numbers below are where the driver's own cost lives. Two hosts
were unusable from this machine and are not plugin problems: Hacker News (12 s
connect timeout, confirmed with curl) and Wikipedia's search redirect, which
answers on the home page and times out on the query — the search check runs on
Bing now, driven by the box's words rather than a control number.

Breadth run (`npm run breadth`), 33 checks, all true: open shadow DOM read and
click, form typing, select, checkbox, submit, `confirm()` seen and accepted,
iframe read, iframe typing, iframe click, cross-site frame read and click,
popup followed, download saved, network responses listed, a file uploaded
into a file input, the page printed to a PDF, a changed-only read, names from `for=` and `aria-labelledby`, a click found by its words, a login filled by field names in one call,
stale ref refused, a crash picked back up on the same page, a list read as 30 rows, a click under a full-screen cookie banner clears the banner and lands on the
control, typing into a field under that banner works the same way, and an
overlay that offers to delete the account is reported but never accepted.

## Phase 4 — what a change costs

| What | Number |
| --- | --- |
| change in the page → frame ready for the column | 7 ms median, 7 ms max (12 samples) |
| `changed_only` after a field changes, dense page | 58 chars ≈ **17 tokens** (whole page: 444) |
| read: text page, `changed_only` | 42 chars ≈ 12 tokens (whole page: 1517) |
| renderer crashed → readable page again | **1.39 s** (detect, fresh tab, same address) |

The mirror's delay is measured from the moment the page is told to change to
the frame object the column would draw — capture, JPEG, and the CDP hop. It is
the part of the latency that belongs to this side; what a person sees adds the
browser's compositing and the SSE hop, both smaller.

A cross-site frame (Chrome runs it in its own process) costs one more round
trip than a same-process one: its controls arrive in the same read, and the
frame's corner is one `DOM.getFrameOwner` plus one call on the owner element.

## Phase 5 — what an overlay costs

| What | Number |
| --- | --- |
| the "what is on top of this control" probe | **1 ms median, 2 ms max** (5 samples) — the same `Runtime.evaluate` hop, no round trip added |
| `sidecar_click` on an uncovered control | 460 ms median (3 runs, page-load settle included) |
| `sidecar_click` on the same control under a cookie banner | 630 ms median (3 runs) — the banner's own Accept click, a 150 ms beat, a re-probe, then the intended click |
| the same under a modal that offers to delete the account | 456 ms — reported, nothing pressed |
| one `sidecar_do` step on an uncovered control | 458 ms median (3 runs) |
| the same step under the cookie banner | 633 ms median (3 runs) — cleared, then the step ran |

A batch pays it once per step that has something over it, not once per call: a
banner cleared by step 1 is gone for steps 2..n, so a five-step flow through a
cookie wall costs one extra step's worth of time, not five.

The probe costs nothing when nothing is in the way, which is the common case;
the covered case pays about 170 ms to clear the banner and land the click in
the same call, instead of making the model spend a whole extra turn (a read, a
click, another read) telling it to close the banner first.
