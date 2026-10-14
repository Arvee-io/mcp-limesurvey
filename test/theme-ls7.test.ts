import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import JSZip from "jszip";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, JsonValue, LimeSurveyConfig } from "../src/types.js";

// LimeSurvey 7.5.1 installs an imported survey theme under the name of the uploaded ZIP file (without .zip, dots
// removed), not under config.xml metadata/name, and caps that name at 45 characters. These tests pin the server to
// that rule and to the file filter of the import (allowedthemeuploads / allowedthemeimageformats defaults).

const baseConfig: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

type Responder = (request: JsonRpcRequest) => JsonValue;

async function session(
  options: { themeDir?: string; responder?: Responder; config?: Partial<LimeSurveyConfig> } = {},
) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-theme" : (options.responder?.(request) ?? null);
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const config = {
    ...baseConfig,
    ...options.config,
    ...(options.themeDir ? { themeDir: options.themeDir } : {}),
  };
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "theme-ls7-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    /** RPC methods sent after the session key, in order. */
    methods() {
      return requests.map((request) => request.method).filter((method) => method !== "get_session_key");
    },
    async close() {
      await client.close();
      await created.server.close();
    },
  };
}

function result(structured: unknown): Record<string, unknown> {
  return (structured as { result?: Record<string, unknown> } | undefined)?.result ?? {};
}

/**
 * A survey whose template starts as `initial`. set_survey_properties answers {template: true} like LimeSurvey does even
 * when it silently keeps another theme, and stores `stored` or, without it, the template that was set;
 * get_survey_properties returns the current template.
 */
function surveyTemplateResponder(stored?: string, initial = "fruity_twentythree"): Responder {
  let current: JsonValue = initial;
  return (request) => {
    if (request.method === "set_survey_properties") {
      current = stored ?? (request.params[2] as { template?: JsonValue } | undefined)?.template ?? null;
      return { template: true };
    }
    if (request.method === "get_survey_properties") return { template: current };
    return null;
  };
}

/** Answers get_survey_properties with the next value of `reads` (the last one repeats) and set with `setResult`. */
function scriptedResponder(reads: JsonValue[], setResult: JsonValue = { template: true }): Responder {
  let index = 0;
  return (request) => {
    if (request.method === "set_survey_properties") return setResult;
    if (request.method === "get_survey_properties") {
      const value = reads[Math.min(index, reads.length - 1)] ?? null;
      index += 1;
      return value;
    }
    return null;
  };
}

async function withThemeDir<T>(run: (themeDir: string) => Promise<T>): Promise<T> {
  const themeDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-theme9-"));
  try {
    return await run(themeDir);
  } finally {
    await rm(themeDir, { recursive: true, force: true });
  }
}

/**
 * A hand-built package that meets the generator's own policy (vanilla parent, GPL, responsive CSS, LICENSE.txt,
 * views/README.txt) so that each test changes exactly one aspect.
 */
