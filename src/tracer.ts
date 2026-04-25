import { appendFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type FetchImpl = (input: Request) => Promise<Response>

export type TraceWriterOptions = {
  dir?: string
  sessionID?: string
  debug?: boolean
  debugFile?: string
  captureMissingProviderHeader?: boolean
  now?: () => Date
}

export type TraceRow = {
  kind: "request" | "response" | "error"
  id: number
  timestamp: string
  sessionID: string
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  status?: number
  statusText?: string
  error?: string
  stack?: string
}

const SESSION_HEADERS = ["x-opencode-session", "x-session-affinity", "session_id"]
const PROVIDER_HEADERS = ["authorization", "x-api-key", "api-key", "x-goog-api-key", "anthropic-version"]
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i
const SENSITIVE_HEADER_PART = /(token|secret|bearer|api[-_]?key)/i

type TraceDecision = {
  sessionID?: string
  reason: string
}

type DiagnosticCounters = {
  fetchSeen: number
  fetchTraced: number
  fetchSkipped: number
  requestRows: number
  responseRows: number
  errorRows: number
  writeErrors: number
}

export function redactHeaders(input: Headers | Record<string, string> | undefined): Record<string, string> {
  const headers = input instanceof Headers ? Object.fromEntries(input.entries()) : { ...(input ?? {}) }
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    output[key] = SENSITIVE_HEADER.test(key) || SENSITIVE_HEADER_PART.test(key) ? "[REDACTED]" : String(value)
  }
  return output
}

export function getSessionID(headers: Headers): string | undefined {
  for (const header of SESSION_HEADERS) {
    const value = headers.get(header)
    if (value) return value
  }
  return undefined
}

export function shouldTraceRequest(request: Request): boolean {
  if (getSessionID(request.headers)) return true
  return isTraceFallbackReason(fallbackTraceReason(request))
}

export function extractPromptFromRequestBody(value: unknown): string | undefined {
  const usable = (text: string | undefined): string | undefined => {
    const trimmed = text?.trim()
    if (!trimmed || trimmed === "Generate a title for this conversation:") return undefined
    return trimmed
  }
  const text = (part: unknown): string | undefined => {
    if (typeof part === "string") return usable(part)
    if (!isRecord(part)) return undefined
    if (typeof part.text === "string") return usable(part.text)
    if (typeof part.input_text === "string") return usable(part.input_text)
    return undefined
  }
  const content = (candidate: unknown): string | undefined => {
    if (typeof candidate === "string") return usable(candidate)
    if (!Array.isArray(candidate)) return undefined
    for (const part of candidate) {
      const found = text(part)
      if (found) return found
    }
    return undefined
  }
  const firstUser = (list: unknown): string | undefined => {
    if (!Array.isArray(list)) return undefined
    for (const item of list) {
      if (!isRecord(item) || item.role !== "user") continue
      const found = content(item.content) ?? text(item)
      if (found) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  return firstUser(value.messages) ?? firstUser(value.input) ?? (typeof value.prompt === "string" ? usable(value.prompt) : undefined)
}

export function parseResponseBody(text: string, _url: string): unknown {
  const json = parseJSON(text)
  if (json !== undefined) return json
  const parsedEvents = parseSSE(text)
  if (parsedEvents) return { events: parsedEvents }
  return { raw: text }
}

export function parseSSE(text: string): Array<{ event?: string; data: unknown }> | undefined {
  const result: Array<{ event?: string; data: unknown }> = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue
    let event: string | undefined
    const data = block
      .split(/\r?\n/)
      .flatMap((line) => {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim()
          return []
        }
        if (line.startsWith("data:")) return [line.slice("data:".length).trimStart()]
        return []
      })
      .join("\n")
    if (!data || data === "[DONE]") continue
    const json = parseJSON(data)
    if (json === undefined) return undefined
    result.push({ event, data: json })
  }
  return result.length ? result : undefined
}

