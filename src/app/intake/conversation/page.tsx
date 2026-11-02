import type { Metadata } from "next";
import { ConversationChat } from "./conversation-chat";

export const metadata: Metadata = {
  title: "Chat — Benefits Navigator",
  description:
    "Answer a few plain-language questions in a conversation. Your answers save as you go, and private details stay private.",
};

// The conversational intake page (Mission v2 M1) — the primary path through
// the intake. The step-by-step wizard (/intake) stays reachable as the
// fallback from here, in the header and on any error.
//
// The page IS the product frame (VAL-FIX-006, the literal Lovable
// prototype geometry): it spans edge-to-edge — no centered max-width,
// no dead gutters (the VAL-FIX-005 85rem cap is superseded). The
// intentional paddings live on the frame's own regions: the talk-stage
// grid carries the prototype's 35px 32px 20px, the bottom session deck
// 15px 32px 0, and the intro block here aligns to the same 32px frame
// inset (the prototype header's own 36px and the stage's 32px differ in
// the prototype too).
export default function ConversationPage() {
  return (
    <div className="flex w-full flex-1 flex-col">
      <div className="flex flex-col gap-2 px-5 pt-7 min-[761px]:px-8 min-[761px]:pt-[35px]">
        <h1 className="font-display text-4xl font-bold tracking-tight">
          Chat through your application
        </h1>
        <p className="max-w-xl text-lg text-muted">
          Tell us about your situation in your own words. The assistant asks
          one question at a time, your answers save as you go, and private
          details never show up on this screen — they are marked as
          &ldquo;you told us&rdquo; instead.
        </p>
      </div>
      <ConversationChat />
    </div>
  );
}
