"""Builds the notification cues in public/sounds/ (16-bit mono WAV, 22.05 kHz).

Run: python tools/make-sounds.py. The sounds are generated here from sine partials, so they carry
no third-party licence (see public/sounds/LICENSE.txt).
"""
import math
import os
import struct
import wave

RATE = 22050
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "sounds")


def bell(freq, start, length, gain):
    """A soft bell: a few inharmonic partials, a 6 ms attack and an exponential decay."""
    partials = [(1.0, 1.0), (2.0, 0.28), (2.76, 0.12), (4.07, 0.05)]
    first = int(start * RATE)
    samples = {}
    for i in range(int(length * RATE)):
        t = i / RATE
        attack = min(1.0, t / 0.006)
        value = 0.0
        for ratio, amp in partials:
            value += amp * math.exp(-t * (4.5 + ratio * 2.5)) * math.sin(2 * math.pi * freq * ratio * t)
        samples[first + i] = value * attack * gain
    return samples


def render(name, notes, total):
    mix = [0.0] * int(total * RATE)
    for freq, start, length, gain in notes:
        for i, v in bell(freq, start, length, gain).items():
            if i < len(mix):
                mix[i] += v
    peak = max(abs(v) for v in mix) or 1.0
    fade = int(0.03 * RATE)
    frames = bytearray()
    for i, v in enumerate(mix):
        tail = min(1.0, (len(mix) - i) / fade)
        frames += struct.pack("<h", int(v / peak * 0.8 * tail * 32767))
    with wave.open(os.path.join(OUT, name), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(bytes(frames))


os.makedirs(OUT, exist_ok=True)
# Finished: a rising fifth, settling.
render("thread-finish.wav", [(784.0, 0.0, 0.9, 0.8), (1174.7, 0.12, 0.9, 0.7)], 0.9)
# Needs you: two quick, equal pings, a little brighter, so it reads as a call.
render("thread-ask.wav", [(1046.5, 0.0, 0.5, 0.8), (1046.5, 0.16, 0.7, 0.75), (1568.0, 0.16, 0.7, 0.2)], 0.85)
