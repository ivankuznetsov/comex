import {expect,test} from '@playwright/test';
import {writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {signIn} from './sign-in-helper';

test('page job survives browser reload and is shared across tabs',async ({browser})=>{
  test.skip(process.env.COMEX_E2E_FAKE_PROVIDER !== '1','Requires isolated fake provider');
  test.setTimeout(150_000);
  const mailbox=process.env.COMEX_E2E_MAILBOX!;
  const hold=join(mailbox,'hold-image'), count=join(mailbox,'image-count');
  const context=await browser.newContext(); const page=await context.newPage();
  try {
    await signIn(page,'pagejob@example.test');
    await page.goto('/create');
    await page.getByLabel('Give your comic a title').fill('Page job');
    await page.getByLabel('What happens in your story?').fill('Mina carries a key across the city.');
    await page.getByRole('button',{name:/Start creating/}).click();
    await expect(page).toHaveURL(/\/comics\//);
    await expect(page.getByLabel('What does Mina want?')).toBeVisible();
    await page.getByLabel('name',{exact:true}).fill('Mina');
    await page.getByLabel('role',{exact:true}).fill('Courier');
    await page.getByLabel('appearance',{exact:true}).fill('Short red hair');
    await page.getByLabel('outfit',{exact:true}).fill('Yellow raincoat');
    await page.getByRole('button',{name:'Add character'}).click();
    await page.getByRole('button',{name:'Draw reference (AI call)'}).click();
    await expect(page.getByAltText('Reference for Mina')).toBeVisible();
    await page.getByRole('button',{name:'Approve',exact:true}).click();
    await page.getByRole('button',{name:/Plan story/}).click();
    await expect(page.getByText('Story review: pass')).toBeVisible();
    await page.getByRole('button',{name:'Approve story',exact:true}).click();
    const before=(await readFile(count,'utf8')).trim().split('\n').length;
    await writeFile(hold,'1');
    await page.getByRole('button',{name:'Generate page',exact:true}).click();
    await expect(page.getByText('Drawing page 1 — panel 1 of 3.',{exact:false})).toBeVisible();
    await page.reload();
    await expect(page.getByText('Drawing page 1 — panel 1 of 3.',{exact:false})).toBeVisible();
    await expect(page.getByRole('button',{name:'Page 2',exact:true})).toBeDisabled();
    const second=await context.newPage(); await second.goto(page.url());
    await expect(second.getByText('Drawing page 1 — panel 1 of 3.',{exact:false})).toBeVisible({timeout:30_000});
    await expect(second.getByRole('button',{name:'Generate page',exact:true})).toBeDisabled();
    await rm(hold);
    await expect(page.getByRole('img',{name:'Page 1, panel 3'})).toBeVisible({timeout:40_000});
    await expect(second.getByRole('img',{name:'Page 1, panel 3'})).toBeVisible({timeout:40_000});
    const after=(await readFile(count,'utf8')).trim().split('\n').length;
    expect(after-before).toBe(3);
  } finally {await rm(hold,{force:true});await context.close();}
});
