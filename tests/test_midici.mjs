/* A real Pro MK3 does not speak MIDI-CI: it hears Discovery and says
 * nothing. We match that, still introduce ourselves, and still damp the
 * retry - without the damping the introduction becomes a banner loop. */
import { loadUi, midiOut, resetLogs, usbFrames, sysexMessages } from "./harness.mjs";
let fails = 0;
const ok = (c, w) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) fails++; };
await loadUi();
for (let i = 0; i < 20; i++) globalThis.tick();
const DISCOVERY = [0xF0,0x7E,0x7F,0x0D,0x70,0x02,0x33,0x0D,0x61,0x3A,0x7F,0x7F,0x7F,0x7F,
                   0x11,0x00,0x00,0x01,0x00,0x01,0x00,0x02,0x00,0x00,0x00,0x1C,0x00,0x00,
                   0x01,0x00,0x03,0xF7];
resetLogs();
for (let i = 0; i < DISCOVERY.length; i += 3)
    globalThis.onMidiMessageExternal(new Uint8Array(DISCOVERY.slice(i, i + 3)));
const msgs = sysexMessages(usbFrames(midiOut.external));
for (const m of msgs) console.log("     sent: " + m.map(x => x.toString(16).padStart(2, "0")).join(" "));
ok(msgs.filter(m => m[3] === 0x0D && m[4] === 0x71).length === 0,
   "no MIDI-CI Discovery Reply - a real LPP stays silent");
const ids = msgs.filter(m => m[3] === 0x06 && m[4] === 0x02);
ok(ids.length === 1, "we still introduce ourselves once");
ok(ids.length === 1 && ids[0][8] === 0x13 && ids[0][9] === 0x01, "and it names the Pro MK3 (13 01)");
resetLogs();
for (let i = 0; i < 400; i++) globalThis.tick();
ok(sysexMessages(usbFrames(midiOut.external)).filter(m => m[3] === 0x06).length === 0,
   "no banner loop: the retry is damped after Discovery");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
