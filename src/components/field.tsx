import type { ReactNode } from "react";

/** Props the control must spread to get the label, help, and error wiring. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-errormessage"?: string;
}

interface FieldProps {
  /** DOM id of the control; the label association is built from it. */
  id: string;
  label: string;
  help?: string;
  error?: string;
  required?: boolean;
  /** Render the control; spread the provided props onto it to inherit the wiring. */
  children: (controlProps: FieldControlProps) => ReactNode;
}

/**
 * Labeled field wrapper (BN-07): associates the label with its control via
 * for/id, connects help text through aria-describedby, and announces errors
 * with role=alert plus aria-invalid/aria-errormessage on the control.
 * Plain-language prompts and help from the question spec become accessible
 * semantics here, so intake questions get correct semantics for free.
 */
export function Field({
  id,
  label,
  help,
  error,
  required = false,
  children,
}: FieldProps) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5 text-left">
      <label htmlFor={id} className="text-base font-medium">
        {label}
        {required ? (
          <span className="ml-1">
            <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </span>
        ) : null}
      </label>
      {help ? (
        <p
          id={helpId}
          className="text-sm text-zinc-600 dark:text-zinc-400"
        >
          {help}
        </p>
      ) : null}
      {children({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
        "aria-errormessage": errorId,
      })}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-sm font-medium text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
