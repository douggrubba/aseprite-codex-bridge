import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge, projectDir } from '../src/bridge.mjs';

const bridge = new Bridge();
await bridge.init();
const home = os.homedir();
const configs = [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'aseprite')];
for (const candidate of [
  path.join(home, 'snap/steam/common/.config/aseprite'),
  path.join(home, '.var/app/com.valvesoftware.Steam/config/aseprite'),
]) {
  try { await fs.access(candidate); configs.push(candidate); } catch {}
}
for (const config of new Set(configs)) {
  const scripts = path.join(config, 'scripts');
  const support = path.join(scripts, 'codex-bridge-support');
  await fs.mkdir(support, {recursive:true});
  await fs.copyFile(path.join(projectDir, 'aseprite/codex-bridge.lua'), path.join(scripts, 'codex-bridge.lua'));
  await fs.copyFile(path.join(projectDir, 'aseprite/core.lua'), path.join(support, 'core.lua'));
  await fs.writeFile(path.join(support, 'config.json'), JSON.stringify({directory:bridge.root}, null, 2));
  console.log(`Installed: ${path.join(scripts, 'codex-bridge.lua')}`);
}
console.log(JSON.stringify(await bridge.status(), null, 2));
console.log('\nNext: in Aseprite, File > Scripts > Rescan Scripts Folder, then File > Scripts > codex-bridge.');
