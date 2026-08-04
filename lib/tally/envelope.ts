/**
 * Ordence — ⭐ The Tally Envelope
 * Version: v0.37.0-alpha
 *
 * Pure and isomorphic.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE STRUCTURE TALLY ACCEPTS, AND WHY IT LOOKS LIKE THIS
 * ══════════════════════════════════════════════════════════════════════
 *     <ENVELOPE>
 *       <HEADER>
 *         <TALLYREQUEST>Import Data</TALLYREQUEST>
 *       </HEADER>
 *       <BODY>
 *         <IMPORTDATA>
 *           <REQUESTDESC>
 *             <REPORTNAME>Vouchers</REPORTNAME>
 *             <STATICVARIABLES>
 *               <SVCURRENTCOMPANY>…</SVCURRENTCOMPANY>
 *             </STATICVARIABLES>
 *           </REQUESTDESC>
 *           <REQUESTDATA>
 *             <TALLYMESSAGE xmlns:UDF="TallyUDF"> … </TALLYMESSAGE>
 *             <TALLYMESSAGE xmlns:UDF="TallyUDF"> … </TALLYMESSAGE>
 *           </REQUESTDATA>
 *         </IMPORTDATA>
 *       </BODY>
 *     </ENVELOPE>
 *
 * It is Tally's own internal request format, exposed. Every oddity below
 * is load-bearing:
 *
 * ⭐ `<SVCURRENTCOMPANY>` IS THE FIELD THAT LOSES A MONTH. Without it the
 * import goes into whichever company happens to be open. A firm running
 * "Ordence Pvt Ltd" and "Ordence Pvt Ltd (2023-24)" side by
 * side — which every firm does in April — will import this year's file
 * into last year's company, successfully, and the only symptom is a
 * turnover figure that will not tie out.
 *
 * ⚠️ `xmlns:UDF="TallyUDF"` ON EVERY `<TALLYMESSAGE>`. It declares the
 * namespace for user-defined fields. Tally's own exports carry it, some
 * builds require it even when no UDF is present, and the failure when it
 * is missing is — again — a silent partial import.
 *
 * ⚠️ ONE `<TALLYMESSAGE>` PER OBJECT, NOT ONE PER FILE. Two vouchers
 * inside one message is a document Tally reads as a single object and
 * imports as whichever one it parsed last.
 */

import { renderDocument, type TallyXmlNode } from "./xml";
import { ledgerMasterNode, type LedgerMapping } from "./ledgers";
import { voucherNode, type TallyVoucherDraft } from "./vouchers";

export type EnvelopeArgs = {
  /** ⭐ EXACTLY as typed into Tally, including any "(2023-24)" suffix. */
  companyName: string;
  /** Masters to create. Usually empty — see `ledgerMasterNode`'s warning. */
  masters?: readonly LedgerMapping[];
  vouchers: readonly TallyVoucherDraft[];
  /**
   * ⭐ `Create` for a first send, `Alter` for a re-send of a period Tally
   * already has. See `lib/tally/keys.ts` — the REMOTEID is what makes
   * `Alter` update rather than duplicate.
   */
  action?: "Create" | "Alter";
  /** Indented output is ~30% larger and vastly easier to read in a diff. */
  indent?: boolean;
};

const UDF_NAMESPACE = { "xmlns:UDF": "TallyUDF" };

/**
 * ⭐ The importable file. This is what an accountant downloads and what
 * `server/tally/push.ts` POSTs.
 */
export function buildImportEnvelope(args: EnvelopeArgs): string {
  const messages: TallyXmlNode[] = [];

  for (const master of args.masters ?? []) {
    messages.push({
      tag: "TALLYMESSAGE",
      attrs: UDF_NAMESPACE,
      children: [ledgerMasterNode(master)],
    });
  }

  for (const voucher of args.vouchers) {
    messages.push({
      tag: "TALLYMESSAGE",
      attrs: UDF_NAMESPACE,
      children: [voucherNode(voucher, { action: args.action ?? "Create" })],
    });
  }

  const root: TallyXmlNode = {
    tag: "ENVELOPE",
    children: [
      {
        tag: "HEADER",
        children: [{ tag: "TALLYREQUEST", text: "Import Data" }],
      },
      {
        tag: "BODY",
        children: [
          {
            tag: "IMPORTDATA",
            children: [
              {
                tag: "REQUESTDESC",
                children: [
                  { tag: "REPORTNAME", text: "Vouchers" },
                  {
                    tag: "STATICVARIABLES",
                    children: [
                      // ⭐ See the header. The single most consequential
                      // element in the file.
                      { tag: "SVCURRENTCOMPANY", text: args.companyName },
                    ],
                  },
                ],
              },
              {
                tag: "REQUESTDATA",
                children: messages,
              },
            ],
          },
        ],
      },
    ],
  };

  return renderDocument(root, { indent: args.indent ?? true });
}

/* ------------------------------------------------------------------ */
/* ⭐ THE EXPORT REQUEST — asking Tally for ITS vouchers                */
/* ------------------------------------------------------------------ */

/**
 * The request that pulls a period of vouchers OUT of Tally, for the
 * reconciliation. A different `TALLYREQUEST` and a different report.
 *
 * ⚠️ `SVFROMDATE` AND `SVTODATE` ARE INCLUSIVE AND ARE IN TALLY'S
 * `YYYYMMDD` FORM. An ISO date here returns an empty result set on some
 * builds and the whole company on others — and "the whole company" looks
 * like a working integration until somebody reconciles ten years against
 * one month.
 */
export function buildVoucherExportRequest(args: {
  companyName: string;
  fromDay: string;
  toDay: string;
}): string {
  const compactDay = (iso: string) => iso.replace(/-/g, "");

  const root: TallyXmlNode = {
    tag: "ENVELOPE",
    children: [
      {
        tag: "HEADER",
        children: [
          { tag: "TALLYREQUEST", text: "Export" },
          { tag: "TYPE", text: "Data" },
          // "Day Book" is the report that contains every voucher type.
          // Asking for "Sales Register" and reconciling everything against
          // it reports every purchase as missing.
          { tag: "ID", text: "Day Book" },
        ],
      },
      {
        tag: "BODY",
        children: [
          {
            tag: "DESC",
            children: [
              {
                tag: "STATICVARIABLES",
                children: [
                  { tag: "SVEXPORTFORMAT", text: "$$SysName:XML" },
                  { tag: "SVCURRENTCOMPANY", text: args.companyName },
                  { tag: "SVFROMDATE", text: compactDay(args.fromDay) },
                  { tag: "SVTODATE", text: compactDay(args.toDay) },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  return renderDocument(root, { indent: true });
}
