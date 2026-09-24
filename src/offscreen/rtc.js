// Real WebRTC peer used by the mesh: one reliable data channel, non-trickle ICE.
//
// iceServers: [] => only host candidates are gathered (no STUN/TURN), so a link can
// only form between devices that can reach each other directly on the local
// network. Chrome hides host IPs behind random mDNS ".local" names, which resolve
// only on the same LAN.

const GATHER_TIMEOUT_MS = 3000;
const DISCONNECTED_GRACE_MS = 4000;

export function createRtcPeer({ onOpen, onMessage, onClose }) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  let dc = null;
  let closed = false;
  let discTimer = null;

  const bind = (ch) => {
    dc = ch;
    ch.onopen = () => { if (!closed) onOpen(); };
    ch.onmessage = (e) => { if (!closed && typeof e.data === 'string') onMessage(e.data); };
    ch.onclose = () => close();
  };
  pc.ondatachannel = (e) => bind(e.channel);
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed' || s === 'closed') close();
    else if (s === 'disconnected') {
      clearTimeout(discTimer);
      discTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') close(); }, DISCONNECTED_GRACE_MS);
    }
  };

  const gathered = () => new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(discTimer);
    try { dc?.close(); } catch { /* ignore */ }
    try { pc.close(); } catch { /* ignore */ }
    onClose();
  }

  return {
    async createOffer() {
      bind(pc.createDataChannel('hotmic', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      await gathered();
      return pc.localDescription.sdp;
    },
    async acceptOffer(sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered();
      return pc.localDescription.sdp;
    },
    async acceptAnswer(sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp });
    },
    send(s) {
      if (closed || !dc || dc.readyState !== 'open') return false;
      try { dc.send(s); return true; } catch { return false; }
    },
    close,
  };
}
