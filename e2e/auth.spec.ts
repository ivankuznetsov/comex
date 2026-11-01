import {test,expect} from '@playwright/test';

test('sign-in screens request and confirm a magic link',async ({page}) => {
  let requestedEmail=''; let submittedToken='';
  await page.route('**/api/auth/request',async route => {requestedEmail=route.request().postDataJSON().email; await route.fulfill({json:{message:'Check your inbox.'}});});
  await page.route('**/api/auth/inspect',async route => {await route.fulfill({json:{email:requestedEmail}});});
  await page.route('**/api/auth/verify',async route => {submittedToken=route.request().postDataJSON().token; await route.fulfill({json:{user:{email:requestedEmail}}});});
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill('creator@example.test');
  await page.getByRole('button',{name:'Email me a sign-in link →'}).click();
  await expect(page.getByText(/Check your inbox/)).toBeVisible();
  expect(requestedEmail).toBe('creator@example.test');
  const token='a'.repeat(64);
  await page.goto(`/sign-in/verify#${token}`);
  await expect(page.getByRole('button',{name:'Sign in →'})).toBeVisible();
  await expect(page.getByText('creator@example.test')).toBeVisible();
  await expect(page.getByText('This link is invalid. Request a new one.')).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button',{name:'Sign in →'}).click();
  await expect(page).toHaveURL(/\/drafts$/);
  expect(submittedToken).toBe(token);
});
