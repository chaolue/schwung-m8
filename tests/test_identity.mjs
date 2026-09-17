/* Novation's programmer's reference gives the real Pro MK3 Application
 * reply as F0 7E 00 06 02 00 20 29 13 01 00 00 <app_version x4> F7.
 * Reporting 00 00 for family/model names the maker but leaves the device
 * unidentified. */
import { loadUi, midiOut, resetLogs, usbFrames, sysexMessages } from "./harness.mjs";
let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };
await loadUi();
for (let i = 0; i < 20; i++) globalThis.tick();
resetLogs();
globalThis.onMidiMessageExternal(new Uint8Array([0xF0, 0x7E, 0x7F]));
globalThis.onMidiMessageExternal(new Uint8Array([0x06, 0x01, 0xF7]));
const frames = usbFrames(midiOut.external);
ok(frames.length > 0, "a Device Inquiry draws a reply");
const b = sysexMessages(frames)[0] ?? [];
console.log("     reply: " + b.map(x => x.toString(16).padStart(2, "0")).join(" "));
ok(b[0] === 0xF0 && b[1] === 0x7E && b[3] === 0x06 && b[4] === 0x02, "is a Device Inquiry reply (06 02)");
ok(b[5] === 0x00 && b[6] === 0x20 && b[7] === 0x29, "manufacturer is Novation (00 20 29)");
ok(b[8] === 0x13 && b[9] === 0x01, "family/model is Launchpad Pro MK3 Application (13 01)");
ok(b.length === 17 && b[16] === 0xF7, "17 bytes, terminated with F7");
ok(b.slice(12, 16).every(x => x <= 9), "app_version is four single digits");
ok(frames.every(f => ((f[0] >> 4) & 0xF) === 2), "every frame goes out on cable 2");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
