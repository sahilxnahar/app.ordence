/**
 * Ordence — ⭐⭐⭐ MONTHLY STATUTORY RETURN FILES
 * Version: v1.52.0-alpha · Batch 78
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCREEN THAT TURNS A COMPUTED LIABILITY INTO A FILED RETURN
 * ══════════════════════════════════════════════════════════════════════
 * Ordence has computed PF, ESI and professional tax correctly for
 * several batches. None of that is FILED. Every month the employer must
 * upload a file — the EPFO ECR, the ESIC monthly contribution, and
 * whatever the State demands for professional tax — and this is where
 * those files come from.
 *
 * ⚠️ THE GUARD IS ON THE ACTIONS, NOT ON THIS ROUTE. A server action is
 * a POST to whatever URL the browser happens to be on, so rendering or
 * not rendering a table decides nothing. `listStatutoryReturns` and
 * `generateStatutoryReturn` each check `payroll.read` themselves.
 *
 * ⭐ THE URL IS THE DOCUMENT — the run, the file and the State are all
 * query parameters, so a return can be linked and reopened.
 *
 * 🔴 AND A REFUSAL IS RENDERED AS PROMINENTLY AS A FILE. "We did not
 * produce this, and here is the employee who has no UAN" is the useful
 * outcome most of the time, and a screen that showed it as a small grey
 * error would push somebody towards producing the file anyway.
 */

import Link from "next/link";
import { AlertTriangle, FileWarning } from "lucide-react";
import {
  generateStatutoryReturn,
  listStatutoryReturns,
} from "@/server/actions/statutory-returns";
import { ReturnDownload } from "@/components/payroll/return-download";

export const dynamic = "force-dynamic";
export const metadata = { title: "Statutory return files · Ordence" };

type Kind = "epfo_ecr" | "esic_monthly" | "professional_tax";

function isKind(value: string | undefined): value is Kind {
  return value === "epfo_ecr" || value === "esic_monthly" || value === "professional_tax";
}

