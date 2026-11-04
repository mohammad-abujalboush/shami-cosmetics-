// Copies only the public site files into /dist. No dependencies.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

// Root-level files: every .html page plus these extras.
const rootFiles = ['robots.txt', 'sitemap.xml', 'favicon.ico', 'favicon.svg'];
// Directories copied recursively.
const dirs = ['account', 'admin', 'assets'];
// Never copied, even inside the directories above.
const blocked = /(^\.|\.md$|\.map$|\.sql$|\.txt$|^serve\.json$|test)/i;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (blocked.test(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

for (const e of fs.readdirSync(root, { withFileTypes: true })) {
  if (!e.isFile()) continue;
  if (e.name.endsWith('.html') || rootFiles.includes(e.name)) {
    fs.copyFileSync(path.join(root, e.name), path.join(dist, e.name));
  }
}
for (const d of dirs) {
  if (fs.existsSync(path.join(root, d))) copyDir(path.join(root, d), path.join(dist, d));
}
console.log('Built /dist');
