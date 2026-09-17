/* The Songs menu: Copy duplicates, Delete asks first, and the last song
 * cannot be deleted at all. */
import { loadUi, drawLog, midiOut, resetLogs, fileSystem, CC, MOVE_JOG_CLICK,
         MOVE_JOG_TURN, JOG_CW, JOG_CCW, MOVE_SHIFT } from "./harness.mjs";

let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };

const MOVE_BACK = 51, MOVE_MENU = 50, MOVE_CAPTURE = 52;
const MOVE_COPY = 60, MOVE_DELETE = 119;

const send = (m) => globalThis.onMidiMessageInternal(m);
const tick = () => globalThis.tick();
const press = (cc) => { send(CC(cc, 127)); send(CC(cc, 0)); };
/* Copy and Delete need Shift here, the same as on the knob cursor. */
const shiftPress = (cc) => {
    send(CC(MOVE_SHIFT, 127));
    press(cc);
    send(CC(MOVE_SHIFT, 0));
};
const click = () => press(MOVE_JOG_CLICK);
const turn = (n) => { for (let i = 0; i < Math.abs(n); i++) send(CC(MOVE_JOG_TURN, n > 0 ? JOG_CW : JOG_CCW)); };
const texts = () => { resetLogs(); tick(); return drawLog.filter(d => d.op === "print").map(d => String(d.text)); };

/* Songs has its own way in now: Shift + step 1, which is note 16 - the
 * Launchpad's T1, intercepted before the grid can forward it. */
const STEP_1 = 16;
function pressStep(note) {
    send(new Uint8Array([0x90, note, 127]));
    send(new Uint8Array([0x90, note, 0]));
}
function shiftStep(note) {
    send(CC(MOVE_SHIFT, 127));
    pressStep(note);
    send(CC(MOVE_SHIFT, 0));
}

async function openSongs() {
    await loadUi();
    globalThis.init();
    globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
    for (let i = 0; i < 10; i++) tick();
    shiftStep(STEP_1);
    for (let i = 0; i < 3; i++) tick();
    return texts();
}

/* --- Copy duplicates ------------------------------------------------- */
fileSystem.clear();
let rows = await openSongs();
ok(rows.includes("+ Add Song"), `the Songs list is open  [${rows.join(", ")}]`);
ok(rows.filter(t => t === "New Song").length === 1, "one song to start with");

turn(-8); turn(1);                     /* onto the first song */
shiftPress(MOVE_COPY);
rows = texts();
console.log("     after Copy:", rows.join(", "));
ok(rows.includes("New Song 2"), "Copy duplicates the song, numbering the name");
ok(rows.includes("New Song"), "and leaves the original alone");

/* --- Delete asks before acting --------------------------------------- */
shiftPress(MOVE_DELETE);
rows = texts();
console.log("     after Delete:", rows.join(", "));
ok(rows.includes("Cancel") && rows.includes("Delete"),
   "Delete opens a question rather than acting");

/* Back cancels, and nothing is lost. */
press(MOVE_BACK);
rows = texts();
ok(!rows.includes("Cancel"), "Back closes the question");
ok(rows.filter(t => t.startsWith("New Song")).length === 2, "both songs still there");

/* The cursor starts on Cancel, so a click without moving keeps the song. */
shiftPress(MOVE_DELETE);
click();
rows = texts();
ok(rows.filter(t => t.startsWith("New Song")).length === 2,
   "clicking straight away picks Cancel - the cursor never starts on Delete");

/* Moving onto Delete and clicking does remove it. */
shiftPress(MOVE_DELETE);
turn(1);
click();
rows = texts();
console.log("     after confirming:", rows.join(", "));
ok(rows.filter(t => t.startsWith("New Song")).length === 1, "confirmed delete removes the song");

/* --- the last song cannot go ----------------------------------------- */
turn(-8); turn(1);
shiftPress(MOVE_DELETE);
rows = texts();
console.log("     delete on the last song:", rows.join(", "));
ok(!rows.includes("Delete"), "no Delete option is offered for the only song");
ok(rows.includes("OK"), "it says so instead of doing nothing");
press(MOVE_BACK);
rows = texts();
ok(rows.filter(t => t.startsWith("New Song")).length === 1, "and the song survives");

