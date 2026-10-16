import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge, projectDir } from '../src/bridge.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aseprite-test-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  return {root, bridge:new Bridge({root})};
}
const luaString = value => JSON.stringify(value);

test('heartbeat JSON can be replaced repeatedly by Aseprite', async t => {
  const {root, bridge} = await fixture(t);
  const result = await bridge.request({op:'run', transaction:false, code:`
    local core = dofile(${luaString(path.join(projectDir, 'aseprite/core.lua'))})
    local filename = ${luaString(path.join(root, 'heartbeat.json'))}
    for i=1,5 do core.write(filename, {sequence=i}) end
    return {sequence=core.read(filename).sequence}
  `}, 'batch');
  assert.equal(result.data.result.sequence, 5);
});

test('real Aseprite: create, inspect, edit, preview, save and export with metadata', async t => {
  const {root, bridge} = await fixture(t);
  const input = path.join(root, 'sprite with spaces.aseprite');
  const created = await bridge.request({op:'run', code:`
    local s = Sprite(16, 12)
    s.layers[1].name = 'Body'
    local im = s.cels[1].image:clone()
    im:drawPixel(3, 4, app.pixelColor.rgba(255, 0, 0, 255))
    s.cels[1].image = im
    s:newFrame()
    s.frames[2].duration = 0.2
    local tag = s:newTag(1, 2); tag.name = 'idle'
    s:saveAs(${luaString(input)})
    return {created=true}
  `}, 'batch');
  assert.equal(created.data.sprite.width, 16);
  const inspected = await bridge.request({op:'inspect', input}, 'batch');
  assert.equal(inspected.data.active.layers[0].name, 'Body');
  assert.equal(inspected.data.active.frames.length, 2);
  assert.equal(inspected.data.active.tags[0].name, 'idle');
  const edit = await bridge.request({op:'run', input, code:"app.sprite.layers[1].name = 'Edited'; return app.sprite.layers[1].name"}, 'batch');
  assert.equal(edit.data.result, 'Edited');
  const preview = await bridge.request({op:'preview', input, frame:2, scale:4}, 'batch');
  const png = Buffer.from(preview.png, 'base64');
  assert.equal(png.subarray(1,4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 48);
  await assert.rejects(bridge.request({op:'preview', input, frame:3}, 'batch'), /out of range/);
  const saved = path.join(root, 'copy.aseprite');
  await bridge.request({op:'save', input, path:saved}, 'batch');
  const before = await fs.readFile(saved);
  await assert.rejects(bridge.request({op:'save', input, path:saved}, 'batch'), /Output exists/);
  assert.deepEqual(await fs.readFile(saved), before);
  const sheet = path.join(root, 'sheet.png'), data = path.join(root, 'sheet.json');
  await bridge.request({op:'export', input, path:sheet, data_path:data}, 'batch');
  const metadata = JSON.parse(await fs.readFile(data, 'utf8'));
  assert.equal(metadata.frames.length, 2);
  assert.equal(metadata.meta.frameTags[0].name, 'idle');
  assert.equal((await fs.readFile(sheet)).readUInt32BE(16), 32);
});

test('Lua errors and failed transactions are reported and rollback edits', async t => {
  const {bridge} = await fixture(t);
  await assert.rejects(bridge.request({op:'run', code:'this is not lua'}, 'batch'), /syntax|near/);
  await assert.rejects(bridge.request({op:'run', code:'error("intentional failure")'}, 'batch'), /intentional failure/);
  const result = await bridge.request({op:'run', transaction:false, code:`
    local s = Sprite(8, 8)
    local original = s.layers[1].name
    local ok = pcall(function()
      app.transaction('test rollback', function()
        s.layers[1].name = 'changed'
        error('rollback')
      end)
    end)
    return {ok=ok, restored=s.layers[1].name == original}
  `}, 'batch');
  assert.equal(result.data.result.ok, false);
  assert.equal(result.data.result.restored, true);
});

test('offline live requests never silently fall back to batch', async t => {
  const {root, bridge} = await fixture(t);
  await assert.rejects(bridge.request({op:'inspect'}), /offline/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('unclaimed live requests are cancelled on timeout', async t => {
  const {root} = await fixture(t);
  const bridge = new Bridge({root, timeout:100});
  await fs.writeFile(path.join(root, 'heartbeat.json'), JSON.stringify({session:'test', time:Date.now()/1000}));
  await assert.rejects(bridge.request({op:'run', code:'error("must not run")'}), /cancelled/);
  assert.deepEqual(await fs.readdir(root), ['heartbeat.json']);
});

test('MCP stdio handshake, tool schemas, actual execution and image response', async t => {
  const {root} = await fixture(t);
  const client = new Client({name:'bridge-test', version:'1.0.0'});
  const transport = new StdioClientTransport({command:process.execPath,
    args:[path.join(projectDir, 'src/server.mjs')], env:{...process.env, ASEPRITE_BRIDGE_DIR:root}});
  await client.connect(transport);
  t.after(() => client.close());
  const {tools} = await client.listTools();
  assert.equal(tools.length, 7);
  const file = path.join(root, 'mcp.aseprite');
  const created = await client.callTool({name:'aseprite_run_lua', arguments:{mode:'batch', code:`local s=Sprite(8,8); s:saveAs(${luaString(file)}); return 'ok'`}});
  assert.ok(!created.isError, JSON.stringify(created));
  const preview = await client.callTool({name:'aseprite_preview', arguments:{mode:'batch', input:file}});
  assert.equal(preview.content[1].type, 'image');
  const error = await client.callTool({name:'aseprite_save', arguments:{path:'relative.aseprite'}});
  assert.equal(error.isError, true);
});
