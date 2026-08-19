/**
 * Ordence — Double-Entry Balance Gate
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 7 MANDATORY VERIFICATION #2
 * ══════════════════════════════════════════════════════════════════════
 * "Ensure the double-entry accounting form physically prevents submission
 *  if debits and credits do not equal zero."
 *
 * These tests DRIVE THE REAL FORM through real keyboard input and then
 * look at the submit button. The point is not that the code contains a
 * `disabled` expression — it is that a person typing unbalanced numbers
 * cannot get the entry through.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS IS THE FIRST OF THREE GATES, AND THE WEAKEST ONE
 * ══════════════════════════════════════════════════════════════════════
 * A disabled button stops an honest mistake. It stops nothing else —
 * anyone with dev-tools can re-enable it. The other two gates are what
 * actually protect the ledger:
 *
 *   2. `postTransactionSchema.superRefine` re-checks the balance server-side
 *      in exact BigInt arithmetic (covered in the security suite).
 *   3. A DEFERRABLE INITIALLY DEFERRED constraint trigger in PostgreSQL
 *      refuses the COMMIT (covered by `accounting-triggers.test.ts`).
 *
 * These tests cover gate 1 only, and are honest about that.
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const postTransaction = vi.fn(async () => ({ ok: true as const, data: { id: "t1" } }));

vi.mock("@/server/actions/accounting", () => ({
  postTransaction: (...args: unknown[]) => postTransaction(...(args as [])),
}));

import { JournalEntryForm, type LedgerOption } from "@/app/(crm)/accounting/journal-form";

const LEDGERS: LedgerOption[] = [
  { id: "11111111-1111-4111-8111-111111111111", code: "1100", name: "Bank — Current", type: "operating" },
  { id: "22222222-2222-4222-8222-222222222222", code: "4100", name: "Sales Revenue", type: "operating" },
  { id: "33333333-3333-4333-8333-333333333333", code: "1200", name: "Bank — Trust", type: "trust" },
];

function setup(lockedDates: Array<{ name: string; startDate: string; endDate: string }> = []) {
  render(<JournalEntryForm ledgers={LEDGERS} lockedDates={lockedDates} />);
  return userEvent.setup();
}

/** The submit button, found by its accessible name. */
function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /post|saving/i }) as HTMLButtonElement;
}

/** All amount inputs, in leg order. */
function amountInputs(): HTMLInputElement[] {
  return screen.getAllByLabelText(/amount/i) as HTMLInputElement[];
}

function ledgerSelects(): HTMLSelectElement[] {
  return screen.getAllByLabelText(/ledger|account/i) as HTMLSelectElement[];
}

