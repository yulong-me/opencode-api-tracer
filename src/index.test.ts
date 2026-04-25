import assert from "node:assert/strict"
import test from "node:test"
import plugin, * as entrypoint from "./index.js"

test("default export is a plugin function for opencode v1.3 compatibility", () => {
  assert.equal(typeof plugin, "function")
  assert.equal(plugin.id, "opencode-api-tracer")
  assert.equal(typeof plugin.server, "function")
})

test("plugin entrypoint does not expose tracer internals as named plugin candidates", () => {
  assert.deepEqual(Object.keys(entrypoint), ["default"])
})
