import type { Metadata } from "next";
import { RenewalPreview } from "./renewal-preview";

export const metadata: Metadata = {
  title: "Renewal preview — Benefits Navigator",
  description:
    "A concept preview of one-click renewals, with made-up details. Nothing on this page is sent or saved.",
  robots: { index: false, follow: false },
};

// The one-click renewal concept preview (HACK-152): a page for the launch
// video, not part of the app's journey and not linked from it. It shows
// made-up details only and sends and saves nothing.
export default function RenewalPreviewPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      <RenewalPreview />
    </div>
  );
}
