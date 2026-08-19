# Phase 2 Deployment & Testing — v0.2.0-alpha

Follow these in order. Roughly 30–40 minutes.

**Legend:** 💻 = Terminal · 🌐 = browser

---

## Step 1 — Install the new packages

💻
```bash
cd ~/Downloads/"SAAS CRM"/ameya-heights-os
npm install
```

Phase 2 adds `svix` (webhook verification), `@tanstack/react-table` (data grid),
`@tanstack/react-query`, and several Radix UI primitives.

---

## Step 2 — Create the new database tables

💻
```bash
npx drizzle-kit generate
```

Writes SQL migration files into `db/migrations/`. Review what it produced:

💻
```bash
ls db/migrations/
```

Then apply them:

💻
```bash
npx drizzle-kit push
```

If it asks to confirm creating tables, choose **Yes**.
This creates six new tables: `companies`, `contacts`, `deals`,
`custom_object_definitions`, `custom_field_definitions`, `custom_object_records`.

---

## Step 3 — 🔒 Turn on isolation for the new tables (DO NOT SKIP)

> **New tables are created with Row-Level Security switched OFF.** Postgres does
> not inherit it. Until you run this, the six new tables — including the one that
> holds every tenant's custom business data — are protected only by application
> code. This is the single most important step in Phase 2.

1. 💻 Print the migration:
   ```bash
   cat db/migrations/0002_phase2_rls.sql
   ```
2. Copy **all** of the output
3. 🌐 Neon dashboard → **SQL Editor** → paste → **Run**

### Verify it worked

Paste this into the SQL Editor and Run:

```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname='public'
  AND tablename IN ('tenants','users','roles','role_permissions','user_roles',
                    'audit_logs','companies','contacts','deals',
                    'custom_object_definitions','custom_field_definitions',
                    'custom_object_records')
ORDER BY tablename;
```

**You must see 12 rows, every one showing `true`.** If any shows `false`, the
script didn't finish — run it again.

---

## Step 4 — Set up the Clerk webhook

This is what makes workspaces provision automatically. Without it, the dashboard
stays stuck on "Finishing setup…".

### 4a. Install the Clerk CLI and start a tunnel

Your local machine isn't reachable from the internet, so Clerk can't call it
directly. The CLI opens a temporary tunnel.

💻 (in a **new** Terminal tab — leave your dev server running)
```bash
npm install -g @clerk/cli
clerk login
```

A browser opens — approve access. Then:

💻
```bash
clerk webhooks listen --forward-to http://localhost:3000/api/webhooks/clerk
```

It prints something like:
```
Webhook signing secret: whsec_AbC123XyZ...
Listening for events...
```

**Copy that `whsec_…` value.**

> **No Clerk CLI available?** Use ngrok instead:
> `brew install ngrok && ngrok http 3000`, then in the Clerk dashboard go to
> **Webhooks → Add Endpoint**, paste `https://<your-ngrok-url>/api/webhooks/clerk`,
> subscribe to the four organization events, and copy the Signing Secret from there.

### 4b. Add the secret to your environment

💻
```bash
open -e .env.local
```

Set this line, save, and close:
```bash
CLERK_WEBHOOK_SIGNING_SECRET="whsec_AbC123XyZ..."
```

### 4c. Restart the dev server

Environment variables are read at startup — the new secret won't be picked up
otherwise.

💻 (in your dev server tab: `Ctrl + C`, then)
```bash
npm run dev
```

---

## Step 5 — Test the webhook end to end

1. 🌐 Go to **http://localhost:3000**
2. Sign in
3. Create a **new organization** (use the organization switcher in the header)

Watch the tunnel Terminal tab — you should see:
```
organization.created  →  200
organizationMembership.created  →  200
```

Now confirm the database actually changed. 🌐 In Neon's SQL Editor:

```sql
SELECT name, slug, plan_tier, status, seat_limit, trial_ends_at
FROM tenants ORDER BY created_at DESC LIMIT 5;
```

Your new organization should appear with `plan_tier = 'trial'`, `status = 'active'`,
`seat_limit = 5`, and a trial ending 14 days out.

4. 🌐 Reload **http://localhost:3000/dashboard**

The "Finishing setup…" message should be **gone**, replaced by your real workspace
name, plan, and seat count.

