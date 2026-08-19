/**
 * Ordence — ⭐ SECTION 17(5): MAY WE CLAIM THIS CREDIT?
 * Version: v0.33.0-alpha
 *
 * Pure. No database, no I/O, no clock. Given the facts about one line of
 * one purchase invoice it returns one verdict, the clause it came from,
 * and a sentence a person can check.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS IS THE MOST IMPORTANT FILE IN THE PHASE
 * ══════════════════════════════════════════════════════════════════════
 * On the outward side (Phase 32) a wrong answer produces a wrong
 * document, and a document is something people look at. Here a wrong
 * answer produces a RIGHT-LOOKING RETURN. The GSTR-3B files cleanly, the
 * credit ledger shows a balance, the books balance, nothing errors.
 *
 * The bill arrives years later, with interest at 18% under Section 50
 * running from the date of the wrong claim, and a penalty under Section
 * 122. For a developer the numbers are not small: the blocked credit on a
 * single mid-size tower is measured in crores, because cement and steel
 * and the main contractor's bill ARE the cost of the building.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ONE THAT MATTERS: 17(5)(c) AND 17(5)(d)
 * ══════════════════════════════════════════════════════════════════════
 * The statute, compressed:
 *
 *   (c) works contract services when supplied for CONSTRUCTION OF AN
 *       IMMOVABLE PROPERTY (other than plant and machinery) — blocked,
 *       EXCEPT where it is an input service for the FURTHER SUPPLY of
 *       works contract service.
 *
 *   (d) goods or services received by a taxable person for CONSTRUCTION
 *       OF AN IMMOVABLE PROPERTY ON HIS OWN ACCOUNT, including when used
 *       in the course or furtherance of business — blocked, other than
 *       plant and machinery.
 *
 * The words that decide crores are "ON HIS OWN ACCOUNT", and they are not
 * defined by what the goods are. They are defined by what the building is
 * FOR:
 *
 *   ┌──────────────────────────────────────────────┬───────────────────┐
 *   │ 50,000 bags of cement, one HSN, one vendor…  │ Credit            │
 *   ├──────────────────────────────────────────────┼───────────────────┤
 *   │ …into a tower whose flats are sold under     │ ⭐ ELIGIBLE       │
 *   │   agreements dated BEFORE the completion     │  (that sale is a  │
 *   │   certificate                                │  taxable supply   │
 *   │                                              │  of service —     │
 *   │                                              │  Sch. II 5(b))    │
 *   ├──────────────────────────────────────────────┼───────────────────┤
 *   │ …into the head office we build for ourselves │ ⭐ BLOCKED 17(5)(d)│
 *   ├──────────────────────────────────────────────┼───────────────────┤
 *   │ …into a tower we will LEASE, not sell        │ ⭐ BLOCKED 17(5)(d)│
 *   ├──────────────────────────────────────────────┼───────────────────┤
 *   │ …into flats sold AFTER the completion        │ ⭐ BLOCKED 17(5)(d)│
 *   │   certificate — a sale outside GST entirely  │  (Sch. III para 5)│
 *   └──────────────────────────────────────────────┴───────────────────┘
 *
 * Nothing on the purchase invoice distinguishes these. The vendor does
 * not know and could not say. It is OUR fact, captured when the bill is
 * entered or not recoverable afterwards — which is why `itcPurpose` is
 * required on every line and why the database refuses an eligible credit
 * against `own_account_construction` outright.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SHAPE OF THE FUNCTION: TWO STAGES, AND WHY IT IS NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * The obvious implementation is a single cascade that returns on the
 * first match. It produces a specific, silent, expensive bug.
 *
 * Section 17(5) blocks things OUTRIGHT. Section 17(2) restricts credit in
 * PROPORTION to taxable use. They are different questions and a supply
 * can be caught by both — but a supply that ESCAPES 17(5) through one of
 * its provisos is still subject to 17(2). In a single cascade, the
 * proviso branch returns "eligible" and the apportionment test below it
 * is never reached: the clubhouse restaurant's food credit escapes
 * 17(5)(b) via the same-category proviso and is then claimed in full,
 * even though the clubhouse also serves an exempt supply.
 *
 * So:
 *   Stage A — `screenBlockedCredit`: does anything block this OUTRIGHT?
 *             Returns a block, or `null` plus a note saying which proviso
 *             carried it.
 *   Stage B — attribution: 17(2) and Rule 42. Exempt, common, or taxable.
 *
 * Every path goes through both. There is no early return that skips B.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY EVERY VERDICT CARRIES A CLAUSE AND A SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * At an assessment the question is never "is this blocked". It is "under
 * which clause, and why did you think so at the time". A register that
 * answers `blocked: true` concedes the point, so `statutoryRef` and
 * `explanation` are part of the return type, stored on the line, and not
 * optional.
 */

