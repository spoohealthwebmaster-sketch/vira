/* Extra tools: Persian slug, leak-domain check, media downloader.
 *
 * Slug mapping is a simplified port of pinoox/slug (MIT, (c) Pinoox) - normalisation
 * rules and consonant table follow that project. Leak list comes from the
 * Leakfarsi/Leakfa-Alert project (MIT); matching logic is the same suffix rule.
 * Media extraction follows the approach of monji024/pinterest-dl. */

// ---------- pure helpers (also exercised from Node tests) ----------

const SLUG_CONSONANTS = {
    'ب': 'b', 'پ': 'p', 'ت': 't', 'ط': 't', 'ث': 's', 'س': 's', 'ص': 's', 'ج': 'j', 'چ': 'ch',
    'ح': 'h', 'ه': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ز': 'z', 'ض': 'z', 'ظ': 'z', 'ر': 'r',
    'ژ': 'zh', 'ش': 'sh', 'ع': '', 'غ': 'gh', 'ق': 'gh', 'ف': 'f', 'ک': 'k', 'گ': 'g', 'ل': 'l',
    'م': 'm', 'ن': 'n', 'ئ': '', 'ء': ''
};
const SLUG_DICT = {
    'محصولات': 'products', 'محصول': 'product', 'دسته‌بندی': 'category', 'دسته': 'category',
    'مقاله': 'article', 'مقالات': 'articles', 'خبر': 'news', 'اخبار': 'news', 'وبلاگ': 'blog',
    'درباره': 'about', 'تماس': 'contact', 'خانه': 'home', 'صفحه': 'page', 'اصلی': 'main',
    'لپتاپ': 'laptop', 'لپ‌تاپ': 'laptop', 'موبایل': 'mobile', 'گوشی': 'phone', 'کامپیوتر': 'computer',
    'فروشگاه': 'shop', 'خرید': 'buy', 'قیمت': 'price', 'آموزش': 'tutorial', 'سایت': 'site',
    'طراحی': 'design', 'برنامه': 'program', 'نویسی': 'writing', 'هوش': 'ai', 'مصنوعی': 'ai'
};
const SLUG_STOP = ['و', 'در', 'به', 'از', 'که', 'را', 'با', 'برای', 'این', 'آن', 'تا', 'یا'];

function slugNormalize(s) {
    return String(s)
        .replace(/ي|ى/g, 'ی').replace(/ك/g, 'ک').replace(/ة|ۀ/g, 'ه').replace(/أ|إ|ٱ/g, 'ا')
        .replace(/[ً-ْٰـ]/g, '')
        .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
        .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
        .replace(/&/g, ' and ').replace(/%/g, ' percent ').replace(/\+/g, ' plus ');
}

function slugTransliterateWord(w) {
    const isCons = ch => Object.prototype.hasOwnProperty.call(SLUG_CONSONANTS, ch);
    const chars = Array.from(w);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i], prev = chars[i - 1], next = chars[i + 1];
        if (c === 'آ') out += 'a';
        else if (c === 'ا') out += (i === 0 ? 'a' : (isCons(prev) || prev === 'و' || prev === 'ی' ? 'a' : ''));
        else if (c === 'و') {
            if (i === 0 || next === 'ا' || next === 'ی') out += 'v';
            else out += (next ? 'o' : 'u');
        }
        else if (c === 'ی') {
            if (i === 0 || next === 'ا' || next === 'و') out += 'y';
            else out += next ? 'i' : 'i';
        }
        else if (c === 'ه' && i === chars.length - 1 && i > 0) out += (isCons(prev) ? 'e' : '');
        else if (isCons(c)) out += (i > 1 && isCons(prev) && SLUG_CONSONANTS[c] ? 'a' : '') + SLUG_CONSONANTS[c];
        else if (/[a-zA-Z0-9]/.test(c)) out += c;
        else out += ' ';
    }
    return out;
}

