// The entry-mode carry (VAL-FIX-003, the round-2 entry/home shell): the
// home surface's mode choice is carried to the conversation's
// engine-gated entry stage as a PRESELECTION. sessionStorage — tab-scoped
// and never persisted server-side; it names which of the two conversation
// entry modes the person picked, nothing else: not a consent decision,
// not answer data, no PII. The session itself still begins only from the
// person's explicit "Let's begin" on the entry stage, behind the consent
// gate — this carry never bypasses that.

const ENTRY_MODE_KEY = "bn_entry_mode_v1";

export type EntryMode = "voice-only" | "voice-plus-typing";

function isEntryMode(value: unknown): value is EntryMode {
  return value === "voice-only" || value === "voice-plus-typing";
}

export function storeEntryMode(mode: EntryMode): void {
  try {
    sessionStorage.setItem(ENTRY_MODE_KEY, mode);
  } catch {
    // Storage may be unavailable (private modes, quotas): the carry is a
    // convenience — the entry stage still offers both modes itself.
  }
}

/** Read-and-clear: the suggestion is consumed once, by the entry stage. */
export function takeStoredEntryMode(): EntryMode | null {
  try {
    const raw = sessionStorage.getItem(ENTRY_MODE_KEY);
    sessionStorage.removeItem(ENTRY_MODE_KEY);
    return isEntryMode(raw) ? raw : null;
  } catch {
    return null;
  }
}