function themePackage(
  installedName: string,
  options: {
    title?: string | null;
    /** Parent theme; null leaves metadata/extends out. */
    parent?: string | null;
    /** Adds an engine section (needed by a theme without a parent). */
    engine?: boolean;
    compatibility?: string[];
    css?: string;
    views?: Record<string, string>;
    files?: Record<string, string | Buffer>;
  } = {},
): JSZip {
  const title = options.title === undefined ? "LimeSurvey 7 Test Theme" : options.title;
  const parent = options.parent === undefined ? "vanilla" : options.parent;
  const compatibility = (options.compatibility ?? ["7.0"]).map((version) => `    <version>${version}</version>\n`).join("");
  const engine = options.engine
    ? "  <engine>\n    <cssframework><name>bootstrap</name></cssframework>\n"
      + "    <viewdirectory>views</viewdirectory>\n    <filesdirectory>files</filesdirectory>\n  </engine>\n"
    : "";
  const zip = new JSZip();
  zip.file(
    "config.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <metadata>
    <name>${installedName}</name>
${title === null ? "" : `    <title>${title}</title>\n`}    <type>theme</type>
    <author>Test Author</author>
    <license>GNU General Public License version 2 or later</license>
    <version>1.0.0</version>
    <apiVersion>3</apiVersion>
    <description>Hand-built package for the LimeSurvey 7 import rules.</description>
${parent === null ? "" : `    <extends>${parent}</extends>\n`}  </metadata>
  <compatibility>
${compatibility}  </compatibility>
${engine}  <files>
    <css>
      <add>css/mcp-theme.css</add>
    </css>
  </files>
</config>
`,
  );
  zip.file(
    "css/mcp-theme.css",
    options.css
      ?? "@media (max-width: 575.98px) { body { color: #111111; } }\n"
        + ":focus-visible { outline: 3px solid #005FCC; }\n"
        + "@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }\n",
  );
  zip.file("LICENSE.txt", "GNU General Public License version 2 or later\n");
  for (const [name, content] of Object.entries(options.views ?? { "views/README.txt": "Inherited views.\n" })) {
    zip.file(name, content);
  }
  for (const [name, content] of Object.entries(options.files ?? {})) zip.file(name, content);
  return zip;
}

type Validation = { valid: boolean; errors: string[]; warnings: string[]; installed_theme_name?: string };

async function validate(
  fileName: string,
  zip: JSZip | Buffer,
  config: Partial<LimeSurveyConfig> = {},
): Promise<Validation> {
  return withThemeDir(async (themeDir) => {
    const archive = Buffer.isBuffer(zip) ? zip : await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(path.join(themeDir, fileName), archive, { mode: 0o600 });
    const current = await session({ themeDir, config });
    try {
      const response = await current.client.callTool({
        name: "limesurvey_validate_survey_theme",
        arguments: { file_name: fileName },
      });
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      assert.equal(current.requests.length, 0, "validation is local and must not call LimeSurvey");
      return result(response.structuredContent) as unknown as Validation;
    } finally {
      await current.close();
    }
  });
}

// WOFF2 files start with the signature "wOF2".
const woff2Font = Buffer.concat([Buffer.from("wOF2", "ascii"), Buffer.alloc(44)]);

// ---------------------------------------------------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------------------------------------------------

test("[THEME-9] generate returns the installed theme name LimeSurvey derives from the ZIP name and writes it as metadata/name", async () => {
  await withThemeDir(async (themeDir) => {
    const current = await session({ themeDir });
    try {
      const response = await current.client.callTool({
        name: "limesurvey_generate_survey_theme",
        arguments: {
          theme_name: "weit_feedback",
          title: "WEIT Feedback",
          theme_version: "1.0.0",
          target_limesurvey_major: "7",
        },
      });
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      const generated = result(response.structuredContent);
      assert.equal(generated.file_name, "weit_feedback-1.0.0-ls7.zip");
      assert.equal(generated.installed_theme_name, "weit_feedback-100-ls7");

      const zip = await JSZip.loadAsync(await readFile(path.join(themeDir, "weit_feedback-1.0.0-ls7.zip")));
      const manifest = (await zip.file("config.xml")?.async("string")) ?? "";
      assert.equal(/<name>([^<]*)<\/name>/.exec(manifest)?.[1], "weit_feedback-100-ls7");
    } finally {
      await current.close();
    }
  });
});

test("[THEME-9] generate refuses a theme_name whose installed name would exceed 45 characters and writes no file", async () => {
  await withThemeDir(async (themeDir) => {
    const current = await session({ themeDir });
    try {
      // 38 + "-100-ls7" (8) = 46 characters: LimeSurvey would abort the import after extracting the files.
      const tooLong = await current.client.callTool({
        name: "limesurvey_generate_survey_theme",
        arguments: { theme_name: `weit_${"x".repeat(33)}`, title: "Too long", theme_version: "1.0.0" },
      });
      assert.equal(tooLong.isError, true, JSON.stringify(tooLong.structuredContent));
      const text = JSON.stringify(tooLong.content);
      assert.match(text, /45/);
      assert.match(text, /theme_name/);
      assert.deepEqual(await readdir(themeDir), []);

      // 37 + 8 = 45 characters is the longest name LimeSurvey accepts.
      const longest = await current.client.callTool({
        name: "limesurvey_generate_survey_theme",
        arguments: { theme_name: `weit_${"x".repeat(32)}`, title: "Longest", theme_version: "1.0.0" },
      });
      assert.equal(longest.isError, undefined, JSON.stringify(longest.structuredContent));
      assert.equal(result(longest.structuredContent).installed_theme_name, `weit_${"x".repeat(32)}-100-ls7`);
      assert.equal(current.requests.length, 0);
    } finally {
      await current.close();
    }
  });
});

test("[THEME-9] generate warns when the version digits without dots are ambiguous in the installed name", async () => {
  await withThemeDir(async (themeDir) => {
    const current = await session({ themeDir });
    try {
      // 1.10.0 and 11.0.0 both become weit_feedback-1100-ls7; the second import would stop with "already exists".
      const ambiguous = await current.client.callTool({
        name: "limesurvey_generate_survey_theme",
        arguments: { theme_name: "weit_feedback", title: "WEIT Feedback", theme_version: "1.10.0" },
      });
      assert.equal(ambiguous.isError, undefined, JSON.stringify(ambiguous.structuredContent));
      const generated = result(ambiguous.structuredContent);
      assert.equal(generated.installed_theme_name, "weit_feedback-1100-ls7");
      assert.ok(Array.isArray(generated.warnings), JSON.stringify(generated));
      assert.ok(
        (generated.warnings as unknown[]).some((warning) => String(warning).includes("1100")),
        JSON.stringify(generated.warnings),
      );

      // Single-digit components cannot collide: no warning.
      const plain = await current.client.callTool({
        name: "limesurvey_generate_survey_theme",
        arguments: { theme_name: "weit_feedback", title: "WEIT Feedback", theme_version: "1.0.0" },
      });
      assert.equal(plain.isError, undefined, JSON.stringify(plain.structuredContent));
      assert.deepEqual(result(plain.structuredContent).warnings ?? [], []);
    } finally {
      await current.close();
    }
  });
});

test("[THEME-9] THEME_NAME_TOO_LONG never names a negative length and suggests shortening theme_version", async () => {
  await withThemeDir(async (themeDir) => {
    const current = await session({ themeDir });
    try {
      // 41 version digits plus "-" and "-ls7" already exceed 45 characters without any theme_name.
      const response = await current.client.callTool({
        name: "limesurvey_generate_survey_theme",
        arguments: {
          theme_name: "weit_feedback",
          title: "Long version",
          theme_version: `${"1".repeat(20)}.${"2".repeat(20)}.3`,
        },
      });
      assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
      const text = JSON.stringify(response.content);
      assert.doesNotMatch(text, /at most -\d/);
      assert.match(text, /shorten/i);
      assert.match(text, /theme_version/);
      assert.deepEqual(await readdir(themeDir), []);
    } finally {
      await current.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// assign
// ---------------------------------------------------------------------------------------------------------------------

test("[THEME-9] assign accepts installed theme names in LimeSurvey's format", async () => {
  for (const themeName of ["weit_feedback-100-ls7", "a".repeat(45)]) {
    const current = await session({ responder: surveyTemplateResponder() });
    try {
      const response = await current.client.callTool({
        name: "limesurvey_assign_survey_theme",
        arguments: { survey_id: 123, theme_name: themeName, confirm_theme_assignment: true },
      });
      assert.equal(response.isError, undefined, `${themeName}: ${JSON.stringify(response.structuredContent)}`);
      const set = current.requests.find((request) => request.method === "set_survey_properties");
      assert.deepEqual(set?.params, ["session-theme", 123, { template: themeName }]);
    } finally {
      await current.close();
    }
  }
});

test("[THEME-9] assign rejects names LimeSurvey cannot install, without an RPC call", async () => {
  const current = await session({ responder: surveyTemplateResponder() });
  try {
    for (const themeName of ["a b", "x.y", "a".repeat(46)]) {
      const response = await current.client.callTool({
        name: "limesurvey_assign_survey_theme",
        arguments: { survey_id: 123, theme_name: themeName, confirm_theme_assignment: true },
      });
      assert.equal(response.isError, true, themeName);
    }
    assert.equal(current.requests.length, 0);
  } finally {
    await current.close();
  }
});

// The RPC sequence of an assignment: read the previous theme, set the new one, read it back.
const assignSequence = ["get_survey_properties", "set_survey_properties", "get_survey_properties"];

test("[THEME-9] assign reports THEME_NOT_APPLIED when LimeSurvey silently keeps another theme", async () => {
  const current = await session({ responder: surveyTemplateResponder("fruity_twentythree") });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
    assert.equal(result(response.structuredContent).code, "THEME_NOT_APPLIED");
    const text = JSON.stringify(response.structuredContent);
    assert.match(text, /weit_feedback-100-ls7/);
    assert.match(text, /fruity_twentythree/);
    // limesurvey_list_installed_themes cannot list installed names (only local ZIPs and themes already in use), so the
    // recovery points to the theme list and to installed_theme_name instead.
    assert.doesNotMatch(text, /limesurvey_list_installed_themes/);
    assert.match(text, /installed_theme_name/);
    assert.deepEqual(current.methods(), assignSequence);
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign reads the template back after setting it and reports verified: true", async () => {
  const current = await session({ responder: surveyTemplateResponder() });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    assert.equal(result(response.structuredContent).verified, true);
    assert.deepEqual(current.methods(), assignSequence);
    for (const read of current.requests.filter((request) => request.method === "get_survey_properties")) {
      assert.deepEqual(read.params, ["session-theme", 123, ["template"]]);
    }
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign reports THEME_NOT_VERIFIED with written: true when only the read-back fails", async () => {
  const current = await session({
    responder: scriptedResponder([{ template: "fruity_twentythree" }, { status: "Error: No permission" }]),
  });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
    const body = result(response.structuredContent);
    assert.equal(body.code, "THEME_NOT_VERIFIED", JSON.stringify(body));
    const details = (body.details ?? {}) as Record<string, unknown>;
    assert.equal(details.written, true);
    assert.match(String(details.recovery), /limesurvey_get_survey_properties/);
    assert.deepEqual(current.methods(), assignSequence);
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign reports THEME_NOT_VERIFIED when the read-back has no template string", async () => {
  const current = await session({ responder: scriptedResponder([{ template: "fruity_twentythree" }, {}]) });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
    assert.equal(result(response.structuredContent).code, "THEME_NOT_VERIFIED");
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign reports THEME_NOT_APPLIED when LimeSurvey refuses to save the survey", async () => {
  const current = await session({
    responder: scriptedResponder([{ template: "fruity_twentythree" }], { template: false }),
  });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
    assert.equal(result(response.structuredContent).code, "THEME_NOT_APPLIED");
    assert.match(JSON.stringify(response.structuredContent), /refused to save/i);
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign writes nothing when the previous theme cannot be read", async () => {
  const current = await session({ responder: scriptedResponder([{ status: "Error: No permission" }]) });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
    assert.deepEqual(current.methods(), ["get_survey_properties"]);
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign reports previous_theme and whether the survey changed", async () => {
  const changed = await session({ responder: surveyTemplateResponder(undefined, "vanilla") });
  try {
    const response = await changed.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const body = result(response.structuredContent);
    assert.equal(body.previous_theme, "vanilla");
    assert.equal(body.changed, true);
  } finally {
    await changed.close();
  }

  const same = await session({ responder: surveyTemplateResponder(undefined, "weit_feedback-100-ls7") });
  try {
    const response = await same.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const body = result(response.structuredContent);
    assert.equal(body.previous_theme, "weit_feedback-100-ls7");
    assert.equal(body.changed, false);
  } finally {
    await same.close();
  }
});

test("[THEME-9] THEME_NOT_APPLIED names previous_theme and asks to restore it when the survey changed", async () => {
  // The survey used vanilla; LimeSurvey stored its default theme instead of the requested one.
  const current = await session({ responder: surveyTemplateResponder("fruity_twentythree", "vanilla") });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
    const body = result(response.structuredContent);
    assert.equal(body.code, "THEME_NOT_APPLIED");
    const details = (body.details ?? {}) as Record<string, unknown>;
    assert.equal(details.previous_theme, "vanilla");
    assert.equal(details.changed, true);
    assert.match(String(details.recovery), /restore/i);
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign names set_survey_properties as the rollback when the survey inherited its theme", async () => {
  const current = await session({ responder: surveyTemplateResponder(undefined, "inherit") });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback-100-ls7", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const body = result(response.structuredContent);
    assert.equal(body.previous_theme, "inherit");
    assert.match(String(body.rollback), /limesurvey_set_survey_properties/);
    assert.match(String(body.rollback), /inherit/);
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign refuses inherit without an RPC call and points to the admin interface", async () => {
  const current = await session({ responder: surveyTemplateResponder() });
  try {
    const response = await current.client.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "inherit", confirm_theme_assignment: true },
    });
    assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
    const text = JSON.stringify(response.content);
    assert.match(text, /inherit/);
    assert.match(text, /admin/i);
    // The reason: the read-back only confirms the stored value, not the theme the survey group passes on.
    assert.match(text, /group/i);
    assert.equal(current.requests.length, 0);
  } finally {
    await current.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------------------------------------------------

test("[THEME-9] validate accepts web fonts with a valid signature and text files outside views/", async () => {
  const validation = await validate(
    "font_theme-1.0.0-ls7.zip",
    themePackage("font_theme-100-ls7", { files: { "fonts/x.woff2": woff2Font, "fonts/OFL.txt": "SIL Open Font License\n" } }),
  );
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
  assert.equal(validation.installed_theme_name, "font_theme-100-ls7");
});

test("[THEME-9] validate rejects a font whose content does not match its extension", async () => {
  const validation = await validate(
    "bad_font-1.0.0-ls7.zip",
    themePackage("bad_font-100-ls7", { files: { "fonts/bad.ttf": "not a font\n" } }),
  );
  assert.equal(validation.valid, false);
  // Fonts are allowed now, so the error must come from the signature check, not from the file type.
  assert.ok(
    validation.errors.some((error) => error.includes("fonts/bad.ttf") && /signature|content/i.test(error)),
    JSON.stringify(validation.errors),
  );
});

test("[THEME-9] validate accepts views/ that only holds a .txt placeholder", async () => {
  const validation = await validate(
    "keep_views-1.0.0-ls7.zip",
    themePackage("keep_views-100-ls7", { views: { "views/keep.txt": "keep\n" } }),
  );
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

test("[THEME-9] validate rejects views/*.html because LimeSurvey skips .html files on import", async () => {
  const validation = await validate(
    "html_views-1.0.0-ls7.zip",
    themePackage("html_views-100-ls7", { views: { "views/README.txt": "Inherited views.\n", "views/x.html": "<p>x</p>\n" } }),
  );
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("views/x.html")), JSON.stringify(validation.errors));
});

test("[THEME-9] validate rejects a manifest without metadata/title", async () => {
  const validation = await validate("no_title-1.0.0-ls7.zip", themePackage("no_title-100-ls7", { title: null }));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => /title/.test(error)), JSON.stringify(validation.errors));
});

test("[THEME-9] validate reports a JavaScript file as a policy warning, not as an error", async () => {
  const validation = await validate(
    "js_theme-1.0.0-ls7.zip",
    themePackage("js_theme-100-ls7", { files: { "js/custom.js": "console.log('theme');\n" } }),
  );
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
  assert.ok(
    validation.warnings.some((warning) => warning.startsWith("policy:") && warning.includes("js/custom.js")),
    JSON.stringify(validation.warnings),
  );
});

test("[THEME-9] validate rejects a file the LimeSurvey import would silently skip", async () => {
  const validation = await validate(
    "exe_theme-1.0.0-ls7.zip",
    themePackage("exe_theme-100-ls7", { files: { "files/tool.exe": "MZ" } }),
  );
  assert.equal(validation.valid, false);
  // The error explains the LimeSurvey behaviour: the import drops the file and reports a partial import.
  assert.ok(
    validation.errors.some((error) => error.includes("files/tool.exe") && /skip/i.test(error)),
    JSON.stringify(validation.errors),
  );
});

test("[THEME-9] validate rejects a ZIP name whose installed theme name exceeds 45 characters", async () => {
  const installedName = `${"a".repeat(38)}-100-ls7`;
  const validation = await validate(`${"a".repeat(38)}-1.0.0-ls7.zip`, themePackage(installedName));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("45")), JSON.stringify(validation.errors));
  assert.equal(validation.installed_theme_name, installedName);
});

test("[THEME-9] validate accepts a vanilla-like theme that only breaks the generator's policy, with policy warnings", async () => {
  // Own CSS file instead of css/mcp-theme.css, no LICENSE.txt and no license in the manifest, 60 entries, and an
  // @import of an external font stylesheet: LimeSurvey imports and uses all of it.
  const zip = new JSZip();
  zip.file(
    "config.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <metadata>
    <name>vanilla_like-100-ls7</name>
    <title>Vanilla-like Theme</title>
    <type>theme</type>
    <author>Test Author</author>
    <version>1.0.0</version>
    <apiVersion>3</apiVersion>
    <description>Hand-built theme outside the generator's policy.</description>
    <extends>vanilla</extends>
  </metadata>
  <compatibility>
    <version>7.0</version>
  </compatibility>
  <files>
    <css>
      <add>css/custom.css</add>
    </css>
  </files>
</config>
`,
  );
  zip.file(
    "css/custom.css",
    "@import url(\"https://fonts.example.test/inter.css\");\nbody { font-family: Inter, sans-serif; }\n",
  );
  for (let index = 1; index <= 54; index += 1) {
    zip.file(`views/subviews/custom/part_${String(index).padStart(2, "0")}.twig`, `{# part ${index} #}\n`);
  }
  // 56 files plus the folders css/, views/, views/subviews/ and views/subviews/custom/.
  assert.equal(Object.keys(zip.files).length, 60);

  const validation = await validate("vanilla_like-1.0.0-ls7.zip", zip);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
  const policy = validation.warnings.filter((warning) => warning.startsWith("policy:"));
  const has = (check: (warning: string) => boolean, label: string) =>
    assert.ok(policy.some(check), `${label}: ${JSON.stringify(validation.warnings)}`);
  has((warning) => warning.includes("css/mcp-theme.css"), "missing css/mcp-theme.css");
  has((warning) => warning.includes("LICENSE.txt"), "missing LICENSE.txt");
  has((warning) => /GPL|General Public License/i.test(warning), "missing GPL license");
  has((warning) => /\b50\b/.test(warning) && /entries/i.test(warning), "more than 50 entries");
  has((warning) => warning.includes("css/custom.css") && /@import|external|url/i.test(warning), "external @import");
});

