# 更新记录

## 2.5.0 - 2026-10-16

### 新增

- 手机音频预缓冲默认 300 ms，可调 200–600 ms，并保存在当前浏览器。
- 断供后自动增加目标缓冲，每次 50 ms，最高 600 ms。
- WebSocket 心跳、退避重连、慢连接重置和手机继续播放入口。
- 音频帧序号、采样率、样本数、采集时间及分阶段诊断指标。
- 音频单元测试、真实本机 WebSocket 集成测试、Chrome 与隔离 Electron 回归测试。

### 改进与修复

- 用 AudioWorklet 替换 ScriptProcessorNode，在音频线程采集单声道 16-bit PCM。
- 限制采集 IPC 在途块数量，丢弃过期帧，避免无限累积延迟。
- 溢出、重连、停止、采样率变化时取消旧音频源，修复叠音和旧排程残留。
- 应用退出时清理音频连接和键盘辅助进程。
- 保留局域网 HTTP 和旧格式 PCM 兼容，不改变文字粘贴、应用绑定与输入历史功能。
- 完善下载、扫码、远程 Mac、隐私安全、音频排错、构建和回退说明。
- 合并并保留仓库已有的 `modern-desktop/` 独立版本。

### 验证与限制

- 28 项单元/本机 WebSocket 测试通过；renderer、Chrome 和 Electron 回归通过。
- 合成音频回归包含 180 ms 传输停顿、暂停/恢复、重连、缓冲持久化、停止清理和移动端布局。
- 未替代真实手机、弱 Wi-Fi、锁屏/省电及实际系统输出设备测试；不保证任意网络下无卡顿。
- 缓冲增加会提高延迟；采集目前为 Windows 单声道，Mac 是远程粘贴映射模式。

升级时退出旧 EXE、打开 2.5.0、重新扫码或刷新手机页面。完整说明见 [README](README.md)。

## 历史发布

- [音频版 2.4.0](https://github.com/FUKANFENG/doubao-lan-input-bridge/releases/tag/v2.4.0)：本次升级前的音频版，包含应用自动匹配粘贴方式、手机输入历史和二维码配对。
- [Modern Desktop QR UI 1.0.0](https://github.com/FUKANFENG/doubao-lan-input-bridge/releases/tag/modern-desktop-v1.0.0)：独立桌面版本，源码与构建说明位于 `modern-desktop/`。
