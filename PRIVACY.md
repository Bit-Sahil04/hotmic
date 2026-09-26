# HotMic Privacy Policy

HotMic coordinates microphone ownership between people joining the same Google Meet call from
the same physical room. This policy describes everything the extension handles, and it exists
because the store listing requires it — HotMic itself collects nothing.

## What HotMic handles

| Data | Where it goes | Why |
|---|---|---|
| Your display name (you type it in the popup) | Sent to other HotMic users in your room, in the same meeting, after you explicitly join | So they can see who is nearby |
| Mic state, meeting id hash, random device id | Sent to other HotMic users in your room | Mic coordination |
| Meeting code | Never leaves your device | Used only to derive the room key (PBKDF2) |

## What HotMic never does

- It **never transmits audio** — no PCM, no recording, no transcripts, no meeting content.
- It sends **nothing to the extension's developer**. There is no developer server, no analytics,
  no tracking, no cookies.
- With the default settings, a third-party relay (PeerJS's public cloud) is used only during the
  first handshake between nearby devices. It sees only an opaque room tag, random device ids and
  AES-GCM-encrypted blobs — never names, meeting codes, or audio. Coordination traffic then flows
  directly between the devices on the local network. You can remove the third party entirely by
  self-hosting the rendezvous server or using the LAN helper (see the README).

## Data handling

- Data in transit is authenticated and encrypted with AES-GCM, using a key derived from the
  meeting code. Devices in other meetings cannot read or forge messages.
- Nothing is stored after you leave: no persistent storage of names, meetings, or messages.
- The extension does not read or modify website content beyond Google Meet's microphone control,
  and only while you are in a Meet call.

## Choices

- Leave the display name empty or decline the join prompt: nothing is shared.
- Type `off` in the popup's Discovery field to disable WebRTC discovery entirely.
- Remove the extension and all handling of the above stops.

## Contact

Open an issue at https://github.com/Bit-Sahil04/hotmic/issues.