function persianToSlug(text, opts) {
    opts = opts || {};
    let s = slugNormalize(text).replace(/([a-z])([A-Z])/g, '$1 $2');
    const words = s.split(/[\s_\-‌.،,؛;:/\\|]+/).filter(Boolean);
    const out = [];
    for (const w of words) {
        if (/^[a-zA-Z0-9]+$/.test(w)) { out.push(w.toLowerCase()); continue; }
        if (opts.stopwords !== false && SLUG_STOP.includes(w)) continue;
        if (opts.dict !== false && SLUG_DICT[w]) { out.push(SLUG_DICT[w]); continue; }
        const t = slugTransliterateWord(w).trim();
        if (t) out.push(t.replace(/ +/g, '-'));
    }
    return out.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function leakMatchDomain(hostname, domains) {
    if (Object.prototype.hasOwnProperty.call(domains, hostname)) return hostname;
    for (const key in domains) if (hostname.endsWith('.' + key)) return key;
    return null;
}
function cleanHostname(input) {
    let v = String(input || '').trim().toLowerCase();
    if (!v) return '';
    if (!/^[a-z]+:\/\//.test(v)) v = 'http://' + v;
    try { return new URL(v).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function decodeHtmlAttr(s) {
    return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function metaContent(html, prop) {
    const re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i');
    const re2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i');
    const m = html.match(re1) || html.match(re2);
    return m ? decodeHtmlAttr(m[1]) : null;
}
function absUrl(u, base) { try { return new URL(u, base).href; } catch (e) { return null; } }

// Pinterest: page embeds JSON in <script id="__PWS_*">; fall back to JSON-LD, og tags, raw pinimg urls.
function extractPinterest(html) {
    const found = { images: [], videos: [] };
    const scripts = html.match(/<script[^>]+id=["']__PWS_[^"']*["'][^>]*>[\s\S]*?<\/script>/g) || [];
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 40) return;
        if (node.images && node.images.orig && node.images.orig.url) found.images.push(node.images.orig.url);
        const vl = node.videos && node.videos.video_list;
        if (vl && typeof vl === 'object') {
            let best = null;
            for (const k in vl) {
                const v = vl[k];
                if (v && v.url && /\.mp4(\?|$)/.test(v.url)) {
                    if (!best || (v.width || 0) * (v.height || 0) > (best.width || 0) * (best.height || 0)) best = v;
                }
            }
            if (!best) for (const k in vl) { const v = vl[k]; if (v && v.url && /\.m3u8/.test(v.url)) { best = { url: v.url.replace(/\/hls\//, '/720p/').replace(/\.m3u8.*$/, '.mp4') }; break; } }
            if (best) found.videos.push(best.url);
        }
        for (const k in node) walk(node[k], depth + 1);
    };
    for (const s of scripts) {
        const m = s.match(/>([\s\S]*?)<\/script>/);
        if (!m) continue;
        try { walk(JSON.parse(m[1]), 0); } catch (e) { /* ignore */ }
    }
    if (!found.videos.length) {
        const mp4 = html.match(/https:\/\/v[0-9a-z]*\.pinimg\.com\/videos\/[^"'\\\s]+?\.mp4/g);
        if (mp4) found.videos.push(...mp4);
    }
    if (!found.images.length) {
        const og = metaContent(html, 'og:image');
        if (og) found.images.push(og.replace(/\/\d+x\d*\//, '/originals/'));
        const raw = html.match(/https:\/\/i\.pinimg\.com\/originals\/[^"'\\\s]+/g);
        if (raw) found.images.push(...raw);
    }
    const uniq = a => Array.from(new Set(a));
    return { images: uniq(found.images), videos: uniq(found.videos) };
}

// Twitter/X: public syndication endpoint JSON.
function twitterToken(id) { return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''); }
function extractTweet(json) {
    const out = { images: [], videos: [], text: json && json.text || '' };
    const media = (json && (json.mediaDetails || [])) || [];
    for (const m of media) {
        if (m.type === 'photo' && m.media_url_https) out.images.push(m.media_url_https + (m.media_url_https.includes('?') ? '' : '?name=orig'));
        const variants = m.video_info && m.video_info.variants || [];
        const mp4 = variants.filter(v => v.content_type === 'video/mp4' && v.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (mp4.length) out.videos.push(mp4[0].url);
    }
    return out;
}

// Generic page: og/twitter meta, JSON-LD, <video>/<source>.
function extractGeneric(html, base) {
    const images = [], videos = [];
    for (const p of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']) {
        const v = metaContent(html, p); if (v) videos.push(absUrl(v, base));
    }
    for (const p of ['og:image:secure_url', 'og:image', 'twitter:image']) {
        const v = metaContent(html, p); if (v) images.push(absUrl(v, base));
    }
    (html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/g) || []).forEach(s => {
        try {
            const j = JSON.parse(s.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/, ''));
            const arr = Array.isArray(j) ? j : (j['@graph'] || [j]);
            arr.forEach(n => {
                if (n && n.contentUrl) (/video/i.test(n['@type']) ? videos : images).push(absUrl(n.contentUrl, base));
                if (n && n['@type'] === 'ImageObject' && n.url) images.push(absUrl(n.url, base));
            });
        } catch (e) { /* ignore */ }
    });
    (html.match(/<(?:video|source)[^>]+src=["']([^"']+)["']/gi) || []).forEach(t => {
        const m = t.match(/src=["']([^"']+)["']/i); if (m) videos.push(absUrl(decodeHtmlAttr(m[1]), base));
    });
    const clean = a => Array.from(new Set(a.filter(u => u && /^https?:/.test(u))));
    return { images: clean(images), videos: clean(videos) };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { persianToSlug, leakMatchDomain, cleanHostname, extractPinterest, extractTweet, extractGeneric, twitterToken };
}

// ---------- UI (browser only) ----------
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
(function () {
    const esc = s => (window.escapeHtml ? window.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const copy = t => { try { navigator.clipboard.writeText(t); } catch (e) { /* ignore */ } };

    const EXTRA = {};

    EXTRA.slug = {
        title: '<i class="fa fa-link"></i> اسلاگ‌ساز فارسی به انگلیسی',
        render(body) {
            body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:.8rem;">
                <p class="text-muted" style="font-size:.8rem;">عنوان فارسی را بنویسید تا اسلاگ انگلیسی برای URL ساخته شود. واژه‌های رایج (محصول، مقاله، لپ‌تاپ…) از دیکشنری ترجمه می‌شوند و بقیه آوانگاری ساده می‌شوند؛ قبل از استفاده بررسی کنید.</p>
                <textarea id="slug-in" rows="3" placeholder="مثلاً: دسته‌بندی لپ‌تاپ‌های گیمینگ"></textarea>
                <label style="font-size:.85rem;"><input type="checkbox" id="slug-dict" checked> ترجمه واژه‌های رایج با دیکشنری</label>
                <label style="font-size:.85rem;"><input type="checkbox" id="slug-stop" checked> حذف حروف اضافه (و، در، به…)</label>
                <input id="slug-out" readonly dir="ltr" style="font-family:monospace;" placeholder="slug">
                <button class="btn" id="slug-copy">کپی</button>
                <p class="text-muted" style="font-size:.7rem;">الگوی تبدیل بر پایه pinoox/slug (MIT)</p>
            </div>`;
            const run = () => {
                document.getElementById('slug-out').value = persianToSlug(document.getElementById('slug-in').value, {
                    dict: document.getElementById('slug-dict').checked, stopwords: document.getElementById('slug-stop').checked
                });
            };
            ['slug-in', 'slug-dict', 'slug-stop'].forEach(id => document.getElementById(id).addEventListener('input', run));
            document.getElementById('slug-copy').addEventListener('click', () => copy(document.getElementById('slug-out').value));
        }
    };

    const LEAKS_URL = 'https://raw.githubusercontent.com/Leakfarsi/Leakfa-Alert/refs/heads/domains/leaks.json';
    const LEAKS_TTL = 24 * 3600 * 1000;
    async function loadLeaks() {
        const cached = (await storageGet({ viraLeaksCache: null })).viraLeaksCache;
        if (cached && cached.at && Date.now() - cached.at < LEAKS_TTL && cached.domains) return cached;
        try {
            const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
            const r = await fetch(LEAKS_URL, { signal: ctl.signal, cache: 'no-store' }); clearTimeout(t);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            const data = { at: Date.now(), timestamp: j.timestamp, domains: j.domains || {} };
            await storageSet({ viraLeaksCache: data });
            return data;
        } catch (e) {
            if (cached && cached.domains) return cached;
            throw e;
        }
    }

    EXTRA.leakcheck = {
        title: '<i class="fa fa-user-shield"></i> بررسی نشت اطلاعات دامنه',
        render(body) {
            body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:.8rem;">
                <p class="text-muted" style="font-size:.8rem;">بررسی می‌کند آیا دامنه‌ای در فهرست سرویس‌های ایرانی دارای نشت اطلاعات (پروژه Leakfa-Alert) هست. فهرست از GitHub گرفته و ۲۴ ساعت ذخیره می‌شود.</p>
                <div style="display:flex; gap:.5rem;"><input id="leak-in" dir="ltr" placeholder="example.ir یا https://example.ir/page" style="flex:1;"><button class="btn" id="leak-go">بررسی</button></div>
                <div id="leak-out"></div>
            </div>`;
            const out = document.getElementById('leak-out');
            const go = async () => {
                const host = cleanHostname(document.getElementById('leak-in').value);
                if (!host) { out.innerHTML = '<p class="text-muted">دامنه معتبر وارد کنید.</p>'; return; }
                out.innerHTML = '<p class="text-muted">در حال دریافت فهرست…</p>';
                try {
                    const data = await loadLeaks();
                    const key = leakMatchDomain(host, data.domains);
                    const stamp = data.timestamp ? ' (آخرین به‌روزرسانی فهرست: ' + esc(data.timestamp) + ')' : '';
                    if (!key) { out.innerHTML = `<p style="color:#27ae60;">برای «${esc(host)}» نشتی در فهرست یافت نشد.${stamp}<br><span class="text-muted" style="font-size:.75rem;">این به معنی نبود نشت نیست؛ فقط یعنی در این فهرست ثبت نشده.</span></p>`; return; }
                    const d = data.domains[key] || {};
                    out.innerHTML = `<div style="border:1px solid #e74c3c; border-radius:8px; padding:.8rem;">
                        <strong style="color:#e74c3c;">نشت اطلاعات ثبت شده: ${esc(d.name_fa || d.name_en || key)}</strong>
                        <p style="font-size:.85rem; margin:.5rem 0;">${esc(d.description_fa || d.description_en || '')}</p>
                        ${d.companyResponse ? `<p style="font-size:.8rem;"><b>پاسخ شرکت:</b> ${esc(d.companyResponse)}</p>` : ''}
                        ${/^https?:\/\//.test(d.relatedURL || '') ? `<a href="${esc(d.relatedURL)}" target="_blank" rel="noopener noreferrer">منبع خبر</a>` : ''}
                        <div class="text-muted" style="font-size:.7rem; margin-top:.4rem;">${stamp}</div></div>`;
                } catch (e) { out.innerHTML = '<p style="color:#e74c3c;">دریافت فهرست ناموفق بود: ' + esc(e.message) + '</p>'; }
            };
            document.getElementById('leak-go').addEventListener('click', go);
            document.getElementById('leak-in').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
        }
    };

    async function fetchText(url, ms) {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 15000);
        try {
            const r = await fetch(url, { signal: ctl.signal, credentials: 'omit', headers: { 'Accept-Language': 'en-US,en;q=0.8' } });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return { text: await r.text(), url: r.url };
        } finally { clearTimeout(t); }
    }

    async function resolveMedia(rawUrl) {
        let u;
        try { u = new URL(rawUrl.trim()); } catch (e) { throw new Error('آدرس نامعتبر است'); }
        if (!/^https?:$/.test(u.protocol)) throw new Error('فقط آدرس http/https پشتیبانی می‌شود');
        const host = u.hostname.replace(/^www\./, '');
        if (/(^|\.)(twitter|x)\.com$/.test(host)) {
            const m = u.pathname.match(/status(?:es)?\/(\d+)/);
            if (!m) throw new Error('شناسه توییت در آدرس پیدا نشد');
            const { text } = await fetchText('https://cdn.syndication.twimg.com/tweet-result?id=' + m[1] + '&lang=en&token=' + twitterToken(m[1]));
            const res = extractTweet(JSON.parse(text));
            return { source: 'Twitter / X', ...res };
        }
        const isPin = /(^|\.)pinterest\.[a-z.]+$/.test(host) || host === 'pin.it';
        const { text, url: finalUrl } = await fetchText(u.href);
        if (isPin) return { source: 'Pinterest', ...extractPinterest(text) };
        return { source: 'صفحه عمومی (og/JSON-LD/video)', ...extractGeneric(text, finalUrl || u.href) };
    }

    async function saveFile(url, name, btn) {
        const old = btn.textContent; btn.textContent = 'در حال دانلود…'; btn.disabled = true;
        try {
            const r = await fetch(url, { credentials: 'omit' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const blob = await r.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
            btn.textContent = 'ذخیره شد ✓';
        } catch (e) {
            btn.textContent = old; btn.disabled = false;
            window.open(url, '_blank', 'noopener');
        }
    }

    EXTRA.downloader = {
        title: '<i class="fa fa-download"></i> دانلودر تصویر و ویدیو',
        render(body) {
            body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:.8rem;">
                <p class="text-muted" style="font-size:.8rem;">پین‌ترست، توییتر/X و صفحات عمومی که تصویر یا ویدیو را در متادیتا (og:video، JSON-LD، تگ video) دارند. اینستاگرام، پورن‌هاب و سایت‌های نیازمند ورود یا ضد‌ربات پشتیبانی نمی‌شوند. فقط محتوایی را دانلود کنید که حق استفاده‌اش را دارید.</p>
                <div style="display:flex; gap:.5rem;"><input id="dl-in" dir="ltr" placeholder="https://www.pinterest.com/pin/…" style="flex:1;"><button class="btn" id="dl-go">استخراج</button></div>
                <div id="dl-out"></div>
                <hr style="opacity:.2; width:100%;">
                <label style="font-size:.85rem;"><input type="checkbox" id="dl-overlay"> نمایش دکمه‌ی دانلود (⬇) روی عکس و ویدیوی همه‌ی سایت‌ها هنگام نگه‌داشتن موس</label>
                <p class="text-muted" style="font-size:.72rem;">فقط فایل‌های مستقیم را می‌گیرد؛ ویدیوهای استریم (یوتیوب، اینستاگرام و…) پشتیبانی نمی‌شوند. بعد از روشن‌کردن، تب‌های باز را یک‌بار رفرش کنید.</p>
            </div>`;
            const out = document.getElementById('dl-out');
            const ov = document.getElementById('dl-overlay');
            storageGet({ viraDlOverlay: false }).then(r => { ov.checked = !!r.viraDlOverlay; });
            ov.addEventListener('change', () => storageSet({ viraDlOverlay: ov.checked }));
            const go = async () => {
                out.innerHTML = '<p class="text-muted">در حال بررسی…</p>';
                try {
                    const res = await resolveMedia(document.getElementById('dl-in').value);
                    const items = [...res.videos.map(u => ['ویدیو', u]), ...res.images.map(u => ['تصویر', u])];
                    if (!items.length) { out.innerHTML = `<p class="text-muted">در ${esc(res.source)} فایلی پیدا نشد. ممکن است محتوا خصوصی باشد یا سایت دسترسی خودکار را مسدود کرده باشد.</p>`; return; }
                    out.innerHTML = `<p style="font-size:.8rem;">منبع: ${esc(res.source)}</p>` + items.map((it, i) => `
                        <div style="display:flex; gap:.5rem; align-items:center; margin:.4rem 0;">
                            <span style="min-width:44px;">${it[0]}</span>
                            <span dir="ltr" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.72rem;" title="${esc(it[1])}">${esc(it[1])}</span>
                            <button class="btn dl-save" data-i="${i}">دانلود</button>
                        </div>`).join('');
                    out.querySelectorAll('.dl-save').forEach(b => b.addEventListener('click', () => {
                        const it = items[+b.dataset.i];
                        const ext = (it[1].split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [, it[0] === 'ویدیو' ? 'mp4' : 'jpg'])[1];
                        saveFile(it[1], 'vira-' + Date.now() + '.' + ext, b);
                    }));
                } catch (e) { out.innerHTML = '<p style="color:#e74c3c;">ناموفق: ' + esc(e.message) + '</p>'; }
            };
            document.getElementById('dl-go').addEventListener('click', go);
            document.getElementById('dl-in').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
        }
    };

    window.VIRA_EXTRA = EXTRA;
})();
}