test("[THEME-9] validate reports missing small-screen rules as a policy warning", async () => {
  const validation = await validate(
    "no_breakpoint-1.0.0-ls7.zip",
    themePackage("no_breakpoint-100-ls7", {
      css: ":focus-visible { outline: 3px solid #005FCC; }\n"
        + "@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }\n",
    }),
  );
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
  assert.ok(
    validation.warnings.some((warning) => warning.startsWith("policy:") && /small-screen|575/i.test(warning)),
    JSON.stringify(validation.warnings),
  );
});

test("[THEME-9] validate keeps an archive path that leaves the theme folder an error", async () => {
  const zip = themePackage("evil_path-100-ls7");
  zip.file("../evil.css", "body { color: red; }\n", { createFolders: false });
  const validation = await validate("evil_path-1.0.0-ls7.zip", zip);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("../evil.css")), JSON.stringify(validation.errors));
});

test("[THEME-9] validate rejects a metadata/title longer than 100 characters", async () => {
  const validation = await validate("long_title-1.0.0-ls7.zip", themePackage("long_title-100-ls7", { title: "T".repeat(101) }));
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => /title/.test(error) && error.includes("100")),
    JSON.stringify(validation.errors),
  );
});

test("[THEME-9] validate rejects a theme without parent and engine, and warns about a standalone theme", async () => {
  const bare = await validate("bare_theme-1.0.0-ls7.zip", themePackage("bare_theme-100-ls7", { parent: null }));
  assert.equal(bare.valid, false);
  assert.ok(bare.errors.some((error) => /extends/.test(error) && /engine/.test(error)), JSON.stringify(bare.errors));

  const standalone = await validate(
    "standalone-1.0.0-ls7.zip",
    themePackage("standalone-100-ls7", { parent: null, engine: true }),
  );
  assert.deepEqual(standalone.errors, []);
  assert.equal(standalone.valid, true);
  assert.ok(
    standalone.warnings.some((warning) => warning.startsWith("policy:") && /no parent/i.test(warning)),
    JSON.stringify(standalone.warnings),
  );
});

