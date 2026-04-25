# opencode-api-tracer 使用手册

`opencode-api-tracer` 是一个 OpenCode 插件，用来记录 OpenCode 运行过程中发出的 LLM API 请求和响应，并输出为 JSONL 文件。

npm 包地址：<https://www.npmjs.com/package/opencode-api-tracer>

当前版本只记录 API 请求、响应和错误；不记录文件操作、shell 命令或工具事件。

## 1. 安装插件

```bash
npm_config_registry=https://registry.npmjs.org/ \
opencode plugin opencode-api-tracer@0.1.6 --global --force
```

安装完成后，OpenCode 会把插件写入全局配置文件：

```text
~/.config/opencode/opencode.json
```

## 2. 配置输出目录

推荐在 `opencode.json` 里配置 JSONL 输出目录：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-api-tracer@0.1.6",
      {
        "dir": "/tmp/opencode-api-tracer"
      }
    ]
  ]
}
```

如果只写插件名：

```json
{
  "plugin": ["opencode-api-tracer@0.1.6"]
}
```

默认会输出到：

```text
~/opencode-api-tracer
```

也可以用环境变量临时指定目录：

```bash
OPENCODE_API_TRACER_DIR=/tmp/opencode-api-tracer \
opencode run "Reply exactly: OK"
```

## 3. 执行 OpenCode

运行一次 agent：

```bash
opencode run "Reply exactly: OK"
```

如果想指定模型：

```bash
opencode run -m provider/model "Reply exactly: OK"
```

运行过程中，插件会把 API 请求和响应写入配置的目录。

确认是否生成日志：

```bash
ls -la /tmp/opencode-api-tracer
```

正常会看到 `.jsonl` 文件，例如：

```text
2026-04-25-10-41-09-Reply exactly OK.jsonl
```

## 4. 查看请求和响应

使用内置终端查看器：

```bash
npx --registry=https://registry.npmjs.org/ opencode-api-tracer /tmp/opencode-api-tracer
```

启动后会先列出 session，选择一个 session 后进入列表界面。

查看器里可以做这些事：

- 查看 API 请求。
- 查看 API 响应。
- 查看错误记录。
- 筛选请求、响应和错误。
- 查看 payload 大小。
- 复制完整 payload 或选中的片段。

常用参数：

```bash
# 只查看历史，不继续监听新日志
npx --registry=https://registry.npmjs.org/ opencode-api-tracer /tmp/opencode-api-tracer --static

# 直接打开指定 session
npx --registry=https://registry.npmjs.org/ opencode-api-tracer /tmp/opencode-api-tracer --session ses_...

# 包含标题生成等 meta 请求
npx --registry=https://registry.npmjs.org/ opencode-api-tracer /tmp/opencode-api-tracer --include-meta
```

如果你已经全局安装过这个包，也可以直接运行：

```bash
opencode-api-radar /tmp/opencode-api-tracer
```

## 5. JSONL 内容

每一行是一条 JSON 记录。

请求示例：

```json
{
  "kind": "request",
  "id": 1,
  "timestamp": "2026-04-25T02:41:09.000Z",
  "sessionID": "ses_...",
  "method": "POST",
  "url": "https://...",
  "headers": {
    "authorization": "[REDACTED]",
    "content-type": "application/json"
  },
  "body": {}
}
```

响应示例：

```json
{
  "kind": "response",
  "id": 1,
  "timestamp": "2026-04-25T02:41:10.000Z",
  "sessionID": "ses_...",
  "method": "POST",
  "url": "https://...",
  "status": 200,
  "statusText": "OK",
  "headers": {},
  "body": {}
}
```

错误示例：

```json
{
  "kind": "error",
  "id": 1,
  "timestamp": "2026-04-25T02:41:10.000Z",
  "sessionID": "ses_...",
  "method": "POST",
  "url": "https://...",
  "error": "fetch failed"
}
```

敏感 header 会被自动脱敏，例如：

- `authorization`
- `x-api-key`
- cookie
- token 类 header

## 6. 注意事项

- JSONL 里会包含 prompt、上下文和响应内容，不要随便提交到 git。
- OpenCode 1.3+ 通常会带真实 session 标记，JSONL 里的 `sessionID` 类似 `ses_...`。
- OpenCode 1.2.x 的模型请求可能没有 session 标记，插件会用 `run_<pid>_<id>` 作为 fallback session。
- 插件只记录带 OpenCode session 标记的请求，或明显像 LLM API 的 POST 请求；普通网页请求不会记录。
- 内部改造版如果模型请求没有 provider header，只要是 POST 且 URL 像 LLM endpoint，也会默认记录。
- 如果你使用 npm mirror，可能遇到版本同步延迟；安装和查看命令里指定 `https://registry.npmjs.org/` 最稳。
- 查看器第一次运行时会检查 Python 依赖，缺少 `rich`、`textual`、`pygments` 或 `pyperclip` 时会尝试自动安装。

