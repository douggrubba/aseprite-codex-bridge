import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantWorker } from '../src/assistant.mjs';
import { discoverCodexSettings } from '../src/codex-settings.mjs';
import { maxReferences, prepareReferences } from '../src/references.mjs';
import { Bridge, projectDir } from '../src/bridge.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const settings = { version: 1, default_model: 'test-model-a', default_effort: 'high', models: [
  { id: 'test-model-a', efforts: ['low', 'high', 'ultra'], default_effort: 'low' },
  { id: 'test-model-b', efforts: ['low', 'medium', 'high'], default_effort: 'medium' },
  { id: 'test-model-plain', efforts: [] },
] };

async function fixture(t, body = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aseprite-assistant-'));
  const command = path.join(root, 'fake-codex');
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
fs.writeFileSync(${JSON.stringify(path.join(root, 'invocation.json'))}, JSON.stringify({ args: process.argv.slice(2), prompt }));
${body || `console.log(JSON.stringify({type:'thread.started', thread_id:'thread-123'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'Added highlights.'}}));
console.log(JSON.stringify({type:'turn.completed'}));`}
`, { mode: 0o700 });
  // Node treats an extensionless executable outside a package as CommonJS on some versions.
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(root, 'heartbeat.json'), JSON.stringify({ session: 'editor', time: Date.now() / 1000 }));
  const worker = new AssistantWorker({ root, command, discoverSettings: async () => settings });
  await worker.init();
  t.after(async () => { await worker.close(); await fs.rm(root, { recursive: true, force: true }); });
  const job = path.join(root, 'assistant-job-test');
  await fs.mkdir(job);
  const request = { session: 'editor', sprite_id: 42, frame: 2, layer: 'Body',
    prompt: 'Add highlights; $(touch /tmp/must-not-execute)', expires: Date.now() / 1000 + 30 };
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify(request));
  return { root, worker, job, request };
}
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const referencePng = () => fs.readFile(path.join(projectDir, 'docs/images/assistant-panel.png'));

test('style references are snapshotted and attached to both fresh and resumed turns', async t => {
  const { root, worker, job, request } = await fixture(t);
  const directory=path.join(root, 'style refs with spaces');
  await fs.mkdir(directory);
  const png=await referencePng();
  await fs.writeFile(path.join(directory, 'b.png'), png);
  await fs.writeFile(path.join(directory, 'a.PNG'), png);
  await fs.writeFile(path.join(directory, 'notes.txt'), 'not an image');
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify({ ...request, reference_dir:directory }));
  await worker.tick();
  let call=await read(path.join(root, 'invocation.json'));
  let images=call.args.flatMap((arg,index)=>arg==='--image' ? [call.args[index+1]] : []);
  assert.equal(images.length,2);
  assert.ok(call.prompt.includes('["a.PNG","b.png"]'));
  assert.ok(call.prompt.includes('palette, outlines, shading'));
  assert.deepEqual(await fs.readFile(images[0]),png);
  await fs.unlink(path.join(directory,'a.PNG'));
  await fs.unlink(path.join(directory,'b.png'));
  assert.deepEqual(await fs.readFile(images[0]),png, 'attachments survive changes to the source folder');
  await fs.writeFile(path.join(directory,'new-style.png'),png);
  const nextJob=path.join(root,'assistant-job-followup');
  await fs.mkdir(nextJob);
  await fs.writeFile(path.join(nextJob,'request.json'),JSON.stringify({...request,thread_id:'thread-123',reference_dir:directory}));
  await worker.tick();
  call=await read(path.join(root,'invocation.json'));
  images=call.args.flatMap((arg,index)=>arg==='--image' ? [call.args[index+1]] : []);
  assert.equal(images.length,1);
  assert.ok(call.args.indexOf('--image')>call.args.indexOf('resume'));
  assert.ok(call.prompt.includes('["new-style.png"]'));
  assert.ok(!call.prompt.includes('b.png'));
  const clearedJob=path.join(root,'assistant-job-without-references');
  await fs.mkdir(clearedJob);
  await fs.writeFile(path.join(clearedJob,'request.json'),JSON.stringify({...request,thread_id:'thread-123'}));
  await worker.tick();
  call=await read(path.join(root,'invocation.json'));
  assert.ok(!call.args.includes('--image'));
  assert.ok(call.prompt.includes('rather than any older reference attachments'));
});

test('reference folders use a bounded, sorted set of direct images', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aseprite-references-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'source'), job=path.join(root,'job');
  await fs.mkdir(directory); await fs.mkdir(job);
  const png=await referencePng();
  for(let i=maxReferences;i>=0;i--) await fs.writeFile(path.join(directory,`${String(i).padStart(2,'0')}.png`),png);
  await fs.mkdir(path.join(directory,'nested'));
  await fs.writeFile(path.join(directory,'nested','ignored.png'),png);
  const refs=await prepareReferences(directory,job);
  assert.equal(refs.total,maxReferences+1);
  assert.equal(refs.images.length,maxReferences);
  assert.equal(refs.images[0].name,'00.png');
  assert.equal(refs.images.at(-1).name,`${String(maxReferences-1).padStart(2,'0')}.png`);
});

test('invalid reference folders or images fail before Codex starts', async t => {
  const { root,worker,job,request }=await fixture(t);
  const directory=path.join(root,'invalid-refs');
  await fs.mkdir(directory);
  for(const reference_dir of ['relative/path',path.join(root,'missing'),directory]) {
    await fs.writeFile(path.join(job,'request.json'),JSON.stringify({...request,reference_dir}));
    await worker.tick();
    assert.equal((await read(path.join(job,'response.json'))).ok,false);
  }
  await fs.writeFile(path.join(directory,'bad.png'),'this is not a PNG');
  await fs.writeFile(path.join(job,'request.json'),JSON.stringify({...request,reference_dir:directory}));
  await worker.tick();
  assert.match((await read(path.join(job,'response.json'))).error,/not a valid PNG/);
  await assert.rejects(fs.access(path.join(root,'invocation.json')),{code:'ENOENT'});
});

test('the folder browser navigates and accepts a directory inside Aseprite', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aseprite-folder-picker-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const nested=path.join(root,'nested');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(root,'reference.png'),await referencePng());
  const result=await new Bridge({root}).request({op:'run',transaction:false,code:`
    local refs=dofile(${JSON.stringify(path.join(projectDir,'aseprite/references.lua'))})
    local root=${JSON.stringify(root)}
    local widgets,data={},{}
    local nativeDialog=Dialog
    Dialog=function()
      local dlg={data=data}
      for _,method in ipairs({'label','entry','button','combobox'}) do
        dlg[method]=function(self,widget)
          if widget.id then widgets[widget.id]=widget;data[widget.id]=widget.option or widget.text or '' end
          return self
        end
      end
      dlg.newrow=function(self) return self end
      dlg.modify=function(self,widget)
        if widget.text then data[widget.id]=widget.text end
        if widget.option then data[widget.id]=widget.option end
      end
      dlg.close=function(self) self.closed=true end
      dlg.show=function(self)
        assert(data.path == root)
        data.folders='nested';widgets.open.onclick()
        assert(data.path == ${JSON.stringify(nested)})
        widgets.up.onclick();assert(data.path == root)
        data.path=${JSON.stringify(nested)}
        widgets.use_folder.onclick()
        assert(self.closed)
      end
      return dlg
    end
    local selected=refs.choose(root,nil)
    Dialog=nativeDialog
    local folders,count=refs.scan(root)
    return {selected=selected,count=count,folders=folders,summary=refs.summary(9)}
  `},'batch');
  assert.equal(result.data.result.selected,nested);
  assert.equal(result.data.result.count,1);
  assert.ok(result.data.result.folders.includes('nested'));
  assert.match(result.data.result.summary,/first 8 of 9/);
});

test('model discovery reads CLI defaults and paginated capabilities without starting a turn', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aseprite-models-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = path.join(root, 'fake-codex');
  const log = path.join(root, 'methods.jsonl');
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
for await (const line of lines) {
  const request=JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, request.method+'\\n');
  if (request.id === undefined) continue;
  let result={};
  if (request.method === 'config/read') result={config:{model:'model-b',model_reasoning_effort:'ultra'}};
  if (request.method === 'model/list') result=request.params.cursor
    ? {data:[{model:'model-b',hidden:false,isDefault:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'ultra'}]}]}
    : {data:[{model:'model-a',hidden:false,isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:'next-page'};
  console.log(JSON.stringify({id:request.id,result}));
}
`, { mode: 0o700 });
  const catalog = await discoverCodexSettings(command, root);
  assert.equal(catalog.default_model, 'model-b');
  assert.equal(catalog.default_effort, 'ultra');
  assert.deepEqual(catalog.models[1].efforts, ['low', 'ultra']);
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'),
    ['initialize', 'initialized', 'config/read', 'model/list', 'model/list']);
});

