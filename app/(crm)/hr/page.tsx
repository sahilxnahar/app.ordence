/**
 * Ordence — ⭐ HR
 * Version: v1.47.0-alpha · Batch 109
 *
 * ⚠️ A SIGNPOST, NOT A DASHBOARD. The three screens under it are guarded
 * by three different keys and one of them by no key at all, so a landing
 * page that fetched anything would refuse the very reader who is allowed
 * on `/hr/me`. It links, and the destinations decide.
 */

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "HR · Ordence" };

const SECTIONS = [
  {
    href: "/hr/me",
    title: "My appraisal",
    body: "Your own appraisal and the appraisals of the people who report to you. Open to everybody with an employee record; shows nobody else's.",
  },
  {
    href: "/hr/org-chart",
    title: "Org chart",
    body: "Who reports to whom, who has left and who is still pointed at them, and who has no reporting line at all.",
  },
  {
    href: "/hr/appraisals",
    title: "Appraisal cycles",
    body: "The whole register: who is reviewed, by whom, over what period, and the signed-off outcome. Needs the HR permission.",
  },
];

export default function HrPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">HR</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The reporting hierarchy and the appraisal cycle. Nothing here changes anybody&rsquo;s
          pay — an increment is entered on the payroll screen by whoever runs payroll.
        </p>
      </div>

      <div className="space-y-3">
        {SECTIONS.map((s) => (
          <Card key={s.href}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                <Link href={s.href} className="underline">
                  {s.title}
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{s.body}</CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
