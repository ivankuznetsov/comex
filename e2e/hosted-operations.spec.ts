import {expect,test} from '@playwright/test';

test.beforeEach(async({page})=>{await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{email:'creator@example.test'},guest:null,workspaceId:'workspace-a'}}));});

test('hosted editor restores jobs, asks the saved questions and requires each approval',async({browser})=>{
  test.setTimeout(90000);
  const context=await browser.newContext(),page=await context.newPage();
  const requests:{action:string;requestKey:string;expectedRevision?:number;input:any}[]=[], jobs=new Map<string,any>(),byKey=new Map<string,string>();
  let releaseQuestions=false, releaseReference=false, guestReady=false, counter=0;
  const characterId='char-1', reference='11111111-1111-4111-8111-111111111111', panelImage='22222222-2222-4222-8222-222222222222';
  const storyState={location:'Town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
  const draft:any={id:'mock-comic',title:'Courier',plot:'Mina carries a key to the lighthouse.',style:'ink-manga',revision:1,storyRevision:1,characters:[],questions:[],answers:{},characterSuggestions:[],initialQuestions:'pending',initialSuggestions:'pending',pages:[],published:false,publication:null};
  await context.route('**/api/auth/session',route=>route.fulfill({json:{user:null,guest:guestReady?{email:'guest@example.test'}:null,workspaceId:guestReady?'workspace-a':null}}));
  await context.route('**/api/auth/guest',async route=>{expect(jobs.size).toBe(0);guestReady=true;await route.fulfill({json:{ok:true,workspaceId:'workspace-a'}});});
  await context.route('**/api/comics/mock-comic/assets/**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmL0AAAAASUVORK5CYII=','base64')}));
  await context.route('**/api/comics/mock-comic',route=>route.fulfill({json:{comic:draft}}));
  await context.route('**/api/operations**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='GET' && url.pathname==='/api/operations')return route.fulfill({json:{operations:[...jobs.values()].filter(job=>job.body.comicId==='mock-comic' && !job.applied).map(job=>({id:job.id,action:job.body.action,comicId:'mock-comic',status:'running',expectedRevision:job.body.expectedRevision,...(job.body.input.characterId?{characterId:job.body.input.characterId}:{})}))}});
    if(req.method()==='POST' && url.pathname==='/api/operations') {
      const body=req.postDataJSON();expect(body.expectedWorkspaceId).toBe('workspace-a');requests.push(body);
      const existing=byKey.get(body.requestKey);if(existing)return route.fulfill({status:202,json:{id:existing,status:'queued',comicId:body.comicId}});
      const id=`op-${++counter}`;byKey.set(body.requestKey,id);jobs.set(id,{id,body,applied:false});
      return route.fulfill({status:202,json:{id,status:'queued',...(body.comicId?{comicId:body.comicId}:{})}});
    }
    const id=url.pathname.split('/')[3],job=jobs.get(id);
    if(!job)return route.fulfill({status:404,json:{error:'Not found'}});
    const {action,input}=job.body;
    if(action==='initialQuestions' && !releaseQuestions)return route.fulfill({json:{id,action,comicId:'mock-comic',status:'running'}});
    if(action==='generateReference' && !releaseReference)return route.fulfill({json:{id,action,comicId:'mock-comic',status:'running'}});
    let result:any={};
    if(!job.applied) {
      job.applied=true;
      if(action==='create')result={comic:{id:'mock-comic'}};
      if(action==='initialQuestions'){draft.initialQuestions='complete';draft.questions=[{id:'question-1',question:'Who receives the key?',suggestedAnswer:'Her brother'}];draft.revision++;}
      if(action==='suggestCharacters'){draft.initialSuggestions='complete';draft.characterSuggestions=[{id:'suggestion-1',name:'Mina',role:'Courier',appearance:'Red hair',outfit:'Blue coat'}];draft.revision++;}
      if(action==='addCharacter'){draft.characters.push({id:characterId,...input,approved:false,referenceStatus:'missing'});draft.revision++;result={comic:structuredClone(draft)};}
      if(action==='generateReference'){draft.characters[0].referenceUrl='/api/comics/mock-comic/assets/'+reference;draft.characters[0].referenceVersion=reference;draft.characters[0].referenceStatus='ready';draft.revision++;}
      if(action==='approveCharacter'){draft.characters[0].approved=true;draft.revision++;}
      if(action==='planStory'){draft.storyboard={bible:{premise:'A key',setting:'Town',rules:[],character_ids:[characterId]},pages:[{index:1,panels:[{id:'panel-1',index:1,character_ids:[characterId],action:'Mina finds the key',framing:'wide',dialogue:[{speaker_id:characterId,text:'Here it is'}],state_before:storyState,state_after:storyState}]}]};draft.pages=[{id:'page-1',index:1,status:'planned',panels:[{id:'panel-1',description:'Mina finds the key',status:'planned',evaluation:'pending'}]}];draft.storyReview={outcome:'pass',findings:[],fingerprint:'a'.repeat(64),accepted:false};draft.storyApproval={storyRevision:1,fingerprint:'b'.repeat(64),approved:false};draft.revision++;}
      if(action==='approveStory'){draft.storyApproval.approved=true;draft.revision++;}
      if(action==='generatePage'){draft.pages[0].status='needs_review';draft.pages[0].panels[0]={id:'panel-1',description:'Mina finds the key',imageUrl:'/api/comics/mock-comic/assets/'+panelImage,status:'needs_review',evaluation:'blocker',reviewOutcome:'findings',findings:[{severity:'blocker',dimension:'story',expected:'key',observed:'missing key'}],accepted:false,reviewVersion:{assetId:panelImage,storyRevision:1,panelRevision:2}};draft.revision++;}
      if(action==='acceptPanel'){draft.pages[0].panels[0].accepted=true;draft.pages[0].status='current';draft.revision++;}
      if(action==='publish'){draft.published=true;draft.publication={editionId:'edition-1',title:input.title,creator:input.creator};draft.revision++;}
      job.result=result;
    }
    return route.fulfill({json:{id,action,comicId:'mock-comic',status:'succeeded',result:job.result}});
  });
  try {
    await page.goto('/create');await page.getByLabel('Your email address').fill('guest@example.test');await page.getByLabel('Give your comic a title').fill('Courier');await page.getByLabel('What happens in your story?').fill(draft.plot);
    await page.getByRole('button',{name:'Start creating →'}).click();await expect(page).toHaveURL(/\/comics\/mock-comic/);
    await expect.poll(()=>requests.filter(item=>item.action==='initialQuestions').length).toBe(1);
    const firstQuestionKey=requests.find(item=>item.action==='initialQuestions')!.requestKey;
    await page.reload();
    const second=await context.newPage();await second.goto('/comics/mock-comic');
    await expect.poll(()=>requests.filter(item=>item.action==='initialQuestions').length).toBe(1);
    expect(firstQuestionKey).toBe('auto:initialQuestions:mock-comic');
    releaseQuestions=true;
    await expect(page.getByLabel('Who receives the key?')).toBeVisible({timeout:15000});
    await expect(page.getByLabel('Who receives the key?')).toHaveAttribute('placeholder','Her brother');
    await expect(page.getByRole('button',{name:'Review and add'})).toBeVisible({timeout:15000});
    expect(new Set(requests.filter(item=>item.action==='suggestCharacters').map(item=>item.requestKey)).size).toBe(1);
    await second.close();
    await page.getByRole('button',{name:'Review and add'}).click();await page.getByRole('button',{name:'Add character',exact:true}).click();
    await expect.poll(()=>requests.filter(item=>item.action==='generateReference').length).toBe(1);
    await page.reload();releaseReference=true;
    await expect(page.getByAltText('Reference for Mina')).toBeVisible({timeout:15000});
    expect(requests.filter(item=>item.action==='generateReference')).toHaveLength(1);
    expect(requests.filter(item=>item.action==='approveCharacter')).toHaveLength(0);
    await page.getByRole('button',{name:'Approve',exact:true}).click();await expect(page.getByText('Approved',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Plan story →'}).click();await expect(page.getByRole('region',{name:'Story beats'}).getByText('Here it is')).toBeVisible();
    await expect(page.getByRole('button',{name:'Generate page',exact:true})).toBeDisabled();
    expect(requests.filter(item=>item.action==='approveStory')).toHaveLength(0);
    await page.getByRole('button',{name:'Approve story',exact:true}).click();await expect(page.getByText('Story approved for drawing.')).toBeVisible();
    await page.getByRole('button',{name:'Generate page',exact:true}).click();await expect(page.getByText('Check: blocker')).toBeVisible();
    expect(requests.find(item=>item.action==='generatePage')?.input.intent).toBe('generate');
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Accept and continue'}).click();await expect(page.getByText('Check: blocker · Accepted')).toBeVisible();
    const accepted=requests.find(item=>item.action==='acceptPanel');expect(accepted?.input).toMatchObject({panelId:'panel-1',assetId:panelImage,storyRevision:1,panelRevision:2});
    await page.getByRole('button',{name:'Prepare download'}).click();const download=page.getByRole('link',{name:'Download page'});await expect(download).toHaveAttribute('href',/\/api\/operations\/op-\d+\/export/);
    await page.getByRole('button',{name:'Publish',exact:true}).click();await page.getByRole('button',{name:'Publish comic'}).click();await expect(page.getByText('Published! Your comic is now on the community shelf.')).toBeVisible();
    expect(requests.find(item=>item.action==='publish')?.input.expectedEditionId).toBeNull();
  } finally {await context.close();}
});

