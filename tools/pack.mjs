// Builds dist/hotmic-v<version>.zip — the store-upload package.
// Runtime files only: manifest, src, vendor, assets, native-host, rendezvous, README, PRIVACY.
// Excludes tests, tools and dotfiles. Uses the platform zip tool (Compress-Archive / zip).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const staging = path.join(root, 'dist', 'staging');
const zipPath = path.join(root, 'dist', `hotmic-v${manifest.version}.zip`);

const INCLUDE = ['manifest.json', 'src', 'vendor', 'assets', 'native-host', 'rendezvous', 'README.md', 'PRIVACY.md'];

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
for (const item of INCLUDE) {
  fs.cpSync(path.join(root, item), path.join(staging, item), { recursive: true });
}
fs.rmSync(zipPath, { force: true });

if (process.platform === 'win32') {
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}'"`);
} else {
  execSync(`zip -qr '${zipPath}' .`, { cwd: staging });
}
fs.rmSync(staging, { recursive: true, force: true });

const size = fs.statSync(zipPath).size;
console.log(`${zipPath}  ${(size / 1024).toFixed(1)} KB`);
console.log('Upload this zip at https://chrome.google.com/webstore/devconsole');
