/* Shift + jog in the knob cursor carries the knob with the cursor - the
 * same gesture the song list uses to reorder songs. A knob that belongs
 * to a graphic takes the whole picture with it. */
import { loadUi, drawLog, fileSystem, midiOut, resetLogs, CC, MOVE_SHIFT,
         MOVE_JOG_CLICK, MOVE_JOG_TURN, JOG_CW, JOG_CCW } from "./harness.mjs";

let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };

const send = (m) => globalThis.onMidiMessageInternal(m);
const tick = () => globalThis.tick();
const texts = () => { resetLogs(); tick(); return drawLog.filter(d => d.op === "print").map(d => String(d.text)); };
const click = () => { send(CC(MOVE_JOG_CLICK, 127)); send(CC(MOVE_JOG_CLICK, 0)); };
const turn = (n) => { for (let i = 0; i < Math.abs(n); i++) send(CC(MOVE_JOG_TURN, n > 0 ? JOG_CW : JOG_CCW)); };
const shiftTurn = (n) => { send(CC(MOVE_SHIFT, 127)); turn(n); send(CC(MOVE_SHIFT, 0)); };

const SONGS = "/data/UserData/schwung/modules/overtake/m8/songs.json";
const slots = () => {
    globalThis.onUnload();
    const j = JSON.parse(fileSystem.get(SONGS) || "{}");
    return j.songs[0].pages[0].knobs.map(k => (k ? k.name : "."));
};

async function boot() {
    await loadUi();
    globalThis.init();
    globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
    for (let i = 0; i < 10; i++) tick();
}

/* Add a knob at a known slot through the wizard. `row` picks the Generic
 * entry: 1 is the 3-knob envelope, 0 is the plain "Knob" (which stops to
 * ask for a name, so it is not used here). */
function addGeneric(slot, row) {
    click(); turn(-64); turn(slot); click();
    let list = texts();
    turn(list.indexOf("Generic")); click();
    list = texts();
    turn(row); click();
    for (let i = 0; i < 8; i++) tick();
}

/* --- a lone knob moves one slot ------------------------------------- */
fileSystem.clear();
await boot();
addGeneric(0, 1);                      /* an envelope at slots 1-3 */
let before = slots();
console.log("     before:", before.join(" "));
ok(before.filter(n => n !== ".").length === 3, "three knobs placed");

/* Put the cursor on the group and shift-turn it forward. */
click(); turn(-64); turn(0);
shiftTurn(1);
let after = slots();
console.log("     after Shift+jog:", after.join(" "));
ok(after.join(" ") !== before.join(" "), "Shift+jog moved something");

/* The three stay adjacent and in order - the picture travels whole. */
const names = before.filter(n => n !== ".");
const idx = names.map(n => after.indexOf(n));
ok(idx.every(i => i >= 0), "every knob of the graphic survived the move");
ok(idx[1] === idx[0] + 1 && idx[2] === idx[1] + 1,
   `the graphic stayed together and in order  [${idx.join(", ")}]`);

/* --- a plain jog still walks the cursor, moving nothing -------------- */
before = slots();
turn(1);
after = slots();
ok(after.join(" ") === before.join(" "), "an unshifted jog moves the cursor, not the knob");

/* --- an empty slot has nothing to move ------------------------------ */
fileSystem.clear();
await boot();
before = slots();
click(); turn(-64); turn(5);           /* an empty slot */
shiftTurn(1);
after = slots();
ok(after.join(" ") === before.join(" "), "Shift+jog on an empty slot changes nothing");

/* --- Shift+Copy duplicates, Shift+Delete removes --------------------- */
const MOVE_COPY = 60, MOVE_DELETE = 119;
const shiftPress = (cc) => {
    send(CC(MOVE_SHIFT, 127));
    send(CC(cc, 127)); send(CC(cc, 0));
    send(CC(MOVE_SHIFT, 0));
};

fileSystem.clear();
await boot();
addGeneric(0, 1);                      /* an envelope at slots 1-3 */
click(); turn(-64); turn(0);           /* cursor onto it */

before = slots();
shiftPress(MOVE_COPY);
after = slots();
console.log("     after Shift+Copy:", after.join(" "));
ok(after.filter(n => n !== ".").length === 6, "Shift+Copy duplicates the whole graphic");

/* Fresh CCs: two knobs on one CC would move together on the M8. */
globalThis.onUnload();
let page = JSON.parse(fileSystem.get(SONGS)).songs[0].pages[0].knobs.filter(Boolean);
let ccs = page.map(k => k.cc);
ok(new Set(ccs).size === ccs.length, `every CC is distinct  [${ccs.join(", ")}]`);

/* And a new group id, or the two pictures would be one. */
const groups = new Set(page.filter(k => k.viz).map(k => k.viz.group));
ok(groups.size === 2, `the copy is its own graphic  (${groups.size} groups)`);

/* Delete takes one slot, leaving the rest where they are - the same as
 * Remove Knob in Knob Settings. */
before = slots();
shiftPress(MOVE_DELETE);
after = slots();
console.log("     after Shift+Delete:", after.join(" "));
ok(after.filter(n => n !== ".").length === before.filter(n => n !== ".").length - 1,
   "Shift+Delete removes exactly one knob");

/* Unshifted, neither does anything here. */
before = slots();
send(CC(MOVE_COPY, 127)); send(CC(MOVE_COPY, 0));
send(CC(MOVE_DELETE, 127)); send(CC(MOVE_DELETE, 0));
after = slots();
ok(after.join(" ") === before.join(" "), "unshifted Copy and Delete change nothing");

/* --- Copy and Delete light up when they are on offer ----------------- */
const ledOf = (cc) => {
    const w = midiOut.internal.filter(
        m => m.length >= 4 && (m[1] & 0xF0) === 0xB0 && m[2] === cc);
    return w.length ? w[w.length - 1][3] : null;
};

fileSystem.clear();
await boot();
addGeneric(0, 1);                      /* knobs at slots 1-3 */
click(); turn(-64); turn(0);           /* cursor onto a filled slot */

resetLogs();
send(CC(MOVE_SHIFT, 127));
tick();
ok(ledOf(MOVE_COPY) > 100 && ledOf(MOVE_DELETE) > 100,
   `Shift over a knob lights Copy and Delete  (${ledOf(MOVE_COPY)}, ${ledOf(MOVE_DELETE)})`);

resetLogs();
send(CC(MOVE_SHIFT, 0));
tick();
ok(ledOf(MOVE_COPY) === 0 && ledOf(MOVE_DELETE) === 0,
   `releasing Shift hands them back  (${ledOf(MOVE_COPY)}, ${ledOf(MOVE_DELETE)})`);

/* An empty slot offers neither, so neither should claim to. */
turn(4);                               /* onto an empty slot */
tick();
resetLogs();
send(CC(MOVE_SHIFT, 127));
for (let i = 0; i < 3; i++) tick();
ok(!(ledOf(MOVE_COPY) > 100), `on an empty slot they stay dark  (${ledOf(MOVE_COPY)})`);
send(CC(MOVE_SHIFT, 0));

/* And nothing is offered when the cursor is not even up. */
send(CC(51, 127)); send(CC(51, 0));    /* Back - close the cursor */
for (let i = 0; i < 3; i++) tick();
resetLogs();
send(CC(MOVE_SHIFT, 127));
for (let i = 0; i < 3; i++) tick();
ok(!(ledOf(MOVE_COPY) > 100), "with the cursor closed, Shift lights neither");
send(CC(MOVE_SHIFT, 0));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
