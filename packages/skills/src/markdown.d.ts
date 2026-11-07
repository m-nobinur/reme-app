/** A skill file, bundled as its text (wrangler's `Text` rule, `markdownAsText` elsewhere). */
declare module "*.md" {
  const text: string
  export default text
}