test("[THEME-9] validate rejects a compatibility list with only versions below 6", async () => {
  const validation = await validate("old_compat-1.0.0-ls7.zip", themePackage("old_compat-100-ls7", { compatibility: ["5.0"] }));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => /compatibility/i.test(error)), JSON.stringify(validation.errors));
});

test("[THEME-9] validate rejects characters LimeSurvey refuses in the installed name", async () => {
  // LimeSurvey keeps "%" when it derives the folder name and then refuses it (Template.php:51).
  const validation = await validate("bad%name-1.0.0-ls7.zip", themePackage("bad%name-100-ls7"));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("bad%name-100-ls7")), JSON.stringify(validation.errors));
});

test("[THEME-9] validate rejects views/ that only holds files the import skips", async () => {
  const zip = themePackage("skipped_views-100-ls7", { views: {} });
  zip.file("views/x.html", "<p>x</p>\n", { createFolders: false });
  const validation = await validate("skipped_views-1.0.0-ls7.zip", zip);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("views/ directory")), JSON.stringify(validation.errors));
});

test("[THEME-9] validate warns about a missing 7.x compatibility entry except in a package marked -ls6", async () => {
  const missing7 = (warning: string) => warning.startsWith("policy:") && /7\.x/.test(warning);
  const ls7 = await validate("six_only-1.0.0-ls7.zip", themePackage("six_only-100-ls7", { compatibility: ["6.0"] }));
  assert.equal(ls7.valid, true, JSON.stringify(ls7.errors));
  assert.ok(ls7.warnings.some(missing7), JSON.stringify(ls7.warnings));

  const ls6 = await validate("six_only-1.0.0-ls6.zip", themePackage("six_only-100-ls6", { compatibility: ["6.0"] }));
  assert.equal(ls6.valid, true, JSON.stringify(ls6.errors));
  assert.equal(ls6.warnings.some(missing7), false, JSON.stringify(ls6.warnings));
});

