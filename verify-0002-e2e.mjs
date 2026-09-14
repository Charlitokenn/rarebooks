/**
 * /check verify 0001+0002 (authenticated pass): real Clerk sign-in on the
 * LIVE instance (E2E_EMAIL / E2E_PASSWORD; the live instance has no magic
 * test code, so a 2FA challenge needs E2E_CODE with the emailed code), then
 * the feature-0001/0002 surface exercised over HTTP through the app's own
 * origin: /api/dashboard READY, /api/db/schema, full Party CRUD with
 * cleanup, /api/subscription/status. E2E_BASE picks the target (deployed app
 * or local dev:web:full).
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'https://app.rarebooks.cc';
const EMAIL = process.env.E2E_EMAIL ?? 'test@gmail.com';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const CODE = process.env.E2E_CODE ?? '';
const MARKER = 'VERIFY-0002-E2E Pty';

function log(...a) { console.log('[e2e]', ...a); }

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const bodyText = () => page.evaluate(() => document.body.innerText);

  await page.goto(BASE + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const id = page.getByRole('textbox', { name: /email|phone|username/i }).first();
  await id.waitFor({ timeout: 30000 });
  await id.fill(EMAIL);
  await page.getByRole('button', { name: /continue/i }).first().click();
  await page.waitForTimeout(2500);

  // password step
  const pw = page.getByLabel(/password/i).first();
  if (await pw.count()) {
    await pw.fill(PASSWORD);
    await page.getByRole('button', { name: /continue|sign in/i }).last().click();
    await page.waitForTimeout(3000);
  }

  // possible 2FA (factor-one / client-trust) challenge: email code.
  // If E2E_CODE is set, use it. Otherwise watch E2E_CODE_FILE (default
  // /tmp/e2e-code.txt): the run stays open, the email arrives, write the
  // 6 digits to that file and the run picks it up and submits.
  if (page.url().includes('factor-one') || page.url().includes('client-trust') || (await bodyText()).includes('Check your email')) {
    log('code challenge reached; url =', page.url());
    const codeInput = page.locator('input[name="code"], input#code__code, input[maxlength="6"], input[inputmode="numeric"]').first();
    await codeInput.waitFor({ timeout: 20000 });
    let code = CODE;
    if (!code) {
      const codeFile = process.env.E2E_CODE_FILE ?? '/tmp/e2e-code.txt';
      log('WAITING_FOR_CODE: paste the emailed 6-digit code into', codeFile);
      for (let waited = 0; waited < 300 && !code; waited += 2) {
        try { code = (await import('fs')).readFileSync(codeFile, 'utf8').trim(); } catch {}
        if (!code) await page.waitForTimeout(2000);
      }
      if (!code) { log('NO_CODE after 5min; aborting run'); await browser.close(); process.exit(3); }
    }
    await codeInput.fill(code);
    await page.getByRole('button', { name: /continue|verify|attempt/i }).last().click();
    await page.waitForTimeout(3500);
    log('after code, url =', page.url());
    log('after code, body =', (await bodyText()).split('\n').filter(Boolean).slice(0, 10).join(' | '));
  }

  // Clerk session task after sign-in: choose an org if shown; otherwise
  // create one through Clerk's own UI (AC-2 provisioning leg).
  await page.waitForTimeout(1500);
  let orgActive = false;
  if (page.url().includes('choose-organization') || page.url().includes('session-tasks')) {
    const orgOption = page.locator('[role="option"], button').filter({ hasText: /verify 0607|spare|test/i }).first();
    if (await orgOption.count()) {
      await orgOption.click();
      await page.waitForTimeout(3000);
      orgActive = true;
      log('selected existing org; url =', page.url());
    }
  }
  if (!orgActive) {
    await page.goto(BASE + '/create-organization', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const nameInput = page.getByLabel(/organization name|name/i).first();
    if (await nameInput.count()) {
      await nameInput.fill('Verify 0607 Test');
      await page.getByRole('button', { name: /^create/i }).last().click();
      await page.waitForTimeout(8000);
      log('created org; url =', page.url());
    } else {
      log('no create-organization form visible; body =', (await bodyText()).split('\n').filter(Boolean).slice(0, 8).join(' | '));
    }
  }

  // ---- the actual checks ----
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  const dash = await page.textContent('body');
  log('dashboard shows welcome shell:', dash.includes('Welcome to RareBooks'));
  await page.screenshot({ path: '/tmp/e2e-dashboard.png' });
  const api = async (path, init) =>
    page.evaluate(
      async ({ p, i }) => {
        const r = await fetch(p, { credentials: 'include', ...i });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      { p: path, i: init ?? null }
    );
  log('GET /api/dashboard ->', JSON.stringify(await api('/api/dashboard')));
  const schemaRes = await api('/api/db/schema');
  log('GET /api/db/schema -> status', schemaRes.status, '| doctypes:', Object.keys(schemaRes.body ?? {}).length, '| hasParty:', !!schemaRes.body?.Party);
  log('GET /api/subscription/status ->', JSON.stringify(await api('/api/subscription/status')));

  const audit = { createdBy: 'e2e@test', modifiedBy: 'e2e@test', created: new Date().toISOString(), modified: new Date().toISOString() };
  const call = (method, args) => api('/api/db/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const out = {};
  out.insert = await call('insert', ['Party', { name: MARKER, role: 'Customer', ...audit }]);
  out.get = await call('get', ['Party', MARKER, ['name', 'role']]);
  out.getAll = await call('getAll', ['Party', { filters: { name: MARKER }, fields: ['name'] }]);
  out.update = await call('update', ['Party', { name: MARKER, email: 'e2e@example.test' }]);
  out.getAfterUpdate = await call('get', ['Party', MARKER, ['email']]);
  out.delete = await call('delete', ['Party', MARKER]);
  out.existsAfterDelete = await call('exists', ['Party', MARKER]);
  out.bespoke = await api('/api/db/bespoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'getLastInserted', args: ['NumberSeries'] }) });
  out.rejectedMethod = await call('migrate', []);
  console.log('[e2e] CRUD:', JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
