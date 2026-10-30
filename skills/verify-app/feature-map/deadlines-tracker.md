# Deadlines tracker

The renewal tracker shows the program's renewal facts from the verified knowledge base and the date the person reports from their own letter or notice, each labeled by origin, and reminds the person in the app when that date gets close and after it passes. The app keeps the date only on the person's device and never sends it; a calendar file the person chooses to download is the reminder that lasts, and it is a plain copy of the date that their calendar app may sync.

## Sub-features

- `dl-kb` shows knowledge-base renewal schedules, dates, steps, links, and what happens if coverage ends, each labeled "From" the program with its source card (BN-22, BN-27).
- `dl-user` shows the date the person entered, labeled "You told us", never styled as official (BN-22).
- `dl-estimate` shows dates worked out from an approval date and the published schedules, each labeled as an estimate with the schedule and source it assumes, shaped by one optional age question.
- `dl-reminder` shows an in-app banner on every page except the tracker itself, which shows the same status, from 30 days before a date, on the day, and from the moment a date has passed until the person changes it, and offers a calendar file with alerts 30, 7, and 1 days before.
- `dl-private` keeps the date on the device: saved encrypted in this browser, removable, and never sent in a request.
- `dl-versions` flags stale or withdrawn knowledge-base facts instead of showing them silently, including on estimate reminders (BN-29).

## How to get to it (user POV)

- Open the renewal tracker page at `/renewal`.
- Follow "Open your renewal tracker" in the "Already have coverage? Keep track of your renewal" box at the end of the conversation once every question is answered.
- Follow the same box on the wizard's review screen.
- Follow "Already have coverage? Keep track of your renewal" on the home page.
- Follow the reminder banner's link from any other page once a saved date is within 30 days or has passed.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- The browser profile is fresh: no saved reminder for the site (clear site data first).
- The harness knows the device's local date; reminders follow the device clock, so a date inside the window is chosen relative to it rather than waited for.

- **Open the tracker.** Go to `/renewal`. Command: TBD — lands with the verify-app skill (HACK-8). Expected: every schedule, date, step, and link carries a "From" label and a source card; no date is labeled "You told us" yet; the form asks which date the person has and says a renewal notice's deadline goes under the first choice.
- **Say you do not know.** Choose "I don't know the date". Command: TBD — lands with the verify-app skill (HACK-8). Expected: a plain note to watch the mail; nothing is saved.
- **Enter a due date more than 30 days out.** Choose the due-date option, enter a date 60 days after the device's today, and save. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the date shows labeled "You told us", with a line that a reminder starts 30 days before, and the saved notice says to download the calendar file too; no banner on other pages.
- **Enter an approval date.** Change the date to an approval date late enough for every published schedule to apply (for the current pilot entry, any date from July 1, 2026 through today) and leave the age question blank. Command: TBD — lands with the verify-app skill (HACK-8). Expected: one estimate per schedule, each labeled "Estimate, not an official date" and naming its schedule with a "From" label and a source card.
- **Answer the age question.** Change the date again and choose "Younger than 19 or older than 64". Command: TBD — lands with the verify-app skill (HACK-8). Expected: the 6 month estimate is gone, a line says why, and the answer shows labeled "You told us".
- **Trigger the reminder.** Change the saved due date to 10 days after the device's today, then open `/` in a new tab. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the reminder banner at the top of the page says the renewal is due in 10 days and links to the tracker; a screen reader announces it.
- **Past due.** Change the due date to yesterday. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the tracker and the banner say the date has passed; the tracker points to the official steps and shows what happens if coverage ends, each item with its "From" label and source card.
- **First estimate passed.** Save an approval date about 7 months before the device's today. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the banner says an estimated date has passed and names the next estimate, on every page but the tracker, until the date is changed.
- **Calendar file.** Download the calendar file, change the date, and download again. Command: TBD — lands with the verify-app skill (HACK-8). Expected: one all-day event on the date (two for an approval date) with alerts at 9 AM 30, 7, and 1 days before, dropping any alert whose time already passed; neither the title, the notes, nor the alerts name the program, the event has no link, and the notes point back to the tracker; importing the second file updates the event instead of adding a copy in calendar apps that honor event identity, and an event the second file leaves out stays until it is deleted by hand.
- **No network.** Repeat save, change, download, and remove with the network panel open. Command: TBD — lands with the verify-app skill (HACK-8). Expected: no request carries the date; the browser's stored site data does not show the date in readable form.
- **Remove it.** Remove the reminder. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the form returns, the banner stops, and the stored site data for the reminder is gone.
- **Proof.** Capture the labeled tracker, the estimate list, the age answer, the banner, the past-due state, and the network log. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-22`.

## Gotchas

- Origin labeling is the check. A knowledge-base fact without its source card, a reported date styled as official, or an estimate without its estimate label all fail.
- Do not verify SMS reminders — the SMS channel is gated out of P0 (BN-42); the reminder is in-app and calendar-file only.
- A stale fact that renders like a live one is the worst failure mode here; the flag must be user-visible (BN-29), on the banner too when the reminder is an estimate.
- "Today" is the device's local date. Near midnight, a harness running in UTC and a browser in Eastern time disagree by a day at the 30-day edge, so read the date from the browser. A tab left open past midnight moves to the new day at midnight, clock-change nights included, or when it regains focus.
- The saved reminder lives in the browser profile. A private window or cleared site data starts empty, and the page then offers the calendar file only, which is the intended fallback rather than a failure.
- Browsers can clear the saved date on their own; Safari on iPhone and Mac does it after about seven days of use without a visit to the site. A reminder that vanished on a later visit is that rule, not a bug, and the page says the calendar file is the reminder that lasts.
- A saved reminder the page cannot read shows a banner line that sends the person to the tracker, which then removes it and says so. A silent removal is a failure.
- The date form appears only after the page finishes loading. A check that types before it appears finds no fields.
- Some calendar apps drop alerts from imported files, and some import a second file as a copy. Check the event in the app rather than trusting the file alone.
