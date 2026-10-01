# Solworld X bot

Runs every 15 minutes on GitHub Actions (free) and posts to your X account:

- **Live activity:** every building claimed, sold, or city taken over on Solworld, read straight from the Solana ledger, with the place name and a link to that building. Busy hours become one roundup post.
- **Scheduled posts:** the next post from `bot/queue.md` (text plus optional image) every 3 hours. Edit that file to change them.
- **Mention replies (optional):** a short reply to people who @mention you, once per conversation, up to 5 a run.

It never replies under, likes, or follows accounts that haven't engaged with you. X suspends accounts that automate that.

## Setup (about 10 minutes)

1. **Get X API keys.** Go to https://developer.x.com and sign in with your Solworld account. Open the Developer Portal and create a Project and an App.
   - In the app's **User authentication settings**, set App permissions to **Read and write**. Use Web App as the type, and any URL (your site) for the callback and website.
   - Under **Keys and tokens**, copy the **API Key and Secret**. Generate the **Access Token and Secret** after setting Read and write; otherwise they're read-only.
2. **Add them to GitHub.** In this repo, go to **Settings → Secrets and variables → Actions**.
   - **Secrets:** `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`. Optionally add `SOLANA_RPC`, a Helius or other RPC URL; it's more reliable than the public one.
   - **Variables:** `SITE_URL` (e.g. `https://yoursite.netlify.app`). Optionally set `POST_EVERY_HOURS` (default 3) and `REPLY_TO_MENTIONS=1`.
3. **Run it once.** Go to **Actions → Solworld X bot → Run workflow**. The first run only records past activity, so it won't spam your history. After that it runs by itself.

Scheduled workflows only run from the repo's **default branch**, so merge this branch first.

## Limits

- The X free API tier allows only a small number of posts a month, so the bot caps itself at 16 posts a day (`MAX_POSTS_PER_DAY`).
- Mention replies need an API plan that can read mentions; the free tier can't.
- Run locally to preview without posting: `SITE_URL=https://yoursite node bot/bot.mjs` (with no keys set, it's a dry run).
