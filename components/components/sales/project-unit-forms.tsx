"use client";

/**
 * Ordence — 🔴🔴🔴 THE FIRST PROJECT AND THE FIRST UNIT
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FORTY-THREE REACHABLE ACTIONS READ `projects` OR `units`
 * ══════════════════════════════════════════════════════════════════════
 * `createProject` and `createUnit` are the only inserts into those two
 * tables and nothing called either. Bookings, the payment plan, the
 * inventory grid, cost control, RA bills, BOQ, meters, rate cards, the
 * cost-centre P&L, the statutory due list, credit notes, timesheets and
 * the piece-rate entry all read one of them. The entire real-estate
 * vertical was reading two tables that could not receive a row.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ CARPET AREA IS THE BASIS OF SALE, AND THAT IS THE STATUTE
 * ══════════════════════════════════════════════════════════════════════
 * s.4(2)(l)(C) and the definition in s.2(k) of RERA 2016 make CARPET
 * AREA the basis on which an apartment is sold. Super built-up is not a
 * lawful basis of sale and quoting on it is the practice RERA exists to
 * end.
 *
 * 🔴 THE BUILT-UP AREA CANNOT BE SMALLER THAN THE CARPET AREA, and the
 * validator refuses it with the reason: it is physically impossible, and
 * it is the shape of typo — two numbers in adjacent fields — that gets
 * caught by nobody and then prices a flat.
 *
 * ⚠️ **THE RERA NUMBER IS OPTIONAL AND THAT IS DELIBERATE.** Advertising
 * without one is an offence under s.3, but a project exists long before
 * it is registered. Refusing to record a project until the certificate
 * arrives would push the whole pre-launch pipeline into a spreadsheet,
 * which is worse for exactly the compliance this is meant to serve. The
 * field says what it is for instead.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type ProjectOption = {
  id: string;
  code: string;
  name: string;
  /**
   * ⭐ WAVE 10 — the editable fields, so "edit a project" does not need a
   * second read action. `listProjects` already returns the whole row; the
   * page was throwing all but two columns away.
   */
  description?: string | null;
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  reraNumber?: string | null;
};

const BLANK_PROJECT = {
  code: "",
  name: "",
  description: "",
  addressLine: "",
  city: "",
  state: "",
  reraNumber: "",
  startedAt: "",
  expectedCompletionAt: "",
};

const BLANK_UNIT = {
  projectId: "",
  code: "",
  tower: "",
  floor: "",
  typology: "",
  carpetAreaSqft: "",
  builtUpAreaSqft: "",
  facing: "",
  price: "",
};

function Errors({ list }: { list?: string[] }) {
  if (!list) return null;
  return (
    <>
      {list.map((m) => (
        <p key={m} className="text-xs text-destructive">
          {m}
        </p>
      ))}
    </>
  );
}