test('unknown paid outcome is restored without a second generation',async({page})=>{
  let posts=0;
  const draft={id:'unknown-comic',title:'Unknown',plot:'A courier carries a key.',style:'ink-manga',revision:5,storyRevision:1,characters:[],questions:[],answers:{},initialQuestions:'complete',initialSuggestions:'complete',storyApproval:{storyRevision:1,fingerprint:'b'.repeat(64),approved:true},pages:[{id:'page-1',index:1,status:'planned',panels:[{id:'panel-1',description:'Find key',status:'planned',evaluation:'pending'}]}]};
  await page.route('**/api/comics/unknown-comic',route=>route.fulfill({json:{comic:draft}}));
  await page.route('**/api/operations**',route=>{if(route.request().method()==='POST'){posts++;return route.fulfill({status:202,json:{id:'unknown-op',status:'queued',comicId:'unknown-comic'}});}if(new URL(route.request().url()).pathname==='/api/operations')return route.fulfill({json:{operations:posts?[{id:'unknown-op',action:'generatePage',comicId:'unknown-comic',pageId:'page-1',status:'unknown_outcome'}]:[]}});return route.fulfill({json:{id:'unknown-op',action:'generatePage',comicId:'unknown-comic',status:'unknown_outcome'}});});
  await page.goto('/comics/unknown-comic');await page.getByRole('button',{name:'Generate page',exact:true}).click();
  await expect(page.getByRole('region',{name:'Draft operations'}).getByText(/outcome is unknown/i)).toBeVisible();
  await page.reload();await expect(page.getByRole('region',{name:'Draft operations'}).getByText(/outcome is unknown/i)).toBeVisible();
  await page.getByRole('button',{name:'Generate page',exact:true}).click();expect(posts).toBe(1);
});

