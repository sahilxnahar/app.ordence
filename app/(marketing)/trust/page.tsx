/**
 * Ordence — The public trust page
 * Version: v1.52.x  (Batch 134)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RULE THIS PAGE IS BUILT ON: EVERY SENTENCE IS CHECKABLE.
 * ══════════════════════════════════════════════════════════════════════
 * The audience is an Indian SMB owner, the chartered accountant who signs
 * off their books, and the banker deciding whether to lend against those
 * books. The CA has already read a dozen vendor security pages promising
 * bank-grade encryption — a phrase that names no standard, cannot be
 * checked, and therefore buys us nothing. A claim that turns out to be
 * false is worth less than nothing.
 *
 * So every claim below names the artefact that implements it — a file, a
 * migration, a CI gate — and a reader who is given the repository can go
 * and look. Nothing here is asserted that could not be shown.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS PAGE MAY NEVER SAY
 * ══════════════════════════════════════════════════════════════════════
 * No SOC 2. No ISO 27001. No PCI. No HIPAA. No "bank-grade", no
 * "military-grade", no "unhackable". Ordence holds NONE of those
 * certifications, and a banker who is interested will ask for the report
 * within one email. Claiming a certification you cannot produce converts
 * a promising conversation into a closed one, and it does so at the exact
 * moment the deal was going well.
 *
 * ⭐ `tests/ui/trust-page.test.ts` reads this file and fails the build if
 * any banned phrase appears. That test exists because the risk is not
 * this commit — it is the marketing edit in eighteen months that slips a
 * word like bank-grade into a heading, which we could not defend if a
 * banker asked us to.
 *
 * ⭐ WHY THE "WHAT WE DO NOT HAVE YET" SECTION IS THE MOST VALUABLE ONE.
 * A page that admits a gap is evidence that the rest of the page was
 * written by somebody willing to be checked. The CA has read the perfect
 * ones; the perfect ones are why they stopped reading.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY STATE CARRIES A WORD, NOT A COLOUR.
 * ══════════════════════════════════════════════════════════════════════
 * Roughly one in twelve Indian men is colour-blind. A green tick beside
 * "in place" and a red one beside "not yet" is, for them, two identical
 * marks. So the status is the WORD — "In place today", "Not yet" — and
 * colour only ever repeats what the word already said.
 *
 * 🔴 SERVER COMPONENT. No `"use client"`, therefore no hooks, no state,
 * no storage. It is a static document; making it interactive would add a
 * client bundle to a page whose entire job is to be readable.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Trust & security — Ordence",
  description:
    "How Ordence separates one business's data from another's, what the audit trail can prove, what support staff may and may not do, and what we do not have yet.",
  /*
   * ⚠️ OVERRIDES THE ROOT LAYOUT'S `robots: { index: false }`.
   *
   * Every other route in this product is a signed-in view of one tenant's
   * data and has no business in a search index. This page is the single
   * exception: it exists to be found by somebody evaluating Ordence, and
   * a CA who cannot find it will simply ask the question by email instead.
   */
  robots: { index: true, follow: true },
};

/**
 * One verifiable control.
 *
 * `evidence` is deliberately a repository path rather than prose. It is
 * what turns "we do row-level security" into something a reader can be
 * handed and can check for themselves.
 */
type Control = {
  readonly heading: string;
  readonly body: readonly string[];
  readonly evidence: readonly string[];
};

