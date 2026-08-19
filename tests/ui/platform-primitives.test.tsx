/**
 * Ordence — The Three Shared Console Primitives
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS WORTH ITS WEIGHT
 * ══════════════════════════════════════════════════════════════════════
 * `DataTable`, `CommandPalette` and `ConfirmDestructive` are consumed by
 * eight other console screens. A prop rename or a quietly dropped `id`
 * prefix does not break the component — it breaks the eight callers, one
 * screen at a time, in ways that look like eight unrelated bugs.
 *
 * So these tests assert the CONTRACT, not the pixels:
 *
 *   • every table parameter is namespaced by `id`, so two tables on one
 *     page cannot fight
 *   • a sort written to the URL is a sort read back out of it — that is
 *     the whole reason the state lives there
 *   • `j` / `k` / `x` are dead while the operator is typing
 *   • the palette's out-of-order guard actually holds when the SLOW,
 *     BROADER query lands last
 *   • the destructive confirm arms on the object's own name, trimmed and
 *     case-insensitive
 *
 * ⚠️ `next/navigation` IS MOCKED LOCALLY, NOT WITH `tests/ui/setup.ts`'s
 * VERSION. The shared mock returns a fresh empty `URLSearchParams` and
 * throws `replace` away, which is exactly the two things under test here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const replace = vi.fn();
const push = vi.fn();
let current = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push,
    replace,
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  // The path as the CONSOLE HOST serves it — `/tenants`, not
  // `/platform/tenants`. Every URL this table writes must be built
  // relative to it, never from a canonical literal.
  usePathname: () => "/tenants",
  useSearchParams: () => current,
  notFound: vi.fn(),
}));

import { DataTable } from "@/components/platform/data-table";
import { CommandPalette } from "@/components/platform/command-palette";
import { ConfirmDestructive } from "@/components/platform/confirm-destructive";
import {
  readDataTableParams,
  dataTableParamKeys,
} from "@/lib/platform/data-table-params";
import { consoleHref, CONSOLE_NAV } from "@/lib/platform/console-paths";

type Row = { id: string; name: string; mrrMinor: bigint };

const rows: Row[] = [
  { id: "a", name: "Zeta Infra", mrrMinor: 900_000_000_000n },
  { id: "b", name: "Alpha Builders", mrrMinor: 900_000_000_001n },
  { id: "c", name: "Chola Estates", mrrMinor: 5n },
];

const nameColumn = {
  key: "name",
  header: "Workspace",
  accessor: (r: Row) => r.name,
  sortable: true,
};
const mrrColumn = {
  key: "mrr",
  header: "MRR",
  accessor: (r: Row) => r.mrrMinor,
  sortable: true,
  align: "right" as const,
};

beforeEach(() => {
  replace.mockClear();
  push.mockClear();
  current = new URLSearchParams();
});

/* ------------------------------------------------------------------ */

