import {expect, type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Isolated fake-provider fixture; never obtains or sends real email. */
export async function signIn(page:Page, email:string) {
  if (process.env.COMEX_E2E_FAKE_PROVIDER !== '1' || !process.env.COMEX_E2E_MAILBOX) throw new Error('Run browser tests using e2e/run-full-flow.sh.');
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button',{name:'Email me a code →'}).click();
  await expect(page.getByText(/Check your inbox/)).toBeVisible();
  const message=JSON.parse(await readFile(join(process.env.COMEX_E2E_MAILBOX,`${email}.json`),'utf8')) as {text:string};
  const code=message.text.match(/code is (\d{8})/)?.[1];
  expect(code).toBeTruthy();
  await page.getByLabel('One-time code').fill(code!);
  await page.getByRole('button',{name:'Sign in →'}).click();
  await expect(page).toHaveURL(/\/drafts$/);
}
