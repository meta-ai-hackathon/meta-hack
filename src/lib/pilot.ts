// Pilot-config seam (Mission v2, VAL-X2-004).
//
// The single program-specific surface in the repo. Everything pilot-specific
// — program name, jurisdiction, form registry id, KB entry ids, portal links
// — is read from this module. HACK-16 is Done on Linear (Oct 30): the pilot
// is NC Medicaid, Mecklenburg County NC, and this file carries the REAL
// program. This flip is the one reviewable commit the seam was designed for;
// no other repo surface may carry program-specific content outside the
// sanctioned surfaces (versioned KB/glossary + form-registry entries with
// official sources, and repo docs describing the locked pilot).
//
// Every official URL below was retrieved 2026-10-30 from the official
// application guidance page (https://medicaid.ncdhhs.gov/apply, which
// displays "last modified 10/08/2026"). Re-verify against the source pages
// before relying on a link in production copy.

export interface PilotPortalLink {
  readonly label: string;
  readonly url: string;
  /** YYYY-MM-DD: when the linked page's content was retrieved + verified. */
  readonly retrievedAt: string;
}

/**
 * An additional application one session's answers also prepare (snap-form
 * milestone, VAL-SNAP-004/005): ask-once reuse across programs. The
 * registries' spec_question_id links drive the carry-over — an
 * already-answered question is never re-asked on either surface.
 */
export interface PilotApplication {
  /** The program's plain-language name as the person knows it. */
  readonly programName: string;
  /** The form-registry entry the PDF pipeline fills for this program. */
  readonly formRegistryId: string;
  /**
   * The honest entry-point copy on the results/review surface. Promises
   * nothing: the program is decided solely by the agency; the app
   * prepares, the person reviews, signs, and submits themselves.
   */
  readonly entryPoint: {
    readonly headline: string;
    readonly detail: string;
    /** The control's accessible name (what choosing it does). */
    readonly action: string;
  };
  /** Official portal links shown to the person (never auto-submitted). */
  readonly portalLinks: readonly PilotPortalLink[];
}

export interface PilotConfig {
  /** The benefits program the pilot serves. */
  readonly programName: string;
  /** The county or city area the pilot serves. */
  readonly countyName: string;
  /** Two-letter state code for the pilot jurisdiction. */
  readonly stateCode: string;
  /** The form-registry entry the PDF pipeline fills for this pilot. */
  readonly formRegistryId: string;
  /**
   * The committed SYNTHETIC demo form (a fixture, not program-specific):
   * the registry entry the validation journeys fill. Stays registered
   * alongside the real form so the sample-based tests keep running.
   */
  readonly sampleFormRegistryId: string;
  /** Knowledge-base entries that ground the assistant for this pilot. */
  readonly kbEntryIds: readonly string[];
  /** Official portal links shown to the person (never auto-submitted). */
  readonly portalLinks: readonly PilotPortalLink[];
  /**
   * The additional applications the SAME session's answers also prepare
   * ("also prepare" entry points on the results/review surface, in order).
   */
  readonly additionalApplications: readonly PilotApplication[];
}

export const PILOT_CONFIG: PilotConfig = {
  programName: "NC Medicaid",
  countyName: "Mecklenburg County",
  stateCode: "NC",
  // The real application form: DHB-5200 (form revision IA-9-2020), the
  // printable application linked from the official apply page.
  formRegistryId: "dhb-5200",
  sampleFormRegistryId: "sample-application-form",
  kbEntryIds: ["nc_medicaid"],
  portalLinks: [
    {
      label: "Apply online through ePASS",
      url: "https://epass.nc.gov/",
      retrievedAt: "2026-10-30",
    },
    {
      label: "How to apply for NC Medicaid (official guidance)",
      url: "https://medicaid.ncdhhs.gov/apply",
      retrievedAt: "2026-10-30",
    },
    {
      label: "Printable application (DHB-5200, PDF)",
      url: "https://policies.ncdhhs.gov/wp-content/uploads/dhb-5200-ia-9-2020.pdf",
      retrievedAt: "2026-10-30",
    },
  ],
  additionalApplications: [
    {
      programName: "Food and Nutrition Services (SNAP)",
      formRegistryId: "dss-8207",
      entryPoint: {
        headline: "Also prepare your SNAP application (DSS-8207)",
        detail:
          "The same answers can prepare a Food and Nutrition Services " +
          "application. Applying may be worth pursuing — SNAP is decided " +
          "solely by your county DSS. We prepare the form; you review it, " +
          "sign it, and submit it yourself.",
        action: "Prepare my SNAP application from these answers",
      },
      portalLinks: [
        {
          label: "Apply online through ePASS",
          url: "https://epass.nc.gov/",
          retrievedAt: "2026-11-01",
        },
        {
          label: "Food and Nutrition Services (official guidance)",
          url: "https://www.ncdhhs.gov/divisions/child-and-family-well-being/food-and-nutrition-services-food-stamps",
          retrievedAt: "2026-11-01",
        },
        {
          label: "Printable application (DSS-8207, PDF)",
          url: "https://policies.ncdhhs.gov/wp-content/uploads/DSS-8207-FNS-App_10.2024.pdf",
          retrievedAt: "2026-11-01",
        },
      ],
    },
  ],
};

/**
 * The pilot application a form id belongs to: the pilot's primary program
 * for its own form, or one of the additional applications. Null for forms
 * outside the pilot's programs (the sample/demo fixtures) — callers fall
 * back to the pilot's primary identity.
 */
export function pilotApplicationForForm(formId: string): {
  programName: string;
  portalLinks: readonly PilotPortalLink[];
} | null {
  if (formId === PILOT_CONFIG.formRegistryId) {
    return {
      programName: PILOT_CONFIG.programName,
      portalLinks: PILOT_CONFIG.portalLinks,
    };
  }
  const additional = PILOT_CONFIG.additionalApplications.find(
    (application) => application.formRegistryId === formId,
  );
  if (!additional) {
    return null;
  }
  return {
    programName: additional.programName,
    portalLinks: additional.portalLinks,
  };
}