/* --- a copy carries the KNOBS, not just the name ---------------------- */
/* Read songs.json rather than driving the screens: what is on disk is
 * what a copy has to reproduce. The knob is added BEFORE the Songs menu
 * is opened, so this never has to navigate back out of it. */
fileSystem.clear();
await loadUi();
globalThis.init();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 10; i++) tick();

/* Knobs through the wizard: cursor to an empty slot, then Generic >
 * Envelope (3). An envelope rather than "Knob", for two reasons - it
 * commits straight away where "Knob" stops to ask for a name, and it
 * places a GRAPHIC, so the copy has a group id to regenerate. */
click(); turn(-64); click();
let list = texts();
turn(list.indexOf("Generic")); click();
list = texts();
turn(list.indexOf("Envelope (3)")); click();
for (let i = 0; i < 10; i++) tick();

const songsPath = "/data/UserData/schwung/modules/overtake/m8/songs.json";
const knobCount = (song) =>
    song.pages.reduce((n, pg) => n + pg.knobs.filter(Boolean).length, 0);

globalThis.onUnload();
let saved = JSON.parse(fileSystem.get(songsPath) || "{}");
ok(knobCount(saved.songs[0]) >= 1, `the song has a knob to copy  (${knobCount(saved.songs[0])})`);

/* Songs, then Copy the first song. */
shiftStep(STEP_1);
for (let i = 0; i < 3; i++) tick();
turn(-8); turn(1);
shiftPress(MOVE_COPY);
globalThis.onUnload();
saved = JSON.parse(fileSystem.get(songsPath) || "{}");

ok(saved.songs.length === 2, `two songs after Copy  (${saved.songs.length})`);
ok(knobCount(saved.songs[1]) === knobCount(saved.songs[0]),
   `the copy carries the same knobs  (${knobCount(saved.songs[1])} vs ${knobCount(saved.songs[0])})`);
ok(saved.songs[0].id !== saved.songs[1].id, "the copy has an id of its own");

const groups = (song) => song.pages.flatMap(pg =>
    pg.knobs.filter(k => k && k.viz && k.viz.group).map(k => k.viz.group));
/* Guard against the check below passing because there is nothing to
 * check: an envelope is a graphic, so there must be group ids here. */
ok(groups(saved.songs[0]).length > 0,
   `the original really does carry a graphic group  [${groups(saved.songs[0]).join(", ")}]`);
const shared = groups(saved.songs[0]).filter(g => groups(saved.songs[1]).includes(g));
ok(shared.length === 0, `no graphic group id is shared between the two  [${shared.join(", ")}]`);

/* --- unshifted, neither button acts ---------------------------------- */
/* They belong to the M8 without Shift, and the two screens that offer
 * them should agree on the grip. */
fileSystem.clear();
rows = await openSongs();
turn(-8); turn(1);                     /* onto the first song */
const songCount = () => texts().filter(t => t.startsWith("New Song")).length;
ok(songCount() === 1, "one song to begin with");
press(MOVE_COPY);
ok(songCount() === 1, "a plain Copy does not duplicate");
press(MOVE_DELETE);
rows = texts();
ok(!rows.includes("Cancel"), `a plain Delete does not open the question  [${rows.join(", ")}]`);

/* --- and the lamps say so -------------------------------------------- */
const ledOf = (cc) => {
    const w = midiOut.internal.filter(
        m => m.length >= 4 && (m[1] & 0xF0) === 0xB0 && m[2] === cc);
    return w.length ? w[w.length - 1][3] : null;
};
resetLogs();
send(CC(MOVE_SHIFT, 127));
tick();
ok(ledOf(MOVE_COPY) > 100 && ledOf(MOVE_DELETE) > 100,
   `Shift over a song lights Copy and Delete  (${ledOf(MOVE_COPY)}, ${ledOf(MOVE_DELETE)})`);
resetLogs();
send(CC(MOVE_SHIFT, 0));
tick();
ok(ledOf(MOVE_COPY) === 0 && ledOf(MOVE_DELETE) === 0, "and releasing hands them back");

