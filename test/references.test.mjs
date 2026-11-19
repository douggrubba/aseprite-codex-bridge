import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareReferences } from '../src/references.mjs';
import { Bridge, projectDir } from '../src/bridge.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aseprite-reference-selection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'images');
  await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
  const png = await fs.readFile(path.join(projectDir, 'docs/images/assistant-panel.png'));
  const names = Array.from({ length: 10 }, (_, i) => `${i < 8 ? '' : 'nested/'}${String(i).padStart(2, '0')}.png`);
  for (const name of names) await fs.writeFile(path.join(directory, name), png);
  return { root, directory, names, png };
}

test('explicit reference selection omits unselected invalid files and preserves snapshot order', async t => {
  const { root, directory, names, png } = await fixture(t);
  await fs.writeFile(path.join(directory, 'invalid.png'), 'not a PNG');
  const selected = [names[9], names[1]];
  const refs = await prepareReferences(directory, root, { limit: 2, files: selected });
  assert.equal(refs.total, 11);
  assert.deepEqual(refs.images.map(image => image.name), selected);
  for (const image of refs.images) assert.deepEqual(await fs.readFile(image.path), png);
});

test('reference selection rejects invalid limits, missing files, traversal, duplicates, and excess selections', async t => {
  const { root, directory, names } = await fixture(t);
  for (const limit of [0, -1, 1.5, '8', null]) {
    await assert.rejects(prepareReferences(directory, root, { limit }), /positive integer/);
  }
  for (const files of [[], null, '00.png', [names[0], names[1], names[2]]]) {
    await assert.rejects(prepareReferences(directory, root, { limit: 2, files }), /selected image limit/);
  }
  for (const file of ['../outside.png', '/tmp/outside.png', 'nested/../00.png', 'missing.png', 1]) {
    await assert.rejects(prepareReferences(directory, root, { files: [file] }), /unavailable/);
  }
  await assert.rejects(prepareReferences(directory, root, { files: [names[0], names[0]] }), /more than once/);
  await fs.unlink(path.join(directory, names[0]));
  await assert.rejects(prepareReferences(directory, root, { files: [names[0]] }), /Select images again/);
});

test('thumbnail picker previews, filters, pages, enforces the cap, and applies or cancels exact choices', async t => {
  const { root, directory } = await fixture(t);
  const result = await new Bridge({ root }).request({ op: 'run', transaction: false, code: `
    local refs=dofile(${JSON.stringify(path.join(projectDir, 'aseprite/references.lua'))})
    local directory=${JSON.stringify(directory)}
    local nativeDialog=Dialog
    local nativeImage=Image
    local instances,drawn={},0
    local painting,paintLoads=false,0
    Image=function(...)
      if painting then paintLoads=paintLoads+1 end
      return nativeImage(...)
    end
    local before=#app.sprites
    Dialog=function()
      local widgets,data,canvases={},{},{}
      local dlg={data=data,widgets=widgets}
      for _,method in ipairs({'label','entry','button','canvas'}) do
        dlg[method]=function(self,w)
          if w.id then widgets[w.id]=w;data[w.id]=w.text or '' end
          if method=='canvas' then canvases[#canvases+1]=w end
          return self
        end
      end
      dlg.newrow=function(self) return self end
      dlg.modify=function(self,w)
        if w.text then data[w.id]=w.text end
        if w.enabled~=nil then widgets[w.id].enabled=w.enabled end
      end
      dlg.repaint=function()
        for _,canvas in ipairs(canvases) do
          local gc={width=canvas.width,height=canvas.height,theme={color={window_face=Color(0),text=Color(255)}}}
          gc.fillRect=function() end
          gc.strokeRect=function() end
          gc.fillText=function() end
          gc.measureText=function(self,text) return {width=utf8.len(text)*5,height=8} end
          gc.drawImage=function(self,image,source,target)
            assert(image.width>0 and image.height>0 and target.width>0 and target.height>0)
            drawn=drawn+1
          end
          painting=true
          canvas.onpaint{context=gc}
          painting=false
        end
      end
      dlg.show=function(self) self:repaint() end
      dlg.close=function(self) self.closed=true end
      instances[#instances+1]=dlg
      return dlg
    end
    local picker=refs.picker(directory,2,{'nested/08.png'})
    local dlg=picker.dialog
    local widgets=dlg.widgets
    local function click(slot)
      widgets.thumbnails.onmousedown{button=MouseButton.LEFT,x=(slot%4)*100+20,y=(slot//4)*104+25}
    end
    assert(#picker.values()==1)
    click(0)
    assert(#picker.values()==2)
    click(1)
    assert(#picker.values()==2 and dlg.data.selection_info:match('Limit reached'))
    widgets.preview.onclick()
    assert(#instances==2, 'Focused image opens a separate larger preview')
    widgets.next.onclick()
    assert(dlg.data.page_info=='Page 2 of 2')
    widgets.none.onclick()
    assert(#picker.values()==0 and not widgets.use_images.enabled)
    widgets.use_images.onclick()
    assert(not dlg.closed)
    click(1)
    widgets.previous.onclick()
    click(0)
    assert(#picker.values()==2)
    dlg.data.filter='nested'
    widgets.filter.onchange()
    assert(dlg.data.page_info=='Page 1 of 1')
    click(1)
    click(0)
    widgets.use_images.onclick()
    assert(dlg.closed)
    assert(picker.selected[1]=='00.png' and picker.selected[2]=='nested/08.png')
    local all=refs.picker(directory,10,nil)
    assert(#all.values()==10, 'The picker does not retain the old eight-image cap')
    all.dialog.widgets.none.onclick()
    all.dialog.widgets.cancel.onclick()
    assert(all.selected==nil, 'Cancel preserves the previously saved choice')
    Dialog=nativeDialog
    Image=nativeImage
    return {selected=picker.selected,previews_drawn=drawn,loads_during_paint=paintLoads,sprites_unchanged=#app.sprites==before}
  ` }, 'batch');
  assert.deepEqual(result.data.result.selected, ['00.png', 'nested/08.png']);
  assert.ok(result.data.result.previews_drawn > 0);
  assert.equal(result.data.result.loads_during_paint, 0, 'File access prompts must not re-enter the canvas painter');
  assert.equal(result.data.result.sprites_unchanged, true);
});
