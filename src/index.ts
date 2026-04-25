import { installFetchTracer, type TraceWriterOptions } from "./tracer.js"

let uninstall: (() => void) | undefined

function traceOptions(options: unknown): TraceWriterOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) return {}
  const dir = (options as { dir?: unknown }).dir
  const debug = (options as { debug?: unknown }).debug
  const debugFile = (options as { debugFile?: unknown; debug_file?: unknown }).debugFile ?? (options as { debug_file?: unknown }).debug_file
  const captureMissingProviderHeader =
    (options as { captureMissingProviderHeader?: unknown; capture_missing_provider_header?: unknown }).captureMissingProviderHeader ??
    (options as { capture_missing_provider_header?: unknown }).capture_missing_provider_header
  return {
    ...(typeof dir === "string" && dir.trim() ? { dir } : {}),
    ...(typeof debug === "boolean" ? { debug } : {}),
    ...(typeof debugFile === "string" && debugFile.trim() ? { debugFile } : {}),
    ...(typeof captureMissingProviderHeader === "boolean" ? { captureMissingProviderHeader } : {}),
  }
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
