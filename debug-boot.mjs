/**
 * Debug: sign in and check why the shell boot is stuck.
 */
import { chromium } from 'playwright';

const ADMIN_EMAIL = 'nkonoki.charles@gmail.com';
const ADMIN_PASS = 'Rare@5378';
const BASE = 'http://localhost:5173';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' });
const page = await context.newPage();

// Capture ALL console messages
page.on('console', msg => console.log(`[CONSOLE ${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => console.log(`[PAGEERR] ${err.message}`));

// Capture network requests
const requests = [];
page.on('request', r => requests.push({ url: r.url(), method: r.method() }));
page.on('response', r => requests.push({ url: r.url(), status: r.status(), method: r.request().method() }));

console.log('=== Going to /sign-in ===');
await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('input', { timeout: 15000 });

const inputs = await page.$$('input');
console.log(`Inputs found: ${inputs.length}`);
if (inputs[0]) await inputs[0].fill(ADMIN_EMAIL);
if (inputs[1]) {
  const t = await inputs[1].getAttribute('type');
  if (t === 'password') {
    await inputs[1].fill(ADMIN_PASS);
  } else {
    const contBtn = page.getByRole('button', { name: /continue/i });
    if (await contBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contBtn.click();
      await page.waitForTimeout(800);
    }
    const pw = await page.$('input[type="password"]');
    if (pw) await pw.fill(ADMIN_PASS);
  }
}

const submitBtn = page.getByRole('button', { name: /continue|sign in/i });
if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  await submitBtn.click();
}

await page.waitForURL(u => !u.pathname.includes('/sign-in'), { timeout: 25000 });
console.log(`Signed in, URL: ${page.url()}`);

// Wait and check what's happening
await page.waitForTimeout(8000);

console.log('\n=== Page state after sign-in + wait ===');
const bodyHTML = await page.evaluate(() => document.body?.innerHTML?.slice(0, 3000));
console.log('Body HTML (first 3000 chars):', bodyHTML);

const bodyText = await page.evaluate(() => document.body?.textContent?.slice(0, 1000));
console.log('Body text:', bodyText);

// Check shell state via window
const shellState = await page.evaluate(() => {
  try {
    // Try to access the shell state module
    return { window: Object.keys(window).filter(k => k.includes('shell') || k.includes('boot') || k.includes('fyo')).join(', ') };
  } catch { return {}; }
});
console.log('Window keys with shell/boot/fyo:', shellState);

// Check for failed network requests
const failedRequests = requests.filter(r => r.status >= 400 || !r.status);
console.log('\n=== Failed/slow requests ===');
for (const r of failedRequests) console.log(`  ${r.method} ${r.url} -> ${r.status || 'pending'}`);

// Check API responses
const apiReqs = requests.filter(r => r.url.includes('/api/'));
console.log('\n=== API requests ===');
for (const r of apiReqs) console.log(`  ${r.method} ${r.url.split('?')[0].slice(-60)} -> ${r.status || 'pending'}`);

// Check for any error in Vue devtools
const errors = await page.evaluate(() => {
  const errs = [];
  // Check if there are any Vue errors logged
  const originalError = window._debugErrors;
  return { errors: errs };
}).catch(() => ({}));
console.log('Vue errors:', errors);

// Check the router state
const routerState = await page.evaluate(() => {
  const app = document.querySelector('#app');
  return { appExists: !!app, appInner: app?.innerHTML?.slice(0, 500) };
});
console.log('App state:', routerState);

// Take a final screenshot
await page.screenshot({ path: '/tmp/shell-verify/snap-debug.png', fullPage: true });
console.log('\nSaved debug screenshot');

// Wait longer and check again
console.log('\n=== Waiting 15 more seconds... ===');
await page.waitForTimeout(15000);

const bodyText2 = await page.evaluate(() => document.body?.textContent?.slice(0, 1000));
console.log('Body text after extra wait:', bodyText2);

const apiReqs2 = requests.filter(r => r.url.includes('/api/'));
console.log('\n=== All API requests (total: ' + apiReqs2.length + ') ===');
for (const r of apiReqs2) console.log(`  ${r.method} ${r.url.split('?')[0].slice(-60)} -> ${r.status || 'pending'}`);

await page.screenshot({ path: '/tmp/shell-verify/snap-debug2.png', fullPage: true });
console.log('Saved second debug screenshot');

await browser.close();
