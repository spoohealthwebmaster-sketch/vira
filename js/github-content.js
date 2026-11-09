// Content script injected on github.com - adds a small floating button that
// copies the repo's clone URL, without scraping GitHub's own (frequently
// changing) DOM for its "Code" button. GitHub is a React SPA that swaps
// pages via pushState without a full reload, so this re-checks on every
// navigation instead of only running once at page load.

const GITHUB_NON_REPO_PATHS = new Set([
    'settings', 'notifications', 'marketplace', 'explore', 'topics', 'trending',
    'collections', 'events', 'sponsors', 'issues', 'pulls', 'codespaces',
    'orgs', 'new', 'login', 'join', 'about', 'pricing', 'features', 'apps',
    'search', 'dashboard'
]);

function getRepoFromPath() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    if (GITHUB_NON_REPO_PATHS.has(owner)) return null;
    return { owner, repo };
}

function removeButton() {
    const el = document.getElementById('vira-gh-clone-btn');
    if (el) el.remove();
}

function injectButton() {
    removeButton();
    const info = getRepoFromPath();
    if (!info) return;

    const btn = document.createElement('button');
    btn.id = 'vira-gh-clone-btn';
    btn.textContent = '📋 کپی دستور کلون (ویرا)';
    btn.style.cssText = [
        'position:fixed', 'bottom:20px', 'left:20px', 'z-index:99999',
        'background:#0a84ff', 'color:#fff', 'border:none', 'border-radius:10px',
        'padding:10px 16px', 'font-size:13px', 'font-family:sans-serif',
        'cursor:pointer', 'box-shadow:0 4px 14px rgba(0,0,0,0.25)', 'direction:rtl'
    ].join(';');

    btn.addEventListener('click', () => {
        const cloneUrl = `git clone https://github.com/${info.owner}/${info.repo}.git`;
        navigator.clipboard.writeText(cloneUrl).then(() => {
            const original = btn.textContent;
            btn.textContent = '✅ کپی شد!';
            setTimeout(() => { btn.textContent = original; }, 1500);
        }).catch(() => {});
    });

    document.body.appendChild(btn);
}

injectButton();

// GitHub navigates between pages via pushState (no full reload), so a
// MutationObserver watching for DOM changes is a low-overhead way to notice
// when the user has moved to a different repo/page (checked against the URL,
// not tied to any specific GitHub DOM element that could change shape).
let lastPath = location.pathname;
const observerTarget = document.querySelector('title') || document.head || document.body;
if (observerTarget) {
    new MutationObserver(() => {
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            injectButton();
        }
    }).observe(observerTarget, { childList: true, subtree: true });
}
