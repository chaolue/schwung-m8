# CLAUDE.md

## Project Overview

M8 LPP Emulator module for Schwung. Emulates a Novation Launchpad Pro for use with Dirtywave M8.

## Build Commands

```bash
./scripts/build.sh      # Package files
./scripts/install.sh    # Deploy to Move
```

## Structure

```
src/
  module.json           # Module metadata
  ui.js                 # JavaScript UI (Launchpad Pro emulation)
```

## Features

- Emulates Launchpad Pro MIDI protocol
- Full pad matrix with velocity
- Raw MIDI mode for direct M8 communication
- Song-based knob configuration: an open-ended list of user-named songs,
  each holding pages of individually added, named, CC-mapped knobs. Display
  always shows the active song's current page (Schwung's own knob-page
  visuals, reused directly from `shared/param_pages/`); touching or turning
  a knob swaps its name for its live value, inverted.
- Knobs are added one at a time through a wizard (jog click raises a
  cursor over the eight slots; land on an empty one and click again)
  over a catalogue of M8's mixer, send-effect and per-instrument-type
  parameters, which supplies the name, the M8 default value, and the next
  free CC. Pages are created and pruned automatically as knobs need them.
  **M8's MIDI mapping is a LEARN system** — nothing here addresses an M8
  parameter by CC; the user maps each CC on the device (cursor on the
  parameter, hold OPTION, turn the knob).
- **Parameter defaults come from the manual's SCREENSHOTS, not its text** —
  see the memory `m8-manual-images-hold-parameter-defaults`, and the
  catalogue header comment in `src/ui.js`, which records where each
  family of defaults came from, before changing them. The EQ is the
  exception: its editor prints dB and Hz rather than hex, so there is no
  byte on the screenshot to copy and those defaults follow the
  catalogue's stated conventions instead.
- Two global screens on the step row, reachable from anywhere:
  **Shift+step 1** opens Song Management (browse/switch/create/rename/
  duplicate/delete) and **Shift+step 2** opens Settings. Both reuse
  `shared/menu_layout.mjs`'s list and `shared/text_entry.mjs`'s keyboard,
  and both take only the jogwheel, Back and their own Shift gestures -
  everything else falls through to the M8.
- A 3-band parametric EQ catalogue: 128 numbered slots plus the main mix
  and the three sends, each with gain, frequency and Q per band, reading
  in the M8's own dB / Q / Hz. TYPE and MODE are deliberately absent —
  they are selectors on the device and cannot be driven by a CC.

## Testing

```bash
./scripts/test.sh       # the whole suite
```

Tests live in `tests/` and load the **real** `src/ui.js` — see
`tests/README.md` for how the harness works, what each suite covers, and
the handful of gotchas worth knowing before adding one.

**`node --check` cannot see the failure this module fails with most often.**
Four times now a `const` has been placed above another `const` it refers to;
the reference is evaluated during module evaluation, while the target is still
in its temporal dead zone, so the module throws `ReferenceError: Cannot access
'X' before initialization` **on import** while the syntax check passes clean.
Running the suite catches it immediately — so run it before every deploy, not
just when the change looks risky. Where a value is only needed at call time (a
path built from `MODULE_DIR`, say), derive it in a **function** rather than a
`const`: a function body is not evaluated until it runs, by which point every
declaration has, and the ordering hazard disappears rather than being
re-sorted.

## Deploying

```bash
./scripts/build.sh      # package into dist/
./scripts/install.sh    # copy dist/ to the Move
```

**`install.sh` only copies `dist/`.** Running it without `build.sh` first
silently ships the previous package — the install reports success and the
device keeps the old behaviour, which is an expensive way to learn that a
fix "did not work". Build, install, then confirm:

```bash
ssh ableton@move.local 'md5sum /data/UserData/schwung/modules/overtake/m8/ui.js'
md5sum src/ui.js
```
