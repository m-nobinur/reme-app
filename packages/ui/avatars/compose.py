"""Compose an avatar's idle loop from its portrait and two edits.

The blink and smile edits are cut down to the area that changed and
crossfaded over the portrait. The head's sway is CSS on the page, so frames
differ only where the face moves and the file stays small. Writes
{name}.webp (animated) and {name}-still.webp.

`strict` raises the threshold for an edit that shifted the whole face's
colour a touch, which would otherwise crossfade all of it: they_2 took 2.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

W = 512          # working size
OUT = 256        # shipped size
FPS = 20
LOOP = 8.0       # seconds; every motion's period divides it, so the loop is seamless
N = int(FPS * LOOP)


def load(path):
    return Image.open(path).convert("RGBA").resize((W, W), Image.LANCZOS)


def arr(im):
    return np.asarray(im).astype(np.float32) / 255


def patch_mask(base, edit, box, threshold):
    """Where the edit changed the face, feathered."""
    b, e = arr(base), arr(edit)
    d = np.abs(b[..., :3] - e[..., :3]).sum(2)
    x0, y0, x1, y1 = (int(v * W) for v in box)
    keep = np.zeros_like(d, bool)
    keep[y0:y1, x0:x1] = True
    hit = (d > threshold) & keep & (b[..., 3] > 0.9)
    m = Image.fromarray((hit * 255).astype(np.uint8))
    # Drop specks, then grow and soften what is left.
    m = m.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(17))
    m = m.filter(ImageFilter.GaussianBlur(4))
    return np.asarray(m).astype(np.float32)[..., None] / 255


def blink_level(t):
    """1 is shut. Fast to close, slower to open, at uneven gaps with one double."""
    level = 0.0
    for start in (1.1, 4.3, 4.62, 6.9):
        dt = t - start
        if 0 <= dt < 0.1:
            level = max(level, dt / 0.1)
        elif 0.1 <= dt < 0.15:
            level = 1.0
        elif 0.15 <= dt < 0.3:
            level = max(level, 1 - (dt - 0.15) / 0.15)
    return level


def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def smile_level(t):
    # Five steps each way: frames that repeat merge, which keeps the file small.
    level = smooth((t - 2.2) / 0.6) * (1 - smooth((t - 4.4) / 0.8))
    return round(level * 5) / 5


def main(name, strict=1.0):
    base = load(f"{name}.png")
    blink = load(f"{name}-blink.png")
    smile = load(f"{name}-smile.png")
    mb = patch_mask(base, blink, (0.22, 0.15, 0.78, 0.6), 0.12 * strict)
    ms = patch_mask(base, smile, (0.28, 0.3, 0.72, 0.7), 0.1 * strict)
    b, eb, es = arr(base), arr(blink), arr(smile)
    # The portrait's own alpha everywhere: the edits' backgrounds carry noise.
    eb[..., 3], es[..., 3] = b[..., 3], b[..., 3]

    frames = []
    for i in range(N):
        t = i / FPS
        s, k = smile_level(t), blink_level(t)
        f = b * (1 - ms * s) + es * ms * s
        f = f * (1 - mb * k) + eb * mb * k
        im = Image.fromarray(np.uint8(np.clip(f, 0, 1) * 255), "RGBA")
        frames.append(im.resize((OUT, OUT), Image.LANCZOS))

    frames[0].save(f"{name}-still.webp", quality=82, method=6)
    frames[0].save(
        f"{name}.webp",
        save_all=True,
        append_images=frames[1:],
        duration=int(1000 / FPS),
        loop=0,
        quality=78,
        method=6,
        minimize_size=True,
        allow_mixed=True,
    )


if __name__ == "__main__":
    main(sys.argv[1], *(float(v) for v in sys.argv[2:]))