test('a known failed redraw requires an explicit resume with a new request key',async({page})=>{
  const sent:{requestKey:string;input:{intent:string}}[]=[];
  const version={assetId:'22222222-2222-4222-8222-222222222222',storyRevision:1,panelRevision:2};
  const draft:any={id:'retry-comic',title:'Retry',plot:'A courier carries a key.',style:'ink-manga',revision:5,storyRevision:1,characters:[],questions:[],answers:{},initialQuestions:'complete',initialSuggestions:'complete',storyApproval:{storyRevision:1,fingerprint:'b'.repeat(64),approved:true},pages:[{id:'page-1',index:1,status:'current',generationPending:false,panels:[{id:'panel-1',description:'Find key',imageUrl:'/panel.png',status:'current',evaluation:'pass',reviewVersion:version}]}]};
  await page.route('**/api/comics/retry-comic',route=>route.fulfill({json:{comic:draft}}));
  await page.route('**/api/operations**',route=>{
    if(route.request().method()==='POST'){sent.push(route.request().postDataJSON());return route.fulfill({status:202,json:{id:`attempt-${sent.length}`,status:'queued',comicId:'retry-comic'}});}
    if(new URL(route.request().url()).pathname==='/api/operations')return route.fulfill({json:{operations:[]}});
    const first=route.request().url().endsWith('/attempt-1');draft.pages[0].generationPending=first;return route.fulfill({json:{id:first?'attempt-1':'attempt-2',action:'generatePage',comicId:'retry-comic',status:first?'failed':'succeeded',...(first?{error:'Drawing stopped safely.'}:{result:{}})}});
  });
  await page.goto('/comics/retry-comic');await page.getByRole('button',{name:'Regenerate page',exact:true}).click();
  await expect(page.getByRole('region',{name:'Draft operations'}).getByText(/Drawing stopped safely/)).toBeVisible();expect(sent).toHaveLength(1);expect(sent[0].input.intent).toBe('regenerate');
  await page.getByRole('button',{name:'Continue page',exact:true}).click();await expect.poll(()=>sent.length).toBe(2);
  expect(sent[1].input.intent).toBe('resume');expect(sent[1].requestKey).not.toBe(sent[0].requestKey);
});

