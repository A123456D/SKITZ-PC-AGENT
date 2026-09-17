# SKITZ PC Agent

Companion helper for **[Skitz Pc Controller](https://skitz-games.pages.dev/pc/)** (Android).
Run it on your Windows or Linux PC to give the phone app its Wi-Fi touchpad, keyboard,
power, and shortcut controls on the same network.

## Download

Get it from the product site — it serves these exact files:

- Windows: https://skitz-games.pages.dev/pc/downloads/skitz-pc-agent-windows.zip
- Linux (Intel/AMD): https://skitz-games.pages.dev/pc/downloads/skitz-pc-agent-linux-x64.tar.gz
- Linux (ARM): https://skitz-games.pages.dev/pc/downloads/skitz-pc-agent-linux-arm64.tar.gz

## Install

**Windows:** unzip, double-click `SkitzPcAgent.exe`. A PIN window appears; the helper
stays in the notification area. Right-click the tray icon → Stop to quit.
Windows SmartScreen may warn on first run (the binary is unsigned) — choose
*More info → Run anyway*.

**Linux:** extract the tar.gz and run `Install SKITZ PC Agent.sh`. Bundled Node runtime;
the GUI needs Python 3 (preinstalled on most distros).

## Pair

On the phone: Pc Controller → **Agent** tab → **Find PC** → type the PIN shown in the
helper window. After pairing, the agent reconnects automatically and self-updates from
the SKITZ site.

## Files in this repo

These archives are the release artifacts served by the SKITZ site's download endpoint.
Source code lives in the private SKITZ-GAMES repository (`pc-controller/pc-agent`).
