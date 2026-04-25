import assert from "node:assert/strict"
import test from "node:test"
import plugin, { traceOptions } from "./index.js"

test("default export uses opencode v1 plugin object shape", () => {
  assert.equal(typeof plugin, "object")
  assert.equal(plugin.id, "opencode-api-tracer")
  assert.equal(typeof plugin.server, "function")
})

test("traceOptions accepts plugin dir option", () => {
  assert.deepEqual(traceOptions({ dir: "/tmp/opencode-api-tracer-test" }), { dir: "/tmp/opencode-api-tracer-test" })
  assert.deepEqual(traceOptions({ dir: "" }), {})
  assert.deepEqual(traceOptions(null), {})
  assert.deepEqual(traceOptions("bad"), {})
})
