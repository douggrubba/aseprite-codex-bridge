import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge, projectDir } from '../src/bridge.mjs';

async function fixture(t, code) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aseprite-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await new Bridge({ root }).request({ op: 'run', transaction: false, code: `
    local export=dofile(${JSON.stringify(path.join(projectDir, 'aseprite/export.lua'))})
    local root=${JSON.stringify(root)}
    ${code}
  ` }, 'batch');
  return { root, result: result.data.result };
}

test('exports distinct objects with diagonal connectivity and isolates nested islands', async t => {
  const { root, result } = await fixture(t, `
    local s=Sprite(24,18)
    local cel=s.layers[1]:cel(1)
    local image=cel.image:clone()
    local red=app.pixelColor.rgba(230,164,126,255)
    local blue=app.pixelColor.rgba(76,73,97,255)
    -- Two top runs join on a later row; a diagonal tail belongs to that object.
    for _,p in ipairs({{1,1},{3,1},{1,2},{2,2},{3,2},{4,3}}) do image:drawPixel(p[1],p[2],red) end
    -- A ring surrounds an unrelated island. Bounding-box crops alone would leak it.
    for x=10,16 do image:drawPixel(x,5,blue); image:drawPixel(x,11,blue) end
    for y=5,11 do image:drawPixel(10,y,blue); image:drawPixel(16,y,blue) end
    image:drawPixel(13,8,red)
    cel.image=image
    local name,modified=s.filename,s.isModified
    local rendered=export.render(s,1)
    local objects=export.objects(rendered)
    local paths=export.save(rendered,objects,root,'building')
    local first=Image{fromFile=paths[1]}
    local ring=Image{fromFile=paths[2]}
    local island=Image{fromFile=paths[3]}
    return {count=#objects,files=paths,
      first={w=first.width,h=first.height,tail=first:getPixel(3,2)},
      ring={w=ring.width,h=ring.height,center=ring:getPixel(3,3)},
      island={w=island.width,h=island.height,pixel=island:getPixel(0,0)},
      sourceUnchanged=cel.image:isEqual(image) and s.filename == name and s.isModified == modified}
  `);
  assert.equal(result.count, 3);
  assert.deepEqual(result.files.map(file => path.basename(file)), ['building-001.png', 'building-002.png', 'building-003.png']);
  assert.deepEqual([result.first.w, result.first.h], [4, 3]);
  assert.notEqual(result.first.tail, 0);
  assert.deepEqual(result.ring, { w: 7, h: 7, center: 0 });
  assert.deepEqual([result.island.w, result.island.h], [1, 1]);
  assert.notEqual(result.island.pixel, 0);
  assert.equal(result.sourceUnchanged, true);
  for (const file of result.files) assert.ok((await fs.stat(file)).size > 0);
  assert.equal(result.files[0], path.join(root, 'building-001.png'));
});

test('selection exports preserve their shape and current frame, excluding hidden layers', async t => {
  const { result } = await fixture(t, `
    local s=Sprite(12,12)
    local red=app.pixelColor.rgba(230,164,126,255)
    local blue=app.pixelColor.rgba(76,73,97,255)
    local image=s.layers[1]:cel(1).image:clone()
    image:drawPixel(2,2,red)
    s.layers[1]:cel(1).image=image
    s:newEmptyFrame()
    local second=Image(12,12)
    second:drawPixel(2,2,blue); second:drawPixel(4,4,blue); second:drawPixel(7,7,blue)
    s:newCel(s.layers[1],2,second)
    local hidden=s:newLayer()
    local cover=Image(12,12)
    cover:drawPixel(3,3,red)
    s:newCel(hidden,2,cover); hidden.isVisible=false
    s.selection:select(Rectangle(1,1,5,5))
    s.selection:subtract(Rectangle(4,4,1,1))
    local rendered=export.render(s,2)
    local paths=export.save(rendered,export.selected(rendered,s.selection),root,'selected')
    local out=Image{fromFile=paths[1]}
    local empty=Selection(Rectangle(10,10,2,2))
    local rejectsEmpty=not pcall(export.selected,rendered,empty)
    return {w=out.width,h=out.height,framePixel=out:getPixel(1,1),expected=blue,
      hiddenPixel=out:getPixel(2,2),maskedPixel=out:getPixel(3,3),
      selectionPreserved=s.selection:contains(2,2) and not s.selection:contains(4,4),rejectsEmpty=rejectsEmpty}
  `);
  assert.deepEqual([result.w, result.h], [5, 5]);
  assert.equal(result.framePixel, result.expected);
  assert.equal(result.hiddenPixel, 0);
  assert.equal(result.maskedPixel, 0);
  assert.equal(result.selectionPreserved, true);
  assert.equal(result.rejectsEmpty, true);
});

