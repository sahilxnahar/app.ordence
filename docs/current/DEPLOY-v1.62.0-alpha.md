# DEPLOY , Ordence v1.62.0-alpha (HR statutory completion)

**Repo: `app.ordence`**

🔴 **SQL: THREE new migrations, `0094` → `0095` → `0096`, in that order, BEFORE the code push.**
⚠️ **No new environment variables.**

**15 gates green. `tsc` clean. 156 test files. 5,270 tests, up from 5,120.**

---

## Six batches, all Indian statutory payroll

| Batch | | |
|---|---|---|
| **Gratuity** | Payment of Gratuity Act 1972 | ceiling, 6-month rounding, death waiver |
| **Full and final** | + 🔴 the payment-date defect | s.7 deduction cap that **refuses** rather than clamps |
| **Overtime** | Factories Act s.59 | **twice** the ordinary rate, state variation, cap breach surfaced |
| **Form 16** | Income-tax Rule 31 | 🔴 **Part B only. Part A is TRACES'.** |
| **ECR / ESIC / PT returns** | the monthly filings | the computation existed; the **files** did not |
| **Advances and reimbursements** | s.7(2)(f), s.12 | append-only recovery ledger |

---

## 🔴 The defect this wave closed

**`payroll_runs` had no date of payment**, and it was on this project's own known-defects list. **The entire Payment of Wages Act, 1936 is about that day** , s.5 sets when wages must be paid, s.5(4) requires payment on the last working day for a terminated employee, and the register an inspector asks for is a register of **dates paid**, not amounts computed. The schema literally could not store the answer.

⭐ **`0094` does not add `paid` to the status enum, and the reasoning is worth reading.** That enum is a one-way ladder of internal acts. Payment is a fact about a bank: it fails, it retries. A `paid` rung would need a backwards transition to record a bounced NEFT, and would make the dangerous row , *posted, journalled, never paid* , look like the healthy resting state. So payment is a **separate axis**: `paid_on`, `payment_reference`, `payment_failed_on`, `payment_failure_reason`, with CHECKs enforcing paid ⇒ approved and paid XOR failed.

⚠️ **And the due date is frozen on the row.** The s.5(1) band depends on headcount, which changes. A register reprinted in 2028 must show the date that governed in 2026.

---

## ⭐ Where the agents refused to produce something wrong

This is the part worth reading. In statutory work, a confident wrong number is the failure mode.

**Form 16 , Part A was not built, deliberately.** Part A is generated and **digitally signed by TRACES** after the 24Q return is processed. An employer who emits their own Part A produces a document that is not a valid Form 16, and an employee will file a return with it believing an obligation was discharged. What ships is Part B plus *Part A reconciliation inputs*, typed `isCertificate: false` and `mustBeDownloadedFrom: "TRACES"` as **literal types**, so the compiler stops a future edit promoting it.

**Surcharge and marginal relief are refused, not approximated.** Above the configured income threshold the certificate is **not issued at all**, and the refusal prints the income and the threshold.

**Overtime refuses for an unconfigured state.** Shops and Establishments Acts are state law and differ in threshold, cap and sometimes multiplier. It never borrows a neighbouring state, the newest row, or the Factories Act default. And a **factory multiplier below 2× is a blocking finding even as data** , s.59 says twice, so 1.5× is caught even if someone configures it.

**Gratuity refuses the piece-rate averaging divisor** (90 / 78 / days-worked) rather than picking one, and **does not compute income tax** because the s.10(10) lifetime-aggregate machinery does not exist , `taxTreatment: "not_computed"` is on every result.

**The return files carry `confirmedAgainstPortal: false`** on every layout row, and it travels onto the file and above the download button. There is no network here to check the current EPFO field order. 🔴 **A malformed statutory file is rejected, which is annoying. A well-formed file with wrong numbers is ACCEPTED**, becomes the employer's filed position, and is corrected only by a revised return and interest.

---

## ⚠️ Three findings, reported and not silently patched

1. 🔴 **`server/payroll/run.ts` computes ESI with `esiCoveredAtPeriodStart: false` as a documented approximation.** An employee who crosses the ESI wage ceiling mid-period **stays covered to the end of the contribution period** (Apr–Sep, Oct–Mar). Under the approximation their payslip can show nil ESI, which drops someone's insurance mid-illness. The return builder now **blocks** rather than filing a month that ends their cover , but the payslip is still wrong. This is the highest-value fix left in payroll.
2. **The Form 16 engine has no production caller.** No server action, no page. That is exactly the state `check-tax-decisions` was written to catch for the GST engine. Wiring it needs decisions about challan-to-deductee mapping that would have been guesses.
3. **The settlement engine's terminated-employee due date is set to the strictest reading.** "Last working day", the Act's "second working day" limb and Code on Wages s.17(2) disagree; the default is the most protective and it is configurable, with the disagreement stated.

---

## Deploy

1. **SQL, in order: `0094` → `0095` → `0096`.**
   - ⭐ **All three drilled the way you actually run them**: split into statements (26, 3 and 44), each sent on its own fresh connection, twice over for idempotence. No `BEGIN`, no `COMMIT`, no bare `SET LOCAL`.
   - ⭐ Verified on a live PostgreSQL 16 that all five new tenant-scoped tables have RLS **enabled and forced** with a policy naming `app_current_tenant_id()`, and that `employee_advance_recoveries` carries working `no_update` / `no_delete` triggers , a recovery you can edit afterwards is not evidence.
2. Unzip `ordence-v1.62.0-alpha.zip`, commit, push.

⚠️ **`0096` was renumbered from `0097` during integration** because two agents correctly decided they needed no SQL, leaving a gap. `check:migrations` fails on gaps by design , that gate exists because three files were once numbered into a future that never happened.

⚠️ **Still not verified: `next build`.** OOM-killed here. `check:route-exports` and `check:client-hooks` exist because that gap broke Railway twice; they are a subset, not a substitute.

---

## Where the roadmap stands

**Mega-wave 2: 22 of 24.** Batch 24 needs a suspended workspace; batch 32 needs the two vault keys.

**Mega-wave 3: 6 of 19 done this wave.** Remaining: entitlements and metering (55, 56) and comms and support (132, 133, 121, 120, 123) are **runnable now**; Razorpay (53, 54, 124) needs the Razorpay keys; the caged agent (62, 63, 64, 140) needs the Groq and Cloudflare Workers AI keys.
