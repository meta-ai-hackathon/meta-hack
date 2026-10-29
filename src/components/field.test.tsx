import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";

function renderField(options: { help?: string; error?: string; required?: boolean }) {
  return renderToStaticMarkup(
    <Field
      id="q-income"
      label="What is your monthly income?"
      help={options.help}
      error={options.error}
      required={options.required}
    >
      {(controlProps) => <input type="text" {...controlProps} />}
    </Field>,
  );
}

describe("Field (BN-07)", () => {
  it("associates the label with the control via for/id", () => {
    const html = renderField({});
    expect(html).toContain('<label for="q-income"');
    expect(html).toContain('id="q-income"');
  });

  it("links help text to the control through aria-describedby", () => {
    const html = renderField({ help: "A rough number is fine." });
    expect(html).toContain('id="q-income-help"');
    expect(html).toContain('aria-describedby="q-income-help"');
    expect(html).toContain("A rough number is fine.");
  });

  it("announces an error with role=alert and wires invalid state", () => {
    const html = renderField({
      help: "A rough number is fine.",
      error: "Enter a number greater than zero.",
    });
    expect(html).toContain('id="q-income-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-errormessage="q-income-error"');
    expect(html).toMatch(/aria-describedby="q-income-help q-income-error"/);
  });

  it("omits describedby wiring when there is no help or error", () => {
    const html = renderField({});
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("aria-invalid");
  });

  it("marks required fields for screen readers, not only by glyph", () => {
    const html = renderField({ required: true });
    expect(html).toContain("(required)");
  });
});
