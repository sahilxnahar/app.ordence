# Moving everything to Railway — step by step

## First, what you actually have right now

I looked at your Railway account. There are **three** projects:

| Project | Service | Domain | State |
|---|---|---|---|
| `Ordence.com-Railway` | Ordence-Railway | **ordence.com** and **www.ordence.com** | ✅ Working. This is your marketing website. |
| `app.ordence` | app.ordence | *(none)* | ⚠️ **Empty.** No settings, no domain. This is meant to be the CRM. |
| `ordence-cloudflare` | ordence | *(none)* | Leftover. Ignore for now. |

**The finding:** `app.ordence` has **zero** application settings. No database
address, no sign-in keys, nothing. That is why it has no web address and why
nothing you push there comes up. It was created and then never set up.

So "move everything to Railway" is really one job: **finish setting up
`app.ordence`.** The website half is already done and working.

---

## PART 1 — Point the service at your code (5 min)

**Step 1.** Go to <https://railway.com> and sign in.

**Step 2.** Click the project **`app.ordence`**.

**Step 3.** Click the service box, also called **`app.ordence`**.

**Step 4.** Click the **Settings** tab.

**Step 5.** Find **Source**. It should say your GitHub repository `app.ordence`
and branch `main`.

- If it does → good, skip to Part 2.
- If it is empty → click **Connect Repo**, choose your `app.ordence`
  repository, and pick branch `main`.

**Step 6.** Still in Settings, find **Build**. Make sure the builder is
**Railpack** or **Nixpacks**. Leave everything else alone.

---

## PART 2 — Add the settings (15 min, and this is the important part)

**Step 1.** Click the **Variables** tab.

**Step 2.** Click **Raw Editor** (top right of that panel). This lets you paste
everything at once instead of typing 20 boxes.

**Step 3.** Paste the block from the file **`RAILWAY-VARIABLES-PASTE.txt`** I
sent alongside this.

**Step 4.** Fill in the values marked `PASTE_HERE`. There are only three you
absolutely cannot skip:

| Setting | Where to get it |
|---|---|
| `DATABASE_URL` | Neon → your project → **Connect** button → copy the connection string |
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys → Secret key |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys → Publishable key |

Everything else can stay blank for now — the app starts without them and the
matching feature is simply switched off until you fill it in.

**Step 5.** Click **Update Variables**.

> ⚠️ **Never put these in a file you push to GitHub.** Railway's Variables tab
> is the only place they belong. Anything typed into a file gets committed, and
> a committed secret has to be treated as burned.

---

## PART 3 — Give it a web address (3 min)

**Step 1.** Settings tab → find **Networking** → **Public Networking**.

**Step 2.** Click **Generate Domain**. Railway gives you something like
`app-ordence-production.up.railway.app`. Use this to test before you touch
your real domain.

**Step 3.** When the test address works, come back here and click
**Custom Domain**. Type `app.ordence.com`.

**Step 4.** Railway shows you a **CNAME** record. Go to Cloudflare → DNS for
`ordence.com` → **Add record**:

- Type: **CNAME**
- Name: **app**
- Target: *(the value Railway showed you)*
- Proxy status: **DNS only** (grey cloud, not orange)

> The grey cloud matters. With the orange cloud on, Cloudflare and Railway both
> try to terminate the certificate and the site answers with an SSL error that
> looks like a Railway fault and isn't.

**Step 5.** Wait 5 minutes. Railway will show a green tick next to the domain.

---

## PART 4 — Deploy (5 min)

**Step 1.** In GitHub Desktop, push your code (the normal 4 steps you already
do).

**Step 2.** Railway sees the push and starts building on its own. Watch the
**Deployments** tab.

**Step 3.** A build takes about 4 minutes. Wait for **Success**.

**Step 4.** Open `https://app.ordence.com/api/health` in your browser.

You should get a short piece of text saying it is healthy. That is the whole
test.

---

## PART 5 — From now on, this is your entire routine

1. Open the zip I send you.
2. GitHub Desktop → **Repository → Show in Finder**.
3. Delete everything in that folder **except** the hidden `.git` folder.
4. Copy everything from the zip into that folder.
5. GitHub Desktop → type a summary → **Commit to main** → **Push origin**.
6. Wait 5 minutes. Check `/api/health`.

No terminal. Ever.

---

## Cleaning up the Cloudflare leftovers

Once `app.ordence.com` is live and you have used it for a few days:

**Step 1.** Railway → delete the project **`ordence-cloudflare`**. It does
nothing.

**Step 2.** Cloudflare dashboard → Workers → the `app-ordence` Worker → delete
it. **Only after** the Railway version has been working for a few days.

**Step 3.** Keep your Cloudflare account. You still need it for two things:
DNS for `ordence.com`, and the R2 buckets where uploaded documents live.
Railway does not replace either.

> ⚠️ Do not delete the Cloudflare Worker on the same day you switch. If
> something is wrong you want the old one still sitting there.

---

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Build fails immediately | Railway cannot see the repo | Part 1, Step 5 |
| Build succeeds, page shows an error | A required setting is missing | Part 2, Step 4 |
| "Application failed to respond" | The app crashed on startup — nearly always `DATABASE_URL` | Deployments tab → click the deploy → read the log → send me the red lines |
| SSL error on app.ordence.com | Cloudflare proxy is on | Part 3, Step 4 — set it to grey cloud |

Send me a screenshot of the Deployments log and I will tell you which line
matters. Do not start changing settings at random — that turns one known
problem into two unknown ones.
