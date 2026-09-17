#!/usr/bin/env python3
"""Grab the Move's display from the Schwung web UI's mirror.

The mirror streams the real panel as server-sent events, so a screenshot
of the device is one request away - which beats drawing a mock of a
screen that then has to be kept in step with the code.

    ./scripts/capture-screen.py docs/img/knob-page.png
    MIRROR=http://192.168.1.20:7700 ./scripts/capture-screen.py out.png

Writes a 128x64 PNG - the panel's real size. Scale it in CSS with
`image-rendering: pixelated` rather than here, so the file stays a
couple of hundred bytes and the pixels stay square.
"""
import base64, json, os, re, struct, subprocess, sys, zlib

MIRROR = os.environ.get("MIRROR", "http://move.local:7700")
W, H = 128, 64


def grab():
    """One frame off the SSE stream. curl rather than urllib: the stream
    never ends, so it has to be cut off by timeout."""
    out = subprocess.run(
        ["curl", "-sN", "--max-time", "10", f"{MIRROR}/stream-auto"],
        capture_output=True, timeout=20).stdout.decode("utf-8", "replace")
    frames = re.findall(r"^data: (\{.*\})\s*$", out, re.M)
    if not frames:
        sys.exit(f"no frame from {MIRROR} - is the mirror running?")
    return json.loads(frames[-1])


def pixels(frame):
    raw = base64.b64decode(frame["data"])
    px = [[0] * W for _ in range(H)]
    if frame["format"].startswith("mono"):
        for page in range(H // 8):
            for col in range(W):
                b = raw[page * W + col]
                for bit in range(8):
                    px[page * 8 + bit][col] = 255 if (b >> bit) & 1 else 0
    else:                                   # gray4, two pixels per byte
        for y in range(H):
            for x in range(0, W, 2):
                b = raw[y * (W // 2) + (x >> 1)]
                px[y][x] = ((b >> 4) & 0xF) * 17
                px[y][x + 1] = (b & 0xF) * 17
    return px


def png(px):
    rows = b"".join(b"\x00" + bytes(row) for row in px)
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    frame = grab()
    open(sys.argv[1], "wb").write(png(pixels(frame)))
    print(f"{sys.argv[1]}: {frame['format']} from {MIRROR}")
