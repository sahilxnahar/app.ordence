# Ordence — the industry feature register

**v0.56.0 · 3 August 2026.** Ten verticals, what each actually needs, and the
order to build them in. India-first throughout.

---

## Part 0 — The insight that decides the whole plan

Ten industries sounds like ten products. It is not.

Every business on your list does the same six things: **wins customers, promises
something, delivers it, bills for it, gets paid, and reports to a regulator.**
Ordence already has all six. What differs between a hospital and a logistics
company is not the shape of the software — it is *what the middle noun is*, and
what the statute says about it.

| | Hotel | Hospital | Logistics | Trading | Solar |
|---|---|---|---|---|---|
| The thing you sell | a room-night | an episode of care | a consignment move | a lot of goods | kWh over 25 years |
| The scarce resource | rooms | beds, theatres, doctors | trucks, drivers | working capital | roof area, irradiance |
| What decays | tonight's empty room | nothing | a truck's idle hour | a hedge position | panel output, 0.5%/yr |
| Who regulates | FSSAI, GST, state excise | NMC, NABH, DPDPA | e-way bill, FASTag | SEBI/FEMA, customs | CEA, DISCOM, MNRE |

**So the build is:** a small number of new SHARED ENGINES that several verticals
need, plus a THIN LAYER per industry — vocabulary, screens, statutory rules, and
which modules are switched on.

> ⚠️ **Get this backwards and you build ten products and maintain ten
> products.** The Section A registry exists precisely so an industry is a
> configuration, not a codebase.

**Rough proportions, measured against what already exists:**

- **~60%** of every vertical is already built (CRM, assets, contracts, orders,
  inventory, accounting, GST, TDS, receivables, workflows, documents, portals)
- **~30%** is **six new shared engines** — listed in Part 1
- **~10%** is genuinely industry-specific and irreducible

---

## Part 1 — The six shared engines, in dependency order

These are the real work. Each unlocks several verticals at once.

### ENGINE 1 · Scheduling & capacity ⭐ the keystone

**Unlocks:** hospitality, hospitals, logistics, services/CA, solar O&M
— **five of ten**

A bookable resource, a calendar, and the arithmetic of "can I fit this in".

- Resource types, capacity units, opening hours, blackout dates
- **Overbooking policy with a stated limit** — hotels deliberately oversell; a
  system that forbids it is unusable, and one that permits it silently is
  dangerous
- Double-booking prevention as a database constraint, **not** application code —
  the classic race where two agents sell the last room in the same second
- Waitlists, queue position, no-show handling
- Recurring blocks, shift patterns, on-call rotas
- **Reschedule cascade** — moving one appointment moves everything downstream
- Utilisation as a first-class number: occupancy %, RevPAR, billable ratio,
  truck fill rate. Different names, identical arithmetic

> ⚠️ **The hard part is not the calendar, it is the concurrency.** Every naive
> booking system works in testing and double-sells on the first busy day.

### ENGINE 2 · Rate & pricing engine

**Unlocks:** hospitality, logistics, trading, electricity, solar, finance

- Rate cards by season, day-of-week, channel, customer segment
- **Dynamic pricing** — occupancy-linked, demand-linked, lead-time-linked
- Tiered and slab pricing (first 100 units at X, next 400 at Y) — this one
  formula serves electricity tariffs, freight slabs and volume discounts
- Contracted rates that override list rates, with validity windows
- Surcharges: fuel, peak, night, hazmat, demand
- **Price history, immutable** — "what did we quote on 14 March" is a question
  that decides disputes

### ENGINE 3 · Field & mobile operations

**Unlocks:** logistics, solar, hospitals (home care), services, hospitality
(housekeeping)

- Job cards, dispatch, assignment by skill and proximity
- **Offline-first capture** — a driver in a tunnel, an engineer on a rooftop, a
  nurse in a basement ward. If it needs signal it does not get used
