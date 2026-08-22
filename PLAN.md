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

- [x] Quick-link cards on the new tab page become clouds: rounded body with
      lobes off the top edge that overhang the sides slightly.
- [x] Share the lobe generator between the tab strip and the pages instead of
      writing it twice - `src/shared/clouds.js`, loaded as a plain script by
      both the chrome renderer and the file:// pages.
- [x] General polish pass: hover lift, focus rings, transitions.

Note: card fills have to be **opaque**. The lobes overlap the body and each
other, so any alpha shows every seam - which is why `--card-solid` and
`--card-hover` exist alongside the translucent `--card`.

Verify: one screenshot of the new tab page.

## Phase 3 — the thought bubble

A comic-book thought bubble hanging off the address bar while typing, with three
small bubbles tapering between it and the field, idly breathing in size.

Built as option (b): `LIVE_PAGE_PREVIEW` in `src/main/shell.js` is `true`, and
the bubble's interior is a real page that reloads per character. Set the flag to
`false` for a destination-only bubble that fetches nothing.

Two constraints came out of building it, both worth remembering:

> **The chrome renderer cannot draw over the page.** A tab is a
> `WebContentsView`, a native child stacked above the window's own web
> contents, so HTML positioned over the page area is invisible behind it.
> The bubble works around this: its frame is drawn *larger* than the preview
> view, so the head row and the ring of padding fall outside the view's rect
> and stay visible. That ring is what reads as the bubble.

> **A view takes native keyboard focus, repeatedly.** Showing it, a load
> committing, and the page's own scripts all grab it, and each grab sends the
> next keystrokes into the preview instead of the address bar. Returning focus
> from inside the `focus` event does not work - it is re-entrant and gets
> undone. It has to be deferred out of the focus change (0 / 80 / 250 ms), and
> the renderer must check where focus actually *is* before acting on a blur
> rather than trusting that it left.

> **Synthetic events do not exercise the real input path.** A dispatched
> `MouseEvent` skips the pointer path entirely, so a suite can pass green while
> real clicks do nothing. Two traps found this way: `preventDefault()` on a
> `pointerdown` cancels the compatibility `mousedown`/`click` that follow, and
> `sendInputEvent` never reaches a non-focused child view of a `BrowserWindow`.
> Pointer behaviour has to be checked with a real OS click. `clickprobe.js` +
> `click.ps1` in the scratchpad do that: the app prints its own target in
> physical pixels, and the clicker calls `SetProcessDPIAware()` first so the
> coordinates it is handed are the ones it uses.

Phase 4's custom page context menu needs the same overlay treatment — budget
for it there.

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
