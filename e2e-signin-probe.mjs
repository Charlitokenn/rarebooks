import { chromium } from 'playwright';
const BASE = process.env.E2E_BASE ?? 'https://app.rarebooks.cc';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const dump = async (label) => {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '(no body)');
  console.log(`\n===== ${label} | url=${page.url()}`);
  console.log(text.split('\n').filter(Boolean).slice(0, 30).join('\n'));
};
const els = async () => {
  const list = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('button, a, [role="button"], [role="menuitem"], input')
    )
      .map(
        (e) =>
          `${e.tagName}[${(
            e.innerText || e.value || e.getAttribute('aria-label') || e.name || ''
          )
            .trim()
            .slice(0, 60)}]`
      )
      .filter((v, i, a) => a.indexOf(v) === i)
      .join('\n')
  );
  console.log('--- interactive ---\n' + list);
};
await page.goto(BASE + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(4000);
await page.fill('input[name="identifier"]', 'test@test.com');
await page.getByRole('button', { name: /continue/i }).first().click();
await page.waitForTimeout(3000);
await page.fill('input[name="password"]', '12345678');
await page.getByRole('button', { name: /continue/i }).first().click();
await page.waitForTimeout(4000);
await dump('after breached password submit');
await els();
await page.screenshot({ path: '/tmp/e2e-signin-after-password.png' });
await browser.close();
