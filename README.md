# HotMic — Microphone Sharing for Google Meet (V1)

A Chrome extension for people sitting **in the same room** and joining the **same Google Meet**.
Nearby extension instances find each other on the local network. Each person explicitly opts
in, and then only one participant "owns" the microphone at a time: when someone takes it, every
other participating device is muted **in Google Meet**.

* Controls **Google Meet's mute state only**. No OS microphone control, no drivers, no virtual
  devices, no audio mixing.
* **Never transmits audio.** Only small, encrypted control/state messages are exchanged.
* Push-to-Talk or Toggle mode. Works alone too (no other participant required).
* Chrome 111+ on Windows and macOS.

---

## Install

### 1. Load the extension

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. The manifest pins the extension ID to **`ijjmpbibipdmmloibgobofjoindgplop`** (via `key`), which
   the helper installers use by default.

### 2. Choose how nearby devices find each other

Chrome extensions cannot open network sockets, so they can't broadcast or listen on the LAN by
themselves. There are two ways to do discovery. Use either one, or both at once: messages go out
on every path that is up and are de-duplicated on arrival.

| | **A. LAN helper** | **B. WebRTC + discovery server** |
|---|---|---|
| Install per machine | Node.js + one script | nothing |
| Leaves the LAN | nothing | a one-time encrypted handshake per device |
| Needs | multicast/broadcast allowed on the network | a reachable rendezvous server, mDNS on the LAN |

Without either, the extension still works in **local-only** mode (sharing alone). The popup
shows `Local only`, with one line per discovery path explaining why it isn't available.

#### Option A: LAN helper (fully local)

LAN discovery goes through a tiny
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
helper (`native-host/hotmic_host.mjs`, Node.js ≥ 18, no dependencies). It is a dumb relay for
already-encrypted envelopes. It never sees plaintext, meeting codes, names or audio.

| OS | Install | Uninstall |
|---|---|---|
| Windows | `powershell -ExecutionPolicy Bypass -File native-host\install-windows.ps1` | `native-host\uninstall-windows.ps1` |
| macOS | `sh native-host/install-macos.sh` | `sh native-host/uninstall-macos.sh` |

Pass a different extension ID as the first argument (`-ExtensionId <id>` on Windows) if you load
the extension under another ID. Restart Chrome after installing.

* **Windows:** allow Node.js through Windows Defender Firewall on *Private* networks when prompted.
* **macOS:** allow Chrome to "find devices on your local network" when prompted.

#### Option B: WebRTC discovery (zero install)

Out of the box the extension uses the **PeerJS public cloud** as its discovery provider (zero
setup, no account): the room's rendezvous "master slot" is the deterministic PeerJS id
`h` + <room tag> and the cloud arbitrates claims, so exactly one device per meeting becomes the
master; everyone else dials the slot directly. The first exchange on every link is an
AES-GCM-sealed challenge bound to the room key (see `src/offscreen/peerjs-mesh.js`), so only
genuine room members can link. With LAN-only ICE (no STUN/TURN) the audio-control traffic still
never leaves the local network; the cloud only sees opaque room tags, random ids and mDNS-based
SDPs.

Self-hosting (corporate networks, offline rooms, or not trusting the default): run

```sh
PORT=8787 node rendezvous/server.mjs      # or: npm run rendezvous
```

or deploy `rendezvous/worker.mjs` to your own Cloudflare account (`npx wrangler deploy`). Then
paste the URL into the popup's **Discovery** field — the `i` icon next to it explains the
options; that path uses our own blind rendezvous protocol (sealed SDP signalling, the cloud sees
even less). Typing `off` there disables WebRTC discovery (the LAN helper and local-only mode keep
working). The popup shows `WebRTC (built-in cloud): connected · master · 0 nearby links` on the
first device and `… · 1 nearby link` on the next one.

> Implementation note: the PeerJS cloud only relays traffic from its own client library — it
> 403s non-browser sockets and closes hand-rolled relay frames (see `tools/peerjs-probe.mjs`,
> `tools/relay-probe.mjs`). We therefore vendor `vendor/peerjs.min.js` (~93 KB, MIT) into the
> offscreen document and let it own the connections; our mesh rides on its data channels. The
> public WebTorrent trackers were evaluated as an alternative and rejected — they no longer
> relay offers/answers (`tools/tracker-probe.mjs`).

