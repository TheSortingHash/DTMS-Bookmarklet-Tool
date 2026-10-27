// Builds dist/ from src/:
//   dtms-batch.js     core + panel (readable; what the bookmarklet runs)
//   bookmarklet.txt   the javascript: URL to save as a bookmark
//   probe-console.js  core + Phase 0 probe, to paste into the DevTools console
//   install.html      drag-to-bookmarks-bar install page
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const { version } = require(path.join(root, 'package.json'));
const banner = `/* DTMS Batch v${version} (built ${new Date().toISOString().slice(0, 10)}) */\n`;

// Safe for this codebase only: no template literals or multi-line strings, and
// comments either own their whole line or are /* ... */ blocks starting a line.
function squeeze(code) {
  const out = [];
  let inBlock = false;
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (inBlock) { if (line.includes('*/')) inBlock = false; continue; }
    if (line.startsWith('/*')) { if (!line.includes('*/')) inBlock = true; continue; }
    if (!line || line.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
}

const tool = banner + src('core.js') + '\n' + src('queue.js') + '\n' + src('panel.js');
const probe = banner + src('core.js') + '\n' + src('probe.js');
const bookmarklet = 'javascript:' + encodeURIComponent('(function(){' + squeeze(tool) + '\n})();void 0');

fs.writeFileSync(path.join(dist, 'dtms-batch.js'), tool);
fs.writeFileSync(path.join(dist, 'probe-console.js'), probe);
fs.writeFileSync(path.join(dist, 'bookmarklet.txt'), bookmarklet + '\n');

const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
fs.writeFileSync(path.join(dist, 'install.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install DTMS Batch</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1f2937;background:#fff}
a.bm{display:inline-block;padding:8px 16px;background:#2C2C87;color:#fff;border-radius:6px;text-decoration:none;font-weight:600}
code{background:#f3f4f6;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>DTMS Batch v${version}</h1>
<p><strong>Drag this button to your bookmarks bar:</strong></p>
<p><a class="bm" href="${escAttr(bookmarklet)}">DTMS Batch</a></p>
<p>If dragging doesn't work: right-click the bookmarks bar → <em>Add page…</em>, name it <code>DTMS Batch</code>,
and paste the contents of <code>bookmarklet.txt</code> as the URL.</p>
<h2>Use</h2>
<ol>
<li>Log in to DTMS and open any DTMS page.</li>
<li>Click <strong>DTMS Batch</strong> in the bookmarks bar.</li>
<li>Type, scan or paste PC Nos. (optionally with a station code), pick a default destination.</li>
<li><strong>Check</strong> (read-only), review the plan, then <strong>Run</strong>.</li>
</ol>
<p>Updating: rebuild, then replace the bookmark the same way.</p>
</body></html>
`);

console.log(`dist/ built: dtms-batch.js ${tool.length} B, bookmarklet ${bookmarklet.length} chars, probe ${probe.length} B`);
