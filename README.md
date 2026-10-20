# Claude Bridge · Windows 桌面托盘版 v1.0.2

多台电脑安装同一个客户端，各端登录同一个 Tailscale 账号。每份实例选择一个固定方向的身份：A 调用端连接一台 B，B 服务端接受已授权的 A。模型服务和网络共享分别配置、分别启停；仅使用网络共享时不需要安装 Claude。B 的模型服务使用已安装并登录的官方 Claude Code，为 A 上的 DeepSeek Harness 提供主模型决策；Harness 的文件和终端工具在 A 执行。

```text
A 上 Harness → A 本机 /v1/chat/completions → 加密连接 → B 的官方 Claude Code
      ↑                                                   ↓
      └── A 执行工具 → 下一轮带回结果 ← 回答 / 结构化工具调用 ──┘
```

发布文件为 `release/ClaudeBridge-1.0.2-windows-x64.exe`，支持 Windows 10/11 x64。用户无需安装 C++ 开发环境、Visual C++ 运行库、Node.js、Go 或系统 Tailscale 客户端，也无需自己部署公网服务器。启用模型服务时，B 需安装当前版官方 Claude Code 并正常登录；A 无需安装 Claude Code，模型调用由自行安装的 Harness 或兼容工具完成。

桌面窗口、系统托盘和进程管理继续使用 C++ / Win32；Tailscale `tsnet` 网络核心使用 Go；任务引擎及 Node.js 运行时内置于同一 EXE，首次启动解包到用户数据目录。源码包为 `release/claude-p2p-bridge-1.0.2.zip`，不含本机账号、配对或 API Token。既有组网、DPAPI 配对和自启动架构保留。

## 使用方法

1. 将同一个 EXE 复制到 B 和各台 A，分别运行。
2. 在“设备与配对”先选择本机为 A 调用端或 B 服务端，再点击“连接私有网络”。在浏览器中用同一个 Tailscale 账号完成授权。若账号启用了设备审批，还需在管理台批准新设备。
3. B 点击“创建服务与配对码”，无需先配置 Claude。每台 A 粘贴 B 的配对码，点击“配对并连接 B”。设备页只管理私网、身份、设备和配对，不配置模型。
4. B 创建服务后、A 保存有效配对后，分别解锁“模型 API”和“网络代理”。B 在“模型 API”配置 Claude 程序和运行目录并启用服务；A 仅显示远端模型状态、本机 Base URL、API Key、模型 ID 和调用测试。只使用网络共享时可跳过模型配置。
5. 配对自动加密保存。下次运行客户端，B 恢复原服务，各 A 自动重连；A 先启动时会等待 B 上线。主动“退出私有网络”后不再自动上线，需再次点击连接。
6. 需要随 Windows 登录启动时，在各端打开左下角“设置”，勾选“Windows 登录后自动在后台运行”。之后会直接驻留托盘并恢复配对。“收起到托盘”和“开源许可”也在设置中。

