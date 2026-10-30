import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../honesty";
import {
  PURGE_SCREEN_LINES,
  executePurge,
  planPurge,
  type PurgeEffects,
} from "./purge";

// Shown-purge invariants (HACK-80). The properties that matter are the
// ones a bug could silently break: wiping answers without a confirmed
// fax, claiming a removal that did not verify, keeping anything beyond
// the fax confirmation, or copy that promises an outcome.

function effectsWith(answers: boolean, receipt: boolean): PurgeEffects {
  return {
    removeAnswers: async () => answers,
    removeConsentReceipt: async () => receipt,
  };
}

describe("purge gating", () => {
  it("a fax purge without a real confirmation id is refused — nothing to run", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 12 }).filter((value) => value.trim() === ""),
        async (blank) => {
          const planned = planPurge({
            kind: "fax_confirmed",
            confirmationId: blank,
          });
          expect(planned.ok).toBe(false);
          if (!planned.ok) {
            expect(planned.reason).toBe("missing_confirmation");
          }
        },
      ),
    );
    expect(
      planPurge({ kind: "fax_confirmed", confirmationId: "conf-9" }).ok,
    ).toBe(true);
    expect(planPurge({ kind: "manual" }).ok).toBe(true);
  });

  it("runs every step in order and reports each verification honestly", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (answers, receipt) => {
        const order: string[] = [];
        const effects: PurgeEffects = {
          removeAnswers: async () => {
            order.push("answers");
            return answers;
          },
          removeConsentReceipt: async () => {
            order.push("consent_receipt");
            return receipt;
          },
        };
        const planned = planPurge({ kind: "manual" });
        if (!planned.ok) {
          throw new Error("manual purge must plan");
        }
        const outcome = await executePurge(planned.plan, effects);
        expect(order).toEqual(["answers", "consent_receipt"]);
        expect(outcome.fullyRemoved).toBe(answers && receipt);
        expect(outcome.results).toEqual([
          { step: "answers", removed: answers },
          { step: "consent_receipt", removed: receipt },
        ]);
        // Copy follows the verified facts, never the hoped-for ones.
        expect(outcome.removedLines).toHaveLength(
          Number(answers) + Number(receipt),
        );
        expect(outcome.remainingLines).toHaveLength(
          Number(!answers) + Number(!receipt),
        );
      }),
    );
  });

  it("only the fax confirmation is kept, and only for a confirmed fax", async () => {
    const faxPlan = planPurge({
      kind: "fax_confirmed",
      confirmationId: "conf-9",
    });
    if (!faxPlan.ok) {
      throw new Error("confirmed purge must plan");
    }
    const faxOutcome = await executePurge(faxPlan.plan, effectsWith(true, true));
    expect(faxOutcome.keptLines).toEqual([
      PURGE_SCREEN_LINES.confirmationKept,
    ]);

    const manualPlan = planPurge({ kind: "manual" });
    if (!manualPlan.ok) {
      throw new Error("manual purge must plan");
    }
    const manualOutcome = await executePurge(
      manualPlan.plan,
      effectsWith(true, true),
    );
    expect(manualOutcome.keptLines).toEqual([]);
  });

  it("screen copy is banned-claim-clean and never promises an outcome", () => {
    for (const line of Object.values(PURGE_SCREEN_LINES)) {
      expect(findBannedClaims(line), line).toEqual([]);
    }
  });
});
