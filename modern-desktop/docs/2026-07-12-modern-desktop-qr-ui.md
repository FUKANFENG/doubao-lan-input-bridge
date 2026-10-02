# Modern Desktop QR UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron/React Windows desktop app that starts the existing Doubao LAN Input Bridge service and displays a QR-code-first modern control panel.

**Architecture:** The Electron main process manages service startup, port selection, LAN IP detection, access key reading, and IPC. The React renderer displays status, QR code, URL controls, and service actions. The existing Python-built `dist/DoubaoLanInputBridge.exe` is packaged as an extra resource and remains the backend bridge.

**Tech Stack:** Electron, React, Vite, TypeScript, Vitest, qrcode, electron-builder, existing PyInstaller backend EXE.

---

### Task 1: Scaffold Desktop App

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/index.html`
- Create: `desktop/tsconfig.json`
- Create: `desktop/tsconfig.node.json`
- Create: `desktop/vite.config.ts`
- Create: `desktop/vitest.config.ts`
- Create: `desktop/src/renderer/main.tsx`
- Create: `desktop/src/renderer/App.tsx`
- Create: `desktop/src/renderer/styles.css`

- [ ] Write minimal package scripts for `dev`, `build`, `test`, and `dist`.
- [ ] Add React/Vite/Electron dependencies.
- [ ] Create a placeholder renderer that can compile before feature work.

### Task 2: Shared URL and Network Helpers

**Files:**
- Create: `desktop/src/shared/urls.ts`
- Create: `desktop/src/shared/network.ts`
- Create: `desktop/src/shared/network.test.ts`
- Create: `desktop/src/shared/urls.test.ts`

- [ ] Write failing tests for phone URL construction.
- [ ] Write failing tests proving WSL, vEthernet, loopback, link-local, and ZeroTier addresses are demoted or excluded from the primary recommendation.
- [ ] Implement helpers to make the tests pass.

### Task 3: Electron Main Service Manager

**Files:**
- Create: `desktop/src/main/main.ts`
- Create: `desktop/src/main/serviceManager.ts`
- Create: `desktop/src/main/preload.ts`
- Create: `desktop/src/shared/types.ts`

- [ ] Write service state types and IPC API names.
- [ ] Implement free-port probing starting at `8765`.
- [ ] Implement backend executable path resolution for dev and packaged modes.
- [ ] Implement start/stop/status IPC.
- [ ] Implement key reading from `%APPDATA%\DoubaoLanInputBridge\access_key.txt`.

### Task 4: React Dashboard UI

**Files:**
- Modify: `desktop/src/renderer/App.tsx`
- Modify: `desktop/src/renderer/styles.css`

- [ ] Build a modern two-column dashboard with a QR panel and service details.
- [ ] Generate QR code from the selected phone URL.
- [ ] Add copy/open/refresh/start/stop controls.
- [ ] Add IP selector when multiple usable addresses are detected.

### Task 5: Build and Verify

**Files:**
- Modify: `desktop/package.json`

- [ ] Run unit tests.
- [ ] Run TypeScript/Vite build.
- [ ] Start Electron in dev mode and verify the service listens.
- [ ] Run `npm run dist` and verify a Windows artifact is produced.

### Self-Review

The plan covers the approved design: Electron modern shell, QR code, URL display, IP filtering, service controls, packaging, and preservation of the original Python service. There are no placeholder tasks requiring unspecified implementation.