各端保存独立设备身份，**只复制 EXE，不要把数据目录复制到另一台电脑**。首次授权或账号授权过期时仍需浏览器操作。[tsnet 说明](https://tailscale.com/docs/features/tsnet)

网络中的设备列表将本机固定在首位，标注“本机”及已配置的“B 服务端 / A 调用端”，同时显示名称、虚拟 IP、在线状态和已知连接路径。A 已配对的 B 也标注服务端；其余节点角色未知时不作推断。本机不能选作远端 B。优先尝试 P2P，无法直连时可通过 Tailscale 的加密中转连接；同一账号不保证所有网络都能物理直连。本软件依赖 Tailscale 托管的协调及中转基础设施。[连接类型](https://tailscale.com/docs/reference/connection-types)

## 身份切换与业务边界

选择身份后才能启动私网。连接发起后即锁定身份，等待账号授权、正常在线、网络中断和自动重连期间都保持锁定；临时掉线不表示允许切换。只有主动“退出私有网络”完成后才能改选身份。退出保留 Tailscale 登录身份和当前配对，但停止当前连接及自动恢复；重新连接同一身份可沿用配对。

配对监听或拨号尚未完成时主动退出私网、关闭客户端，会取消尚未提交的新配对。B 恢复已有配对时沿用当时选定的本机私网地址；该地址仍须属于本机，地址失效时需要重新配对。

从 A 切到 B 或从 B 切到 A 会停止原身份业务并撤销原配对，清除其网络共享授权；新身份需要重新创建服务或配对。不会同时保留双向服务，也不会因重启恢复旧角色。切换期间只显示设备页，未完成新授权前模型与代理入口重新置灰。撤销授权与保存新身份期间，新的登录、配对、业务配置和再次切换请求会被拒绝；保存失败后可以重试，但不会恢复已撤销的旧授权。普通对端离线则保留页面访问，便于查看状态和修复配置。

模型和代理共用私网及设备配对身份，业务连接、状态及启停独立。关闭或重新配置 Claude、模型请求超时或取消，不关闭网络共享；停止共享不停止模型调用。退出私网、撤销配对或切换身份会中止两条业务的当前连接，这是共同授权失效的结果。**WFP 系统保护不会随上述操作自动撤除**，在“设置”始终保留检查及明确关闭保护的入口。

## 多电脑、托盘和自动恢复

- 一个 B 最多同时连接 16 个 A。B 一次执行一个任务，其余按顺序排队，最多 15 个排队请求；每台 A 同时保留一个请求。
- 各 A 的请求、取消及 Claude 会话独立。某台 A 断开只取消自己的任务。界面及状态 API 显示连接数和排队数。
- 每份客户端只运行一个身份，每台 A 保存一个 B。B 正常重启沿用原配对密钥和监听端口，Claude 配置单独保存；重新创建配对码后，各 A 需要重新配对。
- 最小化、关闭窗口右上角 × 或“收起到托盘”只隐藏窗口，API 和连接继续运行。同一 Windows 用户只允许一个桌面实例；双击托盘图标或再次启动客户端会尝试恢复已有窗口。
- “暂停配对连接”停止当前任务与代理会话并保留配对；点击恢复或正常重启时重连。“忘记配对”撤销本机授权并停止业务连接。“退出私有网络”停止私网并保留登录和配对，后续启动不自动上线；“退出客户端”保留已保存配置，同时停止网络、API 及子进程。
- 网络组件异常退出后会重新初始化；即使重启发生在首次配对保存期间，B 仍会重建原配对的监听，A 自动重连。重复启动 B 监听会复用同一次初始化；私网监听失败会先释放本次回环监听，再允许重试。断线和退出不重发未完成任务，避免重复修改文件或执行命令。

拔网线、Wi-Fi 切换、宽带重拨及公网 IP 变化时，客户端使用原 Tailscale 身份和配对重连，重试间隔逐步增长、最高 15 秒。公网 IP 不写入配对码。删除设备身份、重新注册造成 Tailscale 虚拟地址改变时，需重新授权或配对；自动重连不能替代失效的账号授权。

两端需保持开机联网，休眠、关机或客户端完全退出期间无法提供服务。

## 通过 B 上网 · Clash / Mihomo

A 继续运行现有客户端和 Clash，Clash 的 TUN 接管应用流量；本客户端使用 Tailscale 私网连接将 TCP、UDP 转交给 B，由 B 直接连接互联网。模型请求、任务队列与代理数据通道独立，无需开启或配置 Claude。

```text
A 应用 → Clash TUN → A 本机带密码的 SOCKS5 → Tailscale → B → 互联网
```

1. 将同一最新版 EXE 复制到两端，在原 Windows 用户下沿用配对。
2. B 打开“网络代理”，点击“开启共享本机网络”。网络共享默认关闭，和 Claude 服务独立。该页列出已配对调用端，区分“已配对在线”和“正在使用共享”，显示各设备的活动连接和流量；私网在线节点不会自动成为代理使用者。
3. A 打开“网络代理”，该页仅显示本机及已配对 B 的连接情况。点击“启用本地 Clash 节点”，复制“完整配置订阅”。订阅位于 A 的 `127.0.0.1`，需要 A 客户端持续运行；它不是 B 的公网地址。
4. 在使用 Mihomo / Clash Meta 内核的客户端中导入该 URL 作为**完整配置**，切换到该配置并开启 TUN；不需要另开“系统代理”。不能只把节点合并进一份已有的直连分流配置。配置生成的虚拟网卡名是 `ClaudeBridgeTun`；Clash Verge 2.5.8 使用默认 `Mihomo` 网卡名时也可直接启用系统保护，无需手动改名。已验证 Mihomo v1.19.32 的订阅协议；Clash Verge 的实际 UAC/TUN 联动仍需在 A/B 测试机验收。
5. 需要 Clash 退出后也保持禁止直连时，在 A 的本客户端点击“启用 / 刷新系统保护”，接受 Windows UAC。必须先开启上一步的 TUN，系统保护才会安装；没有对应 TUN 时会明确拒绝。

完整配置将互联网流量固定到 B，不包含 `DIRECT` 回退；DNS 使用经 B 的 DoH，IPv4/IPv6 均纳入 TUN。仅回环流量和网络核心自身的组网连接绕过代理，避免回环。默认不设置国内网站直连或局域网直连规则。B 的代理拒绝本机、私网、链路本地和其他特殊目标地址；域名在 B 解析并检查实际拨号地址，避免无意暴露 B 的内网服务。

B 掉线、关闭共享、暂停连接或配对会话失效后，已有代理流立即撤销，新请求失败，A 按现有退避机制自动重连。重连仅恢复后续新连接，不重放中断的下载或请求。订阅地址、本地代理端口和凭据随本机数据目录稳定保存；更换配对需重新显式授权网络共享/代理。端口被占用时会报错，不会悄悄更换端口导致 Clash 使用旧配置。

UDP 通过独立 WebSocket 连接封装转发，支持真实 SOCKS5 UDP ASSOCIATE。弱网丢包时仍受 TCP 重传影响，不承诺游戏低延迟。默认每个已认证会话代理流量保护上限 32 MiB/s，最多 64 个流、B 总计最多 128 个流；超出资源限额时拒绝或关闭相应流。

### 系统断线保护

系统保护使用 Windows WFP 持久过滤规则，不修改系统防火墙的全局默认策略。它放行指定 TUN、回环及必要局域网维护流量，允许内置网络核心重连，阻止绕过 TUN 的公网连接及业务 DNS。**关闭 Clash、退出本客户端、B 离线都不会自动移除保护。** 只有明确点击“关闭保护并恢复本机直连”，接受 UAC 后才移除本配置的保护。

- 普通权限可能无法读取 WFP，界面将显示“状态未验证”，不会当作未启用。点击“检查系统保护（UAC）”可获取实际过滤规则状态；启动、轮询和订阅读取均不会自动请求管理员权限。
- 启用或关闭操作返回“保护规则验证未通过”时，规则可能已经存在；界面会显示检测数量及校验诊断。这个状态不能表示保护已完整生效，也不能表示已关闭保护、恢复直连。
- TUN 被重新创建后接口标识可能改变，即使网卡名称相同也需重新点击“启用 / 刷新系统保护”；更新客户端后网络核心路径改变也可能需要刷新。在刷新之前保持阻断，不会自动放开或移除持久保护。B 暂时离线且 TUN 接口未变时，B 恢复后仍自动重连，无需刷新保护。关闭保护按钮在尚未配对或切换角色后也可使用。
- 保护范围是 Windows Base Filtering Engine（BFE）运行并加载持久规则之后，不保证 Windows 启动早期、BFE 被管理员停用或其他管理员改变策略时的阻断。
- 系统保护仅支持 Windows 10/11 x64 内置组网模式。演示模式、其他系统或 `--system-tailscale` 模式不启用该系统保护。
- 升级前建议显式关闭系统保护，升级并重新开启 Clash TUN 后再启用，避免旧路径/接口阻断新版本组网。
- 同一电脑只应启用一份客户端的系统保护。保护按数据目录分别保存，并绑定启用时的 TUN 接口；多个目录同时启用可能互相阻断。迁移数据目录时，先用原目录明确关闭旧保护；新目录的关闭按钮不会删除其他目录的规则。

独立订阅凭据不等同本机模型 API Token，但仍包含本地代理访问权限，应妥善保管。它不包含 Tailscale 登录凭据或 B 的配对密钥。

A 应只开启 Clash TUN，关闭“系统代理”；Windows 手动代理和代理脚本不得指向本机 Clash，修改后重新启动本客户端。内置 Tailscale 在 Windows 仍可能参考 WinHTTP / PAC / WPAD 设置，指向本机 Clash 会导致组网自举循环；企业强制 PAC / WPAD 环境需要单独验证。本版组网启动 DNS 使用物理 IPv4 网卡，IPv6-only 接入暂不支持（不影响双栈网络中的 IPv6 代理流量）。

新增接口均要求本机 API 鉴权，订阅使用独立 URL 令牌：

| 接口 | 用途 |
| --- | --- |
| `GET /api/proxy` | 共享、本地节点、流量和系统保护状态（只读） |
| `POST /api/proxy` | B `{sharing:true/false}`；A `{enabled:true/false}` |
| `POST /api/proxy/guard` | A 显式 `{enabled:true}` 启用；任一身份可 `{enabled:false}` 恢复直连，需要 UAC |
| `POST /api/proxy/guard/verify` | 显式 `{}`，通过 UAC 检查实际保护状态 |
| `GET /clash/<独立订阅令牌>/config.yaml` | 完整 Clash 配置，推荐导入 |
| `GET /clash/<独立订阅令牌>/nodes.yaml` | 仅节点列表，不包含 TUN、DNS 和阻断规则 |

开发验证可运行 `node scripts/smoke-clash.mjs --mihomo <Mihomo程序绝对路径>`，验证实际 Mihomo 的 TCP/UDP 和订阅协议；`python scripts/smoke-proxy-exe.py` 使用打包的 `bridge-engine` 组件与独立测试数据目录模拟多端，验证代理启停、断线恢复和配置持久化。两者都只使用本机测试，不创建 TUN、不修改系统代理或过滤规则，也不绕过桌面单实例限制。**WFP 规则/ABI、状态校验和模拟回归不能替代真实阻断验收**；实际 UAC 启停、Clash TUN 联动、物理断网、网络切换及重启后阻断仍需在专用 A/B 测试机验证。

默认数据目录为 `%LOCALAPPDATA%\ClaudeBridge`，包含设备身份、本机 `api-token`、加密配对 `pairing.dat`、桌面设置和运行缓存。配对由 Windows DPAPI 绑定当前用户保护；演示配对使用独立的 `pairing-demo.dat`。不要分发这些私有文件。桌面配置读取完成前若窗口初始化失败，退出流程不会将默认值写回已有的 `desktop.ini`。

自启动默认关闭，启用后使用当前用户的 Windows 登录启动项，无需管理员权限。程序将 EXE 复制到数据目录下稳定的版本路径，移动下载文件不会影响启动。手动运行新版时，会刷新同一数据目录已启用的启动项。每个 Windows 用户只有一个 Claude Bridge 启动项；从另一数据目录手动启用会替换该项，关闭时只移除属于当前目录的启动项。演示模式禁用自启动。未登录 Windows 时客户端不会运行。

升级时先从托盘退出旧版，再运行新版。建议 B 与所有 A 一起升级到 1.0.2；旧版已保存的组网登录、配对、身份与 Claude 配置迁移保留，角色和网络是否自动恢复以保存状态为准。若旧版从未保存配对，需要首次配对。Claude 工作目录失效只影响模型配置，不应阻止独立网络共享；设备身份失效或配对密钥被撤销时需重新授权。已启用持久 WFP 保护的升级及目录迁移仍遵循上文的显式关闭流程。

**同一 Windows 用户只允许一个新版桌面实例运行**。新版使用稳定的共享锁，不因端口、数据目录、EXE 位置或后续新版版本号变化而启动第二份桌面；再次启动会尝试唤回已有窗口。已有实例尚未显示窗口或锁权限受限时，新启动会等待其就绪或退出；无法安全取得锁就结束本次启动，不另开后台。新版也会检测当前用户已运行的旧版并唤回它，但无法让随后启动的 0.8 等历史程序遵守其尚未实现的新锁。因此升级时先从托盘退出旧版，升级后统一使用新版。需要更换数据目录或版本时，也先退出当前客户端。从 0.9.4 起，新版之间崩溃后再次启动，会先清退上一轮的后台进程，再读取配置和启动服务；改用其他端口或数据目录也遵守同一顺序。历史旧版没有这套交接记录，升级时应正常退出旧版。A、B 实际部署在不同电脑；同机多端回归由测试脚本使用打包的 `bridge-engine` 组件和独立测试数据目录完成。

## 将 A 配置为 Harness 主模型提供方

在 **Settings → Models → Add model provider → Custom model API** 填写：

| 字段 | 填写值 |
| --- | --- |
| Provider ID | `claude-bridge` |
| Display name | `远程 Claude Code` |
| Base URL | `http://127.0.0.1:3210/v1`，以 A 窗口实际端口为准 |
| API protocol | **OpenAI Chat Completions** |
| API Key | A 客户端“模型 API”页复制的本机 Key |
| Model ID | `claude-code` |
| Input types | **Text** |

保存后选择这个模型。也可使用 `claude-code-sonnet` 或 `claude-code-opus`，分别传递官方 CLI 的 `sonnet` / `opus` 别名；`claude-code` 沿用 B 官方 CLI 的默认模型与认证。可点 Fetch available models，也可手动添加。Harness 实际服务进程须在 A 本机运行；仅从 A 浏览器打开另一台机器上的 Harness，不能访问 A 的 `127.0.0.1`。官方字段见 [Harness 模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。

API Key 是桥接客户端自己生成的本机鉴权令牌，与 Claude 订阅登录凭据不同。程序不读取、复制或中转 Claude OAuth Token，不修改官方 Claude Code 二进制；Claude 认证仍由 B 的官方 CLI 完成。

先在 B 的官方 Claude Code 中用 `/status` 确认当前认证来源，并确认能够正常对话。桥接不会修改认证配置；若 B 已设置 `ANTHROPIC_API_KEY` 等认证变量，仍遵循官方优先级，不能仅凭之前做过会员登录就认定使用的是订阅额度。

### 模型请求示例

先按“使用方法”完成两端身份选择、私网连接和 A/B 配对，再由 B 在模型页配置并启用 Claude。以下请求发送到 A 的本机 API；私网在线或创建配对码本身不会自动启用模型服务。

```powershell
$bridgeToken = (Get-Content "$env:LOCALAPPDATA\ClaudeBridge\api-token" -Raw).Trim()
$bridgeBody = @{ model = 'claude-code'; messages = @(@{ role = 'user'; content = '你好，请介绍你的能力' }); stream = $false } | ConvertTo-Json -Depth 8
$bridgeReply = Invoke-RestMethod -Uri http://127.0.0.1:3210/v1/chat/completions -Method Post -Headers @{ Authorization = "Bearer $bridgeToken" } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($bridgeBody)) -TimeoutSec 3660
$bridgeReply.choices[0].message
```

若指定过 `--data-dir`，请从该目录读取 `api-token`。

### 推理和工具回合

1. Harness 将完整对话历史和工具 JSON Schema 发给 A，再经加密通道传到 B。
2. B 启动官方 `claude -p`，使用 `--safe-mode` 保留正常认证并关闭用户/项目自定义扩展；同时禁用 B 内置工具、MCP 工具、会话落盘及续接。官方托管策略仍适用，其中配置的 hooks、状态栏和文件建议命令可能执行，`--safe-mode` 不构成操作系统沙箱。[官方 CLI 说明](https://code.claude.com/docs/en/cli-reference)
3. Claude 通过官方 `--json-schema` 返回 `structured_output`，包含回答及请求调用的函数名、JSON 参数。
4. A 校验结果、工具名和调用约束，转换为标准 `tool_calls`。Harness 在 A 按自己的权限策略执行工具，再把工具结果放入下一轮历史。

这是通过 Claude Code 结构化输出实现的模型决策适配，不等同于原生 Anthropic 推理 API。不会把 Claude Code 在 B 执行的工具冒充 A 的工具。B 应更新到支持 `--safe-mode`、`--json-schema` 等参数的当前官方版本；不支持时会报错，不降级为普通文本伪成功。CLI 参数见[官方参考](https://code.claude.com/docs/en/cli-reference)。

### 当前支持范围

- `GET /v1/models`；`POST /v1/chat/completions` 的 JSON 与 SSE 响应。
- 文本对话，`system` / `developer` / `user` / `assistant` / `tool`，函数工具及 `tool_choice`，工具结果回传。保留文本块边界、消息 `name` 和历史助手 `refusal`；兼容 SDK 的可空可选字段。
- 一次返回一个候选（`n=1`），最多 128 个工具定义、单次 32 个工具调用；`parallel_tool_calls=false` 限为一个调用。参数语法在桥接侧检查，具体参数 Schema 和执行权限由 Harness 校验。
- 每台 A 同时一个模型或兼容任务请求，B 总计一个执行、其余排队。首次联调先用单个 Harness 会话；并行子代理可能遇到 409 忙碌响应。
- 模型 HTTP 请求体及补全默认字段后的规范化请求均最多 768 KiB，历史最多 2048 条消息；历史或输出中每个工具参数字符串、最终回答文本各最多 256 KiB。图片、音频、Responses、Anthropic Messages、自定义 `response_format` 等未支持能力会明确拒绝。`function.strict=true`、惩罚参数、logit bias、服务等级及远端存储请求不提供对应语义，会明确报错；`max_tokens` 与 `max_completion_tokens` 不能同时设置。
- SSE 在等待时发送保活，最终决策校验后整轮返回；**当前不是逐 token 实时输出**。不要按短时间无文本判定失败，调用方需放宽超时。
- `max_tokens` / `max_completion_tokens`、`temperature`、`top_p` 作为模型提示偏好传递，**不提供原生采样或严格 token 上限保证**；低/中/高等可用推理等级传给 CLI，`none` / `minimal` 只作偏好。B 的墙钟超时、单条 CLI 事件 1 MiB 及总输出 16 MiB 限制仍强制执行。
- 每一步启动新 CLI 并发送完整历史，不复用 Claude 会话。上下文和启动开销高于原生 API；会话历史由 Harness 保存。CLI 内部轮数沿用 B 上限，结构化模式至少需要 3 轮配置。

输入、能力或规范化体积错误为 400，Key 错误 401，HTTP 请求体过大 413，当前 A 忙碌 409，未连接、Claude 服务未启用或断网 503，Claude 失败或无效结构化结果 502，调用方取消为 499。SSE 已发送响应头时，发送带顶层 `error` 字段的 `data:` 错误帧并结束，不发送成功的 `[DONE]`。关闭调用连接会取消 B 当前任务；断网后恢复连接，但不自动重发中断的推理。A 的总等待超时返回 502 / `RESPONSE_TIMEOUT`，仅恢复模型业务连接。

取消最多等待 B 确认 5 秒，超时返回 `CANCEL_TIMEOUT` 并只恢复当前 A 的模型连接，避免旧任务状态不明时继续复用。达到总响应期限时，同样先断开模型连接，再返回 `RESPONSE_TIMEOUT`。网络代理和其他 A 不受影响，原任务不重放。

## 兼容的 B 端任务 API

通过 `Authorization: Bearer <A 的 API_TOKEN>` 鉴权。各电脑 Token 独立，配对无需共享本机 Token。管理页面和 API 只监听 `127.0.0.1`；B 的远端服务位于 `tsnet` 虚拟网络，默认虚拟端口 3211。发现设备本身不会授予调用权限，需使用 B 的配对码。

### 普通 JSON 响应

同样需要先完成 A/B 配对并由 B 单独启用 Claude 服务；兼容任务使用 B 模型页中保存的运行目录及工具权限。

```powershell
$bridgeToken = (Get-Content "$env:LOCALAPPDATA\ClaudeBridge\api-token" -Raw).Trim()
$bridgeHeaders = @{ Authorization = "Bearer $bridgeToken" }
$bridgeBody = @{ prompt = '请概括当前项目结构'; stream = $false } | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:3210/v1/run -Method Post -Headers $bridgeHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($bridgeBody))
```

```json
{
  "requestId": "…",
  "success": true,
  "sessionId": "Claude 会话 UUID",
  "result": { "type": "result", "result": "回答内容", "is_error": false },
  "errors": [],
  "exitCode": 0,
  "cancelled": false
}
```

HTTP 200 仍需检查 `success`。请求格式错误返回 400，Token 错误 401，同源校验失败 403，当前 A 已有任务返回 409，未连接 B 返回 503。B 忙时进入队列；执行失败、队列满、取消和断线通过结果或 SSE 事件报告。

### 流式输出、续接和取消

`stream` 默认 `true`，返回 SSE；`X-Request-ID` 响应头提供任务 ID。事件包括：

| 事件 | 内容 |
| --- | --- |
| `queued` | `position` 为当前排队位置 |
| `started` | 已实际开始执行 |
| `claude` | `event` 保留 Claude 原始 JSON |
| `stderr` | Claude 标准错误输出 |
| `error` | 任务错误 |
| `done` | 结束状态、退出码及是否取消 |

读取 `claude.event.type === "stream_event"` 中的文本增量，或读取最终 `result`，避免将两者重复追加。必须收到 `done` 才算流式请求完整结束，提前 EOF 应视为失败。JSON 模式会等待队列及执行结束。A 的等待上限为 1 小时 10 秒，包含排队时间；超时取消自己的任务，调用方也需设置足够的 HTTP 超时。

后续请求传入 `sessionId`，可续接当前 A 在**本次连接**中创建的会话。其他 A 无权续接；断线后清除授权，自动重连后需开启新会话。`POST /v1/requests/{requestId}/cancel` 或关闭 HTTP 请求可取消自己的排队或执行任务。

Python 3 标准库示例支持流式输出、续接及错误退出：

```powershell
$env:P2P_BRIDGE_TOKEN = (Get-Content "$env:LOCALAPPDATA\ClaudeBridge\api-token" -Raw).Trim()
python examples/client.py '请概括当前项目结构'
# 续接：python examples/client.py '继续分析' --session <上一次的 sessionId>
```

| 接口 | 用途 / 请求体 |
| --- | --- |
| `GET /health` | 健康和版本，无需 Token |
| `GET /v1/status` | 角色、`connectedClients`、`queuedRequests` 和任务状态 |
| `GET /api/tailscale` | 节点状态、授权链接、设备列表及连接路径 |
| `POST /api/identity` | 退出私网后选择身份：`{"role":"client"}` 或 `{"role":"host"}`；改变身份撤销原授权 |
| `POST /api/network/login` | 已选择身份后启动私网并锁定身份：`{}` |
| `POST /api/network/disconnect` | 主动退出私网，保留登录，停止自动恢复并解锁身份：`{}` |
| `POST /api/host` | B 创建配对服务：`{tailscaleIp?,bridgePort?}`；无需 Claude |
| `POST /api/join` | A 配对：`{invitation}` |
| `GET /api/model` | 当前身份的模型配置、可用状态及提示（只读） |
| `POST /api/model` | B 独立配置 Claude：`{enabled,workspace?,claudeCommand?,profile?,timeoutMs?,maxTurns?}`；停止时保留配置 |
| `POST /api/pause` | 暂停连接，保留配对 |
| `POST /api/reconnect` | 恢复保存的配对 |
| `POST /api/disconnect` | 忘记配对并停止连接 |
| `POST /api/shutdown` | 停止客户端，保留配对 |
| `POST /api/probe` | 检查本机 Claude：`{claudeCommand?}` |
| `GET /v1/models` | 模型列表，需本机 API Key |
| `POST /v1/chat/completions` | Harness 文本和函数工具决策 |
| `POST /v1/run` | `{prompt,stream?,sessionId?,model?}` |
| `POST /v1/requests/{id}/cancel` | 取消自己的任务 |

身份、私网、配对和模型的变更接口返回完整状态。状态中的 `identity` 分别报告所选角色、是否锁定、期望上线状态和提示；`capabilities.model/proxy` 表示当前授权是否解锁页面，与实时连接是否在线分开。业务配置接口仍在后台校验身份和授权，不能通过直接请求绕过界面禁用。

管理接口遵循和页面相同的顺序：两端先 `POST /api/identity`，再 `POST /api/network/login`；B 使用不含 Claude 字段的 `POST /api/host` 创建服务，A 通过 `POST /api/join` 保存授权。需要模型时，B 随后单独调用 `POST /api/model` 配置并启用；只需代理时分别开启 B 共享与 A 本地节点。`workspace`、`claudeCommand`、`profile` 等字段不能再放进 `/api/host` 请求。切换身份前必须先成功完成 `POST /api/network/disconnect`。

`/v1/run` 保留旧版“在 B 项目执行完整任务”的语义，工具权限在 B 的模型页高级配置中设置；该入口拒绝 `kind:model`，无任务结果时不会报告成功。网页模型测试使用标准 `/v1/chat/completions`。桌面和网页的模型测试绑定发起时的控制连接；角色、授权或连接更换后清除旧测试结果，不自动重发请求。Harness 主模型也应使用该入口，两个入口的工具执行位置不同。已支持且接收 JSON 参数的接口要求有效的 UTF-8 JSON 对象；取消接口不读取请求体。

## 权限和开源组件

B 的兼容任务可选择读取（Read/Glob/Grep）、编辑（增加 Edit/Write）或开发（增加 Bash）。工作目录、工具、默认 10 分钟执行超时及 30 轮上限由 B 决定，A 无法覆盖。工具限制和工作目录不是操作系统沙箱；兼容任务启用 Bash 时，任务拥有 B 运行账户的相应权限。主模型模式不授权 B 的这些工具，A 工具遵循 Harness 的执行与审批策略。

本软件不保证订阅账号不会受限制，也不规避服务商的认证、限额或使用政策；配对和网络加密不改变订阅授权范围。使用须遵守 [Anthropic 认证规定](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)。

Tailscale 核心客户端、CLI 和 `tsnet` 使用 BSD-3-Clause；部分官方桌面 GUI 及托管服务并非全部开源。本软件使用开源网络核心，独立开发，不代表官方背书。使用托管服务仍适用对应账号条款。[开源范围](https://tailscale.com/opensource) · [许可证](https://github.com/tailscale/tailscale/blob/main/LICENSE)

第三方许可证随 EXE 内置，可从左下角“设置 → 开源许可”查看，包含 Node.js、Tailscale、MinGW-w64、nlohmann/json 及依赖版权信息。开发网页控制台也在“设置”中提供该入口。

## 参数与开发构建

| EXE 参数 | 用途 |
| --- | --- |
| `--port 3213` | 改变本机 API 端口；不允许同一 Windows 用户启动第二个桌面 |
| `--data-dir E:\bridge-data` | 选择数据目录；更换前需退出已有桌面实例 |
| `--minimized` | 启动后直接收起到托盘；兼容旧名 `--no-browser` |
| `--demo` | 本机模拟网络及 Claude，不使用真实账号；配对单独保存 |
| `--system-tailscale` | 使用已安装的系统 Tailscale 客户端 |

只有开发构建需要 Node.js 22+、Python 3、C++ 和 Go 工具。工具脚本校验 SHA256，将便携 w64devkit 2.10.1 和 Go 1.27.2 解压到项目 `.tools`，不修改系统 PATH 或 PowerShell 安全策略。

```powershell
npm ci
python scripts/bootstrap-tools.py
npm run build:windows
python scripts/package.py
```

`package.json` 统一提供版本号，构建时生成 Windows manifest 并注入网络核心。共享构建配置、源码包及 EXE 内运行资源的白名单位于 `scripts/build_support.py`；两种打包都排除私有状态、`.env`、缓存和链接目录。

`release/claude-p2p-bridge-版本号.zip` 是该版本的源码快照，包含测试源码，不含测试运行数据、工具链和本机配置。自 0.9.1 起，构建还生成对应 EXE 的 `.build.json`，记录二进制及源码文件的 SHA256；源码打包会核对这份记录，源码或 EXE 已变化时拒绝覆盖归档，需先重新构建。ZIP 使用原子替换，打包失败保留原文件。没有构建记录的历史 ZIP 仍是当时保存的源码快照。

主要源码：`native/desktop` 为 C++ 窗口与托盘，`native/netcore` 为 Go 组网，`src` 为任务/API，`public` 为开发网页控制台。依赖由 `package-lock.json` 和 `native/go.mod` / `go.sum` 锁定。Claude 程序应在绝对 PATH 目录中，或由 B 指定绝对 `claudeCommand`；不会从项目目录或相对 PATH 自动执行同名程序。

`npm start` 提供开发网页控制台，默认数据目录为当前目录的 `.bridge`；与桌面版默认目录不同。`npm run demo` 启动两个不保存配对的源码模拟实例。源码与 EXE 的 `--demo` 均使用模拟任务；EXE 的演示配对可保存，方便测试重启恢复。

验证命令（先完成构建）：

```powershell
npm run check
npm test
python -m unittest discover -s test -p "test_*.py"
python scripts/test-startup.py
python scripts/test-single-instance.py
python scripts/smoke-native-http.py
python scripts/smoke-desktop.py
python scripts/smoke-proxy-exe.py
# 在 native 目录运行 Go 测试，使用开发环境中已配置的 Go：
go test ./cmd/bridge ./netcore
```

可选的真实客户端协议验证：按 `scripts/smoke-harness-client.js` 顶部命令，将 Harness 使用的 pi-ai 1.1.0 安装到独立 `.bridge` 测试目录，再运行 `node scripts/smoke-harness-client.js`。该脚本用合成 CLI 验证实际 pi-ai 工具往返及官方 OpenAI SDK 错误处理，不访问外部模型；缺少可选依赖时明确跳过，不增加生产依赖。

测试使用合成 Claude CLI 与本机网络，覆盖加密 A/B 通道、A 端工具往返、多 A 排队及取消隔离、断线恢复、无效模型输出、DPAPI 保存、独立注册表自启动项、流式 UTF-8 分片、打包组件运行和快速退出。`test-single-instance.py` 检查新版在同一 Windows 用户下跨端口、目录、文件位置的互斥、锁权限受限时的等待与接管，以及已有窗口唤回；后续新版沿用同一锁标识，历史旧程序后启动的限制见上文。多端模拟使用打包的 `bridge-engine` 组件与各自独立的数据目录，生产桌面不提供绕过单实例限制的参数。源码/运行时白名单测试检查私有文件、缺失资源及链接路径；Windows 权限不允许创建符号链接时，相应链接回归会明确跳过。自启动测试仅写隔离 HKCU 测试键，代理测试不安装真实断网保护。

上述 Python 原生检查会在退出子进程后删除本次运行创建的测试 EXE、解包运行时和配置目录；清理只允许作用于项目内独立测试目录，遇到链接目录会拒绝删除。Mihomo 验证仅保留最新一次的 `.cache/mihomo-smoke.log`，不累积测试配置和缓存。可选的 `.bridge/harness-client-fixture` 是手动安装的测试依赖，不随每次运行自动删除；不再需要时可单独移除。普通开发控制台的 `.bridge` 可能含真实配对和配置，不能将整个目录当测试残留清空。

**真实 Pro/Max 登录后的结构化模型质量、Harness 实际安装的多轮工具行为及跨城市直连/中转，仍需在实际电脑上验证。** 合成 CLI 和模拟 EXE 测试不能证明真实订阅调用已经通过；本开发环境没有代为授权账号或调用真实模型。
