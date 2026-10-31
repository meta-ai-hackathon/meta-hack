"use client";

import { useCallback, type JSX } from "react";
import { useRouter } from "next/navigation";
import { storeEntryMode } from "../lib/entry-mode";
import { ModeChoice, type ConversationEntryMode } from "./intake/conversation/mode-choice";

// The home shell's entry choice (VAL-FIX-003): the approved mode-choice
// card, live on the entry/home surface. "Let's begin" carries the chosen
// mode to the conversation's engine-gated entry stage as a PRESELECTION —
// the session itself still begins only there, from the person's explicit
// "Let's begin", behind the consent gate. Nothing is sent by choosing:
// this picks how the conversation starts, never what may be sent.

export function HomeEntryChoice(): JSX.Element {
  const router = useRouter();
  const onBegin = useCallback((mode: ConversationEntryMode) => {
    storeEntryMode(mode);
    router.push("/intake/conversation");
  }, [router]);
  return <ModeChoice onBegin={onBegin} />;
}
