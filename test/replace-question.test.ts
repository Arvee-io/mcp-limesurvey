import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, JsonValue, LimeSurveyConfig } from "../src/types.js";

const TOOL = "limesurvey_replace_question";
const SID = 7;
const GID = 3;
const OLD_QID = 101;
const WRITE_METHODS = ["set_question_properties", "import_question", "delete_question"];

const baseConfig: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 200_000,
};

interface SimQuestion {
  qid: number;
  sid: number;
  gid: number;
  parent: number;
  title: string;
  order: number;
  type: string;
  mandatory: string;
}

type Override = (params: JsonValue[], state: Sim) => JsonValue | undefined;

interface Sim {
  active: string;
  questions: SimQuestion[];
  nextQid: number;
  overrides: Record<string, Override>;
  /** Title of the question in the .lsq fixture; the simulated import creates it. */
  importTitle: string;
}

function initialSim(overrides: Record<string, Override> = {}, orders: [number, number, number] = [1, 2, 3]): Sim {
  const question = (qid: number, title: string, order: number, extra: Partial<SimQuestion> = {}): SimQuestion => ({
    qid, sid: SID, gid: GID, parent: 0, title, order, type: "T", mandatory: "N", ...extra,
  });
  return {
    active: "N",
    nextQid: 200,
    importTitle: "Q00",
    overrides,
    questions: [
      question(100, "Q_BEFORE", orders[0]),
      question(OLD_QID, "Q00", orders[1], { mandatory: "Y" }),
      question(102, "Q_AFTER", orders[2]),
      question(103, "Q_SUB", 1, { parent: 102 }),
    ],
  };
}

const mains = (state: Sim) => state.questions
  .filter((item) => item.parent === 0 && item.gid === GID)
  // Code-point order like a database collation ("Q00" < "Q_BEFORE"); localeCompare would put "_" first.
  .sort((a, b) => a.order - b.order || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

function renumber(state: Sim): void {
  mains(state).forEach((item, index) => { item.order = index + 1; });
}

function property(item: SimQuestion, name: string): JsonValue {
  const values: Record<string, JsonValue> = {
    sid: String(item.sid), gid: String(item.gid), parent_qid: String(item.parent), title: item.title,
    question_order: String(item.order), mandatory: item.mandatory, type: item.type,
  };
  return values[name] ?? null;
}

function simulate(state: Sim, method: string, params: JsonValue[]): JsonValue {
  const override = state.overrides[method]?.(params, state);
  if (override !== undefined) return override;
  const find = (qid: JsonValue) => state.questions.find((item) => item.qid === qid);
  switch (method) {
    case "get_survey_properties":
      return { active: state.active };
    case "get_question_properties": {
      const item = find(params[0] as JsonValue);
      if (!item) return { status: "Error: Invalid questionid" };
      return Object.fromEntries((params[1] as string[]).map((name) => [name, property(item, name)]));
    }
    case "list_questions":
      return mains(state).map((item) => ({
        id: item.qid, qid: item.qid, parent_qid: item.parent, sid: item.sid, gid: item.gid, title: item.title,
        question_order: item.order, type: item.type,
      }));
    case "set_question_properties": {
      const item = find(params[0] as JsonValue);
      const data = params[1] as Record<string, JsonValue>;
      if (!item) return { status: "Error: Invalid questionid" };
      const result: Record<string, JsonValue> = {};
      if (typeof data.title === "string") {
        item.title = data.title;
        result.title = true;
      }
      if (typeof data.question_order === "number") {
        item.order = data.question_order;
        result.question_order = true;
      }
      renumber(state);
      return result;
    }
    case "import_question": {
      if (state.questions.some((item) => item.parent === 0 && item.title.toLowerCase() === state.importTitle.toLowerCase())) {
        return { status: "Error: Question title already exist in this survey." };
      }
      const created: SimQuestion = {
        qid: state.nextQid++, sid: SID, gid: GID, parent: 0, title: state.importTitle,
        order: Math.max(...mains(state).map((item) => item.order)) + 2, type: "T", mandatory: String(params[4]),
      };
      state.questions.push(created);
      return created.qid;
    }
    case "delete_question": {
      const item = find(params[0] as JsonValue);
      if (!item) return { status: "Error: Invalid question ID" };
      state.questions = state.questions.filter((entry) => entry !== item && entry.parent !== item.qid);
      renumber(state);
      return item.qid;
    }
    default:
      return { status: `Error: the simulator does not know ${method}` };
  }
}

async function connected(sim: Sim, config: LimeSurveyConfig = baseConfig) {
  const requests: Array<{ method: string; params: JsonValue[] }> = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    if (request.method === "get_session_key") {
      return new Response(JSON.stringify({ id: request.id, result: "session-1", error: null }));
    }
    const params = (request.params as JsonValue[]).slice(1);
    requests.push({ method: request.method, params });
    return new Response(JSON.stringify({ id: request.id, result: simulate(sim, request.method, params), error: null }));
  };
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "replace-question-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    writes: () => requests.filter((request) => WRITE_METHODS.includes(request.method)),
    async close() {
      await client.close();
      await created.server.close();
    },
  };
}

