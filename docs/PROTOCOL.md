# golemlink WebSocket protocol v1

The daemon serves one WebSocket endpoint on the same port as the web UI
(`ws://127.0.0.1:8765/` by default). Everything the UI can do goes through it.
The server is authoritative: it validates every field and answers with
`ack`/`err`.

## Framing

- JSON text frames only. Client frames are at most 64 KB.
- Any client message may carry an `id` (string or number). The server echoes it:
  `{"t":"ack","id":…}` on success or `{"t":"err","id":…,"code":"…","msg":"…"}`.
- Server messages never carry an `id` except in direct replies (ack/err/tab).

## Handshake

1. The client connects. `Origin` must be `http://127.0.0.1:<port>` or
   `http://localhost:<port>` (plus the `--unsafe-bind` address when used), and
   `Host` must match one of the same authorities. Otherwise the server completes
   the WebSocket handshake and immediately closes with code `4401`.
2. The first client message must be `{"t":"auth","token":"…"}` within 5 s,
   otherwise the server closes with `4401`. Tokens are compared as SHA-256
   digests with a constant-time comparison.
3. On success the server sends `hello`.

### `hello`

```json
{
  "t": "hello", "v": 1,
  "sessions": [ { "id": "main@lobby", "account": "main", "server": "lobby",
                  "state": "online", "reason": null, "detail": null,
                  "pendingMsa": null } ],
  "accounts": [ { "id": "main", "auth": "microsoft", "username": "you@example.com" } ],
  "servers":  [ { "id": "lobby", "name": "My network", "host": "play.example.net",
                  "port": 25565, "version": "auto", "autoReconnect": true,
                  "chatLog": true, "antiAfk": { "enabled": false, "intervalSec": 90 },
                  "alerts": { "keywords": ["Nick"], "damage": true, "death": true },
                  "resourcePack": "accept", "hasAutoLogin": false } ],
  "supportedVersions": ["1.8.8", "1.9.4", "…", "26.1"],
  "features": { "goto": true, "clickModes": ["normal", "shift"],
                "tabComplete": true, "notifications": false, "wakeLock": false },
  "daemon": { "name": "golemlink", "app": "1.0.0", "node": "22.0.0",
              "mineflayer": "4.39.0", "pathfinder": "2.4.5",
              "loopLagP99": 3.2, "rssMB": 132, "supportedRange": "1.8.8 – 26.1" }
}
```

Passwords never appear in `hello`: `servers[].hasAutoLogin` is the only exposed
bit. Config updates are announced with `accounts` and `servers` messages (see
below), which are v1 extensions to the spec table.

## Client → server

`s` is a session id, `<accountId>@<serverId>`.

| t | fields | effect |
|---|---|---|
| `sub` | `s` | subscribe this client to one session; the server replies with `snapshot` |
| `session.start` | `account`, `server` | start a session (at most 8 at once) |
| `session.stop` | `s` | stop a session (no reconnect) |
| `config.server.put` | `server` | create or update a server entry |
| `config.server.del` | `id` | delete a server entry (stops its sessions) |
| `config.account.put` | `account` | create or update an account |
| `config.account.del` | `id` | delete an account (stops its sessions) |
| `chat` | `s`, `text` | send chat or a `/command` |
| `tab` | `s`, `text` | tab-complete; the reply is `{"t":"tab","s":…,"items":[…]}` |
| `ctl` | `s`, `k`, `on` | `forward, back, left, right, jump` (momentary), `sprint, sneak` (latched) |
| `hold` | `s` | dead-man heartbeat while a momentary control is held |
| `look` | `s`, `yaw`, `pitch` | absolute angles in radians; the UI sends at most 20 Hz |
| `lookAt` | `s`, `x`, `y`, `z` | look at a world position |
| `goto` | `s`, `x`, `z`, `y?` | pathfind within 256 horizontal blocks |
| `step` | `s`, `dir`, `n` | `dir` is `n, e, s, w`; `n` is 1–16 |
| `stop` | `s` | cancel goto and clear momentary controls |
| `interact` | `s` | entity under the crosshair, else the block |
| `use` | `s` | use the held item |
| `hotbar` | `s`, `i` | select hotbar slot 0–8 |
| `click` | `s`, `window`, `slot`, `button`, `mode` | window click; `mode` 0 or 1, `button` 0 or 1, `slot` −999 allowed |
| `drop` | `s`, `slot`, `all` | drop one item or the whole stack |
| `closeWindow` | `s` | close the open window |

