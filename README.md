# Yonatan Maimon Stats

Two screens:
- `public/index.html` — main screen, pulls live data (goals, cards, games, roster) from the Israel Football Association site (football.org.il) for the configured player.
- `public/yonatan-maimon-weekly.html` — weekly upload screen (CSV / stat-image / manual entry), with a management table to view, edit, and delete individual uploads.

Data (weekly stats + uploaded images) is stored in **Supabase** (free tier), not on disk — so it survives restarts/redeploys.

---

## 1. Create the Supabase project (free)

1. Go to https://supabase.com, sign up, and create a new project (pick any name/region, set a database password — you won't need it directly).
2. Once the project is ready, open **SQL Editor** → **New query**, paste the contents of `supabase_schema.sql` (in this folder), and click **Run**. This creates the `weekly_entries` table.
3. Go to **Storage** → **New bucket**. Name it exactly `weekly-images`, and toggle **Public bucket** ON. Click Create.
4. Go to **Project Settings** → **API**. Copy two values:
   - **Project URL** → this is `SUPABASE_URL`
   - **service_role key** (not the `anon` key — the service role key, under "Project API keys") → this is `SUPABASE_SERVICE_KEY`

   ⚠️ The service role key bypasses row-level security and should never be exposed to the browser. It's only used server-side here, which is correct — just don't commit it to a public repo.

## 2. Run it locally (optional, to test before deploying)

```bash
cp .env.example .env
# edit .env and paste in your SUPABASE_URL and SUPABASE_SERVICE_KEY
npm install
npm start
```

Then open http://localhost:3000/index.html and http://localhost:3000/yonatan-maimon-weekly.html.

## 3. Deploy to Render

1. Push this folder to a GitHub repo (or use Render's "deploy from a public Git repo" / manual upload options).
2. On https://dashboard.render.com, click **New** → **Web Service**, connect the repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Under **Environment**, add:
   - `SUPABASE_URL` = (from step 1)
   - `SUPABASE_SERVICE_KEY` = (from step 1)
   - `PLAYER_ID` = `218770` (optional, this is already the default)
5. Deploy. Once live, the two screens are at `/index.html` and `/yonatan-maimon-weekly.html`.

No persistent disk needed — Supabase holds all the data now, so Render's free tier (with its normal restarts/spin-downs) is fine.

## Notes on the federation scraper

The main screen scrapes `football.org.il` server-side (`lib/scrape.js`) — no API key needed since it's a public page, but the site's markup isn't officially documented, so selectors are matched by heading text (e.g. "שערים", "כרטיסים") rather than brittle CSS classes, to be more resilient to markup tweaks. If, after deploying, some section (goals / cards / games / roster) doesn't show up correctly, check the response from `/api/player-info?player_id=218770` — it includes a `_debug` field showing what the scraper found, which makes it fast to pinpoint what needs adjusting.

## What changed from the original null-error bug

The original CSV upload broke because of an unhandled case in the (missing/unseen) backend. The new `lib/csvParse.js`:
- Never throws — always returns `{ ok: true, stats }` or `{ ok: false, error }` with a specific, human-readable Hebrew message.
- Matches column headers by keyword pattern instead of exact text, so it tolerates header variations.
- Matches the player row by "Maimon" or "מימון" case-insensitively.
- Reports exactly what went wrong (empty file, no Player column, no Maimon row, missing Total Distance) instead of failing silently.
