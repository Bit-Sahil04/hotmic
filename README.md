<div align="center">
  <img src="assets/logo.svg" width="96" alt="HotMic logo"/>
  <h1>HotMic</h1>
  <p><b>One microphone per room.</b><br>
  A Chrome extension for people in the same room joining the same Google Meet.</p>
</div>

---

## What it does

- Nearby HotMic users in the same Meet call find each other and explicitly opt in.
- Exactly **one person owns the microphone** at a time — everyone else is muted *in Meet*.
- Push-to-talk (default **Space**) or toggle mode. Works alone too.
- Hand-over is a visible **request** with Wait / Accept — never a silent grab, and it never cuts
  off a speaking owner.
- Controls Meet's mute state only; **no audio is ever transmitted** — only small encrypted
  control messages. Chrome 111+, Windows and macOS, no build step.

## Quick start

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder.
   (The ID is pinned to `ijjmpbibipdmmloibgobofjoindgplop` via the manifest `key`.)
2. Open the popup once: set **your name**, pick a mode and key.
3. Join a Meet call. Each nearby device gets an in-page prompt — **Join microphone sharing** —
   then hold the key to talk. The in-page pill shows who owns the mic.

## Connecting devices (hosting options)

Devices need one way to *find* each other. Coordination traffic itself always flows directly
over your local network. The options combine — messages go out on every path that is up and are
de-duplicated on arrival. Without any option, HotMic still works in **local-only** mode.

### 1. Built-in cloud — the default, zero install

Out of the box, HotMic uses the **PeerJS public cloud** as a blind broker for the first
handshake only. Nothing to install, no account.

```mermaid
sequenceDiagram
    autonumber
    participant C as PeerJS cloud (third party)
    participant A as Device A (claims the room slot)
    participant B as Device B

    A->>C: connect with a random id, claim slot "h<roomTag>"
    Note over C: roomTag = PBKDF2 hash of the meeting code — the code itself is never sent
    B->>C: dial the same slot
    C->>A: relay B's AES-GCM-sealed WebRTC offer (ciphertext)
    A->>C: relay sealed answer + LAN-only ICE candidates
    B->>A: direct data channel opens (host candidates only, typically LAN)
    A->>B: sealed challenge — prove knowledge of the room key
    B->>A: sealed reply — link accepted; everything further flows device-to-device
```

| The cloud **sees** | The cloud **never sees** |
|---|---|
| An opaque slot id `h<roomTag>` (PBKDF2 hash of the meeting code) | The meeting code or URL |
| Random per-session device ids | Your name, device, or anything about you |
| AES-GCM-sealed handshake blobs | Offer/answer contents, IPs (mDNS-masked), messages |
| — | **Any audio, keystrokes, or meeting content** |

Why this is safe to trust with a stranger's infrastructure:

- **LAN-only ICE** — no STUN/TURN, so the cloud has no relay path for traffic even by accident;
  a device on another network simply isn't "nearby".
- **Sealed signalling** — offers/answers are ciphertext to the cloud; a link only opens after the
  sealed challenge proves both sides hold the room key (derived from the meeting code).
- **Handshake-only** — once a link exists, heartbeats and ownership messages flow directly
  between devices. If the cloud goes down, an existing mesh keeps working.

### 2. Your own rendezvous server

For corporate networks, offline rooms, or when you don't want any third party: run the blind
rendezvous server (`rendezvous/`) and paste its URL into the popup's **Discovery** field
(the `i` icon next to it explains the options).

```sh
npm run rendezvous            # Node ≥ 18, PORT=8787 by default
# or, on Cloudflare's free tier: npx wrangler deploy  (in rendezvous/)
```

The server stores only a room tag, random ids and sealed blobs — all expiring. It never sees
plaintext, names, or meeting codes.

### 3. LAN helper — no cloud at all

A tiny Node.js ≥ 18 native-messaging helper (`native-host/`, no dependencies) broadcasts
heartbeats via multicast/subnet broadcast, LAN-only. It is a relay for already-encrypted
envelopes and never sees plaintext.

