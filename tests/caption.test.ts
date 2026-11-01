import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {renderCaption} from '../src/lib/caption';

test('bundled font renders distinct Latin and Cyrillic glyphs with no system fonts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'comex-font-test-'));
  try {
    await mkdir(join(dir,'empty'));
    await writeFile(join(dir,'fonts.conf'),`<fontconfig><dir>${dir}/empty</dir><cachedir>${dir}/cache</cachedir></fontconfig>`);
    const code=`import {renderCaption} from './src/lib/caption'; import {createHash} from 'node:crypto'; import sharp from 'sharp'; const out=[]; for(const s of ['iiii','WWWW','ииии','ШШШШ']) {const r=await renderCaption([s],980);const {data,info}=await sharp(r.image).raw().toBuffer({resolveWithObject:true});let right=24;for(let y=24;y<info.height-24;y++)for(let x=24;x<info.width-24;x++)if(data[(y*info.width+x)*info.channels]<100)right=Math.max(right,x);out.push({height:r.height,inkWidth:right-24,hash:createHash('sha256').update(r.image).digest('hex')});} console.log(JSON.stringify(out));`;
    const run=async(empty:boolean)=>{
      const proc=Bun.spawn([process.execPath,'-e',code],{cwd:process.cwd(),env:{...process.env,...(empty?{FONTCONFIG_FILE:join(dir,'fonts.conf')}:{})},stdout:'pipe',stderr:'pipe'});
      const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();
      expect(await proc.exited,error).toBe(0);return JSON.parse(output);
    };
    const normal=await run(false),isolated=await run(true);
    // Fontconfig hinting can change antialiasing and height by a pixel. Check
    // recognizable variable-width glyphs, not identical platform raster bytes.
    // Balloon padding is fixed; wide glyphs must still make a wider balloon.
    expect(isolated[1].inkWidth-isolated[0].inkWidth).toBeGreaterThan(40);
    for(let i=0;i<normal.length;i++) {
      expect(Math.abs(normal[i].inkWidth-isolated[i].inkWidth)).toBeLessThan(5);
      expect(Math.abs(normal[i].height-isolated[i].height)).toBeLessThan(3);
    }
    expect(new Set(isolated.map((x:{hash:string})=>x.hash)).size).toBe(4);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('pixel wrapping handles long text and escapes literal markup',async()=>{
  const short=await renderCaption(['Nora: Hello!'],480);
  const long=await renderCaption(['Нора: '+ 'Очень длинная реплика & <b>обычный текст</b> '.repeat(6),'Pip: '+ 'W'.repeat(90)],480);
  expect(long!.height).toBeGreaterThan(short!.height);
  const meta=await sharp(long!.image).metadata();expect(meta.width).toBe(480);expect(meta.height).toBe(long!.height);
  expect(await renderCaption([],980)).toBeNull();
  expect(renderCaption(['bad\u0000text'],980)).rejects.toThrow('cannot be rendered');
});

test('speaker names and long multilingual dialogue wrap in separate balloons',async()=>{
  const line={speaker:'Нора & <Pip> '.repeat(8),text:'Подожди! The last star is ours. '.repeat(12)};
  for(const width of [480,980]) {
    const one=await renderCaption([line],width);
    const two=await renderCaption([line,{speaker:'Pip',text:'I will stay.'}],width);
    expect(two!.height).toBeGreaterThan(one!.height);
    expect((await sharp(two!.image).metadata()).width).toBe(width);
    expect(two!.height).toBeLessThan(12000);
  }
  expect(renderCaption([{speaker:'bad\u0000name',text:'Hello'}],480)).rejects.toThrow('cannot be rendered');
});
