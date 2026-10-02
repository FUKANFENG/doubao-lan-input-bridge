# Modern Desktop QR UI Design

## Goal

Build a modern Windows desktop EXE for Doubao LAN Input Bridge that starts the local LAN input service and shows a polished control panel with a scannable QR code for the phone URL.

## Architecture

Use Electron with a React/Vite renderer because this machine already has Node/npm and does not have Rust/Cargo for Tauri. Keep the existing Python/PyInstaller service executable as the bridge backend and package it as an Electron extra resource. Electron owns service lifecycle, port selection, LAN IP selection, access key reading, and IPC; React owns the desktop UI.

## User Experience

The app opens to a compact dashboard. The primary visual focus is a large QR code for the selected phone URL. Nearby controls show service status, port, selected LAN address, access key, and exact phone URL. Actions include copy phone URL, open local page, refresh network addresses, regenerate key, start service, and stop service.

If the default port is occupied, the app automatically chooses the next available port. If multiple network interfaces exist, the UI should prefer real private LAN addresses such as `192.168.x.x` and demote virtual adapters such as WSL, vEthernet, and ZeroTier. The user can still choose from detected usable addresses.

## Components

- Electron main process: starts/stops `DoubaoLanInputBridge.exe --server-only --port <port>`, reads `%APPDATA%\DoubaoLanInputBridge\access_key.txt`, detects LAN IPs, selects free ports, and exposes IPC APIs.
- React renderer: renders the dashboard, QR code, status states, URL controls, network selector, and service controls.
- Shared utilities: deterministic network filtering, URL construction, and port constants.
- Build system: Vite, TypeScript, Electron, electron-builder.

## Testing

Add Vitest unit tests for URL building, LAN interface filtering, and preferred address selection. Add service management tests around pure helpers only; process spawning remains manually verified because it depends on the bundled Windows executable.

## Packaging

Create a new `desktop/` app folder. Do not remove the existing Python GUI. Package the current `dist/DoubaoLanInputBridge.exe` into the Electron app resources and output a Windows build artifact under `desktop/release/`.

## Constraints

No Rust/Tauri dependency. Do not rewrite the Python service in this pass. Do not alter the service HTTP API unless needed for the desktop shell.
