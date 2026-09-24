// Shared helpers for the Become Studio Floor functions.
// Everything here runs on Netlify's servers; the Slack token never reaches the browser.

export const CHANNELS = {
  attendance: process.env.ATTENDANCE_CHANNEL || "C01HXH115DH", // #_attendance (Brisk jibble in/out)
  leaves: process.env.LEAVES_CHANNEL || "C0AC150KC5P",         // #_leaves (Brisk leave approvals)
  general: process.env.GENERAL_CHANNEL || "CAYDCHHGQ",         // #_general (news, kudos, launches)
};

const IST_OFFSET = 5.5 * 3600 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

// Returns a Response when the request must be refused, otherwise null.
export function guard(req) {
  if (!process.env.SLACK_BOT_TOKEN) return json({ error: "missing_token", message: "SLACK_BOT_TOKEN is not set" }, 500);
  const need = process.env.OFFICE_PASSCODE || "";
  if (!need) return null;
  const got = req.headers.get("x-office-key") || "";
  if (got.length !== need.length) return json({ error: "passcode" }, 401);
  let diff = 0;
  for (let i = 0; i < need.length; i++) diff |= need.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0 ? null : json({ error: "passcode" }, 401);
}

export async function slack(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
    if (r.status === 429) {
      const wait = (Number(r.headers.get("retry-after")) || 1) * 1000;
      if (wait > 4000) break;
      await sleep(wait);
      continue;
    }
    const data = await r.json();
    if (!data.ok) {
      const e = new Error(`${method}: ${data.error}`);
      e.slack = data.error;
      throw e;
    }
    return data;
  }
  const e = new Error(`${method}: rate_limited`);
  e.slack = "rate_limited";
  throw e;
}

// Small in-memory cache (per warm function instance). Keeps the last good value if Slack fails.
const store = new Map();
export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await fn();
    store.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (hit) return hit.value;
    throw e;
  }
}

export async function history(channel, { oldest, limit = 200, pages = 3 } = {}) {
  const out = [];
  let cursor;
  for (let i = 0; i < pages; i++) {
    const d = await slack("conversations.history", { channel, oldest, limit, cursor });
    out.push(...(d.messages || []));
    cursor = d.response_metadata && d.response_metadata.next_cursor;
    if (!d.has_more || !cursor) break;
  }
  return out; // newest first
}

export async function loadUsers() {
  return cached("users", 40 * 1000, async () => {
    const users = {};
    let cursor;
    for (let i = 0; i < 10; i++) {
      const d = await slack("users.list", { limit: 200, cursor });
      for (const u of d.members || []) {
        const p = u.profile || {};
        users[u.id] = {
          name: p.real_name || u.real_name || p.display_name || u.name,
          deleted: !!u.deleted,
          bot: !!u.is_bot,
          statusText: p.status_text || "",
          statusEmoji: p.status_emoji || "",
          statusExpiration: p.status_expiration || 0,
        };
      }
      cursor = d.response_metadata && d.response_metadata.next_cursor;
      if (!cursor) break;
    }
    return users;
  });
}

export async function loadChannels() {
  return cached("channels", 30 * 60 * 1000, async () => {
    const list = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
      const d = await slack("conversations.list", { types: "public_channel", exclude_archived: true, limit: 200, cursor });
      list.push(...(d.channels || []));
      cursor = d.response_metadata && d.response_metadata.next_cursor;
      if (!cursor) break;
    }
    return list;
  });
}

// Pull every piece of text out of a message: plain text, blocks and attachments.
export function messageText(m) {
  const parts = [];
  const add = t => { if (typeof t === "string" && t.trim()) parts.push(t); };
  add(m.text);
  const walk = o => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.type === "rich_text") return; // duplicates m.text
    if (typeof o.text === "string") add(o.text);
    else if (o.text && typeof o.text === "object") walk(o.text);
    for (const k of ["elements", "fields", "blocks"]) if (o[k]) walk(o[k]);
  };
  walk(m.blocks);
  for (const a of m.attachments || []) { add(a.pretext); add(a.text || a.fallback); walk(a.blocks); }
  return [...new Set(parts)].join("\n");
}

// Turn <@U123> and <#C123> into <@U123|Name> and <#C123|name> so the page can show names.
export function withNames(text, users, channels) {
  const chName = {};
  for (const c of channels || []) chName[c.id] = c.name;
  return String(text || "")
    .replace(/<@([UW][A-Z0-9]+)>/g, (m, id) => `<@${id}|${(users[id] && users[id].name) || "someone"}>`)
    .replace(/<#(C[A-Z0-9]+)>/g, (m, id) => (chName[id] ? `<#${id}|${chName[id]}>` : m));
}

export function istMidnightEpoch() {
  const DAY = 86400000;
  return Math.floor((Date.now() + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
}
export function istDate(ts) {
  return new Date(Number(ts) * 1000 + IST_OFFSET).toISOString().slice(0, 10);
}
export function leaveLabelToday() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", month: "short", day: "numeric", year: "numeric" }).format(new Date());
}
export function toMin(s) {
  const m = /(\d+):(\d+)\s*([AP])M/i.exec(s || "");
  if (!m) return null;
  return ((+m[1]) % 12 + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + +m[2];
}

export function errorResponse(e) {
  const code = e && e.slack ? e.slack : "upstream";
  return json({ error: code, message: String((e && e.message) || e) }, code === "not_in_channel" || code === "channel_not_found" ? 409 : 502);
}