import type {
  ExpenditureNature,
  ItcBlockReason,
  ItcEligibility,
  ItcPurpose,
  Rule42Attribution,
} from "@/db/schema/purchases";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

export type ItcDeterminationInput = {
  /** ⭐ What the expenditure is FOR. The 17(5)(d) discriminator. */
  itcPurpose: ItcPurpose;
  /** What the expenditure IS. The 17(5)(a)/(b)/(c) discriminator. */
  expenditureNature: ExpenditureNature;

  /**
   * ⭐ Does the OUTWARD supply this feeds carry a rate that is expressly
   * WITHOUT input tax credit?
   *
   * Read straight off the pinned `hsn_sac_rates` row for the outward
   * supply — `itcEligible` on that row IS this fact. The 1% and 5%
   * residential rates notified from 1 April 2019 are the case that
   * matters, and they are a condition of the RATE rather than a clause of
   * Section 17(5).
   *
   * Defaults to `true` (the rate permits credit) when not supplied,
   * because most inputs feed ordinary 18% supplies. ⚠️ For a residential
   * project it must be passed explicitly — see the note in Stage A.
   */
  outwardRateAllowsItc?: boolean;

  /* --- The statutory EXCEPTIONS. Each is a real carve-out. ------- */

  /**
   * 17(5)(a) proviso. A passenger vehicle of ≤13 seats is blocked UNLESS
   * used for: further supply of such vehicles, transport of passengers,
   * or imparting driving training.
   *
   * ⚠️ A GOODS VEHICLE IS NOT BLOCKED AT ALL. 17(5)(a) reaches "motor
   * vehicles for transportation of persons". A tipper, a transit mixer
   * and a crane on a chassis are goods vehicles or plant, fully
   * creditable — and on a construction site that is most of the fleet.
   * Classify those as `goods`/`capital_goods`/`plant_and_machinery` and
   * this flag is never reached.
   */
  vehicleUsedForTaxableOnwardSupply?: boolean;

  /**
   * 17(5)(b) proviso, and the one that most often turns a block into a
   * claim: where an employer is OBLIGED BY LAW to provide the goods or
   * service to employees, the block does not apply. A canteen mandatory
   * under Section 46 of the Factories Act — which a site employing over
   * 250 workers has — is the standard example.
   */
  statutoryObligationToEmployees?: boolean;

  /**
   * 17(5)(b) proviso, the other limb: the inward supply is used to make
   * an OUTWARD taxable supply of the same category. A developer running a
   * paid restaurant in the clubhouse buys food as an input to a taxable
   * supply of food.
   */
  usedForSameCategoryOutwardSupply?: boolean;

  /* --- Facts about the transaction rather than the expenditure --- */

  supplierIsComposition?: boolean;
  supplierIsNonResident?: boolean;
  goodsLostStolenDestroyedOrGifted?: boolean;
  /** Section 16(2)(a): no tax invoice, no credit. A bill of supply, say. */
  hasValidTaxInvoice?: boolean;
};

/* ------------------------------------------------------------------ */
/* OUTPUT                                                              */
/* ------------------------------------------------------------------ */

export type ItcDetermination = {
  eligibility: ItcEligibility;
  blockReason: ItcBlockReason | null;
  /** The clause relied on: "17(5)(d)", "s.17(2)", "Notif. 03/2019". */
  statutoryRef: string;
  /** ⭐ Which letter of the Rule 42 formula this line feeds. */
  rule42Attribution: Rule42Attribution;
  /** One sentence, written for the person who has to defend it. */
  explanation: string;
  /**
   * What to do if the verdict looks wrong. Present only where a
   * reclassification is a legitimate answer — never as an invitation to
   * relabel a blocked credit as an eligible one.
   */
  remedy?: string;
};

/* ------------------------------------------------------------------ */
/* STAGE A — IS IT BLOCKED OUTRIGHT?                                   */
/* ------------------------------------------------------------------ */

