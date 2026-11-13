/**
 * The order of two questions, in the source.
 *
 * A click and a type both ask the page two things before they touch it: where
 * the control is, and what is sitting on top of it. The answers are only true
 * of each other when they are asked about the same place, and a scroll is what
 * moves the place: asking where the control is scrolls it into view, asking
 * what covers it measures whatever is at that place now.
 *
 * Getting the order wrong is invisible in a passing suite — both answers are
 * well-formed, both calls succeed, and the press still lands under a banner the
 * driver never named. It was measured once on a field 1400 px down the page: a
 * banner was on top of it, the type was reported done, and the field was empty.
 * A browser test would catch that again; these assertions catch it without one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOLS = readFileSync(join(ROOT, "tools.js"), "utf8");

/**
 * The body of one tool, from its name to the next tool's name.
 * @param {string} name - the tool whose body to cut out.
 * @param {string} next - the tool that follows it.
 * @returns {string} the source of that one tool.
 */
function body(name, next) {
  const from = TOOLS.indexOf(`name: '${name}'`);
  const to = TOOLS.indexOf(`name: '${next}'`, from + 1);
  assert.ok(from > 0, `${name} is in the source`);
  assert.ok(to > from, `${name} is followed by ${next}`);
  return TOOLS.slice(from, to);
}

/** Order in a body, said as one comparison. */
function before(where, first, second) {
  const a = where.indexOf(first);
  const b = where.indexOf(second);
  assert.ok(a > -1, `the source still calls ${first}`);
  assert.ok(b > -1, `the source still calls ${second}`);
  assert.ok(a < b, `${first} is asked before ${second}`);
}

test("typing into a field asks where it landed before asking what is on top", () => {
  /* findAgain() scrolls the field into view. clearCover() measures what is on
     top of it. The banner that matters is the one over the field where it is
     after that scroll, not the one over the place it held when the page was
     last drawn. */
  const type = body("browser_type", "browser_ask");
  before(
    type,
    "await findAgain(page, Number(args.ref))",
    "await clearCover(page, Number(args.ref))",
  );
});

test("a control found by its words is checked for a cover before it is pressed", () => {
  /* The same gate the numbered control gets, because the press lands on the
     page either way: a banner over a control the caller named is exactly as
     harmful as one over a control the caller numbered. */
  const click = body("browser_click", "browser_hover");
  before(click, "if (hit.blocked !== undefined) return refusedUnder(", "await clearCover(page, Number(hit.ref))");
  before(click, "await clearCover(page, Number(hit.ref))", "point = { x: hit.x, y: hit.y }");
  assert.match(click, /Not clicked: nothing of "\$\{String\(hit\.name\)\.slice\(0, 60\)\}" is reachable/, "the refusal says what was not reachable");
});

test("a field still covered is refused before anything is typed into it", () => {
  const type = body("browser_type", "browser_ask");
  before(
    type,
    "if (gate.cleared !== true)",
    "await page.mouse('mouseMoved', point)",
  );
  assert.match(
    type,
    /Not typed into: the field is still covered/,
    "the refusal names the overlay",
  );
});

test("a banner that was dismissed moves the page, so the field is asked again", () => {
  /* Clicking "Accept all" reflows the page: the field is somewhere else now.
     Typing at the coordinate measured before the dismissal is the same bug in
     a different disguise, so the position is measured again after it. */
  const type = body("browser_type", "browser_ask");
  before(
    type,
    "if (gate.cleared && cover !== '')",
    "const again = await locate(page, Number(args.ref))",
  );
  before(
    type,
    "const again = await locate(page, Number(args.ref))",
    "await page.mouse('mouseMoved', point)",
  );
  assert.match(
    type,
    /if \(again\.gone !== true\) point = \{ x: Number\(again\.x\), y: Number\(again\.y\) \}/,
    "and the new position is adopted",
  );
});

test("a click asks the same two questions in the same order", () => {
  const click = body("browser_click", "browser_type");
  before(
    click,
    "await findAgain(page, Number(args.ref))",
    "await clearCover(page, Number(args.ref))",
  );
  assert.match(
    click,
    /Not clicked: the control is still covered/,
    "the refusal names the overlay",
  );
});

test("a control that is off screen is never handed back as a redraw", () => {
  /* findAgain() looks a control up by its words when its number went away, on
     the theory that the page redrew. A control that merely scrolled out of
     reach is not that: hunting by words would hand back a different control
     that happens to say the same thing. */
  const again = TOOLS.slice(
    TOOLS.indexOf("const findAgain = async"),
    TOOLS.indexOf("return [", TOOLS.indexOf("const findAgain = async")),
  );
  before(
    again,
    "if (spot.off === true) return { gone: true, why:",
    "const known = (refsFor().refs ?? []).find",
  );
  assert.match(
    again,
    /is off screen: scroll it into view/,
    "and it says what to do instead",
  );
});
