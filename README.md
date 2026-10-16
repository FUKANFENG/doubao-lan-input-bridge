# 豆包局域网语音输入桥

手机负责语音转文字，Windows 负责粘贴；也可以把电脑声音通过局域网传到手机扬声器。

本项目是独立工具，非豆包官方产品，不包含豆包语音识别服务。语音识别由手机输入法完成，因此也可使用其他输入法或直接输入文字。

**当前音频版：2.5.0，Windows x64 便携 EXE，无需安装 Python 或 Node.js。**

- [下载 EXE](https://github.com/FUKANFENG/doubao-lan-input-bridge/releases/download/v2.5.0/DoubaoLanInputBridge-Audio-2.5.0.exe)
- [完整发布页：运行包、源码包、SHA256](https://github.com/FUKANFENG/doubao-lan-input-bridge/releases/tag/v2.5.0)
- [更新记录](CHANGELOG.md)

## 版本与目录

| 版本 | 源码位置 | 用途 |
| --- | --- | --- |
| 音频版 2.5.0 | 仓库根目录 | 手机输入、应用匹配、输入历史、电脑声音到手机 |
| Modern Desktop QR UI 1.0.0 | [modern-desktop/](modern-desktop/) | 独立的二维码桌面版本，保留其原有后端与构建方式 |

本文说明根目录音频版。Modern Desktop 的使用与构建见[独立 README](modern-desktop/README.md)，其[历史 Release](https://github.com/FUKANFENG/doubao-lan-input-bridge/releases/tag/modern-desktop-v1.0.0)仍保留，不与音频版混用构建命令。

## 快速开始

需要 Windows 10/11 x64、可访问同一局域网的手机，以及支持 WebSocket/Web Audio 的现代手机浏览器。电脑可以用网线，手机用 Wi-Fi，但不能处于彼此隔离的访客网络。

1. 下载并运行 `DoubaoLanInputBridge-Audio-2.5.0.exe`。升级时先完全退出旧 EXE，避免端口占用。
2. 确认桌面服务已启动，默认端口为 `8765`。按需允许 Windows 防火墙在**专用网络**通信，不需要开放公网端口。
3. 手机扫描桌面二维码，在浏览器中打开页面，确认显示 `2.5.0`。二维码包含地址和访问密钥，不需要手动输入 IP。
4. 在手机顶部选择 **Windows**；电脑先点击要输入文字的位置。
5. 在手机的大文本框中使用豆包输入法语音输入，然后点击上方的**发送**。
6. 电脑把文字写入剪贴板并模拟粘贴。勾选**发送后回车**可在粘贴后自动按 Enter，默认延时可设为 `0.5` 秒。

程序不判断当前焦点是否为输入框，也不会替你切换到目标应用。请在发送前自行确认电脑焦点；自动回车可能立即提交聊天消息或执行终端命令。

便携版无需安装，但设置仍会写入 Windows 用户配置目录。桌面界面底部可查看实际目录，其中 `settings.json` 保存访问密钥、端口和应用绑定，`service.log` 保存运行诊断。EXE 未签名；遇到 SmartScreen 提示时先核对下载来源及 SHA256，不要关闭系统安全防护。

## 输入与目标系统

手机页面提供直接可点选的三个按钮，不需要展开下拉菜单：

| 模式 | 行为 |
| --- | --- |
| Windows | 写入 Windows 剪贴板，然后模拟 `Ctrl+V` |
| Mac | 在 Windows 上模拟 `Win+V`，由远程工具映射为 macOS `Command+V` |
| 自动 | 发送时识别 Windows 前台应用，按进程名绑定的规则选用粘贴方式 |

这里的 **Mac 是远程控制模式，不是原生 macOS 应用**。需要远程软件支持并启用剪贴板同步和 Win/Command 按键映射；若映射不生效，`Win+V` 可能打开本机剪贴板历史。程序直接写入剪贴板，不需要模拟 `Ctrl+C` 或 `Command+C`。

### 按应用绑定

电脑切到目标应用后，在手机“应用自动匹配”区域确认当前进程，再选择“绑定为 Windows”或“绑定为 Mac”。也可以在桌面使用“3 秒后绑定”，随后切换应用。

例如，将 Codex 绑定为 Windows，将连接 Mac 的 AnyDesk 绑定为 Mac。之后选择“自动”，发送时按前台进程匹配。用户规则优先于内置远程工具提示；没有规则的普通应用使用 Windows。手动选择 Windows/Mac 会持续生效，直到再次切换。

规则匹配的是本机进程名，不是远端操作系统探测。同一个远程程序同时连接 Windows 和 Mac 时，需手动切换；不能仅凭进程名区分不同远程会话。前台应用识别也不是输入框检测，不会以“不是输入框”为理由拒绝发送。

### 输入选项与历史

- **发送后清空**：成功后清空输入框；失败时保留内容。
- **末尾加换行**：在文字末尾添加换行字符，与模拟 Enter 是两件事。
- **发送后回车**：粘贴后等待设定延时，再模拟 Enter。
- **最近 10 条输入**：发送前先保存，失败也可找回；点记录填回文本框，或直接重发。
- **草稿**：自动保存在当前手机浏览器；清空非空文本时也会保留到历史。

发送按钮位于文本框上方，滚动时吸附在页面顶部。历史、草稿和缓冲偏好保存在浏览器本地，不是云端备份；清除浏览器数据、更换浏览器、IP 或端口后可能无法看到原记录。

## 电脑声音到手机

1. 手机扫码后点击**开始播放电脑声音**，允许浏览器播放音频。
2. 电脑端点击**开始采集**，再播放需要转发的系统声音。
3. 手机扬声器播放收到的音频；可在手机调整“音频缓冲”。
4. 不使用时停止播放/采集，或停止服务、退出桌面程序。

链路为：Windows 系统输出回环采集 → Electron AudioWorklet → 单声道 16-bit PCM → `/audio` WebSocket → 手机 Web Audio。

### 2.5.0 稳定性改进

- 采集改用 AudioWorklet 音频线程，减少桌面渲染线程忙碌带来的影响；最多保留 8 个未确认采集块，过期音频不补播。
- 手机实际预缓冲默认 **300 ms**，可调 **200–600 ms**。播放断供后目标缓冲每次增加 50 ms，最高 600 ms；手动调整可重新设定目标。
- 播放积压超过当前目标 + 400 ms 时取消旧音频源并重新缓冲；停止、重连、采样率变化时也清空旧排程，防止叠音和持续延迟。
- WebSocket 心跳及断线重连：间隔 0.5、1、2、4、8 秒，之后最高 8 秒。单个手机发送积压超过约 500 ms 时重置慢连接。
- 二进制音频帧增加序号、采样率、样本数和采集时间；仍兼容旧页面的原始 PCM，但新功能需要刷新页面。
- 手机“音频诊断”显示播放断供、队列重置、序号间断、收包间隔、采集交付延迟、丢弃帧、重连和发送积压。

**缓冲越大，通常越能容忍抖动，但延迟越高。** 缓冲值不是端到端延迟，采集分块、网络和设备输出还会增加延迟。建议先用 300 ms，出现间断时尝试 400–600 ms；看视频时可能出现音画不同步。

WebSocket 基于 TCP，提供有序可靠传输，但丢包重传也会让后续数据等待。音频间断还可能来自采集、主线程调度或手机省电，不等于一定断网。诊断中的序号间断也可能来自主动丢弃过期帧，不能直接当作网络丢包率。

### 已知限制

- 当前系统音频采集仅面向 Windows；转发的是系统输出，不是手机麦克风。
- 即使没有实体音箱，Windows 也需要有可用的音频输出端点。完全没有输出设备时可能无法采集，可启用现有输出设备或配置虚拟音频设备。
- 手机通过局域网 HTTP 即可播放，无需 HTTPS。桌面使用 AudioWorklet，手机使用标准 Web Audio，不要求手机在 HTTP 页面运行 AudioWorklet。
- 手机锁屏、切后台、省电或浏览器冻结仍可能中断播放。回到页面出现**继续播放**时需点击；重连不能绕过浏览器的用户播放授权。
- 本版提升抖动容忍度，不保证弱 Wi-Fi 下无卡顿，也不提供低延迟音画同步或立体声传输。

## 安全与隐私

- 服务监听 `0.0.0.0`，只应在可信局域网使用；不要做公网端口转发或暴露到互联网。
- 当前为明文 HTTP/WS，访问密钥不是传输加密，也不是逐设备授权。获得带密钥链接的人可以触发粘贴，并在采集开启时接收系统声音。
- 不要公开二维码、完整手机 URL、`settings.json` 或包含密钥的截图。泄露后先停止服务、重新生成密钥，再扫码连接。
- 系统声音可能包含通话及其他应用的敏感音频，开启采集前请确认内容适合转发。
- 本项目把文字和音频在局域网内转发；手机输入法自身是否上传语音，取决于该输入法的服务与隐私设置。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 手机打不开页面 | 确认同一局域网、未开启访客隔离；检查专用网络防火墙；不要用电脑的 `127.0.0.1` 地址访问 |
| 二维码 IP 不对 | 多网卡/VPN 可能影响地址选择，选择桌面列出的正确局域网地址；本机处于 `192.168.1.x` 时，优先核对该网卡的地址 |
| 启动失败或端口占用 | 退出旧 EXE/旧服务，或停止服务后更换端口并重新扫码 |
| 发送成功但没有粘贴 | 检查电脑焦点、所选模式和远程映射；接口成功表示已执行按键，不保证目标程序接受 |
| 管理员程序无法粘贴 | Windows 可能阻止低权限进程模拟输入；确有需要时以管理员权限启动本程序 |
| Mac 模式打开了 Windows 剪贴板 | 检查远程软件的 Win/Command 映射、剪贴板同步和远程窗口焦点 |
| 页面仍是旧版 | 完全退出旧程序，运行新版，关闭旧手机页面并重新扫码，确认版本号 |
| 电脑无音箱且手机也没声音 | 检查 Windows 默认输出设备是否存在、音量是否静音、采集是否开启、手机是否已点开始播放 |
| 声音断续/越播越慢 | 查看音频诊断，尝试增大缓冲、靠近路由器、保持手机页面前台，排除采集端和省电问题 |
| 发送后提示失败 | 先检查电脑是否已收到文字，避免重复发送；从最近输入恢复内容，并查看桌面日志 |

## 源码开发

根目录音频版使用 React + Vite + Electron、Node.js HTTP/WebSocket 服务，以及 Python/Win32 键盘辅助程序。

构建环境：Windows x64、Node.js 22.12+、npm、Python 3（包含 `py` 启动器）。首次安装和构建需下载 npm 依赖、Electron、PyInstaller 等。开发环境要求与已打包 EXE 不同。

```powershell
git clone https://github.com/FUKANFENG/doubao-lan-input-bridge.git
Set-Location doubao-lan-input-bridge
# 构建本次发布请检出固定标签；日常开发可留在 master
git checkout v2.5.0
npm ci
powershell -ExecutionPolicy Bypass -File .\build-helper.ps1
npm run dev
```

`build-helper.ps1` 创建 `.helper-venv` 并生成 `helper-dist/key_helper.exe`。`npm run dev` 启动 Vite 和 Electron；开发服务地址只绑定本机，手机仍通过桌面程序提供的局域网 URL 连接。

```text
electron/                  桌面主进程、手机页面、音频传输与播放
src/                       React 界面、AudioWorklet 采集
helper/key_helper.py       Windows 剪贴板与键盘操作
tests/                     单元、WebSocket、浏览器与 Electron 回归测试
modern-desktop/            另一个独立桌面版本，详见其 README
```

### 测试

```powershell
npm test
npm run build:renderer
```

可选浏览器回归需要本机 Chrome 和 Playwright，不属于 EXE 的运行依赖：

```powershell
npm install --no-save --package-lock=false playwright
node tests/browser-smoke.cjs
node tests/electron-smoke.cjs
```

也可以设置 `PLAYWRIGHT_MODULE` 为已有 Playwright 模块的绝对路径。浏览器回归需先构建 renderer；Electron 回归使用隔离的配置目录。

2.5.0 已通过 28 项单元/本机 WebSocket 测试、renderer 构建、Chrome 回归和 Electron 回归。合成音频测试覆盖 AudioWorklet → WebSocket → 播放链路、180 ms 传输停顿、暂停恢复、断线重连、缓冲持久化和停止清理；包含 320/390/768 像素宽度页面检查。测试不触发真实 Windows 粘贴，也不采集用户系统声音。真实手机、弱 Wi-Fi、锁屏省电及不同机型仍需实机验证。

### 打包

```powershell
npm run build
```

输出 `release\DoubaoLanInputBridge-Audio-2.5.0.exe`。需要按版本分目录保留产物时：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-helper.ps1
npm run build:renderer
npx electron-builder --win portable --config.directories.output=release/2.5.0
```

发布页的运行 ZIP 包含 EXE、README 和更新记录；`Source.zip` 是 `v2.5.0` 标签对应的完整仓库快照，包含 `modern-desktop/`，不包含运行密钥、用户配置、日志、`node_modules` 或本次构建目录。保留了 modern-desktop 原有的已跟踪后端 EXE 构建输入。GitHub 自动生成的 Source code 下载同样对应标签源码。

## 升级与回退

升级前退出旧程序，保留配置目录备份，再运行新版并刷新手机页面；同一音频版的应用绑定和密钥从原配置读取。浏览器历史按站点地址保存，IP/端口不变时通常可继续使用。

需要回退时完全退出 2.5.0，运行[历史 2.4.0](https://github.com/FUKANFENG/doubao-lan-input-bridge/releases/tag/v2.4.0)，重新打开其手机页面。2.5.0 未替换历史 Release，2.4.0 不包含本次音频缓冲、重连和诊断改进。