test("[THEME-9] validate stops at more than 1000 entries without reading config.xml", async () => {
  const zip = new JSZip();
  // Not well-formed: reading it would add a second error.
  zip.file("config.xml", "<config><metadata><title>Broken & unclosed", { createFolders: false });
  for (let index = 0; index < 1000; index += 1) {
    zip.file(`files/n${String(index).padStart(4, "0")}.txt`, "x", { createFolders: false });
  }
  assert.equal(Object.keys(zip.files).length, 1001);
  const validation = await validate("many_entries-1.0.0-ls7.zip", zip);
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.length, 1, JSON.stringify(validation.errors));
  assert.match(validation.errors[0] ?? "", /1000/);
});

test("[THEME-9] validate reports only the oversized entry and decompresses nothing before the size check", async () => {
  const limit = 64 * 1024;
  const zip = themePackage("big_entry-100-ls7", { files: { "files/fake.png": "not a png\n" } });
  zip.file("files/big.txt", `BIGDATA${"x".repeat(limit + 1 - "BIGDATA".length)}`);
  // Stored without compression; one changed byte breaks the CRC-32 the ZIP declares for files/big.txt, so decompressing
  // (or checking) that entry before the size check would fail the whole validation.
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const marker = archive.indexOf("BIGDATA");
  assert.ok(marker > 0);
  archive[marker + "BIGDATA".length] = "y".charCodeAt(0);

  const validation = await validate("big_entry-1.0.0-ls7.zip", archive, { maxThemeAssetBytes: limit });
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.length, 1, JSON.stringify(validation.errors));
  assert.ok(validation.errors[0]?.includes("files/big.txt"), JSON.stringify(validation.errors));
});

