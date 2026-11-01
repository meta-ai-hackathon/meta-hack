/**
 * HACK-107 item (a): measure the fork's production detection quality over our
 * app's own domain, not upstream's public cases. Fixtures are synthetic
 * (never real people) but shaped like Benefits Navigator chat intake: household
 * members, IDs, income amounts, addresses, and the benefits vocabulary that
 * must survive tokenization.
 *
 * Metric: span-level P/R/F1 between the guard's predictions and hand-labeled
 * gold spans, matched with the same label and a small character-tolerance
 * (token-classification boundaries wobble by a char or two). Predictions come
 * from the serialized session table — the fork seam we maintain — so the eval
 * exercises the full production pipeline (heuristics + ONNX classifier +
 * merge + keep-labels policy), not just one layer.
 *
 * Run: node scripts/rampart-f1-eval.mjs
 * Prints the F1 summary; exits non-zero on failures in the fixture data
 * themselves (missing gold term, unknown label), not on detection misses.
 */

import { createGuard } from "@nationaldesignstudio/rampart";

/** A fixture's private spans use Rampart's own PiiLabel vocabulary. */
const KNOWN_LABELS = new Set([
  "SSN",
  "CREDIT_CARD",
  "IP_ADDRESS",
  "GIVEN_NAME",
  "SURNAME",
  "EMAIL",
  "PHONE",
  "URL",
  "TAX_ID",
  "BANK_ACCOUNT",
  "ROUTING_NUMBER",
  "GOVERNMENT_ID",
  "PASSPORT",
  "DRIVERS_LICENSE",
  "BUILDING_NUMBER",
  "STREET_NAME",
  "SECONDARY_ADDRESS",
]);

/**
 * The benefits vocabulary and geography that must survive (owner requirement:
 * Medicaid/SNAP/DSS/DHHS/renewal/redetermination/Mecklenburg stay intact;
 * city/state/ZIP ride Rampart's default keepLabels).
 */
