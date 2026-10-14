# Survey Themes with the MCP Server

## Supported baseline

The implementation was last verified on October 14, 2026 against LimeSurvey CE
7.5.1: a generated package was imported with **Upload & install** in the theme
list, installed as `<theme_name>-<theme_version without dots>-ls7`, assigned
to a survey with that name (read-back `verified: true`), and rendered with
`css/mcp-theme.css` loaded.

Earlier checks: July 22, 2026 against LimeSurvey CE 7.0.5, and July 24, 2026
against the official `vanilla` 3.0.1 ("Bootstrap Vanilla") manifest, the
minimal official base theme shipped and installed with every LimeSurvey
instance. Generated themes extend `vanilla` instead of `fruity_twentythree` so
they no longer depend on `fruity_twentythree` being installed. The core theme
uses Bootstrap 5 in LimeSurvey 6 and 7 and declares compatibility with both
major versions.

LimeSurvey publishes frequent patch releases. Before every installation, compare
the version shown in the lower-right corner of the administration interface with:

- https://community.limesurvey.org/downloads/
- https://www.limesurvey.org/manual/Extension_compatibility

The generator writes `7.0` to `config.xml` by default. For an existing 6.x
installation, set `target_limesurvey_major` explicitly to `6`.

## Configuration

```text
LIMESURVEY_THEME_DIR=C:/limesurvey-mcp/themes
LIMESURVEY_MAX_THEME_ASSET_BYTES=5242880
LIMESURVEY_WRITE_SCOPE=content
```

Theme generation, validation, and the publication guide work under every write
scope (they only write into `LIMESURVEY_THEME_DIR`), including read-only mode;
`limesurvey_assign_survey_theme` changes a survey and needs
`LIMESURVEY_WRITE_SCOPE=content` or higher.

The MCP process only needs write access to `LIMESURVEY_THEME_DIR`; it does not
need direct access to the LimeSurvey filesystem. Docker uses the
`limesurvey_themes` volume.

## Generate a theme

Tool: `limesurvey_generate_survey_theme`

```json
{
  "theme_name": "weit_feedback",
  "title": "WEIT Feedback",
  "description": "Responsive feedback theme",
  "author": "Wagner-Emden IT Services",
  "theme_version": "1.0.0",
  "target_limesurvey_major": "7",
  "primary_color": "#0B6B57",
  "accent_color": "#C84B31",
  "background_color": "#F5F7F6",
  "surface_color": "#FFFFFF",
  "text_color": "#1F2933",
  "muted_text_color": "#52606D",
  "focus_color": "#005FCC",
  "font_style": "system",
  "density": "comfortable",
  "corner_radius_px": 6,
  "content_max_width_px": 960
}
```

