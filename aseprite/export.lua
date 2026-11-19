-- Export the visible current frame without changing the source document.
local M = {}
local directory = app.fs.filePath(debug.getinfo(1, 'S').source:sub(2))
local folders = dofile(app.fs.joinPath(directory, 'references.lua'))

-- Label horizontal runs instead of storing one Lua table per opaque pixel.
-- Adjacent rows overlap by one pixel so diagonal pixel-art edges stay together.
function M.objects(image)
  assert(image.colorMode == ColorMode.RGB, 'Object detection requires an RGBA image.')
  local bytes, stride = image.bytes, image.rowStride
  local parents, runs, previous = {}, {}, {}
  local function root(id)
    while parents[id] ~= id do
      parents[id] = parents[parents[id]]
      id = parents[id]
    end
    return id
  end
  for y=0,image.height-1 do
    local current, x, first = {}, 0, 1
    local function opaque(px) return bytes:byte(y*stride + px*4 + 4) > 0 end
    while x < image.width do
      if not opaque(x) then x=x+1
      else
        local start = x
        repeat x=x+1 until x == image.width or not opaque(x)
        local run = {x=start, last=x-1, y=y, id=#parents+1}
        parents[run.id] = run.id
        while previous[first] and previous[first].last < start-1 do first=first+1 end
        local index=first
        while previous[index] and previous[index].x <= run.last+1 do
          parents[root(previous[index].id)] = root(run.id)
          index=index+1
        end
        current[#current+1], runs[#runs+1] = run, run
      end
    end
    previous=current
  end
  local grouped, objects = {}, {}
  for _, run in ipairs(runs) do
    local id=root(run.id)
    local object=grouped[id]
    if not object then
      object={x=run.x, y=run.y, right=run.last, bottom=run.y, runs={}}
      grouped[id]=object; objects[#objects+1]=object
    end
    object.x=math.min(object.x,run.x); object.right=math.max(object.right,run.last)
    object.bottom=run.y
    object.runs[#object.runs+1]=run
  end
  table.sort(objects,function(a,b) return a.y == b.y and a.x < b.x or a.y < b.y end)
  for _, object in ipairs(objects) do
    object.bounds=Rectangle(object.x,object.y,object.right-object.x+1,object.bottom-object.y+1)
  end
  return objects
end

function M.render(sprite, frame)
  local image=Image(sprite.width,sprite.height,ColorMode.RGB)
  image:drawSprite(sprite,frame)
  return image
end

function M.selected(image, selection)
  assert(not selection.isEmpty, 'Select an area of the sprite first.')
  local area=selection.bounds
  local left,top=math.max(0,area.x),math.max(0,area.y)
  local right,bottom=math.min(image.width,area.x+area.width),math.min(image.height,area.y+area.height)
  assert(right > left and bottom > top, 'The selection is outside the canvas.')
  local bounds=Rectangle(left,top,right-left,bottom-top)
  local crop=Image(image,bounds)
  for pixel in crop:pixels() do
    if not selection:contains(pixel.x+left,pixel.y+top) then pixel(0) end
  end
  assert(not crop:isEmpty(), 'The selected area has no visible pixels.')
  return {{image=crop,bounds=bounds}}
end

function M.save(image, objects, directory, prefix)
  assert(type(directory) == 'string' and directory:sub(1,1) == '/' and app.fs.isDirectory(directory),
    'Choose an existing output folder using an absolute path.')
  prefix=tostring(prefix or ''):match('^%s*(.-)%s*$')
  assert(#prefix > 0 and not prefix:find('/',1,true) and not prefix:find('\\',1,true) and not prefix:find('%c'),
    'Enter a filename prefix without slashes or control characters.')
  assert(#objects > 0, 'This frame has no visible objects to export.')
  local paths, number = {}, 1
  for _, object in ipairs(objects) do
    local filename
    repeat
      filename=app.fs.joinPath(directory,string.format('%s-%03d.png',prefix,number))
      number=number+1
    until not app.fs.isFile(filename) and not app.fs.isDirectory(filename)
    local ok,err=pcall(function()
      local output=object.image
      if not output then
        output=Image(object.bounds.width,object.bounds.height,ColorMode.RGB)
        for _,run in ipairs(object.runs) do
          for x=run.x,run.last do
            output:drawPixel(x-object.bounds.x,run.y-object.bounds.y,image:getPixel(x,run.y))
          end
        end
      end
      assert(output:saveAs(filename) ~= false and app.fs.isFile(filename), 'Could not write ' .. filename)
    end)
    assert(ok, 'Export stopped after ' .. #paths .. ' file(s): ' .. tostring(err))
    paths[#paths+1]=filename
  end
  return paths
end

function M.choose(sprite, frame, initial, parent)
  local image=M.render(sprite,frame)
  local selection=Selection()
  selection:add(sprite.selection)
  local separate='Separate objects (whole frame)'
  local whole='Whole image'
  local selected='Selected area'
  local mode=whole
  local options=selection.isEmpty and {whole,separate} or {whole,selected,separate}
  local cache, dialog, result = {}, nil, nil
  local output=initial or ''
  if not app.fs.isDirectory(output) then output=app.fs.filePath(sprite.filename) end
  if not app.fs.isDirectory(output) then output=app.fs.userDocsPath end
  local prefix=app.fs.fileTitle(sprite.filename)
  if prefix == '' then prefix='sprite' end
  local function objects()
    local key=dialog.data.mode
    if not cache[key] then
      if key == selected then cache[key]=M.selected(image,selection)
      elseif key == whole then cache[key]={{image=image,bounds=image.bounds}}
      else cache[key]=M.objects(image) end
    end
    return cache[key]
  end
  local function update()
    local ok,value=pcall(objects)
    dialog:modify{ id='count', text=ok and (#value .. ' PNG file(s), frame ' .. frame) or tostring(value) }
    dialog:modify{ id='write', enabled=ok and #value > 0 }
    dialog:modify{ id='hint', text=dialog.data.mode == whole and
      'Full canvas size, including transparent margins.' or
      'Touching objects stay together. Select an area to group pieces.' }
  end
  dialog=Dialog{title='Export PNGs',parent=parent}
  dialog:combobox{id='mode',label='Export:',options=options,option=mode,onchange=update}
  dialog:newrow()
  dialog:label{id='count',text=''}
  dialog:newrow()
  dialog:entry{id='folder',label='Folder:',text=output}
  dialog:button{text='Browse...',onclick=function()
    local chosen=folders.choose(dialog.data.folder,dialog,{title='Export folder',info='Choose where PNG files will be saved.'})
    if chosen then dialog:modify{id='folder',text=chosen} end
  end}
  dialog:newrow()
  dialog:entry{id='prefix',label='Filename prefix:',text=prefix}
  dialog:newrow()
  dialog:label{text='Names: prefix-001.png, prefix-002.png, ...'}
  dialog:newrow()
  dialog:label{text='Existing files are kept; numbering skips used names.'}
  dialog:newrow()
  dialog:label{id='hint',text=''}
  dialog:newrow()
  dialog:button{id='write',text='Export',onclick=function()
    local ok,value=pcall(function() return M.save(image,objects(),dialog.data.folder,dialog.data.prefix) end)
    if not ok then app.alert{title='Export failed',text=tostring(value)}; return end
    result={paths=value,directory=dialog.data.folder}
    dialog:close()
  end}
  dialog:button{text='Cancel'}
  update()
  dialog:show()
  return result
end

return M
