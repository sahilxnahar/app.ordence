> ⚠️ **A LIVE DATABASE PASSWORD USED TO BE PRINTED IN THIS FILE.**
>
> It was redacted on 4 August 2026, when this project moved to Railway and
> the code went into a Git repository for the first time. A tarball on one
> laptop and a Git history are not the same exposure: a commit is permanent,
> it is copied to every clone, and removing it later does not remove it from
> anybody who already pulled.
>
> **That Neon password must be rotated.** Redacting the file does not
> un-share a credential that has been sitting in it.

# Putting Ordence online — free, and without ever opening a Terminal

**Everything below happens in a web browser and one ordinary app you
click through. No commands, no black screen.**

---

## First, the honest bit about "free"

You asked for free. Here is the real picture, in one paragraph, so you
are not surprised later.

**Everything except Cloudflare itself is genuinely free** — the database,
the login system, the code hosting. All of it, permanently, at your size.

**Cloudflare's free plan gives each page 10 milliseconds of thinking
time.** A CRM page — checking who you are, loading your leads, drawing
the table — typically needs 10 to 20. So some pages will work and some
will show an error.

**My advice: try free anyway.** It costs nothing to find out, the setup
is identical either way, and if pages start failing, upgrading is one
click on the same screen you are already looking at. You will know within
an hour.

**If it fails, the error looks like this** — so you recognise it and do
not think the CRM is broken:

> **Error 1102** — Worker exceeded CPU time limit

That one message means "upgrade to the $5 plan", nothing more. Your data
is fine, your setup is fine.

---

## What you will sign up for

All free. All in the browser.

| | What it does | Cost |
|---|---|---|
| **GitHub** | Holds your code | Free |
| **Neon** | The database | Free |
| **Clerk** | Handles logins | Free (10,000 users) |
| **Cloudflare** | Runs the website | Free to try, $5/mo if you need it |

**Set aside about an hour.** Do it in one sitting if you can — the steps
hand values to each other.

> 📋 **Open a blank note on your computer now.** You will copy five or six
> long passwords along the way and you will need them again. Paste each
> one into the note as you go, with a label.

---

# Part 1 — Put the code on GitHub

Cloudflare builds your website from code stored on GitHub. So it goes
there first.

### 1.1 Create a GitHub account

Go to <https://github.com/signup> and sign up. Free.

### 1.2 Install GitHub Desktop

This is the app that replaces the Terminal. It has buttons.

Download from <https://desktop.github.com> and install it like any other
app. Open it and sign in with the GitHub account you just made.

### 1.3 Find the code

**Already done for you.** Open your **SAAS CRM** folder and you will see
a folder called **`ordence`**. That is the code, already unzipped and
ready.

*(The zip file is still there too if you ever need a fresh copy —
`ordence-cloudflare-deploy.tar.gz`. You do not need it now.)*

⚠️ **Ignore the older `ameya` and `v0.25.0-alpha` folders** next to it.
Those are earlier versions from before the rename.

### 1.4 Publish it

In GitHub Desktop:

1. Menu: **File → Add Local Repository**
2. Click **Choose…** and select your `ordence` folder
3. It will say *"this directory does not appear to be a Git repository"* —
   click the blue **create a repository** link in that message
4. Leave everything as-is, click **Create Repository**
5. At the top you will see **Publish repository** — click it
6. ⚠️ **Tick the box that says "Keep this code private."** Your code
   should not be public.
7. Click **Publish Repository**

> ✅ **You know it worked when** GitHub Desktop's top bar changes to
> "Fetch origin" and <https://github.com> shows a repository called
> `ordence`.

---

# Part 2 — The database

### 2.1 Create it

1. Go to <https://neon.tech> → **Sign up** (use your GitHub account, it is
   quicker)
2. Create a project. Name it **ordence**
3. **Region: choose Singapore** (`ap-southeast-1`) — closest to India of
   the free options
4. Click **Create project**

### 2.2 Copy the connection string

Neon shows you a **Connection string** box. Click the copy icon.

It looks like this:

```
postgresql://<USER>:<PASSWORD>@<HOST>/<DB>?sslmode=require
```

📋 **Paste it into your note. Label it `DATABASE_URL`.**

> ⚠️ That is a password. Do not put it in an email or a WhatsApp message.

### 2.3 Build the tables — 🛑 the important step

Neon has a SQL editor built into the website, so you do not need any
tools for this.

In the left sidebar of Neon, click **SQL Editor**.

Open your `ordence` folder → **SQL-FILES** → **RUN-THESE-IN-ORDER**.

I have already put the files you need in that folder, renamed and
numbered so the order is unmistakable:

```
01-run-me-first.sql   ← start here (big one, ~30 seconds)
02.sql
03.sql
   ... and so on ...
12-run-me-last.sql    ← finish here
```

⚠️ **The folder ABOVE that one has 26 files with confusing names.
Ignore it.** Most of those are already inside `01-run-me-first.sql`.
The `RUN-THESE-IN-ORDER` folder has the twelve you actually need, in the
order you need them.

For each file, in number order:

1. Open it in **TextEdit** (Mac) or **Notepad** (Windows)
2. Select all (`Cmd+A` or `Ctrl+A`), copy
3. Paste into Neon's SQL Editor
4. Click **Run**
5. Clear the box, open the next file, repeat

> ✅ **After each one**, the results panel fills with rows. Scroll
> through and look for the word **PASS**. You will see a lot of them.
>
> 🛑 **If you see the word FAIL anywhere, stop and send me a screenshot.**
> Do not carry on to the next file.

### Why this step matters more than any other