export class TraceWriter {
  private readonly dir: string
  private readonly fallbackSessionID: string
  private readonly captureMissingProviderHeader: boolean
  private readonly now: () => Date
  private readonly diagnostics: TraceDiagnostics
  private readonly files = new Map<string, string>()
  private readonly ids = new Map<string, number>()

  constructor(options: TraceWriterOptions = {}) {
    this.dir =
      options.dir ??
      process.env.OPENCODE_API_TRACER_DIR ??
      process.env.OPENCODE_TRACE_DIR ??
      path.join(os.homedir(), "opencode-api-tracer")
    this.fallbackSessionID =
      options.sessionID ??
      process.env.OPENCODE_API_TRACER_SESSION_ID ??
      `run_${process.pid}_${Date.now().toString(36)}`
    this.captureMissingProviderHeader = captureMissingProviderHeaderEnabled(options)
    this.now = options.now ?? (() => new Date())
    this.diagnostics = new TraceDiagnostics(options, this.dir, this.now)
    this.diagnostics.log("writer.created", {
      dir: this.dir,
      fallbackSessionID: this.fallbackSessionID,
      captureMissingProviderHeader: this.captureMissingProviderHeader,
    })
  }

  sessionIDFor(request: Request): string | undefined {
    return this.traceDecisionFor(request).sessionID
  }

  traceDecisionFor(request: Request): TraceDecision {
    const sessionID = getSessionID(request.headers)
    if (sessionID) return { sessionID, reason: "session-header" }
    const reason = fallbackTraceReason(request, this.captureMissingProviderHeader)
    if (isTraceFallbackReason(reason)) return { sessionID: this.fallbackSessionID, reason }
    return { reason }
  }

  log(event: string, data?: Record<string, unknown>): void {
    this.diagnostics.log(event, data)
  }

  count(key: keyof DiagnosticCounters): void {
    this.diagnostics.count(key)
  }

  nextID(sessionID: string): number {
    const next = (this.ids.get(sessionID) ?? 0) + 1
    this.ids.set(sessionID, next)
    return next
  }

  pathForSession(sessionID: string): string | undefined {
    return this.files.get(sessionID)
  }

  write(sessionID: string, name: string, row: TraceRow): string {
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = this.files.get(sessionID) ?? path.join(this.dir, `${timestampForFile(this.now())}-${sanitizeName(name)}.jsonl`)
      this.files.set(sessionID, file)
      appendFileSync(file, `${JSON.stringify(row)}\n`)
      this.diagnostics.count(row.kind === "request" ? "requestRows" : row.kind === "response" ? "responseRows" : "errorRows")
      this.diagnostics.log("jsonl.write.success", {
        kind: row.kind,
        id: row.id,
        sessionID,
        file,
      })
      return file
    } catch (error) {
      this.diagnostics.count("writeErrors")
      this.diagnostics.log("jsonl.write.error", {
        kind: row.kind,
        id: row.id,
        sessionID,
        ...formatError(error),
      })
      throw error
    }
  }
}

