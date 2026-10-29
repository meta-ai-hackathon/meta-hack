import type { Metadata } from "next";
import { IntakeWizard } from "./intake-wizard";

export const metadata: Metadata = {
  title: "Your application — Benefits Navigator",
  description:
    "Answer a few plain-language questions. Your answers save as you go.",
};

// The intake flow's page shell (BN-09). One h1; the wizard below renders
// exactly one question per screen, driven by the question spec.
export default function IntakePage() {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Your benefits application
        </h1>
        <p className="max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
          A few plain-language questions, one at a time. Your answers save as
          you go, and you can stop at any point.
        </p>
      </div>
      <IntakeWizard />
    </div>
  );
}
