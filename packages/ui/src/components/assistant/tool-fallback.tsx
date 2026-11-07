import {
  type ToolApprovalOption,
  type ToolCallMessagePart,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  useAuiState,
  useScrollLock,
  useToolCallElapsed,
} from "@assistant-ui/react"
import { CaretDownIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { ToolStatus } from "@workspace/ui/components/status-line"
import { repeatsPrevious, stepOf } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { memo, useCallback, useRef, useState } from "react"

// The enter token, in milliseconds for the scroll lock.
const ANIMATION_DURATION = 250

type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
}

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION)

  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll()
      if (!isControlled) {
        setUncontrolledOpen(open)
      }
      controlledOnOpenChange?.(open)
    },
    [lockScroll, isControlled, controlledOnOpenChange]
  )

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full",
        className
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  )
}

const formatToolDuration = (ms: number) => {
  if (ms < 1000) return "<1s"
  const seconds = ms / 1000
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`
  if (seconds < 60) return `${Math.floor(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
}

function ToolFallbackDuration({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const elapsedMs = useToolCallElapsed()
  if (elapsedMs === undefined) return null

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        "aui-tool-fallback-duration text-muted-foreground text-xs tabular-nums",
        className
      )}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  )
}

function ToolFallbackLine({
  toolName,
  status,
  step,
}: {
  toolName: string
  status?: ToolCallMessagePartStatus | undefined
  step?: string | undefined
}) {
  const statusType = status?.type ?? "complete"
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled"

  return (
    <ToolStatus
      announce={false}
      clockAfter={null}
      delay={0}
      tool={toolName}
      args={{ step }}
      state={
        statusType === "running"
          ? "working"
          : statusType === "requires-action"
            ? "waiting"
            : statusType === "incomplete"
              ? isCancelled
                ? "stopped"
                : "failed"
              : "done"
      }
    />
  )
}

function ToolFallbackTrigger({
  toolName,
  status,
  step,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string
  status?: ToolCallMessagePartStatus
  step?: string | undefined
}) {
  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger flex w-fit items-center gap-2 px-1 py-1.5 text-chat-step text-muted-foreground transition-colors hover:text-foreground active:translate-y-px",
        "rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className
      )}
      {...props}
    >
      <ToolFallbackLine toolName={toolName} status={status} step={step} />
      <ToolFallbackDuration />
      <CaretDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-standard motion-reduce:transition-none",
          "-rotate-90",
          "group-data-open/trigger:rotate-0",
          "group-data-panel-open/trigger:rotate-0"
        )}
      />
    </CollapsibleTrigger>
  )
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-standard motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "flex flex-col gap-2 ps-6 pt-1 pb-2 ease-standard motion-reduce:animate-none",
          "group-data-open/collapsible-content:fade-in-0 group-data-open/collapsible-content:slide-in-from-top-1 group-data-open/collapsible-content:animate-in group-data-open/collapsible-content:blur-in-[2px]",
          "group-data-closed/collapsible-content:fade-out-0 group-data-closed/collapsible-content:slide-out-to-top-1 group-data-closed/collapsible-content:animate-out group-data-closed/collapsible-content:blur-out-[2px]",
          "group-data-closed/collapsible-content:animation-duration-(--animation-duration) group-data-open/collapsible-content:animation-duration-(--animation-duration)"
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  )
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  argsText?: string
}) {
  if (!argsText) return null

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args", className)}
      {...props}
    >
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region has to take focus to be scrolled from the keyboard.
        tabIndex={0}
        className="aui-tool-fallback-args-value wrap-anywhere max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl bg-muted/50 p-2.5 text-foreground/90 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {argsText}
      </pre>
    </div>
  )
}

const APPROVED_RESULT = "Approved by user"
const DENIED_RESULT = "User denied tool execution"

const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = {
  "allow-once": "Allow",
  "allow-always": "Always allow",
  "reject-once": "Deny",
  "reject-always": "Always deny",
}

const isKnownKind = (kind: string) =>
  Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, kind)

const isAllowKind = (kind: string) =>
  kind === "allow-once" || kind === "allow-always"

const approvalOptionLabel = (option: ToolApprovalOption) =>
  option.label ??
  (isKnownKind(option.kind)
    ? APPROVAL_OPTION_DEFAULT_LABELS[option.kind]
    : undefined) ??
  option.id

const offersInterruptAction = (
  status: ToolCallMessagePartStatus | undefined,
  approval: ToolCallMessagePart["approval"],
  interrupt: ToolCallMessagePart["interrupt"]
) =>
  status?.type !== "requires-action" ||
  status.reason !== "interrupt" ||
  approval != null ||
  interrupt != null