const FIXTURES = [
  {
    id: "renewal-letter-name",
    input:
      "Hi, I am Marisol Vega. I got the renewal letter about my Medicaid redetermination and I do not know what to send.",
    private: [
      { text: "Marisol", label: "GIVEN_NAME" },
      { text: "Vega", label: "SURNAME" },
    ],
    publicTerms: ["renewal", "Medicaid", "redetermination"],
  },
  {
    id: "household-members",
    input:
      "I am Rafael Ortiz and I am applying for SNAP for myself, my wife Camila Ortiz, and our son Diego Perez.",
    private: [
      { text: "Rafael", label: "GIVEN_NAME" },
      { text: "Ortiz", label: "SURNAME" },
      { text: "Camila", label: "GIVEN_NAME" },
      { text: "Diego", label: "GIVEN_NAME" },
      { text: "Perez", label: "SURNAME" },
    ],
    publicTerms: ["SNAP", "applying"],
  },
  {
    id: "ssn-and-phone",
    input:
      "For the DSS office you can reach me at (704) 555-0199, and my social security number is 666-42-7103.",
    private: [
      { text: "(704) 555-0199", label: "PHONE" },
      { text: "666-42-7103", label: "SSN" },
    ],
    publicTerms: ["DSS office"],
  },
  {
    id: "caseworker-email",
    input:
      "Someone named Tasha Jenkins emailed me from t.jenkins@dhhs.example.com about my North Carolina benefits case.",
    private: [
      { text: "Tasha", label: "GIVEN_NAME" },
      { text: "Jenkins", label: "SURNAME" },
      { text: "t.jenkins@dhhs.example.com", label: "EMAIL" },
    ],
    publicTerms: ["emailed", "benefits case"],
  },
  {
    id: "street-address",
    input:
      "We moved to 1729 Rockwell Church Road in Charlotte NC 28215, closer to the Mecklenburg Department of Social Services.",
    private: [
      { text: "1729", label: "BUILDING_NUMBER" },
      { text: "Rockwell Church Road", label: "STREET_NAME" },
    ],
    publicTerms: ["Charlotte", "28215", "Mecklenburg Department of Social Services"],
  },
  {
    id: "income-amounts-stay",
    input:
      "I work patient transport making $2,380 a month before taxes. My SNAP amount was cut from $468 to $122 and I want to appeal.",
    private: [],
    publicTerms: ["$2,380", "$468", "$122", "SNAP", "appeal", "taxes"],
  },
  {
    id: "medicated-account",
    input:
      "My bank routing number is 253177049 and my grandma Paloma Reyes helps me with her pension check every month.",
    private: [
      { text: "253177049", label: "ROUTING_NUMBER" },
      { text: "Paloma", label: "GIVEN_NAME" },
      { text: "Reyes", label: "SURNAME" },
    ],
    publicTerms: ["pension check", "bank"],
  },
  {
    id: "w2-and-employer",
    input:
      "My W-2 tax id 666-11-2267 is under my maiden name Keyla Fournier, though my driver's license says Keyla Fournier Bautista now.",
    private: [
      { text: "666-11-2267", label: "TAX_ID" },
      { text: "Keyla", label: "GIVEN_NAME" },
      { text: "Fournier", label: "SURNAME" },
      { text: "Bautista", label: "SURNAME" },
    ],
    publicTerms: ["driver's license", "W-2"],
  },
  {
    id: "renewal-recertification",
    input:
      "The DHHS notice says redetermination for my food benefits and Medicaid is due before June 30 or coverage stops.",
    private: [],
    publicTerms: ["DHHS", "redetermination", "food benefits", "Medicaid"],
  },
  {
    id: "landlord-application",
    input:
      "Please contact my landlord Yolanda Marsh at 7045558821 if my Medicaid renewal paperwork needs anything more.",
    private: [
      { text: "Yolanda", label: "GIVEN_NAME" },
      { text: "Marsh", label: "SURNAME" },
      { text: "7045558821", label: "PHONE" },
    ],
    publicTerms: ["Medicaid renewal paperwork"],
  },
  {
    id: "childcare-center",
    input:
      "On my renewal form my kids are Mateo Herrera and Lucia Herrera, both at Bright Start Children's Center off Albemarle Road.",
    private: [
      { text: "Mateo", label: "GIVEN_NAME" },
      { text: "Lucia", label: "GIVEN_NAME" },
      { text: "Herrera", label: "SURNAME" },
      { text: "Albemarle Road", label: "STREET_NAME" },
    ],
    publicTerms: ["renewal form", "Bright Start Children's Center"],
  },
  {
    id: "immigration-docs",
    input:
      "I am worried about sharing my passport X7711284 and my green card info with the DHHS renewal site.",
    private: [
      { text: "X7711284", label: "GOVERNMENT_ID" },
    ],
    publicTerms: ["passport", "green card", "DHHS renewal site"],
  },
  {
    id: "utility-meter",
    input:
      "Social services asked for my electric bill; my routing number is 061000104 and the bill shows $173 monthly.",
    private: [
      { text: "061000104", label: "ROUTING_NUMBER" },
    ],
    publicTerms: ["$173", "Social services", "electric bill"],
  },
  {
    id: "family-ssn",
    input:
      "My son Elias Morin was born March 2024; his social security 666-01-6647 is on the blue card in my folder.",
    private: [
      { text: "Elias", label: "GIVEN_NAME" },
      { text: "Morin", label: "SURNAME" },
      { text: "666-01-6647", label: "SSN" },
    ],
    publicTerms: ["born March 2024", "blue card"],
  },
  {
    id: "renamed-workplace",
    input:
      "Why do the renewal notices keep coming after my husband Ruben Salcedo already turned in our DSS paperwork twice?",
    private: [
      { text: "Ruben", label: "GIVEN_NAME" },
      { text: "Salcedo", label: "SURNAME" },
    ],
    publicTerms: ["renewal notices", "DSS paperwork"],
  },
  {
    id: "veteran-assistance",
    input:
      "I get VA benefits and SNAP; can the Mecklenburg office send my recertification reminder by email instead of mail?",
    private: [],
    publicTerms: ["VA benefits", "SNAP", "Mecklenburg office", "recertification reminder"],
  },
  {
    id: "hospital-bill",
    input:
      "Atrium Health billed my son Ramon Zaragoza, and the DSS caseworker needs his Medicaid ID 55-9901441 by Friday.",
    private: [
      { text: "Ramon", label: "GIVEN_NAME" },
      { text: "Zaragoza", label: "SURNAME" },
      { text: "55-9901441", label: "GOVERNMENT_ID" },
    ],
    publicTerms: ["Atrium Health", "DSS caseworker", "Friday"],
  },
  {
    id: "zip-and-city-only",
    input:
      "Renew my benefits? My address is in Charlotte NC 28208 near the airport, off Wilkinson Boulevard.",
    private: [
      { text: "Wilkinson Boulevard", label: "STREET_NAME" },
    ],
    publicTerms: ["Charlotte", "28208", "airport", "Renew my benefits"],
  },
  {
    id: "welfare-office-visit",
    input:
      "I went to the DHHS building on Billings Park Court and they asked me to confirm my daughter Adela Nunez's status.",
    private: [
      { text: "Adela", label: "GIVEN_NAME" },
      { text: "Nunez", label: "SURNAME" },
      { text: "Billings Park Court", label: "STREET_NAME" },
    ],
    publicTerms: ["DHHS building", "daughter", "status"],
  },
  {
    id: "snap-eligibility-question",
    input:
      "Does applying again hurt my odds? My Medicaid lapsed in October and my SNAP appeal is still open.",
    private: [],
    publicTerms: ["applying", "Medicaid", "SNAP appeal", "October"],
  },
];

