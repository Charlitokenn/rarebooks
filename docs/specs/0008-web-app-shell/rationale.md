# 0008 rationale: web app shell (desktop UI on web)

_Decision history for spec 0008, split from index.md when /develop promoted the spec to a directory. The build contract (Requirements, Decision, Feature design, Build plan, Consequences, Follow-up) lives in [index.md](index.md)._
## Context


The web platform (specs 0001, 0002, 0003) gives the browser app a signed-in identity, a per-organization tenant database, and a worker API that mirrors every database method the desktop app uses (`GET /api/db/schema`, `POST /api/db/call`, `POST /api/db/bespoke`). `src/web/boot.ts` already boots a web `fyo` (the app object holding db, schema, and model registry) against a tenant for the standalone Settings page, so the plumbing beneath a full UI exists. What does not exist is the app itself: `rendererWeb.ts` mounts a bare router with no desktop chrome, and the code comments there record exactly why (see `rendererWeb.ts` docblock).

Two forces shape the design. First, the desktop UI was never split for the browser: `src/renderer.ts` needs Electron's `ipc` global, and 49 files under `src/` import the desktop singleton from `src/initFyo` (a module that constructs it with `isElectron: true`); `src/utils/language.ts` imports it at module top level too, which crashes the web build on import, as `rendererWeb.ts` documents. The same applies to a second shared module path: `src/utils/ui.ts` and `Sidebar.vue` import `src/router` directly, and that module eagerly constructs the desktop router with every desktop page imported (POS, PrintView, ImportWizard included). The chrome also relies on Vue provides that `src/App.vue` sets up today (shortcuts, searcher, language direction, registered keys), so mounting chrome without App.vue means replicating its provider setup. Second, scope feature 14 (this one) exists because feature 11's Settings work assumes a shell to expose itself in, and because the team wants the real UI browsable in a browser soon. The build approach is Tracer Bullet: one thin vertical thread, shell plus Customer, through every layer, working end to end before the next doctype starts.

The consequence of not deciding: every later web feature (other doctypes, reports, POS, the admin review page) would re-solve "how does desktop chrome run in a browser" on its own, and the web UI drifts into a second implementation that diverges from desktop.

## Options considered


### Option 1: Build-time module alias swap

The web Vite config resolves the import path `src/initFyo` to a web variant that exports the same `fyo` symbol, constructed with `isElectron: false`. The 49 desktop importers are never touched; the desktop bundle never sees the alias. A small shared module (say `src/createFyo.ts`) holds the construction so the two entry files stay one line wrappers.

**Pros**:
- Zero edits at the 49 import sites, so this scales to every future desktop page mounted on web.
- The desktop bundle is physically unchanged: no runtime guards on the boot path, near-zero desktop regression surface from the mechanism itself.
- Matches what `vite.config.web.ts` already does: it aliases the path roots (`fyo`, `src`, `models`) for the web build, so one more entry is the established pattern, not a new kind of trick.

**Cons**:
- A build-time swap is invisible at the import site: a reader (or an editor without the web config loaded) sees one module resolving to two, which is exactly how alias bugs get shipped.
- Vite string aliases match by prefix, so the entry must be ordered before the broad `src` alias, and any future path move silently un-aliases it.

### Option 2: Guard the shared module at runtime

`src/initFyo.ts` checks for the Electron globals instead of assuming them, and the web entry sets the instance at boot before importing chrome.

**Pros**:
- No build configuration; one module, honest to readers and to the editor.

**Cons**:
- The desktop boot path carries defensive branches forever.
- Does not by itself fix `src/utils/language.ts` or the other eager top-level side effects; each still needs editing.

### Option 3: Full dependency injection refactor

Refactor the importers to receive the app object through Vue provide and inject (a standard Vue mechanism for passing shared objects down the tree) instead of a module import.

**Pros**:
- The clean end state: one tree, no build trickery, no global.

**Cons**:
- A 49-file diff across the whole desktop UI, for a slice whose goal is a working thread. High desktop regression risk now, and it reopens a settled file layout mid-migration.

### Option 4: Copy the chrome into a web-only tree

Duplicate sidebar, list, and form components under `src/pages/web/` and adapt them there.

**Pros**:
- Fastest first demo; desktop tree untouched.

**Cons**:
- Two implementations guaranteed to drift, which directly contradicts feature 14's "same shared components" intent, and every future view pays the copy tax twice.

## Rationale


The load-bearing fact is uniformity: all 49 importers use one module specifier, so one alias resolves all of them with no edits, which is the smallest possible desktop regression surface for the mechanism (AC-7). Option 3 is the principled end state, but spending a 49-file diff on the slice that only has to prove one vertical thread is backwards for a Tracer Bullet; this spec records it as the direction a later refactor can take, not as this build. Option 2 looks cheaper than Option 1 but edits the shared boot path and still leaves language.ts and the eager router to fix, so it carries more desktop risk while solving less. Option 4 was rejected for the reason feature 14's own wording gives.

The alias alone is not sufficient: `rendererWeb.ts` documents that `src/utils/language.ts` crashes on import in the web build (a top-level import of the desktop singleton). Option 1 makes that import resolve, but the language loader's IPC calls still need the refactor its own comments call for (pass `fyo` in as a parameter, no top-level singleton import, per the `AGENTS.md` models rule), so that refactor is in this spec, not deferred (AC-8).

