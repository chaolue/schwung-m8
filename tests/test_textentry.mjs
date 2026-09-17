/* The pad keyboard. Two things it used to get wrong: it swallowed the
 * Shift release that opened it, and the software pad flash kept painting
 * over its letters. */
import { loadUi, drawLog, midiOut, resetLogs, fileSystem, FRAME_MS, CC,
         MOVE_SHIFT, MOVE_JOG_CLICK, MOVE_JOG_TURN, JOG_CW, JOG_CCW } from "./harness.mjs";

let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };

const STEP_1 = 16, HINT_CC = 16;
const send = (m) => globalThis.onMidiMessageInternal(m);
const tick = () => globalThis.tick();
const texts = () => { resetLogs(); tick(); return drawLog.filter(d => d.op === "print").map(d => String(d.text)); };
const click = () => { send(CC(MOVE_JOG_CLICK, 127)); send(CC(MOVE_JOG_CLICK, 0)); };
const turn = (n) => { for (let i = 0; i < Math.abs(n); i++) send(CC(MOVE_JOG_TURN, n > 0 ? JOG_CW : JOG_CCW)); };

async function boot() {
    await loadUi();
    globalThis.init();
    globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
    for (let i = 0; i < 10; i++) tick();
}

/* --- Shift is released even though the keyboard took the message ----- */
fileSystem.clear();
await boot();
send(CC(MOVE_SHIFT, 127));
send(new Uint8Array([0x90, STEP_1, 127])); send(new Uint8Array([0x90, STEP_1, 0]));
send(CC(MOVE_SHIFT, 0));                    /* out of Songs' way */
for (let i = 0; i < 3; i++) tick();
ok(texts().includes("+ Add Song"), "the song list is open");

turn(-8); turn(1);                          /* onto the song */
send(CC(MOVE_SHIFT, 127));
click();                                    /* Shift+click - rename */
send(CC(MOVE_SHIFT, 0));                    /* THIS used to be swallowed */
for (let i = 0; i < 3; i++) tick();

let rows = texts();
ok(rows.some(t => t.startsWith("Song Name")), `the keyboard is up  [${rows.slice(0, 2).join(", ")}]`);

/* The step-1 lamp follows Shift, so it is the visible proof of the flag.
 * Left stuck down it would still be lit. */
const lamp = () => {
    const w = midiOut.internal.filter(
        m => m.length >= 4 && (m[1] & 0xF0) === 0xB0 && m[2] === HINT_CC);
    return w.length ? w[w.length - 1][3] : null;
};
resetLogs();
send(CC(MOVE_SHIFT, 127));
tick();
send(CC(MOVE_SHIFT, 0));
tick();
ok(lamp() === 0, `Shift is released while the keyboard is up  (lamp ${lamp()})`);

/* text_entry.mjs is shared state that loadUi() does not reset, so the
 * keyboard above would still be up in the next block. */
send(CC(51, 127)); send(CC(51, 0));         /* Back - dismiss it */
for (let i = 0; i < 3; i++) tick();

/* --- the flash does not paint over the letters ----------------------- */
await boot();
/* An M8 pad set FLASHING - channel 2 is the Launchpad's blink. LPP note
 * 51 is Move pad 68 on the top view. */
const FLASHING_PAD = 68;
globalThis.onMidiMessageExternal(new Uint8Array([0x91, 51, 21]));
/* Long enough for the startup pad-reassert sweep to finish, so what is
 * counted below is the FLASH and not the redraw. */
for (let i = 0; i < 200; i++) tick();

const padWrites = () => midiOut.internal.filter(
    m => m.length >= 4 && (m[1] & 0xF0) === 0x90 && m[2] === FLASHING_PAD).length;

/* THE PERIOD, in milliseconds rather than ticks. The module times the
 * flash from the clock so it runs at one speed whatever is on screen -
 * the knob page is a heavier draw than a menu and drops ticks, which
 * used to make the same flash visibly faster the moment a menu opened. */
const PAD_FLIP_MS = 450;
const RUN_MS = 3000;
resetLogs();
for (let i = 0; i < RUN_MS / FRAME_MS; i++) tick();
const flips = padWrites();
const expected = Math.floor(RUN_MS / PAD_FLIP_MS);
ok(Math.abs(flips - expected) <= 1,
   `the flash keeps its period: ${flips} flips in ${RUN_MS}ms, expected about ${expected}`);

/* Now open the keyboard and let it run for longer than a flip period. */
send(CC(MOVE_SHIFT, 127));
send(new Uint8Array([0x90, STEP_1, 127])); send(new Uint8Array([0x90, STEP_1, 0]));
send(CC(MOVE_SHIFT, 0));
for (let i = 0; i < 3; i++) tick();
turn(-8); turn(1);
send(CC(MOVE_SHIFT, 127)); click(); send(CC(MOVE_SHIFT, 0));
for (let i = 0; i < 5; i++) tick();
ok(texts().some(t => t.startsWith("Song Name")), "the keyboard is up again");

resetLogs();
for (let i = 0; i < 120; i++) tick();       /* several flip periods */
ok(padWrites() === 0, `no pad is repainted under the keyboard  (${padWrites()} writes)`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
