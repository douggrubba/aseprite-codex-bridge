-- Native UI for the existing live bridge. Codex itself runs in the Node helper.
local M = {}
local directory = app.fs.filePath(debug.getinfo(1, 'S').source:sub(2))
local references = dofile(app.fs.joinPath(directory, 'references.lua'))

function M.create(core, root, session, disconnect)
  local panel = { threads={}, pending=nil, response='' }
  local dialog
  local spinnerFrame = 0
  local spinnerDots = {{7,1}, {11,3}, {13,7}, {11,11}, {7,13}, {3,11}, {1,7}, {3,3}}
  local function read(name)
    local ok, value = pcall(core.read, app.fs.joinPath(root, name))
    if ok then return value end
  end
  local function modify(id, text)
    if dialog.data[id] ~= text then dialog:modify{ id=id, text=text } end
  end
  local function shorten(text, length)
    text = tostring(text):gsub('[\r\n]+', ' ')
    if #text > length then return text:sub(1, length-3) .. '...' end
    return text
  end
  local function message(text)
    panel.response = tostring(text)
    local lines, line = {}, ''
    for word in panel.response:gmatch('%S+') do
      if #line + #word > 58 then lines[#lines+1] = line; line = '' end
      line = line == '' and word or line .. ' ' .. word
    end
    if line ~= '' then lines[#lines+1] = line end
    for i=1,3 do modify('message' .. i, shorten(lines[i] or '', 60)) end
    dialog:modify{ id='details', enabled=#panel.response > 0 }
  end
  local function available()
    local heartbeat = read('assistant-heartbeat.json')
    return heartbeat and os.time() - heartbeat.time < 5
  end
  local models, catalog, settingsSignature = {}, nil, nil
  local preferences = read('assistant-preferences.json') or {}
  local referenceDir = type(preferences.reference_dir) == 'string' and preferences.reference_dir or ''
  local referenceError
  local updatingSettings, lastSettingsCheck = false, nil
  local function includes(items, value)
    for _, item in ipairs(items) do if item == value then return true end end
    return false
  end
  local function setEfforts(preferred)
    local model = models[dialog.data.model]
    -- json.decode arrays can be userdata; native combobox options require a Lua table.
    local efforts = {}
    if model then
      for _, effort in ipairs(model.efforts) do efforts[#efforts+1] = effort end
    else
      efforts = {'CLI default'}
    end
    if #efforts == 0 then efforts = {'Not supported'} end
    local effort = includes(efforts, preferred) and preferred or
      (model and model.default_effort or 'CLI default')
    if not includes(efforts, effort) then effort = efforts[1] end
    dialog:modify{ id='effort', options=efforts, option=effort }
  end
  local function rememberSettings()
    local ok, err = pcall(core.write, app.fs.joinPath(root, 'assistant-preferences.json'),
      {model=dialog.data.model, effort=dialog.data.effort, reference_dir=referenceDir})
    if not ok then message('Could not remember settings: ' .. tostring(err)) end
  end
  local function updateReferences()
    referenceError = nil
    modify('reference_dir', referenceDir ~= '' and shorten(referenceDir, 55) or 'None')
    if referenceDir == '' then
      modify('reference_info', 'PNG, JPEG, WebP — up to ' .. references.limit .. ' images')
      return
    end
    local ok, folders, count = pcall(references.scan, referenceDir)
    if not ok then referenceError=tostring(folders)
    elseif count == 0 then referenceError='No PNG, JPEG, or WebP images in this folder.' end
    modify('reference_info', referenceError and shorten(referenceError, 65) or references.summary(count))
  end
  local function refreshSettings()
    if lastSettingsCheck == os.time() then return end
    lastSettingsCheck = os.time()
    local heartbeat = read('assistant-heartbeat.json')
    if not heartbeat or heartbeat.settings_version ~= 1 then return end
    local settings = read('assistant-settings.json')
    if not settings or settings.version ~= 1 then return end
    local options, signature = {}, {}
    for _, model in ipairs(settings.models or {}) do
      options[#options+1] = model.id
      signature[#signature+1] = model.id .. ':' .. table.concat(model.efforts, ',') .. ':' .. tostring(model.default_effort)
    end
    if #options == 0 then
      models, catalog, settingsSignature = {}, nil, nil
      updatingSettings = true
      dialog:modify{ id='model', options={'CLI default'}, option='CLI default' }
      setEfforts(nil)
      updatingSettings = false
      modify('model_note', 'Model list unavailable — restart the helper to retry')
      return
    end
    local key = table.concat(signature, '|') .. ':' .. tostring(settings.default_model) .. ':' .. tostring(settings.default_effort)
    if key == settingsSignature then return end
    local selected = catalog and dialog.data.model or preferences.model
    local effort = catalog and dialog.data.effort or preferences.effort
    models = {}
    for _, model in ipairs(settings.models) do models[model.id] = model end
    if not models[selected] then
      selected = models[settings.default_model] and settings.default_model or options[1]
      effort = settings.default_effort
    end
    catalog, settingsSignature = settings, key
    updatingSettings = true
    dialog:modify{ id='model', options=options, option=selected }
    setEfforts(effort)
    updatingSettings = false
    modify('model_note', '')
  end
  function panel.cancel()
    if panel.pending then
      core.write(app.fs.joinPath(panel.pending.job, 'cancel.json'), { time=os.time() })
      panel.pending.stopping = true
      modify('status', 'Stopping — review any changes on the canvas')
    end
  end
  local function submit()
    if panel.pending or not app.sprite or not available() then return end
    local helper = read('assistant-heartbeat.json')
    if referenceDir ~= '' then
      if not helper or helper.references_version ~= 1 then
        message('Restart the helper to use style reference images.')
        return
      end
      updateReferences()
      if referenceError then message(referenceError); return end
    end
    if models[dialog.data.model] and (not helper or helper.settings_version ~= 1) then
      message('Restart the helper to use the selected model and effort.')
      return
    end
    local prompt = dialog.data.prompt:match('^%s*(.-)%s*$')
    if #prompt == 0 then return end
    if #prompt > 8000 then message('Keep the instruction under 8000 characters.'); return end
    local sprite = app.sprite
    local job = app.fs.joinPath(root, 'assistant-job-' .. tostring(Uuid()))
    local ok, err = pcall(function()
      app.fs.makeDirectory(job)
      local bounds = sprite.selection.bounds
      core.write(app.fs.joinPath(job, 'request.json'), {
        session=session, sprite_id=sprite.id, prompt=prompt, expires=os.time()+30,
        frame=app.frame and app.frame.frameNumber or 1,
        layer=app.layer and app.layer.name or '', thread_id=panel.threads[sprite.id],
        model=models[dialog.data.model] and dialog.data.model or nil,
        effort=models[dialog.data.model] and #models[dialog.data.model].efforts > 0 and dialog.data.effort or nil,
        reference_dir=referenceDir ~= '' and referenceDir or nil,
        context={ sprite=core.describe(sprite), selection={ empty=sprite.selection.isEmpty,
          x=bounds.x, y=bounds.y, width=bounds.width, height=bounds.height } }
      })
    end)
    if not ok then message('Could not send instruction: ' .. tostring(err)); return end
    panel.pending = { job=job, sprite_id=sprite.id, started=os.time() }
    spinnerFrame = 0
    modify('prompt', '')
    message('')
    modify('status', 'Waiting for Codex...')
    panel.tick()
  end
  -- Esc or the window close button hides the panel; only Disconnect stops the bridge.
  dialog = Dialog{ title='Codex assistant' }
  dialog:label{ id='target', label='Sprite:', text='Open a sprite to begin' }
  dialog:newrow()
  dialog:combobox{ id='model', label='Model:', options={'CLI default'}, option='CLI default', enabled=false,
    onchange=function()
      if updatingSettings or panel.pending then return end
      updatingSettings = true
      setEfforts(dialog.data.effort)
      updatingSettings = false
      rememberSettings()
    end }
  dialog:newrow()
  dialog:combobox{ id='effort', label='Effort:', options={'CLI default'}, option='CLI default', enabled=false,
    onchange=function()
      if not updatingSettings and not panel.pending then rememberSettings() end
    end }
  dialog:newrow()
  dialog:label{ id='model_note', text='Start the helper to choose a model' }
  dialog:newrow()
  dialog:label{ id='reference_dir', label='Style refs:', text='None' }
  dialog:newrow()
  dialog:button{ id='browse_refs', text='Choose folder...', onclick=function()
    local ok, selected = pcall(references.choose, referenceDir, dialog)
    if not ok then message(tostring(selected)); return end
    if selected then referenceDir=selected; updateReferences(); rememberSettings(); panel.tick() end
  end }
  dialog:button{ id='clear_refs', text='Clear references', onclick=function()
    referenceDir=''
    updateReferences()
    rememberSettings()
    panel.tick()
  end }
  dialog:newrow()
  dialog:label{ id='reference_info', text='' }
  dialog:newrow()
  dialog:entry{ id='prompt', label='Instruction:', text='', focus=true,
    onchange=function() panel.tick() end }
  dialog:newrow()
  dialog:button{ id='send', text='Send', enabled=false, onclick=submit }
  dialog:button{ id='cancel', text='Stop', enabled=false, onclick=panel.cancel }
  dialog:button{ id='new', text='New conversation', onclick=function()
    if app.sprite then panel.threads[app.sprite.id] = nil end
    message('Started a new conversation for this sprite.')
  end }
  dialog:newrow()
  -- Keep this row allocated while idle so the panel does not jump as work starts.
  dialog:canvas{ id='spinner', width=16, height=16, hexpand=false, vexpand=false,
    onpaint=function(ev)
      local gc = ev.context
      gc.color = gc.theme.color.window_face
      gc:fillRect(Rectangle(0, 0, gc.width, gc.height))
      if panel.pending then
        gc.color = gc.theme.color.text
        for i, point in ipairs(spinnerDots) do
          gc.opacity = 255 - ((spinnerFrame - (i-1)) % #spinnerDots) * 26
          gc:fillRect(Rectangle(point[1], point[2], 2, 2))
        end
        gc.opacity = 255
      end
    end }
  dialog:label{ id='activity', text='' }
  dialog:newrow()
  dialog:label{ id='status', text='Start the helper with npm run assistant' }
  dialog:newrow()
  for i=1,3 do dialog:label{ id='message' .. i, text='' }; dialog:newrow() end
  dialog:button{ id='details', text='Read response', enabled=false, onclick=function()
    local lines = {}
    for line in (panel.response .. '\n'):gmatch('(.-)\n') do
      while #line > 75 do
        local cut = line:sub(1,75):match('^.*()%s') or 75
        lines[#lines+1] = line:sub(1, cut)
        line = line:sub(cut+1)
      end
      lines[#lines+1] = line
    end
    app.alert{ title='Codex response', text=lines }
  end }
  dialog:newrow()
  dialog:button{ id='undo', text='Undo', onclick=function()
    local ok, err = pcall(app.undo)
    if not ok then message(tostring(err)) end
    app.refresh()
  end }
  dialog:button{ id='redo', text='Redo', onclick=function()
    local ok, err = pcall(app.redo)
    if not ok then message(tostring(err)) end
    app.refresh()
  end }
  dialog:button{ id='disconnect', text='Disconnect', focus=false, onclick=function()
    disconnect()
    dialog:close()
  end }

  function panel.tick(animate)
    local pending = panel.pending
    if pending then
      local ok, result = pcall(core.read, app.fs.joinPath(pending.job, 'response.json'))
      if ok then
        if result.thread_id then panel.threads[pending.sprite_id] = result.thread_id end
        message(result.ok and result.message or ('Error: ' .. tostring(result.error)))
        core.write(app.fs.joinPath(pending.job, 'acknowledged.json'), { time=os.time() })
        panel.pending = nil
      else
        local progressOk, progress = pcall(core.read, app.fs.joinPath(pending.job, 'progress.json'))
        if progressOk and not pending.stopping then modify('status', shorten(progress.text, 65)) end
        if not available() then
          modify('status', 'Helper offline — stop before sending another request')
          -- Cancellation survives worker restarts and prevents a queued edit later.
          if os.time() - pending.started > 5 then
            panel.cancel()
            panel.pending = nil
            message('The helper disconnected. The request was cancelled. Changes may already have applied; review the canvas before retrying.')
          end
        end
      end
    end
    local sprite, busy = app.sprite, panel.pending ~= nil
    if not busy then refreshSettings() end
    local helper = read('assistant-heartbeat.json')
    local settingsEnabled = not busy and available() and helper ~= nil and helper.settings_version == 1 and catalog ~= nil
    dialog:modify{ id='model', enabled=settingsEnabled }
    dialog:modify{ id='effort', enabled=settingsEnabled and #models[dialog.data.model].efforts > 0 }
    if busy then
      if animate then spinnerFrame = (spinnerFrame + 1) % #spinnerDots end
      local elapsed = math.max(0, os.time() - panel.pending.started)
      modify('activity', (panel.pending.stopping and 'Stopping' or 'Working') .. ' — ' .. elapsed .. 's')
    else
      modify('activity', '')
    end
    -- The bridge's existing 200 ms timer drives animation, including silent turns.
    dialog:repaint()
    local target = busy and ('Editing sprite #' .. panel.pending.sprite_id) or
      (sprite and (app.fs.fileName(sprite.filename) ~= '' and app.fs.fileName(sprite.filename) or 'Untitled') .. ' (#' .. sprite.id .. ')' or 'Open a sprite to begin')
    modify('target', shorten(target, 55))
    dialog:modify{ id='send', enabled=not busy and sprite ~= nil and available() and dialog.data.prompt:match('%S') ~= nil }
    dialog:modify{ id='cancel', enabled=busy }
    dialog:modify{ id='new', enabled=not busy and sprite ~= nil }
    dialog:modify{ id='undo', enabled=not busy and sprite ~= nil }
    dialog:modify{ id='redo', enabled=not busy and sprite ~= nil }
    dialog:modify{ id='browse_refs', enabled=not busy }
    dialog:modify{ id='clear_refs', enabled=not busy and referenceDir ~= '' }
    if not busy then modify('status', available() and 'Ready — describe a change above' or 'Start the helper with npm run assistant') end
  end
  panel.dialog = dialog
  updateReferences()
  panel.tick()
  return panel
end

return M
