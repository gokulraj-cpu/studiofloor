// GET /api/game-config — realtime settings for the Doodle Arcade (Supabase Realtime).
// SUPABASE_ANON_KEY is Supabase's public client key; it's still only handed out behind the office passcode.
import { guard, json } from "../lib/slack.mjs";

export default async (req) => {
  const refused = guard(req);
  if (refused && refused.status === 401) return refused;
  const url = process.env.SUPABASE_URL || "", key = process.env.SUPABASE_ANON_KEY || "";
  if (!url || !key) return json({ error: "missing_realtime", message: "SUPABASE_URL and SUPABASE_ANON_KEY are not set" }, 503);
  return json({ url, key, channel: process.env.DOODLE_CHANNEL || "studio-doodle" });
};

export const config = { path: "/api/game-config" };
