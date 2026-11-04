// Multi-language intake copy (HACK-131, GetCalFresh language-access
// practice, extended from the Spanish-only first cut). The English question
// spec stays the single source of truth for structure; each locale ships a
// catalog of translated prompts, help, option labels, and intake chrome.
// Translated copy preserves the honest wording: no eligibility or outcome
// claims in any language. The language choice is stored on the device only.
//
// The catalogs under ./locales are generated offline by NLLB-200 3.3B
// (CTranslate2, CPU) from the English spec and chrome in this module, then
// corrected where short-string output was ambiguous or unidiomatic; ids,
// option values, PII flags, and question structure never change.

import type { Question } from "./spec";
import { DEVICE_INTAKE_COPY } from "./device-intake";
import type { DeviceIntake } from "./device-intake";
import type { ClientQuestion } from "./serialize";
import type { AnswerStatus } from "../honesty";
import { ANSWER_STATUS_LABELS } from "../honesty";
import { AGE_BAND_LABELS, RELATIONSHIP_LABELS } from "./roster";
import { NO_PROOF_NEEDED_NOTE_SINGLE } from "./work-requirements";
import { MONTH_LABELS } from "./attribution";

import es from "./locales/es.json";
import zh from "./locales/zh.json";
import vi from "./locales/vi.json";
import tl from "./locales/tl.json";
import ar from "./locales/ar.json";
import fr from "./locales/fr.json";
import ko from "./locales/ko.json";
import ht from "./locales/ht.json";
import pt from "./locales/pt.json";
import hi from "./locales/hi.json";
import ru from "./locales/ru.json";

/** Locales offered by the intake, most-spoken in the U.S. first. */
export const LANGUAGE_CODES = [
  "en",
  "es",
  "zh",
  "vi",
  "tl",
  "ar",
  "fr",
  "ko",
  "ht",
  "pt",
  "hi",
  "ru",
] as const;
export type Language = (typeof LANGUAGE_CODES)[number];

export interface LanguageInfo {
  readonly code: Language;
  /** Endonym shown on the language picker. */
  readonly label: string;
  /** English name for tests, docs, and logs. */
  readonly english: string;
  readonly dir: "ltr" | "rtl";
  /** NLLB-200 language token the offline generator used. */
  readonly nllb: string;
}

export const LANGUAGES = [
  { code: "en", label: "English", english: "English", dir: "ltr", nllb: "eng_Latn" },
  { code: "es", label: "Español", english: "Spanish", dir: "ltr", nllb: "spa_Latn" },
  { code: "zh", label: "简体中文", english: "Chinese (Simplified)", dir: "ltr", nllb: "zho_Hans" },
  { code: "vi", label: "Tiếng Việt", english: "Vietnamese", dir: "ltr", nllb: "vie_Latn" },
  { code: "tl", label: "Tagalog", english: "Tagalog", dir: "ltr", nllb: "tgl_Latn" },
  { code: "ar", label: "العربية", english: "Arabic", dir: "rtl", nllb: "arb_Arab" },
  { code: "fr", label: "Français", english: "French", dir: "ltr", nllb: "fra_Latn" },
  { code: "ko", label: "한국어", english: "Korean", dir: "ltr", nllb: "kor_Hang" },
  { code: "ht", label: "Kreyòl Ayisyen", english: "Haitian Creole", dir: "ltr", nllb: "hat_Latn" },
  { code: "pt", label: "Português", english: "Portuguese", dir: "ltr", nllb: "por_Latn" },
  { code: "hi", label: "हिन्दी", english: "Hindi", dir: "ltr", nllb: "hin_Deva" },
  { code: "ru", label: "Русский", english: "Russian", dir: "ltr", nllb: "rus_Cyrl" },
] as const satisfies readonly LanguageInfo[];

export const LANGUAGE_VALUES = LANGUAGE_CODES;

export const LANGUAGE_STORAGE_KEY = "bn_language_v1";

const languageListeners = new Set<() => void>();

// The choice made during this visit, for when storage is blocked or rejects the
// write: the picker still has to switch the page even though the choice cannot
// outlive the visit. When the write lands, storage is the source of truth again
// (so another tab's change can reach an open wizard).
let chosenLanguage: Language | null = null;
let chosenLanguageStored = false;
// What storage held when the in-memory choice was pinned. The pin wins only
// while storage still holds that same value, so a later write from another tab
// (or a fresh pick) takes over instead of being ignored forever.
let pinnedStorageValue: Language | null = null;

export function languageInfo(language: Language): LanguageInfo {
  return LANGUAGES.find((info) => info.code === language) ?? LANGUAGES[0];
}

export function languageDirection(language: Language): "ltr" | "rtl" {
  return languageInfo(language).dir;
}

