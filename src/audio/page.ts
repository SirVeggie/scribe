import { checkPermission, type PermissionGrant } from "../pagePermissions.js";

type Gate = { ok: boolean; error?: "denied" | "rate_limited"; permission?: string };
/** Per page: speech requests (one per sentence group) and characters read aloud. */
export const SPEECH_LIMITS = { perMinute: 30, perHour: 300, charsPerHour: 100_000 };

/** Defence in depth for page uploads and speech; chat use does not consume these limits. */
export class PageAudio {
  private calls = new Map<string, number[]>();
  private speech = new Map<string, { at: number; chars: number }[]>();
  constructor(private grants: (id: string) => Map<string, PermissionGrant>, private now = Date.now) {}
  private allowed(id: string, perm: string) {
    try { return checkPermission(this.grants(id), { perm }) === "allow"; } catch { return false; }
  }
  check(id: string): Gate {
    if (!this.allowed(id, "audio.transcribe")) return { ok: false, error: "denied", permission: "audio.transcribe" };
    const now = this.now();
    const times = (this.calls.get(id) ?? []).filter(t => now - t < 3600000);
    if (times.length >= 60 || times.filter(t => now - t < 60000).length >= 6)
      return { ok: false, error: "rate_limited" };
    times.push(now); this.calls.set(id, times);
    return { ok: true };
  }
  /** audio.speak: the page's text goes to the speech source, which may charge per character. */
  checkSpeech(id: string, chars: number): Gate {
    if (!this.allowed(id, "audio.speak")) return { ok: false, error: "denied", permission: "audio.speak" };
    const now = this.now();
    const recent = (this.speech.get(id) ?? []).filter(c => now - c.at < 3600000);
    if (recent.length >= SPEECH_LIMITS.perHour || recent.filter(c => now - c.at < 60000).length >= SPEECH_LIMITS.perMinute
      || recent.reduce((sum, c) => sum + c.chars, 0) + chars > SPEECH_LIMITS.charsPerHour)
      return { ok: false, error: "rate_limited" };
    recent.push({ at: now, chars }); this.speech.set(id, recent);
    return { ok: true };
  }
}
