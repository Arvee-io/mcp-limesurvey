# Installation and Updates

This guide installs `limesurvey-mcp-server` as a local stdio MCP server. Use
Streamable HTTP only when a central service is required.

## Requirements

- Node.js 20 or newer
- A reachable LimeSurvey installation with JSON-RPC enabled under
  **Configuration > Global settings > Interfaces**
- A dedicated LimeSurvey account with only the permissions required by the
  intended tools
- The exact RemoteControl endpoint, normally:
  `https://survey.example.com/index.php/admin/remotecontrol`

Start with `LIMESURVEY_WRITE_SCOPE=none` (equivalent to `LIMESURVEY_READ_ONLY=true`)
to verify the connection and the visible surveys. For building and correcting
surveys, switch to `LIMESURVEY_WRITE_SCOPE=content`: it allows imports,
creating and editing survey content, and theme assignment, but not activation,
deletion, participants, responses, or email (importing a `.lsa` archive, which
activates the survey and brings participants and responses, needs `outreach`). Raise the scope further only when
those actions are intended (`lifecycle`, then `outreach`); the full tool
list per scope is in the README section *Write Safety*.

## Codex CLI

Register the npm package:

```powershell
$remoteControlUrl = "https://survey.example.com/index.php/admin/remotecontrol"
codex mcp add limesurvey `
  --env "LIMESURVEY_URL=$remoteControlUrl" `
  --env "LIMESURVEY_USERNAME=rpc-user" `
  --env "LIMESURVEY_PASSWORD=replace-me" `
  --env "LIMESURVEY_AUTH_PLUGIN=Authdb" `
  --env "LIMESURVEY_WRITE_SCOPE=none" `
  --env "LIMESURVEY_EXPORT_DIR=C:/limesurvey-mcp/exports" `
  --env "LIMESURVEY_THEME_DIR=C:/limesurvey-mcp/themes" `
  -- npx -y limesurvey-mcp-server@latest
```

The command stores the environment values in the Codex MCP configuration.
Protect that configuration as a secret-bearing file and use a dedicated service
account password.

Restart Codex after adding or changing an MCP server. Confirm registration:

```powershell
codex mcp get limesurvey
codex mcp list
```

## Claude Desktop and JSON MCP Clients

Clients that support the common `mcpServers` format can use:

```json
{
  "mcpServers": {
    "limesurvey": {
      "command": "npx",
      "args": ["-y", "limesurvey-mcp-server@latest"],
      "env": {
        "LIMESURVEY_URL": "https://survey.example.com/index.php/admin/remotecontrol",
        "LIMESURVEY_USERNAME": "rpc-user",
        "LIMESURVEY_PASSWORD": "replace-me",
        "LIMESURVEY_AUTH_PLUGIN": "Authdb",
        "LIMESURVEY_WRITE_SCOPE": "none",
        "LIMESURVEY_EXPORT_DIR": "C:/limesurvey-mcp/exports",
        "LIMESURVEY_THEME_DIR": "C:/limesurvey-mcp/themes"
      }
    }
  }
}
```

Use absolute paths. On Windows, either use forward slashes as shown or escape
backslashes in JSON.

## Store the password in a file

Instead of `LIMESURVEY_PASSWORD` in the client configuration, set
`LIMESURVEY_PASSWORD_FILE` to a file that contains only the password. Never
type the password as a literal into a command line: it would stay in the
PowerShell history or the shell history. The commands below ask for it instead.

Windows (PowerShell 7):

```powershell
$passwordFile = Join-Path $env:USERPROFILE ".limesurvey-mcp\password.txt"
New-Item -ItemType Directory -Force (Split-Path $passwordFile) | Out-Null
$secure = Read-Host "LimeSurvey service account password" -AsSecureString
$plain = [System.Net.NetworkCredential]::new("", $secure).Password
[IO.File]::WriteAllText($passwordFile, $plain, [Text.UTF8Encoding]::new($false))
$plain = $null
icacls $passwordFile /inheritance:r /grant:r "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):(R,W)"
```

`icacls` removes the inherited permissions and leaves read and write access to
the current user only; the result lists `<domain>\<user>:(R,W)`. Do not create
the file with `>` or `Out-File` in Windows PowerShell 5.1: it writes UTF-16 (the
first bytes are `FF FE`), and the server rejects such a file with a message that
names UTF-16 and the fix.

Linux and macOS:

```bash
umask 077
mkdir -p ~/.limesurvey-mcp
read -rs -p "LimeSurvey service account password: " lime_pw; echo
printf '%s' "$lime_pw" > ~/.limesurvey-mcp/password.txt
unset lime_pw
chmod 600 ~/.limesurvey-mcp/password.txt
```

Then set `LIMESURVEY_PASSWORD_FILE` to the absolute path of the file (forward
slashes work on Windows, for example `C:/Users/<you>/.limesurvey-mcp/password.txt`)
and **remove `LIMESURVEY_PASSWORD` from the MCP client configuration**. If both
are set, the file wins, `LIMESURVEY_PASSWORD` is ignored, and the server prints a
start-up warning that names both variables (never their values). Only a UTF-8
BOM and the trailing line ending are removed; blanks inside or around the
password stay part of it. `limesurvey_get_instance_info` shows
`password_source: "file"` (without path or content). On POSIX systems the server
also warns when the file is readable by group or others. In Docker, mount the
file read-only and give the path inside the container.

## Global npm Installation

A global installation avoids an `npx` package lookup at every MCP process
start:

