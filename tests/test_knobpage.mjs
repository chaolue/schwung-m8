/* The knob page's layout: the grid is shortened to leave room for the
 * hint bar, and our own labels for graphic cells must land on the SAME
 * line as the labels renderPage draws for ordinary dials. */
import { loadUi, drawLog, fileSystem, resetLogs, CC, MOVE_SHIFT, MOVE_JOG_CLICK,
         MOVE_JOG_TURN, JOG_CW, JOG_CCW } from "./harness.mjs";

let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };

const send = (m) => globalThis.onMidiMessageInternal(m);
const tick = () => globalThis.tick();
const prints = () => { resetLogs(); tick(); return drawLog.filter(d => d.op === "print"); };
const texts = () => prints().map(d => String(d.text));
const click = () => { send(CC(MOVE_JOG_CLICK, 127)); send(CC(MOVE_JOG_CLICK, 0)); };
const turn = (n) => { for (let i = 0; i < Math.abs(n); i++) send(CC(MOVE_JOG_TURN, n > 0 ? JOG_CW : JOG_CCW)); };

await loadUi();
globalThis.init();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 10; i++) tick();

/* Slot 1: a FILTER - a graphic, whose two cells renderPage leaves
 * unlabelled and which this module labels itself. */
click(); turn(-64); click();
let l = texts();
turn(l.indexOf("Generic")); click();
l = texts();
turn(l.indexOf("Filter Lowpass")); click();
for (let i = 0; i < 8; i++) tick();

/* Slot 3: an ordinary DIAL, labelled by renderPage. */
click(); turn(-64); turn(2); click();
l = texts();
turn(l.indexOf("EQ")); click();
turn(1); click();                      /* Main Mix */
click();                               /* Low Gain */
for (let i = 0; i < 8; i++) tick();

const rows = prints();
const yOf = (text) => { const d = rows.find(p => String(p.text) === text); return d ? d.y : null; };
console.log("     labels:", rows.filter(p => p.y > 10).map(p => `${p.text}@${p.y}`).join(" "));

ok(yOf("CUT") !== null && yOf("LGN") !== null,
   `both a graphic label and a dial label are on screen  [${texts().join(", ")}]`);
ok(yOf("CUT") === yOf("LGN"),
   `they share a baseline  (graphic ${yOf("CUT")}, dial ${yOf("LGN")})`);

/* --- the hint bar, and what Shift does to it ------------------------- */
/* The bar's text is drawn with the 4x5 PIXEL font, so none of it reaches
 * the print log - the same reason a menu header is invisible to these
 * assertions. What it does leave is ink in the chrome band, so that is
 * what gets measured: how much, and whether it changes. */
const CHROME_TOP = 55;
const barInk = () => {
    resetLogs();
    tick();
    return drawLog
        .filter(d => (d.op === "fillRect" || d.op === "setPixel") && d.y >= CHROME_TOP)
        .map(d => `${d.op}:${d.x},${d.y},${d.w ?? ""},${d.h ?? ""}`)
        .join("|");
};

const plain = barInk();
ok(plain.length > 0, `the bar is drawn in the chrome band  (${plain.split("|").length} marks)`);

send(CC(MOVE_SHIFT, 127));
const shifted = barInk();
ok(shifted.length > 0, `and still drawn while Shift is held  (${shifted.split("|").length} marks)`);
ok(shifted !== plain, "holding Shift changes what the bar says");

send(CC(MOVE_SHIFT, 0));
ok(barInk() === plain, "releasing Shift puts the first set back");

/* Nothing of the GRID may stray into the band. */
resetLogs();
tick();
const strays = drawLog.filter(d => d.op === "print" && d.y >= CHROME_TOP);
ok(strays.length === 0,
   `no grid label strays into the bar  [${strays.map(d => `${d.text}@${d.y}`).join(", ")}]`);

/* --- all THREE hints must actually be drawn -------------------------- */
/* drawFooter lays the pairs out left to right and silently stops when
 * the next one will not fit, so a set that is a few pixels too wide
 * loses its last hint with no other sign. Each pair opens with one wide
 * pill - the inverted box around its key - so counting those counts the
 * hints that made it onto the panel. */
const pillCount = () => {
    resetLogs();
    tick();
    return drawLog.filter(d => d.op === "fillRect" && d.y >= 55 && d.w >= 8 && d.h >= 6).length;
};
/* ONE page, so there is nowhere to page to and the wheel hint is not
 * offered - two hints, not three. */
ok(pillCount() === 2, `a single-page song drops the page hint  (${pillCount()} drawn)`);
send(CC(MOVE_SHIFT, 127));
ok(pillCount() === 3, `and all three of the Shift set  (${pillCount()} drawn)`);
send(CC(MOVE_SHIFT, 0));

/* --- the cursor gets its own bar ------------------------------------- */
/* The cursor is an overlay on this page, so it shares the bar - and the
 * wheel means something different under it: knobs, not pages. */
const page = barInk();
click();                                /* raise the knob cursor */
const cursor = barInk();
ok(cursor !== page, "raising the cursor changes the bar");

send(CC(MOVE_SHIFT, 127));
const cursorShift = barInk();
ok(cursorShift !== cursor, "and Shift changes it again, for copy and delete");
send(CC(MOVE_SHIFT, 0));
ok(barInk() === cursor, "releasing Shift restores the cursor's own set");

send(CC(51, 127)); send(CC(51, 0));     /* Back closes the cursor */
for (let i = 0; i < 3; i++) tick();
ok(barInk() === page, "closing the cursor puts the page's bar back");

/* --- a song WITH a second page keeps the hint ------------------------ */
/* Written straight into songs.json rather than added through the wizard
 * eight times: what decides the hint is how many pages the song has, and
 * a full page plus the spare ensureSparePage adds is exactly that. */
const knob = (i) => ({
    name: `K${i}`, cc: i + 1, value: 64, default: 64, mode: 0, display: 1,
});
fileSystem.set("/data/UserData/schwung/modules/overtake/m8/songs.json", JSON.stringify({
    schema: 2,
    activeSongId: "s1",
    settings: {},
    songs: [{
        id: "s1", name: "Full",
        pages: [
            { name: "", knobs: Array.from({ length: 8 }, (_, i) => knob(i)) },
            { name: "", knobs: new Array(8).fill(null) },
        ],
    }],
}));
await loadUi();
globalThis.init();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 10; i++) tick();
ok(pillCount() === 2,
   `one FULL page plus its empty spare is still one page of knobs  (${pillCount()} drawn)`);

/* Two pages that both hold knobs is what earns the hint. */
fileSystem.set("/data/UserData/schwung/modules/overtake/m8/songs.json", JSON.stringify({
    schema: 2, activeSongId: "s1", settings: {},
    songs: [{
        id: "s1", name: "Two",
        pages: [
            { name: "", knobs: Array.from({ length: 8 }, (_, i) => knob(i)) },
            { name: "", knobs: [knob(8), null, null, null, null, null, null, null] },
        ],
    }],
}));
await loadUi();
globalThis.init();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 10; i++) tick();
ok(pillCount() === 3, `two pages of knobs shows the page hint  (${pillCount()} drawn)`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