/**
 * A block, or `null` with the reason it survived.
 *
 * Exported because the reason it survived is worth showing on its own:
 * "eligible because the canteen is mandatory under the Factories Act" is
 * a materially different statement from "eligible, no clause engaged",
 * and only the first one needs evidence kept with it.
 */
export type BlockScreen =
  | { blocked: true; determination: ItcDetermination }
  | { blocked: false; survivedVia: string | null };

export function screenBlockedCredit(input: ItcDeterminationInput): BlockScreen {
  const allowsItc = input.outwardRateAllowsItc ?? true;

  /* --- 0. NO DOCUMENT, NO CREDIT — Section 16(2)(a) -------------- */
  //
  // ⚠️ FIRST, BECAUSE IT OUTRANKS EVERYTHING. Section 16(2) opens
  // "notwithstanding anything contained in this section". Without a tax
  // invoice or debit note there is no credit to classify at all, and
  // asking which clause of 17(5) applies to a document that does not
  // exist is a question with no answer.
  if (input.hasValidTaxInvoice === false) {
    return block(
      "no_valid_tax_invoice",
      "s.16(2)(a)",
      "There is no tax invoice or debit note for this line, so there is nothing to " +
        "claim credit against. Section 16(2)(a) makes possession of the document a " +
        "precondition, ahead of every other test.",
      "If the vendor issued a bill of supply they are not charging GST — a " +
        "composition dealer, or an exempt supply. If they should have issued a tax " +
        "invoice, get one before the bill is passed for payment.",
    );
  }

  if (input.supplierIsComposition === true) {
    return block(
      "composition_supplier",
      "17(5)(e)",
      "The supplier pays a flat turnover levy under the composition scheme and may " +
        "not charge GST. Section 17(5)(e) blocks credit on anything received from " +
        "them, and any 'tax' shown on their document is not tax.",
      "Record the whole amount as cost. If the document shows GST, the supplier has " +
        "issued a tax invoice they were not entitled to issue — ask for a corrected " +
        "bill of supply.",
    );
  }

  if (input.supplierIsNonResident === true) {
    return block(
      "non_resident_supplier",
      "17(5)(f)",
      "Goods or services received by a non-resident taxable person are blocked by " +
        "Section 17(5)(f), except on goods they imported themselves.",
    );
  }

  if (input.goodsLostStolenDestroyedOrGifted === true) {
    return block(
      "lost_stolen_destroyed_gifted",
      "17(5)(h)",
      "Goods lost, stolen, destroyed, written off, or disposed of by way of gift or " +
        "free sample carry no credit under Section 17(5)(h). ⚠️ That includes " +
        "promotional items given away at a launch and material written off after a " +
        "site fire — and where credit was already taken it must be reversed.",
    );
  }

  /* --- 1. PERSONAL AND NON-BUSINESS USE — 17(5)(g) --------------- */
  if (input.itcPurpose === "non_business") {
    return {
      blocked: true,
      determination: {
        eligibility: "blocked",
        blockReason: "personal_consumption",
        statutoryRef: "17(5)(g)",
        // ⚠️ T1, NOT T3. Rule 42 gives non-business use its own letter and
        // deducts it before the blocked bucket. Reporting it as T3 puts a
        // figure in the wrong line of the working — and the working is
        // what an officer recomputes.
        rule42Attribution: "exclusively_non_business",
        explanation:
          "This expenditure is for personal consumption or is otherwise outside the " +
          "business. Section 17(5)(g) blocks the credit, and Rule 42 treats it as " +
          "T1 — deducted from total credit before anything is apportioned.",
      },
    };
  }

  /* --- 2. ⭐⭐ THE CONSTRUCTION CLAUSES — 17(5)(c) AND 17(5)(d) --- */

  // 2a. ⭐ OWN ACCOUNT. The block, and the most expensive one available.
  if (input.itcPurpose === "own_account_construction") {
    return block(
      "construction_own_account",
      "17(5)(d)",
      "These goods or services go into an immovable property being constructed ON " +
        "OUR OWN ACCOUNT — a building we will hold, occupy or lease rather than " +
        "sell before completion. Section 17(5)(d) blocks the credit expressly, and " +
        "says so even where the property is used in the course or furtherance of " +
        "business. The tax is capitalised into the cost of the building.",
      "⚠️ Do NOT relabel this to recover the credit. If the units in this building " +
        "are in fact being SOLD under agreements dated before the completion " +
        "certificate, the correct purpose is 'sold_before_completion' — but that is " +
        "a statement about the agreements, evidenced by them, and not a preference.",
    );
  }

  // 2b. ⭐ WORKS CONTRACT. Blocked unless plant and machinery, or unless
  //     it feeds an onward works contract, or unless the property is
  //     being sold pre-completion (in which case it is not construction
  //     on our own account and clause (c) is not engaged either).
  if (
    input.expenditureNature === "works_contract_service" &&
    input.itcPurpose !== "plant_and_machinery" &&
    input.itcPurpose !== "sold_before_completion" &&
    input.itcPurpose !== "further_supply_works_contract"
  ) {
    return block(
      "works_contract_immovable",
      "17(5)(c)",
      "This is a works contract service supplied for the construction of an " +
        "immovable property. Section 17(5)(c) blocks the credit unless the service " +
        "is an input for the FURTHER SUPPLY of works contract service — the " +
        "sub-contractor exception — or the item is plant and machinery.",
      "If we are ourselves supplying a works contract onward and this bill is an " +
        "input to it, the purpose is 'further_supply_works_contract' and the credit " +
        "is available under the proviso to clause (c).",
    );
  }

  /* --- 3. THE OTHER 17(5) BLOCKS — WHAT THE EXPENDITURE **IS** --- */

  const natureBlock = screenByNature(input);
  if (natureBlock.blocked) return natureBlock;

  /* --- 4. ⭐ THE RATE CONDITION — Notification 03/2019 ------------ */
  //
  // ⚠️ LAST OF THE BLOCKS, AND SEPARATE FROM SECTION 17(5) ON PURPOSE.
  //
  // This is not the Act taking the credit away; it is the condition of a
  // rate the developer opted into. The distinction matters because it is
  // PER PROJECT: a developer can be on the old 12%-with-credit scheme for
  // an ongoing Tower A and the compulsory 5%-without-credit scheme for a
  // new Tower B, receive one cement invoice covering both, and have to
  // split it. Folding this into the 17(5) screen would make it a fact
  // about the company rather than about the project.
  if (!allowsItc) {
    const preCompletion = input.itcPurpose === "sold_before_completion";
    return block(
      "notified_rate_without_itc",
      "Notif. 03/2019",
      preCompletion
        ? "These units are sold before completion, so Section 17(5)(d) does NOT " +
            "block the credit — but the project is taxed at the 1%/5% residential " +
            "rates notified from 1 April 2019, and those rates are expressly " +
            "WITHOUT input tax credit. The condition of the rate takes away what " +
            "the Act would have allowed."
        : "The outward supply this feeds is taxed at a rate notified expressly " +
            "WITHOUT input tax credit — the 1% and 5% residential rates from 1 " +
            "April 2019 are the case a developer meets. The credit is denied by " +
            "the condition of the rate, not by Section 17(5).",
      preCompletion
        ? "This is correct if the project opted into, or was compulsorily moved to, " +
            "the new scheme. If it is an ongoing project that elected to continue " +
            "at 12% with credit, then the OUTWARD rate on the project is wrong — " +
            "not this line."
        : undefined,
    );
  }

  /* --- Nothing blocks it. Say what carried it, if anything did. -- */
  return { blocked: false, survivedVia: natureBlock.survivedVia };
}

