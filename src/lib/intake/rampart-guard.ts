// HACK-107: browser-side PII tokenization with the maintained Rampart fork.
//
// One createGuard() per conversation (page lifetime + restored session);
// protect() on typed user text before it is sent to any cloud API; reveal()
// on replies before they are displayed. Rampart is used as-is — no custom
// token format, no second redactor, and keepLabels stays at Rampart's
// default {CITY, STATE, ZIP_CODE}, which already keeps benefits vocabulary
// and place names intact (regression tests live in the fork).
//
// Persistence: the session table (token -> raw PII) is the one raw-PII
// artifact. It is sealed with the device answer store's AES-256-GCM key via
// rampart-session-store and never leaves the device. When the store is not
// available the guard simply keeps the in-memory page-lifetime behavior
// (tokens stable within the lifetime only) — nothing raw is written.
//
// Failure policy (fail closed): until background detection is loaded, or if
// it fails, a typed send is blocked and the UI says so honestly. Raw typed
// text is never sent untokenized. Voice turns are separately consent-gated
// and inherently identifying (recorded audio), so they do not go through
// this layer.

import type { ChatGuard, GuardOptions } from "@nationaldesignstudio/rampart";

import {
  loadRampartSession,
  saveRampartSession,
} from "./rampart-session-store";
import type { DeviceAnswerStoreDeps } from "./device-answer-store";

export type RampartShieldStatus = "loading" | "ready" | "failed";

export type RampartProtectOutcome =
  | { kind: "tokenized"; text: string }
  | { kind: "blocked" };

type GuardFactory = (options?: GuardOptions) => Promise<ChatGuard>;
type StoreOpener = () => Promise<DeviceAnswerStoreDeps | null>;

export interface RampartShieldDeps {
  /** Guard factory; defaults to Rampart's real createGuard. */
  createGuard: GuardFactory;
  /** Store opener; null deps means "no sealed session this session". */
  openStore: StoreOpener;
}

const defaultFactory: GuardFactory = async (options) => {
  // The heavyweight runtime is loaded only in the browser when the shield
  // actually starts, keeping the module importable during SSR and tests.
  const { createGuard } = await import("@nationaldesignstudio/rampart");
  return createGuard(options);
};

const defaultOpener: StoreOpener = async () =>
  (await import("./device-answer-store")).openDeviceAnswerStore().then(
    (opened) => (opened.status === "ok" ? opened.store : null),
  );

export class RampartShield {
  private readonly deps: RampartShieldDeps;
  private guard: ChatGuard | null = null;
  private store: DeviceAnswerStoreDeps | null = null;
  private _status: RampartShieldStatus = "loading";
  private startPromise: Promise<void> | null = null;
  private persisted = false;

  constructor(deps: Partial<RampartShieldDeps> = {}) {
    this.deps = {
      createGuard: deps.createGuard ?? defaultFactory,
      openStore: deps.openStore ?? defaultOpener,
    };
  }

  get status(): RampartShieldStatus {
    return this._status;
  }

  /** Start once; later calls await the same startup. Never rejects. */
  start(): Promise<void> {
    if (this.startPromise === null) {
      this.startPromise = this.startOnce().catch(() => {
        // Fail closed: typed sends stay blocked, the UI says how to proceed.
        this.guard = null;
        this._status = "failed";
      });
    }
    return this.startPromise;
  }

  private async startOnce(): Promise<void> {
    try {
      this.store = await this.deps.openStore();
    } catch {
      this.store = null;
    }
    // A missing or unreadable sealed session restores nothing — tokens
    // recover their values only within one guard lifetime. The UI copy
    // must not claim cross-restart restoration in that case.
    const load = this.store === null ? null : await loadRampartSession(this.store);
    const options: GuardOptions =
      load !== null && load.status === "ok" ? { session: load.serialized } : {};
    // Whether a persisted copy existed as we opened (a restored envelope,
    // or an unreadable one we may re-seal). From now on a confirmed purge
    // wins over this shield's later saves, mirroring recordDeviceAnswer.
    this.persisted = load !== null && load.status !== "none";
    this.guard = await this.deps.createGuard(options);
    this._status = "ready";
  }

  /**
   * Replace PII with Rampart placeholders before anything leaves the device.
   * Blocked (never the raw text) whenever the guard is not ready or a
   * single protect() pass throws.
   */
  async protectTyped(text: string): Promise<RampartProtectOutcome> {
    if (this._status !== "ready" || this.guard === null) {
      return { kind: "blocked" };
    }
    try {
      const scrubbed = await this.guard.protect(text);
      await this.persistSession();
      return { kind: "tokenized", text: scrubbed.text };
    } catch {
      return { kind: "blocked" };
    }
  }

  /**
   * Restore real values for local display. Unknown tokens are left intact
   * and an unavailable guard returns the input unchanged — a coherence
   * degradation, never a PII leak (values live only on this device).
   */
  reveal(text: string): string {
    if (this._status !== "ready" || this.guard === null) {
      return text;
    }
    try {
      return this.guard.reveal(text);
    } catch {
      return text;
    }
  }

  /**
   * Seal the serialized session map under the device key after each new
   * mapping is introduced. Best-effort: a storage failure only shortens the
   * map's lifetime to this page; it never sends or logs the raw map.
   */
  private async persistSession(): Promise<void> {
    if (this.store === null || this.guard === null) return;
    try {
      // Once a persistence was seen (restored or saved here), a save after
      // a user-confirmed purge must not recreate the sealed session — the
      // store returns "purged" and this shield stops writing.
      const saved = await saveRampartSession(this.store, this.guard.serialize(), {
        expectStored: this.persisted,
      });
      if (saved === "saved") {
        this.persisted = true;
      } else if (saved === "purged") {
        this.store = null;
      }
    } catch {
      // The map stays in memory only; sends keep working.
    }
  }
}
