-- Installed alongside codex-bridge-support; invoke from File > Scripts.
if _G.codexBridge then
  _G.codexBridge.dialog:show{ wait=false }
  return
end
assert(app.isUIAvailable, 'Start this script in the Aseprite GUI.')
local directory = app.fs.joinPath(app.fs.filePath(debug.getinfo(1, 'S').source:sub(2)), 'codex-bridge-support')
local core = dofile(app.fs.joinPath(directory, 'core.lua'))
local config = core.read(app.fs.joinPath(directory, 'config.json'))
local root = config.directory
assert(app.fs.isDirectory(root), 'Run npm run setup first.')
local session = tostring(Uuid())
local previous
pcall(function() previous = core.read(app.fs.joinPath(root, 'heartbeat.json')) end)
if previous and os.time() - previous.time < 5 then
  app.alert('Another Aseprite window already owns the Codex bridge. Disconnect it first.')
  return
end
local timer, dialog
local function stop()
  if timer then timer:stop() end
  local ok, heartbeat = pcall(core.read, app.fs.joinPath(root, 'heartbeat.json'))
  if ok and heartbeat.session == session then os.remove(app.fs.joinPath(root, 'heartbeat.json')) end
  _G.codexBridge = nil
end
dialog = Dialog{ title='Codex bridge', onclose=stop }
dialog:label{ id='status', text='Connected — ready for Codex' }
dialog:label{ text='Close this dialog to disconnect.' }
dialog:button{ text='Disconnect', onclick=function() dialog:close() end }
local function tick()
  core.write(app.fs.joinPath(root, 'heartbeat.json'), {session=session, time=os.time(), version=tostring(app.version)})
  for _, name in ipairs(app.fs.listFiles(root)) do
    if name:match('^job%-') then core.process(app.fs.joinPath(root, name), session) end
  end
end
-- A tick can open a modal dialog (Aseprite's script file-access prompt), and the
-- timer keeps firing inside it. Skip ticks while one is still running so they
-- can't nest until the C stack overflows.
local busy = false
timer = Timer{ interval=0.2, ontick=function()
  if busy then return end
  busy = true
  local ok, err = pcall(tick)
  busy = false
  if not ok then
    timer:stop()
    print('Codex bridge: ' .. tostring(err))
    pcall(function() dialog:modify{ id='status', text='Bridge error — reconnect to retry' } end)
    stop()
  end
end }
_G.codexBridge = {dialog=dialog, timer=timer}
tick()
timer:start()
dialog:show{ wait=false }