/**
 * The clauses that key off WHAT the expenditure is rather than what it is
 * for: 17(5)(a), (aa), (ab) and (b).
 */
function screenByNature(input: ItcDeterminationInput): BlockScreen {
  const nature = input.expenditureNature;

  /* --- Plant and machinery: the exception to (c) and (d) --------- */
  //
  // ⚠️ THE EXPLANATION TO SECTION 17 IS NARROWER THAN THE PHRASE SOUNDS.
  // "Plant and machinery" means apparatus, equipment and machinery fixed
  // to earth by foundation or structural support, INCLUDING that
  // foundation and support — but EXCLUDING land, buildings and other
  // civil structures, telecommunication towers, and pipelines laid
  // outside factory premises. A lift, a chiller, a DG set and a fire pump
  // qualify. The lift SHAFT does not. The plinth the DG sits on does.
  if (input.itcPurpose === "plant_and_machinery") {
    return {
      blocked: false,
      survivedVia:
        "Plant and machinery is the express exception to both Section 17(5)(c) and " +
        "17(5)(d), so the credit survives even though the item is fixed to the " +
        "building. ⚠️ The exception does NOT extend to the civil structure around " +
        "it — the lift is plant, the shaft is a building.",
    };
  }

  if (
    nature === "motor_vehicle" ||
    nature === "vessel_or_aircraft" ||
    nature === "motor_vehicle_related_service" ||
    nature === "rent_a_cab"
  ) {
    if (input.vehicleUsedForTaxableOnwardSupply === true) {
      return {
        blocked: false,
        survivedVia:
          "The vehicle or vessel is used for one of the permitted onward supplies — " +
          "further supply of such vehicles, transport of passengers or of goods, or " +
          "imparting driving training — so the block in Section 17(5)(a) does not " +
          "apply.",
      };
    }

    const reason: ItcBlockReason =
      nature === "vessel_or_aircraft"
        ? "vessel_or_aircraft"
        : nature === "motor_vehicle_related_service"
          ? "vehicle_related_service"
          : "motor_vehicle";
    const ref =
      reason === "vessel_or_aircraft"
        ? "17(5)(aa)"
        : reason === "vehicle_related_service"
          ? "17(5)(ab)"
          : "17(5)(a)";

    return block(
      reason,
      ref,
      "Credit on a motor vehicle for the transport of persons with approved seating " +
        "of thirteen or fewer including the driver, on vessels and aircraft, and on " +
        "their insurance, servicing and repair, is blocked. ⚠️ A GOODS VEHICLE IS " +
        "NOT — a tipper, a transit mixer or a crane is fully creditable, and on a " +
        "site that is most of the fleet.",
      "If this is a goods vehicle or site plant rather than a passenger car, the " +
        "nature is 'capital_goods' or the purpose is 'plant_and_machinery', not " +
        "'motor_vehicle'.",
    );
  }

  if (
    nature === "food_and_beverage" ||
    nature === "outdoor_catering" ||
    nature === "beauty_or_health_service"
  ) {
    if (input.usedForSameCategoryOutwardSupply === true) {
      return {
        blocked: false,
        survivedVia:
          "The inward supply is used to make an outward taxable supply of the same " +
          "category — a clubhouse restaurant buying food, for example — so the " +
          "first proviso to Section 17(5)(b) restores the credit.",
      };
    }
    if (input.statutoryObligationToEmployees === true) {
      return {
        blocked: false,
        survivedVia:
          "The employer is obliged BY LAW to provide this to employees — a canteen " +
          "under Section 46 of the Factories Act is the standard case on a site — " +
          "so the second proviso to Section 17(5)(b) restores the credit.",
      };
    }
    return block(
      nature === "beauty_or_health_service"
        ? "beauty_or_health_service"
        : "food_beverage_catering",
      "17(5)(b)(i)",
      "Food and beverages, outdoor catering, beauty treatment, health services and " +
        "cosmetic surgery are blocked by Section 17(5)(b)(i). Site tea, the " +
        "launch-day lunch and the office pantry all fall here.",
      "The block lifts only where the supply feeds an outward taxable supply of the " +
        "SAME category, or where an employer is obliged by law to provide it.",
    );
  }

  if (nature === "life_or_health_insurance") {
    if (input.statutoryObligationToEmployees === true) {
      return {
        blocked: false,
        survivedVia:
          "Life or health insurance an employer is obliged by law to provide to " +
          "employees is outside the block — the proviso to Section 17(5)(b).",
      };
    }
    return block(
      "life_or_health_insurance",
      "17(5)(b)(i)",
      "Life and health insurance for employees is blocked by Section 17(5)(b)(i) " +
        "unless an employer is obliged by law to provide it. ⚠️ Workmen's " +
        "compensation and contractors' all-risk cover on a project are NOT life or " +
        "health insurance and are not blocked by this clause.",
    );
  }

  if (nature === "club_or_fitness_membership") {
    return block(
      "club_membership",
      "17(5)(b)(ii)",
      "Membership of a club, a health centre or a fitness centre is blocked " +
        "outright by Section 17(5)(b)(ii). There is no proviso and no business-use " +
        "argument — a corporate golf membership taken purely to entertain buyers is " +
        "blocked exactly as a personal one is.",
    );
  }

  if (nature === "employee_travel_benefit") {
    if (input.statutoryObligationToEmployees === true) {
      return {
        blocked: false,
        survivedVia:
          "A travel benefit an employer is obliged by law to provide is outside the " +
          "block in Section 17(5)(b)(iii).",
      };
    }
    return block(
      "employee_travel_benefit",
      "17(5)(b)(iii)",
      "Travel benefits extended to employees on vacation — leave or home travel " +
        "concession — are blocked by Section 17(5)(b)(iii). ⚠️ ORDINARY BUSINESS " +
        "TRAVEL IS NOT: a site visit, a hotel for an out-station meeting and a " +
        "flight to a regulator's office are fully creditable.",
    );
  }

  /* --- ⭐ CONSTRUCTION MATERIAL, NOT FOR OUR OWN BUILDING -------- */
  //
  // ⚠️ NOT BLOCKED BY WHAT IT IS, DELIBERATELY. Clause (d) blocks goods
  // "received for construction of an immovable property ON HIS OWN
  // ACCOUNT" — a trader selling cement, or a contractor using it on a
  // client's site, is doing no such thing. Blocking on the material alone
  // would deny a real credit, and the predictable response would be to
  // mislabel the material to get it back, which destroys the one column
  // this phase depends on.
  //
  // The own-account case was already caught at 2a, above.
  return { blocked: false, survivedVia: null };
}