const CONTROLS: readonly Control[] = [
  {
    heading: "One business cannot read another business's rows",
    body: [
      "Separation between businesses is enforced by PostgreSQL itself, not by application code remembering to add a filter. Every table that carries a business identifier has row-level security enabled and FORCED. The distinction matters: enabling row-level security alone does not apply it to the table's owner, and this application connects to the database as the owner — so enabling without forcing would be decoration.",
      "The reason this is enforced in the database rather than in code is that application filters are only as good as the last developer who remembered one. A missed WHERE clause in a single query is enough to show one company another company's ledger.",
      "A check runs on every build that reads the live database and, for every table carrying a business identifier, asserts four things: that row-level security is on, that it is forced, that a policy actually references the current business, and that platform-wide support access can read but never write. There is no threshold and no sampling. One unprotected table fails the build.",
    ],
    evidence: [
      "scripts/check-rls-coverage.mjs — the build gate",
      "SQL-FILES/0001_rls_and_audit_guard.sql — the original policies",
    ],
  },
  {
    heading: "The audit trail can prove it was not edited",
    body: [
      "Audit records are append-only: a database trigger refuses any UPDATE or DELETE against them, and the access policies refuse the connection. That stops the application from rewriting history.",
      "It does not, by itself, stop somebody with full database credentials, who could disable the trigger, edit a row, and switch the trigger back on. So each audit row also carries a SHA-256 digest of its own contents and of the row before it, forming a chain. Altering any historical row changes its digest and breaks every link after it, which makes the alteration detectable rather than merely forbidden.",
      "Being honest about the limit: a hash chain proves tampering happened. It does not prevent it, and it cannot recover the original text. Audit rows written before the chain was introduced sit outside it and are marked as such rather than quietly presented as chained.",
    ],
    evidence: [
      "SQL-FILES/0081_audit_hash_chain.sql — the chain",
      "server/audit.ts — where each link is computed on write",
    ],
  },
  {
    heading: "A closed accounting period stays closed",
    body: [
      "When a period is closed, a database trigger refuses any transaction dated inside it. The refusal is on the document date, not the date the row was inserted — backdating is precisely the move the control exists to stop.",
      "This is enforced at the database level for the same reason as the isolation above: a period close that only the user interface respects is not a period close. Reopening a period is possible, but it is a deliberate act by somebody permitted to do it, and it is recorded.",
      "For a CA this is the difference between numbers that were signed off and numbers that were signed off and then quietly moved.",
    ],
    evidence: ["SQL-FILES/0073_period_lock_and_reorder.sql — the guard trigger"],
  },
  {
    heading: "What our support staff may do inside your workspace",
    body: [
      "Support access to a customer workspace is called impersonation, and it is constrained by a policy held in one file that the banner, the server-side gate, the database checks and the tests all read from.",
      "Access is read-only by default. Write access exists only where the customer has consented — either standing consent recorded by a workspace owner, revocable at any moment, or consent given by an admin for one specific incident.",
      "Every session, in every mode, expires after thirty minutes. That is a hard ceiling applied on read as well as on write, so a session already in progress cannot outlive it. One support engineer may hold one session at a time.",
      "Where no consent exists and the situation is urgent, an engineer may open a break-glass session. It is read-only, it is fifteen minutes, it requires a written justification, and the workspace's owners are notified immediately rather than in a monthly report. The reasoning was that a customer's inability to answer the phone should reduce what we may do, not increase it.",
      "Some actions are refused even with full consent — changing roles, issuing invitations, and anything else that would outlive the session or that the customer could not undo themselves.",
    ],
    evidence: ["lib/platform/impersonation-policy.ts — the policy, with its reasoning written out"],
  },
  {
    heading: "Credentials for your other systems are encrypted before storage",
    body: [
      "When you connect Ordence to another system, the credential you hand over is encrypted with AES-256-GCM before it reaches the database. What is stored is ciphertext, an initialisation vector, a masked display value, and the name of the key used — never the key itself, which is held in the deployment environment and not in the database.",
      "Searchable fields use a keyed blind index rather than the plaintext, so a credential can be looked up without being stored in a readable form. Every read of a secret is written to an access log that no application role may delete.",
      "Being precise about scope: this describes secrets held in the vault. It is not a claim that every field in the product is individually encrypted.",
    ],
    evidence: ["server/vault/crypto.ts — the encryption", "server/vault/secrets.ts — storage and access logging"],
  },
  {
    heading: "The browser-side controls",
    body: [
      "Pages are served with a Content-Security-Policy built per request around a fresh nonce. It contains no unsafe-inline in its script sources and it sets a base URI — the three ways a policy of this kind becomes decoration are each covered by a test that is phrased as the failure rather than the feature.",
      "Session cookies and device-local preferences are the only things stored in your browser; the cookie banner describes that scope rather than a generic one.",
    ],
    evidence: ["lib/security/csp.ts and tests/ui/csp.test.ts"],
  },
];

/**
 * ⭐ THE SECTION A CA READS FIRST.
 *
 * Each entry is a real gap, stated in the words a customer would use, with
 * what we do instead. "Not yet" is a word, deliberately — the status is
 * legible without any colour being perceived.
 */