test('panel request reaches Codex as stdin with a pinned MCP target; follow-up resumes its thread', async t => {
  const { root, worker, job, request } = await fixture(t);
  await worker.tick();
  assert.deepEqual(await read(path.join(job, 'response.json')), { ok: true, thread_id: 'thread-123', message: 'Added highlights.' });
  const call = await read(path.join(root, 'invocation.json'));
  assert.ok(call.prompt.includes(request.prompt));
  assert.ok(!call.args.some(arg => arg.includes(request.prompt)));
  assert.ok(call.args.includes('mcp_servers.aseprite.env.ASEPRITE_TARGET_SPRITE_ID="42"'));
  assert.ok(call.args.includes('mcp_servers.aseprite.env.ASEPRITE_BRIDGE_SESSION="editor"'));
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify({ ...request, thread_id: 'thread-123', prompt: 'Make those warmer' }));
  await worker.tick();
  assert.deepEqual((await read(path.join(root, 'invocation.json'))).args.slice(-3), ['resume', 'thread-123', '-']);
  await fs.writeFile(path.join(job, 'acknowledged.json'), '{}');
  await worker.tick();
  await assert.rejects(fs.access(job), { code: 'ENOENT' });
});

test('stale connections and pre-cancelled requests never launch Codex', async t => {
  const { root, worker, job, request } = await fixture(t);
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify({ ...request, session: 'old-editor' }));
  await worker.tick();
  assert.match((await read(path.join(job, 'response.json'))).error, /offline/);
  await assert.rejects(fs.access(path.join(root, 'invocation.json')), { code: 'ENOENT' });
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify(request));
  await fs.writeFile(path.join(job, 'cancel.json'), '{}');
  await worker.tick();
  assert.match((await read(path.join(job, 'response.json'))).error, /cancelled/);
  await assert.rejects(fs.access(path.join(root, 'invocation.json')), { code: 'ENOENT' });
});

