local M = {}

function M.read(filename)
  local file = assert(io.open(filename, 'rb'))
  local text = file:read('*a')
  file:close()
  return json.decode(text)
end

function M.write(filename, value)
  local encoded = json.encode(value)
  local file = assert(io.open(filename .. '.tmp', 'wb'))
  assert(file:write(encoded))
  file:close()
  -- Aseprite wraps os.rename with a move that refuses an existing destination.
  -- Readers retry the brief missing-file window; they never see partial JSON.
  if app.fs.isFile(filename) then assert(os.remove(filename)) end
  assert(os.rename(filename .. '.tmp', filename))
end

local function layers(items)
  local result = {}
  for _, layer in ipairs(items) do
    local entry = { name=layer.name, visible=layer.isVisible, editable=layer.isEditable,
      group=layer.isGroup, opacity=layer.opacity, stackIndex=layer.stackIndex }
    if layer.isGroup then entry.layers = layers(layer.layers) end
    result[#result+1] = entry
  end
  return result
end

function M.describe(sprite)
  if not sprite then return nil end
  local frames, tags = {}, {}
  for _, frame in ipairs(sprite.frames) do
    frames[#frames+1] = { number=frame.frameNumber, duration=frame.duration }
  end
  for _, tag in ipairs(sprite.tags) do
    tags[#tags+1] = { name=tag.name, from=tag.fromFrame.frameNumber, to=tag.toFrame.frameNumber }
  end
  return { id=sprite.id, filename=sprite.filename, width=sprite.width, height=sprite.height,
    modified=sprite.isModified, colorMode=tostring(sprite.colorMode), layers=layers(sprite.layers),
    frames=frames, tags=tags }
end

local function spriteFor(request)
  if request.sprite_id then
    for _, sprite in ipairs(app.sprites) do
      if sprite.id == request.sprite_id then return sprite end
    end
    error('Requested sprite is no longer open; inspect the session again.')
  end
  return app.sprite
end

local function destination(filename, overwrite)
  assert(type(filename) == 'string' and filename:sub(1, 1) == '/', 'Use an absolute output path.')
  assert(not app.fs.isFile(filename) or overwrite == true, 'Output exists; set overwrite=true explicitly.')
  assert(app.fs.isDirectory(app.fs.filePath(filename)), 'Output parent directory does not exist.')
end

function M.execute(request, job)
  if request.input then
    assert(not app.isUIAvailable, 'input is only valid in batch mode; use open for live mode.')
    assert(app.open(request.input), 'Cannot open input file.')
  end
  local sprite = spriteFor(request)
  local op = request.op
  if op == 'inspect' then
    local sprites = {}
    for _, item in ipairs(app.sprites) do sprites[#sprites+1] = M.describe(item) end
    return { active=M.describe(sprite), sprites=sprites, version=tostring(app.version),
      frame=app.frame and app.frame.frameNumber, layer=app.layer and app.layer.name }
  elseif op == 'open' then
    return { sprite=M.describe(assert(app.open(request.path), 'Cannot open file.')) }
  elseif op == 'run' then
    if sprite then app.sprite = sprite end
    local fn, err = load(request.code, 'codex-edit', 't', _G)
    assert(fn, err)
    local value
    local function run() value = fn() end
    if sprite and request.transaction ~= false then app.transaction('Codex: ' .. (request.label or 'edit'), run)
    else run() end
    app.refresh()
    return { result=value, sprite=M.describe(app.sprite) }
  elseif op == 'save' then
    assert(sprite, 'No active sprite.')
    destination(request.path, request.overwrite)
    local ext = app.fs.fileExtension(request.path):lower()
    assert(ext == 'aseprite' or ext == 'ase', 'Save uses .aseprite or .ase to preserve layers and frames.')
    sprite:saveAs(request.path)
    return { path=request.path, sprite=M.describe(sprite) }
  elseif op == 'preview' then
    assert(sprite, 'No active sprite.')
    local frame = request.frame or (app.frame and app.frame.frameNumber) or 1
    assert(frame >= 1 and frame <= #sprite.frames, 'Frame is out of range.')
    local scale = request.scale or 1
    assert(sprite.width * scale <= 4096 and sprite.height * scale <= 4096, 'Preview dimensions must be at most 4096 pixels.')
    local image = Image(sprite.width, sprite.height, ColorMode.RGB)
    image:drawSprite(sprite, frame)
    if scale ~= 1 then image:resize{ width=sprite.width*scale, height=sprite.height*scale } end
    image:saveAs(app.fs.joinPath(job, 'preview.png'))
    return { width=image.width, height=image.height, frame=frame }
  elseif op == 'export' then
    assert(sprite, 'No active sprite.')
    destination(request.path, request.overwrite)
    assert(app.fs.fileExtension(request.path):lower() == 'png', 'Sprite sheet path must end in .png.')
    if request.data_path then
      destination(request.data_path, request.overwrite)
      assert(app.fs.fileExtension(request.data_path):lower() == 'json', 'Metadata path must end in .json.')
    end
    app.sprite = sprite
    app.command.ExportSpriteSheet{ ui=false, recent=false, askOverwrite=false, type=SpriteSheetType.HORIZONTAL,
      textureFilename=request.path, dataFilename=request.data_path or '',
      dataFormat=SpriteSheetDataFormat.JSON_ARRAY, listLayers=true, listTags=true,
      listSlices=true, trim=false, trimSprite=false, trimByGrid=false, extrude=false,
      ignoreEmpty=false, mergeDuplicates=false, openGenerated=false,
      borderPadding=0, shapePadding=0, innerPadding=0, width=0, height=0,
      columns=0, rows=0, bestFit=false, splitLayers=false, splitTags=false }
    assert(app.fs.isFile(request.path), 'Aseprite did not produce the sprite sheet.')
    return { path=request.path, data_path=request.data_path }
  end
  error('Unknown operation: ' .. tostring(op))
end

function M.process(job, session)
  local pending = app.fs.joinPath(job, 'request.json')
  if not app.fs.isFile(pending) then return end
  local claimed = app.fs.joinPath(job, 'running.json')
  if not os.rename(pending, claimed) then return end
  local ok, value = xpcall(function()
    local request = M.read(claimed)
    assert(request.expires >= os.time(), 'Request expired without being executed.')
    assert(not session or request.session == session, 'Request belongs to a previous connection.')
    return M.execute(request, job)
  end, debug.traceback)
  local response = ok and {ok=true, data=value} or {ok=false, error=tostring(value)}
  local written, err = pcall(M.write, app.fs.joinPath(job, 'response.json'), response)
  if not written then
    M.write(app.fs.joinPath(job, 'response.json'), {ok=false, error='Response encoding failed: ' .. tostring(err)})
  end
end

return M
