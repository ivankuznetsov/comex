import {expect,test} from '@playwright/test';

test('local creation keeps its existing API flow without hosted receipts',async({page})=>{
  let creates=0,operations=0;
  const comic={id:'local-test',title:'Local draft',plot:'A local courier carries a key.',style:'ink-manga',revision:1,storyRevision:1,characters:[],questions:[],answers:{},initialQuestions:'complete',initialSuggestions:'complete',pages:[]};
  await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{email:'local@example.test'},guest:null}}));
  await page.route('**/api/operations**',route=>{operations++;return route.fulfill({status:500,json:{error:'Unexpected hosted operation'}});});
  await page.route('**/api/comics**',route=>{
    if(route.request().method()==='POST' && new URL(route.request().url()).pathname==='/api/comics'){creates++;return route.fulfill({json:{comic}});}
    return route.fulfill({json:{comic}});
  });
  await page.goto('/create');await page.getByLabel('Give your comic a title').fill(comic.title);await page.getByLabel('What happens in your story?').fill(comic.plot);
  await page.getByRole('button',{name:'Start creating →'}).click();await expect(page).toHaveURL(/\/comics\/local-test/);await expect(page.getByText(comic.plot)).toBeVisible();
  expect(creates).toBe(1);expect(operations).toBe(0);expect(await page.evaluate(()=>localStorage.getItem('comex:browser-workspace'))).toBeNull();
});
