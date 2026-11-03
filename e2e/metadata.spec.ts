import { test, expect } from '@playwright/test';

// Check server-rendered metadata without relying on client-side hydration.
test.use({ javaScriptEnabled: false });

test('homepage HTML declares exactly one canonical URL', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  const canonical = page.locator('link[rel="canonical"]');
  await expect(canonical).toHaveCount(1);
  await expect(canonical).toHaveAttribute('href', process.env.COMEX_EXPECTED_CANONICAL || 'https://comex-seven.vercel.app/');
  await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1);
});

for (const route of ['/create', '/drafts']) {
  test(`${route} does not inherit the homepage canonical`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  });
}
