import * as fs from 'node:fs/promises';
import path from 'node:path';

export const maxReferences = 8;
const maxReferenceBytes = 10 * 1024 * 1024;
const maxTotalBytes = 40 * 1024 * 1024;
const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export async function prepareReferences(directory, job) {
  if (directory === undefined || directory === '') return { images: [], total: 0 };
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
    throw new Error('Choose an absolute reference folder path.');
  }
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { throw new Error('Reference folder is unavailable. Choose it again or clear references.'); }
  const names = [];
  for (const entry of entries) {
    if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
    if (entry.isFile() || (entry.isSymbolicLink() && (await fs.stat(path.join(directory, entry.name))).isFile())) names.push(entry.name);
  }
  names.sort();
  if (!names.length) throw new Error('Reference folder has no PNG, JPEG, or WebP images. Choose another folder or clear references.');
  const target = path.join(job, 'references');
  await fs.mkdir(target, { mode: 0o700 });
  const images = [];
  let totalBytes = 0;
  for (const [index, name] of names.slice(0, maxReferences).entries()) {
    const source = path.join(directory, name);
    const info = await fs.stat(source);
    if (info.size > maxReferenceBytes) throw new Error(`Reference image exceeds 10 MB: ${name}`);
    const data = await fs.readFile(source);
    totalBytes += data.length;
    if (data.length > maxReferenceBytes || totalBytes > maxTotalBytes) {
      throw new Error('Style references exceed 10 MB per image or 40 MB total. Use smaller reference images.');
    }
    const extension = path.extname(name).toLowerCase();
    const valid = extension === '.png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : extension === '.webp' ? data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
      : data[0] === 255 && data[1] === 216 && data[2] === 255;
    if (!valid) throw new Error(`Reference file is not a valid ${extension.slice(1).toUpperCase()} image: ${name}`);
    const snapshot = path.join(target, `${index + 1}${extension}`);
    await fs.writeFile(snapshot, data, { mode: 0o600 });
    images.push({ name, path: snapshot });
  }
  return { images, total: names.length };
}
