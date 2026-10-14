/**
 * Generator for the LimeSurvey structure file (.lss) from a survey description (spec): a port of generate_lss() of the
 * plugin's Python generator (scripts/lss_tools.py), byte for byte for valid version 1 specs. Every value goes into a
 * CDATA section; the only text outside CDATA (the language codes) is XML-escaped. Version 2 adds a text per language,
 * attribute values per language, default values (the sections defaultvalues and defaultvalue_l10ns), a script and the
 * question columns of the admin; a spec that uses none of it produces exactly the version 1 file.
 */
import { capLists, structuredSize } from "./response-limit.js";
import { normalizeSurveySpec, unescapeStrings, type TextMap } from "./spec-model.js";
import { validateSpec, type SpecFinding } from "./spec-validate.js";
import { LimeSurveyError, type JsonValue } from "./types.js";

const DBVERSION = "617";
const DEFAULT_SID = 0;

const QUESTION_FIELDS = [
  "qid", "parent_qid", "sid", "gid", "type", "title", "preg", "other", "mandatory", "question_order", "scale_id",
  "same_default", "relevance", "encrypted", "question_theme_name", "same_script",
];

type Row = Record<string, string | number | null>;

function cdata(value: string): string {
  return `<![CDATA[${value.split("]]>").join("]]]]><![CDATA[>")}]]>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

class Writer {
  private readonly lines: string[] = [];

  raw(line: string): void {
    this.lines.push(line);
  }

  section(name: string, fields: readonly string[], rows: readonly Row[]): void {
    this.raw(` <${name}>`);
    this.raw("  <fields>");
    for (const field of fields) this.raw(`   <fieldname>${field}</fieldname>`);
    this.raw("  </fields>");
    this.raw("  <rows>");
    for (const row of rows) {
      this.raw("   <row>");
      for (const field of fields) {
        const raw = row[field];
        const value = raw === undefined || raw === null ? "" : String(raw);
        this.raw(value === "" ? `    <${field}/>` : `    <${field}>${cdata(value)}</${field}>`);
      }
      this.raw("   </row>");
    }
    this.raw("  </rows>");
    this.raw(` </${name}>`);
  }

  text(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

const yn = (flag: boolean): string => (flag ? "Y" : "N");
/** A Yes/No survey setting: Y, N or I (inherit). */
const ynInherit = (value: boolean | "inherit"): string => (value === "inherit" ? "I" : yn(value));
const mandatoryFlag = (value: boolean | "soft"): string => (value === "soft" ? "S" : yn(value));
const textIn = (texts: TextMap, language: string): string => texts[language] ?? "";

/**
 * The SPEC_INVALID error: details.errors holds the problems (path, message, fix), errors_total their number. With
 * `limit` the list is cut so that the structured answer of that workflow stays within maxChars (truncated says so).
 */
export function specInvalidError(errors: readonly SpecFinding[], limit?: { workflow: string; maxChars: number }): LimeSurveyError {
  const message = `The spec is invalid (${errors.length} problem${errors.length === 1 ? "" : "s"}); no file was generated.`;
  const details = (shown: readonly SpecFinding[]): JsonValue => ({
    errors: shown as unknown as JsonValue,
    errors_total: errors.length,
    truncated: shown.length < errors.length,
    recovery: "Fix every entry of errors (path, message, fix) and send the spec again; limesurvey_validate_spec checks a spec without sending anything to LimeSurvey.",
  });
  const shown = limit === undefined
    ? errors
    : capLists({ errors }, (cut) => structuredSize(limit.workflow, { status: "error", message, code: "SPEC_INVALID", details: details(cut.errors) }) <= limit.maxChars).errors;
  return new LimeSurveyError(message, "SPEC_INVALID", details(shown));
}

/** Validates the spec and returns the .lss document. Throws LimeSurveyError SPEC_INVALID with the errors. */
export function generateSurveyLss(spec: unknown): string {
  const decoded = unescapeStrings(spec);
  const validation = validateSpec("survey", decoded);
  if (!validation.valid) throw specInvalidError(validation.errors);
  const sid = DEFAULT_SID;
  const norm = normalizeSurveySpec(decoded);
  const survey = norm.survey;
  const languages = norm.languages;
  const usesModulename = norm.groups.some((group) => group.questions.some((question) => question.modulename !== ""));
  const questionFields = usesModulename ? [...QUESTION_FIELDS, "modulename"] : QUESTION_FIELDS;

  const groupRows: Row[] = [];
  const groupL10nRows: Row[] = [];
  const questionRows: Row[] = [];
  const subquestionRows: Row[] = [];
  const questionL10nRows: Row[] = [];
  const attributeRows: Row[] = [];
  const defaultRows: Row[] = [];
  const defaultL10nRows: Row[] = [];
  const answerRows: Row[] = [];
  const answerL10nRows: Row[] = [];

  let nextQid = 1;
  let nextAid = 1;
  let nextDvid = 1;
  const counters = { gl10n: 1, ql10n: 1, al10n: 1, dl10n: 1 };

  const addQuestionL10n = (qid: number, text: TextMap, help: TextMap, script: TextMap): void => {
    for (const language of languages) {
      questionL10nRows.push({
        id: counters.ql10n, qid, question: textIn(text, language), help: textIn(help, language), language,
        script: textIn(script, language),
      });
      counters.ql10n += 1;
    }
  };

  /** A default value (sqid 0: the question itself; specialtype other: its "Other" option) in the languages it names. */
  const addDefault = (qid: number, sqid: number, specialtype: string, texts: TextMap | undefined): void => {
    if (texts === undefined) return;
    const named = languages.filter((language) => textIn(texts, language) !== "");
    if (named.length === 0) return;
    const dvid = nextDvid;
    nextDvid += 1;
    defaultRows.push({ dvid, qid, scale_id: 0, sqid, specialtype });
    for (const language of named) {
      defaultL10nRows.push({ id: counters.dl10n, dvid, defaultvalue: textIn(texts, language), language });
      counters.dl10n += 1;
    }
  };

  norm.groups.forEach((group, groupIndex) => {
    const gid = groupIndex + 1;
    groupRows.push({ gid, sid, group_order: gid, randomization_group: group.randomization_group, grelevance: group.relevance });
    for (const language of languages) {
      groupL10nRows.push({
        id: counters.gl10n, gid, group_name: textIn(group.title, language), description: textIn(group.description, language), language,
      });
      counters.gl10n += 1;
    }

    group.questions.forEach((question, questionIndex) => {
      const qid = nextQid;
      nextQid += 1;
      questionRows.push({
        qid, parent_qid: 0, sid, gid, type: question.type, title: question.code, preg: question.preg, other: yn(question.other),
        mandatory: mandatoryFlag(question.mandatory), question_order: questionIndex + 1, scale_id: 0,
        same_default: question.same_default ? 1 : 0, relevance: question.relevance, encrypted: yn(question.encrypted),
        question_theme_name: question.question_theme_name, same_script: question.same_script ? 1 : 0,
        modulename: question.modulename,
      });
      addQuestionL10n(qid, question.text, question.help, question.script);
      addDefault(qid, 0, "", question.default);
      addDefault(qid, 0, "other", question.default_other);

      question.subquestions.forEach((sub, subOrder) => {
        const subQid = nextQid;
        nextQid += 1;
        subquestionRows.push({
          qid: subQid, parent_qid: qid, sid, gid, type: question.type, title: sub.code, preg: "", other: "N",
          mandatory: "", question_order: subOrder, scale_id: 0, same_default: 0, relevance: sub.relevance, encrypted: "N",
          question_theme_name: "", same_script: 0, modulename: "",
        });
        addQuestionL10n(subQid, sub.text, {}, {});
        addDefault(qid, subQid, "", sub.default);
      });

      question.answers.forEach((answer, sortOrder) => {
        const aid = nextAid;
        nextAid += 1;
        answerRows.push({
          aid, qid, code: answer.code, sortorder: sortOrder, assessment_value: answer.assessment_value, scale_id: 0,
        });
        for (const language of languages) {
          answerL10nRows.push({ id: counters.al10n, aid, answer: textIn(answer.text, language), language });
          counters.al10n += 1;
        }
      });

      for (const name of Object.keys(question.attributes).sort()) {
        const value = question.attributes[name] ?? "";
        if (typeof value === "string") {
          attributeRows.push({ qid, attribute: name, value, language: "" });
        } else {
          // A language-dependent attribute: LimeSurvey reads one row per language and ignores a row without one.
          for (const language of languages) attributeRows.push({ qid, attribute: name, value: textIn(value, language), language });
        }
      }
    });
  });

  const surveysRow: Row = {
    sid, gsid: 1, admin: "inherit", expires: survey.expires, startdate: "", adminemail: survey.adminemail || "inherit",
    anonymized: ynInherit(survey.anonymized), format: survey.format, savetimings: ynInherit(survey.savetimings),
    template: survey.template || "inherit", language: survey.language,
    additional_languages: survey.additional_languages.join(" "), datestamp: ynInherit(survey.datestamp), usecookie: "I",
    allowregister: "I", allowsave: "I", autonumber_start: 0, autoredirect: "I", allowprev: "I", printanswers: "I",
    ipaddr: ynInherit(survey.ipaddr), refurl: "I", showsurveypolicynotice: 0, publicstatistics: "I", publicgraphs: "I",
    listpublic: "I", htmlemail: "I", sendconfirmation: "I", tokenanswerspersistence: "I", assessments: "I",
    usecaptcha: "N", usetokens: "N", bounce_email: "inherit", attributedescriptions: "", emailresponseto: "inherit",
    emailnotificationto: "inherit", tokenlength: -1, showxquestions: "I", showgroupinfo: "B", shownoanswer: "N",
    showqnumcode: survey.showqnumcode, bouncetime: "", bounceprocessing: "N", bounceaccounttype: "",
    bounceaccounthost: "", bounceaccountpass: "", bounceaccountencryption: "", bounceaccountuser: "",
    showwelcome: "I", showprogress: ynInherit(survey.showprogress), questionindex: 0, navigationdelay: 0, nokeyboard: "I",
    alloweditaftercompletion: "I", googleanalyticsstyle: 0, googleanalyticsapikey: "",
    tokenencryptionoptions: '{"enabled":"N","columns":{"firstname":"N","lastname":"N","email":"N"}}',
    ipanonymize: "I",
  };

  const languageSettingsRows: Row[] = languages.map((language) => ({
    surveyls_survey_id: sid, surveyls_language: language, surveyls_title: textIn(survey.title, language),
    surveyls_description: textIn(survey.description, language), surveyls_welcometext: textIn(survey.welcometext, language),
    surveyls_endtext: textIn(survey.endtext, language), surveyls_policy_notice: "", surveyls_policy_error: "",
    surveyls_policy_notice_label: "", surveyls_url: "", surveyls_urldescription: "", surveyls_dateformat: 1,
    surveyls_numberformat: 0, surveyls_alias: "",
  }));

  const writer = new Writer();
  writer.raw('<?xml version="1.0" encoding="UTF-8"?>');
  writer.raw("<document>");
  writer.raw(" <LimeSurveyDocType>Survey</LimeSurveyDocType>");
  writer.raw(` <DBVersion>${DBVERSION}</DBVersion>`);
  writer.raw(" <languages>");
  for (const language of languages) writer.raw(`  <language>${escapeXml(language)}</language>`);
  writer.raw(" </languages>");

  writer.section("answers", ["aid", "qid", "code", "sortorder", "assessment_value", "scale_id"], answerRows);
  writer.section("answer_l10ns", ["id", "aid", "answer", "language"], answerL10nRows);
  writer.section("groups", ["gid", "sid", "group_order", "randomization_group", "grelevance"], groupRows);
  writer.section("group_l10ns", ["id", "gid", "group_name", "description", "language"], groupL10nRows);
  writer.section("questions", questionFields, questionRows);
  writer.section("subquestions", questionFields, subquestionRows);
  writer.section("question_l10ns", ["id", "qid", "question", "help", "language", "script"], questionL10nRows);
  writer.section("question_attributes", ["qid", "attribute", "value", "language"], attributeRows);
  if (defaultRows.length > 0) {
    writer.section("defaultvalues", ["dvid", "qid", "scale_id", "sqid", "specialtype"], defaultRows);
    writer.section("defaultvalue_l10ns", ["id", "dvid", "defaultvalue", "language"], defaultL10nRows);
  }
  writer.section("surveys", Object.keys(surveysRow), [surveysRow]);
  writer.section("surveys_languagesettings", Object.keys(languageSettingsRows[0] ?? {}), languageSettingsRows);
  writer.raw("</document>");
  return writer.text();
}
