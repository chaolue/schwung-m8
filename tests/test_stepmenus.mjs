/* The two menus live on the step row, behind Shift: step 1 opens Songs,
 * step 2 opens Settings. Step 1 is the Launchpad's T1, so the shifted
 * press must never reach the M8; step 2 is one of this module's own
 * preset buttons, so unshifted it still picks a song. */
import { loadUi, drawLog, midiOut, resetLogs, CC, MOVE_SHIFT,
         MOVE_JOG_CLICK } from "./harness.mjs";

let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };

const STEP_1 = 16, STEP_2 = 17;
const send = (m) => globalThis.onMidiMessageInternal(m);
const tick = () => globalThis.tick();
const texts = () => { resetLogs(); tick(); return drawLog.filter(d => d.op === "print").map(d => String(d.text)); };
const pressStep = (n) => { send(new Uint8Array([0x90, n, 127])); send(new Uint8Array([0x90, n, 0])); };
const turn = (n) => { for (let i = 0; i < Math.abs(n); i++) send(CC(14, n > 0 ? 1 : 127)); };
const click = () => { send(CC(MOVE_JOG_CLICK, 127)); send(CC(MOVE_JOG_CLICK, 0)); };
const shiftStep = (n) => { send(CC(MOVE_SHIFT, 127)); pressStep(n); send(CC(MOVE_SHIFT, 0)); };

async function boot() {
    await loadUi();
    globalThis.init();
    globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
    for (let i = 0; i < 10; i++) tick();
}

/* --- Shift + step 1 opens Songs -------------------------------------- */
await boot();
shiftStep(STEP_1);
let rows = texts();
ok(rows.includes("+ Add Song"), `Shift+step 1 opens Songs  [${rows.join(", ")}]`);

/* --- Shift + step 2 opens Settings, which no longer lists Songs ------- */
await boot();
shiftStep(STEP_2);
rows = texts();
console.log("     Settings rows:", rows.join(", "));
ok(rows.includes("Knob Chan"), "Shift+step 2 opens Settings");
ok(!rows.includes("Songs"), "and Settings does not list Songs - the shortcut is the way across");

/* --- unshifted, step 2 is still song preset 1 ------------------------ */
await boot();
pressStep(STEP_2);
rows = texts();
ok(!rows.includes("Knob Chan"), `a plain step 2 does not open Settings  [${rows.join(", ")}]`);

/* --- the shifted step 1 press must not reach the M8 ------------------ */
await boot();
resetLogs();
shiftStep(STEP_1);
/* Shift itself IS forwarded (it is the Launchpad's Shift); T1 must not
 * be. T1 is LPP note 101 in the pad map. */
const notesOut = midiOut.external
    .filter(m => m.length >= 4 && (m[1] & 0xF0) === 0x90 || (m[1] & 0xF0) === 0x80)
    .map(m => m[2]);
console.log("     notes sent to the M8:", notesOut.join(", ") || "(none)");
ok(!notesOut.includes(101), "T1 is not forwarded when Shift claimed the button");

/* --- Shift lights the led UNDER step 1, and puts it out again -------- */
/* CC 16, not note 16: the little leds below the step row are CCs, the
 * step buttons above them are notes. Same numbers, different leds. */
await boot();
const HINT_CC = 16;
const hintLed = () => {
    const writes = midiOut.internal.filter(
        m => m.length >= 4 && (m[1] & 0xF0) === 0xB0 && m[2] === HINT_CC);
    return writes.length ? writes[writes.length - 1][3] : null;
};
const stepButtonWrites = () =>
    midiOut.internal.filter(m => m.length >= 4 && (m[1] & 0xF0) === 0x90 && m[2] === STEP_1).length;

resetLogs();
send(CC(MOVE_SHIFT, 127));
/* A BRIGHTNESS, not a palette index: the lamps under the steps are white
 * leds. Writing a low palette index here reads as "almost off" - which
 * is exactly how the first version of this looked. */
ok(hintLed() > 100, `Shift lights the led under step 1 brightly  (CC ${HINT_CC} = ${hintLed()})`);
ok(stepButtonWrites() === 0, "and leaves the step BUTTON's own led alone - that one is T1's");
resetLogs();
send(CC(MOVE_SHIFT, 0));
ok(hintLed() === 0, `releasing Shift puts it out again  (CC ${HINT_CC} = ${hintLed()})`);

/* --- the lamp goes out even when a MENU sees the release -------------- */
/* The shortcut guarantees this case: Shift+step 1 opens Songs, so Songs
 * is the screen that sees Shift let go - not the main dispatch. Each
 * menu tracks Shift for itself, and one that forgets the lamp leaves it
 * burning for as long as the screen is open. */