export function readStoredLanguage(storage?: Storage): Language {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    const stored = s?.getItem(LANGUAGE_STORAGE_KEY) ?? "";
    return (LANGUAGE_CODES as readonly string[]).includes(stored) ? (stored as Language) : "en";
  } catch {
    return "en";
  }
}

export function storeLanguage(language: Language, storage?: Storage): void {
  chosenLanguage = language;
  chosenLanguageStored = false;
  pinnedStorageValue = readStoredLanguage(storage);
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    if (s) {
      s.setItem(LANGUAGE_STORAGE_KEY, language);
      chosenLanguageStored = true;
    }
  } catch {
    // Storage unavailable: the choice lasts for this visit only.
  }
  for (const listener of languageListeners) listener();
}

/**
 * Subscribes to the stored language for useSyncExternalStore, so the wizard
 * follows a language picked anywhere in the page. The server snapshot is
 * English: storage is not readable while rendering on the server, and a
 * client whose stored choice differs re-renders once after hydration.
 */
/**
 * Forget the stored choice after "delete my answers from this device". The
 * language a person picked can hint at where they come from, so a shared
 * computer should not keep it once its answers are gone. This visit keeps the
 * language it is already showing; nothing is persisted for the next visitor.
 */
export function clearStoredLanguage(storage?: Storage): void {
  // Pin whatever this visit is showing before the stored value goes, so a
  // language that came from an earlier visit does not flip to English when the
  // key disappears. The pin is visit-only: a later pick or another tab's write
  // replaces it (see `storeLanguage` and the storage listener below).
  chosenLanguage = storedLanguageSnapshot(storage);
  chosenLanguageStored = false;
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    s?.removeItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Storage unavailable: there is nothing stored to clear.
  }
  // What storage now holds (English, since the key is gone) is the baseline the
  // visit's language is pinned against.
  pinnedStorageValue = readStoredLanguage(storage);
}