test('PNG export skips existing files and directories and rejects invalid destinations', async t => {
  const { result, root } = await fixture(t, `
    local image=Image(3,3)
    image:drawPixel(1,1,app.pixelColor.rgba(222,230,193,255))
    local objects=export.objects(image)
    local occupied=app.fs.joinPath(root,'asset-001.png')
    local file=assert(io.open(occupied,'wb'));file:write('keep me');file:close()
    app.fs.makeDirectory(app.fs.joinPath(root,'asset-002.png'))
    local paths=export.save(image,objects,root,'asset')
    local again=export.save(image,objects,root,'asset')
    return {first=paths[1],next=again[1],
      invalidPrefix=not pcall(export.save,image,objects,root,'../oops'),
      invalidDirectory=not pcall(export.save,image,objects,'relative','asset'),
      emptyFrame=not pcall(export.save,image,{},root,'empty')}
  `);
  assert.equal(result.first, path.join(root, 'asset-003.png'));
  assert.equal(result.next, path.join(root, 'asset-004.png'));
  assert.equal(await fs.readFile(path.join(root, 'asset-001.png'), 'utf8'), 'keep me');
  assert.equal(result.invalidPrefix, true);
  assert.equal(result.invalidDirectory, true);
  assert.equal(result.emptyFrame, true);
});

test('export dialog supports separate objects and whole-image export despite an active selection', async t => {
  const { root, result } = await fixture(t, `
    local s=Sprite(8,8)
    local image=s.layers[1]:cel(1).image:clone()
    image:drawPixel(1,1,app.pixelColor.rgba(230,164,126,255))
    image:drawPixel(6,6,app.pixelColor.rgba(230,164,126,255))
    s.layers[1]:cel(1).image=image
    local chooseWhole=false
    local nativeDialog=Dialog
    Dialog=function(options)
      local widgets,data={},{}
      local dlg={data=data}
      for _,name in ipairs({'label','entry','button','combobox'}) do
        dlg[name]=function(self,widget)
          if widget.id then widgets[widget.id]=widget; data[widget.id]=widget.option or widget.text or '' end
          return self
        end
      end
      dlg.newrow=function(self)return self end
      dlg.modify=function(self,widget)
        if widget.text then data[widget.id]=widget.text end
        if widget.enabled ~= nil then widgets[widget.id].enabled=widget.enabled end
      end
      dlg.close=function(self)self.closed=true end
      dlg.show=function(self)
        assert(options.title == 'Export PNGs')
        assert(data.mode == 'Whole image')
        assert(data.count == '1 PNG file(s), frame 1')
        assert(widgets.write.enabled)
        if chooseWhole then
          local found=false
          for _,option in ipairs(widgets.mode.options) do if option == 'Whole image' then found=true end end
          assert(found)
          data.mode='Whole image'; widgets.mode.onchange()
          assert(data.count == '1 PNG file(s), frame 1')
          assert(data.hint:match('Full canvas size'))
        else
          data.mode='Separate objects (whole frame)'; widgets.mode.onchange()
          assert(data.count == '2 PNG file(s), frame 1')
        end
        data.prefix=chooseWhole and 'town-whole' or 'town'
        widgets.write.onclick()
        assert(self.closed)
      end
      return dlg
    end
    local result=export.choose(s,1,root,nil)
    chooseWhole=true
    s.selection:select(Rectangle(1,1,1,1))
    local whole=export.choose(s,1,root,nil)
    local png=Image{fromFile=whole.paths[1]}
    local preserved=png:isEqual(export.render(s,1))
    Dialog=nativeDialog
    return {directory=result.directory,count=#result.paths,first=result.paths[1],
      wholeCount=#whole.paths,width=png.width,height=png.height,preserved=preserved,
      selectionPreserved=s.selection.bounds == Rectangle(1,1,1,1)}
  `);
  assert.equal(result.directory, root);
  assert.equal(result.count, 2);
  assert.equal(path.basename(result.first), 'town-001.png');
  assert.equal(result.wholeCount, 1);
  assert.deepEqual([result.width, result.height], [8, 8]);
  assert.equal(result.preserved, true);
  assert.equal(result.selectionPreserved, true);
});