for (const [name, step] of [["Songs", STEP_1], ["Settings", STEP_2]]) {
    await boot();
    const hintOf = () => {
        const w = midiOut.internal.filter(
            m => m.length >= 4 && (m[1] & 0xF0) === 0xB0 && m[2] === 16);
        return w.length ? w[w.length - 1][3] : null;
    };
    send(CC(MOVE_SHIFT, 127));
    pressStep(step);                   /* the menu is now up and owns input */
    resetLogs();
    send(CC(MOVE_SHIFT, 0));           /* the MENU sees this, not the dispatch */
    ok(hintOf() === 0, `the lamp goes out when ${name} sees Shift released  (${hintOf()})`);
}

/* --- Shift + jog click is no longer a gesture ------------------------ */
await boot();
send(CC(MOVE_SHIFT, 127));
send(CC(MOVE_JOG_CLICK, 127)); send(CC(MOVE_JOG_CLICK, 0));
send(CC(MOVE_SHIFT, 0));
rows = texts();
ok(!rows.includes("Knob Chan"), "Shift+click no longer opens Settings");

/* --- Back leaves the menus entirely, rather than dropping into Settings */
/* Songs used to be a row inside Settings, so Back went "up one" and
 * landed there. It is its own screen now, and there is no up. */
await boot();
shiftStep(STEP_1);
rows = texts();
ok(rows.includes("+ Add Song"), "Songs is open");
send(CC(51, 127)); send(CC(51, 0));            /* Back */
rows = texts();
ok(!rows.includes("+ Add Song"), "Back closes Songs");
ok(!rows.includes("Knob Chan"), `and does NOT land in Settings  [${rows.join(", ")}]`);

/* --- the shortcuts cross straight between the two menus -------------- */
/* This is the case the screens would otherwise swallow: a menu owns the
 * whole surface while it is up and ignores notes, so the press has to be
 * taken before any of them is routed to. */
await boot();
shiftStep(STEP_1);
ok(texts().includes("+ Add Song"), "Songs is open");
shiftStep(STEP_2);
rows = texts();
ok(rows.includes("Knob Chan"), `Shift+step 2 crosses from Songs to Settings  [${rows.join(", ")}]`);
ok(!rows.includes("+ Add Song"), "and Songs is closed behind it");

shiftStep(STEP_1);
rows = texts();
ok(rows.includes("+ Add Song"), `Shift+step 1 crosses back to Songs  [${rows.join(", ")}]`);
ok(!rows.includes("Knob Chan"), "and Settings is closed behind it");

/* Pressing the one you are already on is harmless. */
shiftStep(STEP_1);
ok(texts().includes("+ Add Song"), "pressing the shortcut for the screen you are on keeps it");

/* And from the knob cursor, which is another screen that takes input. */
await boot();
click();                                       /* raise the knob cursor */
shiftStep(STEP_2);
ok(texts().includes("Knob Chan"), "the shortcut also works from the knob cursor");

/* --- a menu no longer swallows the surface --------------------------- */
/* Opening one used to stop the pads, the transport and the mode buttons
 * dead - you could not glance at a setting without the M8 going deaf.
 * Only the wheel, Back and the screen's own Shift gestures are taken. */
const MOVE_PLAY = 85, MOVE_BACK_CC = 51;
const sentNotes = () => midiOut.external
    .filter(m => m.length >= 4 && ((m[1] & 0xF0) === 0x90 || (m[1] & 0xF0) === 0x80))
    .map(m => m[2]);

for (const [name, step] of [["Songs", STEP_1], ["Settings", STEP_2]]) {
    await boot();
    shiftStep(step);
    for (let i = 0; i < 3; i++) tick();

    /* A pad press must still reach the M8. */
    resetLogs();
    send(new Uint8Array([0x90, 92, 127]));
    send(new Uint8Array([0x90, 92, 0]));
    ok(sentNotes().length > 0, `${name}: a pad still reaches the M8  [${sentNotes().join(", ")}]`);

    /* So must Play - LPP note 20. */
    resetLogs();
    send(CC(MOVE_PLAY, 127)); send(CC(MOVE_PLAY, 0));
    ok(sentNotes().includes(20), `${name}: Play still reaches the M8  [${sentNotes().join(", ")}]`);

    /* Back is the screen's, so it must NOT reach the M8 - it closes. */
    resetLogs();
    send(CC(MOVE_BACK_CC, 127)); send(CC(MOVE_BACK_CC, 0));
    ok(!sentNotes().includes(93), `${name}: Back is the screen's, not forwarded`);
    ok(!texts().includes("+ Add Song") && !texts().includes("Knob Chan"),
       `${name}: and Back closed it`);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
