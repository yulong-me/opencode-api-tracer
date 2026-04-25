# opencode-api-tracer

`opencode-api-tracer` 是一个 OpenCode 本地插件，用来记录 OpenCode 运行过程中发出的 LLM API 请求和响应，并把数据写成 JSONL 文件。它的用途类似 `cchistory` / `claude-trace` 这一类工具：不改 OpenCode 源码，通过插件注入，在运行时观察 API 流量。

当前是第一阶段版本，只记录 API 请求、响应和错误。文件操作、shell 命令、工具事件、子 agent 事件会放到后续阶段。

## 功能

- 记录 OpenCode 发出的 LLM API 请求。
- 记录 API 响应，包括普通 JSON 和 SSE 流。
- 每个 session 输出一个 JSONL 文件，方便后续分析。
- 自动脱敏敏感 header，例如 `authorization`、`x-api-key`、cookie、token。
- 提供一个终端交互查看器，可以选择 session、筛选请求、响应和错误、查看 payload。

## 完整使用流程

这条链路覆盖从发布插件到查看请求响应的完整过程：

1. 发布 npm 包。
2. 用 OpenCode 插件机制引用这个 npm 包。
3. 执行一次 OpenCode agent。
4. 插件在运行过程中输出 JSONL 日志。
5. 在终端打开交互查看器，查看 API 请求和响应。

## 发布 npm 包

发布前先确认包内容和测试：

```bash
npm test
npm run typecheck
npm pack --dry-run
```

确认 npm 已登录：

```bash
npm whoami --registry=https://registry.npmjs.org/
```

如果没有登录，先执行：

```bash
npm login --registry=https://registry.npmjs.org/
```

发布：

```bash
npm publish --registry=https://registry.npmjs.org/
```

这个包配置了发布保护：

- `prepublishOnly`：发布前自动执行测试和类型检查。
- `prepack`：打包前自动构建 `dist`。

## 工作方式

插件被 OpenCode 加载后，会包装 `globalThis.fetch`：

```ts
globalThis.fetch = (input, init) => tracedFetch(originalFetch, writer, input, init)
```

每次请求进入包装层后，插件会检查请求 header 里是否存在 OpenCode session 标记：

- `x-opencode-session`
- `x-session-affinity`
- `session_id`

没有这些 session 标记的请求会直接放行，不记录。命中的请求会被 clone 后读取 body，再继续交给原始 `fetch`，所以不会消费 OpenCode 自己要使用的请求或响应流。

## 安装插件

发布到 npm 后，通过 OpenCode 的插件命令安装：

```bash
npm_config_registry=https://registry.npmjs.org/ \
opencode plugin opencode-api-tracer --global
```

这会安装 npm 包并更新 OpenCode 配置。

## 配置 OpenCode 插件

编辑 OpenCode 配置文件：

```bash
~/.config/opencode/opencode.json
```

推荐配置方式是直接在插件参数里写输出目录：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-api-tracer",
      {
        "dir": "/tmp/opencode-api-tracer-test"
      }
    ]
  ]
}
```

如果你不想写 `dir` 参数，也可以只配置插件路径：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-api-tracer"]
}
```

这种情况下默认输出到：

```text
~/opencode-api-tracer
```

也可以在单次命令里用环境变量覆盖输出目录：

```bash
OPENCODE_API_TRACER_DIR=/tmp/opencode-api-tracer-test \
opencode run "Reply exactly: OK"
```

## 快速试用

先清空测试输出目录：

```bash
rm -rf /tmp/opencode-api-tracer-test
```

运行一条 OpenCode 命令：

```bash
OPENCODE_API_TRACER_DIR=/tmp/opencode-api-tracer-test \
opencode run "Reply exactly: OK"
```

也可以指定模型执行：

```bash
OPENCODE_API_TRACER_DIR=/tmp/opencode-api-tracer-test \
opencode run -m provider/model "Reply exactly: OK"
```

确认 JSONL 文件已经生成：

```bash
ls -la /tmp/opencode-api-tracer-test
```

正常情况下会看到类似：

```text
2026-04-25-10-11-56-Reply exactly OK.jsonl
```

## JSONL 格式

每一行是一条独立 JSON 记录。常见记录类型如下。

请求记录示例：

```json
{
  "kind": "request",
  "id": 1,
  "timestamp": "2026-04-25T02:11:56.000Z",
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

响应记录示例：

```json
{
  "kind": "response",
  "id": 1,
  "timestamp": "2026-04-25T02:11:57.000Z",
  "sessionID": "ses_...",
  "method": "POST",
  "url": "https://...",
  "status": 200,
  "statusText": "OK",
  "headers": {},
  "body": {}
}
```

错误记录示例：

```json
{
  "kind": "error",
  "id": 1,
  "timestamp": "2026-04-25T02:11:57.000Z",
  "sessionID": "ses_...",
  "method": "POST",
  "url": "https://...",
  "error": "fetch failed"
}
```

SSE 响应会被解析成：

```json
{
  "body": {
    "events": [
      {
        "event": "content_block_delta",
        "data": {}
      }
    ]
  }
}
```

## 交互查看器

生成 JSONL 后，可以用内置查看器打开：

```bash
npx opencode-api-tracer /tmp/opencode-api-tracer-test
```

启动后会先扫描目录里的 JSONL，列出 session。选择一个 session 后进入 TUI 界面：

- 左侧是事件列表。
- 右侧是当前事件的 payload。
- 顶部按钮可以筛选请求、响应和错误。
- 请求记录会显示 payload 大小和相对上一条请求记录的增长量。
- 支持复制完整 payload 或选中片段。

常用参数：

```bash
# 只看历史，不继续轮询新数据
npx opencode-api-tracer /tmp/opencode-api-tracer-test --static

# 直接打开指定 session
npx opencode-api-tracer /tmp/opencode-api-tracer-test --session ses_...

# 包含标题生成等 meta 请求
npx opencode-api-tracer /tmp/opencode-api-tracer-test --include-meta
```

如果你已经全局安装过这个包，也可以直接运行：

```bash
opencode-api-radar /tmp/opencode-api-tracer-test
```

查看器会自动检查 Python 依赖。如果缺少 `rich`、`textual`、`pygments` 或 `pyperclip`，会尝试用当前 Python 自动安装。

## 开发

如果你是在本仓库里开发插件，先安装依赖并构建：

```bash
npm install
npm run build
```

常用命令：

```bash
npm test
npm run typecheck
python3 -m unittest discover -s scripts -p '*_test.py'
```

`npm test` 会执行：

- TypeScript 构建。
- Node.js 单元测试。
- Python 查看器单元测试。

## 项目结构

```text
src/index.ts                  OpenCode 插件入口
src/tracer.ts                 fetch 包装层、JSONL 写入器、脱敏和解析逻辑
src/*.test.ts                 TypeScript 测试
scripts/opencode_api_radar.py JSONL 交互查看器
scripts/*_test.py             Python 查看器测试
```

## 注意事项

- JSONL 中会包含请求和响应 body。虽然 header 会脱敏，但 prompt、上下文、工具参数仍可能包含敏感信息。
- 不建议把生成的 trace 文件提交到 git。
- 当前版本只捕获带 OpenCode session header 的 `fetch` 请求。
- 当前版本不记录 OpenCode 自身 log 里的 `FileOperationEvent`、shell 命令或工具事件。

## 许可证

MIT
