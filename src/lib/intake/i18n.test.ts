import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import CHROME_SOURCE_FINGERPRINTS from "./chrome-source.json";
import {
  CHROME_EN,
  CHROME_KEYS,
  LANGUAGE_CODES,
  LANGUAGE_STORAGE_KEY,
  LANGUAGES,
  LOCALE_CATALOGS,
  addRowFor,
  ageBandLabel,
  answerStatusLabel,
  deviceBlurbKey,
  languageDirection,
  monthLabel,
  progressText,
  readStoredLanguage,
  relationshipLabel,
  savedProgressText,
  storeLanguage,
  storedLanguageServerSnapshot,
  storedLanguageSnapshot,
  subscribeLanguage,
  translateQuestion,
  translateQuestions,
  uiText,
  type Language,
  type LocaleCatalog,
} from "./i18n";
import { QUESTIONS } from "./spec";
import {
  keepingBlurb,
  keepsAnswers,
  privateAnswerNote,
  type DeviceIntake,
  type DeviceKeeping,
} from "./device-intake";
import type { DeviceAnswerStoreDeps } from "./device-answer-store";
import { ANSWER_STATUSES, BANNED_CLAIM_PATTERNS_ES, findBannedClaims } from "../honesty";
import { BANNED_CLAIM_PATTERNS_BY_LOCALE, findLocaleClaims } from "../honesty-locales";
import { AGE_BAND_VALUES, RELATIONSHIP_VALUES } from "./roster";
import { MONTH_VALUES } from "./attribution";

const NON_ENGLISH = LANGUAGE_CODES.filter(
  (code): code is Exclude<Language, "en"> => code !== "en",
);

function stringsIn(catalog: LocaleCatalog): string[] {
  const out: string[] = [];
  for (const translation of Object.values(catalog.questions)) {
    out.push(translation.prompt, translation.help, ...Object.values(translation.options ?? {}));
  }
  out.push(...Object.values(catalog.chrome));
  out.push(...Object.values(catalog.commonOptions));
  out.push(...Object.values(catalog.relationships));
  out.push(...Object.values(catalog.ageBands));
  out.push(...Object.values(catalog.months));
  out.push(...Object.values(catalog.answerStatus));
  return out;
}

// The wizard renders the device blurbs and private-answer note through chrome
// keys so they can be translated; those keys must still say exactly what the
// device-intake copy says, or English device users read different privacy text.
function deviceState(
  store: DeviceAnswerStoreDeps | null,
  keeping: DeviceKeeping,
  stored: boolean,
): DeviceIntake {
  return {
    store,
    keeping,
    stored,
    answers: null as unknown as DeviceIntake["answers"],
    view: null as unknown as DeviceIntake["view"],
  };
}

const DEVICE_STATES: readonly DeviceIntake[] = ([
  "kept",
  "unsupported",
  "unavailable",
  "stopped",
] as const).flatMap((keeping) =>
  [null, {} as DeviceAnswerStoreDeps].flatMap((store) =>
    [false, true].map((stored) => deviceState(store, keeping, stored)),
  ),
);

