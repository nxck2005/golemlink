# golemlink

A self-hosted remote client for **Minecraft: Java Edition**, in the spirit of
the ChatCraft mobile app. A small Node.js daemon keeps one or more
[Mineflayer](https://github.com/PrismarineJS/mineflayer) bots connected to
servers and serves a web UI for desktop and phone from the same process. It
runs on any Linux box (for example a home server reached over Tailscale) and
inside **Termux on Android**.

> Not an official Minecraft product. Not approved by or associated with Mojang
> or Microsoft.

## Features

- **Accounts:** Microsoft device-code login and offline-mode usernames.
  Several sessions (account × server) run at once, each isolated: one bot
  crashing or getting kicked never affects the others or the daemon.
- **Chat:** colored chat with a searchable backlog, chat and `/commands`,
  command tab-complete, per-session JSONL logs.
- **Sign-in:** one username and password for the web UI, set up with a
  one-time code from the terminal. Devices stay signed in for 90 days and can be
  signed out from Setup.
- **Play:** the held item with Use and Interact, the hotbar, backpack and armor,
  and any container the server opens (such as a server selector), shown as
  soon as it opens. Mouse clicks work as in the game (left, right, shift-click,
  Q to drop); on touch a tap is a left click and a long press opens a menu with
  right click, shift-click and drop. Keys 1–9, E (use) and F (interact).
- **Scoreboard:** the server's sidebar scoreboard and boss bars on Play, in
  their Minecraft colours. The Server view adds the tab list: header, players
  with their team names and ping, and footer.
- **Item textures:** real item and block icons, taken from Mojang's client jar
  for the server's version the first time a bot joins it.
- **Movement:** keyboard WASD and holdable buttons, Space to jump,
  sprint/sneak, drag the map to look, ±90° turns, tap the map to walk there,
  anti-AFK.
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

On a Linux box reached over Tailscale:

```sh
npm ci
node scripts/check-no-native.mjs
node src/main.js --tailscale
```

`--tailscale` listens on this machine's Tailscale address as well as
`127.0.0.1`, and accepts its MagicDNS name. Without it the daemon listens on
`127.0.0.1` only. The default port is 6767.

On Android (Termux):

```sh
scripts/termux-setup.sh            # installs packages, runs npm ci and the native check
scripts/start.sh --open            # restart-on-crash wrapper with a wake lock
scripts/stop.sh                    # sends SIGTERM to the daemon
```

The first time it starts, the daemon prints the address and a setup code:

```
golemlink: open http://confessor.tail1234.ts.net:6767/
           or http://100.67.54.111:6767/
           or http://127.0.0.1:6767/
golemlink: no login yet. Open the page and create one with this code:
golemlink: setup code 123 456 (valid for 15 minutes, works once)
```

Open the page, enter the code, and choose a username and password. That
browser stays signed in for 90 days; other devices sign in with the same
username and password. If the code expires, reload the page and a new one is
printed. Forgot the password? Stop the daemon and run
`node src/main.js reset-password`, then start it again for a new code.

### First session

1. **Setup → Minecraft accounts → Add account.** Pick Microsoft for a premium
   account (the username is the email) or Offline for an offline-mode server.
2. **Setup → Servers → Add server.** Give it an ID, host and port; leave the
   version on `auto` (under More settings).
3. **Setup → Sessions → New session**: choose the account and server, then
   **Start session**.
4. For a Microsoft account, a banner shows the sign-in code and link; sign in
   there and the session finishes connecting.
5. **Play** shows the held item and inventory. Use the item (or tap its hotbar
   slot again) to open a server's menu, and click in the window that appears.
   On a phone, **Chat** and **Move** are tabs; on a desktop, chat sits on the
   right and sessions in the left rail.

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
  "http": { "port": 6767, "tailscale": false, "allowedHosts": [] },
  "itemTextures": true,
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
- `http.tailscale: true` does the same as `--tailscale`; `http.bind` is one
  extra interface IP. `http.allowedHosts` adds host names the page may be
  opened under, such as a reverse proxy's name.
- `itemTextures: false` turns off the texture download. Items then show as
  two-letter tiles.
- Data directories on shared storage (`/sdcard`, `/storage/…`) are refused,
  because other Android apps can read them.

### Anti-AFK

Off by default. When enabled it makes a small yaw change and one jump every
`intervalSec` (±25 %) while no control lease or goto is active. **Check your
server's rules first**: AFK evasion policies vary and using it may be against
them.

## CLI

```
node src/main.js [--tailscale] [--bind <ip>] [--port 6767]
                 [--data-dir ~/.golemlink] [--open]
node src/main.js reset-password
```

The daemon always listens on `127.0.0.1`. `--tailscale` adds the Tailscale
address; `--bind <ip>` adds one other interface address (`--unsafe-bind` still
works as another name for it). Anything that can reach that address sees the
sign-in page, so prefer the tailnet over a LAN or public address.

### Item textures

When a bot first joins a server running a Minecraft version golemlink has no
textures for, the daemon downloads that version's client jar from Mojang
(about 30 MB, checked against its SHA-1), extracts the item and block PNGs into
`~/.golemlink/textures/<version>/` and deletes the jar. This happens once per
version. The browser fetches a small index, then each PNG only when an item
that needs it is on screen, and caches them for a week. Items Minecraft draws
as 3D models (chests, beds, shields, heads) show as letter tiles.

## Security

- The web login is the gate. The password is stored as an scrypt hash in
  `~/.golemlink/auth.json` (mode 0600). Each device gets a random token in an
  `HttpOnly`, `SameSite=Strict` cookie; the daemon keeps only its SHA-256.
- The setup code is printed to stdout only, lasts 15 minutes, works once, and
  is replaced after 5 wrong tries. Sign-in is limited to 5 failures per IP and
  20 overall per minute.
- Every request's `Host` must be a known name for this daemon (127.0.0.1,
  localhost, its bind and Tailscale addresses, or `http.allowedHosts`); others
  get 421. WebSocket upgrades also check `Origin` and the cookie; failures are
  closed with code 4401. API writes need a same-origin `Origin`.