- Geotagged photo evidence, timestamped and tamper-evident
- Digital signature capture at point of delivery/service
- Route optimisation and live tracking
- Checklists with mandatory fields and hold points

### ENGINE 4 · Compliance calendar & filing engine

**Unlocks:** all ten. Highest leverage per line of code.

- A registry of every obligation: what, who, when, penalty for missing it
- Recurring generation, escalation ladder, evidence attachment
- Licence and certificate expiry with graduated warnings
- Inspection readiness packs
- **Regulator-specific formats** — GST returns exist; add ESIC, EPFO, FSSAI,
  Form 16/16A, CEA, PCB returns

> The reason this is the highest-leverage engine: it is the same table, the same
> reminder ladder and the same evidence store for all ten industries. Only the
> seed data differs.

### ENGINE 5 · Metering & consumption billing

**Unlocks:** electricity, solar, hospitality (utilities), logistics (fuel), SaaS

- Meter registry, readings, validation, estimated vs actual
- Time-of-day blocks, peak/off-peak
- Net metering — import, export, banked units, settlement
- Consumption → invoice, with the slab engine from Engine 2
- **Anomaly detection** — a meter reading that moves the wrong way, or jumps
  200%, is either theft, a fault, or a typo. All three need catching

### ENGINE 6 · Clinical & sensitive-data vault

**Unlocks:** hospitals, and hardens everything else

- Field-level encryption for defined sensitive categories
- **Purpose-bound access** — a doctor sees a chart because they are treating the
  patient, not because they hold the "doctor" role. Role-based access is not
  sufficient for health data
- Break-glass access: permitted, alarmed, reviewed
- Consent capture and withdrawal under **DPDPA 2023**
- Retention and lawful erasure
- Every read logged, not just every write

> ⚠️ **This is the one engine that cannot be retrofitted.** If health data lands
> in ordinary tables first, the migration is a data-protection incident. Build
> it before the first hospital, not after.

---

## Part 2 — The ten industries

Format for each: **the operating reality** → **must-have** → **advanced** →
**statutory (India)** → **what already exists**.

---

### 1 · HOSPITALITY — hotels, resorts, restaurants, banquets

**Operating reality.** You sell a perishable good. Tonight's empty room is
revenue that can never be recovered. Everything else follows from that.

**Must-have**

- Property, room-type, room, rate-plan hierarchy
- Reservation lifecycle: enquiry → tentative → confirmed → checked-in →
  checked-out → no-show → cancelled
- Front desk: check-in, room assignment, key issue, ID capture, walk-ins
- **Guest folio** — the running bill: room, F&B, laundry, minibar, spa, with
  split-folio for company-pays-room / guest-pays-extras
- Housekeeping board: dirty / clean / inspected / out-of-order
- Channel manager: OTA inventory sync, rate parity
- POS for restaurant and bar; KOT to kitchen; table plan
- Banquet and event bookings, function prospectus
- Night audit — the daily close that freezes the day's revenue

**Advanced**

- **Revenue management**: dynamic pricing on occupancy, pace, pickup, competitor
  rates, day-of-week and season curves
- Overbooking model with walk-cost calculation
- **RevPAR, ADR, occupancy, GOPPAR** as governed metrics, not spreadsheets
- Group blocks with cut-off dates and release rules
- Guest 360: stay history, preferences, allergies, complaints, lifetime value
- Loyalty tiers, points accrual and burn
- Yield by channel — the OTA that fills rooms at a commission that destroys
  margin should be visible as such
- F&B recipe costing, theoretical vs actual consumption, wastage
- Central reservations across multiple properties

**Statutory (India)**

- **GST**: room tariff slabs by rate band; restaurant at a different rate;
  the composite-vs-mixed supply question on packages
- **FSSAI** licence, renewal, kitchen hygiene records
- **State excise** for bar operations; stock registers
- **Form C** foreigner registration; police intimation
- Fire NOC, lift licence, weights & measures
- **TDS 194-I** on rent, 194-C on contracted services
- E-invoicing above the turnover threshold