### 3. Use it

1. Open the popup once and set **Your name** (shown only to nearby devices in the same meeting).
2. Join a Meet call. When another device in the same meeting is nearby you get an in-page prompt:
   *"Sahil is nearby and is using Microphone Sharing for this meeting."* →
   **Join microphone sharing** / **Not now**. You can also join from the popup, even alone.
3. Hold the PTT key (default **Space**) to talk, or switch to **Toggle** mode (key or popup button).
4. The in-page pill shows *"Sahil has the microphone · 17s"* or *"Microphone available"*.

---

## Architecture

No frameworks or build step: plain MV3, with ES modules in the service worker.

```text
manifest.json
src/
├── shared/
│   ├── config.js          all timings / thresholds (heartbeat, lease, 5 s minimum, debounce…)
│   ├── fsm.js             explicit state-machine helper (transition tables)
│   └── meeting.js         meeting-id extraction from Meet URLs
├── background/            ── service worker (module)
│   ├── service-worker.js  glue: tabs ⇄ sessions ⇄ transport ⇄ popup
│   ├── session.js         State Manager: one RoomSession per tab + meeting + call
│   ├── consent.js         Consent Manager: participation state machine
│   ├── discovery.js       Discovery: peer table, presence, heartbeats
│   ├── ownership.js       Ownership Manager: record / lease_epoch / lease / agreement / transfer
│   ├── mic.js             local Meet mic state + command/verify/reconcile
│   ├── input.js           Input Manager: PTT / Toggle / debounce
│   ├── messages.js        wire schema + strict validation
│   ├── crypto.js          room tag + AES-GCM envelopes derived from the meeting code
│   ├── transport.js       option A: native-messaging LAN transport (reconnect, status)
│   ├── webrtc-transport.js option B: owns the offscreen document running the WebRTC mesh
│   └── multi-transport.js runs A + B side by side, de-duplicates received envelopes
├── offscreen/             ── option B (service workers have no RTCPeerConnection)
│   ├── offscreen.js       one RoomMesh per active meeting
│   ├── mesh.js            master election, LAN-only links, gossip, relay signalling (pure)
│   ├── rtc.js             RTCPeerConnection + data channel, host candidates only
│   └── signal-client.js   rendezvous HTTP client
├── content/               ── meet.google.com only
│   ├── page-probe.js      Device Manager (MAIN world): observes Meet's getUserMedia mic + WebRTC audioLevel
│   ├── meet-adapter.js    Meet Adapter: detect call, find mic toggle, read/click mute
│   ├── overlay.js         in-page consent prompt + ownership pill (shadow DOM)
│   └── content.js         wiring, key capture, fail-closed on disconnect
└── popup/                 popup UI
native-host/               option A: LAN helper + installers (Windows / macOS)
rendezvous/                option B: discovery server (store.mjs = all of its state)
test/                      simulator + protocol / race / mesh / unit / e2e tests
tools/                     real-Chrome smoke tests (single browser; two browsers over WebRTC)
```

All protocol logic (`session.js` and its managers) is pure, with the clock, transport and Meet
adapter injected. The exact same code runs in the service worker and in the deterministic Node
simulator used by the tests.

### State machines (independent)

| Machine | States | Where |
|---|---|---|
| Local participation | `NOT_IN_MEETING → IN_MEETING → PROMPTED → SHARING_DECLINED \| SHARING_JOINED` | `consent.js` |
| Ownership (this device) | `NO_OWNER → REQUESTED → OWNER → RELEASED → NO_OWNER` | `ownership.js` |
| Local Meet microphone | `MUTED \| UNMUTED \| UNKNOWN` (reported, never assumed) | `mic.js` |
| PTT input | `IDLE → PRESS_PENDING → HELD → RELEASE_PENDING`, `SUPPRESSED` | `input.js` |
| Toggle input | `OFF ⇄ ON` | `input.js` |

