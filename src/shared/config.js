// Central configuration. Every timing / threshold used by the protocol lives here;
// nothing else in the code base should hard-code these values.

export const PROTOCOL_VERSION = 1;

export const CONFIG = Object.freeze({
  // ---- Presence / lease --------------------------------------------------
  HEARTBEAT_INTERVAL_MS: 1000,   // periodic presence + lease renewal
  LEASE_TIMEOUT_MS: 3000,        // owner (or any peer) silent this long => expired
  PEER_TIMEOUT_MS: 3000,         // peer considered gone for coordination purposes
  PEER_FORGET_MS: 60000,         // peer removed from the table entirely
  LEASE_SAFETY_MARGIN_MS: 500,   // owner fences itself this much before peers could expire it
  SYNC_MS: 1500,                 // must listen this long before claiming / declaring expiry

  // ---- Ownership -----------------------------------------------------------
  HANDOVER_COUNTDOWN_MS: 10000,  // request shows this long before the mic is passed
  HANDOVER_AUTO_ACCEPT_MS: 3000, // auto-accept when the holder has been quiet this long
  HANDOVER_PAUSE_ZONE_MS: 3000,  // in this final stretch the countdown pauses while the owner speaks
  CLAIM_TIMEOUT_MS: 2000,        // claim not agreed within this => abandon
  CLAIM_RETRY_BACKOFF_MS: 500,
  CLAIM_RESEND_MS: 250,          // re-broadcast pending claim this often
  UNMUTED_CONFLICT_GRACE_MS: 2000, // another member unmuted this long while we own => fence

  // ---- Activity (browser-level WebRTC audioLevel, never raw audio) ---------
  ACTIVITY_LEVEL_THRESHOLD: 0.02,
  ACTIVITY_IDLE_MS: 1200,        // owner quiet this long => request may transfer
  ACTIVITY_STALE_MS: 2000,       // no samples this long => activity unknown
  ACTIVITY_POLL_MS: 300,

  // ---- Scheduling ----------------------------------------------------------
  TICK_MS: 100,
  MIN_SEND_GAP_MS: 50,           // coalesce immediate heartbeats
  SLEEP_GAP_MS: 5000,            // wall-clock gap between ticks => sleep/resume

  // ---- Meet control --------------------------------------------------------
  MIC_COMMAND_TIMEOUT_MS: 1500,
  MIC_COMMAND_RETRIES: 2,
  MIC_MUTE_RETRY_SLOW_MS: 2000,  // keep retrying mute (fail closed) at this rate
  MEET_POLL_MS: 300,
  MEET_VERIFY_TIMEOUT_MS: 1000,
  MEET_UNKNOWN_GRACE_MS: 1000,   // button missing this long => UNKNOWN
  MEET_EXIT_GRACE_MS: 1500,      // call UI missing this long => left meeting

  // ---- Input ---------------------------------------------------------------
  PTT_PRESS_DEBOUNCE_MS: 30,
  PTT_RELEASE_DEBOUNCE_MS: 150,
  PTT_MAX_HOLD_MS: 5 * 60 * 1000, // missed key-up safety net
  TOGGLE_DEBOUNCE_MS: 400,

  // ---- Security --------------------------------------------------------------
  KDF_ITERATIONS: 100000,
  MAX_CLOCK_SKEW_MS: 10 * 60 * 1000,
  MAX_NAME_LENGTH: 40,

  // ---- Native helper -------------------------------------------------------
  NATIVE_HOST_NAME: 'com.hotmic.lan',
  TRANSPORT_RETRY_MIN_MS: 1000,
  TRANSPORT_RETRY_MAX_MS: 10000,

  // ---- WebRTC discovery (rendezvous server + LAN-only data channels) --------
  RTC_LISTEN_MS: 4000,           // try reaching existing masters this long before becoming one
  RTC_CONNECT_TIMEOUT_MS: 8000,  // a link not open by then is dropped (not on our LAN)
  RTC_FAILED_BACKOFF_MS: 60000,  // don't retry an unreachable master sooner than this
  RTC_PROBE_WAIT_MS: 2000,       // cloud driver: wait for a slot dial before claiming
  RTC_MASTER_REFRESH_MS: 10000,  // master re-registers (server TTL is 3x this)
  RTC_GOSSIP_MS: 5000,           // peer-list exchange inside the mesh
  RTC_CHECK_MS: 5000,            // member without a master link re-checks the server
  RTC_RETRY_MS: 5000,            // server unreachable => retry this often
  RTC_INBOX_WAIT_S: 20,          // long-poll duration
  RTC_MAX_PEERS: 32,             // links per device (mesh)
  RTC_SIGNAL_MAX_AGE_MS: 60000,  // older signalling messages are replays => dropped
});

export const DEFAULT_SETTINGS = Object.freeze({
  displayName: '',
  mode: 'ptt',        // 'ptt' | 'toggle'
  pttKey: 'Space',    // KeyboardEvent.code
  discoveryUrl: '',   // WebRTC rendezvous server, e.g. https://hotmic.example.com ('' = off)
  alsoMuteAudio: false, // mute this tab's audio while not talking (speaker->mic feedback guard)
});

/** Subset of config the content script needs (it cannot import ES modules). */
export function contentConfig(config = CONFIG) {
  return {
    MEET_POLL_MS: config.MEET_POLL_MS,
    MEET_VERIFY_TIMEOUT_MS: config.MEET_VERIFY_TIMEOUT_MS,
    MEET_UNKNOWN_GRACE_MS: config.MEET_UNKNOWN_GRACE_MS,
    MEET_EXIT_GRACE_MS: config.MEET_EXIT_GRACE_MS,
    ACTIVITY_POLL_MS: config.ACTIVITY_POLL_MS,
  };
}