**Already exists:** contacts, companies, orders, inventory, GST, TDS,
receivables, accounting, documents, portals, workflows
**Needs:** Engines 1, 2, 4 + folio + housekeeping + channel manager

---

### 2 · HOSPITALS & CLINICS

**Operating reality.** Two things run in parallel that must never be confused:
the **clinical record** (what happened to a person) and the **revenue cycle**
(who pays for it). Conflating them is how patient data leaks into billing
exports.

**Must-have**

- Patient registration, **UHID**, demographics, ABHA linkage
- Appointment scheduling by doctor, department, resource
- OPD flow: token, consultation, prescription, follow-up
- IPD: admission, bed allocation, transfer, discharge summary
- **Bed management** by ward, class, isolation status
- Order entry: labs, imaging, procedures — with results back
- Pharmacy: dispensing, batch, **expiry**, narcotics register
- Billing: package vs itemised, advance, interim, final
- **Insurance/TPA**: pre-authorisation, claim, query, settlement, denial
- OT scheduling, surgeon, anaesthetist, theatre, sterile-set tracking

**Advanced**

- **Clinical pathways** — the standard sequence for a condition, with deviation
  flagged
- Drug interaction and allergy checking at prescribe time
- **Critical-value alerting** — a lab result outside safe range must reach a
  human, with escalation if unacknowledged. This is the single highest-value
  safety feature in the list
- Bed-occupancy forecasting, discharge planning
- Case-mix and DRG-style costing — what does a knee replacement actually cost you
- Doctor-wise revenue, referral attribution, revenue share
- Ayushman Bharat / PMJAY, CGHS, ECHS scheme handling
- Home-care and teleconsultation
- CSSD tracking, biomedical equipment maintenance
- NABH evidence collection as a by-product of normal work

**Statutory (India)**

- **DPDPA 2023** — health data is sensitive; consent, purpose limitation, breach
  notification
- **Clinical Establishments Act** registration
- **NMC** doctor registration validity
- **NDPS** narcotics register — statutory format, physically auditable
- **Biomedical Waste Rules 2016** — colour-coded categories, manifests
- **PCPNDT** for imaging: Form F, no sex determination — a hard legal wall
- Drugs & Cosmetics Act, Schedule H/H1 dispensing records
- AERB for radiology
- GST: healthcare largely exempt, **but** pharmacy, canteen and room rent above
  the threshold are not — the exemption boundary is where mistakes live

**Already exists:** contacts, appointments-shaped workflows, inventory, orders,
receivables, accounting, documents, custom objects
**Needs:** Engines 1, 4, 6 + everything clinical. **The largest build on the
list, and the one with real liability.**

---

### 3 · LOGISTICS & TRANSPORT

**Operating reality.** You sell the movement of a thing between two points.
Your cost is time and fuel; your risk is the gap between what was loaded and
what arrives.

**Must-have**

- Consignment / LR (lorry receipt) / docket, with barcode
- Booking → pickup → in-transit → hub → out-for-delivery → **POD**
- Fleet: vehicle master, ownership vs attached vs market
- Driver master: **licence validity**, duty hours, allocation
- Trip sheet: start/end km, fuel, tolls, driver advance, expenses
- Hub and route network, transhipment
- Freight billing: weight vs volumetric, whichever is greater
- **E-way bill** generation, extension, part-B update
- POD capture with photo and signature

**Advanced**

- Route optimisation, multi-drop sequencing, live ETA
- **Load planning** — cubic and weight utilisation per vehicle
- Freight rate contracts per lane per customer per commodity
- **Fuel efficiency per vehicle per driver** — the single biggest controllable cost
- Vehicle maintenance schedules, tyre life, breakdown history
- Telematics: GPS, geofencing, harsh braking, idling
- Cold chain: temperature logging with excursion alerts
- **Detention and demurrage** billing — hours lost at a customer's dock are
  billable and almost never billed
- Claims and shortage management
- Reverse logistics, COD reconciliation
- Carbon per consignment

