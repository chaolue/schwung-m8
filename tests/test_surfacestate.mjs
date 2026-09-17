/* Closing and reopening the module must come back to the SAME screen:
 * the lit pads, the mode, and the half. The lit set is stored by LPP
 * note and which pad a note paints depends on the half, so restoring
 * colours without the view paints them onto the wrong pads. */
import { loadUi, drawLog, fileSystem, midiOut, resetLogs, usbFrames,
         sysexMessages, CC } from "./harness.mjs";

/* The module's one plain-text screen. Its presence is the signal that
 * nothing has been heard from the M8. */
function waitingForM8() {
    resetLogs();
    globalThis.tick();
    return drawLog.some(d => d.op === "print" && String(d.text).startsWith("Waiting for M8"));
}

let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };

const MOVE_CAPTURE = 52, MOVE_BACK = 51, MOVE_MENU = 50;
const press = (cc) => { globalThis.onMidiMessageInternal(CC(cc, 127)); globalThis.onMidiMessageInternal(CC(cc, 0)); };

/* --- session one: go somewhere non-default, then leave ------------- */
await loadUi();
resetLogs();
globalThis.init();
const freshIds = sysexMessages(usbFrames(midiOut.external)).filter(m => m[3] === 0x06 && m[4] === 0x02);
ok(freshIds.length === 1, "a FRESH start still introduces itself to the M8");
for (let i = 0; i < 10; i++) globalThis.tick();

/* The M8 speaks first, as it does on hardware: first contact resets the
 * pads to the top half, so anything done before this would be undone. */
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 3; i++) globalThis.tick();

press(MOVE_CAPTURE);            /* Sequencer */
press(MOVE_CAPTURE);            /* again on the same button = other half */
for (let i = 0; i < 5; i++) globalThis.tick();

/* An LED, sent AFTER the mode change - which deliberately forgets the
 * grid, so anything lit before it is gone by design. */
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 51, 5]));
for (let i = 0; i < 2; i++) globalThis.tick();

globalThis.onUnload();

const path = [...fileSystem.keys()].find(k => k.endsWith("leds.json"));
ok(!!path, "a snapshot was written on the way out");
const saved = JSON.parse(fileSystem.get(path));
console.log("     saved:", JSON.stringify({ v: saved.v, mode: saved.mode, view: saved.view,
                                            viewByMode: saved.viewByMode,
                                            leds: Object.keys(saved.leds ?? {}).length + " led(s)" }));
ok(saved.v === 2, "snapshot carries a version");
ok(saved.mode === 3, "the mode it was left on is recorded (Sequencer = 3)");
ok(saved.view === 1, "the half it was left on is recorded (Bottom = 1)");
ok(saved.viewByMode && saved.viewByMode["3"] === 1,
   "the mode being left on is in viewByMode, not only the ones departed from");
ok(Object.keys(saved.leds ?? {}).length > 0, "the lit pads are recorded");

/* --- session two: a fresh module, same stored file ----------------- */
await loadUi();                 /* fileSystem persists across loadUi */
resetLogs();
globalThis.init();
/* THE BUG THIS GUARDS: the introduction makes the M8 initialise its
 * control surface from scratch, which drops it on Session and repaints
 * - throwing away the screen we just restored, on the M8's display as
 * well as ours. With a snapshot in hand we say nothing. */
const restoredIds = sysexMessages(usbFrames(midiOut.external)).filter(m => m[3] === 0x06 && m[4] === 0x02);
ok(restoredIds.length === 0, "a RESTORED start says nothing, so the M8 stays where it is");
for (let i = 0; i < 10; i++) globalThis.tick();
ok(sysexMessages(usbFrames(midiOut.external)).filter(m => m[3] === 0x06).length === 0,
   "and the retry loop does not introduce us either");

/* THE REGRESSION THIS GUARDS: the M8 speaking for the first time after a
 * reopen must not reset the half. markM8Connected sends the pads back to
 * the top on first contact, which is right when the M8 is starting the
 * conversation and wrong when we just restored the screen it never left. */
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 52, 5]));
for (let i = 0; i < 3; i++) globalThis.tick();

/* Leaving and re-entering must not change what is stored. */
globalThis.onUnload();
const again = JSON.parse(fileSystem.get(path));
ok(again.mode === 3, "reopened on the mode it was left on");
ok(again.view === 1, "reopened on the half it was left on");
ok(Object.keys(again.leds ?? {}).length > 0, "the remembered pads survived the round trip");

/* --- a snapshot with no timestamp is ignored, not half-applied ------ */
/* A v1 file is a bare lit map with no `t`, so it cannot be aged and is
 * not trusted. It must not throw, and must not leave the module
 * believing the M8 is connected. */
fileSystem.set(path, JSON.stringify({ "51": [5, 0, 0], "52": [21, 0, 0] }));
await loadUi();
let threw = null;
try { globalThis.init(); for (let i = 0; i < 5; i++) globalThis.tick(); }
catch (e) { threw = e; }
ok(!threw, `an old v1 snapshot does not throw${threw ? `: ${threw.message}` : ""}`);
ok(waitingForM8(), "and leaves the module waiting for the M8");
globalThis.onUnload();
ok(JSON.parse(fileSystem.get(path)).v === 2, "and is rewritten in the new format");

/* --- STALE: an old snapshot must not pass for a live M8 -------------- */
/* The failure this guards is the nastiest one available: a screen full of
 * remembered LEDs that looks live while nothing is plugged in. */
fileSystem.clear();
await loadUi();
globalThis.init();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 5; i++) globalThis.tick();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 51, 5]));
for (let i = 0; i < 3; i++) globalThis.tick();
globalThis.onUnload();

const snapPath = [...fileSystem.keys()].find(k => k.endsWith("leds.json"));
const snap = JSON.parse(fileSystem.get(snapPath));
ok(typeof snap.t === "number", "the snapshot carries a timestamp");

/* Fresh, but the M8 has not spoken: the grid is held in memory and
 * NOTHING is claimed. A file cannot tell us the M8 is plugged in, so the
 * screen still says it is waiting - and the module stays silent, so an
 * M8 that is merely idle is not knocked off its screen to prove it is
 * there. */
await loadUi();
resetLogs();
globalThis.init();
for (let i = 0; i < 5; i++) globalThis.tick();
const spokeFirst = sysexMessages(usbFrames(midiOut.external))
    .some(m => m[3] === 0x06 && m[4] === 0x02);
ok(waitingForM8(), "a FRESH snapshot does NOT pass for a connected M8");
ok(!spokeFirst, "and the module stays silent rather than asking");

/* The M8 speaks - now it is confirmed, and the remembered grid goes up. */
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 5; i++) globalThis.tick();
ok(!waitingForM8(), "one message from the M8 confirms it and the page appears");

/* Stale: ignored whole - waiting screen, and nothing painted from it. */
snap.t = Date.now() - (3 * 60 * 1000);          /* three minutes ago */
fileSystem.set(snapPath, JSON.stringify(snap));
await loadUi();
resetLogs();
globalThis.init();
for (let i = 0; i < 5; i++) globalThis.tick();
/* Read the wire BEFORE waitingForM8(), which resets the logs to draw. */
const introduced = sysexMessages(usbFrames(midiOut.external))
    .some(m => m[3] === 0x06 && m[4] === 0x02);
ok(waitingForM8(), "a STALE snapshot shows Waiting for M8 instead");
ok(introduced, "and the module introduces itself, as it does on a first run");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
