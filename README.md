# 豆包语音输入桥 React/Electron 音频版

这是 React 桌面 GUI + 内置局域网 Web 服务版本。除手机语音输入到 Windows 自动粘贴外，2.1 版新增“电脑声音到手机播放”。

## 功能

- 桌面端显示二维码，手机扫码打开 Web UI。
- 手机端用豆包输入法语音转文字，点击发送后 Windows 自动粘贴到当前焦点。
- 手机端保留：发送后清空、末尾加换行、发送后回车、回车延时。
- 粘贴模式支持自动、Windows、Mac 远程。
- 新增电脑声音桥：
  - 手机扫码后点击“开始播放电脑声音”。
  - 电脑端点击“开始采集”。
  - Windows 通过 Electron system audio loopback 捕获电脑输出声音。
  - 音频转为 16-bit PCM，通过 `/audio` WebSocket 发给手机。
  - 手机用 Web Audio API 从扬声器播放。

## 使用步骤

1. 运行 EXE。
2. 手机和电脑连接同一个局域网。
3. 手机扫码打开页面。
4. 输入文字时，先点到电脑目标输入框，再在手机页面发送。
5. 播放电脑声音时：
   - 手机上点击“开始播放电脑声音”。
   - 电脑端点击“开始采集”。
   - 电脑端显示正在推送后，手机会播放电脑输出音频。

## 音频限制

- 系统音频 loopback 当前按 Windows 实现。
- 手机浏览器必须先由用户点击“开始播放”，否则浏览器会阻止自动播放声音。
- 如果 Windows 完全没有可用输出设备，loopback 可能没有可捕获的系统声音。此时需要启用一个音频输出设备，或安装虚拟声卡/虚拟音频线。
- 局域网质量会影响延迟和稳定性。

## 开发

```powershell
npm install
npm run build:renderer
```

## 打包

```powershell
npm run build
```

产物在：

```text
release\DoubaoLanInputBridge-Audio-2.1.0.exe
```
