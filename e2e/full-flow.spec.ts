import { test, expect } from '@playwright/test';
import {signIn} from './sign-in-helper';

test('creator plans, draws, edits, publishes and revises a three-page comic', async ({ browser }) => {
  test.skip(process.env.COMEX_E2E_FAKE_PROVIDER !== '1', 'Requires the isolated fake-provider server.');
  test.setTimeout(180_000);
  const creator = await browser.newContext();
  const page = await creator.newPage();
  await signIn(page,'creator@example.test');
  await page.goto('/create');
  await page.getByLabel('Give your comic a title').fill('The Clockwork Journey');
  await page.getByLabel('What happens in your story?').fill('Mina delivers a clockwork bird carrying a key across London.');
  await page.getByRole('button', { name: /Start creating/ }).click();
  await expect(page).toHaveURL(/\/comics\//);
  await page.getByRole('button', { name: 'Ask story questions' }).click();
  await page.getByLabel('What does Mina want?').fill('Deliver the key safely');
  await page.getByLabel('name', { exact: true }).fill('Mina');
  await page.getByLabel('role', { exact: true }).fill('Courier');
  await page.getByLabel('appearance', { exact: true }).fill('Short red hair');
  await page.getByLabel('outfit', { exact: true }).fill('Yellow coat');
  await page.getByRole('button', { name: 'Add character' }).click();
  await expect(page.getByLabel('What does Mina want?')).toHaveValue('Deliver the key safely');
  await page.getByRole('button', { name: 'Create reference' }).click();
  await expect(page.getByAltText('Reference for Mina')).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approved', { exact:true })).toBeVisible();
  await page.getByRole('button', { name: /Plan story/ }).click();
  await expect(page.getByText('Story review: pass')).toBeVisible();
  const savedDraft = await page.request.get(new URL(page.url()).pathname.replace('/comics/', '/api/comics/'));
  const savedAnswers = (await savedDraft.json()).comic.answers as Record<string,string>;
  expect(Object.values(savedAnswers)).toContain('Deliver the key safely');
  for (let i = 1; i <= 3; i++) {
    await page.getByRole('button', { name: `Page ${i}`, exact:true }).click();
    await page.getByRole('button', { name:'Generate page', exact:true }).click();
    await expect(page.getByRole('img', {name:`Page ${i}, panel 3`})).toBeVisible({timeout:40_000});
    for (let j = 1; j <= 3; j++) {
      await page.getByRole('img', {name:`Page ${i}, panel ${j}`}).click();
      await expect(page.getByText('Automated review completed without findings. Inspect the panel before accepting.')).toBeVisible();
      await page.getByRole('button', {name:'Accept and continue'}).click();
    }
    await expect(page.getByRole('link', {name:'Download page'})).toBeVisible();
  }
  await page.getByRole('button', { name:'Page 1', exact:true }).click();
  const panel1Before = await page.getByRole('img', {name:'Page 1, panel 1'}).getAttribute('src');
  const panel2Before = await page.getByRole('img', {name:'Page 1, panel 2'}).getAttribute('src');
  await page.getByLabel('Edit artwork').fill('Make the sky blue');
  await page.getByRole('button', {name:'Regenerate panel'}).click();
  await expect.poll(async () => page.getByRole('img', {name:'Page 1, panel 1'}).getAttribute('src')).not.toBe(panel1Before);
  await expect(page.getByRole('img', {name:'Page 1, panel 2'})).toHaveAttribute('src', panel2Before!);
  await page.getByRole('button', {name:'Accept and continue'}).click();
  await page.getByRole('button', {name:'Publish', exact:true}).click();
  await page.getByLabel('Creator display name (optional)').fill('Mina Maker');
  await page.getByRole('button', {name:'Publish comic'}).click();
  await expect(page.getByText('Published! Your comic is now on the community shelf.')).toBeVisible({timeout:40_000});
  const publicUrl = new URL((await page.getByRole('link', {name:'View published'}).getAttribute('href'))!, page.url()).toString();
  const readerContext = await browser.newContext();
  const reader = await readerContext.newPage();
  await reader.goto('/');
  await expect(reader.getByRole('heading',{name:'The Clockwork Journey'})).toBeVisible();
  await reader.goto(publicUrl);
  await expect(reader.getByText('Page 1 of 3')).toBeVisible();
  const publicImage = reader.getByRole('img',{name:'Page 1 of The Clockwork Journey'});
  await expect(publicImage).toBeVisible();
  await expect.poll(() => publicImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await reader.getByRole('button',{name:'Next →'}).click();
  await expect(reader.getByText('Page 2 of 3')).toBeVisible();
  await page.getByRole('button', {name:'Page 2', exact:true}).click();
  await page.getByRole('img',{name:'Page 2, panel 2'}).click();
  const prefixBefore = await page.getByRole('img',{name:'Page 2, panel 1'}).getAttribute('src');
  await page.getByLabel('Change the story').fill('Mina takes the longer route');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button',{name:'Preview story change'}).click();
  await expect(page.getByText('Later pages remain outdated until you review the preceding page and generate them.')).toBeVisible({timeout:40_000});
  await expect(page.getByRole('img',{name:'Page 2, panel 1'})).toHaveAttribute('src', prefixBefore!);
  for (let j = 2; j <= 3; j++) {
    await page.getByRole('img',{name:`Page 2, panel ${j}`}).click();
    await page.getByRole('button',{name:'Accept and continue'}).click();
  }
  await page.getByRole('button',{name:'Page 3', exact:true}).click();
  await expect(page.getByText('Story changed — this page needs updating.')).toBeVisible();
  await reader.reload();
  await expect(reader.getByText('Page 1 of 3')).toBeVisible();
  await page.getByRole('button',{name:'Regenerate page', exact:true}).click();
  for (let j = 1; j <= 3; j++) {
    await page.getByRole('img',{name:`Page 3, panel ${j}`}).click();
    await page.getByRole('button',{name:'Accept and continue'}).click();
  }
  await expect(page.getByRole('link',{name:'Download page'})).toBeVisible({timeout:40_000});
  await page.getByRole('button',{name:'Republish',exact:true}).click();
  await page.getByRole('button',{name:'Republish',exact:true}).last().click();
  await expect(page.getByText('Published! Your comic is now on the community shelf.')).toBeVisible({timeout:40_000});
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button',{name:'Withdraw from gallery'}).click();
  await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeVisible();
  await reader.reload();
  await expect(reader.getByText('This comic is unavailable.', {exact:false})).toBeVisible();
  await creator.close();
  await readerContext.close();
});
