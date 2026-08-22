# Build plan

Working plan for the current round of features. Ordered so that the cheapest,
most independent work lands first and the expensive verification happens once
per batch rather than once per change.

## How this gets built (the cost rules)

Every check in this project costs something. Roughly, from cheapest to dearest:

| Check | Relative cost | Use it for |
| --- | --- | --- |
| `node --check` on changed files | ~free | after every edit, always |
| A headless assertion script under Electron | low | logic: URL parsing, vault, layout maths, state |
| Launching the app and reading its log | medium | wiring, IPC, crashes |
| A screenshot | **high** (an image costs more than a page of text) | only genuinely visual work: shape, spacing, animation |
| `./build.sh` | highest (~60 s, 358 MB) | once, at the very end of a round |

Rules that follow from that table:

1. **Batch edits, verify once.** Group changes that touch the same surface and
   do a single verification pass over the batch. Never launch the app to check
   one CSS value.
2. **Prefer an assertion script to a screenshot.** A script that prints
   `RESULT: OK` costs a line; a screenshot costs an image. Anything expressible
   as "does this value equal that value" should be a script. The vault suite and
   the bounds probe in this repo are the pattern to copy.
3. **Screenshot only what is visual, and only once per batch.** Shape, spacing
   and motion genuinely need eyes. Wiring does not.
4. **Never package during development.** Use `npm run shortcut` (or `npm start`)
   — Smart App Control blocks freshly packaged builds anyway. Build once when a
   round is finished.
5. **Kill stray instances before launching.** The single-instance lock silently
   hands the launch to an older process, which has burnt real time here already:
   a stale instance reads stale state and the new code appears not to work.
6. **Edit with one script, not many calls.** A single Python/`sed` pass over
   several files beats a dozen individual edits.
7. **Instrument, do not guess.** Two `console.log`s in the main process settled a
   question that three screenshots could not. Remove them afterwards.

## Phase 1 — theme correctness and cheap UI fixes

One batch, one launch, one screenshot at the end.

- [ ] Theme changes broadcast to open tabs; built-in pages update live instead
      of only at load. Fixes the start page staying in day mode.
- [ ] New tabs open in the current theme.
- [ ] `nativeTheme.themeSource` follows the app theme, so ordinary websites get
      `prefers-color-scheme: dark` too.
- [ ] Persist theme (already stored; confirm it survives restart).
- [ ] Close button centred vertically on each cloud.
- [ ] New-tab button moves below the last cloud in the strip.
- [ ] Settings button in the sidebar nav row.
- [ ] Cloud-styled scrollbars.

Verify: one launch, toggle theme, one screenshot.

## Phase 2 — cloud shapes everywhere

- [ ] Quick-link cards on the new tab page become clouds: rounded body with
      lobes off the top edge that overhang the sides slightly.
- [ ] Share the lobe generator between the tab strip and the pages instead of
      writing it twice.
- [ ] General polish pass: hover lift, focus rings, transitions.

Verify: one screenshot of the new tab page.

## Phase 3 — the thought bubble

A comic-book thought bubble hanging off the address bar while typing, with three
small bubbles tapering between it and the field, idly breathing in size.

Open question, decide before building: what the bubble shows.

- **(a) The destination.** Resolved URL, which shortcut matched, whether it is a
  search or a host. Cheap, instant, no network.
- **(b) A live page preview.** A real page rendered in the bubble, reloading as
  you type. This is the literal reading of "the page view updates every
  character", and it is the more striking feature — but it fetches a page per
  keystroke, which is heavy and hits the network hard on a slow link.

Plan: build (a) as the always-on layer, and put (b) behind a debounce so a burst
of typing collapses into one load. That keeps the feature honest without
hammering the network on every character.

- [ ] Bubble shell, tail of three tapering circles, idle size animation.
- [ ] Destination resolution shown live, spaces excluded from triggering.
- [ ] Preview view, debounced, reusing the existing inset-bounds machinery.

Verify: one screenshot, then one interactive pass.

## Phase 4 — custom menus and scrollbars

- [ ] Right-click menu on clouds with the full Firefox tab menu: new tab, reload,
      duplicate, pin, mute, bookmark, move, reopen closed, close others, close
      to the right, close.
- [ ] Replace the native page context menu with an HTML one. Needs an overlay
      `WebContentsView` above the page, since the chrome view does not extend
      over the page area.
- [ ] Styled scrollbars inside built-in pages.

Verify: assertion script for the menu model, one screenshot for the styling.

## Phase 5 — merge tabs

The largest item. Merging combines the selected tabs into one page.

- [ ] Multi-select in the strip (ctrl/shift click).
- [ ] Merge action: one tab becomes host, the others' URLs move into it.
- [ ] Decide the merged layout — split panes or a stack — and animate the clouds
      moving and scaling into one.

This one needs a design decision before code. Do not start it until phases 1–4
are in and the animation approach is settled.

## Phase 6 — ship

- [ ] `git init`, first commit, push to GitHub.
- [ ] `./build.sh --clean` once.
- [ ] Tag a release.

Only here does packaging happen.
