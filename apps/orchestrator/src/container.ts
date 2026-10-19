import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import { Buffer } from "node:buffer"
import { posix } from "node:path"
import { Files, SandboxFileError } from "@cloudflare/sandbox"
import { NPM_REGISTRY_HOST, POOL_SIZE, SLEEP_AFTER } from "./sandbox.ts"

/**
 * The container behind every site (ADR-031, as amended for Sandbox SDK 1.0):
 * egress denied by default with the registry as the one exception, asleep
 * after `SLEEP_AFTER`, one of at most `POOL_SIZE`, and holding nothing the
 * Worker holds. The image is infra/sandbox/Dockerfile.
 *
 * Its methods are the ones flue's `cloudflareSandbox` calls on a 0.x stub
 * (`CloudflareSandboxStub`), with 0.x meanings, so the Developer's harness
 * and the Workflow's steps reach the container as they did on 0.x.
 */

const WORKSPACE = "/workspace"

/** Where the platform puts the CA it signs intercepted HTTPS with. */
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt"
/** The image's bundle as built, so a restart never stacks an older CA on it. */
const SYSTEM = "/etc/ssl/certs/ca-certificates.system.crt"

/**
 * Every variable a command sees: 1.0 passes a command none of the image's
 * or `start()`'s variables but PATH. These are the ones the 0.12 shell had
 * from the image, and the CA for Node, which reads no system bundle. Nothing
 * from the Worker's env goes in.
 */
const EXEC_ENV = {
  HOME: "/home/reme",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers",
  NODE_EXTRA_CA_CERTS: CA,
}

/**
 * Trust the intercept's CA, as the 0.12 control server did at start: wait
 * for it, then write the bundle from the image's copy and the current CA.
 * Run again for the same container, it writes the same bundle.
 */
const TRUST = [
  "sh",
  "-c",
  `[ -e ${SYSTEM} ] || { cp ${BUNDLE} ${SYSTEM}.tmp && mv ${SYSTEM}.tmp ${SYSTEM}; }
timeout 10 sh -c 'until [ -s ${CA} ]; do sleep 0.1; done' && cat ${SYSTEM} ${CA} >${BUNDLE}.tmp && mv ${BUNDLE}.tmp ${BUNDLE}`,
]

/** GNU `timeout`'s exit code when the command ran out of time. */
const TIMED_OUT = 124

/**
 * How long a slot outlives the last call: the container sleeps `SLEEP_AFTER`
 * after it, and the slack covers a call that renewed at its start and ran
 * long. A crashed or slept container frees its slot when the lease lapses.
 */
export const LEASE_MS = SLEEP_AFTER * 1000 + 5 * 60 * 1000
/** Renewals per container are at most one a minute, so the pool is no hot spot. */
const RENEW_EVERY_MS = 60 * 1000

class PoolFullError extends Error {}

// `wrangler types` cannot see the main module flue generates, so the
// loopback entrypoint this class uses is typed here.
type Exports = { SandboxEgress: (options: { props: object }) => Fetcher }

const text = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)

