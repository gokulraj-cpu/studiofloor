#!/usr/bin/env python3
"""Build public/index.html for the standalone site from the Claude artifact page.

The artifact reads Slack through Claude's connector; the standalone site reads it
from its own /api functions instead. Run:  python3 build.py
"""
import sys, pathlib

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else str(pathlib.Path(__file__).parent / "source" / "become-studio.html")).read_text(encoding="utf-8")
here = pathlib.Path(__file__).parent

def replace_once(s, a, b):
    assert s.count(a) == 1, f"anchor not found exactly once: {a[:60]!r}"
    return s.replace(a, b)

head = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23161926'/%3E%3Crect x='3' y='5' width='10' height='7' fill='%23ffcf4a'/%3E%3Crect x='5' y='7' width='2' height='2' fill='%23161926'/%3E%3Crect x='9' y='7' width='2' height='2' fill='%23161926'/%3E%3C/svg%3E">
"""
s = src.replace('<meta charset="utf-8">\n', "", 1)
s = head + s
s = replace_once(s, "</style>\n", "  body{margin:0}\n  .banner form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;flex:1 1 100%}\n  .banner input{font:inherit;padding:4px 8px;border:2px solid var(--paper-ink);background:#fff;color:var(--paper-ink);min-width:0;flex:1 1 160px}\n</style>\n</head>\n<body>\n")
s = s.rstrip() + "\n</body>\n</html>\n"

standalone = r'''/* ---------------- Standalone data: this site's own Slack functions ---------------- */
const KEY_STORE = "become-studio-key";
let officeKey = ""; try { officeKey = localStorage.getItem(KEY_STORE) || ""; } catch (_) {}
async function api(path){
  const r = await fetch(path, {headers: officeKey ? {"x-office-key": officeKey} : {}, cache: "no-store"});
  if (r.status === 401){ const e = new Error("passcode"); e.code = "passcode"; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok){ const e = new Error(j.message || j.error || String(r.status)); e.code = j.error || "upstream"; throw e; }
  return j;
}
function askPasscode(wrong){
  pollers.forEach(clearInterval); pollers = [];
  banner.innerHTML = "";
  const f = document.createElement("form");
  const p = document.createElement("p"); p.textContent = wrong ? "That passcode didn't work. Check it and try again." : "Enter the studio passcode to see who's in today.";
  const i = document.createElement("input"); i.type = "password"; i.id = "passcode"; i.autocomplete = "current-password"; i.setAttribute("aria-label", "Studio passcode");
  const b = document.createElement("button"); b.type = "submit"; b.textContent = "Enter";
  f.append(p, i, b);
  f.addEventListener("submit", ev => { ev.preventDefault(); officeKey = i.value.trim(); try { localStorage.setItem(KEY_STORE, officeKey); } catch (_) {} banner.hidden = true; startStandalone(); });
  banner.append(f); banner.hidden = false; setSrc("err", "Locked"); setTimeout(() => i.focus(), 50);
}
let pollers = [];
function setupCopy(code, msg){
  if (code === "missing_token") return "This site isn't connected to Slack yet. Add SLACK_BOT_TOKEN in Netlify → Site configuration → Environment variables, then redeploy.";
  if (code === "not_in_channel" || code === "channel_not_found") return "The Slack app can't read the Brisk channels yet. Invite it to #_attendance, #_leaves and #_general (type /invite @Studio Floor in each).";
  if (code === "invalid_auth" || code === "token_revoked" || code === "not_authed") return "Slack rejected the token. Reinstall the Slack app and update SLACK_BOT_TOKEN in Netlify.";
  if (code === "missing_scope") return "The Slack app is missing a permission. Recreate it from slack-app-manifest.yml and reinstall.";
  return `Couldn't reach Slack just now (${msg}). Showing a sample office; reload to try again.`;
}
async function startStandalone(){
  if (location.protocol === "file:"){ startDemo("This local copy has no server behind it, so it's showing a sample office."); return; }
  let d;
  try { d = await api("/api/office"); }
  catch (e){ if (e.code === "passcode") return askPasscode(!!officeKey); return startDemo(setupCopy(e.code, e.message)); }
  mode = "live"; banner.hidden = true; applyOffice(d, true);
  pollers.forEach(clearInterval);
  pollers = [
    setInterval(() => api("/api/office").then(x => applyOffice(x, false)).catch(onPollError), 30000),
    setInterval(loadFeed, 600000),
    setInterval(loadActivity, 900000),
  ];
  loadFeed(); loadActivity();
}
function onPollError(e){ if (e.code === "passcode") return askPasscode(true); stale = true; updateSrc(); }
function applyOffice(d, first){
  if (mode !== "live") return;
  live.att = d.attendance || {};
  live.leaves = new Set(d.leaves || []);
  live.statuses = {};
  for (const [id, st] of Object.entries(d.statuses || {})) live.statuses[id] = {text: st.text || "", emojiName: st.emojiName || "", emoji: EMOJI[st.emojiName] || ""};
  for (const [id, t] of Object.entries(d.titles || {})) if (byId[id]) byId[id].title = t;
  live.attOk = true; lastUpdate = d.at || Date.now(); stale = false; updateSrc();
  recompute(first);
}
async function loadFeed(){
  try {
    const d = await api("/api/feed");
    generalMsgs = d.messages || []; rebuildSlides();
    const sl = {};
    for (const [id, msgs] of Object.entries(d.lines || {})){ const list = []; for (const m of msgs) for (const l of splitLines(m)) if (list.length < 6 && !list.includes(l)) list.push(l); sl[id] = list; }
    live.selfLines = sl;
    if (!tvEl.hidden) tvCount.textContent = `${tvIdx + 1} / ${tvSlides.length}`;
  } catch (e){ if (e.code === "passcode") askPasscode(true); }
}
async function loadActivity(){
  try {
    const d = await api("/api/activity");
    for (const p of people){
      const a = (d.people || {})[p.id];
      if (!a){ p.projects = []; p.project = ""; p.lastMsg = null; continue; }
      p.projects = a.projects || []; p.project = p.projects[0] ? prettyChannel(p.projects[0]) : "";
      let t = a.lastMsg ? cleanText(a.lastMsg.text) : "";
      if (t.length > 110) t = t.slice(0, 107).trimEnd() + "…";
      p.lastMsg = t ? {ch: a.lastMsg.ch, text: t} : null;
    }
    scheduleList();
  } catch (e){ if (e.code === "passcode") askPasscode(true); }
}

/* ---------------- Clock ---------------- */'''
s = replace_once(s, "/* ---------------- Clock ---------------- */", standalone)
s = replace_once(s, "startLive();\n})();", "startStandalone();\n})();")
s = replace_once(s, "This copy can't reach Slack, so it's showing a sample office. Open it in Claude with the Slack connector to see today's check-ins.", "Showing a sample office.")

out = here / "public" / "index.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(s, encoding="utf-8")
print("wrote", out, len(s), "bytes")