/* ------------------------------------------------------------------ */
/* ⭐ THE DETERMINATION — STAGE A THEN STAGE B                         */
/* ------------------------------------------------------------------ */

export function determineItcEligibility(
  input: ItcDeterminationInput,
): ItcDetermination {
  const screen = screenBlockedCredit(input);
  if (screen.blocked) return screen.determination;

  const via = screen.survivedVia;

  /* ---------------------------------------------------------------- */
  /* STAGE B — SECTION 17(2) AND RULE 42                               */
  /* ---------------------------------------------------------------- */
  //
  // ⚠️ REACHED BY EVERY UNBLOCKED PATH, INCLUDING THE PROVISO PATHS.
  // That is the whole reason this is not one cascade: a supply that
  // escapes 17(5) through a proviso is still restricted by 17(2) if it
  // feeds exempt supplies, and a single cascade would have returned
  // "eligible" at the proviso and never asked.

  if (input.itcPurpose === "exempt_supply") {
    return {
      eligibility: "blocked",
      blockReason: "exempt_supply",
      statutoryRef: "s.17(2)",
      rule42Attribution: "exclusively_exempt",
      explanation:
        (via ? `${via} ` : "") +
        "This input nevertheless feeds a WHOLLY EXEMPT outward supply. Section " +
        "17(2) restricts credit to the taxable portion, and where there is none the " +
        "whole credit is unavailable. Rule 42 calls this T2 and deducts it before " +
        "apportionment.",
    };
  }

  if (input.itcPurpose === "common") {
    return {
      eligibility: "proportionate",
      blockReason: null,
      statutoryRef: "Rule 42",
      rule42Attribution: "common",
      explanation:
        (via ? `${via} ` : "") +
        "⭐ This input feeds BOTH taxable and exempt supplies, so it is common " +
        "credit. The WHOLE amount enters the electronic credit ledger and the " +
        "ineligible share is REVERSED in the same return under Rule 42 — availment " +
        "and reversal are separate boxes in GSTR-3B Table 4 and both are reported. " +
        "For a developer the exempt side is usually flats sold AFTER the completion " +
        "certificate, which are outside GST entirely.",
      remedy:
        "The reversal is computed on the PERIOD's turnover, not on this line. Run " +
        "the Rule 42 apportionment for the tax period once every purchase for the " +
        "month has been entered.",
    };
  }

  /* --- Eligible. Name what carried it. --------------------------- */

  if (input.itcPurpose === "sold_before_completion") {
    return {
      eligibility: "eligible",
      blockReason: null,
      statutoryRef: "Sch. II para 5(b)",
      rule42Attribution: "exclusively_taxable",
      explanation:
        "⭐ These goods or services go into units being SOLD under agreements dated " +
        "before the completion certificate. That construction is a taxable outward " +
        "supply of service under Schedule II paragraph 5(b) — it is not " +
        "construction 'on his own account' — so Section 17(5)(d) does not apply and " +
        "the credit is available.",
    };
  }

  if (input.itcPurpose === "further_supply_works_contract") {
    return {
      eligibility: "eligible",
      blockReason: null,
      statutoryRef: "17(5)(c) proviso",
      rule42Attribution: "exclusively_taxable",
      explanation:
        "This bill is an input service for the further supply of works contract " +
        "service that we ourselves provide. The express exception in Section " +
        "17(5)(c) applies — this is what keeps a main contractor whole on its " +
        "sub-contractors' bills.",
    };
  }

  if (input.itcPurpose === "plant_and_machinery") {
    return {
      eligibility: "eligible",
      blockReason: null,
      statutoryRef: "Explanation to s.17",
      rule42Attribution: "exclusively_taxable",
      explanation:
        via ??
        "Plant and machinery is the express exception to Sections 17(5)(c) and " +
          "17(5)(d).",
    };
  }

  return {
    eligibility: "eligible",
    blockReason: null,
    statutoryRef: via ? "17(5) proviso" : "s.16(1)",
    rule42Attribution: "exclusively_taxable",
    explanation:
      via ??
      "An ordinary input used in the course or furtherance of business, feeding a " +
        "taxable outward supply. No clause of Section 17(5) is engaged, so the " +
        "Section 16(1) credit is available once the Section 16(2) conditions are met.",
  };
}