type ExecOptions = {
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

export class RemeSandbox extends DurableObject<Env> {
  private readonly files: Files
  private setup: Promise<void> | null = null
  private ready = false
  private renewedAt = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.files = new Files(this.container)
    const container = ctx.container
    // A restarted Durable Object has lost the timeout; the platform keeps
    // the container.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(SLEEP_AFTER * 1000)
      )
    }
  }

  private get container(): Container {
    const container = this.ctx.container
    if (!container) throw new Error("the sandbox has no container binding")
    return container
  }

  /** The slot table's name for this sandbox: its id, which every name maps to once. */
  private get slot() {
    return this.ctx.id.toString()
  }

  private get pool() {
    return (
      this.env.SANDBOX_POOL as DurableObjectNamespace<SandboxPool>
    ).getByName("pool")
  }

  /**
   * One setup per container: a new one, and a running one this Durable
   * Object has not set up since it restarted. Calls that arrive during setup
   * wait for it; a failed setup leaves the next call to try again.
   */
  private ensureRunning(): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: `ready` is set in the setup's callback
    if (this.setup && (!this.ready || this.container.running)) return this.setup
    this.ready = false
    this.setup = this.startContainer().then(
      () => {
        this.ready = true
      },
      (error: unknown) => {
        this.setup = null
        throw error
      }
    )
    return this.setup
  }

  private async startContainer(): Promise<void> {
    if (!this.container.running) {
      if (!(await this.pool.acquire(this.slot, LEASE_MS))) {
        throw new PoolFullError(`the container pool is full (${POOL_SIZE})`)
      }
      this.renewedAt = Date.now()
      this.container.start({
        image: this.container.images.sandbox,
        instance: "standard-2",
        enableInternet: false,
      })
    }
    // Every step is safe to run again: a deploy can stop setup partway, and
    // the restarted object runs it over a container that is still up.
    try {
      // Port 80 and 443 to the egress rule; with the Internet off, every
      // other port goes nowhere.
      const egress = (this.ctx.exports as Exports).SandboxEgress({ props: {} })
      await this.container.interceptAllOutboundHttp(egress)
      await this.container.interceptOutboundHttps("*", egress)
      // Root for this one command: the bundle is root's file.
      const trust = await this.container.exec(TRUST, { user: "0:0" })
      if ((await trust.exitCode) !== 0) {
        throw new Error("the container did not trust the intercept CA")
      }
      await this.container.setInactivityTimeout(SLEEP_AFTER * 1000)
    } catch (error) {
      await this.destroy()
      throw error
    }
  }

  /** Keep this container's slot while it works, at most once a minute. */
  private renew() {
    if (Date.now() - this.renewedAt < RENEW_EVERY_MS) return
    this.renewedAt = Date.now()
    this.pool.renew(this.slot, LEASE_MS).catch((error: unknown) => {
      this.renewedAt = 0
      console.error(
        JSON.stringify({ type: "sandbox.lease_failed", error: String(error) })
      )
    })
  }

  private async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureRunning()
    this.renew()
    try {
      return await fn()
    } finally {
      this.renew()
    }
  }

  /**
   * Start the container if it is not running, for `provision()`: false when
   * the pool has no slot for it, which the caller answers by evicting a warm
   * sandbox or waiting.
   */
  async open(): Promise<boolean> {
    try {
      await this.exec("true")
      return true
    } catch (error) {
      if (error instanceof PoolFullError) return false
      throw error
    }
  }

  /**
   * One command in bash, as a 0.12 session ran it, from /workspace unless
   * `cwd` says otherwise. Nothing carries from one call to the next. A
   * `timeout` stops the command and everything it started, and throws as
   * 0.12 did.
   */
  async exec(command: string, options: ExecOptions = {}) {
    return this.use(async () => {
      const seconds = options.timeout ? Math.ceil(options.timeout / 1000) : 0
      // The command reaches bash in a variable, never in argv: as in a 0.12
      // session, no command line holds it, so its own `pkill -f` cannot match
      // the shell running it (the screenshot step's does). Un-exported, so
      // what it starts never sees it.
      const shell = [
        "bash",
        "-c",
        'export -n REME_COMMAND; eval "$REME_COMMAND"',
      ]
      const process = await this.container.exec(
        seconds ? ["timeout", "--kill-after=5", `${seconds}`, ...shell] : shell,
        {
          cwd: options.cwd ?? WORKSPACE,
          env: { ...EXEC_ENV, ...options.env, REME_COMMAND: command },
        }
      )
      const out = await process.output()
      if (seconds && out.exitCode === TIMED_OUT) {
        throw new Error(`Command timeout after ${options.timeout}ms`)
      }
      return {
        success: out.exitCode === 0,
        exitCode: out.exitCode,
        stdout: text(out.stdout),
        stderr: text(out.stderr),
      }
    })
  }

  /** A file as text, or as base64 with `encoding: "base64"`, as 0.12 returned it. */
  async readFile(path: string, options: { encoding?: string } = {}) {
    return this.use(async () => {
      const file = await this.files.readFile(path, { cwd: WORKSPACE })
      const bytes = await file.arrayBuffer()
      return {
        content:
          options.encoding === "base64"
            ? Buffer.from(bytes).toString("base64")
            : text(bytes),
      }
    })
  }

  /**
   * Write a file, creating its directory as 0.12 did. A string with
   * `encoding: "base64"` is decoded first.
   */
  async writeFile(
    path: string,
    content: string | Uint8Array | ReadableStream<Uint8Array>,
    options: { encoding?: string } = {}
  ) {
    return this.use(async () => {
      const body =
        typeof content === "string" && options.encoding === "base64"
          ? Buffer.from(content, "base64")
          : content
      const at = { cwd: WORKSPACE }
      try {
        await this.files.writeFile(path, body, at)
      } catch (error) {
        if (!(SandboxFileError.is(error) && error.code === "ENOENT"))
          throw error
        // The open failed, so a stream is still unread and can go again.
        const dir = posix.dirname(posix.resolve(WORKSPACE, path))
        await this.files.mkdir(dir, { recursive: true })
        await this.files.writeFile(path, body, at)
      }
      return { success: true }
    })
  }

  async exists(path: string) {
    return this.use(async () => {
      try {
        await this.files.stat(path, { cwd: WORKSPACE })
        return { exists: true }
      } catch (error) {
        if (SandboxFileError.is(error) && error.code === "ENOENT") {
          return { exists: false }
        }
        throw error
      }
    })
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}) {
    return this.use(async () => {
      await this.files.mkdir(path, { cwd: WORKSPACE, ...options })
      return { success: true }
    })
  }

  async deleteFile(path: string) {
    return this.use(async () => {
      await this.files.remove(path, { cwd: WORKSPACE })
      return { success: true }
    })
  }

  /**
   * What flue's death check polls while a call is pending: a container that
   * stopped under the call fails it as `sandbox_died`. No container round trip.
   */
  getState() {
    const running = this.ctx.container?.running ?? false
    if (running) this.renew()
    return { status: running ? "running" : "stopped" }
  }

  /** Stop the container and free its slot. Idempotent. */
  async destroy(): Promise<void> {
    this.setup = null
    this.ready = false
    if (this.container.running) await this.container.destroy()
    await this.pool.release(this.slot)
  }

  async alarm(): Promise<void> {
    // 0.12 kept an alarm set while a container ran, and one fires here once
    // after the move to 1.0. This class sets none, so there is nothing to do.
  }
}

