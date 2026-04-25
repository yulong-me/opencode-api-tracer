import { appendFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type FetchImpl = (input: Request) => Promise<Response>

export type TraceWriterOptions = {
  dir?: string
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
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i
const SENSITIVE_HEADER_PART = /(token|secret|bearer|api[-_]?key)/i

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
  private readonly now: () => Date
  private readonly files = new Map<string, string>()
  private readonly ids = new Map<string, number>()

  constructor(options: TraceWriterOptions = {}) {
    this.dir =
      options.dir ??
      process.env.OPENCODE_API_TRACER_DIR ??
      process.env.OPENCODE_TRACE_DIR ??
      path.join(os.homedir(), "opencode-api-tracer")
    this.now = options.now ?? (() => new Date())
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
    mkdirSync(this.dir, { recursive: true })
    const file = this.files.get(sessionID) ?? path.join(this.dir, `${timestampForFile(this.now())}-${sanitizeName(name)}.jsonl`)
    this.files.set(sessionID, file)
    appendFileSync(file, `${JSON.stringify(row)}\n`)
    return file
  }
}

export async function tracedFetch(
  fetchImpl: FetchImpl,
  writer: TraceWriter,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init)
  const sessionID = getSessionID(request.headers)
  if (!sessionID) return fetchImpl(request)

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
  if (originalFetch) return () => undefined
  const fetchImpl = globalThis.fetch.bind(globalThis)
  originalFetch = (input: Request) => fetchImpl(input)
  const writer = new TraceWriter(options)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => tracedFetch(originalFetch!, writer, input, init)) as typeof fetch
  return () => {
    if (!originalFetch) return
    globalThis.fetch = originalFetch as typeof fetch
    originalFetch = undefined
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
