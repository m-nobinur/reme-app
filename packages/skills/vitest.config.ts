import { defineConfig } from "vitest/config"
import { markdownAsText } from "./markdown-as-text.ts"

export default defineConfig({ plugins: [markdownAsText] })