The result is a ZIP containing `config.xml` at the archive root,
`css/mcp-theme.css`, `LICENSE.txt`, and `views/README.txt` (LimeSurvey 7 needs
the theme's own `views/` directory even when it overrides no templates). An
optional logo can be supplied as a base64 PNG or JPEG. The generator never adds
SVG or JavaScript because LimeSurvey treats theme imports as an XSS-sensitive
administrator capability.

### Installed theme name

LimeSurvey does not install the theme under `theme_name` or under the
`metadata/name` of `config.xml`. It takes the name of the uploaded ZIP file
without `.zip` and removes every dot. The generator names the ZIP
`<theme_name>-<theme_version>-ls<major>.zip`, so the example above is
installed as `weit_feedback-100-ls7`. The result returns this name as
`installed_theme_name`, and `config.xml` carries the same value as
`metadata/name`.

- Upload the ZIP without renaming it, and assign `installed_theme_name`.
- LimeSurvey allows at most 45 characters. The generator refuses a
  `theme_name` that would exceed this before it writes anything; with
  `theme_version` 1.0.0 the limit is 37 characters for `theme_name`.
- Every version is a separate installed theme (`weit_feedback-110-ls7` after
  `weit_feedback-100-ls7`), so the previous version stays available for
  rollback.
- Because the dots disappear, versions with the same digits collide:
  `1.10.0` and `11.0.0` both install as `weit_feedback-1100-ls7`, and
  LimeSurvey refuses to import a name that is already installed. The generator
  adds a warning when a version component has more than one digit; prefer one
  digit per component or check the theme list before the import.

Generated themes are freely usable under GPL-2.0-or-later. This license is
deliberate because the theme inherits the GPL-licensed `vanilla`.

## Validate before import

Tool: `limesurvey_validate_survey_theme`

```json
{
  "file_name": "weit_feedback-1.0.0-ls7.zip"
}
```

Continue only when `valid=true`: LimeSurvey imports and uses the package. The
result includes `installed_theme_name`, derived from the file name. The rules
follow the import code of LimeSurvey 7.5.1 with its default upload lists.

Errors (`valid=false`) are limited to archive safety and real import
obstacles:

- unsafe ZIP paths (path traversal, absolute paths) and the size limits for
  the archive and each entry;
- image and font content that does not match the extension (PNG, JPEG, GIF,
  ICO, WOFF2, WOFF, TTF, OTF; EOT has no signature to check);
- an installed name longer than 45 characters, or with characters other than
  ASCII letters, digits, `_`, and `-` (LimeSurvey rejects or changes
  `#$%^&*()+=[]';,./{}|:<>?~`);
- files the import would skip silently, leaving a "Partial import": every
  type outside `css js map json eot otf ttf woff woff2 txt md xml twig lss lsa
  lsq lsg gif ico jpg jpeg png`, for example `.html` (also in `views/`),
  `.svg`, `.php`, or `.gitkeep`;
- a missing or overlong (over 100 characters) `metadata/title`, or a missing
  `views/` directory;
- `config.xml` not at the archive root;
- a theme with neither `metadata/extends` nor an `engine` section, and a
  compatibility list that names only versions below 6 (LimeSurvey 7
  uninstalls such a theme).

Allowed without a finding: web fonts (`woff2 woff ttf otf eot`), `txt` and `md`
files anywhere, `gif` and `ico` images, and subfolders in `css/` and `files/`.

Warnings starting with `policy:` mark what LimeSurvey accepts but the generator
never produces. They do not affect `valid`; review them before the import:

- JavaScript, source maps, JSON, XML other than `config.xml`, survey exports,
  and files without an extension;
- a missing `css/mcp-theme.css` or `LICENSE.txt`, a license other than the GNU
  General Public License, and more than 50 entries;
- `@import`, JavaScript expressions, and embedded or external URLs in any CSS
  file (participants' browsers load what they reference), and CSS files over
  200,000 characters;
- missing responsive small-screen rules, checked in `css/mcp-theme.css` or, when
  it is missing, in all CSS files together;
- a parent other than `vanilla` (it must be installed on the target instance),
  or no parent but an `engine` section (a standalone theme; the validator does
  not check that `views/` holds every template);
- `metadata/type` other than `theme`, and a `metadata/name` that differs from
  the installed name (LimeSurvey ignores both);
- no 7.x compatibility entry in a package that is not marked `-ls6`.

LimeSurvey instances can change the allowed upload lists in `config.php`; the
validator uses the defaults.

## Request installation instructions

Tool: `limesurvey_get_theme_publication_guide`

```json
{
  "theme_name": "weit_feedback",
  "package_file_name": "weit_feedback-1.0.0-ls7.zip",
  "installed_limesurvey_version": "7.5.1",
  "hosting": "self_hosted",
  "publication_scope": "instance"
}
```

The tool compares the package major with the installed version and returns the
`installed_theme_name` of the package, stop conditions, acceptance checks,
Cloud guidance, and rollback steps. Set `publication_scope=community` for
public distribution guidance.

## Import into LimeSurvey

1. Sign in with a trusted account that has the global Templates import permission.
2. Open **Configuration > Advanced > Themes**.
3. Select **Survey themes** and start **Upload & install** (Import) in this
   theme list.
4. Choose the validated ZIP from `LIMESURVEY_THEME_DIR` without renaming it.
5. Confirm that the theme appears as `installed_theme_name` and that `vanilla`
   is recognized as the installed parent theme.
6. Preview welcome, question, completion, token, error, print-answer, and
   public-statistics screens in the Theme Editor.

Import only through the theme list. After a failed import LimeSurvey shows a
replacement upload form that does not send the theme type; every upload there
fails with "This theme type ('') is not allowed." (the empty type may also show
as `""`), whatever the ZIP contains. Go back to the theme list instead.

A failed import can leave the theme folder behind, and the next upload of the
same file then stops because the theme already exists. Delete the leftover
theme under **Available survey themes** or **Broken survey themes** (needs the
global Templates delete permission) before trying again.

If LimeSurvey Cloud does not show the import control, do not attempt unofficial
filesystem installation. Confirm custom-theme availability for the account or
plan with LimeSurvey support.

## Assign to a test survey

Tool: `limesurvey_assign_survey_theme`

```json
{
  "survey_id": 123456,
  "theme_name": "weit_feedback-100-ls7",
  "confirm_theme_assignment": true
}
```

`theme_name` is the installed name. LimeSurvey answers `{"template": true}` even
when it keeps another theme: a theme that is not installed under this name, not
readable for the RemoteControl account, or incompatible is silently replaced by
the previous or the default theme. The tool therefore reads the `template`
property back. A match returns `verified: true`; a different value fails with
`THEME_NOT_APPLIED`, naming the requested and the stored theme. If only the
read-back fails, the tool answers `THEME_NOT_VERIFIED` with `written: true`:
check the template in the admin interface or with
`limesurvey_get_survey_properties` instead of repeating the call. The value
`inherit` is refused; choose **Inherit** as the theme in the survey's general
settings in the admin interface instead. Then open the survey as a participant
in every configured language. Assign it to a production survey only after
review.

## Acceptance and rollback

At minimum, test:

- phone, tablet, desktop, and 200 percent browser zoom;
- keyboard navigation and clearly visible focus;
- required-field and other validation errors;
- long labels, matrix questions, and file uploads;
- right-to-left languages when applicable;
- reduced motion and print output;
- privacy, token, quota, and completion pages.

Record the previous theme name before deployment. LimeSurvey does not overwrite
an installed theme with a new upload; a new version is a new package with its
own installed name (mind versions with the same digits, see
[Installed theme name](#installed-theme-name)). Roll back by assigning the previous installed theme with
`limesurvey_assign_survey_theme`; the new package does not need to be deleted.
