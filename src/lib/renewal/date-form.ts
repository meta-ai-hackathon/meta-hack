import { compareDates, formatIsoDate, type CalendarDate } from "./calendar-date";
import {
  ERROR_APPROVAL_IN_FUTURE,
  ERROR_CHOOSE_KIND,
  ERROR_INVALID_DATE,
  type DateChoice,
} from "./copy";
import { parseReportedDate, type ReportedDateKind } from "./reminder";

/**
 * The renewal tracker's form check (BN-22 / HACK-50), kept out of the
 * component so it is a plain function: a kind of date must be chosen
 * ("I don't know" saves nothing), the date must be real and within the
 * reported-year bounds, and an approval or renewal notice cannot be dated
 * after the device's today. A due date may be in the past; it then shows
 * as passed.
 */
export type DateFormCheck =
  | { readonly ok: true; readonly kind: ReportedDateKind; readonly reportedDate: string }
  | { readonly ok: false; readonly error: string; readonly field: "kind" | "date" };

export function checkDateForm(
  choice: DateChoice | "",
  dateText: string,
  today: CalendarDate,
): DateFormCheck {
  if (choice === "" || choice === "unknown") {
    return { ok: false, error: ERROR_CHOOSE_KIND, field: "kind" };
  }
  const date = parseReportedDate(dateText);
  if (date === null) {
    return { ok: false, error: ERROR_INVALID_DATE, field: "date" };
  }
  if (choice === "approval" && compareDates(date, today) > 0) {
    return { ok: false, error: ERROR_APPROVAL_IN_FUTURE, field: "date" };
  }
  return { ok: true, kind: choice, reportedDate: formatIsoDate(date) };
}
