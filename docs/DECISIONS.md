# Decisions

The spec leaves a few things open. Each of these is the simplest option
consistent with it; they are recorded here as required by §1.

## Protocol / daemon

1. **Config broadcasts.** The spec's server→client table has no message for
   "config changed". `hello` carries `accounts`/`servers`, so without one the UI
   could never refresh them. Added two v1 extensions: `{"t":"accounts",…}` and
   `{"t":"servers",…}`, sent to every authenticated client after a
   `config.*.put`/`del`. Documented in `PROTOCOL.md`.

2. **UI-safe config.** The `accounts`/`servers` payloads (in `hello` and the
   extension messages) strip `autoLogin.password` and expose
   `hasAutoLogin: true` instead. `config.server.put` accepts an `autoLogin`
   object without a `password` to keep the stored one; an empty string removes
   auto-login entirely.

3. **Snapshot inventory shape.** `inventory` is the window shape of the player
   window (id 0), so the UI can render armor/offhand/hotbar from the same shape
   it uses for containers. `cursor` is an item shape. Documented in
   `PROTOCOL.md`.

4. **`clickModes`.** A flat array: `["normal","shift"]`. Shift-click (mode 1)
   is implemented *and* exercised by the tier-1 e2e (a shift-click is sent and
   the fake server confirms it), which is the condition the spec sets for
   exposing it.

5. **`goto` phases.** The daemon reports `started`/`arrived`/`failed`/
   `cancelled`. Pathfinder's `failed` detail is the library error message.

6. **Test seams.** `Session` accepts `noSpawnMs` (default 30 000) and `WsHub`
   accepts `authTimeoutMs` (default 5000). Defaults are exactly the spec values;
   the options exist only so tests do not have to wait 30 s.

7. **Attempt settling order.** `bot.on('error')` is attached immediately after
   `mineflayer.createBot()` returns. `createBot` starts connecting inside the
   call, so this is the earliest point a listener can exist; every connection
   error is emitted asynchronously by the socket layer.

8. **Late listener removal.** After `bot.end()`, listeners are removed 250 ms
   later (unref'd timer). Removing them synchronously robbed mineflayer's own
   `end` cleanup (notably the physics interval) of its chance to run, which
   leaked a timer per stopped session. Events emitted in the gap are ignored
   because `session.bot` is already `null`.

9. **Angle convention (verified against the installed Mineflayer).**
   `bot.entity.yaw = atan2(-dx, -dz)` and `bot.entity.pitch = atan2(dy, ground)`,
   i.e. yaw `0` is north (−z), +π/2 is west (−x), −π/2 is east (+x), and
   positive pitch looks up. `bot.look()` rounds to the vanilla sensitivity
   step. The UI's map is north-up and rotates the bot arrow by `-yaw`; the
   look pad adds `-dx` to yaw and `-dy` to pitch, matching both conventions.

10. **Player window slots.** Verified against prismarine-windows for 1.20.5+:
    window `0` has `inventoryStart = 9`, `hotbarStart = 36`, and the armor slots
    are 5–8 with offhand 45. The UI uses those indices directly; the server
    only validates that a slot is inside the window.

## Web UI

11. **Slot gestures.** Mouse clicks act on press, like the game: left, right,
    and shift+left for a quick move; hovering shows a tooltip and Q drops. On
    touch a tap is a left click and a long press (450 ms) opens a menu with
    left click, right click, shift-click, drop one and drop stack. The old
    "Details mode" toggle is gone. With no window open, tapping a hotbar slot
    selects it and tapping the selected slot again uses the item, so opening a
    server selector is two taps at most.

12. **Autostart.** `autostart` stays a config-file feature; the Setup view starts
    and stops sessions manually. The spec only asks for start/stop there.

13. **`tab` replies vs acks.** A `tab` request produces the `tab` reply; if it
    carried an `id`, an `ack` follows as well.

14. **Map tiles cache.** The map keeps decoded tile canvases and drop the
    oldest beyond 800 entries, so a long session cannot grow without bound.

15. **Player dots.** A tap on a player dot shows `name, ping` as a toast
    instead of a persistent label.

## Changes from the spec

20. **Password login instead of a URL token.** The spec gated the UI with a
    token in the URL fragment, which had to be saved and pasted for every
    device. It is replaced by one username and password (scrypt, N=16384),
    created with a one-time 6-digit code printed to stdout, and a per-device
    `HttpOnly` cookie. There is still one owner; golemlink is not multi-user.

21. **Listening beyond loopback.** `--tailscale` (or `http.tailscale`) listens
    on the Tailscale address as well as 127.0.0.1, and `--bind` adds one other
    address. This is safe enough now that a password is required, so the
    warning and the "unsafe" name are gone (`--unsafe-bind` still works). The
    Host allowlist and 421 replies keep DNS rebinding out. The default port is
    6767.

22. **Item textures from Mojang at runtime.** Mojang's textures can't be
    shipped in this repo, so the daemon downloads the client jar for a server's
    version the first time a bot joins it, keeps only the item and block PNGs
    and an index, and serves them to signed-in browsers. Items drawn as 3D
    entity models (chests, beds, shields, heads) keep the letter tile. Server
    resource packs are not applied. `itemTextures: false` turns this off.

23. **Redesigned UI.** Four views replace the five tabs: Play (held item,
    hotbar, backpack, armor and the open window together), Chat, Move (map with
    drag-to-look, WASD) and Setup. On desktop, sessions sit in a left rail and
    chat in a right column. The step-N-blocks row and the separate look pad
    were removed from the UI; `step` stays in the protocol.

## Fake server / e2e

16. **Fake-server chest trigger.** The fake server opens its tracked chest
    window on any `block_place`/`use_item_on` packet while a chest has been
    placed with `trackChest()`. It is a test scaffold, not a wire-accurate
    block interaction.

17. **Tier-2 step order.** The damage alert is checked before the duplicate
    login kick: after the kick the session is stopped, so there is no health to
    drop. Both are still covered.

18. **Isolation in e2e.** The e2e cannot reach into the daemon process to make a
    handler throw. Tier 1 checks that a kick to one session leaves the other
    online; `test/session-network.test.js` injects throwing listeners into a
    session's `physicsTick` and packet handlers in-process and asserts only that
    session ends.

19. **`error then end` fixture.** A TCP server that destroys every connection
    models "a server that's down produces two errors and one end" without a real
    Minecraft server.
