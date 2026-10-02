# Golemlink — implementation spec

> **How to use:** save this as `SPEC.md` in an empty git repo, commit it alone on `main`, and tag that commit `spec` (`git tag spec`). Then tell each agent: "Read SPEC.md and implement it end to end."

You are implementing **Golemlink** (package and command name `golemlink`): a self-hosted remote client for Minecraft: Java Edition, in the spirit of the ChatCraft mobile app. A Node.js daemon runs inside **Termux on Android** (or on any Linux box), keeps one or more Mineflayer bots connected to servers, and is controlled from a touch-first web UI in the phone's browser over a localhost WebSocket.

Build the whole thing in this repository. Work autonomously:
- Read this entire spec first, then plan against the milestones in §14.
- Don't ask questions. When something is ambiguous, pick the simplest option consistent with this spec and record it in `docs/DECISIONS.md`.

## 1. Scope (v1)

- **Accounts:** Microsoft (device-code login) and offline-mode usernames. Several sessions (account × server) can run at once.
- **Chat:** colored chat, sending messages and commands, tab-complete, per-session logs.
- **Movement:** joystick, jump/sprint/sneak, look, step N blocks, tap-the-map go-to, interact with the block or entity under the crosshair, use the held item, anti-AFK.
- **Inventory:** player inventory, hotbar, and any open window (chests, NPC or compass server-selector menus), with desktop click semantics.
- **Mini-map:** top-down color map around the bot, with nearby players.
- **Alerts:** keyword mentions, damage, death, kicks, and the Microsoft login code — shown in the UI and as Android notifications.
- **Resilience:** closing the UI never affects the bot; the UI reconnects and resyncs from a snapshot. The daemon reconnects to servers with backoff.

## 2. Hard constraints