**Statutory (India)**

- **E-way bill** — the operational centre of Indian logistics compliance
- **GST under RCM** for goods transport agencies
- **TDS 194-C**
- Motor Vehicles Act: permits, fitness, PUC, insurance expiry
- **FASTag** reconciliation
- Driver working hours
- Hazmat licensing, TREM card
- **Carrier's liability** under the Carriage by Road Act

**Already exists:** orders, inventory, GST, TDS, receivables, accounting,
contracts, assets, workflows
**Needs:** Engines 1, 2, 3, 4 + consignment + fleet + e-way bill

---

### 4 · TRADING & DISTRIBUTION

**Operating reality.** You buy, you hold, you sell. Your margin is thin and your
enemies are stale stock, credit risk, and price moves between purchase and sale.

**Must-have**

- Item master: HSN, UOM, alternate UOM, pack size, barcode
- **Multi-warehouse stock, batch and serial, expiry**
- Purchase: indent → PO → GRN → quality → vendor invoice → three-way match
- Sales: quote → order → pick/pack → dispatch → invoice → e-way bill
- Price lists per customer per item, with validity
- **Credit limit enforcement at order entry**, not at month-end
- Landed cost: freight, duty, insurance apportioned into item cost
- Stock valuation: FIFO / weighted average, consistently
- Sales returns, purchase returns, credit and debit notes

**Advanced**

- **Reorder point and safety stock computed from actual demand variability**,
  not typed by hand
- ABC/XYZ classification, slow and dead stock ageing
- **Margin by item / customer / salesman / territory — after landed cost and
  after discounts.** Most distributors cannot answer this
- Scheme and discount engine: quantity slabs, free goods, cash discount
- Consignment stock at dealer locations
- Barcode/RFID picking, cycle counting
- Demand forecasting; seasonality
- Import: BOE, customs duty, exchange-rate variance
- Commodity price-risk and hedge positions where relevant
- Salesman beat plans, van sales, secondary sales capture

**Statutory (India)**

- **GST** end to end: tax invoice, e-invoice/IRN, e-way bill, GSTR-1/3B, **2B
  reconciliation**, ITC eligibility, Rule 42/43
- **TDS 194Q** on purchases, **TCS 206C(1H)** on sales — and the interaction
  between them, which is a genuine trap
- MSME payment timelines — **Section 43B(h)**: pay a micro/small vendor late and
  the expense is disallowed in that year
- Legal Metrology on packaged goods
- Import: customs, BIS, FSSAI where applicable

**Already exists:** orders, inventory, purchases, GST, GSTR-2B, TDS, Tally,
receivables, accounting, contacts, companies. **The most complete vertical
today** — perhaps 75% built
**Needs:** Engine 2 + landed cost + scheme engine + forecasting

---

### 5 · ELECTRICITY — generation, distribution, trading

**Operating reality.** You sell a product that cannot be stored, must be
balanced second by second, and is priced by a regulator.

**Must-have**

- Consumer master by category (domestic, commercial, industrial, agricultural)
- Connection lifecycle: application → sanction → meter → energisation
- **Meter registry, readings, billing cycles**
- **Slab tariff engine** — the arithmetic centre of the vertical
- Fixed charges, energy charges, demand charges, duty, cess, subsidy
- Bill generation, delivery, collection
- Disconnection and reconnection workflow
- Complaint and outage management

**Advanced**

- **Time-of-day tariffs**, peak/off-peak
- **Net metering** — import, export, banked units, annual settlement
- Open access, wheeling, banking charges
- **AT&C loss computation by feeder and DT** — the number that defines a
  distribution business
- Theft detection from consumption anomaly
- Load forecasting; DSM scheduling
- **REC and green certificate** tracking
- Prepaid meters, smart-meter integration
- Power purchase agreements and merit-order dispatch
- Peak-demand penalty and power-factor incentive
- SAIDI / SAIFI reliability indices

**Statutory (India)**