test('a job started by another client is discovered and followed without a duplicate start',async({page})=>{
  let posts=0,release=false;
  const draft:any={id:'cross-comic',title:'Shared',plot:'A courier carries a key.',style:'ink-manga',revision:1,storyRevision:1,characters:[],questions:[],answers:{},initialQuestions:'pending',initialSuggestions:'complete',pages:[]};
  await page.route('**/api/comics/cross-comic',route=>route.fulfill({json:{comic:draft}}));
  await page.route('**/api/operations**',route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='POST'){posts++;return route.fulfill({status:500,json:{error:'Unexpected duplicate'}});}
    if(url.pathname==='/api/operations')return route.fulfill({json:{operations:[{id:'remote-op',action:'initialQuestions',comicId:'cross-comic',status:'running',expectedRevision:1}]}});
    if(!release)return route.fulfill({json:{id:'remote-op',action:'initialQuestions',comicId:'cross-comic',status:'running'}});
    draft.initialQuestions='complete';draft.questions=[{id:'q',question:'Who receives the key?',suggestedAnswer:'Her sister'}];draft.revision=2;
    return route.fulfill({json:{id:'remote-op',action:'initialQuestions',comicId:'cross-comic',status:'succeeded',result:{}}});
  });
  await page.goto('/comics/cross-comic');await expect(page.getByRole('region',{name:'Draft operations'})).toContainText('Story questions');
  expect(posts).toBe(0);release=true;
  await expect(page.getByLabel('Who receives the key?')).toBeVisible({timeout:15000});expect(posts).toBe(0);
});

