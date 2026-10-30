import type { Metadata } from "next";
import { DEVICE_INTAKE_COPY } from "../../lib/intake/device-intake";
import { IntakeWizard } from "./intake-wizard";

export const metadata: Metadata = {
  title: "Your application — Benefits Navigator",
  description:
    "Answer a few plain-language questions. Nothing you enter on this page is sent to us.",
};

// The intake flow's page shell (BN-09). One h1; the wizard below renders
// exactly one question per screen, driven by the question spec. Answers on
// this page live only on the person's device (HACK-99).
export default function IntakePage() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-bold tracking-tight">
          Your benefits application
        </h1>
        <p className="max-w-xl text-lg text-muted">
          {DEVICE_INTAKE_COPY.pageIntro}
        </p>
      </div>
      <IntakeWizard persistence="device" />
    </div>
  );
}
