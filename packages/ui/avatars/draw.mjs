/**
 * Draws each assistant portrait once through OpenRouter's images endpoint,
 * with the key from the orchestrator's .dev.vars. Then `edit.mjs` draws its
 * blink and smile, and `compose.py` turns the three into the loop the app
 * ships. Run from a scratch folder, then copy each `{id}.webp` and
 * `{id}-still.webp` into `src/assets/avatars/`:
 *
 *   node packages/ui/avatars/draw.mjs apps/orchestrator/.dev.vars . [ids]
 *   node packages/ui/avatars/edit.mjs apps/orchestrator/.dev.vars . ids
 *   python3 packages/ui/avatars/compose.py <id> [strict]
 *
 * gpt-image-2.5-flare, about $0.03 a portrait and $0.03 to $0.06 an edit
 * (2026-10-23). The ids are `AVATARS`' in `@workspace/contracts`.
 */
import { readFileSync, writeFileSync } from "node:fs"

const [, , varsPath, outDir, only] = process.argv
const key = readFileSync(varsPath, "utf8")
  .match(/^OPENROUTER_API_KEY=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
const STYLE =
  "A cute stylised 3D clay character bust, head and shoulders, front facing, centred, smooth satin polymer clay and soft vinyl toy finish, hair sculpted as big smooth glossy chunky strands (not felt, not fuzzy, not individual hairs), smooth rounded shapes, big glossy dark eyes with a small highlight, small friendly smile, soft blush on the cheeks, gentle studio lighting with soft shadows, Pixar-like toy figurine render, warm friendly professional look of a helpful office assistant. Plain solid white background, no text, no watermark, no logo, nothing cut off."
const PEOPLE = {
  she_1:
    "A young woman with long wavy copper-orange hair and round dark-teal glasses, wearing a soft mint sweater under a mustard cardigan.",
  she_2:
    "A woman with deep brown skin and a high curly black afro puff, small gold stud earrings, wearing a coral blouse under a navy blazer.",
  she_3:
    "An East Asian woman with a sleek black bob with straight bangs, wearing a cream turtleneck under a sage-green jacket.",
  he_1: "A young man with tousled chocolate-brown hair swept to the side and thin round brown glasses, wearing a light blue collared shirt under a tan vest.",
  he_2: "A man with warm brown skin, a short neat black beard and a short fade haircut, wearing a white t-shirt under an olive bomber jacket.",
  he_3: "A man with light skin, short blond curly hair and freckles, wearing a burgundy knit jumper over a white collar.",
  they_1:
    "An androgynous young person with a short lilac undercut swept to one side, wearing a charcoal hoodie with a teal collar.",
  they_2:
    "An androgynous person with medium brown skin, chin-length dark curly hair and big round black glasses, wearing a mustard overshirt over a white tee.",
  they_3:
    "An androgynous person with short messy teal-blue hair and a small silver ear cuff, wearing a soft lavender knit sweater.",
}
const names = only ? only.split(",") : Object.keys(PEOPLE)
await Promise.all(
  names.map(async (name) => {
    const t = Date.now()
    const r = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-image-2.5-flare",
        prompt: `${STYLE} ${PEOPLE[name]}`,
        size: "1024x1024",
        background: "transparent",
        output_format: "png",
      }),
    })
    if (!r.ok)
      return console.log(name, r.status, (await r.text()).slice(0, 300))
    const body = await r.json()
    const img = body.data?.find((d) => d.b64_json)
    if (!img)
      return console.log(name, "no image", JSON.stringify(body).slice(0, 300))
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(img.b64_json, "base64"))
    console.log(
      name,
      `${((Date.now() - t) / 1000).toFixed(1)}s`,
      body.usage?.cost ?? ""
    )
  })
)
