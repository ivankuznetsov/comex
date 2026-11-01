import { test, expect } from '@playwright/test';

test('a broken page does not leave an error on a different readable page', async ({ page }) => {
  const id = '11111111-1111-4111-8111-111111111111';
  await page.route(`**/api/published/${id}`, route => route.fulfill({json:{comic:{id,title:'Reader test',creator:'Test',editionId:'edition',pages:[{id:'one',imageUrl:'/test-image-one.png'},{id:'two',imageUrl:'/test-image-two.png'}]}}}));
  await page.route('**/test-image-one.png', route => route.abort());
  await page.route('**/test-image-two.png', route => route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WfQAAAAASUVORK5CYII=','base64')}));
  await page.goto(`/read/${id}`);
  const message = page.getByText('This edition may have changed or become unavailable. Reload to open the current edition.');
  await expect(message).toBeVisible();
  await page.getByRole('button',{name:'Next →'}).click();
  await expect(page.getByRole('img',{name:'Page 2 of Reader test'})).toBeVisible();
  await expect(message).toBeHidden();
});
