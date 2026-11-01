import {test,expect} from '@playwright/test';

test.skip(process.env.COMEX_E2E_MODE==='hosted','Requires the isolated local-mode test server.');

test('routing preserves clarification, binds story preview, and keeps pending edits on their panel',async ({page})=>{
  test.setTimeout(120_000);
  const version={assetId:'11111111-1111-4111-8111-111111111111',storyRevision:1,panelRevision:2};
  const snapshot={draftRevision:4,...version};
  const comic={id:'test-comic',revision:4,title:'The lighthouse',plot:'A dark lighthouse',style:'ink-manga',characters:[],questions:[],answers:{},pages:[{id:'page1',index:1,status:'needs_review',panels:[{id:'p1',description:'The lamp is off',status:'needs_review',evaluation:'uncertain',imageUrl:'/panel.png',reviewVersion:version},{id:'p2',description:'The keeper arrives',status:'needs_review',evaluation:'uncertain',imageUrl:'/panel2.png',reviewVersion:version}]}]};
  const requests:any[]=[];let preview:any; let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let hold=true;
  await page.route('**/api/comics/test-comic',route=>route.fulfill({json:{comic}}));
  await page.route('**/api/comics/test-comic/pages/*/job',route=>route.fulfill({json:{job:null,comic}}));
  await page.route('**/api/comics/test-comic/panels/*/edit',async route=>{
    const body=route.request().postDataJSON();requests.push(body);
    if(hold){hold=false;await gate;}
    if(body.instruction.includes('Clarification:')) return route.fulfill({json:{outcome:'edited',intent:'restore',comic}});
    const story=body.instruction.includes('Give the key');
    return route.fulfill({json:{outcome:'handoff',routing:{intent:story?'story':'clarify',reason:story?'The story changes.':'The request is ambiguous.',question:story?null:'What should change?',panelId:'p1',instruction:body.instruction,snapshot}}});
  });
  await page.route('**/api/comics/test-comic/revisions/preview',async route=>{preview=route.request().postDataJSON();return route.fulfill({json:{proposal:{id:'proposal',affectedPage:1,affectedPanel:1,explanation:'The light changes.',panels:[{id:'p1',page:1,panel:1,previousAction:'The lamp is off',action:'The sailor takes the key',dialogue:[{speaker:'Sailor',text:'Thank you.'}]}]}}});});
  await page.goto('/comics/test-comic');
  await page.getByLabel('Edit artwork').fill('Fix the lighthouse');
  await page.getByRole('button',{name:'Apply artwork edit (AI call)'}).click();
  await expect(page.getByLabel('Edit artwork')).toBeDisabled();
  await expect(page.getByRole('img',{name:'Page 1, panel 2'}).locator('..')).toBeDisabled();
  release();
  await expect(page.getByLabel('What should change?')).toBeVisible();
  await page.getByLabel('What should change?').fill('Make it dark');
  await page.getByRole('img',{name:'Page 1, panel 2'}).click();
  await expect(page.getByLabel('What should change?')).toHaveCount(0);
  await page.getByRole('img',{name:'Page 1, panel 1'}).click();
  await page.getByLabel('Edit artwork').fill('Fix the lighthouse');
  await page.getByRole('button',{name:'Apply artwork edit (AI call)'}).click();
  await expect(page.getByRole('button',{name:'Continue'})).toBeDisabled();
  await page.getByLabel('What should change?').fill('Make it dark');
  await page.getByRole('button',{name:'Continue'}).click();
  await expect.poll(()=>requests.length).toBe(3);
  expect(requests[2]).toEqual({instruction:'Fix the lighthouse\n\nClarification: Make it dark',...version,expectedDraftRevision:4});
  await page.getByLabel('Edit artwork').fill('Give the key to the sailor');
  await page.getByRole('button',{name:'Apply artwork edit (AI call)'}).click();
  await expect(page.getByText('This may change the story.')).toBeVisible();
  await page.getByRole('status').filter({hasText:'This may change the story.'}).getByRole('button',{name:'Preview story change'}).click();
  await expect.poll(()=>preview).toEqual({panelId:'p1',instruction:'Give the key to the sailor',reviewedVersion:version,expectedDraftRevision:4});
  const dialog=page.getByRole('dialog',{name:'Review your story change'});
  await expect(dialog.getByText('The lamp is off')).toBeVisible();
  await expect(dialog.getByText('The sailor takes the key')).toBeVisible();
  await expect(dialog.getByText('Thank you.')).toBeVisible();
  await expect(dialog.getByText(/Later pages remain outdated/)).toBeVisible();
  await dialog.getByRole('button',{name:'Close preview'}).click();
  await expect(page.getByText('Preview saved. Return to it while the draft remains unchanged.')).toBeVisible();
});