export async function tracedFetch(
  fetchImpl: FetchImpl,
  writer: TraceWriter,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init)
  writer.count("fetchSeen")
  writer.log("fetch.seen", requestDiagnostic(request))
  const decision = writer.traceDecisionFor(request)
  if (!decision.sessionID) {
    writer.count("fetchSkipped")
    writer.log("fetch.skipped", {
      ...requestDiagnostic(request),
      reason: decision.reason,
    })
    return fetchImpl(request)
  }
  writer.count("fetchTraced")
  writer.log("fetch.traced", {
    ...requestDiagnostic(request),
    sessionID: decision.sessionID,
    reason: decision.reason,
  })
  const sessionID = decision.sessionID

  const requestText = await request.clone().text().catch(() => "")
  const requestBody = parseBody(requestText)
  const id = writer.nextID(sessionID)
  const prompt = extractPromptFromRequestBody(requestBody) ?? sessionID
  const common = {
    id,
    sessionID,
    method: request.method,
    url: request.url,
  }

  safeWrite(writer, sessionID, prompt, {
    ...common,
    kind: "request",
    timestamp: new Date().toISOString(),
    headers: redactHeaders(request.headers),
    body: requestBody,
  })

  let response: Response
  try {
    response = await fetchImpl(request)
  } catch (error) {
    safeWrite(writer, sessionID, prompt, {
      ...common,
      kind: "error",
      timestamp: new Date().toISOString(),
      ...formatError(error),
    })
    throw error
  }

  void response
    .clone()
    .text()
    .then((responseText) => {
      safeWrite(writer, sessionID, prompt, {
        ...common,
        kind: "response",
        timestamp: new Date().toISOString(),
        status: response.status,
        statusText: response.statusText,
        headers: redactHeaders(response.headers),
        body: parseResponseBody(responseText, request.url),
      })
    })
    .catch((error) => {
      writer.log("response.clone.error", {
        id,
        sessionID,
        url: request.url,
        ...formatError(error),
      })
      safeWrite(writer, sessionID, prompt, {
        ...common,
        kind: "error",
        timestamp: new Date().toISOString(),
        ...formatError(error),
      })
    })

  return response
}

let originalFetch: FetchImpl | undefined

export function installFetchTracer(options: TraceWriterOptions = {}): () => void {
  const diagnostics = TraceDiagnostics.fromOptions(options)
  diagnostics.log("install.start", {
    cwd: process.cwd(),
    pid: process.pid,
    node: process.version,
    fetchType: typeof globalThis.fetch,
  })
  if (originalFetch) {
    diagnostics.log("install.already-installed")
    return () => undefined
  }
  if (typeof globalThis.fetch !== "function") {
    diagnostics.log("install.no-global-fetch")
    return () => undefined
  }
  const fetchImpl = globalThis.fetch.bind(globalThis)
  originalFetch = (input: Request) => fetchImpl(input)
  const writer = new TraceWriter(options)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => tracedFetch(originalFetch!, writer, input, init)) as typeof fetch
  writer.log("install.patched", {
    cwd: process.cwd(),
    pid: process.pid,
    outputDir: writerOutputDir(writer),
  })
  return () => {
    if (!originalFetch) return
    globalThis.fetch = originalFetch as typeof fetch
    originalFetch = undefined
    writer.log("install.unpatched")
  }
}

function parseBody(text: string): unknown {
  if (!text) return undefined
  return parseJSON(text) ?? text
}

