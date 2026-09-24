// Meeting identity extraction from Google Meet URLs.

const MEET_HOST = 'meet.google.com';
// Standard Meet codes look like abc-defg-hij. Be slightly lenient on segment length.
const CODE_RE = /^\/([a-z]{3,4}-[a-z]{4,5}-[a-z]{3,4})(?:\/|$)/i;

/**
 * Returns the normalised meeting code (e.g. "abc-defg-hij") or null when the URL
 * is not a Meet call URL (landing page, /lookup/, /new, settings, ...).
 */
export function parseMeetingId(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== MEET_HOST) return null;
  const m = CODE_RE.exec(url.pathname);
  return m ? m[1].toLowerCase() : null;
}