These files are what stop one customer seeing another customer's data.

**If you skip them, the CRM still works perfectly.** Every page loads.
Nothing shows an error. The only difference is that every customer can
read every other customer's leads, bookings and finances — and nothing
anywhere tells you.

That is why it is twelve copy-pastes rather than something I could hide.

---

# Part 3 — Logins

### 3.1 Create a Clerk application

1. Go to <https://clerk.com> → **Sign up**
2. Click **Create application**
3. Name it **Ordence**
4. Turn on **Email** and **Google**
5. Click **Create application**

### 3.2 ⚠️ Turn on Organizations

In the left sidebar, click **Organizations**, then **Enable
Organizations**.

**This is not optional.** Ordence gives each customer company its own
workspace, and that is what an Organization is. Without this, nobody can
log in properly.

### 3.3 Copy the two keys

Left sidebar → **API Keys**. Copy both:

- One starting `pk_test_...`
- One starting `sk_test_...`

📋 **Paste both into your note**, labelled `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
and `CLERK_SECRET_KEY`.

---

# Part 4 — Put it online

### 4.1 Cloudflare account

Go to <https://dash.cloudflare.com/sign-up> and sign up. **Do not pay for
anything yet.**

### 4.2 Connect your code

1. Left sidebar → **Workers & Pages**
2. Click **Create application**
3. Choose the **Import a repository** tab
4. Click **Connect GitHub** and authorise it
5. Choose your **ordence** repository
6. Click **Begin setup**

### 4.3 Settings

Cloudflare will guess most of this. Check these three:

| Field | What to put |
|---|---|
| Project name | `ordence` |
| Build command | `npm run deploy` |
| Deploy command | *leave blank* |

### 4.4 Add your secrets

Before you finish, find **Environment variables** (you may need to click
*Add variable* or expand a section).

Add each of these. For the ones marked 🔒, click the **Encrypt** button
next to it.

| Name | Value | |
|---|---|---|
| `DATABASE_URL` | the Neon string from your note | 🔒 |
| `DATABASE_URL_UNPOOLED` | the same Neon string again | 🔒 |
| `CLERK_SECRET_KEY` | the `sk_test_...` key | 🔒 |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | the `pk_test_...` key | |
| `PLATFORM_ADMIN_EMAILS` | your own email address | |

*(That last one makes you the administrator.)*

### 4.5 Deploy

Click **Save and Deploy**.

**This takes 5–10 minutes the first time.** You will see a log scrolling
past. That is normal — it is building the whole application.

> ✅ **You know it worked when** the log ends with a green **Success** and
> gives you a web address like `ordence-abc.workers.dev`.
>
> **Click it. That is your CRM.**

---

# Part 5 — Your own address

### 5.1 Point ordence.com at Cloudflare

1. Cloudflare dashboard → **Add a site** → type `ordence.com`
2. Choose the **Free** plan
3. Cloudflare shows you two **nameservers** — something like
   `alice.ns.cloudflare.com`
4. Go to wherever you bought ordence.com (GoDaddy, Namecheap, BigRock…),
   find **Nameservers**, and replace what is there with Cloudflare's two

> ⏱️ This can take anywhere from 10 minutes to a few hours. Cloudflare
> emails you when it is done.

### 5.2 Create the subdomain

Once ordence.com shows **Active**:

1. **Workers & Pages → ordence → Settings → Domains & Routes**
2. Click **Add → Custom domain**
3. Type: **`app.ordence.com`**
4. Click **Add domain**

Cloudflare sets up the DNS and the security certificate for you.

### 5.3 Tell the app its own address

Back in **Settings → Variables and Secrets**, add two more:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://app.ordence.com` |
| `NEXT_PUBLIC_ROOT_DOMAIN` | `app.ordence.com` |

Then go to **Deployments** and click **Retry deployment** so it picks
them up.

> ✅ **Done when** <https://app.ordence.com> loads Ordence with a padlock
> in the address bar.

---

# When something goes wrong

**"Error 1102 — Worker exceeded CPU time limit"**

This is the free-plan limit, exactly as warned at the top. Nothing is
broken. Fix: **Workers & Pages → Plans → Workers Paid** ($5/month). Then
reload the page.

**The build failed with a red X**

Click into the build log and scroll to the first line in red. Send me
that line. Do not re-run it hoping for a different result — it will fail
the same way.

**A page says "Something went wrong"**

A secret is missing or has a typo. Go to **Settings → Variables and
Secrets** and check all five are there, spelled exactly as in the table.
The most common cause is a space accidentally copied onto the end of the
Neon string.

**I cannot log in**

Almost always Organizations is off in Clerk. Go back to step 3.2.

---

# What you are looking at once it loads

The parts that are built and working:

- **Sales** — leads pipeline, inventory, bookings, channel partners
- **Automations** — the workflow builder
- **Record types** — create your own kinds of records
- **Settings** — team, billing, recycle bin
- **Admin console** at `/platform` — your view across all customers

Built underneath but with no screens yet: GST, purchases, GSTR-2B
reconciliation, TDS, Tally export, demand notices. Those are the next
thing I would put a face on.

Not configured yet: sending email, taking payments.

---

# What this actually costs you

| | Per month |
|---|---|
| GitHub | ₹0 |
| Neon database | ₹0 |
| Clerk logins | ₹0 |
| Cloudflare | ₹0 to try · ~₹420 ($5) if you hit the limit |
| **Total** | **₹0 to find out** |

Even at the paid tier, file downloads cost nothing extra — Cloudflare
does not charge for bandwidth out of R2. That is the part that would have
cost real money elsewhere.
