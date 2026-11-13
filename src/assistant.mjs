import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Bridge, projectDir, readHeartbeat } from './bridge.mjs';
import { discoverCodexSettings } from './codex-settings.mjs';

const missing = error => error.code === 'ENOENT';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function read(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (!missing(error)) throw error; return null; }
}
async function write(file, value) {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

export function codexArgs(request, root) {
  // Argument arrays and stdin keep user instructions out of the shell.
  const config = {
    approval_policy: 'never', sandbox_mode: 'read-only',
    'mcp_servers.aseprite.command': process.execPath,
    'mcp_servers.aseprite.args': [path.join(projectDir, 'src/server.mjs')],
    'mcp_servers.aseprite.env.ASEPRITE_BRIDGE_DIR': root,
    'mcp_servers.aseprite.env.ASEPRITE_BRIDGE_SESSION': request.session,
    'mcp_servers.aseprite.env.ASEPRITE_TARGET_SPRITE_ID': String(request.sprite_id),
  };
  const args = ['exec', '--json'];
  if (request.effort) config.model_reasoning_effort = request.effort;
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
  if (request.thread_id) args.push('resume', request.thread_id);
  if (request.model) args.push('--model', request.model);
  args.push('-');
  return args;
}

export function instruction(request) {
  return `You are the assistant inside Aseprite. Use the aseprite MCP tools to carry out the user's edit.
The target is live sprite ID ${request.sprite_id}, frame ${request.frame}, layer ${JSON.stringify(request.layer)}.
Always inspect and preview this sprite before editing. Always pass sprite_id=${request.sprite_id}.
Do not edit any other sprite, save, export, close documents, modify project files, or use batch mode.
The user may have made manual edits since the previous turn; inspect the current state again.
Keep edits undoable: use transactions and clone cel images before changing pixels, then assign the clone back.
Respect the selection described below when the user refers to it; do not assume it is still unchanged.
Do not retry a timed-out edit. Inspect first and report uncertainty if its outcome is unknown.
Preview the result when done. Respond with a brief plain-text description of the change.
Context at submission: ${JSON.stringify(request.context)}
User instruction: ${request.prompt}`;
}

export class AssistantWorker {
  constructor({ root, command = process.env.CODEX_BIN || 'codex', timeout = 10 * 60_000,
    spawnProcess = spawn, discoverSettings = discoverCodexSettings } = {}) {
    this.bridge = new Bridge({ root });
    this.root = this.bridge.root;
    this.command = command;
    this.timeout = timeout;
    this.spawnProcess = spawnProcess;
    this.discoverSettings = discoverSettings;
    this.stopped = false;
  }

  async init() {
    await this.bridge.init();
    this.lockPath = path.join(this.root, 'assistant.lock');
    // Recover a dead worker's lock. A live owner always wins.
    try { this.lock = await fs.open(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await read(this.lockPath);
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error('Assistant lock is incomplete. Check for another worker before removing assistant.lock.');
      try { process.kill(owner.pid, 0); throw new Error('An assistant worker is already running.'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await fs.unlink(this.lockPath);
      this.lock = await fs.open(this.lockPath, 'wx', 0o600);
    }
    await this.lock.writeFile(JSON.stringify({ pid: process.pid }));
    try { this.settings = await this.discoverSettings(this.command, projectDir); }
    catch (error) { this.settings = { version: 1, models: [], error: error.message }; }
    await write(path.join(this.root, 'assistant-settings.json'), this.settings);
    await this.heartbeat();
  }

  async heartbeat() {
    await write(path.join(this.root, 'assistant-heartbeat.json'), { time: Date.now() / 1000, pid: process.pid, settings_version: 1 });
  }

  async tick() {
    for (const name of (await fs.readdir(this.root)).sort()) {
      if (this.stopped) return;
      if (!name.startsWith('assistant-job-')) continue;
      const job = path.join(this.root, name);
      if (await read(path.join(job, 'acknowledged.json'))) {
        await fs.rm(job, { recursive: true, force: true });
        continue;
      }
      const pending = path.join(job, 'request.json');
      try { await fs.rename(pending, path.join(job, 'running.json')); }
      catch (error) { if (missing(error)) continue; throw error; }
      let result;
      try {
        const request = await read(path.join(job, 'running.json'));
        if (!request || !Number.isInteger(request.sprite_id) || request.sprite_id <= 0 ||
            typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 8000 ||
            typeof request.session !== 'string' || !(request.expires >= Date.now() / 1000) ||
            (request.thread_id && !/^[a-zA-Z0-9-]{1,100}$/.test(request.thread_id))) {
          throw new Error('Invalid or expired assistant request. Send it again from the panel.');
        }
        const heartbeat = await readHeartbeat(this.root).catch(error => { if (!missing(error)) throw error; return null; });
        if (!heartbeat || heartbeat.session !== request.session || Date.now() / 1000 - heartbeat.time >= 5) {
          throw new Error('The original Aseprite connection is offline.');
        }
        if (await read(path.join(job, 'cancel.json'))) throw new Error('Request cancelled before starting.');
        if (request.model !== undefined || request.effort !== undefined) {
          const model = this.settings.models.find(model => model.id === request.model);
          if (!model) throw new Error('Selected model is unavailable. Restart the helper to refresh the model list.');
          if (model.efforts.length ? !model.efforts.includes(request.effort) : request.effort !== undefined) {
            throw new Error('Selected effort is not supported by this model.');
          }
        }
        result = await this.run(request, job);
      } catch (error) { result = { ok: false, error: error.message }; }
      await write(path.join(job, 'response.json'), result);
    }
  }

  async run(request, job) {
    await write(path.join(job, 'progress.json'), { text: 'Codex is starting...' });
    const child = this.spawnProcess(this.command, codexArgs(request, this.root), {
      cwd: projectDir, env: process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let stderr = '', thread_id = request.thread_id, message = '', failure, stopReason, completed = false;
    let progress = Promise.resolve();
    const publish = text => {
      // Serialize atomic replacements, even when JSONL events arrive together.
      progress = progress.then(() => write(path.join(job, 'progress.json'), { text: text.slice(0, 500) }));
      progress.catch(() => {});
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'thread.started') thread_id = event.thread_id;
      const item = event.item;
      if (item?.type === 'agent_message' && event.type === 'item.completed') {
        message = item.text;
        publish(message);
      } else if (item?.type === 'mcp_tool_call') {
        publish(`Codex: ${item.tool || 'editing sprite'}...`);
      }
      if (event.type === 'turn.failed') failure = event.error?.message || 'Codex could not complete the edit.';
      if (event.type === 'error') failure = event.message || 'Codex reported an error.';
      if (event.type === 'turn.completed') completed = true;
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', () => {}); // Startup failure can close stdin early.
    child.stdin.end(instruction(request));
    const started = Date.now();
    let checking = false;
    const monitor = setInterval(async () => {
      if (checking || stopReason) return;
      checking = true;
      try {
        const heartbeat = await readHeartbeat(this.root).catch(error => { if (!missing(error)) throw error; return null; });
        if (this.stopped) stopReason = 'Assistant worker stopped.';
        else if (await read(path.join(job, 'cancel.json'))) stopReason = 'Request stopped.';
        else if (!heartbeat || heartbeat.session !== request.session || Date.now() / 1000 - heartbeat.time >= 5) stopReason = 'Aseprite disconnected.';
        else if (Date.now() - started > this.timeout) stopReason = 'Codex timed out.';
        if (stopReason) this.terminate(child);
      } catch (error) { stopReason = error.message; this.terminate(child); }
      finally { checking = false; }
    }, 250);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      await progress;
      if (stopReason) throw new Error(`${stopReason} Changes may already have applied; inspect the canvas before retrying.`);
      if (code !== 0 || failure) throw new Error(failure || stderr.trim() || `Codex exited with code ${code}. Check codex login and the MCP configuration.`);
      if (!completed) throw new Error('Codex exited without a completed turn. Review the canvas before retrying.');
      return { ok: true, thread_id, message: message || 'Done. Review the canvas.' };
    } catch (error) {
      return { ok: false, thread_id, error: error.code === 'ENOENT'
        ? 'Codex executable not found. Set CODEX_BIN to its absolute path.' : error.message };
    } finally {
      clearInterval(monitor);
      lines.close();
      this.child = null;
    }
  }

  terminate(child = this.child) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 1500);
    timer.unref();
  }

  async close() {
    this.stopped = true;
    this.terminate();
    if (this.lock) {
      await fs.rm(path.join(this.root, 'assistant-heartbeat.json'), { force: true });
      await this.lock.close();
      await fs.unlink(this.lockPath);
      this.lock = null;
    }
  }
}

async function main() {
  const worker = new AssistantWorker();
  try { await worker.init(); }
  catch (error) { await worker.close(); throw error; }
  const stop = () => { worker.stopped = true; worker.terminate(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let heartbeatBusy = false;
  const timer = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try { await worker.heartbeat(); }
    catch (error) { console.error(error.message); stop(); }
    finally { heartbeatBusy = false; }
  }, 1000);
  console.log('Aseprite assistant ready. Open File > Scripts > codex-bridge. Ctrl+C stops the helper.');
  try {
    while (!worker.stopped) { await worker.tick(); if (!worker.stopped) await sleep(200); }
  } finally {
    clearInterval(timer);
    while (heartbeatBusy) await sleep(10);
    await worker.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
