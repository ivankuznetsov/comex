import {test,expect} from '@playwright/test';

test('creator chooses five pages, draws and publishes all five',async({page})=>{
  test.skip(process.env.COMEX_E2E_FAKE_PROVIDER!=='1','Requires the isolated fake-provider server.');
  test.setTimeout(180_000);
  await page.goto('/create');
  await page.getByLabel('Your email address').fill('longer-comic@example.test');
  await page.getByLabel('Give your comic a title').fill('A five-page adventure');
  await page.getByLabel('What happens in your story?').fill('Mina carries a precious key through London.');
  await page.getByRole('button',{name:'Start creating →'}).click();
  await expect(page).toHaveURL(/\/comics\//,{timeout:90_000});
  await expect(page.getByRole('button',{name:'Review suggestion'})).toBeVisible({timeout:30_000});
  await expect(page.getByLabel('Pages',{exact:true})).toHaveValue('3');
  const budget=page.getByRole('region',{name:'Estimated budget'});
  await expect(budget).toContainText('3 pages · 9 panels · 0 character references');
  await expect(budget).toContainText('USD');
  await page.getByLabel('Pages',{exact:true}).selectOption('5');
  await expect(page.getByLabel('Pages',{exact:true})).toHaveValue('5');
  await expect(budget).toContainText('5 pages · 15 panels');
  await expect(page.getByLabel('Panels per page')).toBeEnabled();
  await page.getByLabel('Panels per page').selectOption('2');
  await expect(page.getByRole('button',{name:'Review suggestion'})).toBeEnabled();
  await page.getByRole('button',{name:'Review suggestion'}).click();
  await page.getByRole('button',{name:'Add character',exact:true}).click();
  await expect(page.getByAltText('Reference for Mina')).toBeVisible();
  await expect(budget).toContainText('5 pages · 10 panels · 1 character reference');
  await expect(budget).toContainText('10 panels and 0 references left to draw');
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await page.reload();
  await expect(page.getByLabel('Pages',{exact:true})).toHaveValue('5');
  await page.getByRole('button',{name:/Plan story/}).click();
  await expect(page.getByRole('button',{name:'Page 5',exact:true})).toBeVisible();
  await expect(page.getByLabel('Pages',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Approve story',exact:true}).click();
  for(let i=1;i<=5;i++) {
    await page.getByRole('button',{name:`Page ${i}`,exact:true}).click();
    await page.getByRole('button',{name:'Generate page',exact:true}).click();
    await expect(page.getByRole('img',{name:`Page ${i}, panel 2`})).toBeVisible({timeout:40_000});
    await expect(page.getByRole('link',{name:'Download page'})).toBeVisible();
  }
  await expect(budget).toContainText('Estimated remaining: $0.00');
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await page.getByRole('button',{name:'Publish comic',exact:true}).click();
  await expect(page.getByRole('link',{name:'View published'})).toBeVisible({timeout:40_000});
  const url=await page.getByRole('link',{name:'View published'}).getAttribute('href');
  await page.goto(url!+'?page=5');
  await expect(page.getByText('Page 5 of 5',{exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'Page 5 of A five-page adventure'})).toBeVisible();
});
