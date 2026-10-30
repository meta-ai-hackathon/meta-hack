"use client";

import { useState } from "react";
import { Field } from "./field";
import { StatusRegion } from "./status-region";

/**
 * Interactive demo of the BN-07 components on the home page: a labeled field
 * with help text, and a polite live region that announces a status change
 * when the button is pressed. Later flows replace this demo with real usage.
 */
export function A11yDemo() {
  // Press count varies the message so every press re-announces (aria-live
  // regions announce changes, not identical re-sets).
  const [presses, setPresses] = useState(0);
  return (
    <div className="flex w-full max-w-sm flex-col items-stretch gap-4 text-left">
      <Field
        id="a11y-demo-field"
        label="Example question with a label"
        help="Help text like this is read with the field it describes."
      >
        {(controlProps) => (
          <input
            {...controlProps}
            type="text"
            name="a11y-demo-field"
            className="rounded-xl border border-surface-border bg-surface px-3 py-2 text-base text-foreground"
          />
        )}
      </Field>
      <button
        type="button"
        onClick={() => setPresses((n) => n + 1)}
        className="rounded-full bg-teal-deep px-4 py-2 text-base font-semibold text-teal-contrast hover:bg-teal"
      >
        Show an example status update
      </button>
      <StatusRegion
        message={
          presses === 0
            ? ""
            : `Example status update, press ${presses}: this change was announced to assistive technology.`
        }
        className="min-h-6 rounded-xl border border-dashed border-surface-border px-3 py-1.5 text-sm text-muted"
      />
    </div>
  );
}
