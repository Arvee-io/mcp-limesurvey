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

async function session(options: { themeDir?: string; responder?: Responder } = {}) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-theme" : (options.responder?.(request) ?? null);
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const config = options.themeDir ? { ...baseConfig, themeDir: options.themeDir } : baseConfig;
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
 * set_survey_properties answers {template: true} like LimeSurvey does even when it silently keeps another theme;
 * get_survey_properties returns `stored` or, without it, the template that was set.
 */
function surveyTemplateResponder(stored?: string): Responder {
  let lastSet: JsonValue = null;
  return (request) => {
    if (request.method === "set_survey_properties") {
      lastSet = (request.params[2] as { template?: JsonValue } | undefined)?.template ?? null;
      return { template: true };
    }
    if (request.method === "get_survey_properties") return { template: stored ?? lastSet };
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
    css?: string;
    views?: Record<string, string>;
    files?: Record<string, string | Buffer>;
  } = {},
): JSZip {
  const title = options.title === undefined ? "LimeSurvey 7 Test Theme" : options.title;
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
    <extends>vanilla</extends>
  </metadata>
  <compatibility>
    <version>7.0</version>
  </compatibility>
  <files>
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

async function validate(fileName: string, zip: JSZip): Promise<Validation> {
  return withThemeDir(async (themeDir) => {
    await writeFile(path.join(themeDir, fileName), await zip.generateAsync({ type: "nodebuffer" }), { mode: 0o600 });
    const current = await session({ themeDir });
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
    assert.match(text, /limesurvey_list_installed_themes/);
    assert.deepEqual(current.methods(), ["set_survey_properties", "get_survey_properties"]);
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
    assert.deepEqual(current.methods(), ["set_survey_properties", "get_survey_properties"]);
    const readBack = current.requests.find((request) => request.method === "get_survey_properties");
    assert.deepEqual(readBack?.params, ["session-theme", 123, ["template"]]);
  } finally {
    await current.close();
  }
});

test("[THEME-9] assign reports THEME_NOT_VERIFIED with written: true when only the read-back fails", async () => {
  const current = await session({
    responder: (request) => {
      if (request.method === "set_survey_properties") return { template: true };
      if (request.method === "get_survey_properties") return { status: "Error: No permission" };
      return null;
    },
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
    assert.deepEqual(current.methods(), ["set_survey_properties", "get_survey_properties"]);
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