const NOT_YET: readonly { readonly gap: string; readonly instead: string }[] = [
  {
    gap: "We hold no SOC 2 report and no ISO 27001 certificate.",
    instead:
      "We have not been through either audit. If your policy requires one, we would rather you knew now than after implementation. What we can offer instead is the specific evidence on this page, and answers to a security questionnaire that name files rather than adjectives.",
  },
  {
    gap: "We have no published penetration test.",
    instead:
      "No third-party test has been commissioned. Internal checks — the build gates described above, plus tests for cross-tenant access and injection — run on every change, but an internal check is not an independent one and we will not present it as one.",
  },
  {
    gap: "We do not publish a formal uptime commitment.",
    instead:
      "There is no contractual availability figure. Ask us for the actual operating history rather than a number written into a page.",
  },
  {
    gap: "Customer-managed encryption keys are not available.",
    instead:
      "Vault keys are held by Ordence in the deployment environment. If your organisation requires that it hold the key, we cannot meet that today.",
  },
  {
    gap: "Data residency is answered on request, not asserted here.",
    instead:
      "Ordence runs on managed infrastructure — Neon for the database, Railway for the application — and the storage region is a property of that infrastructure. We would rather tell you the current region in writing, and tell you when it changes, than print a region on a marketing page that nobody updates. Ask, and we will answer specifically.",
  },
  {
    gap: "Encryption in transit and at rest is provided by our infrastructure vendors.",
    instead:
      "Traffic is served over HTTPS, and our database provider Neon encrypts stored data. Those are properties of Neon and of the hosting platform, described in their documentation — we attribute them rather than restating them as our own engineering.",
  },
];

export default function TrustPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header>
        <p className="text-sm font-semibold uppercase tracking-widest text-primary">Ordence</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">Trust and security</h1>
        <p className="mt-5 text-base leading-relaxed text-muted-foreground">
          This page is written for the person who has to sign something — the owner, their
          chartered accountant, their banker. Every claim on it names the part of the system that
          implements it, so it can be checked rather than believed. The last section lists what we
          do not have.
        </p>
      </header>

      <section className="mt-14 space-y-12" aria-labelledby="controls-heading">
        <h2 id="controls-heading" className="text-2xl font-semibold tracking-tight">
          What is in place today
        </h2>

        {CONTROLS.map((control) => (
          <article key={control.heading} className="border-l-2 border-border pl-5">
            {/*
              ⚠️ THE STATUS IS THE WORD "In place today", not a coloured dot.
              The colour class below only repeats what the word already says;
              remove every colour from this page and nothing becomes ambiguous.
            */}
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              In place today
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight">{control.heading}</h3>
            <div className="mt-3 space-y-3">
              {control.body.map((paragraph) => (
                <p key={paragraph.slice(0, 48)} className="text-sm leading-relaxed">
                  {paragraph}
                </p>
              ))}
            </div>
            <p className="mt-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Where to check this
            </p>
            <ul className="mt-2 space-y-1">
              {control.evidence.map((item) => (
                <li key={item} className="font-mono text-xs text-muted-foreground">
                  {item}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="mt-16" aria-labelledby="not-yet-heading">
        <h2 id="not-yet-heading" className="text-2xl font-semibold tracking-tight">
          What we do not have yet
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Stated plainly, because you will find out anyway, and finding out later is worse for both
          of us.
        </p>

        <dl className="mt-8 space-y-8">
          {NOT_YET.map((item) => (
            <div key={item.gap} className="border-l-2 border-border pl-5">
              {/* Again: the state is the word "Not yet". */}
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Not yet
              </p>
              <dt className="mt-2 text-base font-semibold">{item.gap}</dt>
              <dd className="mt-2 text-sm leading-relaxed">{item.instead}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-16 border-t border-border pt-8" aria-labelledby="contact-heading">
        <h2 id="contact-heading" className="text-2xl font-semibold tracking-tight">
          Reporting something, or asking for more
        </h2>
        <p className="mt-3 text-sm leading-relaxed">
          If you believe you have found a security problem in Ordence, write to{" "}
          <a className="font-medium underline" href="mailto:security@ordence.com">
            security@ordence.com
          </a>
          . Our machine-readable contact details follow RFC 9116 and are published at{" "}
          <Link className="font-medium underline" href="/security.txt">
            /security.txt
          </Link>
          .
        </p>
        <p className="mt-3 text-sm leading-relaxed">
          For a security questionnaire, a data-processing agreement, or the current storage region,
          write to the same address. We answer with specifics.
        </p>
      </section>
    </main>
  );
}