describe("DataTable — the view is a URL", () => {
  it("⭐ writes namespaced parameters, relative to the path this host serves", () => {
    render(
      <DataTable<Row>
        id="ws"
        rows={rows}
        rowId={(r) => r.id}
        caption="Workspaces"
        columns={[nameColumn]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Workspace/ }));
    expect(replace).toHaveBeenCalledWith("/tenants?ws_sort=name&ws_dir=asc", {
      scroll: false,
    });
  });

  it("⭐ reads the sort back out of the URL — a refresh keeps the view", () => {
    current = new URLSearchParams("ws_sort=name&ws_dir=asc");
    render(
      <DataTable<Row>
        id="ws"
        rows={rows}
        rowId={(r) => r.id}
        caption="Workspaces"
        columns={[nameColumn]}
      />,
    );
    expect(screen.getAllByRole("columnheader")[0]?.getAttribute("aria-sort")).toBe(
      "ascending",
    );
    const first = screen.getAllByRole("row")[1];
    expect(first?.textContent).toContain("Alpha Builders");
  });

  it("🔴 sorts money as bigint — 900000000001 does not collapse into 900000000000", () => {
    current = new URLSearchParams("ws_sort=mrr&ws_dir=desc");
    render(
      <DataTable<Row>
        id="ws"
        rows={rows}
        rowId={(r) => r.id}
        caption="Workspaces"
        columns={[nameColumn, mrrColumn]}
      />,
    );
    const order = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent ?? "");
    expect(order[0]).toContain("Alpha Builders");
    expect(order[1]).toContain("Zeta Infra");
    expect(order[2]).toContain("Chola Estates");
  });

  it("🔴 two tables on one page do not collide", () => {
    current = new URLSearchParams("ws_sort=name&ws_dir=desc");
    render(
      <>
        <DataTable<Row>
          id="ws"
          rows={rows}
          rowId={(r) => r.id}
          caption="Workspaces"
          columns={[nameColumn]}
        />
        <DataTable<Row>
          id="usr"
          rows={rows}
          rowId={(r) => r.id}
          caption="Users"
          columns={[nameColumn]}
        />
      </>,
    );
    const sorts = screen.getAllByRole("columnheader").map((h) => h.getAttribute("aria-sort"));
    expect(sorts).toEqual(["descending", "none"]);
  });

  it("selection arrives from the URL and is reported to the parent", () => {
    current = new URLSearchParams("ws_sel=a");
    const onSelectionChange = vi.fn();
    render(
      <DataTable<Row>
        id="ws"
        rows={rows}
        rowId={(r) => r.id}
        caption="Workspaces"
        unit="workspaces"
        columns={[nameColumn]}
        selectable
        onSelectionChange={onSelectionChange}
      />,
    );
    expect(onSelectionChange).toHaveBeenCalledWith(["a"]);
    expect(screen.getByTestId("ws-count").textContent).toContain("1 selected");
  });

  it("j moves the focused row and x toggles its selection", () => {
    current = new URLSearchParams("ws_sel=a");
    render(
      <DataTable<Row>
        id="ws"
        rows={rows}
        rowId={(r) => r.id}
        caption="Workspaces"
        columns={[nameColumn]}
        selectable
      />,
    );
    fireEvent.keyDown(window, { key: "j" }); // focus row 0 — "a"
    fireEvent.keyDown(window, { key: "x" }); // deselect it
    expect(replace).toHaveBeenCalledWith("/tenants", { scroll: false });
  });

  it("🔴 the shortcuts are dead while the operator is typing in the filter", () => {
    render(
      <DataTable<Row>
        id="ws"
        rows={rows}
        rowId={(r) => r.id}
        caption="Workspaces"
        columns={[nameColumn]}
        selectable
        searchable
      />,
    );
    const input = screen.getByLabelText("Filter");
    input.focus();
    fireEvent.keyDown(input, { key: "x" });
    fireEvent.keyDown(input, { key: "j" });
    expect(replace).not.toHaveBeenCalled();
  });

  it("filtering resets the page — page 7 of the old list is not page 7 of the new one", () => {
    current = new URLSearchParams("ws_page=3");
    render(
      <DataTable<Row>
        id="ws"
        rows={rows}
        rowId={(r) => r.id}
        caption="Workspaces"
        columns={[nameColumn]}
        searchable
      />,
    );
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "alp" } });
    expect(replace).toHaveBeenCalledWith("/tenants?ws_q=alp", { scroll: false });
  });

  it("⭐ empty, loading and error are states with WORDS, not a blank area", () => {
    const base = {
      id: "t2",
      rows: [] as Row[],
      rowId: (r: Row) => r.id,
      caption: "Workspaces",
      unit: "workspaces",
      columns: [nameColumn],
    };
    const { rerender } = render(<DataTable<Row> {...base} status="loading" />);
    expect(screen.getByTestId("t2-count").textContent).toContain("Loading workspaces");

    rerender(<DataTable<Row> {...base} status="error" error="the database refused" />);
    expect(screen.getByRole("alert").textContent).toContain("the database refused");

    rerender(<DataTable<Row> {...base} />);
    expect(screen.getByText(/No workspaces yet/)).toBeTruthy();
  });

  it("announces the row count in a live region after a filter", () => {
    current = new URLSearchParams("ws_q=alpha");
    render(
      <DataTable<Row>
        id="ws"
        rows={rows}
        rowId={(r) => r.id}
        caption="Workspaces"
        unit="workspaces"
        columns={[nameColumn]}
        searchable
      />,
    );
    const region = screen.getByTestId("ws-count");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toContain("1 of 3 workspaces match these filters");
  });
});

/* ------------------------------------------------------------------ */

describe("readDataTableParams — the server half of the same contract", () => {
  it("namespaces by id", () => {
    expect(dataTableParamKeys("ws").sort).toBe("ws_sort");
    expect(dataTableParamKeys("ws").filter("plan")).toBe("ws_f_plan");
  });

  it("🔴 allow-lists the sort key and refuses a negative page", () => {
    const q = readDataTableParams(
      "ws",
      new URLSearchParams("ws_sort=name);DROP&ws_page=-3&ws_dir=sideways"),
      { sortKeys: ["name"], pageSize: 10 },
    );
    expect(q.sortKey).toBe(null);
    expect(q.sortDir).toBe("asc");
    expect(q.page).toBe(1);
    expect(q.offset).toBe(0);
  });

  it("🔴 returns selected ids unverified — they are input, never a permission", () => {
    const q = readDataTableParams("ws", new URLSearchParams("ws_sel=a, b ,,c"));
    expect(q.selectedIds).toEqual(["a", "b", "c"]);
  });

  it("drops a filter value that is not on its allow-list", () => {
    const q = readDataTableParams("ws", new URLSearchParams("ws_f_plan=free&ws_f_x=1"), {
      filterValues: { plan: ["pro", "scale"] },
    });
    expect(q.filters).toEqual({});
  });
});

