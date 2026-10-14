/**
 * Generator for the LimeSurvey structure file (.lss) from a survey description (spec): a port of generate_lss() of the
 * plugin's Python generator (scripts/lss_tools.py), byte for byte for valid specs. Every value goes into a CDATA
 * section; the only text outside CDATA (the language codes) is XML-escaped.
 */
import { capLists, structuredSize } from "./response-limit.js";
import { normalizeSurveySpec, unescapeStrings } from "./spec-model.js";
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
const mandatoryFlag = (value: boolean | "soft"): string => (value === "soft" ? "S" : yn(value));

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
  const languages = [survey.language, ...survey.additional_languages.filter((language) => language !== survey.language)];

  const groupRows: Row[] = [];
  const groupL10nRows: Row[] = [];
  const questionRows: Row[] = [];
  const subquestionRows: Row[] = [];
  const questionL10nRows: Row[] = [];
  const attributeRows: Row[] = [];
  const answerRows: Row[] = [];
  const answerL10nRows: Row[] = [];

  let nextQid = 1;
  let nextAid = 1;
  const counters = { gl10n: 1, ql10n: 1, al10n: 1 };

  const addQuestionL10n = (qid: number, text: string, help: string): void => {
    for (const language of languages) {
      questionL10nRows.push({ id: counters.ql10n, qid, question: text, help, language, script: "" });
      counters.ql10n += 1;
    }
  };

  norm.groups.forEach((group, groupIndex) => {
    const gid = groupIndex + 1;
    groupRows.push({ gid, sid, group_order: gid, randomization_group: "", grelevance: group.relevance });
    for (const language of languages) {
      groupL10nRows.push({ id: counters.gl10n, gid, group_name: group.title, description: group.description, language });
      counters.gl10n += 1;
    }

    group.questions.forEach((question, questionIndex) => {
      const qid = nextQid;
      nextQid += 1;
      questionRows.push({
        qid, parent_qid: 0, sid, gid, type: question.type, title: question.code, preg: "", other: yn(question.other),
        mandatory: mandatoryFlag(question.mandatory), question_order: questionIndex + 1, scale_id: 0, same_default: 0,
        relevance: question.relevance, encrypted: "N", question_theme_name: "", same_script: 0,
      });
      addQuestionL10n(qid, question.text, question.help);

      question.subquestions.forEach((sub, subOrder) => {
        const subQid = nextQid;
        nextQid += 1;
        subquestionRows.push({
          qid: subQid, parent_qid: qid, sid, gid, type: question.type, title: sub.code, preg: "", other: "N",
          mandatory: "", question_order: subOrder, scale_id: 0, same_default: 0, relevance: "1", encrypted: "N",
          question_theme_name: "", same_script: 0,
        });
        addQuestionL10n(subQid, sub.text, "");
      });

      question.answers.forEach((answer, sortOrder) => {
        const aid = nextAid;
        nextAid += 1;
        answerRows.push({
          aid, qid, code: answer.code, sortorder: sortOrder, assessment_value: answer.assessment_value, scale_id: 0,
        });
        for (const language of languages) {
          answerL10nRows.push({ id: counters.al10n, aid, answer: answer.text, language });
          counters.al10n += 1;
        }
      });

      for (const name of Object.keys(question.attributes).sort()) {
        attributeRows.push({ qid, attribute: name, value: question.attributes[name] ?? "", language: "" });
      }
    });
  });

  const surveysRow: Row = {
    sid, gsid: 1, admin: "inherit", expires: survey.expires, startdate: "", adminemail: survey.adminemail || "inherit",
    anonymized: yn(survey.anonymized), format: survey.format, savetimings: yn(survey.savetimings),
    template: survey.template || "inherit", language: survey.language,
    additional_languages: survey.additional_languages.join(" "), datestamp: yn(survey.datestamp), usecookie: "I",
    allowregister: "I", allowsave: "I", autonumber_start: 0, autoredirect: "I", allowprev: "I", printanswers: "I",
    ipaddr: yn(survey.ipaddr), refurl: "I", showsurveypolicynotice: 0, publicstatistics: "I", publicgraphs: "I",
    listpublic: "I", htmlemail: "I", sendconfirmation: "I", tokenanswerspersistence: "I", assessments: "I",
    usecaptcha: "N", usetokens: "N", bounce_email: "inherit", attributedescriptions: "", emailresponseto: "inherit",
    emailnotificationto: "inherit", tokenlength: -1, showxquestions: "I", showgroupinfo: "B", shownoanswer: "N",
    showqnumcode: survey.showqnumcode, bouncetime: "", bounceprocessing: "N", bounceaccounttype: "",
    bounceaccounthost: "", bounceaccountpass: "", bounceaccountencryption: "", bounceaccountuser: "",
    showwelcome: "I", showprogress: yn(survey.showprogress), questionindex: 0, navigationdelay: 0, nokeyboard: "I",
    alloweditaftercompletion: "I", googleanalyticsstyle: 0, googleanalyticsapikey: "",
    tokenencryptionoptions: '{"enabled":"N","columns":{"firstname":"N","lastname":"N","email":"N"}}',
    ipanonymize: "I",
  };

  const languageSettingsRows: Row[] = languages.map((language) => ({
    surveyls_survey_id: sid, surveyls_language: language, surveyls_title: survey.title,
    surveyls_description: survey.description, surveyls_welcometext: survey.welcometext,
    surveyls_endtext: survey.endtext, surveyls_policy_notice: "", surveyls_policy_error: "",
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
  writer.section("questions", QUESTION_FIELDS, questionRows);
  writer.section("subquestions", QUESTION_FIELDS, subquestionRows);
  writer.section("question_l10ns", ["id", "qid", "question", "help", "language", "script"], questionL10nRows);
  writer.section("question_attributes", ["qid", "attribute", "value", "language"], attributeRows);
  writer.section("surveys", Object.keys(surveysRow), [surveysRow]);
  writer.section("surveys_languagesettings", Object.keys(languageSettingsRows[0] ?? {}), languageSettingsRows);
  writer.raw("</document>");
  return writer.text();
}
