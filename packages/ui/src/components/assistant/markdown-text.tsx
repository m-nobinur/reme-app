import "@assistant-ui/react-markdown/styles/dot.css"

import type { TextMessagePartProps } from "@assistant-ui/react"
import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import { TooltipIconButton } from "@workspace/ui/components/assistant/tooltip-icon-button"
import { useCopyToClipboard } from "@workspace/ui/hooks/use-copy-to-clipboard"
import { cn } from "@workspace/ui/lib/utils"
import { type FC, memo, useMemo, useRef } from "react"
import remarkGfm from "remark-gfm"

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0]
}

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T
): T => {
  const ref = useRef(value)
  if (value !== ref.current) {
    const prev = ref.current
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key])
    if (!stable) ref.current = value
  }
  return ref.current
}

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ components }) => {
  const stableComponents = useShallowStable(components)
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    }
  }, [stableComponents])

  // No images, by any syntax. The text is a model's, and an injected prompt
  // can make it write an image whose URL carries workspace data, which the
  // browser fetches on render. Dropped from the tree, so no `components`
  // override can bring one back. Raw HTML already renders as text, and the
  // default `urlTransform` already blanks `javascript:` and `data:` links.
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeExternalLinks]}
      className="aui-md"
      components={markdownComponents}
      disallowedElements={["img"]}
      defer
    />
  )
}

/** The part of a hast node this file reads and writes. */
type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** A link's text as a reader sees it: images are dropped, so they add none. */
const linkText = (node: HastNode): string =>
  node.type === "text"
    ? (node.value ?? "")
    : node.tagName === "img"
      ? ""
      : (node.children ?? []).map(linkText).join("")

/** Controls that reorder text on screen, so a link's text can't use them. */
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

const stripBidi = (node: HastNode) => {
  if (node.type === "text") node.value = (node.value ?? "").replace(BIDI, "")
  for (const child of node.children ?? []) stripBidi(child)
}

/**
 * Where a link goes when the browser resolves it from an https page, or
 * null when that is this app: `//host` and `http:host` leave it too.
 */
function outside(href: string): URL | null {
  try {
    const url = new URL(href, "https://base.invalid/")
    return /^https?:$/.test(url.protocol) && url.hostname !== "base.invalid"
      ? url
      : null
  } catch {
    return null
  }
}

/**
 * The text already says where the link goes: plain ASCII equal to the host
 * or to the href as written. Never for a host with a punycode label, which
 * can look like another, or for an href with userinfo, which reads as a
 * host it is not.
 */
const saysWhere = (text: string, href: string, url: URL) =>
  /^[\x21-\x7e]+$/.test(text) &&
  (text === url.hostname || text === href.toLowerCase()) &&
  !url.username &&
  !url.password &&
  !url.hostname.split(".").some((label) => label.startsWith("xn--"))

const host = (url: URL): HastNode => ({
  type: "element",
  tagName: "bdi",
  properties: { dir: "ltr" },
  children: [{ type: "text", value: url.hostname }],
})

/**
 * Every link that leaves the app opens in a new tab with no opener or
 * referrer, and tells a screen reader so. Link text is the model's, so
 * "Open your new site" could point anywhere: the host follows the text in
 * a muted span that markdown cannot write, isolated so the text's
 * direction cannot reverse it, unless the text already says where it goes.
 * The text loses any bidi controls. A link whose only content was an image
 * is named by its host. Footnotes, mailto and the blank href a blocked
 * scheme leaves stay as they are. Written into the tree rather than the
 * `a` component, so a caller's `a` still gets it.
 */
function rehypeExternalLinks() {
  const visit = (node: HastNode) => {
    for (const child of node.children ?? []) visit(child)
    const href = String(node.properties?.href ?? "")
    const url = node.tagName === "a" ? outside(href) : null
    if (!url) return
    stripBidi(node)
    const text = linkText(node).trim().toLowerCase()
    node.properties = {
      ...node.properties,
      target: "_blank",
      rel: ["noopener", "noreferrer"],
    }
    node.children = !text
      ? [host(url)]
      : saysWhere(text, href, url)
        ? (node.children ?? [])
        : [
            ...(node.children ?? []),
            {
              type: "element",
              tagName: "span",
              properties: {
                className: [
                  "aui-md-a-host",
                  "inline-block",
                  "text-muted-foreground",
                ],
              },
              children: [
                { type: "text", value: "\u00a0(" },
                host(url),
                { type: "text", value: ")" },
              ],
            },
          ]
    node.children.push({
      type: "element",
      tagName: "span",
      properties: { className: ["sr-only"] },
      children: [{ type: "text", value: " (opens in a new tab)" }],
    })
  }
  return visit
}

export const MarkdownText = memo(MarkdownTextImpl)

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const onCopy = () => {
    if (!code || isCopied) return
    copyToClipboard(code)
  }

  return (
    <div className="aui-code-header-root mt-4 flex items-center justify-between rounded-t-2xl border border-border border-b-0 bg-muted/50 px-3.5 py-1.5 text-xs">
      <span className="aui-code-header-language font-medium text-muted-foreground lowercase">
        {language}
      </span>
      <TooltipIconButton tooltip="Copy" onClick={onCopy}>
        {!isCopied && <CopyIcon />}
        {isCopied && (
          <CheckIcon className="zoom-in-50 fade-in animate-in duration-200 ease-out motion-reduce:animate-none" />
        )}
      </TooltipIconButton>
    </div>
  )
}

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mt-7 mb-3 scroll-m-20 font-semibold text-[1.375em] leading-snug tracking-tight first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-6 mb-2.5 scroll-m-20 font-semibold text-[1.1875em] leading-snug first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-5 mb-2 scroll-m-20 font-semibold text-[1.0625em] leading-snug first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-4 mb-1.5 scroll-m-20 font-semibold first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-4 mb-1 font-semibold text-[0.9375em] first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-4 mb-1 font-medium text-[0.9375em] text-muted-foreground first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn("aui-md-p my-4 first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a text-primary underline underline-offset-2 hover:text-primary/80",
        className
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote my-4 border-muted-foreground/30 border-s-2 ps-4 text-muted-foreground",
        className
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul my-4 ms-6 list-disc marker:text-muted-foreground [&>li]:mt-1.5",
        className
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol my-4 ms-6 list-decimal marker:text-muted-foreground [&>li]:mt-1.5",
        className
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr my-6 border-muted-foreground/20", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <div
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region has to take focus to be scrolled from the keyboard.
      tabIndex={0}
      className="aui-md-table-scroll my-4 overflow-x-auto rounded-sm text-[0.9375em] outline-none focus-visible:ring-3 focus-visible:ring-ring"
    >
      <table
        className={cn(
          "aui-md-table w-full border-separate border-spacing-0",
          className
        )}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-2xl last:rounded-se-2xl [[align=center]]:text-center [[align=right]]:text-right",
        className
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-muted-foreground/20 border-s border-b px-3 py-1.5 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-2xl [&:last-child>td:last-child]:rounded-ee-2xl",
        className
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li ps-1", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("aui-md-strong font-semibold", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre overflow-x-auto rounded-t-none rounded-b-2xl border border-border border-t-0 bg-muted/30 p-4 text-[0.8125em] leading-relaxed",
        className
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock()
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code rounded-lg bg-muted px-1.5 py-0.5 font-mono text-[0.85em]",
          className
        )}
        {...props}
      />
    )
  },
  CodeHeader,
})
