import {test, expect, type Page} from '@playwright/test';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

/** The runner supplies a fresh isolated budget database and a fake provider. */
function reservations(): number {
  const path = process.env.COMEX_E2E_BUDGET_DB;
  if (!path || process.env.COMEX_E2E_FAKE_PROVIDER !== '1') throw new Error('Use the isolated E2E runner.');
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path, {readOnly:true});
  try { return Number((db.prepare('SELECT count(*) AS count FROM provider_reservations').get() as {count:number}).count); }
  finally { db.close(); }
}

async function startDraft(page:Page, email:string, title:string, plot = 'Mina carries a precious key through London.') {
  await page.goto('/create');
  void email;
  await page.getByLabel('Give your comic a title').fill(title);
  await page.getByLabel('What happens in your story?').fill(plot);
  await page.getByRole('button',{name:'Start creating →'}).click();
  await expect(page).toHaveURL(/\/comics\//,{timeout:30_000});
}

async function addCharacter(page:Page, name:string) {
  await page.getByLabel('name',{exact:true}).fill(name);
  await page.getByLabel('role',{exact:true}).fill('Courier');
  await page.getByLabel('appearance',{exact:true}).fill('Short red hair');
  await page.getByLabel('outfit',{exact:true}).fill('Yellow coat');
  await page.getByRole('button',{name:'Add character',exact:true}).click();
}

test('new drafts ask questions automatically and draw references only on request', async ({page}) => {
  test.skip(process.env.COMEX_E2E_FAKE_PROVIDER !== '1', 'Requires the isolated fake-provider server.');
  const before = reservations();
  await startDraft(page,'autoflow@example.test','Automatic journey');
  await expect(page.getByLabel('What does Mina want?')).toBeVisible({timeout:30_000});
  await expect(page.getByRole('button',{name:'Review suggestion'})).toBeVisible({timeout:30_000});
  await expect.poll(reservations).toBe(before + 2);
  await expect(page.getByRole('button',{name:'Ask story questions'})).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('What does Mina want?')).toBeVisible();
  expect(reservations()).toBe(before + 2);

  await page.getByRole('button',{name:'Review suggestion'}).click();
  await expect(page.getByLabel('name',{exact:true})).toHaveValue('Mina');
  await expect(page.getByLabel('name',{exact:true})).toBeFocused();
  await expect(page.getByLabel('name',{exact:true})).toBeInViewport();
  await page.getByLabel('outfit',{exact:true}).fill('Blue raincoat');
  await page.getByRole('button',{name:'Add character',exact:true}).click();
  expect(reservations()).toBe(before + 2);
  await page.getByRole('button',{name:'Draw reference (AI call)'}).click();
  await expect(page.getByAltText('Reference for Mina')).toBeVisible({timeout:30_000});
  await expect(page.getByText('Outfit: Blue raincoat',{exact:true})).toBeVisible();
  await expect.poll(reservations).toBe(before + 3);
  await expect(page.getByRole('button',{name:'Create reference'})).toHaveCount(0);
  await page.reload();
  await expect(page.getByAltText('Reference for Mina')).toBeVisible({timeout:30_000});
  expect(reservations()).toBe(before + 3);
});

test('a failed automatic request preserves the draft or card and offers an explicit retry', async ({page}) => {
  test.skip(process.env.COMEX_E2E_FAKE_PROVIDER !== '1', 'Requires the isolated fake-provider server.');
  const before = reservations();
  await startDraft(page,'autoretry@example.test','Recoverable draft','Mina carries AUTORETRYQUESTIONS through London.');
  await expect(page.getByRole('heading',{name:'Recoverable draft'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry questions'})).toBeVisible({timeout:30_000});
  await expect.poll(reservations).toBe(before + 1);
  writeFileSync(join(process.env.COMEX_E2E_MAILBOX!, 'allow-questions'), 'ok');
  await page.getByRole('button',{name:'Retry questions'}).click();
  await expect(page.getByLabel('What does Mina want?')).toBeVisible({timeout:30_000});
  await expect(page.getByRole('button',{name:'Review suggestion'})).toBeVisible({timeout:30_000});
  await expect.poll(reservations).toBe(before + 3);
  await page.reload();
  await expect(page.getByLabel('What does Mina want?')).toBeVisible();
  expect(reservations()).toBe(before + 3);

  await addCharacter(page,'Retryref');
  await expect(page.getByRole('heading',{name:'Retryref'})).toBeVisible();
  await page.getByRole('button',{name:'Draw reference (AI call)'}).click();
  await expect(page.getByRole('button',{name:'Draw reference (AI call)'})).toBeVisible({timeout:30_000});
  await expect.poll(reservations).toBe(before + 4);
  writeFileSync(join(process.env.COMEX_E2E_MAILBOX!, 'allow-reference'), 'ok');
  await page.getByRole('button',{name:'Draw reference (AI call)'}).click();
  await expect(page.getByAltText('Reference for Retryref')).toBeVisible({timeout:30_000});
  await expect.poll(reservations).toBe(before + 5);
});

test('a suggestion request that cannot start offers a manual retry', async ({page}) => {
  test.skip(process.env.COMEX_E2E_FAKE_PROVIDER !== '1', 'Requires the isolated fake-provider server.');
  await page.route('**/api/comics/*/characters/suggestions',route => route.fulfill({status:409,json:{error:'A story request is already running.'}}));
  await startDraft(page,'suggestionretry@example.test','Suggestion retry');
  await expect(page.getByRole('button',{name:'Suggest characters',exact:true})).toBeVisible({timeout:30_000});
  await expect(page.getByText('A story request is already running.')).toBeVisible();
});
