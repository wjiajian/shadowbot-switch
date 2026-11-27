<div align="center">

# ShadowBot Switch

*给影刀 Copilot 换上其他 agent 引擎，随时一条命令切回原版*

[![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D4?style=flat-square)](#环境要求)
[![PowerShell](https://img.shields.io/badge/PowerShell-7%2B-5391FE?style=flat-square)](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows)
[![ShadowBot](https://img.shields.io/badge/ShadowBot-6.3.39%2B-E8483B?style=flat-square)](#环境要求)
[![Pi](https://img.shields.io/badge/Pi-1.5.2-333333?style=flat-square)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
[![License](https://img.shields.io/github/license/wjiajian/shadowbot-switch?style=flat-square)](LICENSE)

[功能](#功能) • [开始使用](#开始使用) • [日常命令](#日常命令) • [Skills](#skills) • [MCP](#mcp) • [Agent 规则](#agent-规则agentsmd) • [更新与迁移](#更新与迁移) • [开发](#开发)

</div>

ShadowBot Switch 接管影刀 Copilot 背后的 agent 进程，让你在不同 harness 之间切换，同时保留影刀原有的聊天面板、模型设置、工具授权和会话展示。每个 harness 有独立的运行时和聊天记录，切换时互不覆盖。

目前可选两个 harness：

| ID | 名称 | 类型 | Skills / 自定义 MCP |
| --- | --- | --- | --- |
| `pi` | Pi | 托管 | 支持 |
| `original` | 影刀原版 OpenCode | 随影刀附带 | 不支持 |

## 功能

- `use <harness>` 一条命令切换，每个 harness 恢复自己的聊天记录，不动业务项目文件。
- 兼容 OpenCode 的 HTTP/SSE 接口，影刀的面板、授权弹窗、工具卡片照常使用。
- Skills 分安装级和应用级两层目录，同名时应用级优先，安装级 Skill 自动同步到原生 `/` 菜单。
- 自定义 MCP 支持 stdio 和 Streamable HTTP，保存配置后在下一次空闲请求时自动生效。
- 首次运行自动下载并校验 Node、npm、Go，无需自己安装开发工具。
- 每次更新生成独立运行时；切换中断后重跑原命令或 `repair` 即可恢复，`doctor` 给出修复提示。
- 新增 harness 只需注册信息和适配器，不改安装器、启动器或切换核心。

## 工作原理

```mermaid
flowchart LR
    UI[影刀 Copilot 面板] --> L[兼容启动器<br/>替换 opencode.exe]
    L -->|托管 harness| S[兼容服务<br/>HTTP / SSE]
    S --> A[harness 适配器<br/>目前为 Pi]
    A --> MCP[影刀 MCP + 自定义 MCP]
    A --> SK[官方 + 自定义 Skills]
    L -->|original| O[备份的原版 opencode.exe]
```

安装时，Go 编写的启动器替换影刀目录中的 `opencode.exe`，原程序备份。影刀启动 agent 时，启动器按当前选择转发到兼容服务或原版程序，并用 Windows Job Object 管理子进程，避免退出后残留。

## 开始使用

### 环境要求

- Windows x64
- [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows)
- 影刀 **6.3.39 及以上**（更低版本会警告）
- 首次安装需要联网

> [!IMPORTANT]
> 启动器只接管已验证的影刀版本，会校验原版 `opencode.exe`。影刀升级后，需等本项目完成兼容验证再切换。

影刀升级会创建新的版本目录。升级后先看 `status` 或 `doctor`。如果提示仍关联旧目录，请保存工作、退出影刀并执行 `.\switch.ps1 use pi --wait`。如果影刀和本项目同时升级，先拉取源码，退出影刀并运行 `.\switch.ps1 update pi --local-only --wait`。该命令会保留 Pi 版本、重建兼容服务并接入新目录。用 `status` 确认；当前后端已是 Pi 且目录正确时即可启动影刀。若要从原版切到 Pi，再运行 `.\switch.ps1 use pi --wait`。

如果升级期间打开过原版 Copilot，切换前会核对活动会话与托管后端的记录。发现混用时会停止。请退出影刀，完整备份活动数据库及其 WAL、用户目录下的 `current-session.json` 和 `.shadowbot-switch`。保留升级期间的原版会话副本，再用同一时间点的托管数据库、适配器历史和会话指针恢复后重试。

### 安装并切换

1. 在 [GitHub 项目页](https://github.com/wjiajian/shadowbot-switch) 点击 **Code → Download ZIP**，解压到准备长期保留的目录；也可以 `git clone`。
2. 新装的影刀需先打开一次 Copilot，初始化会话库。
3. 在项目根目录打开 PowerShell 7：

   ```powershell
   .\switch.ps1 harnesses          # 查看可用的 harness 和能力
   .\switch.ps1 use pi --wait      # 安装并切换到 Pi
   ```

4. 脚本准备好运行文件后会提示退出影刀。保存工作，从托盘完全退出影刀；脚本检测到退出后完成切换，然后重新打开影刀即可。

脚本会自动查找影刀安装路径，找到多个时显示编号供选择，成功后记住路径。也可以手动指定：

```powershell
.\switch.ps1 use pi --shadowbot-dir 'D:\ShadowBot' --wait --timeout 600
```

准备阶段（下载工具链、编译）期间影刀可以照常使用，工具缓存在项目的 `.tools/` 中。脚本不会强行结束进程，`--wait` 默认最多等待 300 秒。

所有操作都从 `switch.ps1` 进入，从其他目录用完整路径调用也可以。旧入口 `install.ps1 -Harness <harness>` 仍然可用，原版也可以用旧名 `opencode-origin`。

## 图形界面

不想记命令时，可以用本地图形界面管理 harness 和日常配置：

```powershell
.\ui.ps1                 # 或 .\switch.ps1 ui，菜单里按 u
.\ui.ps1 -NoBrowser      # 不自动开窗口，只打印地址
```

- **Harness**：安装、切换、更新，切换时显示进度和日志，等待影刀退出时可以停止。首次安装前可以修改影刀安装目录。
- **Skills / MCP**：按范围查看、启用、停用、添加、移除；MCP 可以单独测试连接。
- **规则**可编辑安装级和应用级 AGENTS.md，显示 UTF-8 字节数、换行方式和生效路径。保存前会检查文件是否已被其他程序修改。
- **配置**可调整 MCP 授权顺序和安装级 `/thinking` 开关、预览导入、下载配置包、恢复备份和管理应用路径。
- **诊断**列出检查结果、运行实例的 PID、配置应用情况、MCP 错误和最近的切换记录。

已有安装更新源码后，运行 `.\switch.ps1 update <托管 harness> --wait` 重建运行时，新的界面命令随运行时生效。

## 日常命令

```powershell
.\switch.ps1                    # 当前后端和操作菜单
.\switch.ps1 use <harness>      # 复用已安装版本，恢复该 harness 的聊天记录
.\switch.ps1 use original       # 恢复影刀原版程序和聊天记录
.\switch.ps1 update [harness]   # 更新指定或当前 harness，不改变当前选择
.\switch.ps1 reload             # 同步 Skill 菜单，安排 MCP 配置刷新
.\switch.ps1 status             # 后端、运行中的应用和配置生效状态
.\switch.ps1 log --limit 20 --offset 0  # 最近切换记录，最新的在前
.\switch.ps1 doctor             # 完整诊断，每个问题附修复提示
.\switch.ps1 ui                 # 打开图形界面
.\switch.ps1 help               # 完整命令帮助，未安装时也可用
```

通用选项：

| 选项 | 作用 |
| --- | --- |
| `--json` | 输出机器可读结果；诊断或连接检查失败时返回非零退出码 |
| `--global` | 本次只操作安装级配置 |
| `--app <路径>` | 本次只操作指定影刀应用 |
| `--wait` / `--timeout <秒>` | 切换时等待影刀退出 |
| `--shadowbot-dir <路径>` | 指定影刀安装目录 |

### 配置范围

默认管理**此安装下的所有应用**，不会把终端所在目录当成影刀应用。应用级配置优先于安装级。

```powershell
.\switch.ps1 apps add 'D:\Path\To\App'     # 登记手动路径
.\switch.ps1 apps list
.\switch.ps1 apps remove 'D:\Path\To\App'  # 仅移除登记
.\switch.ps1 apps select 'D:\Path\To\App'  # 记住此应用，后续命令沿用
.\switch.ps1 apps clear                    # 恢复安装级默认范围
```

`apps select` 不带路径时可交互选择。应用列表汇总运行实例、影刀用户目录和手动添加的路径。`apps clear` 清除选择，手动登记会保留。新配置写入应用下的 `.shadowbot-switch/`；旧版的 `.pi/` 配置继续读取，同名时新目录优先。

## Skills

把包含 `SKILL.md` 的文件夹放进以下目录即可使用：

| 范围 | 目录 |
| --- | --- |
| 此安装的所有应用 | `.shadowbot-switch/skills/<名称>/SKILL.md` |
| 单个影刀应用 | `<应用根目录>/.shadowbot-switch/skills/<名称>/SKILL.md` |

也可以用命令管理：

```powershell
.\switch.ps1 skills                             # 来源、启用状态、覆盖和解析问题
.\switch.ps1 skills add 'D:\MySkills\my-skill'
.\switch.ps1 skills disable my-skill
.\switch.ps1 skills enable my-skill
.\switch.ps1 skills remove my-skill             # 移到 config-backups/，可手动恢复
.\switch.ps1 config open skills
```

Skill 的内容、增删和权限在下一轮对话生效。启用 Skill 不会授予它工具权限，两者分开管理。官方 Skill 名称保留，冲突时清单会说明原因。

安装级 Skill 会自动同步到影刀的 `Resources/Copilot/commands/`，即原生 `/` 菜单。菜单文件变化后需**重新连接 Copilot** 才会显示。应用级 Skill 可以直接在聊天中点名使用。

项目内置三个 Skill：`shadowbot-flow-edit`（流程编辑）、`shadowbot-run-diagnostics`（运行诊断）和 `shadowbot-web-exploration`（Explorer 委派），见 [skills/](skills/)。

### 在聊天中调整思考强度

目前只有 Pi 支持以下命令。

- `/thinking`：查看当前档位，以及当前模型支持哪些档位。
- `/thinking <档位>`：设置当前会话的档位，例如 `/thinking high`。
- 原生 `/` 菜单里也有 `thinking` 入口，用法相同。

命令由接入程序直接处理，不调用模型，也不写入聊天上下文。档位按会话保存，从下一次请求生效，服务重启后继续沿用，不需要重启影刀。会话正在生成时只能查询，不能修改。

可选档位取决于模型，非推理模型只支持 `off`。切换模型后，如果原档位不受支持，请求会提示你用 `/thinking` 重新设置。

在配置页的安装级设置中可关闭 `/thinking`，对应 `.shadowbot-switch/agent/shadowbot.json` 中的 `"thinkingCommand": false`。关闭后会移除生成的菜单项，直接发送的 `/thinking high` 会作为普通消息处理。应用级同名字段只会产生提示。

首次使用需执行 `.\switch.ps1 update pi --wait` 更新运行时。如果 `/` 菜单里仍然没有 `thinking`，重新连接 Copilot 即可。已有同名的自定义 `thinking` 命令时，菜单入口优先使用你自己的。

## MCP

| 范围 | 配置文件 |
| --- | --- |
| 此安装的所有应用 | `.shadowbot-switch/agent/mcp.json` |
| 单个影刀应用 | `<应用根目录>/.shadowbot-switch/mcp.json` |

```powershell
.\switch.ps1 mcp                                # 只查看配置，不启动服务
.\switch.ps1 mcp add docs --url 'https://example.com/mcp'
.\switch.ps1 mcp add local-tools --command node --arg 'D:\tools\server.mjs' --permission ask
.\switch.ps1 mcp disable docs
.\switch.ps1 mcp enable docs
.\switch.ps1 mcp remove docs
.\switch.ps1 config check
.\switch.ps1 mcp test docs                      # 在当前终端环境中独立建连检查
.\switch.ps1 mcp status                         # 运行中 Copilot 的实际连接状态
```

配置规则：

- 每个服务只能填 `command`（stdio）或 `url`（HTTP）之一，同时填写会报错。
- 不支持 OAuth，含 `oauth` 字段会报错。静态令牌可写在 `headers` 中，例如 `"Authorization": "Bearer ${MCP_TOKEN}"`。
- 环境变量写成 `${NAME}`，缺失时只报告变量名，不打印凭据。修改系统环境变量后需重启影刀。
- `command: "node"` 使用随附的 Node；其他程序需在本机安装，或填写完整路径。
- 工具授权默认为询问，可用 `--permission ask|allow|deny` 或 `shadowbot.json` 的 `mcpPermission` 调整。应用级可用 `{ "enabled": false }` 禁用继承的服务。

配置保存后，应用在下一次空闲请求时自动应用改动：只重连新增或变化的服务；新连接失败时保留原来可用的连接，失败原因显示在 `status` / `mcp status` 中。`mcp test` 使用当前终端的环境变量，结果不等同于 Copilot 内的运行状态；`mcp status` 读取运行实例的记录，约有 2 秒延迟。

示例：[examples/mcp.json](examples/mcp.json) · [examples/shadowbot.json](examples/shadowbot.json)

在 `mcpPermission` 中，工具名形如 `docs_search`，最后命中的授权规则生效。将默认授权 `"*"` 放在第一位，例如 `{"*":"ask","docs_*":"allow"}`。安装级、旧应用目录和当前应用目录按顺序合并，同名规则更新授权并保留原位置。配置页的“当前生效的授权规则”显示合并后的顺序。

`settings show --json` 返回当前文件摘要。使用 `settings save --from patch.json --expect <摘要>` 可只修改授权和功能开关，文件不存在时传 `absent`。补丁示例：

```json
{"version":1,"mcpPermission":[{"pattern":"*","action":"ask"},{"pattern":"docs_*","action":"allow"}],"thinkingCommand":false}
```

省略字段会保留当前值。`mcpPermission: []` 清除本层授权，`thinkingCommand: null` 恢复默认开关。Skill 状态和其他字段会保留。

## AGENTS.md

托管 harness（目前为 Pi）会自动加载两层规则，影刀原版 OpenCode 不使用：

- 安装级：本项目的 `.shadowbot-switch/agent/AGENTS.md`，适用于所有影刀应用。
- 应用级：`<影刀应用根目录>/AGENTS.md`，只适用于当前应用，冲突时优先于安装级。根目录没有这个文件时，改读 `.shadowbot-switch/AGENTS.md`（导入配置时写在这里）。

应用根目录指影刀传给 Copilot 的应用工作区，不是本仓库目录。

规则每轮对话重新读取，保存后下一轮生效，不需要 reload。主 Agent 和它发起的子 Agent（如浏览器探索）都会加载。只读取上面两个位置，不扫描父目录或子目录；规则也不会改变工具授权。

规则文件须为 UTF-8，每层最多 32 KiB，不能是指向所在目录之外的链接。不符合要求的文件会整个跳过，不会截断。可用 `.\switch.ps1 config check` 或 `doctor` 检查，应用级加 `--app <应用根目录>`。`config export --app` 会一并导出应用规则。

从规则页或 `rules show --json` 查看每层的生效状态和文件摘要。根目录已有 AGENTS.md 时，空文件或无效文件也会阻止回退规则生效。两处都没有时，应用级编辑器在 `.shadowbot-switch/AGENTS.md` 新建文件。

```powershell
.\switch.ps1 rules show --global --json
.\switch.ps1 rules save --global --scope installation --from .\AGENTS.md --expect absent
.\switch.ps1 rules remove --app 'D:\Apps\demo' --scope application --expect <摘要>
```

## 更新与迁移

```powershell
.\switch.ps1 update <harness> --wait            # 即使当前用原版，也可以更新托管 harness
.\switch.ps1 repair --wait                      # 搬迁项目目录或中断后恢复
.\switch.ps1 config export 'D:\backup\shadowbot-config.json' --global
.\switch.ps1 config import 'D:\backup\shadowbot-config.json' --global
```

**更新本项目**：重新下载源码，覆盖到原项目目录，保留 `.shadowbot-switch/`（配置和聊天数据）与 `.tools/`（工具缓存），再对要用的托管 harness 运行 `update <harness> --wait`。用 Git 获取的项目先 `git pull` 再执行同一命令。托管 harness 声明上游后，`update` 会在各包共同发布的稳定版本中选择同主版本的最高版本（0.x 还要求次版本相同），跳过已弃用版本。原版 OpenCode 随影刀更新，`update original` 只会给出说明；当前使用原版时，不带参数的 `update` 也一样，要重建托管 harness 请写明 ID，例如 `update pi`。

首次 `use` 联网时安装最新兼容版，查询或生成依赖锁失败时回退到仓库锁定版本，离线时直接使用仓库锁。影刀升级后重新运行 `use <harness>` 即可刷新原版备份并切换，`repair` 保留已装版本。用 `update pi --check` 只查版本，或用 `update --check --all --json` 输出全部结果。检查时无需退出影刀。

- `update pi --version 1.6.3` 指定精确版本，可跨主版本、试用预发布或回滚。下次普通更新仍会向兼容的新版本前进。
- `update pi --local-only` 跳过查询，按当前依赖计划应用本地源码。仓库基线追平已装的自动升级版本时，改用仓库锁文件。
- `update pi --pinned` 恢复仓库锁定版本。离线模式跳过上游查询，npm-cache 需包含所选锁文件对应的全部包。

升级锁文件位于 `.shadowbot-switch/harnesses/<id>/dependencies/`，不会改写 Git 跟踪的依赖文件。普通卸载会清理这些锁文件并保留 agent 数据。TypeScript 使用项目根目录 devDependencies 的类型编译，发布后适配器从自己的 node_modules 加载 SDK，激活前由 `verify-install` 校验实际加载的适配器和版本。

**搬迁目录**：移动整个项目目录（包括 `.shadowbot-switch/`）后运行 `repair`。旧目录仍存在时会拒绝接管，避免两套会话混用。

**换设备**：先在新设备安装，再导入配置。导出包含所选范围的配置和自定义 Skill，不含聊天库和构建缓存。导入遇到同名文件会停止；加 `--replace` 时先备份到 `.shadowbot-switch/config-backups/` 再覆盖。

导入前可以加 `--dry-run` 查看全部新建、覆盖和冲突路径。实际导入、移除 Skill/MCP、覆盖或删除规则、覆盖设置时，程序会在 `config-backups/<编号>.backup.json` 记录原目标与文件类型。恢复导入可删除该次新建的文件。恢复之前也会自动备份当前状态，返回的编号可用于撤销这次恢复。旧备份没有清单，可打开目录手动取回文件。

```powershell
.\switch.ps1 config import .\config.json --global --dry-run
.\switch.ps1 config backups --global --limit 20
.\switch.ps1 config restore <编号> --global --dry-run
.\switch.ps1 config restore <编号> --global
```

> [!WARNING]
> 导出文件可能包含你填写的 MCP 凭据，请保存在私人位置。

## 下载源与离线安装

`use`、`update` 和 `repair` 支持 `--mirror direct`（官方源）与 `--mirror aliyun`。例如：

```powershell
.\switch.ps1 use pi --mirror aliyun --wait
.\switch.ps1 update pi --offline-dir 'D:\工具链' --wait
```

`install.ps1` 和 `scripts/build.ps1` 对应参数为 `-Mirror` 和 `-OfflineToolchainDir`。也可设置环境变量 `SHADOWBOT_SWITCH_MIRROR` 和 `SHADOWBOT_SWITCH_OFFLINE_DIR`。显式参数优先。未指定镜像参数时，可用 `SHADOWBOT_SWITCH_NODE_BASE_URL`、`SHADOWBOT_SWITCH_NPM_REGISTRY`、`SHADOWBOT_SWITCH_GO_BASE_URL`、`SHADOWBOT_SWITCH_GOPROXY` 分别覆盖下载地址。交互安装需要构建且没有配置下载源或离线目录时，会提示选择源，回车使用官方源。传入 `--json` 时跳过下载源提示。图形界面在 Harness 页记住当前浏览器的下载源选择。

WebUI 的「检查更新」可查看上游候选版本、另有的新主版本和上次检查时间。WebUI 的下载源默认为「默认（跟随环境）」。安装、更新和修复都可以显式选择官方源或阿里云镜像。

使用 `--offline-dir <目录>` 时，优先复用项目 `.tools/` 中的工具。Node 按 SHA256 校验，已解压的 npm、Go 按固定版本的文件清单逐项核对相对路径和大小。工具缺失或清单不符时，先查找项目内已缓存的压缩包，再从离线目录读取以下文件，并校验固定哈希：

```text
node.exe                    # 也支持 v24.22.3/win-x64/node.exe
npm-11.17.0.tgz
go1.25.0.windows-amd64.zip
npm-cache/                  # 可选，复制自 .tools/npm-cache/
go-mod/                     # 可选，复制自 .tools/go-work/pkg/mod/，也可放在 pkg/mod/
```

完整离线构建需要按相同锁文件预热依赖，npm 下载源应与预热时一致。依赖缓存可留在项目内，也可按上面的结构放入离线目录。默认卸载会删除项目内的 `.tools/` 缓存。

## 卸载

运行 `.\switch.ps1 uninstall --wait`，或在 Harness 页点击「卸载 ShadowBot Switch」并确认。卸载会等影刀退出、切回原版会话，删除本项目的运行时、`.tools/`、`dist/` 和根目录及各 harness 的 `node_modules/`。默认保留 `.shadowbot-switch/` 下的会话备份、安装级 Skill、安装级配置和偏好。各 harness 仅清理 releases 子目录，适配器专属配置继续保留。影刀程序或安装记录缺失时，默认保留 `original/` 原版备份。只想切回原版并保留工具链时，使用 `.\switch.ps1 use original --wait`。

加 `--purge-data` 可永久删除整个 `.shadowbot-switch/`。无人值守时必须显式传入 `--yes`。可用 `--shadowbot-dir` 核对影刀目录、`--timeout` 设置等待秒数、`--json` 获取恢复、删除和保留的路径，以及清理失败的路径与原因。

## 本地数据

| 目录 | 内容 |
| --- | --- |
| `.shadowbot-switch/skills/` | 安装级自定义 Skills |
| `.shadowbot-switch/agent/` | 安装级配置及旧 Skill 目录 |
| `.shadowbot-switch/backends/` | 各 harness 的会话快照、当前会话指针与原生记录 |
| `.shadowbot-switch/harnesses/<id>/releases/` | 每个版本独立的运行时和依赖 |
| `.shadowbot-switch/harnesses/<id>/agent/` | 适配器专属配置（如 Pi SDK 的 agent 目录） |
| `.shadowbot-switch/host-skills/` | 官方 Skill 联接与缓存 |
| `.shadowbot-switch/running/` | 运行实例状态（不含凭据） |
| `.shadowbot-switch/config-lock.sqlite` | 协调 CLI 和界面同时写入配置 |
| `.shadowbot-switch/apps.json` | 手动添加的应用目录 |
| `.shadowbot-switch/ui-staging/` | 界面编辑与导入导出的临时文件 |
| `.shadowbot-switch/config-backups/` | 配置变更与恢复前的备份、清单和应用范围记录 |
| `.tools/` | 构建工具和缓存 |

切换只恢复对应后端的聊天历史，不恢复业务项目文件。取消聊天后，已经启动的影刀流程可能仍在运行，可以在影刀中按运行 ID 查询或停止。

## 开发

```powershell
.\scripts\build.ps1       # 构建并运行 TypeScript、Go、Node 和 PowerShell 测试
```

项目结构：

```text
switch.ps1 / install.ps1   命令入口与安装流程
ui.ps1 / ui/               图形界面入口与静态页面（服务在 scripts/ui-server.ps1）
scripts/                   工具链、发现、激活、进程等 PowerShell 模块
launcher/                  Go 兼容启动器（替换 opencode.exe）
src/                       公共管理层与影刀兼容服务（TypeScript）
src/adapters/<id>/         各 harness 适配器
harnesses/<id>/            harness 注册信息与适配器依赖锁文件
contract/                  OpenCode 兼容契约与接口录制
test/                      Node、Go、PowerShell 测试及测试用适配器
```

想接入新的 harness，参见 [Harness 接入约定](contract/README.md#harness-接入约定)。`test/fixtures/harness/` 中的测试适配器只在隔离测试中注册，可作为参考。
