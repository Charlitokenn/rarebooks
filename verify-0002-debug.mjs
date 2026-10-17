import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
await page.goto('http://localhost:5174/sign-in', { waitUntil: 'domcontentloaded' });
const id = page.getByRole('textbox', { name: /email|phone|username/i }).first();
await id.waitFor({ timeout: 30000 });
await id.fill('test@test.com');
await page.getByRole('button', { name: /continue/i }).first().click();
await page.waitForTimeout(2500);
await page.getByLabel(/password/i).first().fill('12345678');
await page.getByRole('button', { name: /continue|sign in/i }).last().click();
await page.waitForTimeout(2500);
await page.locator('button').filter({ hasText: /email code/i }).first().click();
await page.waitForTimeout(3000);
console.log(await page.evaluate(() => {
  const inps = Array.from(document.querySelectorAll('input'));
  return inps.map(i => i.outerHTML.slice(0, 200)).join('\n---\n');
}));
await browser.close();