Shared ownership state is the replicated record `{ lease_epoch, owner_device_id | NO_OWNER }`.

---

## How it works

### Meeting + room identity

`https://meet.google.com/abc-defg-hij` → meeting id `abc-defg-hij` (`meeting.js`). The service
worker creates a session only while the Meet **call UI** is present (not the landing page, not the
pre-join lobby). From the meeting code it derives, with PBKDF2:

* `roomTag`, used only to route packets, and
* an AES-GCM key: every message is encrypted and authenticated.

So a device belongs to a sharing room only when it is on the **same LAN** + in the **same meeting**
+ has **explicitly joined**. Devices in other meetings can't match, read or forge messages, and
the meeting code never goes on the wire.

### Discovery / presence

Every undecided or joined device broadcasts a heartbeat every `HEARTBEAT_INTERVAL_MS` (1 s),
plus immediately on any change. The heartbeat carries `device_id, display_name, sharing_status,
mic_state, ownership record, request, acks`; `last_seen` is tracked by the receiver. Declined
devices stay silent. `device_id` is random and new for every meeting session (and after leaving
sharing).

**Option A (helper):** the helper sends on every IPv4 interface via multicast (TTL 1) + subnet
broadcast + unicast to recently heard peers, and reports interface changes. Every device must
exchange heartbeats and acks for the ownership protocol anyway, so on UDP every device simply
beacons. A master would only add a single point of failure there.

**Option B (WebRTC): listen first, then become master.**

1. A device entering the call asks the rendezvous server for the room's *masters* and tries to
   open a data channel to each one.
   * Links use **host ICE candidates only** (no STUN/TURN). They can only form between devices
     that reach each other directly on the local network.
   * Chrome hides the IPs behind mDNS `.local` names.
   * A master on another network (a remote participant in the same meeting) is simply
     unreachable, so it isn't "nearby".
2. It reaches a master → becomes a **member**. It reaches none within 4 s → becomes a **master**
   itself: it registers with the server and answers newcomers. Normally that is one master per LAN.
3. Inside the mesh, devices gossip peer lists and connect to everyone. The signalling for those
   links is **relayed over existing links, not the server**. The lower device id initiates, so
   there is no glare.
4. Masters that turn out to reach each other (e.g. two devices raced into the role) merge: the
   higher id steps down. If a master leaves or crashes, the lowest-id remaining member takes over.
   Members that are linked to a master never contact the server.

The server sees only an opaque room tag, random device ids and AES-GCM-sealed SDP blobs. All of
it expires, and none of it is ongoing traffic: heartbeats and ownership messages flow directly
over the LAN data channels.

### How many devices can discover each other?

| Limit | Value | Why |
|---|---|---|
| Masters per meeting on the server | 16 (`MAX_MASTERS`) | ≈ one per distinct network with HotMic users |
| Direct links per device (WebRTC) | 32 (`RTC_MAX_PEERS`) | full mesh: each device holds N−1 data channels; Chrome allows far more, but CPU/battery add up |
| Helper (UDP) | no hard limit | each device just receives N small packets/s |
| **Practical room size** | **~20–25 sharing devices** | the ownership protocol needs *every* joined member to confirm a handover, so each extra device adds latency and loss sensitivity |

That comfortably covers a meeting room. Bigger rooms would need a star/relay topology plus quorum
agreement instead of unanimous agreement (a V2 topic).

### Ownership protocol (`ownership.js`)

* **Records and epochs.** Every change creates a new record with `lease_epoch + 1`. Devices adopt
  the highest record they see, using a deterministic total order: higher epoch; then owner beats
  none; then lower device id. Stale messages can never change state.
* **Agreement before unmuting.** A device becomes `OWNER` (and is unmuted) only once every live
  joined member has echoed exactly its record **and** reports its Meet mic as not unmuted. This
  settles simultaneous requests deterministically (exactly one owner) and makes every handover
  break-before-make.
