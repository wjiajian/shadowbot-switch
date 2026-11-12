# ShadowBot Switch

在 Windows 上为影刀 Copilot 切换 Pi 和影刀自带的 OpenCode。启用 Pi 后，可以继续在影刀原有面板中使用已配置的模型、流程工具和网页探索，并为项目添加自定义 Skills 和 MCP。两种后端各自保留会话，切换后可以接着使用对应的聊天记录。

## 快速开始

需要 Windows x64、PowerShell 7，以及影刀 **6.3.39**（随附 OpenCode **1.18.12**）。首次安装 Pi 需要联网，脚本会下载 Node.js、npm 和 Go 到项目的 `.tools` 目录。

1. 如果是新安装的影刀，先打开一次 Copilot，初始化会话库。
2. 从托盘完全退出影刀，并关闭正在运行的 OpenCode。
3. 在项目根目录运行安装脚本。

   ```powershell
   .\install.ps1
   ```

4. 选择 `pi`，等待终端显示 `Active harness: pi`，然后重新打开影刀。

首次安装 Pi 时，脚本从 npm 获取最新稳定版。之后切换会复用本地已安装的版本。安装预检会核对影刀原版程序的校验值和会话库结构。

## 切换和回退

菜单提供两个选项，也可以通过 `-Harness` 直接指定。

| 选项 | 命令 | 行为 |
| --- | --- | --- |
| `pi` | `.\install.ps1 -Harness pi` | 启用 Pi，恢复 Pi 的聊天记录和当前会话。 |
| `opencode-origin` | `.\install.ps1 -Harness opencode-origin` | 恢复影刀原版 `opencode.exe`、会话库和当前会话。Pi 的会话和配置可在下次切回时继续使用。 |

> [!IMPORTANT]
> 切换期间请保持影刀和 OpenCode 关闭。如果安装或切换中断，退出两者后重新运行同一条命令，脚本会先处理待恢复的操作。

### 安装目录和换设备

脚本先检查本地安装记录，再通过 Windows 注册表和开始菜单快捷方式查找影刀。自动定位失败或发现多个安装位置时，可以指定包含 `ShadowBot.exe` 的目录。

```powershell
.\install.ps1 -Harness pi -ShadowBotDirectory 'D:\ShadowBot'
```

在新设备获取项目源码并重新运行安装脚本，影刀资源目录、用户会话库和官方 Skill 路径都会按本机位置重新确定。要迁移自定义配置，可以单独复制项目的 `.shadowbot-switch/agent/`，并调整其中指向其他程序的绝对路径。

## Skills 和 MCP

| 配置范围 | Skill 文件 | 启用 Skill | MCP 配置 |
| --- | --- | --- | --- |
| 此安装下的所有应用 | `.shadowbot-switch/agent/skills/<名称>/SKILL.md` | `.shadowbot-switch/agent/shadowbot.json` | `.shadowbot-switch/agent/mcp.json` |
| 单个影刀应用 | `.pi/skills/<名称>/SKILL.md` | `.pi/shadowbot.json` | `.pi/mcp.json` |

应用级路径相对于该影刀应用的根目录。在对应的 `shadowbot.json` 的 `enabledSkills` 中填写自定义 Skill 名称。自定义 MCP 支持 stdio 和 Streamable HTTP，工具调用默认需要授权，可以通过 `mcpPermission` 配置。 [Skill 启用和授权示例](examples/shadowbot.json) · [MCP 配置示例](examples/mcp.json)

影刀的 `xbot-web-exploration` 通过 Windows 目录联接读取。`web-automation`、`xbot-rpa-builtins` 和 `xbot-sdk` 的 ZIP 内容变化后，下次加载 Skill 会自动刷新项目里的解包缓存。仓库内的三个 `shadowbot-*` Skill 提供流程编辑、运行诊断和 Explorer 委派的桥接说明。

## 检查安装和配置

安装过 Pi 后，在项目根目录可以运行以下命令。将示例路径替换为实际的影刀应用根目录。

```powershell
$control = '.\.shadowbot-switch\shadowbot-pi.exe'
& $control doctor
& $control skills list 'D:\Path\To\App'
& $control mcp list 'D:\Path\To\App'
& $control reload
```

`doctor` 显示当前后端和恢复状态。`reload` 会在应用空闲后的下一次 Copilot 请求中重新加载自定义 MCP 配置。影刀已经启动的流程可以在影刀里按运行 ID 查询和停止。

## 本地数据

| 目录 | 内容 |
| --- | --- |
| `.shadowbot-switch/agent/` | 项目级自定义 Skills 和 MCP 配置 |
| `.shadowbot-switch/backends/` | 两种后端的会话备份、当前会话指针和 Pi 原生记录 |
| `.shadowbot-switch/host-skills/` | 影刀官方 Skill 的目录联接和解包缓存 |
| `.shadowbot-switch/harnesses/pi/` | Pi 依赖和桥接运行时 |
| `.tools/` | 安装脚本下载的构建工具和缓存 |

影刀继续从自己的数据目录读取当前后端的活动会话。旧版 ShadowBot Pi 的数据会在首次接管时复制到项目的本地数据目录。

## 构建与验证

```powershell
.\scripts\build.ps1
```

构建脚本使用锁定的 Pi SDK 运行 Node.js、Go 和 PowerShell 测试，并在 `dist/` 生成桥接服务和启动器。 [实施计划](PLAN.md) · [兼容接口](contract/README.md) · [实机和自动化验证记录](TEST-REPORT.md)
