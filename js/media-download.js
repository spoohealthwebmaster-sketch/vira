/* Hover download button for images and videos.
 * Off by default; enabled from the Vira "downloader" tool (storage key viraDlOverlay).
 * Only handles direct http(s) files - blob:/HLS/DASH streams are skipped. */
(function () {
    if (window.top !== window || !chrome || !chrome.storage) return;

    let enabled = false;
    chrome.storage.local.get({ viraDlOverlay: false }, r => { enabled = !!r.viraDlOverlay; });
    chrome.storage.onChanged.addListener(ch => {
        if (ch.viraDlOverlay) { enabled = !!ch.viraDlOverlay.newValue; if (!enabled) hide(); }
    });

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;display:none;left:0;top:0;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>button{all:initial;cursor:pointer;width:34px;height:34px;border-radius:50%;background:#1f6feb;color:#fff;font:18px/34px sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4)}button:hover{background:#388bfd}</style><button title="دانلود با ویرا">⬇</button>';
    const btn = root.querySelector('button');
    document.documentElement.appendChild(host);

    let current = null, hideTimer = null;

    function mediaUrl(el) {
        let u = el.tagName === 'VIDEO' ? (el.currentSrc || el.src || (el.querySelector('source') || {}).src) : (el.currentSrc || el.src);
        if (!u || !/^https?:\/\//.test(u)) return null;
        if (el.tagName === 'VIDEO' && /\.(m3u8|mpd)(\?|$)/i.test(u)) return null;
        if (el.tagName === 'IMG' && /(^|\.)pinimg\.com$/.test(new URL(u).hostname)) u = u.replace(/\/\d+x\d*\//, '/originals/');
        return u;
    }
    function fileName(url, el) {
        let n = '';
        try { n = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch (e) { /* ignore */ }
        n = n.replace(/[\\/:*?"<>|]/g, '_');
        if (!/\.[a-z0-9]{2,5}$/i.test(n)) n = (n || 'vira-' + Date.now()) + (el.tagName === 'VIDEO' ? '.mp4' : '.jpg');
        return n;
    }
    function hide() { host.style.display = 'none'; current = null; }
    function show(el) {
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 120 || r.bottom < 0 || r.top > innerHeight) { hide(); return; }
        current = el;
        host.style.left = Math.max(4, Math.min(r.right - 42, innerWidth - 42)) + 'px';
        host.style.top = Math.max(4, r.top + 8) + 'px';
        host.style.display = 'block';
    }

    document.addEventListener('mouseover', e => {
        if (!enabled) return;
        const t = e.target;
        if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO') && mediaUrl(t)) { clearTimeout(hideTimer); show(t); }
    }, true);
    document.addEventListener('mouseout', e => {
        if (e.target === current && e.relatedTarget !== host) hideTimer = setTimeout(hide, 600);
    }, true);
    host.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    host.addEventListener('mouseleave', () => { hideTimer = setTimeout(hide, 400); });
    addEventListener('scroll', hide, true);

    btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        if (!current) return;
        const url = mediaUrl(current);
        if (!url) return;
        btn.textContent = '…';
        chrome.runtime.sendMessage({ action: 'vira_download', url, filename: fileName(url, current) }, res => {
            btn.textContent = res && res.ok ? '✓' : '!';
            setTimeout(() => { btn.textContent = '⬇'; }, 1500);
        });
    });
})();
