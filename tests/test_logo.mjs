/* The Launchpad's logo, which the M8 lights to show LIVE MODE, is CC 31
 * on the Move - one of the little white lamps under the step row, not
 * the step button above it. A white led reads the byte as a brightness,
 * so the M8's colour has to be translated rather than passed through. */
import { loadUi, midiOut, resetLogs, CC } from "./harness.mjs";

let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };

const LOGO_CC = 31;
const tick = () => globalThis.tick();
const logo = () => {
    const w = midiOut.internal.filter(
        m => m.length >= 4 && (m[1] & 0xF0) === 0xB0 && m[2] === LOGO_CC);
    return w.length ? w[w.length - 1][3] : null;
};

await loadUi();
globalThis.init();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 40, 5]));
for (let i = 0; i < 10; i++) tick();

/* LPP note 99 is the logo. The M8 lights it with a colour; whatever the
 * colour, the lamp can only be a brightness. */
for (const colour of [21, 5, 3, 127]) {
    resetLogs();
    globalThis.onMidiMessageExternal(new Uint8Array([0x90, 99, colour]));
    ok(logo() === 124, `M8 colour ${colour} lights the logo fully  (${logo()})`);
}

resetLogs();
globalThis.onMidiMessageExternal(new Uint8Array([0x90, 99, 0]));
ok(logo() === 0, `and colour 0 puts it out  (${logo()})`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