```bash
npm install --global limesurvey-mcp-server@latest
limesurvey-mcp
```

The binary still requires the LimeSurvey environment variables. Configure the
MCP client to run `limesurvey-mcp` and inject them there.

A global installation also takes precedence over the registry for every
`npx -y limesurvey-mcp-server@...` call on the same machine. Once it exists,
update it explicitly with every release; `@latest` in an `npx` command will not
do it.

## Install from Source

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
git checkout v1.4.0
npm ci
npm test
```

Configure the MCP client to run Node.js with the absolute path to
`dist/src/index.js`.

## Docker and Streamable HTTP

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
git checkout v1.4.0
cp .env.example .env
docker compose up --build -d
```

The supplied Compose configuration binds to `127.0.0.1:3000`, enables
read-only mode, and exposes:

- MCP: `http://127.0.0.1:3000/mcp`
- Health: `http://127.0.0.1:3000/health`

Set a long random `MCP_HTTP_BEARER_TOKEN` before using a non-loopback binding.
Terminate TLS at a reverse proxy and configure exact Host and Origin allowlists.

## Verify the Installation

After restarting the MCP client:

1. Call `limesurvey_get_session_key`; expect `status: connected`.
2. Call `limesurvey_list_surveys`; confirm only expected surveys are visible.
3. Call `limesurvey_list_survey_groups`.
4. Keep `LIMESURVEY_WRITE_SCOPE=none` until these checks pass, then raise it to
   `content` for building surveys.

For source installations, run the mocked test suite and inspect package
contents:

```bash
npm test
npm pack --dry-run
```

The guarded live suite covers all 73 tools. It creates and deletes prefixed
test records and must only be used on an approved test instance. See
[Live Integration Testing](LIVE_TESTING.md).

## Update

An `npx` installation on `@latest` picks up a new release at the next MCP
process start; restart the client fully. For a pinned `npx` installation,
change the version in the MCP configuration and restart:

```text
limesurvey-mcp-server@1.4.0
```

For a global installation:

```bash
npm install --global limesurvey-mcp-server@latest
```

Run this global update even when the MCP client is configured with
`npx -y ... @latest`: `npx` resolves to the global installation first, so an
outdated global package silently keeps serving the old version.

For a source installation:

```bash
git fetch --tags
git checkout v1.4.0
npm ci
npm test
```

Review the [Changelog](../CHANGELOG.md) before enabling writes after an update.

## Remove

Codex CLI:

```powershell
codex mcp remove limesurvey
```

Global npm package:

```bash
npm uninstall --global limesurvey-mcp-server
```

Remove stored MCP credentials and generated export or theme directories
separately according to the local retention policy.

## Troubleshooting

The server contacts LimeSurvey lazily: the session key is fetched on the first
tool call, not at startup. A client-side `Failed to connect` therefore means the
process never started, and never means wrong credentials or an unreachable
instance — those surface as a failing tool call instead.

### The MCP client reports `Failed to connect`

1. **Check Node.js:** `node -v` must report 20 or newer.
2. **Check for a broken global installation**, a known cause when the package
   worked before and stopped after a release:

   ```bash
   npm ls -g limesurvey-mcp-server --depth=0
   ```

   An entry without a version number (`limesurvey-mcp-server@`) or a
   `MODULE_NOT_FOUND` for `dist/src/index.js` means the global package is
   corrupt. Because `npx -y` resolves to a global installation before the
   registry, a broken one breaks `npx` too, regardless of the requested
   version. Repair it:

   ```bash
   npm install --global limesurvey-mcp-server@latest
   ```

   Reconnecting the MCP server is enough after this; the environment is
   unchanged.
3. **Check the required variables.** `LIMESURVEY_URL`,
   `LIMESURVEY_USERNAME`, and one of `LIMESURVEY_PASSWORD` or
   `LIMESURVEY_PASSWORD_FILE` must be present and non-empty, or startup
   aborts. `LIMESURVEY_URL` must be an absolute
   `http`/`https` URL; plain `http` to a non-loopback host additionally
   requires `LIMESURVEY_ALLOW_INSECURE_HTTP=true`.
4. **Reproduce outside the client** to read the actual error, which an MCP
   client usually hides:

   ```bash
   LIMESURVEY_URL=https://survey.example.com/index.php/admin/remotecontrol \
   LIMESURVEY_USERNAME=rpc-user LIMESURVEY_PASSWORD=x \
   npx -y limesurvey-mcp-server@latest
   ```

   A server that starts prints its preflight warnings and then waits on stdio.

### Other symptoms

- `Invalid user name or password`: verify the dedicated account, password, and
  `LIMESURVEY_AUTH_PLUGIN`.
- HTML or `404` response: verify the exact `/index.php/admin/remotecontrol`
  endpoint and that JSON-RPC is enabled.
- Write tool blocked (error code `WRITE_SCOPE_INSUFFICIENT`): the message names
  the current scope, the required scope, and the variable that set it. If the
  change is intended, raise `LIMESURVEY_WRITE_SCOPE` (`content` < `lifecycle`
  < `outreach`) and fully restart the MCP client. `LIMESURVEY_READ_ONLY=true`
  equals `none`; if both variables are set, the stricter level wins and a
  startup warning is printed. Do not work around the block with direct
  RemoteControl calls.
- Export or theme workflow unavailable: configure writable absolute
  `LIMESURVEY_EXPORT_DIR` and `LIMESURVEY_THEME_DIR` paths.
- MCP configuration changed but behavior is unchanged: fully restart the MCP
  client so its stdio child process is recreated.
