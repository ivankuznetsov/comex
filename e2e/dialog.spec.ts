import { expect, test } from '@playwright/test';
import {signIn} from './sign-in-helper';

test('publish dialog manages keyboard focus and returns it to the trigger', async ({ page }) => {
  await signIn(page,'dialog@example.test');
  await page.goto('/create');
  await page.getByLabel('Give your comic a title').fill('The Courier');
  await page.getByLabel('What happens in your story?').fill('A courier delivers a mysterious key.');
  await page.getByRole('button', { name: /Start creating/ }).click();
  await expect(page).toHaveURL(/\/comics\//,{timeout:30_000});

  const trigger = page.getByRole('button', { name: 'Publish', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Publish your comic' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toBeFocused();
  await trigger.evaluate(el => (el as HTMLElement).focus());
  await expect(dialog.getByLabel('Title', { exact: true })).toBeFocused();

  for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key);
    await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog.getByRole('button', { name: 'Publish comic' })).toBeDisabled();
  await expect(dialog.getByText(/0 of 0 planned pages are complete/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(trigger).toBeFocused();
});