- **Electricity Act 2003**, state ERC tariff orders
- **CEA** metering regulations
- **Renewable Purchase Obligation** compliance
- Energy audit under the Energy Conservation Act
- GST on the non-exempt portion; electricity duty

**Already exists:** contacts, receivables, accounting, assets, workflows
**Needs:** Engines 2, 4, 5. **Engine 5 is the vertical.**

---

### 6 · SOLAR & RENEWABLES

**Operating reality.** You sell a 25-year promise. The money is made or lost in
generation performance and O&M discipline, long after the sale.

**Must-have**

- Site survey, shadow analysis, roof/land assessment
- System design: panel, inverter, structure, cable BOM
- **Generation estimate** and payback model
- Proposal, quotation, subsidy calculation
- Project execution: procurement, installation, commissioning
- **Net-metering application** and DISCOM liaison
- Commissioning certificate, handover pack

**Advanced**

- **Actual vs estimated generation, per site, per string, monthly** — the
  number the whole business turns on
- **Performance ratio and degradation** tracking against the warranty curve
- Inverter and monitoring-platform integration
- O&M contracts: preventive schedules, cleaning cycles, breakdown SLA
- **Soiling loss** vs cleaning cost — the optimisation that pays for itself
- Warranty claim management, panel serial traceability
- **PPA / RESCO / OPEX models**: you own the asset, the customer buys units.
  This turns a project business into a 25-year receivable and needs the
  metering engine
- Carbon credit and REC generation
- Subsidy claim: MNRE, state, disbursement tracking
- ALMM compliance and panel provenance
- Battery storage sizing and cycle tracking

**Statutory (India)**

- **MNRE** subsidy scheme rules; PM Surya Ghar
- **ALMM** approved-model list — installing a non-ALMM panel voids subsidy
- DISCOM net-metering regulations, state by state
- CEA safety, earthing, protection
- GST at the applicable renewable rate; the goods/services split on EPC
- Structural and fire NOCs

**Already exists:** contacts, deals, assets, contracts, orders, inventory,
receivables, accounting, documents
**Needs:** Engines 3, 4, 5 + design/BOM + generation analytics

---

### 7 · IT & SOFTWARE COMPANIES

**Operating reality.** You sell people's time or a subscription. Your only real
asset walks out at 6pm, and your margin is the gap between what you bill and
what you pay.

**Must-have**

- Project, phase, milestone, task
- **Timesheets** — the atom of the business
- Resource allocation and utilisation
- Client contracts: T&M, fixed price, retainer, milestone
- Billing from timesheets or milestones; retainer drawdown
- Expense capture and rebilling
- Sprint/issue tracking or integration with what the team already uses

**Advanced**

- **Utilisation, bench, and realisation rate** — billed hours ÷ worked hours.
  The three numbers that decide whether a services business is healthy
- **Project profitability with fully-loaded cost**, not just salary
- Revenue recognition: **Ind-AS 115** percentage-of-completion for fixed-price
- Capacity planning and pipeline-weighted resourcing
- SaaS metrics: MRR, ARR, churn, expansion, NRR, CAC payback
- Subscription billing, usage metering, dunning
- SLA tracking and credits
- Skill matrix, certifications, training
- Non-billable-time analysis
- **Software capitalisation** — which development spend is an asset
- ESOP register and vesting

**Statutory (India)**

- **STPI / SEZ** compliance, softex filing
- **Export of services**: LUT, zero-rated supply, FIRC/BRC realisation
- **Transfer pricing** for related-party offshore work
- **Section 194J** TDS on professional fees; **Equalisation levy** where relevant
- **EPF, ESI, PT, gratuity, POSH** — the employment stack
- DPDPA as a data processor for clients

**Already exists:** contacts, companies, deals, contracts, orders, receivables,
accounting, workflows, billing/metering, custom objects
**Needs:** timesheets + resourcing + revenue recognition. **Modest — perhaps
65% built**

---

### 8 · BASIC BUSINESSES — retail, SME, single-location

