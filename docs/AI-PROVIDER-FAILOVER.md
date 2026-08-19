# Ordence — the AI provider router

**v0.60.0 · 3 August 2026.** How to use 31 free providers as one reliable
service, without putting your customers' data somewhere it must not go.

---

## Part 0 — The thing to decide before any code

You asked for failover: if one provider breaks, the next takes over. That part
is easy and I'll design it below.

**The hard part is a different question, and it has to be answered first:**

> **Which data is allowed to leave Ordence at all?**

Most free tiers reserve the right to train on what you send them. That is the
price of free, and it is stated in their terms. It is completely fine for some
of what you'd want AI for, and completely unacceptable for the rest.

| What you might send | Free tier? | Why |
|---|---|---|
| "Draft a follow-up email about a site visit" | ✅ Yes | Generic text, no customer in it |
| "Summarise this GST notice" (blank template) | ✅ Yes | Public document |
| Marketing copy for ordence.com | ✅ Yes | Yours, and public anyway |
| **A contact's name, phone, address** | 🔴 No | Personal data under DPDPA |
| **A contract's commercial terms** | 🔴 No | Your customer's confidential info |
| **A patient record** | 🔴 **Never** | Sensitive personal data. Criminal exposure |
| **A ledger, a bank statement, a salary** | 🔴 No | Financial data |

⚠️ **This is not a caution to bolt on later.** If the router is built without
it, the first useful feature somebody ships — "summarise this customer's
history" — quietly sends a tenant's CRM to a provider that trains on it. There
is no fixing that afterwards; the data has left.

**So the router has two lanes, and the lane is chosen by the CALLER declaring
what kind of data it is holding — not by the router guessing.**

| Lane | Providers | For |
|---|---|---|
| **OPEN** | all 31 free tiers, failover across them | Nothing about a real customer |
| **CONFIDENTIAL** | a short allowlist with a written no-training term, or Cloudflare Workers AI | Anything tenant-owned |

> ⭐ **Cloudflare Workers AI is the interesting one.** It is on the list, it is
> free-tier, and it runs inside the account you already deploy to — so tenant
> data never leaves Cloudflare's network, and it is covered by the DPA you
> already have with them. For a multi-tenant CRM that is a materially better
> default than any of the other thirty.

---

## Part 1 — Why naive failover is the wrong shape

The obvious design is a try/catch chain: try Groq, catch, try Cerebras, catch,
try Gemini.

**That fails in the way free tiers actually fail.** They rarely go down. They
rate-limit — Groq gives 30 requests a minute, and request 31 gets a 429. So a
try/catch chain hammers Groq to its ceiling on every single request, waits for
the rejection, and only then moves on. Every call after the thirtieth pays the
full latency of a failure before it does anything useful.

**The router therefore needs to know the budget before it spends it.** Three
pieces:

1. **A ledger of what each provider has left this minute/day** — kept in
   Upstash, which you have connected and which currently does nothing. This is
   its first real job.
2. **Health** — consecutive failures trip a breaker so a dead provider is
   skipped for a cool-off rather than retried on every request.
3. **An ordered preference list per lane**, so the choice is deliberate rather
   than incidental.

---

## Part 2 — The architecture

```
   caller
     │  askAI({ purpose, sensitivity, prompt })
     ▼
┌─────────────────────────────────────────────────────────┐
│ 1 · ENTITLEMENT GATE      requireFeature("ai.copilot")   │
│     Already built. AI is a paid capability per tier.     │
├─────────────────────────────────────────────────────────┤
│ 2 · ⭐ SENSITIVITY GATE                                  │
│     sensitivity: "open" | "tenant"                       │
│     "tenant" → CONFIDENTIAL lane only. No exceptions,    │
│     no fallback into the open lane when it is busy.      │
├─────────────────────────────────────────────────────────┤
│ 3 · ROUTER                                               │
│     • read budget + health from Upstash                  │
│     • pick the first provider in the lane with headroom  │
│     • call it, with a timeout                            │
│     • on 429/5xx: record, trip breaker, take the next    │
│     • decrement the budget on success                    │
├─────────────────────────────────────────────────────────┤
│ 4 · AUDIT                                                │
│     Which provider, which model, tokens, latency,        │
│     tenant, purpose. NEVER the prompt or the response.   │
└─────────────────────────────────────────────────────────┘
```

### The files

| File | What it holds |
|---|---|
| `lib/ai/providers.ts` | The 31 providers: base URL, env var name, models, rate limits, lane |
| `lib/ai/router.ts` | Budget, breaker, ordered selection. Pure logic, fully testable |
| `lib/ai/client.ts` | `askAI()` — the only thing the rest of the app calls |
| `server/ai/audit.ts` | Usage rows. Metadata only |
| `db/schema/ai.ts` | `ai_requests`, `ai_provider_health` |

### The one function everything uses

