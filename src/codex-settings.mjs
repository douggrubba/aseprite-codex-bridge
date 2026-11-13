import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Query configuration and model metadata only; this does not start a model turn.
export async function discoverCodexSettings(command, cwd, { timeout = 10000 } = {}) {
  const child = spawn(command, ['app-server', '--stdio'], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0, stderr = '', closed = false, failure;
  const fail = error => {
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.on('close', () => { closed = true; fail(new Error(stderr.trim() || 'Codex settings service exited.')); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on('error', fail);
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.error) entry.reject(new Error(response.error.message));
    else entry.resolve(response.result);
  });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const timer = setTimeout(() => fail(new Error('Codex model discovery timed out.')), timeout);
  try {
    await request('initialize', { clientInfo: { name: 'aseprite_bridge', version: '0.1.0' } });
    send({ method: 'initialized', params: {} });
    const config = (await request('config/read', { cwd, includeLayers: false })).config;
    const models = [];
    let cursor;
    do {
      const page = await request('model/list', { cursor, includeHidden: false });
      for (const model of page.data) {
        if (model.hidden || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(model.model)) continue;
        models.push({ id: model.model,
          efforts: model.supportedReasoningEfforts.map(item => item.reasoningEffort),
          default_effort: model.defaultReasoningEffort, is_default: model.isDefault });
      }
      cursor = page.nextCursor;
    } while (cursor);
    const preferred = models.find(model => model.id === config?.model) ||
      models.find(model => model.is_default) || models[0];
    return { version: 1, models, default_model: preferred?.id,
      default_effort: preferred?.efforts.includes(config?.model_reasoning_effort)
        ? config.model_reasoning_effort : preferred?.default_effort };
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    if (!closed) child.kill();
    const killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000);
    killTimer.unref();
  }
}