export function subscribeLanguage(listener: () => void): () => void {
  languageListeners.add(listener);
  // Another tab changing the choice reaches an open wizard through the
  // browser's storage event, not through this page's listeners.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== LANGUAGE_STORAGE_KEY) return;
    // Another tab's write is authoritative again, even for a visit that pinned
    // its language after deleting the answers.
    chosenLanguage = null;
    chosenLanguageStored = true;
    listener();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    languageListeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function storedLanguageSnapshot(storage?: Storage): Language {
  const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  // A choice the browser refused to store wins over what storage still holds:
  // if the write was rejected (a quota error, a locked-down browser), the picker
  // has to switch anyway instead of springing back to the older stored value.
  // The pin only applies while storage holds what it held when the choice was
  // made, so a later write from another tab takes over.
  if (chosenLanguage && !chosenLanguageStored) {
    const stored = readStoredLanguage(s);
    return stored === pinnedStorageValue ? chosenLanguage : stored;
  }
  return readStoredLanguage(s);
}

export function storedLanguageServerSnapshot(): Language {
  return "en";
}

export interface QuestionTranslation {
  readonly prompt: string;
  readonly help: string;
  readonly options?: Readonly<Record<string, string>>;
}

export const CHROME_KEYS = [
  "continue",
  "notSure",
  "skipForNow",
  "bestGuess",
  "languageLabel",
  "addPerson",
  "back",
  "addRow",
  "personName",
  "relationship",
  "ageRange",
  "householdMember",
  "activityType",
  "hoursLastMonth",
  "notSureHours",
  "fromIncome",
  "removePerson",
  "person",
  "rowWord",
  "notPicked",
  "duplicateRow",
  "rosterFull",
  "nameHint",
  "enterHours",
  "negHours",
  "tooManyHours",
  "removeRow",
  "yes",
  "no",
  "required",
  "privateAnswer",
  "deviceOnly",
  "noHouseholdList",
  "rosterFirst",
  "addRowFor",
  "thisPerson",
  "loading",
  "allAnswered",
  "nothingSubmitted",
  "stillOpen",
  "answer",
  "reviewAnswer",
  "noAnswerRecorded",
  "savedPrivately",
  "saveAndFinishLater",
  "saving",
  "deleting",
  "deleteButton",
  "deleteConfirm",
  "deleteYes",
  "deleteNo",
  "keepPrompt",
  "genericError",
  "requiredError",
  "serverSaveBlurb",
  "savedComeBack",
  "savedProgress",
  "markedNotSure",
  "progress",
  "remaining",
  "noProofNeeded",
  "deviceKeptBlurb",
  "deviceUnsupportedBlurb",
  "deviceUnavailableBlurb",
  "deviceStoppedBlurb",
  "deviceStoppedNothingStoredBlurb",
  "deviceVisibilityNote",
  "savedPrivatelyThisVisit",
] as const;
export type ChromeKey = (typeof CHROME_KEYS)[number];

/** English chrome is the source of truth the offline generator translates. */
export const CHROME_EN: Readonly<Record<ChromeKey, string>> = {
  continue: "Continue",
  notSure: "I'm not sure",
  skipForNow: "Skip for now",
  bestGuess: "This is my best guess \u2014 I have not verified it",
  languageLabel: "Language",
  addPerson: "Add another person",
  back: "Back",
  addRow: "Add a row",
  personName: "first name or nickname",
  relationship: "Relationship",
  ageRange: "Age range",
  householdMember: "Household member",
  activityType: "Type of activity",
  hoursLastMonth: "Hours last month",
  notSureHours: "Not sure about the hours",
  fromIncome: "From your income answers, you could add:",
  removePerson: "Remove this person",
  person: "Person",
  rowWord: "row",
  notPicked: "Does not apply / not picked yet",
  duplicateRow:
    "This person already has a row for this activity. Change one of them or remove this row.",
  rosterFull:
    "That is everyone we can list here. You can change or remove a person above.",
  nameHint: "Enter a first name or nickname for this person.",
  enterHours: "Enter the hours, or tick Not sure about the hours.",
  negHours: "Hours cannot be less than zero.",
  tooManyHours: "That is more hours than a month has. Please check the number.",
  removeRow: "Remove this row",
  yes: "Yes",
  no: "No",
  required: "required",
  privateAnswer:
    "For your privacy, we don't show your saved answer here. To change it, enter a new one.",
  deviceOnly:
    "This question can only be answered when your answers are saved on this device. You can skip it here - it never blocks your application.",
  noHouseholdList:
    "There is no household list or situation to attach yet. You can skip this question - it never blocks your application.",
  rosterFirst:
    "Add your household list first, then add a row for each person. You can skip this question - it never blocks your application.",
  addRowFor: "Add a row for {name}: {activity}",
  thisPerson: "this person",
  loading: "Loading your questions\u2026",
  allAnswered: "All questions answered for now",
  nothingSubmitted: "Nothing is submitted \u2014 you decide what happens next.",
  stillOpen: "Still open",
  answer: "Answer",
  reviewAnswer: "Review this answer",
  noAnswerRecorded: "No answer recorded.",
  savedPrivately: "Saved privately \u2014 not shown again.",
  saveAndFinishLater: "Save and finish later",
  saving: "Saving\u2026",
  deleting: "Deleting\u2026",
  deleteButton: DEVICE_INTAKE_COPY.deleteButton,
  deleteConfirm: DEVICE_INTAKE_COPY.deleteConfirm,
  deleteYes: DEVICE_INTAKE_COPY.deleteYes,
  deleteNo: DEVICE_INTAKE_COPY.deleteNo,
  // Adopted from the device-intake copy so the English chrome tracks the
  // copy's own source of truth when that module's wording is updated (it
  // moved here from HACK-131's frozen snapshot at the HACK-131 rebase).
  keepPrompt: DEVICE_INTAKE_COPY.keepPrompt,
  genericError: "Something went wrong on our side. Please try again.",
  requiredError:
    "This one is needed to continue. Pick an option or choose I'm not sure.",
  serverSaveBlurb:
    "Your answers save as you go on the app's server. Stop any time and pick up later in this browser \u2014 nothing is submitted until you decide.",
  savedComeBack:
    "Saved. Come back in this browser any time \u2014 nothing is submitted until you decide.",
  savedProgress: "Saved. {answered} of {total} answered.",
  markedNotSure: "Marked as not sure. You can come back to it.",
  progress: "Answered {answered} of {total} questions",
  remaining: "{remaining} to go",
  noProofNeeded: NO_PROOF_NEEDED_NOTE_SINGLE,
  // The device-mode notices are the ones a shared-computer reader most needs to
  // understand, so each has a chrome key alongside the English source they
  // mirror in `DEVICE_INTAKE_COPY`.
  deviceKeptBlurb: DEVICE_INTAKE_COPY.keptBlurb,
  deviceUnsupportedBlurb: DEVICE_INTAKE_COPY.unsupportedBlurb,
  deviceUnavailableBlurb: DEVICE_INTAKE_COPY.unavailableBlurb,
  deviceStoppedBlurb: DEVICE_INTAKE_COPY.stoppedBlurb,
  deviceStoppedNothingStoredBlurb: DEVICE_INTAKE_COPY.stoppedBlurbNothingStored,
  deviceVisibilityNote: DEVICE_INTAKE_COPY.visibilityNote,
  savedPrivatelyThisVisit: DEVICE_INTAKE_COPY.privateNotKept,
};

/**
 * Where the answers given now end up, as the chrome key that says so. Mirrors
 * `keepingBlurb` in `device-intake.ts` so the wizard can render the sentence in
 * the chosen language instead of only in English.
 */
export function deviceBlurbKey(intake: DeviceIntake): ChromeKey {
  switch (intake.keeping) {
    case "kept":
      return intake.store === null ? "deviceUnavailableBlurb" : "deviceKeptBlurb";
    case "unsupported":
      return "deviceUnsupportedBlurb";
    case "unavailable":
      return "deviceUnavailableBlurb";
    case "stopped":
      return intake.stored ? "deviceStoppedBlurb" : "deviceStoppedNothingStoredBlurb";
  }
}

export interface LocaleCatalog {
  readonly questions: Readonly<Record<string, QuestionTranslation>>;
  readonly chrome: Readonly<Record<ChromeKey, string>>;
  readonly commonOptions: Readonly<Record<string, string>>;
  readonly relationships: Readonly<Record<string, string>>;
  readonly ageBands: Readonly<Record<string, string>>;
  readonly months: Readonly<Record<string, string>>;
  readonly answerStatus: Readonly<Record<AnswerStatus, string>>;
}

const CATALOGS: Readonly<Record<Exclude<Language, "en">, LocaleCatalog>> = {
  es: es as unknown as LocaleCatalog,
  zh: zh as unknown as LocaleCatalog,
  vi: vi as unknown as LocaleCatalog,
  tl: tl as unknown as LocaleCatalog,
  ar: ar as unknown as LocaleCatalog,
  fr: fr as unknown as LocaleCatalog,
  ko: ko as unknown as LocaleCatalog,
  ht: ht as unknown as LocaleCatalog,
  pt: pt as unknown as LocaleCatalog,
  hi: hi as unknown as LocaleCatalog,
  ru: ru as unknown as LocaleCatalog,
};

/** Exposed for coverage/honesty tests; runtime code should use the helpers. */
export const LOCALE_CATALOGS = CATALOGS;

function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/**
 * The client question in the chosen language. English returns the spec
 * question unchanged; every other locale returns a translated copy with
 * identical structure, ids, option values, and PII flags.
 */
export function translateQuestion(
  question: Question | ClientQuestion,
  language: Language,
): ClientQuestion {
  const base: ClientQuestion = { ...question };
  if (language === "en") return base;
  const catalog = CATALOGS[language];
  const tr = catalog.questions[question.id];
  if (!tr) return base;
  return {
    ...base,
    prompt: tr.prompt,
    help: tr.help,
    ...(base.options
      ? {
          options: base.options.map((option) => ({
            value: option.value,
            label:
              tr.options?.[option.value] ??
              catalog.commonOptions[option.value] ??
              option.label,
          })),
        }
      : {}),
  };
}

export function translateQuestions<T extends Question | ClientQuestion>(
  questions: readonly T[],
  language: Language,
): ClientQuestion[] {
  return questions.map((question) => translateQuestion(question, language));
}

export function uiText(key: ChromeKey, language: Language): string {
  if (language === "en") return CHROME_EN[key];
  return CATALOGS[language].chrome[key] ?? CHROME_EN[key];
}

export function relationshipLabel(value: string, language: Language): string {
  const english = (RELATIONSHIP_LABELS as Readonly<Record<string, string>>)[value] ?? value;
  if (language === "en") return english;
  return CATALOGS[language].relationships[value] ?? english;
}

export function ageBandLabel(value: string, language: Language): string {
  const english = (AGE_BAND_LABELS as Readonly<Record<string, string>>)[value] ?? value;
  if (language === "en") return english;
  return CATALOGS[language].ageBands[value] ?? english;
}

export function monthLabel(value: string, language: Language): string {
  const english = (MONTH_LABELS as Readonly<Record<string, string>>)[value] ?? value;
  if (language === "en") return english;
  return CATALOGS[language].months[value] ?? english;
}

export function answerStatusLabel(status: AnswerStatus, language: Language = "en"): string {
  if (language === "en") return ANSWER_STATUS_LABELS[status];
  return CATALOGS[language].answerStatus[status] ?? ANSWER_STATUS_LABELS[status];
}

export function progressText(
  progress: { readonly answered: number; readonly total: number; readonly remaining: number },
  language: Language,
): string {
  const base = fill(uiText("progress", language), {
    answered: progress.answered,
    total: progress.total,
  });
  if (progress.remaining <= 0) return base;
  return `${base} \u2014 ${fill(uiText("remaining", language), { remaining: progress.remaining })}`;
}

export function addRowFor(name: string, activity: string, language: Language): string {
  return fill(uiText("addRowFor", language), { name, activity });
}

export function savedProgressText(answered: number, total: number, language: Language): string {
  return fill(uiText("savedProgress", language), { answered, total });
}
