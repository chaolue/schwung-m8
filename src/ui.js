/*
 * M8 Launchpad Pro Emulator Module
 *
 * Emulates a Novation Launchpad Pro for the Dirtywave M8.
 * Maps Move pads/buttons to LPP protocol and handles bidirectional MIDI.
 */

import * as std from "std";

/* Shared utilities - absolute path for module location independence */
import {
    MoveMenu, MoveBack, MoveCapture, MoveShift, MoveDelete, MoveCopy,
    MoveMainButton, MoveMainTouch, MoveMainKnob, MoveMasterTouch,
    MovePlay, MoveRec, MoveLoop, MoveMute, MoveUndo,
    MovePad32, MidiClock, MoveRGBLeds, MoveUp, MoveDown
} from '/data/UserData/schwung/shared/constants.mjs';
import { setLED, setButtonLED, decodeDelta } from '/data/UserData/schwung/shared/input_filter.mjs';
import { buildMetaIndex } from '/data/UserData/schwung/shared/param_pages/param_meta.mjs';
import {
    renderPage, centeredText, fitText, SCREEN_WIDTH, COLS
} from '/data/UserData/schwung/shared/param_pages/render_page.mjs';
import { resolveViz } from '/data/UserData/schwung/shared/param_pages/viz.mjs';
/* The brightness ramp Schwung maintains for knob leds, used here as the
 * Neutral sweep rather than copied. It skips DarkGrey (#1A1A1A), which
 * is within 2% of DarkGrey2 (#141414) and costs a step of the ramp for
 * nothing - see the comment above WHITE_LEVELS. */
import { WHITE_LEVELS } from '/data/UserData/schwung/shared/param_pages/knob_leds.mjs';
import {
    lfoShapeSample, filterGainAt
} from '/data/UserData/schwung/shared/param_pages/viz_draw.mjs';
import {
    drawMenuList, drawMenuHeader, drawMenuFooter, drawStatusOverlay
} from '/data/UserData/schwung/shared/menu_layout.mjs';
/* Where the chrome starts. The knob grid is given everything above it
 * and the hint bar everything below, which is the division every other
 * Schwung param page uses. */
import { RULE_Y } from '/data/UserData/schwung/shared/list_geometry.mjs';
import {
    openTextEntry, isTextEntryActive, handleTextEntryMidi, tickTextEntry, drawTextEntry
} from '/data/UserData/schwung/shared/text_entry.mjs';

/* LPP note layout (10x10 grid) */
const lppNotes = [
    90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
    80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
    70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
    60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
    50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
    30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    101, 102, 103, 104, 105, 106, 107, 108,
    1, 2, 3, 4, 5, 6, 7, 8
];

const lppNoteValueMap = new Map([...lppNotes.map((a) => [a, [0, 0, 0]])]);

/* The Launchpad's logo led, which M8 uses to show LIVE MODE. CC 31 is
 * the led BELOW step 16 - not note 31, which is step 16 itself and is
 * the eighth song-preset button. Notes and CCs are separate address
 * spaces on Move, so the two 31s are different leds and do not collide.
 *
 * It was on CC 99, which is a pad. */
const moveLOGO = 31;

/* Move control to LPP note mapping (top view) */
const moveControlToLppNoteMapTop = new Map([
    [55, 80], [54, 70], [62, 91], [63, 92], [85, 20],
    [43, 89], [42, 79], [41, 69], [40, 59],
    [50, 94], [49, 90], [119, 60], [51, 93], [52, 97],
    [88, 2], [56, 1], [86, 10], [60, 50], [58, 3],
    [118, 98], [moveLOGO, 99]
]);

const lppNoteToMoveControlMapTop = new Map([...moveControlToLppNoteMapTop.entries()].map((a) => [a[1], a[0]]));

/* Move control to LPP note mapping (bottom view) */
const moveControlToLppNoteMapBottom = new Map([
    [55, 80], [54, 70], [62, 91], [63, 92], [85, 20],
    [43, 49], [42, 39], [41, 29], [40, 19],
    [50, 94], [49, 90], [119, 60], [51, 93], [52, 97],
    [88, 2], [56, 1], [86, 10], [60, 50], [58, 3],
    [118, 98], [moveLOGO, 99]
]);

const lppNoteToMoveControlMapBottom = new Map([...moveControlToLppNoteMapBottom.entries()].map((a) => [a[1], a[0]]));

/* Move control to LPP note mapping (odd-rows view). Identical to the
 * other two except for the four track buttons, which are the right-hand
 * column of whichever four rows are on screen - here rows 8, 6, 4, 2. */
const moveControlToLppNoteMapOdd = new Map([
    [55, 80], [54, 70], [62, 91], [63, 92], [85, 20],
    [43, 89], [42, 69], [41, 49], [40, 29],
    [50, 94], [49, 90], [119, 60], [51, 93], [52, 97],
    [88, 2], [56, 1], [86, 10], [60, 50], [58, 3],
    [118, 98], [moveLOGO, 99]
]);

const lppNoteToMoveControlMapOdd = new Map([...moveControlToLppNoteMapOdd.entries()].map((a) => [a[1], a[0]]));

/* LPP pad to Move pad mapping (top view) */
const lppPadToMovePadMapTop = new Map([
    [81, 92], [82, 93], [83, 94], [84, 95], [85, 96], [86, 97], [87, 98], [88, 99],
    [71, 84], [72, 85], [73, 86], [74, 87], [75, 88], [76, 89], [77, 90], [78, 91],
    [61, 76], [62, 77], [63, 78], [64, 79], [65, 80], [66, 81], [67, 82], [68, 83],
    [51, 68], [52, 69], [53, 70], [54, 71], [55, 72], [56, 73], [57, 74], [58, 75],
    [101, 16], [102, 18], [103, 20], [104, 22], [105, 24], [106, 26], [107, 28], [108, 30]
]);

const moveToLppPadMapTop = new Map([...lppPadToMovePadMapTop.entries()].map((a) => [a[1], a[0]]));

/* LPP pad to Move pad mapping (bottom view) */
const lppPadToMovePadMapBottom = new Map([
    [41, 92], [42, 93], [43, 94], [44, 95], [45, 96], [46, 97], [47, 98], [48, 99],
    [31, 84], [32, 85], [33, 86], [34, 87], [35, 88], [36, 89], [37, 90], [38, 91],
    [21, 76], [22, 77], [23, 78], [24, 79], [25, 80], [26, 81], [27, 82], [28, 83],
    [11, 68], [12, 69], [13, 70], [14, 71], [15, 72], [16, 73], [17, 74], [18, 75],
    [101, 16], [102, 18], [103, 20], [104, 22], [105, 24], [106, 26], [107, 28], [108, 30]
]);

const moveToLppPadMapBottom = new Map([...lppPadToMovePadMapBottom.entries()].map((a) => [a[1], a[0]]));

/* LPP pad to Move pad mapping (odd-rows view).
 *
 * LPP rows 8, 6, 4 and 2 instead of a contiguous four, so a 4-row Move
 * screen covers the whole 8-row phrase at half resolution. Ported from
 * the "display only odd rows" mode in damian-/move-anything.
 *
 * WHICH FOUR ROWS IS EASY TO GET WRONG BY ONE. LPP row 8 (81-88) is the
 * TOP row - the Top view maps it to Move pad 92, Move's top left - so
 * M8's rows 00, 02, 04, 06 are LPP 8, 6, 4, 2, NOT 7, 5, 3, 1. The first
 * version used the odd LPP numbers, which reads plausibly and silently
 * shows M8 rows 01/03/05/07 instead: every row present but the first one
 * missing. */
const lppPadToMovePadMapOdd = new Map([
    [81, 92], [82, 93], [83, 94], [84, 95], [85, 96], [86, 97], [87, 98], [88, 99],
    [61, 84], [62, 85], [63, 86], [64, 87], [65, 88], [66, 89], [67, 90], [68, 91],
    [41, 76], [42, 77], [43, 78], [44, 79], [45, 80], [46, 81], [47, 82], [48, 83],
    [21, 68], [22, 69], [23, 70], [24, 71], [25, 72], [26, 73], [27, 74], [28, 75],
    [101, 16], [102, 18], [103, 20], [104, 22], [105, 24], [106, 26], [107, 28], [108, 30]
]);

const moveToLppPadMapOdd = new Map([...lppPadToMovePadMapOdd.entries()].map((a) => [a[1], a[0]]));

/* ------------------------------------------------------------- LED values
 *
 * MOVE HAS TWO KINDS OF LED AND THEY SPEAK DIFFERENT LANGUAGES.
 *
 * An RGB led (every pad, all 16 steps, Play, Rec, Sample and the four row
 * buttons) reads its value as an INDEX INTO THE PALETTE in constants.mjs.
 * A white led (Back, Menu, Capture, Loop, Mute, Delete, Copy, Undo, Shift
 * and the arrows) reads the same byte as a BRIGHTNESS, 0-127.
 *
 * The two greys below were brightnesses - 0x10 dim, 0x7c bright - and they
 * are correct for a white led. Sent to an RGB one they were read as
 * palette entries, and the palette says something else entirely:
 *
 *     0x10 = 16  -> #31ADFF Azure Blue      (wanted: a dark grey)
 *     0x7c = 124 -> #141414 Dark Grey 2     (wanted: a bright grey)
 *
 * So the song-preset steps lit BLUE where they should have been dim, and
 * Play lit almost black where it should have been bright. Naming them for
 * the surface they belong to is what stops that recurring; ledFor() below
 * makes it structural. */
const WHITE_DIM = 0x10;
const WHITE_BRIGHT = 0x7c;

/* Palette indices, from the table at the top of constants.mjs. */
const RGB_OFF = 0;
const RGB_DIM_GREY = 123;      /* #404040 - visible in a lit room */
const RGB_GREY = 118;          /* #595959 */
const RGB_WHITE = 120;         /* #FFFFFF */

/* The song-preset steps are the module's own row, not the M8's, and they
 * sat in the same white-and-grey as the track buttons directly above
 * them - two rows of the same two colours, telling you nothing about
 * which was which. Amber is the one hue nothing else on this surface
 * uses: the M8's own palette runs white, pink, green, blue and red. */
const RGB_PRESET = 8;          /* #FFC516 bright yellow */
/* Not amber's own dim variant, 79 (#664E08): beside the bright one it
 * still read as the same lamp at the same strength, and which song you
 * were on took a second look. Ochre is a long way down in luminance
 * while still being clearly lit - the row has to survive a lit room,
 * which is what ruled out the darker 80 (#211902). */
const RGB_PRESET_DIM = 6;      /* #491804 ochre */

/* ------------------------------------------------- the knobs' own leds
 *
 * Each of the eight knobs has a light under it - the Move has no LED
 * collar around the knob, one lamp beneath it - addressed by the same
 * CC the knob turns on (71-78) and written on the 24th-note TRANSITION
 * channel
 * so the colour slides rather than snapping. A sweep is a short list of
 * palette entries walked by the knob's position: the bottom of the
 * travel is the first entry, the top the last.
 *
 * These four lists came from the module's original virtual_knobs.mjs,
 * which lit them before the knobs became song-shaped. Knob 9 is
 * left alone - it is the master, it belongs to no song, and the old
 * code had to borrow the Sample button's led to show it at all. */
const KNOB_LED_CCS = [71, 72, 73, 74, 75, 76, 77, 78];
const KNOB_LED_ANIM = 0x01;            /* Trans24th - see constants.mjs */
const KNOB_SWEEPS = [
    /* Neutral: dark to white, black first so the bottom of the travel
     * really is off. The rest is Schwung's own WHITE_LEVELS - six stops
     * where this list used to have four. */
    [RGB_OFF].concat(WHITE_LEVELS),
    [104, 105, 20, 21, 23, 26, 25],    /* Synthwave */
    [124, 35, 23, 26, 25],             /* Rose */
    [33, 16, 15, 14, 11, 8, 3, 2],     /* Rainbow */
    null,                              /* Off */
];
/* Four characters at most. These are drawn in a LIST's value column,
 * which is what is left after the label - the same squeeze that turned
 * "Absolute" into "Abs" beside "Mstr Mode". The web UI, which has room,
 * spells them out. */
const KNOB_SWEEP_OPTIONS = ["Grey", "Syn", "Rose", "Rain", "Off"];
/* The same five as the web UI's settings-schema.json spells them. */
const KNOB_SWEEP_KEYS = ["neutral", "synthwave", "rose", "rainbow", "off"];
const KNOB_SWEEP_DEFAULT = 0;
const KNOB_SWEEP_OFF = 4;
/* A knob with no sweep of its own follows the song's - the row below 0. */
const KNOB_SWEEP_FOLLOW = -1;

/* Kept for the LPP colour map below, which addresses pads only. */
/* Only the LPP colour map uses these two now, and only as MOVE PALETTE
 * indices - the led call sites take a level through ledFor() instead.
 * It was 0x7c, a brightness, which as a palette entry is #141414 -
 * lit, technically. The edge buttons carry it, and that is most of why
 * they could not be seen. */
const chrome_dim = 123;        /* #404040 - visible in a lit room */
const green = 0x7e;            /* #00FF00 */
const navy = 0x7d;
const sky = 0x5f;
const red = 0x7f;              /* #FF0000 */
/* THE CURSOR AND THE TRACK BUTTONS ARE BOTH THIS COLOUR (LPP 78), which
 * is why one value answered two separate reports: a pulsing edit-mode
 * cursor that looked white and static beside the white chain pads, and
 * a right-hand column too dim to read. It was 0x5f - #134566 - which is
 * a blue only in the sense that black is. */
const blue = 16;               /* #31ADFF azure blue */
const azure = 0x63;
const white = 0x7a;
const pink = 0x6d;
const aqua = 0x5a;
const black = 0x00;
const lemonade = 0x6b;
const lime = 0x20;
const fern = 0x55;

/* Alias imported constants for local usage */
const moveMENU = MoveMenu;
const moveBACK = MoveBack;
const moveCAP = MoveCapture;
const moveSHIFT = MoveShift;
const moveWHEEL = MoveMainButton;
const movePLAY = MovePlay;
const moveREC = MoveRec;
const moveLOOP = MoveLoop;
const moveMUTE = MoveMute;
const moveUNDO = MoveUndo;
const moveWHEELTouch = MoveMainTouch;
const moveMASTERTouch = MoveMasterTouch;
const moveJogTurn = MoveMainKnob;

/* Which surface a control's led is, so a caller can name a colour once
 * and have it come out right on either. MoveRGBLeds is the list in
 * constants.mjs, so this cannot drift from the hardware. */
const RGB_LED_SET = new Set(MoveRGBLeds);

/* Semantic names, resolved per led. Every call site says what it MEANS
 * - off, dim, bright - instead of a number that is only correct on one
 * of the two surfaces. */
function ledFor(control, level) {
    const rgb = RGB_LED_SET.has(control);
    if (level === "off") return rgb ? RGB_OFF : 0x00;
    if (level === "dim") return rgb ? RGB_DIM_GREY : WHITE_DIM;
    if (level === "bright") return rgb ? RGB_WHITE : WHITE_BRIGHT;
    return rgb ? RGB_GREY : WHITE_DIM;
}

/* Which LPP channels mean "animate this pad".
 *
 * A Launchpad carries the animation in the MIDI CHANNEL of the LED
 * message: channel 1 is static, 2 is flashing, 3 is pulsing. M8 uses it -
 * a selected chain or phrase is sent flashing, and so is every other
 * place that chain appears - and the CONTROL path has always honoured
 * it (see the 0x91 branch at the end of applyLppLed). The PAD path
 * threw it away and relayed everything static, which is why the
 * selection never moved.
 *
 * The value is only a flag here: what the pad then does is decided by
 * tickPadAnimation below, not by Move's own transition. */
const LPP_PAD_ANIMATED = { 0x91: true, 0x92: true };

/* --------------------------------------------------- pad animation
 *
 * ANIMATED IN SOFTWARE, not by the hardware transition.
 *
 * Move inherits Push 2's LED transitions and they are documented
 * (AbletonPush2MIDIDisplayInterface, "LED animation"): base colour on
 * channel 0, then target and transition type on channels 1-15, and a
 * channel-0 write stops a running transition. Three attempts at
 * driving that produced three wrong pictures on the device - both
 * colours in one frame lost the base, target-then-base stopped the
 * animation dead, and base-then-target went back to transitioning from
 * whatever the M8 had painted. The M8 repaints these pads on its own
 * schedule, and every one of those repaints is a channel-0 write, so
 * the base a transition starts from is never reliably ours.
 *
 * Toggling the colour ourselves removes the whole question. It costs
 * one write per animated pad per flip - a handful of pads a few times
 * a second - and it cannot be undone by an M8 repaint, because the
 * next flip overwrites it.
 */

/* What a flashing pad alternates WITH: a near neighbour of the same hue
 * at a clearly different brightness, so the pad reads as one pad
 * breathing rather than as two pads taking turns.
 *
 * Picked by hand rather than derived. The palette's 26 saturated
 * colours do carry a regular dim partner (63 + 2c), and that is still
 * the fallback, but the colours this module flashes are not all in
 * that range - the pure primaries and the greys sit outside it - and
 * where the formula did apply it chose partners so dark they read as
 * off: azure against #134566 looked like blue-to-nothing.
 *
 * A colour that is ALREADY dark takes a BRIGHTER partner instead.
 * Direction does not matter - the pad alternates between the two
 * either way - only that both ends are lit and share a hue. */
const PULSE_PARTNER = {
    0x7a: 118,     /* white   #CCCCCC -> #595959 mid grey, not near-black */
    120: 118,      /* white   #FFFFFF -> #595959 */
    0x7e: 83,      /* green   #00FF00 -> #306609 */
    0x7f: 65,      /* red     #FF0000 -> #661914 */
    16: 20,        /* azure   #31ADFF -> #153999 a deeper blue, still lit */
    32: 12,        /* deep green #007F12 -> #4F8A04, brighter: it is dark already */
    109: 23,       /* dim pink   #3C1166 -> #972BFF */
    95: 16,        /* dim azure  #134566 -> #31ADFF */
    85: 11,        /* dim green  #144D08 -> #34C216 */
    90: 13,        /* dark teal  #0C210B -> #62FF55 */
    99: 18,        /* dim violet #0A1466 -> #1A34FF */
};

function pulsePartnerOf(colour) {
    if (PULSE_PARTNER[colour] !== undefined) return PULSE_PARTNER[colour];
    /* The palette's own dim partner, for any saturated colour not listed. */
    if (colour >= 1 && colour <= 26) return 63 + 2 * colour;
    return black;
}

/* Move note -> the two colours it alternates between. */
const animatedPads = new Map();

/* Ticks per flip. The module ticks at about 44 Hz, so this is about
 * one and a half flips a second - a pulse of roughly 0.8 Hz.
 *
 * Tuned on the device three times: 10 was far too fast, 16 still read
 * as a flicker rather than a pulse. Raise it further to slow it down;
 * nothing else depends on the number. */
/* THE FLASH IS TIMED FROM THE CLOCK, NOT FROM A TICK COUNT.
 *
 * It used to flip every PAD_FLIP_TICKS ticks, which assumes every tick
 * is the same length. On the device they are not: shadow_ui drives the
 * module on a ~16ms loop, and the knob page is a far heavier draw than a
 * menu list - dials, filter and envelope graphics, the whole page every
 * frame. When that overruns, ticks are dropped and the counter advances
 * more slowly, so the same flash ran at one speed on the knob page and a
 * visibly faster one the moment a menu opened. The menu was not speeding
 * up; the knob page was dragging.
 *
 * Milliseconds do not care what is on screen, so one period now means
 * one period everywhere. 450ms is what 28 ticks of a 16ms loop was
 * nominally worth - a full cycle, dim and bright, is twice this. */
const PAD_FLIP_MS = 450;
let padFlipOn = false;

/* Pads the M8 has painted statically, waiting to see whether a re-arm
 * follows in the same refresh - see the static branch of applyLppLed.
 * Value is the colour to paint if the stop does stand. */
const padStopPending = new Map();

function applyPendingPadStops() {
    if (!padStopPending.size) return;
    for (const [note, colour] of padStopPending) {
        animatedPads.delete(note);
        move_midi_internal_send([0x09, 0x90, note, colour]);
    }
    padStopPending.clear();
}

/* Only writes on the frames the phase actually changes, so a steady
 * screen costs nothing between flips. */
let padFlipDueAt = 0;

function tickPadAnimation() {
    /* NOT WHILE THE KEYBOARD HAS THE GRID.
     *
     * Blink and pulse are done in software here, a flip every
     * PAD_FLIP_TICKS - and the flip writes straight to the pads. With
     * the keyboard up those pads are letters, painted once when it
     * opened, so a flip a few frames later punched the old screen's
     * flashing chains back through the middle of them.
     *
     * Nothing is lost by pausing: the phase is free-running and the
     * hand-back repaints the whole grid from memory, which re-arms
     * every animation from what the M8 last said. */
    if (padsAreBorrowed()) return;
    applyPendingPadStops();
    if (!animatedPads.size) { padFlipDueAt = 0; padFlipOn = false; return; }
    const now = Date.now();
    /* First armed pad starts the clock rather than flipping at once -
     * applyLppLed has just painted it, and a flip in the same frame
     * would make the first half-period a flicker. */
    if (!padFlipDueAt) { padFlipDueAt = now + PAD_FLIP_MS; return; }
    if (now < padFlipDueAt) return;
    /* Counted from NOW, not from what was due: a frame late should not
     * make the next one early, which is what accumulating the schedule
     * would do after a stall. */
    padFlipDueAt = now + PAD_FLIP_MS;
    padFlipOn = !padFlipOn;
    for (const [note, pair] of animatedPads) {
        move_midi_internal_send([0x09, 0x90, note, padFlipOn ? pair[1] : pair[0]]);
    }
}

/* Stop a pad animating and leave it on `colour`. */
function disarmPad(note, colour) {
    animatedPads.delete(note);
    padStopPending.delete(note);
    move_midi_internal_send([0x09, 0x90, note, colour]);
}

/* Take every animation off before a full repaint. A view change points
 * the same physical pad at a different LPP note, so an animation left
 * running would keep flipping under the new one. */
function disarmAnimatedPads() {
    for (const note of animatedPads.keys()) {
        move_midi_internal_send([0x09, 0x90, note, black]);
    }
    animatedPads.clear();
    padStopPending.clear();
}

/* Launchpad colour -> Move palette index.
 *
 * TWO DIFFERENT 128-COLOUR TABLES, so an entry missing here does not
 * degrade to an approximate hue - it falls through as a raw index into
 * Move's palette and lands somewhere unrelated.
 *
 * A traced M8 sends 1, 3, 5, 21, 23, 57, 71 and 78; all are covered.
 * Read against Grahack's M8_LPP_recap they mean: 3 white (non-empty
 * chains), 21 green (chains playing), 71 dark pink (empty chains),
 * 78 blue (the edit-mode cursor, and the track buttons), 1 the dim
 * chrome on the edge buttons. */
const lppColorToMoveColorMap = new Map([
    [0x15, green], [0x17, lime], [0x1, chrome_dim], [0x05, red], [0x39, red], [0x03, white], [0x4e, blue],
    [0x47, pink], [0x13, aqua], [0x27, blue], [0x2b, azure], [0x16, fern]
]);

const lppColorToMoveMonoMap = new Map([
    [0x05, 0x7f], [0x78, 0x7f], [0x01, 0x10], [0x07, 0x0f]
]);

/* State */
/* Which four LPP rows the pads show. Top and Bottom have always been a
 * pair toggled by wheel touch; Odd is a third stop, added to the cycle
 * only when the setting is on (see settings.oddRows) so anyone who does
 * not want a third press never gets one. */
const VIEW_TOP = 0;
const VIEW_BOTTOM = 1;
const VIEW_ODD = 2;
let viewMode = VIEW_TOP;

function padMapLppToMove() {
    if (viewMode === VIEW_ODD) return lppPadToMovePadMapOdd;
    return viewMode === VIEW_TOP ? lppPadToMovePadMapTop : lppPadToMovePadMapBottom;
}
function padMapMoveToLpp() {
    if (viewMode === VIEW_ODD) return moveToLppPadMapOdd;
    return viewMode === VIEW_TOP ? moveToLppPadMapTop : moveToLppPadMapBottom;
}
function controlMapLppToMove() {
    if (viewMode === VIEW_ODD) return lppNoteToMoveControlMapOdd;
    return viewMode === VIEW_TOP ? lppNoteToMoveControlMapTop : lppNoteToMoveControlMapBottom;
}
function controlMapMoveToLpp() {
    if (viewMode === VIEW_ODD) return moveControlToLppNoteMapOdd;
    return viewMode === VIEW_TOP ? moveControlToLppNoteMapTop : moveControlToLppNoteMapBottom;
}

/* Which of M8's Launchpad screens is up, tracked from the button that
 * asked for it. M8 starts on the primary Session screen; Back returns to
 * it, Shift+Back reaches a SECOND session screen, Menu is Note and
 * Capture is Sequencer. Nothing is sent back to say so, so the only way
 * to know is to watch what we forward. */
const LP_SESSION = 0;
const LP_SESSION_ALT = 1;
const LP_NOTE = 2;
const LP_SEQ = 3;
let lpMode = LP_SESSION;

/* Odd rows halves the SESSION grid - it puts M8 phrase rows 0, 2, 4, 6
 * on screen at once, so you see a whole phrase at half resolution. The
 * Note and Sequencer screens are not phrase rows at all (a keyboard and
 * a step editor), and the second Session screen is a different grid
 * again, so on any of the three "every other row" describes nothing and
 * just hides half the layout. The third view is therefore offered only
 * on the primary Session screen. */
function oddRowsAvailable() {
    return settings.oddRows && lpMode === LP_SESSION;
}

/* Restated rather than remembered: the screen can change on any button
 * press and the setting can change in Settings, and either one can strand
 * the pads on a layout the cycle no longer reaches. Both call this. */
function reconcileOddRowsView() {
    if (oddRowsAvailable()) return;
    if (viewMode !== VIEW_ODD) return;
    viewMode = VIEW_TOP;
    queuePadRedraw();
    updateMoveViewPulse();
}

/* ------------------------------------------------------------- tracing */

/* Which LPP notes the M8 actually lights, per screen.
 *
 * The module is a blind emulator - it maps notes both ways and has never
 * had to know what M8 puts where. That is fine until a screen turns out
 * to use rows the current view does not show, at which point the pads
 * look dead and there is nothing in the module that can say why. So this
 * records the lit set for a few seconds after each screen change and
 * writes it out as a grid.
 *
 * OFF unless `trace_on` exists beside the module, and read ONCE at init:
 * a file check per MIDI event would cost more than the feature. Delete
 * the file to stop. Writes go to /data/UserData (never the device's
 * root filesystem, which is full). */
/* Derived in a FUNCTION rather than a const: MODULE_DIR is declared
 * further down the file, and a const referring to it from up here is
 * read during module evaluation, when it is still in its temporal dead
 * zone - which throws on import, a failure `node --check` cannot see.
 * A function body is not evaluated until it is called, by which time
 * every declaration has run. */
function tracePath(name) {
    return `${MODULE_DIR}/${name}`;
}
const TRACE_FRAMES = 130;          /* ~3 s at 44 Hz */
let traceOn = false;
let tracePending = [];
let traceFramesLeft = 0;
/* The WHOLE screen, maintained continuously rather than per window.
 * It used to be cleared at the start of each window, so a window only
 * ever showed what CHANGED during it - and since the M8 paints the grid
 * once and then sends deltas, every window after the first looked
 * nearly empty. That reads as "the M8 sent almost nothing", which is a
 * conclusion about the device rather than about the instrument. */
let traceLit = new Map();
/* Every LED message of the window, in order, as [note, channel, colour]. */
let traceEvents = [];
const TRACE_EVENT_CAP = 600;
let traceLabel = "";

function traceWrite(line) {
    if (!traceOn) return;
    tracePending.push(line);
}

/* Appending means re-reading, because std has no append mode here. The
 * log is small (a few lines per screen change) and only written while
 * tracing, so the cost is irrelevant next to losing the history on every
 * flush. */
/* What has already been written, kept in memory.
 *
 * This used to re-READ the whole log on every flush, because std has
 * no append mode here - fine when a flush only happened at the end of
 * a window, and not fine once flushing moved onto a two-second timer:
 * a read plus a full rewrite, blocking, on the UI tick, in the same
 * seconds the nudge is counting ticks and the M8 is painting. It
 * changed the behaviour of the thing it was measuring. */
let traceWritten = "";

function traceFlush() {
    if (!traceOn || !tracePending.length) return;
    traceWritten += tracePending.join("\n") + "\n";
    tracePending = [];
    const f = std.open(tracePath("trace.log"), "w");
    if (f) {
        f.puts(traceWritten);
        f.close();
    }
}

/* WHAT THE OTHER END IS ACTUALLY SENDING.
 *
 * traceLed only ever sees NOTE messages, because that is the only kind
 * the LED relay acts on - so a device that paints its grid some other
 * way (a CC, a different channel, a different note numbering) leaves an
 * empty trace that reads as "nothing arrived". It is not the same
 * finding, and the difference matters the moment something other than
 * M8 hardware is on the other end - the iOS build of M8, say.
 *
 * So every external message is tallied by kind, and the first few are
 * kept verbatim. Trace-gated like everything else here: nothing is
 * counted unless the flag file exists. */
const traceKinds = new Map();      /* "9n ch1" -> count */
const traceRaw = [];               /* the first messages, as they arrived */
const TRACE_RAW_CAP = 48;
let traceExternalCount = 0;

function traceIncoming(data) {
    if (!traceOn) return;
    traceExternalCount++;
    const status = data[0];
    const kind = status >= 0xF0
        ? `sys ${status.toString(16)}`
        : `${(status & 0xF0).toString(16)}x ch${(status & 0x0F) + 1}`;
    traceKinds.set(kind, (traceKinds.get(kind) || 0) + 1);
    if (traceRaw.length < TRACE_RAW_CAP) {
        traceRaw.push([...data].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join(" "));
    }
}

/* THE OTHER PLACE AN LED STREAM COULD BE LANDING.
 *
 * The host routes by USB cable: cable 2 reaches onMidiMessageExternal,
 * cable 0 is Move's own surface and reaches onMidiMessageInternal. If
 * the app writes its LED stream to a different port from the one it
 * reads - easily done on iOS, where a destination and a source are
 * separate objects - those writes arrive as "the Move's own buttons"
 * and are silently discarded as nonsense.
 *
 * So anything internal that Move's surface cannot account for is worth
 * seeing: Move sends knob touches 0-9, steps 16-31 and pads 68-99, and
 * nothing else. A note 11-67 on the internal side is not a Move
 * control; it is an LPP grid address that came in the wrong door. */
function traceStrangeInternal(data) {
    if (!traceOn) return;
    const status = data[0] & 0xF0;
    if (status !== 0x90 && status !== 0x80) return;
    const note = data[1];
    const isMoveControl = note <= 9 || (note >= 16 && note <= 31) || (note >= 68 && note <= 99);
    if (isMoveControl) return;
    strangeInternal.set(note, (strangeInternal.get(note) || 0) + 1);
}

const strangeInternal = new Map();

let traceLastCensus = "";

function traceIncomingReport(onlyIfChanged) {
    if (!traceOn) return;
    /* One line per state, not one per flush: a device that has been
     * quiet for a minute should say so once. */
    const fingerprint = `${traceExternalCount}:${strangeInternal.size}`;
    if (onlyIfChanged && fingerprint === traceLastCensus) return;
    traceLastCensus = fingerprint;
    traceWrite(`  heard ${traceExternalCount} message(s) from the other end`);
    if (!traceKinds.size) {
        traceWrite("  kinds: NONE - nothing at all arrived on the external port");
        return;
    }
    traceWrite("  kinds: " + [...traceKinds].map(([k, n]) => `${k} x${n}`).join(", "));
    if (traceRaw.length) traceWrite("  first messages: " + traceRaw.join(" | "));
    if (strangeInternal.size) {
        const notes = [...strangeInternal].sort((a, b) => a[0] - b[0])
            .map(([n, c]) => `${n}x${c}`).join(" ");
        traceWrite(`  NOT-A-MOVE-CONTROL notes on the internal side: ${notes}`);
        traceWrite("  (an LPP grid address arriving on cable 0 means the other");
        traceWrite("   end is writing to a different port than it reads)");
    }
}

/* Start collecting the lit set for the screen just entered. */
function traceScreen(label) {
    if (!traceOn) return;
    traceReport();
    traceLabel = label;
    traceEvents = [];
    traceFramesLeft = TRACE_FRAMES;
    traceWrite(`--- ${label} (view ${viewMode}, oddAvailable ${oddRowsAvailable()})`);
}