describe("Double-entry journal form — the balance gate", () => {
  beforeEach(() => {
    postTransaction.mockClear();
  });

  it("starts with submission blocked on an empty form", () => {
    setup();
    expect(submitButton()).toBeDisabled();
  });

  it("BLOCKS submission when debits and credits do not match", async () => {
    const user = setup();

    const [debitLedger, creditLedger] = ledgerSelects();
    await user.selectOptions(debitLedger!, LEDGERS[0]!.id);
    await user.selectOptions(creditLedger!, LEDGERS[1]!.id);

    const [debitAmount, creditAmount] = amountInputs();
    await user.type(debitAmount!, "1000.00");
    await user.type(creditAmount!, "900.00");

    await waitFor(() => {
      expect(submitButton()).toBeDisabled();
    });

    expect(postTransaction).not.toHaveBeenCalled();
  });

  it("BLOCKS submission on a ONE PAISA difference", async () => {
    const user = setup();

    const [debitLedger, creditLedger] = ledgerSelects();
    await user.selectOptions(debitLedger!, LEDGERS[0]!.id);
    await user.selectOptions(creditLedger!, LEDGERS[1]!.id);

    const [debitAmount, creditAmount] = amountInputs();
    // The difference a floating-point sum would happily round away.
    await user.type(debitAmount!, "1000.01");
    await user.type(creditAmount!, "1000.00");

    await waitFor(() => {
      expect(submitButton()).toBeDisabled();
    });

    expect(postTransaction).not.toHaveBeenCalled();
  });

  it("ALLOWS submission once debits equal credits exactly", async () => {
    const user = setup();

    const [debitLedger, creditLedger] = ledgerSelects();
    await user.selectOptions(debitLedger!, LEDGERS[0]!.id);
    await user.selectOptions(creditLedger!, LEDGERS[1]!.id);

    await user.type(screen.getAllByLabelText(/description/i)[0]!, "Booking receipt — Unit 304");

    const [debitAmount, creditAmount] = amountInputs();
    await user.type(debitAmount!, "1000.00");
    await user.type(creditAmount!, "1000.00");

    await waitFor(() => {
      expect(submitButton()).toBeEnabled();
    });
  });

  it("RE-BLOCKS the moment a balanced entry is edited out of balance", async () => {
    const user = setup();

    const [debitLedger, creditLedger] = ledgerSelects();
    await user.selectOptions(debitLedger!, LEDGERS[0]!.id);
    await user.selectOptions(creditLedger!, LEDGERS[1]!.id);
    await user.type(screen.getAllByLabelText(/description/i)[0]!, "Test entry");

    const [debitAmount, creditAmount] = amountInputs();
    await user.type(debitAmount!, "500.00");
    await user.type(creditAmount!, "500.00");

    await waitFor(() => expect(submitButton()).toBeEnabled());

    // Now break it — a single extra keystroke.
    await user.type(creditAmount!, "0");

    await waitFor(() => {
      expect(submitButton()).toBeDisabled();
    });
  });

  it("BLOCKS a zero-value entry even though 0 debits equal 0 credits", async () => {
    const user = setup();

    const [debitLedger, creditLedger] = ledgerSelects();
    await user.selectOptions(debitLedger!, LEDGERS[0]!.id);
    await user.selectOptions(creditLedger!, LEDGERS[1]!.id);

    const [debitAmount, creditAmount] = amountInputs();
    await user.type(debitAmount!, "0.00");
    await user.type(creditAmount!, "0.00");

    // Technically balanced. Still meaningless — a transaction must move
    // a non-zero amount, or the ledger fills with entries that say nothing.
    await waitFor(() => {
      expect(submitButton()).toBeDisabled();
    });
  });

  it("BLOCKS when an amount is balanced but a ledger is not chosen", async () => {
    const user = setup();

    const [debitAmount, creditAmount] = amountInputs();
    await user.type(debitAmount!, "750.00");
    await user.type(creditAmount!, "750.00");

    // Balanced, but the money has no accounts to move between.
    await waitFor(() => {
      expect(submitButton()).toBeDisabled();
    });
  });

  it("shows a live running balance so the difference is visible while typing", async () => {
    const user = setup();

    const [debitLedger, creditLedger] = ledgerSelects();
    await user.selectOptions(debitLedger!, LEDGERS[0]!.id);
    await user.selectOptions(creditLedger!, LEDGERS[1]!.id);

    const [debitAmount, creditAmount] = amountInputs();
    await user.type(debitAmount!, "1000.00");
    await user.type(creditAmount!, "600.00");

    // A polite live region — announced by screen readers without stealing focus.
    const statuses = await screen.findAllByRole("status");
    const balancePanel = statuses.find((el) => /Difference/i.test(el.textContent ?? ""));

    expect(balancePanel, "no live balance panel rendered").toBeDefined();
    expect(balancePanel).toHaveAttribute("aria-live", "polite");
    expect(balancePanel!.textContent).toMatch(/400\.00/);
  });

  it("WARNS when the entry date falls inside a closed period", async () => {
    const user = setup([
      { name: "FY2026 Q1", startDate: "2026-04-01", endDate: "2026-06-30" },
    ]);

    const dateInput = screen.getByLabelText(/date/i) as HTMLInputElement;
    await user.clear(dateInput);
    await user.type(dateInput, "2026-05-15");

    const [debitLedger, creditLedger] = ledgerSelects();
    await user.selectOptions(debitLedger!, LEDGERS[0]!.id);
    await user.selectOptions(creditLedger!, LEDGERS[1]!.id);
    await user.type(screen.getAllByLabelText(/description/i)[0]!, "Back-dated entry");

    const [debitAmount, creditAmount] = amountInputs();
    await user.type(debitAmount!, "100.00");
    await user.type(creditAmount!, "100.00");

    // Perfectly balanced — and still refused, because the period is closed.
    // The database would reject this too; catching it here saves a round trip
    // and explains why.
    await waitFor(() => {
      expect(screen.getAllByText(/FY2026 Q1/).length).toBeGreaterThan(0);
      expect(submitButton()).toBeDisabled();
    });

    expect(postTransaction).not.toHaveBeenCalled();
  });
});
