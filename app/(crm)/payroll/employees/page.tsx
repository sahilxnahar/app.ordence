/**
 * Ordence — ⭐⭐ EMPLOYEES
 * Version: v1.23.0-alpha · Batch 15
 *
 * ⚠️ SEPARATE FROM SITE LABOUR ON PURPOSE. Contract labour is brought by
 * a vendor and paid through that vendor's RA bill. Giving them payslips
 * would misstate the employment relationship in a way a labour inspector
 * cares about, so the two populations never mix.
 */

import Link from "next/link";
import {
  getEmployeeStructure,
  listEmployees,
  listPayComponents,
  saveEmployee,
  setPayStructure,
} from "@/server/actions/payroll";
import {
  EmployeeBoard,
  type ComponentView,
  type EmployeeView,
  type StructureView,
} from "@/components/payroll/employee-board";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employees · Ordence" };

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "");
}

export default async function EmployeesPage() {
  const [people, components, manage] = await Promise.all([
    listEmployees(),
    listPayComponents(),
    checkPermission("payroll.manage"),
  ]);

  if (!people.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Employees</h1>
        <p className="text-sm text-destructive">{people.error}</p>
      </main>
    );
  }

  const employees: EmployeeView[] = people.data.rows.map((e) => ({
    id: String(e.id),
    employeeCode: String(e.employeeCode),
    fullName: String(e.fullName),
    designation: e.designation ? String(e.designation) : null,
    department: e.department ? String(e.department) : null,
    workStateCode: String(e.workStateCode),
    joinedOn: iso(e.joinedOn),
    leftOn: e.leftOn ? iso(e.leftOn) : null,
    // ⚠️ A BOOLEAN, NEVER THE PAN ITSELF. The screen needs to know
    // whether tax can be withheld; it does not need to publish a tax
    // identifier to everybody who can read the list.
    hasPan: Boolean(e.pan),
    pfExempt: Boolean(e.pfExempt),
    esiExempt: Boolean(e.esiExempt),
    taxRegime: String(e.taxRegime ?? "new"),
  }));

  const structures: Record<string, StructureView[]> = {};
  for (const e of employees) {
    const s = await getEmployeeStructure(e.id);
    structures[e.id] = s.ok
      ? s.data.rows.map((row) => ({
          id: String(row.id),
          componentId: String(row.componentId),
          code: String(row.code),
          label: String(row.label),
          kind: String(row.kind),
          monthlyAmountMinor: String(row.monthlyAmountMinor),
          effectiveFrom: iso(row.effectiveFrom),
          effectiveTo: row.effectiveTo ? iso(row.effectiveTo) : null,
        }))
      : [];
  }

  const componentViews: ComponentView[] = components.ok
    ? components.data.rows.map((c) => ({
        id: String(c.id),
        code: String(c.code),
        label: String(c.label),
        kind: String(c.kind),
      }))
    : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link href="/payroll" className="text-xs underline">
          Payroll
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Employees</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          People on your own payroll. Ordence records no Aadhaar and no bank account number — it
          accrues what is owed and the transfer is made in your bank&apos;s own portal.
        </p>
      </div>

      {componentViews.length === 0 ? (
        <p className="rounded border border-amber-500 p-3 text-sm">
          There are no pay components yet, so there is nothing to pay anybody with.{" "}
          <Link href="/payroll/setup" className="underline">
            Seed the starter set
          </Link>{" "}
          first.
        </p>
      ) : null}

      <EmployeeBoard
        employees={employees}
        components={componentViews}
        structures={structures}
        canManage={manage.allowed}
        onSaveEmployee={saveEmployee}
        onSetStructure={setPayStructure}
      />
    </main>
  );
}
