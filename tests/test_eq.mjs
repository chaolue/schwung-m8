/* The EQ branch of the Add Knob wizard. M8 has a 3-band parametric EQ in
 * 128 numbered slots plus one each for the main mix and the three send
 * effects; none of its band rows have published FX mnemonics. */
import { loadUi, drawLog, resetLogs, fileSystem, CC, MOVE_JOG_CLICK, MOVE_JOG_TURN,
         JOG_CW, JOG_CCW } from "./harness.mjs";

let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };

await loadUi();
globalThis.init();
const tick = () => globalThis.tick();
/* The knob page only exists once the M8 has spoken. */
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 10; i++) tick();

const send = (m) => globalThis.onMidiMessageInternal(m);
const click = () => { send(CC(MOVE_JOG_CLICK, 127)); send(CC(MOVE_JOG_CLICK, 0)); };
const turn = (n) => { for (let i = 0; i < Math.abs(n); i++) send(CC(MOVE_JOG_TURN, n > 0 ? JOG_CW : JOG_CCW)); };
const texts = () => { resetLogs(); tick(); return drawLog.filter(d => d.op === "print").map(d => String(d.text)); };

/* Open the wizard on an empty slot: jog cursor, walk to a free one, click. */
click();                       /* raise the cursor */
turn(-64);                     /* wind to the first slot of the song */
turn(7);                       /* slot 8 - empty on a fresh song */
click();                       /* open the Add Knob wizard there */

let rows = texts();
ok(rows.some(t => t === "EQ"), `root offers EQ  [${rows.join(", ")}]`);

/* Walk down to EQ and enter it. */
const rootIdx = rows.indexOf("EQ");
turn(rootIdx);
click();
rows = texts();
console.log("     targets:", rows.join(", "));
for (const want of ["Slot", "Main Mix", "ModFX", "Delay", "Reverb"])
    ok(rows.includes(want), `EQ offers "${want}"`);

/* A named EQ commits straight to the parameter list. */
turn(1);                       /* Main Mix */
click();
rows = texts();
console.log("     params:", rows.slice(0, 8).join(", "), "...");
for (const want of ["Low Gain", "Low Freq", "Low Q"])
    ok(rows.includes(want), `band rows include "${want}"`);
/* TYPE and MODE are selectors on the device and cannot be driven by a
 * CC, so a knob pointed at one would do nothing. */
for (const gone of ["Low Type", "Low Mode"])
    ok(!rows.includes(gone), `"${gone}" is NOT offered - not MIDI assignable`);
/* The value column previews the knob's name, so the list also proves the
 * three stems exist for this band. */
for (const stem of ["LGN", "LFQ", "LQ"])
    ok(rows.includes(stem), `the list previews the stem "${stem}"`);

/* Pick Low Gain and confirm a knob arrives named for the stem. */
click();
for (let i = 0; i < 5; i++) tick();
rows = texts();
ok(rows.some(t => t.includes("LGN")), `a knob named LGN appears  [${rows.join(", ")}]`);

/* --- the Slot path: a hex number, ceilinged at 7F --------------------- */
/* A fresh song: the run above left a knob in the slot we walk to, and a
 * filled slot opens Knob Settings rather than the wizard. */
fileSystem.clear();
await loadUi();
globalThis.init();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 10; i++) tick();

click(); turn(-64); turn(7); click();          /* wizard on an empty slot */
rows = texts();
turn(rows.indexOf("EQ")); click();             /* EQ */
click();                                       /* Slot - the first row */

/* The editor shows "EQ Slot 00" in its header, which drawMenuHeader paints
 * with a pixel font and so is invisible to the print log - drive it and
 * read the result out of the knob name instead. */
click();                                       /* enter the HIGH digit */
turn(15);                                      /* wind it as far as it goes */
click();                                       /* leave the digit */
turn(1); click();                              /* low digit */
turn(15);
click();
turn(1); click();                              /* the accept row */
rows = texts();
console.log("     after winding both digits to maximum:", rows.slice(0, 6).join(", "));
ok(rows.some(t => t === "Low Gain"), "the slot is accepted and the rows appear");

click();                                       /* Low Gain */
for (let i = 0; i < 5; i++) tick();
rows = texts();
/* 7F, not FF: the ceiling held on the high digit. */
ok(rows.some(t => t.includes("LGN7F")), `the slot tops out at 7F  [${rows.join(", ")}]`);
ok(!rows.some(t => t.includes("LGNFF")), "and never reaches FF");

/* --- the readouts, in M8's own units ---------------------------------- */
/* Touching a knob swaps its name for its live value, so the readout is
 * whatever the page prints while the knob is held. */
const KNOB_SLOT = 7;          /* the wizard was opened on the 8th slot */
const readout = () => {
    /* Knob touches are notes 0-7, one per encoder. */
    send(new Uint8Array([0x90, KNOB_SLOT, 127]));
    const shown = texts();
    send(new Uint8Array([0x90, KNOB_SLOT, 0]));
    return shown;
};

async function freshEqKnob(targetRow, paramRow) {
    fileSystem.clear();
    await loadUi();
    globalThis.init();
    globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
    for (let i = 0; i < 10; i++) tick();
    click(); turn(-64); turn(7); click();       /* wizard on an empty slot */
    const root = texts();
    turn(root.indexOf("EQ")); click();
    turn(targetRow); click();
    turn(paramRow); click();
    for (let i = 0; i < 5; i++) tick();
    return readout();
}

/* Main Mix is row 1; Gain, Freq and Q are rows 0, 1 and 2 of the band. */
let shown = await freshEqKnob(1, 0);
ok(shown.some(t => t === "0.00"), `Gain reads 0.00 dB at its default  [${shown.join(", ")}]`);

shown = await freshEqKnob(1, 1);
ok(shown.some(t => t === "100"), `Low Freq reads 100 Hz at its default  [${shown.join(", ")}]`);

shown = await freshEqKnob(1, 2);
ok(shown.some(t => t === "50"), `Q reads 50 at its default  [${shown.join(", ")}]`);

/* THE DIRECTION, which the default alone cannot show - 50 is the middle
 * either way round. Turning the knob UP narrows the band, so Q climbs. */
const KNOB_CC = 78;                            /* encoders are CC 71-78 */
const spin = (n) => { for (let i = 0; i < 300; i++) send(CC(KNOB_CC, n)); };
spin(127);                                     /* fully anticlockwise */
shown = readout();
ok(shown.some(t => t === "01"), `Q bottoms out at 01  [${shown.join(", ")}]`);
spin(1);                                       /* fully clockwise */
shown = readout();
ok(shown.some(t => t === "99"), `Q tops out at 99  [${shown.join(", ")}]`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
