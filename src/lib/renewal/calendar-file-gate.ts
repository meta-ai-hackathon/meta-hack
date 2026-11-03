/**
 * Whether the renewal tracker offers its calendar file (.ics) download
 * (HACK-50 review, P2 on 7fbeb3c).
 *
 * The calendar file is the one copy of the person's renewal date that is
 * not sealed: it lands in plaintext in the downloads folder, and a
 * calendar that syncs passes the date to its provider. Every other copy is
 * encrypted under a key that exists only on the device, and AGENTS.md lets
 * answer data leave the device only through the fax. Whether a download
 * the person chooses is allowed is a policy decision for a person, and
 * nobody has recorded it yet.
 *
 * So this stays false until a person records on HACK-50 whether a
 * plaintext calendar file is allowed. While it is false the tracker shows
 * no download control, never builds or offers the file, and no line of its
 * copy mentions one (LINES_WITHOUT_CALENDAR_FILE in copy.ts). The in-app
 * reminder and the banner work the same either way. Turning it on brings
 * the download back exactly as it was, which is why the calendar builder
 * (reminder-calendar.ts, ics.ts) and its tests stay in place. Turn it on
 * only in a change that links the recorded decision, and update the docs
 * that say the download is gated (README.md, feature.md, and
 * skills/verify-app/feature-map/deadlines-tracker.md).
 */
export const CALENDAR_FILE_DOWNLOAD_ENABLED: boolean = false;