function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  status,
  ...props
}: React.ComponentProps<"div"> &
  Partial<
    Pick<
      ToolCallMessagePartProps,
      "addResult" | "resume" | "respondToApproval" | "status"
    >
  > & {
    interrupt?: ToolCallMessagePart["interrupt"]
    approval?: ToolCallMessagePart["approval"]
  }) {
  const [submitted, setSubmitted] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  if (
    approval != null &&
    (approval.approved !== undefined || approval.resolution !== undefined)
  )
    return null

  if (!offersInterruptAction(status, approval, interrupt)) return null

  // A declared option list is a host constraint: the kit never adds an
  // approval path beyond it, but always preserves a refusal path.
  const declaredOptions = respondToApproval ? approval?.options : undefined

  const respond = (approved: boolean) => {
    if (submitted) return
    if (
      approval != null &&
      approval.approved === undefined &&
      respondToApproval
    ) {
      respondToApproval({ approved })
    } else if (interrupt) {
      resume?.({ approved })
    } else if (
      status?.type === "requires-action" &&
      status.reason === "interrupt"
    ) {
      return
    } else {
      addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT)
    }
    setSubmitted(true)
  }

  const respondWithOption = (option: ToolApprovalOption) => {
    if (submitted) return
    // A custom kind has no decision class for the runtime to derive, and
    // responding without one throws; picking a declared option is an answer,
    // so it resolves as approved.
    respondToApproval?.(
      isKnownKind(option.kind)
        ? { optionId: option.id }
        : { optionId: option.id, approved: true }
    )
    setSubmitted(true)
    setConfirmingId(null)
  }

  const handleOption = (option: ToolApprovalOption) => {
    if (option.confirm) {
      setConfirmingId(option.id)
    } else {
      respondWithOption(option)
    }
  }

  const confirming =
    confirmingId != null
      ? declaredOptions?.find((o) => o.id === confirmingId)
      : undefined

  if (confirming) {
    const confirmMeta =
      typeof confirming.confirm === "object" ? confirming.confirm : undefined
    const confirmDescription =
      confirmMeta?.description ?? confirming.description
    return (
      <div
        data-slot="tool-fallback-approval-confirm"
        className={cn(
          "aui-tool-fallback-approval-confirm flex flex-col gap-2 pt-1",
          className
        )}
        {...props}
      >
        <p className="aui-tool-fallback-approval-confirm-title font-semibold">
          {confirmMeta?.title ?? `${approvalOptionLabel(confirming)}?`}
        </p>
        {confirmDescription && (
          <p className="aui-tool-fallback-approval-confirm-description text-muted-foreground">
            {confirmDescription}
          </p>
        )}
        {confirming.grants && confirming.grants.length > 0 && (
          <ul className="aui-tool-fallback-approval-confirm-grants flex flex-col gap-1">
            {confirming.grants.map((grant) => (
              <li key={grant}>
                <code className="aui-tool-fallback-approval-confirm-grant rounded bg-muted px-1.5 py-0.5 text-xs">
                  {grant}
                </code>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => respondWithOption(confirming)}
            disabled={submitted}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmingId(null)}
            disabled={submitted}
          >
            Back
          </Button>
        </div>
      </div>
    )
  }

  if (declaredOptions && declaredOptions.length > 0) {
    const allowOptions = declaredOptions.filter((o) => isAllowKind(o.kind))
    const customOptions = declaredOptions.filter((o) => !isKnownKind(o.kind))
    const rejectOptions = declaredOptions.filter(
      (o) => isKnownKind(o.kind) && !isAllowKind(o.kind)
    )
    return (
      <div
        data-slot="tool-fallback-approval"
        className={cn(
          "aui-tool-fallback-approval flex flex-wrap items-center gap-2 pt-1",
          className
        )}
        {...props}
      >
        {[...allowOptions, ...customOptions, ...rejectOptions].map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option === allowOptions[0] ? "default" : "outline"}
            onClick={() => handleOption(option)}
            disabled={submitted}
          >
            {approvalOptionLabel(option)}
          </Button>
        ))}
        {rejectOptions.length === 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => respond(false)}
            disabled={submitted}
          >
            Deny
          </Button>
        )}
      </div>
    )
  }

  return (
    <div
      data-slot="tool-fallback-approval"
      className={cn(
        "aui-tool-fallback-approval flex items-center gap-2 pt-1",
        className
      )}
      {...props}
    >
      <Button size="sm" onClick={() => respond(true)} disabled={submitted}>
        Allow
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => respond(false)}
        disabled={submitted}
      >
        Deny
      </Button>
    </div>
  )
}

/** Calls the thread draws no row for: `read_skill` is `skill_view`'s old name. */
const SILENT = new Set(["skill_view", "read_skill"])

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  toolCallId,
  args,
  argsText,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  const isRequiresAction = status?.type === "requires-action"
  const shouldRenderApproval =
    isRequiresAction && offersInterruptAction(status, approval, interrupt)
  const step = stepOf({ args, argsText })
  const repeat = useAuiState((s) =>
    repeatsPrevious(s.message.parts, toolCallId)
  )

  const [open, setOpen] = useState(isRequiresAction)
  const [prevRequiresAction, setPrevRequiresAction] = useState(isRequiresAction)
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction)
    if (isRequiresAction) setOpen(true)
  }

  // A skill view names the work on the waiting line instead, and says nothing once done.
  if (repeat || SILENT.has(toolName)) return null

  if (!isRequiresAction) {
    return (
      <div
        data-slot="tool-fallback-line"
        className="flex w-fit items-center px-1 py-1.5 text-chat-step text-muted-foreground"
      >
        <ToolFallbackLine toolName={toolName} status={status} step={step} />
      </div>
    )
  }

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} status={status} step={step} />
      <ToolFallbackContent>
        <ToolFallbackArgs argsText={argsText} />
        {shouldRenderApproval && (
          <ToolFallbackApproval
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            respondToApproval={respondToApproval}
            status={status}
          />
        )}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  )
}

/**
 * Anything the assistant calls that has no UI of its own: its line in the
 * copy table's words, and nothing to open once it has run or failed, since the
 * reply carries the substance. Only a step waiting on the owner expands, to
 * its arguments and the allow-or-deny pair. `Approval` takes over for the
 * tools whose target the owner has to see before answering.
 */
const ToolFallback = memo(ToolFallbackImpl) as ToolCallMessagePartComponent
ToolFallback.displayName = "ToolFallback"

export { ToolFallback }
