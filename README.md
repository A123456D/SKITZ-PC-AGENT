# Mouse & Keys Agent

Companion helper for **[Skitz Mouse & Keys](https://skitz-games.pages.dev/pc/)** (Android).
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

**Linux:** extract the tar.gz and run `Install Mouse & Keys Agent.sh`. Bundled Node runtime;
the GUI needs Python 3 (preinstalled on most distros).

## Pair

On the phone: Mouse & Keys → **Agent** tab → **Find PC** → type the PIN shown in the
helper window. After pairing, the agent reconnects automatically and self-updates from
the SKITZ site.

## Upgrading from an older agent

Agent 1.7.5 and newer check for updates every hour and restore themselves if an update
fails to start, so most people never do this by hand.

**Agents older than 1.7.5 could not update themselves** and must be replaced once:

1. Delete the folder `%LOCALAPPDATA%\SkitzPcAgent` on the PC.
2. Download and unzip the current archive into that folder.
3. Run `SkitzPcAgent.exe`.

Step 1 matters. Overwriting in place leaves an old screen-capture helper on disk that
Windows Defender flags as a trojan, which is what made mirroring look broken.

## Files in this repo

These archives are the release artifacts served by the SKITZ site's download endpoint.
Source code lives in the private SKITZ-GAMES repository (`pc-controller/pc-agent`).

`capture-source.cs.txt` is the screen-capture source. It is compiled in memory inside
`powershell.exe` the first time mirroring starts, so the archive contains no
screen-capture executable and nothing for an antivirus to flag.