test('a new tab can recover a previously started draft without enqueueing another',async({page})=>{
  let posts=0;
  await page.addInitScript(()=>{localStorage.setItem('comex:browser-operation:workspace-a:prior-create',JSON.stringify({workspaceId:'workspace-a',requestKey:'prior-create',id:'prior-op',action:'create',status:'running',input:{title:'Recovered',plot:'A courier carries a key.',style:'ink-manga'}}));sessionStorage.removeItem('comex:active-create');});
  await page.route('**/api/operations**',route=>{if(route.request().method()==='POST'){posts++;return route.fulfill({status:500,json:{error:'Unexpected duplicate'}});}if(new URL(route.request().url()).pathname==='/api/operations')return route.fulfill({json:{operations:[]}});return route.fulfill({json:{id:'prior-op',action:'create',comicId:'recovered',status:'succeeded',result:{comic:{id:'recovered'}}}});});
  await page.route('**/api/comics/recovered',route=>route.fulfill({json:{comic:{id:'recovered',title:'Recovered',plot:'A courier carries a key.',style:'ink-manga',revision:1,storyRevision:1,characters:[],questions:[],answers:{},initialQuestions:'complete',initialSuggestions:'complete',pages:[]}}}));
  await page.goto('/create');await expect(page.getByText('A previous draft request is available. Check it to continue that draft.')).toBeVisible();
  await page.getByRole('button',{name:'Check draft request'}).click();await expect(page).toHaveURL(/\/comics\/recovered/);expect(posts).toBe(0);
});

test('an old failed job does not turn a completed page redraw into a resume',async({page})=>{
  const sent:any[]=[];
  const draft={id:'completed-comic',title:'Completed',plot:'A courier carries a key.',style:'ink-manga',revision:9,storyRevision:1,characters:[],questions:[],answers:{},initialQuestions:'complete',initialSuggestions:'complete',storyApproval:{storyRevision:1,fingerprint:'b'.repeat(64),approved:true},pages:[{id:'page-1',index:1,status:'current',generationPending:false,panels:[{id:'panel-1',imageUrl:'/panel.png',status:'current',evaluation:'pass'}]}]};
  await page.route('**/api/comics/completed-comic',route=>route.fulfill({json:{comic:draft}}));
  await page.route('**/api/operations**',route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='POST'){sent.push(req.postDataJSON());return route.fulfill({status:202,json:{id:'new-op',action:'generatePage',comicId:'completed-comic',status:'queued'}});}
    if(url.pathname==='/api/operations')return route.fulfill({json:{operations:[{id:'old-op',action:'generatePage',comicId:'completed-comic',pageId:'page-1',status:'failed'}]}});
    const old=url.pathname.endsWith('/old-op');return route.fulfill({json:{id:old?'old-op':'new-op',action:'generatePage',comicId:'completed-comic',status:old?'failed':'succeeded'}});
  });
  await page.goto('/comics/completed-comic');await page.getByRole('button',{name:'Regenerate page',exact:true}).click();
  await expect.poll(()=>sent.length).toBe(1);expect(sent[0].input.intent).toBe('regenerate');
});

test('a lost create acknowledgement stays private across sign-out and account switching',async({page})=>{
  let workspace='workspace-a',posts=0,lookup=0;
  await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{email:workspace+'@example.test'},guest:null,workspaceId:workspace}}));
  await page.route('**/api/auth/sign-out',route=>{workspace='workspace-b';return route.fulfill({json:{ok:true}});});
  await page.route('**/api/operations**',route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='POST'){posts++;expect(req.postDataJSON().expectedWorkspaceId).toBe('workspace-a');return route.abort();}
    if(url.searchParams.has('requestKey')){lookup++;expect(workspace).toBe('workspace-a');return route.fulfill({json:{operation:{id:'lost-op',action:'create',status:'unknown_outcome'}}});}
    return route.fulfill({json:{id:'lost-op',action:'create',status:'unknown_outcome'}});
  });
  await page.route('**/api/published**',route=>route.fulfill({json:{comics:[]}}));
  await page.goto('/create');await page.getByLabel('Give your comic a title').fill('Secret title');await page.getByLabel('What happens in your story?').fill('Secret story about a courier.');
  await page.getByRole('button',{name:'Start creating →'}).click();await expect.poll(()=>posts).toBe(1);
  await page.getByRole('button',{name:'Sign out workspace-a@example.test'}).click();await page.waitForURL('**/');await page.goto('/create');
  await expect(page.getByLabel('Give your comic a title')).toHaveValue('');
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('Secret');expect(posts).toBe(1);expect(lookup).toBe(0);
  workspace='workspace-a';await page.reload();
  await expect(page.getByRole('button',{name:'Check draft request'})).toBeVisible();await page.getByRole('button',{name:'Check draft request'}).click();
  await expect(page.getByText(/could not be confirmed/i)).toBeVisible();expect(lookup).toBe(1);expect(posts).toBe(1);
});

