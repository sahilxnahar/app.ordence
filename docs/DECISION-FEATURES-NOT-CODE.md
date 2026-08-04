# Yes — Features and Ideas, Not Code

**Answer to: "Can I just take their features, or take ideas from Twenty and build it myself?"**
**Date:** 1 August 2026

---

## The short answer

**Yes. Completely. That is exactly what you chose, and it is what I am
already doing.**

There is no legal restriction whatsoever on:

- Reading their entire codebase (I have — all 1.82 million lines)
- Listing every feature they ship
- Copying their **data model** — what fields a Lead has, what states a
  Workflow moves through
- Copying their **product decisions** — 4 triggers, 19 workflow actions,
  Kanban over any object
- Building all of it ourselves, better, and selling it

**Ideas, features, layouts, data structures and "how it works" are not
copyrightable. Only the actual written code is.**

This is not a loophole. It is the foundation of the entire software
industry. Every CRM has a pipeline board. Every accounting system has
double-entry. Salesforce did not invent the contact record, and nobody
can own the concept of "a workflow with triggers and actions".

---

## Where the line actually sits

| Action | Legal? |
|---|---|
| "Twenty's workflow engine has 19 action types — here they are" | ✅ A fact |
| "Their Lead object has these 14 fields" | ✅ A fact |
| "Build me a Kanban that works over any record type, like theirs" | ✅ An idea |
| "Their runtime `CREATE TABLE` approach is better than ours — copy the approach" | ✅ An idea |
| Opening their `workflow-executor.ts` and pasting it into our repo | ❌ **This is the only thing that is off-limits** |
| Copying it and renaming the variables | ❌ Still copying |

**The one rule: I read their code to understand what it does, then close
it and write ours. Nothing is pasted.**

That is the same thing we did with your own personal CRM in Phase 22 —
I read your `Lead`, `Unit` and `Booking` models to learn the fields you
had discovered you needed, then wrote `db/schema/sales.ts` fresh, with
tenant isolation and paise-based money that your original never had. The
result is better than what I was reading, and it is entirely ours.

---

## The one thing to be careful about

Because it is easy to blur, and blurring it is what creates the risk:

> **"Incorporate all their features" is safe.
> "Incorporate all their code" would give away the company.**

Those two sentences sound almost identical and mean opposite things. In
the first, we spend engineering time. In the second, every customer
receives the complete source of Ordence and may hand it to a
competitor.

I will never paste their code. If I ever need to explain how something
of theirs works, I will describe it — not quote it.

---

## What that means practically

The four capabilities you chose get built as follows.

| Capability | What I take from Twenty | What I write |
|---|---|---|
| **Workflow engine** | The shape: 4 trigger kinds, ~19 action types, versioned definitions, run history, a visual node graph | All of it — on our schema, inside `withTenant()`, gated by our permissions |
| **Runtime custom objects** | The insight that real `CREATE TABLE` beats a generic rows table | Our own DDL builder, with forced RLS on every table it creates — which theirs does not do |
| **Views over any object** | The idea of saved, named, permission-scoped views in table / kanban / calendar form | Generalising the Phase 22 Kanban we already built |
| **AI agents + MCP** | The pattern: agents with their own permissions, reusable skills, MCP as the interface | Ours, against our data, with our four gates applied |

In every row, what crosses over is a paragraph of understanding. What
gets written is ours.

---

## One place we will deliberately do it differently

Worth flagging, because it is the clearest example of *why* rebuilding
beats copying even when copying is tempting.

**Twenty has no row-level security. None — I checked. Zero policies,
zero `RLS` in the schema.** Their isolation is entirely application-level:
a `workspaceId` carried in memory and added to queries by their ORM.

That is a perfectly reasonable choice for them. It would be a bad one
for us, because our whole promise is that cross-customer access is
*physically impossible at the database level*, not merely *correctly
handled by the code*. We have 47 policies and 13 composite foreign keys
enforcing that.

So when I build their custom-object engine, it will not work like
theirs — every table it creates gets `ENABLE` + `FORCE` row-level
security automatically, or it does not get created.

**Copying the code would have imported their security model along with
their feature. Copying the idea lets us keep ours.**

That is the argument for this whole approach in one example.
