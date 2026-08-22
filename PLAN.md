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

- [x] Theme changes broadcast to open tabs; built-in pages update live instead
      of only at load. Fixes the start page staying in day mode.
- [x] New tabs open in the current theme.
- [x] `nativeTheme.themeSource` follows the app theme, so ordinary websites get
      `prefers-color-scheme: dark` too.
- [x] Persist theme (already stored; confirm it survives restart).
- [x] Close button centred vertically on each cloud.
- [x] New-tab button moves below the last cloud in the strip.
- [x] Settings button in the sidebar nav row.
- [x] Cloud-styled scrollbars.

Verify: one launch, toggle theme, one screenshot.

Also landed in phase 1, found while testing:

- [x] Collapsed sidebar drops the cloud entirely — no lobes, no pill, just a
      circle around the favicon with an accent ring when active.
- [x] Lobe count is randomised per cloud, with a width-derived floor.
- [x] `Ctrl+L` while collapsed opens the sidebar first; it used to focus an
      input that was `display: none` and swallow every keystroke.
- [x] Bubble bounds are re-sent on `animationend` — `getBoundingClientRect`
      reports the *transformed* box, so the preview was being sized from a
      mid-animation `scale(0.96)` and stayed 4% small.

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

Decided: **option (b)** — a real page rendered in the bubble, reloading as you
type. Guards that keep it sane without breaking the rule: a load only starts
when the resolved URL actually changes, the in-flight load is stopped first so
pages cannot queue up, and space-only edits do not count as a character.

- [x] Bubble shell, tail of three tapering circles, idle size animation.
- [x] Destination resolution shown live, spaces excluded from triggering.
- [x] Live preview view (option (b): a real load per character, skipping
      space-only changes), reusing the inset-bounds machinery.

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