* **Lease.** Members ack the owner's heartbeats. The owner fences itself (mutes and releases) at
  `LEASE_TIMEOUT_MS − LEASE_SAFETY_MARGIN_MS` after its last acked heartbeat. Observers expire a
  silent owner after `LEASE_TIMEOUT_MS` (3 s) → `NO_OWNER` → next request can acquire. The owner is
  always muted before anyone else could claim.
* **Minimum ownership.** A request never pre-empts an owner who has held the mic for less than
  the minimum-hold floor. The floor is `MIN_OWNERSHIP_ACTIVE_MS` (5 s) if the owner has spoken
  during the hold — or if activity is unknown/stale (conservative) — and `MIN_OWNERSHIP_IDLE_MS`
  (2 s) if Meet's WebRTC stats show the owner never spoke since acquiring the mic. After the
  floor, the owner transfers to the longest-waiting requester (epoch + 1) — but only when they
  are not speaking: while Meet's WebRTC stats still show mic activity, the transfer waits until
  the owner has been quiet for `ACTIVITY_IDLE_MS`, however long that takes. A voluntary release
  hands the mic straight to a waiting requester.
* A pre-empted user's intent is cleared (PTT needs a new press; toggle turns OFF), so there is no
  ping-pong.
* **Joining late.** A device must listen for `SYNC_MS` before it may claim, so a late joiner
  always joins muted and never disturbs the current owner.

### Meet adapter + reconciliation

* Mute state comes from Meet's mic toggle (`[data-is-muted]`). The mic is told apart from the
  camera by the non-localised `ctrl/⌘ + d` hint, with words/icons as fallback. If the toggle is
  ambiguous or missing, the state is `UNKNOWN`.
* Commands click Meet's own button and then **verify** the resulting DOM state, with retries. On
  failure the device releases (unmute failed) or is marked inconsistent and keeps retrying the
  mute (fail closed).
* **Manual changes:**
  * Owner mutes in Meet → ownership released.
  * Non-owner unmutes → immediately re-muted; the owner is unchanged.
  * Meet's own hold-Space-to-unmute is suppressed while sharing, when Space is the PTT key.

### Microphone detection (`page-probe.js`)

The probe observes the audio track Meet obtained from `getUserMedia`: its label, `ended` events,
and `devicechange`. It **never selects a device**; Meet's choice is the source of truth. The popup
shows `Meet microphone: <label>`. If the user changes the mic in Meet, the new track is picked up.
If the device disappears, the owner fails closed and the UI asks the user to choose a mic in Meet.
Nothing is auto-selected.

### Fail-closed behaviour

