local M = { limit=8 }
local extensions = {png=true, jpg=true, jpeg=true, webp=true}

function M.scan(directory)
  assert(type(directory) == 'string' and directory:sub(1,1) == '/' and app.fs.isDirectory(directory),
    'Choose an existing reference folder using an absolute path.')
  local folders, count = {}, 0
  for _, name in ipairs(app.fs.listFiles(directory)) do
    local filename = app.fs.joinPath(directory, name)
    if app.fs.isDirectory(filename) then
      folders[#folders+1] = name
    elseif app.fs.isFile(filename) and extensions[app.fs.fileExtension(name):lower()] then
      count = count + 1
    end
  end
  table.sort(folders)
  return folders, count
end

function M.summary(count)
  if count > M.limit then return 'Using first ' .. M.limit .. ' of ' .. count .. ' images (filename order)' end
  return count .. ' reference image' .. (count == 1 and '' or 's') .. ' — PNG, JPEG, WebP'
end

-- Aseprite's file widget selects files, so use a native folder browser with no OS dependencies.
function M.choose(initial, parent)
  local current = initial ~= '' and initial or app.fs.userDocsPath
  if not app.fs.isDirectory(current) then current = app.fs.userDocsPath end
  local selected, dialog
  local function navigate(directory)
    local ok, folders, count = pcall(M.scan, directory)
    if not ok then dialog:modify{ id='info', text=tostring(folders) }; return false end
    current = app.fs.normalizePath(directory)
    if #current > 1 then current = current:gsub('/+$', '') end
    dialog:modify{ id='path', text=current }
    dialog:modify{ id='folders', options=#folders > 0 and folders or {'(No subfolders)'}, option=folders[1] or '(No subfolders)' }
    dialog:modify{ id='open', enabled=#folders > 0 }
    dialog:modify{ id='up', enabled=current ~= '/' }
    dialog:modify{ id='info', text=M.summary(count) }
    return true
  end
  dialog = Dialog{ title='Style reference folder', parent=parent }
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
