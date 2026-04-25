import { installFetchTracer, type TraceWriterOptions } from "./tracer.js"

let uninstall: (() => void) | undefined

export function traceOptions(options: unknown): TraceWriterOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) return {}
  const dir = (options as { dir?: unknown }).dir
  if (typeof dir !== "string" || !dir.trim()) return {}
  return { dir }
}

const server = async (_input?: unknown, options?: unknown) => {
  uninstall ??= installFetchTracer(traceOptions(options))
  return {}
}

const entrypoint: {
  id: string
  server: typeof server
} = {
  id: "opencode-api-tracer",
  server,
}

export default entrypoint
export * from "./tracer.js"
