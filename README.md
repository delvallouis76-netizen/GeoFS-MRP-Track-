# MRP COMMAND BOT — Setup Guide

## FILES IN THIS FOLDER
```
mrp-command-bot.js   ← main bot code
package.json         ← dependencies
railway.toml         ← Railway deployment config
aoboxes.json         ← PUT YOUR aoboxes.json HERE
.env.example         ← copy this to .env for local testing
.gitignore           ← keeps secrets off GitHub
```

---

## STEP 1 — CREATE THE DISCORD BOT

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it `MRP COMMAND`
3. Go to **Bot** tab
   - Click **Add Bot**
   - Click **Reset Token** → COPY IT (save somewhere safe)
   - Enable **Message Content Intent** (scroll down, toggle on)
4. Go to **General Information**
   - Copy your **Application ID**

---

## STEP 2 — INVITE BOT TO YOUR SERVER

1. Go to **OAuth2 → URL Generator**
2. Check these boxes:
   - Scopes: `bot` + `applications.commands`
   - Permissions: `Send Messages` + `Embed Links` + `Read Message History` + `Use Slash Commands`
3. Copy the URL at the bottom
4. Open it in your browser → select your server → Authorize
5. Repeat for any other servers you want it in

---

## STEP 3 — DEPLOY TO RAILWAY (free, runs 24/7)

### 3a. Push files to GitHub
1. Go to https://github.com → create a **New Repository** (private)
2. Name it `mrp-command-bot`
3. Upload these files to it:
   - `mrp-command-bot.js`
   - `package.json`
   - `railway.toml`
   - `aoboxes.json`
   - `.gitignore`
   - DO NOT upload `.env` — keep that secret

### 3b. Deploy on Railway
1. Go to https://railway.app
2. Sign in with GitHub
3. Click **New Project**
4. Click **Deploy from GitHub repo**
5. Select your `mrp-command-bot` repo
6. Railway will detect it automatically

### 3c. Add Environment Variables
1. In Railway dashboard → click your project
2. Click **Variables** tab
3. Add these one by one:

| Variable | Value |
|----------|-------|
| `BOT_TOKEN` | your bot token from Step 1 |
| `BOT_APP_ID` | your application ID from Step 1 |
| `POLL_MS` | `12000` |
| `COOLDOWN_MIN` | `45` |

4. Click **Deploy** — Railway will build and start the bot

### 3d. Confirm it's running
- Click **Deployments** tab
- Click the latest deployment
- Click **View Logs**
- You should see:
```
[MRP] 1600 territory boxes loaded.
[MRP] Online as MRP COMMAND#1234
[MRP] Registering 7 commands...
[MRP] Commands registered.
```

---

## STEP 4 — CONFIGURE IN DISCORD

Run these commands in your server after the bot is online:

```
/config alert_channel   → select the channel for scramble alerts
/config log_channel     → select a quiet log channel (optional)
/config role            → select a role to ping on alerts (optional)
/territory add          → type a country name, pick from autocomplete
/territory add          → repeat for each territory you want monitored
```

Test it:
```
/radar                  → shows live contacts in your airspace
/sitrep                 → full situation report all territories
/ident [callsign]       → full info card on any pilot online
```

---

## COMMANDS REFERENCE

| Command | What it does |
|---------|-------------|
| `/territory add` | Add a country/region to monitor |
| `/territory remove` | Stop monitoring a territory |
| `/territory list` | See all monitored territories |
| `/config alert_channel` | Set where alerts are posted |
| `/config log_channel` | Set quiet log channel |
| `/config role` | Add/remove ping role |
| `/config friendly` | Mark a tag as friendly (won't alert) |
| `/config cooldown` | Set minutes between repeat alerts |
| `/config alerts` | Toggle MRP/Tagged/Unknown alerts on or off |
| `/config view` | See full current config |
| `/ignore add` | Silence a specific callsign forever |
| `/ignore remove` | Un-silence a callsign |
| `/ignore list` | See all ignored callsigns |
| `/radar` | Live snapshot of contacts in your airspace |
| `/radar filter:mrp` | Show MRP contacts only |
| `/ident [callsign]` | Full IDENT card for any pilot |
| `/sitrep` | All territories, all contacts, grouped |
| `/history` | Recently tracked contacts (last 30 min) |

---

## ALERT TYPES

| Icon | Type | Default |
|------|------|---------|
| 🔵 | MRP pilot (known group tag) | ON |
| 🔴 | Tagged pilot (has a tag, not MRP) | ON |
| ⚫ | Unknown/untagged pilot | OFF |
| 🟢 | Friendly (your ally tags) | Never alerts |

Toggle with `/config alerts type:mrp enabled:false` etc.

---

## ALERT BUTTONS

Every scramble alert has 3 buttons:
- **FULL IDENT** — shows complete info card for that contact
- **IGNORE** — adds callsign to ignore list immediately
- **MARK FRIENDLY** — marks their tag as friendly, won't alert again

---

## RUNNING IN MULTIPLE SERVERS

The bot handles this automatically.
Each server has completely separate:
- Territory watchlist
- Alert channel
- Ping roles
- Friendly tags
- Ignore list
- Cooldown settings

Just invite the bot to each server and run `/config` + `/territory add` in each one.

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| Commands not showing | Wait 2-3 min after first deploy, commands register globally |
| No alerts firing | Check `/config view` — make sure alert_channel and territories are set |
| Bot offline in Railway | Check Variables tab — BOT_TOKEN must be correct |
| `aoboxes.json not found` | Make sure you uploaded aoboxes.json to your GitHub repo |
| alerts not showing MRP | Run `/config alerts type:mrp enabled:true` |
| Too many alerts | Increase cooldown with `/config cooldown minutes:120` |

---

## UPDATING THE BOT

To update code after changes:
1. Edit `mrp-command-bot.js` on GitHub (or push from your PC)
2. Railway automatically detects the change and redeploys
3. Takes about 1-2 minutes, zero downtime

---

## DATA STORAGE

The bot stores configs in a `data/` folder:
- `data/GUILDID.json` — per-server config
- `data/.cooldowns.json` — alert cooldown timestamps

On Railway this resets if the container restarts.
For permanent storage on Railway, add a Volume in the Railway dashboard:
- Mount path: `/app/data`
- This keeps configs across restarts/redeploys
