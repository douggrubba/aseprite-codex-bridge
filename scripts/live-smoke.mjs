import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge, projectDir } from '../src/bridge.mjs';

const bridge = new Bridge();
const directory = path.join(projectDir, 'artifacts', `live-${Date.now()}`);
await fs.mkdir(directory, {recursive:true});
assert.equal((await bridge.status()).live.connected, true, 'Connect the Aseprite GUI first.');
const initial = await bridge.request({op:'inspect'});
const created = await bridge.request({op:'run', transaction:false, code:`
  local s = Sprite(32, 32)
  s.layers[1].name = 'Bridge test'
  local image = s.cels[1].image:clone()
  for y=8,23 do
    for x=8,23 do
      image:drawPixel(x, y, app.pixelColor.rgba(64, 180, 220, 255))
    end
  end
  s.cels[1].image = image
  return s.id
`});
const sprite_id = created.data.result;
assert.equal(typeof sprite_id, 'number');
await bridge.request({op:'run', sprite_id, label:'Verify undo', code:`
  app.sprite.layers[1].name = 'Undo this edit'
`});
const undone = await bridge.request({op:'run', sprite_id, transaction:false, code:`
  app.undo()
  return app.sprite.layers[1].name
`});
assert.equal(undone.data.result, 'Bridge test');
const preview = await bridge.request({op:'preview', sprite_id, scale:8});
assert.equal(preview.data.width, 256);
await fs.writeFile(path.join(directory, 'preview.png'), Buffer.from(preview.png, 'base64'));
await bridge.request({op:'save', sprite_id, path:path.join(directory, 'bridge-test.aseprite')});
await bridge.request({op:'export', sprite_id, path:path.join(directory, 'sheet.png'), data_path:path.join(directory, 'sheet.json')});
const final = await bridge.request({op:'inspect', sprite_id});
assert.equal(final.data.active.id, sprite_id);
assert.equal(final.data.sprites.length, (initial.data.sprites?.length || 0) + 1);
assert.equal(final.data.active.modified, false);
console.log(JSON.stringify({ok:true, sprite_id, directory, checks:['live inspect', 'create', 'edit', 'undo', 'PNG preview', 'save', 'sheet export']}, null, 2));