test('model and effort switches reach fresh and resumed Codex turns', async t => {
  const { root, worker, job, request } = await fixture(t);
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify({ ...request, model: 'test-model-a', effort: 'ultra' }));
  await worker.tick();
  let args = (await read(path.join(root, 'invocation.json'))).args;
  assert.equal(args[args.indexOf('--model') + 1], 'test-model-a');
  assert.ok(args.includes('model_reasoning_effort="ultra"'));
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify({ ...request, thread_id: 'thread-123', model: 'test-model-b', effort: 'medium' }));
  await worker.tick();
  args = (await read(path.join(root, 'invocation.json'))).args;
  assert.equal(args[args.indexOf('--model') + 1], 'test-model-b');
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  assert.equal(args[args.indexOf('resume') + 1], 'thread-123');
  assert.equal(args[args.indexOf('resume') + 2], '--model');
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify({ ...request, thread_id: 'thread-123', model: 'test-model-plain' }));
  await worker.tick();
  args = (await read(path.join(root, 'invocation.json'))).args;
  assert.equal(args[args.indexOf('--model') + 1], 'test-model-plain');
  assert.ok(!args.some(arg => arg.startsWith('model_reasoning_effort=')));
});

test('unsupported model/effort pairs are rejected before starting Codex', async t => {
  const { root, worker, job, request } = await fixture(t);
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify({ ...request, model: 'test-model-b', effort: 'ultra' }));
  await worker.tick();
  assert.match((await read(path.join(job, 'response.json'))).error, /not supported/);
  await assert.rejects(fs.access(path.join(root, 'invocation.json')), { code: 'ENOENT' });
  await fs.writeFile(path.join(job, 'request.json'), JSON.stringify({ ...request, model: '--not-a-model', effort: 'low' }));
  await worker.tick();
  assert.match((await read(path.join(job, 'response.json'))).error, /unavailable/);
});

