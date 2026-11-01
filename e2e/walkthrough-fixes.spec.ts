import {expect, test} from '@playwright/test';

test('mobile editor shows delayed checks, requires acceptance and keeps errors in view', async ({page}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({width:390,height:844});
  let reviewFinished=false, accepted=false;
  const version={assetId:'11111111-1111-4111-8111-111111111111',storyRevision:1,panelRevision:2};
  const comic=()=>({id:'ux-review',revision:1,title:'Review demo',plot:'A short story',style:'ink-manga',characters:[],questions:[],answers:{},initialQuestions:'complete',initialSuggestions:'complete',published:false,pages:[
    {id:'page1',index:1,status:accepted?'current':reviewFinished?'needs_review':'checking',panels:[{id:'p1',description:'The market',status:accepted?'needs_review':reviewFinished?'needs_review':'checking',evaluation:reviewFinished?'blocker':'pending',reviewOutcome:reviewFinished?'findings':null,findings:reviewFinished?[{severity:'blocker',dimension:'framing_composition',expected:'A silhouette',observed:'The figure is visible'}]:[],ready:true,reviewed:accepted,accepted,imageUrl:'/test-panel.png',reviewVersion:version}]},
    {id:'page2',index:2,status:'planned',panels:[{id:'p2',description:'The ending',status:'planned',evaluation:'pending',ready:false,reviewed:false,imageUrl:null}]},
  ]});
  await page.route('**/api/comics/ux-review**',async route => {
    const request=route.request(), path=new URL(request.url()).pathname;
    if (request.method()==='GET') return route.fulfill({json:path.endsWith('/job')?{job:null,comic:comic()}:{comic:comic()}});
    if (request.method()==='PATCH') return route.fulfill({status:409,json:{error:'Could not change the layout.'}});
    if (path.endsWith('/accept')) {expect(request.postDataJSON()).toEqual(version);accepted=true;return route.fulfill({json:{comic:comic()}});}
    return route.fulfill({status:404,json:{error:'Unexpected request'}});
  });
  await page.goto('/comics/ux-review');
  await expect(page.getByText('Check: checking')).toBeVisible();
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Publish your comic'});
  await expect(dialog.getByText(/1 of 2 planned pages are complete/)).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Publish comic'})).toBeDisabled();
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await page.getByRole('button',{name:'Page 2',exact:true}).click();
  await expect(page.getByRole('button',{name:'Generate page'})).toBeDisabled();
  await expect(page.getByText('Finish and review the preceding page before drawing this one.')).toBeVisible();
  await page.getByRole('button',{name:'Page 1',exact:true}).click();
  reviewFinished=true;
  await expect(page.getByText('Check: blocker')).toBeVisible({timeout:7000});
  await expect(page.getByText('framing composition:',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Accept this panel'}).click();
  await expect(page.getByText('You accepted these findings for this image.')).toBeVisible();
  await page.getByLabel('Page layout').selectOption('grid');
  const error=page.getByRole('alert').filter({hasText:'Could not change the layout.'});
  await expect(error).toBeVisible();await expect(error).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