| OS | Install | Uninstall |
|---|---|---|
| Windows | `powershell -ExecutionPolicy Bypass -File native-host\install-windows.ps1` | `native-host\uninstall-windows.ps1` |
| macOS | `sh native-host/install-macos.sh` | `sh native-host/uninstall-macos.sh` |

Restart Chrome after installing; allow Node.js through the firewall when prompted.

### 4. Off — local-only

Type `off` in the popup's Discovery field to disable WebRTC discovery (the helper and local-only
mode keep working). The popup shows one line per path with its status.

## How it works

**Identity.** The meeting code (`meet.google.com/abc-defg-hij` → `abc-defg-hij`) derives, via
PBKDF2, a `roomTag` for routing and an AES-GCM key for every message. A device joins a room only
when it is in the **same meeting**, on a **directly reachable network**, and has **explicitly
joined**. `device_id` is random per session.

**Ownership.** Shared state is a replicated record `{ lease_epoch, owner }`; every change bumps
the epoch and devices adopt the highest. A device becomes owner — and unmutes — only when **every
live member echoes its record** and reports its Meet mic as not unmuted; simultaneous requests
settle deterministically. Members ack the owner's heartbeats; a silent owner is fenced muted and
the lease expires after 3 s. Manual changes are reconciled: a non-owner's unmute is reverted, an
owner's manual mute releases ownership, and Meet's own hold-Space-to-talk is suppressed.

**Hand-over.** Someone wanting the mic creates a 10 s request (`HANDOVER_COUNTDOWN_MS`): the
owner's island turns yellow with **Wait / Accept**; the requester sees
*"Requesting microphone from …"*. **Accept** passes immediately; **Wait** cancels until a fresh
press; with no answer the mic passes once the owner has been quiet for 3 s
(`HANDOVER_AUTO_ACCEPT_MS`), and the final window pauses while Meet still shows the owner
speaking — nobody is cut off mid-sentence.

**Fail-closed.** Silence, ack loss, helper loss, sleep/wall-clock gaps, an `UNKNOWN` Meet state,
internal errors, or a closed tab: the device mutes and releases *first*, then re-syncs. Malformed,
stale, or replayed messages are dropped (strict validation, sequence numbers, epochs, clock
window).

## Development

```sh
npm test               # 82 tests — protocol/race simulator, mesh, rendezvous, units, e2e
npm run smoke          # real Chrome + fake Meet page (local-only)
npm run smoke:webrtc   # two Chrome instances over real WebRTC (add --builtin for the real cloud)
npm run icons          # regenerate brand PNGs from tools/make-icons.mjs
```

```text
src/
├── shared/     config.js (all timings), fsm.js, meeting.js (meeting-code parsing)
├── background/ service-worker (glue) · session · consent · discovery · ownership
│               mic (Meet state + reconcile) · input (PTT/toggle) · messages (wire schema)
│               crypto (room tag + AES-GCM) · transport (helper) · webrtc-transport · multi-transport
├── offscreen/  WebRTC mesh: master election, LAN-only links, sealed channel auth (vendored PeerJS)
├── content/    page-probe (mic observation, MAIN world) · meet-adapter · overlay · content
└── popup/      popup UI
native-host/    LAN helper + installers · rendezvous/  self-hostable discovery server
test/           deterministic simulator + unit/integration tests · tools/  real-Chrome smokes
```

All protocol logic is pure (clock, transport and adapter injected), so the same code runs in the
service worker and in the simulator. After **every simulated event**, tests assert that no two
participants are ever unmuted.

## Known limitations

- **Meet DOM changes** — Meet has no API; if its mic toggle changes, state becomes `UNKNOWN` and
  HotMic fails closed until `meet-adapter.js` is updated.
- **Guest Wi-Fi / client isolation** blocks discovery on all paths.
- **One owner per network partition** — two isolated halves may each have an owner (solo use
  requires unanimity to be permissive by design).
- **Keys work only in the focused Meet tab**; toggle is also available from the popup.
- **Mic label** appears only if the content script loads before Meet opens the microphone —
  reload Meet after installing.
- The helper needs Node.js ≥ 18 per machine; the WebRTC path needs nothing.
