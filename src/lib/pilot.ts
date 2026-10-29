// Pilot-config seam (Mission v2, VAL-X2-004).
//
// The single program-specific surface in the repo. Everything pilot-specific
// — program name, jurisdiction, form registry id, KB entry ids, portal links
// — is read from this module, and until the pilot decision formally lands
// (HACK-16) every value is a committed placeholder. Flipping to the chosen
// pilot is ONE reviewable commit in this file: no other repo surface may
// carry program-specific content.

export interface PilotPortalLink {
  readonly label: string;
  readonly url: string;
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
  /** Knowledge-base entries that ground the assistant for this pilot. */
  readonly kbEntryIds: readonly string[];
  /** Official portal links shown to the person (never auto-submitted). */
  readonly portalLinks: readonly PilotPortalLink[];
}

export const PILOT_CONFIG: PilotConfig = {
  programName: "{{PILOT_PROGRAM}}",
  countyName: "{{PILOT_COUNTY}}",
  stateCode: "{{PILOT_STATE}}",
  formRegistryId: "{{PILOT_FORM_REGISTRY_ID}}",
  kbEntryIds: ["{{PILOT_KB_ENTRY_ID}}"],
  portalLinks: [
    {
      label: "Official application portal",
      url: "{{PILOT_PORTAL_URL}}",
    },
  ],
};
