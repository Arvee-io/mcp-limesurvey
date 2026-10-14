# Test fixtures

Origin of every fixture. None of them contains content copied from the LimeSurvey source tree; they only follow
LimeSurvey's export layout, so they are covered by the MIT license of this repository.

| File | Origin |
|---|---|
| `sample-survey.lss` | Written for the `.lss` comparison tests in LimeSurvey's export layout (DBVersion 640). |
| `replace-question.lsq` | Written for the question replacement tests in LimeSurvey's export layout. |
| `lss-parity/*.spec.json` | Survey descriptions in the spec format. `p01` and `p02` reuse the example specs of the tests of the Python generator (`scripts/lss_tools.py` of the `limesurvey` Claude Code plugin, same rights holder), `p03` the minimal example of its spec reference; `p04` and `p05` were written for the parity test. |
| `lss-parity/*.lss` | Output of that Python generator (plugin 1.2.1, commit `09b7ba6`) for the spec of the same name. They are the reference for the byte parity of the TypeScript port and must not be edited by hand. |
| `lss-parity/manifest.json` | Parity cases: spec, reference `.lss` (absent for types the Python generator cannot produce) and the question types each case covers. |
| `html-unescape-cases.json` | Test cases for the HTML entity decoding: `input`, `python` (the result of `html.unescape` of Python 3.14) and `safe` (the result of a Python reference implementation of the safe rule: decode only references that end with `;` and do not produce `& < > " '`). |

`.gitattributes` marks `lss-parity/` as `-text`, so the files keep their bytes on every platform.
