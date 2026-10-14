import { BASE_THEME_BY_TYPE } from "../../src/attribute-defaults.js";
import type { FakeGroup, FakeLimeSurvey, FakeQuestion, FakeSurvey } from "./fake-limesurvey.js";

/**
 * Writes a survey straight into the public arrays of the fake, without an import. That is how a survey built in the
 * LimeSurvey admin looks (stored attributes, default values, base theme names, CRLF and entities in the texts), which
 * no spec of this server produces. Rows are written the way LimeSurvey stores them; nothing is validated.
 */

/** Texts per language, for example { de: "Ja", en: "Yes" }. A language that a field leaves out gets no text row. */
export type Texts = Record<string, string>;

export interface SeedAnswer {
  code: string;
  text: Texts;
  assessment_value?: number;
  scale_id?: number;
}

export interface SeedSubquestion {
  code: string;
  text: Texts;
  relevance?: string;
  scale_id?: number;
}

export interface SeedAttribute {
  name: string;
  value: string;
  /** Only for the language dependent attributes; without it the row has an empty language. */
  language?: string;
}

export interface SeedDefault {
  /** Code of the subquestion the default belongs to; without it the default belongs to the question itself. */
  subquestion?: string;
  scale_id?: number;
  specialtype?: string;
  text: Texts;
}

export interface SeedQuestion {
  code: string;
  type: string;
  text: Texts;
  help?: Texts;
  script?: Texts;
  /** question_theme_name; defaults to the base theme of the type, as LimeSurvey stores it. */
  theme?: string;
  /** Y, N or S. */
  mandatory?: string;
  other?: boolean;
  relevance?: string;
  same_default?: boolean;
  answers?: SeedAnswer[];
  subquestions?: SeedSubquestion[];
  attributes?: SeedAttribute[];
  defaults?: SeedDefault[];
}

export interface SeedGroup {
  title: Texts;
  description?: Texts;
  relevance?: string;
  questions: SeedQuestion[];
}

export interface SeedSurvey {
  /** One entry per survey language; the first language is the base language. */
  title: Texts;
  groups: SeedGroup[];
  active?: boolean;
  /** Overrides for the other columns of the surveys table. */
  settings?: Record<string, string>;
}

export interface SeededSurvey {
  sid: number;
  /** Group ids in the order of the seed. */
  gids: number[];
  /** Question id by question code. */
  qids: Record<string, number>;
}

// Far away from the counters of the fake (100001, 2001, 3001, ...), so seeded ids never collide with imported ones.
let nextId = 800001;
const id = (): number => {
  nextId += 1;
  return nextId;
};

export function seedSurvey(fake: FakeLimeSurvey, seed: SeedSurvey): SeededSurvey {
  const languages = Object.keys(seed.title);
  const base = languages[0];
  if (base === undefined) throw new Error("seedSurvey: the title needs at least one language.");
  const sid = id();
  const survey: FakeSurvey = {
    sid,
    active: seed.active === true ? "Y" : "N",
    language: base,
    additional_languages: languages.slice(1).join(" "),
    settings: {
      anonymized: "N",
      format: "G",
      savetimings: "N",
      datestamp: "N",
      ipaddr: "N",
      showprogress: "Y",
      showqnumcode: "X",
      adminemail: "inherit",
      template: "inherit",
      ...seed.settings,
    },
    languagesettings: Object.fromEntries(languages.map((language) => [language, {
      surveyls_survey_id: String(sid),
      surveyls_language: language,
      surveyls_title: seed.title[language] ?? "",
      surveyls_description: "",
      surveyls_welcometext: "",
      surveyls_endtext: "",
    }])),
  };
  fake.surveys.push(survey);

  const gids: number[] = [];
  const qids: Record<string, number> = {};
  seed.groups.forEach((groupSeed, groupIndex) => {
    const gid = id();
    gids.push(gid);
    const group: FakeGroup = {
      gid,
      sid,
      group_order: groupIndex,
      randomization_group: "",
      grelevance: groupSeed.relevance ?? "1",
      l10n: Object.fromEntries(languages.map((language) => [language, {
        group_name: groupSeed.title[language] ?? "",
        description: groupSeed.description?.[language] ?? "",
      }])),
    };
    fake.groups.push(group);

    groupSeed.questions.forEach((questionSeed, questionIndex) => {
      const qid = id();
      qids[questionSeed.code] = qid;
      /** Text rows only for the languages the texts name. */
      const l10n = (texts: Texts, help: Texts = {}, script: Texts = {}): FakeQuestion["l10n"] => Object.fromEntries(
        languages.filter((language) => texts[language] !== undefined).map((language) => [language, {
          id: id(),
          question: texts[language] ?? "",
          help: help[language] ?? "",
          script: script[language] ?? "",
        }]),
      );
      fake.questions.push({
        qid,
        parent_qid: 0,
        sid,
        gid,
        type: questionSeed.type,
        title: questionSeed.code,
        preg: "",
        other: questionSeed.other === true ? "Y" : "N",
        mandatory: questionSeed.mandatory ?? "N",
        encrypted: "N",
        question_order: questionIndex + 1,
        scale_id: 0,
        same_default: questionSeed.same_default === true ? "1" : "0",
        relevance: questionSeed.relevance ?? "1",
        question_theme_name: questionSeed.theme ?? BASE_THEME_BY_TYPE[questionSeed.type] ?? "",
        modulename: "",
        same_script: "0",
        l10n: l10n(questionSeed.text, questionSeed.help, questionSeed.script),
      });

      const subqids = new Map<string, number>();
      (questionSeed.subquestions ?? []).forEach((subSeed, subIndex) => {
        const subqid = id();
        subqids.set(subSeed.code, subqid);
        fake.questions.push({
          qid: subqid,
          parent_qid: qid,
          sid,
          gid,
          type: questionSeed.type,
          title: subSeed.code,
          preg: "",
          other: "N",
          mandatory: "",
          encrypted: "N",
          question_order: subIndex,
          scale_id: subSeed.scale_id ?? 0,
          same_default: "0",
          relevance: subSeed.relevance ?? "1",
          question_theme_name: "",
          modulename: "",
          same_script: "0",
          l10n: l10n(subSeed.text),
        });
      });

      (questionSeed.answers ?? []).forEach((answerSeed, answerIndex) => {
        fake.answers.push({
          aid: id(),
          qid,
          code: answerSeed.code,
          sortorder: answerIndex,
          assessment_value: answerSeed.assessment_value ?? 0,
          scale_id: answerSeed.scale_id ?? 0,
          l10n: { ...answerSeed.text },
        });
      });

      for (const attributeSeed of questionSeed.attributes ?? []) {
        fake.attributes.push({ qid, attribute: attributeSeed.name, value: attributeSeed.value, language: attributeSeed.language ?? "" });
      }

      for (const defaultSeed of questionSeed.defaults ?? []) {
        const sqid = defaultSeed.subquestion === undefined ? 0 : subqids.get(defaultSeed.subquestion);
        if (sqid === undefined) throw new Error(`seedSurvey: question ${questionSeed.code} has no subquestion ${defaultSeed.subquestion}.`);
        fake.defaults.push({
          dvid: id(),
          qid,
          sqid,
          scale_id: defaultSeed.scale_id ?? 0,
          specialtype: defaultSeed.specialtype ?? "",
          l10n: { ...defaultSeed.text },
        });
      }
    });
  });
  return { sid, gids, qids };
}
