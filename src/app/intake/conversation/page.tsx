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
export default function ConversationPage() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      <div className="flex flex-col gap-2">
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
