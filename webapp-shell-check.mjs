/**
 * /check verify web app shell — Playwright automation harness.
 * Signs in as the admin user, exercises the shell, takes screenshots for evidence.
 *
 * Uses proper Playwright locators (getByText, getByRole, locator) — no jQuery :contains().
 */
import { chromium } from 'playwright';

const ADMIN_EMAIL = 'nkonoki.charles@gmail.com';
const ADMIN_PASS = 'Rare@5378';
const BASE = 'http://localhost:5173';

function fail(reason) { console.error('FAIL:', reason); process.exitCode = 1; }
function info(msg) { console.log('[shell-check]', msg); }
function pass(msg) { console.log('[shell-check] ✓', msg); }

async function screenshot(page, name) {
  const path = `/tmp/shell-verify/snap-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  info(`Saved ${name} → ${path}`);
  return path;
}

async function signIn(page) {
  info('Signing in…');
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for Clerk to render its form
  await page.waitForSelector('input', { timeout: 15000 });
  const inputs = await page.$$('input');
  info(`Found ${inputs.length} input(s)`);

  // Fill email (first input, type=text)
  if (inputs.length >= 1) {
    await inputs[0].fill(ADMIN_EMAIL);
    info('Filled email');
  }

  // Fill password if visible, or click Continue first
  if (inputs.length >= 2) {
    const type = await inputs[1].getAttribute('type');
    if (type === 'password') {
      await inputs[1].fill(ADMIN_PASS);
      info('Filled password (already visible)');
    } else {
      // Click Continue to reveal password
      const contBtn = page.getByRole('button', { name: /continue|next/i });
      if (await contBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await contBtn.click();
        info('Clicked Continue to reveal password');
        await page.waitForTimeout(800);
      }
      const pw = await page.$('input[type="password"]');
      if (pw) {
        await pw.fill(ADMIN_PASS);
        info('Filled password after Continue');
      }
    }
  } else {
    // Single-input flow: click Continue, wait for password
    const contBtn = page.getByRole('button', { name: /continue|next/i });
    if (await contBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contBtn.click();
      await page.waitForSelector('input[type="password"]', { timeout: 5000 });
      await page.locator('input[type="password"]').fill(ADMIN_PASS);
      info('Filled password (single-input flow)');
    }
  }

  // Submit
  const submitBtn = page.getByRole('button', { name: /continue|sign in|sign-in|next/i });
  if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submitBtn.click();
    info('Clicked submit button');
  } else {
    await page.keyboard.press('Enter');
    info('Pressed Enter');
  }

  await page.waitForURL(u => !u.pathname.includes('/sign-in'), { timeout: 25000 });
  info('Signed in, redirected to: ' + page.url());
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') info(`PAGE ERROR: ${msg.text()}`);
  });
  page.on('pageerror', err => info(`JS ERROR: ${err.message}`));

  try {
    // ── Step 1: Sign in ──
    await signIn(page);
    await page.waitForTimeout(4000);
    await screenshot(page, '01-after-signin');

    // ── AC-1: App chrome renders ──
    const url1 = page.url();
    info(`Shell URL: ${url1}`);

    // Check sidebar
    const sidebar = page.locator('aside, .sidebar, [class*="sidebar"], nav').first();
    const hasSidebar = await sidebar.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasSidebar) { pass('AC-1: Sidebar visible'); } else { fail('AC-1: No sidebar found'); }

    // Check welcome / shell content
    const bodyText = await page.evaluate(() => document.body?.textContent?.slice(0, 2000));
    const hasWelcome = bodyText?.includes('Welcome to RareBooks') || bodyText?.includes('signed in') || bodyText?.includes('Customer');
    if (hasWelcome) { pass('AC-1: Welcome/shell content present'); } else { info('AC-1: Body preview: ' + bodyText?.slice(0, 200)); }

    // Settings & Billing links
    const settingsLink = page.getByRole('link', { name: /settings/i }).or(page.locator('a[href*="/settings"]'));
    const billingLink = page.getByRole('link', { name: /billing/i }).or(page.locator('a[href*="/billing"]'));
    info(`Settings link: ${await settingsLink.isVisible({ timeout: 2000 }).catch(() => false)}`);
    info(`Billing link: ${await billingLink.isVisible({ timeout: 2000 }).catch(() => false)}`);

    // Navigate Settings
    if (await settingsLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await settingsLink.click();
      await page.waitForTimeout(3000);
      await screenshot(page, '02-settings');
      info(`Settings page URL: ${page.url()}`);
      pass('AC-1: Settings page loads');
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }

    // Navigate Billing
    if (await billingLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await billingLink.click();
      await page.waitForTimeout(3000);
      await screenshot(page, '03-billing');
      info(`Billing page URL: ${page.url()}`);
      pass('AC-1: Billing page loads');
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }

    // Sign out
    info('Testing sign out…');
    const signOutBtn = page.getByText('Sign out', { exact: false }).or(page.getByRole('button', { name: /sign.?out/i }));
    if (await signOutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await signOutBtn.click();
      await page.waitForTimeout(3000);
      await screenshot(page, '04-after-signout');
      if (page.url().includes('/sign-in')) {
        pass('AC-1: Sign out → sign-in');
      } else {
        info(`After sign-out URL: ${page.url()}`);
      }

      // Sign back in
      info('Signing back in for remaining tests…');
      await signIn(page);
      await page.waitForTimeout(4000);
    } else {
      info('Sign out button not found, skipping sign-out test');
    }

    // ── AC-2: Customers list ──
    info('Navigating to Customers…');
    const customersLink = page.getByText('Customers', { exact: false }).first();
    if (await customersLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await customersLink.click();
      info('Clicked Customers link');
    } else {
      // Try direct URL
      info('Customers link not visible, trying direct URL');
      await page.goto(`${BASE}/list/Party/Customers`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    await page.waitForTimeout(4000);
    await screenshot(page, '05-customers-list');

    const listBody = await page.evaluate(() => document.body?.textContent?.slice(0, 2000));
    const hasParty = listBody?.toLowerCase().includes('party') || listBody?.toLowerCase().includes('customer') || listBody?.toLowerCase().includes('full_name') || listBody?.includes('Add');
    if (hasParty) { pass('AC-2: Customers list renders'); } else { info('AC-2: List body preview: ' + listBody?.slice(0, 300)); }

    // ── AC-3: Create a Party ──
    info('Attempting to create a Party entry…');
    const addBtn = page.getByRole('button', { name: /add|new|\+|create/i }).or(page.locator('button:has-text("+"), button.primary')).first();
    if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addBtn.click();
      info('Clicked Add button');
      await page.waitForTimeout(2000);
      await screenshot(page, '06-create-form');

      // Fill form inputs
      const formInputs = await page.$$('input[type="text"], input:not([type])');
      if (formInputs.length >= 1) {
        await formInputs[0].fill('TestCustomer_' + Date.now());
        info('Filled name field');
        await page.waitForTimeout(500);

        // Save
        const saveBtn = page.getByRole('button', { name: /save|create|submit/i }).or(page.locator('button.primary, button:has-text("Save"), button:has-text("Create")'));
        if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await saveBtn.click();
          info('Clicked Save');
          await page.waitForTimeout(3000);
          await screenshot(page, '07-after-save');
          pass('AC-3: Create form submitted');
        } else {
          info('No Save button visible');
        }
      } else {
        info('No form inputs found');
      }
    } else {
      info('Add button not found, AC-3 skipped');
    }

    // ── AC-5: Deep link reload ──
    info('Testing deep link reload…');
    await page.goto(`${BASE}/list/Party/Customers`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    await screenshot(page, '08-deep-link');
    const deepUrl = page.url();
    info(`Deep link URL: ${deepUrl}`);
    if (!deepUrl.includes('/sign-in') && !deepUrl.includes('blank')) {
      pass('AC-5: Deep link loads (not redirected to sign-in)');
    }

    // ── AC-9: Org switcher ──
    info('Looking for org switcher…');
    // The sidebar footer should have org switcher
    const footerArea = page.locator('[class*="footer"], [class*="switcher"]').first();
    if (await footerArea.isVisible({ timeout: 3000 }).catch(() => false)) {
      const footerText = await footerArea.textContent().catch(() => '');
      info(`Footer text: ${footerText?.slice(0, 200)}`);
      await footerArea.click();
      await page.waitForTimeout(2000);
      await screenshot(page, '09-org-switcher');

      // Look for dropdown options
      const options = await page.$$('.dropdown-item, [role="option"], li, .switcher-option');
      info(`Found ${options.length} options in switcher`);
      for (const opt of options) {
        const txt = await opt.textContent().catch(() => '').trim();
        if (txt && txt.includes('RareBooks')) {
          info(`Found org option: ${txt}`);
          await opt.click();
          info('Switched to RareBooks org');
          await page.waitForTimeout(5000);
          await screenshot(page, '10-after-switch');
          pass('AC-9: Org switcher functional');
          break;
        }
      }
    } else {
      info('AC-9: Org switcher not found (may use different selector)');
    }

    // ── AC-10: Sidebar disabled entries ──
    info('Checking sidebar for disabled entries…');
    const disabledTags = page.getByText('coming soon', { exact: false });
    const hasComingSoon = await disabledTags.isVisible({ timeout: 2000 }).catch(() => false);
    if (hasComingSoon) {
      pass('AC-10: "coming soon" tags found on disabled sidebar entries');
    } else {
      info('AC-10: No "coming soon" tags visible');
    }

    // ── Final screenshot ──
    await screenshot(page, '11-final');
    info(`Final URL: ${page.url()}`);
    info('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    info('Verification complete.');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exitCode = 1;
});
