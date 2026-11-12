# OpenCode 1.18.12 兼容契约

本机影刀版本为 `6.3.39`，随附原版 agent 的 `--version` 返回 `1.18.12`。原程序 SHA-256 为 `de2e62ab0e3f27a3ea7ff9ef4c4fe7097f0d6df01118b2e7c5f57726256d6314`。

- [schema.sql](schema.sql) 来自本机共享数据库的只读 `.schema` 查询。活动数据库位于 `%LOCALAPPDATA%\ShadowBot\opencode\runtime\shared\xdg_data\opencode\opencode.db`。
- 会话指针位于 `users/{user}/apps/{app}/copilot/agent/sessions/current-session.json`。扩展应用另有 `xbot_extensions/{extension}/.dev/agent/sessions/current-session.json`。
- 影刀本机上下文插件读取 `SHADOWBOT_OPENCODE_WORKSPACE_ROOT`。插件的配置还包括 `SHADOWBOT_OPENCODE_REWRITE_DIR`、证据服务和运行上下文服务地址。

## 影刀原聊天面板录制

[shadowbot-observe.jsonl](shadowbot-observe.jsonl) 来自影刀 6.3.39 中的空白测试应用。启动器透传 `serve --hostname --port` 及宿主提供的工作目录和环境。样本仅保留参数名称、环境变量名称、请求和响应结构、HTTP 状态及已识别事件。

- 宿主轮询 `GET /global/health`，随后通过 `POST /mcp` 注册 `studio-mcp`、`xbot-copilot`。两个服务均报告连接成功，注册配置为 `remote`。Pi 实机日志确认两个服务均通过 Streamable HTTP 建连。
- 宿主创建会话并订阅 `GET /event`，通过同步 `POST /session/{id}/message` 发送带 ID 的消息片段。回复后宿主用 `PATCH /session/{id}/message/{id}/part/{id}` 更新已提交片段的元数据。
- 本次会话选择 `deepseek/deepseek-flash`。宿主生成的 provider 配置只包含凭据和超时选项，模型由目录提供。Pi 使用锁定版本自带的目录补齐模型定义。

## 隔离录制

[opencode-fixture.jsonl](opencode-fixture.jsonl) 由本机原版 `opencode.exe` 和本地模拟模型生成。启动器转发 Basic Auth、`GET /global/health`、`POST /session`、`GET /event` 和 `POST /session/{id}/prompt_async`。`prompt_async` 返回 204。事件包括 `message.updated`、`message.part.updated`、`message.part.delta`、`session.status` 和 `session.idle`。样本保留已识别的结构，移除了时间戳和未识别的事件。

类型基线来自锁定的 `@opencode-ai/sdk@1.18.12`。Pi 侧使用锁定的 `@earendil-works/pi-coding-agent@1.5.2` 和 `@earendil-works/pi-mcp@1.5.2`。Pi 实机已通过影刀本地转发完成平台模型交互。
