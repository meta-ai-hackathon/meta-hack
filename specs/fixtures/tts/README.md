# TTS evidence samples

Synthesized spoken-reply evidence for the natural-conversation milestone
(HACK-106, VAL-VTTS-001). Content is fully synthetic (no real-person data,
HACK-58).

- `reply-callirrhoe-gemini-3.8-flash-tts.wav` — the SHIPPED voice/model:
  Gemini `gemini-3.8-flash-tts`, prebuilt voice `Callirrhoe` (the committed
  `DEFAULT_TTS_VOICE` in `src/lib/tts.ts`), spoken through the verbatim
  reply frame the app sends. Text: "Got it, thanks for sharing that. Next,
  lets talk about your household. About how many people live with you right
  now?" — a representative grounded next-question reply. 24 kHz mono
  16-bit PCM WAV as returned by the model (unary WAV output).
