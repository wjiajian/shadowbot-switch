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


## Harness 接入约定

公共管理与宿主兼容层不直接引用引擎 SDK。`src/adapter.ts` 定义适配器契约，`src/harnesses.ts` 按注册信息延迟加载当前适配器。Pi 的执行、模型目录、上下文及 MCP 实现位于 `src/adapters/pi/`。

新增托管 harness：

1. 添加 `harnesses/<id>/harness.json`，声明唯一小写 ID、名称、别名、`kind: "managed"`、版本、适配器入口、启动参数与 Skills/MCP 能力。
2. 实现 `src/adapters/<id>/index.ts`，导出 `adapter: HarnessAdapter`；需要初始化环境时可改为导出 `async initialize(home): Promise<HarnessAdapter>`，在函数中设置环境后动态导入 SDK。`createConfig` 接收宿主模型与认证，`createRuns` 负责执行、取消、原生上下文及会话操作。可选的 `mcp` 实现承载宿主 MCP；`capabilities.mcp` 控制自定义 MCP 的加载，不关闭宿主服务。界面事件和历史通过传入的 `Store` 写入，授权/提问使用 `Interactions`。
3. 如需依赖，在 `harnesses/<id>/package.json` 与锁文件中声明；`versionPackage` 可指定用哪个依赖版本作为适配器版本，否则使用注册中的 `version`。编译测试需要的依赖放在根包的 `devDependencies`，生产 SDK 只安装到该适配器子目录。
4. `launch.executable` 相对于发布目录；参数中的 `{runtime}` 替换为该 harness 已提交的发布目录。使用公共兼容服务时设置 `args: ["{runtime}/service/main.js"]`。运行环境提供 `SHADOWBOT_SWITCH_HOME` 和 `SHADOWBOT_HARNESS`，SDK 专属环境变量由适配器设置。
5. 在隔离测试中注册适配器并验证启动、会话隔离、更新、能力拒绝和恢复；不修改安装器、启动器或切换核心来识别新 ID。

安装记录 `format: 2` 使用 `runtime: { harness, release }` 指向管理运行时，`harnesses[id]` 分别记录各引擎的版本、发布 ID、适配器入口、启动方式与能力；`bundled` 记录宿主自带引擎的 ID 和版本。启动器从当前选择对应的记录启动，更新其他 harness 不改变选择。原版属于唯一的 `bundled` 类型，由影刀维护二进制和版本。注册项可通过 `menuOrder` 固定菜单顺序，输入名称和别名不区分大小写。保留旧 Pi 运行时期间仍写入它读取 schema 所需的 `runtimeRelease/piVersion`，迁移该运行时后移除。

`agent/` 与应用 `.shadowbot-switch/` 保存公共配置，`harnesses/<id>/agent/` 保存适配器私有配置，`backends/<id>/` 保存兼容数据库快照及适配器原生会话。旧 `.pi/` 应用配置仍可读取，新目录优先；旧安装记录、定位文件和 `shadowbot-pi.exe` 名称保留兼容。旧适配数据库的 `pi_file/pi_leaf/pi_entry` 在事务中迁移为中立的 `native_*` 列。

测试夹具 `test/fixtures/harness/` 不接真实模型，也不作为产品引擎注册。它在没有 Pi SDK 的临时运行目录中使用公共 HTTP/SSE 与持久层，作为新增 harness 无需修改公共流程的验收证据。

离线 Skills/MCP 配置管理、导入导出和配置检查由公共层完成，不依赖当前引擎的执行能力或 SDK 能否加载。连接检查才加载支持 MCP 的已安装适配器。应用配置导出按运行时规则合并 `.pi/` 和 `.shadowbot-switch/` 的 MCP 与权限配置；remove 移除当前范围两层的同名资源并保留备份，不删除继承的安装级资源。

自定义 MCP 格式由公共层 `mcp-config.ts` 的类型与 `validateCustomMcp` 定义；适配器的 `reloadCustom` 使用同一校验器后再建立连接，不另用引擎 SDK 重复校验。Pi 的库校验仅用于宿主自带 MCP 的配置转换。适配器契约不再提供单独的 `mcp.validate`。公共层通过 `harnessCapabilities` 统一读取能力，优先使用已安装发布记录，旧清单缺失该记录时才回退到注册默认值。

自定义 MCP 的 `command` 和 `url` 按字段是否存在互斥检查，再验证对应传输字段；即使显式提供 `type` 或另一字段为 `null`，也不能混合两种传输。当前连接实现不提供 OAuth 登录、令牌存储及刷新，因此公共格式拒绝 `oauth`，避免离线检查通过却在连接时忽略认证配置。静态 `headers` 认证继续可用。
