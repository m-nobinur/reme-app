import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import { Buffer } from "node:buffer"
import {
  NPM_REGISTRY_HOST,
  POOL_SIZE,
  SANDBOX_INSTANCE,
  SLEEP_AFTER,
} from "./sandbox.ts"

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
  HOME: "/tmp/home",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers",
  NODE_EXTRA_CA_CERTS: CA,
  // Egress refuses telemetry.astro.build, which logged an error on every run.
  ASTRO_TELEMETRY_DISABLED: "1",
  // The tail's identity (`GIT` in tail.ts), so the lead's own commits work too.
  GIT_AUTHOR_NAME: "reme",
  GIT_AUTHOR_EMAIL: "developer@reme.invalid",
  GIT_COMMITTER_NAME: "reme",
  GIT_COMMITTER_EMAIL: "developer@reme.invalid",
}

/**
 * Trust the intercept's CA, as the 0.12 control server did at start: wait
 * for it, then write the bundle from the image's copy and the current CA.
 * Then make the warm-revision marker's directory. Run again for the same
 * container, it does the same.
 */
const TRUST = [
  "sh",
  "-c",
  `[ -e ${SYSTEM} ] || { cp ${BUNDLE} ${SYSTEM}.tmp && mv ${SYSTEM}.tmp ${SYSTEM}; }
timeout 10 sh -c 'until [ -s ${CA} ]; do sleep 0.1; done' && cat ${SYSTEM} ${CA} >${BUNDLE}.tmp && mv ${BUNDLE}.tmp ${BUNDLE} &&
mkdir -p ${WORKSPACE}/.reme`,
]

/**
 * Set on every command the code does not mark privileged, so the stray sweep
 * can tell the Developer's processes and the site's build code from the
 * code's own steps: every command runs as root with every capability, since
 * the org's own container is the boundary (as Hermes skips its command
 * guards in a container).
 */
const STRAY = "REME_STRAY=1"

/**
 * The file calls, as commands. The path comes in `REME_PATH`; a write's
 * bytes come on stdin. A write makes its directory, as 0.12 did.
 */
export const FILE_SCRIPTS = {
  read: 'cat -- "$REME_PATH"',
  write: 'mkdir -p -- "$(dirname -- "$REME_PATH")" && cat >"$REME_PATH"',
  exists: 'test -e "$REME_PATH" || test -L "$REME_PATH"',
  mkdir: 'mkdir -- "$REME_PATH"',
  mkdirAll: 'mkdir -p -- "$REME_PATH"',
  remove: 'rm -- "$REME_PATH"',
}

/**
 * Kills every process carrying the `STRAY` marker: what the Developer's
 * commands or the site's own build code left running (a `setsid` escapes the
 * timeout), so none of it touches the tail's files. Each pass stops what it
 * finds before killing it, so nothing forks past it, and passes repeat until
 * one finds nothing. Never the container's own process or this shell.
 */
export const STOP_STRAYS = `for _ in $(seq 20); do found=; for s in /proc/[0-9]*/status; do p=\${s#/proc/}; p=\${p%/status}; { [ "$p" = 1 ] || [ "$p" = $$ ]; } && continue; tr '\\0' '\\n' 2>/dev/null <"/proc/$p/environ" | grep -qx '${STRAY}' && kill -STOP "$p" 2>/dev/null && found="$found $p"; done; [ -z "$found" ] && break; kill -KILL $found 2>/dev/null; done; true`

/**
 * What bash runs for every `exec`: the cwd and the command come in its env.
 * A cwd that does not exist yet is made, as `writeFile` makes its directory:
 * the Developer's first command is `mkdir -p /workspace/site` from inside it.
 */
export const EXEC_SCRIPT =
  'mkdir -p -- "$REME_CWD" && cd -- "$REME_CWD" || exit 1; export -n REME_COMMAND REME_CWD; eval "$REME_COMMAND"'

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
  /**
   * The code's own step, outside the site: the stray sweep never stops it.
   * flue's adapter never passes it, so every model command is swept.
   */
  privileged?: boolean
}

export class RemeSandbox extends DurableObject<Env> {
  private setup: Promise<void> | null = null
  private ready = false
  private renewedAt = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
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
        instance: SANDBOX_INSTANCE,
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
   * 0.12 did. A `cwd` that does not exist is made first.
   */
  async exec(command: string, options: ExecOptions = {}) {
    return this.use(async () => {
      const out = await this.run(command, options)
      return {
        success: out.exitCode === 0,
        exitCode: out.exitCode,
        stdout: text(out.stdout),
        stderr: text(out.stderr),
      }
    })
  }

