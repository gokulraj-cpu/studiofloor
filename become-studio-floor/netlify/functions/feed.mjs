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
    return json({ ok: true, at: Date.now(), messages });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: "/api/feed" };
