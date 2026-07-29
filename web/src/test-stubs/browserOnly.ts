/**
 * Stands in for a module that only exists in a browser.
 *
 * `monaco-editor` declares a `module` entry and no `main` or `exports`, so
 * Vite's node resolver finds no entry for it at all and a test that so much as
 * imports a file importing it fails to *collect* — the failure says "Failed to
 * resolve entry for package", which reads like a broken install rather than
 * like a package that was never meant to load outside a browser. Its two web
 * workers, imported through Vite's `?worker` suffix, have no node meaning
 * either.
 *
 * Nothing under test touches monaco's API surface: `monacoSetup.ts` passes the
 * namespace straight to `configureMonacoYaml`, which the tests mock. So one
 * empty stub answers for all three, wired up in `vite.config.ts`'s `test.alias`.
 */
export default class BrowserOnly {}