async function lsqBase64(mutate: (xml: string) => string = (xml) => xml): Promise<string> {
  const xml = await readFile(path.resolve("test", "fixtures", "replace-question.lsq"), "utf8");
  return Buffer.from(mutate(xml), "utf8").toString("base64");
}

const args = async (extra: Record<string, unknown> = {}) => ({
  survey_id: SID,
  question_id: OLD_QID,
  import_data: await lsqBase64(),
  import_data_type: "lsq",
  confirm_destructive_action: true,
  ...extra,
});

function structured(response: unknown): Record<string, any> {
  const content = (response as { structuredContent?: { result?: Record<string, any> }; content?: unknown }).structuredContent;
  assert.ok(content?.result, `the tool answered without structured content: ${JSON.stringify(response)}`);
  return content.result;
}

const titlesOf = (sim: Sim) => mains(sim).map((item) => `${item.order}:${item.title}`);

test("[S-03b] replace_question swaps the question in place: RPC order, parameters, position and result", async () => {
  const sim = initialSim();
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const methods = session.requests.map((request) => request.method);
    assert.deepEqual(methods, [
      "get_survey_properties",
      "get_question_properties",
      "list_questions",
      "set_question_properties",
      "get_question_properties",
      "import_question",
      "set_question_properties",
      "get_question_properties",
      "delete_question",
      "get_question_properties",
      "list_questions",
    ]);
    const [survey, oldProps, listBefore, rename, reread, imported, reorder, guard, deleted, newProps, listAfter] = session.requests;
    assert.deepEqual(reread?.params, [OLD_QID, ["question_order"]], "the order is read again after the rename renumbered the group");
    assert.deepEqual(survey?.params, [SID, ["active"]]);
    assert.deepEqual(oldProps?.params, [OLD_QID, ["sid", "gid", "parent_qid", "title", "question_order", "mandatory", "type"]]);
    assert.deepEqual(listBefore?.params, [SID, GID]);
    assert.equal(rename?.params[0], OLD_QID);
    const tempTitle = (rename?.params[1] as { title: string }).title;
    assert.match(tempTitle, /^[A-Za-z][A-Za-z0-9]{3,19}$/);
    assert.notEqual(tempTitle, "Q00");
    assert.equal(imported?.params[0], SID);
    assert.equal(imported?.params[1], GID);
    assert.equal(imported?.params[2], (await args()).import_data);
    assert.equal(imported?.params[3], "lsq");
    assert.equal(imported?.params[4], "Y", "mandatory comes from the file because import_question always overwrites it");
    assert.deepEqual(reorder?.params, [200, { question_order: 2 }]);
    assert.equal(guard?.params[0], OLD_QID);
    assert.deepEqual(deleted?.params, [OLD_QID]);
    assert.deepEqual(newProps?.params, [200, ["title", "gid", "question_order", "type"]]);
    assert.deepEqual(listAfter?.params, [SID, GID]);

    const result = structured(response);
    assert.equal(result.survey_id, SID);
    assert.equal(result.group_id, GID);
    assert.equal(result.old_question_id, OLD_QID);
    assert.equal(result.new_question_id, 200);
    assert.equal(result.title, "Q00");
    assert.equal(result.question_order, 2);
    assert.ok(Array.isArray(result.steps) && result.steps.length >= 5);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
    assert.match(String(result.notes), /question IDs change/);
    assert.match(String(result.notes), /legacy conditions/);
    assert.deepEqual(titlesOf(sim), ["1:Q_BEFORE", "2:Q00", "3:Q_AFTER"]);
    assert.ok(sim.questions.some((item) => item.qid === 200 && item.order === 2));
    assert.ok(!sim.questions.some((item) => item.qid === OLD_QID));
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question skips the rename when the file brings a different code", async () => {
  const sim = initialSim();
  sim.importTitle = "Q01";
  const session = await connected(sim);
  try {
    const data = await lsqBase64((xml) => xml.replace("<![CDATA[Q00]]>", "<![CDATA[Q01]]>").replace("<![CDATA[Y]]>", "<![CDATA[S]]>"));
    const response = await session.client.callTool({ name: TOOL, arguments: await args({ import_data: data }) });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const renames = session.requests.filter((request) => request.method === "set_question_properties"
      && "title" in (request.params[1] as object));
    assert.equal(renames.length, 0);
    assert.equal(session.requests.find((request) => request.method === "import_question")?.params[4], "S");
    assert.deepEqual(titlesOf(sim), ["1:Q_BEFORE", "2:Q01", "3:Q_AFTER"]);
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question refuses an active survey without any writing RPC", async () => {
  const sim = initialSim();
  sim.active = "Y";
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, true);
    assert.equal(structured(response).code, "SURVEY_ACTIVE");
    assert.deepEqual(session.writes(), []);
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question refuses a question of another survey without any writing RPC", async () => {
  const sim = initialSim();
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args({ survey_id: 8 }) });
    assert.equal(response.isError, true);
    assert.equal(structured(response).code, "QUESTION_SURVEY_MISMATCH");
    assert.deepEqual(session.writes(), []);
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question refuses a subquestion without any writing RPC", async () => {
  const sim = initialSim();
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args({ question_id: 103 }) });
    assert.equal(response.isError, true);
    assert.equal(structured(response).code, "NOT_A_MAIN_QUESTION");
    assert.deepEqual(session.writes(), []);
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question refuses a file without a main question without any writing RPC", async () => {
  const sim = initialSim();
  const session = await connected(sim);
  try {
    const data = Buffer.from("<document><LimeSurveyDocType>Question</LimeSurveyDocType></document>").toString("base64");
    const response = await session.client.callTool({ name: TOOL, arguments: await args({ import_data: data }) });
    assert.equal(response.isError, true);
    assert.equal(structured(response).code, "LSQ_INVALID");
    assert.deepEqual(session.writes(), []);
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question needs confirm_destructive_action=true and sends no RPC without it", async () => {
  const sim = initialSim();
  const session = await connected(sim);
  try {
    for (const confirm of [undefined, false]) {
      const input = await args();
      if (confirm === undefined) delete (input as Record<string, unknown>).confirm_destructive_action;
      else input.confirm_destructive_action = confirm as unknown as true;
      const response = await session.client.callTool({ name: TOOL, arguments: input });
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response.content), /confirm_destructive_action/);
    }
    assert.deepEqual(session.requests, []);
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question with an import_data_path outside the import directory fails without any RPC", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ls-replace-"));
  const session = await connected(initialSim(), { ...baseConfig, importDir: dir });
  try {
    const input = await args();
    delete (input as Record<string, unknown>).import_data;
    const response = await session.client.callTool({
      name: TOOL,
      arguments: { ...input, import_data_path: path.join("..", "outside.lsq") },
    });
    assert.equal(response.isError, true);
    assert.equal(structured(response).code, "IMPORT_PATH_OUTSIDE_DIR");
    assert.deepEqual(session.requests, []);
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("[S-03b] replace_question: a failing import restores the title and deletes nothing", async () => {
  const sim = initialSim({
    import_question: () => ({ status: "Error: Invalid LimeSurvey question structure XML " }),
  });
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, true);
    const error = structured(response);
    assert.equal(error.code, "REPLACE_QUESTION_FAILED");
    assert.equal(error.details.failed_step, "import_question");
    assert.equal(error.details.rolled_back, true);
    assert.deepEqual(error.details.manual_cleanup, []);
    assert.deepEqual(session.requests.filter((request) => request.method === "delete_question"), []);
    const titleWrites = session.requests
      .filter((request) => request.method === "set_question_properties")
      .map((request) => (request.params[1] as { title?: string }).title);
    assert.equal(titleWrites.length, 2);
    assert.notEqual(titleWrites[0], "Q00");
    assert.equal(titleWrites[1], "Q00");
    assert.deepEqual(titlesOf(sim), ["1:Q_BEFORE", "2:Q00", "3:Q_AFTER"]);
    assert.ok(sim.questions.some((item) => item.qid === OLD_QID));
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question: a refused reorder removes the new question and restores the old title", async () => {
  const sim = initialSim({
    set_question_properties: (params) => (typeof (params[1] as { question_order?: number }).question_order === "number"
      ? { question_order: "Questions with dependencies - Order cannot be changed" }
      : undefined),
  });
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, true);
    const error = structured(response);
    assert.equal(error.details.failed_step, "set_question_order");
    assert.equal(error.details.rolled_back, true);
    assert.match(String(error.message), /dependencies/);
    const deletes = session.requests.filter((request) => request.method === "delete_question");
    assert.deepEqual(deletes.map((request) => request.params), [[200]]);
    assert.deepEqual(titlesOf(sim), ["1:Q_BEFORE", "2:Q00", "3:Q_AFTER"]);
    assert.ok(sim.questions.some((item) => item.qid === OLD_QID));
    assert.ok(!sim.questions.some((item) => item.qid === 200));
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question: a failing delete of the old question rolls the whole replacement back", async () => {
  const sim = initialSim({
    delete_question: (params) => (params[0] === OLD_QID
      ? { status: "Cannot delete Question. Others rely on this question" }
      : undefined),
  });
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, true);
    const error = structured(response);
    assert.equal(error.details.failed_step, "delete_old_question");
    assert.equal(error.details.rolled_back, true);
    assert.deepEqual(error.details.manual_cleanup, []);
    const deletes = session.requests.filter((request) => request.method === "delete_question").map((request) => request.params[0]);
    assert.deepEqual(deletes, [OLD_QID, 200], "only the old question is attempted, then only the question this call imported");
    assert.deepEqual(titlesOf(sim), ["1:Q_BEFORE", "2:Q00", "3:Q_AFTER"]);
    assert.ok(sim.questions.some((item) => item.qid === OLD_QID));
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question: a stray question created by a half-failed import is removed, nothing else", async () => {
  const sim = initialSim({
    import_question: (_params, state) => {
      state.questions.push({
        qid: state.nextQid++, sid: SID, gid: GID, parent: 0, title: state.importTitle, order: 9, type: "T", mandatory: "N",
      });
      return { status: "Error when update question", errors: { mandatory: ["invalid"] } };
    },
  });
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, true);
    assert.equal(structured(response).details.rolled_back, true);
    const deletes = session.requests.filter((request) => request.method === "delete_question").map((request) => request.params[0]);
    assert.deepEqual(deletes, [200]);
    assert.ok(sim.questions.some((item) => item.qid === OLD_QID && item.title === "Q00"));
    assert.deepEqual(titlesOf(sim), ["1:Q_BEFORE", "2:Q00", "3:Q_AFTER"]);
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question reports manual_cleanup when the rollback itself fails", async () => {
  const sim = initialSim({
    delete_question: () => ({ status: "Cannot delete Question. Others rely on this question" }),
  });
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, true);
    const error = structured(response);
    assert.equal(error.details.rolled_back, false);
    const cleanup = error.details.manual_cleanup as Array<Record<string, unknown>>;
    assert.ok(cleanup.length >= 1);
    assert.equal(cleanup[0]?.question_id, 200);
    assert.match(String(error.message), /manual cleanup/i);
    assert.ok(sim.questions.some((item) => item.qid === OLD_QID));
  } finally {
    await session.close();
  }
});

