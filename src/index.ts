import { installFetchTracer, type TraceWriterOptions } from "./tracer.js"

let uninstall: (() => void) | undefined

function traceOptions(options: unknown): TraceWriterOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) return {}
  const dir = (options as { dir?: unknown }).dir
  if (typeof dir !== "string" || !dir.trim()) return {}
  return { dir }
}

type PluginEntrypoint = ((input?: unknown, options?: unknown) => Promise<object>) & {
  id?: string
  server?: (input?: unknown, options?: unknown) => Promise<object>
}

const server: PluginEntrypoint = async (_input?: unknown, options?: unknown) => {
  uninstall ??= installFetchTracer(traceOptions(options))
  return {}
}

server.id = "opencode-api-tracer"
server.server = server

export default server
