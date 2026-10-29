import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusRegion } from "./status-region";

describe("StatusRegion (BN-07)", () => {
  it("renders a polite, atomic live region with the current message", () => {
    const html = renderToStaticMarkup(
      <StatusRegion id="save-status" message="Progress saved." />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('id="save-status"');
    expect(html).toContain("Progress saved.");
  });

  it("stays mounted with an empty region when there is no message", () => {
    const html = renderToStaticMarkup(<StatusRegion message="" />);
    // The region must exist in the DOM before the first update so screen
    // readers pick up the change when a message arrives.
    expect(html).toContain('role="status"');
  });
});
