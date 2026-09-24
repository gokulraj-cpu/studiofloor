# Become Studio Floor — standalone site

A live pixel office for Become. It reads Brisk check-ins, leave, Slack statuses, project
channels and #_general from Slack through its own server functions, so it works in any
browser (and on the office TV) without Claude.

```
public/index.html            the office page
netlify/functions/office.mjs /api/office   → Brisk check-ins (#_attendance), today's leave (#_leaves), Slack statuses
netlify/functions/feed.mjs   /api/feed     → #_general posts for the Studio TV
netlify/functions/activity.mjs /api/activity → what people are working on (public project channels, last 7 days)
netlify/lib/slack.mjs        shared Slack + passcode helpers
slack-app-manifest.yml       creates the Slack app in one paste
source/become-studio.html    the Claude artifact version of the page
build.py                     rebuilds public/index.html from it: python3 build.py
```

## 1. Create the Slack app (about 3 minutes)

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**.
2. Pick the Become workspace, paste the contents of `slack-app-manifest.yml`, and create it.
3. **Install to Workspace** and approve. A workspace admin may need to approve it.
4. Open **OAuth & Permissions** and copy the **Bot User OAuth Token** (starts with `xoxb-`).
5. In Slack, invite the app to the three channels it reads:
   `/invite @Studio Floor` in **#_attendance**, **#_leaves** and **#_general**.
6. For the project bubbles, also invite it to the project channels you want counted
   (for example #madeit, #galent, #sgi-collective). See "Project bubbles" below for the
   automatic option.

## 2. Deploy on Netlify

1. Put this folder in a Git repo (GitHub works well) and choose **Add new site → Import an existing project**
   in Netlify. Drag-and-drop deploys don't include the server functions, so use Git or the CLI below.
   Build command: leave empty. Publish directory: `public`. Functions: `netlify/functions`
   (both are already set in `netlify.toml`).
2. In **Site configuration → Environment variables**, add:

   | Variable | Value |
   |---|---|
   | `SLACK_BOT_TOKEN` | the `xoxb-…` token from step 1 |
   | `OFFICE_PASSCODE` | a passcode the team will type once per browser |

   Optional: `ATTENDANCE_CHANNEL`, `LEAVES_CHANNEL`, `GENERAL_CHANNEL` (channel IDs, already set
   to Become's), and `ACTIVITY_AUTO_JOIN=true` (see below).
3. **Deploys → Trigger deploy**. Environment variables only apply after a new deploy.
4. Optional: **Domain management → Add a domain**, e.g. `office.become.team`.

With the CLI instead: `npm i -g netlify-cli`, then `netlify login`, `netlify init`,
`netlify env:set SLACK_BOT_TOKEN xoxb-…`, `netlify env:set OFFICE_PASSCODE …`, `netlify deploy --prod`.

## 3. Open it

Visit the site, enter the passcode once (it's remembered in that browser), and the office fills in.
For the office TV: open the site on the TV's browser, tap the Studio TV, then **Full screen**.

## How the data is used

- **Refresh rates:** check-ins and statuses about every 30 seconds, #_general every 10 minutes, project activity every 15 minutes.
  Results are cached on the server, so many open screens don't multiply Slack calls.
- **Leave:** the page only ever shows "On leave". The leave type from Brisk is never sent to the browser.
- **Project bubbles:** only public channels are read, and only channels the app has been added to.
  Set `ACTIVITY_AUTO_JOIN=true` to let the app join every public channel on its own; Slack will post
  a one-time "Studio Floor joined" line in each channel it joins.
- **Private data:** the app can't see DMs or private channels unless it's invited to them.
  `groups:history` is only there in case #_attendance or #_leaves is a private channel.

## Privacy note on the passcode

The passcode keeps casual visitors out. It's shared by everyone, so change `OFFICE_PASSCODE`
(and redeploy) when someone leaves. For per-person sign-in, put the site behind Netlify's
site-wide password or an identity provider later.

## Changing the roster or desks

The team list and desk order live at the top of the script in `public/index.html` (`const ROSTER = [...]`).
Each row is `[Slack user ID, display name, role]`; desks are assigned in that order.

## If something's wrong

The page says what's missing in a note at the top-left:
- "isn't connected to Slack yet" → `SLACK_BOT_TOKEN` is missing, or you didn't redeploy after adding it.
- "can't read the Brisk channels" → invite the app to #_attendance, #_leaves and #_general.
- "Slack rejected the token" → reinstall the app and update the token.