test("[THEME-9] validate rejects a config.xml that is not well-formed", async () => {
  // An unescaped "&" makes the XML not well-formed; LimeSurvey cannot load such a manifest.
  const validation = await validate("bad_xml-1.0.0-ls7.zip", themePackage("bad_xml-100-ls7", { title: "Feedback & Survey" }));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("config.xml")), JSON.stringify(validation.errors));
});

test("[THEME-9] validate reports .twig templates as a policy warning", async () => {
  const validation = await validate(
    "twig_theme-1.0.0-ls7.zip",
    themePackage("twig_theme-100-ls7", {
      views: { "views/README.txt": "Inherited views.\n", "views/layout_global.twig": "{# override #}\n" },
    }),
  );
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
  assert.ok(
    validation.warnings.some((warning) => warning.startsWith("policy:") && warning.includes("views/layout_global.twig")),
    JSON.stringify(validation.warnings),
  );
});

test("[THEME-9] validate prefixes the reduced-motion and focus rules with policy:", async () => {
  const validation = await validate(
    "plain_css-1.0.0-ls7.zip",
    themePackage("plain_css-100-ls7", { css: "@media (max-width: 575.98px) { body { color: #111111; } }\n" }),
  );
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  for (const rule of [/reduced-motion/i, /focus/i]) {
    assert.ok(
      validation.warnings.some((warning) => warning.startsWith("policy:") && rule.test(warning)),
      `${rule}: ${JSON.stringify(validation.warnings)}`,
    );
  }
});

