import { test, expect } from '@playwright/test';

test('creator can save a private local draft and another browser cannot read it', async ({ browser }) => {
  const creator = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await creator.newPage();
  await page.goto('/create');
  await page.getByLabel('Give your comic a title').fill('The Clockwork Delivery');
  await page.getByLabel('What happens in your story?').fill('Mina delivers a clockwork bird carrying a mysterious key.');
  await page.getByRole('button', { name: /Start creating/ }).click();
  await expect(page).toHaveURL(/\/comics\//);
  await expect(page.getByText('Mina delivers a clockwork bird', { exact: false })).toBeVisible();
  const draftUrl = page.url();
  await page.getByLabel('name', { exact: true }).fill('Mina');
  await page.getByLabel('role', { exact: true }).fill('Courier');
  await page.getByLabel('appearance', { exact: true }).fill('Short red hair');
  await page.getByLabel('outfit', { exact: true }).fill('Yellow coat');
  await page.getByRole('button', { name: 'Add character' }).click();
  await expect(page.getByRole('heading', { name: 'Mina' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mina' })).toBeVisible();
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(draftUrl);
  await expect(otherPage.getByText(/comic not found/i)).toBeVisible();
  await otherPage.goto('/');
  await expect(otherPage.getByText('The Clockwork Delivery')).toHaveCount(0);
  await creator.close();
  await other.close();
});
