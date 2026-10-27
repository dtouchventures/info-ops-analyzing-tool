# AIVS browser editions

The same application runs in two browser editions:

| Edition | How it runs | Data | Identity |
|---|---|---|---|
| **No-install** (`AIVS (no install).html`) | Double-click the file (about 12 MB). No Node.js, no internet. Offline text reading in English and Kiswahili. | IndexedDB in that browser on that computer, plus full backup and restore | One local profile with a typed name. Approvals are labelled **local analyst acknowledgements**. |
| **Hosted** (claude.ai artifact) | Open the claude.ai link while signed in | claude.ai shared storage | claude.ai accounts; roles are checked in the page |

The team edition (the Node server in the parent folder) is the only one that enforces roles on a server.

Sources: `local.js` (browser-only platform), `ocr-local.js` (offline OCR: Tesseract.js 5.1.1, its WebAssembly core and English and Kiswahili data embedded; the build fixes one known 5.1.1 bug where language data is passed in directly), `text.js`, `core.js`, `svc.js`, `pages.js`, `workspace.js`, `boot.js` and `app.css`.

To rebuild the no-install file, run `npm install` in the parent folder, then `python build_no_install.py`.

The no-install edition reads text offline (English, Kiswahili or both) and has no cloud AI. The hosted edition has no offline reader, but it can use Claude transcription.