for (const [label, orders] of [["gaps 2, 4, 6", [2, 4, 6]], ["0-based 0, 1, 2", [0, 1, 2]]] as const) {
  test(`[S-03b] replace_question keeps the position when the group has ${label} and the rename renumbers it`, async () => {
    const sim = initialSim({}, [...orders]);
    const session = await connected(sim);
    try {
      const response = await session.client.callTool({ name: TOOL, arguments: await args() });
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      const result = structured(response);
      assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
      assert.deepEqual(mains(sim).map((item) => item.title), ["Q_BEFORE", "Q00", "Q_AFTER"]);
      assert.ok(!sim.questions.some((item) => item.qid === OLD_QID));
    } finally {
      await session.close();
    }
  });
}

/** delete_question that the server executes, but whose answer never reaches the client (timeout, 5xx, dropped connection). */
const deletesThenFails = (probeFails: boolean): Record<string, Override> => ({
  delete_question: (params, state) => {
    if (params[0] !== OLD_QID) return undefined;
    state.questions = state.questions.filter((entry) => entry.qid !== OLD_QID && entry.parent !== OLD_QID);
    renumber(state);
    throw new Error("The operation was aborted due to timeout");
  },
  get_question_properties: (params, state) => {
    if (probeFails && params[0] === OLD_QID && !state.questions.some((item) => item.qid === OLD_QID)) {
      throw new Error("connection reset");
    }
    return undefined;
  },
});