**Operating reality.** One owner, few staff, no patience. They will abandon
anything that takes more than an afternoon to start using.

**Must-have**

- Customers, suppliers, items — nothing more elaborate
- **Invoice in under 30 seconds**
- Purchase entry, stock in/out
- Payment in/out, cash and bank
- **GST-ready invoice, e-invoice where applicable**
- Day book, ledger, outstanding list
- WhatsApp invoice sending

**Advanced (but only where it stays invisible)**

- Barcode scanning, quick POS
- Auto reorder suggestion
- Customer credit tracking and reminders
- Simple loyalty
- Tally export
- Bank statement import and auto-reconciliation
- Basic MIS: today's sales, top items, who owes me money

**Statutory (India)**

- GST: invoice, e-invoice above threshold, GSTR-1/3B, composition where opted
- TDS where applicable
- **MSME/Udyam** registration, 43B(h) awareness
- Shops & Establishments

**Already exists:** essentially all of it
**Needs:** almost nothing new. **A packaging and simplification exercise, not a
build.** This is your fastest revenue and your best proving ground for the
entitlement filter — because here, hiding what they do not need IS the product

---

### 9 · FINANCE — NBFC, broking, wealth, lending

**Operating reality.** You are trusted with other people's money and watched by
a regulator with teeth. Auditability is not a feature, it is the product.

**Must-have**

- Client onboarding with **KYC**: PAN, Aadhaar (consented), address, bank
- **Risk profiling** and suitability
- Product master: loan, deposit, fund, policy, scheme
- Application → approval → disbursement / allotment
- **Repayment schedule, EMI, amortisation**
- Collection, receipt, allocation across principal/interest/charges
- Statement of account
- Nominee and joint holding

**Advanced**

- **Credit scoring and underwriting rules**, bureau pull, decisioning
- **NPA classification and provisioning** — SMA-0/1/2, sub-standard, doubtful,
  loss, per RBI IRAC norms
- Restructuring, moratorium, one-time settlement
- Portfolio analytics: yield, spread, vintage, roll-rate
- **Co-lending and securitisation**
- Broking: order, trade, contract note, margin, pledge
- Wealth: goal planning, asset allocation, rebalancing, XIRR
- Distributor commission and trail
- **AML/CFT**: transaction monitoring, alerts, **STR/CTR** filing
- Investor portal, e-sign, e-mandate/NACH

**Statutory (India)**

- **RBI** NBFC scale-based regulation, capital adequacy, exposure norms
- **SEBI** for broking, PMS, AIF, RIA — segregation, audit trail
- **PMLA**: KYC records, retention, reporting to FIU-IND
- **CKYC** registry upload
- Fair Practices Code, grievance redressal, ombudsman
- Ind-AS 109 ECL provisioning
- **TDS 194A** on interest, **206AB** for non-filers
- DPDPA on financial data

**Already exists:** contacts, companies, deals, contracts, accounting
(double-entry, trust-grade), receivables, documents, portals, audit, secops
**Needs:** loan lifecycle + KYC/AML + NPA engine. **Heavy on regulation, light
on new mechanics** — the double-entry core already carries it

---

### 10 · PROFESSIONAL SERVICES — CA, CS, legal, consulting

**Operating reality.** You sell judgement, bill for time, and live and die by
deadlines set by someone else's calendar.

**Must-have**

- Client master with **entity structure** — a client is a family, a firm and
  three companies, not one row
- Engagement letter, scope, fee basis
- **Compliance calendar per client**: GST monthly, TDS quarterly, ITR annual,
  ROC, audit
- Task assignment, review hierarchy, sign-off
- **Timesheets and WIP**
- Billing: fixed, hourly, retainer, success fee
- Document management with year/entity foldering
- DSC register, credential vault

**Advanced**

- **Recurring compliance auto-generation** — every client's obligations for the
  year, created once, tracked continuously
