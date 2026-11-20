# Contributing to Dustmap

Thanks for helping. Bug reports, translations, ideas and pull requests are all welcome.

## Getting started

You need Windows 10 or 11 and Node.js 22 or newer.

```powershell
npm install
npm run dev
```

`npm run dev` starts Vite with hot reload and Electron pointed at it. See the README for the other scripts.

## Before you open a pull request

```powershell
npm run typecheck
npm test
```

- Keep pull requests focused: one fix or feature per PR.
- Describe what changed and how you tested it. Screenshots help for UI changes.
- Write commit messages in the imperative mood (“Add Spanish plural forms”, not “Added…”).

## Testing without risking real files

Never try cleanup or deletion flows on your real files. Use the demo drive instead:

- `npm start -- --demo` opens Electron with a synthetic drive.
- In a browser, open the Vite URL from `npm run dev` with `?scan=C:\`. The in-browser demo backend uses the same engine query code, so layouts and numbers behave like the desktop app.

Turbo mode reads the raw volume and needs administrator rights. Check it from an administrator terminal with `npm run bench -- C:\ --mft`. `npm test` covers the MFT parser without admin rights.

## Adding a language

1. Copy `src/renderer/lib/locales/es.ts` to a new file, for example `de.ts`, and translate every string. TypeScript reports missing keys.
2. Register it in `src/renderer/lib/i18n.ts`: add it to `dicts`, `LANG_NAMES` and `detectLang()`.
3. Add size units for it in `src/renderer/lib/format.ts`.
4. Add the matching Chromium locale to `build.electronLanguages` in `package.json`, for example `de`.
5. Check that nothing gets cut off: open each tab and the settings dialog in the new language.

## Project principles

- **Safety first.** Deletion goes to the Recycle Bin by default, protected paths are enforced in the main process (`protectedReason` in `src/main/main.ts`), and every destructive action is confirmed with its total size.
- **Light on resources.** Animations stop when idle, the engine process is released when not needed, and the tree stays in typed arrays. Measure memory and CPU before and after performance-sensitive changes.
- **Private.** No telemetry and no network calls.
- **Accessible.** Every control needs a label, keyboard support and visible focus.

## Project layout

See “How it works” in the [README](README.md#how-it-works).