test("[THEME-9] validate checks the JPEG signature at the start only", async () => {
  // Valid start of a JPEG (SOI + APP0 marker); the end-of-image marker is followed by padding bytes.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(16),
    Buffer.from([0xff, 0xd9]),
    Buffer.alloc(4),
  ]);
  const validation = await validate("jpeg_theme-1.0.0-ls7.zip", themePackage("jpeg_theme-100-ls7", { files: { "files/photo.jpg": jpeg } }));
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// publication guide
// ---------------------------------------------------------------------------------------------------------------------

test("[THEME-9] the publication guide names the installed theme name and the import path through the theme list", async () => {
  const current = await session();
  try {
    const response = await current.client.callTool({
      name: "limesurvey_get_theme_publication_guide",
      arguments: {
        theme_name: "weit_feedback",
        package_file_name: "weit_feedback-1.0.0-ls7.zip",
        installed_limesurvey_version: "7.5.1",
        hosting: "self_hosted",
      },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const guide = result(response.structuredContent);
    assert.equal(guide.installed_theme_name, "weit_feedback-100-ls7");
    const steps = JSON.stringify(guide.steps);
    assert.match(steps, /weit_feedback-100-ls7/);
    // Do not rename the ZIP: LimeSurvey takes the theme name from the uploaded file name.
    assert.match(steps, /rename/i);
    // The replacement upload form after a failed import has no theme field and always fails with this message.
    assert.match(steps, /This theme type \(''\) is not allowed/);
    assert.equal(current.requests.length, 0);
  } finally {
    await current.close();
  }
});

async function guideFor(packageFileName: string): Promise<Record<string, unknown>> {
  const current = await session();
  try {
    const response = await current.client.callTool({
      name: "limesurvey_get_theme_publication_guide",
      arguments: {
        theme_name: "weit_feedback",
        package_file_name: packageFileName,
        installed_limesurvey_version: "7.5.1",
        hosting: "self_hosted",
      },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    return result(response.structuredContent);
  } finally {
    await current.close();
  }
}

test("[THEME-9] the publication guide asks to review every policy: warning before the import", async () => {
  const guide = await guideFor("weit_feedback-1.0.0-ls7.zip");
  const steps = guide.steps as unknown[];
  const first = String(steps[0]);
  assert.match(first, /valid=true/);
  assert.match(first, /policy:/);
  const stopConditions = guide.stop_conditions as unknown[];
  assert.ok(stopConditions.some((condition) => /policy:/.test(String(condition))), JSON.stringify(stopConditions));
});

test("[THEME-9] the publication guide still returns current_reference.current_ce_release", async () => {
  const guide = await guideFor("weit_feedback-1.0.0-ls7.zip");
  const reference = (guide.current_reference ?? {}) as Record<string, unknown>;
  assert.ok(String(reference.current_ce_release).startsWith("7.5.1"), JSON.stringify(reference));
});
