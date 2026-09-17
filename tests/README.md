# Tests

Each file loads the **real `src/ui.js`** in Node rather than a copy of its
logic: `harness.mjs` rewrites the module's
`/data/UserData/schwung/shared/` imports to point at the Schwung checkout
beside this repo, stubs the device globals (`print`, `fill_rect`,
`set_pixel`, `clear_screen`, `text_width`, `move_midi_*_send`,
`host_ensure_dir`, `host_pad_block`, `host_exit_module`, and a `std`
shim), and then drives the module through `onMidiMessageInternal`,
`onMidiMessageExternal` and `tick()`, asserting on the draw log and on
what went out over MIDI.

```bash
./scripts/test.sh                       # everything
node tests/test_eq.mjs                  # one suite
SCHWUNG_SRC=/path/to/schwung/src ./scripts/test.sh
```

Schwung is expected at `../schwung/src`; `SCHWUNG_SRC` overrides that.

## Run these before every deploy

`node --check` **cannot see the failure this module fails with most
often**: a `const` placed above another `const` it refers to throws
`ReferenceError: Cannot access 'X' before initialization` during module
evaluation, while the syntax check passes clean. Loading the module is
what catches it, and every suite here starts by loading the module.

## What each one covers

| Suite | Covers |
| --- | --- |
| `test_smoke.mjs` | Imports, boots, draws, and survives the jogwheel knob cursor, a pad press, the master-knob readout and a Shift+Step 13 menu round trip |
| `test_identity.mjs` | The Device Inquiry reply names the Launchpad Pro MK3 (`13 01`), not just Novation |
| `test_midici.mjs` | MIDI-CI Discovery is answered with silence, as the real hardware does, while the introduction and its retry damping still work |
| `test_surfacestate.mjs` | The pads, mode and half are saved on the way out and restored on the way in; a reopen stays silent so the M8 keeps its screen; v1 snapshots still load |
| `test_eq.mjs` | The EQ branch of the Add Knob wizard, the `00`-`7F` slot ceiling, and the dB / Q / Hz readings |

## Gotchas worth knowing before adding one

- **`tick()` is what draws.** There is no `render()` global.
- **The M8 has to speak first.** Until something arrives on the external
  port the module shows "Waiting for M8...", and there is no knob page to
  assert against. Send any note-on from the M8 before doing anything else.
- **First contact resets the pads to the top half**, so anything set up
  before it is undone. Let the M8 speak, *then* arrange the state.
- **A mode change forgets the grid on purpose**, so an LED set before one
  is gone by design. Light pads after the last mode change.
- **`fileSystem` persists across `loadUi()`**, which is what makes the
  save/restore tests possible - and what makes a slot filled by an
  earlier step still filled in a later one. `fileSystem.clear()` for a
  fresh song.
- **A scrolling list only prints the visible rows**, so do not count a
  long list's items from one frame.
- **`drawMenuHeader` uses a pixel font**, so a header is invisible to
  `print`-log assertions. Assert on list contents instead.
- **`drawMenuList`'s scrollbar needs `set_pixel`**, which the harness
  stubs; it is only reached once a list is long enough to scroll.
