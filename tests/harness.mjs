/* Loads the REAL src/ui.js in Node by rewriting its device import paths to
 * the real Schwung checkout and stubbing the device globals. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/* Captured before Date.now is replaced below, so the module cache-buster
 * still gets a genuinely increasing number. */
const realNow = Date.now.bind(Date);

/* The module under test is this repo; the shared modules it imports live
 * in the Schwung checkout beside it. SCHWUNG_SRC overrides that for a
 * checkout kept somewhere else. */
/* fileURLToPath, not url.pathname: the checkout lives under "Ableton
 * Move", and a pathname percent-encodes the space into %20, which then
 * matches no directory on disk. */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const M8 = path.resolve(HERE, "..");
const SCHWUNG = process.env.SCHWUNG_SRC || path.resolve(M8, "../schwung/src");
const OUT = path.join(HERE, "ui_under_test.mjs");

if (!fs.existsSync(path.join(SCHWUNG, "shared"))) {
    console.error(
        `Cannot find Schwung's shared modules at ${SCHWUNG}/shared\n` +
        `Clone schwung beside this repo, or set SCHWUNG_SRC to its src directory.`);
    process.exit(2);
}

export const drawLog = [];
export const exits = [];
export const padBlock = [];
export const midiOut = { internal: [], external: [] };
export const fileSystem = new Map();

export function resetLogs() {
    drawLog.length = 0;
    midiOut.internal.length = 0;
    midiOut.external.length = 0;
}

function installGlobals() {
    globalThis.print = (x, y, text, color) => {
        drawLog.push({ op: "print", x, y, text, color });
        if (x < -20 || y < 0 || x > 140 || y > 70) throw new Error(`print OOB: ${x},${y} "${text}"`);
    };
    globalThis.fill_rect = (x, y, w, h, color) => {
        drawLog.push({ op: "fillRect", x, y, w, h, color });
        if (x < 0 || y < 0 || x + w > 128 || y + h > 64) throw new Error(`fill_rect OOB: ${x},${y},${w},${h}`);
    };
    globalThis.draw_rect = globalThis.fill_rect;
    globalThis.set_pixel = (x, y, color) => { drawLog.push({ op: "setPixel", x, y, color }); };
    globalThis.clear_screen = () => { drawLog.push({ op: "clear" }); };
    globalThis.text_width = (t) => String(t).length * 6;
    globalThis.move_midi_internal_send = (m) => { midiOut.internal.push([...m]); return true; };
    globalThis.move_midi_external_send = (m) => { midiOut.external.push([...m]); return true; };
    globalThis.host_ensure_dir = () => true;
    padBlock.length = 0;
    globalThis.host_pad_block = (on) => { padBlock.push(on); };
    exits.length = 0;
    globalThis.host_exit_module = () => { exits.push("exit"); };
    globalThis.console = console;
}

/* A CLOCK THAT MOVES WITH THE TICKS.
 *
 * The module times its pad flash in milliseconds, because the device's
 * tick rate is not constant - a heavy screen drops frames. Tests tick as
 * fast as Node can, so against a real clock almost no time would pass
 * and nothing timed would ever fire.
 *
 * So Date.now() is replaced with a clock that advances one device frame
 * per tick(), which is what the module would see on hardware. The test
 * files share the realm, so they read the same clock - which keeps the
 * snapshot-staleness tests coherent with it too. */
export const FRAME_MS = 16;
let fakeNow = 1789000000000;            /* a fixed, plausible epoch */
export function advanceClock(ms) { fakeNow += ms; }
export function clockNow() { return fakeNow; }

export async function loadUi() {
    installGlobals();
    let src = fs.readFileSync(path.join(M8, "src/ui.js"), "utf8");
    src = src.replace(/'\/data\/UserData\/schwung\/shared\//g, `'${SCHWUNG}/shared/`);
    src = src.replace(/import \* as std from "std";/, `const std = {
            loadFile: (p) => (globalThis.__fs.has(p) ? globalThis.__fs.get(p) : null),
            parseExtJSON: (s) => JSON.parse(s),
            open: (p) => ({ puts(t) { globalThis.__fs.set(p, t); }, close() {} }),
        };`);
    globalThis.__fs = fileSystem;
    fs.writeFileSync(OUT, src);
    const mod = await import(pathToFileURL(OUT).href + `?t=${realNow()}`);
    /* Patch the clock and step it from tick(), AFTER the module has
     * defined its own tick. */
    Date.now = () => fakeNow;
    const moduleTick = globalThis.tick;
    if (typeof moduleTick === "function") {
        globalThis.tick = function () {
            fakeNow += FRAME_MS;
            return moduleTick.apply(this, arguments);
        };
    }
    return mod;
}

export const CC = (n, v) => new Uint8Array([0xb0, n, v]);
export const NOTE_ON = (n) => new Uint8Array([0x90, n, 127]);
export const NOTE_OFF = (n) => new Uint8Array([0x90, n, 0]);
export const MOVE_SHIFT = 49, MOVE_JOG_TURN = 14, MOVE_JOG_CLICK = 3;
export const JOG_CW = 1, JOG_CCW = 127;

/* Split concatenated 4-byte USB-MIDI frames out of each send() call. */
export function usbFrames(messages) {
    const frames = [];
    for (const m of messages)
        for (let i = 0; i + 3 < m.length; i += 4) frames.push(m.slice(i, i + 4));
    return frames;
}
export function sysexMessages(frames) {
    const out = []; let cur = [];
    for (const f of frames) {
        const cin = f[0] & 0x0F;
        const n = { 4: 3, 7: 3, 6: 2, 5: 1 }[cin] ?? 0;
        for (let i = 0; i < n; i++) cur.push(f[1 + i]);
        if (cin !== 0x4) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
}

export function openKnobSlot(slot, page = 0) {
    const send = (m) => globalThis.onMidiMessageInternal(m);
    send(CC(MOVE_JOG_CLICK, 127)); send(CC(MOVE_JOG_CLICK, 0));
    for (let i = 0; i < 64; i++) send(CC(MOVE_JOG_TURN, JOG_CCW));
    for (let i = 0; i < page * 8 + slot; i++) send(CC(MOVE_JOG_TURN, JOG_CW));
    send(CC(MOVE_JOG_CLICK, 127)); send(CC(MOVE_JOG_CLICK, 0));
}
