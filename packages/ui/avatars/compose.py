"""Cut an avatar's portrait and two edits into the layers the app stacks.

The blink and smile edits are cut down to the area that changed, feathered,
and saved as patches on a clear canvas the portrait's size, so the page lays
them over the portrait and fades each in on its own clock. Writes
{name}.webp (the portrait), {name}-blink.webp and {name}-smile.webp.

`strict` raises the threshold for an edit that shifted the whole face's
colour a touch, which would otherwise take all of it: they_2 took 2.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

W = 512          # working size
OUT = 256        # shipped size


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


def save(pixels, path):
    im = Image.fromarray(np.uint8(np.clip(pixels, 0, 1) * 255), "RGBA")
    im.resize((OUT, OUT), Image.LANCZOS).save(path, quality=82, method=6)


def main(name, strict=1.0):
    base = load(f"{name}.png")
    for kind, box, threshold in (
        ("blink", (0.22, 0.15, 0.78, 0.6), 0.12),
        ("smile", (0.28, 0.3, 0.72, 0.7), 0.1),
    ):
        edit = load(f"{name}-{kind}.png")
        mask = patch_mask(base, edit, box, threshold * strict)
        patch = arr(edit)
        # The edit's own alpha is noise off the face; the mask is the patch.
        patch[..., 3] = mask[..., 0] * arr(base)[..., 3]
        save(patch, f"{name}-{kind}.webp")
    save(arr(base), f"{name}.webp")


if __name__ == "__main__":
    main(sys.argv[1], *(float(v) for v in sys.argv[2:]))
