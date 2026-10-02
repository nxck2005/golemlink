# golemlink

A self-hosted remote client for **Minecraft: Java Edition**, in the spirit of
the ChatCraft mobile app. A small Node.js daemon keeps one or more
[Mineflayer](https://github.com/PrismarineJS/mineflayer) bots connected to
servers and serves a touch-first web UI from the same process. It is built to
run inside **Termux on Android**, but runs unchanged on any Linux box.

> Not an official Minecraft product. Not approved by or associated with Mojang
> or Microsoft.

## Features

- **Accounts:** Microsoft device-code login and offline-mode usernames.
  Several sessions (account × server) run at once, each isolated: one bot
  crashing or getting kicked never affects the others or the daemon.
- **Chat:** colored chat with a searchable backlog, chat and `/commands`,
  command tab-complete, per-session JSONL logs.
- **Movement:** virtual joystick, jump/sprint/sneak, drag-to-look and ±90°
  buttons, step N blocks, tap-the-map go-to, interact/use, anti-AFK.
- **Inventory:** player inventory, hotbar and any open container window with
  desktop click semantics (tap = left click, long-press = right click), cursor
  banner, drop one / drop stack, item detail sheet.
- **Mini-map:** top-down color map with relief, water depth and nearby players,
  built from chunk data in time slices so the physics tick is never starved.
- **Alerts:** keyword mentions, damage, death, kicks and Microsoft sign-in
  codes, shown as toasts and (on Termux) as Android notifications.
- **Resilience:** closing the UI never affects the bots; the UI reconnects and
  resyncs from a snapshot, and the daemon reconnects to servers with backoff.

## Supported Minecraft versions

golemlink supports every version Mineflayer 4.39.0 was tested against:
**1.8.8 – 26.1** (see `hello.supportedVersions` or the startup log for the
exact list). A server's `version` defaults to `"auto"`, which pings the server
and picks the right protocol.

If the server runs an unsupported version (for example 26.3 today), the session
stops and reports the server's version, the supported range and the remedy:
pin a supported version, and run **ViaVersion + ViaBackwards** on servers you
control.

## Requirements

- Node.js **22 or newer** (`nodejs-lts` in Termux).
- No compiler, no native modules, no build step.
- For Android notifications and wake locks: the Termux:API app plus the
  `termux-api` package, installed from the **same source** as Termux.

## Install and run

On a Linux box:

```sh
npm ci
node scripts/check-no-native.mjs
node src/main.js --open            # --open needs Termux; prints the URL otherwise
```

On Android (Termux):

```sh
scripts/termux-setup.sh            # installs packages, runs npm ci and the native check
scripts/start.sh --open            # restart-on-crash wrapper with a wake lock
scripts/stop.sh                    # sends SIGTERM to the daemon
```

The daemon prints a tokened URL to stdout only:

```
golemlink: open http://127.0.0.1:8765/#t=<token>
```

The UI moves the token from the fragment into `localStorage` and clears the
fragment. If you start the daemon in the background, get the URL with
`node src/main.js --print-url`.

### First session

1. Open the printed URL in the phone's browser.
2. **Setup → Accounts → + Add account.** Pick `offline` for an offline-mode
   server, or `microsoft` for a premium account (the username is the email).
3. **Setup → Servers → + Add server.** Give it an id, host and port; leave
   `version` on `auto`.
4. **Setup → Sessions**: choose the account and server, then **Start session**.
5. For a Microsoft account, a banner shows the device code and link; sign in
   there and the session finishes connecting.
6. Switch to **Chat** or **Move**. The session picker in the top bar switches
   between running sessions.

### Termux:Widget shortcuts

Place these in `~/.shortcuts/tasks/` (Widgets → Termux:Widget). Tasks run in
the background, so there is no terminal session to close:

```sh
mkdir -p ~/.shortcuts/tasks
cat > ~/.shortcuts/tasks/golemlink <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
cd ~/golemlink && scripts/start.sh --open
EOF
cat > ~/.shortcuts/tasks/golemlink-stop <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
cd ~/golemlink && scripts/stop.sh
EOF
chmod +x ~/.shortcuts/tasks/golemlink ~/.shortcuts/tasks/golemlink-stop
```

### Android background rules

- Turn battery optimization **off** for Termux.
- Android 12L+: `adb shell "settings put global settings_enable_monitor_phantom_procs false"`
  (can be run from Termux over wireless debugging).
- Android 12 only: lift the 32-process limit with
  `device_config put activity_manager max_phantom_processes 2147483647`.
  Android 12 cannot disable the high-CPU kill; the daemon may still be killed.
- Android 14+: also enable Developer options → "Disable child process restrictions".

`scripts/termux-setup.sh` prints the same list with more detail.

## Configuration

Everything lives in `~/.golemlink` (mode 0700). `config.json` is edited by the
Setup tab in the UI, or by hand:

```json
{
  "version": 1,
  "http": { "port": 8765 },
  "accounts": [
    { "id": "main", "auth": "microsoft", "username": "you@example.com" },
    { "id": "alt",  "auth": "offline",   "username": "NickAlt" }
  ],
  "servers": [
    {
      "id": "lobby", "name": "My network", "host": "play.example.net", "port": 25565,
      "version": "auto", "autoReconnect": true, "chatLog": true,
      "antiAfk": { "enabled": false, "intervalSec": 90 },
      "alerts": { "keywords": ["Nick"], "damage": true, "death": true },
      "resourcePack": "accept", "autoLogin": null
    }
  ],
  "autostart": ["main@lobby"],
  "minimap": { "radiusChunks": 6 },
  "deadmanMs": 600,
  "termux": { "wakeLock": true, "notifications": true }
}
```

- `autoLogin` is `{ "password": "…", "trigger": "/(login|log in)/i" }` or `null`.
  Passwords never leave the daemon; the UI only sees `hasAutoLogin`.
- `resourcePack` is `"accept"` (default) or `"deny"`. Nothing is downloaded.
- Data directories on shared storage (`/sdcard`, `/storage/…`) are refused,
  because other Android apps can read them.

### Anti-AFK

Off by default. When enabled it makes a small yaw change and one jump every
`intervalSec` (±25 %) while no control lease or goto is active. **Check your
server's rules first**: AFK evasion policies vary and using it may be against
them.

## CLI

```
node src/main.js [--port 8765] [--data-dir ~/.golemlink] [--open]
                 [--print-url] [--unsafe-bind <ip>]
```

The daemon binds `127.0.0.1` only. `--unsafe-bind <ip>` exposes one interface
address with a loud warning. **Use an SSH tunnel instead**, which needs no
unsafe bind:

```sh
ssh -L 8765:127.0.0.1:8765 <phone>
```

## Security

- The token in `~/.golemlink/token` is the real gate. It is printed to stdout
  only, never written to `daemon.log`.
- WebSocket upgrades check `Origin` and `Host` (DNS-rebinding guard); bad ones
  are closed with code 4401.
- Only `GET`/`HEAD` are served, only from `web/`; traversal and dotfiles are
  rejected. HTML is `no-store`; a strict CSP forbids inline scripts and external
  requests.
- Logs never contain the token, account passwords or Microsoft tokens.

## Performance

With one online session the daemon targets an event-loop delay p99 under
20 ms (measured with `perf_hooks.monitorEventLoopDelay`, shown in the Setup tab;
a warning is logged if it stays above 50 ms). `status` is sent at most 5 Hz,
players at 2 Hz, and map tiles in batches of at most 32. RSS is logged every
5 minutes.

## Development

```sh
npm test        # native-dependency check + node:test unit/integration tests
npm run e2e     # tier 1 fake server (required) + tier 2 vanilla server (optional)
npm run test:ui # optional: requires Playwright and its Chromium browser
npm run test:ui:movement # optional: real joystick-to-Minecraft integration
```

`npm run e2e` drives the daemon only through its WebSocket API. Tier 2 needs
Java 21+ and Mojang's servers; when either is missing it prints
`SKIPPED: <reason>` and exits 0. `MC_VERSION` overrides the tested version
(default `1.21.11`).

See `docs/PROTOCOL.md` for the wire protocol, `docs/DECISIONS.md` for choices
made where the spec was open, and `docs/REPORT.md` for the implementation
report.

The browser smoke test checks setup, chat search, status bars, inventory clicks,
session isolation, server-menu left/right clicks (mouse, long press, and details
actions), and phone portrait/landscape and desktop layouts. Playwright is not a
daemon dependency: install it separately and set `UI_PLAYWRIGHT_MODULE` to its
absolute `index.mjs` path if it is not available in this project's dependencies.
Set `UI_SCREENSHOTS` to a directory to save screenshots of each tab.

The movement browser test uses a disposable offline Minecraft test server and
the real daemon modules. It checks walking speed, stationary-drag heartbeats,
direction changes, the dead zone, release outside the joystick, lost capture,
snapshot resync, blur, tab switches, touch cancellation, and two-finger jump.

## License

MIT — see `LICENSE`.