## 7. 常见问题

如果 OpenCode log 里出现：

```text
Cannot call a class constructor TraceWriter without new
```

或：

```text
fn5 is not a function
```

说明加载到了旧版本插件，或 OpenCode 版本使用了不同的插件入口形态。强制重新安装最新版本：

```bash
npm_config_registry=https://registry.npmjs.org/ \
opencode plugin opencode-api-tracer@0.1.6 --global --force
```

确认配置里只保留 npm 包名，不要同时保留旧的本地 `file://...` 插件：

```json
{
  "plugin": ["opencode-api-tracer@0.1.6"]
}
```

如果 OpenCode 1.2.x 能正常运行但没有生成 JSONL，请确认版本至少是 `0.1.3`。`0.1.2` 依赖 session header，而 OpenCode 1.2.x 的模型请求可能没有这个 header。

如果内部硬编码模型调用没有常见 provider header，`0.1.6` 起默认也会记录，只需要正常配置插件：

```json
{
  "plugin": [
    [
      "opencode-api-tracer@0.1.6",
      {
        "dir": "/tmp/opencode-api-tracer"
      }
    ]
  ]
}
```

也可以临时用环境变量指定输出目录：

```bash
OPENCODE_API_TRACER_DIR=/tmp/opencode-api-tracer \
opencode run "Reply exactly: OK"
```

默认只记录 POST 且 URL 像 `/messages`、`/chat/completions`、`/responses` 等模型 endpoint 的请求。

## 8. 诊断模式

插件默认会写诊断日志，位置在 trace 目录下：

```text
/tmp/opencode-api-tracer/opencode-api-tracer.debug.jsonl
```

运行：

```bash
OPENCODE_API_TRACER_DIR=/tmp/opencode-api-tracer \
opencode run "Reply exactly: OK"
```

诊断日志只记录元信息，不记录请求 body，也不记录 header 值。它会记录：

- 插件是否初始化：`install.start`
- 是否成功 patch `globalThis.fetch`：`install.patched`
- 是否看到了 fetch 调用：`fetch.seen`
- 是否追踪该请求：`fetch.traced`
- 如果跳过，为什么跳过：`fetch.skipped`
- JSONL 是否写入成功：`jsonl.write.success`
- 进程退出前的计数：`process.summary`

快速查看：

```bash
tail -n 50 /tmp/opencode-api-tracer/opencode-api-tracer.debug.jsonl
```

如果要指定诊断日志路径：

```bash
OPENCODE_API_TRACER_DEBUG_FILE=/tmp/opencode-api-tracer.debug.jsonl \
OPENCODE_API_TRACER_DIR=/tmp/opencode-api-tracer \
opencode run "Reply exactly: OK"
```

如果要关闭诊断日志：

```bash
OPENCODE_API_TRACER_DEBUG=0 \
opencode run "Reply exactly: OK"
```

常见判断：

| 诊断日志现象 | 含义 |
|---|---|
| 没有 `install.start` | 插件没有被 OpenCode 加载，先检查 `opencode.json` 的 `plugin` |
| 有 `install.patched`，但没有 `fetch.seen` | 模型请求没有走当前进程的 `globalThis.fetch`，可能走子进程、native、RPC、`http/https` 或内部服务 |
| 有 `fetch.seen`，全是 `fetch.skipped` | 请求走了 fetch，但不符合当前过滤规则，看 `reason` |
| `reason=method-not-post` | 不是 POST 请求 |
| `reason=missing-provider-header` | 没有 provider/header 特征，且显式关闭了无 provider header 兼容策略 |
| `reason=missing-provider-header-not-llm-endpoint` | 没有 provider/header 特征，并且 URL 不像模型 endpoint |
| `reason=not-llm-endpoint` | URL 不像 `/messages`、`/chat/completions`、`/responses` 等 LLM endpoint |
| 有 `fetch.traced`，但没有 `jsonl.write.success` | 写文件失败，看 `jsonl.write.error` |

如果只有 `install.patched` 没有任何 `fetch.seen`，这个插件层已经无法证明真实网络请求内容；下一步要么在内部 OpenCode 源码的模型调用处埋点，要么使用代理/MITM 或更底层的 `http/https/undici` hook。
