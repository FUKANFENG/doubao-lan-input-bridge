# Modern Desktop QR UI

这是豆包局域网输入桥的现代 Windows 桌面版：Electron + React 界面，内置 Python 局域网服务，并在桌面端直接显示手机扫码二维码。

## 功能

- 自动启动和停止局域网输入服务
- 自动选择可用端口和局域网 IPv4 地址
- 桌面端生成二维码，手机扫码后直接打开 Web 输入页
- 显示手机地址、本机地址、端口和服务状态
- 复制手机地址、打开本机页面、刷新网络地址、重新生成访问密钥
- 访问密钥只保存在 Windows `%APPDATA%\\DoubaoLanInputBridge`，不会写入仓库

## 目录

```text
desktop/                  Electron + React 桌面界面
doubao-lan-input-gui/     Python 后端源码和打包所需后端 EXE
docs/                     设计说明和实施计划
```

## 开发

在 `modern-desktop/desktop` 目录执行：

```powershell
npm install
npm test
npm run build
```

本地开发启动：

```powershell
npm run dev
```

## 打包

`doubao-lan-input-gui/dist/DoubaoLanInputBridge.exe` 已随源码目录保留。执行：

```powershell
npm run dist
```

便携版输出到：

```text
desktop/release/DoubaoLanInput-1.0.0-x64.exe
```

首次运行时 Windows 可能显示未签名提示；选择“更多信息”后继续运行即可。
