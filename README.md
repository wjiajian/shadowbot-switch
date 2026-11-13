# ShadowBot Switch

在 Windows 上为影刀 Copilot 切换 Pi 和影刀自带的 OpenCode。继续使用影刀面板、模型设置、流程工具和网页探索，并添加自定义 Skills 与 MCP。两种后端分别保留聊天记录，切回后可以继续对应的会话。

支持 Windows x64、PowerShell 7、影刀 **6.3.39** 和随附的 OpenCode **1.18.12**。当前项目使用已验证的 Pi **1.5.2**。

## 开始使用

在 [GitHub 项目页](https://github.com/wjiajian/shadowbot-switch) 点击 **Code → Download ZIP**，解压到准备长期保留的目录；也可以使用 `git clone`。在项目根目录打开 PowerShell 7：

```powershell
.\switch.ps1 use pi --wait
```

脚本先准备运行文件，再提示退出影刀。保存工作，从托盘完全退出影刀及 OpenCode；脚本等待退出后完成切换，然后重新打开影刀。新装影刀需先打开一次 Copilot，初始化会话库。

首次安装需要联网。脚本自动下载所需的 Node、npm、Go 和锁定版本的依赖，并完成编译，无需手动安装开发工具。工具缓存在项目的 `.tools/` 中；准备期间仍可使用影刀。影刀安装路径会自动查找，多候选时显示编号供选择，成功安装后记住路径。

```powershell
.\switch.ps1 use pi --shadowbot-dir 'D:\ShadowBot' --wait --timeout 600
```

所有操作都从这个入口执行；从其他工作目录调用脚本的完整路径也可以。原来的 `install.ps1 -Harness pi` / `opencode-origin` 仍可使用。

## 日常命令

```powershell
.\switch.ps1                    # 显示当前后端和操作菜单
.\switch.ps1 use pi             # 复用已安装版本，恢复 Pi 聊天记录
.\switch.ps1 use original       # 恢复影刀原版程序和聊天记录
.\switch.ps1 reload             # 同步菜单，安排配置刷新
.\switch.ps1 status             # 后端、运行应用和配置生效状态
.\switch.ps1 doctor             # 汇总诊断，每个问题附修复提示
.\switch.ps1 help               # 完整命令帮助，未安装时也能用
```

默认输出中文摘要和表格。`--json` 输出机器可读结果；诊断或连接检查失败会返回非零退出码。`help`、`status` 和基础诊断在未安装或安装记录损坏时仍能给出下一步。

切换会检查影刀和 OpenCode 是否退出，并列出占用进程。`--wait` 等待退出，默认最多 300 秒；不会强行结束进程。中断后重跑原命令可恢复，或运行 `repair`。

## 配置范围

默认管理**此安装下的所有应用**，不把终端所在目录当成影刀应用。应用级配置优先于安装级自定义配置。

```powershell
.\switch.ps1 apps list
.\switch.ps1 apps select 'D:\Path\To\App'  # 记住此应用，后续管理命令沿用
.\switch.ps1 skills --app 'D:\Path\To\App' # 只在本次指定应用
.\switch.ps1 skills --global               # 只在本次使用安装级范围
.\switch.ps1 apps clear                    # 清除记忆，恢复安装级默认范围
```

`apps select` 不带路径时可交互选择。应用列表来自已登记的运行实例和当前影刀用户目录，始终显示完整路径。

## Skills

日常只需记住两个目录，放入包含 `SKILL.md` 的文件夹即可使用：

| 范围 | 目录 |
| --- | --- |
| 此安装的所有应用 | `.shadowbot-switch/skills/<名称>/SKILL.md` |
| 单个影刀应用 | `<应用根目录>/.pi/skills/<名称>/SKILL.md` |

也可以用命令自动复制、启用或禁用：

```powershell
.\switch.ps1 skills
.\switch.ps1 skills add 'D:\MySkills\my-skill'
.\switch.ps1 skills disable my-skill
.\switch.ps1 skills enable my-skill
.\switch.ps1 skills remove my-skill
.\switch.ps1 config open skills
```

清单包含启用状态、实际来源、同名覆盖和解析问题。应用级自定义 Skill 覆盖同名安装级 Skill；官方 Skill 名称保留，冲突会显示原因。`remove` 将当前范围的 Skill 移到 `.shadowbot-switch/config-backups/`，可手动恢复。Skill 指令读取与工具权限分开，启用 Skill 不会授予其工具权限。

Skill 内容、增删和权限在下一轮读取。安装级菜单文件自动同步到影刀 `Resources/Copilot/commands/`，也可运行 `reload` 立即同步。**原生 `/` 菜单文件改变后需重新连接 Copilot**；命令输出会报告新增、更新、删除和冲突。应用级 Skill 可直接在聊天中点名，兼容服务的 `/command` 接口也提供当前应用的 Skill 指令。

影刀官方 Skill 的目录联接和 ZIP 解包缓存按实际内容更新。内置的 `shadowbot-flow-edit`、`shadowbot-run-diagnostics` 和 `shadowbot-web-exploration` 提供流程编辑、运行诊断和 Explorer 委派说明。

## MCP

安装级配置位于 `.shadowbot-switch/agent/mcp.json`，应用级位于 `<应用根目录>/.pi/mcp.json`。支持 stdio 和 Streamable HTTP。

`command: "node"` 使用随附 Node；要指定其他 Node 版本，可填写其完整路径。其他外部程序需在本机安装或填写可执行文件路径。

```powershell
.\switch.ps1 mcp                         # 仅查看配置，不启动任何服务
.\switch.ps1 mcp add docs --url 'https://example.com/mcp'
.\switch.ps1 mcp add local-tools --command node --arg 'D:\tools\server.mjs'
.\switch.ps1 mcp disable docs
.\switch.ps1 mcp enable docs
.\switch.ps1 mcp remove docs
.\switch.ps1 config open mcp
.\switch.ps1 config check
.\switch.ps1 mcp test docs               # 在当前终端环境中独立建连检查
.\switch.ps1 mcp status                  # 运行中的 Copilot 实际状态
```

`mcp test` 会启动 stdio 程序或连接远端，结束后关闭测试连接。它使用当前终端的环境变量，不能代替 Copilot 的运行状态。`mcp status` 读取运行实例的状态记录，最多延迟约 2 秒；没有运行实例时显示为空。

配置文件保存后，应用空闲后的下一次请求自动应用改动，无需手动 reload。只重连新增或改变的服务，未变化连接继续使用。替换连接失败时保留原可用连接，`status` / `mcp status` 显示失败原因。配置错误不会使其他可用服务被全部断开。

`reload` 会同步菜单并要求各应用下一次空闲请求复查配置；输出会区分等待请求、运行中和无运行实例。`status` 用于确认最终生效结果。

自定义 MCP 默认询问工具授权。可在 `shadowbot.json` 中配置 `mcpPermission`，或添加服务时指定 `--permission ask|allow|deny`。应用级可用 `{ "enabled": false }` 禁用继承的服务。环境变量使用 `${NAME}`，缺失时报告变量名称而不打印凭据。更改系统环境变量后需重新启动影刀以取得新环境。

[Skill 和权限示例](examples/shadowbot.json) · [MCP 示例](examples/mcp.json)

## 更新、恢复和迁移

```powershell
.\switch.ps1 update --wait
.\switch.ps1 repair --wait
.\switch.ps1 config export 'D:\backup\shadowbot-config.json' --global
.\switch.ps1 config import 'D:\backup\shadowbot-config.json' --global
.\switch.ps1 config check --global
```

`use` 只切换并复用已安装版本。`update` 从当前本地源码构建，使用项目锁定的 Pi 版本，不自动拉取 GitHub 源码或追踪 npm latest；保持原来选择的后端。构建、测试和安装使用同一份依赖锁文件，每个新版运行时携带独立依赖，准备期间不改动旧运行时。

更新时重新下载源码，将解压后的项目文件覆盖到原项目目录，保留 `.shadowbot-switch/`（配置和聊天数据）与 `.tools/`（工具和缓存），再运行 `update --wait`。通过 Git 获取的项目可先拉取源码，再执行同一命令。

`repair` 用于移动整个项目目录后的定位修复及未完成的激活恢复，会核对原程序和启动器。旧项目目录仍存在时拒绝接管，避免混用两套会话。移动整个项目时须保留 `.shadowbot-switch/`。

换设备先在新设备安装，再导入配置。导出包包含所选范围内的配置和自定义 Skill 文件，不包含聊天库或构建缓存。文件中可能有你填写的 MCP 凭据，应保存在自己的备份位置。导入先检查路径及 JSON 配置，遇到同名文件会停止；使用 `--replace` 时先备份到 `.shadowbot-switch/config-backups/`。导入报告不适用于本机的绝对路径，`config check` 可再次检查。

## 本地数据

| 目录 | 内容 |
| --- | --- |
| `.shadowbot-switch/skills/` | 安装级自定义 Skills |
| `.shadowbot-switch/agent/` | 安装级配置及旧 Skill 目录 |
| `.shadowbot-switch/backends/` | 两种后端会话备份、当前会话指针、Pi 原生记录 |
| `.shadowbot-switch/harnesses/pi/releases/` | 每版独立运行时和依赖 |
| `.shadowbot-switch/host-skills/` | 官方 Skill 联接与缓存 |
| `.shadowbot-switch/running/` | 不含凭据的运行实例状态 |
| `.shadowbot-switch/config-backups/` | 导入覆盖前和移除 Skill 的备份 |
| `.tools/` | 源码构建工具和缓存 |

影刀从自己的数据目录读取当前后端的活动会话。切换只恢复对应后端的历史，不恢复业务项目文件。取消聊天后，已经启动的影刀流程可能仍在运行，可在影刀按运行 ID 查询或停止。

## 开发与验证

```powershell
.\scripts\build.ps1       # TypeScript、Go、Node 和 PowerShell 测试
```

[使用体验验收](EXPERIENCE-PLAN.md) · [实施计划](PLAN.md) · [兼容接口](contract/README.md) · [验证记录](TEST-REPORT.md)