describe("intake locales (HACK-131 multi-language)", () => {
  it("fails when English chrome changes without the catalogs being re-translated", () => {
    // `chrome-source.json` records a fingerprint of each English chrome string
    // as it stood when the catalogs were generated. Changing the English copy —
    // a privacy fix, a corrected delete notice — has to re-run the translation
    // and refresh this baseline; otherwise every locale keeps the old meaning
    // and CI would still be green.
    const baseline: Readonly<Record<string, string>> = CHROME_SOURCE_FINGERPRINTS;
    const drift: string[] = [];
    for (const [key, value] of Object.entries(CHROME_EN)) {
      const fingerprint = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
      if (baseline[key] !== fingerprint) drift.push(key);
    }
    expect(drift, `re-translate these chrome keys, then refresh chrome-source.json: ${drift.join(", ")}`).toEqual([]);
  });

  it("names the same device copy as the device-intake module, in every state", () => {
    for (const state of DEVICE_STATES) {
      expect(uiText(deviceBlurbKey(state), "en"), `${state.keeping}/${state.stored}`).toBe(
        keepingBlurb(state),
      );
      const noteKey = keepsAnswers(state) ? "savedPrivately" : "savedPrivatelyThisVisit";
      expect(uiText(noteKey, "en"), `${state.keeping}/${state.stored}`).toBe(
        privateAnswerNote(state),
      );
    }
  });

  it("offers every configured locale with an endonym and a direction", () => {
    expect(LANGUAGES.map((info) => info.code)).toEqual([...LANGUAGE_CODES]);
    for (const info of LANGUAGES) {
      expect(info.label.trim(), info.code).not.toBe("");
      expect(info.english.trim(), info.code).not.toBe("");
      expect(info.nllb, info.code).toMatch(/^[a-z]{3}_[A-Z][a-z]{3}$/);
      expect(["ltr", "rtl"]).toContain(info.dir);
    }
    expect(languageDirection("ar")).toBe("rtl");
    expect(languageDirection("es")).toBe("ltr");
  });

  it("covers every spec question, option value, and chrome key in every locale", () => {
    for (const language of NON_ENGLISH) {
      const catalog = LOCALE_CATALOGS[language];
      for (const question of QUESTIONS) {
        const translation = catalog.questions[question.id]!;
        expect(translation, `${language}:${question.id}`).toBeDefined();
        expect(translation.prompt.length, `${language}:${question.id}`).toBeGreaterThan(0);
        expect(translation.help.length, `${language}:${question.id}`).toBeGreaterThan(0);
        for (const option of question.options ?? []) {
          const label =
            translation.options?.[option.value] ?? catalog.commonOptions[option.value];
          expect(label, `${language}:${question.id}:${option.value}`).toBeTruthy();
        }
      }
      for (const key of CHROME_KEYS) {
        expect(uiText(key, language).trim(), `${language}:${key}`).not.toBe("");
      }
    }
  });

  it("keeps ids, types, option values, and pii flags identical in every locale", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...QUESTIONS),
        fc.constantFrom(...NON_ENGLISH),
        (question, language) => {
          const translated = translateQuestion(question, language);
          expect(translated.id).toBe(question.id);
          expect(translated.type).toBe(question.type);
          expect(translated.pii).toBe(question.pii);
          expect((translated.options ?? []).map((option) => option.value)).toEqual(
            (question.options ?? []).map((option) => option.value),
          );
          expect(translateQuestion(question, "en").prompt).toBe(question.prompt);
        },
      ),
    );
    for (const language of NON_ENGLISH) {
      expect(translateQuestions(QUESTIONS, language)).toHaveLength(QUESTIONS.length);
    }
  });

  it("translates every relationship, age band, month, and answer status", () => {
    for (const language of NON_ENGLISH) {
      for (const value of RELATIONSHIP_VALUES) {
        expect(relationshipLabel(value, language).trim(), `${language}:${value}`).not.toBe("");
      }
      for (const value of AGE_BAND_VALUES) {
        expect(ageBandLabel(value, language).trim(), `${language}:${value}`).not.toBe("");
      }
      for (const value of MONTH_VALUES) {
        expect(monthLabel(value, language).trim(), `${language}:${value}`).not.toBe("");
      }
      for (const status of ANSWER_STATUSES) {
        expect(answerStatusLabel(status, language).trim(), `${language}:${status}`).not.toBe("");
      }
    }
  });

  it("contains no corrupted characters, unknown tokens, or source-language leaks", () => {
    for (const language of NON_ENGLISH) {
      for (const text of stringsIn(LOCALE_CATALOGS[language])) {
        expect(text, `${language}:${text}`).not.toContain("\uFFFD");
        expect(text, `${language}:${text}`).not.toContain("<unk>");
        expect(text, `${language}:${text}`).not.toContain("eng_Latn");
      }
    }
  });

  it("preserves templates and fills their placeholders", () => {
    for (const language of NON_ENGLISH) {
      const row = addRowFor("Ana", "Trabajo", language);
      expect(row).toContain("Ana");
      expect(row).toContain("Trabajo");
      expect(row).not.toMatch(/\{\w+\}/);
      const progress = progressText({ answered: 3, total: 8, remaining: 5 }, language);
      expect(progress).toContain("3");
      expect(progress).toContain("8");
      expect(progress).toContain("5");
      expect(progress).not.toMatch(/\{\w+\}/);
      const saved = savedProgressText(4, 9, language);
      expect(saved).toContain("4");
      expect(saved).toContain("9");
      expect(saved).not.toMatch(/\{\w+\}/);
    }
  });

  it("passes the banned-claims gate in every offered locale", () => {
    // Every locale the picker offers is checked: English and Spanish through
    // the shared gate, the other ten through their own (coarser) nets.
    expect(Object.keys(BANNED_CLAIM_PATTERNS_BY_LOCALE).sort()).toEqual([
      "ar",
      "fr",
      "hi",
      "ht",
      "ko",
      "pt",
      "ru",
      "tl",
      "vi",
      "zh",
    ]);
    for (const language of NON_ENGLISH) {
      for (const text of stringsIn(LOCALE_CATALOGS[language])) {
        expect(findLocaleClaims(text, language, findBannedClaims), `${language}: ${text}`).toEqual([]);
      }
    }
    // Non-vacuous: each locale's net bites on its own canonical claims, and
    // lets an honest disclaimer through.
    const claims: Readonly<Record<string, [string, string]>> = {
      zh: ["您符合资格。", "不保证您获得福利。"],
      vi: ["Bạn đủ điều kiện nhận trợ cấp.", "không được bảo đảm"],
      tl: ["Karapat-dapat ka para sa tulong.", "hindi garantisado"],
      ar: ["أنت مؤهل للحصول على المساعدة.", "غير مضمون"],
      fr: ["Vous serez approuvé.", "Votre demande n'est pas garantie."],
      ko: ["귀하는 자격이 있습니다.", "보장되지 않습니다"],
      ht: ["Ou kalifye pou èd sa a.", "pa garanti"],
      pt: ["Você é elegível para ajuda.", "Não é garantido."],
      hi: ["आप सहायता के लिए पात्र हैं।", "कोई गारंटी नहीं है।"],
      ru: ["Вы имеете право на помощь.", "Это не гарантировано."],
    };
    for (const [language, [claim, disclaimer]] of Object.entries(claims)) {
      expect(findLocaleClaims(claim, language, findBannedClaims).length, `${language}: ${claim}`).toBeGreaterThan(0);
      expect(findLocaleClaims(disclaimer, language, findBannedClaims), `${language}: ${disclaimer}`).toEqual([]);
    }
    // The commoner phrasings, each of which a net has to catch too.
    const moreClaims: Readonly<Record<string, string>> = {
      zh: "您有资格获得 SNAP。",
      vi: "Bạn hội đủ điều kiện nhận trợ cấp.",
      ar: "مؤهل للحصول على المساعدة.",
      fr: "Vous avez droit à une aide.",
      pt: "Você tem direito a uma ajuda.",
      hi: "आपको सहायता का अधिकार है।",
      ru: "Вы соответствуете требованиям.",
    };
    for (const [language, claim] of Object.entries(moreClaims)) {
      expect(findLocaleClaims(claim, language, findBannedClaims).length, `${language}: ${claim}`).toBeGreaterThan(0);
    }
    // The benefit-is-on-its-way shape: a promise that money is coming is banned
    // in every locale, since the rules allow only "you may qualify".
    const receivePromises: Readonly<Record<string, string>> = {
      zh: "您将获得 SNAP 福利。",
      vi: "Bạn sẽ nhận được trợ cấp.",
      tl: "Makakatanggap ka ng tulong.",
      ar: "سوف تحصل على المساعدة.",
      fr: "Vous recevrez une aide.",
      ko: "지원금을 받게 됩니다.",
      ht: "W ap resevwa èd.",
      pt: "Você vai receber ajuda.",
      hi: "आपको सहायता मिलेगी।",
      ru: "Вы получите помощь.",
    };
    for (const [language, claim] of Object.entries(receivePromises)) {
      expect(findLocaleClaims(claim, language, findBannedClaims).length, `${language}: ${claim}`).toBeGreaterThan(0);
    }
    // The same sentence hedged is the honest framing and stays allowed.
    const hedgedReceive: Readonly<Record<string, string>> = {
      zh: "您可能会获得帮助。",
      vi: "Bạn có thể nhận được trợ cấp.",
      tl: "Maaaring makakatanggap ka ng tulong.",
      ar: "قد تحصل على المساعدة.",
      fr: "Vous pourriez recevoir une aide.",
      ko: "지원금을 받게 될 수도 있습니다.",
      ht: "Petèt w ap resevwa èd.",
      pt: "Talvez você irá receber ajuda.",
      hi: "शायद आपको सहायता मिलेगी।",
      ru: "Возможно, вы получите помощь.",
    };
    for (const [language, text] of Object.entries(hedgedReceive)) {
      expect(findLocaleClaims(text, language, findBannedClaims), `${language}: ${text}`).toEqual([]);
    }
    // An assertive phrase is not a hedge ("sans doute" means "undoubtedly"), a
    // hedge in an earlier sentence does not cover this one, and a later
    // unhedged claim is not hidden behind an earlier hedged one.
    for (const [language, claim] of [
      ["fr", "Sans doute, vous serez approuvé."],
      ["ht", "Nan ka sa a, ou kalifye."],
      ["fr", "Peut-être pas. Vous serez approuvé."],
      // A negation about something else must not bind the claim: only a
      // negation directly in front of the claimed word counts.
      ["fr", "Ne vous inquiétez pas, vous serez approuvé."],
      ["ht", "Pa enkyete w, ou kalifye."],
      ["fr", "Vous serez approuvé. Vous serez approuvé."],
    ] as const) {
      expect(findLocaleClaims(claim, language, findBannedClaims).length, `${language}: ${claim}`).toBeGreaterThan(0);
    }
    // A hedge in the claim's own clause still lets it pass.
    expect(findLocaleClaims("Peut-être que vous serez approuvé.", "fr", findBannedClaims)).toEqual([]);
    expect(findLocaleClaims("Có thể bạn sẽ được chấp thuận.", "vi", findBannedClaims)).toEqual([]);
    // Hindi's negation is a single letter that also ends ordinary words
    // (लेकिन, "but"), so only a standalone न may negate a claim.
    expect(
      findLocaleClaims("लेकिन आप सहायता के लिए पात्र हैं।", "hi", findBannedClaims).length,
    ).toBeGreaterThan(0);
    // A confident "pode ter certeza" is an assertion, not a hedge.
    expect(
      findLocaleClaims("Você pode ter certeza: você é elegível.", "pt", findBannedClaims).length,
    ).toBeGreaterThan(0);
    // Assertive idioms that contain a modal are still claims.
    expect(
      findLocaleClaims("Pode confiar: você é elegível.", "pt", findBannedClaims).length,
    ).toBeGreaterThan(0);
    expect(
      findLocaleClaims("आप निश्चिंत रह सकते हैं, आप पात्र हैं।", "hi", findBannedClaims).length,
    ).toBeGreaterThan(0);
    // A negative determination is still a determination, not a disclaimer.
    const negated: Readonly<Record<string, string>> = {
      pt: "Você não é elegível.",
      hi: "आप पात्र नहीं हैं।",
      ru: "Вы не имеете права на помощь.",
      fr: "Vous n'êtes pas admissible.",
      zh: "您不符合资格。",
      vi: "Bạn không đủ điều kiện.",
      tl: "Hindi ka kwalipikado.",
      ar: "أنت غير مؤهل.",
      ko: "귀하는 자격이 없습니다.",
      ht: "Ou pa kalifye.",
    };
    for (const [language, text] of Object.entries(negated)) {
      expect(findLocaleClaims(text, language, findBannedClaims).length, text).toBeGreaterThan(0);
    }
    // Arabic hedge particles are whole words only: the same letters sit inside
    // the word for "applicants", so a claim about them must still be caught.
    expect(
      findLocaleClaims("المتقدمين مؤهلون للحصول على المساعدة.", "ar", findBannedClaims).length,
    ).toBeGreaterThan(0);
    expect(findLocaleClaims("قد يكون المتقدمون مؤهلين.", "ar", findBannedClaims)).toEqual([]);
    // An unrelated negation or hedge earlier in the sentence does not launder a
    // claim: a negation binds what it sits next to, not anything later on.
    for (const [language, claim] of [
      ["zh", "不管怎样，您符合资格。"],
      ["fr", "N'importe quand, vous serez approuvé."],
      ["fr", "Pas de souci, vous serez approuvé."],
      ["ht", "Pa gen pwoblèm, ou kalifye."],
    ] as const) {
      expect(findLocaleClaims(claim, language, findBannedClaims).length, `${language}: ${claim}`).toBeGreaterThan(0);
    }
    // The Spanish patterns still bite on the claims they exist to catch.
    expect(BANNED_CLAIM_PATTERNS_ES.some((pattern) => pattern.test("Usted es elegible para Medicaid"))).toBe(true);
    expect(BANNED_CLAIM_PATTERNS_ES.some((pattern) => pattern.test("Será aprobado sin duda"))).toBe(true);
    expect(findBannedClaims("Usted es elegible").length).toBeGreaterThan(0);
    // The determinations Spanish copy could most plausibly slip into, each of
    // which decides an outcome the app must leave to the state.
    for (const claim of [
      "Usted calificará para SNAP.",
      "Usted calificas para ayuda.",
      "Usted calificó para SNAP.",
      "Calificaste para el programa.",
      "Calificaron para beneficios.",
      "Espero que califique para la ayuda.",
      "Está calificado para SNAP.",
      "Usted si califica para beneficios.",
      "Cumple los requisitos del programa.",
      "Tiene derecho a recibir SNAP.",
      "Su solicitud fue aprobada.",
      "Va a recibir beneficios el próximo mes.",
    ]) {
      expect(findBannedClaims(claim).length, claim).toBeGreaterThan(0);
    }
    // Honest hedges and disclaimers must not trip the gate; flagging them would
    // push translators away from the honest wording the gate exists to keep.
    for (const hedged of [
      "No está garantizado que reciba ayuda.",
      "Si califica, la oficina decide.",
      "Si usted califica, le enviaremos una carta.",
      "Usted podría calificar para SNAP.",
      "Puede que califique para la ayuda.",
      "Tal vez califique, pero la oficina decide.",
    ]) {
      expect(findBannedClaims(hedged), hedged).toEqual([]);
    }
  });

  it("persists the chosen locale on the device only", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
    } as unknown as Storage;
    expect(readStoredLanguage(storage)).toBe("en");
    for (const language of LANGUAGE_CODES) {
      storeLanguage(language, storage);
      expect(backing.get(LANGUAGE_STORAGE_KEY)).toBe(language);
      expect(readStoredLanguage(storage)).toBe(language);
    }
    backing.set(LANGUAGE_STORAGE_KEY, "not-a-language");
    expect(readStoredLanguage(storage)).toBe("en");
  });

  it("notifies subscribers of a stored language, and gives the server an English snapshot", () => {
    // The wizard reads the language through useSyncExternalStore, so storing a
    // choice has to reach it, and the server render has to start in English
    // rather than reading storage it cannot see.
    let calls = 0;
    const unsubscribe = subscribeLanguage(() => {
      calls += 1;
    });
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
    } as unknown as Storage;
    storeLanguage("es", storage);
    expect(calls).toBe(1);
    expect(readStoredLanguage(storage)).toBe("es");
    expect(storedLanguageSnapshot(storage)).toBe("es");
    unsubscribe();
    storeLanguage("fr", storage);
    expect(calls).toBe(1);
    expect(storedLanguageServerSnapshot()).toBe("en");
  });

  it("still switches the language when device storage is blocked", () => {
    // Private windows and blocked storage throw on getItem and setItem. The
    // picker has to keep working for this visit, so the choice is remembered
    // in memory even though it cannot be saved.
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    storeLanguage("ar", blocked);
    expect(storedLanguageSnapshot(blocked)).toBe("ar");
    // An older stored value does not win back the page when the new write is
    // rejected: the choice the person just made is the one on screen.
    const older = {
      getItem: (key: string) => (key === LANGUAGE_STORAGE_KEY ? "es" : null),
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    storeLanguage("fr", older);
    expect(storedLanguageSnapshot(older)).toBe("fr");
    // Leave the shared fallback as found for the rest of the file.
    storeLanguage("en", blocked);
  });

  it("falls back to the English source for unknown questions and keys", () => {
    const question = QUESTIONS[0];
    expect(translateQuestion(question, "en").prompt).toBe(question.prompt);
    expect(uiText("continue", "en")).toBe("Continue");
    expect(uiText("continue", "es")).not.toBe("Continue");
    // A question the catalog has no translation for renders the English source
    // rather than a blank or an id.
    const untranslated = { ...question, id: "a_question_no_catalog_has" };
    const es = translateQuestion(untranslated, "es");
    expect(es.prompt).toBe(untranslated.prompt);
    expect(es.help).toBe(untranslated.help);
    expect(es.options?.map((option) => option.label)).toEqual(
      untranslated.options?.map((option) => option.label),
    );
  });
});