- **Deadline risk board**: what is due, what is late, whose fault, what it costs
- Client data collection portal with chase-up
- Government portal integration: GSTN, TRACES, MCA, income tax
- **WIP ageing and realisation** — the hours you worked and will never bill
- Partner and staff profitability
- Peer-review and audit-file readiness
- Conflict checking
- Knowledge base, precedent library
- Litigation: hearings, cause list, limitation dates
- e-Sign and e-Stamp

**Statutory (India)**

- **ICAI/ICSI/Bar Council** professional standards, UDIN generation
- Advertising restrictions — real constraints on what the CRM may send
- Client confidentiality and privilege
- Peer review, quality control (SQC 1)
- **Anti-money-laundering obligations** now extended to professionals
- DPDPA as processor

**Already exists:** contacts, companies, contracts, documents, workflows,
receivables, accounting, portals, custom objects, and the legal_advocate
industry template
**Needs:** Engines 1 and 4 + timesheets/WIP. **Engine 4 IS this vertical** —
build it here and it serves the other nine

---

## Part 3 — What to build, in order

Sequenced by leverage, not by interest.

| # | Build | Unlocks | Why here |
|---|---|---|---|
| 1 | **Engine 4 — compliance calendar** | all 10 | Cheapest engine, widest reach, and it is the entire CA vertical |
| 2 | **Basic businesses** vertical | 1 | Almost nothing new. Fastest revenue, proves the entitlement filter |
| 3 | **Trading & distribution** | 1 | ~75% built. Finish landed cost, schemes, forecasting |
| 4 | **Engine 1 — scheduling** | 5 | The keystone. Concurrency-safe from day one |
| 5 | **Engine 2 — pricing** | 6 | Slab arithmetic serves tariffs, freight and discounts alike |
| 6 | **Professional services** | 1 | Engines 1 + 4 already done by now |
| 7 | **Engine 3 — field ops** | 5 | Offline-first is the hard requirement |
| 8 | **Logistics** | 1 | E-way bill is the differentiator |
| 9 | **Hospitality** | 1 | Folio + housekeeping + channel manager |
| 10 | **Engine 5 — metering** | 3 | |
| 11 | **Solar** | 1 | Generation analytics on Engine 5 |
| 12 | **Electricity** | 1 | Engine 5 plus tariff regulation |
| 13 | **IT/software** | 1 | Timesheets + Ind-AS 115 |
| 14 | **Finance** | 1 | Regulatory depth, on existing accounting |
| 15 | **Engine 6 + Hospitals** | 1 | **Last, deliberately** — see below |

### Why hospitals go last

Not because it is least valuable — it may be the most. Because it is the only
one where getting it wrong is a **patient-safety and data-protection incident**
rather than a bug. Health data cannot be migrated into a vault after the fact
without that migration itself being a breach. Engine 6 has to exist before the
first patient record does, and by position 15 you will have the operational
maturity to run it.

---

## Part 4 — What this means for the registry

Each industry becomes an entry in `lib/industry-templates.ts` and a set of
modules in `lib/modules/registry.ts`. Concretely:

- **53 feature keys today → roughly 180** when all ten are covered
- **3 industry templates → 13**
- **6 new engines**, each a schema + SQL + screens, in the pattern already
  established by orders, inventory and land
- **Every module carries `industries: [...]`**, so a hotel never sees a
  consignment note and a hospital never sees a rate card

> ⚠️ **The trap to avoid: a feature key per industry per capability.** Scheduling
> is `scheduling.resources`, not `hotel.rooms` + `hospital.beds` +
> `logistics.slots`. Three keys for one engine means three code paths, three
> bugs, and a pricing model nobody can explain. The vocabulary differs; the
> capability does not.

---

## Still pending, unchanged

`admin.ordence.com` returns 404 while `app.ordence.com/api/diag` reports both
platform keys present — so the guard is fine and the session is probably not
reaching the admin subdomain. The next diagnostic is
`https://admin.ordence.com/api/diag`, checking whether `signedIn` is true there.
Parked at your request, not forgotten.
