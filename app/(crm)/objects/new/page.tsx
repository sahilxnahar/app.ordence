/**
 * Ordence — Define A Record Type
 * Version: v0.27.0-alpha
 * Runtime: Node
 *
 * ⚠️ THE SERVER ACTION IS PASSED TO THE CLIENT COMPONENT, NOT IMPORTED BY
 * IT. `server/actions/dynamic-objects.ts` reaches the database through
 * `server/dynamic/*`, which is `server-only`; importing it from a
 * `"use client"` file would drag the whole server graph toward the bundle
 * and make the designer impossible to render in a test. Same pattern as
 * `app/(crm)/automations/page.tsx`.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  createDynamicObject,
  listDynamicObjects,
} from "@/server/actions/dynamic-objects";
import { ObjectDesigner } from "@/components/dynamic/object-designer";
import { relationTargets } from "../mapping";
import { Refusal } from "../refusal";

export const dynamic = "force-dynamic";

export default function NewObjectPage() {
  return (
    <div className="p-6">
      <div className="mb-5">
        <p className="text-xs text-muted-foreground">
          <Link href="/objects" className="hover:underline">
            Record types
          </Link>{" "}
          / New
        </p>
        <h1 className="mt-1 text-2xl font-bold">New record type</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing is created until you press the button at the bottom, and then the
          table and every column are created together — either all of it or none of it.
        </p>
      </div>

      <Suspense fallback={<Skeleton />}>
        <DesignerView />
      </Suspense>
    </div>
  );
}

async function DesignerView() {
  const existing = await listDynamicObjects();
  if (!existing.ok) return <Refusal message={existing.error} />;

  return (
    <ObjectDesigner
      object={null}
      fields={[]}
      objectCount={existing.data.rows.length}
      relationTargets={relationTargets(existing.data.rows)}
      actions={{ onCreate: createDynamicObject }}
    />
  );
}

function Skeleton() {
  return <div className="h-96 animate-pulse rounded-lg border border-border bg-muted/30" />;
}