function parseJSON(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function hasProviderHeader(headers: Headers): boolean {
  return PROVIDER_HEADERS.some((header) => !!headers.get(header))
}

function fallbackTraceReason(request: Request, captureMissingProviderHeader = false): string {
  if (request.method.toUpperCase() !== "POST") return "method-not-post"
  const likelyLLMEndpoint = isLikelyLLMEndpoint(request.url)
  if (!hasProviderHeader(request.headers)) {
    if (!captureMissingProviderHeader) return "missing-provider-header"
    if (!likelyLLMEndpoint) return "missing-provider-header-not-llm-endpoint"
    return "fallback-llm-endpoint-missing-provider-header"
  }
  if (!likelyLLMEndpoint) return "not-llm-endpoint"
  return "fallback-llm-endpoint"
}

function isTraceFallbackReason(reason: string): boolean {
  return reason === "fallback-llm-endpoint" || reason === "fallback-llm-endpoint-missing-provider-header"
}

function isLikelyLLMEndpoint(url: string): boolean {
  const pathname = new URL(url).pathname.toLowerCase()
  return (
    pathname.endsWith("/messages") ||
    pathname.endsWith("/chat/completions") ||
    pathname.endsWith("/responses") ||
    pathname.includes(":generatecontent") ||
    pathname.includes(":streamgeneratecontent")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function safeWrite(writer: TraceWriter, sessionID: string, name: string, row: TraceRow): void {
  try {
    writer.write(sessionID, name, row)
  } catch {
    // Tracing should never break the host opencode session.
  }
}

function formatError(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) return { error: error.message, stack: error.stack }
  return { error: String(error) }
}

function requestDiagnostic(request: Request): Record<string, unknown> {
  const url = new URL(request.url)
  return {
    method: request.method,
    url: request.url,
    host: url.host,
    pathname: url.pathname,
    headerNames: Array.from(request.headers.keys()).sort(),
    hasSessionHeader: !!getSessionID(request.headers),
    hasProviderHeader: hasProviderHeader(request.headers),
    likelyLLMEndpoint: isLikelyLLMEndpoint(request.url),
  }
}

function writerOutputDir(writer: TraceWriter): string {
  return (writer as unknown as { dir: string }).dir
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function captureMissingProviderHeaderEnabled(options: TraceWriterOptions): boolean {
  if (typeof options.captureMissingProviderHeader === "boolean") return options.captureMissingProviderHeader
  return parseBoolean(process.env.OPENCODE_API_TRACER_CAPTURE_MISSING_PROVIDER_HEADER)
}

function diagnosticsEnabled(options: TraceWriterOptions): boolean {
  if (typeof options.debug === "boolean") return options.debug
  if (process.env.OPENCODE_API_TRACER_DEBUG !== undefined) return parseBoolean(process.env.OPENCODE_API_TRACER_DEBUG)
  return true
}

function defaultTraceDir(options: TraceWriterOptions = {}): string {
  return (
    options.dir ??
    process.env.OPENCODE_API_TRACER_DIR ??
    process.env.OPENCODE_TRACE_DIR ??
    path.join(os.homedir(), "opencode-api-tracer")
  )
}

class TraceDiagnostics {
  private readonly enabled: boolean
  private readonly file?: string
  private readonly now: () => Date
  private readonly counters: DiagnosticCounters = {
    fetchSeen: 0,
    fetchTraced: 0,
    fetchSkipped: 0,
    requestRows: 0,
    responseRows: 0,
    errorRows: 0,
    writeErrors: 0,
  }
  private summaryRegistered = false
  private summaryLogged = false

  static fromOptions(options: TraceWriterOptions = {}): TraceDiagnostics {
    return new TraceDiagnostics(options, defaultTraceDir(options), () => new Date(), false)
  }

  constructor(options: TraceWriterOptions = {}, traceDir = defaultTraceDir(options), now: () => Date = () => new Date(), registerSummary = true) {
    this.enabled = diagnosticsEnabled(options) || !!options.debugFile || !!process.env.OPENCODE_API_TRACER_DEBUG_FILE
    this.file =
      options.debugFile ??
      process.env.OPENCODE_API_TRACER_DEBUG_FILE ??
      (this.enabled ? path.join(traceDir, "opencode-api-tracer.debug.jsonl") : undefined)
    this.now = now
    if (this.enabled && registerSummary) this.registerSummary()
  }

  count(key: keyof DiagnosticCounters): void {
    this.counters[key]++
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    if (!this.enabled || !this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(
        this.file,
        `${JSON.stringify({
          timestamp: this.now().toISOString(),
          pid: process.pid,
          event,
          ...data,
        })}\n`,
      )
    } catch {
      // Diagnostics must never break tracing or the host opencode process.
    }
  }

  private registerSummary(): void {
    if (this.summaryRegistered) return
    this.summaryRegistered = true
    const logSummary = () => {
      if (this.summaryLogged) return
      this.summaryLogged = true
      this.log("process.summary", { counters: this.counters })
    }
    process.once("beforeExit", logSummary)
    process.once("exit", logSummary)
  }
}

function timestampForFile(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("-")
}

function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9 _-]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 10)
    .join(" ")
    .slice(0, 60)
    .trim()
  return cleaned || "session"
}
