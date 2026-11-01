import {test,expect} from '@playwright/test';

test('creator can clarify an ambiguous visual edit or preview a story change',async ({page})=>{
  const version={assetId:'11111111-1111-4111-8111-111111111111',storyRevision:1,panelRevision:2};
  const comic={id:'test-comic',title:'The lighthouse',plot:'A dark lighthouse',style:'ink-manga',characters:[],questions:[],answers:{},pages:[{id:'page1',index:1,status:'needs_review',panels:[{id:'p1',description:'The lamp is off',status:'needs_review',evaluation:'uncertain',imageUrl:'/panel.png',reviewVersion:version}]}]};
  let classified=0;let confirmed:unknown;let preview:unknown;
  await page.route('**/api/comics/test-comic',route=>route.fulfill({json:{comic}}));
  await page.route('**/api/comics/test-comic/panels/p1/edit',async route=>{
    const body=route.request().postDataJSON();
    if (body.decision) {confirmed=body;return route.fulfill({json:{comic}});}
    classified++;
    return route.fulfill({json:{editDecision:{intent:classified===1?'uncertain':'story',reason:'The scene may change.',panelId:'p1',reviewedVersion:version,...(classified===1?{proposalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}:{})}}});
  });
  await page.route('**/api/comics/test-comic/revisions/preview',async route=>{preview=route.request().postDataJSON();return route.fulfill({json:{proposal:{id:'proposal',affectedPage:1,affectedPanel:1,explanation:'The light changes.',panels:[{id:'p1',page:1,panel:1,previousAction:'The lamp is off',action:'The sailor takes the key',dialogue:[{speaker:'Sailor',text:'Thank you.'}]}]}}});});
  await page.goto('/comics/test-comic');
  await page.getByLabel('Edit artwork').fill('Turn the lamp off');
  await page.getByRole('button',{name:'Regenerate panel'}).click();
  await expect(page.getByText('Does this change the story?')).toBeVisible();
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Artwork only — story stays unchanged'}).click();
  await expect.poll(()=>confirmed).toEqual({proposalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',decision:'artwork_only'});
  expect(classified).toBe(1);
  await page.getByLabel('Edit artwork').fill('Give the key to the sailor');
  await page.getByRole('button',{name:'Regenerate panel'}).click();
  await expect(page.getByText('This may change the story.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Artwork only — story stays unchanged'})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview as story change'}).click();
  await expect.poll(()=>preview).toEqual({panelId:'p1',instruction:'Give the key to the sailor',reviewedVersion:version});
  const dialog=page.getByRole('dialog',{name:'Review your story change'});
  await expect(dialog.getByText('The lamp is off')).toBeVisible();
  await expect(dialog.getByText('The sailor takes the key')).toBeVisible();
  await expect(dialog.getByText('Thank you.')).toBeVisible();
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await expect(page.getByText('Revision not applied.')).toBeVisible();
});