/* "+ Add Song" is not a song, so neither is on offer there. */
turn(-8);                              /* row 0 */
tick();
resetLogs();
send(CC(MOVE_SHIFT, 127));
for (let i = 0; i < 3; i++) tick();
ok(!(ledOf(MOVE_COPY) > 100), `on "+ Add Song" they stay dark  (${ledOf(MOVE_COPY)})`);
send(CC(MOVE_SHIFT, 0));

/* --- Capture no longer makes a song ---------------------------------- */
/* It is the Launchpad's Sequencer button, so it belongs to the M8; the
 * "+ Add Song" row is the way to make one. */
fileSystem.clear();
await openSongs();
ok(songCount() === 1, "one song to begin with");
press(MOVE_CAPTURE);
ok(songCount() === 1, "Capture does not create a song");
turn(-8); click();                     /* "+ Add Song" still does */
/* That opens the rename keyboard over the list, so the count comes from
 * what was saved rather than from what is on screen. */
globalThis.onUnload();
const saved2 = JSON.parse(fileSystem.get(
    "/data/UserData/schwung/modules/overtake/m8/songs.json") || "{}");
ok(saved2.songs.length === 2, `the + Add Song row still does  (${saved2.songs.length})`);
/* That left the name keyboard up, and text_entry.mjs is shared state
 * that loadUi() does NOT reset - Node caches it, and only ui.js is
 * re-imported with a cache-buster. Left open it would swallow the step
 * shortcut in the next block, which is skipped while the pads are
 * letters. So it is dismissed here. */
press(MOVE_BACK);
for (let i = 0; i < 3; i++) tick();
ok(texts().includes("+ Add Song"), "the keyboard is dismissed and the list is back");

/* --- rename is Shift+click, not Menu --------------------------------- */
fileSystem.clear();
rows = await openSongs();
ok(rows.includes("+ Add Song"), `the list is open before we start  [${rows.join(", ")}]`);
turn(-8); turn(1);                     /* onto the song */
ok(texts().includes("+ Add Song"), "still open after moving the cursor");
press(MOVE_MENU);
rows = texts();
ok(rows.includes("New Song"), `Menu no longer renames  [${rows.join(", ")}]`);

send(CC(MOVE_SHIFT, 127)); click(); send(CC(MOVE_SHIFT, 0));
rows = texts();
/* The name keyboard is a pad grid with its own header, so the song list
 * is gone from the screen once it opens. */
ok(!rows.includes("+ Add Song"), `Shift+click opens the rename keyboard  [${rows.join(", ")}]`);

/* --- the bar swaps for Shift ----------------------------------------- */
/* Its text is the 4x5 pixel font and never reaches the print log, so the
 * ink in the chrome band is what gets measured.
 *
 * The rename block above left the name keyboard up, and text_entry.mjs
 * is shared state loadUi() does not reset - left open it swallows the
 * step shortcut, openSongs() silently does nothing, and this would
 * measure the knob page instead. Which it did, and passed, because that
 * page happened to show three hints too. */
press(MOVE_BACK);
for (let i = 0; i < 3; i++) tick();
fileSystem.clear();
await openSongs();
const barInk = () => {
    resetLogs();
    tick();
    return drawLog
        .filter(d => (d.op === "fillRect" || d.op === "setPixel") && d.y >= 55)
        .map(d => `${d.op}:${d.x},${d.y},${d.w ?? ""},${d.h ?? ""}`)
        .join("|");
};
const pillCount = () => {
    resetLogs();
    tick();
    return drawLog.filter(d => d.op === "fillRect" && d.y >= 55 && d.w >= 8 && d.h >= 6).length;
};
ok(texts().includes("+ Add Song"),
   `the song list really is the screen being measured  [${texts().join(", ")}]`);
const plainBar = barInk();
ok(plainBar.length > 0, `the song list has a bar  (${plainBar.split("|").length} marks)`);
ok(pillCount() === 3, `all three hints fit  (${pillCount()} drawn)`);
send(CC(MOVE_SHIFT, 127));
const shiftBar = barInk();
ok(shiftBar !== plainBar, "holding Shift swaps it for copy and delete");
ok(pillCount() === 3, `and all three of the Shift set fit  (${pillCount()} drawn)`);
send(CC(MOVE_SHIFT, 0));
ok(barInk() === plainBar, "and releasing puts it back");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
