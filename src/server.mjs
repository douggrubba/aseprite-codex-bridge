import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge } from './bridge.mjs';

const bridge = new Bridge();
const server = new McpServer({ name: 'aseprite', version: '0.1.0' }, {
  instructions: 'Control Linux Aseprite. Live mode is the default and edits the running GUI. Call aseprite_status and aseprite_inspect first. Pin edits to sprite_id from inspect. Use aseprite_preview to see results. Batch mode runs in a separate process and does not see unsaved GUI changes. Batch run code must explicitly save any output before the process exits. Lua has full local script access. For undoable pixel edits, clone cel.image, draw on the clone, then assign cel.image = clone inside the default transaction; direct drawPixel on a cel image is not undoable. Never close or overwrite user work unless requested. Do not automatically retry a timed-out live edit.',
});
const absolute = z.string().min(1).refine(p => p.startsWith('/') && !p.includes('\0'), 'Use an absolute Linux path');
const context = {
  mode: z.enum(['live', 'batch']).default('live'),
  input: absolute.optional().describe('Batch only: file to open before the operation.'),
  sprite_id: z.number().int().positive().optional().describe('Live only: pin operation to an open sprite ID from inspect.'),
};

function register(name, description, schema, operation, readOnly = false) {
  server.registerTool(name, {
    description, inputSchema: schema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: name === 'aseprite_run_lua' },
  }, async args => {
    try {
      if (args.mode === 'live' && args.input) throw new Error('input requires batch mode; use aseprite_open for live mode.');
      if (args.mode === 'batch' && args.sprite_id) throw new Error('sprite_id requires live mode.');
      const result = await operation(args);
      const { png, ...metadata } = result;
      const content = [{ type: 'text', text: JSON.stringify(metadata) }];
      if (png) content.push({ type: 'image', mimeType: 'image/png', data: png });
      return { content };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}
const call = op => ({mode, ...args}) => bridge.request({op, ...args}, mode);

register('aseprite_status', 'Check live GUI connection and locate the Aseprite executable.', {}, () => bridge.status(), true);
register('aseprite_inspect', 'Inspect dimensions, layers, frame durations, tags and open sprite IDs.', context, call('inspect'), true);
register('aseprite_open', 'Open a file in the connected Aseprite GUI without closing existing documents.', {path:absolute}, args => bridge.request({op:'open', ...args}));
register('aseprite_run_lua', 'Run Lua with the full Aseprite API. Return JSON-compatible values. Live edits default to an undo transaction. Batch outputs must be saved in the script. Do not use blocking loops or dialogs.', {
  ...context, code:z.string().min(1).max(256000), label:z.string().max(100).optional(),
  transaction:z.boolean().default(true),
}, call('run'));
register('aseprite_preview', 'Return a flattened PNG preview of a sprite frame; frame numbers are 1-based.', {
  ...context, frame:z.number().int().positive().optional(), scale:z.number().int().min(1).max(16).default(1),
}, call('preview'), true);
register('aseprite_save', 'Save the active or specified sprite as .aseprite/.ase. Existing output requires overwrite=true.', {
  ...context, path:absolute, overwrite:z.boolean().default(false),
}, call('save'));
register('aseprite_export_sheet', 'Export all frames as a horizontal PNG sprite sheet and optional JSON metadata.', {
  ...context, path:absolute, data_path:absolute.optional(), overwrite:z.boolean().default(false),
}, call('export'));

await bridge.init();
await server.connect(new StdioServerTransport());
