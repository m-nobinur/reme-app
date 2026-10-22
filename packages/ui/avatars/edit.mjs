/**
 * Draws a portrait's blink and smile as edits of the portrait itself, so
 * `compose.py` can cut out only the eyes and the mouth. See `draw.mjs`.
 */
import { readFileSync, writeFileSync } from "node:fs"

const [, , varsPath, dir, names, kinds = "blink,smile"] = process.argv
const key = readFileSync(varsPath, "utf8")
  .match(/^OPENROUTER_API_KEY=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
const KEEP =
  "Keep everything else pixel-identical to the input: same pose, head position and size, framing, hair, glasses, clothes, colours, lighting and transparent background. Do not move, rescale or re-crop anything."
const EDITS = {
  blink: `Edit this image. Change only the eyes: both eyes fully closed in a natural relaxed blink, the eyelids smooth clay in the same skin tone with the lashes curving down. ${KEEP}`,
  smile: `Edit this image. Change only the mouth: a slightly wider, warmer closed-mouth smile, the cheeks lifting a touch. Eyes stay open exactly as they are. ${KEEP}`,
}
const jobs = names
  .split(",")
  .flatMap((n) => kinds.split(",").map((k) => [n, k]))
await Promise.all(
  jobs.map(async ([name, kind]) => {
    const b64 = readFileSync(`${dir}/${name}.png`).toString("base64")
    const r = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-image-2.5-flare",
        prompt: EDITS[kind],
        size: "1024x1024",
        background: "transparent",
        output_format: "png",
        input_references: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${b64}` },
          },
        ],
      }),
    })
    if (!r.ok)
      return console.log(name, kind, r.status, (await r.text()).slice(0, 300))
    const body = await r.json()
    const img = body.data?.find((d) => d.b64_json)
    if (!img) return console.log(name, kind, "no image")
    writeFileSync(
      `${dir}/${name}-${kind}.png`,
      Buffer.from(img.b64_json, "base64")
    )
    console.log(name, kind, body.usage?.cost ?? "")
  })
)
