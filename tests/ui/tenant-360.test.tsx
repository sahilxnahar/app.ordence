/**
 * Ordence — Tenant 360: the tab in the URL, and the refusal on the screen
 * Version: v1.52.0-alpha (Batch 125)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE FOR, AND WHAT THEY DELIBERATELY DO NOT PIN
 * ══════════════════════════════════════════════════════════════════════
 * Three properties of this screen are load-bearing, and all three are the
 * kind that break silently:
 *
 *   ① THE TAB IS THE URL. A link pasted into a ticket has to land on the
 *      tab the writer meant, on EITHER of the console's two base paths.
 *   ② A REFUSAL IS VISIBLE AND THE VALUE ROLLS BACK. The optimistic
 *      number is a display convenience; if the server says no, the
 *      operator must see the refusal AND the number the workspace is
 *      actually on. A silent revert is how somebody promises a customer
 *      25 seats they do not have.
 *   ③ MONEY SURVIVES AS `bigint`. A per-seat price multiplied by a seat
 *      count must not lose a paisa to a float.
 *
 * ⚠️ THE ASSERTIONS ARE PROPERTIES, NOT STRINGS. Nothing here pins a
 * sentence, a class name, a file path or a literal href — a copy edit to
 * a refusal message is an improvement, and a test that fails on it is a
 * test that teaches people not to improve messages. What is asserted is:
 * the tab written equals the tab clicked; the alert names BOTH numbers;
 * the amount rendered contains the exact digits `bigint` produced.
 *
 * ⚠️ `next/navigation` IS MOCKED LOCALLY. The shared mock in
 * `tests/ui/setup.ts` throws `replace` away and hands back a fresh empty
 * `URLSearchParams`, which is precisely the pair of things under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";

const replace = vi.fn();
let current = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace,
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  /*
   * ⚠️ THE PATH AS THE CONSOLE HOST SERVES IT — `/tenants/:id`, not
   * `/platform/tenants/:id`. Every URL this screen writes must be built
   * from this, never from a canonical literal, or the link is a 404 on
   * exactly one of the two hosts.
   */
  usePathname: () => "/tenants/abc",
  useSearchParams: () => current,
  notFound: vi.fn(),
}));

import { TenantTabs } from "@/components/platform/tenant-tabs";
import { PlanSeatsCard } from "@/components/platform/plan-seats-card";
import { IncidentsNotWiredPanel } from "@/components/platform/tenant-panels";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "plan", label: "Plan and seats" },
  { value: "billing", label: "Billing" },
] as const;

const PANELS = {
  overview: <p>overview-body</p>,
  plan: <p>plan-body</p>,
  billing: <p>billing-body</p>,
};

beforeEach(() => {
  replace.mockClear();
  current = new URLSearchParams();
});

describe("Tenant 360 · the tab lives in the URL", () => {
  it("renders the tab the query string asks for, not the first one", () => {
    current = new URLSearchParams("tab=billing");
    render(<TenantTabs tabs={TABS} panels={PANELS} />);
    expect(screen.getByText("billing-body")).toBeTruthy();
  });

  it("falls back to the first tab when the query string names one that does not exist", () => {
    // Tabs get renamed; links in six-month-old tickets do not. The
    // fallback is what stops such a link rendering an empty screen.
    current = new URLSearchParams("tab=whatever-this-used-to-be-called");
    render(<TenantTabs tabs={TABS} panels={PANELS} />);
    expect(screen.getByText("overview-body")).toBeTruthy();
  });

  it("writes the clicked tab to the URL, on whatever base path this host serves", () => {
    render(<TenantTabs tabs={TABS} panels={PANELS} />);
    // ⚠️ `mouseDown`, not `click`. Radix activates a tab on mousedown so
    // that a drag started on a trigger still switches — `fireEvent.click`
    // never dispatches mousedown, so it would test nothing.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Billing" }), { button: 0 });

    expect(replace).toHaveBeenCalled();
    const written = String(replace.mock.calls.at(-1)?.[0]);
    const [path, query] = written.split("?");

    // The PROPERTY: the path came from usePathname, so it carries no
    // hard-coded `/platform` prefix — and the tab written is the tab
    // clicked. Neither assertion cares what the tab is called.
    expect(path.startsWith("/platform")).toBe(false);
    expect(new URLSearchParams(query).get("tab")).toBe("billing");
  });

  it("keeps the other query parameters, so a table's sort survives a tab change", () => {
    // The shared DataTable namespaces its own params onto this same URL.
    // Dropping them here would silently reset an operator's filters every
    // time they looked at another tab.
    current = new URLSearchParams("tab=overview&tenant-activity.q=suspend");
    render(<TenantTabs tabs={TABS} panels={PANELS} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Plan and seats" }), {
      button: 0,
    });

    const query = String(replace.mock.calls.at(-1)?.[0]).split("?")[1];
    const params = new URLSearchParams(query);
    expect(params.get("tab")).toBe("plan");
    expect(params.get("tenant-activity.q")).toBe("suspend");
  });
});

