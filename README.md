# Claude Bridge · Windows 桌面托盘版 v1.1.8

多台电脑安装同一个客户端，各端登录同一个 Tailscale 账号。每份实例选择一个固定方向的身份：A 调用端连接一台 B，B 服务端接受已授权的 A。模型服务和网络共享分别配置、分别启停；仅使用网络共享时不需要安装 Claude。B 的模型服务使用已安装并登录的官方 Claude Code，为 A 上的 DeepSeek Harness 提供主模型决策；Harness 的文件和终端工具在 A 执行。

```text
A 上 Harness → A 本机 /v1/chat/completions → 加密连接 → B 的官方 Claude Code
      ↑                                                   ↓
      └── A 执行工具 → 下一轮带回结果 ← 回答 / 结构化工具调用 ──┘
```

发布文件为 `release/ClaudeBridge-1.1.8-windows-x64.exe`，支持 Windows 10/11 x64。用户无需安装 C++ 开发环境、Visual C++ 运行库、Node.js、Go 或系统 Tailscale 客户端，也无需自己部署公网服务器。启用模型服务时，B 需安装当前版官方 Claude Code 并正常登录；A 无需安装 Claude Code，模型调用由自行安装的 Harness 或兼容工具完成。

桌面窗口、系统托盘和进程管理使用 C++ / Win32；Tailscale `tsnet` 网络核心使用 Go；任务引擎及 Node.js 运行时内置于同一 EXE，首次启动解包到用户数据目录。源码包为 `release/claude-p2p-bridge-1.1.8.zip`，不含本机账号、配对或 API Token。

调用端与服务端均支持浅色、深色主题，切换按钮位于左下角“设置”上方。右上角状态框以绿色表示已连接、黄色表示等待连接、红色表示尚未选择身份或需要登录。设备、配对、模型和代理页面统一使用明确的调用端／服务端名称及彩色按钮。

## 使用方法

1. 将同一个 EXE 复制到 B 和各台 A，分别运行。
2. 在“设备与配对”先选择本机为 A 调用端或 B 服务端，再点击“连接私有网络”。在浏览器中用同一个 Tailscale 账号完成授权。若账号启用了设备审批，还需在管理台批准新设备。
3. 服务端点击“创建服务与配对码”，无需先配置 Claude。调用端粘贴服务端的配对码，点击“配对并连接服务端”。配对成功后输入框显示只读配对信息，下方按钮变为“忘记配对”；暂停或暂时离线时保留配对，服务端明确拒绝授权后才回到重新配对状态。设备页只管理私网、身份、设备和配对，不配置模型。
4. B 创建服务后、A 保存有效配对后，分别解锁“模型 API”和“网络代理”。B 在“模型 API”配置 Claude 程序和运行目录并启用服务；A 点击“开启模型 API”才开始监听本机模型端口，再使用 Base URL、API Key、模型 ID 和调用测试。停止后立即释放模型端口并取消在途模型请求，配对和网络代理继续运行。每次启动客户端，A 的模型 API 默认关闭。只使用网络共享时可跳过模型配置。
5. 配对自动加密保存。下次运行客户端，B 恢复原服务，各 A 自动重连；A 先启动时会等待 B 上线。主动“退出私有网络”后不再自动上线，需再次点击连接。
6. 需要随 Windows 登录启动时，在各端打开左下角“设置”，勾选“Windows 登录后自动在后台运行”。之后会直接驻留托盘并恢复配对。“收起到托盘”和“开源许可”也在设置中。

“运行记录”仅保留本次进程内的记录，退出客户端后清空，不写入磁盘；启动和退出时清理当前数据目录中旧版遗留的普通 `client.log`。右上角关闭按钮仅收起到托盘，真正退出请使用托盘菜单“退出客户端”。模型测试区的“复制 PowerShell 示例”用于生成带当前接口、模型和鉴权信息的本机调用命令，仅在需要接入脚本时使用。