- **Runtime:** Node.js ≥ 22 (Termux package `nodejs-lts`). ESM (`"type": "module"`), plain JavaScript (JSDoc types are fine). No TypeScript, bundler, transpiler or build step.
- **Dependencies:** runtime deps are `mineflayer`, `mineflayer-pathfinder`, `ws` (plus `vec3` only if you import it directly). Exact versions with no ranges; commit `package-lock.json`. No dev dependencies; tests use `node:test`. Don't add `ws`'s optional native peers (`bufferutil`, `utf-8-validate`).
- **Pure-JS dependency tree:** no native addons. `scripts/check-no-native.mjs` fails if any installed package contains `binding.gyp`, `"gypfile": true`, or a prebuilt `.node` file, and warns (doesn't fail) on install scripts. `npm test` runs it.
- **One daemon process:** no `worker_threads` and no long-lived child processes. The only children allowed are short-lived `termux-*` helpers, run with `execFile` and an args array (never a shell). The optional e2e tier may spawn a Java server; that's test-only.
- **Session isolation:** a failure in one session must never take down the daemon or other sessions. In testing, one bot's handler throwing killed the whole process, and the other bot with it.
  - Wrap each bot's `bot._client.emit` **and** `bot.emit` in try/catch. A caught exception ends only that session (reason `internal`, stack in `daemon.log`). Wrapping `_client.emit` alone isn't enough: timer-driven events such as `physicsTick` bypass it.
  - Attach `bot.on('error')` before connecting, and handle every promise from bot APIs (failures become `err` replies).
  - Wrap each WebSocket message dispatch in try/catch, so no client input can throw out of a handler.
  - Last resort: `uncaughtException` logs, stops sessions and exits 1, so `start.sh` restarts the daemon. `unhandledRejection` logs and continues.
- **Portable:** runs unchanged on plain Linux. Termux features are auto-detected and optional.
- **Web UI:** static files served by the daemon. No frameworks, CDNs, external requests, inline scripts or inline event handlers. Under the CSP in §10, set dynamic styles through `element.style` (CSSOM), never `style` attributes.
- **No Mojang assets** (textures, fonts, sounds) in the repo or the UI.
- **License:** MIT. Add a `LICENSE` file with the standard MIT text and `Copyright (c) 2026 nxck2005`, and set `"license": "MIT"` in `package.json`. Don't copy third-party code into the repo; dependencies keep their own licenses through npm.
- **Disclaimer:** the README, and the UI's More tab, state: "Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft." Don't use "Minecraft" or Mojang branding in the app name or icon.

## 3. Non-goals

- 3D or world rendering (no `prismarine-viewer`, no canvas/WebGL world view).
- Forge, NeoForge or Fabric handshakes, or modded registries. Detect modded-server kicks and explain them; don't work around them.
- Bypassing bot verification, captchas or anti-cheat. Nothing cheat-like: no attacking or kill-aura, x-ray, flight, speed, no-fall or reach. Movement goes only through Mineflayer's normal physics.
- Unofficial Mineflayer forks or patch-package backports for unsupported Minecraft versions.
- Bedrock Edition, internet-facing exposure, telemetry, and auto-registration on offline-mode servers.
- Scoreboard/sidebar, boss bars and titles (candidates for v2).
- Villager trading: merchant windows show as plain slot grids, with no trade selection.

## 4. Version policy (verify before coding)

- **Context as of late September 2026:**
  - Minecraft Java's current release is 26.3.
  - Mineflayer's README lists support through 26.1, and no npm release of the Mineflayer stack supported 26.2 or 26.3 yet.
- **Check the current state:** run `npm view mineflayer version`. After installing, read `node_modules/mineflayer/lib/version.js` for the tested and supported versions.
- **Pinning:** pin the newest stable `mineflayer`, and a `mineflayer-pathfinder` release that works with it.
- **Unsupported servers:** a server's `version` defaults to `"auto"`. If the server runs an unsupported version, stop the session (no reconnect loop) and report:
  - the server's version,
  - the supported range,
  - the remedy: pin a supported version, and run ViaVersion + ViaBackwards on servers you control.
- **Visibility:** show the supported versions in the startup log, the `hello` message and the README.

## 5. Architecture

```
Phone browser ─ touch UI (web/)
   │  ws://127.0.0.1:8765  (token + Origin/Host checks)
   ▼
Node daemon (one process)
 ├ http.js       static files + security headers
 ├ ws.js         auth, validation, rate limits, routing
 ├ sessions.js   lifecycle, backoff, kick classification
 │  └ session.js one mineflayer bot per account×server
 │     ├ movement.js   leases, dead-man, look, goto/step, anti-AFK
 │     ├ inventory.js  items, windows, clicks, cursor
 │     ├ minimap.js    per-chunk tiles (time-sliced)
 │     └ chat.js       segments, redaction, JSONL logs
 ├ alerts.js     keywords, damage, death, kicks → UI + notifier
 ├ termux.js     notification / wake-lock / open-url (no-op off Termux)
 └ config.js     data dir, config, secrets, atomic writes
   │  TCP
   ▼
Minecraft server(s)
```

Repo layout:

```
package.json  package-lock.json  README.md  LICENSE
src/      main.js config.js http.js ws.js protocol.js sessions.js session.js
          movement.js inventory.js minimap.js chat.js alerts.js termux.js log.js
web/      index.html style.css app.js (+ small ES modules) manifest.webmanifest icon.svg
scripts/  termux-setup.sh start.sh stop.sh prune-data.mjs check-no-native.mjs
          e2e.mjs fake-server.mjs
test/     *.test.js
docs/     PROTOCOL.md DECISIONS.md REPORT.md
```

CLI: `node src/main.js [--port 8765] [--data-dir ~/.golemlink] [--open] [--print-url] [--unsafe-bind <ip>]`. `npm start` runs it. `--print-url` prints the tokened URL and exits, for when the daemon runs in the background.

## 6. Data directory and config

```
~/.golemlink/              0700
  config.json              0600   atomic writes (tmp file + rename)
  token                    0600   32 random bytes, base64url, created on first run
  auth/                    0700   Mineflayer profilesFolder (Microsoft token cache)
  logs/<sessionId>/YYYY-MM-DD.jsonl
  daemon.log               rotate at 5 MB, keep 2
  daemon.pid               written at startup, removed on clean exit
```

- Refuse a data dir on shared storage (`/sdcard`, `/storage/…`), because other apps can read it. Check the real path (resolve symlinks on the nearest existing ancestor): Termux's `~/storage/shared` is a symlink into `/storage/emulated/0`.
- The session id is `<accountId>@<serverId>`. Account and server ids must match `^[a-z0-9_-]{1,32}$`, because they become folder names.

```json
{
  "version": 1,
  "http": { "port": 8765 },
  "accounts": [
    { "id": "main", "auth": "microsoft", "username": "you@example.com" },
    { "id": "alt", "auth": "offline", "username": "NickAlt" }
  ],
  "servers": [
    {
      "id": "lobby",
      "name": "My network",
      "host": "play.example.net",
      "port": 25565,
      "version": "auto",
      "autoReconnect": true,
      "chatLog": true,
      "antiAfk": { "enabled": false, "intervalSec": 90 },
      "alerts": { "keywords": ["Nick"], "damage": true, "death": true },
      "resourcePack": "accept",
      "autoLogin": null
    }
  ],
  "autostart": ["main@lobby"],
  "minimap": { "radiusChunks": 6 },
  "deadmanMs": 600,
  "termux": { "wakeLock": true, "notifications": true }
}
```

- `autoLogin` is either `{ "password": "…", "trigger": "/(login|log in)/i" }` or `null`.
- `resourcePack` is `"accept"` (default) or `"deny"` (see §8.2).
- Passwords never leave the daemon. The UI only sees `hasAutoLogin: true`. An update without a password keeps the old one; an empty string removes it.
- On load, validate the config with clear error messages, keep unknown keys, and migrate by `version`.

## 7. WebSocket protocol v1

Document this in `docs/PROTOCOL.md`. `src/protocol.js` holds hand-written validators that every handler shares.

**Framing**
- JSON text frames. Client frames are at most 64 KB.
- Any client message may carry an `id`. The server answers with `{"t":"ack","id":…}` or `{"t":"err","id":…,"code":"…","msg":"…"}`.

**Handshake**
- The first client message must be `{"t":"auth","token":"…"}`, sent within 5 s; otherwise close with code 4401.
- After auth, the server sends `hello`: `{"t":"hello","v":1,"sessions":[…],"accounts":[…],"servers":[…],"supportedVersions":[…],"features":{…},"daemon":{…}}`.
  - `features`: `goto`, `clickModes`, `tabComplete`, `notifications`, `wakeLock`.
  - `daemon`: versions of the app, Node, mineflayer and pathfinder, plus `loopLagP99` and `rssMB`.
  - Each session object carries `state`, `reason`, `detail` and `pendingMsa` (`{code,url,expiresAt}` or `null`), so a UI opened after a sign-in code was issued still shows it.

Client → server (`s` = session id):

| t | fields | effect |
|---|---|---|
| `sub` | `s` | subscribe this client to one session; the server replies with `snapshot` |
| `session.start` / `session.stop` | `account`,`server` / `s` | start or stop a session |
| `config.server.put` / `config.server.del` | `server` / `id` | create, update or delete a server entry |
| `config.account.put` / `config.account.del` | `account` / `id` | same for accounts |
| `chat` | `s`,`text` (≤256; 100 on 1.8–1.10.2) | send chat or a `/command` (§8.3) |
| `tab` | `s`,`text` | tab-complete; the server replies `{"t":"tab","s":…,"items":[…]}` |
| `ctl` | `s`,`k`,`on` | `k` is one of forward, back, left, right, jump (momentary) or sprint, sneak (latched) |
| `hold` | `s` | dead-man heartbeat while any momentary control is on |
| `look` | `s`,`yaw`,`pitch` | absolute angles, in radians (the UI sends at most 20 Hz) |
| `lookAt` | `s`,`x`,`y`,`z` | look at a world position |
| `goto` | `s`,`x`,`z`,`y?` | pathfind, at most 256 blocks horizontally |
| `step` | `s`,`dir`,`n` | `dir` is n, e, s or w; `n` is 1–16 |
| `stop` | `s` | cancel goto and clear momentary controls |
| `interact` | `s` | entity under the crosshair, else block |
| `use` | `s` | use the held item |
| `hotbar` | `s`,`i` | select slot 0–8 |
| `click` | `s`,`window`,`slot`,`button`,`mode` | window click (see §8.5) |
| `drop` | `s`,`slot`,`all` | drop one item or the whole stack |
| `closeWindow` | `s` | close the open window |

Server → client:

| t | payload |
|---|---|
| `sessions` | full session list (same shape as in `hello`), sent on any lifecycle change |
| `snapshot` | `s`, `state`, `status`, `inventory`, `window`, `cursor`, `chat` (backlog), `players`, `features`; tiles follow as `tiles` batches |
| `state` | `s`, `state` (connecting, online, reconnecting, stopped), `reason`, `detail`, `retryInMs?` |
| `chat` | `s`, `ts`, `plain`, `segs` |
| `status` | at most 5 Hz: `x,y,z,yaw,pitch,dim,hp,food,sat,xpLvl,gm,quick,actionbar,target,ctl` (`ctl` = the bot's actual control states) |
| `inv` | `s`, `window`, `slots` delta `{ "<slot>": item \| null }`, `cursor?` (debounced 50 ms) |
| `window` | `s`, a window object or `null` |
| `tiles` / `untile` | `s`, `[{cx,cz,rgb}]` / `[{cx,cz}]` |
| `players` | `s`, `[{name,ping,gm,x?,z?}]` (positions only for nearby players, at most 2 Hz) |
| `ctlReset` | `s`, `reason` (deadman, disconnect, goto) |
| `goto` | `s`, `phase` (started, arrived, failed, cancelled), `detail?` |
| `alert` | `s`, `kind`, `text` |
| `msa` | `s`, `code`, `url`, `expiresAt` |

Routing: `sessions`, `alert` and `msa` go to every authenticated client. Everything else goes only to that session's subscribers.

Shapes:
- **Item:** `{"n":"diamond_sword","d":"Diamond Sword","c":1,"cn":null,"lore":[],"dur":null,"ench":false}`. `cn` is the custom name, `dur` is `[used,max]` or `null`.
- **Window:** `{"id":3,"type":"minecraft:generic_9x3","title":{"plain":"…","segs":[]},"size":63,"invStart":27,"slots":[]}`. The player inventory is window `0`.
- **Chat segment:** `{"x":"text","c":"#rrggbb","b":1,"i":1,"u":1,"s":1,"o":1}`. Only `x` is required; `c` is the color, and `b`, `i`, `u`, `s`, `o` mean bold, italic, underlined, strikethrough and obfuscated.
- **Tile:** `rgb` is base64 of 16×16×3 bytes. Rows run along z (north to south) and columns along x (west to east).

Backpressure: if a client's `bufferedAmount` exceeds 1 MB, stop sending it `status` and `tiles`, then send a fresh `snapshot` once the buffer drains.

## 8. Behavior

### 8.1 Sessions and reconnect

- **States:** `stopped → connecting → online → reconnecting → connecting … → stopped`.
- **Settling an attempt:** each connection attempt settles **exactly once**, on the first of `error`, `kicked`, `end`, or 30 s without `spawn`. Then call `bot.end()`, remove its listeners and drop the bot. Ignore anything it emits afterwards.
  - Don't wait for `end`. With `version: "auto"`, a server reporting an unsupported version (26.3, 1.7.10, an unknown protocol) produces only `error`, with no `end`, and leaves the bot's socket open. A server that's down produces two `error`s and one `end`.
  - The 30 s timer stops while a Microsoft device code is pending and restarts on the bot's `connect` event, so a first-time sign-in isn't cut off.
- **Backoff:** start at 5 s, double up to 5 min, add ±20 % jitter, and reset after 60 s online.
- **Reason normalization:** kick and end reasons arrive as a string, JSON text, a chat component or NBT, depending on the version. Normalize them to `{plain, translate?}` with one helper, and keep fixtures for each shape. NBT example: `{"type":"compound","value":{"text":{"type":"string","value":"…"}}}`.
- **Classification:** match translate keys and plain text, case-insensitively.
  - `duplicate_login` → **stop and never reconnect**. Otherwise the bot and the user's real client kick each other forever, or the bot retries forever behind a proxy. Matches:
    - `multiplayer.disconnect.duplicate_login` ("You logged in from another location");
    - the proxy forms "You are already connected to this proxy!" (Velocity's `velocity.error.already-connected-proxy`, and BungeeCord) and "You are already connected to this server!".
  - `idle` → stop. Matches `multiplayer.disconnect.idling` ("You have been idle for too long!") or text matching `/\b(afk|idle|idling|inactiv\w*)\b/i`. Rejoining after an AFK kick evades the server's policy.
  - `banned`, `not_whitelisted` → stop.
  - `version` → stop, with the advice from §4. Matches `multiplayer.disconnect.outdated_client`, `outdated_server` and `incompatible`, and text containing "Outdated client", "Outdated server", "Incompatible client", "Unsupported protocol version", "No data available for version" or "is not supported".
  - `modded` (NeoForge, Forge or FML handshake rejections) → stop with "modded servers are not supported".
  - `auth` (Microsoft login failure, "Failed to verify username") → stop.
  - `shutdown` (`multiplayer.disconnect.server_shutdown` "Server closed", Velocity's "Proxy shutting down.", or text containing "restart"), timeouts and network errors → reconnect with backoff if `autoReconnect` is on.
  - Any other kick, and `internal` (§2) → reconnect if `autoReconnect` is on, but the 3rd such kick within 30 minutes stops the session with `kick_loop`. Without this limit, a server that kicks the bot a few minutes after each join gets rejoined forever, because the backoff resets after 60 s online.
- **Sign-in lock:** only one session per account signs in at a time. prismarine-auth keeps a separate in-memory cache per sign-in and rewrites the whole cache file. Concurrent sign-ins overwrite each other's tokens and can show two device codes.
- **Limits:** at most 8 concurrent sessions. `autostart` sessions start at boot.

### 8.2 Login

- **Microsoft:** `auth: "microsoft"` and `profilesFolder: <data>/auth`.
  - Surface the device-code flow through Mineflayer's code callback (expected option `onMsaCode`; verify it).
  - Send it to every UI as an `msa` message, keep it in the session's `pendingMsa` until sign-in finishes or the code expires, print it to stdout, and send a notification.
  - Never log tokens.
- **Offline:** `auth: "offline"`.
- **Resource packs:** Mineflayer accepts packs by itself only during the configuration phase. In play it just emits `resourcePack`, so servers that require a pack kick or stall the bot. Answer play-phase requests too, with `bot.acceptResourcePack()` or `bot.denyResourcePack()` per the server's `resourcePack` setting. Nothing is downloaded.
- Keep Mineflayer's default auto-respawn. Use `viewDistance: 6` (Mineflayer accepts a number).

### 8.3 Chat

- **Source:** listen to Mineflayer's chat-component message event. Action-bar messages (`game_info`) go to `status.actionbar`, not the log.
- **Conversion:** turn components into `segs` + `plain` with translations resolved (prismarine-chat does this). Colors are best-effort, both named and hex.
- **Sending:** commands start with `/`. Validate before calling `bot.chat`, and reply `err` instead of sending:
  - Length: at most 256 characters, or 100 on 1.8–1.10.2. Reject longer text rather than letting Mineflayer split it into several messages (it never splits commands, and an over-long packet gets the bot kicked).
  - Characters: reject `§`, newlines and other control characters (below U+0020, and U+007F). Vanilla kicks for them (`multiplayer.disconnect.illegal_characters`), and Mineflayer doesn't filter them.
- **Backlog:** keep the last 500 lines per session in memory, and write a JSONL file when `chatLog` is on.
- **Redaction:** replace any configured auto-login password with `••••` in logs, the backlog and echoes.
- **Tab-complete:** go through Mineflayer if available, returning at most 20 results. Allow at most 4 requests per second per session; proxies such as Velocity can kick for tab-complete spam.

### 8.4 Movement

- **Momentary controls** (forward, back, left, right, jump) stay on only while the owning client keeps sending `hold`; the UI sends one every 200 ms.
  - If no `hold` arrives for `deadmanMs` (default 600), or the owning socket closes: clear the momentary controls, keep the latched ones (sprint, sneak), and send `ctlReset`.
  - Check this every 100 ms. The last client to press a control owns the lease.
  - If a check runs more than 200 ms late, skip it, so heartbeats queued during an event-loop stall get processed first. Stalls happen: the first session on a given Minecraft version blocks the loop for 0.3–1.1 s on a 2.1 GHz x86 core (longer on a phone), more than the 400 ms margin between heartbeat and timeout.
- **`look`:** clamp pitch to ±π/2 and apply at most 20 Hz.
- **`goto` / `step`:** use mineflayer-pathfinder with a `Movements` profile that **cannot dig or place blocks**:
  - `canDig = false`, `allow1by1towers = false`, `allowParkour = false`.
  - `scafoldingBlocks = []`. That misspelling is the library's. Setting `scaffoldingBlocks` silently does nothing and leaves dirt and cobblestone as scaffolding.
  - Set `bot.pathfinder.tickTimeout = 10` and `thinkTimeout = 10000`. The default of 40 ms of path search per 50 ms tick breaks the §12 budget.
  - Release latched sprint and sneak while a goto runs, and restore them when it ends. mineflayer-pathfinder clears every control state when it stops (verified), which would otherwise leave the UI showing toggles that are off.
  - Any momentary control or `stop` cancels it.
  - `step` means goto the column N blocks away in a cardinal direction.
- **Fallback:** if the pathfinder fails to load or errors on this version, set `features.goto = false` and carry on.
- **Angle convention:** verify Mineflayer's yaw/pitch convention empirically and document it. The UI's arrow and compass must match it.

### 8.5 Inventory and windows

- **Mirror state:** the player inventory and `bot.currentWindow`.
  - Send a snapshot on `sub`, deltas on slot updates, and `window` on open and close.
  - Track the cursor item (prismarine-windows `selectedItem`; verify).
- **Clicks:** desktop semantics using mode 0 only. Tap = left click (button 0), long-press = right click (button 1).
  - That covers picking up, placing, swapping, splitting and placing one, without any other click mode.
  - Mineflayer 4.39.0's `docs/api.md` marks only mode 0 as stable and modes 1–4 as experimental. Expose shift-click (mode 1) in `features.clickModes` only once the fake-server test (§13) covers it.
- **Other actions:** `hotbar` → `setQuickBarSlot`; `use` → activate the held item.
- **`drop`:** drop from the exact slot with mode-0 clicks:
  - Whole stack: click the slot, then click outside (slot `-999`).
  - One item: click the slot, right-click outside (`-999`, button 1), then click the slot again to put the rest back.
  - Don't use `bot.toss` (it drops the first stack of that item type, which may not be the slot the user tapped) or `bot.tossStack` (it also closes the open window).
  - Drop needs an empty cursor; otherwise reply `err` with code `cursor_busy`.
- **Validation:** reject clicks with a stale window id or an out-of-range slot.
- **`describeItem(item)`:** must handle pre-1.20.5 NBT names and lore and 1.20.5+ data components. For the name, use `custom_name`, then `item_name` (plugin menus set it; prismarine-item's `customName` ignores it), then the display name. Unit-test both formats with fixtures.
- **Player window slots** (verify against prismarine-windows): 0 craft result, 1–4 craft grid, 5–8 armor, 9–35 main, 36–44 hotbar, 45 offhand.

### 8.6 Interact

- **`interact`:**
  - If an entity under the crosshair is within reach, activate it (NPC menus, villagers).
  - Otherwise activate the block under the crosshair, within 4.5 blocks (chests, doors, buttons).
  - Verify the Mineflayer helper names.
- **`status.target`:** the name of the entity or block under the crosshair, updated at most 2 Hz, so the user can aim.
- No attack action in v1.

### 8.7 Mini-map

- **Tile lifecycle:** keep tiles for loaded chunks within `radiusChunks` of the bot.
  - Build a tile when its chunk loads.
  - Rebuild on block updates, debounced 250 ms per chunk.
  - Drop it on unload or when it falls out of range.
- **Column scan:** scan down from `min(botY + 48, worldMaxY)` to the first non-air block, capped at 128 blocks. In dimensions with a ceiling (the nether), start at `botY + 2` instead.
- **Color:**
  - Use a hand-written palette keyed by block-name patterns: grass, leaves, water, sand, stone, deepslate, dirt, snow/ice, logs/planks, lava, netherrack, basalt/blackstone, end stone, terracotta, ores, and so on.
  - Fall back to a stable hash color, and cache the color per block state id.
  - Relief: lighter if the column is higher than the one to its north, darker if lower.
  - Water gets darker with depth, up to 8 blocks.
- **Reading blocks:** read state ids straight from the chunk column, not with `bot.blockAt` per block.
- **Time-slicing:** run the build queue in slices of at most 5 ms per macrotask (`setImmediate`), so the 50 ms physics tick is never starved.

### 8.8 Alerts

- **Kinds:**
  - keyword: a whole word, case-insensitive (so `Nick` doesn't fire on "NickAlt joined the game"), or a `/regex/flags`. Match every chat line except the bot's own: skip lines whose sender is the bot, and lines containing text this session sent in the last 5 s. Servers often send player chat as system messages, which carry no sender, so a sender check alone isn't enough;
  - damage: a health drop, with a 15 s cooldown;
  - death;
  - stopped/kicked;
  - msa.
- **Delivery:** send to every connected UI (not just the session's subscribers) and, when enabled and available, through `termux-notification` with a stable id per session and kind.
- **Rate limit:** at most 1 per kind per 10 s, with counts coalesced.

### 8.9 Anti-AFK

- Off by default.
- Every `intervalSec` ±25 %, if no control lease or goto is active: make a small yaw change plus one jump.
- The README tells users to check server rules first.

### 8.10 Auto-login (offline-mode servers)

- After spawn, when a chat line matches `trigger`, send `/login <password>` once per connection.
- No auto-registration.

## 9. Web UI

The visual direction is decided. Implement it; don't redesign it.

**Look**
- Dark, high-contrast and utilitarian.
- Color tokens: bg `#0e1013`, surface `#161a20`, raised `#1d222a`, border `#2a303a`, text `#e7e9ee`, muted `#8a93a3`, accent `#4ade80`, warn `#fbbf24`, danger `#f87171`, info `#60a5fa`.
- Type: system UI font for chrome, `ui-monospace` for chat and coordinates, 15 px base.
- Sizing: 48×48 px minimum touch targets, an 8 px grid, 12 px card radius. Respect safe-area insets.
- Orientation: portrait first. In landscape, the Move tab puts the map on the left and the controls on the right.
- On controls, suppress the context menu and text selection.
- The joystick and look pad must work at the same time (track `pointerId`).

**Shell:** a top status bar (session switcher, state dot, HP/food/XP as thin bars, coordinates, action-bar text), the content area, and bottom tabs **Chat · Move · Bag · More**.

**Tabs**
- **Chat:**
  - Log with auto-scroll that pauses when the user scrolls up, plus a "Jump to latest" chip. Keep at most 500 DOM rows.
  - Input bar with a send button, and suggestion chips while typing a `/command` (request them 250 ms after the last keystroke).
  - Lighten chat colors with under 4.5:1 contrast against the background (for example `black`, `dark_blue`) toward the text color.
- **Move:**
  - Square canvas map: north up, an arrow for the bot's facing, players as dots (tap a dot for the name), zoom 1–4×. Tapping the map shows a "Go to x, z" confirm chip.
  - Bottom left: a virtual joystick (pointer events, dead zone, 8-way → forward/back/left/right).
  - Bottom right: Jump (hold), Sprint and Sneak (toggles that show `status.ctl`, not the UI's own guess), Interact, Use, and a big red STOP.
  - Look: a drag pad (horizontal = yaw, vertical = pitch) plus ±90° turn buttons.
  - Step: N/E/S/W buttons with a 1/2/4/8 selector.
  - A "Looking at: …" label.
- **Bag:**
  - Any open window on top: title plus grid, 9 columns unless the type says otherwise.
  - Then the player inventory: an armor + offhand row, the 27 main slots, and the hotbar with the selected slot highlighted.
  - A banner when an item is on the cursor.
  - Tap = left click, long-press = right click.
  - Detail sheet: name, custom name, lore, durability, and actions Hold (hotbar), Drop one, Drop stack, Use.
  - A close-window button.
- **More:**
  - Sessions: start/stop, state, last reason.
  - Add or edit servers and accounts, with per-server toggles: auto-reconnect, chat log, anti-AFK, alerts.
  - Player list with ping.
  - Daemon info: versions, supported Minecraft versions, event-loop lag.

**Item tiles** (no textures)
- A rounded square showing a two-letter code from the item id (`diamond_sword` → DS).
- Background tinted by material keyword: diamond cyan, iron silver, gold amber, netherite near-black, copper orange, wood/leather brown, stone gray, anything else neutral.
- Count in the bottom-right corner, an accent ring if enchanted, and a durability bar if damaged.

**Behavior**
- WebSocket auto-reconnect (1 s → 10 s): re-auth, re-subscribe, and rebuild from `snapshot`. Show a banner while disconnected. On close code 4401, stop reconnecting and say the token was rejected and to open the link printed at startup (or run `--print-url`).
- Send `look` at most 20 Hz (coalesce pointer moves and send the latest), `ctl` only when a control changes, and `hold` every 200 ms while a momentary control is held. Sending `look` on every pointer move would exceed the server's rate limit on a 120 Hz screen.
- Show any session's `pendingMsa` code and link as a banner, whichever session is selected.
- On `visibilitychange` (hidden) and `pagehide`, release all momentary controls immediately.
- Show alerts as toasts. Call `navigator.vibrate(100)` on damage when the page is visible.
- A web manifest (standalone, dark theme color) and an SVG icon. No service worker.
- Render all server-provided text (chat, item names, lore, titles, reasons, player names) with `textContent` only — never `innerHTML`.

## 10. Security

**Binding**
- Bind to `127.0.0.1` only.
- `--unsafe-bind <ip>` binds one specific interface address (not `0.0.0.0`) with a loud warning. It also adds `http://<ip>:<port>` to the Origin and Host allowlists and to the CSP `connect-src`; otherwise the checks below reject every connection. The README recommends an SSH tunnel instead, which works with the default allowlist.

**Token**
- The token lives in `~/.golemlink/token`. Startup prints `http://127.0.0.1:<port>/#t=<token>` to stdout only, never through the logger, so it never reaches `daemon.log`.
- The UI moves the token from the URL fragment into `localStorage` (wrapped in try/catch), then clears the fragment with `history.replaceState`.

**WebSocket upgrade**
- `Origin` must be `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- `Host` must match too (a DNS-rebinding guard).
- These checks stop malicious web pages. Other apps on the phone can forge any header, so the token is the real gate.
- The auth message must arrive within 5 s. Compare SHA-256 digests of the received and stored tokens with `crypto.timingSafeEqual`. It throws when the inputs differ in length: comparing raw tokens let one message with a short token crash a test server.
- Per-connection rate limit of about 60 msg/s with a burst of 120. Drop excess messages with `err` code `rate_limited`, and close the connection only on sustained flooding (over 600 messages in 5 s).
- Validate every field: types, finite numbers, ranges, string lengths, slot bounds.

**HTTP**
- GET and HEAD only.
- Serve only files inside `web/`: normalize paths and reject traversal and dotfiles.
- Headers:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:<port> ws://localhost:<port>; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: no-store` on HTML.

**Logs** never contain the token, passwords or Microsoft tokens.

## 11. Termux integration

**`termux.js`**
- Detects these on `PATH`:
  - `termux-notification` (needs the `termux-api` package and the Termux:API app),
  - `termux-wake-lock` / `termux-wake-unlock`,
  - `termux-open-url`.
- Everything is a no-op when missing. Calls use `execFile` with an args array and a 5 s timeout; failures are logged once.

**Startup and shutdown**
- Take a wake lock if enabled, and release it on shutdown.
- On SIGINT/SIGTERM, stop sessions gracefully, then exit 0.
- Ignore SIGHUP. Node exits on it by default (status 129), so closing the Termux session would otherwise kill the daemon. Also ignore `EPIPE`/`EIO` errors on stdout once the terminal is gone.
- Write `daemon.pid`, and refuse to start if it names a running golemlink process.
- `--open` opens the URL with the token.

**`scripts/termux-setup.sh`**
- Runs `pkg install -y nodejs-lts termux-api`, `npm ci`, and the native check.
- Offers to run `scripts/prune-data.mjs`. It deletes the Bedrock data the bot never uses from `node_modules/minecraft-data/minecraft-data/data/bedrock/`, but keeps `bedrock/common`, which minecraft-data requires. That cuts the install from 471 MB to 138 MB.
  - It must run again after every `npm ci`.
  - Afterwards it loads each configured Minecraft version, to prove nothing needed was deleted.
- Then prints the manual steps:
  - Install Termux and Termux:API from the same source (F-Droid or GitHub, not mixed with the Play Store).
  - Turn off battery optimization for Termux.
  - Android 12L and later: run `adb shell "settings put global settings_enable_monitor_phantom_procs false"` once. This works from Termux itself over wireless debugging.
  - Android 12 (not 12L): run `adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647"`. This only lifts the 32-process limit. Android 12 can't turn off the kill for high CPU use, so warn that the daemon may still be killed in the background.
  - Android 14+: Developer options also has "Disable child process restrictions".

**`scripts/start.sh`**
- Takes a wake lock, then runs a restart loop: restart 3 s after a crash (non-zero exit), and give up after 5 crashes within 60 s. A clean exit (0) ends the loop. It ignores SIGHUP too (`trap '' HUP`).
- Passes its args through.
- `scripts/stop.sh` sends SIGTERM to the pid in `daemon.pid`.
- The README shows Termux:Widget shortcuts in `~/.shortcuts/tasks/`. Scripts there run in the background as Termux tasks, with no terminal session to close: `golemlink` → `start.sh --open`, and `golemlink-stop` → `stop.sh`.

## 12. Performance budgets

- **Event-loop delay:** p99 under 20 ms with one session online and the map building, measured with `perf_hooks.monitorEventLoopDelay`. Show it in More, and log a warning if p99 exceeds 50 ms over 10 s.
- **Memory:** one session under about 200 MB RSS at view distance 6, and roughly 20–45 MB more per extra session. Measured with Mineflayer 4.39.0 on Node 22: 130–146 MB for one bot holding 400 chunk columns of flat terrain, and about 67 KB per column of vanilla-like terrain. Log RSS every 5 min.
- **Message rates:** `status` at most 5 Hz, players at most 2 Hz, tiles batched (at most 32 per frame).

## 13. Testing

**Unit tests:** `npm test` runs the native-dependency check, then `node --test`. Unit tests need no network and no server. Cover:
- protocol validators, with good and bad payloads;
- WebSocket auth (missing, wrong or wrong-length token, timeout, bad Origin/Host, close code 4401), using a real `ws` client on an ephemeral port;
- rate limiting (excess messages dropped, the connection kept unless flooding);
- the static server: traversal, dotfiles, headers;
- the dead-man switch, with `node:test` mock timers, including skipping a late check;
- the backoff schedule and kick-loop breaker; attempt settling (error only, error then end, kick then end, timeout, timer paused for a device code); reason normalization + classification with fixtures for every shape, including Velocity, idle and NBT reasons;
- chat validation (length per version, `§`, newline), segmentation, and password redaction;
- keyword matching: whole words, the bot's own lines skipped;
- `describeItem` fixtures, for both NBT and data components, including `item_name`;
- the tile builder, against a fake chunk column;
- config: validation, the id pattern, atomic write, file modes, shared-storage refusal through a symlink;
- `termux.js` no-ops when the binaries are absent.

**End-to-end:** `npm run e2e` (`scripts/e2e.mjs`) drives the daemon only through its WebSocket API. It runs the scenario below in two tiers, each against a different server, for `MC_VERSION` (default `1.21.11`).

**Tier 1, required (no Java, no network):** `scripts/fake-server.mjs`, an in-process fake server built on `minecraft-protocol`'s `createServer`.
- Load `minecraft-protocol`, `prismarine-registry`, `prismarine-chunk` and `vec3` with `createRequire(require.resolve('mineflayer'))`. The server then uses exactly the bot's protocol stack, and no dependency is added.
- `createServer` sends the registry data itself. On `playerJoin`, send:
  - `login`, spreading `registry.loginPacket`;
  - `map_chunk` for a flat stone floor built with prismarine-chunk (`dump()`, `dumpLight()`, `heightmaps: []`);
  - `position`;
  - `update_health`. Mineflayer emits `spawn` on the first positive health.
- Script the console steps as packets: the wall as blocks in the chunks, `set_slot` for items, `open_window` when the bot uses the chest, `kick_disconnect` for kicks, `update_health` for damage. Record every packet the bot sends.
- Extra tier-1 checks:
  - Velocity's "already connected to this proxy" kick and an idle kick each stop the session.
  - A ping reporting 26.3 (protocol 777) stops it with `version` and no reconnect.
  - With the server down, the session reconnects with backoff.
  - An `add_resource_pack` during play gets accepted.
  - A throw in one session's packet handler, and in its `physicsTick` handler, leaves a second session online.
- This is verified to work. A ~50-line fake 1.21.11 server built this way spawned the bot in 0.6 s. The bot then:
  - walked 4.06 blocks with forward held, and coasted 0.26 blocks after release;
  - pathed around a 5×3 wall to 0.00 blocks from the target in 2.5 s;
  - sent no dig or place packets.

**Tier 2, optional (vanilla server):** if Java 21+ is installed and Mojang's servers are reachable:
- Download the vanilla server jar via Mojang's version manifest (`https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`), cached in `.cache/`.
- Run it in a temp dir with `eula=true`, `online-mode=false`, `level-type=minecraft:flat`, `difficulty=peaceful`, `spawn-protection=0`, `view-distance=6`.
- Send setup commands through the server console (stdin).
- If prerequisites are missing, print `SKIPPED: <reason>` and exit 0. That's common in sandboxes, which often can't reach Mojang. Never fake results.

Scenario (tier 2 uses the console commands in parentheses):
1. Start the daemon with a temp data dir, add an offline account and the local server over WS, and start the session.
2. Chat round-trip.
3. Send `ctl forward` with holds and check the position changes. Stop the holds and check movement stops within 1 s (dead-man).
4. Build a 3-high, 5-wide stone wall between the bot and a point 10 blocks away (`fill`), give the bot some dirt so scaffolding would be possible, then `goto` that point.
   - The bot arrives within 1.5 blocks.
   - The wall is intact (`execute if block …`). In tier 1, the server also saw no dig or place packets.
5. Give the bot 5 diamonds (`give <bot> minecraft:diamond 5`) → an inventory delta arrives.
6. Put a chest in front of the bot (`setblock`), `lookAt` it, `interact` → the window opens. Click the diamonds into it, and confirm the server received the clicks (`data get block …`).
7. Kick the bot as a duplicate login (a second raw offline client with the same name joins) → the session is `stopped` with `duplicate_login`, and doesn't reconnect within 15 s.
8. Damage the bot by 2 (`damage <bot> 2`) → a damage alert arrives.
9. Tear everything down cleanly.

## 14. Milestones

Do them in order. After each one, tests must be green, then commit.

1. **M1 Core:**
   - data dir, config and token;
   - HTTP + WS with every security check;
   - protocol validators;
   - session manager (offline auth), with session isolation and attempt settling;
   - chat both ways;
   - reconnect + classification;
   - logs;
   - UI: shell, Chat, and More (sessions, servers, accounts);
   - `scripts/fake-server.mjs` with the chat, kick and reconnect checks. Later milestones extend it.
2. **M2 Movement:** leases + dead-man, look, joystick UI, goto/step, interact/use, anti-AFK, and the fake-server movement and wall steps.
3. **M3 Inventory:** item and window serialization, cursor clicks, hotbar, drop, the Bag tab, and the fake-server inventory and chest steps.
4. **M4 Mini-map:** time-sliced tile builder, palette, map canvas, players.
5. **M5 Alerts & Termux:** alerts + notifications, wake lock, scripts, Microsoft device-code UI, auto-login, multi-session switcher, README.
6. **M6 Hardening:** the rest of tier 1, tier 2, performance instrumentation, `PROTOCOL.md`, `DECISIONS.md`, `REPORT.md`.

Done means:
- `npm test` passes, including the native check.
- e2e tier 1 passes. Tier 2 passes or reports an honest SKIPPED.
- A new user can go from a fresh Termux install to a connected session using only the README.
- No TODOs remain for in-scope features.

## 15. Working rules

- **Check APIs against the installed code**, not memory. Before using an API, read `node_modules/mineflayer/docs/api.md` and `index.d.ts`, the mineflayer-pathfinder README, and the installed prismarine-windows, prismarine-item, prismarine-chat and prismarine-chunk READMEs. API names in this spec are expectations, not guarantees.
- **CommonJS packages:** Mineflayer and mineflayer-pathfinder are CommonJS. Named ESM imports from the pathfinder fail, so use `import pf from 'mineflayer-pathfinder'` and destructure `pathfinder`, `Movements` and `goals`.
- **Prefer the smallest clear implementation:** small cohesive modules, no speculative abstractions, and no extra tooling (ESLint, Prettier, TypeScript, bundlers, Docker, CI).
- **Don't stop early.** If one feature is blocked on this library version, feature-flag it off, finish everything else, and document it.
- **Branches (independent builds):** the repo owner commits `SPEC.md` alone on `main` and tags that commit `spec`. Work only on `impl/<your-model-name>`, created from the `spec` tag (`git switch -c impl/<your-model-name> spec`). Never read, diff, merge or cherry-pick another `impl/*` branch.
- **Final report**, in your last message and in `docs/REPORT.md`:
  - a milestone status table;
  - the exact commands you ran and their results (`npm test`, `npm run e2e`);
  - pinned versions (`npm ls --depth=0`);
  - supported Minecraft versions;
  - what is unverified (for example Microsoft login, or running on a real phone);
  - deviations from this spec, and why;
  - known limitations.
