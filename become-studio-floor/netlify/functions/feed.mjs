// GET /api/feed — recent #_general posts for the Studio TV (news, wins, kudos, launches).
import { CHANNELS, guard, json, cached, history, loadUsers, loadChannels, messageText, withNames, istDate, errorResponse } from "../lib/slack.mjs";

const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "pinned_item", "message_deleted"]);

export default async (req) => {
  const refused = guard(req);
  if (refused) return refused;
  try {
    const [msgs, users, channels] = await Promise.all([
      cached("general", 5 * 60 * 1000, () => history(CHANNELS.general, { limit: 60, pages: 1 })),
      loadUsers(),
      loadChannels().catch(() => []),
    ]);
    const messages = [];
    for (const m of msgs) {
      if (m.subtype && SKIP_SUBTYPES.has(m.subtype)) continue;
      const plain = m.text || "";
      const full = messageText(m);
      const raw = full.length > plain.length * 1.5 ? full : plain;   // bot posts often keep their content in blocks
      if (!raw.trim()) continue;
      const author = m.user && users[m.user] && !m.bot_id ? users[m.user].name : "";
      messages.push({ author, raw: withNames(raw, users, channels), date: istDate(m.ts) });
    }
    // Bubble lines people post about themselves in #studio-floor-lines (the app must be invited there).
    const lines = {};
    const want = (process.env.LINES_CHANNEL || "studio-floor-lines").replace(/^#/, "");
    const ch = channels.find(c => c.name === want && c.is_member);
    if (ch) {
      try {
        const msgs2 = await cached("lines", 10 * 60 * 1000, () => history(ch.id, { limit: 100, pages: 1 }));
        for (const m of msgs2) {
          if (!m.user || m.bot_id || m.subtype) continue;
          (lines[m.user] = lines[m.user] || []).push(withNames(m.text || "", users, channels));
        }
      } catch (_) { /* no lines yet */ }
    }
    return json({ ok: true, at: Date.now(), messages, lines });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: "/api/feed" };