5. 🌐 Visit **http://localhost:3000/contacts** — the data grid renders (empty for now).

### Confirm spoofing is actually blocked

💻
```bash
curl -i -X POST http://localhost:3000/api/webhooks/clerk \
  -H "Content-Type: application/json" \
  -H "svix-id: fake" -H "svix-timestamp: 1234567890" -H "svix-signature: v1,fake" \
  -d '{"type":"organization.created","data":{"id":"org_evil","name":"Attacker"}}'
```

**Expected: `HTTP/1.1 401 Unauthorized`** and `{"error":"Invalid signature."}`.

Then verify nothing was written:
```sql
SELECT count(*) FROM tenants WHERE clerk_org_id = 'org_evil';  -- must be 0
```

If that returns 0 and you got a 401, signature verification is doing its job.

---

## Step 6 — Ship it

💻
```bash
git add .
git commit -m "feat: v0.2.0-alpha — Clerk sync, CRM entities, custom object engine, data grid"
git push
```

Vercel redeploys automatically (~2 minutes).

### Add the webhook secret to Vercel

Your local `whsec_` is for the tunnel only — production needs its own.

1. 🌐 Clerk dashboard → **Webhooks** → **Add Endpoint**
2. URL: `https://your-app.vercel.app/api/webhooks/clerk`
3. Subscribe to these four events:
   - `organization.created`
   - `organization.updated`
   - `organization.deleted`
   - `organizationMembership.created`
4. Click **Create**, then copy the **Signing Secret**
5. 🌐 Vercel → your project → **Settings → Environment Variables**
6. Add `CLERK_WEBHOOK_SIGNING_SECRET` with that value
7. **Deployments** → newest → `…` → **Redeploy**

> Skipping the redeploy is the most common mistake here. Vercel only picks up new
> environment variables on a fresh deployment.

### Run the RLS migration on production

If your Vercel deployment points at a *different* Neon database than local, repeat
**Step 3** against that database. Same SQL, same verification query.

---

## Verification checklist

- [ ] `npx drizzle-kit push` created 6 new tables
- [ ] All **12** tables report `rowsecurity = true`
- [ ] Creating an organization writes a row to `tenants`
- [ ] Dashboard shows the real workspace name (not "Finishing setup…")
- [ ] `/contacts` renders the data grid
- [ ] Forged webhook returns **401** and writes nothing
- [ ] `CLERK_WEBHOOK_SIGNING_SECRET` is set in Vercel **and** redeployed

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Webhook logs `500 Webhook not configured` | Secret missing | Set `CLERK_WEBHOOK_SIGNING_SECRET`, restart dev server |
| Webhook returns 401 on real Clerk events | Wrong secret, or tunnel restarted | Copy the current `whsec_` and restart |
| Dashboard still says "Finishing setup…" | Webhook never fired | Check the tunnel tab; create a *new* org to trigger it |
| `relation "companies" does not exist` | Migration not pushed | Re-run `npx drizzle-kit push` |
| `permission denied for table contacts` | RLS on, but tenant context unset | Expected for raw SQL — the app sets it via `withTenant()` |
| Grid shows "No contacts yet" | Correct — table is empty | Add a contact via `createContact()` |
| `Cross-tenant reference blocked` error | The trigger is working as designed | You referenced another tenant's record |

---

## What you can build on now

`defineCustomObject()` lets a tenant create a business entity in seconds — no
migration, no deployment. For example, a real-estate workspace defining "Property":

```ts
await defineCustomObject({
  name: "Property",
  pluralName: "Properties",
  icon: "building-2",
  fields: [
    { fieldName: "address",   label: "Address",   fieldType: "text",     isRequired: true },
    { fieldName: "price",     label: "Price",     fieldType: "currency",
      validation: { currencyCode: "INR" } },
    { fieldName: "bedrooms",  label: "Bedrooms",  fieldType: "number" },
    { fieldName: "status",    label: "Status",    fieldType: "select",
      options: [
        { label: "Available", value: "available" },
        { label: "Under Offer", value: "under_offer" },
        { label: "Sold", value: "sold" },
      ] },
    { fieldName: "listed_on", label: "Listed On", fieldType: "date" },
  ],
});
```

`buildDynamicColumns()` then renders those fields in the data grid automatically —
currency formatted, dates localised, select values shown as badges.
