import sharp from 'sharp';
import {join} from 'node:path';
import {ApplicationError} from './application/contracts';

// An explicit font file is required: serverless runtimes need not have OS fonts.
// 44 px remains ~14.5 CSS px when a 1020 px page fits a 390 px phone.
export const captionFontSize = 44;
const padding = 24;
function markup(value:string):string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value))
    throw new ApplicationError('invalid_input','Dialogue includes a character that cannot be rendered.');
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

/** Pango wraps by actual glyph widths; user dialogue is escaped, never markup. */
export async function renderCaption(dialogue:string[], width:number):Promise<{image:Buffer;height:number}|null> {
  if (!dialogue.length) return null;
  const {data,info} = await sharp({text:{
    text:`<span foreground="#171717">${dialogue.map(markup).join('\n')}</span>`,
    font:`Liberation Sans ${captionFontSize}`,
    fontfile:join(process.cwd(),'assets/fonts/LiberationSans-Regular.ttf'),
    width:width-padding*2, wrap:'word-char', spacing:8, rgba:true,
  }}).png().toBuffer({resolveWithObject:true});
  const height = info.height + padding*2;
  if (height > 12000) throw new ApplicationError('invalid_input','The page has too much dialogue to compose.');
  const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="1.5" y="1.5" width="${width-3}" height="${height-3}" fill="white" stroke="#171717" stroke-width="3"/></svg>`);
  const image = await sharp(background).composite([{input:data,left:padding,top:padding}]).png().toBuffer();
  return {image,height};
}
