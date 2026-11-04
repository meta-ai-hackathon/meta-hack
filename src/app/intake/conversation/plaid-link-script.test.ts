// @vitest-environment jsdom
// Retrying after a failed Link script load must not hang (review P3 on PR
// #172): the failed element is removed and reset, so the next attempt can
// append a fresh script and settle.
import { afterEach, describe, expect, it } from "vitest";
import { loadPlaidLinkScript } from "./income-stage";

describe("loadPlaidLinkScript", () => {
  afterEach(() => {
    document
      .querySelectorAll("script[data-plaid-link]")
      .forEach((script) => script.remove());
    delete (window as { Plaid?: unknown }).Plaid;
  });

  it("removes a failed script and lets a retry load a fresh one", async () => {
    const first = loadPlaidLinkScript();
    const failedScript = document.querySelector<HTMLScriptElement>(
      "script[data-plaid-link]",
    );
    expect(failedScript).not.toBeNull();
    failedScript?.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow("plaid");
    expect(document.querySelector("script[data-plaid-link]")).toBeNull();

    const second = loadPlaidLinkScript();
    const retryScript = document.querySelector<HTMLScriptElement>(
      "script[data-plaid-link]",
    );
    expect(retryScript).not.toBeNull();
    expect(retryScript).not.toBe(failedScript);
    retryScript?.dispatchEvent(new Event("load"));
    await expect(second).resolves.toBeUndefined();
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const first = loadPlaidLinkScript();
    const second = loadPlaidLinkScript();
    expect(document.querySelectorAll("script[data-plaid-link]")).toHaveLength(1);
    document
      .querySelector("script[data-plaid-link]")
      ?.dispatchEvent(new Event("load"));
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
