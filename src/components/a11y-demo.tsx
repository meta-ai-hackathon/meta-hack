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
            className="rounded-md border border-zinc-400 bg-white px-3 py-2 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
          />
        )}
      </Field>
      <button
        type="button"
        onClick={() => setPresses((n) => n + 1)}
        className="rounded-md border border-zinc-900 bg-zinc-900 px-4 py-2 text-base font-semibold text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Show an example status update
      </button>
      <StatusRegion
        message={
          presses === 0
            ? ""
            : `Example status update, press ${presses}: this change was announced to assistive technology.`
        }
        className="min-h-6 rounded-md border border-dashed border-zinc-400 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
      />
    </div>
  );
}