/**
 * §8.3's egress rule for the container's HTTP and HTTPS: the registry and
 * nothing else, refused with 0.12's answer.
 */
export class SandboxEgress extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> | Response {
    const host = new URL(request.url).hostname.replace(/\.+$/, "")
    if (host === NPM_REGISTRY_HOST) return fetch(request)
    return new Response("Origin is disallowed", { status: 520 })
  }
}

/**
 * The container pool's slot table, as one Durable Object (`getByName("pool")`)
 * so every grant is serialised: the `durable_object` scheduling policy has
 * no `max_instances`. A slot is a lease the running sandbox renews; a
 * stopped one releases it and a lapsed one frees itself. Each method runs
 * without an await, so no two interleave.
 */
export class SandboxPool extends DurableObject<Env> {
  /** Grant `slot` a lease, or renew the one it holds. False when the pool is full. */
  acquire(slot: string, leaseMs: number): boolean {
    const now = Date.now()
    const kv = this.ctx.storage.kv
    let held = 0
    for (const [key, until] of kv.list<number>()) {
      if (until <= now) kv.delete(key)
      else if (key !== slot) held++
    }
    if (held >= POOL_SIZE) return false
    kv.put(slot, now + leaseMs)
    return true
  }

  /** Extend a running sandbox's lease, taking a slot back if it lapsed: it is running either way. */
  renew(slot: string, leaseMs: number): void {
    this.ctx.storage.kv.put(slot, Date.now() + leaseMs)
  }

  release(slot: string): void {
    this.ctx.storage.kv.delete(slot)
  }
}
