-- Dialog has no native multiline entry. Keep editing and layout inside one canvas.
local M = {}

function M.add(dialog, options)
  local editor = {}
  local chars, cursor, anchor, scroll = {}, 0, 0, 0
  local rows, lineHeight, visible = {}, 10, 6
  local dirty, reveal, dragging = true, true, false
  local undo, redo = {}, {}
  local padding = 4
  local function split(text)
    local result = {}
    text = text:gsub('\r\n', '\n'):gsub('\r', '\n'):gsub('\t', '    ')
    for _, code in utf8.codes(text) do
      if code >= 32 or code == 10 then result[#result+1] = utf8.char(code) end
    end
    return result
  end
  function editor:getText() return table.concat(chars) end
  local function changed()
    dirty, reveal = true, true
    if options.onchange then options.onchange() end
    dialog:repaint()
  end
  function editor:setText(text)
    chars = split(text)
    cursor, anchor, scroll = #chars, #chars, 0
    undo, redo = {}, {}
    changed()
  end
  local function snapshot() return {editor:getText(), cursor, anchor} end
  local function restore(state)
    chars, cursor, anchor = split(state[1]), state[2], state[3]
    changed()
  end
  local function selection() return math.min(cursor, anchor), math.max(cursor, anchor) end
  local function replace(text)
    local first, last = selection()
    local inserted = split(text)
    -- Match the panel's existing 8000-byte request limit without splitting UTF-8.
    local bytes = #editor:getText() - #table.concat(chars, '', first+1, last)
    for _, char in ipairs(inserted) do bytes = bytes + #char end
    if bytes > 8000 then
      if options.onlimit then options.onlimit() end
      return
    end
    undo[#undo+1] = snapshot()
    if #undo > 100 then table.remove(undo, 1) end
    redo = {}
    local result = {}
    for i=1,first do result[#result+1] = chars[i] end
    for _, char in ipairs(inserted) do result[#result+1] = char end
    for i=last+1,#chars do result[#result+1] = chars[i] end
    chars, cursor = result, first + #inserted
    anchor = cursor
    changed()
  end
  local function move(position, selecting)
    cursor = math.max(0, math.min(#chars, position))
    if not selecting then anchor = cursor end
    reveal = true
    dialog:repaint()
  end
  local function caretRow()
    for i=#rows,1,-1 do if cursor >= rows[i].first then return i end end
    return 1
  end
  local function nearest(row, x)
    local position, distance = row.first, math.huge
    for i=row.first,row.last do
      local delta = math.abs(x - row.x[i])
      if delta < distance then position, distance = i, delta end
    end
    return position
  end
  local function hit(ev)
    local row = rows[math.max(1, math.min(#rows, math.floor((ev.y-padding)/lineHeight)+scroll+1))]
    return row and nearest(row, ev.x-padding) or 0
  end
  local lastWidth, lastFontHeight
  dialog:canvas{ id=options.id, label=options.label, focus=true,
    width=300, height=72, vexpand=false,
    onpaint=function(ev)
      local gc = ev.context
      local fontHeight = gc:measureText('M').height
      lineHeight = fontHeight + 2
      visible = math.max(1, math.floor((gc.height-padding*2)/lineHeight))
      if dirty or lastWidth ~= gc.width or lastFontHeight ~= fontHeight then
        rows = {}
        local widths = {}
        local function width(char)
          if not widths[char] then widths[char] = gc:measureText(char).width end
          return widths[char]
        end
        local first = 0
        repeat
          local last, used, space = first, 0, nil
          while last < #chars and chars[last+1] ~= '\n' do
            local nextWidth = width(chars[last+1])
            if used + nextWidth > gc.width-padding*2-5 and last > first then
              if space then last = space end
              break
            end
            last, used = last+1, used+nextWidth
            if chars[last] == ' ' then space = last end
          end
          local row = {first=first, last=last, x={[first]=0}}
          for i=first+1,last do row.x[i] = row.x[i-1] + width(chars[i]) end
          rows[#rows+1] = row
          if last == #chars then break end
          first = chars[last+1] == '\n' and last+1 or last
        until false
        dirty, lastWidth, lastFontHeight = false, gc.width, fontHeight
      end
      local caret = caretRow()
      if reveal then
        if caret <= scroll then scroll = caret-1 end
        if caret > scroll+visible then scroll = caret-visible end
        reveal = false
      end
      scroll = math.max(0, math.min(math.max(0, #rows-visible), scroll))
      local colors = gc.theme.color
      gc.color = colors.background or colors.window_face
      gc:fillRect(Rectangle(0, 0, gc.width, gc.height))
      gc.color = colors.text
      gc:strokeRect(Rectangle(0, 0, gc.width-1, gc.height-1))
      local first, last = selection()
      for i=scroll+1,math.min(#rows, scroll+visible) do
        local row, y = rows[i], padding+(i-scroll-1)*lineHeight
        local left, right = math.max(first, row.first), math.min(last, row.last)
        if right > left or (last > row.last and first <= row.last) then
          gc.color = colors.selected or Color{r=65, g=95, b=145}
          gc:fillRect(Rectangle(padding+row.x[left], y,
            (row.x[right] or row.x[row.last])+ (last > row.last and 2 or 0)-row.x[left], lineHeight))
        end
        gc.color = colors.text
        gc:fillText(table.concat(chars, '', row.first+1, row.last), padding, y)
        if right > left then
          gc.color = colors.selected_text or colors.text
          gc:fillText(table.concat(chars, '', left+1, right), padding+row.x[left], y)
        end
        gc.color = colors.text
        if cursor == anchor and i == caret then
          gc:fillRect(Rectangle(padding+row.x[cursor], y, 1, fontHeight))
        end
      end
      if #rows > visible then
        gc.color = colors.text
        local track = gc.height-padding*2
        gc:fillRect(Rectangle(gc.width-4, padding+track*scroll/#rows, 2,
          math.max(3, track*visible/#rows)))
      end
    end,
    onkeydown=function(ev)
      local code, shortcut = ev.code, ev.ctrlKey or ev.metaKey
      -- Leave normal dialog focus traversal and Escape available.
      if code == 'Tab' or code == 'Escape' then return end
      ev:stopPropagation()
      if shortcut and code == 'KeyA' then
        anchor=0; move(#chars, true)
      elseif shortcut and (code == 'KeyC' or code == 'KeyX') then
        local first, last = selection()
        if last > first then
          app.clipboard.text = table.concat(chars, '', first+1, last)
          if code == 'KeyX' then replace('') end
        end
      elseif shortcut and code == 'KeyV' then
        replace(app.clipboard.text or '')
      elseif shortcut and (code == 'KeyZ' or code == 'KeyY') then
        local from, to = undo, redo
        if code == 'KeyY' or ev.shiftKey then from, to = redo, undo end
        if #from > 0 then to[#to+1] = snapshot(); restore(table.remove(from)) end
      elseif code == 'Enter' or code == 'NumpadEnter' then
        replace('\n')
      elseif code == 'Backspace' or code == 'Delete' then
        if cursor == anchor then
          anchor = math.max(0, math.min(#chars, cursor+(code == 'Backspace' and -1 or 1)))
        end
        if cursor ~= anchor then replace('') end
      elseif code == 'ArrowLeft' or code == 'ArrowRight' then
        local first, last = selection()
        local position = cursor+(code == 'ArrowLeft' and -1 or 1)
        if not ev.shiftKey and first ~= last then position = code == 'ArrowLeft' and first or last end
        move(position, ev.shiftKey)
      elseif code == 'Home' or code == 'End' then
        local row = rows[caretRow()]
        move(shortcut and (code == 'Home' and 0 or #chars) or
          (row and (code == 'Home' and row.first or row.last) or cursor), ev.shiftKey)
      elseif code == 'ArrowUp' or code == 'ArrowDown' or code == 'PageUp' or code == 'PageDown' then
        local index = caretRow()
        local step = (code == 'PageUp' or code == 'PageDown') and visible or 1
        local target = math.max(1, math.min(#rows, index+((code == 'ArrowUp' or code == 'PageUp') and -step or step)))
        if rows[index] and rows[target] then move(nearest(rows[target], rows[index].x[cursor]), ev.shiftKey) end
      elseif not shortcut and not ev.altKey and ev.key and ev.key ~= '' then
        replace(ev.key)
      end
    end,
    onkeyup=function(ev)
      if ev.code ~= 'Tab' and ev.code ~= 'Escape' then ev:stopPropagation() end
    end,
    onmousedown=function(ev)
      if ev.button ~= MouseButton.LEFT then return end
      dragging = true
      move(hit(ev), ev.shiftKey)
    end,
    onmousemove=function(ev) if dragging then move(hit(ev), true) end end,
    onmouseup=function() dragging=false end,
    onwheel=function(ev)
      scroll = math.max(0, math.min(math.max(0, #rows-visible), scroll+ev.deltaY*3))
      reveal = false
      dialog:repaint()
    end }
  return editor
end

return M