/* ------------------------------------------------------------------ */
/* SPLITTING THE VERDICT ACROSS THE TAX HEADS                          */
/* ------------------------------------------------------------------ */

export type TaxHeads = {
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
};

export type ItcSplit = {
  eligibleTaxMinor: bigint;
  blockedTaxMinor: bigint;
  /** The heads making up the eligible portion. Sums to `eligible`. */
  eligibleHeads: TaxHeads;
  blockedHeads: TaxHeads;
};

/**
 * Turn a verdict plus a line's four tax heads into the two figures the
 * line stores.
 *
 * ⚠️ THERE IS NO PARTIAL CASE HERE, AND THAT IS THE POINT. A
 * `proportionate` line carries its FULL tax as eligible: Rule 42 works by
 * availing the whole common credit and reversing the ineligible share
 * separately, in the same return. Splitting a common line here AND
 * reversing at period level would count the reversal twice — a quiet
 * under-claim that looks like conservatism and is simply wrong.
 */
export function splitItcByVerdict(
  eligibility: ItcEligibility,
  heads: TaxHeads,
): ItcSplit {
  const zero: TaxHeads = {
    cgstMinor: 0n,
    sgstMinor: 0n,
    igstMinor: 0n,
    cessMinor: 0n,
  };
  const total = sumHeads(heads);

  if (eligibility === "blocked") {
    return {
      eligibleTaxMinor: 0n,
      blockedTaxMinor: total,
      eligibleHeads: zero,
      blockedHeads: { ...heads },
    };
  }

  return {
    eligibleTaxMinor: total,
    blockedTaxMinor: 0n,
    eligibleHeads: { ...heads },
    blockedHeads: zero,
  };
}