/* `status` carries the CHANNEL, which is where a Launchpad puts the
 * animation: 1 static, 2 blinking, 3 pulsing. Recording it alongside the
 * colour is the whole point of the trace - "the cursor is white and does
 * not blink" has two possible causes (the M8 never sent blue-on-channel-2,
 * or it did and something later overwrote it with white-on-channel-1) and
 * only the ORDER of the messages tells them apart. */
function traceLed(lppNote, velocity, on, status) {
    if (!traceOn) return;
    /* Recorded as the MIDI channel a person counts - 1, 2, 3 - not the
     * status nibble, so the log reads the same way the Launchpad
     * documentation does. */
    const ch = (status & 0x0F) + 1;
    if (on && velocity > 0) traceLit.set(lppNote, [velocity, ch]);
    else traceLit.delete(lppNote);
    if (traceEvents.length < TRACE_EVENT_CAP) traceEvents.push([lppNote, ch, velocity]);
}

/* The lit set as an 8x8 picture, rows 8 (top) down to 1, so it can be
 * compared with the M8's screen directly. A digit is a lit pad. */
function traceReport() {
    if (!traceOn || !traceLabel) return;
    /* The grid, with the ANIMATION as the glyph: a static pad is #, a
     * blinking one B, a pulsing one P. That alone answers whether the
     * cursor is being sent animated at all. */
    const glyph = (v) => (!v ? "." : v[1] === 2 ? "B" : v[1] === 3 ? "P" : "#");
    traceWrite(`  screen after "${traceLabel}": ${traceLit.size} leds lit   (# static, B blink, P pulse)`);
    for (let r = 8; r >= 1; r--) {
        let line = `  row ${r}: `;
        for (let c = 1; c <= 8; c++) line += glyph(traceLit.get(r * 10 + c));
        traceWrite(line);
    }
    /* Every distinct colour on screen, so an unmapped one is visible as a
     * number we do not translate. */
    const colours = new Map();
    for (const [note, v] of traceLit) {
        const key = `${v[0]}${v[1] === 1 ? "" : v[1] === 2 ? " blink" : " pulse"}`;
        colours.set(key, (colours.get(key) || 0) + 1);
    }
    traceWrite("  colours: " + [...colours].map(([k, n]) => `${k} x${n}`).join(", "));
    const edge = [...traceLit.keys()].filter((n) => n < 11 || n > 88 || n % 10 === 0 || n % 10 === 9);
    traceWrite(`  edge/control notes lit: ${JSON.stringify(edge.sort((a, b) => a - b))}`);

    /* Any pad the M8 sent animated at ANY point, with its whole message
     * history. A pad that was sent blinking and is now static was
     * overwritten, and this is where that shows up. */
    const everAnimated = new Set(traceEvents.filter((e) => e[1] !== 1).map((e) => e[0]));
    if (everAnimated.size) {
        traceWrite(`  pads sent animated: ${JSON.stringify([...everAnimated].sort((a, b) => a - b))}`);
        for (const note of everAnimated) {
            const hist = traceEvents.filter((e) => e[0] === note)
                .map((e) => `ch${e[1]}:${e[2]}`).join(" -> ");
            traceWrite(`    note ${note}: ${hist}`);
        }
    } else {
        traceWrite("  pads sent animated: NONE - every message was channel 1");
    }
    traceWrite(`  (${traceEvents.length} led messages in this window${traceEvents.length >= TRACE_EVENT_CAP ? ", capped" : ""})`);
    traceIncomingReport();
    traceLabel = "";
    traceEvents = [];
    traceFlush();
}

/* Lines written outside a window used to be lost. traceReport blanks
 * the label when it finishes and then early-returns forever after, so
 * tracePending simply grew and was never written - every nudge
 * attempt past the first, and every outcome, reached no file at all.
 * That reads as the code not running. Flush on a timer as well. */
const TRACE_FLUSH_EVERY = 88;          /* about two seconds */
let traceFlushCount = 0;

function traceTick() {
    if (!traceOn) return;
    if (traceFramesLeft > 0) {
        traceFramesLeft--;
        if (traceFramesLeft === 0) traceReport();
    }
    if (++traceFlushCount >= TRACE_FLUSH_EVERY) {
        traceFlushCount = 0;
        /* SILENCE HAS TO PRINT TOO.
         *
         * The census used to go out only with a screen report, and a
         * screen report only happens once something has connected - so
         * the single most important finding, that nothing arrived at
         * all, left an empty file that reads like a broken tracer. It
         * is written on every flush now, whenever it has changed. */
        traceIncomingReport(true);
        traceFlush();
    }
}

function viewStops() {
    return oddRowsAvailable() ? 3 : 2;
}

function advanceViewMode() {
    viewMode = (viewMode + 1) % viewStops();
    queuePadRedraw();
    updateMoveViewPulse();
}

/* EACH SCREEN REMEMBERS ITS OWN HALF.
 *
 * The half used to be one value shared by every screen, which meant
 * that looking at the bottom half of one screen and then switching
 * halves on another silently moved the first one too - come back to it
 * and you were on the top again, with nothing having touched it. So the
 * half is filed under the screen you are leaving and fetched back for
 * the screen you arrive at. A screen not visited yet opens on the top,
 * which is where everything used to start. */
const viewModeByMode = new Map();

/* Everything the M8 has lit on the GRID, forgotten. The control leds
 * are left alone: Play, Rec and the arrows belong to the device rather
 * than to a screen, and the M8 does not resend them. */
function forgetGrid() {
    for (const note of lppNoteValueMap.keys()) {
        if (note >= 11 && note <= 88) lppNoteValueMap.set(note, [0, 0, 0]);
    }
}

function switchLpMode(target) {
    if (target === lpMode) return;
    viewModeByMode.set(lpMode, viewMode);
    const remembered = viewModeByMode.get(target);
    lpMode = target;
    viewMode = remembered === undefined ? VIEW_TOP : remembered;
    /* A MODE CHANGE IS THE HARDWARE'S TO PAINT.
     *
     * The remembered grid belongs to the screen being left, and the M8
     * repaints for a screen change anyway - so replaying it here would
     * put the old screen's pads up for the moment it takes the M8 to
     * send the new ones. Forgetting first means the pads go dark and
     * fill in with what is actually there. Switching HALVES is not a
     * mode change and keeps its memory: the M8 sends nothing for that,
     * and the cache is all there is. */
    forgetGrid();
    queuePadRedraw();
}
let shiftHeld = false;

/* EVERY change to Shift goes through here, because the lamp under step 1
 * has to follow it.
 *
 * The five menu screens track Shift for themselves - each owns input
 * while it is up, and the main dispatch never sees those messages - and
 * every one of them used to set the flag directly. So the lamp stayed
 * lit after the key was let go, which the shortcut guarantees you will
 * hit: Shift+step 1 opens Songs, and Songs is then the screen that sees
 * the release. */
function setShiftHeld(down) {
    shiftHeld = down;
    showShiftStepHint(down);
    updateKnobCursorHints();
}
let liveMode = false;
let isPlaying = false;
let currentView = moveBACK;
let sysexBuffer = [];
/* The universal Device Inquiry, which is how the other end asks what we
 * are: F0 7E <device id> 06 01 F7. The hardware M8 broadcasts it with
 * 7F ("all call"), and this used to match that byte for byte - so an
 * inquiry carrying any OTHER device id, which the spec allows and other
 * hosts do send, fell through to the "some other sysex" branch. That
 * branch marks us connected, and being connected is what stops the
 * proactive identity retry: we would fall silent without ever having
 * answered, and a host waiting to be told a Launchpad is present never
 * paints a thing. So the id byte is ignored. */
const m8InitSysex = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];

function isDeviceInquiry(bytes) {
    return bytes.length === 6
        && bytes[0] === 0xf0 && bytes[1] === 0x7e
        && bytes[3] === 0x06 && bytes[4] === 0x01 && bytes[5] === 0xf7;
}
let m8Connected = false;  /* Track if M8 has connected */
/* Set when a snapshot gave us a screen we have not been able to confirm.
 * While it stands the module says NOTHING to the M8 - see tick() - so an
 * M8 that is sitting there quietly is not knocked off the screen it is
 * on just to prove it exists. Cleared the moment the M8 speaks. */
let awaitingM8WithSnapshot = false;
let initRetryTicks = 0;   /* Ticks since startup for retry logic */
const INIT_RETRY_INTERVAL = 60;  /* Send init every ~1 second if not connected */

function drawUI() {
    if (mainKnobOpen) {
        try {
            drawMainKnob();
            return;
        } catch (e) {
            console.log(`drawMainKnob: render failed: ${e}`);
            closeMainKnob();
        }
    }
    if (settingsOpen && !songMgmtOpen) {
        try {
            drawSettings();
            return;
        } catch (e) {
            console.log(`drawSettings: render failed: ${e}`);
            closeSettings();
        }
    }
    if (songMgmtOpen) {
        try {
            drawSongMgmt();
            return;
        } catch (e) {
            /* Same reasoning as the drawSongPage try/catch below: must not
             * throw from tick(). Fall all the way back to closing the screen
             * rather than getting stuck showing nothing useful. */
            console.log(`drawSongMgmt: render failed: ${e}`);
            closeSongManagement();
        }
    }
    if (knobEditOpen) {
        try {
            drawKnobEdit();
            return;
        } catch (e) {
            console.log(`drawKnobEdit: render failed: ${e}`);
            closeKnobEdit();
        }
    }
    if (knobWizardOpen) {
        try {
            drawKnobWizard();
            return;
        } catch (e) {
            console.log(`drawKnobWizard: render failed: ${e}`);
            closeKnobWizard();
        }
    }
    if (m8Connected) {
        try {
            if (drawSongPage()) return;
        } catch (e) {
            /* Must not throw: tick() is a globalThis entry point, same as
             * onMidiMessageInternal - an uncaught exception here is fatal to
             * the whole overtake module, not just this frame's draw. Say so
             * on screen rather than leaving the last frame frozen there. */
            console.log(`drawSongPage: render failed: ${e}`);
            drawStatus("Display error");
            return;
        }
        /* loadSongs guarantees a song with a page, so a connected M8 always
         * has a page to draw and this is unreachable in practice. */
        drawStatus("No song page");
        return;
    }
    drawStatus("Waiting for M8...");
}

/* The module's ONLY plain-text screen, and the only one drawn outside a
 * Schwung menu component - so it uses Schwung's own status card rather than
 * hand-placed print() lines at hardcoded y positions, which is what this
 * replaced. Everything else on screen is now either the knob page or one of
 * the menus. */
function drawStatus(message) {
    clear_screen();
    drawStatusOverlay("M8 LPP Emulator", message);
}

function arraysAreEqual(array1, array2) {
    if (array1.length !== array2.length) return false;
    for (let i = 0; i < array1.length; i++) {
        if (array1[i] !== array2[i]) return false;
    }
    return true;
}

/* Progressive resync of the pad grid after a view toggle. Replaying the whole
 * active map synchronously can emit up to ~80 packets from one MIDI callback
 * (40 pads, some doubled); this spreads it across ticks instead, matching the
 * host's recommended progressive-LED pattern (8/frame). */
let padRedrawEntries = null;
let padRedrawIndex = 0;
const PAD_REDRAW_PER_FRAME = 8;

function queuePadRedraw() {
    disarmAnimatedPads();
    let activeMoveToLppPadMap = padMapMoveToLpp();
    padRedrawEntries = [...activeMoveToLppPadMap.entries()];
    padRedrawIndex = 0;
}

function drainPadRedraw() {
    if (!padRedrawEntries || padRedrawIndex >= padRedrawEntries.length) return;
    const end = Math.min(padRedrawIndex + PAD_REDRAW_PER_FRAME, padRedrawEntries.length);
    for (let i = padRedrawIndex; i < end; i++) {
        const [moveNote, lppNote] = padRedrawEntries[i];
        const data = lppNoteValueMap.get(lppNote);
        if (data && data[0] !== 0) {
            /* Straight to the painter, never back through the external
             * handler - see applyLppLed. */
            applyLppLed(data[1], data[2], data[0] & 0xF0, data[0]);
        } else {
            /* M8 has never reported a color for this LPP note under the new
             * view (still the initial [0,0,0] placeholder) - replaying that
             * is a no-op, which is what left the OTHER view's stale color
             * lit on this physical pad. Clear it explicitly instead. */
            move_midi_internal_send([0x09, 0x90, moveNote, black]);
        }
    }
    padRedrawIndex = end;
}

/* Hand a message to the pad keyboard, and put the pads back when it
 * closes.
 *
 * text_entry.mjs reuses the PAD GRID as its keyboard, painting letters
 * over whatever the pads were showing. Closing it restored nothing, so
 * the grid was left carrying Move's own colours until something else
 * happened to trigger a resync.
 *
 * The resync belongs to the KEYBOARD closing rather than to the screen
 * closing, which is why it could not simply live in closeSongManagement:
 * renaming returns you to Song Management, a screen you then stay on, so
 * the only close that had a resync was one that had not happened yet.
 *
 * Returns true when the keyboard consumed the message. */
function routeTextEntryInput(data) {
    if (!isTextEntryActive()) return false;
    /* SHIFT IS STILL TRACKED IN HERE.
     *
     * The keyboard takes every message, which is right for the pads -
     * they are letters while it is up - but it also swallowed the Shift
     * RELEASE. And the keyboard is reached BY holding Shift: Shift+jog
     * click renames a song. So the flag was set on the way in, the
     * release never arrived, and Shift stayed stuck down for the rest
     * of the session - long after the keyboard had gone.
     *
     * Tracked, then passed on rather than consumed here, so the
     * keyboard can still use Shift for whatever it likes. */
    if (data[0] === 0xb0 && data[1] === moveSHIFT) setShiftHeld(data[2] === 127);
    handleTextEntryMidi(data);
    /* The hand-back is NOT done here - see tickTextEntryHandback. */
    return true;
}

/* THE KEYPRESS THAT CLOSES THE KEYBOARD NEVER REACHES THIS MODULE.
 *
 * shadow_ui.js handles internal MIDI before it routes anything to a
 * loaded module, and one of the things it does first is:
 *
 *     if (isTextEntryActive()) {
 *         if (handleTextEntryMidi(data)) { ...; return; }   // consumed
 *     }
 *
 * The keyboard lives in shared/text_entry.mjs, one instance for the
 * whole realm, so the host's check is true whenever OUR keyboard is
 * open. Every keystroke, the closing one included, is consumed up
 * there and never dispatched down here. Repainting "when the keyboard
 * hands back" therefore never ran at all: the next message this module
 * saw was whatever came after the keyboard was already gone - the Back
 * that closed the menu, which is exactly when the pads used to return.
 *
 * A transition cannot be watched for in input we never receive, so it
 * is watched for in the TICK, which does still run. */
let textEntryWasActive = false;

/* Opening it is the one moment this module is certainly running, so the
 * watch is armed here rather than left for a tick to notice. A keyboard
 * that opened and closed between two frames would otherwise look like
 * nothing having happened. */
function openKeyboard(opts) {
    textEntryWasActive = true;
    openTextEntry(opts);
}

function tickTextEntryHandback() {
    const active = isTextEntryActive();
    if (active === textEntryWasActive) return;
    textEntryWasActive = active;
    if (active) return;                 /* it has just taken the pads */

    /* text_entry raises host_pad_block(1) to type on the pads and
     * leaves it raised - the host lowers it again on its own next tick,
     * but doing it here means the repaint below is not racing that. */
    if (typeof host_pad_block === "function") host_pad_block(0);
    /* The keyboard borrows the PADS, but the buttons and the step row
     * were cleared with them - so the hand-back puts the whole surface
     * back from memory, not just the grid. */
    repaintFromMemory();
}

/* `force` pushes past setButtonLED's cache, which otherwise suppresses
 * a repeat of a value it believes it already sent - and after the
 * host's LED clear that belief is wrong for every button on the
 * surface. Re-asserting without it is a no-op. */
function updateMoveViewPulse(force) {
    setButtonLED(moveBACK, ledFor(moveBACK, "dim"), force);
    setButtonLED(moveMENU, ledFor(moveMENU, "dim"), force);
    setButtonLED(moveCAP, ledFor(moveCAP, "dim"), force);
    setButtonLED(currentView, ledFor(currentView, "bright"), force);
    /* Which view you are in, as an animation on the view button: Top is
     * steady, Bottom pulses, Odd blinks faster. The channel nibble of the
     * status byte picks the animation (see constants.mjs - 0xA is
     * Pulse2th, 0xD is Blink8th), which is why these are raw sends rather
     * than setButtonLED calls: the shared helper writes channel 0. */
    if (viewMode === VIEW_BOTTOM) {
        move_midi_internal_send([0x0b, 0xBA, currentView, black]);
    } else if (viewMode === VIEW_ODD) {
        move_midi_internal_send([0x0b, 0xBD, currentView, black]);
    }
}

/* Song presets on the ALTERNATE step buttons.
 *
 * The LPP grid claims the EVEN step notes (16-30 - they carry M8's mute
 * states, see lppPadToMovePadMapTop), so these odd ones are the physical
 * buttons in between, unclaimed since the bank system was deleted. The
 * first eight songs sit on them in list order, which is why reordering
 * songs in Song Management is also how a song is moved to a different
 * button.
 *
 * Lit white for the song you are on, dim for a button that has a song
 * behind it, dark for one that does not - so the row says both how many
 * songs there are and where you are among them. */
const SONG_STEP_NOTES = [17, 19, 21, 23, 25, 27, 29, 31];

/* TWO MENUS ON THE STEP ROW, BEHIND SHIFT.
 *
 * Step 1 opens Songs and step 2 opens Settings, which used to be one
 * screen with the song list as its first row.
 *
 * The two steps are different kinds of button and each needs its own
 * care. Step 1 is note 16, which is the Launchpad's T1 - part of the
 * grid, forwarded to the M8, and with its led painted by the M8. So the
 * press is intercepted before the grid ever sees it, and the led is
 * BORROWED while Shift is held and handed straight back on release.
 * Step 2 is note 17, one of this module's own song-preset buttons,
 * which the M8 never sees at all - there the plain press still picks a
 * song and only the shifted one opens Settings. */
const SONGS_STEP_NOTE = 16;
const SETTINGS_STEP_NOTE = 17;

/* Shift lights the small led BELOW step 1, so the shortcut is visible
 * rather than something you have to know.
 *
 * Below, not the step button itself: the row of little leds under the
 * steps is a separate address space - CCs 16-31 - from the step buttons
 * above them, which are notes 16-31. The same numbers, different leds.
 * CC 31 is the one the M8 lights as the Launchpad logo; the other
 * fifteen are unused by both sides, so this one is free to borrow and
 * there is nothing to hand back. Lighting the step BUTTON would mean
 * taking T1's colour off the M8 and putting it back afterwards.
 *
 * Step 2 needs no hint: it is already lit as a song preset. */
const SHIFT_HINT_CC = 16;

/* A BRIGHTNESS, and ledFor() must not be asked for it.
 *
 * The lamps under the steps are WHITE leds - they read the byte as a
 * brightness, 0-127 - while the step buttons above them are RGB and read
 * it as a palette index. ledFor() decides which by looking the control
 * up in MoveRGBLeds, and that list holds MoveSteps, the step NOTES
 * 16-31. It has no way to know this 16 is a CC, so it would answer "RGB"
 * and hand back a palette index.
 *
 * That is not a theoretical mix-up: the first version of this wrote
 * RGB_PRESET, palette index 8, and a white led read the 8 as a
 * brightness of 8 out of 127 - lit, but so faintly it looked broken.
 * CCs 16-31 are the one range where the two address spaces collide on
 * the same numbers, so they are written directly. */
function showShiftStepHint(on) {
    setButtonLED(SHIFT_HINT_CC, on ? WHITE_BRIGHT : 0x00, true);
}

/* COPY AND DELETE LIGHT UP WHEN THEY ARE ON OFFER.
 *
 * Held with Shift, those two buttons duplicate and remove whatever the
 * cursor is on - a knob on the knob cursor, a song in the song list.
 * One pair of gestures across both screens, so they are advertised the
 * same way on both rather than left to be discovered.
 *
 * Only while the offer actually stands: Shift down, and something under
 * the cursor to act on. An empty knob slot and the song list's "+ Add
 * Song" row both offer nothing, and a lit button that does nothing is
 * worse than an unlit one.
 *
 * Both belong to the M8 the rest of the time - Copy is the Launchpad's
 * Duplicate and Delete its Clear - so the colour is borrowed and handed
 * straight back to whatever the M8 last said it was. */
const KNOB_HINT_CCS = [MoveCopy, MoveDelete];
let knobHintsLit = false;

function restoreControlLedFor(cc) {
    const lppNote = controlMapMoveToLpp().get(cc);
    const data = lppNote === undefined ? null : lppNoteValueMap.get(lppNote);
    if (data && data[0] !== 0) applyLppLed(data[1], data[2], data[0] & 0xF0, data[0]);
    else setButtonLED(cc, 0x00, true);
}

function updateKnobCursorHints() {
    const page = getActivePage();
    const onKnob = knobSelectOpen && !!(page && page.knobs[knobSelectIndex]);
    /* Not while the delete question is up - that screen has taken the
     * buttons over and neither offer stands until it is answered. */
    const onSong = songMgmtOpen && !songMgmtConfirm && songMgmtSongIndex() >= 0;
    const want = shiftHeld && (onKnob || onSong);
    if (want === knobHintsLit) return;      /* nothing to say */
    knobHintsLit = want;
    for (const cc of KNOB_HINT_CCS) {
        if (want) setButtonLED(cc, WHITE_BRIGHT, true);
        else restoreControlLedFor(cc);
    }
}

function updateSongStepLeds(force) {
    SONG_STEP_NOTES.forEach((note, i) => {
        const song = songs[i];
        if (!song) { setLED(note, RGB_OFF, force); return; }
        /* Every step here is an RGB led, so these are palette indices
         * rather than brightnesses - ledFor() is not needed. */
        setLED(note, song.id === activeSongId ? RGB_PRESET : RGB_PRESET_DIM, force);
    });
}

/* The host clears every LED about 500ms into the overtake handshake, and
 * markM8Connected can land on either side of that - M8 is often already
 * streaming when the module loads, so the first paint happens BEFORE the
 * clear and is wiped by it. setLED then believes the row is already
 * correct and never repaints, which is why the preset LEDs came up dark.
 *
 * So the row is re-asserted past the cache for the first couple of
 * seconds, whenever the clear actually lands. INIT_RETRY_INTERVAL treats
 * 60 ticks as roughly a second, so this is about two. */
const SONG_STEP_LED_REASSERT_TICKS = 120;
const SONG_STEP_LED_REASSERT_EVERY = 20;
let songStepLedReassert = 0;

function tickSongStepLeds() {
    if (songStepLedReassert <= 0) return;
    songStepLedReassert--;
    if (songStepLedReassert % SONG_STEP_LED_REASSERT_EVERY === 0) updateSongStepLeds(true);
}

/* THE PADS HAVE THE SAME PROBLEM, and it is worse for them.
 *
 * The M8 paints its grid once and then sends only changes, so the
 * opening paint is the whole picture - and it arrives while the host is
 * still clearing LEDs for the module. Whatever lands before the clear
 * is wiped, and the M8 has no reason to send it again. The pads then
 * stay dark until something forces a repaint: a button press, a page
 * change, or toggling the integration off and on at the M8 end. All
 * three are just ways of making the M8 talk again.
 *
 * Nothing is lost though - every LED the M8 sends is remembered in
 * lppNoteValueMap whether or not it reached the pads - so replaying
 * that cache a few times across the first couple of seconds puts the
 * grid back without the M8 having to do anything. */
const PAD_REASSERT_TICKS = 150;
const PAD_REASSERT_EVERY = 30;
let padReassert = 0;

/* The M8 is never asked to repaint.
 *
 * It has no idea the module came or went - there is no "device
 * disconnected" from the peripheral end of MIDI, and a screen change is
 * the only thing it repaints for. The module used to exploit that by
 * pressing Sequencer and then Session on the way in, which worked and
 * which flickered through a screen nobody asked for. The lit grid is
 * remembered across an exit now (see loadSurfaceSnapshot), so there is
 * nothing to ask for: what you left is put straight back.
 *
 * A pad can therefore be a moment stale if the M8 moved while the
 * module was closed. Anything it changes it repaints, so it corrects
 * itself; and a first run, with nothing remembered, comes up dark until
 * the M8 next paints - changing screen on the M8 does it. */
let ledsSeenSinceConnect = 0;

/* A complete press of one LPP control, down and up. The odd view's
 * two-row scroll uses it to send a whole extra press ahead of the real
 * one - see the arrow handling in onMidiMessageInternal. */
function pressOnM8(lppNote) {
    move_midi_external_send([2 << 4 | 0x9, 0x90, lppNote, 100]);
    move_midi_external_send([2 << 4 | 0x8, 0x80, lppNote, 0]);
}



function tickPadReassert() {
    if (padReassert <= 0) return;
    /* Tested BEFORE the decrement, so the first sweep goes out on the
     * very next tick rather than a period later - the clear may
     * already have happened by the time we are connected. */
    const due = padReassert % PAD_REASSERT_EVERY === 0;
    padReassert--;
    if (!due) return;
    /* queuePadRedraw only covers the PADS - its entries come from the
     * pad map. The buttons down the sides, Play and the logo travel
     * through the CONTROL map and were cleared by the same sweep, so
     * they need replaying too. */
    queuePadRedraw();
    reassertControlLeds();
    updateMoveViewPulse(true);
    updatePLAYLed(true);
    /* The song-preset steps are the module's OWN leds, not the M8's,
     * and the same clear takes them out. They have their own window
     * too, but sweeping them here keeps the two in step. */
    updateSongStepLeds(true);
}

/* Repaint every side button, and the logo, from what the M8 last said
 * about it. These are raw CC writes inside applyLppLed rather than
 * cached ones, so replaying the remembered message is enough. A
 * control the M8 has never lit is left alone: some of them are the
 * module's own and updateMoveViewPulse owns those. */
/* THE GRID, KEPT ACROSS AN EXIT.
 *
 * Everything the M8 has lit is already remembered in lppNoteValueMap,
 * which is what a screen close replays. Leaving the module throws that
 * away with the rest of the JS context, and the M8 - which has no idea
 * we went anywhere - sends nothing on the way back in. That is why
 * coming back used to press Sequencer and then Session: a screen change
 * is the only thing that makes the M8 repaint, and with nothing
 * remembered there was nothing else to show.
 *
 * So the lit set is written out on the way out and read back on the way
 * in. What you had is what you get, immediately and without the flicker
 * through another screen. It can be a moment stale - the M8 may have
 * moved while we were away - but any change it makes repaints the pads
 * that changed, and a stale pad is a smaller lie than a wrong screen. */
function ledsPath() {
    return `${MODULE_DIR}/leds.json`;
}

let ledsRestored = false;
/* Set when a snapshot put a screen back, and cleared the first time the
 * M8 speaks - see markM8Connected. */
let surfaceRestored = false;

/* Version 1 was the bare lit map, `{note: [a,b,c]}`. Version 2 wraps it
 * and adds the screen it belonged to. Both are still read: a device
 * updated mid-session has a v1 file sitting there, and the only cost of
 * not recognising it is one dark grid. */
const SURFACE_SNAPSHOT_VERSION = 2;

/* HOW LONG A REMEMBERED SCREEN IS WORTH TRUSTING.
 *
 * Restoring the screen means telling the module the M8 is still there
 * and still on it, which is the only way to come back without asking the
 * M8 to repaint and being dragged to Session for it. That assumption is
 * safe for a quick trip out to the Tools menu and back. It is not safe
 * after the Move has been sitting switched off, or with the M8 unplugged
 * - and when it is wrong the cost is the worst kind: a screen full of
 * stale LEDs that looks live, instead of the "Waiting for M8" screen
 * that would tell you nothing is connected.
 *
 * There is no way to ask. A connected M8 that is simply idle sends
 * nothing at all, so silence cannot separate "here and quiet" from
 * "gone" - which rules out waiting a moment and deciding from that. The
 * clock is the one signal available, so the snapshot gets an age and
 * stops being trusted once it is stale. Past that it is ignored whole:
 * no pads, no mode, no half, and the module introduces itself and waits
 * for the M8 exactly as it does on a first run. */
const SURFACE_SNAPSHOT_TTL_MS = 2 * 60 * 1000;

/* WHICH SCREEN THE REMEMBERED PADS CAME FROM.
 *
 * The lit set is stored by LPP note, and which Move pad a note paints
 * depends on the half - top, bottom or odd rows - so restoring the
 * colours without the view paints them onto the wrong pads. The mode
 * matters for the same reason and for a second one: whether odd rows is
 * even offered, and which of the three mode buttons lights, are both
 * read off lpMode. So the screen travels with the pads rather than
 * being a convenience on top of them. */
function currentViewButtonFor(mode) {
    if (mode === LP_NOTE) return moveMENU;
    if (mode === LP_SEQ) return moveCAP;
    return moveBACK;          /* both Session screens live on Back */
}

function saveSurfaceSnapshot() {
    const lit = {};
    for (const [note, data] of lppNoteValueMap) {
        if (data && data[0] !== 0) lit[note] = [data[0], data[1], data[2]];
    }
    /* switchLpMode only records a mode's half on the way OUT of it, so
     * the mode we are leaving on is not in the map yet. */
    const viewByMode = {};
    for (const [mode, view] of viewModeByMode) viewByMode[mode] = view;
    viewByMode[lpMode] = viewMode;

    const f = std.open(ledsPath(), "w");
    if (!f) return;
    f.puts(JSON.stringify({
        v: SURFACE_SNAPSHOT_VERSION,
        t: Date.now(),
        leds: lit,
        mode: lpMode,
        view: viewMode,
        viewByMode,
    }));
    f.close();
}

function loadSurfaceSnapshot() {
    let raw = null;
    try { raw = std.loadFile(ledsPath()); } catch (e) { return false; }
    if (!raw) return false;
    let saved = null;
    try { saved = std.parseExtJSON(raw); } catch (e) { return false; }
    if (!saved) return false;

    /* AGE FIRST, before a single value is restored - a stale snapshot is
     * ignored whole rather than half-applied.
     *
     * A negative age counts as stale too. It means the clock has moved
     * backwards since the file was written, which says the timestamp
     * cannot be reasoned about rather than that the file is fresh. A v1
     * file, and a v2 one written before this existed, carry no `t` at
     * all and are treated the same way. */
    const age = typeof saved.t === "number" ? Date.now() - saved.t : null;
    if (age === null || age < 0 || age > SURFACE_SNAPSHOT_TTL_MS) {
        console.log(`loadSurfaceSnapshot: ignoring a snapshot ${age === null
            ? "with no timestamp" : `${Math.round(age / 1000)}s old`}`);
        return false;
    }

    /* A v1 file has no wrapper - it IS the lit map. */
    const lit = saved.leds && typeof saved.leds === "object" ? saved.leds : saved;

    let restored = 0;
    for (const key of Object.keys(lit)) {
        const data = lit[key];
        if (!Array.isArray(data) || data.length < 3) continue;
        lppNoteValueMap.set(Number(key), [data[0], data[1], data[2]]);
        restored++;
    }

    const validMode = (m) => m === LP_SESSION || m === LP_SESSION_ALT
                          || m === LP_NOTE || m === LP_SEQ;
    const validView = (v) => v === VIEW_TOP || v === VIEW_BOTTOM || v === VIEW_ODD;

    if (validMode(saved.mode)) lpMode = saved.mode;
    if (validView(saved.view)) viewMode = saved.view;

    viewModeByMode.clear();
    if (saved.viewByMode && typeof saved.viewByMode === "object") {
        for (const key of Object.keys(saved.viewByMode)) {
            const mode = Number(key);
            const view = saved.viewByMode[key];
            if (!validMode(mode) || !validView(view)) continue;
            /* Odd rows describes nothing off the primary Session screen,
             * so a remembered one there is dropped rather than carried
             * back in and reconciled away on the first button press. */
            viewModeByMode.set(mode, view === VIEW_ODD && mode !== LP_SESSION
                ? VIEW_TOP : view);
        }
    }

    /* The setting can have been switched off while we were away - from
     * the browser, even - which strands a remembered odd view on a cycle
     * that no longer reaches it. Clamped here rather than through
     * reconcileOddRowsView, because that repaints, and init queues a
     * full repaint of its own a few lines later. */
    if (viewMode === VIEW_ODD && !oddRowsAvailable()) viewMode = VIEW_TOP;
    currentView = currentViewButtonFor(lpMode);

    surfaceRestored = validMode(saved.mode) || validView(saved.view);
    console.log(`loadSurfaceSnapshot: ${restored} led(s), mode ${lpMode}, view ${viewMode}`);
    return restored > 0;
}

/* Everything we remember, put back on the surface: the pads over the
 * next few frames, and the rest at once. Used both on the way back into
 * the module and when the pad keyboard hands the grid back. */
