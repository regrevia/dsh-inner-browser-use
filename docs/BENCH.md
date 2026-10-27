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
| launch → first frame | 506 ms | 129–492 ms (cold/warm profile) |
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