  private async run(
    command: string,
    options: ExecOptions & { stdin?: ReadableStream<Uint8Array> }
  ) {
    const seconds = options.timeout ? Math.ceil(options.timeout / 1000) : 0
    const out = await (await this.spawn(command, options)).output()
    if (seconds && out.exitCode === TIMED_OUT) {
      throw new Error(`Command timeout after ${options.timeout}ms`)
    }
    return out
  }

  private spawn(
    command: string,
    options: ExecOptions & { stdin?: ReadableStream<Uint8Array> }
  ) {
    const seconds = options.timeout ? Math.ceil(options.timeout / 1000) : 0
    // The command reaches bash in a variable, never in argv: as in a 0.12
    // session, no command line holds it, so its own `pkill -f` cannot match
    // the shell running it (the screenshot step's does). Un-exported, so
    // what it starts never sees it. The process starts in /workspace and
    // changes directory itself: on Containers a spawn into a missing
    // directory throws "Command `bash` was not found", which ended the
    // Developer's `mkdir -p /workspace/site` on staging.
    const shell = ["bash", "-c", EXEC_SCRIPT]
    return this.container.exec(
      seconds ? ["timeout", "--kill-after=5", `${seconds}`, ...shell] : shell,
      {
        cwd: WORKSPACE,
        // Root: the image's own user, reme, has no capabilities locally.
        user: "0:0",
        env: {
          ...EXEC_ENV,
          ...(options.privileged ? {} : { REME_STRAY: "1" }),
          ...options.env,
          REME_COMMAND: command,
          REME_CWD: options.cwd ?? WORKSPACE,
        },
        ...(options.stdin ? { stdin: options.stdin } : {}),
      }
    )
  }

  /** One file call; a failure throws with what the command said. */
  private async file(
    script: keyof typeof FILE_SCRIPTS,
    path: string,
    stdin?: ReadableStream<Uint8Array>
  ) {
    return this.use(async () => {
      const out = await this.run(FILE_SCRIPTS[script], {
        env: { REME_PATH: path },
        ...(stdin ? { stdin } : {}),
      })
      if (out.exitCode !== 0 && script !== "exists")
        throw new Error(text(out.stderr).trim() || `${script} failed: ${path}`)
      return out
    })
  }

  /** A file as text, or as base64 with `encoding: "base64"`, as 0.12 returned it. */
  async readFile(path: string, options: { encoding?: string } = {}) {
    const { stdout } = await this.file("read", path)
    return {
      content:
        options.encoding === "base64"
          ? Buffer.from(stdout).toString("base64")
          : text(stdout),
    }
  }

  /**
   * Stream a file from the container into the sites bucket under `key` and
   * return its size. A site's tar is tens of MB: as a base64 string decoded
   * in the caller it ran the Developer's isolate out of memory (#593). A file
   * that changes length on the way fails the put.
   */
  async saveFile(path: string, key: string): Promise<number> {
    return this.use(async () => {
      const env = { REME_PATH: path }
      const sized = await this.run('stat -L -c %s -- "$REME_PATH"', { env })
      const size = Number(text(sized.stdout).trim())
      if (sized.exitCode !== 0 || !Number.isSafeInteger(size))
        throw new Error(text(sized.stderr).trim() || `cannot read ${path}`)
      const reading = await this.spawn(FILE_SCRIPTS.read, { env })
      if (!reading.stdout) throw new Error(`no output reading ${path}`)
      await this.env.SITES.put(
        key,
        reading.stdout.pipeThrough(new FixedLengthStream(size))
      )
      if ((await reading.exitCode) !== 0) throw new Error(`cannot read ${path}`)
      return size
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
    const stdin =
      content instanceof ReadableStream
        ? content
        : new Blob([
            typeof content === "string" && options.encoding === "base64"
              ? Buffer.from(content, "base64")
              : content,
          ]).stream()
    await this.file("write", path, stdin)
    return { success: true }
  }

  async exists(path: string) {
    return { exists: (await this.file("exists", path)).exitCode === 0 }
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}) {
    await this.file(options.recursive ? "mkdirAll" : "mkdir", path)
    return { success: true }
  }

  /** Kill what the Developer's commands left running; see `STOP_STRAYS`. */
  async stopStrays() {
    return this.use(async () => {
      await this.run(STOP_STRAYS, { privileged: true })
    })
  }

  async deleteFile(path: string) {
    await this.file("remove", path)
    return { success: true }
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