for (const [label, differentCode] of [["the same code (with rename)", false], ["a different code (no rename)", true]] as const) {
  test(`[S-03b] replace_question keeps the new question when delete_question was executed but not answered, ${label}`, async () => {
    const sim = initialSim(deletesThenFails(false));
    if (differentCode) sim.importTitle = "Q01";
    const session = await connected(sim);
    try {
      const data = differentCode
        ? await lsqBase64((xml) => xml.replace("<![CDATA[Q00]]>", "<![CDATA[Q01]]>"))
        : (await args()).import_data;
      const response = await session.client.callTool({ name: TOOL, arguments: await args({ import_data: data }) });
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      const result = structured(response);
      assert.equal(result.new_question_id, 200);
      assert.equal(result.old_question_id, OLD_QID);
      assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
      const deletes = session.requests.filter((request) => request.method === "delete_question").map((request) => request.params[0]);
      assert.deepEqual(deletes, [OLD_QID], "the new question must never be deleted");
      assert.deepEqual(mains(sim).map((item) => item.title), ["Q_BEFORE", differentCode ? "Q01" : "Q00", "Q_AFTER"]);
      assert.ok(sim.questions.some((item) => item.qid === 200));
      const step = (result.steps as Array<{ step: string; detail?: Record<string, unknown> }>).find((item) => item.step === "delete_old_question");
      assert.ok(step, "the delete step is reported");
      assert.match(JSON.stringify(step), /unclear|ambiguous|not answered/i);
    } finally {
      await session.close();
    }
  });
}

