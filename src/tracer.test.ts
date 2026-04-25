import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  extractPromptFromRequestBody,
  getSessionID,
  parseResponseBody,
  redactHeaders,
  shouldTraceRequest,
  TraceWriter,
  tracedFetch,
} from "./tracer.js"

test("redactHeaders redacts sensitive values but keeps routing headers", () => {
  const headers = redactHeaders({
    authorization: "Bearer super-secret",
    "x-api-key": "secret-key",
    "x-opencode-session": "ses_123",
    "content-type": "application/json",
  })

  assert.equal(headers.authorization, "[REDACTED]")
  assert.equal(headers["x-api-key"], "[REDACTED]")
  assert.equal(headers["x-opencode-session"], "ses_123")
  assert.equal(headers["content-type"], "application/json")
})

test("getSessionID recognizes opencode session headers", () => {
  assert.equal(getSessionID(new Headers({ "x-opencode-session": "ses_a" })), "ses_a")
  assert.equal(getSessionID(new Headers({ "x-session-affinity": "ses_b" })), "ses_b")
  assert.equal(getSessionID(new Headers({ session_id: "ses_c" })), "ses_c")
  assert.equal(getSessionID(new Headers({ "content-type": "application/json" })), undefined)
})

test("shouldTraceRequest recognizes older opencode LLM requests without session headers", () => {
  assert.equal(
    shouldTraceRequest(
      new Request("https://api.minimaxi.com/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "secret",
        },
      }),
    ),
    true,
  )
  assert.equal(shouldTraceRequest(new Request("https://example.com/page", { method: "GET" })), false)
})

test("extractPromptFromRequestBody finds the first useful user prompt", () => {
  const prompt = extractPromptFromRequestBody({
    messages: [
      { role: "system", content: "ignore" },
      { role: "user", content: [{ type: "text", text: "  Reply exactly: OK  " }] },
    ],
  })

  assert.equal(prompt, "Reply exactly: OK")
})

test("parseResponseBody parses json and SSE event streams", () => {
  assert.deepEqual(parseResponseBody('{"ok":true}', "https://example.com/v1/messages"), { ok: true })
  assert.deepEqual(
    parseResponseBody(
      [
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      "https://example.com/v1/messages",
    ),
    {
      events: [
        {
          event: "content_block_delta",
          data: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
        },
      ],
    },
  )
})

test("tracedFetch writes request and response rows without consuming the response", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-api-tracer-"))
  try {
    const writer = new TraceWriter({
      dir,
      now: () => new Date("2026-04-25T01:00:00.000Z"),
    })
    const fetchImpl = async (_request: Request) =>
      new Response('{"answer":"OK"}', {
        status: 200,
        headers: { "content-type": "application/json", authorization: "secret-response-token" },
      })

    const response = await tracedFetch(fetchImpl, writer, "https://api.example.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: "secret-request-token",
        "content-type": "application/json",
        "x-opencode-session": "ses_trace",
      },
      body: JSON.stringify({
        model: "demo",
        messages: [{ role: "user", content: "Reply exactly: OK" }],
        tools: [{ name: "bash" }],
      }),
    })

    assert.equal(await response.text(), '{"answer":"OK"}')
    const file = writer.pathForSession("ses_trace")
    assert.ok(file)
    const rows = await waitForRows(file, 2)

    assert.equal(rows.length, 2)
    assert.equal(rows[0].kind, "request")
    assert.equal(rows[1].kind, "response")
    assert.equal((rows[0].headers as Record<string, string>).authorization, "[REDACTED]")
    assert.equal((rows[1].headers as Record<string, string>).authorization, "[REDACTED]")
    assert.deepEqual(rows[1].body, { answer: "OK" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tracedFetch records likely LLM requests without opencode session headers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-api-tracer-"))
  try {
    const writer = new TraceWriter({
      dir,
      sessionID: "run_test",
      now: () => new Date("2026-04-25T01:00:00.000Z"),
    })
    const fetchImpl = async (_request: Request) => new Response('{"answer":"OK"}', { status: 200 })

    await tracedFetch(fetchImpl, writer, "https://api.minimaxi.com/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "secret-request-token",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Reply exactly: OK" }],
      }),
    })

    const file = writer.pathForSession("run_test")
    assert.ok(file)
    const rows = await waitForRows(file, 2)
    assert.equal(rows[0].sessionID, "run_test")
    assert.equal(rows[0].kind, "request")
    assert.equal(rows[1].kind, "response")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function waitForRows(file: string, count: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    const text = readFileSync(file, "utf8").trim()
    const rows = text ? text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : []
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