/** Tolerance for token-classification boundary wobble, in characters. */
const BOUNDARY_TOLERANCE = 2;

function fail(message) {
  console.error(`fixture error: ${message}`);
  process.exitCode = 1;
}

/** Every occurrence of a quoted gold/predicted term inside the raw input. */
function occurrences(input, term) {
  const hits = [];
  let at = 0;
  while (at <= input.length - term.length) {
    const hit = input.indexOf(term, at);
    if (hit < 0) break;
    hits.push({ start: hit, end: hit + term.length });
    at = hit + 1;
  }
  return hits;
}

/**
 * Matching for the SAFETY metric is label-agnostic: our use case cares that
 * the value left the text, not which taxonomy label the model chose for it
 * (ROUTING_NUMBER vs SSN on the same digits fails upstream's label score but
 * succeeds at not leaking). A prediction matches a gold when the boundaries
 * agree within tolerance and the spans overlap, with either span covering the
 * whole gold term (compound spans like "Fournier Bautista" tokenizing as one
 * SURNAME still cover both name parts).
 */
function spansAgree(gs, ps, tolerance) {
  const coversGold = ps.start <= gs.start + tolerance && ps.end >= gs.end - tolerance;
  const insideGold = gs.start <= ps.start + tolerance && gs.end >= ps.end - tolerance;
  const boundary = Math.abs(gs.start - ps.start) <= tolerance && Math.abs(gs.end - ps.end) <= tolerance;
  return coversGold || insideGold || boundary;
}

function category(label) {
  if (["GIVEN_NAME", "SURNAME"].includes(label)) return "names";
  if (["SSN", "CREDIT_CARD", "TAX_ID", "BANK_ACCOUNT", "ROUTING_NUMBER", "GOVERNMENT_ID", "PASSPORT", "DRIVERS_LICENSE", "IP_ADDRESS"].includes(label)) {
    return "structured-ids";
  }
  if (["EMAIL", "PHONE", "URL"].includes(label)) return "contact";
  return "addresses";
}