test("[S-03b] replace_question: an unanswered delete whose probe also fails deletes nothing and names both questions", async () => {
  const sim = initialSim(deletesThenFails(true));
  const session = await connected(sim);
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, true);
    const error = structured(response);
    assert.equal(error.code, "REPLACE_QUESTION_FAILED");
    assert.equal(error.details.failed_step, "delete_old_question");
    assert.equal(error.details.rolled_back, false);
    assert.doesNotMatch(String(error.message), /rolled back; the original question is unchanged/);
    const cleanup = error.details.manual_cleanup as Array<Record<string, unknown>>;
    const mentioned = JSON.stringify(cleanup);
    assert.ok(mentioned.includes(String(OLD_QID)) && mentioned.includes("200"), mentioned);
    const deletes = session.requests.filter((request) => request.method === "delete_question").map((request) => request.params[0]);
    assert.deepEqual(deletes, [OLD_QID], "the new question must not be deleted when the state is unknown");
    assert.ok(sim.questions.some((item) => item.qid === 200));
  } finally {
    await session.close();
  }
});

test("[S-03b] replace_question under write scope none is blocked before any RPC", async () => {
  const session = await connected(initialSim(), { ...baseConfig, writeScope: "none", readOnly: true });
  try {
    const response = await session.client.callTool({ name: TOOL, arguments: await args() });
    assert.equal(response.isError, true);
    assert.equal(structured(response).code, "WRITE_SCOPE_INSUFFICIENT");
    assert.deepEqual(session.requests, []);
  } finally {
    await session.close();
  }
});
