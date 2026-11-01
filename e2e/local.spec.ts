import { test, expect } from '@playwright/test';
import {signIn} from './sign-in-helper';

test('creator can save a private local draft and another browser cannot read it', async ({ browser }) => {
  const creator = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await creator.newPage();
  await signIn(page,'local@example.test');
  await page.goto('/create');
  await page.getByLabel('Give your comic a title').fill('The Clockwork Delivery');
  await page.getByLabel('What happens in your story?').fill('Mina delivers a clockwork bird carrying a mysterious key.');
  await page.getByRole('button', { name: /Start creating/ }).click();
  await expect(page).toHaveURL(/\/comics\//);
  await expect(page.getByText('Mina delivers a clockwork bird', { exact: false })).toBeVisible();
  await page.getByLabel('Panels per page').selectOption('4');
  await expect(page.getByLabel('Panels per page')).toHaveValue('4');
  await page.getByLabel('Page layout').selectOption('grid');
  await expect(page.getByLabel('Page layout')).toHaveValue('grid');
  await page.reload();
  await expect(page.getByLabel('Panels per page')).toHaveValue('4');
  await expect(page.getByLabel('Page layout')).toHaveValue('grid');
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

for (const viewport of [{width:390,height:844},{width:1280,height:800}]) {
  test(`upload and approve separate references at ${viewport.width}px`, async ({page}) => {
    const sharp=(await import('sharp')).default;
    const {existsSync,readFileSync}=await import('node:fs'); const {join}=await import('node:path');
    await page.setViewportSize(viewport);
    await signIn(page,`upload${viewport.width}@example.test`);
    await page.goto('/create');
    await page.getByLabel('Give your comic a title').fill(`References ${viewport.width}`);
    await page.getByLabel('What happens in your story?').fill('Pip and Nora open a lighthouse.');
    await page.getByRole('button',{name:/Start creating/}).click();
    await expect(page.getByRole('button',{name:'Review and add'})).toBeVisible({timeout:30_000});
    const countFile=join(process.env.COMEX_E2E_MAILBOX!,'image-count');
    const imageCalls=()=>existsSync(countFile) ? readFileSync(countFile,'utf8').trim().split('\n').length : 0;
    const before=imageCalls();
    for (const [name, color] of [['Pip','#abc'],['Nora','#def']]) {
      await page.getByLabel('name',{exact:true}).fill(name);
      await page.getByLabel('role',{exact:true}).fill('Keeper');
      await page.getByLabel('appearance',{exact:true}).fill(`${name} has glasses`);
      await page.getByLabel('outfit',{exact:true}).fill('Red coat');
      await page.getByRole('button',{name:'Upload a reference for new character'}).click();
      const card=page.locator('article').filter({has:page.getByRole('heading',{name,exact:true})});
      const png=await sharp({create:{width:12,height:12,channels:4,background:color}}).png().toBuffer();
      await card.getByLabel(`Reference image for ${name}`).setInputFiles({name:`${name}.png`,mimeType:'image/png',buffer:png});
      await card.getByLabel('Appearance in this reference').fill(`${name} has round glasses`);
      await card.getByRole('button',{name:'Save reference'}).click();
      await expect(card.getByAltText(`Reference for ${name}`)).toBeVisible();
      await expect(card.getByText('Needs approval')).toBeVisible();
      await expect(card.getByText(`${name} has round glasses`)).toBeVisible();
      await card.getByRole('button',{name:'Approve',exact:true}).click();
      await expect(card.getByText('Approved',{exact:true})).toBeVisible();
    }
    expect(imageCalls()).toBe(before);
    await page.reload();
    await expect(page.getByAltText('Reference for Pip')).toBeVisible();
    await expect(page.getByAltText('Reference for Nora')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('upload keeps the file and text through a conflict and requires review of a changed card', async ({page}) => {
  const sharp=(await import('sharp')).default;
  await signIn(page,'uploadconflict@example.test');
  await page.goto('/create');
  await page.getByLabel('Give your comic a title').fill('Upload conflict');
  await page.getByLabel('What happens in your story?').fill('A lighthouse keeper.');
  await page.getByRole('button',{name:/Start creating/}).click();
  await expect(page.getByRole('button',{name:'Review and add'})).toBeVisible({timeout:30_000});
  for(const [label,value] of [['name','Pip'],['role','Keeper'],['appearance','Blue hair'],['outfit','Red coat']]) await page.getByLabel(label,{exact:true}).fill(value);
  await page.getByRole('button',{name:'Upload a reference for new character'}).click();
  const card=page.locator('article').filter({has:page.getByRole('heading',{name:'Pip',exact:true})});
  const png=await sharp({create:{width:12,height:12,channels:4,background:'#abc'}}).png().toBuffer();
  await card.getByLabel('Reference image for Pip').setInputFiles({name:'pip.png',mimeType:'image/png',buffer:png});
  await card.getByLabel('Appearance in this reference').fill('Uploaded glasses');
  await card.getByRole('button',{name:'Edit card'}).click();
  await page.getByLabel('appearance',{exact:true}).fill('Newer card text');
  await page.getByRole('button',{name:'Save character'}).click();
  await expect(card.getByText('The character card changed.',{exact:false})).toBeVisible();
  await expect(card.getByRole('button',{name:'Save reference'})).toBeDisabled();
  await card.getByRole('button',{name:'Use current card version'}).click();
  let attempts=0;
  await page.route('**/characters/*/reference/upload',route => ++attempts === 1 ? route.fulfill({status:409,json:{error:'The draft changed. Refresh and try again.'}}) : route.continue());
  await card.getByRole('button',{name:'Save reference'}).click();
  await expect(page.getByText('The draft changed. Refresh and try again.')).toBeVisible();
  await expect(card.getByLabel('Appearance in this reference')).toHaveValue('Uploaded glasses');
  expect(await card.getByLabel('Reference image for Pip').evaluate((input:HTMLInputElement)=>input.files?.[0]?.name)).toBe('pip.png');
  await card.getByRole('button',{name:'Save reference'}).click();
  await expect(card.getByAltText('Reference for Pip')).toBeVisible();
  await expect(card.getByText('Uploaded glasses')).toBeVisible();
});
