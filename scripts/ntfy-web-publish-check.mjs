/**
 * Spec 0006 AC-3/AC-4 verification harness: a browser-origin publish to
 * ntfy.sh, from the deployed web app's own origin, observed to ARRIVE.
 *
 * The 2026-09-12 CORS preflight pass proved ntfy.sh *allows* browser
 * publishes; this closes the other half of AC-3 — a message actually
 * landing in the topic's event stream — on evidence, not on the preflight.
 *
 * What it does:
 *  1. Launches Chromium (Playwright) and navigates to the deployed origin
 *     so the page's real origin is that of the hosted app.
 *  2. From that page context, POSTs to https://ntfy.sh/<topic> with the
 *     same headers src/utils/ntfy.ts sends (Markdown/Title/Tags). A CORS
 *     block surfaces as "Failed to fetch"; a pass is the HTTP status.
 *  3. Polls the topic's JSON stream server-side (poll=1&since=all) and
 *     checks the exact message body is in it. That's the arrival proof;
 *     the subscriber side is ntfy's own delivery to whatever app is
 *     subscribed to the topic.
 *
 * AC-4: the topic is random per run (a fresh topic, published to once,
 * never printed anywhere else), mirroring the unguessable-per-org rule.
 *
 * This does NOT replace the in-app path check: the Settings page's
 * "Send test notification" button exercises the real sendNtfyNotification
 * end to end, and /check verify runs that manually. This script is the
 * reproducible origin + arrival half.
 *
 * Usage:
 *   npm run check:ntfy
 *   NTFY_CHECK_ORIGIN=https://other.example npm run check:ntfy
 */
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const ORIGIN = process.env.NTFY_CHECK_ORIGIN ?? 'https://app.rarebooks.cc';
const topic = `rarebooks-web-check-${randomBytes(6).toString('hex')}`;
const message = `RareBooks browser-origin publish check ${new Date().toISOString()}`;

function fail(reason) {
  console.error(`FAIL: ${reason}`);
  process.exitCode = 1;
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  console.log(`Navigating to ${ORIGIN} to publish from its origin…`);
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const origin = new URL(page.url()).origin;
  console.log(`Page origin: ${origin}`);

  // Mirrors src/utils/ntfy.ts's request shape (that file is the code
  // under test; keep the two in sync if its headers change).
  const result = await page.evaluate(async ({ topic, message }) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        body: message,
        headers: {
          'Markdown': 'yes',
          'Title': 'RareBooks AC-3 check',
          'Tags': 'white_check_mark',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }, { topic, message });

  if (!result.ok) {
    fail(
      `publish from browser origin did not succeed: ${JSON.stringify(result)} ` +
        `(a "TypeError: Failed to fetch" is the CORS/network block AC-3 is about)`
    );
  } else {
    console.log(`Browser publish succeeded (HTTP ${result.status}).`);
  }

  // Arrival proof: ntfy's poll endpoint replays recent events, no auth
  // needed on a public topic.
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`);
  if (!res.ok) {
    fail(`could not poll topic (HTTP ${res.status})`);
  } else {
    const body = await res.text();
    const arrived = body
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .some((e) => e?.event === 'message' && e?.message === message);
    if (arrived) {
      console.log(`Message observed in topic "${topic}" event stream. AC-3 evidence: PASS.`);
    } else {
      fail(`publish "succeeded" but the message is not in the topic stream`);
    }
  }
} finally {
  await browser.close();
}

if (!process.exitCode) {
  console.log('AC-3 origin check complete: browser-origin publish observed arriving.');
}
