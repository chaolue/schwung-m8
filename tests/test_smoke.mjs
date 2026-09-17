/* Pre-deploy smoke test: the module must IMPORT (the TDZ hazard `node
 * --check` cannot see), boot, tick, draw, and survive the gestures that
 * touch the newest code paths. */
import { loadUi, drawLog, midiOut, resetLogs, CC, NOTE_ON, NOTE_OFF,
         MOVE_SHIFT, openKnobSlot } from "./harness.mjs";
let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };
await loadUi();
ok(typeof globalThis.onMidiMessageInternal === "function", "module imported and exposed handlers");
const tick = () => globalThis.tick && globalThis.tick();   /* the module draws inside tick() */
for (let i = 0; i < 40; i++) tick();
ok(drawLog.length > 0, "boots and draws without throwing");
resetLogs(); for (let i = 0; i < 30; i++) tick();
ok(true, "steady-state ticks are clean");
resetLogs();
try { openKnobSlot(0); tick(); ok(true, "jogwheel knob cursor opens a slot"); }
catch (e) { ok(false, `jogwheel knob cursor: ${e.message}`); }
for (let i = 0; i < 5; i++) { globalThis.onMidiMessageInternal(CC(51, 127)); globalThis.onMidiMessageInternal(CC(51, 0)); tick(); }
resetLogs();
globalThis.onMidiMessageInternal(NOTE_ON(68)); globalThis.onMidiMessageInternal(NOTE_OFF(68));
ok(midiOut.external.length > 0, "a pad press reaches the M8 on the external port");
resetLogs();
globalThis.onMidiMessageInternal(NOTE_ON(8)); globalThis.onMidiMessageInternal(CC(79, 1)); tick();
ok(drawLog.length > 0, "master knob readout draws");
globalThis.onMidiMessageInternal(NOTE_OFF(8));
globalThis.onMidiMessageInternal(CC(MOVE_SHIFT, 127));
globalThis.onMidiMessageInternal(NOTE_ON(28)); globalThis.onMidiMessageInternal(NOTE_OFF(28));
globalThis.onMidiMessageInternal(CC(MOVE_SHIFT, 0));
for (let i = 0; i < 5; i++) tick();
ok(true, "shift + step 13 menu round trip survives");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
