import { ParseSpeeds, PDFDocument } from "@cantoo/pdf-lib";
import { fillLoadedPdf, type FillOutcome } from "../forms/fill-core";
import type { FormRegistryEntry } from "../forms/registry-core";
import type { ClientAnswerState } from "./client-store";
import { DEVICE_FORM_ENTRY, deviceFillValues } from "./device-form";

// Drawing the device answers onto the blank application form, in the
// browser (HACK-115). This is the one device module that loads pdf-lib, so
// the step-by-step page imports it only when the person asks to see their
// filled form: the questions never wait on the PDF library. The values come
// from deviceFillValues and the drawing is fill-core's, the same code the
// server's fill route runs. The filled bytes go to the print preview
// (device-print.ts), and to the browser as a file only when the person
// presses Download a copy (device-download.ts).

export type DeviceFillResult =
  | { readonly kind: "filled"; readonly outcome: FillOutcome }
  /** A typed answer didn't pass the checks (too long, for example). Nothing was filled. */
  | { readonly kind: "invalid_answers" }
  /** The blank form couldn't be opened. Nothing was filled. */
  | { readonly kind: "unreadable_form" };

/**
 * Fill the blank form with the device answers, in memory. The bytes are
 * the person's own filled application; nothing here stores or sends them.
 *
 * The template is the committed public form (device-template.ts serves the
 * registry's own bytes, pinned by a test, and that copy passes the
 * server's XFA and encryption gate). A copy that won't open, encrypted
 * ones included, fills nothing.
 */
export async function fillFormOnDevice(
  templateBytes: Uint8Array,
  answers: ClientAnswerState,
  typed: Readonly<Record<string, string>> = {},
  entry: FormRegistryEntry = DEVICE_FORM_ENTRY,
): Promise<DeviceFillResult> {
  const assembled = deviceFillValues(answers, typed, entry);
  if (assembled === null) {
    return { kind: "invalid_answers" };
  }
  let pdf: PDFDocument;
  try {
    // Parse fast (the same option review-fill.ts takes): the fork's
    // default Slow speed yields a `setTimeout` tick per ~100 parsed
    // objects, and a browser throttles background tabs' timers to about
    // one a second — a 21-page form's parse would take minutes of ticks.
    // Fast parses without the ticks, in one go.
    pdf = await PDFDocument.load(templateBytes, { parseSpeed: ParseSpeeds.Fast });
  } catch {
    return { kind: "unreadable_form" };
  }
  const { filled, toResolve, conflicts } = await fillLoadedPdf(
    pdf,
    entry,
    assembled.values,
    assembled.answerMap,
  );
  return {
    kind: "filled",
    // Saved in one go, too: the writer's default yields a `setTimeout`
    // tick per 50 objects, which a throttled background tab stretches to
    // minutes.
    outcome: {
      bytes: await pdf.save({ objectsPerTick: Infinity }),
      filled,
      toResolve,
      conflicts,
    },
  };
}