function repaintFromMemory() {
    queuePadRedraw();
    reassertControlLeds();
    /* Play is the one control led that does not come straight from the
     * M8's byte - it is derived from transport and live mode through
     * setButtonLED, which suppresses a value it believes it already
     * sent. After a screen has owned the surface that belief is wrong,
     * so this one is forced. */
    updatePLAYLed(true);
    updateMoveViewPulse(true);
    updateSongStepLeds(true);
    updateKnobLeds(true);
}

function reassertControlLeds() {
    for (const lppNote of controlMapMoveToLpp().values()) {
        const data = lppNoteValueMap.get(lppNote);
        if (data && data[0] !== 0) applyLppLed(data[1], data[2], data[0] & 0xF0, data[0]);
    }
}

/* Pressing one of those buttons switches song. Silent for a button with
 * no song behind it rather than wrapping or clamping onto another song -
 * an empty preset should do nothing, not something surprising. */
function selectSongByStep(index) {
    const song = songs[index];
    if (!song || song.id === activeSongId) return;
    activeSongId = song.id;
    activePageIndex = 0;
    cachedSongId = null;   /* different song, different page shape */
    markSongsDirty();
    updateSongStepLeds();
}

function updatePLAYLed(force) {
    if (!liveMode && !isPlaying) setButtonLED(movePLAY, ledFor(movePLAY, "bright"), force);
    if (!liveMode && isPlaying) setButtonLED(movePLAY, green, force);
    if (liveMode && !isPlaying) setButtonLED(movePLAY, sky, force);
    if (liveMode && isPlaying) setButtonLED(movePLAY, navy, force);
}

/* ---------------------------------------------------------- MIDI-CI
 *
 * The iOS build of M8 does not ask the question the hardware asks. It
 * opens with a MIDI-CI DISCOVERY - F0 7E 7F 0D 70 ... - which is MIDI
 * 2.0's "who is on this port, and what can you do?", and it says
 * nothing else until something answers. The hardware M8 sends the
 * classic Device Inquiry (06 01) instead and starts painting as soon as
 * it has our identity, so this whole exchange never came up.
 *
 * Captured from an iPad, 32 bytes, every field in its place:
 *
 *   F0 7E 7F 0D 70 02 | 33 0D 61 3A | 7F 7F 7F 7F | 11 00 00 |
 *   01 00 | 01 00 | 02 00 00 00 | 1C | 00 00 01 00 | 03 | F7
 *   ver 1.2, its MUID, broadcast, manufacturer, family, model,
 *   revision, capabilities, 16k max sysex, output path
 *
 * We no longer answer it. A real Pro MK3 does not speak MIDI-CI, and
 * matching the hardware is what we are after; the reply we used to
 * send was well-formed and changed nothing. Discovery is still
 * recognised, because arriving traffic is how we know somebody is
 * listening. */
const MIDI_CI_SUB_ID = 0x0D;
const MIDI_CI_DISCOVERY = 0x70;

function isMidiCiDiscovery(bytes) {
    return bytes.length >= 30
        && bytes[0] === 0xF0 && bytes[1] === 0x7E
        && bytes[3] === MIDI_CI_SUB_ID && bytes[4] === MIDI_CI_DISCOVERY;
}

function sendLPPIdentity() {
    /* The Universal Device Inquiry reply: "I am a Launchpad Pro MK3".
     *
     * The model matters, not just the maker. Novation's programmer's
     * reference (LPP3_prog_ref_guide_200415, "Device Inquiry message")
     * gives the real device's reply as
     *
     *   F0 7E 00 06 02 00 20 29 13 01 00 00 <app_version x4> F7
     *
     * where 00 20 29 is Novation and 13 01 is the Pro MK3 running its
     * Application (13 11 would be the bootloader). This used to send
     * 00 00 for family and model, which names the maker but leaves the
     * device unidentified - enough for a host to say "a Novation thing
     * is here", not enough for it to know which Launchpad it is or what
     * to send it.
     *
     * The frames below are hand-packed: five CIN 4 frames of three
     * bytes, then a CIN 6 frame holding the last two. 17 bytes. */
    let out_cable = 2;
    let LPPInitSysex = [
        out_cable << 4 | 0x4, 0xF0, 126, 0,
        out_cable << 4 | 0x4, 6, 2, 0,
        out_cable << 4 | 0x4, 32, 41, 0x13,
        out_cable << 4 | 0x4, 0x01, 0x00, 0x00,
        out_cable << 4 | 0x4, 0x00, 0x01, 0x00,
        out_cable << 4 | 0x6, 0x00, 0xF7, 0x0
    ];
    move_midi_external_send(LPPInitSysex);
}

function markM8Connected() {
    if (m8Connected) return;
    m8Connected = true;
    initRetryTicks = 0;
    /* First contact normally means the M8 is starting the conversation
     * from its own first screen, so the pads go back to the top half.
     * Not when we restored a snapshot: there the M8 has been running all
     * along and simply has not spoken since we reopened, the screen we
     * remembered is the one it is still on, and resetting here would
     * undo the restore on the M8's very first message. Spent once, so a
     * genuine reconnect later still starts at the top. */
    const hadSnapshot = surfaceRestored;
    if (surfaceRestored) {
        surfaceRestored = false;
    } else {
        viewMode = VIEW_TOP;
    }
    awaitingM8WithSnapshot = false;
    loadSongs();
    /* After the songs, so a value set in a browser wins over the copy
     * that was written into songs.json when the module last ran. */
    loadModuleConfig();
    if (traceOn) {
        traceWrite(`=== M8 connected, oddRows ${settings.oddRows} ===`);
        traceScreen("Session (startup)");
    }
    updateSongStepLeds(true);
    updateKnobLeds(true);
    songStepLedReassert = SONG_STEP_LED_REASSERT_TICKS;
    padReassert = PAD_REASSERT_TICKS;
    /* The confirmation we were waiting for. The remembered grid has been
     * sitting in lppNoteValueMap unpainted since init - put it up now. */
    if (hadSnapshot) repaintFromMemory();
}

function initLPP() {
    sendLPPIdentity();
    markM8Connected();
}

/* ============================================================================
 * Song-based knob configuration
 *
 * Replaced the fixed 9-bank/9-save-slot system (banksDef/saveBanks/
 * changeBank/changeSave/handleMoveKnobs/knobconfig.json) in the cutover
 * phase - see git history for that code if it's ever needed for reference.
 * ============================================================================ */

const MODULE_DIR = "/data/UserData/schwung/modules/overtake/m8";
const SONGS_PATH = MODULE_DIR + "/songs.json";
const KNOBS_PER_PAGE = 8;
/* The 8 cells are drawn as two rows of 4 (render_page.mjs COLS/ROWS), and a
 * multi-knob graphic may not span the gap between them - see
 * nextFreeKnobRun. */
const KNOBS_PER_ROW = 4;

/* Module settings: GLOBAL, not per song. These describe how the module
 * talks to the M8 - which channel and CC it sends on, how the grid is
 * laid out - rather than anything a song contains, and a setting that
 * changed under you when a preset button switched song would be a nasty
 * surprise. Persisted alongside the songs in songs.json. */

let songs = [];             // Song[]
let activeSongId = null;
let activePageIndex = 0;

/* Autosave is throttled rather than written on every knob-turn tick: a
 * synchronous write on every message while spinning a knob (this runs in
 * shadow_ui, shared with everything else the UI does, not an isolated
 * thread) would be wasteful and could stutter the whole UI. Edits land on
 * disk within SONGS_AUTOSAVE_INTERVAL_MS of the last change instead. */
let songsDirty = false;
let lastSongsSaveAt = 0;
const SONGS_AUTOSAVE_INTERVAL_MS = 2000;

function markSongsDirty() {
    songsDirty = true;
}

function flushSongsIfDirty() {
    if (!songsDirty) return;
    const now = Date.now();
    if (now - lastSongsSaveAt < SONGS_AUTOSAVE_INTERVAL_MS) return;
    saveSongs();
    songsDirty = false;
    lastSongsSaveAt = now;
}

