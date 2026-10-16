local directory = app.fs.filePath(debug.getinfo(1, 'S').source:sub(2))
local core = dofile(app.fs.joinPath(directory, 'core.lua'))
local job = assert(app.params.job, 'Missing job script parameter.')
core.process(job)
