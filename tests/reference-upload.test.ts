import {expect, test} from 'bun:test';
import sharp from 'sharp';
import {normalizeReference, readReferenceForm} from '../src/lib/reference-upload';

test('normalizes static JPEG and transparent WebP into PNG', async () => {
  const jpeg = await sharp({create:{width:4,height:8,channels:3,background:'#d40'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const normalized = await normalizeReference(new File([Uint8Array.from(jpeg)],'portrait.jpg',{type:'image/jpeg'}));
  const meta = await sharp(normalized).metadata();
  expect(meta.format).toBe('png'); expect(meta.width).toBe(8); expect(meta.height).toBe(4); expect(meta.exif).toBeUndefined();
  const webp = await sharp({create:{width:3,height:3,channels:4,background:{r:1,g:2,b:3,alpha:0.25}}}).webp().toBuffer();
  const result = await normalizeReference(new File([Uint8Array.from(webp)],'transparent.webp',{type:'image/webp'}));
  expect((await sharp(result).metadata()).hasAlpha).toBe(true);
});

test('rejects malformed, mislabeled, oversized, and animated PNG input', async () => {
  const png = await sharp({create:{width:3,height:3,channels:3,background:'#fff'}}).png().toBuffer();
  await expect(normalizeReference(new File([Uint8Array.from(png)],'wrong.jpg',{type:'image/jpeg'}))).rejects.toThrow('does not match');
  await expect(normalizeReference(new File([new Uint8Array([1,2,3])],'bad.png',{type:'image/png'}))).rejects.toThrow();
  await expect(normalizeReference(new File([new Uint8Array(4*1024*1024+1)],'large.png',{type:'image/png'}))).rejects.toThrow('4 MiB');
  const animation = Buffer.concat([png.subarray(0,8),Buffer.from([0,0,0,0,97,99,84,76,0,0,0,0]),png.subarray(8)]);
  await expect(normalizeReference(new File([Uint8Array.from(animation)],'animated.png',{type:'image/png'}))).rejects.toThrow('Animated');
});

test('bounds multipart bytes without trusting a content-length header', async () => {
  const form = new FormData(); form.set('image',new File([new Uint8Array(4*1024*1024+300*1024)],'large.png',{type:'image/png'}));
  const request = new Request('http://localhost/upload',{method:'POST',body:form});
  await expect(readReferenceForm(request)).rejects.toThrow('too large');
  const dishonest = new Request('http://localhost/upload',{method:'POST',headers:{'content-length':'1'},body:form});
  await expect(readReferenceForm(dishonest)).rejects.toThrow('too large');
});