function makeSongId() {
    /* Not exposed to the user - just needs to be stable and unique per song,
     * independent of its (renamable) display name or (reorderable) position. */
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* mode/display are stored as plain indices into these option lists (not
 * strings) - the module owns both storage and interpretation, so there's no
 * external wire format to reconcile via param_pages' values[] mapping. */
/* Abbreviated because they are drawn in a LIST's value column, which is
 * what is left after the label and the label floor: "Absolute" beside
 * "Mstr Mode" ran off the right edge of the screen. */
/* RELATIVE IS NOT FOR THE M8. Its learn system maps a CC to a parameter
 * and reads the value absolutely, so a knob left on Rel does nothing
 * over there. The mode is kept because these CCs go out on an ordinary
 * MIDI channel and can drive OTHER GEAR on the same wire, some of which
 * would rather have an encoder's movement than its position - so the
 * relative branches in handleSongKnobTurn, revertAuditionedKnobs and
 * revertMasterAudition are deliberate, not leftovers. Absolute is the
 * default and the only mode that works with the M8 itself. */
const KNOB_MODE_OPTIONS = ["Abs", "Rel"];
const KNOB_MODE_ABSOLUTE = 0;
const KNOB_MODE_RELATIVE = 1;
/* The last three read a knob the way M8's EQ editor reads it - decibels,
 * a Q number and hertz - rather than as a number out of the wire. They
 * are offered to every knob, not just an EQ one: nothing about them is
 * EQ-specific once the scale is chosen, and a knob pointed at something
 * else with the same range may as well borrow the format. */
const KNOB_DISPLAY_OPTIONS = ["0-127", "Hex", "0-1", "-1..1", "dB", "Q", "Hz"];
/* The main knob keeps the original four. It is a plain pass-through with
 * no parameter behind it, so an EQ reading would be a number about
 * nothing - and settings-schema.json spells exactly these for the web
 * settings page. */
const MASTER_DISPLAY_KEYS = ["0-127", "hex", "0-1", "-1..1"];
const KNOB_DISPLAY_HEX = 1;
const KNOB_DISPLAY_UNIT = 2;
const KNOB_DISPLAY_BIPOLAR = 3;
const KNOB_DISPLAY_EQ_GAIN = 4;
const KNOB_DISPLAY_EQ_Q = 5;
const KNOB_DISPLAY_EQ_FREQ = 6;

/* ---------------------------------------------------- a knob's own scale
 *
 * A CC is seven bits and an M8 parameter is a byte, so a hex knob used to
 * show its value doubled: every other byte, 00 02 04 ... FE, and the odd
 * ones simply unreachable. A knob set to Hex now counts in BYTES - 0 to
 * 255, every value there - and sends value >> 1 on the wire. The M8 still
 * hears one CC per two bytes, which is all seven bits can carry; what
 * changes is that the number under your hand is the one the M8's own
 * screen shows, and you can land on any of them.
 *
 * Note-valued parameters (Tracking's low and high) are already 0-127 on
 * the M8 itself, so they keep the 128-step scale - see M8_NOTE_SCALE. */
function knobFineHex(knob) {
    return knob.display === KNOB_DISPLAY_HEX && knob.scale !== M8_NOTE_SCALE;
}

function knobMaxStep(knob) {
    return knobFineHex(knob) ? 255 : 127;
}

/* Which sweep a knob uses: its own if it names one, otherwise the
 * song's. Absent is the usual case and stores nothing. */
function knobSweepIndex(knob) {
    const own = knob && knob.led;
    if (typeof own === "number" && own >= 0 && own < KNOB_SWEEPS.length) return own;
    const global = settings.knobLeds;
    return typeof global === "number" && global >= 0 && global < KNOB_SWEEPS.length
        ? global : KNOB_SWEEP_DEFAULT;
}

/* Where the knob stands, as a colour. The position is read against the
 * knob's whole scale rather than its clamp, so a knob limited to the
 * middle of its travel lights the middle of the sweep - the ring says
 * where the value IS, not how far through its own leash it is. */
function knobLedColour(knob) {
    const sweep = KNOB_SWEEPS[knobSweepIndex(knob)];
    if (!sweep) return RGB_OFF;
    const top = knobMaxStep(knob) || 1;
    const level = Math.max(0, Math.min(1, knob.value / top));
    return sweep[Math.round(level * (sweep.length - 1))];
}

/* Last colour written per ring, so a steady page costs nothing. */
const knobLedCache = new Map();

function updateKnobLeds(force) {
    const page = getActivePage();
    for (let i = 0; i < KNOB_LED_CCS.length; i++) {
        const knob = page ? page.knobs[i] : null;
        /* An empty slot is dark: there is nothing under that knob. */
        const colour = knob ? knobLedColour(knob) : RGB_OFF;
        const cc = KNOB_LED_CCS[i];
        if (!force && knobLedCache.get(cc) === colour) continue;
        knobLedCache.set(cc, colour);
        /* Channel 1 is the 24th-note transition, so the ring slides to
         * the new colour instead of stepping. */
        move_midi_internal_send([0x0B, 0xb0 | KNOB_LED_ANIM, cc, colour]);
    }
}

/* Which MIDI channel this knob sends on. Absent means "the song's" -
 * settings.knobChannel, which is what every knob did before the row
 * existed and what all but a stray one still wants. A knob only carries
 * a channel of its own when it is pointed at something that is not the
 * M8, or at a second M8 listening elsewhere. */
function knobChannelOf(knob) {
    return typeof knob.chan === "number" ? knob.chan : settings.knobChannel;
}

/* What goes on the wire: seven bits, whatever scale the knob counts in. */
function knobCcValue(knob) {
    return knobFineHex(knob) ? (knob.value >> 1) : knob.value;
}

/* The ends of the knob's travel. A knob with no clamp recorded runs the
 * whole scale, which is every knob made before the rows existed. */
function knobLow(knob) {
    return typeof knob.min === "number" ? Math.max(0, Math.min(knobMaxStep(knob), knob.min)) : 0;
}

function knobHigh(knob) {
    const top = knobMaxStep(knob);
    return typeof knob.max === "number" ? Math.max(0, Math.min(top, knob.max)) : top;
}

function clampKnobValue(knob) {
    const lo = knobLow(knob), hi = Math.max(knobLow(knob), knobHigh(knob));
    knob.value = Math.max(lo, Math.min(hi, knob.value));
}

/* ------------------------------------------------------- the multiplier
 *
 * How far one detent moves the value, counted in CC steps so that 1x is
 * what the knobs have always done whatever scale they are on: one CC per
 * detent, which on a hex knob is two bytes. 1/2x is therefore the setting
 * that walks a hex knob through every byte, and 1/4x and 1/3x are for a
 * parameter where a whole CC is too coarse a jump to hear.
 *
 * Fractions need somewhere to accumulate: a quarter of a step is nothing
 * on its own, and four of them are one. The remainder is deliberately NOT
 * saved - it is a property of the gesture in progress, not of the song. */
const KNOB_MULT_OPTIONS = ["1/4x", "1/3x", "1/2x", "1x", "2x"];
const KNOB_MULT_FACTORS = [0.25, 1 / 3, 0.5, 1, 2];
const KNOB_MULT_DEFAULT = 3;          /* 1x */
const knobAccum = new WeakMap();

function knobMultIndex(knob) {
    const i = knob.mult;
    return typeof i === "number" && i >= 0 && i < KNOB_MULT_OPTIONS.length ? i : KNOB_MULT_DEFAULT;
}

/* Steps of the knob's own scale per detent. */
function knobStepPerDetent(knob) {
    return KNOB_MULT_FACTORS[knobMultIndex(knob)] * (knobFineHex(knob) ? 2 : 1);
}

/* How many whole steps this detent is worth, carrying the remainder. */
function knobDetentSteps(knob, dir) {
    const acc = (knobAccum.get(knob) || 0) + dir * knobStepPerDetent(knob);
    const whole = acc < 0 ? Math.ceil(acc) : Math.floor(acc);
    knobAccum.set(knob, acc - whole);
    return whole;
}

/* Switching Display across the hex boundary changes what the numbers
 * COUNT, so the position has to be re-expressed or the knob jumps: 7F
 * on a 0-127 knob and 7F on a hex one are opposite ends of the travel. */
function rescaleKnobForDisplay(knob, wasFine) {
    const isFine = knobFineHex(knob);
    if (isFine === wasFine) return;
    const conv = (v) => Math.max(0, Math.min(isFine ? 255 : 127,
                                             isFine ? v * 2 : Math.round(v / 2)));
    knob.value = conv(knob.value);
    if (typeof knob.default === "number") knob.default = conv(knob.default);
    if (typeof knob.min === "number") knob.min = conv(knob.min);
    if (typeof knob.max === "number") knob.max = conv(knob.max);
}

const DEFAULT_SETTINGS = {
    /* MIDI channel for the song knobs' CCs, 0-15 on the wire. M8's
     * CONTROL MAP CHANNEL (MIDI Settings view) has to agree with this or
     * nothing the knobs send is heard. */
    knobChannel: 3,
    /* The master knob is a song-independent pass-through, so it gets its
     * own channel, CC and send mode rather than borrowing the knobs'. */
    masterChannel: 3,
    masterCc: 79,
    masterMode: KNOB_MODE_ABSOLUTE,
    /* How the panel over the page reads the main knob: 0-127, Hex,
     * 0-1 or -1..1, the same four a song knob offers. */
    masterDisplay: KNOB_DISPLAY_HEX,
    /* Where the master knob was left. Kept with the settings rather
     * than in a song because the knob belongs to no song, and kept at
     * all so the readout starts where you left it instead of at zero
     * every time the module loads. Restored but NOT sent: pushing a
     * value at the M8 on load would move a parameter nobody touched. */
    masterValue: 0,
    /* Adds a third stop to the wheel-touch view cycle - see ODD_ROWS. */
    oddRows: false,
    /* Which colour sweep the knob rings use, for every knob that does
     * not name one of its own. Index into KNOB_SWEEP_OPTIONS. */
    knobLeds: KNOB_SWEEP_DEFAULT,
};
let settings = Object.assign({}, DEFAULT_SETTINGS);

/* ============================================================================
 * M8 parameter catalogue - what the Add Knob wizard offers.
 *
 * M8's MIDI mapping is a LEARN system, not a fixed CC map: you assign a CC
 * to a parameter on the M8 itself (cursor on the parameter, hold [OPTION],
 * turn the CC), up to 128 mappings per song, stored in the song file. So
 * nothing here can "address" an M8 parameter by CC - what this catalogue
 * buys is the other three things the wizard needs: a recognisable NAME, a
 * sensible STARTING VALUE, and (via nextFreeCc) a CC that no other knob in
 * the song is using, so each learn gesture is unambiguous.
 *
 * `m` is the name stem. Where M8 publishes an FX command mnemonic for the
 * parameter (the Mixer & Effects Commands and common Instrument FX Commands
 * appendices), that mnemonic IS the stem, so a knob and the tracker's FX
 * column call the same thing by the same name. The per-instrument-type
 * parameters have FX commands too, but the manual does not print them -
 * "check the FX command help view with the desired instrument in use to see
 * the full list" - so rather than invent mnemonics that might not match the
 * device, those use the parameter name as it appears on M8's own instrument
 * screen, shortened to fit. Every knob can be renamed afterwards anyway.
 *
 * `def` is the default in M8's own 0-255 byte space (what the M8 screen
 * shows in hex); knob.value stores half of it, because a 7-bit CC is 0-127
 * and M8 doubles an incoming CC to reach its native range.
 *
 * The manual's PROSE does not tabulate per-parameter defaults - on the
 * device [EDIT]+[OPTION] resets a parameter to its default, but the values
 * are never printed. The Instrument View page's screenshot does show them,
 * though, for every row an instrument carries, and that image is the source
 * for the common instrument set below. (It is an image, so a text search of
 * the PDF finds nothing - which is how an earlier pass of this catalogue
 * came to omit PAN entirely and put DRY at the wrong value.) Elsewhere the
 * values follow the conventions the manual states in words, plus track
 * volume confirmed from hardware:
 *   0xE0  track volumes (confirmed on hardware), main volume and the
 *         send-return volumes
 *   0xC0  an instrument's DRY, per the Instrument View screenshot
 *   0x80  centre for bipolar controls: PAN (screenshot), DJ filter ("a
 *         value of 80 is off with no filtering"), Sampler DETUNE ("80 being
 *         the center frequency") and Hypersynth SUBOSC
 *   0xFF  stereo width ("00 is mono, FF is stereo") and filter cutoff
 *         (screenshot), i.e. fully open / not filtering
 *   0x00  everything else - sends, resonance, amp, modulation amounts and
 *         the enum-ish selectors, all starting at their first/least value
 * ============================================================================ */

/* The filter's two knobs, as one entry. Stated once because Wavsynth
 * carries a longer type list and would otherwise be a second copy.
 *
 * `modeKnobs` replaces the whole member list for a type whose controls
 * are not cutoff and resonance. M8's LP>HP is a lowpass corner and a
 * HIGHPASS corner, so CUT and RES are the wrong names - and a second
 * CUT/RES pair on one page collides with an ordinary filter's, which
 * render_page disambiguates by appending the slot number ("CUT24").
 *
 * The ORDER differs too, which is why this replaces the list rather
 * than just renaming it. RES is the highpass corner and CUT the lowpass
 * one, so on the response curve RES owns the LEFT edge of the band and
 * CUT the right; putting HP on the left knob makes the pair read the
 * same way round as the picture above them. The roles are looked up by
 * name, so the swap moves the knobs without touching the curve. */
function filterEntry(types) {
    return {
        /* Just "Filter": drawMenuList budgets a fixed ~6px per glyph for
         * a label and then truncates, so "Filter (2 knobs)" was cut
         * mid-word. The count is already in the value column
         * (entryPreview renders it as "2kn"), which is where it belongs. */
        label: "Filter",
        vizKind: "filter",
        vizModeRole: "mode",
        vizModeOptions: types,
        vizModePrompt: "Filter Type",
        modeKnobs: {
            /* Two independent corners and no resonance at all: M8's CUT
             * drives the LOWPASS (FF = wide open) and its RES drives the
             * HIGHPASS (00 = at DC), so both parameters are "off" at
             * their defaults and either one squeezes the band from its
             * own side.
             *
             * LOWPASS FIRST, which is the M8's own parameter order
             * (it lists CUT above RES). M8 mapping is a LEARN system,
             * so the natural gesture is to walk down the M8's screen
             * assigning each row to the next knob - and in this order
             * that lands each knob on the parameter its label claims.
             *
             * The pair was HP-first for a while, by request, and it is
             * worth recording why it came back: reversed, the natural
             * learn gesture CROSSES the two, and a crossed pair is
             * indistinguishable from a mirrored graphic. Three rounds
             * went on proving the drawing innocent. The order that
             * cannot be crossed by the obvious gesture wins over the
             * one that reads more tidily.
             *
             * The labels name the M8 parameter as well as the role -
             * the only two in the catalogue that do - so the header
             * reads "Ins02 LP (CUT)" and the mapping is unambiguous at
             * the moment you make it. */
            [FILTER_LP_HP]: [
                { m: "LP", label: "Lowpass (CUT)", def: 0xFF, role: "cutoff" },
                { m: "HP", label: "Highpass (RES)", def: 0x00, role: "resonance" },
            ],
        },
        knobs: [
            { m: "CUT", def: 0xFF, role: "cutoff" },
            { m: "RES", def: 0x00, role: "resonance" },
        ],
    };
}

/* Settings the shared viz layer cannot draw honestly, so no graphic is
 * formed for them and their knobs stay ordinary dials.
 *
 * M8's LP>HP is a lowpass whose RES sets the corner of a one-pole
 * HIGHPASS - two independent corners, and no resonance at all.
 * viz_draw's filterModeOf maps any name containing both "lp" and "hp" to
 * its BANDPASS, and that bandpass is a single hump centred on CUTOFF
 * which narrows and grows a peak as resonance rises: the wrong corner,
 * the wrong behaviour, and a resonant peak the filter does not have.
 *
 * Drawing it correctly needs a mode in viz_draw's own vocabulary - its
 * curve helpers (fillCurveMass, drawColumnCurve, PASS, EDGE) are all
 * module-private, and that file explicitly forbids a graph keeping its
 * own copy of the fill, because a filter that fills differently from the
 * envelope beside it can misrepresent the filter. Until such a mode
 * exists, no picture beats a wrong one. */
/* Written the way a person reads them rather than the way M8's screen
 * abbreviates them - the M8 is squeezing these into a hardware font and
 * we are not. They still have to be M8's words: viz_draw's filterModeOf
 * reads the selected option's TEXT to pick a response curve, so
 * "Bandstop" is a decision and not a spelling.
 *
 * LP > HP keeps its abbreviation on purpose. filterModeOf recognises the
 * pair only through a ">" (`lp\s*>\s*hp` or `lowpass\s*>\s*highpass`);
 * anything else containing both words - "LP to HP" - falls through to
 * the rule below it and is drawn as a BANDPASS, which is the wrong
 * corner and a resonant peak the filter does not have. The spelt-out
 * form matches too but is too long for a menu row. */
/* Declared up here rather than beside M8_FILTER_TYPES, which is where
 * they read naturally: VIZ_MODE_WAS below is keyed by FILTER_LP_HP, and
 * a const is in its temporal dead zone until its own line runs - so the
 * module threw on import, which `node --check` cannot see. */
const FILTER_OFF = "Off";
const FILTER_LP_HP = "LP > HP";

/* Shape ids for the three waveforms Schwung gained for M8's sake (see
 * the viz-lfo-exponential-and-square-up branch). An OLDER Schwung has no
 * case for them and lfoShapeSample falls through to its sine default, so
 * sampling one against a sine is a reliable way to ask whether this
 * host can draw it - and cheaper than shipping two builds of the
 * module or guessing from a version number. */
const LFO_SHAPE_PROBE = { "Exp Down": 100, "Exp Up": 101, "Square Up": 102 };

function libraryDrawsShape(id) {
    /* Two probe points, because a single one can coincide: an inverted
     * square and a sine happen to agree at phase 0. */
    return [0.1, 0.35].some((t) => lfoShapeSample(id, t) !== lfoShapeSample(0, t));
}

/* LP>HP is probed the same way, just through the filter model rather
 * than the LFO one: an older Schwung has no such mode and falls through
 * to its lowpass default, so a response that differs from a lowpass is
 * the answer. The probe point sits below the highpass corner, where the
 * two disagree most - a lowpass passes it and LP>HP stops it. */
function libraryDrawsLpHp() {
    return filterGainAt(0.2, "lphp", 0.8, 0.5) !== filterGainAt(0.2, "lp", 0.8, 0.5);
}

/* The spellings these modes were STORED under before the names were
 * written out. This check runs against a saved song, so a rename that
 * forgot them would quietly start drawing a wrong curve for every group
 * created before it - and drawing the wrong curve is the exact failure
 * the unsupported list exists to prevent. */
const VIZ_MODE_WAS = {
    [FILTER_LP_HP]: ["LP>HP"],
    "Exp Down": ["EXP DN"],
    "Exp Up": ["EXP UP"],
    "Square Up": ["SQU UP"],
};

/* Compared on a squashed key, so punctuation and spacing cannot make two
 * spellings of one mode look different - "LP > HP" and "LP>HP" are the
 * same answer. */
function vizModeKey(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const VIZ_UNSUPPORTED_KEYS = (() => {
    const keys = new Set();
    const mark = (name) => {
        keys.add(vizModeKey(name));
        for (const old of VIZ_MODE_WAS[name] || []) keys.add(vizModeKey(old));
    };
    if (!libraryDrawsLpHp()) mark(FILTER_LP_HP);
    /* An exponential drawn as a ramp is the wrong curve, and Square Up
     * drawn as the only square would be inverted - showing the LFO high
     * exactly when it is low. So on a host that cannot draw them, they
     * get plain dials; on one that can, they get their real waveform. */
    for (const name of Object.keys(LFO_SHAPE_PROBE)) {
        if (!libraryDrawsShape(LFO_SHAPE_PROBE[name])) mark(name);
    }
    return keys;
})();

function vizModeUnsupported(mode) {
    return !!mode && VIZ_UNSUPPORTED_KEYS.has(vizModeKey(mode));
}

/* M8's filter types, in the order the Multi-mode Filter Parameters section
 * lists them, plus the OFF the Instrument View screenshot shows as default.
 * These are OPTION TEXT, and their wording is load-bearing: viz_draw.mjs's
 * filterModeOf reads the selected option's text to decide which response
 * curve to draw, matching on words like "lowpass" / "bandpass" / "off". */
/* An M8 parameter's own full scale.
 *
 * Almost every row is a BYTE (00-FF), and a 7-bit CC therefore covers it in
 * steps of two - which is why the hex readout doubles what the knob stores.
 * Some rows are NOTE-valued and top out at 7F instead (Tracking's low and
 * high value, which can refer to note numbers); a CC covers those
 * one-for-one, so they must neither halve on the way in nor double on the
 * way out. Getting it wrong is invisible everywhere except the hex readout,
 * where a note-scaled knob reads exactly double its real value. */
const M8_NOTE_SCALE = 0x7F;

const M8_FILTER_TYPES = [
    FILTER_OFF, "Lowpass", "Highpass", "Bandpass", "Bandstop",
    FILTER_LP_HP, "ZDF Lowpass", "ZDF Highpass",
];

/* Wavsynth adds four modes that apply the filter INTO the waveform. Only
 * offered under Wavsynth, so the other types' lists stay honest. */
const M8_FILTER_TYPES_WAVSYNTH = M8_FILTER_TYPES.concat([
    "Wav Lowpass", "Wav Highpass", "Wav Bandpass", "Wav Bandstop",
]);

/* The LFO shapes the Instrument Modulation View lists, in its order. Like
 * the filter types these are read as TEXT by the viz layer - viz_draw's LFO
 * drawer resolves a shape name to the wave it draws - so the wording
 * matters more than it looks. The "T" (tick-rate) variants of each shape
 * are the same WAVE at a faster rate, so they are left out: they would
 * double the list without changing a single picture. */
/* Spelt out, for the same reason as the filter types - and with a bonus:
 * these names are lfoShapeIdOf's OWN vocabulary, so nothing has to be
 * translated on the way to storage any more. M8's abbreviations did not
 * match it ("RAMP DN" missed `rampdown` by two letters and silently drew
 * a sine), which is what the alias table used to paper over.
 *
 * "Square Down" is deliberate, not a typo for the library's plain
 * "square": viz_draw's one square starts HIGH, which is exactly what M8
 * calls SQU DN, and `squaredown` is matched to it. Square Up is the
 * separate shape added for M8's sake. */
const M8_LFO_SHAPES = [
    "Triangle", "Sine", "Ramp Down", "Ramp Up", "Exp Down", "Exp Up",
    "Square Down", "Square Up", "Random", "Drunk",
];

/* ---------------------------------------------------------------- mixer */

const M8_MIXER_PARAMS = [
    { m: "VT", label: "Track Volume", def: 0xE0, needsTrack: true },
    { m: "VMV", label: "Main Volume", def: 0xE0 },
    { m: "OTT", label: "OTT Volume", def: 0x00 },
    { m: "DJF", label: "DJ Filter", def: 0x80 },
    { m: "VMX", label: "ModFX Volume", def: 0xE0 },
    { m: "VDE", label: "Delay Volume", def: 0xE0 },
    { m: "VRE", label: "Reverb Volume", def: 0xE0 },
    { m: "IVO", label: "Input Volume", def: 0x00 },
    { m: "IMX", label: "Input ModFX", def: 0x00 },
    { m: "IDE", label: "Input Delay", def: 0x00 },
    { m: "IRV", label: "Input Reverb", def: 0x00 },
    { m: "IV2", label: "Input 2 Volume", def: 0x00 },
    { m: "IM2", label: "Input 2 ModFX", def: 0x00 },
    { m: "ID2", label: "Input 2 Delay", def: 0x00 },
    { m: "IR2", label: "Input 2 Reverb", def: 0x00 },
    { m: "USB", label: "USB Volume", def: 0x00 },
    { m: "UMX", label: "USB ModFX", def: 0x00 },
    { m: "UDE", label: "USB Delay", def: 0x00 },
    { m: "URV", label: "USB Reverb", def: 0x00 },
];

/* ---------------------------------------------------------------- sends */

/* Both send effects end in a REVERB SEND row, and neither can be called
 * "XDR"/"XMR" without trouble: XDR is the FX command for the delay's TIME
 * (one command covering both the left and right rows), so reusing it for a
 * different row of the same screen is the one collision this catalogue can
 * actually cause. "D>R" and "M>R" say what the row does, fit the cell with
 * room to spare, and cannot be mistaken for an FX command - which is the
 * right side of the line to be on, since the FX commands and the
 * CC-mappable screen rows are simply different namespaces. */
const M8_SEND_GROUPS = [
    {
        name: "ModFX",
        ctx: "MFX",
        params: [
            { m: "XMM", label: "Mod Depth", def: 0x40 },
            { m: "XMF", label: "Mod Freq", def: 0x80 },
            { m: "XMW", label: "Width", def: 0xFF },
            { m: "M>R", label: "To Reverb", def: 0x00 },
        ],
    },
    {
        name: "Delay",
        ctx: "DLY",
        params: [
            { m: "XDL", label: "Time L", def: 0x30 },
            { m: "XDR", label: "Time R", def: 0x30 },
            { m: "XDF", label: "Feedback", def: 0x80 },
            { m: "XDW", label: "Width", def: 0xFF },
            { m: "D>R", label: "To Reverb", def: 0x00 },
        ],
    },
    {
        name: "Reverb",
        ctx: "REV",
        params: [
            { m: "XRS", label: "Room Size", def: 0xFF },
            { m: "XRD", label: "Decay", def: 0xC0 },
            { m: "XSH", label: "Shimmer", def: 0x00 },
            { m: "XRM", label: "Mod Depth", def: 0x10 },
            { m: "XRF", label: "Mod Freq", def: 0xFF },
            { m: "XRW", label: "Width", def: 0xFF },
        ],
    },
];

/* ------------------------------------------------------------------- EQ
 *
 * M8 carries a 3-band parametric EQ in several places at once: 128
 * numbered slots that instruments are pointed at (an instrument names a
 * slot rather than owning an EQ, so several can share one), the main mix,
 * and one for each of the three send effects.
 *
 * The bands are LOW, MID and HIGH, and those names describe their
 * DEFAULTS rather than any fixed role - the manual is explicit that "each
 * band is functionally identical and can be configured to suit your
 * needs", so all three offer the same five rows.
 *
 * NO FX MNEMONICS EXIST FOR THESE. The Mixer & Effects Commands appendix
 * publishes only EQM and EQI, and both of those assign a SLOT rather than
 * move a band. So these follow the catalogue's other rule and take the EQ
 * editor's own row names, shortened, prefixed with the band.
 *
 * THE DEFAULTS ARE THE CONVENTION, NOT A SCREENSHOT. The Instrument View
 * screenshot could be read for exact bytes because that screen prints
 * hex; the EQ editor prints decibels and hertz instead (GAIN -05.00,
 * FREQ 1547, Q 64), so there is no byte on it to copy. GAIN is a boost
 * or a cut about zero, so it takes the 0x80 that the other bipolar
 * controls take; FREQ and Q start mid-range on the same reasoning; TYPE
 * and MODE are enum-ish selectors and start at 0x00, which is their
 * first entry (LOWCUT and STEREO). As everywhere else in this catalogue
 * these are only STARTING VALUES - nothing here addresses the M8, which
 * learns each CC from the knob you turn. */
/* FREQUENCY IS A TABLE, NOT A CURVE.
 *
 * The EQ's frequency runs 37 Hz to 15 kHz over 128 steps, and the spacing
 * is neither linear nor a clean exponent: it opens in 2 Hz steps
 * (37, 39, 41 ... 49), then widens unevenly all the way out. So the
 * readings are listed rather than computed - ONE ENTRY PER CC STEP, which
 * is what makes the table exactly 128 long and lets a knob's value index
 * it directly. */
const M8_EQ_FREQ_TABLE = [
    37, 39, 41, 43, 45, 47, 49, 52,
    54, 57, 59, 62, 65, 69, 72, 75,
    79, 83, 87, 91, 95, 100, 105, 110,
    115, 121, 127, 133, 139, 146, 153, 160,
    168, 176, 185, 194, 203, 213, 223, 234,
    245, 257, 269, 282, 296, 310, 325, 341,
    357, 375, 393, 411, 431, 452, 474, 497,
    521, 546, 572, 599, 628, 659, 690, 724,
    776, 814, 853, 894, 937, 982, 1029, 1079,
    1131, 1185, 1242, 1302, 1365, 1431, 1499, 1572,
    1647, 1727, 1810, 1897, 1988, 2084, 2184, 2289,
    2399, 2515, 2636, 2763, 2896, 3035, 3181, 3334,
    3494, 3663, 3839, 4024, 4217, 4420, 4633, 4856,
    5089, 5334, 5591, 5860, 6142, 6437, 6747, 7072,
    7412, 7769, 8142, 8534, 8945, 9375, 9826, 10299,
    10795, 11314, 11859, 12429, 13027, 13654, 14311, 15000,
];

/* The default frequency of each band, as an index into the table above -
 * which is also where the bands get their names. Two of the three are
 * the NEAREST step to a round number rather than the number itself: the
 * M8 shows about 1 kHz and about 5 kHz, and the table's nearest rungs
 * are 982 Hz and 5089 Hz. There is no step on exactly 1000 or 5000. */
const M8_EQ_BANDS = [
    { name: "Low", stem: "L", freqStep: 21 },
    { name: "Mid", stem: "M", freqStep: 69 },
    { name: "High", stem: "H", freqStep: 104 },
];

/* TYPE and MODE are NOT here, and are not an oversight: neither is
 * assignable over MIDI on the M8 - they are selectors you move on the
 * device - so a knob pointed at one would be a knob that does nothing.
 * For the record, TYPE is one of LOWCUT, LOWSHELF, BELL, BANDPASS,
 * HI.SHELF, HI.CUT and ALLPASS, and MODE one of STEREO, MID, SIDE, LEFT
 * and RIGHT.
 *
 * `def` is an M8 byte, as everywhere else in this catalogue, and the
 * factory halves it for a knob that counts in CC steps - so a frequency
 * default is its table index doubled. Gain and Q both default to the
 * middle of their travel: 0.00 dB and Q 50. */
const M8_EQ_BAND_PARAMS = [
    { suffix: "GN", label: "Gain", def: 0x80, display: KNOB_DISPLAY_EQ_GAIN },
    { suffix: "FQ", label: "Freq", display: KNOB_DISPLAY_EQ_FREQ },
    { suffix: "Q", label: "Q", def: 0x80, display: KNOB_DISPLAY_EQ_Q },
];

/* The ends of the two computed readings, so the formatter and this
 * catalogue cannot drift apart. LOW and HIGH are the ends of the KNOB's
 * travel, not of the number: Q reads 01 at the bottom and 99 at the top. */
const EQ_GAIN_RANGE_DB = 40;
const EQ_Q_LOW = 1;
const EQ_Q_HIGH = 99;

/* Flat rather than a band step then a parameter step: fifteen rows is one
 * scrolling list, and "Low Gain" reads as well in it as "Gain" would two
 * clicks deeper. */
const M8_EQ_PARAMS = (() => {
    const out = [];
    for (const band of M8_EQ_BANDS) {
        for (const p of M8_EQ_BAND_PARAMS) {
            out.push({
                m: `${band.stem}${p.suffix}`,
                label: `${band.name} ${p.label}`,
                /* Frequency is the one row whose default differs per
                 * band - it is what LOW, MID and HIGH mean. */
                def: p.def === undefined ? band.freqStep * 2 : p.def,
                display: p.display,
            });
        }
    }
    return out;
})();

/* The EQs themselves. Only the slot path needs a number; the other four
 * are one EQ each and are told apart by the header line. */
const M8_EQ_SLOT_MAX = 0x7F;      /* 128 slots, 00-7F */
const M8_EQ_TARGETS = [
    { name: "Slot", ctx: null },
    { name: "Main Mix", ctx: "EQMix" },
    { name: "ModFX", ctx: "EQMFX" },
    { name: "Delay", ctx: "EQDly" },
    { name: "Reverb", ctx: "EQRev" },
];

/* --------------------------------------------------- instrument: generic */

/* The rows every instrument type carries. Defaults confirmed against the
 * device.
 *
 * WHAT IS NOT HERE IS THE POINT. M8 only maps a CC to a parameter with a
 * VISUAL SLIDER - the manual says so twice, about the touchscreen and about
 * MIDI CCs, in the same sentence pair - so every selector row is
 * unmappable and offering one would offer a knob that can never be learned
 * onto anything. That rules out FILTER type, LIM, SHAPE, PLAY mode, SLICE,
 * ALGO, the FM operator shapes, SCALE, CHORD, the ModFX mod type, reverb
 * FREEZE and the DJ filter's type - all of which earlier passes of this
 * catalogue offered. VOL, PIT and FIN are absent for the older reason: they
 * are FX commands that OFFSET a playing note rather than naming a row the
 * cursor can rest on. */
const M8_INSTRUMENT_GENERIC = [
    /* The filter as ONE GRAPHIC across two knobs. Its TYPE is asked for by
     * the wizard and stored with the group rather than given a knob of its
     * own, because the type is a selector and so cannot be mapped - see
     * vizModeFor and the span:false role ensureSongPageMeta emits. */
    filterEntry(M8_FILTER_TYPES),
    { m: "CUT", label: "Cutoff", def: 0xFF },
    { m: "RES", label: "Resonance", def: 0x00 },
    { m: "AMP", label: "Amp", def: 0x00 },
    { m: "PAN", label: "Pan", def: 0x80 },
    { m: "DRY", label: "Dry", def: 0xC0 },
    { m: "MFX", label: "ModFX Send", def: 0x00 },
    { m: "DEL", label: "Delay Send", def: 0x00 },
    { m: "REV", label: "Reverb Send", def: 0x00 },
];

/* ---------------------------------------------- instrument: type-specific */

/* Only the rows a type has BEYOND the generic set, so this list is what
 * "Instrument Type" offers and the generic set is reached from its own
 * category. External Instrument and MIDI Out are therefore absent: once
 * their selectors (port, channel, bank, the custom CC assignments) are
 * ruled out they have nothing of their own left. External Instrument is
 * still fully usable - it carries audio, so its filter, amp, pan, dry and
 * sends are exactly the generic rows, one category across. */
const M8_INSTRUMENT_TYPES = [
    {
        name: "Wavsynth",
        /* Wavsynth's filter offers four extra in-waveform modes, so its own
         * filter graphic carries the longer type list. */
        filterTypes: M8_FILTER_TYPES_WAVSYNTH,
        params: [
            { m: "SIZ", label: "Size", def: 0x20 },
            { m: "MUL", label: "Mult", def: 0x00 },
            { m: "WRP", label: "Warp", def: 0x00 },
            { m: "SCN", label: "Scan", def: 0x00 },
        ],
    },
    {
        name: "Macrosynth",
        params: [
            { m: "TBR", label: "Timbre", def: 0x80 },
            { m: "COL", label: "Color", def: 0x80 },
            { m: "DEG", label: "Degrade", def: 0x00 },
            { m: "RDX", label: "Redux", def: 0x00 },
        ],
    },
    {
        name: "Sampler",
        params: [
            { m: "STA", label: "Start", def: 0x00 },
            { m: "LST", label: "Loop Start", def: 0x00 },
            { m: "LEN", label: "Length", def: 0xFF },
            { m: "DTN", label: "Detune", def: 0x80 },
            { m: "DEG", label: "Degrade", def: 0x00 },
        ],
    },
    {
        name: "FM Synth",
        params: [
            { m: "RTA", label: "Op A Ratio", def: 0x00 },
            { m: "RTB", label: "Op B Ratio", def: 0x00 },
            { m: "RTC", label: "Op C Ratio", def: 0x00 },
            { m: "RTD", label: "Op D Ratio", def: 0x00 },
            { m: "LVA", label: "Op A Level", def: 0x00 },
            { m: "LVB", label: "Op B Level", def: 0x00 },
            { m: "LVC", label: "Op C Level", def: 0x00 },
            { m: "LVD", label: "Op D Level", def: 0x00 },
            { m: "FBA", label: "Op A Feedback", def: 0x00 },
            { m: "FBB", label: "Op B Feedback", def: 0x00 },
            { m: "FBC", label: "Op C Feedback", def: 0x00 },
            { m: "FBD", label: "Op D Feedback", def: 0x00 },
        ],
    },
    {
        name: "Hypersynth",
        params: [
            { m: "SFT", label: "Shift", def: 0x80 },
            { m: "SWM", label: "Swarm", def: 0x00 },
            { m: "WID", label: "Width", def: 0x00 },
            { m: "SUB", label: "Sub Osc", def: 0x80 },
        ],
    },
];

/* ------------------------------------------------------ instrument: mods */

/* M8 has 4 modulation slots per instrument and each slot can be ANY of these
 * types, so the wizard asks which slot and then which type rather than
 * offering one fixed set of modulator parameters.
 *
 * A type's SHAPE parameters are offered twice - once as a single multi-knob
 * graphic and once as individual knobs - because a graphic needs a
 * contiguous run of free slots on one row and there is not always one to
 * spare. modType() derives both from ONE list so a default is written once:
 * they were two hand-kept lists, and they had already drifted (the LFO's
 * graphic still said FRQ 00 / AMT 00 after the individual entries were
 * corrected to 10 / FF).
 *
 * AMOUNT is an EXTRA for the envelopes, not part of their graphic:
 * viz_draw's envelope reads only the shape roles, so an amount knob inside
 * the span would be a cell the picture covers but never reflects. For an
 * LFO it is the `depth` role and so belongs in the shape list. */
function modType({ name, vizKind, vizModeOptions, vizModePrompt, graphicLabel, shape, extras }) {
    const params = [];
    if (vizKind && shape.length >= 2) {
        const graphic = {
            label: graphicLabel,
            vizKind,
            knobs: shape.map((k) => ({ m: k.m, def: k.def, role: k.role, scale: k.scale })),
        };
        if (vizModeOptions) {
            graphic.vizModeOptions = vizModeOptions;
            graphic.vizModePrompt = vizModePrompt;
        }
        params.push(graphic);
    }
    for (const e of extras || []) params.push(e);
    for (const k of shape) params.push({ m: k.m, label: k.label, def: k.def });
    return { name, params };
}

const M8_MOD_AMOUNT = { m: "AMT", label: "Amount", def: 0xFF };

const M8_MOD_TYPES = [
    modType({
        name: "AHD Envelope",
        vizKind: "envelope",
        graphicLabel: "Envelope",
        extras: [M8_MOD_AMOUNT],
        shape: [
            { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
            { m: "HLD", label: "Hold", def: 0x00, role: "hold" },
            { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
        ],
    }),
    modType({
        name: "ADSR Envelope",
        vizKind: "envelope",
        graphicLabel: "Envelope",
        extras: [M8_MOD_AMOUNT],
        shape: [
            { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
            { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
            { m: "SUS", label: "Sustain", def: 0x80, role: "sustain" },
            { m: "REL", label: "Release", def: 0x80, role: "release" },
        ],
    }),
    modType({
        name: "Drum Envelope",
        vizKind: "envelope",
        graphicLabel: "Envelope",
        extras: [M8_MOD_AMOUNT],
        /* PEAK/BODY/DECAY are the drum envelope's own names; they map onto
         * the envelope drawer's attack/hold/decay roles because that is the
         * shape they describe - a sharp transient, a held body, then a
         * fall. The knobs keep M8's names. */
        shape: [
            { m: "PEK", label: "Peak", def: 0x80, role: "attack" },
            { m: "BOD", label: "Body", def: 0x10, role: "hold" },
            { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
        ],
    }),
    modType({
        name: "LFO",
        vizKind: "lfo",
        graphicLabel: "LFO",
        /* OSC (shape) and TRIG are selectors, so neither can be mapped and
         * neither gets a knob. The wave the graphic draws is asked for once,
         * when the graphic is added, and stored with it. */
        vizModeOptions: M8_LFO_SHAPES,
        vizModePrompt: "LFO Shape",
        shape: [
            { m: "FRQ", label: "Freq", def: 0x10, role: "rate" },
            { m: "AMT", label: "Amount", def: 0xFF, role: "depth" },
        ],
    }),
    modType({
        name: "Trig Envelope",
        vizKind: "envelope",
        graphicLabel: "Envelope",
        extras: [M8_MOD_AMOUNT],
        shape: [
            { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
            { m: "HLD", label: "Hold", def: 0x00, role: "hold" },
            { m: "DEC", label: "Decay", def: 0x40, role: "decay" },
        ],
    }),
    modType({
        name: "Tracking",
        shape: [],
        extras: [
            M8_MOD_AMOUNT,
            { m: "LVL", label: "Low Value", def: 0x00, scale: M8_NOTE_SCALE },
            { m: "HVL", label: "High Value", def: 0x7F, scale: M8_NOTE_SCALE },
        ],
    }),
];

/* ------------------------------------------------------ generic: shapes */

/* Knobs chosen by their PICTURE, with no M8 parameter behind them yet.
 *
 * M8's mapping is a learn system - the device is told which CC drives
 * which parameter, and nothing here addresses a parameter by CC - so a
 * knob's "connection" is only ever a NAME, a sensible starting value and
 * the line the header spells out. Which means it can be decided after the
 * fact, and often wants to be: you know you want an envelope on this row
 * long before you have settled which instrument's third mod slot it is.
 * Knob Settings > Connect fills it in later.
 *
 * By shape rather than by type, so the three 3-knob envelopes M8 has -
 * AHD, Drum and Trig - are ONE row. They draw the identical picture and
 * differ only in what M8 calls their knobs, which is exactly the part
 * Connect supplies; three indistinguishable rows would be three ways to
 * ask for the same graphic. */
/* Filter types whose CURVE is one already offered. ZDF is M8's
 * zero-delay-feedback implementation of the same response - it sounds
 * different and is a real choice on the instrument, but it draws the
 * identical picture, and this list is chosen by picture. Which of the
 * two it is, is a Connect question, exactly as with the three 3-knob
 * envelopes.
 *
 * They stay in the TYPE picker under Instrument, where the choice is the
 * M8 parameter rather than the graphic. */
const VIZ_SAME_AS_TYPE = {
    "ZDF Lowpass": "Lowpass",
    "ZDF Highpass": "Highpass",
};

function fixedModeEntry(base, label, mode) {
    const entry = Object.assign({}, base, { label, fixedVizMode: mode });
    /* The mode is answered here, so the wizard must not ask for it. */
    delete entry.vizModeOptions;
    delete entry.vizModePrompt;
    return entry;
}

const M8_GENERIC_SHAPES = (() => {
    const out = [
        {
            label: "Envelope (3)", vizKind: "envelope",
            knobs: [
                { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
                { m: "HLD", label: "Hold", def: 0x00, role: "hold" },
                { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
            ],
        },
        {
            label: "Envelope (4)", vizKind: "envelope",
            knobs: [
                { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
                { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
                { m: "SUS", label: "Sustain", def: 0x80, role: "sustain" },
                { m: "REL", label: "Release", def: 0x80, role: "release" },
            ],
        },
    ];
    /* Built from the same entries the connected paths use, so a shape
     * offered here cannot describe different knobs from the one reached
     * through Instrument. */
    const filter = filterEntry(M8_FILTER_TYPES);
    for (const t of M8_FILTER_TYPES) {
        if (VIZ_SAME_AS_TYPE[t] || t === FILTER_OFF) continue;
        out.push(fixedModeEntry(filter, `Filter ${t}`, t));
    }
    const lfo = M8_MOD_TYPES.find((t) => t.name === "LFO");
    const lfoGraphic = lfo && lfo.params.find((p) => p.vizKind === "lfo");
    if (lfoGraphic) {
        for (const s of M8_LFO_SHAPES) out.push(fixedModeEntry(lfoGraphic, `LFO ${s}`, s));
    }
    return out;
})();

function makeKnobConfig(cc, opts) {
    const o = opts || {};
    /* The catalogue's defaults are M8 BYTES. A hex knob counts in bytes
     * too, so the default goes in as it stands; a knob on any other
     * display counts in CC steps and halves it. A note-valued parameter
     * is 0-127 on the M8 itself either way. See M8_NOTE_SCALE and
     * knobFineHex. */
    const noteScaled = o.scale === M8_NOTE_SCALE;
    const display = o.display === undefined ? KNOB_DISPLAY_HEX : o.display;
    const fine = display === KNOB_DISPLAY_HEX && !noteScaled;
    const top = fine ? 255 : 127;
    const raw = o.def === undefined ? 0 : (noteScaled || fine ? o.def : o.def / 2);
    const value = Math.max(0, Math.min(top, Math.round(raw)));
    const knob = {
        name: o.name || "PRM",
        cc,
        value,
        default: value,
        mode: KNOB_MODE_ABSOLUTE,
        display,
    };
    /* Only the exception is stored, so an ordinary knob's saved form is
     * unchanged and every song written before this still loads as
     * byte-scaled - which is what all of them are. */
    if (noteScaled) knob.scale = M8_NOTE_SCALE;
    /* What the wizard was pointing at when this knob was made - shown in
     * the header while the knob is touched. See commitWizardEntry. */
    if (o.detail) knob.detail = o.detail;
    /* Membership of a multi-knob graphic: which group, what it draws, and
     * this knob's part in it (viz.mjs's role vocabulary). */
    if (o.viz) knob.viz = o.viz;
    return knob;
}

/* An empty page: 8 slots, none filled. Slots are POSITIONS, not a list -
 * a knob keeps the physical encoder it was added to, and removing one
 * leaves a hole rather than sliding its neighbours under the user's
 * fingers. Songs saved before knobs became individual have all 8 filled,
 * which is just a full page and needs no migration. */
function makeSongPage(name) {
    return { name: name || "", knobs: new Array(KNOBS_PER_PAGE).fill(null) };
}

function makeSong(name) {
    return { id: makeSongId(), name: name || "New Song", pages: [makeSongPage()] };
}

/* Lowest CC in 1-119 that no knob anywhere in this song already uses. CC 0
 * is Bank Select MSB and 120-127 are reserved channel-mode messages, so
 * neither end is handed out. */
function nextFreeCc(song) {
    const used = new Set();
    for (const p of song.pages) {
        for (const k of p.knobs) {
            if (k) used.add(k.cc);
        }
    }
    for (let cc = 1; cc <= 119; cc++) {
        if (!used.has(cc)) return cc;
    }
    return 1; /* 119 knobs in one song - reuse rather than refuse */
}

/* Where the next added knob (or run of knobs) goes: the first free run of
 * `count` slots WITHIN ONE ROW, searching the page the user is looking at
 * and then any later page, else a new page appended to the song. Returns
 * { pageIndex, slot }.
 *
 * The row constraint is viz.mjs's, not ours: a graphic is only drawn for a
 * group whose slots are contiguous AND share a row (isAdjacentRun), because
 * a picture cannot span the gap between the two rows of cells. A run of 4
 * therefore fits only at slot 0 or 4. For count 1 this walks 0..7 in order,
 * exactly as a plain "first empty slot" search would. */
function nextFreeKnobRun(song, count) {
    const n = Math.max(1, count | 0);
    for (let p = activePageIndex; p < song.pages.length; p++) {
        const knobs = song.pages[p].knobs;
        for (let base = 0; base < KNOBS_PER_PAGE; base += KNOBS_PER_ROW) {
            for (let start = base; start + n <= base + KNOBS_PER_ROW; start++) {
                let free = true;
                for (let i = 0; i < n; i++) {
                    if (knobs[start + i]) { free = false; break; }
                }
                if (free) return { pageIndex: p, slot: start };
            }
        }
    }
    song.pages.push(makeSongPage());
    return { pageIndex: song.pages.length - 1, slot: 0 };
}

/* Can `count` knobs start at this exact page/slot - free, and all within
 * one row? See nextFreeKnobRun for why the row matters. */
function runFitsAt(song, target, count) {
    const page = song.pages[target.pageIndex];
    if (!page) return false;
    const rowEnd = (Math.floor(target.slot / KNOBS_PER_ROW) + 1) * KNOBS_PER_ROW;
    if (target.slot + count > rowEnd) return false;
    for (let i = 0; i < count; i++) {
        if (page.knobs[target.slot + i]) return false;
    }
    return true;
}

/* ------------------------------------------------- abbreviating the detail */

/* The header's right-hand slot is about 14 characters wide, and "Ins1A "
 * spends six of them before the parameter is named at all. renderPage does
 * shorten an over-long one, but it does it by chopping - "Track Volume"
 * came out as "Tra Volume" - so the words are abbreviated here, where a
 * human picked each one, and the library's fitter is left as the backstop
 * for the few that are still too long.
 *
 * A table of WORDS rather than of labels: the catalogue has ~80 labels
 * built from ~60 words, most of which repeat, and a word table also covers
 * a label added later without anyone remembering to shorten it. */
const M8_LABEL_WORDS = {
    Amount: "Amt", Attack: "Atk", Color: "Col", Cutoff: "Cut",
    Decay: "Dec", Degrade: "Degr", Delay: "Dly", Depth: "Dpt",
    Detune: "Det", Feedback: "Fbk", Filter: "Flt", Highpass: "HP",
    Input: "In", Length: "Len", Level: "Lvl", Lowpass: "LP",
    ModFX: "MFX", Ratio: "Rat", Redux: "Rdx", Release: "Rel",
    Resonance: "Res", Reverb: "Rev", Shift: "Shft", Shimmer: "Shmr",
    Start: "Strt", Sustain: "Sus", Swarm: "Swrm", Timbre: "Tmb",
    Track: "Trk", Value: "Val", Volume: "Vol", Width: "Wid",
};

/* "Input 2 Volume" -> "In 2 Vol" -> "In2 Vol", "Op A Level" -> "OpA Lvl".
 * A bare index reads as part of the thing it indexes, so closing that gap
 * buys a character and loses nothing. */
const M8_LABEL_INDEX_RE = /\b(In|Op) ([0-9A-D])\b/g;

function shortLabel(text) {
    const words = String(text || "").split(" ");
    for (let i = 0; i < words.length; i++) {
        const short = M8_LABEL_WORDS[words[i]];
        if (short) words[i] = short;
    }
    return words.join(" ").replace(M8_LABEL_INDEX_RE, "$1$2");
}

/* Name stem -> what that knob is, so a knob carrying no stored `detail`
 * can still be described.
 *
 * `detail` is attached when the wizard creates a knob, which does
 * nothing for the knobs that already exist - and every knob on a device
 * that has been in use predates the field. Deriving from the NAME fixes
 * those retroactively and costs no storage, so the stored value is now
 * only a more precise answer where one was recorded.
 *
 * Built from the catalogue itself rather than written out again, so a
 * parameter cannot be renamed in one place and described from the
 * other. */
const M8_STEM_INDEX = (() => {
    const index = Object.create(null);
    const add = (m, label, kind, ctx) => {
        if (!m || index[m]) return;          /* first definition wins */
        index[m] = { label: label || m, kind, ctx };
    };
    /* Two passes per list, because a multi-knob GRAPHIC entry lists the same
     * stems as the individual entries beside it but is labelled for the
     * picture rather than the parameter - modType()'s graphic carries
     * "Envelope (3 knobs)" and its members carry no label at all. Taking the
     * graphic's label made CUT read "Filter" and FRQ read "LFO". So the
     * individually-named entries are indexed FIRST and a graphic member is
     * only a fallback, and only when it names itself. */
    const addParams = (params, kind, ctx) => {
        for (const p of params || []) {
            if (p.knobs) continue;
            add(p.m, p.label, kind, ctx);
        }
        for (const p of params || []) {
            if (!p.knobs) continue;
            for (const k of p.knobs) add(k.m, k.label, kind, ctx);
            for (const list of Object.values(p.modeKnobs || {})) {
                for (const k of list) add(k.m, k.label, kind, ctx);
            }
        }
    };
    addParams(M8_MIXER_PARAMS, "mix");
    for (const g of M8_SEND_GROUPS) addParams(g.params, "send", g.ctx);
    /* No ctx: which EQ it is varies per knob and comes from the wizard. */
    addParams(M8_EQ_PARAMS, "eq");
    addParams(M8_INSTRUMENT_GENERIC, "inst");
    for (const t of M8_INSTRUMENT_TYPES) addParams(typeParamsFor(t), "inst");
    for (const t of M8_MOD_TYPES) addParams(t.params, "mod");
    return index;
})();

/* Longest first, so "DEC" is not matched as "DE". */
const M8_STEMS_BY_LENGTH = Object.keys(M8_STEM_INDEX).sort((a, b) => b.length - a.length);

/* An instrument is always named with BOTH its hex digits - "Ins00",
 * "Ins1A". A knob's own name drops the padding because a 32px cell cannot
 * spare the character, which makes "CUT0" and "CUT10" look like different
 * shapes of the same thing; the header has the room to be unambiguous, and
 * the whole point of it is to say which instrument. */
function instCtx(n) {
    return `Ins${(Number(n) || 0).toString(16).toUpperCase().padStart(2, "0")}`;
}

/* What a knob is connected to: the recorded answer if there is one,
 * otherwise read back out of its name. A mod parameter is named for its
 * SLOT rather than its instrument (see m8KnobName), so a derived mod
 * detail can say "M2 Attack" but not which instrument - the recorded
 * one can, which is why it is still worth storing.
 *
 * Stored LONG and abbreviated on the way out, so a detail recorded before
 * the abbreviations existed shortens too, and so the wizard has one less
 * thing to get right. */
function knobDetail(knob) {
    return shortLabel(knobDetailLong(knob));
}

function knobDetailLong(knob) {
    if (!knob) return "";
    if (knob.detail) return knob.detail;
    const name = String(knob.name || "");
    for (const stem of M8_STEMS_BY_LENGTH) {
        if (!name.startsWith(stem)) continue;
        const entry = M8_STEM_INDEX[stem];
        const suffix = name.slice(stem.length);
        let ctx = "";
        if (entry.kind === "mix") ctx = "MIX";
        else if (entry.kind === "send") ctx = entry.ctx || "";
        /* The suffix is the instrument's hex, unpadded, straight off the
         * name - so it is parsed back rather than reprinted. */
        else if (entry.kind === "inst") ctx = suffix ? instCtx(parseInt(suffix, 16)) : "";
        else if (entry.kind === "mod") ctx = suffix ? `M${suffix}` : "";
        return [ctx, entry.label].filter(Boolean).join(" ");
    }
    return "";
}

/* "VT" + track 3 -> "VT3"; "CUT" + instrument 0x1A -> "CUT1A". Numbers are
 * M8's own hex where they name an instrument, unpadded so a 3-letter stem
 * plus a two-digit instrument still fits the ~5 characters a 32px cell
 * holds. A mod parameter takes the MOD SLOT as its number rather than the
 * instrument - "ATK2" - because the instrument is chosen once at the top of
 * the flow and applies to everything under it, while which of the four mod
 * slots you are looking at is the thing that actually distinguishes two
 * otherwise identical knobs on screen. */
function m8KnobName(stem, number) {
    if (number === null || number === undefined) return stem;
    return `${stem}${typeof number === "number" ? number.toString(16).toUpperCase() : number}`;
}

/* Turn one wizard leaf into knobs on the song.
 *
 * A leaf is either a single parameter (`m`) or a multi-knob graphic
 * (`knobs` + `vizKind`). Both land through here so slot allocation, CC
 * allocation and the page bookkeeping have one implementation.
 *
 * CCs are taken one at a time and AFTER each insertion, because nextFreeCc
 * reads the song: allocating a run up front would hand the same number to
 * every member of a group. */
/* Each member of a group describes ITSELF. The group's own label names the
 * picture ("Envelope (3 knobs)"), so handing it to all three members put
 * that on the header of each of them - less use than the answer derived
 * from the name would have been. modType()'s members carry no label, so
 * the stem index is the fallback, which is the same table knobDetail reads
 * and so cannot disagree with it. */
function memberDetail(ctx, member, entry) {
    /* With no context there is nothing to record that the name does not
     * already carry - and storing one anyway would make an UNCONNECTED
     * Generic shape indistinguishable from a connected knob on the
     * Connect row, which reports exactly this field. */
    if (!ctx) return "";
    const named = member.label
        || (M8_STEM_INDEX[member.m] && M8_STEM_INDEX[member.m].label)
        || (member === entry ? entry.label : "")
        || member.m || "";
    return [ctx, named].filter(Boolean).join(" ");
}

/* The knobs an entry turns into. A mode may replace the list outright -
 * different names and a different order. See filterEntry's modeKnobs. */
function entryMembers(entry, vizMode) {
    const mode = vizMode || entry.fixedVizMode;
    return (mode && entry.modeKnobs && entry.modeKnobs[mode]) || entry.knobs || [entry];
}

function addKnobsFromEntry(song, entry, number, target, vizMode, ctx) {
    const members = entryMembers(entry, vizMode);
    /* A target names the slot the gesture pointed at (the empty cell that
     * was touched). It is only honoured if the WHOLE run fits there within
     * one row - Shift+touching slot 3 and then choosing a 3-knob envelope
     * would otherwise straddle the row boundary, and viz.mjs refuses to
     * draw a group that does, leaving three live knobs and no picture. */
    const place = (target && runFitsAt(song, target, members.length))
        ? target : nextFreeKnobRun(song, members.length);
    const page = song.pages[place.pageIndex];
    if (!page) return null;

    /* One id per ADDED GROUP, not per catalogue entry: adding the same
     * envelope twice must produce two graphics, not one group of six roles
     * that fails the adjacency check and draws nothing. */
    const groupId = entry.vizKind ? `g${makeSongId()}` : null;

    /* Stored verbatim: the option names ARE the vocabulary viz_draw
     * matches on, which is what the readable spellings bought. */
    const storedMode = vizMode;

    members.forEach((member, i) => {
        const slot = place.slot + i;
        if (slot >= KNOBS_PER_PAGE) return;
        const knob = makeKnobConfig(nextFreeCc(song), {
            name: m8KnobName(member.m, number),
            def: member.def,
            scale: member.scale,
            /* A catalogue row may bring its own reading - an EQ frequency
             * is hertz, not a number out of the wire. Absent for almost
             * everything, which leaves makeKnobConfig's Hex default. */
            display: member.display,
            detail: memberDetail(ctx, member, entry),
            viz: groupId ? { group: groupId, kind: entry.vizKind, role: member.role } : undefined,
        });
        /* The graphic's fixed setting - which filter type, which LFO wave -
         * rides on the FIRST member. It is not a knob: the setting is a
         * selector on the M8 and so cannot be mapped to a CC, but the
         * picture is wrong without it, so the wizard asks once and stores
         * the answer here. ensureSongPageMeta turns it into a span:false
         * role, which is viz.mjs's own mechanism for a role that lends the
         * graphic a value without occupying one of its cells. */
        if (i === 0 && groupId && storedMode) knob.vizMode = storedMode;
        page.knobs[slot] = knob;
    });
    activePageIndex = place.pageIndex;
    ensureSparePage(song);
    markSongsDirty();
    return place;
}

/* Re-point knobs that already exist at a different M8 parameter, keeping
 * their SLOTS and their CCs.
 *
 * The CC is what the M8 has been taught, so changing it would silently
 * unlearn the mapping; the slot is a physical encoder the user has
 * already put their hand on. Everything else - name, starting value, the
 * line the header shows, and the picture - describes the parameter and so
 * follows it.
 *
 * A graphic travels as a BLOCK, the same one Slot moves (knobMoveBlock),
 * because connecting one cell of an envelope to something else would
 * leave viz.mjs a group whose members disagree. */
function connectKnobsFromEntry(song, entry, number, vizMode, ctx, index) {
    const page = song.pages[activePageIndex];
    if (!page || !page.knobs[index]) return;
    const block = knobMoveBlock(page, index);
    const members = entryMembers(entry, vizMode);
    const storedMode = vizMode;

    /* Reuse the group id if there is one, so a connected envelope stays
     * the same picture rather than becoming a second group over the same
     * cells. */
    const head = page.knobs[block.start];
    const groupId = entry.vizKind
        ? ((head && head.viz && head.viz.group) || `g${makeSongId()}`)
        : null;

    const paired = Math.min(block.size, members.length);
    for (let i = 0; i < block.size; i++) {
        const knob = page.knobs[block.start + i];
        if (!knob) continue;
        /* A block longer than the entry - a 4-knob envelope connected to a
         * 3-knob one - leaves knobs over. They keep their names but LOSE
         * the group: left in it they would carry a role the new picture
         * does not draw, which is a cell inside the graphic that nothing
         * ever updates. */
        if (i >= paired) {
            delete knob.viz;
            delete knob.vizMode;
            continue;
        }
        const member = members[i];
        const noteScaled = member.scale === M8_NOTE_SCALE;
        const raw = member.def === undefined ? 0 : (noteScaled ? member.def : member.def / 2);
        /* Re-pointing a knob at an EQ row brings that row's reading with
         * it, so a knob connected to "Low Freq" shows hertz rather than
         * whatever it counted in before. Done BEFORE the value is set, so
         * the min and max travel to the new scale and the value below
         * lands on it. */
        if (member.display !== undefined && knob.display !== member.display) {
            const wasFine = knobFineHex(knob);
            knob.display = member.display;
            rescaleKnobForDisplay(knob, wasFine);
        }
        knob.name = m8KnobName(member.m, number);
        knob.detail = memberDetail(ctx, member, entry);
        /* The old value described the old parameter, so it is not worth
         * keeping - 0xE0 meant "most of the way up" as a track volume and
         * means something else entirely as a filter cutoff. */
        knob.value = Math.max(0, Math.min(127, Math.round(raw)));
        knob.default = knob.value;
        if (noteScaled) knob.scale = M8_NOTE_SCALE;
        else delete knob.scale;
        delete knob.vizMode;
        if (groupId) knob.viz = { group: groupId, kind: entry.vizKind, role: member.role };
        else delete knob.viz;
        if (i === 0 && groupId && storedMode) knob.vizMode = storedMode;
    }
    markSongsDirty();
}

/* Keep an empty page at the end whenever the last one is full.
 *
 * Adding a knob is Shift+touch on an EMPTY SLOT, so a song whose last
 * page is full has no slot left to touch and the gesture dead-ends -
 * the Add Knob row in Knob Settings was the only way through, which is
 * not something anyone finds on their own. A spare page means the
 * obvious gesture always has somewhere to land: jog past the end and
 * there is a page of empty slots waiting.
 *
 * Only ever ONE spare, and only while the last real page is full, so
 * this cannot pile up blank pages - removeKnobAt prunes trailing empties
 * first and then asks for the spare again, which settles either way. */
function ensureSparePage(song) {
    const last = song.pages[song.pages.length - 1];
    if (last && last.knobs.indexOf(null) < 0) song.pages.push(makeSongPage());
}

/* Empty one slot, then drop any now-empty pages off the END of the song.
 * Pages exist because knobs do (nextFreeKnobRun appends one when the last
 * fills up), so a trailing page with nothing on it is just the reverse of
 * that and would otherwise be un-removable - there is no delete-page
 * gesture any more. A page in the MIDDLE is left alone even when empty:
 * removing it would renumber every page after it, moving pages the user
 * scrolls by. A song always keeps at least one page. */
function removeKnobAt(song, pageIndex, slot) {
    const page = song.pages[pageIndex];
    if (!page || !page.knobs[slot]) return;
    page.knobs[slot] = null;
    while (song.pages.length > 1
           && song.pages[song.pages.length - 1].knobs.every((k) => !k)) {
        song.pages.pop();
    }
    /* Clamp BEFORE the spare is added, or removing the last knob from a
     * page lands you on the blank spare rather than on the page that
     * still has knobs on it. */
    activePageIndex = Math.max(0, Math.min(song.pages.length - 1, activePageIndex));
    ensureSparePage(song);
    markSongsDirty();
}

/* The text of songs.json as this module last saw it, so an edit made
 * from the web page can be told apart from our own autosave. */
let lastSongsRaw = null;

function loadSongs() {
    const raw = std.loadFile(SONGS_PATH);
    lastSongsRaw = raw;
    if (raw) {
        try {
            const parsed = std.parseExtJSON(raw);
            if (Array.isArray(parsed)) {
                /* Bare-array format from before the active song was persisted -
                 * read it, but never written again below. */
                songs = parsed;
            } else if (parsed && Array.isArray(parsed.songs)) {
                songs = parsed.songs;
                activeSongId = parsed.activeSongId || null;
                migrateKnobScale(parsed.schema);
                /* Merged over the defaults rather than replacing them, so
                 * a file written before a setting existed still loads and
                 * simply takes that setting's default. */
                settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
            }
        } catch (e) {
            /* A malformed songs.json must not crash the module (this runs from
             * markM8Connected, itself called from the MIDI callback) - fall
             * through to the empty-list default below instead. */
            console.log(`loadSongs: failed to parse ${SONGS_PATH}: ${e}`);
        }
    }
    const invented = !songs.length;
    if (invented) songs = [makeSong("New Song")];
    for (const song of songs) ensureSparePage(song);
    if (!activeSongId || !songs.some((s) => s.id === activeSongId)) {
        activeSongId = songs[0].id;
        activePageIndex = 0;
    }
    /* Written only for a song we just invented, and only AFTER the active
     * id is resolved. Saving before that point recorded
     * `activeSongId: null`, which the next load silently repaired - so the
     * file on a fresh install was wrong from the moment it was created and
     * nothing ever said so. */
    if (invented) saveSongs();
    console.log(`loadSongs: ${songs.length} song(s), active="${getActiveSong().name}"`);
}


/* ============================================================================
 * The same settings, from the web UI.
 *
 * Schwung Manager renders a Settings page for any module that ships a
 * settings-schema.json, and stores what you choose in config.json beside
 * it. That file is the web UI's only channel: it never talks to a running
 * module. So the two are kept in step from this side -
 *
 *   - config.json is read at startup and applied over the settings, and
 *     POLLED while running, so a change made in a browser lands on the
 *     device without a restart;
 *   - every change made ON the device is written back to config.json, so
 *     the web page shows what the hardware actually has rather than a
 *     stale copy.
 *
 * Last writer wins, which for a person at one device and one browser is
 * the behaviour they expect. The file is merged rather than replaced, so
 * keys this module does not manage survive.
 *
 * Channels are stored 1-16 here, matching the schema and how everyone
 * numbers them; internally they are 0-15.
 * ============================================================================ */

/* In a function: MODULE_DIR is declared above this, but deriving paths at
 * call time is the habit that keeps this file free of dead-zone faults. */
function configPath() {
    return MODULE_DIR + "/config.json";
}

/* The raw text last seen, so the poll can ignore our own writes and skip
 * parsing an unchanged file. */
let lastConfigRaw = null;
const CONFIG_POLL_TICKS = 90;        /* ~2s at the module's ~44Hz tick */
let configPollTicks = 0;

function settingsAsConfig() {
    return {
        knob_channel: settings.knobChannel + 1,
        master_cc: settings.masterCc,
        master_channel: settings.masterChannel + 1,
        master_mode: settings.masterMode === KNOB_MODE_RELATIVE ? "relative" : "absolute",
        master_display: MASTER_DISPLAY_KEYS[settings.masterDisplay] || MASTER_DISPLAY_KEYS[KNOB_DISPLAY_HEX],
        odd_rows: !!settings.oddRows,
        knob_leds: KNOB_SWEEP_KEYS[settings.knobLeds] || KNOB_SWEEP_KEYS[KNOB_SWEEP_DEFAULT],
    };
}

/* Returns true if anything actually moved, so a caller knows whether the
 * pads and leds need catching up. Each key is checked on its own: a
 * config.json holding only one of them is perfectly legal. */
function applyConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return false;
    let changed = false;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const num = (v) => (typeof v === "number" ? v : parseInt(v, 10));

    if (cfg.knob_channel !== undefined) {
        const ch = clamp(num(cfg.knob_channel) - 1, 0, 15);
        if (!isNaN(ch) && ch !== settings.knobChannel) { settings.knobChannel = ch; changed = true; }
    }
    if (cfg.master_channel !== undefined) {
        const ch = clamp(num(cfg.master_channel) - 1, 0, 15);
        if (!isNaN(ch) && ch !== settings.masterChannel) { settings.masterChannel = ch; changed = true; }
    }
    if (cfg.master_cc !== undefined) {
        const cc = clamp(num(cfg.master_cc), 0, 127);
        if (!isNaN(cc) && cc !== settings.masterCc) { settings.masterCc = cc; changed = true; }
    }
    if (cfg.master_mode !== undefined) {
        const mode = String(cfg.master_mode) === "relative"
            ? KNOB_MODE_RELATIVE : KNOB_MODE_ABSOLUTE;
        if (mode !== settings.masterMode) { settings.masterMode = mode; changed = true; }
    }
    if (cfg.master_display !== undefined) {
        const idx = MASTER_DISPLAY_KEYS.indexOf(String(cfg.master_display));
        if (idx >= 0 && idx !== settings.masterDisplay) { settings.masterDisplay = idx; changed = true; }
    }
    if (cfg.knob_leds !== undefined) {
        const idx = KNOB_SWEEP_KEYS.indexOf(String(cfg.knob_leds));
        if (idx >= 0 && idx !== settings.knobLeds) { settings.knobLeds = idx; changed = true; }
    }
    if (cfg.odd_rows !== undefined) {
        const on = cfg.odd_rows === true || cfg.odd_rows === "true" || cfg.odd_rows === 1;
        if (on !== settings.oddRows) { settings.oddRows = on; changed = true; }
    }
    return changed;
}

function readConfigRaw() {
    try {
        return std.loadFile(configPath());
    } catch (e) {
        return null;
    }
}

function loadModuleConfig() {
    const raw = readConfigRaw();
    lastConfigRaw = raw;
    if (!raw) return;
    try {
        applyConfig(std.parseExtJSON(raw));
    } catch (e) {
        console.log(`loadModuleConfig: failed to parse ${configPath()}: ${e}`);
    }
}

function writeModuleConfig() {
    let existing = {};
    const raw = readConfigRaw();
    if (raw) {
        try { existing = std.parseExtJSON(raw) || {}; } catch (e) { existing = {}; }
    }
    const merged = JSON.stringify(Object.assign({}, existing, settingsAsConfig()));
    if (merged === lastConfigRaw) return;
    const f = std.open(configPath(), "w");
    if (!f) return;
    f.puts(merged);
    f.close();
    lastConfigRaw = merged;
}

/* SONGS CAN BE EDITED FROM THE WEB PAGE TOO.
 *
 * web_ui.html rewrites songs.json whole - reordering, renaming, adding
 * and deleting songs - so the file is watched on the same beat as
 * config.json and reloaded when it changes underneath us.
 *
 * Two things are never interrupted: a screen that owns the surface (you
 * are editing on the device, and pulling the list out from under a
 * cursor would be worse than being briefly out of date), and unsaved
 * local edits, which are flushed first and therefore win. Neither can
 * strand the reload - the poll comes round again. */
function tickSongsFile() {
    if (screenOwnsSurface() || songsDirty) return;
    let raw = null;
    try { raw = std.loadFile(SONGS_PATH); } catch (e) { return; }
    if (raw === null || raw === lastSongsRaw) return;
    loadSongs();
    /* loadSongs re-reads the settings block too, so the web UI's
     * config.json has to win again afterwards. */
    loadModuleConfig();
    reconcileOddRowsView();
    updateSongStepLeds(true);
    queuePadRedraw();
    updateMoveViewPulse();
    console.log(`tickSongsFile: reloaded, ${songs.length} song(s)`);
}

/* A browser can change the file at any moment, so it is watched rather
 * than read once. Cheap: an unchanged file costs one read every couple
 * of seconds and no parse. */
function tickModuleConfig() {
    if (++configPollTicks < CONFIG_POLL_TICKS) return;
    configPollTicks = 0;
    tickSongsFile();
    const raw = readConfigRaw();
    if (raw === lastConfigRaw) return;
    lastConfigRaw = raw;
    if (!raw) return;
    let parsed = null;
    try { parsed = std.parseExtJSON(raw); } catch (e) { return; }
    if (!applyConfig(parsed)) return;
    /* Odd rows may have just been switched off under a view that only
     * exists while it is on, and the step leds follow the song list. */
    reconcileOddRowsView();
    queuePadRedraw();
    updateMoveViewPulse();
    markSongsDirty();
}

/* SONGS WRITTEN BEFORE HEX KNOBS COUNTED IN BYTES.
 *
 * A hex knob stored 0-127 and showed it doubled; it stores the byte
 * itself now. Every value, default and (there were none yet) clamp on
 * such a knob therefore doubles once, and the file is stamped so it
 * cannot happen twice. Anything else - 0-127, 0-1, -1..1, note-valued -
 * counted in CC steps before and still does. */
const SONGS_SCHEMA = 2;

function migrateKnobScale(schema) {
    if (schema >= SONGS_SCHEMA) return;
    let touched = 0;
    for (const song of songs) {
        for (const page of song.pages || []) {
            for (const knob of page.knobs || []) {
                if (!knob || !knobFineHex(knob)) continue;
                const grow = (v) => Math.max(0, Math.min(255, v * 2));
                knob.value = grow(knob.value || 0);
                if (typeof knob.default === "number") knob.default = grow(knob.default);
                if (typeof knob.min === "number") knob.min = grow(knob.min);
                if (typeof knob.max === "number") knob.max = grow(knob.max);
                touched++;
            }
        }
    }
    if (!touched) return;
    console.log(`migrateKnobScale: ${touched} hex knob(s) rescaled to bytes`);
    /* Only when something actually moved. A blanket mark here would
     * leave the module permanently dirty after every load, and
     * tickSongsFile stands off while there are unsaved local edits -
     * so an edit made in the browser would never be picked up. */
    markSongsDirty();
}

function saveSongs() {
    const f = std.open(SONGS_PATH, "w");
    if (!f) {
        console.log(`saveSongs: failed to open ${SONGS_PATH} for writing`);
        return;
    }
    const body = JSON.stringify({ schema: SONGS_SCHEMA, activeSongId, settings, songs });
    f.puts(body);
    f.close();
    /* So the watcher below can tell our own write from someone else's. */
    lastSongsRaw = body;
    /* Mirror the settings out to the web UI's file. Done here rather
     * than at each edit site so no future settings row can forget. */
    writeModuleConfig();
}

function getActiveSong() {
    return songs.find((s) => s.id === activeSongId) || songs[0];
}

function getActivePage() {
    const song = getActiveSong();
    if (!song || !song.pages.length) return null;
    if (activePageIndex >= song.pages.length) activePageIndex = 0;
    return song.pages[activePageIndex];
}

/* ============================================================================
 * Settings - Shift+Jog-click opens this, and the song list is one row of
 * it rather than the whole screen.
 *
 * Everything here is GLOBAL (see DEFAULT_SETTINGS): it describes how the
 * module talks to the M8, not what a song contains. Same row idiom as Knob
 * Settings - jog moves, click enters a value row and jog then changes it,
 * click again leaves - so there is one way to edit a value in this module
 * rather than two.
 * ============================================================================ */

/* "mainKnob" and "exit" are ACTION rows: they fire on click and never
 * enter edit mode, the same shape Knob Settings uses for Add/Remove.
 *
 * The main knob's CC, channel, send mode and display used to sit here
 * as four rows of the seven, which made a list mostly about ONE knob
 * that is not even part of a song. They are a screen of their own now,
 * behind Main Knob. */
/* No "songs" row: the song list is a screen of its own, and Shift+step 1
 * reaches it from here just as it does from anywhere else. */
const SETTINGS_ROWS = [
    "knobChannel", "mainKnob", "oddRows", "knobLeds", "exit",
];
const SETTINGS_LABELS = {
    knobChannel: "Knob Chan",
    mainKnob: "Main Knob",
    oddRows: "Odd Rows",
    knobLeds: "Knob LED",
    exit: "Exit Module",
};
const ONOFF_OPTIONS = ["Off", "On"];

let settingsOpen = false;
let settingsCursor = 0;
let settingsEntered = false;

function openSettings() {
    settingsOpen = true;
    settingsCursor = 0;
    settingsEntered = false;
}

function closeSettings() {
    settingsOpen = false;
    repaintFromMemory();
}

function settingsRowValue(row) {
    switch (row) {
        /* Channels are stored 0-15 on the wire and shown 1-16, which is
         * how M8 (and everything else) numbers them. */
        case "knobChannel": return String(settings.knobChannel + 1);
        /* The row is a door, and what is behind it is the knob's CC -
         * the one thing you would look for from out here. */
        case "mainKnob": return `CC ${settings.masterCc}`;
        case "oddRows": return ONOFF_OPTIONS[settings.oddRows ? 1 : 0];
        case "knobLeds": return KNOB_SWEEP_OPTIONS[settings.knobLeds];
        /* An action row has nothing to show in the value column. */
        case "exit": return "";
        default: return "";
    }
}

function adjustSetting(row, step) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    switch (row) {
        case "knobChannel":
            settings.knobChannel = clamp(settings.knobChannel + step, 0, 15);
            break;
        case "oddRows":
            settings.oddRows = step > 0;
            reconcileOddRowsView();
            break;
        case "knobLeds":
            settings.knobLeds = clamp(settings.knobLeds + step, 0, KNOB_SWEEP_OPTIONS.length - 1);
            updateKnobLeds(false);
            break;
        default:
            return;
    }
    markSongsDirty();
}

/* Leave the module the same way the host's own gesture does: Shift
 * with the volume knob and the jogwheel both touched. (Shift+Step 13
 * is the way INTO the Tools menu, not the way out of a module.)
 * The host runs onUnload for us on the way out, which is what persists the
 * songs, but flushing first keeps the write on this side of the door in
 * case a host build ever exits without the callback. */
function exitModule() {
    closeSettings();
    flushSongsIfDirty();
    if (typeof host_exit_module === "function") host_exit_module();
    else if (typeof host_return_to_menu === "function") host_return_to_menu();
}

/* THIS SCREEN TAKES THE JOGWHEEL AND BACK, AND NOTHING ELSE.
 *
 * A menu used to swallow the whole surface, which meant opening one
 * stopped the pads, the transport and the mode buttons dead - you could
 * not glance at a setting without the M8 going deaf. Everything except
 * the wheel and Back now falls through to its ordinary handling and
 * reaches the M8 as usual.
 *
 * Shift falls through too, deliberately. The main dispatch is what
 * tracks it and forwards it to the Launchpad, and this screen's own
 * Shift gestures read the same flag a moment later - so letting it past
 * costs nothing and keeps the M8's idea of Shift honest.
 *
 * Returns true when it consumed the message. */
function handleSettingsInput(data) {
    if (data[0] !== 0xb0) return false;

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    if (moveControlNumber !== moveJogTurn
        && moveControlNumber !== moveWHEEL
        && moveControlNumber !== moveBACK) return false;
    notePressConsumed(moveControlNumber, pressed);

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return true;
        if (settingsEntered) {
            adjustSetting(SETTINGS_ROWS[settingsCursor], Math.sign(delta));
        } else {
            settingsCursor = Math.max(0, Math.min(SETTINGS_ROWS.length - 1,
                                                  settingsCursor + Math.sign(delta)));
        }
        return true;
    }

    if (!pressed) return true;          /* the release of one we took */

    if (moveControlNumber === moveBACK) {
        if (settingsEntered) { settingsEntered = false; return true; }
        closeSettings();
        return true;
    }

    const row = SETTINGS_ROWS[settingsCursor];
    if (row === "mainKnob") {
        settingsOpen = false;
        openMainKnob();
        return true;
    }
    if (row === "exit") {
        exitModule();
        return true;
    }
    settingsEntered = !settingsEntered;
    return true;
}

/* ============================================================================
 * Main Knob - Settings > Main Knob, Back returns there.
 *
 * Knob 9 is a pass-through that belongs to no song: its own CC, its own
 * channel, its own send mode and now its own display. Four rows about
 * one knob, off the main list rather than in it.
 * ============================================================================ */

const MAIN_KNOB_FIELDS = ["cc", "chan", "mode", "display"];
const MAIN_KNOB_LABELS = { cc: "CC", chan: "Chan", mode: "Mode", display: "Display" };

let mainKnobOpen = false;
let mainKnobCursor = 0;
let mainKnobEntered = false;

function openMainKnob() {
    mainKnobOpen = true;
    mainKnobCursor = 0;
    mainKnobEntered = false;
}

function closeMainKnob() {
    mainKnobOpen = false;
    /* Back up to where it was opened from, the same as the song list. */
    settingsOpen = true;
}

function mainKnobRowValue(field) {
    switch (field) {
        case "cc": return String(settings.masterCc);
        case "chan": return String(settings.masterChannel + 1);
        case "mode": return KNOB_MODE_OPTIONS[settings.masterMode];
        case "display": return KNOB_DISPLAY_OPTIONS[settings.masterDisplay];
        default: return "";
    }
}

function adjustMainKnob(field, step) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    switch (field) {
        case "cc":
            settings.masterCc = clamp(settings.masterCc + step, 0, 127);
            break;
        case "chan":
            settings.masterChannel = clamp(settings.masterChannel + step, 0, 15);
            break;
        case "mode":
            settings.masterMode = clamp(settings.masterMode + step, 0, KNOB_MODE_OPTIONS.length - 1);
            break;
        case "display":
            /* MASTER_DISPLAY_KEYS, not KNOB_DISPLAY_OPTIONS: the main
             * knob is offered the original four only. */
            settings.masterDisplay = clamp(settings.masterDisplay + step,
                                           0, MASTER_DISPLAY_KEYS.length - 1);
            break;
        default:
            return;
    }
    markSongsDirty();
}

function handleMainKnobInput(data) {
    if (data[0] !== 0xb0) return;

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    if (moveControlNumber === moveSHIFT) {
        setShiftHeld(pressed);
        return;
    }

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return;
        if (mainKnobEntered) {
            adjustMainKnob(MAIN_KNOB_FIELDS[mainKnobCursor], Math.sign(delta));
        } else {
            mainKnobCursor = Math.max(0, Math.min(MAIN_KNOB_FIELDS.length - 1,
                                                  mainKnobCursor + Math.sign(delta)));
        }
        return;
    }

    if (!pressed) return;

    if (moveControlNumber === moveBACK) {
        if (mainKnobEntered) { mainKnobEntered = false; return; }
        closeMainKnob();
        return;
    }

    if (moveControlNumber !== moveWHEEL) return;
    mainKnobEntered = !mainKnobEntered;
}

function drawMainKnob() {
    clear_screen();
    drawMenuHeader("Main Knob");
    drawMenuList({
        items: MAIN_KNOB_FIELDS,
        selectedIndex: mainKnobCursor,
        editMode: mainKnobEntered,
        getLabel: (field) => MAIN_KNOB_LABELS[field],
        getValue: (field) => mainKnobRowValue(field),
    });
    drawMenuFooter(["Jog: Move", "Clk: Edit", "Bck: Settings"]);
}

function drawSettings() {
    clear_screen();
    drawMenuHeader("Settings");
    drawMenuList({
        items: SETTINGS_ROWS,
        selectedIndex: settingsCursor,
        editMode: settingsEntered,
        getLabel: (row) => SETTINGS_LABELS[row],
        getValue: (row) => settingsRowValue(row),
    });
    drawMenuFooter(["Jog: Move", "Clk: Edit", "Bck: Close"]);
}

/* ============================================================================
 * Song Management screen - Shift+Jog-click to open, Back to close.
 *
 * Owns the whole screen and every control while open: LPP pad/button
 * forwarding is suspended (handleSongMgmtInput is dispatched to BEFORE any of
 * the normal onMidiMessageInternal logic runs, and onMidiMessageExternal's
 * LED relay is gated off - see the two call sites). Pads get reused by
 * text_entry.mjs for typing during rename/create, which is the reason
 * forwarding has to stop rather than just being ignored: M8's own LED
 * updates would otherwise paint over the text-entry keyboard.
 * ============================================================================ */

let songMgmtOpen = false;
let songMgmtCursor = 0;

/* A synthetic first row, not a song - selecting it calls createSong() (same
 * as the Capture-button shortcut below). Every other cursor position is
 * songs[cursor - 1]. */
const ADD_SONG_ITEM = { id: "__add_song__", name: "+ Add Song" };

function songMgmtItems() {
    return [ADD_SONG_ITEM].concat(songs);
}

/* The cursor walks rows and row 0 is not a song. Returns -1 there, which
 * is what stops Copy, Delete and rename acting on a song that is not
 * under the cursor. */
function songMgmtSongIndex() {
    const i = songMgmtCursor - 1;
    return i >= 0 && i < songs.length ? i : -1;
}
function songMgmtLastRow() {
    return songs.length;
}

function openSongManagement() {
    songMgmtOpen = true;
    /* A question never survives the screen it was asked on. */
    closeDeleteConfirm();
    const activeIndex = songs.findIndex((s) => s.id === activeSongId);
    songMgmtCursor = activeIndex >= 0 ? activeIndex + 1 : 0;
}

function closeSongManagement() {
    songMgmtOpen = false;
    closeDeleteConfirm();
    /* OUT, not up. Songs is its own screen now - reached with Shift+step
     * 1 rather than from inside Settings - so there is no "up" for Back
     * to go to. It used to land in Settings because that is where the
     * list lived. */
    settingsOpen = false;
    /* M8's LED updates kept updating lppNoteValueMap while this screen owned
     * the pads (see onMidiMessageExternal), just without painting them - so
     * the cache may now be ahead of what the pads are actually showing.
     * Reuse the same resync path the view-toggle uses to catch it up. */
    repaintFromMemory();
}

/* Picking a song is "go and play this", so it leaves the menus entirely
 * rather than stepping back up to Settings. */
function closeSongManagementToPerform() {
    closeSongManagement();
}

function renameSong(song) {
    openKeyboard({
        title: "Song Name",
        initialText: song.name,
        onConfirm: (text) => {
            const trimmed = (text || "").trim();
            if (trimmed) song.name = trimmed;
            markSongsDirty();
        },
    });
}

function createSong() {
    const song = makeSong("New Song");
    songs.push(song);
    songMgmtCursor = songs.length; /* row 0 is Add Song, so song i sits at i + 1 */
    markSongsDirty();
    updateSongStepLeds();
    renameSong(song);
}

/* Shift+jog moves the highlighted song through the list - which is also
 * how it is moved onto a different preset step button, since the first
 * eight songs ARE the eight buttons in list order. The cursor travels
 * with the song, so holding Shift and spinning keeps moving the same one
 * instead of walking off it after the first step. */
function moveSong(step) {
    const from = songMgmtSongIndex();
    if (from < 0) return;              /* on Add Song or Settings */
    const to = from + step;
    if (to < 0 || to >= songs.length) return;
    const [song] = songs.splice(from, 1);
    songs.splice(to, 0, song);
    songMgmtCursor = to + 1;
    markSongsDirty();
    updateSongStepLeds();
}

function deleteSong(index) {
    if (songs.length <= 1) return; /* always at least one song */
    const wasActive = songs[index].id === activeSongId;
    songs.splice(index, 1);
    if (songMgmtCursor > songMgmtLastRow()) songMgmtCursor = songMgmtLastRow();
    if (wasActive) {
        activeSongId = songs[0].id;
        activePageIndex = 0;
    }
    markSongsDirty();
    updateSongStepLeds();
}

/* "Song", "Song 2", "Song 3" - a number is appended only when the plain
 * name is taken, and it counts up until it finds a gap. Nicer than
 * "Song copy copy", which is what duplicating a duplicate would give. */
function uniqueSongName(base) {
    const taken = new Set(songs.map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
        const candidate = `${base} ${n}`;
        if (!taken.has(candidate)) return candidate;
    }
    return base;
}

/* A song, copied whole - every page, every knob, every setting on every
 * knob. The copy lands directly BELOW the original rather than at the
 * end, because the list order is also the preset-button order and a
 * duplicate is nearly always wanted next to the thing it came from.
 *
 * The graphic group ids are regenerated rather than copied. They are
 * only ever matched within one page, so sharing them across two songs
 * would probably be harmless - but "probably harmless" is not worth
 * carrying when a fresh id costs nothing. */
function duplicateSong(index) {
    const source = songs[index];
    if (!source) return;

    const groupIds = new Map();
    const copy = {
        id: makeSongId(),
        name: uniqueSongName(source.name),
        pages: (source.pages || []).map((page) => ({
            name: page.name || "",
            knobs: (page.knobs || []).map((knob) => {
                if (!knob) return null;
                const clone = Object.assign({}, knob);
                if (knob.viz) {
                    const old = knob.viz.group;
                    if (old && !groupIds.has(old)) groupIds.set(old, `g${makeSongId()}`);
                    clone.viz = Object.assign({}, knob.viz, { group: groupIds.get(old) || old });
                }
                return clone;
            }),
        })),
    };

    songs.splice(index + 1, 0, copy);
    songMgmtCursor = index + 2;      /* row 0 is "+ Add Song" */
    markSongsDirty();
    updateSongStepLeds();
}

/* DELETING ASKS FIRST.
 *
 * Deleting a song throws away every page of knobs on it, and the button
 * is one press with nothing held - so it opens a two-row list instead of
 * acting, with the cursor parked on Cancel. Anything that is not a
 * deliberate move onto "Delete" and a click leaves the song alone.
 *
 * `blocked` is the other half of the same screen: the last song cannot
 * go, and saying so is better than a button that quietly does nothing. */
let songMgmtConfirm = null;

function openDeleteConfirm(index) {
    const song = songs[index];
    if (!song) return;
    songMgmtConfirm = {
        index,
        name: song.name,
        blocked: songs.length <= 1,
        cursor: 0,                   /* Cancel - never start on the door out */
    };
}

function closeDeleteConfirm() {
    songMgmtConfirm = null;
}

/* Returns true when it consumed the message, so the list below does not
 * also act on it. */
function handleDeleteConfirmInput(moveControlNumber, pressed, data) {
    if (!songMgmtConfirm) return false;

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta !== 0 && !songMgmtConfirm.blocked) {
            songMgmtConfirm.cursor = Math.max(0, Math.min(1, songMgmtConfirm.cursor + Math.sign(delta)));
        }
        return true;
    }
    if (!pressed) return true;

    if (moveControlNumber === moveBACK
        || (moveControlNumber === MoveDelete && shiftHeld)) {
        closeDeleteConfirm();
        return true;
    }
    if (moveControlNumber === moveWHEEL) {
        const confirmed = !songMgmtConfirm.blocked && songMgmtConfirm.cursor === 1;
        const index = songMgmtConfirm.index;
        closeDeleteConfirm();
        if (confirmed) deleteSong(index);
        return true;
    }
    /* Not swallowed any more: a question owns the wheel and the two
     * buttons that answer it, and everything else carries on reaching
     * the M8 the way it does behind every other screen. */
    return false;
}

/* Takes the jogwheel, Back, and the two buttons its Shift gestures use -
 * and nothing else. See handleSettingsInput for why the rest falls
 * through. Returns true when it consumed the message. */
function handleSongMgmtInput(data) {
    /* The name keyboard is the exception: while it is up the PADS are
     * letters, so it really does own the surface. */
    if (isTextEntryActive()) { routeTextEntryInput(data); return true; }

    if (data[0] !== 0xb0) return false;  /* pads, steps, knob touches: not ours */

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    const isOurs = moveControlNumber === moveJogTurn
        || moveControlNumber === moveWHEEL
        || moveControlNumber === moveBACK
        /* Copy and Delete only when shifted - unshifted they are the
         * Launchpad's Duplicate and Clear and belong to the M8. */
        || ((moveControlNumber === MoveCopy || moveControlNumber === MoveDelete) && shiftHeld);
    if (!isOurs) return false;
    notePressConsumed(moveControlNumber, pressed);

    if (handleDeleteConfirmInput(moveControlNumber, pressed, data)) return true;

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return true;
        if (shiftHeld) {
            moveSong(Math.sign(delta));
            return true;
        }
        songMgmtCursor = Math.max(0, Math.min(songMgmtLastRow(), songMgmtCursor + Math.sign(delta)));
        return true;
    }

    if (!pressed) return true;          /* the release of one we took */

    if (moveControlNumber === moveBACK) {
        closeSongManagement();
    } else if (moveControlNumber === moveWHEEL) {
        /* Shift+click renames the song under the cursor. It used to be
         * Menu, which is the Launchpad's Note button and so belongs to
         * the M8 - the same reason Capture no longer makes a song. The
         * screen's own gestures all live on Shift now. */
        if (shiftHeld) {
            if (songMgmtSongIndex() >= 0) renameSong(songs[songMgmtSongIndex()]);
            return true;
        }
        if (songMgmtCursor === 0) {
            createSong();
            return true;
        }
        activeSongId = songs[songMgmtSongIndex()].id;
        activePageIndex = 0;
        cachedSongId = null;     /* different song, different page shape */
        markSongsDirty();
        closeSongManagementToPerform();   /* relights the preset LEDs on the way out */
    } else if (moveControlNumber === MoveCopy) {
        if (shiftHeld && songMgmtSongIndex() >= 0) duplicateSong(songMgmtSongIndex());
    } else if (moveControlNumber === MoveDelete) {
        /* Shift on both, to match the knob cursor: the same two buttons
         * do the same two jobs to whatever the cursor is on, and a
         * gesture that means "duplicate this" on one screen should not
         * mean it with a different grip on the other. The confirmation
         * below is still the real safety for Delete. */
        if (shiftHeld && songMgmtSongIndex() >= 0) openDeleteConfirm(songMgmtSongIndex());
    }
    return true;
}

/* The song name is the whole point of the question, so it gets the
 * header; the rows are the two answers. A blocked delete has one row and
 * no choice to make - the header says why, and the row is the way out. */
function drawDeleteConfirm() {
    clear_screen();
    if (songMgmtConfirm.blocked) {
        drawMenuHeader("Only song");
        drawMenuList({
            items: ["OK"],
            selectedIndex: 0,
            getLabel: (item) => item,
            getValue: () => "",
        });
        drawMenuFooter(["The last song cannot be deleted"]);
        return;
    }
    drawMenuHeader(`Delete ${songMgmtConfirm.name}?`);
    drawMenuList({
        items: ["Cancel", "Delete"],
        selectedIndex: songMgmtConfirm.cursor,
        getLabel: (item) => item,
        getValue: () => "",
    });
    drawMenuFooter(["Jog: Move", "Clk: Pick", "Bck: Cancel"]);
}

function drawSongMgmt() {
    if (isTextEntryActive()) {
        tickTextEntry();
        drawTextEntry();
        return;
    }
    if (songMgmtConfirm) {
        drawDeleteConfirm();
        return;
    }
    clear_screen();
    drawMenuHeader("Songs");
    drawMenuList({
        items: songMgmtItems(),
        selectedIndex: songMgmtCursor,
        getLabel: (item) => item.name,
        getValue: (item) => (item === ADD_SONG_ITEM ? "" : (item.id === activeSongId ? "*" : "")),
    });
    drawMenuFooter(songMgmtHints());
}

/* ============================================================================
 * Knob Select - a cursor over the eight slots of the current page.
 *
 * Reached with a plain jogwheel click, which had nothing to do once
 * switching grid halves moved to the mode buttons. The wheel walks the
 * cursor, a second click opens whatever the slot holds, and Back
 * leaves. It replaces Shift+touch as the way into Knob Settings, which
 * is what freed Shift to be the audition.
 *
 * An EMPTY slot is a valid stop rather than something to skip: clicking
 * one opens the Add Knob wizard, exactly as Shift+touch on an empty
 * slot used to. Skipping them would make an empty page unreachable.
 * ============================================================================ */

let knobSelectOpen = false;
let knobSelectIndex = 0;

/* WHERE THE CURSOR WAS WHEN IT LAST WENT AWAY, PER PAGE.
 *
 * Editing a knob is rarely one visit: you set the CC, look at the page,
 * come back for the display, come back again for the clamp. Starting at
 * the first filled slot every time meant walking back along the row on
 * each return.
 *
 * Kept per page of per song, so wandering off to another page and back
 * does not cost the position on either - one remembered slot would have
 * been spent by the visit. Keyed by song id so the same page number in
 * a different song is a different question; forgotten when the module
 * unloads, which is the right lifetime for a cursor. */
const knobSelectLast = new Map();   /* `${songId}:${page}` -> slot */

function knobSelectKey() {
    const song = getActiveSong();
    return `${song ? song.id : "-"}:${activePageIndex}`;
}

function rememberKnobSelect() {
    knobSelectLast.set(knobSelectKey(), knobSelectIndex);
}

function openKnobSelect() {
    knobSelectOpen = true;
    const page = getActivePage();
    const seen = knobSelectLast.get(knobSelectKey());
    if (seen !== undefined) {
        knobSelectIndex = Math.max(0, Math.min(KNOBS_PER_PAGE - 1, seen));
        return;
    }
    /* Start on the first slot that HAS something, so the common case -
     * one knob on the page - needs no scrolling at all. Falls back to
     * slot 0 on an empty page, which is then the Add Knob door. */
    const first = page ? page.knobs.findIndex((k) => k) : -1;
    knobSelectIndex = first >= 0 ? first : 0;
}

function closeKnobSelect() {
    rememberKnobSelect();
    knobSelectOpen = false;
}

/* Returns true when the cursor has taken the message. Unlike the menu
 * screens this is only an OVERLAY on the song page - the pads, the mode
 * buttons and the knobs all still mean what they usually do - so it
 * claims just the three controls it drives (wheel turn, wheel click,
 * Back) and lets everything else through to the normal handler. */
function handleKnobSelectInput(data) {
    if (data[0] !== 0xb0) return false;
    const control = data[1];
    const pressed = data[2] === 127;

    if (control === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return true;
        /* SHIFT CARRIES THE KNOB WITH THE CURSOR.
         *
         * The same gesture the song list uses to reorder songs, for the
         * same reason: the thing under the cursor is what you want to
         * move, and the wheel is already in your hand. A knob that is
         * part of a graphic takes the whole picture with it, and the
         * step is "next valid position" rather than "one slot" - which
         * is what lets a four-knob envelope move between rows at all,
         * since it cannot slide within one.
         *
         * Page to page is deliberately not offered: a slot IS a
         * physical encoder, so a knob on a page you are not looking at
         * would sit under no encoder. */
        if (shiftHeld) {
            const moved = moveKnobBlock(knobSelectIndex, Math.sign(delta));
            if (moved !== knobSelectIndex) {
                knobSelectIndex = moved;
                markSongsDirty();
            }
            return true;
        }
        /* PAST THE END IS THE NEXT PAGE, not a wall. The cursor is how
         * every knob is reached, and stopping at slot 8 made the pages
         * past this one unreachable without first putting the cursor
         * away, turning the wheel, and raising it again. Walking off
         * one end arrives at the other end of the neighbouring page,
         * which is where you were going. */
        const dir = Math.sign(delta);
        const song = getActiveSong();
        const pages = song ? song.pages.length : 1;
        let next = knobSelectIndex + dir;
        if (next < 0) {
            if (activePageIndex <= 0) return true;      /* first slot of the first page */
            activePageIndex--;
            next = KNOBS_PER_PAGE - 1;
        } else if (next >= KNOBS_PER_PAGE) {
            if (activePageIndex >= pages - 1) return true;
            activePageIndex++;
            next = 0;
        }
        knobSelectIndex = next;
        return true;
    }

    /* Shift+Copy duplicates what the cursor is on, Shift+Delete removes
     * it. Shift rather than a bare press because both are one keystroke
     * away from losing work, and because an unshifted Copy or Delete
     * still belongs to the M8. */
    if (control === MoveCopy || control === MoveDelete) {
        if (!pressed || !shiftHeld) return true;
        const song = getActiveSong();
        const page = getActivePage();
        if (!song || !page || !page.knobs[knobSelectIndex]) return true;
        if (control === MoveCopy) {
            knobSelectIndex = copyKnobBlock(knobSelectIndex);
        } else {
            removeKnobAt(song, activePageIndex, knobSelectIndex);
            cachedSongId = null;
        }
        return true;
    }

    if (control !== moveBACK && control !== moveWHEEL) return false;
    if (!pressed) return true;          /* the release of one we took */

    if (control === moveBACK) {
        closeKnobSelect();
        return true;
    }

    const page = getActivePage();
    const slot = knobSelectIndex;
    closeKnobSelect();
    if (page) {
        if (page.knobs[slot]) openKnobEdit(slot);
        else openKnobWizard({ pageIndex: activePageIndex, slot });
    }
    return true;
}

/* ============================================================================
 * Knob Settings screen - Shift+touch a knob (notes 0-7) to open it, Back to
 * close. Drawn with the same drawMenuHeader/drawMenuList/drawMenuFooter chrome
 * as Song Management below, rather than the param-page dial/bar widgets, so
 * every settings-style screen in this module looks and drives the same way.
 *
 * Jog wheel moves the row cursor across the four fields (Name/CC/Mode/
 * Display); jog click on Name dives straight into text_entry.mjs (an opaque
 * field has no turn behaviour, matching "a knob that cannot turn opens on
 * touch" elsewhere in Schwung); jog click on any other row toggles it
 * "entered" - drawMenuList's own `editMode` affordance, which brackets the
 * selected row's value - and while entered, jog turn steps that field's value
 * instead of moving the cursor (an enum is just an int clamped to
 * [0, options.length-1], so the same clamp logic drives Mode and Display).
 * Touching a DIFFERENT knob (notes 0-7) while this screen is already open
 * switches straight to editing that one, without Back+Shift+touch again - the
 * plain (un-shifted) touch is unambiguous here since the screen already owns
 * every knob touch and there's nothing else it could mean.
 * Same screen-ownership shape as Song Management otherwise - suspends LPP
 * forwarding, resyncs the pads on close.
 * ============================================================================ */

/* "remove" is an ACTION row, not a value: it never enters edit mode, it
 * fires on click. Kept in the same list so the jog walks it like any
 * other row rather than needing a second gesture to reach.
 *
 * No Add Knob row: adding is the jogwheel cursor's job, on an empty
 * slot, and a song always carries a spare page - so there is somewhere
 * to click even when this page is full. A second door to the wizard
 * from inside a screen about ONE knob only invited the question of
 * which knob it would land next to. */
const KNOB_SETTINGS_FIELDS = ["name", "connect", "cc", "chan", "mode", "display", "led",
                              "mult", "min", "max", "move", "remove"];
const KNOB_SETTINGS_LABELS = {
    name: "Name", connect: "Connect", cc: "CC", chan: "Chan", mode: "Mode",
    display: "Display", led: "LED", mult: "Speed", min: "Min", max: "Max",
    move: "Slot", remove: "Remove Knob",
};

/* The channel row runs one below 1, and that stop is "follow the
 * song's channel" rather than a channel of its own. */
const KNOB_CHAN_FOLLOW = -1;

/* Min and Max are ends of the travel, so they read in the knob's own
 * display - a hex knob's clamp is 30 to 4F, not 48 to 79. A shifted
 * turn steps by eight, because walking 256 bytes one detent at a time
 * is not a thing anyone should be asked to do. */
const KNOB_LIMIT_COARSE = 8;

let knobEditOpen = false;
let knobEditIndex = -1;
let knobEditCursor = 0;
let knobEditEntered = false;

function openKnobEdit(index) {
    const page = getActivePage();
    if (!page || !page.knobs[index]) return; /* nothing there to edit */
    knobEditOpen = true;
    knobEditIndex = index;
    knobEditCursor = 0;
    knobEditEntered = false;
}

function closeKnobEdit() {
    knobEditOpen = false;
    knobEditIndex = -1;
    /* A knob's display mode may have just changed, which changes the SHAPE
     * of the main page's synthetic chain_params (plain int vs the hex-enum
     * trick) - force ensureSongPageMeta to rebuild instead of serving the
     * pre-edit cache. */
    cachedSongId = null;
    repaintFromMemory();
}

/* The slots a move operates on: the whole viz group if this knob is in
 * one, otherwise just this knob.
 *
 * A graphic's members have to stay contiguous AND inside one row or
 * viz.mjs stops forming the group and the picture disappears, so moving a
 * single member out from under its own graphic is never what was wanted.
 * The group travels as a block instead. */
function knobMoveBlock(page, index) {
    const knob = page.knobs[index];
    const group = knob && knob.viz ? knob.viz.group : null;
    if (!group) return { start: index, size: 1 };
    const slots = [];
    page.knobs.forEach((k, i) => {
        if (k && k.viz && k.viz.group === group) slots.push(i);
    });
    const start = Math.min(...slots);
    return { start, size: Math.max(...slots) - start + 1 };
}

/* Where a block of this size may begin: anywhere it fits within a SINGLE
 * row. That is viz.mjs's constraint, and it is what makes a four-knob
 * envelope have exactly two possible homes (the two rows) while a lone
 * knob can sit anywhere. */
function validBlockStarts(size) {
    const out = [];
    for (let base = 0; base < KNOBS_PER_PAGE; base += KNOBS_PER_ROW) {
        for (let start = base; start + size <= base + KNOBS_PER_ROW; start++) out.push(start);
    }
    return out;
}

/* Move the edited knob - or its whole graphic - to the next valid
 * position, swapping with whatever is in the way so nothing is displaced
 * off the page. Within the current page only: a slot IS a physical
 * encoder, and moving a knob to a page you are not looking at would put
 * it under no encoder at all. Knobs keep their names, CCs and values;
 * only their positions change.
 *
 * Because the step is "next VALID start" rather than "one slot", a block
 * that cannot slide within its row jumps to the other row instead - which
 * is the only way a four-knob envelope can be moved at all. */
/* Returns where the moved knob ended up, or the index it was given when
 * nothing moved - so a caller can follow its own cursor along without
 * knowing how far the block travelled. */
function moveKnobBlock(index, step) {
    const page = getActivePage();
    if (!page) return index;
    const knobs = page.knobs;
    if (!knobs[index]) return index;        /* an empty slot has nothing to move */
    const { start, size } = knobMoveBlock(page, index);

    const starts = validBlockStarts(size);
    const target = starts[starts.indexOf(start) + step];
    if (target === undefined) return index;

    const moving = knobs.slice(start, start + size);
    /* Whatever occupies the destination and is not part of the block
     * itself comes back to fill the slots the block vacates. The two
     * counts always match, so no knob is created or lost: a step within a
     * row rotates its neighbour around, and a jump to the other row swaps
     * the two blocks whole. */
    const displaced = [];
    for (let i = target; i < target + size; i++) {
        if (i >= start && i < start + size) continue;
        if (knobs[i]) displaced.push(knobs[i]);
    }
    const freed = [];
    for (let i = start; i < start + size; i++) {
        if (i < target || i >= target + size) freed.push(i);
    }

    for (let i = start; i < start + size; i++) knobs[i] = null;
    for (let i = target; i < target + size; i++) knobs[i] = null;
    moving.forEach((k, i) => { knobs[target + i] = k; });
    displaced.forEach((k, i) => { if (freed[i] !== undefined) knobs[freed[i]] = k; });

    cachedSongId = null;               /* slot -> key mapping changed */
    return index + (target - start);   /* follow the knob, not the slot */
}

/* Knob Settings still calls it by its old name and on its own cursor. */
function moveKnobSlot(step) {
    knobEditIndex = moveKnobBlock(knobEditIndex, step);
}

/* Copy the knob under the cursor - or its whole graphic - into the next
 * run of free slots.
 *
 * A graphic travels whole for the same reason it moves whole: its knobs
 * have to sit adjacent on one row or viz.mjs will not draw it, so
 * copying one member alone would produce a knob with a role in a picture
 * that is not there. The copy gets a NEW group id and fresh CCs - two
 * knobs learned to the same CC would move together on the M8, which is
 * the opposite of what a copy is for.
 *
 * Returns where the copy landed, so the cursor can follow it. */
function copyKnobBlock(index) {
    const song = getActiveSong();
    const page = getActivePage();
    if (!song || !page || !page.knobs[index]) return index;

    const { start, size } = knobMoveBlock(page, index);
    const block = page.knobs.slice(start, start + size);
    const place = nextFreeKnobRun(song, size);
    const target = song.pages[place.pageIndex];
    if (!target) return index;

    const groupId = block.some((k) => k && k.viz) ? `g${makeSongId()}` : null;
    block.forEach((knob, i) => {
        if (!knob) return;
        const clone = Object.assign({}, knob, { cc: nextFreeCc(song) });
        if (knob.viz) clone.viz = Object.assign({}, knob.viz, { group: groupId });
        target.knobs[place.slot + i] = clone;
    });

    activePageIndex = place.pageIndex;
    ensureSparePage(song);
    cachedSongId = null;
    markSongsDirty();
    return place.slot + (index - start);
}

function renameKnob(knob) {
    openKeyboard({
        title: "Rename Knob",
        initialText: knob.name,
        onConfirm: (text) => {
            const trimmed = (text || "").trim();
            if (trimmed) knob.name = trimmed;
            markSongsDirty();
        },
    });
}

function handleKnobEditInput(data) {
    if (routeTextEntryInput(data)) return;

    const page = getActivePage();
    const knob = page ? page.knobs[knobEditIndex] : null;
    if (!knob) {
        closeKnobEdit();
        return;
    }

    /* Touching a different knob (notes 0-7) while this screen is open jumps
     * straight to editing that one instead - no need to Back out and
     * Shift+touch again. Resets the row cursor and drops out of "entered" so
     * the new knob always opens on Name, matching a fresh Shift+touch open. */
    if (data[0] === 0x90 && data[2] === 127 && data[1] >= 0 && data[1] <= 7) {
        /* Only onto a slot that HAS a knob - an empty one has no settings
         * to show, and silently doing nothing is better than opening a
         * blank screen the Back key then has to be used to escape. */
        if (data[1] !== knobEditIndex && page.knobs[data[1]]) {
            knobEditIndex = data[1];
            knobEditCursor = 0;
            knobEditEntered = false;
        }
        return;
    }

    if (data[0] !== 0xb0) return;

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    if (moveControlNumber === moveSHIFT) {
        setShiftHeld(pressed);
        return;
    }

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return;
        if (!knobEditEntered) {
            knobEditCursor = Math.max(0, Math.min(KNOB_SETTINGS_FIELDS.length - 1, knobEditCursor + Math.sign(delta)));
            return;
        }
        const field = KNOB_SETTINGS_FIELDS[knobEditCursor];
        if (field === "cc") {
            knob.cc = Math.max(1, Math.min(127, knob.cc + Math.sign(delta)));
        } else if (field === "chan") {
            const now = typeof knob.chan === "number" ? knob.chan : KNOB_CHAN_FOLLOW;
            const next = Math.max(KNOB_CHAN_FOLLOW, Math.min(15, now + Math.sign(delta)));
            if (next === KNOB_CHAN_FOLLOW) delete knob.chan;
            else knob.chan = next;
        } else if (field === "mode") {
            knob.mode = Math.max(0, Math.min(KNOB_MODE_OPTIONS.length - 1, knob.mode + Math.sign(delta)));
        } else if (field === "display") {
            const wasFine = knobFineHex(knob);
            knob.display = Math.max(0, Math.min(KNOB_DISPLAY_OPTIONS.length - 1, knob.display + Math.sign(delta)));
            rescaleKnobForDisplay(knob, wasFine);
        } else if (field === "led") {
            const now = typeof knob.led === "number" ? knob.led : KNOB_SWEEP_FOLLOW;
            const next = Math.max(KNOB_SWEEP_FOLLOW,
                                  Math.min(KNOB_SWEEPS.length - 1, now + Math.sign(delta)));
            if (next === KNOB_SWEEP_FOLLOW) delete knob.led;
            else knob.led = next;
            /* Not forced: the cache repaints exactly the ring whose
             * colour this actually changed, which is usually one. */
            updateKnobLeds(false);
        } else if (field === "mult") {
            knob.mult = Math.max(0, Math.min(KNOB_MULT_OPTIONS.length - 1,
                                             knobMultIndex(knob) + Math.sign(delta)));
            knobAccum.delete(knob);
        } else if (field === "min" || field === "max") {
            const step = Math.sign(delta) * (shiftHeld ? KNOB_LIMIT_COARSE : 1);
            const top = knobMaxStep(knob);
            const now = field === "min" ? knobLow(knob) : knobHigh(knob);
            const next = Math.max(0, Math.min(top, now + step));
            if (field === "min") knob.min = Math.min(next, knobHigh(knob));
            else knob.max = Math.max(next, knobLow(knob));
            clampKnobValue(knob);
        } else if (field === "move") {
            moveKnobSlot(Math.sign(delta));
        }
        markSongsDirty();
        return;
    }

    if (!pressed) return;

    if (moveControlNumber === moveBACK) {
        closeKnobEdit();
    } else if (moveControlNumber === moveWHEEL) {
        const field = KNOB_SETTINGS_FIELDS[knobEditCursor];
        if (field === "name") {
            renameKnob(knob);
            return;
        }
        if (field === "connect") {
            const index = knobEditIndex;
            closeKnobEdit();
            /* Same wizard, same catalogue - it re-points this knob at the
             * leaf instead of making a new one, and comes back here. */
            openKnobWizard(null, index);
            return;
        }
        if (field === "remove") {
            const song = getActiveSong();
            if (song) removeKnobAt(song, activePageIndex, knobEditIndex);
            closeKnobEdit();
            return;
        }
        knobEditEntered = !knobEditEntered;
    }
}

function drawKnobEdit() {
    if (isTextEntryActive()) {
        tickTextEntry();
        drawTextEntry();
        return;
    }

    const page = getActivePage();
    const knob = page ? page.knobs[knobEditIndex] : null;
    if (!knob) {
        closeKnobEdit();
        return;
    }

    clear_screen();
    drawMenuHeader(`Knob ${knobEditIndex + 1}`);
    drawMenuList({
        items: KNOB_SETTINGS_FIELDS,
        selectedIndex: knobEditCursor,
        editMode: knobEditEntered,
        getLabel: (field) => KNOB_SETTINGS_LABELS[field],
        getValue: (field) => {
            if (field === "name") return knob.name;
            /* The RECORDED connection, never the one derived from the
             * name. A dash means the header cannot say which instrument
             * this knob belongs to, which is the whole reason to come
             * here - so a guess in this column would hide the knobs that
             * need the row. */
            if (field === "connect") return knob.detail ? shortLabel(knob.detail) : "-";
            if (field === "cc") return String(knob.cc);
            /* "Song" is the usual answer: the channel from Settings,
             * whatever that is now, rather than a copy of it taken when
             * the knob was made. */
            if (field === "chan") {
                return typeof knob.chan === "number"
                    ? String(knob.chan + 1) : "Song";
            }
            if (field === "mode") return KNOB_MODE_OPTIONS[knob.mode];
            if (field === "display") return KNOB_DISPLAY_OPTIONS[knob.display];
            /* "Song" is the usual answer, and it follows Settings as
             * it stands rather than a copy taken here. */
            if (field === "led") {
                return typeof knob.led === "number"
                    ? KNOB_SWEEP_OPTIONS[knob.led] : "Song";
            }
            if (field === "mult") return KNOB_MULT_OPTIONS[knobMultIndex(knob)];
            if (field === "min") return formatKnobLimit(knob, knobLow(knob));
            if (field === "max") return formatKnobLimit(knob, knobHigh(knob));
            if (field === "move") {
                /* A range when a graphic moves as one, so the row says
                 * that the whole picture travels rather than this knob. */
                const block = knobMoveBlock(page, knobEditIndex);
                return block.size > 1
                    ? `${block.start + 1}-${block.start + block.size}`
                    : String(knobEditIndex + 1);
            }
            return "";
        },
    });
    drawMenuFooter(["Jog: Move", "Clk: Edit", "Bck: Close"]);
}

/* ============================================================================
 * Add Knob wizard - Shift+touch an EMPTY knob slot, or the Add Knob row in
 * Knob Settings.
 *
 * A STACK of screens rather than numbered steps. The paths are different
 * lengths - Mixer is two screens, an instrument mod is five - and a stack
 * makes Back mean one thing everywhere (pop; close when empty) instead of
 * each screen having to know its own depth.
 *
 * A frame is either a LIST (drawMenuList, same chrome as every other menu
 * here) or the two-digit HEX editor used for the instrument number, which
 * is a list of its own in the Knob Settings idiom: jog moves between the
 * digits, click enters and leaves a digit, and an Add/Next row commits.
 * 128 instruments as a flat list would be a long scroll to reach 7F.
 * ============================================================================ */

const WIZ_LIST = "list";
const WIZ_HEX = "hex";

let knobWizardOpen = false;
/* Frames: { kind, title, items, getLabel, getValue, onPick } for a list, or
 * { kind: WIZ_HEX, title, value, onPick } for the number editor. Each frame
 * carries its own cursor so popping back lands where it was left. */
let knobWizardStack = [];
/* Where the knob will land. Captured at open (the empty slot that was
 * touched), or null when the wizard was opened from Knob Settings and the
 * placement should be worked out at commit time. */
let knobWizardTarget = null;
/* The instrument number chosen at the top of the Instrument path, carried
 * down to whichever leaf finally commits. */
let knobWizardInstrument = 0;

/* >= 0 while the wizard is re-pointing an EXISTING knob rather than
 * making a new one: the slot on the active page whose Connect row opened
 * it. The two walks are the same catalogue and the same frames - only
 * what happens at the leaf differs - so a second wizard would have been
 * the same code with one line changed. */
let knobWizardConnect = -1;

function openKnobWizard(target, connectIndex) {
    knobWizardOpen = true;
    knobWizardTarget = target || null;
    knobWizardConnect = connectIndex === undefined ? -1 : connectIndex;
    knobWizardInstrument = 0;
    knobWizardStack = [];
    pushWizardFrame(rootWizardFrame());
}

function closeKnobWizard() {
    knobWizardOpen = false;
    knobWizardConnect = -1;
    knobWizardStack = [];
    cachedSongId = null; /* the page's shape may have changed - rebuild the meta */
    repaintFromMemory();
}

/* Each frame carries the CONTEXT the path has narrowed to so far - "MIX",
 * "REV", "I1A", "I1A M2" - inherited from its parent unless it narrows
 * further. It ends up on the knob as `detail` and is what the header
 * shows while the knob is touched, because a name like CUT1A says which
 * instrument only if you already know the scheme.
 *
 * Kept on the FRAME rather than in one variable so Back unwinds it for
 * free: popping to the parent restores the parent's context. */
function pushWizardFrame(frame) {
    if (!frame) return;
    frame.cursor = 0;
    if (frame.kind === WIZ_HEX) frame.editing = -1;
    if (frame.ctx === undefined) {
        const parent = currentWizardFrame();
        frame.ctx = parent ? parent.ctx : "";
    }
    knobWizardStack.push(frame);
}

function currentWizardFrame() {
    return knobWizardStack[knobWizardStack.length - 1] || null;
}

/* The innermost frame that HAS a context, not the innermost frame.
 * The last step before a commit is often a plain picker that carries none
 * - the track number for Mixer > Track Volume, the wave for an LFO - so
 * reading the top of the stack dropped the context for exactly the entries
 * that take an extra step, and did it silently. */
function wizardCtx() {
    for (let i = knobWizardStack.length - 1; i >= 0; i--) {
        const ctx = knobWizardStack[i].ctx;
        if (ctx) return ctx;
    }
    return "";
}

/* Commit a catalogue leaf and close. `number` is what gets appended to the
 * name - a track, an instrument, or a mod slot, depending on the path. */
function commitWizardEntry(entry, number, vizMode) {
    const song = getActiveSong();
    if (song) {
        /* "Ins1A Cutoff", "MIX Track Volume", "Ins1A M2 Attack" - what the
         * header spells out while the knob is touched, abbreviated on the
         * way to the screen by knobDetail. The 3-letter stem under the
         * dial cannot say which instrument or which mod slot, and that is
         * the thing worth knowing. */
        if (knobWizardConnect >= 0) {
            const index = knobWizardConnect;
            connectKnobsFromEntry(song, entry, number, vizMode, wizardCtx(), index);
            closeKnobWizard();
            /* Straight back to the row that asked, so the new name and
             * connection are visible where the change was made. */
            openKnobEdit(index);
            return;
        }
        addKnobsFromEntry(song, entry, number, knobWizardTarget, vizMode, wizardCtx());
    }
    closeKnobWizard();
}

/* A graphic whose shape is fixed by a selector needs that selector's value
 * before it can be drawn, and the selector is not mappable so it never
 * becomes a knob - so the wizard asks, as one more step, and the answer is
 * stored with the group. Entries without one commit straight away. */
function pickEntry(entry, number) {
    /* A Generic shape IS its mode - "LFO SIN" was the row that was
     * clicked - so there is nothing left to ask. */
    if (entry.fixedVizMode) {
        commitWizardEntry(entry, number, entry.fixedVizMode);
        return;
    }
    if (!entry.vizModeOptions) {
        commitWizardEntry(entry, number);
        return;
    }
    pushWizardFrame(listFrame(
        entry.vizModePrompt || "Type", entry.vizModeOptions,
        (opt) => opt,
        () => "",
        (opt) => commitWizardEntry(entry, number, opt)));
}

/* --------------------------------------------------------- wizard frames */

function listFrame(title, items, getLabel, getValue, onPick, ctx) {
    return { kind: WIZ_LIST, title, items, getLabel, getValue, onPick, ctx };
}

/* A catalogue leaf's right-hand column: the name the knob will end up with,
 * so the result is visible before it is chosen. A multi-knob entry shows how
 * many knobs it will take instead - its members have several names. */
function entryPreview(entry, number) {
    if (entry.knobs) return `${entry.knobs.length}kn`;
    if (entry.needsTrack && number === undefined) return `${entry.m}..`;
    return m8KnobName(entry.m, number);
}

function paramListFrame(title, params, number, ctx) {
    return listFrame(
        title, params,
        (p) => p.label,
        (p) => entryPreview(p, number),
        (p) => {
            /* Only the mixer's track volume still asks for a number of its
             * own; everything else was numbered further up the path. */
            if (p.needsTrack) {
                pushWizardFrame(listFrame(
                    p.label, [1, 2, 3, 4, 5, 6, 7, 8],
                    (t) => `Track ${t}`,
                    (t) => m8KnobName(p.m, t),
                    (t) => pickEntry(p, t)));
                return;
            }
            pickEntry(p, number);
        },
        ctx);
}

/* The root's first entry: everything that does not need to be told which
 * instrument it belongs to.
 *
 * "Knob" is the old "Other" - a knob the catalogue has no opinion about,
 * which you name yourself and which takes the next free CC like any other.
 * It sat alone at the BOTTOM of the root list, which is the wrong end for
 * the entry a new user reaches for first.
 *
 * The mod types are here for a reason rather than for convenience: a mod
 * parameter is named and numbered by its SLOT, so the instrument step
 * above them was two clicks that changed nothing about the resulting
 * knob. Instrument > Mods still exists for the one thing it does add,
 * which is recording the instrument for the header. */
function genericFrame() {
    const entries = [{ name: "Knob", entry: null }];
    for (const e of M8_GENERIC_SHAPES) entries.push({ name: e.label, entry: e });
    /* One level, and it commits: no instrument, no mod slot, no track.
     * Everything here is chosen by its picture and connected afterwards
     * from Knob Settings, which is the whole point of the list. */
    return listFrame(
        "Generic", entries,
        (e) => e.name,
        (e) => (e.entry ? `${entryMembers(e.entry).length}kn` : ""),
        (e) => (e.entry ? pickEntry(e.entry, null) : openOtherKnobEntry()));
}

/* Which of M8's EQs, then its fifteen rows.
 *
 * The slot path asks for a number the way the instrument path does, and
 * the name carries it - "LGN0A" - so two slots' worth of knobs on one
 * page stay apart. The four named EQs have no number to carry, so their
 * knobs are named bare and told apart by the header, exactly as the
 * Mixer and Sends entries already are. */
function eqTargetFrame() {
    return listFrame(
        "EQ", M8_EQ_TARGETS,
        (t) => t.name,
        (t) => (t.ctx ? String(M8_EQ_PARAMS.length) : "00-7F"),
        (t) => {
            if (t.ctx) {
                pushWizardFrame(paramListFrame(t.name, M8_EQ_PARAMS, undefined, t.ctx));
                return;
            }
            pushWizardFrame({
                kind: WIZ_HEX, title: "EQ Slot", value: 0,
                max: M8_EQ_SLOT_MAX,
                onPick: (n) => {
                    const slot = n.toString(16).toUpperCase().padStart(2, "0");
                    pushWizardFrame(paramListFrame(
                        `EQ ${slot}`, M8_EQ_PARAMS, n, `EQ${slot}`));
                },
                ctx: "",
            });
        });
}

function rootWizardFrame() {
    const groups = [
        { name: "Generic", open: () => pushWizardFrame(genericFrame()) },
        {
            name: "Instrument",
            open: () => pushWizardFrame({
                kind: WIZ_HEX, title: "Instrument", value: 0,
                onPick: (n) => { knobWizardInstrument = n; pushWizardFrame(instrumentFrame(n)); },
                ctx: "",
            }),
        },
        { name: "Mixer", open: () => pushWizardFrame(paramListFrame("Mixer", M8_MIXER_PARAMS, undefined, "MIX")) },
        {
            name: "Sends",
            open: () => pushWizardFrame(listFrame(
                "Sends", M8_SEND_GROUPS,
                (g) => g.name,
                (g) => String(g.params.length),
                (g) => pushWizardFrame(paramListFrame(g.name, g.params, undefined, g.ctx)))),
        },
        { name: "EQ", open: () => pushWizardFrame(eqTargetFrame()) },
    ];
    return listFrame("Add Knob", groups, (g) => g.name, () => "", (g) => g.open());
}

/* A mod parameter's NAME is numbered by its slot ("ATK2"), so the
 * instrument is the one thing about it the name can never say - which is
 * exactly why this path records it in the context and why there is no
 * instrument-free shortcut to it. Generic offers the mod GRAPHICS with no
 * connection at all; naming one is always this walk. */
function modSlotFrame(ctx) {
    return listFrame(
        "Mod Slot", [1, 2, 3, 4],
        (n) => `Mod ${n}`,
        () => "",
        (n) => {
            const slotCtx = [ctx, `M${n}`].filter(Boolean).join(" ");
            pushWizardFrame(listFrame(
                `Mod ${n}`, M8_MOD_TYPES,
                (t) => t.name,
                () => "",
                (t) => pushWizardFrame(paramListFrame(t.name, t.params, n, slotCtx)),
                slotCtx));
        },
        ctx);
}

function instrumentFrame(instrument) {
    const label = instrument.toString(16).toUpperCase().padStart(2, "0");
    const ctx = instCtx(instrument);
    const categories = [
        /* "Base": the parameters every instrument has, whatever its type.
         * It was "Generic", which now names the root's no-connection
         * shape list - two different things one level apart under the
         * same word. */
        {
            name: "Base",
            open: () => pushWizardFrame(
                paramListFrame("Base", M8_INSTRUMENT_GENERIC, instrument, ctx)),
        },
        /* The mod SLOT, not the instrument, numbers a mod parameter's
         * name - see m8KnobName. */
        { name: "Mods", open: () => pushWizardFrame(modSlotFrame(ctx)) },
        {
            name: "Instrument Type",
            open: () => pushWizardFrame(listFrame(
                "Type", M8_INSTRUMENT_TYPES,
                (t) => t.name,
                (t) => String(t.params.length),
                (t) => pushWizardFrame(
                    paramListFrame(t.name, typeParamsFor(t), instrument, ctx)))),
        },
    ];
    return listFrame(`Inst ${label}`, categories, (c) => c.name, () => "", (c) => c.open(), ctx);
}

/* A type's own parameters, plus its filter graphic when the type widens the
 * filter list - Wavsynth's four in-waveform modes are not offered anywhere
 * else, so its filter entry cannot come from the shared generic list. */
function typeParamsFor(type) {
    if (!type.filterTypes) return type.params;
    return [filterEntry(type.filterTypes)].concat(type.params);
}

/* Generic > Knob: straight to the keyboard, and the typed text IS the
 * name. For an M8 parameter this module does not know, or a mapping to
 * something else entirely on the same channel. */
function openOtherKnobEntry() {
    openKeyboard({
        title: "Knob Name",
        initialText: "PRM",
        onConfirm: (text) => {
            const trimmed = (text || "").trim();
            commitWizardEntry({ m: trimmed || "PRM", def: 0x00 }, null);
        },
    });
}

/* ---------------------------------------------------------- wizard input */

function handleKnobWizardInput(data) {
    /* Generic > Knob hands the pads to text_entry.mjs; it owns everything until it
     * confirms or cancels. A cancel leaves the wizard standing on the group
     * list, which is where Back would have put it anyway. */
    if (routeTextEntryInput(data)) return;
    if (data[0] !== 0xb0) return;

    const frame = currentWizardFrame();
    if (!frame) {
        closeKnobWizard();
        return;
    }

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    if (moveControlNumber === moveSHIFT) {
        setShiftHeld(pressed);
        return;
    }

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta !== 0) wizardTurn(frame, Math.sign(delta));
        return;
    }

    if (!pressed) return;

    if (moveControlNumber === moveBACK) {
        if (frame.kind === WIZ_HEX && frame.editing >= 0) {
            frame.editing = -1;   /* leave the digit before leaving the screen */
            return;
        }
        knobWizardStack.pop();
        if (!knobWizardStack.length) closeKnobWizard();
        return;
    }

    if (moveControlNumber === moveWHEEL) wizardClick(frame);
}

/* Rows of the hex editor: the two digits, then the row that accepts. */
const WIZ_HEX_ROWS = 3;

function wizardTurn(frame, step) {
    if (frame.kind === WIZ_HEX) {
        if (frame.editing < 0) {
            frame.cursor = Math.max(0, Math.min(WIZ_HEX_ROWS - 1, frame.cursor + step));
            return;
        }
        /* Editing a digit: each digit is clamped to 0-F on its own and never
         * carries into the other, which is the whole reason for editing them
         * separately - winding the low digit past F to reach the next
         * sixteen is the scroll this screen exists to avoid. */
        const digit = frame.editing === 0 ? (frame.value >> 4) & 0xF : frame.value & 0xF;
        const next = Math.max(0, Math.min(15, digit + step));
        const value = frame.editing === 0
            ? (next << 4) | (frame.value & 0xF)
            : (frame.value & 0xF0) | next;
        /* `max` where the range is not a whole byte - EQ slots stop at 7F.
         * The digit REFUSES rather than snapping to the ceiling, which is
         * the same way it already refuses to carry past F: winding finds
         * the end and stays there instead of jumping somewhere else. */
        if (frame.max !== undefined && value > frame.max) return;
        frame.value = value;
        return;
    }
    frame.cursor = Math.max(0, Math.min(frame.items.length - 1, frame.cursor + step));
}

function wizardClick(frame) {
    if (frame.kind === WIZ_HEX) {
        if (frame.cursor === WIZ_HEX_ROWS - 1) {
            frame.onPick(frame.value);
            return;
        }
        frame.editing = frame.editing === frame.cursor ? -1 : frame.cursor;
        return;
    }
    const chosen = frame.items[frame.cursor];
    if (chosen !== undefined) frame.onPick(chosen);
}

/* ---------------------------------------------------------- wizard draw */

function drawKnobWizard() {
    const frame = currentWizardFrame();
    if (!frame) {
        closeKnobWizard();
        return;
    }
    if (isTextEntryActive()) {
        tickTextEntry();
        drawTextEntry();
        return;
    }

    clear_screen();
    if (frame.kind === WIZ_HEX) {
        drawWizardHex(frame);
        return;
    }
    drawMenuHeader(frame.title);
    drawMenuList({
        items: frame.items,
        selectedIndex: frame.cursor,
        /* This list carries the longest labels in the module - "Filter
         * Highpass", "LFO Square Down" - against the shortest values,
         * which are all "2kn". The default columns are laid out for the
         * opposite shape (a 9px indent and a value column starting at
         * 92), which left 12 characters for a 15-character label and
         * ran it into the value.
         *
         * Both edges move: dropping the indent alone still leaves the
         * longest rows a character short. */
        labelX: 2,
        valueX: 104,
        getLabel: (item) => frame.getLabel(item),
        getValue: (item) => frame.getValue(item),
    });
    drawMenuFooter(["Jog: Move", "Clk: Pick", "Bck: Up"]);
}

function drawWizardHex(frame) {
    const hex = frame.value.toString(16).toUpperCase().padStart(2, "0");
    drawMenuHeader(`${frame.title} ${hex}`);
    drawMenuList({
        items: [0, 1, 2],
        selectedIndex: frame.cursor,
        editMode: frame.editing >= 0 && frame.editing === frame.cursor,
        getLabel: (row) => (row === 0 ? "Digit 1" : row === 1 ? "Digit 2" : "Use This"),
        getValue: (row) => {
            if (row === 0) return hex[0];
            if (row === 1) return hex[1];
            return hex;
        },
    });
    drawMenuFooter(["Jog: Move", "Clk: Edit", "Bck: Up"]);
}

/* Adapter from param_pages' { fillRect, print, textWidth } contract to
 * Move's actual globals, which are snake_case (fill_rect/text_width) except
 * print, which already matches. */
const songPageDrawCtx = {
    fillRect: (x, y, w, h, color) => fill_rect(x, y, w, h, color),
    print: (x, y, text, color) => print(x, y, text, color),
    textWidth: (text) => text_width(text),
};

/* Cached per (song, page) so the synthetic chain_params/metaIndex aren't
 * rebuilt every tick (~245Hz, measured earlier in this module's debugging) -
 * only when the active song or page actually changes. Matches the
 * "rebuild when fingerprint changes" pattern docs/PARAM_PAGES.md describes
 * for the real chain-slot case. */
let cachedSongId = null;
let cachedPageIndex = -1;
let cachedChainParams = null;
let cachedMetaIndex = null;
/* Cell-less params carrying each graphic's fixed setting - see the
 * `span: false` note in ensureSongPageMeta. */
let cachedVizModeParams = [];

/* Every knob is declared "int" now, always - see the note above HEX_OPTIONS'
 * old home in git history for why an enum-of-hex-strings was tried instead.
 * That got the hex TEXT right but lost the dial pointer: render_page.mjs
 * only draws the dial for a KIND_NUMBER cell (drawCell's KIND_ENUM branch
 * draws a boxed value, no dial) - so a Hex-display knob rendered as a static
 * box while its Decimal-display neighbours kept their needle. Declaring
 * every knob "int" restores the dial (the fraction it points to comes from
 * the plain 0-127 CC value either way, so the pointer is correct regardless
 * of display mode) and the cell's own label position is left showing the
 * knob's NAME always - the VALUE, hex or decimal, is never drawn on the
 * cell at all, only in the swapped title row drawSongPage builds below. */
function ensureSongPageMeta(song, pageIndex, page) {
    if (cachedSongId === song.id && cachedPageIndex === pageIndex) return;
    /* chain_params spells the display label `name`, not `label` - that's the
     * inline-hierarchy field name, and using the wrong one silently falls
     * through to a de-underscored key instead of throwing.
     *
     * An empty slot contributes a null rather than a param: renderPage draws
     * a faint tick for any slot whose key is falsy (drawEmptyCell), which is
     * exactly what an addable slot should look like, so the holes need no
     * handling of their own beyond keeping the array 8 long and positional. */
    /* A graphic needs at least two of its knobs still present. viz.mjs is
     * happy to form a one-role group (a single slot IS an adjacent run), and
     * drawEnvelope then returns without drawing anything - leaving a cell
     * that is claimed by the graphic and therefore skipped by the ordinary
     * cell loop, i.e. blank. Removing two of an envelope's three knobs is
     * all it takes. Counting first and dropping the declaration below turns
     * that case back into ordinary dials. */
    const groupCounts = new Map();
    for (const k of page.knobs) {
        if (!k || !k.viz || !k.viz.group) continue;
        groupCounts.set(k.viz.group, (groupCounts.get(k.viz.group) || 0) + 1);
    }

    /* Groups whose fixed setting has no honest picture - see
     * vizModeUnsupported. Declaring no viz leaves the members as
     * ordinary labelled dials. */
    const unsupported = new Set();
    for (const k of page.knobs) {
        if (!k || !k.viz || !k.viz.group || !k.vizMode) continue;
        if (vizModeUnsupported(k.vizMode)) unsupported.add(k.viz.group);
    }

    cachedChainParams = page.knobs.map((k, i) => {
        if (!k) return null;
        const key = `${song.id}:${pageIndex}:${i}`;
        const param = { key, name: k.name, type: "int", min: 0, max: 127, step: 1 };
        if (k.viz && k.viz.group && groupCounts.get(k.viz.group) >= 2
            && !unsupported.has(k.viz.group)) {
            param.viz = { group: k.viz.group, kind: k.viz.kind, role: k.viz.role };
        }
        return param;
    });

    /* The fixed setting behind a graphic - a filter's type, an LFO's wave -
     * as a role with NO CELL. viz.mjs's `span: false` is exactly this: "a
     * role that lends the graphic its VALUE without joining the run of
     * cells it covers", and such a role is not claimed, so it costs no
     * slot. The key is appended PAST the eight the grid draws, so
     * renderPage's cell loop (which stops at COLS*ROWS) never reaches it
     * while collectDeclared, which walks the whole key array, still sees
     * it.
     *
     * The value is always index 0 of a one-option enum holding the chosen
     * text, because the only consumer is viz_draw resolving that text to a
     * curve or a wave - it never needs the other options, and keeping the
     * full list out of the saved song keeps songs.json small. */
    cachedVizModeParams = [];
    page.knobs.forEach((k, i) => {
        if (!k || !k.vizMode || !k.viz || !k.viz.group) return;
        if (groupCounts.get(k.viz.group) < 2) return;
        if (unsupported.has(k.viz.group)) return;
        cachedVizModeParams.push({
            key: `${song.id}:${pageIndex}:${i}:mode`,
            name: "",
            type: "enum",
            options: [k.vizMode],
            viz: {
                group: k.viz.group,
                kind: k.viz.kind,
                role: k.viz.kind === "lfo" ? "shape" : "mode",
                span: false,
            },
        });
    });

    cachedMetaIndex = buildMetaIndex({
        chainParams: cachedChainParams.filter(Boolean).concat(cachedVizModeParams),
    });
    cachedSongId = song.id;
    cachedPageIndex = pageIndex;
}

/* Where the library draws a cell's name label.
 *
 * render_page.mjs derives this from constants it does not export
 * (HEADER_BLOCK, FONT_H and the row height), so the two baselines are
 * pinned here instead - and CHECKED: test_graphic_labels asserts that an
 * ordinary dial's label lands exactly on them, so a change in that file
 * fails a test rather than quietly putting text in the wrong place.
 *
 * This replaced a scheme that wrapped `print` and matched the recorded
 * calls by position. That worked for a labelled cell and could not work
 * at all for a cell covered by a graphic, which prints nothing - and
 * those are exactly the cells that now need a label drawn. */
/* Moved up when the grid was shortened for the hint bar: the two rows
 * now sit in 0..54 rather than 0..63, so renderPage's own label
 * baselines came up with them. Measured from what renderPage draws for
 * an ordinary dial, not guessed - and test_knobpage pins them, so a
 * change in render_page.mjs fails a test rather than quietly putting our
 * graphic labels on a different line from its dial labels. */
const CELL_LABEL_Y = [26, 48];
const CELL_W = SCREEN_WIDTH / COLS;

function slotLabelCentre(slot) {
    return (slot % KNOBS_PER_ROW) * CELL_W + Math.floor(CELL_W / 2);
}

function slotLabelBaseline(slot) {
    return CELL_LABEL_Y[Math.floor(slot / KNOBS_PER_ROW)];
}

/* WHAT THE BAR ALONG THE BOTTOM SAYS.
 *
 * Three pairs, each a key in an inverted pill and what it does beside
 * it - the same footer every Schwung param page carries, so the knob
 * page reads like the rest of the system rather than like a screen with
 * no way out.
 *
 * HOLDING SHIFT SWAPS ALL THREE. The knob page has two sets of
 * gestures and only room for one, and the Shift set is the one nobody
 * can guess: that the step buttons reach the two menus, and that
 * holding Shift while turning a knob auditions the change and puts it
 * back. Shift is the natural place to ask "what else is there", so
 * asking it answers itself. */
function knobPageHints() {
    /* The knob cursor is an OVERLAY on this page rather than a screen of
     * its own, so the bar under it is this one - and while it is up the
     * wheel walks knobs instead of pages, which is the whole reason the
     * label cannot just say "page" everywhere. */
    if (knobSelectOpen) {
        if (shiftHeld) return ["Jog: Move", "Cpy: Copy", "Del: Del"];
        return ["Jog: Knob", "Clk: Edit", "Bck: Exit"];
    }
    if (shiftHeld) return ["St1: Song", "St2: Setup", "Knb: Try"];
    /* THE PAGE HINT ONLY WHEN THERE IS A PAGE WORTH TURNING TO.
     *
     * Counting pages is not the same as counting pages of KNOBS. Filling
     * a page makes ensureSparePage add an empty one behind it so there
     * is always somewhere to put the next knob - so a song with one full
     * page has two pages, and the wheel's only destination is a blank.
     * That is a place the wheel can go, not a place worth advertising.
     *
     * Pages that hold something are what count, and the hint appears
     * once there is more than one of them. */
    const song = getActiveSong();
    const filled = song
        ? song.pages.filter((pg) => pg.knobs.some((k) => k)).length
        : 0;
    const canPage = filled > 1;
    return canPage
        ? ["Jog: Page", "Clk: Edit", "Sft: More"]
        : ["Clk: Edit", "Sft: More"];
}

/* The song list. Shift turns the two buttons into copy and delete, and
 * the plain click hint gives up its place to say so - there is only room
 * for three, and what Shift adds is worth more than repeating what an
 * unshifted click does. */
function songMgmtHints() {
    if (shiftHeld) return ["Jog: Order", "Cpy: Dup", "Del: Del"];
    return ["Jog: Move", "Clk: Sel", "Bck: Exit"];
}

/* Draw one cell's label row: a name, or a value in an inverted pill.
 *
 * The full cell width is cleared first whatever is being drawn, because
 * what is already there may be WIDER than what replaces it - "CUTOFF"
 * giving way to "E0" would otherwise leave the ends of the old name
 * showing on either side of the pill.
 *
 * The pill itself is only as wide as its text plus a couple of pixels,
 * rather than the whole cell: a full-width bar reads as a highlighted
 * row, and what is wanted is a badge around the number. */
/* THE LAST PIXEL ROW OF THE PANEL IS NOT SAFE TO PAINT.
 *
 * The bottom cell's label row is y 55 to 63 - exactly the full height -
 * and a pill drawn there came out on the device as a white line across
 * the TOP of the screen as well, at the same x. Nothing in the module
 * or the host renderer draws it (both clip at the buffer edge, and the
 * draw log has nothing above y=8 at that x), so it is the panel's own
 * row 63 showing up where it should not. Everything else on this
 * surface stops at 62 - the footer text included - which is why this
 * is the first place it has ever shown.
 *
 * So the label row is trimmed to end at 62 where it would run to 63.
 * One pixel off the bottom of a nine-pixel pill is not visible; the
 * line at the top very much is. */
const LAST_SAFE_ROW = 62;

function labelRowHeight(top) {
    return Math.min(LABEL_ROW_H, LAST_SAFE_ROW + 1 - top);
}

function drawSlotLabel(slot, text, inverted) {
    const cx = slotLabelCentre(slot);
    const y = slotLabelBaseline(slot);
    const rowTop = y - 1;
    const rowH = labelRowHeight(rowTop);
    fill_rect(Math.round(cx - CELL_W / 2), rowTop, CELL_W, rowH, 0);
    const fitted = fitText(songPageDrawCtx, text, CELL_W - 2);
    if (inverted) {
        /* The pill hugs the text, so it can be WIDER than the cell -
         * the text is fitted to CELL_W - 2 and the pill adds four for
         * its padding. In the last cell that ran off the right edge
         * and fill_rect refused the write. Clamped to the panel. */
        const w = Math.min(text_width(fitted) + 4, SCREEN_WIDTH);
        const x = Math.max(0, Math.min(Math.round(cx - w / 2), SCREEN_WIDTH - w));
        fill_rect(x, rowTop, w, rowH, 1);
    }
    centeredText(songPageDrawCtx, cx, y, fitted, inverted ? 0 : 1);
}

/* The master knob's value, drawn OVER the page while it is moving.
 *
 * It cannot have a cell: the eight cells belong to the song knobs and
 * the master is not one of them. A panel in the middle borrows the
 * space instead and gives it straight back - the page underneath is
 * redrawn whole on the next frame, so nothing has to be restored. A
 * hollow box rather than a solid pill, so it reads as something laid on
 * top of the dials instead of one of them. */
const MASTER_OVERLAY_H = 17;

/* The main knob's value in whatever Settings > Main Knob asks for.
 * Borrows the song knobs' formatter rather than keeping a second set of
 * rules: the master stores CC steps, and hex counts in bytes, so that
 * one reading is doubled on the way in. */
function formatMasterValue() {
    const shown = { display: settings.masterDisplay, value: settings.masterValue };
    if (knobFineHex(shown)) shown.value = Math.min(255, settings.masterValue * 2);
    return formatKnobReadoutValue(shown);
}

function drawMasterOverlay() {
    const label = "Main " + formatMasterValue();
    const w = Math.min(SCREEN_WIDTH - 8, text_width(label) + 18);
    const x = Math.round((SCREEN_WIDTH - w) / 2);
    const y = 24;
    fill_rect(x, y, w, MASTER_OVERLAY_H, 1);
    fill_rect(x + 1, y + 1, w - 2, MASTER_OVERLAY_H - 2, 0);
    centeredText(songPageDrawCtx, SCREEN_WIDTH / 2, y + 5, label, 1);
}

/* Holding the jog wheel turns knob moves into an AUDITION: the values
 * you dial in while it is held are put back when you let go.
 *
 * This is the same bargain the wheel already strikes with the pad view -
 * hold to look, release to undo - so "nothing you do while holding the
 * wheel sticks" is one rule rather than two.
 *
 * The original value is captured lazily, on the first turn of each knob,
 * so holding the wheel without touching anything costs nothing. Reverting
 * has to reach M8 as well as the display, and how depends on the knob's
 * send mode - see revertAuditionedKnobs. */
const auditionedKnobs = new Map();   /* knob object -> value before the audition */

/* Held SHIFT is what makes a knob move an audition now. It used to be a
 * held wheel touch, and the wheel was needed back for knob select;
 * Shift came free the moment knob editing moved off Shift+touch. */
function noteAuditionValue(knob) {
    if (shiftHeld && !auditionedKnobs.has(knob)) auditionedKnobs.set(knob, knob.value);
}

function revertAuditionedKnobs() {
    revertMasterAudition();
    if (!auditionedKnobs.size) return;
    for (const [knob, original] of auditionedKnobs) {
        const delta = original - knob.value;
        knob.value = original;
        if (delta === 0) continue;
        if (knob.mode === KNOB_MODE_RELATIVE) {
            /* Relative knobs send movement, not position, so the revert
             * is the opposite movement. Move's encoding is 1-63 for
             * clockwise and 65-127 for anticlockwise (see decodeDelta),
             * and one message carries the whole correction. The wire
             * counts CC steps, so a hex knob's two bytes are one. */
            const ccDelta = knobFineHex(knob) ? Math.round(delta / 2) : delta;
            const size = Math.min(63, Math.abs(ccDelta));
            if (size) move_midi_external_send([2 << 4 | 0xb, 0xb0 | knobChannelOf(knob),
                                               knob.cc, ccDelta > 0 ? size : 64 + size]);
        } else {
            move_midi_external_send([2 << 4 | 0xb, 0xb0 | knobChannelOf(knob),
                                     knob.cc, knobCcValue(knob)]);
        }
    }
    auditionedKnobs.clear();
    /* The autosave may well have persisted a mid-audition value already,
     * so the revert has to be written too. */
    markSongsDirty();
}

/* Which song knob (0-7, or -1) reads as "active" right now - its VALUE
 * replaces its own NAME label (the text under its dial), reverting to the
 * name once it isn't. A capacitive touch claims a knob until release; a turn
 * with no touch registered claims it for KNOB_TURN_CLAIM_MS instead, the
 * same shape as Schwung's own TURN_CLAIM_MS in page_controller.mjs - a turn
 * has no release event of its own, so it has to time out rather than latch
 * forever on a knob whose touch pad never fired. See claimKnobTouch/
 * releaseKnobTouch/claimKnobTurn and their call sites (the main note handler
 * and handleSongKnobTurn). */
let activeKnobIndex = -1;
let activeKnobTouched = false;
let activeKnobTurnUntil = 0;
const KNOB_TURN_CLAIM_MS = 1200;

function claimKnobTouch(index) {
    activeKnobIndex = index;
    activeKnobTouched = true;
}

function releaseKnobTouch(index) {
    if (activeKnobIndex !== index) return;
    activeKnobTouched = false;
}

/* The master knob has no cell on the page - the eight song knobs fill
 * it - so its value is shown as a panel OVER them while it is being
 * moved, on the same terms as a song knob's readout: for as long as it
 * is touched, and for a moment after a turn. */
let masterTouched = false;
let masterTurnUntil = 0;

function isMasterReadoutActive() {
    return masterTouched || Date.now() < masterTurnUntil;
}

function claimKnobTurn(index) {
    activeKnobIndex = index;
    activeKnobTurnUntil = Date.now() + KNOB_TURN_CLAIM_MS;
}

function isKnobReadoutActive(index) {
    return index === activeKnobIndex && (activeKnobTouched || Date.now() < activeKnobTurnUntil);
}

/* Mirrors the doubling in handleSongKnobTurn's M8-hex comment (git history):
 * M8's own parameter values are a byte (00-FF) reached by doubling the 7-bit
 * CC, so the readout must double too or it reads half of what the M8 screen
 * shows for the same knob position. */
/* An end of the travel, in whatever the knob counts in. The value
 * formatter works off knob.value, so this borrows it with the limit
 * standing in - same rounding, same hex padding, one set of rules. */
function formatKnobLimit(knob, step) {
    const real = knob.value;
    knob.value = step;
    const text = formatKnobReadoutValue(knob);
    knob.value = real;
    return text;
}

function formatKnobReadoutValue(knob) {
    if (knob.display === KNOB_DISPLAY_HEX) {
        /* The byte IS the value now - see knobFineHex. A note-valued
         * parameter is 0-127 on the M8 too, so it shows as it stands. */
        const shown = knob.value;
        return shown.toString(16).toUpperCase().padStart(2, "0");
    }
    /* The normalised readings work off the CC range the knob actually
     * travels (0-127), not M8's byte range, so they are the same whether
     * or not the parameter is note-scaled. */
    if (knob.display === KNOB_DISPLAY_UNIT) {
        return (knob.value / 127).toFixed(2);
    }
    /* M8'S OWN EQ READINGS.
     *
     * Gain is centred on 64 for the same reason the bipolar reading is:
     * that is the CC landing on M8's own centre, so the default reads a
     * true 0.00 rather than a third of a decibel off it. The top of the
     * travel reaches 39.38 rather than 40.00 - the same "a 7-bit CC
     * cannot quite reach the top" that hex shows as FE. */
    if (knob.display === KNOB_DISPLAY_EQ_GAIN) {
        return (((knob.value - 64) / 64) * EQ_GAIN_RANGE_DB).toFixed(2);
    }
    /* 01 at the bottom of the travel, 99 at the top, 50 in the middle -
     * turning the knob up narrows the band. Two digits, as the editor
     * prints it. */
    if (knob.display === KNOB_DISPLAY_EQ_Q) {
        const q = EQ_Q_LOW + Math.round((knob.value / 127) * (EQ_Q_HIGH - EQ_Q_LOW));
        return String(q).padStart(2, "0");
    }
    /* Frequency is a LOOKUP, not a curve - see M8_EQ_FREQ_TABLE. One
     * entry per CC step, which is why the table is 128 long. */
    if (knob.display === KNOB_DISPLAY_EQ_FREQ) {
        const i = Math.max(0, Math.min(M8_EQ_FREQ_TABLE.length - 1, Math.round(knob.value)));
        return String(M8_EQ_FREQ_TABLE[i]);
    }
    if (knob.display === KNOB_DISPLAY_BIPOLAR) {
        /* Centred on 64, because that is the CC that lands on M8's own
         * centre of 0x80. The cost is that the top of the range reads
         * 0.98 rather than 1.00 - the same "a 7-bit CC cannot quite
         * reach the top" the hex reading has, where 127 shows FE. */
        return ((knob.value - 64) / 64).toFixed(2);
    }
    return String(knob.value);
}

/* A label row: the device's fixed 5x7 font plus a clear pixel above AND
 * below it. drawCell's own "locked" background uses FONT_H + 1, which
 * leaves the glyphs sitting on the bottom edge of the fill - fine for a
 * strip that spans the cell, wrong for the value pill, where the text
 * reads as resting on the border rather than inside it. */
const LABEL_ROW_H = 9;

/* Draws the active song's current page in place of the plain-text status.
 * Returns false (draws nothing) if there's no song/page yet, so the caller
 * can fall back to the text status. */
function drawSongPage() {
    const song = getActiveSong();
    const page = getActivePage();
    if (!song || !page) return false;

    ensureSongPageMeta(song, activePageIndex, page);

    const values = {};
    cachedChainParams.forEach((p, i) => {
        /* The dials and the pictures are drawn against a 0-127 param, so
         * a hex knob hands over its CC rather than its byte. */
        if (p) values[p.key] = knobCcValue(page.knobs[i]);
    });

    /* renderPage draws only the graphics it is HANDED - resolution and
     * drawing are separate in this library, so the caller runs the resolver.
     * Ours only ever comes back with groups this module declared on its own
     * synthetic chain_params (viz.mjs's detectors need vocabulary in the key
     * names, which these keys, being song:page:slot, do not have). */
    const pageKeys = cachedChainParams.map((p) => (p ? p.key : null));
    /* Appended PAST the eight cells the grid draws, so these lend their
     * value to a graphic without ever being rendered - see the span:false
     * note in ensureSongPageMeta. Index 0 of a one-option enum: the option
     * text is the whole payload. */
    for (const vp of cachedVizModeParams) {
        pageKeys.push(vp.key);
        values[vp.key] = 0;
    }

    const viz = resolveViz({ keys: pageKeys, metaIndex: cachedMetaIndex }).groups;

    clear_screen();

    /* The header's right-hand slot, which is otherwise unused - our pages
     * carry no name. drawHeader gives it first claim on the width and
     * fits it, so a long detail truncates rather than colliding with the
     * song name on the left. */
    const activeKnob = (activeKnobIndex >= 0 && isKnobReadoutActive(activeKnobIndex))
        ? page.knobs[activeKnobIndex] : null;
    const headerRight = (activeKnob && knobDetail(activeKnob)) || page.name || "";

    /* THE GRID IS SHORTENED TO MAKE ROOM FOR THE BAR.
     *
     * renderPage lays its two rows out inside whatever rect it is given
     * and expects the caller to draw anything below - the same division
     * every other Schwung param page uses. RULE_Y (55) is where the
     * chrome starts, so the eight cells get rows 0..54 and the hint bar
     * gets 55..63. */
    renderPage(songPageDrawCtx, {
        rect: { x: 0, y: 0, w: SCREEN_WIDTH, h: RULE_Y },
        page: { name: headerRight, keys: pageKeys },
        metaIndex: cachedMetaIndex,
        values,
        viz,
        title: song.name || "",
        pageIndex: activePageIndex,
        pageCount: song.pages.length,
        touched: -1,
    });

    /* A graphic replaces its members' cells, so renderPage draws them no
     * labels - but you still need to know which knob is attack and which
     * is decay. The picture only uses the top 13 rows of a 26-row cell
     * (viz_draw's VIZ_ROWS), so the label row underneath is free for
     * exactly this. */
    const covered = new Set();
    for (const g of viz) {
        for (let i = 0; i < g.slotSpan; i++) covered.add(g.slotStart + i);
    }
    for (const slot of covered) {
        const knob = page.knobs[slot];
        if (!knob) continue;
        const active = isKnobReadoutActive(slot);
        drawSlotLabel(slot, active ? formatKnobReadoutValue(knob) : knob.name, active);
    }

    drawMenuFooter(knobPageHints());

    /* An ordinary cell already has its name from renderPage; only the
     * active one needs swapping for its value. */
    if (activeKnobIndex >= 0 && !covered.has(activeKnobIndex)
        && isKnobReadoutActive(activeKnobIndex) && page.knobs[activeKnobIndex]) {
        drawSlotLabel(activeKnobIndex,
                      formatKnobReadoutValue(page.knobs[activeKnobIndex]), true);
    }

    /* The knob-select cursor, in the same inverted pill the value
     * readout uses - one visual idea for "this slot, right now" rather
     * than a second one to learn. An empty slot has no name to invert,
     * so it gets the thing clicking it would do. */
    if (knobSelectOpen) {
        const sel = page.knobs[knobSelectIndex];
        drawSlotLabel(knobSelectIndex, sel ? sel.name : "Add", true);
    }

    /* Last, so it covers whatever it lands on. */
    if (isMasterReadoutActive()) drawMasterOverlay();

    return true;
}

/* Knob turn (CC71-78) edits the active page's knob and forwards its CC to
 * M8. Plain +/-1 per detent for now, matching the old system's step size -
 * M8-style coarse/fine (EDIT+UP/DOWN vs LEFT/RIGHT) and the rest of
 * page_controller.mjs's gesture set (hold-to-reveal, Shift precision,
 * Mute+touch reset) are deferred to a follow-up phase rather than adopted
 * blind while the device is unreachable for verification. */
/* Channels and the master knob's CC are settings now - see
 * DEFAULT_SETTINGS. M8's CONTROL MAP CHANNEL (MIDI Settings view) has to
 * match settings.knobChannel or nothing the knobs send is heard. */

function handleSongKnobTurn(data) {
    const knobIndex = data[1] - 71;
    if (knobIndex < 0 || knobIndex >= KNOBS_PER_PAGE) return;

    const page = getActivePage();
    if (!page) return;

    const delta = decodeDelta(data[2]);
    if (delta === 0) return;

    /* Shift+turn is the AUDITION: the value moves and M8 hears it, and
     * letting Shift go puts it back (noteAuditionValue below records the
     * starting point). The gesture used to be the jogwheel touch, which
     * the knob cursor now owns. */

    const knob = page.knobs[knobIndex];
    if (!knob) return; /* empty slot - this encoder controls nothing here */
    noteAuditionValue(knob);
    /* The multiplier can make a detent worth less than a whole step, so
     * some detents move nothing and only carry the remainder. The
     * readout is still claimed for them: the knob is being turned, and
     * a screen that ignored the first three detents of a 1/4x knob
     * would look broken. */
    const steps = knobDetentSteps(knob, Math.sign(delta));
    claimKnobTurn(knobIndex);
    if (steps === 0) return;
    knob.value = Math.max(knobLow(knob),
                          Math.min(knobHigh(knob), knob.value + steps));
    /* Absolute: send the accumulated 0-127 value we track (today's
     * behaviour). Relative: forward Move's own relative encoder byte as-is
     * (1-63 CW, 65-127 CCW) and let M8 do the accumulating - `knob.value`
     * still tracks an approximate position for the on-screen display either
     * way, but isn't what's on the wire in this mode. */
    const wireValue = knob.mode === KNOB_MODE_RELATIVE ? data[2] : knobCcValue(knob);
    move_midi_external_send([2 << 4 | 0xb, 0xb0 | knobChannelOf(knob), knob.cc, wireValue]);
    markSongsDirty();
}

/* CC79 (master) pass-through - see the comment at its call site. Not part of
 * any song's data, just forwards its own value; its only appearance on
 * screen is the transient panel drawn by drawMasterOverlay. The value
 * itself lives in `settings` so it survives a reload - see masterValue
 * in DEFAULT_SETTINGS. */
/* Where the master knob stood when a Shift audition began, or null. */
let masterAuditionValue = null;

function sendMasterValue(wire) {
    move_midi_external_send([2 << 4 | 0xb, 0xb0 | settings.masterChannel,
                             settings.masterCc, wire]);
}

function revertMasterAudition() {
    if (masterAuditionValue === null) return;
    const delta = masterAuditionValue - settings.masterValue;
    settings.masterValue = masterAuditionValue;
    masterAuditionValue = null;
    /* The autosave may already have written the mid-audition value. */
    markSongsDirty();
    if (delta === 0) return;
    if (settings.masterMode === KNOB_MODE_RELATIVE) {
        const size = Math.min(63, Math.abs(delta));
        sendMasterValue(delta > 0 ? size : 64 + size);
    } else {
        sendMasterValue(settings.masterValue);
    }
}

function handleMasterKnobTurn(data) {
    const delta = decodeDelta(data[2]);
    if (delta === 0) return;
    /* Shift auditions this knob too: the value moves and M8 hears it,
     * and letting Shift go puts it back. It is not in auditionedKnobs
     * because it is not a knob object - it has no song, name or CC of
     * its own - so it keeps its own one-slot memory. */
    if (shiftHeld && masterAuditionValue === null) masterAuditionValue = settings.masterValue;
    masterTurnUntil = Date.now() + KNOB_TURN_CLAIM_MS;
    settings.masterValue = Math.max(0, Math.min(127, settings.masterValue + Math.sign(delta)));
    markSongsDirty();
    /* Same absolute/relative split as a song knob: Absolute sends the
     * position we track, Relative forwards Move's own encoder byte and
     * lets M8 accumulate. Channel and CC are its own, not the knobs'. */
    const wireValue = settings.masterMode === KNOB_MODE_RELATIVE ? data[2] : settings.masterValue;
    sendMasterValue(wireValue);
}

/* External MIDI handler (from M8) */
globalThis.onMidiMessageExternal = function (data) {
    if (data[0] === MidiClock) return;
    traceIncoming(data);

    let value = data[0];
    let maskedValue = (value & 0xf0);
    let noteOn = maskedValue === 0x90;
    let noteOff = maskedValue === 0x80;

    /* Handle sysex - 0xF7 can appear at different positions based on packet type:
     * CIN 0x05 (1-byte end): data[0], CIN 0x06 (2-byte end): data[1], CIN 0x07 (3-byte end): data[2]
     * Only push bytes up to and including F7 to avoid padding zeros */
    let sysexStart = value === 0xF0;
    let sysexEndPos = data[0] === 0xF7 ? 0 : data[1] === 0xF7 ? 1 : data[2] === 0xF7 ? 2 : -1;
    let sysexEnd = sysexEndPos >= 0;

    if (sysexStart) {
        sysexBuffer = [];
        sysexBuffer.push(...data);
        return;
    }
    if (sysexBuffer.length && !sysexEnd) {
        /* Safety: limit sysex buffer size to prevent unbounded growth from malformed sysex */
        if (sysexBuffer.length > 4096) {
            sysexBuffer = [];
            return;
        }
        sysexBuffer.push(...data);
        return;
    }
    if (sysexEnd) {
        /* Only push bytes up to and including F7, skip padding zeros */
        for (let i = 0; i <= sysexEndPos; i++) {
            sysexBuffer.push(data[i]);
        }
        if (isMidiCiDiscovery(sysexBuffer)) {
            /* A real Launchpad Pro MK3 has no MIDI-CI at all: it hears
             * Discovery and says nothing. We used to answer with a
             * proper Discovery Reply, which is correct MIDI-CI and
             * still left the iPadOS M8 app sending no LEDs - so the
             * reply is gone, on the theory that looking like the
             * hardware matters more than being protocol-complete, and
             * that answering may put CoreMIDI or the app into a
             * negotiation a real Launchpad never enters.
             *
             * The introduction still goes out, because that is the
             * message the app demonstrably reads - each one made it
             * print "Launchpad Connected". Marking connected is what
             * damps the retry, so it stays too: without it we would
             * introduce ourselves on a loop and spam that banner. */
            sendLPPIdentity();
            markM8Connected();
        } else if (isDeviceInquiry(sysexBuffer)) {
            /* Answered EVERY time it is asked, not just the first. A
             * host that asks again - after its own restart, or because
             * the first answer arrived before it was listening - is
             * asking because it does not know yet. */
            initLPP();
        } else if (sysexBuffer.length) {
            markM8Connected();
        }
        sysexBuffer = [];
        return;
    }

    if (!(noteOn || noteOff)) {
        markM8Connected();
        return;
    }

    /* If we receive LED data (note messages), M8 is connected.
     * This handles the case where M8 skips the identity request
     * because it already received our proactive identity response. */
    markM8Connected();

    lppNoteValueMap.set(data[1], [...data]);
    ledsSeenSinceConnect++;
    traceLed(data[1], data[2], noteOn, value);
    applyLppLed(data[1], data[2], maskedValue, value);
};

/* Paint one LPP LED onto the Move.
 *
 * Split out of the external handler so that REPLAYING a remembered LED -
 * which is what a view change does, through drainPadRedraw - does not have
 * to re-enter that handler. Re-entering it meant the replay ran the SysEx
 * accumulator too, and a synthetic note arriving between an F0 and its F7
 * was appended INTO the part-built message: the buffer no longer matched
 * the identity request, so the handshake went unanswered and the M8 was
 * left waiting. Rare while a redraw only followed a wheel-touch; routine
 * once a screen change could start one, because that is exactly when the
 * M8 is talking most. */
/* SHIFT HAS TO BE LET GO ON THE M8 WHEN A SCREEN TAKES OVER.
 *
 * Shift+Jog-click opens Settings, and the Shift PRESS was forwarded to
 * the M8 a moment before that happened. The screen then swallows every
 * button, the matching RELEASE among them, so the M8 is left holding a
 * key nobody is pressing: everything after that reads as Shift+whatever
 * until Shift is tapped again. The same is true of every screen that
 * owns the surface, not just Settings.
 *
 * So the M8 is told Shift is up as a screen takes over, and told it is
 * down again on the way back out if it really is still held. Driven
 * from the tick by comparing against the last frame rather than hooked
 * into each open/close, so a screen added later cannot forget it. */
function screenOwnsSurface() {
    return songMgmtOpen || settingsOpen || mainKnobOpen || knobEditOpen || knobWizardOpen;
}

let surfaceOwnedLastTick = false;

function sendShiftToM8(down) {
    /* Shift is LPP 90 in every view, but ask the map rather than
     * writing the number down twice. */
    const lppNote = controlMapMoveToLpp().get(moveSHIFT);
    if (lppNote === undefined) return;
    if (down) move_midi_external_send([2 << 4 | 0x9, 0x90, lppNote, 100]);
    else move_midi_external_send([2 << 4 | 0x8, 0x80, lppNote, 0]);
}

function tickShiftHandover() {
    const owned = screenOwnsSurface();
    if (owned === surfaceOwnedLastTick) return;
    surfaceOwnedLastTick = owned;
    if (shiftHeld) sendShiftToM8(!owned);
}

/* WHAT ACTUALLY BORROWS THE PADS.
 *
 * Every menu screen used to count: Song Management, Knob Settings and
 * the wizard all suppressed the LED relay while open. But none of them
 * draws on the pads - only the KEYBOARD does, and it is the reason the
 * others were ever listed. The cost of counting them all was that the
 * grid stayed away from the moment a menu opened until the last one
 * closed, so leaving the keyboard left Move's own pad colours showing
 * underneath rather than the M8's.
 *
 * So the relay stands aside for the keyboard alone. Menus keep the M8's
 * grid lit and live underneath them, and closing the keyboard puts it
 * straight back. */
function padsAreBorrowed() {
    return isTextEntryActive();
}

function applyLppLed(lppNoteNumber, lppVelocity, maskedValue, value) {
    /* M8's updates are tracked above whether or not they are painted,
     * so the resync on hand-back has something to replay. */
    if (padsAreBorrowed()) return;

    let activeLppToMovePadMap = padMapLppToMove();
    let moveNoteNumber = activeLppToMovePadMap.get(lppNoteNumber);
    let moveVelocity = lppColorToMoveColorMap.get(lppVelocity) ?? lppVelocity;

    if (moveNoteNumber) {
        const anim = LPP_PAD_ANIMATED[value];
        if (anim) {
            /* Both ends come from the one colour, so the pad flashes in
             * its own hue rather than alternating with whatever the
             * chain underneath happened to be.
             *
             * A REPEAT of the same request must not restart anything.
             * M8 re-sends its overlays on every grid refresh, and
             * during playback that is far more often than the flip
             * period - so resetting the phase here held the pad on one
             * colour and it never appeared to flash at all. The phase
             * is global and free-running; a pad only paints itself
             * immediately the first time, so the flash starts without
             * waiting a full period. */
            padStopPending.delete(moveNoteNumber);
            const already = animatedPads.has(moveNoteNumber);
            animatedPads.set(moveNoteNumber, [pulsePartnerOf(moveVelocity), moveVelocity]);
            if (!already) {
                move_midi_internal_send([0x09, 0x90, moveNoteNumber, moveVelocity]);
            }
            return;
        }
        /* A plain colour ends the flash - but NOT immediately. M8
         * repaints the whole grid and then re-sends its overlays, so a
         * flashing pad receives a static write on every refresh and
         * acting on it at once would cancel the flash a moment before
         * it is asked for again. Painting it would also show the chain
         * colour for a frame, which is the flicker this is all about.
         *
         * So the stop is remembered and applied on the next tick, by
         * which time the re-arm has either arrived or it has not. */
        if (animatedPads.has(moveNoteNumber)) {
            padStopPending.set(moveNoteNumber, moveVelocity);
            return;
        }
        move_midi_internal_send([(maskedValue / 16), maskedValue, moveNoteNumber, moveVelocity]);
        return;
    }

    let activeLppToMoveControlMap = controlMapLppToMove();
    let moveControlNumber = activeLppToMoveControlMap.get(lppNoteNumber);

    if (moveControlNumber === moveLOGO) {
        /* CC 31 is a WHITE led - it reads the byte as a BRIGHTNESS, not
         * as a palette index - so the M8's colour is translated to lit
         * or not rather than passed through. Passed through it landed on
         * whatever brightness the palette number happened to be, which
         * for the logo's colour is a long way short of on.
         *
         * The same trap as the lamps under the steps, and for the same
         * reason ledFor() cannot be asked: it decides RGB-or-white by
         * looking the control up in MoveRGBLeds, and 31 is in there as
         * the step NOTE. Notes and CCs are separate address spaces, and
         * this 31 is the CC. */
        moveVelocity = lppVelocity > 0 ? WHITE_BRIGHT : 0x00;
        liveMode = moveVelocity === WHITE_BRIGHT;
        updatePLAYLed();
    }

    if (moveControlNumber === movePLAY) {
        isPlaying = moveVelocity === green;
        updatePLAYLed();
        return;
    }

    if (moveControlNumber === moveLOOP || moveControlNumber === moveMUTE || moveControlNumber === moveUNDO) {
        moveVelocity = lppColorToMoveMonoMap.get(lppVelocity) ?? lppVelocity;
    }

    if (moveControlNumber) {
        move_midi_internal_send([0x0b, 0xB0, moveControlNumber, moveVelocity]);
        if (value === 0x91) {
            move_midi_internal_send([0x0b, 0xbe, moveControlNumber, black]);
        }
    }
}

/* Internal MIDI handler (from Move) */
/* A PRESS TAKEN BY A SCREEN MUST NOT LEAVE ITS RELEASE BEHIND.
 *
 * A screen closes on the press, so by the time the release arrives there
 * is nothing open to claim it - it falls through to the ordinary
 * handling and reaches the M8 as a button-up for a button-down the M8
 * never saw. Back does this every time, because closing is what Back is
 * for.
 *
 * So a consumed press is remembered and the matching release swallowed
 * once. A screen that is still up claims its own release and clears the
 * note on the way past, which keeps the two in step. */
const swallowedPresses = new Set();

function notePressConsumed(control, pressed) {
    if (pressed) swallowedPresses.add(control);
    else swallowedPresses.delete(control);
}

function swallowConsumedRelease(data) {
    if (data[0] !== 0xb0 || data[2] === 127) return false;
    return swallowedPresses.delete(data[1]);
}

/* Shut whichever menu is up, without going "back" - a shortcut switches
 * screens rather than stepping out of one. */
function closeAllMenus() {
    if (songMgmtOpen) closeSongManagement();
    if (mainKnobOpen) closeMainKnob();
    if (settingsOpen) closeSettings();
    if (knobWizardOpen) closeKnobWizard();
    if (knobEditOpen) closeKnobEdit();
    if (knobSelectOpen) closeKnobSelect();
}

/* THE TWO MENU SHORTCUTS WORK FROM ANYWHERE, each other included.
 *
 * Shift+step 1 is Songs and Shift+step 2 is Settings, wherever you are -
 * so the pair are two doors into one place rather than a place with a
 * door in it, and you can cross straight from one to the other without
 * backing out first.
 *
 * Checked BEFORE the screens are routed to, because every one of them
 * would otherwise swallow it: a menu takes the whole surface while it is
 * up and ignores notes entirely, so the press would simply vanish.
 *
 * Not while the pad keyboard is up. There the pads are letters, and
 * taking one would type nothing and jump screens instead. */
function handleMenuShortcut(data) {
    if (data[0] !== 0x90 || data[2] !== 127) return false;
    if (!shiftHeld || isTextEntryActive()) return false;

    if (data[1] === SONGS_STEP_NOTE) {
        if (!songMgmtOpen) { closeAllMenus(); openSongManagement(); }
        return true;
    }
    if (data[1] === SETTINGS_STEP_NOTE) {
        if (!settingsOpen) { closeAllMenus(); openSettings(); }
        return true;
    }
    return false;
}

globalThis.onMidiMessageInternal = function (data) {
    traceStrangeInternal(data);
    if (handleMenuShortcut(data)) return;
    /* Songs and Settings take the wheel, Back and their own Shift
     * gestures, and let everything else fall through to the ordinary
     * handling below - so the pads, the transport and the mode buttons
     * keep working while a menu is on screen. */
    if (songMgmtOpen && handleSongMgmtInput(data)) return;
    if (mainKnobOpen) {
        handleMainKnobInput(data);
        return;
    }
    if (settingsOpen && handleSettingsInput(data)) return;
    if (swallowConsumedRelease(data)) return;
    if (knobSelectOpen && handleKnobSelectInput(data)) return;
    if (knobEditOpen) {
        handleKnobEditInput(data);
        return;
    }
    if (knobWizardOpen) {
        handleKnobWizardInput(data);
        return;
    }

    const isNote = data[0] === 0x80 || data[0] === 0x90;
    const isCC = data[0] === 0xb0;
    const isAt = data[0] === 0xa0;

    if (isAt) return; /* Ignore aftertouch */

    let activeMoveToLppPadMap = padMapMoveToLpp();

    if (isNote) {
        let moveNoteNumber = data[1];

        /* Wheel touch holds the AUDITION and nothing else now - which
         * half of the grid is showing moved to the mode buttons. */
        /* The wheel holds nothing now: the audition is Shift and the
         * grid halves are the mode buttons. */
        if (moveNoteNumber === moveWHEELTouch) return;

        /* The PRESS was taken by handleMenuShortcut above; the release
         * has to go too, or the M8 hears a note-off for a T1 press it
         * never got. Note 16 is the Launchpad's T1, so left alone it
         * would be forwarded as a track button. */
        if (moveNoteNumber === SONGS_STEP_NOTE && shiftHeld) return;

        let lppNote = activeMoveToLppPadMap.get(moveNoteNumber);

        if (!lppNote) {
            /* The odd step notes are the song preset buttons - see
             * SONG_STEP_NOTES. They are not part of the LPP grid (only the
             * even steps, 16-30, are), so M8 never sees them. */
            const presetIndex = SONG_STEP_NOTES.indexOf(moveNoteNumber);
            if (presetIndex >= 0) {
                /* Step 2's SHIFTED press was taken by
                 * handleMenuShortcut; what is left here is the plain
                 * one, which still picks a song. The M8 sees neither. */
                if (data[2] === 127 && !(moveNoteNumber === SETTINGS_STEP_NOTE && shiftHeld)) {
                    selectSongByStep(presetIndex);
                }
                return;
            }

            /* Touching a song knob (notes 0-7; note 8 is the master
             * knob, which has no name or CC of its own) claims it for
             * the value readout until release. Shift+touch used to open
             * Knob Settings; that is the jogwheel's job now, which is
             * what freed Shift for the audition. */
            if (moveNoteNumber >= 0 && moveNoteNumber <= 7) {
                if (data[2] === 127) {
                    claimKnobTouch(moveNoteNumber);
                } else {
                    releaseKnobTouch(moveNoteNumber);
                }
            } else if (moveNoteNumber === moveMASTERTouch) {
                /* Note 8, the master knob. It has no cell to invert, so
                 * touching it raises the overlay panel instead. */
                masterTouched = data[2] === 127;
            }
            return;
        }

        let moveVelocity = data[2] * 4;
        if (moveVelocity > 127) moveVelocity = 127;

        move_midi_external_send([2 << 4 | (data[0] / 0xF), data[0], lppNote, moveVelocity]);
        return;
    }

    if (isCC) {
        let moveControlNumber = data[1];
        let activeMoveControlToLppNoteMap = controlMapMoveToLpp();
        let lppNote = activeMoveControlToLppNoteMap.get(moveControlNumber);

        /* Store current view */
        if (moveControlNumber === moveBACK || moveControlNumber === moveMENU || moveControlNumber === moveCAP) {
            currentView = moveControlNumber;
            /* Latched on the PRESS only. Shift is usually let go before
             * the button it modified, so a release would report a plain
             * Back and turn the second Session screen back into the
             * first one without the M8 having moved. */
            if (data[2] === 127) {
                /* PRESSING THE MODE YOU ARE ALREADY IN SWITCHES HALVES.
                 *
                 * Back does it for Session - and for Beat Repeat, which
                 * is a session screen and shares the button - Menu for
                 * Note, Capture for Sequencer. Pressing a DIFFERENT
                 * mode button changes mode instead and leaves the half
                 * where it was, so each screen keeps the half you last
                 * looked at.
                 *
                 * Tested BEFORE lpMode is updated, or every press would
                 * look like the mode it just set. The button is still
                 * forwarded to the M8 either way: what it means over
                 * there is the M8's business, and pressing Session
                 * while on Session is a no-op to it. */
                const target = moveControlNumber === moveBACK
                    ? (shiftHeld ? LP_SESSION_ALT : LP_SESSION)
                    : moveControlNumber === moveMENU ? LP_NOTE : LP_SEQ;
                /* A press that does not CHANGE the screen switches the
                 * half instead. Comparing the screen the press selects
                 * against the current one is what keeps Shift+Back out
                 * of it: that is a move to Beat Repeat, not a second
                 * press of the screen you are on, even though it shares
                 * the button with Session. */
                if (target === lpMode) advanceViewMode();
                else switchLpMode(target);
                /* Odd rows belongs to the primary Session screen, so a
                 * half remembered there is not necessarily legal here -
                 * and the setting may have been turned off in between. */
                reconcileOddRowsView();
                traceScreen(moveControlNumber === moveBACK
                    ? (shiftHeld ? "Session 2 (Shift+Back)" : "Session (Back)")
                    : moveControlNumber === moveMENU ? "Note (Menu)" : "Sequencer (Capture)");
            }
            updateMoveViewPulse();
        }

        /* Rec toggles session-EDIT, which is where the blinking blue
         * cursor lives. It is not a screen as far as odd rows is
         * concerned - it is still session - so it does not touch
         * lpMode, but it is very much a different screen to look at,
         * and the first trace of this missed it entirely for that
         * reason. */
        if (moveControlNumber === moveREC && data[2] === 127) {
            traceScreen("Session EDIT (Rec)");
        }

        /* Note: Shift+Wheel exit is handled at host level */

        /* Wheel click raises the knob cursor. The two menus moved off it
         * onto the step row - Shift+step 1 for Songs, Shift+step 2 for
         * Settings - so a shifted click is simply not a gesture any
         * more, and is swallowed rather than falling through to the
         * cursor: Shift+click reading as a plain click is the kind of
         * thing that opens a screen you did not ask for. */
        if (moveControlNumber === moveWHEEL && data[2] === 0x7f) {
            if (!shiftHeld) openKnobSelect();
            return;
        }

        /* Jog turn scrolls through the active song's pages. MoveMainKnob
         * (CC14) was completely unclaimed before this - see
         * the song-based knob design. One page per
         * detent regardless of turn speed (page counts are small, a
         * proportional jump would overshoot), clamped rather than wrapping.
         *
         * Pages are no longer added or removed by hand: they follow the
         * knobs. Adding a knob with every slot full appends a page
         * (nextFreeKnobRun), and removing the last knob from a trailing
         * page drops it again (removeKnobAt), so Shift has no separate
         * meaning here and a shifted turn just pages like an unshifted
         * one. */
        if (moveControlNumber === moveJogTurn) {
            const delta = decodeDelta(data[2]);
            if (delta !== 0) {
                const song = getActiveSong();
                if (song && song.pages.length > 1) {
                    activePageIndex = Math.max(0, Math.min(
                        song.pages.length - 1, activePageIndex + Math.sign(delta)));
                }
            }
            return;
        }

        if (!lppNote) {
            /* Knobs 1-8 (CC71-78) edit the active song page. CC79 (master) is
             * a simple song-independent pass-through - it's excluded from
             * the "8 knobs" concept everywhere (page_input.mjs's own
             * KNOB_CC_FIRST..LAST is 71-78), and the master-volume
             * suppression in init() already commits to it not being real
             * volume, so forwarding it as-is to M8 keeps the physical knob
             * doing something useful without inventing a dedicated feature
             * for it. */
            if (moveControlNumber >= 71 && moveControlNumber <= 78) {
                handleSongKnobTurn(data);
            } else if (moveControlNumber === 79) {
                handleMasterKnobTurn(data);
            }
            return;
        }

        let pressed = data[2] === 127;

        if (pressed) {
            if (moveControlNumber === moveSHIFT) {
                setShiftHeld(true);
            }
            /* THE ODD VIEW SCROLLS TWO ROWS AT A TIME - BUT ONLY THE
             * PLAIN ARROW.
             *
             * It shows M8 rows 0, 2, 4, 6 - every other one - so a
             * one-row scroll swaps which rows are on screen and the
             * whole grid changes under your hand. Two puts the NEXT
             * four even rows up, which is what the view is for. Sent
             * as a complete extra press before the real one, so the
             * release that follows completes the second of two rather
             * than leaving a key down.
             *
             * Shift+arrow is already a PAGE - eight M8 rows - and eight
             * rows is exactly what this view spans, so it lands on the
             * next screenful on its own. Doubling that moved sixteen
             * and skipped a whole screen. */
            if (viewMode === VIEW_ODD && !shiftHeld
                && (moveControlNumber === MoveUp || moveControlNumber === MoveDown)) {
                pressOnM8(lppNote);
            }
            move_midi_external_send([2 << 4 | 0x9, 0x90, lppNote, 100]);
        } else {
            if (moveControlNumber === moveSHIFT) {
                setShiftHeld(false);
                /* Letting go is what puts an auditioned knob back. */
                revertAuditionedKnobs();
            }
            move_midi_external_send([2 << 4 | 0x8, 0x80, lppNote, 0]);
        }
    }
};

globalThis.init = function () {
    console.log("M8 LPP Emulator module starting...");

    /* The master/volume knob is remapped to the "Main" slot of knob bank 8
     * (see the knob bank management section above) rather than left as real
     * volume. Without this,
     * Move processes CC 79 / master-touch note 8 in parallel - changing the
     * actual output volume and popping up Move's own volume OLED overlay -
     * while the module is showing that same knob turn as an M8 parameter.
     * No matching call on exit: the host clears this automatically on any
     * overtake-mode change, and this module has no exit path of its own
     * (Shift + volume-touch + jogwheel-touch is handled entirely at
     * the host level). */
    if (typeof shadow_set_overtake_suppress_master_volume === 'function') {
        shadow_set_overtake_suppress_master_volume(1);
    }

    /* Armed here, but the first screen is logged from markM8Connected:
     * the settings are not read until then, and there is no screen to
     * describe until the M8 is talking. */
    /* `!= null`, not a truthiness test: the natural way to create a flag
     * file is `touch`, which leaves it EMPTY, and loadFile returns "" for
     * that - so the obvious gesture armed nothing. It read as "the
     * feature does not work" rather than as "the flag did not take",
     * which cost a diagnostic round trip. */
    traceOn = std.loadFile(tracePath("trace_on")) != null;

    /* What the grid looked like when we left, which is what goes back
     * on the surface - the M8 is not asked for anything. */
    ledsRestored = loadSurfaceSnapshot();
    padReassert = PAD_REASSERT_TICKS;
    songStepLedReassert = SONG_STEP_LED_REASSERT_TICKS;

    /* DO NOT INTRODUCE OURSELVES IF WE ALREADY KNOW THE M8.
     *
     * The introduction is not free: hearing it, the M8 initialises the
     * control surface from scratch, which lands it on its own default
     * screen - Session - and repaints. That is exactly what re-picking
     * CTRL SURFACE does, and it is the reason that trick fixes a dead
     * grid. It used to be invisible here, because a fresh module also
     * started on Session and the two agreed. Now that the screen is
     * restored, introducing ourselves drags the M8 back to Session a
     * moment after we arrive and throws the restore away - on the M8's
     * own display as well as ours.
     *
     * So when a snapshot gave us a screen, we take the M8 as still
     * connected - it was when we saved, and it has not been told
     * anything since - and say nothing. A genuinely restarted M8
     * broadcasts its own Device Inquiry, which we still answer, so the
     * case this introduction was written for is covered anyway.
     *
     * With no snapshot we introduce ourselves as before: this handles
     * the M8 having asked before the module was loaded. */
    if (surfaceRestored) {
        /* Restored into MEMORY, not onto the surface. Nothing is painted
         * and nothing is claimed: a file cannot tell us the M8 is
         * plugged in, and saying it is on the strength of one is how a
         * grid of old LEDs came to sit there looking live with nothing
         * connected. The pads stay dark and the screen says "Waiting for
         * M8" until the M8 itself says something, at which point
         * markM8Connected puts the remembered grid up. */
        awaitingM8WithSnapshot = true;
    } else {
        sendLPPIdentity();
    }
};

/* Called once on teardown, regardless of which mechanism triggered it (the
 * host-level Shift + volume + jogwheel escape included). Forces an
 * immediate save
 * if a knob edit is still waiting on the autosave throttle - otherwise up to
 * SONGS_AUTOSAVE_INTERVAL_MS of edits could be lost on exit. */
globalThis.onUnload = function () {
    if (songsDirty) {
        saveSongs();
        songsDirty = false;
    }
    /* So the way back in has a grid and a screen to restore - see
     * loadSurfaceSnapshot. */
    saveSurfaceSnapshot();
};

globalThis.tick = function () {
    traceTick();
    /* Proactively send LPP identity until M8 connects.
     * This handles the case where M8 sent its identity request before
     * the module loaded (e.g., when entering overtake mode after M8 is
     * already connected). */
    /* ONE INTRODUCTION PER ASKING.
     *
     * This retried once a second until an LED arrived, on the theory
     * that an app switched into Launchpad mode late would otherwise
     * never hear an identity. The iOS app answers each identity with
     * "Launchpad Connected" on its own screen, so a retry a second
     * turned into that banner a second - it was re-accepting the device
     * over and over, and whatever it does after accepting never got a
     * chance to finish. So the introduction goes out when we are asked
     * and while nobody has answered at all, and not otherwise. */
    /* Not while a restored screen is waiting to be confirmed: the
     * introduction is what makes the M8 re-initialise its surface and
     * land on Session, which would throw away the very screen we are
     * holding. An M8 that is actually there will say something the
     * moment anything is pressed, and that is what confirms it. */
    if (!m8Connected && !awaitingM8WithSnapshot) {
        initRetryTicks++;
        if (initRetryTicks >= INIT_RETRY_INTERVAL) {
            initRetryTicks = 0;
            sendLPPIdentity();
        }
    }
    tickTextEntryHandback();
    /* Driven from the tick rather than from each of the half-dozen
     * places that could change the answer - the cursor opening, moving,
     * landing on an empty slot, a copy, a delete, a page change. It
     * compares against what is already lit and returns without sending
     * anything when nothing has changed, so the cost of asking every
     * frame is a comparison. */
    updateKnobCursorHints();
    tickShiftHandover();
    tickModuleConfig();
    tickPadReassert();
    tickPadAnimation();
    drainPadRedraw();
    tickSongStepLeds();
    updateKnobLeds(false);
    drawUI();
    flushSongsIfDirty();
};
