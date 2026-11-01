import {test,expect} from '@playwright/test';

test('creator signs in with an emailed one-time code',async ({page})=>{
  let requestedEmail='';let submitted:{email:string;code:string}|undefined;
  await page.route('**/api/auth/request',async route=>{requestedEmail=route.request().postDataJSON().email;await route.fulfill({json:{message:'Check your inbox.'}});});
  await page.route('**/api/auth/verify',async route=>{submitted=route.request().postDataJSON();await route.fulfill({json:{user:{email:requestedEmail}}});});
  await page.goto('/sign-in');await page.getByLabel('Email address').fill('creator@example.test');
  await page.getByRole('button',{name:'Email me a code →'}).click();await expect(page.getByText(/Check your inbox/)).toBeVisible();
  await page.getByLabel('One-time code').fill('12345678');await page.getByRole('button',{name:'Sign in →'}).click();
  await expect(page).toHaveURL(/\/drafts$/);expect(submitted).toEqual({email:'creator@example.test',code:'12345678'});
});

test('a new creator starts immediately and claims the draft after verifying email',async ({page})=>{
  const {readFile}=await import('node:fs/promises');const {join}=await import('node:path');
  const email='newcreator@example.test';
  await page.goto('/create');await page.getByLabel('Your email address').fill(email);
  await page.getByLabel('Give your comic a title').fill('New creator draft');
  await page.getByLabel('What happens in your story?').fill('A courier delivers a letter.');
  await page.getByRole('button',{name:'Start creating →'}).click();await expect(page).toHaveURL(/\/comics\//);
  const url=page.url();await expect(page.getByRole('heading',{name:'New creator draft'})).toBeVisible();
  await page.goto('/sign-in');await page.getByLabel('Email address').fill(email);await page.getByRole('button',{name:'Email me a code →'}).click();
  await expect(page.getByText(/Check your inbox/)).toBeVisible();
  const mail=JSON.parse(await readFile(join(process.env.COMEX_E2E_MAILBOX!,`${email}.json`),'utf8')) as {text:string};
  const code=mail.text.match(/code is (\d{8})/)![1];await page.getByLabel('One-time code').fill(code);
  await page.getByRole('button',{name:'Sign in →'}).click();await expect(page).toHaveURL(/\/drafts$/);
  await expect(page.getByRole('heading',{name:'New creator draft'})).toBeVisible();await page.goto(url);
  await expect(page.getByRole('heading',{name:'New creator draft'})).toBeVisible();
});

test('a creator can correct the guest email before saving the draft',async ({page})=>{
  const {readFile}=await import('node:fs/promises');const {join}=await import('node:path');
  const email='corrected@example.test';await page.goto('/create');await page.getByLabel('Your email address').fill('mistyped@example.test');
  await page.getByLabel('Give your comic a title').fill('Corrected email draft');await page.getByLabel('What happens in your story?').fill('A courier delivers a letter.');
  await page.getByRole('button',{name:'Start creating →'}).click();await expect(page).toHaveURL(/\/comics\//);
  await page.goto('/sign-in');await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Save this browser’s drafts to the verified email above').check();
  await page.getByRole('button',{name:'Email me a code →'}).click();await expect(page.getByText(/Check your inbox/)).toBeVisible();
  const mail=JSON.parse(await readFile(join(process.env.COMEX_E2E_MAILBOX!,`${email}.json`),'utf8')) as {text:string};
  await page.getByLabel('One-time code').fill(mail.text.match(/code is (\d{8})/)![1]);await page.getByRole('button',{name:'Sign in →'}).click();
  await expect(page).toHaveURL(/\/drafts$/);await expect(page.getByRole('heading',{name:'Corrected email draft'})).toBeVisible();
});