```ts
const answer = await askAI({
  purpose: "draft_email",
  sensitivity: "open",           // ⚠️ the caller states this, explicitly
  prompt: "...",
  maxTokens: 800,
});
```

⚠️ **`sensitivity` has no default.** A default would be wrong either way: default
to `open` and somebody eventually leaks a customer; default to `tenant` and the
open lane is never used, so the whole point is lost. Making it required forces a
decision at every call site — and makes those decisions greppable in review.

---

## Part 3 — Which providers, in what order

From the directory, ordered by what actually matters for you: no credit card,
generous limits, OpenAI-compatible, and a real jurisdiction.

**OPEN lane** — general text, nothing about a customer:

| # | Provider | Base URL | Card? |
|---|---|---|---|
| 1 | **Groq** | `https://api.groq.com/openai/v1` | No |
| 2 | **Cerebras** | `https://api.cerebras.ai/v1` | No |
| 3 | **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta` | No |
| 4 | **Mistral** | `https://api.mistral.ai/v1` | No |
| 5 | **Cohere** | `https://api.cohere.com/v2` | No |
| 6 | **GitHub Models** | `https://models.github.ai/inference` | No |

**CONFIDENTIAL lane** — anything tenant-owned:

| # | Provider | Why it qualifies |
|---|---|---|
| 1 | **Cloudflare Workers AI** | Same account you deploy to, covered by your existing DPA, data does not leave their network |
| 2 | *(a paid tier with a no-training term, when you have one)* | Not free, and that is the point |

⚠️ **Two entries, not twenty.** The confidential lane is short because
qualifying for it means a written commitment not to train on your inputs.
Padding it with free tiers because "they probably don't" is the decision that
makes the whole design pointless.

> ⚠️ **Also worth knowing about the list itself:** several providers on it are
> hosted in mainland China (ModelScope, SiliconFlow, Z AI, Alibaba). Fine for
> the open lane; a separate conversation for anything else, and one your Indian
> enterprise customers will eventually ask about.

---

## Part 4 — The build, in batches

Each batch ships on its own and is useful before the next starts.

| Batch | What | Depends on |
|---|---|---|
| **1** | **Delete the OpenRouter keys** (Part 5). Nothing uses them | — |
| **2** | `lib/ai/providers.ts` — the registry, 31 entries, lanes and limits | — |
| **3** | `lib/ai/router.ts` + tests — budget, breaker, selection. **Pure logic, no network**, so it is testable properly | 2 |
| **4** | Upstash budget ledger — the first real use of the Redis you already pay nothing for | 3 |
| **5** | `askAI()` + the sensitivity gate + `ai_requests` audit table | 3, 4 |
| **6** | Wire `ai.copilot` / `ai.rag` entitlements. **They already exist** in the catalogue | 5 |
| **7** | Per-tenant opt-in — a switch in Settings, off by default, with the training question stated in plain words | 6 |
| **8** | The first real feature: draft an email, summarise a document | 7 |

**Batches 2 and 3 are the substance.** The router is pure functions over a
budget table — no network, no database — so it can be tested for the cases that
actually bite: every provider exhausted, a breaker half-open, a 429 mid-flight,
two requests racing for the last token of the minute.

---

## Part 5 — Deleting the OpenRouter keys

**Nothing in Ordence calls OpenRouter.** I checked. The four keys are in
`AMEYA-CRM-MASTER-DETAILS.md` and are live and billable.

1. Go to **<https://openrouter.ai/settings/keys>**
2. Delete all four. Do not replace them — the router above does not need
   OpenRouter, and a key that exists is a key that can leak
3. Check **<https://openrouter.ai/activity>** for spend you did not make
4. Remove them from `AMEYA-CRM-MASTER-DETAILS.md`
5. ⚠️ **Purge them from git history too.** Deleting the line leaves them
   readable in every earlier commit. `git filter-repo`, or ask GitHub Support

> OpenRouter stays *in the registry* as an option — it is a good aggregator.
> What goes away is the four keys that leaked.

---

## Part 6 — What I need from you

To build batch 2 onward, one key per provider you want in the open lane. Start
with two; the router does not care how many it has.

| Provider | Where | Time |
|---|---|---|
| **Groq** | <https://console.groq.com/keys> | 1 min, email only |
| **Cerebras** | <https://cloud.cerebras.ai/> | 2 min |
| **Google Gemini** | <https://aistudio.google.com/app/apikey> | 1 min |
| **Cloudflare Workers AI** | <https://dash.cloudflare.com/profile/api-tokens> | You already have the account |

Each becomes a Cloudflare **Secret**: `GROQ_API_KEY`, `CEREBRAS_API_KEY`,
`GOOGLE_AI_API_KEY`, `CF_AI_TOKEN`.

⚠️ **Send them to me and they are burned, exactly like the last set.** Put them
straight into Cloudflare yourself; I do not need to see a key to write the code
that reads it.