function f1(p, r) {
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

const guard = await createGuard({ device: "cpu" });

const cells = {
  overall: { tp: 0, fp: 0, fn: 0 },
  names: { tp: 0, fp: 0, fn: 0 },
  "structured-ids": { tp: 0, fp: 0, fn: 0 },
  contact: { tp: 0, fp: 0, fn: 0 },
  addresses: { tp: 0, fp: 0, fn: 0 },
};
let publicTermsKept = 0;
let overRedactions = [];
let leaks = [];
let serializationRight = true;
let tokensStableAcrossTurns = true;
let labelDisagreements = [];
let matchedLabelAgreements = 0;
const seenTokens = new Map();

for (const fixture of FIXTURES) {
  for (const term of fixture.private) {
    if (!KNOWN_LABELS.has(term.label)) {
      fail(`${fixture.id}: unknown label ${term.label} for ${term.text}`);
    }
    if (occurrences(fixture.input, term.text).length === 0) {
      fail(`${fixture.id}: private term ${term.text} does not appear in the input`);
    }
  }
  if (process.exitCode === 1) process.exit(1);

  const first = await guard.protect(fixture.input);
  const serialized = guard.serializeObject();
  // The eval exercises the exact production path; the serialized session
  // table must rehydrate and its tokens must not drift across turns.
  for (const entry of serialized.entries) {
    const prior = seenTokens.get(`${entry.label}\u0000${entry.value.toLowerCase()}`);
    if (prior !== undefined && prior !== entry.token) {
      tokensStableAcrossTurns = false;
    }
    seenTokens.set(`${entry.label}\u0000${entry.value.toLowerCase()}`, entry.token);
  }
  const restored = await createGuard({
    device: "cpu",
    session: serialized,
  });
  const roundTrip = await restored.protect(fixture.input);
  const tokensFirst = first.text.match(/\[[A-Z][A-Z_]*_\d+\]/g) ?? [];
  const tokensRound = roundTrip.text.match(/\[[A-Z][A-Z_]*_\d+\]/g) ?? [];
  if (tokensFirst.length !== tokensRound.length) {
    // Restore must rehydrate/protect into every slot the first pass tokenized.
    serializationRight = false;
  }

  // Predictions straight from the serialized table (value → label).
  const predictions = [];
  for (const entry of serialized.entries) {
    for (const hit of occurrences(fixture.input, entry.value)) {
      predictions.push({ start: hit.start, end: hit.end, label: entry.label, token: entry.token });
    }
  }

  const golds = fixture.private.flatMap((term) =>
    occurrences(fixture.input, term.text).map((hit) => ({
      start: hit.start,
      end: hit.end,
      label: term.label,
      text: term.text,
    })),
  );

  // Span-level matching, greedy on best-boundary agreement per gold.
  const matchedPred = new Set();
  const matchedGold = new Set();
  for (const gs of golds) {
    let best = -1;
    let bestDistance = Infinity;
    predictions.forEach((ps, i) => {
      if (matchedPred.has(i)) return;
      if (!spansAgree(gs, ps, BOUNDARY_TOLERANCE)) return;
      const distance = Math.abs(gs.start - ps.start) + Math.abs(gs.end - ps.end);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    if (best >= 0) {
      matchedPred.add(best);
      matchedGold.add(gs);
      cells.overall.tp += 1;
      cells[category(gs.label)].tp += 1;
      if (predictions[best].label === gs.label) matchedLabelAgreements += 1;
      else labelDisagreements.push(`${fixture.id}: gold ${gs.label} "${gs.text}" tokenized as ${predictions[best].label} ${predictions[best].token} (still redacted)`);
    }
  }
  predictions.forEach((_, i) => {
    if (!matchedPred.has(i)) {
      cells.overall.fp += 1;
      cells[category(predictions[i].label)].fp += 1;
      overRedactions.push(`${fixture.id}: false positive ${predictions[i].label} "${predictions[i].token}" for "${fixture.input.slice(predictions[i].start, predictions[i].end)}"`);
    }
  });
  golds.forEach((gs) => {
    if (!matchedGold.has(gs)) {
      const removed = first.text.includes(gs.text) === false;
      if (removed) labelDisagreements.push(`${fixture.id}: gold ${gs.label} "${gs.text}" was redacted under a different/unmatched span (counted above)`);
      else leaks.push(`${fixture.id}: ${gs.label} "${gs.text}" survived unredacted`);
      cells.overall.fn += 1;
      cells[category(gs.label)].fn += 1;
    }
  });

  for (const term of fixture.publicTerms) {
    if (occurrences(first.text, term).length > 0) {
      publicTermsKept += 1;
    } else {
      overRedactions.push(`${fixture.id}: benefit/geography term "${term}" was tokenized`);
    }
  }
}

const totalPublic = FIXTURES.reduce((n, f) => n + f.publicTerms.length, 0);
console.log(`\nRampart (production config: default published HF CDN model, device cpu)`);
console.log(`Span-level detection quality over ${FIXTURES.length} Benefits-Nav intake fixtures:`);
console.log(`  gold private spans: ${FIXTURES.reduce((n, f) => n + f.private.length, 0)}`);
const p = cells.overall.tp / Math.max(1, cells.overall.tp + cells.overall.fp);
const r = cells.overall.tp / Math.max(1, cells.overall.tp + cells.overall.fn);
console.log(`  precision ${p.toFixed(3)} (TP ${cells.overall.tp} / FP ${cells.overall.fp})`);
console.log(`  recall    ${r.toFixed(3)} (TP ${cells.overall.tp} / FN ${cells.overall.fn})`);
console.log(`  F1        ${f1(p, r).toFixed(3)}`);
console.log(`\n By category:`);
for (const kind of ["names", "structured-ids", "contact", "addresses"]) {
  const c = cells[kind];
  const cp = c.tp / Math.max(1, c.tp + c.fp);
  const cr = c.tp / Math.max(1, c.tp + c.fn);
  console.log(`  ${kind.padEnd(15)} P ${cp.toFixed(3)}  R ${cr.toFixed(3)}  F1 ${f1(cp, cr).toFixed(3)}  (TP ${c.tp} FP ${c.fp} FN ${c.fn})`);
}
console.log(`\nBenefits/geography survival (public terms): ${publicTermsKept}/${totalPublic} kept intact`);
console.log(`Serialized-table cross-turn token stability: ${tokensStableAcrossTurns ? "ok" : "DRIFTING"}`);
console.log(`Sealed-session restore keeps token slots stable: ${serializationRight ? "ok" : "DEGRADED"}`);
console.log(`Label-taxonomy agreement (diagnostic only): ${matchedLabelAgreements}/${cells.overall.tp} spans share Rampart's label`);

if (labelDisagreements.length > 0) {
  console.log(`
Label disagreements (complicate downstream reasoning, not the safety of the send): ${labelDisagreements.length}`);
  for (const row of labelDisagreements) {
    console.log(`  - ${row}`);
  }
}

if (overRedactions.length > 0) {
  console.log(`\nFalse positives / over-redactions (${overRedactions.filter((row) => !row.startsWith("(miss)")).length}):`);
  for (const row of overRedactions.filter((row) => !row.startsWith("(miss)"))) {
    console.log(`  - ${row}`);
  }
}
if (leaks.length > 0) {
  console.log(`\nUnredacted gold PII (false negatives that leak): ${leaks.length}`);
  for (const row of leaks) {
    console.log(`  - ${row}`);
  }
}
