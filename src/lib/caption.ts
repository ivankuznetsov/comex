import sharp, {type OverlayOptions} from 'sharp';
import {join} from 'node:path';
import {ApplicationError} from './application/contracts';

// Bundled OFL comic lettering, including Cyrillic, works without OS fonts.
// Keep dialogue at 44 px: ~14.5 CSS px on a 390 px phone.
export const captionFontSize = 44;
export type CaptionLine = {speaker:string;text:string};
const ink='#211d19',paper='#fffef8';
function markup(value:string):string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value))
    throw new ApplicationError('invalid_input','Dialogue includes a character that cannot be rendered.');
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
async function lettering(text:string,width:number,size:number) {
  return sharp({text:{text:`<span foreground="${ink}">${markup(text)}</span>`,
    font:`Pangolin ${size}`,fontfile:join(process.cwd(),'assets/fonts/Pangolin-Regular.ttf'),
    width,align:'centre',wrap:'word-char',spacing:5,rgba:true,
  }}).png().toBuffer({resolveWithObject:true});
}

/** Separate balloons preserve dialogue order and speaker attribution. Never cover art. */
export async function renderCaption(dialogue:(CaptionLine|string)[], width:number):Promise<{image:Buffer;height:number}|null> {
  if (!dialogue.length) return null;
  const maxWidth=width-32,padX=32,padY=22;
  const blocks=[];
  let height=16;
  for(const entry of dialogue) {
    const line=typeof entry==='string'?{speaker:'',text:entry}:entry;
    const text=await lettering(line.text,maxWidth-padX*2,captionFontSize);
    const label=line.speaker?await lettering(line.speaker.toLocaleUpperCase(),maxWidth-padX*2,28):null;
    const w=Math.max(160,Math.max(text.info.width,label?.info.width??0)+padX*2);
    const bodyHeight=text.info.height+(label?label.info.height+12:0)+padY*2;
    const h=bodyHeight+18; // Tail points into the lettering gutter, not over the artwork.
    height+=h+16;
    if(height>12000)throw new ApplicationError('invalid_input','The page has too much dialogue to compose.');
    blocks.push({text,label,w,h,bodyHeight});
  }
  const layers:OverlayOptions[]=[];
  let y=16;
  for(let i=0;i<blocks.length;i++) {
    const {text,label,w,h,bodyHeight}=blocks[i];
    const x=i%2?width-16-w:16;
    const r=Math.min(48,bodyHeight/2),right=w-3,bottom=h-3,left=3,top=18;
    const tail=i%2?w-76:76;
    // One continuous ink contour: rounded balloon with a short, open-top tail.
    const outline=`M ${left+r} ${top} H ${tail-14} Q ${tail-10} 8 ${tail-16} 3 Q ${tail+8} 8 ${tail+14} ${top} H ${right-r} Q ${right} ${top} ${right} ${top+r} V ${bottom-r} Q ${right} ${bottom} ${right-r} ${bottom} H ${left+r} Q ${left} ${bottom} ${left} ${bottom-r} V ${top+r} Q ${left} ${top} ${left+r} ${top} Z`;
    const balloon=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="${outline}" fill="white" stroke="${ink}" stroke-width="3.5" stroke-linejoin="round"/></svg>`);
    layers.push({input:balloon,left:x,top:y});
    let textY=y+18+padY;
    if(label){layers.push({input:label.data,left:x+Math.floor((w-label.info.width)/2),top:textY});textY+=label.info.height+12;}
    layers.push({input:text.data,left:x+Math.floor((w-text.info.width)/2),top:textY});
    y+=h+16;
  }
  const image=await sharp({create:{width,height,channels:4,background:paper}}).composite(layers).png().toBuffer();
  return {image,height};
}
