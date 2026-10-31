import { PDFDocument } from "@cantoo/pdf-lib";
import { fillLoadedPdf, type FillOutcome } from "../forms/fill-core";
import type { FormRegistryEntry } from "../forms/registry-core";
import type { ClientAnswerState } from "./client-store";
import { DEVICE_FORM_ENTRY, deviceFillValues } from "./device-form";

// Drawing the device answers onto the blank application form, in the
// browser (HACK-115). This is the one device module that loads pdf-lib, so
// the step-by-step page imports it only when the person downloads: the
// questions never wait on the PDF library. The values come from
// deviceFillValues and the drawing is fill-core's, the same code the
// server's fill route runs.

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
    pdf = await PDFDocument.load(templateBytes);
  } catch {
    return { kind: "unreadable_form" };
  }
  const { filled, toResolve } = await fillLoadedPdf(
    pdf,
    entry,
    assembled.values,
    assembled.answerMap,
  );
  return { kind: "filled", outcome: { bytes: await pdf.save(), filled, toResolve } };
}