export function ProjectUnitForms({
  projects,
  createProjectAction,
  createUnitAction,
  /**
   * ⭐⭐ WAVE 10 — `updateProject` HAD NO CALLER ANYWHERE.
   *
   * 🔴 A project's RERA registration number could be created and never
   * corrected. That number goes on every demand notice, every allotment
   * letter and every advertisement the promoter publishes; a typo in it
   * is a statutory disclosure that is wrong on every document until
   * somebody edits the database by hand.
   *
   * ⚠️ EDITING REUSES THE CREATE FORM rather than getting its own
   * screen. Two forms over the same eleven fields is two places for a
   * field to be forgotten, and the field that gets forgotten is always
   * the one added last.
   */
  updateProjectAction,
}: {
  projects: readonly ProjectOption[];
  createProjectAction: (i: unknown) => Promise<Result<{ id: string }>>;
  createUnitAction: (i: unknown) => Promise<Result<{ id: string }>>;
  updateProjectAction?: (i: unknown) => Promise<Result<{ id: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [which, setWhich] = useState<"none" | "project" | "unit">("none");
  /** Set while editing an existing project; null while creating one. */
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [proj, setProj] = useState({ ...BLANK_PROJECT });
  const [unit, setUnit] = useState({ ...BLANK_UNIT });
  const [fe, setFe] = useState<Record<string, string[]>>({});

  /**
   * 🔴 THE AREA CHECK, MIRRORED FROM `unitAreaCoherent` SO THE PERSON
   * SEES IT WHILE THEY ARE STILL LOOKING AT BOTH NUMBERS. The server
   * refuses it too; this is about which of the two figures they correct.
   */
  const carpet = Number(unit.carpetAreaSqft || "0");
  const built = Number(unit.builtUpAreaSqft || "0");
  const areaProblem =
    carpet > 0 && built > 0 && built < carpet
      ? "The built-up area cannot be smaller than the carpet area. Check the two figures."
      : null;

  /**
   * ⭐ WAVE 10 — load an existing project into the same form.
   *
   * ⚠️ THE DATES ARE NOT LOADED. `listProjects` returns them as `Date`
   * objects and the inputs want `yyyy-mm-dd` strings; converting in a
   * client component would apply the browser's timezone to a civil date
   * and shift a March 31 start into March 30 for anybody west of UTC.
   * Leaving them blank means `updateProject` receives no date field and
   * leaves the stored one alone, which is the correct outcome for a form
   * that is not asking about them.
   */
  function editProject(option: ProjectOption) {
    setFe({});
    setEditingProjectId(option.id);
    setProj({
      ...BLANK_PROJECT,
      code: option.code,
      name: option.name,
      description: option.description ?? "",
      addressLine: option.addressLine ?? "",
      city: option.city ?? "",
      state: option.state ?? "",
      reraNumber: option.reraNumber ?? "",
    });
    setWhich("project");
  }

  function submitProject() {
    setFe({});
    startTransition(async () => {
      const editing = editingProjectId !== null;
      const payload = {
        code: proj.code.trim(),
        name: proj.name.trim(),
        description: proj.description.trim() || null,
        addressLine: proj.addressLine.trim() || null,
        city: proj.city.trim() || null,
        state: proj.state.trim() || null,
        reraNumber: proj.reraNumber.trim() || null,
        startedAt: proj.startedAt || null,
        expectedCompletionAt: proj.expectedCompletionAt || null,
      };

      const res =
        editing && updateProjectAction
          ? await updateProjectAction({ id: editingProjectId, ...payload })
          : await createProjectAction(payload);

      if (!res.ok) {
        if (res.fieldErrors) setFe(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(`${proj.name.trim()} ${editing ? "updated" : "created"}.`);
      setProj({ ...BLANK_PROJECT });
      setEditingProjectId(null);
      setWhich("none");
    });
  }

  function submitUnit() {
    setFe({});
    startTransition(async () => {
      const res = await createUnitAction({
        projectId: unit.projectId,
        code: unit.code.trim(),
        tower: unit.tower.trim() || null,
        floor: unit.floor ? Number(unit.floor) : null,
        typology: unit.typology.trim() || null,
        carpetAreaSqft: unit.carpetAreaSqft
          ? Number(unit.carpetAreaSqft)
          : null,
        builtUpAreaSqft: unit.builtUpAreaSqft
          ? Number(unit.builtUpAreaSqft)
          : null,
        facing: unit.facing.trim() || null,
        price: unit.price.trim() || null,
      });
      if (!res.ok) {
        if (res.fieldErrors) setFe(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(`Unit ${unit.code.trim()} added.`);
      setUnit({ ...BLANK_UNIT, projectId: unit.projectId });
      setWhich("none");
    });
  }

  if (which === "none") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setEditingProjectId(null);
            setProj({ ...BLANK_PROJECT });
            setWhich("project");
          }}
        >
          Add a project
        </Button>

        {/*
          ⭐⭐ WAVE 10 — EDIT, WHICH DID NOT EXIST. `updateProject` had no
          caller. The RERA number in particular goes on every demand
          notice and every advertisement, and a typo in it was permanent
          short of editing the database by hand.
        */}
        {updateProjectAction && projects.length > 0 && (
          <select
            aria-label="Edit a project"
            value=""
            onChange={(e) => {
              const option = projects.find((project) => project.id === e.target.value);
              if (option) editProject(option);
            }}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Edit a project…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} , {project.name}
              </option>
            ))}
          </select>
        )}
        <Button
          variant="secondary"
          disabled={projects.length === 0}
          onClick={() => setWhich("unit")}
        >
          Add a unit
        </Button>
        {projects.length === 0 && (
          <span className="self-center text-xs text-muted-foreground">
            A unit belongs to a project. Create the project first.
          </span>
        )}
      </div>
    );
  }

  if (which === "project") {
    return (
      <div className="space-y-4 rounded-md border p-4 text-sm">
        <p className="font-medium">
          {editingProjectId ? "Edit this project" : "Add a project"}
        </p>
        {editingProjectId && (
          <p className="text-xs text-muted-foreground">
            The start and completion dates are left as they are , this form does not ask
            about them, and a date read back through the browser&rsquo;s timezone would move
            by a day.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="p-code">Code</Label>
            <Input
              id="p-code"
              value={proj.code}
              placeholder="AMEYA-H"
              onChange={(e) => setProj({ ...proj, code: e.target.value })}
            />
            <Errors list={fe.code} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="p-name">Name</Label>
            <Input
              id="p-name"
              value={proj.name}
              onChange={(e) => setProj({ ...proj, name: e.target.value })}
            />
            <Errors list={fe.name} />
          </div>
          <div className="space-y-1 sm:col-span-3">
            <Label htmlFor="p-addr">Address</Label>
            <Input
              id="p-addr"
              value={proj.addressLine}
              onChange={(e) =>
                setProj({ ...proj, addressLine: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="p-city">City</Label>
            <Input
              id="p-city"
              value={proj.city}
              onChange={(e) => setProj({ ...proj, city: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="p-state">State</Label>
            <Input
              id="p-state"
              value={proj.state}
              onChange={(e) => setProj({ ...proj, state: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="p-rera">RERA registration number</Label>
            <Input
              id="p-rera"
              value={proj.reraNumber}
              onChange={(e) =>
                setProj({ ...proj, reraNumber: e.target.value })
              }
            />
            {/**
             * ⚠️ OPTIONAL, AND THE COPY EXPLAINS WHY RATHER THAN LEAVING
             * IT LOOKING LIKE AN OVERSIGHT.
             */}
            <p className="text-xs text-muted-foreground">
              Leave blank until the certificate arrives. ⚠️ Advertising or
              selling before registration is an offence under s.3 RERA, so
              fill this in before either.
            </p>
            <Errors list={fe.reraNumber} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="p-start">Started</Label>
            <Input
              id="p-start"
              type="date"
              value={proj.startedAt}
              onChange={(e) => setProj({ ...proj, startedAt: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="p-end">Expected completion</Label>
            <Input
              id="p-end"
              type="date"
              value={proj.expectedCompletionAt}
              onChange={(e) =>
                setProj({ ...proj, expectedCompletionAt: e.target.value })
              }
            />
            {/**
             * ⚠️ THE DATE THE DELAY LADDER IS MEASURED AGAINST. s.18
             * RERA gives an allottee the right to withdraw with interest
             * where possession is not handed over by the date in the
             * agreement.
             */}
            <p className="text-xs text-muted-foreground">
              The date s.18 RERA measures a delay against.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              pending || proj.code.trim() === "" || proj.name.trim() === ""
            }
            onClick={submitProject}
          >
            {editingProjectId ? "Save the project" : "Create the project"}
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setWhich("none");
              setProj({ ...BLANK_PROJECT });
              setEditingProjectId(null);
              setFe({});
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="u-proj">Project</Label>
          <select
            id="u-proj"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={unit.projectId}
            onChange={(e) => setUnit({ ...unit, projectId: e.target.value })}
          >
            <option value="">Choose…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-code">Unit number</Label>
          <Input
            id="u-code"
            value={unit.code}
            placeholder="A-1203"
            onChange={(e) => setUnit({ ...unit, code: e.target.value })}
          />
          <Errors list={fe.code} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-tower">Tower</Label>
          <Input
            id="u-tower"
            value={unit.tower}
            onChange={(e) => setUnit({ ...unit, tower: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-floor">Floor</Label>
          <Input
            id="u-floor"
            inputMode="numeric"
            value={unit.floor}
            onChange={(e) => setUnit({ ...unit, floor: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-typ">Typology</Label>
          <Input
            id="u-typ"
            value={unit.typology}
            placeholder="3BHK"
            onChange={(e) => setUnit({ ...unit, typology: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-facing">Facing</Label>
          <Input
            id="u-facing"
            value={unit.facing}
            onChange={(e) => setUnit({ ...unit, facing: e.target.value })}
          />
        </div>
      </div>

      <div className="grid gap-4 rounded-md border border-dashed p-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="u-carpet">Carpet area, sq ft</Label>
          <Input
            id="u-carpet"
            inputMode="numeric"
            value={unit.carpetAreaSqft}
            onChange={(e) =>
              setUnit({ ...unit, carpetAreaSqft: e.target.value })
            }
          />
          {/**
           * 🔴 THE BASIS OF SALE, AND IT IS THE STATUTE RATHER THAN A
           * CONVENTION. s.2(k) with s.4(2)(l)(C) RERA 2016.
           */}
          <p className="text-xs text-muted-foreground">
            🔴 The basis of sale. s.2(k) with s.4(2)(l)(C) RERA 2016. Super
            built-up is not a lawful basis and quoting on it is the practice
            RERA exists to end.
          </p>
          <Errors list={fe.carpetAreaSqft} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-built">Built-up area, sq ft</Label>
          <Input
            id="u-built"
            inputMode="numeric"
            value={unit.builtUpAreaSqft}
            onChange={(e) =>
              setUnit({ ...unit, builtUpAreaSqft: e.target.value })
            }
          />
          <Errors list={fe.builtUpAreaSqft} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-price">Price, in paise</Label>
          <Input
            id="u-price"
            inputMode="numeric"
            value={unit.price}
            onChange={(e) => setUnit({ ...unit, price: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            ₹85,00,000 is 850000000.
          </p>
          <Errors list={fe.price} />
        </div>
        {areaProblem && (
          <p className="text-xs text-destructive sm:col-span-3">
            🔴 {areaProblem} Two numbers in adjacent fields is the shape of
            typo nobody catches, and it prices a flat.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            pending ||
            unit.projectId === "" ||
            unit.code.trim() === "" ||
            areaProblem !== null
          }
          onClick={submitUnit}
        >
          Add the unit
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setWhich("none");
            setUnit({ ...BLANK_UNIT });
            setFe({});
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
