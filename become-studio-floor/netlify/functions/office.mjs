// GET /api/office — today's Brisk check-ins, today's leave, and everyone's Slack status.
import { CHANNELS, guard, json, cached, history, loadUsers, messageText, istMidnightEpoch, leaveLabelToday, toMin, errorResponse } from "../lib/slack.mjs";

const JIBBLE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>\s*has jibbled (in|out) at (\d{1,2}:\d{2}\s?[AP]M)/gi;
const LEAVE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>\s*is on \*?[^*\n]+?\*? for ([A-Z][a-z]{2} \d{1,2}, \d{4})/g;

export default async (req) => {
  const refused = guard(req);
  if (refused) return refused;
  try {
    const dayStart = istMidnightEpoch();
    const [attMsgs, leaveMsgs, users] = await Promise.all([
      cached(`att:${dayStart}`, 20 * 1000, () => history(CHANNELS.attendance, { oldest: dayStart / 1000, limit: 200 })),
      cached("leaves", 5 * 60 * 1000, () => history(CHANNELS.leaves, { limit: 100, pages: 1 })),
      loadUsers(),
    ]);

    // Check-ins: oldest first, so the last event decides whether someone is in.
    const events = [];
    for (const m of attMsgs) {
      const text = messageText(m);
      for (const x of text.matchAll(JIBBLE)) events.push({ id: x[1], dir: x[2].toLowerCase(), time: x[3].replace(/^0/, "").toUpperCase(), ts: Number(m.ts) });
    }
    events.sort((a, b) => a.ts - b.ts);
    const attendance = {};
    for (const e of events) {
      const s = attendance[e.id] || (attendance[e.id] = { first: null, in: false, outAt: null, events: [] });
      s.events.push({ dir: e.dir, min: toMin(e.time), time: e.time });
      if (e.dir === "in") { if (!s.first) s.first = e.time; s.in = true; }
      else { s.in = false; s.outAt = e.time; }
    }

    // Leave approved for today. The leave type is never sent to the page.
    const today = leaveLabelToday();
    const leaves = new Set();
    for (const m of leaveMsgs) for (const x of messageText(m).matchAll(LEAVE)) if (x[2] === today) leaves.add(x[1]);

    // Slack statuses (expired ones are ignored).
    const nowSec = Date.now() / 1000;
    const statuses = {};
    for (const [id, u] of Object.entries(users)) {
      if (u.deleted || u.bot) continue;
      if (u.statusExpiration && u.statusExpiration < nowSec) continue;
      if (!u.statusText && !u.statusEmoji) continue;
      statuses[id] = { text: u.statusText, emojiName: u.statusEmoji.replace(/^:|:$/g, "") };
    }

    const titles = {};
    for (const [id, u] of Object.entries(users)) if (!u.deleted && !u.bot && u.title) titles[id] = u.title;
    return json({ ok: true, at: Date.now(), attendance, leaves: [...leaves], statuses, titles });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: "/api/office" };
