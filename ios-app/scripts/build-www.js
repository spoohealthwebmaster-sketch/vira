// Copies the extension's page files into ios-app/www. Extension-only scripts
// (service worker, content scripts) and the unrelated mcp-servers folder are left out.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const out = path.resolve(__dirname, '..', 'www');

const SKIP_JS = new Set(['background.js', 'github-content.js', 'media-download.js']);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function copyDir(rel, filter) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) return;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const relPath = path.join(rel, entry.name);
        if (entry.isDirectory()) { copyDir(relPath, filter); continue; }
        if (filter && !filter(entry.name)) continue;
        const dest = path.join(out, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(root, relPath), dest);
    }
}

// iOS-only tweaks, applied to the copy so the extension's own files stay untouched:
// draw under the notch with safe-area padding, and keep Safari from zooming into inputs.
const IOS_CSS = `
html { -webkit-text-size-adjust: 100%; }
body {
    padding-top: max(1rem, env(safe-area-inset-top)) !important;
    padding-bottom: max(1rem, env(safe-area-inset-bottom)) !important;
    padding-left: max(1rem, env(safe-area-inset-left)) !important;
    padding-right: max(1rem, env(safe-area-inset-right)) !important;
}
input, textarea, select { font-size: 16px !important; }
.modal-content { max-width: 100vw; }
`;
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace('content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1.0, viewport-fit=cover"');
html = html.replace('</head>', '    <link rel="stylesheet" href="css/ios-app.css">\n</head>');
fs.writeFileSync(path.join(out, 'index.html'), html);
copyDir('css');
fs.writeFileSync(path.join(out, 'css', 'ios-app.css'), IOS_CSS);
copyDir('fonts');
copyDir('vendor');
copyDir('icons');
copyDir('js', name => !SKIP_JS.has(name));

console.log('www ready:', fs.readdirSync(out).join(', '));
