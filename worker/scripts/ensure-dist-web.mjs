// Ensures ../dist_web exists before `wrangler dev` starts.
//
// wrangler dev validates `assets.directory` on startup even in split-dev
// mode, where Vite (not wrangler) actually serves the frontend via
// vite.config.web.ts's proxy. Without this, a fresh checkout that hasn't
// run `npm run build:web` yet fails with:
//   "The directory specified by the assets.directory field ... does not
//    exist"
//
// This never overwrites a real build — it only creates a placeholder when
// dist_web/index.html is missing.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distWeb = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist_web');
const indexHtml = join(distWeb, 'index.html');

if (!existsSync(indexHtml)) {
  mkdirSync(distWeb, { recursive: true });
  writeFileSync(
    indexHtml,
    '<!doctype html><title>rarebooks-web (dev placeholder)</title>' +
      '<p>Run against the Vite dev server, not this Worker, for the real frontend.</p>'
  );
  console.log(`[ensure-dist-web] created placeholder at ${indexHtml}`);
}