export function sumHeads(heads: TaxHeads): bigint {
  return heads.cgstMinor + heads.sgstMinor + heads.igstMinor + heads.cessMinor;
}

export function addHeads(a: TaxHeads, b: TaxHeads): TaxHeads {
  return {
    cgstMinor: a.cgstMinor + b.cgstMinor,
    sgstMinor: a.sgstMinor + b.sgstMinor,
    igstMinor: a.igstMinor + b.igstMinor,
    cessMinor: a.cessMinor + b.cessMinor,
  };
}

export const ZERO_HEADS: TaxHeads = Object.freeze({
  cgstMinor: 0n,
  sgstMinor: 0n,
  igstMinor: 0n,
  cessMinor: 0n,
});

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function block(
  blockReason: ItcBlockReason,
  statutoryRef: string,
  explanation: string,
  remedy?: string,
): BlockScreen {
  return {
    blocked: true,
    determination: {
      eligibility: "blocked",
      blockReason,
      statutoryRef,
      // ⭐ T3 in Rule 42. Everything blocked by Section 17(5) is deducted
      // from total credit BEFORE apportionment — a blocked credit never
      // enters the common pool, because there is nothing to apportion.
      rule42Attribution: "blocked",
      explanation,
      ...(remedy === undefined ? {} : { remedy }),
    },
  };
}
