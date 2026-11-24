local M = { defaultLimit=8 }
local extensions = {png=true, jpg=true, jpeg=true, webp=true}

function M.scan(directory)
  assert(type(directory) == 'string' and directory:sub(1,1) == '/' and app.fs.isDirectory(directory),
    'Choose an existing folder using an absolute path.')
  local folders, files, visited = {}, {}, {}
  local function visit(folder, relative, depth)
    -- AppFS cannot resolve directory symlinks; bound recursion to avoid cycles.
    if depth > 64 then return end
    local normalized = app.fs.normalizePath(folder)
    if visited[normalized] then return end
    visited[normalized] = true
    for _, name in ipairs(app.fs.listFiles(folder)) do
      local filename = app.fs.joinPath(folder, name)
      if app.fs.isDirectory(filename) then
        if depth == 0 then folders[#folders+1] = name end
        visit(filename, relative .. name .. '/', depth + 1)
      elseif app.fs.isFile(filename) and extensions[app.fs.fileExtension(name):lower()] then
        files[#files+1] = relative .. name
      end
    end
  end
  visit(directory, '', 0)
  table.sort(folders)
  table.sort(files)
  return folders, #files, files
end

function M.summary(count, limit, selected)
  limit = limit or M.defaultLimit
  if selected then return selected .. ' selected of ' .. count .. ' images (limit ' .. limit .. ')' end
  if count > limit then return 'Using first ' .. limit .. ' of ' .. count .. ' images (relative path order)' end
  return count .. ' reference image' .. (count == 1 and '' or 's') .. ' — PNG, JPEG, WebP'
end

local function fitText(gc, text, width)
  if gc:measureText(text).width <= width then return text end
  while #text > 0 and gc:measureText(text .. '...').width > width do
    text = text:sub(1, (utf8.offset(text, -1) or 1)-1)
  end
  return text .. '...'
end

local function checker(gc, x, y, width, height)
  for yy=0,height-1,6 do for xx=0,width-1,6 do
    gc.color = ((xx//6 + yy//6)%2 == 0) and Color{r=64,g=65,b=72} or Color{r=81,g=82,b=89}
    gc:fillRect(Rectangle(x+xx,y+yy,math.min(6,width-xx),math.min(6,height-yy)))
  end end
end

local function drawFitted(gc, image, x, y, width, height)
  local scale = math.min(width/image.width, height/image.height)
  local w,h = math.max(1,math.floor(image.width*scale)), math.max(1,math.floor(image.height*scale))
  gc:drawImage(image, image.bounds, Rectangle(x+(width-w)//2,y+(height-h)//2,w,h))
end

function M.preview(directory, name, parent)
  local image = assert(Image{fromFile=app.fs.joinPath(directory,name)}, 'Cannot preview this image.')
  local dialog = Dialog{title='Reference image preview', parent=parent}
  dialog:canvas{width=360,height=240,vexpand=false,onpaint=function(ev)
    local gc=ev.context
    checker(gc,0,0,gc.width,gc.height)
    drawFitted(gc,image,4,4,gc.width-8,gc.height-8)
  end}
  dialog:newrow()
  dialog:canvas{width=360,height=14,vexpand=false,onpaint=function(ev)
    local gc=ev.context
    gc.color=gc.theme.color.text
    gc:fillText(fitText(gc,name,gc.width),0,1)
  end}
  dialog:newrow()
  dialog:label{text=image.width .. ' x ' .. image.height .. ' pixels'}
  dialog:button{text='Close'}
  return dialog
end

-- Build separately from show() so the actual canvas callbacks can be exercised in tests.
function M.picker(directory, limit, selection, parent)
  local _, _, files = M.scan(directory)
  assert(#files > 0, 'No reference images in this folder or its subfolders.')
  local selected, filtered, cache = {}, {}, {}
  local page, pageSize, focused, cellWidth, cellHeight = 0, 8, nil, 100, 104
  local controller, dialog = {}, nil
  local wanted
  if selection then
    wanted={}
    for _,name in ipairs(selection) do wanted[name]=true end
  end
  local count=0
  for _,name in ipairs(files) do
    if count < limit and (not wanted or wanted[name]) then selected[name]=true;count=count+1 end
  end
  function controller.values()
    local values={}
    for _,name in ipairs(files) do if selected[name] then values[#values+1]=name end end
    return values
  end
  local function thumbnail(name)
    if cache[name] == nil then
      local ok,image=pcall(function()
        local source=assert(Image{fromFile=app.fs.joinPath(directory,name)})
        local scale=math.min(84/source.width,60/source.height)
        source:resize(math.max(1,math.floor(source.width*scale)),math.max(1,math.floor(source.height*scale)))
        return source
      end)
      cache[name]=ok and image or false
    end
    return cache[name]
  end
  local function refresh(status)
    local values=controller.values()
    local pages=math.max(1,math.ceil(#filtered/pageSize))
    page=math.max(0,math.min(page,pages-1))
    -- File access can open Aseprite's permission dialog. Do it before painting,
    -- never from onpaint, where the modal dialog would re-enter the painter.
    for slot=1,pageSize do
      local name=filtered[page*pageSize+slot]
      if name then thumbnail(name) end
    end
    dialog:modify{id='selection_info',text=status or (#values .. ' / ' .. limit .. ' selected - ' .. #filtered .. ' matching images')}
    dialog:modify{id='page_info',text='Page ' .. (page+1) .. ' of ' .. pages}
    dialog:modify{id='previous',enabled=page>0}
    dialog:modify{id='next',enabled=page<pages-1}
    dialog:modify{id='preview',enabled=focused~=nil}
    dialog:modify{id='use_images',enabled=#values>0}
    dialog:repaint()
  end
  local function filter()
    local query=(dialog.data.filter or ''):lower()
    filtered={}
    for _,name in ipairs(files) do if name:lower():find(query,1,true) then filtered[#filtered+1]=name end end
    page=0;cache={}
    refresh()
  end
  local function turn(delta)
    page=page+delta;cache={};refresh()
  end
  dialog=Dialog{title='Select style references',parent=parent}
  dialog:entry{id='filter',label='Filter:',text='',onchange=filter}
  dialog:newrow()
  dialog:label{id='selection_info',text=''}
  dialog:newrow()
  dialog:canvas{id='thumbnails',width=400,height=208,vexpand=false,focus=true,
    onpaint=function(ev)
      local gc=ev.context
      cellWidth=math.floor(gc.width/4);cellHeight=math.floor(gc.height/2)
      gc.color=gc.theme.color.window_face
      gc:fillRect(Rectangle(0,0,gc.width,gc.height))
      if #filtered==0 then gc.color=gc.theme.color.text;gc:fillText('No matching images.',8,8) end
      for slot=0,pageSize-1 do
        local name=filtered[page*pageSize+slot+1]
        if name then
          local x,y=(slot%4)*cellWidth,(slot//4)*cellHeight
          gc.color=selected[name] and Color{r=58,g=88,b=119} or gc.theme.color.window_face
          gc:fillRect(Rectangle(x+1,y+1,cellWidth-2,cellHeight-2))
          checker(gc,x+8,y+17,cellWidth-16,cellHeight-44)
          local image=cache[name]
          if image then drawFitted(gc,image,x+8,y+17,cellWidth-16,cellHeight-44)
          else gc.color=gc.theme.color.text;gc:fillText('No preview',x+8,y+35) end
          gc.color=selected[name] and Color{r=242,g=242,b=242} or gc.theme.color.text
          gc:strokeRect(Rectangle(x+5,y+4,9,9))
          if selected[name] then gc:fillText('x',x+7,y+4) end
          gc:fillText(fitText(gc,app.fs.fileName(name),cellWidth-10),x+5,y+cellHeight-24)
          local folder=app.fs.filePath(name)
          gc:fillText(fitText(gc,folder~='' and folder or '(root)',cellWidth-10),x+5,y+cellHeight-13)
          if focused==name then gc:strokeRect(Rectangle(x+1,y+1,cellWidth-3,cellHeight-3)) end
        end
      end
    end,
    onmousedown=function(ev)
      if ev.button~=MouseButton.LEFT then return end
      local col,row=math.floor(ev.x/cellWidth),math.floor(ev.y/cellHeight)
      if col<0 or col>3 or row<0 or row>1 then return end
      local name=filtered[page*pageSize+row*4+col+1]
      if not name then return end
      focused=name
      if selected[name] then selected[name]=nil
      elseif #controller.values()>=limit then refresh('Limit reached. Deselect an image or raise Max images.');return
      else selected[name]=true end
      refresh()
    end,
    onwheel=function(ev) if ev.deltaY~=0 then turn(ev.deltaY>0 and 1 or -1) end end}
  dialog:newrow()
  dialog:label{id='page_info',text=''}
  dialog:newrow()
  dialog:button{id='previous',text='Previous',onclick=function() turn(-1) end}
  dialog:button{id='next',text='Next',onclick=function() turn(1) end}
  dialog:newrow()
  dialog:button{id='preview',text='Preview focused image...',enabled=false,onclick=function()
    if not focused then return end
    local ok,err=pcall(function() M.preview(directory,focused,dialog):show() end)
    if not ok then refresh('Cannot preview: ' .. app.fs.fileName(focused)) end
  end}
  dialog:button{id='none',text='Deselect all',onclick=function() selected={};refresh() end}
  dialog:newrow()
  dialog:button{id='use_images',text='Use selected images',onclick=function()
    local values=controller.values()
    if #values==0 then return end
    for _,name in ipairs(values) do
      if not thumbnail(name) then refresh('Cannot read: ' .. app.fs.fileName(name));return end
    end
    controller.selected=values
    dialog:close()
  end}
  dialog:button{id='cancel',text='Cancel',onclick=function() dialog:close() end}
  controller.dialog=dialog
  filter()
  return controller
end

function M.pick(directory, limit, selection, parent)
  local picker=M.picker(directory,limit,selection,parent)
  picker.dialog:show()
  return picker.selected
end

-- Aseprite's file widget selects files, so use a native folder browser with no OS dependencies.
function M.choose(initial, parent, options)
  options=options or {}
  local current = initial ~= '' and initial or app.fs.userDocsPath
  if not app.fs.isDirectory(current) then current = app.fs.userDocsPath end
  local selected, dialog
  local function navigate(directory)
    -- The picker can start at the home directory. Only list the current level on the UI thread.
    local ok, folders = pcall(function()
      assert(type(directory) == 'string' and directory:sub(1,1) == '/' and app.fs.isDirectory(directory),
        'Choose an existing folder using an absolute path.')
      local children = {}
      for _, name in ipairs(app.fs.listFiles(directory)) do
        if app.fs.isDirectory(app.fs.joinPath(directory, name)) then children[#children+1] = name end
      end
      table.sort(children)
      return children
    end)
    if not ok then dialog:modify{ id='info', text=tostring(folders) }; return false end
    current = app.fs.normalizePath(directory)
    if #current > 1 then current = current:gsub('/+$', '') end
    dialog:modify{ id='path', text=current }
    dialog:modify{ id='folders', options=#folders > 0 and folders or {'(No subfolders)'}, option=folders[1] or '(No subfolders)' }
    dialog:modify{ id='open', enabled=#folders > 0 }
    dialog:modify{ id='up', enabled=current ~= '/' }
    dialog:modify{ id='info', text=options.info or '' }
    return true
  end
  dialog = Dialog{ title=options.title or 'Style reference folder', parent=parent }
  dialog:entry{ id='path', label='Path:', text=current, focus=true }
  dialog:button{ id='go', text='Go', onclick=function() navigate(dialog.data.path) end }
  dialog:newrow()
  dialog:combobox{ id='folders', label='Subfolders:', options={'(No subfolders)'} }
  dialog:newrow()
  dialog:button{ id='open', text='Open subfolder', onclick=function()
    navigate(app.fs.joinPath(current, dialog.data.folders))
  end }
  dialog:button{ id='up', text='Up', onclick=function()
    local directory = app.fs.filePath(current)
    navigate(directory ~= '' and directory or '/')
  end }
  dialog:newrow()
  dialog:label{ id='info', text='' }
  dialog:newrow()
  dialog:button{ id='use_folder', text='Use this folder', onclick=function()
    if navigate(dialog.data.path) then selected=current; dialog:close() end
  end }
  dialog:button{ text='Cancel', onclick=function() dialog:close() end }
  navigate(current)
  dialog:show()
  return selected
end

return M
