# Alfred — shared Telegram bot for Claude Code

One bot, your Claude Code subscription, a Telegram group your team is in. It scans your
code directory itself, so adding a new project means cloning it there, nothing else.

## Setup

1. **Create the bot** via @BotFather, get the token.
2. **Add the bot to your team's Telegram group.**
3. On the server:
   ```
   npm install
   cp .env.example .env
   ```
   - `TELEGRAM_BOT_TOKEN` — from BotFather
   - `CODE_DIRS` — one or more base folders, comma-separated (e.g.
     `/home/ubuntu/code,/home/ubuntu/priyanka-code`). Every subfolder with a `.git`
     inside, in any of them, becomes reachable as `/fix <foldername> ...` — nothing
     has to live in any one person's folder for someone else to reach it. If two
     folders have a same-named subfolder, the first one listed wins and the bot
     logs a warning.
   - `ALLOWED_CHAT_IDS` — the group's chat ID (send any message in the group, hit
     `https://api.telegram.org/bot<token>/getUpdates`, read the group's `chat.id`;
     it'll be negative)
   - `OWNER_IDS` — comma-separated Telegram user IDs of everyone with owner-level
     trust (you, and anyone else you trust the same way). DM the bot once from each
     account, check the same URL, read `from.id`
4. **Handle exceptions in `repos.json`** — only needed for the odd case:
   ```json
   {
     "acme-freelance": { "ownerOnly": true },
     "scratch-repo": false,
     "other-project": { "path": "/some/path/outside/CODE_DIRS" }
   }
   ```
   Everything else across every folder in `CODE_DIRS` is open to the whole group
   automatically.
5. **Log in as yourself, once:** `claude` → `/login` on the server, and `gh auth login`.
   This is what keeps everything on your subscription, even with more than one person
   at owner level — there's only ever this one login on the server, so nobody else's
   account gets pulled in no matter how many people you trust as owners.
6. **Run it, keep it running:**
   ```
   pm2 start bot.js --name alfred
   pm2 save && pm2 startup
   ```

## Getting these files onto the server without hand-typing them

Easiest one-time move: download the zip below, then from your own machine:

```
scp alfred-bot.zip youruser@yourserver:~/
ssh youruser@yourserver
unzip alfred-bot.zip -d alfred-bot && cd alfred-bot
```

Then `npm install`, fill in `.env`, and run it as in Setup above.

For anything after this first deploy — you'll want to tweak the prompt template, add
a command, whatever — the normal move is a git repo: push this folder to a private
GitHub repo once, then on the server it's just `git clone`, and future changes are
`git pull`. Tell me if you want me to walk through that instead of repeating scp each
time.

## What teammates can and can't do

- Anyone in the allowed group can run `/fix <repo> <description>` on any repo
  `CODE_DIR` turns up that isn't `ownerOnly`, and `/repos` to see what's available.
- They never touch your Claude Code login, an API key, or the server directly.
- Owner-only repos are invisible to them in `/repos` and refuse their `/fix` outright.
- Every PR and commit says who asked for it.
- Nothing lands on `main` without a PR, regardless of who triggered it.

## Notes

- `MAX_TURNS` / `MAX_BUDGET_USD` cap each request, shared across the whole team, not
  per-person.
- Jobs run one at a time across everyone, so a burst of requests queues rather than
  racing on the same git checkout.
- Cloning a new project into `CODE_DIR` is the entire "onboarding" step for a new repo
  — no config file to remember to edit unless it needs an exception.