| Condition | Result |
|---|---|
| Owner silent ≥ 3 s (Wi-Fi loss, crash, sleep, Chrome closed) | lease expires → `NO_OWNER`; owner already fenced muted |
| Owner stops receiving acks | owner mutes + releases before peers could claim |
| Helper connection lost / network interface change | mute, release, resync before new claims |
| Laptop sleep/wake (wall-clock gap) | mute, release, drop stale presence, resync |
| Meet state `UNKNOWN` | owner releases; no claims |
| Another member stays unmuted (can't be re-muted) | owner fences itself |
| Malformed / stale / replayed messages | dropped (strict validation, seq, epoch, clock window) |
| Service worker restarts / extension reloads | content script mutes Meet locally, reconnects; orphaned scripts tear down |
| Internal error in evaluation | mute |
| Meet tab closed / call left / URL changes | release + `leave` message, mute, stop heartbeats, clear session state |

Consent survives only a service-worker restart within the same page instance. A refresh, a new
call or a new meeting always starts fresh, with no inherited ownership.

### Privacy

Messages contain only the whitelisted metadata listed in `messages.js`, and a test enforces this.
There is no PCM, recording, transcript or meeting content. The activity signal is the browser's
own `audioLevel` statistic, used locally only and never transmitted. The helper never sees
plaintext.

---

## Tests

```sh
npm test               # 71 tests: protocol/race simulator, mesh, rendezvous, units, adapter, SW glue, real-UDP e2e
npm run smoke          # real Chrome + fake Meet page (local-only mode)
npm run smoke:webrtc   # two real Chrome instances + local rendezvous server, over real WebRTC
```

* `test/mesh.test.js` covers master election and full-mesh convergence, a forced race where
  everyone becomes master and then merges, a remote participant on another network that never
  links, clean and crashed master hand-off, server outages, and forged/replayed signalling.
* `tools/browser-webrtc-smoke.mjs` runs two separate Chrome profiles (two "laptops") with no
  helper. It checks: A becomes master; B listens, finds A and is prompted; B joins as member (one
  master on the server); PTT on A unmutes only A; B's request inside A's minimum hold is held; release hands
  over to B; the server never saw names or the meeting code.

* `test/protocol.test.js` runs the real session code on a simulated LAN with latency, jitter,
  loss and partitions. After **every event** it checks that no two participants are ever unmuted.
  It covers every race in the spec:
  * simultaneous PTT
  * rapid toggling
  * owner disconnect
  * owner manual mute
  * non-owner manual unmute
  * simultaneous joins
  * late joiner
  * stale epochs
  * asymmetric partition
  * 20 % packet loss with random PTT use
* `test/e2e.test.js` starts real helper processes and runs sessions with real crypto over UDP,
  including meeting isolation.
* `tools/browser-smoke.mjs` loads the unpacked extension into a throw-away Chrome profile (via CDP
  `Extensions.loadUnpacked`) and serves a fake `https://meet.google.com/abc-defg-hij` page. It
  checks: meeting detection, join alone, PTT unmute/mute through the real content script,
  suppression of Meet's Space handler, manual-unmute revert, and cleanup.

## Acceptance criteria

| # | Criterion | Where |
|---|---|---|
| 1–3 | Detect Meet, meeting, session | `meet-adapter.js`, `meeting.js`, `service-worker.js` · smoke test |
| 4–5 | LAN discovery, same meeting only | helper + `crypto.js` room tag/key · `e2e.test.js` |
| 6–8 | Prompt, join alone, decline | `consent.js`, overlay, popup · protocol tests |
| 9–11 | PTT / toggle acquire + release | `input.js`, `ownership.js` · tests + smoke |
| 12–13 | Single owner, others muted | agreement rule · simultaneous/lossy tests |
| 14–15 | No transfer < floor (5 s talked / 2 s silent), transfer after | `MIN_OWNERSHIP_*_MS` · tests |
| 16 | Debounce | `input.js` · repeat/bounce/rapid-toggle tests |
| 17 | Manual mute/unmute reconciled | `mic.js`, `ownership.onMicExternal` · tests + smoke |
| 18–19 | Lease expiry, fail closed | lease/fencing · disconnect/partition/sleep/transport tests |
| 20 | Leaving cleans up | `session.dispose` · tests + smoke |
| 21 | Follows Meet's selected mic | `page-probe.js` (observe only) |
| 22 | No audio transmitted | whitelist test, encrypted metadata only |
| 23–24 | Windows + macOS, no driver | MV3 + Node helper installers for both |

## Known limitations (V1)

* **Meet DOM changes.** Meet has no API; if Google changes the mic toggle markup, the state
  becomes `UNKNOWN`. The extension then fails closed and says so in the popup and overlay; update
  `meet-adapter.js`.
* **Networks that block multicast/broadcast/mDNS** (guest Wi-Fi, client isolation) prevent
  discovery with either option. Unicast (helper) is only used for peers that have already been
  heard.
* **WebRTC option needs the rendezvous server once per device.** An already formed mesh keeps
  working if the server goes down. Two devices on different LANs connected by a VPN can count as
  "nearby" (same as with the helper).
* **Keys only work in the Meet tab.** PTT/toggle keys are captured only while the Meet tab has
  focus. Toggle can also be used from the popup.
* **Partitions and sleeping members.** In a true network partition inside one room, each side can
  have its own owner (there is no quorum, by design, so that solo use works). A member whose
  laptop sleeps makes the current owner lose the mic after ~2.5 s. That is the price of fencing.
* **Node.js required for option A.** The helper needs Node.js ≥ 18 on each machine; option B needs nothing on the devices.
* **Late load.** Mic label detection needs the content script to be present before Meet opens the
  microphone. After installing or reloading the extension mid-call, reload Meet to see the label.
