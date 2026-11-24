import * as fs from 'node:fs/promises';
import path from 'node:path';

export const defaultReferenceLimit = 8;
const maxReferenceBytes = 10 * 1024 * 1024;
const maxTotalBytes = 40 * 1024 * 1024;
const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const maxFolderDepth = 64;

export async function prepareReferences(directory, job, { limit = defaultReferenceLimit, files } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Reference image limit must be a positive integer.');
  if (files !== undefined && (!Array.isArray(files) || !files.length || files.length > limit)) {
    throw new Error('Choose at least one reference image, up to the selected image limit.');
  }
  if (directory === undefined || directory === '') return { images: [], total: 0 };
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
    throw new Error('Choose an absolute reference folder path.');
  }
  const names = [];
  const visited = new Set();
  async function collect(folder, depth) {
    if (depth > maxFolderDepth) return;
    const real = await fs.realpath(folder);
    if (visited.has(real)) return;
    visited.add(real);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const source = path.join(folder, entry.name);
      const info = entry.isSymbolicLink() ? await fs.stat(source) : entry;
      if (info.isDirectory()) await collect(source, depth + 1);
      else if (info.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        names.push(path.relative(directory, source));
      }
    }
  }
  try { await collect(directory, 0); }
  catch { throw new Error('Reference folder or a subfolder is unavailable. Choose it again or clear references.'); }
  names.sort();
  if (!names.length) throw new Error('Reference folder and its subfolders have no PNG, JPEG, or WebP images. Choose another folder or clear references.');
  let selected = names.slice(0, limit);
  if (files !== undefined) {
    const available = new Set(names);
    const seen = new Set();
    for (const name of files) {
      if (typeof name !== 'string' || path.isAbsolute(name) || name.includes('\0') ||
          name.split(/[\\/]/).includes('..') || !available.has(name)) {
        throw new Error(`Selected reference image is unavailable. Select images again: ${name}`);
      }
      if (seen.has(name)) throw new Error(`Reference image selected more than once: ${name}`);
      seen.add(name);
    }
    selected = files;
  }
  const target = path.join(job, 'references');
  await fs.mkdir(target, { mode: 0o700 });
  const images = [];
  let totalBytes = 0;
  for (const [index, name] of selected.entries()) {
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