test('cancelling a running request terminates Codex and warns about partial edits', async t => {
  const { root, worker, job } = await fixture(t, 'setInterval(() => {}, 1000);');
  const running = worker.tick();
  for (let i = 0; i < 100; i++) {
    try { await fs.access(path.join(root, 'invocation.json')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await fs.writeFile(path.join(job, 'cancel.json'), '{}');
  await running;
  const result = await read(path.join(job, 'response.json'));
  assert.equal(result.ok, false);
  assert.match(result.error, /Changes may already have applied/);
});

test('missing executable reports a useful error and does not retry', async t => {
  const { worker, job } = await fixture(t);
  worker.command = '/nonexistent/aseprite-test-codex';
  await worker.tick();
  assert.match((await read(path.join(job, 'response.json'))).error, /CODEX_BIN/);
});

test('an incomplete Codex run is not reported as a successful edit', async t => {
  const { worker, job } = await fixture(t, 'console.log(JSON.stringify({type:"thread.started", thread_id:"thread-123"}));');
  await worker.tick();
  const result = await read(path.join(job, 'response.json'));
  assert.equal(result.ok, false);
  assert.equal(result.thread_id, 'thread-123');
  assert.match(result.error, /without a completed turn/);
});

test('a panel bridge cannot execute against a replacement editor session', async t => {
  const { root } = await fixture(t);
  const bridge = new Bridge({ root, session: 'previous-editor' });
  await assert.rejects(bridge.request({ op: 'inspect', sprite_id: 42 }), /connection changed/);
  assert.ok(!(await fs.readdir(root)).some(name => name.startsWith('job-')));
});

test('a second helper cannot claim the same queue', async t => {
  const { root } = await fixture(t);
  await assert.rejects(new AssistantWorker({ root }).init(), /already running/);
});

test('panel Lua submits current context, retains target across tab changes, and consumes response', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aseprite-panel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bridge = new Bridge({ root });
  const result = await bridge.request({ op: 'run', transaction: false, code: `
    local core = dofile(${JSON.stringify(path.join(projectDir, 'aseprite/core.lua'))})
    local assistant = dofile(${JSON.stringify(path.join(projectDir, 'aseprite/assistant.lua'))})
    local root = ${JSON.stringify(root)}
    local widgets, data = {}, {}
    local nativeDialog = Dialog
    Dialog = function(options)
      local dlg = { data=data }
      for _, name in ipairs({'label','entry','button','canvas','combobox'}) do
        dlg[name] = function(self, widget)
          if widget.id then widgets[widget.id]=widget; data[widget.id]=widget.option or widget.text or '' end
          return self
        end
      end
      dlg.newrow = function(self) return self end
      dlg.close = function(self) if options.onclose then options.onclose() end end
      dlg.repaint = function(self)
        -- Exercise the actual paint callback with Aseprite rectangles and theme colors.
        local gc = {width=16, height=16, theme={color={window_face=Color(0), text=Color(255)}}}
        gc.fillRect = function() end
        widgets.spinner.onpaint{context=gc}
      end
      dlg.modify = function(self, widget)
        if widget.text ~= nil then data[widget.id]=widget.text end
        if widget.options then
          assert(type(widget.options) == 'table', 'Native combobox options must be a Lua table')
          widgets[widget.id].options=widget.options
        end
        if widget.option ~= nil then data[widget.id]=widget.option end
        if widget.enabled ~= nil then widgets[widget.id].enabled=widget.enabled end
      end
      return dlg
    end
    local s = Sprite(8,8)
    local original = s.id
    core.write(app.fs.joinPath(root,'assistant-heartbeat.json'), {time=os.time(), settings_version=1, references_version=1})
    core.write(app.fs.joinPath(root,'assistant-preferences.json'), {reference_dir=${JSON.stringify(path.join(projectDir, 'docs/images'))}})
    core.write(app.fs.joinPath(root,'assistant-settings.json'), json.decode([==[${JSON.stringify(settings)}]==]))
    local disconnected=0
    local panel = assistant.create(core, root, 'editor', function() disconnected=disconnected+1 end)
    panel.dialog:close()
    local closeKeepsRunning=disconnected == 0
    local defaults=data.model == 'test-model-a' and data.effort == 'high'
    data.effort='ultra'
    widgets.effort.onchange()
    data.model='test-model-b'
    widgets.model.onchange()
    local resetEffort=data.effort == 'medium' and #widgets.effort.options == 3
    data.prompt='Add a highlight'
    panel.tick()
    local sendEnabled=widgets.send.enabled
    widgets.send.onclick()
    local pending=panel.pending
    local request=core.read(app.fs.joinPath(pending.job,'request.json'))
    local working=data.activity:match('^Working') ~= nil
    local stopped=false
    core.write(app.fs.joinPath(pending.job,'progress.json'), {text='Codex is editing...'})
    panel.cancel()
    panel.tick(true)
    stopped=data.activity:match('^Stopping') ~= nil and data.status:match('^Stopping') ~= nil
    local other=Sprite(4,4)
    panel.tick()
    local pinned=panel.pending.sprite_id == original and not widgets.undo.enabled and not widgets.model.enabled and not widgets.effort.enabled and not widgets.browse_refs.enabled and not widgets.clear_refs.enabled
    core.write(app.fs.joinPath(pending.job,'response.json'), {ok=true, message='Done', thread_id='thread-123'})
    panel.tick()
    local consumed=panel.pending == nil and panel.threads[original] == 'thread-123' and data.activity == ''
    app.sprite=s
    widgets.undo.onclick()
    widgets.redo.onclick()
    widgets.disconnect.onclick()
    local explicitDisconnect=disconnected == 1
    local reopened=assistant.create(core, root, 'editor', function() end)
    local remembered=reopened.dialog.data.model == 'test-model-b' and reopened.dialog.data.effort == 'medium'
    local rememberedReferences=reopened.dialog.data.reference_dir:match('docs/images') ~= nil
    widgets.clear_refs.onclick()
    local clearedReferences=core.read(app.fs.joinPath(root,'assistant-preferences.json')).reference_dir == '' and reopened.dialog.data.reference_dir == 'None'
    Dialog=nativeDialog
    return {sendEnabled=sendEnabled, pinned=pinned, consumed=consumed, working=working, stopped=stopped,
      defaults=defaults, resetEffort=resetEffort, remembered=remembered, model=request.model, effort=request.effort,
      closeKeepsRunning=closeKeepsRunning, explicitDisconnect=explicitDisconnect,
      references=request.reference_dir, rememberedReferences=rememberedReferences, clearedReferences=clearedReferences,
      submitted=request.prompt, target=request.sprite_id, original=original,
      selectionEmpty=request.context.selection.empty, response=panel.response}
  ` }, 'batch');
  assert.equal(result.data.result.sendEnabled, true);
  assert.equal(result.data.result.pinned, true);
  assert.equal(result.data.result.consumed, true);
  assert.equal(result.data.result.working, true);
  assert.equal(result.data.result.stopped, true);
  assert.equal(result.data.result.defaults, true);
  assert.equal(result.data.result.resetEffort, true);
  assert.equal(result.data.result.remembered, true);
  assert.equal(result.data.result.closeKeepsRunning, true);
  assert.equal(result.data.result.explicitDisconnect, true);
  assert.equal(result.data.result.references,path.join(projectDir,'docs/images'));
  assert.equal(result.data.result.rememberedReferences,true);
  assert.equal(result.data.result.clearedReferences,true);
  assert.equal(result.data.result.model, 'test-model-b');
  assert.equal(result.data.result.effort, 'medium');
  assert.equal(result.data.result.target, result.data.result.original);
  assert.equal(result.data.result.selectionEmpty, true);
  assert.equal(result.data.result.submitted, 'Add a highlight');
  assert.equal(result.data.result.response, 'Done');
});

test('panel MCP refuses other sprites and batch mode', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aseprite-pinned-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = new Client({ name: 'panel-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(projectDir, 'src/server.mjs')],
    env: { ...process.env, ASEPRITE_BRIDGE_DIR: root, ASEPRITE_TARGET_SPRITE_ID: '42' } }));
  t.after(() => client.close());
  for (const args of [{ sprite_id: 43 }, { mode: 'batch' }]) {
    const result = await client.callTool({ name: 'aseprite_inspect', arguments: args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /pinned/);
  }
  const saved = await client.callTool({ name: 'aseprite_save', arguments: { path: '/tmp/no.aseprite' } });
  assert.match(saved.content[0].text, /Save and export from Aseprite/);
});