- Besides the sign-in API, only `GET`/`HEAD` are served, from `web/` and (when
  signed in) the texture folder; traversal and dotfiles are
  rejected. HTML is `no-store`; a strict CSP forbids inline scripts and external
  requests.
- Logs never contain login tokens, passwords, setup codes or Microsoft tokens.

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
npm run test:ui:movement # optional: real keyboard/touch-to-Minecraft integration
```

`npm run e2e` drives the daemon only through its WebSocket API. Tier 2 needs
Java 21+ and Mojang's servers; when either is missing it prints
`SKIPPED: <reason>` and exits 0. `MC_VERSION` overrides the tested version
(default `1.21.11`).

See `docs/PROTOCOL.md` for the wire protocol, `docs/DECISIONS.md` for choices
made where the spec was open, and `docs/REPORT.md` for the implementation
report.

The browser smoke test checks first-run setup and sign-in, Setup forms, chat
search, status bars, using the held item, inventory and container clicks
(mouse left/right/shift, tap, long-press menu), map drag and tap, session
switching, and phone portrait/landscape and desktop layouts. Playwright is not a
daemon dependency: install it separately and set `UI_PLAYWRIGHT_MODULE` to its
absolute `index.mjs` path if it is not available in this project's dependencies.
Set `UI_SCREENSHOTS` to a directory to save screenshots of each view.

On the **Move** view, hold **W/A/S/D** on your keyboard (forward/left/back/right)
and **Space** to jump. You can also hold the on-screen W/A/S/D buttons. Keys
never control the bot while typing in a field or viewing another view, and
movement is released when you leave the view or window.

The movement browser test uses a disposable offline Minecraft test server and
the real daemon modules. It checks keyboard movement, typing safety, walking
speed, hold heartbeats, diagonal movement, button/key combinations, release,
lost capture, snapshot resync, blur, tab switches, and multi-touch jump.

## License

MIT — see `LICENSE`.
