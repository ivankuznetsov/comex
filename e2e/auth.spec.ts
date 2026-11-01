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
  await page.goto('/create');
  await page.getByLabel('Your email address').fill(email);
  await page.getByLabel('Give your comic a title').fill('New creator draft');
  await page.getByLabel('What happens in your story?').fill('A courier delivers a letter.');
  await page.getByRole('button',{name:'Start creating →'}).click();await expect(page).toHaveURL(/\/comics\//);
  const url=page.url();await expect(page.getByRole('heading',{name:'New creator draft'})).toBeVisible();
  await page.goto('/sign-in');await expect(page.getByLabel('Email address')).toHaveValue(email);await page.getByRole('button',{name:'Email me a code →'}).click();
  await expect(page.getByText(/Check your inbox/)).toBeVisible();
  const mail=JSON.parse(await readFile(join(process.env.COMEX_E2E_MAILBOX!,`${email}.json`),'utf8')) as {text:string};
  const code=mail.text.match(/code is (\d{8})/)![1];await page.getByLabel('One-time code').fill(code);
  await page.getByRole('button',{name:'Sign in →'}).click();await expect(page).toHaveURL(/\/drafts$/,{timeout:30_000});
  await expect(page.getByRole('heading',{name:'New creator draft'})).toBeVisible();await page.goto(url);
  await expect(page.getByRole('heading',{name:'New creator draft'})).toBeVisible();
});

test('a creator can correct the guest email before saving the draft',async ({page})=>{
  const {readFile}=await import('node:fs/promises');const {join}=await import('node:path');
  const email='corrected@example.test';await page.goto('/create');await page.evaluate(async () => {await fetch('/api/comics',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Existing draft',plot:'An existing story',style:'ink-manga',email:'mistyped@example.test'})});});
  await page.getByLabel('Give your comic a title').fill('Corrected email draft');await page.getByLabel('What happens in your story?').fill('A courier delivers a letter.');
  await page.getByRole('button',{name:'Start creating →'}).click();await expect(page).toHaveURL(/\/comics\//);
  await page.goto('/sign-in');await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Save this browser’s drafts to the verified email above').check();
  await page.getByRole('button',{name:'Email me a code →'}).click();await expect(page.getByText(/Check your inbox/)).toBeVisible();
  const mail=JSON.parse(await readFile(join(process.env.COMEX_E2E_MAILBOX!,`${email}.json`),'utf8')) as {text:string};
  await page.getByLabel('One-time code').fill(mail.text.match(/code is (\d{8})/)![1]);await page.getByRole('button',{name:'Sign in →'}).click();
  await expect(page).toHaveURL(/\/drafts$/);await expect(page.getByRole('heading',{name:'Corrected email draft'})).toBeVisible();
});

test('delayed session prefill cannot corrupt a corrected email',async ({page})=>{
  let release!:()=>void,started!:()=>void;
  const delayed=new Promise<void>(resolve=>release=resolve), begun=new Promise<void>(resolve=>started=resolve);
  await page.route('**/api/auth/session',async route=>{started();await delayed;await route.fulfill({json:{user:null,guest:{email:'mistyped@example.test'}}});});
  let payload: {email:string;claimGuest?:boolean}|undefined;
  await page.route('**/api/auth/request',async route=>{payload=route.request().postDataJSON();await route.fulfill({json:{message:'Check your inbox.'}});});
  await page.goto('/sign-in');await begun;
  await expect(page.getByRole('status')).toHaveText('Checking your account…');
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  release();
  const input=page.getByLabel('Email address');await expect(input).toHaveValue('mistyped@example.test');
  await input.fill('corrected@example.test');await expect(input).toHaveValue('corrected@example.test');
  await page.getByLabel('Save this browser’s drafts to the verified email above').check();
  await page.getByRole('button',{name:'Email me a code →'}).click();
  await expect(page.getByText(/Check your inbox/)).toBeVisible();expect(payload).toEqual({email:'corrected@example.test',claimGuest:true});
});

test('a stalled session lookup does not block sign-in or overwrite typing later',async ({page})=>{
  let release!:()=>void,started!:()=>void;
  const delayed=new Promise<void>(resolve=>release=resolve), begun=new Promise<void>(resolve=>started=resolve);
  await page.route('**/api/auth/session',async route=>{started();await delayed;await route.fulfill({json:{user:null,guest:{email:'old@example.test'}}}).catch(()=>{});});
  await page.goto('/sign-in');await begun;
  const input=page.getByLabel('Email address');await expect(input).toBeVisible({timeout:7000});
  await input.fill('new@example.test');release();await expect(input).toHaveValue('new@example.test');
});
