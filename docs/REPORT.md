# Implementation report

Implementation of `SPEC.md` on branch `impl/deepseek-v4.1-flash`, created from the
`spec` tag (the tag was missing in this checkout, so it was created on the
commit that added `SPEC.md`), by DeepSeek V4.1 Flash.

## Milestones

| Milestone | Status | Notes |
|---|---|---|
| M1 Core | done | data dir/config/token, HTTP + WS security, protocol validators, session manager with offline auth, isolation, settling, chat, reconnect + classification, JSONL logs, UI shell/Chat/More, fake server with chat/kick/reconnect checks |
| M2 Movement | done | leases + dead-man, look, joystick, goto/step with a no-dig/no-place/no-parkour profile, interact/use, anti-AFK, fake-server wall/backoff checks |
| M3 Inventory | done | item/window serialization, cursor clicks, hotbar, drop-one/drop-stack, Bag tab, chest step in tier 1 and tier 2 |
| M4 Mini-map | done | time-sliced tile builder, palette + hash fallback, relief and water depth, canvas map, players |
| M5 Alerts & Termux | done | alerts + notifications, wake lock, start/stop/termux-setup/prune scripts, MSA UI (banner + notification), auto-login, session switcher, README |
| M6 Hardening | done | full tier 1 + tier 2 e2e, event-loop/RSS instrumentation, PROTOCOL.md, DECISIONS.md, this report |

## Commands and results

```
$ npm test
> node scripts/check-no-native.mjs && node --test
check-no-native: ok (90 packages scanned)
ℹ tests 82
ℹ pass 82
ℹ fail 0
ℹ cancelled 0

$ npm run e2e
… 58/58 checks passed in 72.5s   (tier 1 + tier 2, exit 0)
```

The e2e run covers, all through the daemon's WebSocket API:

- tier 1 (fake server): chat round-trip; map tiles pushed after subscribing;
  forward with holds then stop; dead-man timeout; 3-high wall + goto arriving
  within 0.00 blocks with no dig/place packets; inventory delta; chest window;
  mode-0 and shift-click clicks confirmed server side; drop one/stack click
  sequences; resource pack accepted during play; damage alert; duplicate login
  stops the session and it stays stopped for 15 s; Velocity and idle kicks stop
  the session; an outdated-client kick reports `version`; a server reporting
  26.3 (protocol 777) stops with the server version, supported range and
  ViaVersion advice and never reconnects; a down server reconnects with a ~5 s
  backoff and succeeds when it returns; wrong/missing/short tokens, bad
  Origin/Host and auth timeouts all close with 4401; traversal/dotfiles/POST
  rejected with CSP, nosniff and no-referrer headers; a kick to one session
  leaves another online.
- tier 2 (vanilla 1.21.11 server, downloaded from Mojang and cached in
  `.cache/`): the whole scenario above re-run against a real server, including
  console-driven `fill`/`give`/`setblock`/`damage` and `data get block`
  confirmation of the chest clicks.

Additional checks:

```
$ node scripts/prune-data.mjs /tmp/opencode/prune-data
prune-data: removed 331.7 MB of Bedrock data, kept common/ (0.1 MB); was 331.8 MB
prune-data: ok, minecraft-data loads 1.21.11
$ du -sh node_modules
138M
```

`scripts/start.sh` / `stop.sh` were exercised manually (HTTP 200, SIGTERM
shutdown, pid file removed), and a second daemon on the same data dir refuses
to start while `daemon.pid` names a running golemlink process.

## Pinned versions

```
$ npm ls --depth=0
golemlink@1.0.0 /home/nick/projects/golemlink
├── mineflayer-pathfinder@2.4.5
├── mineflayer@4.39.0
└── ws@8.22.0
```

No dev dependencies; tests use `node:test`. `package-lock.json` is committed.
`minecraft-data` 3.117.0 comes in through mineflayer (used by the fake server
and the `--auto` version resolver).

## Supported Minecraft versions

Mineflayer 4.39.0's tested list, shown at startup, in `hello` and in the
README: **1.8.8, 1.9.4, 1.10.2, 1.11.2, 1.12.2, 1.13.2, 1.14.4, 1.15.2,
1.16.5, 1.17.1, 1.18.2, 1.19, 1.19.2, 1.19.3, 1.19.4, 1.20.1, 1.20.2, 1.20.4,
1.20.6, 1.21.1, 1.21.3, 1.21.4, 1.21.5, 1.21.6, 1.21.8, 1.21.9, 1.21.11,
26.1** — i.e. 1.8.8 – 26.1.

A server on 26.3 (the current release at implementation time) is detected and
stopped with the remedy text; that path is covered by tier 1 with a fake ping.

## What is unverified

- **Microsoft device-code login.** The flow is wired through Mineflayer's
  `onMsaCode` (verified present in minecraft-protocol/prismarine-auth) and the
  code is broadcast, logged and notified, but no real Microsoft account was
  used. Offline accounts are fully covered by the e2e.
- **Real Android/Termux hardware.** `termux.js` is unit-tested with stub
  binaries; wake locks, Android notifications, `--open` and the background
  rules were not exercised on a device.
- **Real touch browsers.** The UI is checked statically (no inline
  scripts/handlers/styles, no external URLs, all element ids present, contrast
  helper) and served over HTTP, but it was not driven in a real mobile browser.
- **Minecraft versions other than 1.21.11.** Version-gated logic is unit-tested
  (e.g. 100-char chat limit) and the classifiers handle version-specific kick
  shapes, but no other version was run end to end.
- **26.1 support** is taken from Mineflayer's tested list; no 26.1 server was run.
- **Real phone memory use.** The budget is instrumented (loop-lag p99, RSS) and
  RSS is logged every 5 min, but no measurement on a 2 GB phone was possible.

## Deviations from the spec

All are recorded in `docs/DECISIONS.md`; the notable ones:

1. Added `accounts` and `servers` server→client messages (the spec table has no
   way to push config changes after `hello`).
2. The Bag's item detail sheet is opened through a "Details mode" toggle so
   that tap/long-press keep their specified click semantics.
3. Tier 2 checks the damage alert before the duplicate-login kick (a stopped
   session has no health); both are still covered.
4. The "session isolation" check is split: the e2e verifies a kick leaves the
   other session online, and `test/session-network.test.js` injects throwing
   `physicsTick` and packet-handler listeners in-process and verifies only that
   session ends.
5. `Session` accepts a `noSpawnMs` test seam and `WsHub` an `authTimeoutMs`
   seam; defaults are the spec values (30 s / 5 s).
6. `bot`/`bot._client` listeners are removed 250 ms after `bot.end()` (unref'd)
   instead of synchronously, so Mineflayer's own end cleanup runs. Events in
   the gap are ignored.
7. The map drops decoded tile canvases beyond an 800-entry cache cap.

## Known limitations

- No scoreboard/sidebar, boss bars or titles (v2 candidates, as specified).
- Merchant windows show as plain slot grids; no trade selection.
- No attack action at all (by design).
- The tier-1 fake server supports modern protocol stacks (1.18+ layouts); the
  default and only exercised e2e version is 1.21.11.
- `--unsafe-bind` only warns loudly; it cannot make other apps on the phone
  trustworthy. The README recommends an SSH tunnel.
- The UI is portrait-first; landscape keeps the same controls (map left,
  controls right) but was not tuned further.