### Chat validation

- At most 256 characters (100 on 1.8–1.10.2). Longer text is rejected with
  `err code=too_long` rather than split, because an over-long packet gets the
  bot kicked.
- `§`, newlines and characters below U+0020 or U+007F are rejected with
  `err code=illegal_characters`.

## Server → client

| t | payload |
|---|---|
| `sessions` | full session list, sent to every authenticated client on any lifecycle change |
| `state` | `s`, `state` (`connecting`,`online`,`reconnecting`,`stopped`), `reason`, `detail`, `retryInMs?` |
| `snapshot` | `s`, `state`, `reason`, `detail`, `status`, `inventory`, `window`, `cursor`, `chat`, `players`, `features` |
| `chat` | `s`, `ts`, `plain`, `segs`, `echo?` |
| `status` | `s`, `x,y,z,yaw,pitch,dim,hp,food,sat,xpLvl,xpProgress,gm,quick,actionbar,target,ctl` (5 Hz) |
| `inv` | `s`, `window`, `slots` delta `{ "<slot>": item \| null }`, `cursor?` (debounced 50 ms) |
| `window` | `s`, a window object or `null` |
| `tiles` | `s`, `[{cx,cz,rgb}]` (at most 32 per message) |
| `untile` | `s`, `[{cx,cz}]` |
| `players` | `s`, `[{name,ping,gm,x?,z?}]` (2 Hz) |
| `ctlReset` | `s`, `reason` (`deadman`, `disconnect`, `goto`, `stop`) |
| `goto` | `s`, `phase` (`started`, `arrived`, `failed`, `cancelled`), `detail?` |
| `alert` | `s`, `kind` (`keyword`,`damage`,`death`,`stopped`,`msa`), `text` |
| `msa` | `s`, `code`, `url`, `expiresAt` |
| `tab` | `s`, `items` (reply to `tab`) |
| `accounts` | `accounts` — config extension: sent after account changes |
| `servers` | `servers` — config extension: sent after server changes |

Routing: `sessions`, `alert` and `msa` go to every authenticated client.
Everything else goes only to that session's subscribers.

### Backpressure

When a client's `bufferedAmount` exceeds 1 MB, the server stops sending it
`status` and `tiles`. Once the buffer drains below 256 KB, it sends a fresh
`snapshot` for every subscription and resumes.

## Shapes

**Item**

```json
{"n":"diamond_sword","d":"Diamond Sword","c":1,"cn":null,"lore":[],"dur":null,"ench":false}
```

`n` is the item id, `d` the display name (custom name if present), `cn` the
custom/plugin name or `null`, `dur` `[used,max]` or `null`, `ench` true when
enchanted.

**Window**

```json
{"id":3,"type":"minecraft:generic_9x3","title":{"plain":"…","segs":[]},
 "size":63,"invStart":27,"hotbarStart":54,"slots":[]}
```

The player inventory is window `0` (46 slots, `invStart` 9, `hotbarStart` 36).

**Chat segment**

```json
{"x":"text","c":"#rrggbb","b":1,"i":1,"u":1,"s":1,"o":1}
```

Only `x` is required; `c` is a hex color, the flags mean bold, italic,
underlined, strikethrough and obfuscated.

**Tile**

`rgb` is base64 of 16×16×3 bytes. Rows run along z (north to south), columns
along x (west to east).

**Snapshot fields**

- `inventory` — window shape for the player inventory (id 0).
- `window` — the open window shape or `null`.
- `cursor` — item shape held by the cursor, or `null`.

## Error codes

`bad_message`, `bad_json`, `unknown_type`, `bad_field`, `auth_required`,
`bad_token`, `rate_limited`, `internal`, `no_session`, `no_account`,
`no_server`, `already_running`, `session_limit`, `not_online`, `too_long`,
`illegal_characters`, `chat_failed`, `tab_failed`, `goto_unavailable`,
`goto_range`, `unsupported_mode`, `stale_window`, `bad_slot`, `cursor_busy`,
`nothing_there`, `bad_config`.
