import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export const defaultRoot = path.join(os.homedir(), 'aseprite-bridge-data');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const missing = error => error.code === 'ENOENT';

async function readHeartbeat(root) {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(await fs.readFile(path.join(root, 'heartbeat.json'), 'utf8')); }
    catch (error) {
      if (!missing(error) || attempt === 3) throw error;
      await sleep(25);
    }
  }
}

export async function findAseprite() {
  if (process.env.ASEPRITE_BIN) return process.env.ASEPRITE_BIN;
  const homes = [
    '.steam/steam', '.local/share/Steam',
    'snap/steam/common/.local/share/Steam',
    '.var/app/com.valvesoftware.Steam/.local/share/Steam',
  ].map(p => path.join(os.homedir(), p));
  for (const home of [...homes]) {
    try {
      const vdf = await fs.readFile(path.join(home, 'steamapps/libraryfolders.vdf'), 'utf8');
      for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) homes.push(match[1]);
    } catch (error) { if (!missing(error)) throw error; }
  }
  const candidates = [
    ...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'aseprite')),
    ...homes.map(p => path.join(p, 'steamapps/common/Aseprite/aseprite')),
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('Aseprite not found. Set ASEPRITE_BIN to the Linux executable.');
}

export class Bridge {
  constructor({ root = process.env.ASEPRITE_BRIDGE_DIR || defaultRoot, timeout = 15000 } = {}) {
    this.root = path.resolve(root);
    this.timeout = timeout;
    this.tail = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.root);
    if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error('Bridge directory must be owned by this user and must not be a symlink.');
    await fs.chmod(this.root, 0o700);
  }

  async status() {
    let live = null;
    try {
      live = await readHeartbeat(this.root);
      live.connected = Date.now() / 1000 - live.time < 5;
    } catch (error) { if (!missing(error)) throw error; }
    let binary = null, version = null, batchError = null;
    try {
      binary = await findAseprite();
      version = (await exec(binary, ['--version'], { timeout: 5000 })).stdout.trim();
    } catch (error) { batchError = error.message; }
    return { directory: this.root, live: live || { connected: false }, binary, version, batchError,
      help: 'In Aseprite: File > Scripts > codex-bridge. Keep its connection dialog open.' };
  }

  async request(payload, mode = 'live') {
    // Serialize each MCP client's operations; independent clients have distinct job IDs.
    const result = this.tail.then(() => this.#request(payload, mode));
    this.tail = result.catch(() => {});
    return result;
  }

  async #request(payload, mode) {
    await this.init();
    const job = await fs.mkdtemp(path.join(this.root, mode === 'batch' ? 'batch-' : 'job-'));
    let cleanup = true;
    try {
      let session;
      if (mode === 'live') {
        let heartbeat;
        try { heartbeat = await readHeartbeat(this.root); }
        catch { throw new Error('Live bridge is offline. Run File > Scripts > codex-bridge in Aseprite.'); }
        if (Date.now() / 1000 - heartbeat.time >= 5) throw new Error('Live bridge is offline or busy. Open its connection dialog and try again.');
        session = heartbeat.session;
      }
      const request = { ...payload, id: randomUUID(), session, expires: Math.ceil((Date.now() + this.timeout) / 1000) };
      await fs.writeFile(path.join(job, 'request.tmp'), JSON.stringify(request), { mode: 0o600 });
      await fs.rename(path.join(job, 'request.tmp'), path.join(job, 'request.json'));
      if (mode === 'batch') {
        const binary = await findAseprite();
        await exec(binary, ['--batch', '--script-param', `job=${job}`, '--script', path.join(projectDir, 'aseprite/batch.lua')],
          { timeout: this.timeout, maxBuffer: 1024 * 1024 });
      }
      const deadline = Date.now() + this.timeout;
      while (true) {
        try {
          const result = JSON.parse(await fs.readFile(path.join(job, 'response.json'), 'utf8'));
          if (!result.ok) throw new Error(result.error || 'Aseprite operation failed');
          if (payload.op === 'preview') {
            const png = await fs.readFile(path.join(job, 'preview.png'));
            if (png.length > 10 * 1024 * 1024) throw new Error('Preview exceeds 10 MB; use a smaller scale or sprite.');
            return { ...result, png: png.toString('base64') };
          }
          return result;
        } catch (error) { if (!missing(error)) throw error; }
        if (Date.now() >= deadline) {
          // Removing the request cancels it only if the Lua side hasn't claimed it.
          try { await fs.unlink(path.join(job, 'request.json')); }
          catch (error) { if (!missing(error)) throw error; cleanup = false; }
          throw new Error(cleanup
            ? 'Aseprite did not pick up the request; it was cancelled. Check the bridge dialog and any script permission prompts.'
            : `Aseprite claimed the request but did not finish in time. Outcome unknown; inspect the sprite before retrying. Job: ${job}`);
        }
        await sleep(75);
      }
    } finally {
      if (cleanup) await fs.rm(job, { recursive: true, force: true });
    }
  }
}