各端保存独立设备身份，**只复制 EXE，不要把数据目录复制到另一台电脑**。首次授权或账号授权过期时仍需浏览器操作。[tsnet 说明](https://tailscale.com/docs/features/tsnet)

B 的“Claude 程序路径或命令”保留默认 `claude` 即可自动检测：优先使用当前 PATH，随后读取最新的 Windows 用户/系统 PATH，并检查用户原生安装、npm、WinGet、旧版本地安装及 Claude 桌面版（含 Microsoft Store）的 CLI 目录。桌面版有多个缓存版本时选用最新版本；检测成功会显示版本和实际程序路径。自定义安装位置仍可填写 `claude.exe` 或官方 `cli.js` 的绝对路径。找不到程序时只提示未能定位，不据此判断未安装或未登录。

网络中的设备列表将本机固定在首位，标注“本机”及已配置的“B 服务端 / A 调用端”，同时显示名称、虚拟 IP、在线状态和已知连接路径。A 已配对的 B 也标注服务端；其余节点角色未知时不作推断。本机不能选作远端 B。优先尝试 P2P，无法直连时可通过 Tailscale 的加密中转连接；同一账号不保证所有网络都能物理直连。本软件依赖 Tailscale 托管的协调及中转基础设施。[连接类型](https://tailscale.com/docs/reference/connection-types)

## 身份切换与业务边界

选择身份后才能启动私网。连接发起后即锁定身份，等待账号授权、正常在线、网络中断和自动重连期间都保持锁定；临时掉线不表示允许切换。只有主动“退出私有网络”完成后才能改选身份。退出保留 Tailscale 登录身份和当前配对，但停止当前连接及自动恢复；重新连接同一身份可沿用配对。

配对监听或拨号尚未完成时主动退出私网、关闭客户端，会取消尚未提交的新配对。B 恢复已有配对时沿用当时选定的本机私网地址；该地址仍须属于本机，地址失效时需要重新配对。

从 A 切到 B 或从 B 切到 A 会停止原身份业务并撤销原配对，清除其网络共享授权；新身份需要重新创建服务或配对。不会同时保留双向服务，也不会因重启恢复旧角色。切换期间只显示设备页，未完成新授权前模型与代理入口重新置灰。撤销授权与保存新身份期间，新的登录、配对、业务配置和再次切换请求会被拒绝；保存失败后可以重试，但不会恢复已撤销的旧授权。普通对端离线则保留页面访问，便于查看状态和修复配置。

模型和代理共用私网及设备配对身份，业务连接、状态及启停独立。关闭或重新配置 Claude、模型请求超时或取消，不关闭网络共享；停止共享不停止模型调用。退出私网、撤销配对或切换身份会中止两条业务的当前连接，这是共同授权失效的结果。

## 多电脑、托盘和自动恢复

- 一个 B 最多同时连接 16 个 A。B 一次执行一个任务，其余按顺序排队，最多 15 个排队请求；每台 A 同时保留一个请求。
- 各 A 的请求、取消及 Claude 会话独立。某台 A 断开只取消自己的任务。界面及状态 API 显示连接数和排队数。
- 每份客户端只运行一个身份，每台 A 保存一个 B。B 正常重启沿用原配对密钥和监听端口，Claude 配置单独保存；重新创建配对码后，各 A 需要重新配对。
- 最小化、关闭窗口右上角 × 或“收起到托盘”只隐藏窗口，API 和连接继续运行。同一 Windows 用户只允许一个桌面实例；双击托盘图标或再次启动客户端会尝试恢复已有窗口。
- “暂停配对连接”停止当前任务与代理会话并保留配对；点击恢复或正常重启时重连。“忘记配对”撤销本机授权并停止业务连接。“退出私有网络”停止私网并保留登录和配对，后续启动不自动上线；“退出客户端”保留已保存配置，同时停止网络、API 及子进程。
- 网络组件异常退出后会重新初始化；即使重启发生在首次配对保存期间，B 仍会重建原配对的监听，A 自动重连。重复启动 B 监听会复用同一次初始化；私网监听失败会先释放本次回环监听，再允许重试。断线和退出不重发未完成任务，避免重复修改文件或执行命令。

拔网线、Wi-Fi 切换、宽带重拨及公网 IP 变化时，客户端使用原 Tailscale 身份和配对重连，重试间隔逐步增长、最高 15 秒。公网 IP 不写入配对码。删除设备身份、重新注册造成 Tailscale 虚拟地址改变时，需重新授权或配对；自动重连不能替代失效的账号授权。

两端需保持开机联网，休眠、关机或客户端完全退出期间无法提供服务。

### 持续卡顿时的保守通道恢复（1.1.7）

本版只针对 TCP 下载及网页数据通道的持续受阻评估自动恢复。B 观察到持续下行数据积压、同时出现内置 TCP 重传或超时证据时，向对应 A 发送恢复提示；A 结合本机状态决定是否只刷新自己的 Bridge 传输通道，B 不替其他 A 重启网络组件。单纯空闲、一次慢请求或延迟偏高不会触发。该提示需要 A、B 均升级至 1.1.7；旧版的配对握手、模型及代理协议仍可互通，但不会获得新版双端协作判断。

严重受阻须持续至少 20 秒，只有单条流时须持续至少 30 秒；下行恢复还要求 A 收到同次连接的多次近期提示并核对本地状态。恢复之间至少间隔 2 分钟，30 分钟内最多尝试 3 次；失败的尝试同样计入预算。模型任务正在执行或排队、本地应用读取过慢、用户已暂停或主动离线时不会自动刷新。刷新保留已有配对与偏好设置，只恢复后续新连接，不重放中断的模型任务、下载或请求。该判断偏保守，不会识别或处理所有低速情形。

自动恢复不会修改 Clash、TUN、系统代理、路由或系统网络设置，也不会清空登录身份、重新配对或重启 B 的全部服务。仅上传变慢不会触发自动刷新，UDP/QUIC、握手前超时或源站限速问题也不承诺恢复。这是异常持续时的一次受限恢复尝试，不代表已经定位或修复运营商、跨境链路或远端网站的根因；是否恢复速度仍需实际观察。

### 正式版手动通道探针（1.1.8）

“网络代理 → 网络诊断”包含手动通道探测及 JSON 报告导出。A 只探测当前配对的 B；B 可从当前已认证的 A 中选择目标。无需切换诊断版或重新配对，不接受用户输入任意地址。探测只使用现有在线网络组件，未连接、正在执行模型任务或自动刷新通道时不会开始。

每组串行发送 9 次少量探测（TSMP、128 字节 disco、1200 字节 disco 各 3 次），最长 35 秒，两组之间至少间隔 60 秒；可随时取消，已经发出的单次探测最多继续等待约 2.5 秒。关闭诊断窗口会取消该窗口发起的探测。报告只保存本次时间、探测类别、回复、超时、延迟和路径类别，不包含密钥、配对码、订阅凭据、设备名称或地址。报告不会自动上传，也不会自动写入磁盘。

这是主动探测，可能促使 Bridge 更新路径选择；不会操作 Clash、TUN、系统代理或路由。TSMP 在当前网络核心中是固定 29 字节的内层 IPv4 包，路径信息显示未知；disco 大小是包含 disco 头的 UDP 负载。探测回复和超时不能换算为实际公网丢包率，也不代表视频、下载带宽或 MTU 已通过测试。日常运行仍使用轻量被动监测，不会后台循环发送主动探针。

## 通过 B 上网 · Clash / Mihomo

A 继续运行现有客户端和 Clash，Clash 的 TUN 接管应用流量；本客户端使用 Tailscale 私网连接将 TCP、UDP 转交给 B，由 B 直接连接互联网。模型请求、任务队列与代理数据通道独立，无需开启或配置 Claude。

```text
A 应用 → Clash TUN → A 本机带密码的 SOCKS5 → Tailscale → B → 互联网
```

1. 将同一最新版 EXE 复制到两端，在原 Windows 用户下沿用配对。
2. B 打开“网络代理”，点击“开启共享本机网络”。网络共享默认关闭，和 Claude 服务独立。该页列出已配对调用端，区分“已配对在线”和“正在使用共享”，显示各设备的活动连接和流量；私网在线节点不会自动成为代理使用者。
3. A 打开“网络代理”，该页仅显示本机及已配对 B 的连接情况。点击“启用本地 Clash 节点”，复制“完整配置订阅”。订阅位于 A 的 `127.0.0.1`，需要 A 客户端持续运行；它不是 B 的公网地址。
4. 在使用 Mihomo / Clash Meta 内核的客户端中导入该 URL 作为**完整配置**，切换到该配置，保持“规则”模式并开启 TUN；不需要另开“系统代理”。“代理”页显示“通过 B 上网”代理组，其中仅有“B 网络出口”节点；旧订阅更新并重新激活后即可显示。不能只把节点合并进一份已有的直连分流配置，也不要改用“全局”模式绕过组网进程的规则。配置生成的虚拟网卡名是 `ClaudeBridgeTun`，组网自举也识别 Clash Verge 默认的 `Mihomo` 网卡名。已验证 Mihomo v1.19.32 的订阅协议；Clash Verge 的实际 TUN 联动仍需在 A/B 测试机验收。

完整配置将互联网流量固定到 B，不包含 `DIRECT` 回退；DNS 使用经 B 的 DoH，IPv4/IPv6 均纳入 TUN。仅回环流量和网络核心自身的组网连接绕过代理，避免回环。默认不设置国内网站直连或局域网直连规则。B 的代理拒绝本机、私网、链路本地和其他特殊目标地址；域名在 B 解析并检查实际拨号地址，避免无意暴露 B 的内网服务。

B 掉线、关闭共享、暂停连接或配对会话失效后，已有代理流立即撤销，新请求失败，A 按现有退避机制自动重连。重连仅恢复后续新连接，不重放中断的下载或请求。订阅地址、本地代理端口和凭据随本机数据目录稳定保存；更换配对需重新显式授权网络共享/代理。端口被占用时会报错，不会悄悄更换端口导致 Clash 使用旧配置。

TCP 本地接收端写入阻塞时会暂停 WebSocket 读取，避免继续堆积数据；背压期间保留连接，接收恢复后继续传输。持续本地写入阻塞约 120 秒仍未恢复时回收该流；真正失联的连接按心跳超时回收。跨城、跨国链路的实际吞吐和下载稳定性仍需两端升级后复测。

UDP 通过独立 WebSocket 连接封装转发，支持真实 SOCKS5 UDP ASSOCIATE。弱网丢包时仍受 TCP 重传影响，不承诺游戏低延迟。两端的代理流及内置传输通道默认不设固定连接数量上限，实际承载受系统资源和网络条件影响；资源不足时新连接仍可能失败。代理状态中的 `connectionLimit` 和 `sessionConnectionLimit` 为 `0` 表示不设数量上限，界面同时显示实际活跃连接数。TCP 关闭或断线后释放相应流，UDP 关联空闲 60 秒后回收，后续新流量可重新建立关联。每个已认证会话的 32 MiB/s 流量保护阈值、4 MiB 缓冲保护及握手超时仍保留；超出相应保护限额时拒绝或关闭相关流。升级时 A、B 应使用同一新版；取消数量限制不改变链路带宽、延迟或中继路径。

### 旧版系统保护的升级与恢复

主程序不再提供系统断线保护的设置和 API，也不安装新的 WFP 保护规则。旧版已经安装的持久规则不会随退出或升级自动删除；升级前应使用旧版、原数据目录明确关闭保护，或使用本次发行版附带的离线恢复包。

旧版启用断线保护后整机断网、无法通过原界面关闭时，可在其他电脑取得 `release/ClaudeBridge-Network-Recovery-windows-x64.zip` 后离线拷入并解压。从托盘退出客户端，右键恢复 EXE 选择“以管理员身份运行”，输入 `RESTORE` 并回车。工具按显示名、确定性 GUID 和本软件规则标记查找全部旧配置，事务撤除后重新核对剩余数量；不需要原安装目录、AppID、TUN 或联网，不重置系统防火墙。确认剩余配置为 0 后，关闭 Clash TUN/系统代理并重新测试直连。报错时保留窗口诊断。本版主程序不再提供重新启用系统保护的入口。开发者可用 `python scripts/build_guard_recovery.py` 离线构建该工具。

独立订阅凭据不等同本机模型 API Token，但仍包含本地代理访问权限，应妥善保管。它不包含 Tailscale 登录凭据或 B 的配对密钥。

A 应只开启 Clash TUN，关闭“系统代理”；Windows 手动代理和代理脚本不得指向本机 Clash，修改后重新启动本客户端。内置 Tailscale 在 Windows 仍可能参考 WinHTTP / PAC / WPAD 设置，指向本机 Clash 会导致组网自举循环；企业强制 PAC / WPAD 环境需要单独验证。本版组网启动 DNS 使用物理 IPv4 网卡，IPv6-only 接入暂不支持（不影响双栈网络中的 IPv6 代理流量）。

Windows 组网传输选择非虚拟默认网卡，Tailscale 控制连接与普通组网 DNS 共用物理网卡解析器，避免控制域名落入 fake-IP。此修复不修改现有 Clash 配置、节点或系统路由，也不保证改善跨国链路带宽。

代理管理接口要求本机 API 鉴权，订阅使用独立 URL 令牌：

| 接口 | 用途 |
| --- | --- |
| `GET /api/proxy` | 共享、本地节点和流量状态（只读） |
| `GET /api/network/diagnostics` | 内置组网的 TCP 重传、超时及各传输路径累计收发计数（只读） |
| `POST /api/proxy` | B `{sharing:true/false}`；A `{enabled:true/false}` |
| `GET /clash/<独立订阅令牌>/config.yaml` | 完整 Clash 配置，推荐导入 |
| `GET /clash/<独立订阅令牌>/nodes.yaml` | 仅节点列表，不包含 TUN、DNS 和阻断规则 |

在正式桌面或网页控制台的“网络代理”页点击“网络诊断”打开，之后约每 2 秒自动读取最新快照，也可点击“刷新”立即读取。关闭诊断后停止更新；网页离开“网络代理”页时也停止更新。读取尚未结束时跳过下一次自动刷新，不叠加请求。收发、重传与超时计数是本机内置节点启动以来的累计值，包含控制连接、模型及代理等所有流量，不是按 B、对端或代理单独计数；当前连接数反映快照时的连接状态。重传计数不能当作公网丢包率。没有数据时显示不可用，不能当作零；诊断不会自动测速、重连或启动未运行的网络组件。

诊断接口位于本机管理端口，沿用 API Token 鉴权。`scope: "node"` 表示本机整节点统计，`available: false` 表示当前没有可读取的快照，空集合不代表实测为零。诊断超时也不会主动重置已有连接。

开发验证可运行 `node scripts/smoke-clash.mjs --mihomo <Mihomo程序绝对路径>`，验证实际 Mihomo 的 TCP/UDP 和订阅协议；`python scripts/smoke-proxy-exe.py` 使用打包的 `bridge-engine` 组件与独立测试数据目录模拟多端，验证代理启停、断线恢复和配置持久化。两者都只使用本机测试，不创建 TUN、不修改系统代理或过滤规则，也不绕过桌面单实例限制。实际 Clash TUN 联动、物理断网、网络切换及重启后的代理恢复仍需在专用 A/B 测试机验证。

默认数据目录为 `%LOCALAPPDATA%\ClaudeBridge`，包含设备身份、本机 `api-token`、加密配对 `pairing.dat`、桌面设置和运行缓存。配对由 Windows DPAPI 绑定当前用户保护；演示配对使用独立的 `pairing-demo.dat`。不要分发这些私有文件。桌面配置读取完成前若窗口初始化失败，退出流程不会将默认值写回已有的 `desktop.ini`。

Windows 初始化内置组网时，为当前用户拥有的状态目录设置私有访问权限，兼容只继承“修改”权限的自定义数据目录。管理员首次创建的目录，在管理员组已启用且拥有该目录时会将所有者规范为当前用户，方便之后普通权限重启；正常连接无需以管理员身份运行。权限初始化仅作用于组网状态目录，保留已有登录和配对配置，不修改父目录权限；路径包含链接或状态目录属于其他账户时会明确报错，请选择当前用户拥有的独立目录。

自启动默认关闭，启用后使用当前用户的 Windows 登录启动项，无需管理员权限。程序将 EXE 复制到数据目录下稳定的版本路径，移动下载文件不会影响启动。手动运行新版时，会刷新同一数据目录已启用的启动项。每个 Windows 用户只有一个 Claude Bridge 启动项；从另一数据目录手动启用会替换该项，关闭时只移除属于当前目录的启动项。演示模式禁用自启动。未登录 Windows 时客户端不会运行。

新版桌面启动并确认引擎就绪后，会自动清理数据目录 `app`、`engine` 和 `runtime` 中已识别的旧程序及运行缓存。当前运行组件、正在使用的程序、自启动引用的副本和更高版本程序会保留；无法确认是否安全时跳过清理，稍后启动再重试。清理不删除私网登录、配对、API Key、桌面或代理设置，也不跟随链接目录。独立运行开发引擎时不自动清理。

升级时先从托盘退出旧版，再运行新版，A、B 统一使用同一新版 EXE，并沿用各自原数据目录。保存的组网登录、配对、身份和 Claude 配置会继续使用；若原本没有配对，或设备身份、授权已失效，则需重新授权或配对。A 的模型 API 每次启动默认关闭，需在模型页显式开启；模型 URL 默认为 `http://127.0.0.1:3210/v1`，管理端口默认为 `http://127.0.0.1:3211`。Claude 工作目录失效只影响模型配置，不应阻止独立网络共享。

**同一 Windows 用户只允许一个桌面实例运行**。再次启动会尝试唤回已有窗口；更换端口、数据目录或 EXE 位置不会启动第二份桌面。需要切换数据目录或版本时，先从托盘退出当前实例。窗口尚未就绪或锁权限受限时，新实例会等待或退出；崩溃后再次启动会先清退上一轮后台进程，再加载配置。A、B 实际部署在不同电脑；同机多端回归使用打包的 `bridge-engine` 组件和独立测试数据目录。

## 将 A 配置为 Harness 主模型提供方

先在 A 的“模型 API”页点击“开启模型 API”，每次重启客户端后都需要重新启动。然后在 **Settings → Models → Add model provider → Custom model API** 填写：

| 字段 | 填写值 |
| --- | --- |
| Provider ID | `claude-bridge` |
| Display name | `远程 Claude Code` |
| Base URL | `http://127.0.0.1:3210/v1`，以 A 窗口实际端口为准 |
| API protocol | **OpenAI Chat Completions** |
| API Key | A 客户端“模型 API”页复制的本机 Key |
| Model ID | 从 A 的“模型 API”下拉列表复制，或使用 Fetch available models 获取 |
| Input types | **Text** |

保存提供商后点击 Fetch available models，选择 B 返回的模型；也可从 A 客户端复制所选模型 ID 手动添加。列表来自 B 当前 Claude Code 的官方初始化接口，包含名称、说明和原始 ID，并过滤 CLI 标记不可选的条目；不再维护固定的模型家族或版本列表。A 的调用测试、复制示例及 API 请求均使用所选 ID，包括上下文后缀。启用模型或重连时自动同步，列表缓存五分钟，A 的“刷新模型列表”会请求 B 重新读取。读取失败会明确报错，不返回静态或空的成功列表；切换 B 配置、撤销配对或停用服务会清除原目录。列表反映 CLI 当前可选项，后端额度、登录或权限变化仍可能在实际调用时返回错误。[官方模型配置](https://code.claude.com/docs/en/model-config)

旧客户端的 `claude-code` 仅作为默认入口兼容，不再列在动态目录；新版调用应直接使用列表中的 ID。Harness 实际服务进程须在 A 本机运行；仅从 A 浏览器打开另一台机器上的 Harness，不能访问 A 的 `127.0.0.1`。官方字段见 [Harness 模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。

API Key 是桥接客户端自己生成的本机鉴权令牌，与 Claude 订阅登录凭据不同。程序不读取、复制或中转 Claude OAuth Token，不修改官方 Claude Code 二进制；Claude 认证仍由 B 的官方 CLI 完成。

先在 B 的官方 Claude Code 中用 `/status` 确认当前认证来源，并确认能够正常对话。桥接不会修改认证配置；若 B 已设置 `ANTHROPIC_API_KEY` 等认证变量，仍遵循官方优先级，不能仅凭之前做过会员登录就认定使用的是订阅额度。

### 模型请求示例

先完成两端身份选择、私网连接和配对，由 B 在模型页配置并启用 Claude，再在 A 点击“开启模型 API”。以下请求发送到 A 的本机模型端口；私网在线或创建配对码本身不会自动启用模型服务。

```powershell
$bridgeToken = (Get-Content "$env:LOCALAPPDATA\ClaudeBridge\api-token" -Raw).Trim()
$bridgeModels = Invoke-RestMethod -Uri http://127.0.0.1:3210/v1/models -Headers @{ Authorization = "Bearer $bridgeToken" }
$bridgeModelId = $bridgeModels.data[0].id # 可改为动态列表中的其他 ID
$bridgeBody = @{ model = $bridgeModelId; messages = @(@{ role = 'user'; content = '你好，请介绍你的能力' }); stream = $false } | ConvertTo-Json -Depth 8
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

通过 `Authorization: Bearer <A 的 API_TOKEN>` 鉴权。各电脑 Token 独立，配对无需共享本机 Token。管理页面和 API 只监听 `127.0.0.1`。本机模型 API 默认端口为 3210，仅在 A 主动启动后监听；管理页面和 `/api/*` 使用独立端口，默认为 3211，不受模型 API 开关影响。指定 `--port` 时管理端口为该值加一，65535 时改用 65534。B 的远端服务位于 `tsnet` 虚拟网络，默认虚拟端口 3211，与本机管理端口属于不同网络。发现设备本身不会授予调用权限，需使用 B 的配对码。

### 普通 JSON 响应

`/v1/run` 是独立兼容任务接口，使用管理端口（默认 3211），不受 A 的模型 API 监听开关控制。同样需要先完成 A/B 配对并由 B 单独启用 Claude 服务；兼容任务使用 B 模型页中保存的运行目录及工具权限。

```powershell
$bridgeToken = (Get-Content "$env:LOCALAPPDATA\ClaudeBridge\api-token" -Raw).Trim()
$bridgeHeaders = @{ Authorization = "Bearer $bridgeToken" }
$bridgeBody = @{ prompt = '请概括当前项目结构'; stream = $false } | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:3211/v1/run -Method Post -Headers $bridgeHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($bridgeBody))
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

Python 3 标准库示例支持流式输出、续接及错误退出，直接访问本机接口，不使用环境变量中的 HTTP 代理：

```powershell
$env:P2P_BRIDGE_TOKEN = (Get-Content "$env:LOCALAPPDATA\ClaudeBridge\api-token" -Raw).Trim()
python examples/client.py '请概括当前项目结构'
# 续接：python examples/client.py '继续分析' --session <上一次的 sessionId>
```

下表的 `/v1/models` 和 `/v1/chat/completions` 使用模型端口；其他接口使用管理端口。取消接口也可通过已开启的模型端口调用。

| 接口 | 用途 / 请求体 |
| --- | --- |
| `GET /health` | 健康和版本，无需 Token |
| `GET /api/status` | 管理状态，包含 `modelApi` 的 `enabled/listening/port/baseUrl/error` |
| `GET /v1/status` | 角色、`connectedClients`、`queuedRequests` 和任务状态 |
| `GET /api/tailscale` | 节点状态、授权链接、设备列表及连接路径 |
| `POST /api/identity` | 退出私网后选择身份：`{"role":"client"}` 或 `{"role":"host"}`；改变身份撤销原授权 |
| `POST /api/network/login` | 已选择身份后启动私网并锁定身份：`{}` |
| `POST /api/network/disconnect` | 主动退出私网，保留登录，停止自动恢复并解锁身份：`{}` |
| `POST /api/host` | B 创建配对服务：`{tailscaleIp?,bridgePort?}`；无需 Claude |
| `POST /api/join` | A 配对：`{invitation}` |
| `GET /api/model` | 当前身份的模型配置、可用状态及提示（只读） |
| `POST /api/model` | B 独立配置 Claude：`{enabled,workspace?,claudeCommand?,profile?,timeoutMs?,maxTurns?}`；停止时保留配置 |
| `POST /api/model-api` | A 启停本机模型监听：`{enabled}`；返回完整状态，重启后默认关闭 |
| `POST /api/model-test` | 管理端同源调用测试；请求体与 `/v1/chat/completions` 相同，模型 API 需已启动 |
| `POST /api/pause` | 暂停连接，保留配对 |
| `POST /api/reconnect` | 恢复保存的配对 |
| `POST /api/disconnect` | 忘记配对并停止连接 |
| `POST /api/shutdown` | 停止客户端，保留配对 |
| `POST /api/probe` | 检查本机 Claude：`{claudeCommand?}` |
| `GET /v1/models` | B 的动态可选模型列表，需本机 API Key 和有效服务连接 |
| `POST /api/models/refresh` | `{}`；B 重新读取 CLI 目录，A 请求已配对的 B 刷新并同步 |
| `POST /v1/chat/completions` | Harness 文本和函数工具决策 |
| `POST /v1/run` | `{prompt,stream?,sessionId?,model?}` |
| `POST /v1/requests/{id}/cancel` | 取消自己的任务 |

身份、私网、配对和模型的变更接口返回完整状态。状态中的 `identity` 分别报告所选角色、是否锁定、期望上线状态和提示；`capabilities.model/proxy` 表示当前授权是否解锁页面，与实时连接是否在线分开。业务配置接口仍在后台校验身份和授权，不能通过直接请求绕过界面禁用。

管理接口遵循和页面相同的顺序：两端先 `POST /api/identity`，再 `POST /api/network/login`；B 使用不含 Claude 字段的 `POST /api/host` 创建服务，A 通过 `POST /api/join` 保存授权。需要模型时，B 随后单独调用 `POST /api/model` 配置并启用；只需代理时分别开启 B 共享与 A 本地节点。`workspace`、`claudeCommand`、`profile` 等字段不能再放进 `/api/host` 请求。切换身份前必须先成功完成 `POST /api/network/disconnect`。

`/v1/run` 保留旧版“在 B 项目执行完整任务”的语义，工具权限在 B 的模型页高级配置中设置；该入口拒绝 `kind:model`，无任务结果时不会报告成功。网页和桌面模型测试经管理端 `/api/model-test` 使用标准 Chat Completions 请求格式；Harness 使用模型端口的 `/v1/chat/completions`。桌面和网页的模型测试绑定发起时的控制连接；角色、授权或连接更换后清除旧测试结果，不自动重发请求。两个模型入口的工具执行位置不同。已支持且接收 JSON 参数的接口要求有效的 UTF-8 JSON 对象；取消接口不读取请求体。

## 权限和开源组件

B 的兼容任务可选择读取（Read/Glob/Grep）、编辑（增加 Edit/Write）或开发（增加 Bash）。工作目录、工具、默认 10 分钟执行超时及 30 轮上限由 B 决定，A 无法覆盖。工具限制和工作目录不是操作系统沙箱；兼容任务启用 Bash 时，任务拥有 B 运行账户的相应权限。主模型模式不授权 B 的这些工具，A 工具遵循 Harness 的执行与审批策略。

本软件不保证订阅账号不会受限制，也不规避服务商的认证、限额或使用政策；配对和网络加密不改变订阅授权范围。使用须遵守 [Anthropic 认证规定](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)。

Tailscale 核心客户端、CLI 和 `tsnet` 使用 BSD-3-Clause；部分官方桌面 GUI 及托管服务并非全部开源。本软件使用开源网络核心，独立开发，不代表官方背书。使用托管服务仍适用对应账号条款。[开源范围](https://tailscale.com/opensource) · [许可证](https://github.com/tailscale/tailscale/blob/main/LICENSE)

第三方许可证随 EXE 内置，可从左下角“设置 → 开源许可”查看，包含 Node.js、Tailscale、MinGW-w64、nlohmann/json 及依赖版权信息。开发网页控制台也在“设置”中提供该入口。

## 参数与开发构建

| EXE 参数 | 用途 |
| --- | --- |
| `--port 3213` | 改变本机模型 API 端口，管理端口使用 3214；不允许同一 Windows 用户启动第二个桌面 |
| `--data-dir E:\bridge-data` | 选择数据目录；更换前需退出已有桌面实例 |
| `--minimized` | 启动后直接收起到托盘；兼容旧名 `--no-browser` |
| `--demo` | 本机模拟网络及 Claude，不使用真实账号；配对单独保存 |
| `--system-tailscale` | 使用已安装的系统 Tailscale 客户端 |

开发构建需要 Node.js 22+、Python 3、C++ 和 Go 工具；Windows 命令请使用 PowerShell 7。工具脚本校验 SHA256，将便携 w64devkit 2.10.1 和 Go 1.27.2 解压到项目 `.tools`，不修改系统 PATH 或 PowerShell 安全策略。

```powershell
npm ci
python scripts/bootstrap-tools.py
npm run build:windows
python scripts/package.py
```

`package.json` 统一提供版本号，构建时生成 Windows manifest 并注入网络核心。共享构建配置、源码包及 EXE 内运行资源的白名单位于 `scripts/build_support.py`；两种打包都排除私有状态、`.env`、缓存和链接目录。

本地网络诊断可使用 `python scripts/build_windows.py --diagnostics` 构建。带独立标签的 EXE 和构建记录位于 `release/diagnostics`，构建目录及引擎与正式产物分开保存。程序标题和设置页标明“本地诊断版”，该构建不会修改 Windows 自启动注册。此命令只生成本机文件，不发布 GitHub 版本。

诊断构建还可在同一只读接口返回匿名的逐 TCP 连接快照，包括对端接收窗口、发送积压、RTT、拥塞窗口和连接自身的重传、超时计数。它使用受版本及内容校验的独立依赖副本，按请求读取状态，不改变拥塞算法或传输参数；正式构建不包含该扩展。未建立发送状态的连接不返回虚构的实测零值。快照有连接数上限，截断时明确标记；不包含地址、访问内容、配对或认证信息。

需要同时观察 JavaScript 转发队列时，可仅为诊断进程设置 `BRIDGE_FLOW_DIAGNOSTICS=1`。接口附加匿名 `proxyFlows` 数值，记录源读取、WebSocket 本地写完成、待写积压及暂停状态，并保留有界的近期关闭摘要；默认关闭，不写逐帧日志。TCP 与 JavaScript 转发流的编号属于不同命名空间，不能直接按编号对应。本地写完成不表示 A 已收到；零接收窗口说明接收链施加背压，仍不能单独定位 A 的具体应用或网络组件。

`release/claude-p2p-bridge-版本号.zip` 是源码快照，包含测试源码，不含测试数据、工具链和本机配置。构建生成 EXE 对应的 `.build.json`，记录二进制及每个源码文件的 SHA-256；源码打包核对这份记录，源码或 EXE 已变化时需重新构建。ZIP 使用原子替换，打包失败保留原文件。

每次完成新版打包后，`python scripts/package.py` 自动清理旧版发布文件。清理前须核验最新版 EXE、源码 ZIP、SHA256 校验文件和构建记录完整一致；保留这四个文件及离线网络恢复工具 ZIP，恢复 ZIP 内已包含程序、说明和校验文件，内容相同的散装副本会删除。构建或源码打包失败时不清理，仅生成源码快照时不清理；发现更高版本产物时也不清理，防止重打旧版误删新版。诊断目录和无法识别的文件不自动删除。

主要源码：`native/desktop` 为 C++ 窗口与托盘，`native/netcore` 为 Go 组网，`src` 为任务/API，`public` 为开发网页控制台。依赖由 `package-lock.json` 和 `native/go.mod` / `go.sum` 锁定。Claude 程序应在绝对 PATH 目录中，或由 B 指定绝对 `claudeCommand`；不会从项目目录或相对 PATH 自动执行同名程序。

`npm start` 提供开发网页控制台，默认数据目录为当前目录的 `.bridge`；与桌面版默认目录不同。`npm run demo` 启动两个不保存配对的源码模拟实例。源码与 EXE 的 `--demo` 均使用模拟任务；EXE 的演示配对可保存，方便测试重启恢复。

验证命令（先完成构建）：

Windows 冒烟测试共用隔离目录及端口分配工具，模型和管理端口成对检查，并避开系统动态 TCP 端口范围，防止启动探测发生自连接；测试不会修改系统端口范围。

```powershell
npm run check
npm test
python -m unittest discover -s test -p "test_*.py"
python scripts/test-startup.py
python scripts/test-single-instance.py
python scripts/smoke-native-http.py
python scripts/smoke-desktop.py
python scripts/smoke-proxy-exe.py
# Windows 权限重启验收：从普通 PowerShell 7 运行，一次 UAC 提示仅提升隔离测试阶段：
python scripts/test-windows-state-restart.py
# 使用与 Windows 构建相同的网络兼容配置，含显式 underlay 回归：
python scripts/test-native.py
```

可选的真实客户端协议验证：按 `scripts/smoke-harness-client.js` 顶部命令，将 Harness 使用的 pi-ai 1.1.0 安装到独立 `.bridge` 测试目录，再运行 `node scripts/smoke-harness-client.js`。该脚本用合成 CLI 验证实际 pi-ai 工具往返及官方 OpenAI SDK 错误处理，不访问外部模型；缺少可选依赖时明确跳过，不增加生产依赖。

测试使用合成 Claude CLI 与本机网络，覆盖加密 A/B 通道、A 端工具往返、多 A 排队及取消隔离、断线恢复、无效模型输出、DPAPI 保存、独立注册表自启动项、流式 UTF-8 分片、打包组件运行和快速退出。`test-single-instance.py` 检查新版在同一 Windows 用户下跨端口、目录、文件位置的互斥、锁权限受限时的等待与接管，以及已有窗口唤回；后续新版沿用同一锁标识，历史旧程序后启动的限制见上文。多端模拟使用打包的 `bridge-engine` 组件与各自独立的数据目录，生产桌面不提供绕过单实例限制的参数。源码/运行时白名单测试检查私有文件、缺失资源及链接路径；Windows 权限不允许创建符号链接时，相应链接回归会明确跳过。自启动测试仅写隔离 HKCU 测试键。

`test-windows-state-restart.py` 使用同一账号的真实高权限、普通权限进程，验证管理员初始化后未启动 Tailscale 就退出，再以普通权限重新打开并读取保存状态。测试拒绝缺失或跳过的阶段，检查所有者、权限、父目录及状态内容；仅使用隔离合成数据，不连接真实私网，在 `.cache/validation` 保留回执供检查。

除上述保留回执的权限测试外，Python 原生检查会在退出子进程后删除本次运行创建的测试 EXE、解包运行时和配置目录；清理只允许作用于项目内独立测试目录，遇到链接目录会拒绝删除。Mihomo 验证仅保留最新一次的 `.cache/mihomo-smoke.log`，不累积测试配置和缓存。可选的 `.bridge/harness-client-fixture` 是手动安装的测试依赖，不随每次运行自动删除；不再需要时可单独移除。普通开发控制台的 `.bridge` 可能含真实配对和配置，不能将整个目录当测试残留清空。

**真实 Pro/Max 登录后的结构化模型质量、Harness 实际安装的多轮工具行为及跨城市直连/中转，仍需在实际电脑上验证。** 合成 CLI 和模拟 EXE 测试不能证明真实订阅调用已经通过；本开发环境没有代为授权账号或调用真实模型。
