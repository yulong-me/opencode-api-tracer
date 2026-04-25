# opencode-api-tracer

Small OpenCode plugin that traces LLM `fetch()` request/response payloads to local JSONL files.

This project is based on the same core idea as `@ljw1004/opencode-trace`: load as an OpenCode plugin, patch `globalThis.fetch`, and only record requests that carry OpenCode session headers.

Phase 1 scope: API request/response/error capture only. It does not yet record file operations, shell commands, or tool events.

## What It Records

- Request URL, method, redacted headers, and JSON body
- Response status, redacted headers, and JSON body
- SSE responses as parsed event lists
- Fetch errors

Sensitive headers such as `authorization`, `x-api-key`, cookies, and token-like headers are redacted.

## Install Locally

From this project:

```bash
npm install
npm run build
```

Add the local package to OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///Users/yulong/work/opencode-api-tracer",
      {
        "dir": "/tmp/opencode-api-tracer-test"
      }
    ]
  ]
}
```

Then restart OpenCode and run a prompt.

You can also use the plugin without an explicit `dir` option and set the output directory per command:

```bash
OPENCODE_API_TRACER_DIR=/tmp/opencode-api-tracer-test opencode run "Reply exactly: OK"
```

## Output

By default logs are written to:

```text
~/opencode-api-tracer/*.jsonl
```

Override the directory:

```bash
OPENCODE_API_TRACER_DIR=/tmp/opencode-traces opencode
```

Or configure it in `opencode.json` with the plugin option:

```json
{
  "plugin": [
    [
      "file:///Users/yulong/work/opencode-api-tracer",
      {
        "dir": "/tmp/opencode-traces"
      }
    ]
  ]
}
```

Each JSONL row has one of these shapes:

```json
{"kind":"request","id":1,"sessionID":"ses_...","method":"POST","url":"...","headers":{},"body":{}}
{"kind":"response","id":1,"sessionID":"ses_...","status":200,"headers":{},"body":{}}
{"kind":"error","id":1,"sessionID":"ses_...","error":"..."}
```

## Interactive Viewer

After OpenCode writes JSONL files, open the radar:

```bash
python3 /Users/yulong/work/opencode-api-tracer/scripts/opencode_api_radar.py /tmp/opencode-api-tracer-test
```

Useful modes:

```bash
# Pick a session, then keep polling for new rows.
python3 /Users/yulong/work/opencode-api-tracer/scripts/opencode_api_radar.py /tmp/opencode-api-tracer-test

# Static history mode.
python3 /Users/yulong/work/opencode-api-tracer/scripts/opencode_api_radar.py /tmp/opencode-api-tracer-test --static

# Open a known session directly.
python3 /Users/yulong/work/opencode-api-tracer/scripts/opencode_api_radar.py /tmp/opencode-api-tracer-test --session ses_...
```

## How It Works

The plugin entrypoint installs a fetch wrapper:

```ts
globalThis.fetch = (input, init) => tracedFetch(originalFetch, writer, input, init)
```

`tracedFetch()` normalizes input into a `Request`, checks for one of:

- `x-opencode-session`
- `x-session-affinity`
- `session_id`

Requests without those headers are passed through without logging.

For matching requests, it reads `request.clone().text()` for the request body, forwards the original request, then reads `response.clone().text()` in the background so the host OpenCode stream remains usable.

## Development

```bash
npm test
npm run typecheck
python3 -m unittest discover -s scripts -p '*_test.py'
```