export default async function StatutoryReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    run?: string;
    state?: string;
    priorYear?: string;
  }>;
}) {
  const params = await searchParams;
  const catalogue = await listStatutoryReturns();

  if (!catalogue.ok) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <h1 className="text-xl font-semibold">Statutory return files</h1>
        <p className="mt-3 text-sm text-red-700">{catalogue.error}</p>
      </main>
    );
  }

  const kind: Kind = isKind(params.kind) ? params.kind : "epfo_ecr";
  const runNo = (params.run ?? "").trim();
  const stateCode = (params.state ?? "").trim().toUpperCase();
  const priorYear = (params.priorYear ?? "").trim();

  const outcome =
    runNo.length === 0
      ? null
      : await generateStatutoryReturn({
          kind,
          runNo,
          stateCode: stateCode.length === 2 ? stateCode : undefined,
          priorYearLiabilityMinor: /^\d+$/.test(priorYear) ? priorYear : undefined,
        });

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">Statutory return files</h1>
        <p className="text-sm text-slate-600">
          The monthly files an employer uploads: the EPFO ECR, the ESIC contribution file, and the
          professional tax return for a State that has been configured. Nothing here is filed for
          you — Ordence prepares the file and refuses to prepare one it cannot stand behind.
        </p>
      </header>

      {/* ⚠️ A PLAIN GET FORM. Every choice lands in the URL, so the
          document is linkable and there is no client state to lose. */}
      <form method="get" className="grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block font-medium">File</span>
          <select name="kind" defaultValue={kind} className="mt-1 w-full rounded border px-2 py-1">
            {catalogue.data.kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label} · {k.authority}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="block font-medium">Payroll run</span>
          <select name="run" defaultValue={runNo} className="mt-1 w-full rounded border px-2 py-1">
            <option value="">Choose a run…</option>
            {catalogue.data.runs.map((r) => (
              <option key={r.runNo} value={r.runNo}>
                {r.runNo} · {r.periodStart} to {r.periodEnd} · {r.status}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="block font-medium">State (professional tax only)</span>
          <select name="state" defaultValue={stateCode} className="mt-1 w-full rounded border px-2 py-1">
            <option value="">—</option>
            {catalogue.data.states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="block font-medium">
            Last year&rsquo;s professional tax liability, in paise
          </span>
          <input
            name="priorYear"
            defaultValue={priorYear}
            inputMode="numeric"
            className="mt-1 w-full rounded border px-2 py-1"
            placeholder="Some States decide monthly or annual filing from this"
          />
        </label>

        <div className="sm:col-span-2">
          <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white">
            Prepare the file
          </button>
        </div>
      </form>

      {/* ⭐ EVERY STATE CARRIES A WORD. */}
      {outcome === null ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600">
          Nothing has been prepared yet. Choose a payroll run above. A return files what was
          actually paid, so it is built from a run&rsquo;s frozen payslips and never recomputed.
        </p>
      ) : !outcome.ok ? (
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {outcome.error}
        </p>
      ) : outcome.data.generated ? (
        <FileView file={outcome.data.file} />
      ) : (
        <RefusalView refusal={outcome.data.refusal} />
      )}

      <p className="text-xs text-slate-500">
        Due dates come from{" "}
        <Link href="/compliance" className="underline">
          the compliance calendar
        </Link>
        , which is the only place Ordence keeps them.
      </p>
    </main>
  );
}

type Outcome = Awaited<ReturnType<typeof generateStatutoryReturn>>;
type Generated = Extract<Extract<Outcome, { ok: true }>["data"], { generated: true }>;
type Refused = Extract<Extract<Outcome, { ok: true }>["data"], { generated: false }>;

function FileView({ file }: { file: Generated["file"] }) {
  return (
    <section className="space-y-4 rounded-lg border border-slate-200 p-4">
      <div>
        <h2 className="text-lg font-semibold">{file.title}</h2>
        <p className="text-sm text-slate-600">
          {file.lineCount} rows · {file.periodStart} to {file.periodEnd} · due {file.dueOn} to{" "}
          {file.dueAuthority}
        </p>
        <p className="mt-1 text-sm text-slate-600">{file.ifLate}</p>
      </div>

      {/* 🔴 THE UNVERIFIED LAYOUT IS ABOVE THE DOWNLOAD, NOT BELOW IT. */}
      {!file.confirmedAgainstPortal ? (
        <p className="flex gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            The layout of this file has <strong>not</strong> been confirmed against the live portal.
            Check the field order before the first upload. Source: {file.layoutSource}
          </span>
        </p>
      ) : null}

      <ReturnDownload
        fileName={file.fileName}
        text={file.text}
        confirmedAgainstPortal={file.confirmedAgainstPortal}
      />

      <div className="space-y-1 text-sm text-slate-700">
        <h3 className="font-medium">What this was built from</h3>
        <ul className="list-disc pl-5">
          {file.basis.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </div>

      <div className="space-y-1 text-sm text-slate-700">
        <h3 className="font-medium">Before you upload it</h3>
        <ul className="list-disc pl-5">
          {file.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>

      {file.findings.length > 0 ? (
        <div className="space-y-1 text-sm text-slate-700">
          <h3 className="font-medium">Things you could not otherwise have known</h3>
          <ul className="list-disc pl-5">
            {file.findings.map((f) => (
              <li key={`${f.code}-${f.subject}-${f.message}`}>
                <strong>{f.subject}</strong> — {f.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function RefusalView({ refusal }: { refusal: Refused["refusal"] }) {
  return (
    <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-amber-900">
        <FileWarning className="h-5 w-5" aria-hidden />
        No file was produced — {refusal.title}
      </h2>
      <p className="text-sm text-amber-900">{refusal.reason}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
        {refusal.findings.map((f) => (
          <li key={`${f.code}-${f.subject}-${f.message}`}>
            <strong>{f.subject}</strong> — {f.message}
          </li>
        ))}
      </ul>
      <p className="text-xs text-amber-800">
        A file that was not produced, with a named reason, costs an hour. A well-formed file with
        wrong numbers is accepted by the portal and becomes the employer&rsquo;s filed position.
      </p>
    </section>
  );
}
