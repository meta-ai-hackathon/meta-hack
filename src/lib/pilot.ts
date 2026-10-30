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
};
