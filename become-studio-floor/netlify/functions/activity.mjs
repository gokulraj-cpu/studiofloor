// GET /api/activity — what each person has been working on, from their last 7 days of public-channel messages.
// Only public channels are read. By default only channels the Slack app has been added to are used;
// set ACTIVITY_AUTO_JOIN=true to let the app join every public channel (Slack posts a "joined" line in each).
import { guard, json, cached, slack, history, loadUsers, loadChannels, withNames, errorResponse } from "../lib/slack.mjs";

const IGNORE = /^_|general|random|announce|attendance|leave|fun|social|watercooler|celebrat|birthday|memes?$|^dev-talk$/i;
const WEEK = 7 * 86400;

async function compute() {
  const deadline = Date.now() + 8000;
  const [channels, users] = await Promise.all([loadChannels(), loadUsers()]);
  const autoJoin = String(process.env.ACTIVITY_AUTO_JOIN || "").toLowerCase() === "true";
  const oldest = Date.now() / 1000 - WEEK;

  let targets = channels.filter(c => !c.is_private && !c.is_archived && !IGNORE.test(c.name));
  if (autoJoin) {
    for (const c of targets.filter(c => !c.is_member)) {
      if (Date.now() > deadline - 4000) break;
      try { await slack("conversations.join", { channel: c.id }); c.is_member = true; } catch (_) { /* skip */ }
    }
  }
  targets = targets.filter(c => c.is_member);

  const score = {};   // user -> channel -> score
  const latest = {};  // user -> {ch, text, ts}
  const queue = [...targets];
  const worker = async () => {
    while (queue.length && Date.now() < deadline) {
      const c = queue.shift();
      let msgs = [];
      try { msgs = await history(c.id, { oldest, limit: 100, pages: 1 }); } catch (_) { continue; }
      for (const m of msgs) {
        if (!m.user || m.bot_id || m.subtype) continue;
        const ageDays = (Date.now() / 1000 - Number(m.ts)) / 86400;
        const s = (score[m.user] = score[m.user] || {});
        s[c.name] = (s[c.name] || 0) + Math.max(0.2, 1 - ageDays / 8);
        if (!latest[m.user] || Number(m.ts) > latest[m.user].ts) latest[m.user] = { ch: c.name, text: m.text || "", ts: Number(m.ts) };
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const people = {};
  for (const [id, chs] of Object.entries(score)) {
    const projects = Object.keys(chs).sort((a, b) => chs[b] - chs[a]).slice(0, 3);
    const l = latest[id];
    people[id] = { projects, lastMsg: l ? { ch: l.ch, text: withNames(l.text, users, channels).slice(0, 400) } : null };
  }
  return { people, channelsRead: targets.length, partial: queue.length > 0 };
}

export default async (req) => {
  const refused = guard(req);
  if (refused) return refused;
  try {
    const data = await cached("activity", 15 * 60 * 1000, compute);
    return json({ ok: true, at: Date.now(), ...data });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: "/api/activity" };