/* ------------------------------------------------------------------ */

const BASE = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  tenantName: "Acme Constructions",
  planTier: "basic",
  seatLimit: 10,
  seatsInUse: 8,
  storageLimitMb: 5000,
  storageUsedMb: 1200,
  mrrMinor: "500000",
  perSeatMinor: "49900",
  currency: "INR",
  canEdit: true,
};

/** Drive the confirm dialog the way an operator does. */
async function confirmWith(reason: string) {
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/type the workspace name/i), {
    target: { value: BASE.tenantName },
  });
  fireEvent.change(within(dialog).getByLabelText(/why are you doing this/i), {
    target: { value: reason },
  });
  const confirm = within(dialog)
    .getAllByRole("button")
    .find((b) => /change plan and limits/i.test(b.textContent ?? ""));
  await act(async () => {
    fireEvent.click(confirm!);
  });
}

describe("Tenant 360 · plan and seats, and the refusal that must not be swallowed", () => {
  it("shows the refusal AND the value the workspace is actually on", async () => {
    // The server's words, whatever they are. The test supplies them and
    // then only asserts they reached the screen — it does not know or
    // care what the server chooses to say.
    const serverSaid = "That plan is not sold in this region any more.";
    const onSave = vi.fn().mockResolvedValue({ ok: false, error: serverSaid });

    render(<PlanSeatsCard {...BASE} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText("Seat limit"), { target: { value: "25" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("plan-save"));
    });
    await confirmWith("Customer asked for more seats on the renewal call.");

    const alert = await screen.findByTestId("plan-refusal");

    // ① the server's own explanation reached the operator
    expect(alert.textContent).toContain(serverSaid);
    // ② what was attempted is named
    expect(alert.textContent).toContain("25");
    // ③ and so is what is actually true — this is the rollback being
    //    VISIBLE rather than a number quietly flicking back
    expect(alert.textContent).toContain(String(BASE.seatLimit));
    // ④ and the displayed seat figure is the server's, not the optimistic one
    expect(screen.getByTestId("seats-shown").textContent).toContain(
      `of ${BASE.seatLimit}`,
    );
  });

  it("sends the over-commit acknowledgement when the new ceiling is below what is used", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(<PlanSeatsCard {...BASE} onSave={onSave} />);

    // 8 people already hold seats; 3 is below that.
    fireEvent.change(screen.getByLabelText("Seat limit"), { target: { value: "3" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("plan-save"));
    });
    await confirmWith("Downgrading to the smaller plan they signed for.");

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const sent = onSave.mock.calls.at(-1)?.[0];
    expect(sent.acceptOverCommit).toBe(true);
    expect(sent.seatLimit).toBe(3);
    // The reason is EVIDENCE — it lands verbatim in the customer's audit
    // log, so it must reach the server unaltered.
    expect(sent.reason).toContain("Downgrading");
  });

  it("never lets a grade without the capability arm the form", () => {
    render(<PlanSeatsCard {...BASE} canEdit={false} onSave={vi.fn()} />);
    // Disabled, not hidden: a hidden control teaches an engineer the
    // capability does not exist.
    expect((screen.getByTestId("plan-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("multiplies the per-seat price in bigint, so no paisa is lost to a float", () => {
    // One paisa above 2^53. A float loses it; bigint does not. The
    // assertion is on the DIGITS, which is the property that matters —
    // not on the formatter's choice of separators.
    const onSave = vi.fn();
    render(
      <PlanSeatsCard
        {...BASE}
        seatLimit={1}
        seatsInUse={0}
        perSeatMinor="9007199254740993"
        onSave={onSave}
      />,
    );

    const exact = (9007199254740993n / 100n).toString();
    const body = document.body.textContent ?? "";
    expect(body).toContain(exact);
    expect(body).toContain("93"); // the surviving paise
  });
});

/* ------------------------------------------------------------------ */

describe("Tenant 360 · the Incidents tab is honest about being unwired", () => {
  it("names the missing pieces instead of listing incidents it never checked", () => {
    render(
      <IncidentsNotWiredPanel
        tenantName="Acme Constructions"
        incidentsHref="/incidents"
      />,
    );
    const panel = screen.getByTestId("incidents-not-wired");

    // The PROPERTY: a reader can act on this. It names the column that
    // has no resolver and the function that takes no tenant argument —
    // both are identifiers, so they change only when the code does.
    expect(panel.textContent).toContain("affected_filter");
    expect(panel.textContent).toContain("getIncidents");

    // And the escape hatch goes wherever the server said, on whichever
    // host — not to a hard-coded `/platform/...` that 404s on admin.
    const link = within(panel).getByRole("link");
    expect(link.getAttribute("href")).toBe("/incidents");
  });
});
