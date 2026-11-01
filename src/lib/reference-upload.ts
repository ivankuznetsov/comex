import sharp from 'sharp';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_REQUEST = MAX_FILE + 256 * 1024;
const MAX_PIXELS = 16_777_216;
const MAX_OUTPUT = 16 * 1024 * 1024;

export class UploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function readReferenceForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new UploadError(415, 'Send a reference image as a form upload.');
  const reader = request.body?.getReader();
  if (!reader) throw new UploadError(400, 'Choose an image to upload.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST) { await reader.cancel(); throw new UploadError(413, 'The upload is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    return await new Response(Buffer.concat(chunks), {headers:{'content-type':contentType}}).formData();
  } catch { throw new UploadError(400, 'The upload form is invalid.'); }
}

function hasAnimationChunk(bytes: Buffer): boolean {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (!bytes.subarray(0,8).equals(signature)) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new UploadError(400, 'The PNG image is invalid.');
    if (bytes.toString('ascii',offset+4,offset+8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}

export async function normalizeReference(file: File): Promise<Buffer> {
  if (!file.size) throw new UploadError(400, 'Choose a non-empty image.');
  if (file.size > MAX_FILE) throw new UploadError(413, 'Choose an image smaller than 4 MiB.');
  const formats: Record<string,string> = {'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'};
  if (!formats[file.type]) throw new UploadError(400, 'Choose a PNG, JPEG, or WebP image.');
  const bytes = Buffer.from(await file.arrayBuffer());
  if (hasAnimationChunk(bytes)) throw new UploadError(400, 'Animated images are not supported.');
  try {
    const input = sharp(bytes, {failOn:'warning', limitInputPixels:MAX_PIXELS, animated:true});
    const metadata = await input.metadata();
    if (metadata.format !== formats[file.type]) throw new UploadError(400, 'The image type does not match its contents.');
    if ((metadata.pages ?? 1) > 1) throw new UploadError(400, 'Animated images are not supported.');
    const output = await input.rotate().resize({width:4096,height:4096,fit:'inside',withoutEnlargement:true}).png().toBuffer();
    if (output.length > MAX_OUTPUT) throw new UploadError(413, 'The normalized image is too large.');
    return output;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(400, 'The image could not be decoded or exceeds the pixel limit.');
  }
}
