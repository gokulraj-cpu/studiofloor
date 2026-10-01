// GET /api/game-config — realtime settings for the Doodle Arcade (Supabase Realtime).
// SUPABASE_ANON_KEY is Supabase's public client key; it's still only handed out behind the office passcode.
// GET /api/game-config?check=1 also asks Supabase whether the URL and key work, and says what to fix.
import { guard, json } from "../lib/slack.mjs";

const clean = v => String(v || "").trim().replace(/^["']|["']$/g, "").trim();

function keyKind(key){
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (key.startsWith("sb_secret_")) return "secret";
  const parts = key.split(".");
  if (parts.length === 3){
    try { const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); return p.role === "service_role" ? "secret" : p.role === "anon" ? "anon" : "unknown"; }
    catch (_) { return "unknown"; }
  }
  return "unknown";
}

export default async (req) => {
  const refused = guard(req);
  if (refused && refused.status === 401) return refused;
  let url = clean(process.env.SUPABASE_URL).replace(/\/+$/, "").replace(/\/(rest|auth|realtime)\/v1.*$/, "");
  const key = clean(process.env.SUPABASE_ANON_KEY);
  if (!url || !key) return json({ error: "missing_realtime", message: "SUPABASE_URL and SUPABASE_ANON_KEY are not set" }, 503);
  const dash = /supabase\.com\/dashboard\/project\/([a-z0-9]+)/.exec(url);
  if (dash) url = `https://${dash[1]}.supabase.co`;              // someone pasted the dashboard address
  if (/^[a-z0-9]{20}$/.test(url)) url = `https://${url}.supabase.co`;   // just the project ref
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(url)) return json({ error: "bad_url", message: `SUPABASE_URL should look like https://<project>.supabase.co (it is "${url.slice(0, 60)}")` }, 503);
  const kind = keyKind(key);
  if (kind === "secret") return json({ error: "secret_key", message: "SUPABASE_ANON_KEY holds a secret/service_role key. Use the anon or publishable key instead, and rotate the secret key in Supabase since it was exposed to browsers." }, 503);

  const out = { url, key, channel: clean(process.env.DOODLE_CHANNEL) || "studio-doodle", keyKind: kind };
  if (new URL(req.url).searchParams.get("check")){
    try {
      const r = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key, Authorization: kind === "anon" ? `Bearer ${key}` : undefined } });
      out.check = r.ok ? "ok" : (r.status === 401 || r.status === 403) ? "bad_key" : `http_${r.status}`;
      if (!r.ok) out.checkBody = (await r.text()).slice(0, 200);
    } catch (e) { out.check = "unreachable"; out.checkBody = String(e.message || e).slice(0, 200); }
  }
  return json(out);
};

export const config = { path: "/api/game-config" };