/* ------------------------------------------------------------------ */

describe("CommandPalette", () => {
  it("opens on Ctrl+K and offers every console destination", async () => {
    render(<CommandPalette isConsoleHost={false} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    for (const item of CONSOLE_NAV) {
      expect(screen.getAllByText(item.label).length).toBeGreaterThan(0);
    }
  });

  it("🔴 maps every destination through consoleHref on the console host", async () => {
    render(<CommandPalette isConsoleHost />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByLabelText("Search the console");
    fireEvent.change(input, { target: { value: "action register" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // `/platform/log` on app., `/log` here. A canonical path on this host
    // is the 404 chain in lib/platform/console-paths.ts.
    expect(push).toHaveBeenCalledWith("/log");
  });

  it("⭐ a slow, broader response landing last does not overwrite a newer one", async () => {
    let resolveSlow: (value: never[]) => void = () => {};
    const searchWorkspaces = vi.fn((q: string) => {
      if (q === "ac") {
        return new Promise<never[]>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve([
        { id: "w1", name: "Acme Constructions", slug: "acme" },
      ] as never[]);
    });

    render(
      <CommandPalette
        isConsoleHost={false}
        searchWorkspaces={searchWorkspaces as never}
        debounceMs={5}
      />,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByLabelText("Search the console");

    fireEvent.change(input, { target: { value: "ac" } });
    await new Promise((r) => setTimeout(r, 25));
    fireEvent.change(input, { target: { value: "acme" } });
    await waitFor(() => expect(screen.getByText("Acme Constructions")).toBeTruthy());

    // The stale request now resolves. Its handler still runs — an
    // AbortController would not have stopped it — and the sequence number
    // is what keeps it off the screen.
    await act(async () => {
      resolveSlow([]);
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(screen.getByText("Acme Constructions")).toBeTruthy();
  });

  it("runs a page-supplied action and closes first", async () => {
    const run = vi.fn();
    render(
      <CommandPalette
        isConsoleHost={false}
        actions={[{ id: "suspend", label: "Suspend this workspace", run }]}
      />,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByLabelText("Search the console");
    fireEvent.change(input, { target: { value: "suspend" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ */

describe("ConfirmDestructive", () => {
  const props = {
    open: true,
    onOpenChange: () => {},
    objectName: "Acme Constructions",
    actionLabel: "Suspend workspace",
    consequence: "Every user in this workspace is signed out immediately.",
  };

  it("⭐ renders the consequence prominently, in words", () => {
    render(<ConfirmDestructive {...props} onConfirm={vi.fn()} />);
    expect(screen.getByTestId("danger-headline").textContent).toContain(
      "signed out immediately",
    );
  });

  it("⭐ arms on the object's OWN name, trimmed and case-insensitive", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDestructive {...props} onConfirm={onConfirm} />);
    const button = screen.getByRole("button", { name: "Suspend workspace" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Type the workspace name/), {
      target: { value: "  acme   constructions " },
    });
    fireEvent.change(screen.getByLabelText("Why are you doing this?"), {
      target: { value: "ZD-4471 repeated abuse reports from three customers" },
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith({
      reason: "ZD-4471 repeated abuse reports from three customers",
    });
  });

  it("refuses a reason below the caller's minimum", () => {
    render(<ConfirmDestructive {...props} minReasonLength={40} onConfirm={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Type the workspace name/), {
      target: { value: "Acme Constructions" },
    });
    fireEvent.change(screen.getByLabelText("Why are you doing this?"), {
      target: { value: "asked to" },
    });
    const button = screen.getByRole("button", { name: "Suspend workspace" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("says what does NOT happen when the caller supplies nothing", () => {
    render(<ConfirmDestructive {...props} onConfirm={vi.fn()} />);
    expect(screen.getByText(/platform action register/)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */

describe("consoleHref", () => {
  it("maps the console host's base path, and leaves app. alone", () => {
    expect(consoleHref("/platform/tenants", true)).toBe("/tenants");
    expect(consoleHref("/platform", true)).toBe("/");
    expect(consoleHref("/platform/sessions?live=1", true)).toBe("/sessions?live=1");
    expect(consoleHref("/platform/tenants", false)).toBe("/platform/tenants");
  });
});