test('a late response in another tab cannot restore redacted input',async({browser})=>{
  const context=await browser.newContext(),first=await context.newPage();let workspace='workspace-a',release!:()=>void,started!:()=>void;
  const requestStarted=new Promise<void>(resolve=>{started=resolve;}),waitForRelease=new Promise<void>(resolve=>{release=resolve;});
  await context.route('**/api/auth/session',route=>route.fulfill({json:{user:{email:workspace+'@example.test'},guest:null,workspaceId:workspace}}));
  await context.route('**/api/operations**',async route=>{if(route.request().method()==='POST'){started();await waitForRelease;return route.fulfill({status:202,json:{id:'late-op',status:'queued'}});}return route.fulfill({json:{operations:[]}});});
  try {
    await first.goto('/create');await first.getByLabel('Give your comic a title').fill('Private title');await first.getByLabel('What happens in your story?').fill('Private story for this browser.');
    await first.getByRole('button',{name:'Start creating →'}).click();await requestStarted;
    workspace='workspace-b';const second=await context.newPage();await second.goto('/create');await expect(second.getByLabel('Give your comic a title')).toHaveValue('');
    await expect(first.getByLabel('Give your comic a title')).toHaveValue('');release();
    await expect.poll(()=>first.evaluate(()=>JSON.stringify(localStorage))).not.toContain('Private');
  } finally {release();await context.close();}
});

test('a redacted lost request rejects changed input and reuses its key after re-entry',async({page})=>{
  let workspace='workspace-a';const posts:any[]=[];
  await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{email:workspace+'@example.test'},guest:null,workspaceId:workspace}}));
  await page.route('**/api/operations**',route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='POST'){posts.push(req.postDataJSON());return posts.length===1 ? route.abort() : route.fulfill({status:202,json:{id:'recovered-op',status:'queued'}});}
    if(url.searchParams.has('requestKey'))return route.fulfill({status:404,json:{error:'Not found'}});
    if(url.pathname==='/api/operations')return route.fulfill({json:{operations:[]}});
    return route.fulfill({json:{id:'recovered-op',action:'create',comicId:'recovered',status:'succeeded',result:{comic:{id:'recovered'}}}});
  });
  await page.route('**/api/comics/recovered',route=>route.fulfill({json:{comic:{id:'recovered',title:'Original title',plot:'Original story for the draft.',style:'clear-line-adventure',revision:1,storyRevision:1,characters:[],questions:[],answers:{},initialQuestions:'complete',initialSuggestions:'complete',pages:[]}}}));
  await page.goto('/create');await page.getByLabel('Give your comic a title').fill('Original title');await page.getByLabel('What happens in your story?').fill('Original story for the draft.');
  await page.getByRole('button',{name:'Start creating →'}).click();await expect.poll(()=>posts.length).toBe(1);
  workspace='workspace-b';await page.reload();await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('comex:browser-workspace') || '{}').id)).toBe('workspace-b');await expect(page.getByLabel('Give your comic a title')).toHaveValue('');
  workspace='workspace-a';await page.reload();await expect(page.getByText(/Re-enter the original input/i)).toBeVisible();
  await page.getByLabel('Give your comic a title').fill('Changed title');await page.getByLabel('What happens in your story?').fill('Original story for the draft.');
  await page.getByRole('button',{name:'Start creating →'}).click();await expect(page.getByText(/does not match the original request/i)).toBeVisible();expect(posts).toHaveLength(1);
  await page.getByLabel('Give your comic a title').fill('Original title');await page.getByRole('button',{name:'Start creating →'}).click();
  await expect(page).toHaveURL(/\/comics\/recovered/);expect(posts).toHaveLength(2);expect(posts[1].requestKey).toBe(posts[0].requestKey);
});
