// extension/js/app.js

let currentProjectId = null;
let currentData = null;
let fetchDataRequestId = 0;
let authToken = null;
let currentUser = null;
let preferredAiEffort = 'lite'; // lite | standard | deep | exhaustive | local - loaded from storage at startup, changed in Settings
let bookmarkClickBehavior = 'newtab'; // newtab | sametab | copy - loaded from storage at startup, changed in Settings

// Local model option (free, no You.com credit spent) - the same OpenAI-compatible
// proxy the article-writer/price-checker tools already point at on this machine.
// Only reachable from localhost, so it works from the extension and desktop
// app (both run on the user's own PC) but never from the remote backend.
const LOCAL_AI_PROXY_URL = 'http://127.0.0.1:8045/v1/chat/completions';
const LOCAL_AI_PROXY_KEY = 'sk-5bac2aa622dc4d24ac0269d581c0924d';
const LOCAL_AI_PROXY_MODEL = 'gemini-3.8-flash-high';

// Single choke point every AI feature in the app calls through - branches to
// the local proxy when the user picked "local" in Settings, otherwise goes
// through the backend's ai_ask (You.com). Keeping this in one place means the
// model choice in Settings actually applies everywhere, not just the chat.
async function callAI(prompt, effort) {
    const useEffort = effort || preferredAiEffort;
    if (useEffort === 'local') {
        try {
            const res = await fetch(LOCAL_AI_PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LOCAL_AI_PROXY_KEY },
                body: JSON.stringify({ model: LOCAL_AI_PROXY_MODEL, messages: [{ role: 'user', content: prompt }] })
            });
            if (!res.ok) return { success: false, error: `سرویس محلی خطا داد (HTTP ${res.status})` };
            const data = await res.json();
            const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (!answer) return { success: false, error: 'پاسخ سرویس محلی قابل تشخیص نبود' };
            return { success: true, answer };
        } catch (e) {
            return { success: false, error: 'اتصال به سرویس محلی (127.0.0.1:8045) برقرار نشد - مطمئن شو پروکسی محلی روی این کامپیوتر روشنه' };
        }
    }
    return await apiCall('ai_ask', 'POST', { prompt, effort: useEffort });
}

// The floating always-on-top mini pomodoro window (Tauri only) loads this
// same index.html with ?mini=pomodoro, so it needs to bypass the normal
// auth/dashboard boot entirely and render a tiny standalone timer instead.
// It intentionally does NOT share state/history with the dashboard's own
// pomodoro widget - a small independent companion, not a second view onto
// the same session.
function renderMiniPomodoro() {
    document.body.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; gap:0.75rem; font-family:inherit; background:#1a1a2e; color:#fff; user-select:none;">
            <div id="mini-pomo-time" style="font-size:2.4rem; font-weight:800; font-family:monospace; direction:ltr;">25:00</div>
            <div id="mini-pomo-mode" style="font-size:0.8rem; opacity:0.7;">تمرکز</div>
            <div style="display:flex; gap:0.5rem;">
                <button id="mini-pomo-toggle" style="padding:0.4rem 1rem; border-radius:8px; border:none; background:#0a84ff; color:#fff; cursor:pointer; font-family:inherit;">شروع</button>
                <button id="mini-pomo-reset" style="padding:0.4rem 1rem; border-radius:8px; border:none; background:rgba(255,255,255,0.15); color:#fff; cursor:pointer; font-family:inherit;">ریست</button>
            </div>
        </div>
    `;
    const FOCUS_SECONDS = 25 * 60;
    const BREAK_SECONDS = 5 * 60;
    let secondsLeft = FOCUS_SECONDS;
    let isBreak = false;
    let running = false;
    let interval = null;

    function render() {
        const m = Math.floor(secondsLeft / 60).toString().padStart(2, '0');
        const s = (secondsLeft % 60).toString().padStart(2, '0');
        document.getElementById('mini-pomo-time').textContent = `${m}:${s}`;
        document.getElementById('mini-pomo-mode').textContent = isBreak ? 'استراحت' : 'تمرکز';
        document.getElementById('mini-pomo-toggle').textContent = running ? 'مکث' : 'شروع';
    }
    function tick() {
        secondsLeft--;
        if (secondsLeft <= 0) {
            isBreak = !isBreak;
            secondsLeft = isBreak ? BREAK_SECONDS : FOCUS_SECONDS;
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(isBreak ? 'وقت استراحته! ☕' : 'وقت تمرکزه! 🎯');
            }
        }
        render();
    }
    document.getElementById('mini-pomo-toggle').addEventListener('click', () => {
        running = !running;
        if (running) interval = setInterval(tick, 1000);
        else clearInterval(interval);
        render();
    });
    document.getElementById('mini-pomo-reset').addEventListener('click', () => {
        running = false;
        clearInterval(interval);
        isBreak = false;
        secondsLeft = FOCUS_SECONDS;
        render();
    });
    render();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (new URLSearchParams(location.search).get('mini') === 'pomodoro') {
        renderMiniPomodoro();
        return;
    }
    if (typeof window.__TAURI__ !== 'undefined') {
        document.querySelectorAll('[data-desktop-only]').forEach(el => el.hidden = false);
    }
    const { aiEffortLevel } = await storageGet({ aiEffortLevel: 'lite' });
    preferredAiEffort = aiEffortLevel;
    const { bookmarkClickBehavior: savedBookmarkClick } = await storageGet({ bookmarkClickBehavior: 'newtab' });
    bookmarkClickBehavior = savedBookmarkClick;
    setupAuthEventListeners();

    const { authToken: savedToken } = await storageGet({ authToken: null });
    if (savedToken) {
        authToken = savedToken;
        const me = await apiCall('get_me');
        if (me && me.success && me.user) {
            currentUser = me.user;
            showAuthenticatedApp();
            startDashboard();
            return;
        }
        // get_me failed - but that's not necessarily a real sign-out. If the server
        // explicitly rejected the token (401), apiCall() already cleared authToken
        // and showed the login screen itself. If authToken is still set here, this
        // was something else entirely - the host was unreachable (offline, a VPN/
        // firewall blocking that IP, a temporary server hiccup) - not proof the
        // session is invalid. Don't force a re-login over a network blip; open the
        // dashboard from cache instead and let fetchData() retry in the background.
        if (authToken) {
            showAuthenticatedApp();
            startDashboard();
            return;
        }
    }
    showLoginScreen();
});

function startDashboard() {
    initTheme();
    initAccentColor();
    initBackground();
    initClock();
    initCalendar();
    initDailyQuote();
    restoreMood();
    restoreCat();
    initWeather();
    resetPomodoro();
    loadPomodoroLog();
    initSearchEngine();
    applyWidgetVisibility();
    applySavedWidgetOrder();
    initWidgetDragDrop();
    setupEventListeners();
    restoreCachedData().then(() => fetchData());
    checkTelegramReminders();
    refreshChatUnreadBadge();
    if (chatUnreadPollInterval) clearInterval(chatUnreadPollInterval);
    chatUnreadPollInterval = setInterval(refreshChatUnreadBadge, 30000);
}

// Drag-to-reorder for dashboard widgets. Only the widget's <h3> title is
// made draggable (not the whole card) so grabbing a button, checkbox, or
// task row inside a widget never gets mistaken for a drag gesture - only
// grabbing the title bar does. Reordering just moves DOM position; CSS
// Grid's own auto-flow repacks each widget's existing col-4/6/8/12 span
// into rows, so this never has to touch widget sizing.
function initWidgetDragDrop() {
    const grid = document.querySelector('.widget-grid');
    if (!grid) return;
    let draggedWidget = null;

    grid.querySelectorAll(':scope > .widget[data-widget]').forEach(widget => {
        const handle = widget.querySelector('.widget-header h3');
        if (!handle) return;
        handle.setAttribute('draggable', 'true');
        handle.style.cursor = 'grab';
        handle.title = (handle.title ? handle.title + ' - ' : '') + 'برای جابه‌جایی بکش';

        handle.addEventListener('dragstart', (e) => {
            draggedWidget = widget;
            widget.classList.add('widget-dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        handle.addEventListener('dragend', () => {
            widget.classList.remove('widget-dragging');
            draggedWidget = null;
            saveWidgetOrder();
        });
    });

    grid.querySelectorAll(':scope > .widget[data-widget]').forEach(widget => {
        widget.addEventListener('dragover', (e) => {
            if (!draggedWidget || draggedWidget === widget) return;
            e.preventDefault();
            const rect = widget.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (e.clientY < midY) grid.insertBefore(draggedWidget, widget);
            else grid.insertBefore(draggedWidget, widget.nextSibling);
        });
    });
}

async function saveWidgetOrder() {
    const grid = document.querySelector('.widget-grid');
    if (!grid) return;
    const order = [...grid.querySelectorAll(':scope > .widget[data-widget]')].map(w => w.dataset.widget);
    await storageSet({ widgetOrder: order });
}

async function applySavedWidgetOrder() {
    const grid = document.querySelector('.widget-grid');
    if (!grid) return;
    const { widgetOrder } = await storageGet({ widgetOrder: null });
    if (!widgetOrder || !Array.isArray(widgetOrder)) return;
    widgetOrder.forEach(key => {
        const el = grid.querySelector(`:scope > .widget[data-widget="${key}"]`);
        if (el) grid.appendChild(el);
    });
}

// Runs once per day (per browser/device, deduped via storage) whenever the
// dashboard loads. Only flags checks/invoices due today or already overdue -
// deliberately not a fuzzy "due soon" window, since that needs real
// Jalali-to-Gregorian date math this project doesn't have server-side, and
// getting it subtly wrong is worse than a slightly-late reminder.
async function checkTelegramReminders() {
    const { telegramChatId, lastTelegramReminderCheck } = await storageGet({ telegramChatId: '', lastTelegramReminderCheck: '' });
    if (!telegramChatId) return;
    const todayKey = new Date().toISOString().slice(0, 10);
    if (lastTelegramReminderCheck === todayKey) return;
    await storageSet({ lastTelegramReminderCheck: todayKey });

    try {
        const [checksRes, invoicesRes] = await Promise.all([
            apiCall('get_checks'),
            apiCall('get_client_invoices')
        ]);
        const todayJ = padJalaliDate(getTodayJalaali());
        const isDueOrOverdue = (dueDateStr) => !!dueDateStr && padJalaliDate(dueDateStr) <= todayJ;

        const dueChecks = ((checksRes && checksRes.checks) || []).filter(c => c.status === 'pending' && isDueOrOverdue(c.due_date));
        const dueInvoices = ((invoicesRes && invoicesRes.invoices) || []).filter(i => i.status !== 'paid' && isDueOrOverdue(i.due_date));
        if (dueChecks.length === 0 && dueInvoices.length === 0) return;

        let msg = '⏰ یادآوری ویرا:\n\n';
        if (dueChecks.length) {
            msg += `چک‌های سررسیدشده (${dueChecks.length}):\n`;
            dueChecks.forEach(c => { msg += `- ${c.title}: ${Number(c.amount).toLocaleString()} تومان (${c.due_date})\n`; });
            msg += '\n';
        }
        if (dueInvoices.length) {
            msg += `فاکتورهای سررسیدشده (${dueInvoices.length}):\n`;
            dueInvoices.forEach(i => { msg += `- ${i.title}: ${Number(i.amount).toLocaleString()} تومان (${i.due_date})\n`; });
        }
        await apiCall('send_telegram_message', 'POST', { chat_id: telegramChatId, text: msg });
    } catch (e) { /* a failed reminder check shouldn't block dashboard load */ }
}

async function setupTelegramSettings() {
    const chatIdInput = document.getElementById('settings-telegram-chatid');
    const statusEl = document.getElementById('settings-telegram-status');
    const usernameEl = document.getElementById('settings-telegram-bot-username');

    const { telegramChatId } = await storageGet({ telegramChatId: '' });
    chatIdInput.value = telegramChatId || '';

    apiCall('get_telegram_bot_info').then(res => {
        usernameEl.textContent = (res && res.success && res.username) ? '@' + res.username : '(نامشخص)';
    });

    chatIdInput.onchange = async () => {
        await storageSet({ telegramChatId: chatIdInput.value.trim() });
    };

    document.getElementById('settings-telegram-detect-btn').onclick = async () => {
        statusEl.style.display = 'block';
        statusEl.innerHTML = '<i class="fa fa-spinner fa-spin"></i> در حال بررسی پیام‌های اخیر ربات...';
        const res = await apiCall('get_telegram_updates');
        if (res && res.success && res.chats && res.chats.length > 0) {
            const chat = res.chats[0];
            chatIdInput.value = chat.chat_id;
            await storageSet({ telegramChatId: String(chat.chat_id) });
            statusEl.innerHTML = `<span style="color:var(--success-color);">✅ Chat ID پیدا شد (${escapeHtml(chat.name)})</span>`;
        } else {
            statusEl.innerHTML = '<span style="color:var(--danger-color);">هیچ پیامی پیدا نشد. اول یه پیام به ربات بفرست، بعد دوباره امتحان کن.</span>';
        }
    };

    document.getElementById('settings-telegram-test-btn').onclick = async () => {
        const chatId = chatIdInput.value.trim();
        statusEl.style.display = 'block';
        if (!chatId) { statusEl.innerHTML = '<span style="color:var(--danger-color);">اول Chat ID رو وارد کن.</span>'; return; }
        statusEl.innerHTML = '<i class="fa fa-spinner fa-spin"></i> در حال ارسال...';
        const res = await apiCall('send_telegram_message', 'POST', { chat_id: chatId, text: '✅ ویرا با موفقیت به تلگرام وصل شد!' });
        if (res && res.success) {
            statusEl.innerHTML = '<span style="color:var(--success-color);">✅ پیام ارسال شد، تلگرامت رو چک کن.</span>';
        } else {
            statusEl.innerHTML = `<span style="color:var(--danger-color);">❌ ${escapeHtml((res && res.error) || 'ارسال ناموفق')}</span>`;
        }
    };
}

// --- Auth Screen (login / register) ---
function showLoginScreen() {
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
}

function showAuthenticatedApp() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'block';
}

function setupAuthEventListeners() {
    document.getElementById('auth-show-register').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('auth-login-form').style.display = 'none';
        document.getElementById('auth-register-form').style.display = 'block';
    });
    document.getElementById('auth-show-login').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('auth-register-form').style.display = 'none';
        document.getElementById('auth-login-form').style.display = 'block';
    });

    // Show/hide password - lets you actually verify what you typed instead of
    // trusting the dots, since mobile keyboards can silently autocapitalize/
    // autocorrect a field's value even when it displays correctly as dots.
    document.querySelectorAll('[data-toggle-pass]').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.togglePass);
            const isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            btn.innerHTML = isHidden ? '<i class="fa fa-eye-slash"></i>' : '<i class="fa fa-eye"></i>';
        });
    });

    async function doLogin() {
        const email = document.getElementById('auth-login-email').value.trim();
        const password = document.getElementById('auth-login-password').value;
        const errorEl = document.getElementById('auth-login-error');
        errorEl.textContent = '';
        if (!email || !password) { errorEl.textContent = 'ایمیل و رمز عبور را وارد کنید.'; return; }

        const res = await apiCallPublic('login', { email, password });
        if (res && res.success) {
            authToken = res.token;
            currentUser = res.user;
            await storageSet({ authToken: res.token });
            showAuthenticatedApp();
            startDashboard();
        } else {
            errorEl.textContent = (res && res.error) || 'ورود ممکن نشد. اتصال به سرور را بررسی کنید.';
        }
    }

    async function doRegister() {
        const displayName = document.getElementById('auth-register-name').value.trim();
        const email = document.getElementById('auth-register-email').value.trim();
        const password = document.getElementById('auth-register-password').value;
        const inviteCode = document.getElementById('auth-register-invite').value.trim();
        const errorEl = document.getElementById('auth-register-error');
        errorEl.textContent = '';
        if (!email || !password) { errorEl.textContent = 'ایمیل و رمز عبور را وارد کنید.'; return; }

        const res = await apiCallPublic('register', { email, password, display_name: displayName, invite_code: inviteCode });
        if (res && res.success) {
            authToken = res.token;
            currentUser = res.user;
            await storageSet({ authToken: res.token });
            showAuthenticatedApp();
            startDashboard();
        } else {
            errorEl.textContent = (res && res.error) || 'ثبت‌نام ممکن نشد. اتصال به سرور را بررسی کنید.';
        }
    }

    document.getElementById('auth-login-btn').addEventListener('click', doLogin);
    document.getElementById('auth-register-btn').addEventListener('click', doRegister);
    document.getElementById('auth-login-password').addEventListener('keypress', (e) => { if (e.key === 'Enter') doLogin(); });
    document.getElementById('auth-register-invite').addEventListener('keypress', (e) => { if (e.key === 'Enter') doRegister(); });
}

window.logoutUser = async function() {
    const ok = await showConfirm('از حساب کاربری خارج شوید؟');
    if (!ok) return;
    await apiCall('logout', 'POST', {});
    authToken = null;
    currentUser = null;
    currentData = null;
    await storageSet({ authToken: null, cachedData: null, cachedProjects: null });
    location.reload();
};

// --- Storage helper (chrome.storage.local with localStorage fallback so the
// dashboard also works when previewed as a plain page, not just as an extension) ---
function storageGet(defaults) {
    return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(defaults, resolve);
            return;
        }
        const result = {};
        Object.keys(defaults).forEach(key => {
            const raw = localStorage.getItem('vira_' + key);
            if (raw === null) { result[key] = defaults[key]; return; }
            try { result[key] = JSON.parse(raw); } catch (e) { result[key] = raw; }
        });
        resolve(result);
    });
}

function storageSet(values) {
    return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set(values, resolve);
            return;
        }
        Object.entries(values).forEach(([key, val]) => localStorage.setItem('vira_' + key, JSON.stringify(val)));
        resolve();
    });
}

function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only allow http(s) URLs in href/src attributes - blocks javascript:/data: schemes.
function safeUrl(url) {
    const s = String(url == null ? '' : url).trim();
    return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

// Inline onerror="..." attributes are silently no-ops under the extension's CSP
// (same class of bug as the old inline-onclick issue) - wire <img data-fallback="...">
// broken-image fallbacks via addEventListener instead, after inserting HTML that uses it.
function wireImgFallbacks(container) {
    if (!container) return;
    container.querySelectorAll('img[data-fallback]').forEach(img => {
        img.addEventListener('error', function onErr() {
            img.removeEventListener('error', onErr);
            img.src = img.dataset.fallback;
        });
    });
}

const PRIORITY_LABELS = { urgent: 'فوری 🔥', high: 'بالا ⚡', medium: 'متوسط', low: 'پایین' };
const STATUS_LABELS = { todo: 'در انتظار', doing: 'در حال انجام', review: 'بازبینی', done: 'تکمیل شده' };

// window.confirm()/prompt()/alert() are silently no-ops on Chrome extension
// override pages (new tab, etc), so every dialog in this app goes through
// this modal instead.
function showDialog({ title = '', message = '', withInput = false, inputValue = '', inputPlaceholder = '', okText = 'تأیید', hideCancel = false }) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('confirm-modal-overlay');
        const inputWrap = document.getElementById('confirm-modal-input-wrap');
        const input = document.getElementById('confirm-modal-input');
        const okBtn = document.getElementById('confirm-modal-ok-btn');
        const cancelBtn = document.getElementById('confirm-modal-cancel-btn');

        document.getElementById('confirm-modal-title').textContent = title || (withInput ? 'ورودی' : 'تأیید');
        document.getElementById('confirm-modal-message').textContent = message;
        inputWrap.style.display = withInput ? 'block' : 'none';
        input.value = inputValue;
        input.placeholder = inputPlaceholder;
        okBtn.textContent = okText;
        cancelBtn.style.display = hideCancel ? 'none' : '';

        overlay.classList.add('active');
        if (withInput) setTimeout(() => { input.focus(); input.select(); }, 50);

        function cleanup(result) {
            overlay.classList.remove('active');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            input.removeEventListener('keypress', onKeypress);
            resolve(result);
        }
        function onOk() { cleanup(withInput ? (input.value.trim() || null) : true); }
        function onCancel() { cleanup(withInput ? null : false); }
        function onKeypress(e) { if (e.key === 'Enter') onOk(); }

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        input.addEventListener('keypress', onKeypress);
    });
}
const showConfirm = (message, title) => showDialog({ title, message });
const showPrompt = (message, defaultValue, title) => showDialog({ title, message, withInput: true, inputValue: defaultValue || '' });
const showAlert = (message, title) => showDialog({ title, message, hideCancel: true });

// --- API Helper Function ---
async function apiCall(action, method = 'GET', body = null) {
    let url = `${CONFIG.API_URL}?action=${action}`;
    if (method === 'GET' && currentProjectId !== null) {
        url += `&project_id=${currentProjectId}`;
    }

    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken || ''}`
        }
    };

    if (method !== 'GET') {
        const requestBody = body ? { ...body } : {};
        if (requestBody.project_id === undefined) requestBody.project_id = currentProjectId;
        options.body = JSON.stringify(requestBody);
    }

    try {
        const response = await fetch(url, options);
        if (response.status === 401) {
            // Session token is missing/expired/revoked - sign the user out locally
            // and send them back to the login screen instead of failing silently.
            // Also wipe the cached dashboard data so a different account logging in
            // afterward on this same browser never flashes the previous user's data.
            authToken = null;
            currentUser = null;
            currentData = null;
            await storageSet({ authToken: null, cachedData: null, cachedProjects: null });
            showLoginScreen();
            return null;
        }
        if (!response.ok) throw new Error('API Error');
        return await response.json();
    } catch (error) {
        console.error('Error:', error);
        return null;
    }
}

// Same as apiCall but never attaches a session token - only for register/login,
// which happen before we have one.
async function apiCallPublic(action, body) {
    const url = `${CONFIG.API_URL}?action=${action}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        return await response.json();
    } catch (error) {
        console.error('Error:', error);
        return null;
    }
}

// --- Theme (light/dark) ---
async function initTheme() {
    const { theme } = await storageGet({ theme: 'dark' });
    applyTheme(theme);
}

const ACCENT_PRESETS = [
    { value: 'blue', label: 'آبی (پیش‌فرض)', color: '#0a84ff' },
    { value: 'purple', label: 'بنفش', color: '#af52de' },
    { value: 'green', label: 'سبز', color: '#32d74b' },
    { value: 'orange', label: 'نارنجی', color: '#ff9f0a' },
    { value: 'pink', label: 'صورتی', color: '#ff375f' }
];

async function initAccentColor() {
    const { accentColor } = await storageGet({ accentColor: 'blue' });
    applyAccentColor(accentColor);
}

function applyAccentColor(value) {
    if (value === 'blue') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.setAttribute('data-accent', value);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const dockBtn = document.getElementById('theme-toggle-btn');
    if (dockBtn) dockBtn.innerHTML = theme === 'light' ? '<i class="fa fa-sun"></i>' : '<i class="fa fa-moon"></i>';
    const settingsChk = document.getElementById('settings-theme-toggle');
    if (settingsChk) settingsChk.checked = theme === 'light';
}

window.toggleTheme = async function() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    await storageSet({ theme: next });
};

// --- Auto-rotating wallpaper (changes daily, no network image needed) ---
function initBackground() {
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const variant = (dayOfYear % 5) + 1;
    document.documentElement.setAttribute('data-bg', String(variant));
}

// --- Widget visibility (Settings) ---
async function applyWidgetVisibility() {
    const { hiddenWidgets } = await storageGet({ hiddenWidgets: [] });
    hiddenWidgets.forEach(key => {
        const el = document.getElementById('widget-' + key);
        if (el) el.classList.add('hidden-widget');
    });
}

const WIDGET_LABELS = {
    projects: 'فضاهای کاری', pomodoro: 'پومودورو', calendar: 'تقویم', market: 'دارایی و بازار',
    tasks: 'تسک‌ها', bookmarks: 'بوک‌مارک‌ها', mood: 'حالت روحی', devtools: 'ابزارهای توسعه', notes: 'یادداشت‌ها', habits: 'عادات روزانه',
    cat: 'گربه‌ی خانگی'
};

// Native <select> popups render corrupted under a backdrop-filter/blur ancestor
// in Chromium (the settings modal is blurred glass), so this builds a plain
// button + list dropdown instead, fully styled and CSP-safe (no inline handlers).
function initDropdown(containerEl, optionsList, currentValue, onChange) {
    const current = optionsList.find(o => o.value === currentValue) || optionsList[0];
    containerEl.innerHTML = `
        <button type="button" class="custom-select-btn">
            <span class="custom-select-value">${current ? current.label : ''}</span>
            <i class="fa fa-chevron-down"></i>
        </button>
        <ul class="custom-select-list">
            ${optionsList.map(o => `<li class="custom-select-option${o.value === currentValue ? ' selected' : ''}" data-value="${o.value}">${o.label}</li>`).join('')}
        </ul>
    `;

    const btn = containerEl.querySelector('.custom-select-btn');
    const valueEl = containerEl.querySelector('.custom-select-value');
    const listEl = containerEl.querySelector('.custom-select-list');

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.custom-select.open').forEach(el => { if (el !== containerEl) el.classList.remove('open'); });
        containerEl.classList.toggle('open');
    });

    listEl.addEventListener('click', (e) => {
        const opt = e.target.closest('.custom-select-option');
        if (!opt) return;
        listEl.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        valueEl.textContent = opt.textContent;
        containerEl.classList.remove('open');
        onChange(opt.dataset.value);
    });
}

document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
});

window.openSettingsModal = async function() {
    if (isDesktopApp()) {
        const autostartToggle = document.getElementById('settings-autostart-toggle');
        autostartToggle.checked = await window.__TAURI__.autostart.isEnabled();
        autostartToggle.onchange = async () => {
            if (autostartToggle.checked) await window.__TAURI__.autostart.enable();
            else await window.__TAURI__.autostart.disable();
        };
    }

    const list = document.getElementById('widget-visibility-list');
    const { hiddenWidgets, timezone, weatherLocation } = await storageGet({ hiddenWidgets: [], timezone: 'auto', weatherLocation: 'auto' });
    list.innerHTML = '';

    const AI_EFFORT_OPTIONS = [
        { value: 'lite', label: 'سریع (کم‌هزینه)' },
        { value: 'standard', label: 'استاندارد (متعادل)' },
        { value: 'deep', label: 'عمیق (کندتر، دقیق‌تر)' },
        { value: 'exhaustive', label: 'جامع (کندترین، عمیق‌ترین)' },
        { value: 'local', label: 'رایگان (مدل محلی همین کامپیوتر)' }
    ];
    initDropdown(document.getElementById('settings-ai-effort'), AI_EFFORT_OPTIONS, preferredAiEffort, async (value) => {
        preferredAiEffort = value;
        await storageSet({ aiEffortLevel: value });
    });

    setupTelegramSettings();

    const { accentColor } = await storageGet({ accentColor: 'blue' });
    const swatchesEl = document.getElementById('settings-accent-swatches');
    swatchesEl.innerHTML = ACCENT_PRESETS.map(p => `
        <button type="button" data-accent-swatch="${p.value}" title="${escapeHtml(p.label)}" style="width:30px; height:30px; border-radius:50%; background:${p.color}; border:2px solid ${p.value === accentColor ? 'var(--text-color)' : 'transparent'}; cursor:pointer;"></button>
    `).join('');
    swatchesEl.querySelectorAll('[data-accent-swatch]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const value = btn.dataset.accentSwatch;
            applyAccentColor(value);
            await storageSet({ accentColor: value });
            swatchesEl.querySelectorAll('[data-accent-swatch]').forEach(b => { b.style.borderColor = 'transparent'; });
            btn.style.borderColor = 'var(--text-color)';
        });
    });

    const BOOKMARK_CLICK_OPTIONS = [
        { value: 'newtab', label: 'باز شدن تو تب جدید' },
        { value: 'sametab', label: 'باز شدن تو همین تب' },
        { value: 'copy', label: 'کپی کردن لینک' }
    ];
    initDropdown(document.getElementById('settings-bookmark-click'), BOOKMARK_CLICK_OPTIONS, bookmarkClickBehavior, async (value) => {
        bookmarkClickBehavior = value;
        await storageSet({ bookmarkClickBehavior: value });
    });

    initDropdown(document.getElementById('settings-timezone'), TIMEZONES, timezone, async (value) => {
        await storageSet({ timezone: value });
        initClock();
    });

    initDropdown(document.getElementById('settings-weather-location'), WEATHER_CITIES, weatherLocation, async (value) => {
        await storageSet({ weatherLocation: value });
        initWeather();
    });

    document.querySelectorAll('[data-widget]').forEach(w => {
        const key = w.dataset.widget;
        const row = document.createElement('div');
        row.className = 'settings-widget-row';
        row.innerHTML = `
            <span>${WIDGET_LABELS[key] || key}</span>
            <label class="switch">
                <input type="checkbox" data-widget-toggle="${key}" ${hiddenWidgets.includes(key) ? '' : 'checked'}>
                <span class="slider"></span>
            </label>
        `;
        list.appendChild(row);
    });

    list.querySelectorAll('input[data-widget-toggle]').forEach(chk => {
        chk.addEventListener('change', async (e) => {
            const key = e.target.dataset.widgetToggle;
            const widgetEl = document.getElementById('widget-' + key);
            const { hiddenWidgets: current } = await storageGet({ hiddenWidgets: [] });
            let updated;
            if (e.target.checked) {
                widgetEl.classList.remove('hidden-widget');
                updated = current.filter(k => k !== key);
            } else {
                widgetEl.classList.add('hidden-widget');
                updated = [...current, key];
            }
            await storageSet({ hiddenWidgets: updated });
        });
    });

    document.getElementById('settings-modal-overlay').classList.add('active');
};

window.closeSettingsModal = function() {
    document.getElementById('settings-modal-overlay').classList.remove('active');
};

// ==========================================================================
// ANIMATED DESKTOP PET CAT ENGINE (Walking Paws & Interactive Companion)
// ==========================================================================
let catLevel = 1;
let catXp = 0;
let isCatRoaming = false;
let isCatChasing = false;
let catBubbleTimer = null;
let catRoamInterval = null;
let isWalking = false;

async function restoreCat() {
    const data = await storageGet({ catLevel: 1, catXp: 0, isCatRoaming: false });
    catLevel = data.catLevel || 1;
    catXp = data.catXp || 0;
    isCatRoaming = !!data.isCatRoaming;

    const levelText = document.getElementById('cat-level-text');
    if (levelText) levelText.textContent = `گربه شما (سطح ${catLevel})`;

    const catWrap = document.getElementById('cat-character-wrap');
    const catWidget = document.getElementById('cat-widget');
    if (!catWrap || !catWidget) return;

    if (isCatRoaming) {
        catWidget.classList.add('roaming-floor');
        startAutonomousRoam();
    }

    // Direct click: Pet the cat
    catWrap.addEventListener('click', (e) => {
        e.stopPropagation();
        petCat();
    });

    // Actions popover buttons
    const btnFeed = document.getElementById('cat-act-feed');
    const btnPet = document.getElementById('cat-act-pet');
    const btnWalk = document.getElementById('cat-act-walk');
    const btnFollow = document.getElementById('cat-act-follow');

    if (btnFeed) btnFeed.addEventListener('click', (e) => { e.stopPropagation(); feedCat(); });
    if (btnPet) btnPet.addEventListener('click', (e) => { e.stopPropagation(); petCat(); });
    if (btnWalk) btnWalk.addEventListener('click', (e) => { e.stopPropagation(); toggleFloorRoaming(); });
    if (btnFollow) btnFollow.addEventListener('click', (e) => { e.stopPropagation(); toggleCursorChasing(); });

    // Periodic random meow / thought
    setInterval(() => {
        if (Math.random() < 0.3 && !isWalking) {
            const idleThoughts = [
                'میو! روزت پر از انرژی و موفقیت 🐾',
                'خسته نباشی! یه جرعه آب بنوش 🥤',
                'کدها عالی پیش میرن! ✨',
                'هوای آفتابی چقدر خوبه ☀️',
                'یکمی استراحت کن و کش و قوس بیا 🐱',
                'میووو... خرخرخر 💖'
            ];
            showCatBubble(idleThoughts[Math.floor(Math.random() * idleThoughts.length)], 3500);
        }
    }, 40000);
}

function showCatBubble(text, duration = 3000) {
    const bubble = document.getElementById('cat-bubble');
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add('active');
    clearTimeout(catBubbleTimer);
    catBubbleTimer = setTimeout(() => {
        bubble.classList.remove('active');
    }, duration);
}

function petCat() {
    const catWrap = document.getElementById('cat-character-wrap');
    if (!catWrap) return;

    catWrap.classList.remove('cat-idle', 'walking');
    catWrap.classList.add('happy-jump');
    setTimeout(() => {
        catWrap.classList.remove('happy-jump');
        catWrap.classList.add('cat-idle');
    }, 700);

    addCatXp(5);
    const petPhrases = ['خرخرخر... مرسی! 💖', 'میو! خیلی کیف داد ✨', 'عاشقتم! 🐾', 'چقدر مهربونی 😻'];
    showCatBubble(petPhrases[Math.floor(Math.random() * petPhrases.length)], 2500);
}

function feedCat() {
    const catWrap = document.getElementById('cat-character-wrap');
    if (!catWrap) return;

    catWrap.classList.remove('cat-idle', 'walking');
    catWrap.classList.add('happy-jump');
    setTimeout(() => {
        catWrap.classList.remove('happy-jump');
        catWrap.classList.add('cat-idle');
    }, 700);

    addCatXp(15);
    const treats = ['آخ جون ماهی تازه! 🐟😋', 'عجب گوشت خوشمزه‌ای! 🍖', 'شیر تازه! میووو 🥛', 'سیر شدم، دمت گرم! 🐱'];
    showCatBubble(treats[Math.floor(Math.random() * treats.length)], 3000);
}

async function addCatXp(amt) {
    catXp += amt;
    if (catXp >= catLevel * 50) {
        catLevel++;
        catXp = 0;
        showCatBubble(`🎉 تبریک! سطح گربه شما به ${catLevel} ارتقا یافت!`, 4000);
    }
    const levelText = document.getElementById('cat-level-text');
    if (levelText) levelText.textContent = `گربه شما (سطح ${catLevel})`;
    await storageSet({ catLevel, catXp });
}

function toggleFloorRoaming() {
    const catWidget = document.getElementById('cat-widget');
    if (!catWidget) return;

    isCatRoaming = !isCatRoaming;
    storageSet({ isCatRoaming });

    if (isCatRoaming) {
        catWidget.classList.add('roaming-floor');
        const startX = window.innerWidth / 2;
        catWidget.style.left = startX + 'px';
        showCatBubble('شروع قدم زدن آزاد روی صفحه! 🐾', 2500);
        startAutonomousRoam();
    } else {
        catWidget.classList.remove('roaming-floor');
        catWidget.style.left = '';
        clearInterval(catRoamInterval);
        isCatChasing = false;
        showCatBubble('برگشتم سر جام 🏠', 2500);
    }
}

function startAutonomousRoam() {
    clearInterval(catRoamInterval);
    catRoamInterval = setInterval(() => {
        if (!isCatRoaming || isCatChasing) return;
        if (Math.random() < 0.7) {
            const margin = 100;
            const newX = margin + Math.random() * (window.innerWidth - margin * 2);
            walkCatTo(newX, Math.random() > 0.6 ? 'run' : 'walk');
        }
    }, 6000);
}

function walkCatTo(targetX, mode = 'walk') {
    const catWidget = document.getElementById('cat-widget');
    const catWrap = document.getElementById('cat-character-wrap');
    if (!catWidget || !catWrap) return;

    const startX = parseFloat(catWidget.style.left) || window.innerWidth / 2;
    const distance = targetX - startX;
    if (Math.abs(distance) < 10) return;

    const dir = distance > 0 ? 1 : -1;
    // Flip facing direction
    catWrap.style.transform = dir > 0 ? 'scaleX(1)' : 'scaleX(-1)';

    catWrap.classList.remove('cat-idle', 'walking', 'running');
    catWrap.classList.add(mode === 'run' ? 'running' : 'walking');
    isWalking = true;

    const speed = mode === 'run' ? 5 : 2.5;
    let currentX = startX;

    function step() {
        if (!isWalking) return;
        const rem = targetX - currentX;
        if (Math.abs(rem) <= speed) {
            currentX = targetX;
            catWidget.style.left = currentX + 'px';
            catWrap.classList.remove('walking', 'running');
            catWrap.classList.add('cat-idle');
            isWalking = false;
            return;
        }

        currentX += dir * speed;
        catWidget.style.left = currentX + 'px';
        requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function toggleCursorChasing() {
    const catWidget = document.getElementById('cat-widget');
    if (!catWidget) return;

    if (!isCatRoaming) {
        toggleFloorRoaming();
    }

    isCatChasing = !isCatChasing;
    if (isCatChasing) {
        showCatBubble('بیا بازی! موست رو حرکت بده 🧶', 3000);
        window.addEventListener('mousemove', onMouseMoveChase);
    } else {
        window.removeEventListener('mousemove', onMouseMoveChase);
        showCatBubble('خسته شدم از دویدن! 😸', 2000);
    }
}

let lastChaseThrottle = 0;
function onMouseMoveChase(e) {
    if (!isCatChasing) return;
    const now = Date.now();
    if (now - lastChaseThrottle < 200) return;
    lastChaseThrottle = now;

    const targetX = Math.max(60, Math.min(window.innerWidth - 60, e.clientX));
    walkCatTo(targetX, 'run');
}

async function resetFunWidgets() {
    if (!await showConfirm('حالت روحی و سطح گربه پاک شود؟')) return;
    catLevel = 1;
    catXp = 0;
    await storageSet({ catLevel: 1, catXp: 0, mood: null });
    const levelText = document.getElementById('cat-level-text');
    if (levelText) levelText.textContent = 'گربه شما (سطح ۱)';
    document.querySelectorAll('.mood-emoji').forEach(s => { s.dataset.active = '0'; });
    showCatBubble('گربه شما ریست شد! 🐾');
}

// --- Bottom Dock ---
function setDockActive(index) {
    const items = document.querySelectorAll('.dock-item');
    items.forEach(d => d.classList.remove('active'));
    if (items[index]) items[index].classList.add('active');
}

window.dockGoHome = function() {
    setDockActive(0);
    if (document.getElementById('notion-workspace-view').style.display !== 'none') {
        closeNotionWorkspace();
    }
    switchProject(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.dockGoProjects = function() {
    setDockActive(1);
    if (document.getElementById('notion-workspace-view').style.display !== 'none') {
        closeNotionWorkspace();
    }
    const el = document.getElementById('widget-projects');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash-highlight');
    setTimeout(() => el.classList.remove('flash-highlight'), 900);
};

// --- Clock & Date ---
const TIMEZONES = [
    { value: 'auto', label: 'خودکار (منطقه زمانی سیستم)' },
    { value: 'Asia/Tehran', label: 'ایران - تهران' },
    { value: 'Asia/Dubai', label: 'امارات - دبی' },
    { value: 'Europe/Istanbul', label: 'ترکیه - استانبول' },
    { value: 'Europe/London', label: 'انگلستان - لندن' },
    { value: 'Europe/Berlin', label: 'آلمان - برلین' },
    { value: 'Europe/Moscow', label: 'روسیه - مسکو' },
    { value: 'America/New_York', label: 'آمریکا - نیویورک' },
    { value: 'America/Los_Angeles', label: 'آمریکا - لس‌آنجلس' },
    { value: 'Asia/Shanghai', label: 'چین - شانگهای' },
    { value: 'Asia/Tokyo', label: 'ژاپن - توکیو' },
    { value: 'Asia/Kolkata', label: 'هند - دهلی' },
    { value: 'Australia/Sydney', label: 'استرالیا - سیدنی' },
    { value: 'UTC', label: 'UTC' }
];

let clockInterval = null;

async function initClock() {
    const clockEl = document.getElementById('clock');
    const dateEl = document.getElementById('date');
    const { timezone } = await storageGet({ timezone: 'auto' });
    const tz = timezone && timezone !== 'auto' ? timezone : undefined;

    function updateTime() {
        const now = new Date();
        const timeOpts = { hour: '2-digit', minute: '2-digit' };
        const dateOpts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        if (tz) { timeOpts.timeZone = tz; dateOpts.timeZone = tz; }
        clockEl.textContent = now.toLocaleTimeString('fa-IR', timeOpts);
        dateEl.textContent = now.toLocaleDateString('fa-IR', dateOpts);
    }

    clearInterval(clockInterval);
    updateTime();
    clockInterval = setInterval(updateTime, 1000);
}

// --- Weather (keyless open-meteo API + geolocation) ---
function weatherIconClass(code, isDay) {
    if (code === 0) return isDay ? 'fa-sun' : 'fa-moon';
    if (code >= 1 && code <= 3) return 'fa-cloud-sun';
    if (code === 45 || code === 48) return 'fa-smog';
    if (code >= 51 && code <= 67) return 'fa-cloud-rain';
    if (code >= 71 && code <= 77) return 'fa-snowflake';
    if (code >= 80 && code <= 82) return 'fa-cloud-showers-heavy';
    if (code >= 95) return 'fa-bolt';
    return 'fa-cloud';
}

// One color per condition so rain/snow/storm/fog actually look different from a
// sunny day, instead of every icon rendering in the same fixed sun-yellow.
function weatherIconColor(code, isDay) {
    if (code === 0) return isDay ? '#ffd60a' : '#c7d2fe';
    if (code >= 1 && code <= 3) return '#94a3b8';
    if (code === 45 || code === 48) return '#9ca3af';
    if (code >= 51 && code <= 67) return '#38bdf8';
    if (code >= 71 && code <= 77) return '#7dd3fc';
    if (code >= 80 && code <= 82) return '#2563eb';
    if (code >= 95) return '#f59e0b';
    return '#94a3b8';
}

// A subtle, condition-matched motion class (rain bounces, snow sways, storm flickers, ...).
function weatherIconAnimClass(code) {
    if (code === 0) return 'weather-anim-sun';
    if (code >= 1 && code <= 3) return 'weather-anim-cloud';
    if (code === 45 || code === 48) return 'weather-anim-cloud';
    if (code >= 51 && code <= 67) return 'weather-anim-rain';
    if (code >= 71 && code <= 77) return 'weather-anim-snow';
    if (code >= 80 && code <= 82) return 'weather-anim-rain';
    if (code >= 95) return 'weather-anim-storm';
    return 'weather-anim-cloud';
}

const WEATHER_CITIES = [
    { value: 'auto', label: 'خودکار (موقعیت مکانی من)', lat: null, lon: null },
    { value: 'tehran', label: 'تهران', lat: 35.6892, lon: 51.3890 },
    { value: 'mashhad', label: 'مشهد', lat: 36.2605, lon: 59.6168 },
    { value: 'isfahan', label: 'اصفهان', lat: 32.6546, lon: 51.6680 },
    { value: 'shiraz', label: 'شیراز', lat: 29.5918, lon: 52.5837 },
    { value: 'tabriz', label: 'تبریز', lat: 38.0800, lon: 46.2919 },
    { value: 'karaj', label: 'کرج', lat: 35.8400, lon: 50.9391 },
    { value: 'ahvaz', label: 'اهواز', lat: 31.3183, lon: 48.6706 },
    { value: 'qom', label: 'قم', lat: 34.6416, lon: 50.8746 },
    { value: 'kermanshah', label: 'کرمانشاه', lat: 34.3277, lon: 47.0778 },
    { value: 'urmia', label: 'ارومیه', lat: 37.5527, lon: 45.0761 },
    { value: 'ardabil', label: 'اردبیل', lat: 38.2498, lon: 48.2933 },
    { value: 'rasht', label: 'رشت', lat: 37.2809, lon: 49.5832 },
    { value: 'zahedan', label: 'زاهدان', lat: 29.4963, lon: 60.8629 },
    { value: 'yazd', label: 'یزد', lat: 31.8974, lon: 54.3569 },
    { value: 'kerman', label: 'کرمان', lat: 30.2839, lon: 57.0834 },
    { value: 'arak', label: 'اراک', lat: 34.0917, lon: 49.6892 },
    { value: 'bandarabbas', label: 'بندرعباس', lat: 27.1865, lon: 56.2808 }
];

let weatherCoords = null; // {lat, lon, label} - filled in once resolved, reused by the forecast modal

async function initWeather() {
    const cityEl = document.getElementById('weather-city');
    const tempEl = document.getElementById('weather-temp');
    const iconEl = document.getElementById('weather-icon');

    const applyWeather = (lat, lon, cityLabel) => {
        weatherCoords = { lat, lon, label: cityLabel };
        fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`)
            .then(r => r.json())
            .then(data => {
                if (!data.current_weather) throw new Error('no data');
                const w = data.current_weather;
                tempEl.textContent = Math.round(w.temperature) + '°';
                cityEl.textContent = cityLabel;
                iconEl.className = 'fa weather-icon ' + weatherIconClass(w.weathercode, w.is_day) + ' ' + weatherIconAnimClass(w.weathercode);
                iconEl.style.color = weatherIconColor(w.weathercode, w.is_day);
            })
            .catch(() => { cityEl.textContent = 'دریافت نشد'; });
    };

    const { weatherLocation } = await storageGet({ weatherLocation: 'auto' });
    const preset = WEATHER_CITIES.find(c => c.value === weatherLocation);

    if (preset && preset.value !== 'auto') {
        applyWeather(preset.lat, preset.lon, preset.label);
        return;
    }

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => applyWeather(pos.coords.latitude.toFixed(2), pos.coords.longitude.toFixed(2), 'موقعیت شما'),
            () => applyWeather(35.6892, 51.3890, 'تهران'),
            { timeout: 5000 }
        );
    } else {
        applyWeather(35.6892, 51.3890, 'تهران');
    }
}

function formatForecastHour(isoStr) {
    return new Date(isoStr).toLocaleTimeString('fa-IR', { hour: '2-digit' });
}
function formatForecastDay(isoStr, idx) {
    if (idx === 0) return 'امروز';
    return new Date(isoStr + 'T00:00:00').toLocaleDateString('fa-IR', { weekday: 'long' });
}

async function openWeatherDetails() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    clearInterval(tempMailInterval);
    clearTimeout(reactionTimeout);

    title.innerHTML = '<i class="fa fa-cloud-sun"></i> پیش‌بینی آب و هوا';
    body.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem 0;">در حال دریافت اطلاعات...</div>';
    overlay.classList.add('active');

    const coords = weatherCoords || { lat: 35.6892, lon: 51.3890, label: 'تهران' };
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current_weather=true&hourly=temperature_2m,weathercode&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=7`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('bad status');
        const data = await res.json();

        const cw = data.current_weather;
        let startIdx = data.hourly.time.indexOf(cw.time);
        if (startIdx < 0) startIdx = 0;
        const hourly = data.hourly.time.slice(startIdx, startIdx + 12).map((t, i) => ({
            time: t,
            temp: data.hourly.temperature_2m[startIdx + i],
            code: data.hourly.weathercode[startIdx + i]
        }));
        const daily = data.daily.time.map((t, i) => ({
            date: t,
            max: data.daily.temperature_2m_max[i],
            min: data.daily.temperature_2m_min[i],
            code: data.daily.weathercode[i]
        }));

        body.innerHTML = `
            <div style="text-align:center; margin-bottom:1.5rem;">
                <i class="fa ${weatherIconClass(cw.weathercode, cw.is_day)} ${weatherIconAnimClass(cw.weathercode)}" style="font-size:3rem; color:${weatherIconColor(cw.weathercode, cw.is_day)};"></i>
                <div style="font-size:2.2rem; font-weight:bold; margin-top:0.5rem;">${Math.round(cw.temperature)}°</div>
                <div class="text-muted">${escapeHtml(coords.label)}</div>
            </div>
            <h4 style="font-size:0.9rem; color:var(--text-muted); margin-bottom:0.6rem;">ساعت‌های آینده</h4>
            <div id="weather-hourly" style="display:flex; gap:0.75rem; overflow-x:auto; padding-bottom:0.75rem; margin-bottom:1.5rem;"></div>
            <h4 style="font-size:0.9rem; color:var(--text-muted); margin-bottom:0.6rem;">هفته آینده</h4>
            <div id="weather-daily" style="display:flex; flex-direction:column; gap:0.5rem;"></div>
        `;

        document.getElementById('weather-hourly').innerHTML = hourly.map(h => `
            <div style="flex:0 0 auto; text-align:center; background:rgba(128,128,128,0.06); border-radius:12px; padding:0.6rem 0.8rem; min-width:64px;">
                <div style="font-size:0.75rem; color:var(--text-muted);">${formatForecastHour(h.time)}</div>
                <i class="fa ${weatherIconClass(h.code, 1)} ${weatherIconAnimClass(h.code)}" style="margin:0.4rem 0; color:${weatherIconColor(h.code, 1)}; display:block;"></i>
                <div style="font-size:0.85rem; font-weight:600;">${Math.round(h.temp)}°</div>
            </div>
        `).join('');

        document.getElementById('weather-daily').innerHTML = daily.map((d, i) => `
            <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(128,128,128,0.06); border-radius:10px; padding:0.6rem 1rem;">
                <span style="min-width:70px;">${formatForecastDay(d.date, i)}</span>
                <i class="fa ${weatherIconClass(d.code, 1)} ${weatherIconAnimClass(d.code)}" style="color:${weatherIconColor(d.code, 1)};"></i>
                <span style="direction:ltr; font-family:monospace;"><b>${Math.round(d.max)}°</b> / ${Math.round(d.min)}°</span>
            </div>
        `).join('');
    } catch (e) {
        body.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem 0;">دریافت پیش‌بینی ممکن نشد.</div>';
    }
}

// --- Fetch Data & Instant Warm Cache ---
async function restoreCachedData() {
    try {
        const { cachedProjects, cachedData } = await storageGet({ cachedProjects: null, cachedData: null });
        if (cachedProjects && Array.isArray(cachedProjects)) {
            renderProjects(cachedProjects);
        }
        if (cachedData) {
            currentData = cachedData;
            renderTasks(cachedData.tasks || []);
            if (cachedData.notes_snippets && cachedData.notes_snippets.length > 0) {
                loadNoteIntoEditor(cachedData.notes_snippets[0]);
            }
            renderBookmarkCategories(cachedData.bookmark_categories || []);
            renderBookmarks(cachedData.bookmarks || []);
            initMarketAndPortfolio();
            renderHabits();
        }
    } catch (e) {
        console.error('Error restoring cached data:', e);
    }
}

async function fetchData() {
    const requestId = ++fetchDataRequestId;
    try {
        const [projData, data] = await Promise.all([
            apiCall('get_projects'),
            apiCall('get_data')
        ]);

        // A newer fetchData() (e.g. from switching project again) started and
        // may already own the UI - drop this stale response instead of
        // repainting over it.
        if (requestId !== fetchDataRequestId) return;

        if (projData && projData.projects) {
            renderProjects(projData.projects);
            storageSet({ cachedProjects: projData.projects });
        }

        if (data) {
            currentData = data;
            renderTasks(data.tasks || []);

            currentNoteId = null;
            if (data.notes_snippets && data.notes_snippets.length > 0) {
                loadNoteIntoEditor(data.notes_snippets[0]);
            } else {
                createNewNote(false);
            }

            renderBookmarkCategories(data.bookmark_categories || []);
            renderBookmarks(data.bookmarks || []);
            storageSet({ cachedData: data });
        }

        initCalendar();
        initMarketAndPortfolio();
        renderHabits();
        if (document.getElementById('notion-workspace-view').style.display !== 'none') renderNotionTasks();
    } catch (e) {
        console.error('Fetch data error:', e);
    }
}

// --- Projects / Workspaces ---
let projectsCache = [];

function renderProjects(projects) {
    projectsCache = projects;
    const list = document.getElementById('project-list');
    list.innerHTML = `
        <div class="project-box ${currentProjectId === null ? 'active' : ''}" data-project-id="">
            <div class="project-icon" style="background: #94a3b8;"><i class="fa fa-globe"></i></div>
            <span>فضای عمومی</span>
        </div>
    `;

    projects.forEach(p => {
        const isActive = currentProjectId == p.id ? 'active' : '';
        const initial = p.name.substring(0, 1).toUpperCase();
        list.innerHTML += `
            <div class="project-box ${isActive}" data-project-id="${p.id}">
                <button class="project-delete-btn" data-delete-project-id="${p.id}" title="حذف پروژه"><i class="fa fa-times"></i></button>
                <div class="project-icon" style="background: ${p.color};">${initial}</div>
                <span>${escapeHtml(p.name)}</span>
            </div>
        `;
    });

    updateProjectContextBanner();
}

function updateProjectContextBanner() {
    const banner = document.getElementById('project-context-banner');
    if (currentProjectId === null) {
        banner.classList.remove('active');
        return;
    }
    const project = projectsCache.find(p => String(p.id) === String(currentProjectId));
    if (!project) { banner.classList.remove('active'); return; }
    document.getElementById('project-context-name').textContent = project.name;
    document.getElementById('project-context-dot').style.background = project.color;
    banner.classList.add('active');
}

async function deleteProject(id) {
    const project = projectsCache.find(p => String(p.id) === String(id));
    const ok = await showConfirm(`پروژه «${project ? project.name : ''}» و همه‌ی تسک‌ها/بوک‌مارک‌ها/یادداشت‌های آن حذف شود؟ این عمل غیرقابل بازگشت است.`, 'حذف پروژه');
    if (!ok) return;
    await apiCall('delete_project', 'POST', { id });
    if (String(currentProjectId) === String(id)) currentProjectId = null;
    fetchData();
}

function switchProject(id) {
    currentProjectId = id;
    updateProjectContextBanner();
    fetchData();
}

function openNewProjectModal() {
    document.getElementById('project-name-input').value = '';
    document.getElementById('project-domain-input').value = '';
    document.getElementById('project-color-input').value = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
    document.getElementById('project-modal-error').style.display = 'none';
    document.getElementById('project-modal-overlay').classList.add('active');
    setTimeout(() => document.getElementById('project-name-input').focus(), 50);
}

function closeProjectModal() {
    document.getElementById('project-modal-overlay').classList.remove('active');
}

async function saveNewProject() {
    const name = document.getElementById('project-name-input').value.trim();
    const errorEl = document.getElementById('project-modal-error');
    if (!name) { errorEl.style.display = 'block'; return; }
    errorEl.style.display = 'none';

    const domain = document.getElementById('project-domain-input').value.trim() || null;
    const color = document.getElementById('project-color-input').value;
    await apiCall('add_project', 'POST', { name, domain, color, project_id: null });
    closeProjectModal();
    fetchData();
}

// --- Jalaali Calendar & Task Integration ---
let currentSelectedDate = null;
let currentCalYear = null;
let currentCalMonth = null;
let holidaysCache = {}; // year -> { 'jy-jm-jd' (zero-padded): [event descriptions] }
const months = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];

function getTodayJalaali() {
    if (typeof jalaali === 'undefined') return null;
    const j = jalaali.toJalaali(new Date());
    return `${j.jy}-${j.jm}-${j.jd}`;
}

// getTodayJalaali() (and free-typed date fields) aren't zero-padded, so comparing
// two Jalali date strings directly ("1405-6-5" vs "1405-06-21") sorts them as plain
// text instead of by actual date - pad both sides before comparing/sorting.
function padJalaliDate(dateStr) {
    if (!dateStr) return '';
    const parts = String(dateStr).trim().split('-');
    if (parts.length !== 3) return String(dateStr).trim();
    const [y, m, d] = parts;
    return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Same raw-while-editing / comma-formatted-once-blurred behavior as the finance
// monthly grid's amount cells, for any other money input (checkbook, shopping list, ...).
function wireLiveAmountFormatting(input) {
    if (!input) return;
    input.addEventListener('focus', () => {
        const raw = parseFloat(String(input.value).replace(/,/g, '')) || 0;
        input.value = raw || '';
    });
    input.addEventListener('blur', () => {
        const raw = parseFloat(String(input.value).replace(/,/g, '')) || 0;
        input.value = raw ? raw.toLocaleString() : '';
    });
}

// Resolves today's date synchronously before the first renderTasks() call so
// tasks aren't hidden on first paint while waiting for the calendar grid to init.
function initCalendarDate() {
    if (!currentSelectedDate) currentSelectedDate = getTodayJalaali();
}

function initCalendar() {
    if (typeof jalaali === 'undefined') {
        setTimeout(initCalendar, 500);
        return;
    }
    initCalendarDate();
    if (currentCalYear === null) {
        const jNow = jalaali.toJalaali(new Date());
        currentCalYear = jNow.jy;
        currentCalMonth = jNow.jm;
    }
    renderCalendar(currentCalYear, currentCalMonth);
}

// Static per-year holiday/occasion data (official Iranian holidays and other
// calendar occasions, with lunar-based ones already resolved to the correct
// Jalali day for that specific year).
// Bundled locally for the current +/- a year (extension/vendor/holidays/) so the
// calendar doesn't re-fetch this static, once-a-year data on every load. Falls
// back to the live GitHub copy only for years that aren't bundled.
const BUNDLED_HOLIDAY_YEARS = [1404, 1405, 1406];

async function fetchHolidays(year) {
    if (holidaysCache[year]) return holidaysCache[year];
    const map = {};
    try {
        const url = BUNDLED_HOLIDAY_YEARS.includes(year)
            ? `vendor/holidays/${year}.json`
            : `https://raw.githubusercontent.com/hasan-ahani/shamsi-holidays/main/holidays/${year}.json`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('bad status');
        const data = await res.json();
        data.forEach(day => {
            map[day.date] = (day.events || []).map(e => ({ description: e.description, isHoliday: !!e.is_holiday }));
        });
    } catch (e) {
        // no network / year not published yet - calendar still works, just without holiday/occasion info
    }
    holidaysCache[year] = map;
    return map;
}

let currentMonthEventsByDate = {}; // non-padded dateStr -> events[] for the currently rendered month

function updateDayEventsPanel(dateStr, events) {
    const el = document.getElementById('calendar-day-events');
    if (!el) return;
    if (!events || events.length === 0) {
        el.innerHTML = '';
        el.style.display = 'none';
        return;
    }
    el.style.display = 'flex';
    el.innerHTML = events.map(e => `<div class="${e.isHoliday ? 'cal-event-holiday' : ''}">${escapeHtml(e.description)}</div>`).join('');
}

function renderCalendar(jy, jm) {
    currentCalYear = jy;
    currentCalMonth = jm;
    document.getElementById('calendar-header-title').textContent = months[jm - 1] + ' ' + jy;

    const firstDayGreg = jalaali.toGregorian(jy, jm, 1);
    const d = new Date(firstDayGreg.gy, firstDayGreg.gm - 1, firstDayGreg.gd);
    let startDayOfWeek = d.getDay() + 1;
    if (startDayOfWeek === 7) startDayOfWeek = 0;

    const monthLength = jalaali.jalaaliMonthLength(jy, jm);

    const grid = document.querySelector('.calendar-grid');
    Array.from(grid.children).forEach((child, idx) => {
        if (idx > 6) child.remove();
    });

    for (let i = 0; i < startDayOfWeek; i++) {
        grid.appendChild(document.createElement('div'));
    }

    const todayStr = getTodayJalaali();

    fetchHolidays(jy).then(holidayMap => {
        currentMonthEventsByDate = {};
        for (let day = 1; day <= monthLength; day++) {
            const dateStr = `${jy}-${jm}-${day}`;
            const isoDateStr = `${jy}-${String(jm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayEvents = holidayMap[isoDateStr] || [];
            currentMonthEventsByDate[dateStr] = dayEvents;

            const div = document.createElement('div');
            div.className = 'cal-day';
            div.textContent = day;

            const weekday = (startDayOfWeek + day - 1) % 7; // 0=Saturday ... 6=Friday
            if (weekday === 6) div.classList.add('friday');

            if (dayEvents.some(e => e.isHoliday)) {
                div.classList.add('holiday');
                div.title = dayEvents.filter(e => e.isHoliday).map(e => e.description).join('، ');
            }

            if (dateStr === todayStr) div.classList.add('today');
            if (dateStr === currentSelectedDate) div.classList.add('active');

            if (currentData && currentData.tasks) {
                const hasTask = currentData.tasks.some(t => t.task_date === dateStr);
                if (hasTask) div.classList.add('has-task');
            }

            div.addEventListener('click', () => {
                currentSelectedDate = dateStr;
                renderCalendar(jy, jm);
                renderTasks((currentData && currentData.tasks) || []);
                updateDayEventsPanel(dateStr, dayEvents);
            });

            grid.appendChild(div);
        }

        updateDayEventsPanel(currentSelectedDate, currentMonthEventsByDate[currentSelectedDate]);
    });
}

function calPrevMonth() {
    currentCalMonth--;
    if (currentCalMonth < 1) { currentCalMonth = 12; currentCalYear--; }
    renderCalendar(currentCalYear, currentCalMonth);
}
function calNextMonth() {
    currentCalMonth++;
    if (currentCalMonth > 12) { currentCalMonth = 1; currentCalYear++; }
    renderCalendar(currentCalYear, currentCalMonth);
}
function calGoToday() {
    const jNow = jalaali.toJalaali(new Date());
    currentSelectedDate = getTodayJalaali();
    renderCalendar(jNow.jy, jNow.jm);
    renderTasks((currentData && currentData.tasks) || []);
}

// --- Tasks ---
function renderTasks(tasks) {
    const list = document.getElementById('task-list');
    list.innerHTML = '';

    const filteredTasks = tasks.filter(t => t.task_date === currentSelectedDate || (!t.task_date && currentSelectedDate === getTodayJalaali()));

    if (filteredTasks.length === 0) {
        list.innerHTML = '<li style="justify-content: center; opacity: 0.5;">تسک فعالی برای این روز ندارید!</li>';
        return;
    }

    filteredTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'task-item';
        if (task.completed == 1) li.classList.add('completed');

        li.innerHTML = `
            <span class="task-text" style="cursor:pointer;" data-action="toggle" data-task-id="${task.id}">
                ${task.is_focus == 1 ? '<i class="fa fa-star" style="color: gold; margin-left: 5px;"></i>' : ''}
                ${escapeHtml(task.content)}
            </span>
            <div class="task-item-actions">
                <button class="icon-btn" style="width:24px; height:24px; font-size:0.65rem; ${task.description ? 'background:var(--primary-color); color:#fff;' : ''}" data-action="description" data-task-id="${task.id}" title="${task.description ? 'مشاهده/ویرایش توضیحات' : 'افزودن توضیحات'}"><i class="fa fa-align-left"></i></button>
                <button class="icon-btn" style="width:24px; height:24px; font-size:0.65rem;" data-action="movedate" data-task-id="${task.id}" title="تغییر تاریخ"><i class="fa fa-calendar-day"></i></button>
                <button class="icon-btn" style="width:24px; height:24px; font-size:0.65rem;" data-action="edit" data-task-id="${task.id}" title="ویرایش متن"><i class="fa fa-pencil-alt"></i></button>
                <button class="icon-btn" style="background: rgba(239,68,68,0.2); color: #fca5a5; width:24px; height:24px; font-size:0.7rem;" data-action="delete" data-task-id="${task.id}" title="حذف">
                    <i class="fa fa-trash"></i>
                </button>
            </div>
        `;
        list.appendChild(li);
    });
}

function startEditTask(li, id) {
    const task = ((currentData && currentData.tasks) || []).find(t => String(t.id) === String(id));
    if (!task) return;
    const textSpan = li.querySelector('.task-text');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-edit-input';
    input.value = task.content;
    textSpan.replaceWith(input);
    input.focus();
    input.select();

    const save = async () => {
        const newContent = input.value.trim();
        if (newContent && newContent !== task.content) {
            await apiCall('edit_task', 'POST', { id, content: newContent, task_date: task.task_date, description: task.description });
        }
        fetchData();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = task.content; input.blur(); }
    });
    input.addEventListener('blur', save, { once: true });
}

async function moveTaskDate(id) {
    const task = ((currentData && currentData.tasks) || []).find(t => String(t.id) === String(id));
    if (!task) return;
    const current = task.task_date || getTodayJalaali();
    const input = await showPrompt('تاریخ جدید را به فرمت سال-ماه-روز شمسی وارد کنید (مثل 1405-5-25):', current, 'تغییر تاریخ تسک');
    if (!input) return;
    const parts = input.split('-').map(s => parseInt(s, 10));
    if (parts.length !== 3 || parts.some(isNaN)) { await showAlert('فرمت تاریخ نامعتبر است.'); return; }
    await apiCall('edit_task', 'POST', { id, content: task.content, task_date: `${parts[0]}-${parts[1]}-${parts[2]}`, description: task.description });
    fetchData();
}

function openTaskDescriptionModal(id) {
    const task = ((currentData && currentData.tasks) || []).find(t => String(t.id) === String(id));
    if (!task) return;
    document.getElementById('task-desc-modal-title').textContent = task.content;
    document.getElementById('task-desc-textarea').value = task.description || '';
    document.getElementById('task-desc-modal-overlay').dataset.taskId = id;
    document.getElementById('task-desc-modal-overlay').classList.add('active');
    setTimeout(() => document.getElementById('task-desc-textarea').focus(), 50);
}

function closeTaskDescriptionModal() {
    document.getElementById('task-desc-modal-overlay').classList.remove('active');
}

async function saveTaskDescription() {
    const overlay = document.getElementById('task-desc-modal-overlay');
    const id = overlay.dataset.taskId;
    const task = ((currentData && currentData.tasks) || []).find(t => String(t.id) === String(id));
    if (!task) return;
    const description = document.getElementById('task-desc-textarea').value.trim();
    await apiCall('edit_task', 'POST', { id, content: task.content, task_date: task.task_date, description: description || null });
    closeTaskDescriptionModal();
    fetchData();
}

async function addTask() {
    const input = document.getElementById('task-input');
    let content = input.value.trim();
    if (!content) return;

    let is_focus = 0;
    if (content.startsWith('!')) {
        is_focus = 1;
        content = content.substring(1).trim();
    }

    input.value = '';
    await apiCall('add_task', 'POST', { content, is_focus, task_date: currentSelectedDate });
    await fetchData();
}

async function toggleTask(id) {
    await apiCall('toggle_task', 'POST', { id });
    await fetchData();
}

async function deleteTask(id) {
    await apiCall('delete_task', 'POST', { id });
    await fetchData();
}

// --- Notes / Snippets Library ---
let currentNoteId = null;
let noteTimeout;

function renderNotesList(notes) {
    const list = document.getElementById('notes-list');
    list.innerHTML = '';
    if (!notes || notes.length === 0) {
        list.innerHTML = '<li class="text-muted" style="font-size:0.8rem; padding:0.5rem;">یادداشتی وجود ندارد</li>';
        return;
    }
    const typeIcon = { snippet: '💻', evidence: '📌' };
    notes.forEach(n => {
        const li = document.createElement('li');
        li.className = 'note-list-item' + (String(n.id) === String(currentNoteId) ? ' active' : '');
        const label = (n.title || n.content || 'یادداشت بی‌نام').trim().slice(0, 24) || 'یادداشت بی‌نام';
        li.innerHTML = `
            <span class="note-title">${typeIcon[n.type] || '📝'} ${escapeHtml(label)}</span>
            <i class="fa fa-trash note-del" title="حذف"></i>
        `;
        li.querySelector('.note-del').addEventListener('click', (e) => { e.stopPropagation(); deleteNoteItem(n.id); });
        li.addEventListener('click', () => loadNoteIntoEditor(n));
        list.appendChild(li);
    });
}

function loadNoteIntoEditor(note) {
    const textarea = document.getElementById('note-textarea');
    currentNoteId = note.id;
    textarea.value = note.content || '';
    textarea.dataset.id = note.id;

    const sourceBadge = document.getElementById('note-source-badge');
    if (note.type === 'evidence' && note.source_url) {
        document.getElementById('note-source-badge-text').textContent = note.source_title || note.source_url;
        sourceBadge.href = safeUrl(note.source_url);
        sourceBadge.style.display = 'inline-flex';
    } else {
        sourceBadge.style.display = 'none';
    }

    if (currentData) renderNotesList(currentData.notes_snippets || []);
}

window.createNewNote = function(shouldFocus = true) {
    const textarea = document.getElementById('note-textarea');
    currentNoteId = null;
    textarea.value = '';
    textarea.dataset.id = '';
    document.getElementById('note-source-badge').style.display = 'none';
    // Only steal focus when the user explicitly clicked "new note" - calling
    // .focus() on an off-screen textarea auto-scrolls the page to it, which
    // was yanking the whole dashboard down to the notes widget every time
    // fetchData() fell back to this for a project/date with no notes yet.
    if (shouldFocus) textarea.focus();
    if (currentData) renderNotesList(currentData.notes_snippets || []);
};

window.deleteNoteItem = async function(id) {
    if (!await showConfirm('این یادداشت حذف شود؟')) return;
    await apiCall('delete_note', 'POST', { id });
    if (currentData) {
        currentData.notes_snippets = (currentData.notes_snippets || []).filter(n => String(n.id) !== String(id));
        if (String(currentNoteId) === String(id)) {
            const next = currentData.notes_snippets[0];
            if (next) loadNoteIntoEditor(next); else createNewNote();
        } else {
            renderNotesList(currentData.notes_snippets);
        }
    }
};

async function saveNote() {
    const textarea = document.getElementById('note-textarea');
    const content = textarea.value;
    const noteId = textarea.dataset.id;

    const status = document.getElementById('note-status');
    status.textContent = 'در حال ذخیره...';

    const firstLine = content.split('\n')[0].trim().slice(0, 40) || 'یادداشت بی‌نام';
    const type = isSnippetMode ? 'snippet' : 'note';

    const res = await apiCall('save_note', 'POST', {
        id: noteId ? parseInt(noteId) : undefined,
        title: firstLine,
        content: content,
        language: 'javascript',
        type
    });

    if (res && res.success) {
        textarea.dataset.id = res.id;
        currentNoteId = res.id;
        status.textContent = 'تغییرات ذخیره شد ✅';
        setTimeout(() => { if (status.textContent === 'تغییرات ذخیره شد ✅') status.textContent = ''; }, 2000);

        if (currentData) {
            currentData.notes_snippets = currentData.notes_snippets || [];
            const idx = currentData.notes_snippets.findIndex(n => String(n.id) === String(res.id));
            const updatedNote = { id: res.id, title: firstLine, content, type };
            if (idx >= 0) currentData.notes_snippets[idx] = { ...currentData.notes_snippets[idx], ...updatedNote };
            else currentData.notes_snippets.unshift(updatedNote);
            renderNotesList(currentData.notes_snippets);
        }
    } else {
        status.textContent = 'خطا در ذخیره‌سازی ❌';
    }
}

async function askAIAboutEvidence() {
    const notes = (currentData && currentData.notes_snippets) || [];
    const evidenceItems = notes.filter(n => n.type === 'evidence');
    if (evidenceItems.length === 0) {
        showAlert('هنوز هیچ شواهدی (متن سلکت‌شده از سایت‌ها) ثبت نکرده‌اید.');
        return;
    }
    const question = await showPrompt('چه سوالی درباره‌ی شواهد و یادداشت‌های ثبت‌شده داری؟', '', 'پرسش از AI درباره شواهد');
    if (!question) return;

    const context = 'این‌ها شواهد و یادداشت‌هایی هستند که کاربر از سایت‌های مختلف ذخیره کرده:\n\n' +
        evidenceItems.map((n, i) => `[${i + 1}] عنوان: ${n.title || 'بی‌نام'}\nمنبع: ${n.source_title || n.source_url || 'نامشخص'}\nمتن: ${(n.content || '').slice(0, 500)}`).join('\n\n');

    askAIWithContext(question, context, question);
}

// --- Bookmarks ---
let currentCategoryId = null;

function renderBookmarkCategories(categories) {
    const list = document.getElementById('bookmark-categories');
    list.innerHTML = `<span class="cat-badge ${currentCategoryId === null ? 'active' : ''}" data-cat-id="">همه</span>`;
    categories.forEach(c => {
        list.innerHTML += `<span class="cat-badge ${currentCategoryId == c.id ? 'active' : ''}" data-cat-id="${c.id}">${escapeHtml(c.name)}</span>`;
    });
}

function renderBookmarks(bookmarks) {
    const list = document.getElementById('bookmark-list');
    list.innerHTML = '';

    const filtered = currentCategoryId ? bookmarks.filter(b => b.category_id == currentCategoryId) : bookmarks;

    if (filtered.length === 0) {
        list.innerHTML = '<div style="grid-column: 1/-1; text-align:center; opacity:0.5;">بوک‌مارکی یافت نشد.</div>';
        return;
    }

    filtered.forEach(b => {
        const url = safeUrl(b.url);
        const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(b.url || '')}&sz=64`;
        list.innerHTML += `
            <div class="bookmark-item" data-bookmark-id="${b.id}" data-open-url="${url}" title="${escapeHtml(b.title)}">
                <div class="bookmark-item-actions">
                    <button class="bookmark-action-btn" data-edit-bookmark="${b.id}" title="ویرایش"><i class="fa fa-edit"></i></button>
                    <button class="bookmark-action-btn danger" data-delete-bookmark="${b.id}" title="حذف"><i class="fa fa-trash"></i></button>
                </div>
                <img src="${escapeHtml(favicon)}" alt="icon" data-fallback="icons/icon16.png">
                <span>${escapeHtml(b.title)}</span>
            </div>
        `;
    });
    wireImgFallbacks(list);

    list.querySelectorAll('.bookmark-item').forEach(item => {
        item.addEventListener('click', () => {
            const url = item.dataset.openUrl;
            if (!url || url === '#') return;
            if (bookmarkClickBehavior === 'copy') {
                navigator.clipboard.writeText(url).catch(() => {});
                const original = item.style.outline;
                item.style.outline = '2px solid var(--success-color)';
                setTimeout(() => { item.style.outline = original; }, 400);
            } else if (bookmarkClickBehavior === 'sametab') {
                window.location.href = url;
            } else {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
        });
    });
    list.querySelectorAll('[data-edit-bookmark]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const bookmark = (currentData && currentData.bookmarks || []).find(b => String(b.id) === String(btn.dataset.editBookmark));
            if (bookmark) openBookmarkModal(bookmark);
        });
    });
    list.querySelectorAll('[data-delete-bookmark]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await showConfirm('این بوک‌مارک حذف شود؟', 'حذف بوک‌مارک');
            if (!ok) return;
            await apiCall('delete_bookmark', 'POST', { id: btn.dataset.deleteBookmark });
            if (currentData) {
                currentData.bookmarks = (currentData.bookmarks || []).filter(b => String(b.id) !== String(btn.dataset.deleteBookmark));
                renderBookmarks(currentData.bookmarks);
            }
        });
    });
}

window.filterBookmarks = function(id) {
    currentCategoryId = id;
    if (currentData) {
        renderBookmarkCategories(currentData.bookmark_categories || []);
        renderBookmarks(currentData.bookmarks || []);
    }
};

let bookmarkModalSelectedCategory = '';
let editingBookmarkId = null;

function openBookmarkModal(bookmarkToEdit) {
    editingBookmarkId = bookmarkToEdit ? bookmarkToEdit.id : null;

    document.getElementById('bookmark-modal-title').innerHTML = editingBookmarkId
        ? '<i class="fa fa-edit"></i> ویرایش بوک‌مارک'
        : '<i class="fa fa-bookmark"></i> بوک‌مارک جدید';
    document.getElementById('save-bookmark-btn').textContent = editingBookmarkId ? 'ذخیره تغییرات' : 'افزودن بوک‌مارک';

    document.getElementById('bookmark-title-input').value = bookmarkToEdit ? bookmarkToEdit.title : '';
    document.getElementById('bookmark-url-input').value = bookmarkToEdit ? bookmarkToEdit.url : '';
    document.getElementById('bookmark-modal-error').style.display = 'none';
    document.getElementById('bookmark-new-category-wrap').style.display = 'none';
    document.getElementById('bookmark-new-category-input').value = '';
    document.getElementById('bookmark-ai-category-status').style.display = 'none';

    const categories = (currentData && currentData.bookmark_categories) || [];
    const options = [
        { value: '', label: 'بدون دسته‌بندی' },
        ...categories.map(c => ({ value: String(c.id), label: c.name })),
        { value: '__new__', label: '+ دسته‌بندی جدید' }
    ];
    bookmarkModalSelectedCategory = bookmarkToEdit
        ? (bookmarkToEdit.category_id ? String(bookmarkToEdit.category_id) : '')
        : (currentCategoryId ? String(currentCategoryId) : '');
    initDropdown(document.getElementById('bookmark-category-select'), options, bookmarkModalSelectedCategory, (value) => {
        bookmarkModalSelectedCategory = value;
        document.getElementById('bookmark-new-category-wrap').style.display = value === '__new__' ? 'flex' : 'none';
    });

    document.getElementById('bookmark-modal-overlay').classList.add('active');
    setTimeout(() => document.getElementById('bookmark-title-input').focus(), 50);
}

function closeBookmarkModal() {
    document.getElementById('bookmark-modal-overlay').classList.remove('active');
    editingBookmarkId = null;
}

window.addBookmark = () => openBookmarkModal();

async function saveBookmark() {
    const title = document.getElementById('bookmark-title-input').value.trim();
    const url = document.getElementById('bookmark-url-input').value.trim();
    const errorEl = document.getElementById('bookmark-modal-error');
    if (!title || !url) { errorEl.textContent = 'عنوان و لینک الزامی هستند.'; errorEl.style.display = 'block'; return; }
    errorEl.style.display = 'none';

    let categoryId = (bookmarkModalSelectedCategory && bookmarkModalSelectedCategory !== '__new__') ? Number(bookmarkModalSelectedCategory) : null;

    if (bookmarkModalSelectedCategory === '__new__') {
        const newName = document.getElementById('bookmark-new-category-input').value.trim();
        if (!newName) { errorEl.textContent = 'نام دسته‌بندی جدید را وارد کنید.'; errorEl.style.display = 'block'; return; }
        const catRes = await apiCall('add_bookmark_category', 'POST', { name: newName });
        if (catRes && catRes.success) {
            categoryId = catRes.id;
        } else {
            errorEl.textContent = 'ساخت دسته‌بندی جدید ممکن نشد.'; errorEl.style.display = 'block'; return;
        }
    }

    if (editingBookmarkId) {
        await apiCall('edit_bookmark', 'POST', { id: editingBookmarkId, title, url, category_id: categoryId });
    } else {
        await apiCall('add_bookmark', 'POST', { title, url, category_id: categoryId });
    }
    closeBookmarkModal();
    fetchData();
}

async function suggestBookmarkCategoryWithAI() {
    const title = document.getElementById('bookmark-title-input').value.trim();
    const url = document.getElementById('bookmark-url-input').value.trim();
    const statusEl = document.getElementById('bookmark-ai-category-status');
    statusEl.style.display = 'block';

    if (!title && !url) {
        statusEl.textContent = 'اول عنوان یا لینک رو وارد کن.';
        return;
    }
    const categories = (currentData && currentData.bookmark_categories) || [];
    if (categories.length === 0) {
        statusEl.textContent = 'هنوز دسته‌بندی‌ای نساختی که ازش پیشنهاد بدم؛ اول یکی بساز.';
        return;
    }
    statusEl.innerHTML = '<i class="fa fa-spinner fa-spin"></i> در حال تحلیل...';

    const namesList = categories.map(c => c.name).join('، ');
    const res = await callAI(`فقط و فقط دقیقاً یکی از این نام‌های دسته‌بندی رو (بدون هیچ توضیح یا کلمه‌ی اضافه) به‌عنوان جواب برگردون که با این بوک‌مارک بیشترین تناسب رو داره، یا اگه هیچ‌کدوم مناسب نبودن دقیقاً کلمه‌ی «هیچکدام» رو برگردون.\n\nدسته‌بندی‌های موجود: ${namesList}\n\nعنوان بوک‌مارک: ${title}\nلینک: ${url}`);

    if (!res || !res.success || !res.answer) {
        statusEl.textContent = (res && res.error) || 'پیشنهاد گرفتن ممکن نشد.';
        return;
    }
    const answer = String(res.answer).trim().replace(/^["'«»]+|["'«»]+$/g, '');
    const matched = categories.find(c => c.name.trim() === answer || answer.includes(c.name.trim()));
    if (!matched) {
        statusEl.textContent = 'دسته‌بندی مناسبی بین موارد موجود پیدا نشد.';
        return;
    }
    bookmarkModalSelectedCategory = String(matched.id);
    const options = [
        { value: '', label: 'بدون دسته‌بندی' },
        ...categories.map(c => ({ value: String(c.id), label: c.name })),
        { value: '__new__', label: '+ دسته‌بندی جدید' }
    ];
    initDropdown(document.getElementById('bookmark-category-select'), options, bookmarkModalSelectedCategory, (value) => {
        bookmarkModalSelectedCategory = value;
        document.getElementById('bookmark-new-category-wrap').style.display = value === '__new__' ? 'flex' : 'none';
    });
    document.getElementById('bookmark-new-category-wrap').style.display = 'none';
    statusEl.innerHTML = `<i class="fa fa-check" style="color:var(--success-color);"></i> دسته «${escapeHtml(matched.name)}» پیشنهاد شد.`;
}

// --- Mood Tracker & Quote ---
const quotes = [
    "موفقیت یعنی رفتن از شکستی به شکست دیگر، بدون از دست دادن اشتیاق.",
    "اگر می‌خواهید رازی را پنهان کنید، آن را در صفحه دوم گوگل قرار دهید! (کابوس سئوکاران)",
    "کد خوب مانند یک لطیفه است. اگر مجبور شوید آن را توضیح دهید، یعنی بد است.",
    "اولین قدم برای حل یک مشکل، فهمیدن آن است.",
    "باگ‌ها قابلیت‌هایی هستند که مستند نشده‌اند!"
];

async function initDailyQuote() {
    const quoteEl = document.getElementById('daily-quote');
    const authorEl = document.getElementById('daily-quote-author');
    const fallback = () => {
        quoteEl.textContent = quotes[Math.floor(Math.random() * quotes.length)];
        if (authorEl) authorEl.textContent = '';
    };
    try {
        const res = await fetch('https://ganjgah.ir/api/ganjoor/poem/random');
        if (!res.ok) throw new Error('bad status');
        const poem = await res.json();
        const lines = (poem.plainText || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2);
        if (lines.length === 0) throw new Error('empty poem');
        quoteEl.textContent = lines.join(' — ');
        if (authorEl) authorEl.textContent = poem.fullTitle ? '— ' + poem.fullTitle.split('»')[0].trim() : '';
    } catch (e) {
        fallback();
    }
}

async function setMood(element) {
    document.querySelectorAll('.mood-emoji').forEach(s => { s.dataset.active = '0'; });
    element.dataset.active = '1';

    const status = document.getElementById('note-status');
    status.textContent = 'حالت روحی شما ثبت شد!';
    setTimeout(() => { if (status.textContent === 'حالت روحی شما ثبت شد!') status.textContent = ''; }, 2000);

    await storageSet({ mood: element.dataset.mood });
}

async function restoreMood() {
    const { mood } = await storageGet({ mood: null });
    document.querySelectorAll('.mood-emoji').forEach(s => {
        s.dataset.active = (mood && s.dataset.mood === mood) ? '1' : '0';
    });
}

const SEARCH_ENGINES = [
    { value: 'google', label: 'گوگل', url: 'https://www.google.com/search?q=' },
    { value: 'bing', label: 'بینگ', url: 'https://www.bing.com/search?q=' },
    { value: 'duckduckgo', label: 'داک‌داک‌گو', url: 'https://duckduckgo.com/?q=' },
    { value: 'yahoo', label: 'یاهو', url: 'https://search.yahoo.com/search?p=' },
    { value: 'yandex', label: 'یاندکس', url: 'https://yandex.com/search/?text=' },
    { value: 'startpage', label: 'استارت‌پیج', url: 'https://www.startpage.com/sp/search?query=' }
];
const ADV_FILETYPES = [
    { value: '', label: 'بدون محدودیت نوع فایل' },
    { value: 'pdf', label: 'PDF' },
    { value: 'doc', label: 'Word (doc)' },
    { value: 'ppt', label: 'PowerPoint (ppt)' },
    { value: 'xls', label: 'Excel (xls)' },
    { value: 'txt', label: 'متنی (txt)' }
];
let currentSearchEngine = 'google';
let advFiletype = '';

function runSearch(query) {
    if (!query) return;
    const engine = SEARCH_ENGINES.find(e => e.value === currentSearchEngine) || SEARCH_ENGINES[0];
    window.open(engine.url + encodeURIComponent(query), '_blank');
}

function handleSearch(e) {
    if (e.key === 'Enter') {
        const query = e.target.value.trim();
        if (query) {
            runSearch(query);
            e.target.value = '';
        }
    }
}

async function initSearchEngine() {
    const { searchEngine } = await storageGet({ searchEngine: 'google' });
    currentSearchEngine = searchEngine;
    initDropdown(document.getElementById('search-engine-select'), SEARCH_ENGINES, currentSearchEngine, async (value) => {
        currentSearchEngine = value;
        await storageSet({ searchEngine: value });
    });
}

function runAdvancedSearch() {
    const parts = [];
    const base = document.getElementById('global-search').value.trim();
    if (base) parts.push(base);
    const exact = document.getElementById('adv-exact').value.trim();
    if (exact) parts.push(`"${exact}"`);
    const exclude = document.getElementById('adv-exclude').value.trim();
    if (exclude) exclude.split(/\s+/).forEach(w => parts.push('-' + w));
    const site = document.getElementById('adv-site').value.trim();
    if (site) parts.push('site:' + site);
    const intitle = document.getElementById('adv-intitle').value.trim();
    if (intitle) parts.push('intitle:' + intitle);
    if (advFiletype) parts.push('filetype:' + advFiletype);
    const after = document.getElementById('adv-after').value;
    if (after) parts.push('after:' + after);
    const before = document.getElementById('adv-before').value;
    if (before) parts.push('before:' + before);

    if (parts.length === 0) return;
    const query = parts.join(' ');
    window.open(SEARCH_ENGINES[0].url + encodeURIComponent(query), '_blank'); // advanced operators are Google-specific
    document.getElementById('advanced-search-panel').classList.remove('open');
}

function setupEventListeners() {
    document.getElementById('add-task-btn').addEventListener('click', addTask);
    document.getElementById('task-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addTask();
    });

    document.getElementById('global-search').addEventListener('keypress', handleSearch);

    initDropdown(document.getElementById('adv-filetype-select'), ADV_FILETYPES, advFiletype, (value) => { advFiletype = value; });
    document.getElementById('advanced-search-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('advanced-search-panel').classList.toggle('open');
    });
    document.getElementById('adv-search-run-btn').addEventListener('click', runAdvancedSearch);
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('advanced-search-panel');
        const btn = document.getElementById('advanced-search-btn');
        if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
            panel.classList.remove('open');
        }
    });

    document.getElementById('note-textarea').addEventListener('input', () => {
        clearTimeout(noteTimeout);
        document.getElementById('note-status').textContent = 'در حال تایپ...';
        noteTimeout = setTimeout(saveNote, 1000);
    });

    // --- Delegated listeners for dynamically-regenerated lists ---
    document.getElementById('project-list').addEventListener('click', (e) => {
        const delBtn = e.target.closest('.project-delete-btn');
        if (delBtn) { e.stopPropagation(); deleteProject(Number(delBtn.dataset.deleteProjectId)); return; }
        const box = e.target.closest('.project-box');
        if (!box) return;
        const pid = box.dataset.projectId;
        if (pid) { openNotionWorkspace(Number(pid)); } else { switchProject(null); }
    });
    document.getElementById('project-context-exit-btn').addEventListener('click', () => switchProject(null));

    document.getElementById('task-list').addEventListener('click', (e) => {
        const el = e.target.closest('[data-action][data-task-id]');
        if (!el) return;
        const id = Number(el.dataset.taskId);
        const action = el.dataset.action;
        if (action === 'toggle') toggleTask(id);
        else if (action === 'delete') deleteTask(id);
        else if (action === 'movedate') moveTaskDate(id);
        else if (action === 'edit') startEditTask(el.closest('.task-item'), id);
        else if (action === 'description') openTaskDescriptionModal(id);
    });

    document.getElementById('bookmark-categories').addEventListener('click', (e) => {
        const badge = e.target.closest('.cat-badge');
        if (!badge) return;
        const id = badge.dataset.catId;
        filterBookmarks(id ? Number(id) : null);
    });

    document.getElementById('mood-selector').addEventListener('click', (e) => {
        const el = e.target.closest('.mood-emoji');
        if (el) setMood(el);
    });

    document.getElementById('tools-grid').addEventListener('click', (e) => {
        const el = e.target.closest('.tool-btn');
        if (el) openTool(el.dataset.tool);
    });

    // --- Static controls (fixed DOM nodes, bound once) ---
    document.getElementById('deep-focus-toggle').addEventListener('change', toggleDeepFocus);
    document.getElementById('cat-widget').addEventListener('click', feedCat);
    document.getElementById('weather-widget').addEventListener('click', openWeatherDetails);
    document.getElementById('launch-workspace-btn').addEventListener('click', launchWorkspace);
    document.getElementById('new-project-btn').addEventListener('click', openNewProjectModal);
    document.getElementById('pomodoro-start-btn').addEventListener('click', togglePomodoro);
    document.getElementById('pomodoro-reset-btn').addEventListener('click', resetPomodoro);
    document.getElementById('pomodoro-stats-btn').addEventListener('click', openPomodoroStats);
    document.getElementById('pomodoro-mini-btn').addEventListener('click', () => {
        window.__TAURI__.core.invoke('open_mini_pomodoro');
    });
    document.getElementById('cal-prev-btn').addEventListener('click', calPrevMonth);
    document.getElementById('cal-next-btn').addEventListener('click', calNextMonth);
    document.getElementById('cal-today-btn').addEventListener('click', calGoToday);
    document.getElementById('edit-assets-btn').addEventListener('click', editAssetsModal);
    document.getElementById('open-finance-tracker-widget-btn').addEventListener('click', openFinanceTrackerTool);
    document.getElementById('add-bookmark-btn').addEventListener('click', addBookmark);
    document.getElementById('snippet-toggle-btn').addEventListener('click', toggleSnippetMode);
    document.getElementById('new-note-btn').addEventListener('click', createNewNote);
    document.getElementById('notes-ai-ask-btn').addEventListener('click', askAIAboutEvidence);

    document.getElementById('dock-home-btn').addEventListener('click', dockGoHome);
    document.getElementById('dock-projects-btn').addEventListener('click', dockGoProjects);
    document.getElementById('dock-all-tasks-btn').addEventListener('click', openAllTasksView);
    document.getElementById('theme-toggle-btn').addEventListener('click', toggleTheme);
    document.getElementById('dock-settings-btn').addEventListener('click', openSettingsModal);
    document.getElementById('dock-logout-btn').addEventListener('click', logoutUser);

    document.getElementById('close-modal-btn').addEventListener('click', closeModal);
    document.getElementById('close-assets-modal-btn').addEventListener('click', closeAssetsModal);
    document.getElementById('save-assets-btn').addEventListener('click', saveAssets);
    document.getElementById('close-settings-modal-btn').addEventListener('click', closeSettingsModal);
    document.getElementById('settings-theme-toggle').addEventListener('change', toggleTheme);
    document.getElementById('reset-fun-widgets-btn').addEventListener('click', resetFunWidgets);

    document.getElementById('close-project-modal-btn').addEventListener('click', closeProjectModal);
    document.getElementById('save-project-btn').addEventListener('click', saveNewProject);
    document.getElementById('project-name-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') saveNewProject(); });

    document.getElementById('close-bookmark-modal-btn').addEventListener('click', closeBookmarkModal);
    document.getElementById('save-bookmark-btn').addEventListener('click', saveBookmark);
    document.getElementById('bookmark-url-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') saveBookmark(); });
    document.getElementById('bookmark-ai-category-btn').addEventListener('click', suggestBookmarkCategoryWithAI);

    document.getElementById('close-task-desc-modal-btn').addEventListener('click', closeTaskDescriptionModal);
    document.getElementById('save-task-desc-btn').addEventListener('click', saveTaskDescription);

    document.getElementById('portfolio-privacy-wrap').addEventListener('click', () => {
        document.getElementById('widget-market').classList.toggle('portfolio-revealed');
    });
    // --- Notion Workspace & v2 Feature Listeners ---
    initKanbanDragAndDrop();
    document.getElementById('cmd-palette-btn').addEventListener('click', openCommandPalette);
    document.getElementById('dock-cmd-btn').addEventListener('click', openCommandPalette);

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            openCommandPalette();
        } else if (e.key === 'Escape') {
            closeCommandPalette();
            closeTaskDrawer();
            closeAiAssistantModal();
            closeVaultModal();
            closeSessionsModal();
            closeModal();
        }
    });

    document.getElementById('cmd-palette-input').addEventListener('input', (e) => renderCommandResults(e.target.value));
    document.getElementById('cmd-palette-input').addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            cmdSelectedIdx = Math.min(cmdSelectedIdx + 1, cmdResultsList.length - 1);
            updateCommandSelectionUI();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            cmdSelectedIdx = Math.max(cmdSelectedIdx - 1, 0);
            updateCommandSelectionUI();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (cmdResultsList[cmdSelectedIdx]) {
                closeCommandPalette();
                cmdResultsList[cmdSelectedIdx].run();
            }
        }
    });
    document.getElementById('cmd-palette-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'cmd-palette-overlay') closeCommandPalette();
    });

    // Notion Workspace
    document.getElementById('notion-back-btn').addEventListener('click', closeNotionWorkspace);
    document.getElementById('view-board-btn').addEventListener('click', () => switchNotionView('board'));
    document.getElementById('view-list-btn').addEventListener('click', () => switchNotionView('list'));
    document.getElementById('notion-add-task-btn').addEventListener('click', () => openTaskDrawer(null, 'todo'));
    document.getElementById('notion-save-tabs-btn').addEventListener('click', openSessionsModal);
    document.getElementById('notion-launch-btn').addEventListener('click', launchWorkspace);
    document.getElementById('project-context-open-notion-btn').addEventListener('click', () => openNotionWorkspace(currentProjectId));
    document.getElementById('open-notion-board-widget-btn').addEventListener('click', () => openNotionWorkspace(currentProjectId || (projectsCache[0] ? projectsCache[0].id : null)));

    document.querySelectorAll('.kanban-add-btn').forEach(btn => {
        btn.addEventListener('click', () => openTaskDrawer(null, btn.dataset.status));
    });

    // Task Drawer
    document.getElementById('close-drawer-btn').addEventListener('click', closeTaskDrawer);
    document.getElementById('drawer-save-btn').addEventListener('click', saveTaskDrawer);
    document.getElementById('drawer-delete-btn').addEventListener('click', drawerDeleteCurrentTask);
    document.getElementById('drawer-add-subtask-btn').addEventListener('click', drawerAddSubtask);
    document.getElementById('drawer-ai-subtasks-btn').addEventListener('click', drawerAskAISubtasks);
    document.getElementById('drawer-new-subtask-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') drawerAddSubtask(); });
    document.getElementById('task-drawer-overlay').addEventListener('click', (e) => { if (e.target.id === 'task-drawer-overlay') closeTaskDrawer(); });

    // AI Assistant
    document.getElementById('dock-ai-btn').addEventListener('click', openAiAssistantModal);
    document.getElementById('close-ai-modal-btn').addEventListener('click', closeAiAssistantModal);
    document.getElementById('ai-send-btn').addEventListener('click', () => sendAiPrompt());
    document.getElementById('ai-prompt-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiPrompt(); }
    });
    document.querySelectorAll('.ai-prompts-chips .chip-btn').forEach(btn => {
        btn.addEventListener('click', () => sendAiPrompt(btn.dataset.prompt));
    });

    // Internal Chat
    document.getElementById('dock-chat-btn').addEventListener('click', openChatModal);
    document.getElementById('close-chat-modal-btn').addEventListener('click', closeChatModal);
    document.getElementById('chat-send-btn').addEventListener('click', sendChatMessage);
    document.getElementById('chat-message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });

    // Vault
    document.getElementById('dock-vault-btn').addEventListener('click', openVaultModal);
    document.getElementById('close-vault-modal-btn').addEventListener('click', closeVaultModal);
    document.getElementById('vault-unlock-btn').addEventListener('click', unlockVault);
    document.getElementById('vault-master-pass').addEventListener('keypress', (e) => { if (e.key === 'Enter') unlockVault(); });
    document.getElementById('vault-new-item-btn').addEventListener('click', openVaultItemForm);
    document.getElementById('vault-form-cancel-btn').addEventListener('click', closeVaultItemForm);
    document.getElementById('vault-form-save-btn').addEventListener('click', saveVaultItemForm);
    document.getElementById('vault-form-generate-btn').addEventListener('click', () => {
        const input = document.getElementById('vault-form-value');
        input.value = generateStrongPassword();
        document.getElementById('vault-form-strength').innerHTML = passwordStrengthLabel(input.value);
    });
    document.getElementById('vault-form-copy-btn').addEventListener('click', () => {
        const value = document.getElementById('vault-form-value').value;
        if (!value) return;
        navigator.clipboard.writeText(value).catch(() => {});
    });
    document.getElementById('vault-form-value').addEventListener('input', (e) => {
        document.getElementById('vault-form-strength').innerHTML = passwordStrengthLabel(e.target.value);
    });

    // Habits
    document.getElementById('new-habit-btn').addEventListener('click', addNewHabit);

    // Sessions
    document.getElementById('save-current-session-btn').addEventListener('click', saveCurrentTabSession);
    document.getElementById('close-session-modal-btn').addEventListener('click', closeSessionsModal);

    // Backup & Restore
    document.getElementById('export-backup-btn').addEventListener('click', exportDashboardBackup);
    document.getElementById('import-backup-btn').addEventListener('click', () => document.getElementById('import-backup-file').click());
    document.getElementById('import-backup-file').addEventListener('change', (e) => importDashboardBackup(e.target.files[0]));

}

window.switchProject = switchProject;
window.openNewProjectModal = openNewProjectModal;
window.toggleTask = toggleTask;
window.deleteTask = deleteTask;

// --- Pomodoro Timer ---
let pomodoroInterval = null;
let pomodoroSeconds = 25 * 60;
let pomodoroMode = 'focus'; // 'focus' | 'break'
let pomodoroRunning = false;

// Focus-time tracking: seconds worked per Jalali day, kept forever in
// chrome.storage so month/multi-month stats stay available after the daily
// counter naturally "resets" (it's really just keyed by a new date string).
let pomodoroLog = {};
let pomodoroUnsavedTicks = 0;

function formatPomodoro(totalSeconds) {
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const s = (totalSeconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function formatDurationFa(totalSeconds) {
    const totalMinutes = Math.floor(totalSeconds / 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h > 0) return `${h} ساعت و ${m} دقیقه`;
    return `${m} دقیقه`;
}

async function loadPomodoroLog() {
    const { pomodoroLog: saved } = await storageGet({ pomodoroLog: {} });
    pomodoroLog = saved || {};
    updatePomodoroTodayDisplay();
}

function updatePomodoroTodayDisplay() {
    const el = document.getElementById('pomodoro-today-total');
    if (!el) return;
    const seconds = pomodoroLog[getTodayJalaali()] || 0;
    el.textContent = 'امروز: ' + formatDurationFa(seconds) + ' کار کرده‌اید';
}

function tickPomodoroFocus() {
    const key = getTodayJalaali();
    pomodoroLog[key] = (pomodoroLog[key] || 0) + 1;
    pomodoroUnsavedTicks++;
    updatePomodoroTodayDisplay();
    if (pomodoroUnsavedTicks >= 10) flushPomodoroLog();
}

async function flushPomodoroLog() {
    pomodoroUnsavedTicks = 0;
    await storageSet({ pomodoroLog });
}

function renderPomodoro() {
    document.getElementById('pomodoro-time').textContent = formatPomodoro(pomodoroSeconds);
    document.getElementById('pomodoro-mode').textContent = pomodoroMode === 'focus' ? 'زمان تمرکز' : 'زمان استراحت';
}

function notifyPomodoro() {
    const msg = pomodoroMode === 'focus' ? 'وقت استراحت است! ☕' : 'وقت تمرکز دوباره‌ست! 💪';
    if (typeof chrome !== 'undefined' && chrome.notifications) {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'https://ui-avatars.com/api/?name=%E2%8F%B0&background=0a84ff&color=fff',
            title: 'پومودورو',
            message: msg
        });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('پومودورو', { body: msg });
    }
}

window.togglePomodoro = function() {
    const btn = document.getElementById('pomodoro-start-btn');
    if (pomodoroRunning) {
        clearInterval(pomodoroInterval);
        pomodoroRunning = false;
        btn.textContent = 'ادامه';
        flushPomodoroLog();
        return;
    }
    pomodoroRunning = true;
    btn.textContent = 'توقف';
    pomodoroInterval = setInterval(() => {
        pomodoroSeconds--;
        if (pomodoroMode === 'focus') tickPomodoroFocus();
        if (pomodoroSeconds <= 0) {
            notifyPomodoro();
            flushPomodoroLog();
            pomodoroMode = pomodoroMode === 'focus' ? 'break' : 'focus';
            pomodoroSeconds = pomodoroMode === 'focus' ? 25 * 60 : 5 * 60;
        }
        renderPomodoro();
    }, 1000);
    renderPomodoro();
};

window.resetPomodoro = function() {
    clearInterval(pomodoroInterval);
    pomodoroRunning = false;
    pomodoroMode = 'focus';
    pomodoroSeconds = 25 * 60;
    const btn = document.getElementById('pomodoro-start-btn');
    if (btn) btn.textContent = 'شروع';
    renderPomodoro();
};

window.openPomodoroStats = async function() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    clearInterval(tempMailInterval);
    clearTimeout(reactionTimeout);

    title.innerHTML = '<i class="fa fa-chart-bar"></i> آمار پومودورو';

    const { pomodoroLog: log } = await storageGet({ pomodoroLog: {} });
    const monthTotals = {};
    Object.entries(log).forEach(([dateStr, sec]) => {
        const [jy, jm] = dateStr.split('-');
        const key = `${jy}-${jm}`;
        monthTotals[key] = (monthTotals[key] || 0) + sec;
    });
    const monthKeys = Object.keys(monthTotals).sort();
    const maxSeconds = Math.max(1, ...Object.values(monthTotals));
    const jNow = jalaali.toJalaali(new Date());
    const defaultMonthKey = `${jNow.jy}-${jNow.jm}`;

    body.innerHTML = `
        <h4 style="font-size:0.9rem; color:var(--text-muted); margin-bottom:0.75rem;">مقایسه ماه‌ها</h4>
        <div id="pomodoro-months-compare" style="margin-bottom:1.5rem;">
            ${monthKeys.length === 0 ? '<p class="text-muted">هنوز داده‌ای ثبت نشده.</p>' : monthKeys.map(k => {
                const [jy, jm] = k.split('-');
                const pct = Math.round((monthTotals[k] / maxSeconds) * 100);
                return `<div class="stats-month-bar-row">
                    <span class="stats-month-bar-label">${escapeHtml(months[jm - 1])} ${escapeHtml(jy)}</span>
                    <div class="stats-month-bar-track"><div class="stats-month-bar-fill" style="width:${pct}%;"></div></div>
                    <span class="stats-month-bar-value">${formatDurationFa(monthTotals[k])}</span>
                </div>`;
            }).join('')}
        </div>
        <h4 style="font-size:0.9rem; color:var(--text-muted); margin-bottom:0.75rem;">جزئیات یک ماه</h4>
        <div class="custom-select" id="pomodoro-month-select" style="max-width:220px; margin-bottom:1rem;"></div>
        <div id="pomodoro-days-list"></div>
    `;

    function renderMonthDetail(monthKey) {
        const [jy, jm] = monthKey.split('-').map(Number);
        const daysEl = document.getElementById('pomodoro-days-list');
        const entries = Object.entries(log)
            .filter(([d]) => d.startsWith(`${jy}-${jm}-`))
            .sort((a, b) => parseInt(a[0].split('-')[2], 10) - parseInt(b[0].split('-')[2], 10));
        if (entries.length === 0) { daysEl.innerHTML = '<p class="text-muted">داده‌ای برای این ماه نیست.</p>'; return; }
        const monthTotal = entries.reduce((sum, [, s]) => sum + s, 0);
        daysEl.innerHTML = `<div class="stats-day-row" style="font-weight:700;"><span>جمع ماه</span><span>${formatDurationFa(monthTotal)}</span></div>` +
            entries.map(([d, s]) => `<div class="stats-day-row"><span>${escapeHtml(d.split('-')[2])} ${escapeHtml(months[jm - 1])}</span><span>${formatDurationFa(s)}</span></div>`).join('');
    }

    const monthOptions = monthKeys.length > 0
        ? monthKeys.map(k => { const [jy, jm] = k.split('-'); return { value: k, label: `${months[jm - 1]} ${jy}` }; }).reverse()
        : [{ value: defaultMonthKey, label: `${months[jNow.jm - 1]} ${jNow.jy}` }];

    initDropdown(document.getElementById('pomodoro-month-select'), monthOptions, monthOptions[0].value, renderMonthDetail);
    renderMonthDetail(monthOptions[0].value);

    overlay.classList.add('active');
};

// --- Dev Tools Modals ---
let tempMailInterval = null;
let reactionTimeout = null;

// --- Desktop-only native tools (Vira Desktop / Tauri) ---
// Entry points that call into Rust commands are gated by isDesktopApp().
function isDesktopApp() {
    return typeof window.__TAURI__ !== 'undefined';
}

// Full system health snapshot (desktop only). GPU usage/temperature is
// intentionally not shown - there's no reliable vendor-neutral way to read
// it without bundling per-GPU-vendor SDKs (NVML for Nvidia only, etc.), and
// CPU/sensor temperatures are usually unavailable on Windows without
// Administrator rights (a Windows limitation, not something fixable here).
async function openSystemHealthTool() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    title.innerHTML = '<i class="fa fa-heart-pulse" style="color:#ef4444;"></i> سلامت سیستم';
    body.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem 0;">در حال دریافت...</div>';
    overlay.classList.add('active');

    function bar(pct) {
        const color = pct > 85 ? 'var(--danger-color)' : pct > 60 ? '#ff9f0a' : 'var(--success-color)';
        return `<div style="background:rgba(128,128,128,0.15); border-radius:6px; height:8px; overflow:hidden; margin-top:4px;">
            <div style="width:${Math.min(pct, 100)}%; height:100%; background:${color};"></div>
        </div>`;
    }

    async function refresh() {
        let stats;
        try {
            stats = await window.__TAURI__.core.invoke('get_system_stats');
        } catch (e) {
            body.innerHTML = `<p style="color:var(--danger-color); text-align:center;">دریافت اطلاعات سیستم ممکن نشد: ${escapeHtml(String(e))}</p>`;
            return;
        }
        const memPct = Math.round(stats.memory.percent);
        const swapPct = Math.round(stats.swap.percent);
        const cpuPct = Math.round(stats.cpu.usage_percent);
        const uptimeH = Math.floor(stats.os.uptime_secs / 3600);
        const uptimeM = Math.floor((stats.os.uptime_secs % 3600) / 60);
        const finiteTemps = (stats.temps || []).filter(t => typeof t.temp_c === 'number' && isFinite(t.temp_c));

        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:1.2rem;">
                <div class="finance-toolbar" style="margin-bottom:0;">
                    <div class="finance-discover-title"><i class="fa fa-heart-pulse"></i> سلامت سیستم</div>
                    <button class="btn-secondary" id="sh-refresh-btn" style="padding:0.4rem 0.8rem; font-size:0.8rem;"><i class="fa fa-sync"></i> به‌روزرسانی</button>
                </div>

                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:1rem;">
                    <div style="background:rgba(128,128,128,0.06); border-radius:12px; padding:1rem;">
                        <div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span>پردازنده (CPU)</span><strong>${cpuPct}%</strong></div>
                        ${bar(cpuPct)}
                        <div class="text-muted" style="font-size:0.75rem; margin-top:6px;">${escapeHtml(stats.cpu.brand)} • ${stats.cpu.physical_cores} هسته فیزیکی / ${stats.cpu.logical_cores} منطقی${stats.cpu.frequency_mhz ? ' • ' + stats.cpu.frequency_mhz + ' مگاهرتز' : ''}</div>
                    </div>
                    <div style="background:rgba(128,128,128,0.06); border-radius:12px; padding:1rem;">
                        <div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span>حافظه (RAM)</span><strong>${memPct}%</strong></div>
                        ${bar(memPct)}
                        <div class="text-muted" style="font-size:0.75rem; margin-top:6px;">${(stats.memory.used_mb / 1024).toFixed(1)} از ${(stats.memory.total_mb / 1024).toFixed(1)} گیگابایت</div>
                    </div>
                    ${stats.swap.total_mb > 0 ? `
                    <div style="background:rgba(128,128,128,0.06); border-radius:12px; padding:1rem;">
                        <div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span>فایل صفحه‌بندی (Swap)</span><strong>${swapPct}%</strong></div>
                        ${bar(swapPct)}
                        <div class="text-muted" style="font-size:0.75rem; margin-top:6px;">${(stats.swap.used_mb / 1024).toFixed(1)} از ${(stats.swap.total_mb / 1024).toFixed(1)} گیگابایت</div>
                    </div>
                    ` : ''}
                </div>

                <div>
                    <h4 style="font-size:0.9rem; color:var(--text-muted); margin-bottom:0.6rem;">دیسک‌ها</h4>
                    <div style="display:flex; flex-direction:column; gap:0.6rem;">
                        ${(stats.disks || []).map(d => `
                            <div style="background:rgba(128,128,128,0.06); border-radius:12px; padding:0.8rem;">
                                <div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span style="direction:ltr; display:inline-block;">${escapeHtml(d.name || d.mount_point)}</span><strong>${Math.round(d.percent_used)}%</strong></div>
                                ${bar(d.percent_used)}
                                <div class="text-muted" style="font-size:0.75rem; margin-top:6px;">${d.available_gb} گیگابایت آزاد از ${d.total_gb} گیگابایت</div>
                            </div>
                        `).join('') || '<p class="text-muted" style="font-size:0.85rem;">دیسکی شناسایی نشد.</p>'}
                    </div>
                </div>

                <div>
                    <h4 style="font-size:0.9rem; color:var(--text-muted); margin-bottom:0.6rem;">دما</h4>
                    ${finiteTemps.length > 0 ? `
                        <div style="display:flex; flex-wrap:wrap; gap:0.6rem;">
                            ${finiteTemps.map(t => `<span style="background:rgba(128,128,128,0.1); padding:0.4rem 0.8rem; border-radius:20px; font-size:0.82rem;">${escapeHtml(t.label)}: ${t.temp_c.toFixed(1)}°C</span>`).join('')}
                        </div>
                    ` : `<p class="text-muted" style="font-size:0.8rem;"><i class="fa fa-info-circle"></i> حسگر دمایی در دسترس نیست (ویندوز معمولاً بدون دسترسی Administrator دمای سخت‌افزار رو نشون نمی‌ده). کارت گرافیک هم به همین دلیل تو این پنل نیست - نیاز به ابزار اختصاصی سازنده‌ی GPU داره.</p>`}
                </div>

                <div class="text-muted" style="font-size:0.78rem; border-top:1px solid var(--glass-border); padding-top:0.8rem;">
                    ${escapeHtml(stats.os.name)} ${escapeHtml(stats.os.version)} • ${escapeHtml(stats.os.hostname)} • مدت روشن بودن: ${uptimeH} ساعت و ${uptimeM} دقیقه
                </div>
            </div>
        `;
        document.getElementById('sh-refresh-btn').addEventListener('click', refresh);
    }

    await refresh();
}

window.openTool = function(toolId) {
    // Reset any size override left over from a wide-table tool (finance ledger) -
    // each tool below decides its own size from a clean slate.
    document.querySelector('#modal-overlay .modal-content').classList.remove('modal-fullscreen');

    if (toolId === 'ai') { openAiAssistantModal(); return; }
    if (toolId === 'vault') { openVaultModal(); return; }
    if (toolId === 'systemhealth') { openSystemHealthTool(); return; }
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    if (window.VIRA_EXTRA && window.VIRA_EXTRA[toolId]) {
        title.innerHTML = window.VIRA_EXTRA[toolId].title;
        window.VIRA_EXTRA[toolId].render(body);
        overlay.classList.add('active');
        return;
    }

    clearInterval(tempMailInterval);
    clearTimeout(reactionTimeout);
    body.innerHTML = '';

    if (toolId === 'enhancer') {
        openEnhancerTool();
        return;
    }
    else if (toolId === 'timetracker') {
        openTimeTrackerTool();
        return;
    }
    else if (toolId === 'irandev') {
        openIranDevTool();
        return;
    }
    else if (toolId === 'finance') {
        openFinanceTool();
        return;
    }
    else if (toolId === 'imgpalette') {
        openImgPaletteTool();
        return;
    }
    else if (toolId === 'vectorizer') {
        openVectorizerTool();
        return;
    }
    else if (toolId === 'bgremover') {
        openBgRemoverTool();
        return;
    }
    else if (toolId === 'tempmail') {
        title.innerHTML = '<i class="fa fa-envelope"></i> ایمیل موقت';
        body.innerHTML = `<div style="text-align:center;">
            <p>در حال ساخت ایمیل...</p>
        </div>`;

        // 1secmail.com's own server has been returning 403 (broken htaccess on
        // their end, not fixable client-side) - switched to guerrillamail.com's
        // API, which doesn't need any signup/account step either.
        fetch('https://api.guerrillamail.com/ajax.php?f=get_email_address')
            .then(r => r.json())
            .then(data => {
                const email = data.email_addr;
                const sidToken = data.sid_token;
                let seq = 0;
                body.innerHTML = `
                    <div style="text-align:center;">
                        <h3>آدرس ایمیل شما:</h3>
                        <input type="text" id="tempmail-email-input" value="${escapeHtml(email)}" readonly style="font-size:1.5rem; text-align:center; margin:1rem 0;">
                        <p style="color:var(--text-muted); font-size:0.9rem;">این صفحه هر ۵ ثانیه رفرش می‌شود تا پیام‌های جدید را دریافت کند (اعتبار: ۱ ساعت).</p>
                        <hr style="border-color:var(--glass-border); margin:1rem 0;">
                        <div id="mail-inbox">صندوق دریافت خالی است.</div>
                    </div>
                `;
                document.getElementById('tempmail-email-input').addEventListener('click', function() { this.select(); });

                tempMailInterval = setInterval(() => {
                    fetch(`https://api.guerrillamail.com/ajax.php?f=check_email&seq=${seq}&sid_token=${sidToken}`)
                        .then(r => r.json())
                        .then(res => {
                            const msgs = res && res.list;
                            if (msgs && msgs.length > 0) {
                                seq = Math.max(...msgs.map(m => m.mail_id));
                                let html = '<ul class="list">';
                                msgs.forEach(m => {
                                    html += `<li style="flex-direction:column; align-items:flex-start;">
                                        <strong>از: ${escapeHtml(m.mail_from)}</strong>
                                        <span>موضوع: ${escapeHtml(m.mail_subject)}</span>
                                        <span style="font-size:0.8rem; color:gray;">${escapeHtml(m.mail_date)}</span>
                                        <button class="btn-secondary" data-mail-summarize="${m.mail_id}" style="margin-top:0.4rem; font-size:0.75rem; padding:0.3rem 0.6rem;"><i class="fa fa-robot"></i> خلاصه با AI</button>
                                        <div data-mail-summary-for="${m.mail_id}" style="margin-top:0.4rem; font-size:0.82rem; white-space:pre-wrap;"></div>
                                    </li>`;
                                });
                                html += '</ul>';
                                document.getElementById('mail-inbox').innerHTML = html;

                                document.querySelectorAll('[data-mail-summarize]').forEach(btn => {
                                    btn.addEventListener('click', async function() {
                                        const mailId = this.dataset.mailSummarize;
                                        const outEl = document.querySelector(`[data-mail-summary-for="${mailId}"]`);
                                        outEl.innerHTML = '<i class="fa fa-spinner fa-spin"></i> در حال دریافت و خلاصه‌سازی...';
                                        try {
                                            const emailRes = await fetch(`https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${mailId}&sid_token=${sidToken}`);
                                            const emailData = await emailRes.json();
                                            const bodyHtml = emailData.mail_body || emailData.mail_excerpt || '';
                                            const bodyText = new DOMParser().parseFromString(bodyHtml, 'text/html').body.textContent || '';
                                            const aiRes = await callAI(`این ایمیل رو به فارسی خیلی خلاصه (حداکثر ۳-۴ خط) بگو موضوعش چیه و اگه اقدامی لازمه بگو:\n\nموضوع: ${emailData.mail_subject || ''}\nمتن:\n${bodyText.slice(0, 4000)}`);
                                            if (aiRes && aiRes.success && aiRes.answer) {
                                                outEl.textContent = aiRes.answer;
                                            } else {
                                                outEl.innerHTML = `<span style="color:var(--danger-color);">${escapeHtml((aiRes && aiRes.error) || 'خلاصه‌سازی ممکن نشد')}</span>`;
                                            }
                                        } catch (e) {
                                            outEl.innerHTML = '<span style="color:var(--danger-color);">دریافت متن ایمیل ممکن نشد</span>';
                                        }
                                    });
                                });
                            }
                        });
                }, 5000);
            })
            .catch(() => {
                body.innerHTML = '<p style="text-align:center;">ساخت ایمیل موقت ممکن نشد. سرویس guerrillamail.com شاید موقتاً در دسترس نیست.</p>';
            });
    }
    else if (toolId === 'squoosh') {
        title.innerHTML = '<i class="fa fa-image"></i> فشرده‌ساز Squoosh';
        body.innerHTML = `<iframe src="https://squoosh.app/" width="100%" height="600px" style="border:none; border-radius: 12px; background:white;"></iframe>`;
    }
    else if (toolId === 'json') {
        title.innerHTML = '<i class="fa fa-code"></i> فرمت‌کننده JSON';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; height: 500px; gap: 1rem;">
                <textarea id="json-input" placeholder="کد JSON درهم‌ریخته را اینجا پیست کنید..." style="height:50%; font-family:monospace; direction:ltr;"></textarea>
                <div style="display:flex; gap:0.6rem;">
                    <button class="btn-primary" id="format-json-btn" style="flex:1;">مرتب‌سازی (Format)</button>
                    <button class="btn-secondary" id="json-ai-fix-btn" style="flex:1;"><i class="fa fa-robot"></i> توضیح/اصلاح خطا با AI</button>
                </div>
                <textarea id="json-output" placeholder="خروجی مرتب شده..." readonly style="height:50%; font-family:monospace; direction:ltr; background:rgba(128,128,128,0.1);"></textarea>
            </div>
        `;
        let lastJsonError = '';
        document.getElementById('format-json-btn').addEventListener('click', function() {
            try {
                const input = document.getElementById('json-input').value;
                const parsed = JSON.parse(input);
                lastJsonError = '';
                document.getElementById('json-output').value = JSON.stringify(parsed, null, 4);
                document.getElementById('json-output').style.borderColor = "var(--glass-border)";
            } catch (e) {
                lastJsonError = e.message;
                document.getElementById('json-output').value = "خطا در سینتکس JSON!";
                document.getElementById('json-output').style.borderColor = "red";
            }
        });
        document.getElementById('json-ai-fix-btn').addEventListener('click', function() {
            const input = document.getElementById('json-input').value.trim();
            if (!input) return;
            const question = lastJsonError
                ? 'این کد JSON خطای سینتکسی داره، دقیقاً بگو مشکل کجاست و نسخه‌ی درست‌شده رو کامل بنویس.'
                : 'این کد JSON رو بررسی کن، اگه مشکلی داره بگو کجاست و نسخه‌ی درست رو بده، وگرنه به‌طور خلاصه بگو ساختارش چیه.';
            askAIWithContext(
                question,
                `کد JSON:\n${input}${lastJsonError ? `\n\nخطای پارسر: ${lastJsonError}` : ''}`,
                'بررسی/اصلاح JSON با AI'
            );
        });
    }
    else if (toolId === 'qr') {
        title.innerHTML = '<i class="fa fa-qrcode"></i> بارکدساز';

        const QR_FIELDS = {
            text: [{ id: 'qr-text', label: 'متن یا لینک', type: 'text', placeholder: 'https://... یا هر متنی' }],
            wifi: [
                { id: 'qr-wifi-ssid', label: 'نام شبکه (SSID)', type: 'text' },
                { id: 'qr-wifi-pass', label: 'رمز عبور', type: 'text' },
                { id: 'qr-wifi-enc', label: 'نوع رمزنگاری', type: 'select', options: [['WPA', 'WPA/WPA2'], ['WEP', 'WEP'], ['nopass', 'بدون رمز']] }
            ],
            phone: [{ id: 'qr-phone', label: 'شماره تلفن', type: 'text', placeholder: '09123456789' }],
            sms: [
                { id: 'qr-sms-number', label: 'شماره گیرنده', type: 'text', placeholder: '09123456789' },
                { id: 'qr-sms-text', label: 'متن پیامک', type: 'text' }
            ],
            email: [
                { id: 'qr-email-to', label: 'آدرس ایمیل', type: 'text', placeholder: 'name@example.com' },
                { id: 'qr-email-subject', label: 'موضوع', type: 'text' },
                { id: 'qr-email-body', label: 'متن پیام', type: 'text' }
            ],
            contact: [
                { id: 'qr-contact-name', label: 'نام و نام‌خانوادگی', type: 'text' },
                { id: 'qr-contact-phone', label: 'شماره تلفن', type: 'text' },
                { id: 'qr-contact-email', label: 'ایمیل', type: 'text' }
            ]
        };
        const QR_TYPE_LABELS = { text: 'متن / لینک', wifi: 'وای‌فای', phone: 'تلفن', sms: 'پیامک', email: 'ایمیل', contact: 'مخاطب' };

        function qrEscape(str) {
            return String(str || '').replace(/([\\;,:"])/g, '\\$1');
        }

        function buildQrData(type) {
            const val = (id) => (document.getElementById(id) || {}).value || '';
            if (type === 'wifi') {
                const enc = val('qr-wifi-enc') || 'WPA';
                if (enc === 'nopass') return `WIFI:T:nopass;S:${qrEscape(val('qr-wifi-ssid'))};;`;
                return `WIFI:T:${enc};S:${qrEscape(val('qr-wifi-ssid'))};P:${qrEscape(val('qr-wifi-pass'))};;`;
            }
            if (type === 'phone') return `tel:${val('qr-phone').trim()}`;
            if (type === 'sms') return `smsto:${val('qr-sms-number').trim()}:${val('qr-sms-text')}`;
            if (type === 'email') {
                const params = new URLSearchParams();
                if (val('qr-email-subject')) params.set('subject', val('qr-email-subject'));
                if (val('qr-email-body')) params.set('body', val('qr-email-body'));
                const qs = params.toString();
                return `mailto:${val('qr-email-to').trim()}${qs ? '?' + qs : ''}`;
            }
            if (type === 'contact') {
                return `BEGIN:VCARD\nVERSION:3.0\nFN:${val('qr-contact-name')}\nTEL:${val('qr-contact-phone')}\nEMAIL:${val('qr-contact-email')}\nEND:VCARD`;
            }
            return val('qr-text');
        }

        function renderQrFields(type) {
            const wrap = document.getElementById('qr-fields');
            wrap.innerHTML = QR_FIELDS[type].map(f => {
                if (f.type === 'select') {
                    return `<label style="display:block; margin-bottom:0.6rem; font-size:0.85rem; color:var(--text-muted);">${f.label}
                        <select id="${f.id}" style="width:100%; margin-top:4px; padding:0.5rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                            ${f.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
                        </select>
                    </label>`;
                }
                return `<label style="display:block; margin-bottom:0.6rem; font-size:0.85rem; color:var(--text-muted);">${f.label}
                    <input type="text" id="${f.id}" placeholder="${f.placeholder || ''}" style="width:100%; margin-top:4px; direction:ltr; text-align:left;">
                </label>`;
            }).join('');
            wrap.querySelectorAll('input, select').forEach(el => el.addEventListener('input', updateQr));
            wrap.querySelectorAll('select').forEach(el => el.addEventListener('change', updateQr));
        }

        function updateQr() {
            const type = document.querySelector('.qr-type-btn.active').dataset.qrtype;
            const data = buildQrData(type).trim();
            const output = document.getElementById('qr-output');
            output.innerHTML = data ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data)}" alt="QR Code">` : '';
        }

        body.innerHTML = `
            <div style="text-align:center; display:flex; flex-direction:column; align-items:center; gap: 1rem;">
                <div class="qr-type-tabs" id="qr-type-tabs">
                    ${Object.keys(QR_TYPE_LABELS).map((t, i) => `<span class="qr-type-btn${i === 0 ? ' active' : ''}" data-qrtype="${t}">${QR_TYPE_LABELS[t]}</span>`).join('')}
                </div>
                <div id="qr-fields" style="width:100%; max-width:320px; text-align:right;"></div>
                <div id="qr-output" style="margin-top: 0.5rem; padding: 1rem; background: white; border-radius: 12px; display:inline-block; min-height: 220px; min-width: 220px;"></div>
            </div>
        `;

        document.getElementById('qr-type-tabs').addEventListener('click', (e) => {
            const btn = e.target.closest('.qr-type-btn');
            if (!btn) return;
            document.querySelectorAll('.qr-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderQrFields(btn.dataset.qrtype);
            updateQr();
        });

        renderQrFields('text');
    }
    else if (toolId === 'color') {
        title.innerHTML = '<i class="fa fa-palette"></i> پالت رنگ و گرادیانت';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap: 1.5rem;">
                <div>
                    <p style="margin-bottom:0.5rem;">انتخاب رنگ و کپی کردن هکس:</p>
                    <div style="display:flex; gap:1rem; align-items:center;">
                        <input type="color" id="color-picker" style="width: 60px; height: 40px; cursor: pointer;">
                        <input type="text" id="color-hex" readonly style="width: 150px; direction: ltr; font-family: monospace;">
                        ${window.EyeDropper ? '<button class="btn-secondary" id="color-eyedropper-btn" title="چکاندن رنگ از هر جای صفحه"><i class="fa fa-eye-dropper"></i> چکاندن از صفحه</button>' : ''}
                    </div>
                </div>
                <hr style="border-color:var(--glass-border); width:100%;">
                <div>
                    <p style="margin-bottom:0.75rem;">تولیدکننده گرادیانت:</p>
                    <div style="display:flex; gap:1.5rem; align-items:center; flex-wrap:wrap; margin-bottom:1rem;">
                        <label>رنگ ۱ <input type="color" id="grad-c1" value="#0a84ff"></label>
                        <label>رنگ ۲ <input type="color" id="grad-c2" value="#ff2d55"></label>
                        <label>زاویه <input type="range" id="grad-angle" min="0" max="360" value="90"></label>
                    </div>
                    <div class="gradient-preview" id="gradient-preview"></div>
                    <input type="text" id="grad-code" readonly style="width:100%; margin-top:0.75rem; direction:ltr; font-family:monospace; font-size:0.85rem;">
                </div>
            </div>
        `;
        document.getElementById('color-hex').addEventListener('click', function() { this.select(); });
        document.getElementById('grad-code').addEventListener('click', function() { this.select(); });
        document.getElementById('color-picker').addEventListener('input', (e) => {
            document.getElementById('color-hex').value = e.target.value;
        });
        const eyedropperBtn = document.getElementById('color-eyedropper-btn');
        if (eyedropperBtn) {
            eyedropperBtn.addEventListener('click', async () => {
                try {
                    const result = await new window.EyeDropper().open();
                    document.getElementById('color-picker').value = result.sRGBHex;
                    document.getElementById('color-hex').value = result.sRGBHex;
                } catch (e) { /* user cancelled the pick - nothing to do */ }
            });
        }
        function updateGradient() {
            const c1 = document.getElementById('grad-c1').value;
            const c2 = document.getElementById('grad-c2').value;
            const angle = document.getElementById('grad-angle').value;
            const css = `linear-gradient(${angle}deg, ${c1}, ${c2})`;
            document.getElementById('gradient-preview').style.background = css;
            document.getElementById('grad-code').value = `background: ${css};`;
        }
        document.getElementById('grad-c1').addEventListener('input', updateGradient);
        document.getElementById('grad-c2').addEventListener('input', updateGradient);
        document.getElementById('grad-angle').addEventListener('input', updateGradient);
        updateGradient();
    }
    else if (toolId === 'newsdigest') {
        title.innerHTML = '<i class="fa fa-newspaper"></i> اخبار روز';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:1rem;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">آدرس فیدهای RSS (هر خط یکی)</label>
                    <textarea id="news-feeds-input" placeholder="https://example.com/feed" style="height:80px; direction:ltr; text-align:left; font-family:monospace; font-size:0.82rem;"></textarea>
                    <button class="btn-secondary" id="news-save-feeds-btn" style="margin-top:0.5rem;"><i class="fa fa-save"></i> ذخیره فیدها</button>
                </div>
                <div style="display:flex; gap:0.5rem;">
                    <button class="btn-primary" id="news-refresh-btn" style="flex:1;"><i class="fa fa-sync"></i> دریافت اخبار</button>
                    <button class="btn-secondary" id="news-ai-digest-btn" style="flex:1;"><i class="fa fa-robot"></i> خلاصه‌ی هوشمند با AI</button>
                </div>
                <div id="news-list" style="display:flex; flex-direction:column; gap:0.6rem; max-height:400px; overflow-y:auto;"></div>
            </div>
        `;
        let newsItems = [];

        (async function initFeeds() {
            const { newsFeeds } = await storageGet({ newsFeeds: [] });
            document.getElementById('news-feeds-input').value = (newsFeeds || []).join('\n');
        })();

        document.getElementById('news-save-feeds-btn').addEventListener('click', async () => {
            const urls = document.getElementById('news-feeds-input').value.split('\n').map(s => s.trim()).filter(Boolean);
            await storageSet({ newsFeeds: urls });
            await showAlert('فیدها ذخیره شد.', 'اخبار روز');
        });

        async function fetchFeed(url) {
            try {
                const res = await fetch(url);
                const xmlText = await res.text();
                const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
                let sourceTitle = '';
                const chTitle = doc.querySelector('channel > title') || doc.querySelector('feed > title');
                if (chTitle) sourceTitle = chTitle.textContent;
                if (!sourceTitle) { try { sourceTitle = new URL(url).hostname; } catch (e) { sourceTitle = url; } }
                const rawItems = [...doc.querySelectorAll('item'), ...doc.querySelectorAll('entry')].slice(0, 8);
                return rawItems.map(item => {
                    const title = (item.querySelector('title') || {}).textContent || '';
                    let link = (item.querySelector('link') || {}).textContent || '';
                    if (!link) {
                        const linkEl = item.querySelector('link[href]');
                        if (linkEl) link = linkEl.getAttribute('href');
                    }
                    const pubDate = (item.querySelector('pubDate') || item.querySelector('published') || item.querySelector('updated') || {}).textContent || '';
                    return { title, link, pubDate, source: sourceTitle };
                });
            } catch (e) {
                return [];
            }
        }

        document.getElementById('news-refresh-btn').addEventListener('click', async () => {
            const urls = document.getElementById('news-feeds-input').value.split('\n').map(s => s.trim()).filter(Boolean);
            if (urls.length === 0) { await showAlert('اول حداقل یه فید RSS اضافه کن.', 'اخبار روز'); return; }
            const listEl = document.getElementById('news-list');
            listEl.innerHTML = '<p class="text-muted" style="text-align:center;">در حال دریافت...</p>';
            const results = await Promise.all(urls.map(fetchFeed));
            newsItems = results.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
            if (newsItems.length === 0) {
                listEl.innerHTML = '<p class="text-muted" style="text-align:center;">خبری دریافت نشد. آدرس فیدها رو چک کن (یا سایت مقصد درخواست از مبدأ دیگر رو مسدود کرده).</p>';
                return;
            }
            listEl.innerHTML = newsItems.map(item => `
                <a href="${escapeHtml(item.link)}" target="_blank" style="display:block; padding:0.6rem; border-radius:8px; background:rgba(128,128,128,0.06); text-decoration:none; color:var(--text-color);">
                    <div style="font-size:0.88rem; font-weight:600;">${escapeHtml(item.title)}</div>
                    <div class="text-muted" style="font-size:0.72rem; margin-top:2px;">${escapeHtml(item.source)}</div>
                </a>
            `).join('');
        });

        document.getElementById('news-ai-digest-btn').addEventListener('click', async () => {
            if (newsItems.length === 0) { await showAlert('اول یه‌بار دکمه‌ی «دریافت اخبار» رو بزن.', 'اخبار روز'); return; }
            const listText = newsItems.slice(0, 30).map(i => `- [${i.source}] ${i.title}`).join('\n');
            askAIWithContext(
                'از بین این تیترهای خبری، مهم‌ترین‌هاشون رو انتخاب کن و برای هرکدوم یه خلاصه‌ی خیلی کوتاه (یک خط) به فارسی بده. اگه چندتا خبر درباره‌ی یه موضوع مشترک بودن، ترکیبشون کن.',
                `تیترهای امروز:\n${listText}`,
                'خلاصه‌ی هوشمند اخبار با AI'
            );
        });
    }
    else if (toolId === 'lorem') {
        title.innerHTML = '<i class="fa fa-align-left"></i> تولیدکننده لورم ایپسوم';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap: 1rem;">
                <p>متن آزمایشی برای کپی کردن:</p>
                <textarea id="lorem-textarea" readonly style="height: 200px; font-size:1rem; line-height:1.6;">لورم ایپسوم متن ساختگی با تولید سادگی نامفهوم از صنعت چاپ و با استفاده از طراحان گرافیک است. چاپگرها و متون بلکه روزنامه و مجله در ستون و سطرآنچنان که لازم است و برای شرایط فعلی تکنولوژی مورد نیاز و کاربردهای متنوع با هدف بهبود ابزارهای کاربردی می باشد.</textarea>
            </div>
        `;
        document.getElementById('lorem-textarea').addEventListener('click', function() { this.select(); });
    }
    else if (toolId === 'fakedata') {
        title.innerHTML = '<i class="fa fa-user-secret"></i> تولیدکننده دیتای فیک';

        const fn = ["علی", "محمد", "سارا", "مریم", "رضا", "زهرا", "امیر", "فاطمه", "حسین", "زینب", "مهدی", "نرگس", "احمد", "لیلا", "حسن", "الناز", "کیانوش", "شیوا", "بهزاد", "پریسا", "آرش", "رویا", "کاوه", "مینا", "فرهاد", "یاسمن", "شاهین", "نازنین", "پویا", "ترانه"];
        const ln = ["احمدی", "رضایی", "محمدی", "حسینی", "کریمی", "موسوی", "جعفری", "حیدری", "نوری", "صادقی", "رحیمی", "قاسمی", "اکبری", "یوسفی", "عباسی", "طاهری", "شریفی", "کاظمی", "فتاحی", "مرادی", "ابراهیمی", "امینی", "رستمی", "ملکی", "فرجی", "نجفی", "صالحی", "باقری", "شکری", "زارعی"];
        const name = fn[Math.floor(Math.random() * fn.length)] + " " + ln[Math.floor(Math.random() * ln.length)];
        const phone = "09" + Math.floor(Math.random() * 900000000 + 100000000);

        const usFn = ["James", "Emma", "Michael", "Olivia", "Daniel", "Sophia", "David", "Isabella", "William", "Ava", "John", "Mia", "Robert", "Charlotte", "Joseph", "Amelia", "Thomas", "Harper", "Charles", "Evelyn", "Christopher", "Abigail", "Matthew", "Emily", "Anthony", "Elizabeth", "Mark", "Sofia", "Steven", "Victoria"];
        const usLn = ["Smith", "Johnson", "Williams", "Brown", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White", "Harris", "Clark", "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Hill", "Green"];
        const usName = usFn[Math.floor(Math.random() * usFn.length)] + " " + usLn[Math.floor(Math.random() * usLn.length)];
        const usAreaCode = Math.floor(Math.random() * 800) + 200;
        const usPhone = `(${usAreaCode}) ${Math.floor(Math.random() * 800) + 200}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

        // US SSN format (XXX-XX-XXXX) - random digits only, avoiding the
        // officially-reserved/invalid prefixes (000, 666, 900-999) so it at
        // least looks like a plausible fake, same spirit as the national ID below.
        function randomSsn() {
            let area;
            do { area = Math.floor(Math.random() * 899) + 1; } while (area === 666);
            const group = String(Math.floor(Math.random() * 99) + 1).padStart(2, '0');
            const serial = String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0');
            return `${String(area).padStart(3, '0')}-${group}-${serial}`;
        }

        // Random but checksum-VALID Iranian national ID - passes format validation
        // without being any real person's actual code (the checksum only narrows
        // down ~1/11th of combinations, same approach every fake-data generator uses).
        function randomNationalId() {
            let digits;
            do {
                digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
            } while (digits.every(d => d === digits[0]));
            const sum = digits.reduce((acc, d, i) => acc + d * (10 - i), 0);
            const rem = sum % 11;
            const check = rem < 2 ? rem : 11 - rem;
            return digits.join('') + check;
        }

        function luhnCheckDigit(numStr) {
            let sum = 0, alt = true;
            for (let i = numStr.length - 1; i >= 0; i--) {
                let n = parseInt(numStr[i], 10);
                if (alt) { n *= 2; if (n > 9) n -= 9; }
                sum += n;
                alt = !alt;
            }
            return (10 - (sum % 10)) % 10;
        }
        function randomCardNumber() {
            const bins = ['603799', '589210', '627412', '610433', '639607', '502229'];
            const bin = bins[Math.floor(Math.random() * bins.length)];
            let rest = '';
            for (let i = 0; i < 9; i++) rest += Math.floor(Math.random() * 10);
            const partial = bin + rest;
            const full = partial + luhnCheckDigit(partial);
            return full.match(/.{1,4}/g).join('-');
        }
        function randomUsCardNumber() {
            const bins = ['4539', '4916', '4024', '5412', '5425', '2223']; // Visa / Mastercard test-style prefixes
            const bin = bins[Math.floor(Math.random() * bins.length)];
            let rest = '';
            for (let i = 0; i < 11; i++) rest += Math.floor(Math.random() * 10);
            const partial = bin + rest;
            const full = partial + luhnCheckDigit(partial);
            return full.match(/.{1,4}/g).join('-');
        }

        function randomIranPostalCode() {
            let code = String(Math.floor(Math.random() * 9) + 1);
            for (let i = 0; i < 9; i++) code += Math.floor(Math.random() * 10);
            return code;
        }
        function randomUsZip() {
            return String(Math.floor(Math.random() * 90000) + 10000);
        }
        function randomIranAddress() {
            const cities = ['تهران', 'مشهد', 'اصفهان', 'شیراز', 'تبریز', 'کرج', 'اهواز', 'قم', 'کرمانشاه', 'رشت', 'یزد', 'اردبیل', 'بندرعباس', 'کرمان', 'ارومیه', 'زاهدان', 'همدان', 'ساری', 'قزوین', 'گرگان'];
            const streets = ['خیابان ولیعصر', 'خیابان انقلاب', 'خیابان آزادی', 'بلوار کشاورز', 'خیابان طالقانی', 'خیابان فردوسی', 'بلوار فرحزادی', 'خیابان شریعتی', 'بلوار میرداماد', 'خیابان جمهوری', 'خیابان کریمخان', 'بلوار آفریقا', 'خیابان پاسداران', 'خیابان دماوند'];
            const city = cities[Math.floor(Math.random() * cities.length)];
            const street = streets[Math.floor(Math.random() * streets.length)];
            const alley = Math.floor(Math.random() * 40) + 1;
            const plaque = Math.floor(Math.random() * 300) + 1;
            const unit = Math.floor(Math.random() * 12) + 1;
            return `${city}، ${street}، کوچه ${alley}، پلاک ${plaque}، واحد ${unit}`;
        }

        function randomUsAddress() {
            const streets = ['Main St', 'Oak Ave', 'Maple Dr', 'Washington Blvd', 'Park Ave', '2nd St', 'Sunset Blvd', 'Elm St', 'Cedar Ln', 'Lake Dr', 'Highland Ave', 'River Rd', 'Pine St', 'Hill St'];
            const places = [['New York', 'NY'], ['Los Angeles', 'CA'], ['Chicago', 'IL'], ['Houston', 'TX'], ['Phoenix', 'AZ'], ['Seattle', 'WA'], ['Boston', 'MA'], ['Austin', 'TX'], ['Denver', 'CO'], ['Miami', 'FL'], ['Atlanta', 'GA'], ['Portland', 'OR'], ['Dallas', 'TX'], ['Detroit', 'MI'], ['Nashville', 'TN'], ['Minneapolis', 'MN'], ['San Diego', 'CA'], ['Orlando', 'FL'], ['Las Vegas', 'NV'], ['Baltimore', 'MD']];
            const num = Math.floor(Math.random() * 9000) + 100;
            const street = streets[Math.floor(Math.random() * streets.length)];
            const [city, state] = places[Math.floor(Math.random() * places.length)];
            const zip = String(Math.floor(Math.random() * 90000) + 10000);
            return `${num} ${street}, ${city}, ${state} ${zip}`;
        }

        const fields = [
            { id: 'fakedata-name', label: 'نام (ایران)', value: name, ltr: false },
            { id: 'fakedata-name-us', label: 'نام (آمریکا)', value: usName, ltr: true },
            { id: 'fakedata-phone', label: 'موبایل (ایران)', value: phone, ltr: true },
            { id: 'fakedata-phone-us', label: 'تلفن (آمریکا)', value: usPhone, ltr: true },
            { id: 'fakedata-nid', label: 'کد ملی (ایران)', value: randomNationalId(), ltr: true },
            { id: 'fakedata-ssn-us', label: 'SSN (آمریکا)', value: randomSsn(), ltr: true },
            { id: 'fakedata-card', label: 'شماره کارت (ایران)', value: randomCardNumber(), ltr: true },
            { id: 'fakedata-card-us', label: 'شماره کارت (آمریکا)', value: randomUsCardNumber(), ltr: true },
            { id: 'fakedata-postal', label: 'کد پستی (ایران)', value: randomIranPostalCode(), ltr: true },
            { id: 'fakedata-zip-us', label: 'ZIP Code (آمریکا)', value: randomUsZip(), ltr: true },
            { id: 'fakedata-addr-ir', label: 'آدرس (ایران)', value: randomIranAddress(), ltr: false },
            { id: 'fakedata-addr-us', label: 'آدرس (آمریکا)', value: randomUsAddress(), ltr: true }
        ];

        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap: 1rem; max-height:520px; overflow-y:auto; padding-left:4px;">
                ${fields.map(f => `
                    <div>
                        <label style="color:var(--text-muted); font-size:0.9rem;">${f.label}:</label>
                        <input type="text" id="${f.id}" value="${escapeHtml(f.value)}" readonly style="width:100%; margin-top:0.5rem; text-align:center; ${f.ltr ? 'direction:ltr; font-family:monospace;' : ''}">
                    </div>
                `).join('')}
                <p class="text-muted" style="font-size:0.72rem; margin:0;">این‌ها کاملاً تصادفی‌اند و برای تست فرم/UI هستند؛ کد ملی/SSN و شماره کارت‌ها فقط فرمت/چک‌سام معتبر دارند و به شخص یا حساب واقعی متصل نیستند.</p>
                <button class="btn-secondary" id="fakedata-regen-btn"><i class="fa fa-sync"></i> تولید مجدد</button>
            </div>
        `;
        fields.forEach(f => document.getElementById(f.id).addEventListener('click', function() { this.select(); }));
        document.getElementById('fakedata-regen-btn').addEventListener('click', () => openTool('fakedata'));
    }
    else if (toolId === 'jwt') {
        title.innerHTML = '<i class="fa fa-key"></i> دیکدر JWT';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; height: 500px; gap: 1rem;">
                <textarea id="jwt-input" placeholder="توکن JWT خود را اینجا پیست کنید..." style="height:30%; font-family:monospace; direction:ltr;"></textarea>
                <button class="btn-primary" id="decode-jwt-btn">دیکد کردن</button>
                <div style="display:flex; gap:1rem; height:70%;">
                    <textarea id="jwt-header" placeholder="Header..." readonly style="width:50%; font-family:monospace; direction:ltr; background:rgba(128,128,128,0.1);"></textarea>
                    <textarea id="jwt-payload" placeholder="Payload..." readonly style="width:50%; font-family:monospace; direction:ltr; background:rgba(128,128,128,0.1);"></textarea>
                </div>
            </div>
        `;
        document.getElementById('decode-jwt-btn').addEventListener('click', function() {
            try {
                const token = document.getElementById('jwt-input').value.split('.');
                const header = JSON.parse(atob(token[0]));
                const payload = JSON.parse(atob(token[1]));
                document.getElementById('jwt-header').value = JSON.stringify(header, null, 4);
                document.getElementById('jwt-payload').value = JSON.stringify(payload, null, 4);
            } catch (e) {
                document.getElementById('jwt-payload').value = "توکن نامعتبر است!";
            }
        });
    }
    else if (toolId === 'contrast') {
        title.innerHTML = '<i class="fa fa-adjust"></i> بررسی کنتراست رنگ (WCAG)';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; gap: 2rem;">
                <div style="display:flex; gap: 2rem;">
                    <label>رنگ پس‌زمینه: <input type="color" id="bg-color" value="#ffffff"></label>
                    <label>رنگ متن: <input type="color" id="text-color" value="#000000"></label>
                </div>
                <div id="contrast-preview" style="width: 100%; height: 100px; display:flex; justify-content:center; align-items:center; font-size:2rem; font-weight:bold; border-radius:12px; background:#ffffff; color:#000000;">متن آزمایشی (Sample Text)</div>
                <div id="contrast-result" style="font-size:1.5rem;">Ratio: 21.00 (قبول ✅)</div>
            </div>
        `;
        function checkContrast() {
            function getLuminance(hex) {
                const rgb = [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
                const a = rgb.map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
                return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
            }
            const bg = document.getElementById('bg-color').value;
            const text = document.getElementById('text-color').value;

            document.getElementById('contrast-preview').style.background = bg;
            document.getElementById('contrast-preview').style.color = text;

            const l1 = getLuminance(bg);
            const l2 = getLuminance(text);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

            const result = document.getElementById('contrast-result');
            if (ratio >= 4.5) {
                result.innerHTML = `Ratio: ${ratio.toFixed(2)} (استاندارد AA را پاس می‌کند ✅)`;
                result.style.color = "lightgreen";
            } else {
                result.innerHTML = `Ratio: ${ratio.toFixed(2)} (خوانایی پایین است ❌)`;
                result.style.color = "salmon";
            }
        }
        document.getElementById('bg-color').addEventListener('input', checkContrast);
        document.getElementById('text-color').addEventListener('input', checkContrast);
    }
    else if (toolId === 'seo') {
        title.innerHTML = '<i class="fa fa-tachometer-alt"></i> بررسی سئو و سرعت صفحه';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:1rem;">
                <div style="display:flex; gap:0.5rem;">
                    <input type="url" id="seo-url-input" placeholder="https://example.com" style="flex:1; direction:ltr; padding:0.6rem; border-radius:10px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08);">
                    <button class="btn-primary" id="run-seo-check-btn">بررسی</button>
                </div>
                <div id="seo-result" class="text-muted" style="font-size:0.85rem;">آدرس یک صفحه وب را وارد کنید. (فقط از داخل اکستنشن نصب‌شده کار می‌کند؛ در پیش‌نمایش مرورگر معمولی به دلیل CORS ممکن است شکست بخورد.)</div>

                <hr style="border-color:var(--glass-border); margin:0.25rem 0;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem; flex-wrap:wrap;">
                    <span style="font-size:0.82rem; color:var(--text-muted);">بررسی عمیق‌تر با Lighthouse واقعی گوگل (کندتر ولی خیلی دقیق‌تر)</span>
                    <button class="btn-secondary" id="run-lighthouse-btn"><i class="fa fa-rocket"></i> اجرای Lighthouse</button>
                </div>
                <div id="lighthouse-result"></div>
            </div>
        `;
        document.getElementById('run-seo-check-btn').addEventListener('click', async function() {
            let url = document.getElementById('seo-url-input').value.trim();
            if (!url) return;
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
            const resultEl = document.getElementById('seo-result');
            resultEl.textContent = 'در حال بررسی...';
            const start = performance.now();
            try {
                const res = await fetch(url);
                const elapsed = Math.round(performance.now() - start);
                const html = await res.text();
                const sizeKb = (new Blob([html]).size / 1024).toFixed(1);
                const doc = new DOMParser().parseFromString(html, 'text/html');

                const titleTag = (doc.querySelector('title') || {}).textContent?.trim() || '';
                const metaDescEl = doc.querySelector('meta[name="description"]');
                const metaDesc = metaDescEl ? metaDescEl.getAttribute('content') || '' : '';
                const viewport = !!doc.querySelector('meta[name="viewport"]');
                const h1Count = doc.querySelectorAll('h1').length;
                const imgs = doc.querySelectorAll('img');
                const imgsNoAlt = Array.from(imgs).filter(i => !i.getAttribute('alt')).length;

                const row = (label, value, status) => `
                    <div class="seo-result-row">
                        <span>${label}</span>
                        <span>${value} <span class="seo-badge ${status}">${status === 'ok' ? 'خوب' : status === 'warn' ? 'قابل بهبود' : 'مشکل‌دار'}</span></span>
                    </div>`;

                resultEl.innerHTML = `
                    ${row('زمان پاسخ', elapsed + ' ms', elapsed < 600 ? 'ok' : elapsed < 1500 ? 'warn' : 'bad')}
                    ${row('حجم HTML', sizeKb + ' KB', sizeKb < 100 ? 'ok' : sizeKb < 300 ? 'warn' : 'bad')}
                    ${row('عنوان صفحه', titleTag ? (titleTag.length + ' کاراکتر') : 'وجود ندارد', titleTag && titleTag.length <= 60 ? 'ok' : titleTag ? 'warn' : 'bad')}
                    ${row('توضیحات متا', metaDesc ? (metaDesc.length + ' کاراکتر') : 'وجود ندارد', metaDesc ? 'ok' : 'bad')}
                    ${row('متا Viewport', viewport ? 'موجود' : 'وجود ندارد', viewport ? 'ok' : 'bad')}
                    ${row('تعداد H1', h1Count, h1Count === 1 ? 'ok' : 'warn')}
                    ${row('تصاویر بدون alt', imgsNoAlt + ' از ' + imgs.length, imgsNoAlt === 0 ? 'ok' : 'warn')}
                `;
            } catch (e) {
                resultEl.textContent = 'دریافت این آدرس ممکن نشد (احتمالاً سایت مقصد درخواست از مبدأ دیگر را مسدود کرده است).';
            }
        });

        document.getElementById('run-lighthouse-btn').addEventListener('click', async function() {
            let url = document.getElementById('seo-url-input').value.trim();
            if (!url) { await showAlert('اول یک آدرس وارد کنید.'); return; }
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
            const lhResult = document.getElementById('lighthouse-result');
            lhResult.innerHTML = '<p class="text-muted" style="font-size:0.85rem; margin-top:0.75rem;">در حال اجرای Lighthouse روی سرورهای گوگل... معمولاً ۱۵ تا ۴۵ ثانیه طول می‌کشد.</p>';

            try {
                // PageSpeed Insights runs real Lighthouse server-side and returns the
                // full report as JSON - this is the only way to get Lighthouse data
                // into an extension, since Chrome doesn't expose its DevTools panel
                // to extensions directly. Keyless requests share a small daily quota;
                // set CONFIG.PAGESPEED_API_KEY (free from Google Cloud Console) for a
                // much higher one if this starts hitting quota errors.
                const keyParam = CONFIG.PAGESPEED_API_KEY ? `&key=${encodeURIComponent(CONFIG.PAGESPEED_API_KEY)}` : '';
                const categoryParams = ['performance', 'seo', 'accessibility', 'best-practices'].map(c => `category=${c}`).join('&');
                const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&${categoryParams}${keyParam}`;
                const res = await fetch(apiUrl);
                const data = await res.json();
                if (data.error) throw new Error(data.error.message || 'خطای ناشناخته');

                const cats = data.lighthouseResult.categories;
                const scoreColor = (score) => score >= 0.9 ? 'var(--success-color)' : score >= 0.5 ? '#ff9f0a' : 'var(--danger-color)';
                const scoreCircle = (label, cat) => {
                    if (!cat || cat.score === null) return '';
                    const pct = Math.round(cat.score * 100);
                    return `
                        <div style="text-align:center;">
                            <div style="width:60px; height:60px; border-radius:50%; border:4px solid ${scoreColor(cat.score)}; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:1.05rem;">${pct}</div>
                            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:6px;">${label}</div>
                        </div>
                    `;
                };

                const audits = data.lighthouseResult.audits;
                const opportunities = Object.values(audits)
                    .filter(a => a.score !== null && a.score < 0.9 && a.title && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'notApplicable')
                    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
                    .slice(0, 6);

                lhResult.innerHTML = `
                    <div style="display:flex; justify-content:space-around; margin:1rem 0; flex-wrap:wrap; gap:0.75rem;">
                        ${scoreCircle('عملکرد', cats.performance)}
                        ${scoreCircle('سئو', cats.seo)}
                        ${scoreCircle('دسترسی‌پذیری', cats.accessibility)}
                        ${scoreCircle('بهترین شیوه‌ها', cats['best-practices'])}
                    </div>
                    ${opportunities.length ? `
                        <h4 style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.5rem;">مهم‌ترین مواردی که باید بهتر بشن:</h4>
                        <ul style="font-size:0.82rem; padding-inline-start:1.2rem; display:flex; flex-direction:column; gap:4px;">
                            ${opportunities.map(a => `<li>${escapeHtml(a.title)}</li>`).join('')}
                        </ul>
                        <button class="btn-secondary" id="seo-ai-suggest-btn" style="margin-top:0.75rem; width:100%;"><i class="fa fa-robot"></i> اولویت‌بندی اقدامات با AI</button>
                    ` : '<p class="text-muted" style="font-size:0.85rem;">مورد قابل‌توجهی برای بهبود پیدا نشد 👌</p>'}
                `;

                if (opportunities.length) {
                    document.getElementById('seo-ai-suggest-btn').addEventListener('click', () => {
                        const scorePct = (c) => c && c.score !== null ? Math.round(c.score * 100) : '—';
                        const scoresSummary = `عملکرد: ${scorePct(cats.performance)}, سئو: ${scorePct(cats.seo)}, دسترسی‌پذیری: ${scorePct(cats.accessibility)}, بهترین شیوه‌ها: ${scorePct(cats['best-practices'])}`;
                        const issuesList = opportunities.map(a => `- ${a.title}`).join('\n');
                        askAIWithContext(
                            'بر اساس این نتایج Lighthouse، مهم‌ترین اقدامات رو به ترتیب اولویت و با یک توضیح کوتاه عملی برای هرکدوم به فارسی لیست کن.',
                            `آدرس بررسی‌شده: ${url}\nامتیازها (از ۱۰۰): ${scoresSummary}\nمواردی که Lighthouse مشکل‌دار تشخیص داده:\n${issuesList}`,
                            'اولویت‌بندی سئو با AI'
                        );
                    });
                }
            } catch (e) {
                lhResult.innerHTML = `<p style="color:var(--danger-color); font-size:0.85rem; margin-top:0.75rem;">اجرای Lighthouse ممکن نشد: ${escapeHtml(e.message || 'خطای شبکه')}. سهمیه‌ی رایگان بدون کلید API محدوده؛ اگه مدام این خطا میاد، یک کلید رایگان از Google Cloud Console بگیرید (فعال‌سازی PageSpeed Insights API) و توی <code>extension/js/config.js</code> به‌عنوان <code>PAGESPEED_API_KEY</code> بذارید.</p>`;
            }
        });
    }
    else if (toolId === 'article') {
        title.innerHTML = '<i class="fa fa-robot"></i> ربات مقاله‌نویس هوش مصنوعی';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:0.9rem;">
                <p class="text-muted" style="font-size:0.78rem; margin:0;">مستقیم به پروکسی محلی چند-مدلی خودت (روی ۱۲۷.۰.۰.۱:۸۰۴۵) وصل می‌شه - نیازی به اجرای دستی هیچ سروری نیست.</p>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">موضوع مقاله</label>
                    <textarea id="article-topic" placeholder="مثلاً: ۷ نکته برای سئوی سریع‌تر سایت" style="width:100%; min-height:70px; padding:0.6rem; border-radius:10px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); resize:vertical;"></textarea>
                </div>
                <div style="display:flex; gap:0.75rem; flex-wrap:wrap;">
                    <div style="flex:1; min-width:160px;">
                        <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">لحن</label>
                        <select id="article-tone" style="width:100%; padding:0.6rem; border-radius:10px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                            <option value="رسمی و تخصصی">رسمی و تخصصی</option>
                            <option value="دوستانه و ساده">دوستانه و ساده</option>
                            <option value="متقاعدکننده و فروش‌محور">متقاعدکننده و فروش‌محور</option>
                        </select>
                    </div>
                    <div style="flex:1; min-width:160px;">
                        <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">مدل (روی پروکسی محلی)</label>
                        <div style="display:flex; gap:0.4rem;">
                            <input type="text" id="article-model" value="gemini-3.8-flash-high" style="flex:1; padding:0.6rem; border-radius:10px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left;">
                            <button class="icon-btn" id="article-fetch-models-btn" title="دریافت لیست مدل‌های موجود روی پروکسی"><i class="fa fa-sync-alt"></i></button>
                        </div>
                        <div id="article-models-list" style="display:none; flex-wrap:wrap; gap:0.35rem; margin-top:0.5rem;"></div>
                    </div>
                </div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">کلمات کلیدی هدف (اختیاری)</label>
                    <input type="text" id="article-keywords" placeholder="کلمه۱، کلمه۲، ..." style="width:100%; padding:0.6rem; border-radius:10px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                </div>
                <button class="btn-primary" id="article-generate-btn"><i class="fa fa-magic"></i> تولید مقاله کامل (سئو-محور)</button>
                <div id="article-progress-log" style="display:none; font-size:0.8rem; color:var(--text-muted); max-height:140px; overflow-y:auto; background:rgba(128,128,128,0.06); border-radius:10px; padding:0.6rem;"></div>
                <div id="article-result-wrap" style="display:none;">
                    <div class="qr-type-tabs" id="article-result-tabs">
                        <span class="qr-type-btn active" data-article-view="markdown">Markdown</span>
                        <span class="qr-type-btn" data-article-view="html">WordPress HTML</span>
                    </div>
                    <textarea id="article-result-output" readonly style="width:100%; height:320px; font-family:monospace; direction:ltr; text-align:left; margin-top:0.6rem; padding:0.6rem; border-radius:10px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);"></textarea>
                    <div style="display:flex; gap:0.6rem; margin-top:0.6rem;">
                        <button class="btn-secondary" id="article-copy-btn" style="flex:1;"><i class="fa fa-copy"></i> کپی</button>
                        <button class="btn-secondary" id="article-download-btn" style="flex:1;"><i class="fa fa-download"></i> دانلود فایل</button>
                    </div>
                    <div style="margin-top:1rem; border-top:1px solid var(--glass-border); padding-top:1rem;">
                        <h4 style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.6rem;">انتشار مستقیم در وردپرس</h4>
                        <p class="text-muted" style="font-size:0.76rem; margin:0 0 0.6rem;">با «Application Password» وردپرس (نه رمز اصلی حسابت - از وردپرس ۵.۶ به بعد از پروفایل کاربری‌ات قابل‌ساختنه). اگه سایتت درخواست‌های بیرونی رو مسدود کرده باشه (CORS)، این بخش کار نمی‌کنه.</p>
                        <input type="url" id="article-wp-site" placeholder="https://yoursite.com" style="width:100%; margin-bottom:0.5rem; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left;">
                        <div style="display:flex; gap:0.5rem; margin-bottom:0.5rem;">
                            <input type="text" id="article-wp-username" placeholder="یوزرنیم وردپرس" style="flex:1; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left;">
                            <input type="password" id="article-wp-apppass" placeholder="Application Password" style="flex:1; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left;">
                        </div>
                        <div style="display:flex; gap:0.5rem;">
                            <button class="btn-secondary" id="article-wp-publish-draft-btn" style="flex:1;"><i class="fa fa-file"></i> ذخیره پیش‌نویس</button>
                            <button class="btn-primary" id="article-wp-publish-btn" style="flex:1;"><i class="fa fa-globe"></i> انتشار مستقیم</button>
                        </div>
                        <p id="article-wp-status" style="font-size:0.8rem; margin-top:0.5rem; display:none;"></p>
                    </div>
                </div>
            </div>
        `;

        (async () => {
            const { wpSite, wpUsername } = await storageGet({ wpSite: '', wpUsername: '' });
            document.getElementById('article-wp-site').value = wpSite;
            document.getElementById('article-wp-username').value = wpUsername;
        })();

        let lastOutlineData = null;
        let lastMarkdown = '';
        let lastHtml = '';

        function proxyUrl(path) {
            return `http://${CONFIG.LOCAL_LLM_PROXY.host}:${CONFIG.LOCAL_LLM_PROXY.port}${path}`;
        }

        async function callLocalLLM(messages, model) {
            let res;
            try {
                res = await fetch(proxyUrl('/v1/chat/completions'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${CONFIG.LOCAL_LLM_PROXY.apiKey}`
                    },
                    body: JSON.stringify({ model: model || 'gemini-3.8-flash-high', messages })
                });
            } catch (e) {
                throw new Error('اتصال به پروکسی محلی (127.0.0.1:8045) برقرار نشد - مطمئن شو روی سیستمت روشنه.');
            }
            if (!res.ok) throw new Error(`خطای پروکسی محلی: HTTP ${res.status}`);
            const data = await res.json();
            return data.choices[0].message.content;
        }

        // Ports server.js's polishPersianTypography() verbatim: fixes missing ZWNJ
        // (نیم‌فاصله) around می‌/نمی‌ prefixes, ها/های/تر/ترین suffixes, and Persian
        // punctuation spacing - things AI output commonly gets wrong.
        function articlePolishPersianTypography(text) {
            if (!text || typeof text !== 'string') return text;
            let t = text;
            t = t.replace(/(^|[\s\(\[\"«'”])(می|نمی)\s+([؀-ۿ])/g, '$1$2‌$3');
            t = t.replace(/([؀-ۿ])\s+(ها|های|هایی|هایمان|هایتان|هایشان)([\s.,،؛!?؟\)«\"'”\]]|$)/g, '$1‌$2$3');
            t = t.replace(/([؀-ۿ])\s+(تر|ترین)([\s.,،؛!?؟\)«\"'”\]]|$)/g, '$1‌$2$3');
            t = t.replace(/\s+([،؛؟!:])/g, '$1');
            t = t.replace(/([،؛؟!:«])([^\s\d])/g, '$1 $2');
            return t;
        }

        function articleGetOutlinePrompt(topic, tone, targetKeywords) {
            let keywordsInstruction = '';
            if (targetKeywords && targetKeywords.trim()) {
                keywordsInstruction = `
- Mandatory Target Keywords to plan for: "${targetKeywords.trim()}".
- CRITICAL ANTI-KEYWORD-STUFFING: Strategically distribute these keywords across the most logical headings and meta elements without forcing them. Never produce word soup (سوپ کلمات).`;
            }
            return `You are a World-Class SEO Strategist & Subject Matter Authority.
Your goal is to engineer an EEAT-compliant, Information-Gain driven pillar outline for the topic: "${topic}".

Core Pillars to incorporate:
1. "Information Gain" (Google Patent Standard): Focus on original angles, real-world case scenarios, practical pitfalls, and actionable frameworks that competitors in search results miss.
2. "GEO & Answer-First (BLUF)": Plan sections so each directly answers the user query upfront before diving into deep analysis.
3. "Semantic SEO & Entities": Map topical depth covering core entities, related concepts, and search intent.
4. "Tone": The article tone MUST BE: ${tone}.
${keywordsInstruction}

CRITICAL REQUIREMENTS:
1. You MUST generate AT LEAST 10 highly relevant, non-repetitive headings in the "outline" array.
2. Provide "key_takeaways" in the root JSON: An array of 4 to 5 high-impact bullet points summarizing the core actionable insights of this entire guide (for Google AI Overviews and the TL;DR / Key Takeaways box).
3. Provide a "main_image_prompt" in English for Midjourney representing the photorealistic cover image.
4. Provide an "image_prompt" (English Midjourney prompt) for EXACTLY 3 of the items in the outline array.
5. Provide 4-6 authoritative FAQ items in "faq" array.

Output STRICTLY in valid JSON format ONLY:
{
  "meta_title": "High CTR, SEO-optimized title (50-60 chars)",
  "meta_description": "Compelling meta description with clear search intent & value prop (140-160 chars)",
  "keywords": "Comma-separated semantic entities & LSI keywords",
  "intent": "Search intent description (Informational, Commercial, etc.)",
  "key_takeaways": [
    "Key takeaway point 1 (crisp & actionable)",
    "Key takeaway point 2 (crisp & actionable)",
    "Key takeaway point 3 (crisp & actionable)",
    "Key takeaway point 4 (crisp & actionable)"
  ],
  "main_image_prompt": "Midjourney photorealistic prompt for the cover image",
  "outline": [
    {
       "heading": "Heading Title",
       "short_description": "Specific value angle & unique information nugget for this section",
       "image_prompt": "Midjourney prompt for this section (only for 3 headings)"
    }
  ],
  "faq": [
    {"q": "Frequently asked question", "a": "Direct, authoritative, concise answer"}
  ]
}`;
        }

        // Ports server.js's convertMarkdownToWordPressHTML() verbatim: key-takeaways
        // box, table of contents, JSON-LD Article+FAQPage schema, then markdown ->
        // WordPress block HTML (headings/bold/callouts/tables/lists).
        function articleConvertMarkdownToWpHtml(markdown, outlineData) {
            let keyTakeawaysHtml = '';
            if (outlineData && outlineData.key_takeaways && outlineData.key_takeaways.length > 0) {
                keyTakeawaysHtml = `<div class="wp-block-group key-takeaways-box" style="background: linear-gradient(135deg, #f0fdf4 0%, #e0f2fe 100%); border: 1.5px solid #0284c7; border-radius: 12px; padding: 20px; margin: 25px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">\n` +
                    `<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">\n` +
                    `  <span style="font-size: 1.4rem;">💡</span>\n` +
                    `  <h3 style="margin: 0; color: #0369a1; font-size: 1.2rem; font-weight: bold;">نکات کلیدی مقاله در یک نگاه (Key Takeaways)</h3>\n` +
                    `</div>\n<ul style="margin: 0; padding-right: 22px; line-height: 2; color: #0f172a;">\n` +
                    outlineData.key_takeaways.map(kt => `  <li><strong>${articlePolishPersianTypography(kt)}</strong></li>`).join('\n') +
                    `\n</ul>\n</div>\n\n`;
            }

            let tocHtml = `<div class="wp-block-table-of-contents" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin: 25px 0;">\n<h3 style="margin-top: 0; font-size: 1.15rem; color: #1e293b; display: flex; align-items: center; gap: 6px;">📋 <span>فهرست مطالب این مقاله</span></h3>\n<ul style="margin-bottom: 0; line-height: 2; padding-right: 20px;">\n`;
            if (outlineData && outlineData.outline) {
                outlineData.outline.forEach((item, idx) => {
                    const anchorId = `section-${idx + 1}`;
                    tocHtml += `  <li><a href="#${anchorId}" style="text-decoration: none; color: #2563eb;">${item.heading || `بخش ${idx + 1}`}</a></li>\n`;
                });
                if (outlineData.faq && outlineData.faq.length > 0) {
                    tocHtml += `  <li><a href="#section-faq" style="text-decoration: none; color: #2563eb;">سوالات متداول (FAQ)</a></li>\n`;
                }
            }
            tocHtml += `</ul>\n</div>\n\n`;

            let schemaJson = {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "Article",
                        "headline": outlineData?.meta_title || "",
                        "description": outlineData?.meta_description || "",
                        "keywords": outlineData?.keywords || "",
                        "inLanguage": "fa-IR",
                        "author": { "@type": "Organization", "name": "تیم تحریریه و کارشناسان محتوا" }
                    }
                ]
            };
            if (outlineData && outlineData.faq && outlineData.faq.length > 0) {
                const faqEntities = outlineData.faq.map(f => ({
                    "@type": "Question", "name": f.q,
                    "acceptedAnswer": { "@type": "Answer", "text": f.a }
                }));
                schemaJson["@graph"].push({ "@type": "FAQPage", "mainEntity": faqEntities });
            }
            const schemaMarkupHtml = `\n\n<!-- Google JSON-LD Schema Markup (EEAT & FAQ Rich Snippets) -->\n<script type="application/ld+json">\n${JSON.stringify(schemaJson, null, 2)}\n</script>\n`;

            let html = markdown;
            let headingIndex = 0;
            html = html.replace(/^##\s+(.+)$/gm, (match, titleTxt) => {
                headingIndex++;
                const id = titleTxt.includes('سوالات متداول') ? 'section-faq' : `section-${headingIndex}`;
                return `<h2 id="${id}">${titleTxt.trim()}</h2>`;
            });
            html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
            html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
            html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
            html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

            html = html.replace(/^>\s+(.+)$/gm, (match, quoteContent) => {
                if (quoteContent.includes('پرامپت عکس') || quoteContent.includes('پرامپت تصویر')) {
                    return `<div class="wp-block-quote ai-image-callout" style="background: #f1f5f9; border-right: 4px solid #3b82f6; padding: 12px 16px; margin: 15px 0; border-radius: 4px; font-size: 0.95rem;">${quoteContent}</div>`;
                }
                if (quoteContent.includes('نکته') || quoteContent.includes('💡')) {
                    return `<div class="wp-block-quote tip-callout" style="background: #f0fdf4; border-right: 4px solid #16a34a; padding: 12px 16px; margin: 15px 0; border-radius: 4px; font-size: 0.95rem;">${quoteContent}</div>`;
                }
                if (quoteContent.includes('هشدار') || quoteContent.includes('⚠️')) {
                    return `<div class="wp-block-quote warning-callout" style="background: #fffbeb; border-right: 4px solid #d97706; padding: 12px 16px; margin: 15px 0; border-radius: 4px; font-size: 0.95rem;">${quoteContent}</div>`;
                }
                return `<blockquote><p>${quoteContent}</p></blockquote>`;
            });

            html = html.replace(/(?:(?:\|.+?\|\r?\n)+)/g, (tableMatch) => {
                const rows = tableMatch.trim().split('\n');
                if (rows.length < 2) return tableMatch;
                let tableHtml = '<figure class="wp-block-table"><table class="has-fixed-layout">\n';
                let inHeader = true;
                rows.forEach((row, rIdx) => {
                    if (row.includes('---')) { inHeader = false; return; }
                    const cells = row.split('|').filter((_, cIdx, arr) => cIdx > 0 && cIdx < arr.length - 1);
                    if (rIdx === 0) {
                        tableHtml += '  <thead>\n    <tr>\n';
                        cells.forEach(c => tableHtml += `      <th>${c.trim()}</th>\n`);
                        tableHtml += '    </tr>\n  </thead>\n  <tbody>\n';
                    } else {
                        tableHtml += '    <tr>\n';
                        cells.forEach(c => tableHtml += `      <td>${c.trim()}</td>\n`);
                        tableHtml += '    </tr>\n';
                    }
                });
                tableHtml += '  </tbody>\n</table></figure>\n';
                return tableHtml;
            });

            const lines = html.split('\n');
            let inList = false;
            let formattedLines = [];
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
                    if (!inList) { formattedLines.push('<ul>'); inList = true; }
                    formattedLines.push(`  <li>${trimmed.substring(2)}</li>`);
                } else {
                    if (inList) { formattedLines.push('</ul>'); inList = false; }
                    if (trimmed.startsWith('<h1') || trimmed.startsWith('<h2') || trimmed.startsWith('<h3') ||
                        trimmed.startsWith('<blockquote') || trimmed.startsWith('<div') || trimmed.startsWith('</div') ||
                        trimmed.startsWith('<figure') || trimmed.startsWith('</figure') || trimmed.startsWith('<table') ||
                        trimmed.startsWith('</table') || trimmed === '---' || trimmed === '') {
                        if (trimmed === '---') formattedLines.push('<hr />');
                        else formattedLines.push(trimmed);
                    } else {
                        formattedLines.push(`<p>${trimmed}</p>`);
                    }
                }
            });
            if (inList) formattedLines.push('</ul>');

            let finalHtml = formattedLines.join('\n');
            const firstHrIndex = finalHtml.indexOf('<hr />');
            if (firstHrIndex !== -1) {
                finalHtml = finalHtml.slice(0, firstHrIndex + 6) + '\n\n' + keyTakeawaysHtml + tocHtml + finalHtml.slice(firstHrIndex + 6);
            } else {
                finalHtml = keyTakeawaysHtml + tocHtml + finalHtml;
            }
            finalHtml += schemaMarkupHtml;
            return articlePolishPersianTypography(finalHtml);
        }

        function articleLog(message, isError) {
            const logEl = document.getElementById('article-progress-log');
            const line = document.createElement('div');
            if (isError) line.style.color = 'var(--danger-color)';
            line.textContent = message;
            logEl.appendChild(line);
            logEl.scrollTop = logEl.scrollHeight;
        }

        document.getElementById('article-fetch-models-btn').addEventListener('click', async function() {
            const listEl = document.getElementById('article-models-list');
            try {
                const res = await fetch(proxyUrl('/v1/models'), {
                    headers: { 'Authorization': `Bearer ${CONFIG.LOCAL_LLM_PROXY.apiKey}` }
                });
                if (!res.ok) throw new Error('bad status');
                const data = await res.json();
                const ids = (data && Array.isArray(data.data)) ? data.data.map(m => m.id) : [];
                if (ids.length === 0) throw new Error('no models');
                listEl.style.display = 'flex';
                listEl.innerHTML = ids.map(id => `<span class="qr-type-btn" data-model-pick="${escapeHtml(id)}" style="font-size:0.72rem;">${escapeHtml(id)}</span>`).join('');
                listEl.querySelectorAll('[data-model-pick]').forEach(el => {
                    el.addEventListener('click', () => { document.getElementById('article-model').value = el.dataset.modelPick; });
                });
            } catch (e) {
                await showAlert('اتصال به پروکسی محلی روی 127.0.0.1:8045 برقرار نشد. مطمئن شو پروکسی روی سیستمت روشنه.', 'خطا');
            }
        });

        document.getElementById('article-generate-btn').addEventListener('click', async function() {
            const topic = document.getElementById('article-topic').value.trim();
            if (!topic) return;
            const tone = document.getElementById('article-tone').value;
            const targetKeywords = document.getElementById('article-keywords').value.trim();
            const model = document.getElementById('article-model').value.trim() || 'gemini-3.8-flash-high';

            const btn = this;
            btn.disabled = true;
            const logEl = document.getElementById('article-progress-log');
            logEl.style.display = 'block';
            logEl.innerHTML = '';
            document.getElementById('article-result-wrap').style.display = 'none';

            try {
                articleLog('🚀 موضوع: ' + topic);
                if (targetKeywords) articleLog('🎯 کلمات کلیدی هدف: ' + targetKeywords);
                articleLog('⏳ در حال تولید ساختار هوشمند (حداقل ۱۰ تیتر) و پرامپت‌های عکس...');

                const outlinePrompt = articleGetOutlinePrompt(topic, tone, targetKeywords);
                const outlineRaw = await callLocalLLM([{ role: 'user', content: outlinePrompt }], model);
                let cleanJsonStr = outlineRaw.replace(/```json/gi, '').replace(/```/gi, '').trim();
                const firstBrace = cleanJsonStr.indexOf('{');
                const lastBrace = cleanJsonStr.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1) cleanJsonStr = cleanJsonStr.substring(firstBrace, lastBrace + 1);
                const outlineData = JSON.parse(cleanJsonStr);
                outlineData.targetKeywords = targetKeywords;
                lastOutlineData = outlineData;
                articleLog('✅ ساختار سئو شده با موفقیت ایجاد شد.');

                const headingsCount = outlineData.outline ? outlineData.outline.length : 0;
                if (headingsCount === 0) {
                    articleLog('❌ هیچ تیتری در اوت‌لاین یافت نشد.', true);
                    btn.disabled = false;
                    return;
                }

                let finalArticleText = `# ${outlineData.meta_title}\n\n`;
                finalArticleText += `> نوشته شده توسط: **هوش مصنوعی (${model})**\n\n`;
                if (outlineData.main_image_prompt) {
                    finalArticleText += `--- \n**📸 پرامپت عکس اصلی (کاور):**\n\`${outlineData.main_image_prompt}\`\n---\n\n`;
                }
                finalArticleText += `**متا دیسکریپشن:** ${outlineData.meta_description}\n\n`;
                finalArticleText += `**کلمات کلیدی سئو:** ${outlineData.keywords}\n\n`;
                if (targetKeywords) finalArticleText += `**کلمات کلیدی اجباری (Must-include):** ${targetKeywords}\n\n`;
                if (outlineData.intent) finalArticleText += `**هدف کاربر (Intent):** ${outlineData.intent}\n\n`;
                if (outlineData.key_takeaways && outlineData.key_takeaways.length > 0) {
                    finalArticleText += `> ### 💡 نکات کلیدی مقاله در یک نگاه (Key Takeaways)\n`;
                    outlineData.key_takeaways.forEach(kt => { finalArticleText += `> * **${kt}**\n`; });
                    finalArticleText += `\n`;
                }
                finalArticleText += `---\n\n`;

                for (let i = 0; i < outlineData.outline.length; i++) {
                    const item = outlineData.outline[i];
                    let headingTitle = item.heading;
                    const isAutoFill = (!headingTitle || headingTitle.trim() === '' || headingTitle.includes('تیتر جدید'));
                    articleLog(isAutoFill
                        ? `⏳ در حال شناسایی هوشمند تیتر خالی ${i + 1} و نگارش آن...`
                        : `⏳ در حال نگارش تخصصی تیتر ${i + 1} از ${headingsCount}: «${headingTitle}»...`);

                    let keywordInstruction = '';
                    if (targetKeywords) {
                        keywordInstruction = `
- Mandatory Target Keywords: "${targetKeywords}"
- ANTI-KEYWORD-STUFFING: Blend relevant target keywords seamlessly ONLY when naturally appropriate. DO NOT force keywords or create word soup (سوپ کلمات). Maintain natural Persian fluency above all.`;
                    }

                    const sectionPrompt = `You are a World-Class SEO Writer and Industry Expert writing for an authoritative publication.
Your task is to write a deeply researched, high-ranking section for the article titled "${outlineData.meta_title}".

Specific Section Context:
- Target Heading: "${headingTitle}"
- Objective & Unique Angle: "${item.short_description || 'In-depth practical analysis'}"
- Article Context & Intent: ${outlineData.intent || 'Comprehensive authoritative guide'}
- Tone: ${tone}
${keywordInstruction}

${isAutoFill ? `CRITICAL INSTRUCTION: The user left this heading blank. You MUST analyze the overall article context, invent a highly relevant, missing SEO heading, and write the content for it. Put the generated heading at the very top of your response using Markdown H2 (## Heading Title).` : ''}

MANDATORY SEO WRITING FRAMEWORK (Google Search Central Standards):
1. 🎯 ANSWER-FIRST PRINCIPLE (BLUF for Google AI Overviews & GEO):
   - In the FIRST 2-3 sentences of this section, provide a crystal-clear, direct answer, definition, or primary takeaway. DO NOT begin with generic filler or preamble phrases ("در دنیای مدرن امروز...", "همانطور که می‌دانید..."). Get straight to the point.
2. 💎 INFORMATION GAIN & E-E-A-T EXCELLENCE:
   - Provide original depth and practical substance that generic AI articles lack.
   - Include real-world examples, pro-tips ("> **💡 نکته کلیدی تجربی:** ..."), and common mistakes/pitfalls to avoid ("> **⚠️ خطای رایج:** ...").
   - Use structured formatting: markdown tables (| Column 1 | Column 2 |), numbered action steps, and bullet points wherever comparisons or processes are explained.
3. 🧠 SEMANTIC SEO & NATURAL ENTITIES:
   - Naturally integrate related semantic concepts and entities.
   - Strictly follow anti-keyword stuffing rules (NO repetitive stuffing, NO word soup).
4. 🚫 SCOPE & FORMAT:
   - Write ONLY the content for this specific heading. Do NOT write an introduction or conclusion for the whole article.
   - Output ONLY the markdown content in native, fluent Persian (Farsi).`;

                    try {
                        const sectionContent = await callLocalLLM([{ role: 'user', content: sectionPrompt }], model);
                        let cleanedContent = sectionContent.trim();
                        if (isAutoFill) {
                            finalArticleText += `${cleanedContent}\n\n`;
                        } else {
                            if (cleanedContent.startsWith('# ') || cleanedContent.startsWith('## ') || cleanedContent.startsWith('### ')) {
                                const firstLineBreak = cleanedContent.indexOf('\n');
                                if (firstLineBreak !== -1) cleanedContent = cleanedContent.substring(firstLineBreak).trim();
                            }
                            finalArticleText += `## ${headingTitle}\n\n`;
                            finalArticleText += `${cleanedContent}\n\n`;
                        }
                        if (item.image_prompt) {
                            finalArticleText += `\n> **🖼️ پرامپت عکس پیشنهادی برای این بخش:**\n> \`${item.image_prompt}\`\n\n`;
                        }
                        articleLog(`✅ بخش مربوط به تیتر ${i + 1} نگارش شد.`);
                    } catch (err) {
                        articleLog(`⚠️ خطا در تولید تیتر ${i + 1}: ${err.message}`, true);
                    }
                }

                if (outlineData.faq && outlineData.faq.length > 0) {
                    articleLog('⏳ در حال اضافه کردن سوالات متداول...');
                    finalArticleText += `## سوالات متداول (FAQ)\n\n`;
                    outlineData.faq.forEach(faq => { finalArticleText += `**${faq.q}**\n${faq.a}\n\n`; });
                }

                finalArticleText = articlePolishPersianTypography(finalArticleText);
                articleLog('💾 در حال تبدیل به فرمت وردپرس...');
                const wordpressHtml = articleConvertMarkdownToWpHtml(finalArticleText, outlineData);

                lastMarkdown = finalArticleText;
                lastHtml = wordpressHtml;

                articleLog('✅ مقاله آماده شد.');
                document.getElementById('article-result-wrap').style.display = 'block';
                document.querySelectorAll('#article-result-tabs .qr-type-btn').forEach(b => b.classList.toggle('active', b.dataset.articleView === 'markdown'));
                document.getElementById('article-result-output').value = finalArticleText;
            } catch (error) {
                articleLog('❌ خطای پیش‌بینی‌نشده: ' + error.message, true);
            }
            btn.disabled = false;
        });

        document.querySelectorAll('#article-result-tabs .qr-type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#article-result-tabs .qr-type-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('article-result-output').value = btn.dataset.articleView === 'html' ? lastHtml : lastMarkdown;
            });
        });

        document.getElementById('article-copy-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(document.getElementById('article-result-output').value).catch(() => {});
        });

        document.getElementById('article-download-btn').addEventListener('click', () => {
            const activeBtn = document.querySelector('#article-result-tabs .qr-type-btn.active');
            const activeView = activeBtn ? activeBtn.dataset.articleView : 'markdown';
            const content = activeView === 'html' ? lastHtml : lastMarkdown;
            const ext = activeView === 'html' ? 'html' : 'md';
            const safeTitle = ((lastOutlineData && lastOutlineData.meta_title) || 'article').replace(/[\\/:*?"<>|]/g, '').substring(0, 50);
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `article_${Date.now()}_${safeTitle}.${ext}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        });

        async function publishToWordPress(status) {
            const site = document.getElementById('article-wp-site').value.trim().replace(/\/$/, '');
            const username = document.getElementById('article-wp-username').value.trim();
            const appPass = document.getElementById('article-wp-apppass').value;
            const statusEl = document.getElementById('article-wp-status');
            statusEl.style.display = 'block';
            if (!site || !username || !appPass) {
                statusEl.innerHTML = '<span style="color:var(--danger-color);">آدرس سایت، یوزرنیم و Application Password الزامی هستن.</span>';
                return;
            }
            if (!lastOutlineData || !lastHtml) {
                statusEl.innerHTML = '<span style="color:var(--danger-color);">اول یه مقاله تولید کن.</span>';
                return;
            }
            await storageSet({ wpSite: site, wpUsername: username });
            statusEl.innerHTML = '<i class="fa fa-spinner fa-spin"></i> در حال ارسال به وردپرس...';
            try {
                const res = await fetch(`${site}/wp-json/wp/v2/posts`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Basic ' + btoa(username + ':' + appPass)
                    },
                    body: JSON.stringify({
                        title: lastOutlineData.meta_title || 'مقاله‌ی جدید',
                        content: lastHtml,
                        status: status
                    })
                });
                if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}));
                    throw new Error(errBody.message || `HTTP ${res.status}`);
                }
                const data = await res.json();
                statusEl.innerHTML = `<span style="color:var(--success-color);">✅ با موفقیت ${status === 'publish' ? 'منتشر' : 'به‌عنوان پیش‌نویس ذخیره'} شد. <a href="${escapeHtml(data.link || '#')}" target="_blank" style="color:var(--primary-color);">مشاهده</a></span>`;
            } catch (e) {
                statusEl.innerHTML = `<span style="color:var(--danger-color);">❌ ${escapeHtml(e.message || String(e))} (ممکنه سایتت درخواست‌های بیرونی رو مسدود کرده باشه - CORS)</span>`;
            }
        }
        document.getElementById('article-wp-publish-draft-btn').addEventListener('click', () => publishToWordPress('draft'));
        document.getElementById('article-wp-publish-btn').addEventListener('click', () => publishToWordPress('publish'));
    }
    else if (toolId === 'reaction') {
        title.innerHTML = '<i class="fa fa-bolt"></i> بازی سرعت واکنش';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; gap:1rem;">
                <p class="text-muted" style="font-size:0.85rem;">وقتی رنگ سبز شد، هر چه سریع‌تر کلیک کن!</p>
                <div class="reaction-box wait" id="reaction-box">برای شروع کلیک کن</div>
                <div id="reaction-result" style="font-size:1.1rem; font-weight:600;"></div>
            </div>
        `;
        document.getElementById('reaction-box').addEventListener('click', handleReactionClick);
        resetReactionGame();
    }
    else if (toolId === 'hafez') {
        title.innerHTML = '<i class="fa fa-feather"></i> فال حافظ';
        body.innerHTML = `
            <div style="text-align:center; padding:1rem 0;">
                <p class="text-muted" style="margin-bottom:1rem; font-size:0.82rem;">یک نیت کن و کلیک کن. (ممکنه اولین بار چند ثانیه طول بکشه)</p>
                <button class="btn-primary" id="hafez-fal-btn"><i class="fa fa-magic"></i> گرفتن فال</button>
                <div id="hafez-result" style="margin-top:1.5rem;"></div>
            </div>
        `;
        async function getFal() {
            const resultEl = document.getElementById('hafez-result');
            resultEl.innerHTML = '<p class="text-muted">در حال گرفتن فال...</p>';
            try {
                const res = await fetch('https://hafez-dxle.onrender.com/fal');
                if (!res.ok) throw new Error('bad status');
                const data = await res.json();
                resultEl.innerHTML = `
                    <h3 style="margin-bottom:0.75rem;">${escapeHtml(data.title)}</h3>
                    <p style="line-height:1.9; font-size:0.95rem;">${escapeHtml(data.interpreter)}</p>
                    <button class="btn-secondary" id="hafez-ai-interpret-btn" style="margin-top:1rem;"><i class="fa fa-robot"></i> تفسیر امروزی‌تر با AI</button>
                    <div id="hafez-ai-output" style="margin-top:1rem; text-align:right; line-height:1.9; font-size:0.9rem; white-space:pre-wrap;"></div>
                `;
                document.getElementById('hafez-ai-interpret-btn').addEventListener('click', async function() {
                    const outEl = document.getElementById('hafez-ai-output');
                    outEl.innerHTML = '<span class="text-muted"><i class="fa fa-spinner fa-spin"></i> در حال تفسیر...</span>';
                    const aiRes = await callAI(`این غزل حافظ و تفسیر سنتی‌اش رو بخون و یه تفسیر امروزی‌تر، کاربردی‌تر و کوتاه برای زندگی روزمره بهم بده:\n\nعنوان: ${data.title}\nتفسیر سنتی: ${data.interpreter}`);
                    if (aiRes && aiRes.success && aiRes.answer) {
                        outEl.textContent = aiRes.answer;
                    } else {
                        outEl.innerHTML = `<span style="color:var(--danger-color);">${escapeHtml((aiRes && aiRes.error) || 'خطا در تفسیر')}</span>`;
                    }
                });
            } catch (e) {
                resultEl.innerHTML = '<p class="text-muted">گرفتن فال ممکن نشد؛ سرویس شاید موقتاً در خواب باشه، دوباره امتحان کن.</p>';
            }
        }
        document.getElementById('hafez-fal-btn').addEventListener('click', getFal);
    }
    else if (toolId === 'movie') {
        openMovieTrackerTool();
        return;
    }
    else if (toolId === 'ledger') {
        openFinanceTrackerTool();
        return;
    }
    else if (toolId === 'myip') {
        title.innerHTML = '<i class="fa fa-network-wired"></i> آی‌پی عمومی من';
        body.innerHTML = `<div style="text-align:center; padding:2rem 0;">
            <div id="myip-result" class="text-muted">در حال دریافت...</div>
        </div>`;
        fetch('https://ip.dnslab.link/')
            .then(r => r.json())
            .then(data => {
                const ip = data.IPv4 && data.IPv4.Address;
                const resultEl = document.getElementById('myip-result');
                if (!ip) { resultEl.textContent = 'دریافت آی‌پی ممکن نشد.'; return; }
                resultEl.innerHTML = `
                    <div id="myip-value" style="font-size:2rem; font-family:monospace; direction:ltr; cursor:pointer;">${escapeHtml(ip)}</div>
                    <p class="text-muted" style="margin-top:0.5rem; font-size:0.8rem;">برای کپی کلیک کن</p>
                `;
                document.getElementById('myip-value').addEventListener('click', function() {
                    navigator.clipboard.writeText(ip).catch(() => {});
                    const note = this.nextElementSibling;
                    const prevText = note.textContent;
                    note.textContent = 'کپی شد! ✅';
                    setTimeout(() => { note.textContent = prevText; }, 1500);
                });
            })
            .catch(() => { document.getElementById('myip-result').textContent = 'دریافت آی‌پی ممکن نشد.'; });
    }

    overlay.classList.add('active');
};

// --- Reaction Game ---
let reactionState = 'idle'; // idle | waiting | ready

function resetReactionGame() {
    reactionState = 'idle';
    const box = document.getElementById('reaction-box');
    if (!box) return;
    box.className = 'reaction-box';
    box.textContent = 'برای شروع کلیک کن';
    const resultEl = document.getElementById('reaction-result');
    if (resultEl) resultEl.textContent = '';
}

function handleReactionClick() {
    const box = document.getElementById('reaction-box');
    const resultEl = document.getElementById('reaction-result');

    if (reactionState === 'idle') {
        reactionState = 'waiting';
        box.className = 'reaction-box wait';
        box.textContent = 'صبر کن...';
        resultEl.textContent = '';
        const delay = 1000 + Math.random() * 3000;
        reactionTimeout = setTimeout(() => {
            reactionState = 'ready';
            box.className = 'reaction-box go';
            box.textContent = 'همین حالا کلیک کن!';
            box.dataset.start = performance.now();
        }, delay);
    } else if (reactionState === 'waiting') {
        clearTimeout(reactionTimeout);
        reactionState = 'idle';
        box.className = 'reaction-box';
        box.textContent = 'زودتر از موعد کلیک کردی! دوباره امتحان کن';
        resultEl.textContent = '';
    } else if (reactionState === 'ready') {
        const elapsed = Math.round(performance.now() - parseFloat(box.dataset.start));
        resultEl.textContent = `زمان واکنش شما: ${elapsed} میلی‌ثانیه`;
        reactionState = 'idle';
        box.className = 'reaction-box';
        box.textContent = 'برای امتحان دوباره کلیک کن';
    }
}

window.closeModal = function() {
    clearInterval(tempMailInterval);
    clearTimeout(reactionTimeout);
    document.getElementById('modal-overlay').classList.remove('active');
    document.querySelector('#modal-overlay .modal-content').classList.remove('modal-fullscreen');
};

window.launchWorkspace = async function() {
    if (currentData && currentData.bookmarks && currentData.bookmarks.length > 0) {
        const links = currentCategoryId ? currentData.bookmarks.filter(b => b.category_id == currentCategoryId) : currentData.bookmarks;
        if (links.length > 0) {
            if (await showConfirm(`آیا مطمئن هستید که می‌خواهید ${links.length} تب جدید باز کنید؟`)) {
                links.forEach(b => window.open(b.url, '_blank'));
            }
        }
    }
};

let isSnippetMode = false;
window.toggleSnippetMode = function() {
    isSnippetMode = !isSnippetMode;
    const ta = document.getElementById('note-textarea');
    const pre = document.getElementById('snippet-preview');
    const code = document.getElementById('snippet-code');
    const btn = document.getElementById('snippet-toggle-btn');

    if (isSnippetMode) {
        pre.style.display = 'block';
        ta.style.display = 'none';
        code.textContent = ta.value;
        if (window.hljs) hljs.highlightElement(code);
        btn.innerHTML = '<i class="fa fa-pencil-alt"></i>';
        btn.title = "ویرایش";
    } else {
        pre.style.display = 'none';
        ta.style.display = 'block';
        btn.innerHTML = '<i class="fa fa-code"></i>';
        btn.title = "نمایش به عنوان قطعه‌کد (رنگ‌بندی)";
    }
};

window.toggleDeepFocus = function() {
    const isFocus = document.getElementById('deep-focus-toggle').checked;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        if (isFocus) {
            chrome.runtime.sendMessage({ action: "enable_focus" });
            document.getElementById('pomodoro-time').style.color = "var(--success-color)";
        } else {
            chrome.runtime.sendMessage({ action: "disable_focus" });
            document.getElementById('pomodoro-time').style.color = "";
        }
    }
};

let lastCpuInfo = null;
async function updateHardwareMonitor() {
    if (isDesktopApp()) {
        try {
            const stats = await window.__TAURI__.core.invoke('get_system_stats');
            const ramEl = document.getElementById('sys-ram');
            if (ramEl) {
                const percent = Math.round(stats.memory.percent);
                ramEl.textContent = `RAM: ${percent}%`;
                ramEl.style.color = percent > 80 ? 'var(--danger-color)' : '';
            }
            const cpuEl = document.getElementById('sys-cpu');
            if (cpuEl) {
                const percent = Math.round(stats.cpu.usage_percent);
                cpuEl.textContent = `CPU: ${percent}%`;
                cpuEl.style.color = percent > 80 ? 'var(--danger-color)' : '';
            }
        } catch (e) { /* ignore transient failures */ }
        return;
    }
    if (typeof chrome === 'undefined' || !chrome.system) return;

    if (chrome.system.memory) {
        chrome.system.memory.getInfo((info) => {
            const used = info.capacity - info.availableCapacity;
            const percent = Math.round((used / info.capacity) * 100);
            const ramEl = document.getElementById('sys-ram');
            if (ramEl) {
                ramEl.textContent = `RAM: ${percent}%`;
                ramEl.style.color = percent > 80 ? 'var(--danger-color)' : '';
            }
        });
    }
    if (chrome.system.cpu) {
        chrome.system.cpu.getInfo((info) => {
            let currentActive = 0;
            let currentTotal = 0;

            info.processors.forEach(proc => {
                currentActive += proc.usage.kernel + proc.usage.user;
                currentTotal += proc.usage.kernel + proc.usage.user + proc.usage.idle;
            });

            if (lastCpuInfo) {
                const activeDiff = currentActive - lastCpuInfo.active;
                const totalDiff = currentTotal - lastCpuInfo.total;
                const percent = totalDiff === 0 ? 0 : Math.round((activeDiff / totalDiff) * 100);
                const cpuEl = document.getElementById('sys-cpu');
                if (cpuEl) {
                    cpuEl.textContent = `CPU: ${percent}%`;
                    cpuEl.style.color = percent > 80 ? 'var(--danger-color)' : '';
                }
            }

            lastCpuInfo = { active: currentActive, total: currentTotal };
        });
    }
}
setInterval(updateHardwareMonitor, 2000);
setTimeout(updateHardwareMonitor, 500);

// --- Market Prices & Portfolio Tracker ---
let marketPrices = {};
let myAssets = {};

// Wallex's own public market API (no key needed) - fetched directly from the
// extension, independent of our PHP backend, so crypto prices show up even
// when the backend/host isn't set up yet.
async function fetchWallexPrices() {
    try {
        const res = await fetch('https://api.wallex.ir/v1/markets');
        if (!res.ok) throw new Error('bad status');
        const json = await res.json();
        const symbols = (json.result && json.result.symbols) || {};
        const priceOf = (sym) => {
            const s = symbols[sym];
            const p = s && s.stats && s.stats.lastPrice;
            return p ? Math.round(parseFloat(p)).toLocaleString('en-US') : null;
        };
        const out = {};
        const btc = priceOf('BTCTMN'); if (btc) out.bitcoin = btc;
        const eth = priceOf('ETHTMN'); if (eth) out.ethereum = eth;
        const usdt = priceOf('USDTTMN'); if (usdt) out.tether = usdt;
        return out;
    } catch (e) {
        return {};
    }
}

// Iran free-market dollar / gold / mesghal / coin prices.
// Primary: nerkh.jahankhahan.shop (keyless, refreshes every minute; asks for at
// most 1 request/minute per endpoint and credit to "Nerkhsanj").
// Fallback: iran-market (GitHub-hosted JSON, refreshes every 30 minutes).
// Fetched straight from the extension like Wallex, so it doesn't depend on our
// PHP host. Any price <= 0 is dropped instead of shown as "0" - the previous
// source (brsapi) started answering 200 OK with every price at zero.
const IRAN_MARKET_CACHE_TTL_MS = 90 * 1000;       // keeps us under nerkh's 1 req/min across tabs and project switches
const IRAN_MARKET_STALE_MAX_MS = 60 * 60 * 1000;  // if both sources fail, reuse the last good prices for up to an hour
const NERKH_KEY_MAP = {
    dollar: 'dollar', gold: 'gold_18', gold24: 'gold_24', mesghal: 'gold_mesghal',
    coin: 'coin_emami', bahar: 'coin_bahar', half: 'coin_nim', quarter: 'coin_rob', gram: 'coin_gerami'
};
const IRAN_MARKET_SYMBOL_MAP = {
    USD_IRR_FREE: 'dollar', GOLD_18K_IRR: 'gold_18', GOLD_24K_IRR: 'gold_24', GOLD_MESGHAL_IRR: 'gold_mesghal',
    COIN_EMAMI_IRR: 'coin_emami', COIN_BAHAR_IRR: 'coin_bahar', COIN_HALF_IRR: 'coin_nim',
    COIN_QUARTER_IRR: 'coin_rob', COIN_GRAMI_IRR: 'coin_gerami'
};
let iranMarketInFlight = null;

async function fetchJsonWithTimeout(url, ms = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error('bad status ' + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchIranMarketPricesFresh() {
    const isPrice = (n) => typeof n === 'number' && isFinite(n) && n > 0;
    const fmt = (n) => Math.round(n).toLocaleString('en-US');

    try {
        const json = await fetchJsonWithTimeout('https://nerkh.jahankhahan.shop/data/live.json');
        const rates = (json && json.rates) || {};
        const prices = {};
        for (const [src, dst] of Object.entries(NERKH_KEY_MAP)) {
            if (isPrice(Number(rates[src]))) prices[dst] = fmt(Number(rates[src]));
        }
        if (prices.dollar) return { prices, source: 'nerkh' };
    } catch (e) { /* fall through to the secondary source */ }

    try {
        const json = await fetchJsonWithTimeout('https://raw.githubusercontent.com/iran-market/iran-market.github.io/main/data/latest-toman.json', 15000);
        const prices = {};
        (function walk(x) {
            if (Array.isArray(x)) { x.forEach(walk); return; }
            if (!x || typeof x !== 'object') return;
            if (typeof x.symbol === 'string' && IRAN_MARKET_SYMBOL_MAP[x.symbol]) {
                const price = Number(x.price);
                if (isPrice(price) && x.stale !== true && x.currency === 'IRT') prices[IRAN_MARKET_SYMBOL_MAP[x.symbol]] = fmt(price);
                return;
            }
            Object.values(x).forEach(walk);
        })(json);
        if (prices.dollar) return { prices, source: 'iran-market' };
    } catch (e) { /* both sources failed */ }

    return null;
}

async function fetchIranMarketPrices() {
    const { iranMarketCache } = await storageGet({ iranMarketCache: null });
    const now = Date.now();
    if (iranMarketCache && now - iranMarketCache.ts < IRAN_MARKET_CACHE_TTL_MS) return iranMarketCache;

    if (!iranMarketInFlight) {
        iranMarketInFlight = fetchIranMarketPricesFresh().finally(() => { iranMarketInFlight = null; });
    }
    const fresh = await iranMarketInFlight;
    if (fresh) {
        const entry = { ts: Date.now(), prices: fresh.prices, source: fresh.source };
        storageSet({ iranMarketCache: entry });
        return entry;
    }
    if (iranMarketCache && now - iranMarketCache.ts < IRAN_MARKET_STALE_MAX_MS) return { ...iranMarketCache, stale: true };
    return null;
}

function renderMarketSourceNote(iranMarket) {
    const el = document.getElementById('market-prices-source');
    if (!el) return;
    if (!iranMarket) {
        el.textContent = 'قیمت دلار، طلا و سکه فعلاً در دسترس نیست.';
        return;
    }
    const time = new Date(iranMarket.ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    const sourceLabel = iranMarket.source === 'nerkh' ? 'Nerkhsanj' : 'iran-market';
    el.textContent = `منبع دلار/طلا/سکه: ${sourceLabel} • ${time}${iranMarket.stale ? ' (قدیمی - منبع در دسترس نیست)' : ''}`;
}

async function initMarketAndPortfolio() {
    if (currentData && currentData.assets) {
        myAssets = {};
        currentData.assets.forEach(a => {
            myAssets[a.asset_key] = parseFloat(a.amount);
        });
    }

    const [iranMarket, wallexPrices] = await Promise.all([
        fetchIranMarketPrices(),
        fetchWallexPrices()
    ]);

    marketPrices = { ...wallexPrices, ...(iranMarket ? iranMarket.prices : {}) };
    renderMarketSourceNote(iranMarket);

    if (Object.keys(marketPrices).length > 0) {
        renderMarketPrices();
        renderMyAssets();
    } else {
        const list = document.getElementById('market-prices-list');
        if (list) list.innerHTML = '<div class="text-muted">دریافت قیمت‌ها ممکن نشد.</div>';
    }
}

const assetNames = {
    'dollar': 'دلار',
    'bitcoin': 'بیت‌کوین',
    'ethereum': 'اتریوم',
    'tether': 'تتر',
    'gold_18': 'طلای ۱۸ عیار (هر گرم)',
    'gold_24': 'طلای ۲۴ عیار (هر گرم)',
    'gold_mesghal': 'مثقال طلا',
    'coin_emami': 'سکه امامی',
    'coin_bahar': 'سکه بهار آزادی',
    'coin_nim': 'نیم سکه',
    'coin_rob': 'ربع سکه',
    'coin_gerami': 'سکه گرمی'
};

function renderMarketPrices() {
    const list = document.getElementById('market-prices-list');
    list.innerHTML = '';

    for (const key of Object.keys(assetNames)) {
        const val = marketPrices[key];
        if (!val) continue;
        list.innerHTML += `
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--glass-border); padding-bottom:4px;">
                <span>${assetNames[key]}</span>
                <span style="font-weight:bold; color:var(--text-color); font-family:sans-serif;">${val}</span>
            </div>
        `;
    }
}

function parsePrice(str) {
    if (!str || str === 'نامشخص') return 0;
    return parseFloat(String(str).replace(/,/g, ''));
}

function renderMyAssets() {
    const list = document.getElementById('my-assets-list');
    list.innerHTML = '';

    let totalValue = 0;

    for (const [key, amount] of Object.entries(myAssets)) {
        if (amount > 0 && assetNames[key]) {
            const price = parsePrice(marketPrices[key]);
            const value = price * amount;
            totalValue += value;

            list.innerHTML += `
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--glass-border); padding-bottom:4px;">
                    <span>${amount} <small>${assetNames[key]}</small></span>
                    <span style="font-weight:bold; color:var(--text-color); font-family:sans-serif;">${value.toLocaleString()} <small>تومان</small></span>
                </div>
            `;
        }
    }

    if (list.innerHTML === '') {
        list.innerHTML = '<div class="text-muted">دارایی ثبت نشده است.</div>';
    }

    const totalText = totalValue.toLocaleString() + ' تومان';
    document.getElementById('total-net-worth').textContent = totalText;
    document.getElementById('portfolio-total').textContent = totalText;
}

window.editAssetsModal = function() {
    const overlay = document.getElementById('assets-modal-overlay');
    const body = document.getElementById('assets-modal-body');
    body.innerHTML = '';

    for (const [key, name] of Object.entries(assetNames)) {
        const currentAmount = myAssets[key] || 0;
        body.innerHTML += `
            <div style="display:flex; flex-direction:column; gap:5px;">
                <label style="font-size:0.9rem; color:var(--text-muted);">${name}</label>
                <input type="number" step="0.01" id="asset_input_${key}" value="${currentAmount}" style="padding:0.5rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08);">
            </div>
        `;
    }

    overlay.classList.add('active');
};

window.closeAssetsModal = function() {
    document.getElementById('assets-modal-overlay').classList.remove('active');
};

window.saveAssets = async function() {
    const payload = {};
    for (const key of Object.keys(assetNames)) {
        const val = document.getElementById(`asset_input_${key}`).value;
        payload[key] = parseFloat(val) || 0;
    }

    await apiCall('save_assets', 'POST', { assets: payload });

    myAssets = payload;
    renderMyAssets();
    closeAssetsModal();
};

// ==========================================================================
// NOTION-STYLE PROJECT WORKSPACE & KANBAN BOARD CONTROLLER
// ==========================================================================
let currentNotionView = 'board'; // 'board' | 'list'
let currentDrawerTaskId = null;
let currentDrawerTaskDraft = null;
let activeUptimeDomain = null;
let isAllTasksMode = false;
let allTasksList = [];

function findTaskById(taskId) {
    const pool = isAllTasksMode ? allTasksList : ((currentData && currentData.tasks) || []);
    return pool.find(t => String(t.id) === String(taskId));
}

async function refreshTasksView() {
    if (isAllTasksMode) {
        const res = await apiCall('get_all_tasks');
        allTasksList = (res && res.tasks) || [];
    } else {
        await fetchData();
    }
    renderNotionTasks();
}

window.openAllTasksView = async function() {
    isAllTasksMode = true;
    setDockActive(2);
    document.getElementById('main-dashboard-view').style.display = 'none';
    const notionView = document.getElementById('notion-workspace-view');
    notionView.style.display = 'flex';
    notionView.classList.add('all-tasks-mode');

    document.getElementById('notion-proj-title').textContent = 'همه‌ی تسک‌ها (همه‌ی پروژه‌ها)';
    const iconEl = document.getElementById('notion-proj-icon');
    iconEl.style.background = '#6366f1';
    iconEl.innerHTML = '<i class="fa fa-layer-group"></i>';

    document.getElementById('notion-proj-link').style.display = 'none';
    document.getElementById('notion-uptime-badge').style.display = 'none';
    document.getElementById('notion-ssl-badge').style.display = 'none';
    activeUptimeDomain = null;

    const res = await apiCall('get_all_tasks');
    allTasksList = (res && res.tasks) || [];
    renderNotionTasks();
};

function openNotionWorkspace(projectId) {
    const proj = (projectsCache || []).find(p => String(p.id) === String(projectId));
    if (!proj) return;

    isAllTasksMode = false;
    currentProjectId = Number(projectId);
    document.getElementById('main-dashboard-view').style.display = 'none';
    const notionView = document.getElementById('notion-workspace-view');
    notionView.style.display = 'flex';
    notionView.classList.remove('all-tasks-mode');

    // Update Header
    document.getElementById('notion-proj-title').textContent = proj.name;
    const iconEl = document.getElementById('notion-proj-icon');
    iconEl.style.background = proj.color || '#6366f1';
    iconEl.textContent = proj.name.substring(0, 1).toUpperCase();

    // Domain & Uptime
    const domainLink = document.getElementById('notion-proj-link');
    const domainSpan = document.getElementById('notion-proj-domain');
    const uptimeBadge = document.getElementById('notion-uptime-badge');
    const sslBadge = document.getElementById('notion-ssl-badge');

    if (proj.domain) {
        domainLink.style.display = 'inline-flex';
        domainLink.href = proj.domain.startsWith('http') ? proj.domain : 'https://' + proj.domain;
        domainSpan.textContent = proj.domain.replace(/^https?:\/\//, '');
        uptimeBadge.style.display = 'inline-flex';
        uptimeBadge.className = 'uptime-badge';
        uptimeBadge.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> بررسی وضعیت...';
        sslBadge.style.display = 'inline-flex';
        sslBadge.innerHTML = '<i class="fa fa-lock"></i> SSL: ...';
        activeUptimeDomain = proj.domain;
        checkProjectUptime(proj.domain);
    } else {
        activeUptimeDomain = null;
        domainLink.style.display = 'none';
        uptimeBadge.style.display = 'none';
        sslBadge.style.display = 'none';
    }

    // Render Tasks in Board
    renderNotionTasks();
    fetchData();
}

function closeNotionWorkspace() {
    activeUptimeDomain = null;
    isAllTasksMode = false;
    document.getElementById('notion-workspace-view').classList.remove('all-tasks-mode');
    document.getElementById('notion-workspace-view').style.display = 'none';
    document.getElementById('main-dashboard-view').style.display = 'block';
}

function switchNotionView(viewMode) {
    currentNotionView = viewMode;
    document.getElementById('view-board-btn').classList.toggle('active', viewMode === 'board');
    document.getElementById('view-list-btn').classList.toggle('active', viewMode === 'list');
    document.getElementById('notion-board-container').style.display = viewMode === 'board' ? 'grid' : 'none';
    document.getElementById('notion-list-container').style.display = viewMode === 'list' ? 'block' : 'none';
    renderNotionTasks();
}

function renderNotionTasks() {
    let tasks;
    if (isAllTasksMode) {
        tasks = allTasksList;
    } else {
        const allTasks = (currentData && currentData.tasks) || [];
        tasks = currentProjectId !== null ? allTasks.filter(t => String(t.project_id) === String(currentProjectId)) : allTasks;
    }

    if (currentNotionView === 'board') {
        renderNotionKanban(tasks);
    } else {
        renderNotionList(tasks);
    }
}

function renderNotionKanban(tasks) {
    const cols = {
        todo: document.getElementById('cards-todo'),
        doing: document.getElementById('cards-doing'),
        review: document.getElementById('cards-review'),
        done: document.getElementById('cards-done')
    };

    Object.values(cols).forEach(col => { if (col) col.innerHTML = ''; });
    const counts = { todo: 0, doing: 0, review: 0, done: 0 };

    tasks.forEach(t => {
        let status = t.status || (t.completed == 1 ? 'done' : 'todo');
        if (!cols[status]) status = 'todo';
        counts[status]++;

        // Subtasks count
        let subtasks = [];
        try {
            subtasks = typeof t.subtasks === 'string' ? JSON.parse(t.subtasks || '[]') : (t.subtasks || []);
        } catch (e) { subtasks = []; }
        const doneSubtasks = subtasks.filter(s => s.done).length;

        // Card HTML
        const card = document.createElement('div');
        card.className = 'kanban-card';
        card.draggable = true;
        card.dataset.taskId = t.id;

        const priority = t.priority || 'medium';
        const priorityClass = PRIORITY_LABELS[priority] ? priority : 'medium';

        let badgesHtml = '<span class="priority-pill ' + priorityClass + '">' + (PRIORITY_LABELS[priority] || escapeHtml(priority)) + '</span>';
        if (isAllTasksMode) {
            const projColor = t.project_color || '#94a3b8';
            const projLabel = t.project_name || 'فضای عمومی';
            badgesHtml += '<span class="project-pill" style="background:' + escapeHtml(projColor) + '22; color:' + escapeHtml(projColor) + ';"><i class="fa fa-briefcase"></i> ' + escapeHtml(projLabel) + '</span>';
        }
        if (subtasks.length > 0) {
            badgesHtml += '<span class="subtasks-pill"><i class="fa fa-list-check"></i> ' + doneSubtasks + '/' + subtasks.length + '</span>';
        }
        if (t.task_date) {
            badgesHtml += '<span class="date-pill"><i class="fa fa-calendar"></i> ' + escapeHtml(t.task_date) + '</span>';
        }
        if (t.tags) {
            t.tags.split(',').forEach(tag => {
                if (tag.trim()) badgesHtml += '<span class="subtasks-pill">#' + escapeHtml(tag.trim()) + '</span>';
            });
        }

        card.innerHTML = 
            '<div class="kanban-card-title">' + escapeHtml(t.content) + '</div>' +
            '<div class="kanban-card-badges">' + badgesHtml + '</div>';

        // Card Click opens Notion Drawer
        card.addEventListener('click', () => openTaskDrawer(t.id));

        // Drag & Drop
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', String(t.id));
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));

        if (cols[status]) cols[status].appendChild(card);
    });

    // Update Counts
    const cTodo = document.getElementById('count-todo');
    const cDoing = document.getElementById('count-doing');
    const cReview = document.getElementById('count-review');
    const cDone = document.getElementById('count-done');
    if (cTodo) cTodo.textContent = String(counts.todo);
    if (cDoing) cDoing.textContent = String(counts.doing);
    if (cReview) cReview.textContent = String(counts.review);
    if (cDone) cDone.textContent = String(counts.done);
}

function renderNotionList(tasks) {
    const container = document.getElementById('notion-list-items');
    if (!container) return;
    container.innerHTML = '';

    if (tasks.length === 0) {
        const emptyMsg = isAllTasksMode ? 'هیچ تسکی در هیچ‌کدام از پروژه‌ها ثبت نشده است.' : 'هیچ تسکی برای این پروژه ثبت نشده است.';
        container.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem;">' + emptyMsg + '</div>';
        return;
    }

    tasks.forEach(t => {
        const item = document.createElement('div');
        item.className = 'task-item';
        item.style.cursor = 'pointer';
        const priority = t.priority || 'medium';
        const priorityClass = PRIORITY_LABELS[priority] ? priority : 'medium';
        const projectPill = isAllTasksMode
            ? '<span class="project-pill" style="background:' + escapeHtml(t.project_color || '#94a3b8') + '22; color:' + escapeHtml(t.project_color || '#94a3b8') + ';"><i class="fa fa-briefcase"></i> ' + escapeHtml(t.project_name || 'فضای عمومی') + '</span>'
            : '';
        item.innerHTML =
            '<input type="checkbox" ' + (t.completed == 1 ? 'checked' : '') + ' style="cursor:pointer;">' +
            '<span class="task-text ' + (t.completed == 1 ? 'text-muted' : '') + '" style="' + (t.completed == 1 ? 'text-decoration:line-through;' : '') + '">' + escapeHtml(t.content) + '</span>' +
            projectPill +
            '<span class="priority-pill ' + priorityClass + '">' + (PRIORITY_LABELS[priority] || escapeHtml(priority)) + '</span>' +
            '<span class="uptime-badge">' + (STATUS_LABELS[t.status] || escapeHtml(t.status || 'todo')) + '</span>' +
            '<button class="icon-btn" style="width:26px; height:26px; font-size:0.7rem;" title="جزئیات"><i class="fa fa-sliders-h"></i></button>';

        item.querySelector('input[type="checkbox"]').addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleTask(t.id);
            await refreshTasksView();
        });

        item.addEventListener('click', () => openTaskDrawer(t.id));
        container.appendChild(item);
    });
}

// Drag & drop handlers for columns
function initKanbanDragAndDrop() {
    document.querySelectorAll('.kanban-column').forEach(col => {
        col.addEventListener('dragover', (e) => {
            e.preventDefault();
            col.classList.add('drag-over');
        });
        col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
        col.addEventListener('drop', async (e) => {
            e.preventDefault();
            col.classList.remove('drag-over');
            const taskId = e.dataTransfer.getData('text/plain');
            const targetStatus = col.dataset.status;
            if (taskId && targetStatus) {
                await moveTaskStatus(Number(taskId), targetStatus);
            }
        });
    });
}

async function moveTaskStatus(taskId, newStatus) {
    const task = findTaskById(taskId);
    if (!task) return;

    task.status = newStatus;
    task.completed = (newStatus === 'done') ? 1 : 0;
    renderNotionTasks();
    if (!isAllTasksMode && currentData && currentData.tasks) renderTasks(currentData.tasks);

    await apiCall('update_task_status', 'POST', { id: taskId, status: newStatus });
}

// ==========================================================================
// NOTION TASK DETAIL DRAWER CONTROLLER
// ==========================================================================
let drawerSubtasks = [];

function openTaskDrawer(taskId = null, defaultStatus = 'todo') {
    const overlay = document.getElementById('task-drawer-overlay');
    currentDrawerTaskId = taskId;

    const statusOptions = [
        { value: 'todo', label: '📋 در انتظار انجام (To Do)' },
        { value: 'doing', label: '⚡ در حال انجام (In Progress)' },
        { value: 'review', label: '👀 در حال بازبینی (In Review)' },
        { value: 'done', label: '✅ تکمیل شده (Done)' }
    ];
    const priorityOptions = [
        { value: 'low', label: '🟢 اولویت پایین' },
        { value: 'medium', label: '🔵 اولویت متوسط' },
        { value: 'high', label: '🟠 اولویت بالا' },
        { value: 'urgent', label: '🔴 فوری و حیاتی' }
    ];

    const projectOptions = [
        { value: '', label: '🌐 فضای عمومی' },
        ...(projectsCache || []).map(p => ({ value: String(p.id), label: p.name }))
    ];

    if (taskId) {
        const task = findTaskById(taskId);
        if (!task) return;
        currentDrawerTaskDraft = { ...task };

        document.getElementById('drawer-task-title').value = task.content || '';
        document.getElementById('drawer-task-date').value = task.task_date || '';
        document.getElementById('drawer-task-tags').value = task.tags || '';
        document.getElementById('drawer-task-links').value = task.links || '';
        document.getElementById('drawer-task-description').value = task.description || '';
        document.getElementById('drawer-date-badge').textContent = task.task_date || 'بدون تاریخ';

        try {
            drawerSubtasks = typeof task.subtasks === 'string' ? JSON.parse(task.subtasks || '[]') : (task.subtasks || []);
        } catch (e) { drawerSubtasks = []; }

        initDropdown(document.getElementById('drawer-status-select'), statusOptions, task.status || 'todo', (v) => { currentDrawerTaskDraft.status = v; });
        initDropdown(document.getElementById('drawer-priority-select'), priorityOptions, task.priority || 'medium', (v) => { currentDrawerTaskDraft.priority = v; });
        initDropdown(document.getElementById('drawer-project-select'), projectOptions, task.project_id ? String(task.project_id) : '', (v) => { currentDrawerTaskDraft.project_id = v ? Number(v) : null; });
    } else {
        currentDrawerTaskDraft = {
            content: '',
            status: defaultStatus,
            priority: 'medium',
            task_date: (typeof currentSelectedDate !== 'undefined' && currentSelectedDate) ? currentSelectedDate : getTodayJalaali(),
            tags: '',
            links: '',
            description: '',
            subtasks: [],
            project_id: isAllTasksMode ? null : currentProjectId
        };
        drawerSubtasks = [];
        document.getElementById('drawer-task-title').value = '';
        document.getElementById('drawer-task-date').value = currentDrawerTaskDraft.task_date;
        document.getElementById('drawer-task-tags').value = '';
        document.getElementById('drawer-task-links').value = '';
        document.getElementById('drawer-task-description').value = '';
        document.getElementById('drawer-date-badge').textContent = currentDrawerTaskDraft.task_date;

        initDropdown(document.getElementById('drawer-status-select'), statusOptions, defaultStatus, (v) => { currentDrawerTaskDraft.status = v; });
        initDropdown(document.getElementById('drawer-priority-select'), priorityOptions, 'medium', (v) => { currentDrawerTaskDraft.priority = v; });
        initDropdown(document.getElementById('drawer-project-select'), projectOptions, currentDrawerTaskDraft.project_id ? String(currentDrawerTaskDraft.project_id) : '', (v) => { currentDrawerTaskDraft.project_id = v ? Number(v) : null; });
    }

    renderDrawerSubtasks();
    overlay.classList.add('active');
    setTimeout(() => document.getElementById('drawer-task-title').focus(), 60);
}

function closeTaskDrawer() {
    document.getElementById('task-drawer-overlay').classList.remove('active');
    currentDrawerTaskId = null;
    currentDrawerTaskDraft = null;
}

function renderDrawerSubtasks() {
    const list = document.getElementById('drawer-subtasks-list');
    list.innerHTML = '';

    drawerSubtasks.forEach((sub, idx) => {
        const item = document.createElement('div');
        item.className = 'subtask-item ' + (sub.done ? 'done' : '');
        item.innerHTML = 
            '<input type="checkbox" ' + (sub.done ? 'checked' : '') + ' style="cursor:pointer;">' +
            '<span>' + escapeHtml(sub.text) + '</span>' +
            '<i class="fa fa-times subtask-del-btn" title="حذف ساب‌تسک"></i>';

        item.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
            drawerSubtasks[idx].done = e.target.checked;
            renderDrawerSubtasks();
        });

        item.querySelector('.subtask-del-btn').addEventListener('click', () => {
            drawerSubtasks.splice(idx, 1);
            renderDrawerSubtasks();
        });

        list.appendChild(item);
    });

    updateSubtasksProgressUI();
}

function updateSubtasksProgressUI() {
    const fill = document.getElementById('subtasks-progress-fill');
    const num = document.getElementById('subtasks-progress-num');
    if (!fill || !num) return;

    if (drawerSubtasks.length === 0) {
        fill.style.width = '0%';
        num.textContent = '۰٪';
        return;
    }
    const doneCount = drawerSubtasks.filter(s => s.done).length;
    const pct = Math.round((doneCount / drawerSubtasks.length) * 100);
    fill.style.width = pct + '%';
    num.textContent = pct + '٪ (' + doneCount + ' از ' + drawerSubtasks.length + ')';
}

function drawerAddSubtask() {
    const input = document.getElementById('drawer-new-subtask-input');
    const text = input.value.trim();
    if (!text) return;
    drawerSubtasks.push({ id: Date.now(), text, done: false });
    input.value = '';
    renderDrawerSubtasks();
    input.focus();
}

async function drawerAskAISubtasks() {
    const title = document.getElementById('drawer-task-title').value.trim();
    const description = document.getElementById('drawer-task-description').value.trim();
    if (!title) {
        showAlert('اول یک عنوان برای تسک بنویس.');
        return;
    }

    const btn = document.getElementById('drawer-ai-subtasks-btn');
    const originalIcon = btn.innerHTML;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';
    btn.disabled = true;

    const prompt = `این یک تسک کاری است:\nعنوان: ${title}\n${description ? 'توضیحات: ' + description + '\n' : ''}\n` +
        `این تسک را به ۳ تا ۶ ساب‌تسک کوچک‌تر و عملی بشکن. فقط لیست ساب‌تسک‌ها را خط به خط و بدون هیچ توضیح اضافه‌ای برگردان (هر خط فقط یک ساب‌تسک، بدون شماره‌گذاری یا بولت).`;
    const res = await callAI(prompt);

    btn.innerHTML = originalIcon;
    btn.disabled = false;

    if (!res || !res.success || !res.answer) {
        showAlert('خطا در دریافت پیشنهاد از AI: ' + ((res && res.error) || 'نامشخص'));
        return;
    }

    const lines = String(res.answer).split('\n')
        .map(l => l.replace(/^[\s\-*•\d.)]+/, '').trim())
        .filter(l => l.length > 0 && l.length < 200);

    if (lines.length === 0) {
        showAlert('AI پیشنهاد قابل استفاده‌ای برنگردوند.');
        return;
    }

    lines.forEach((text, idx) => drawerSubtasks.push({ id: Date.now() + idx, text, done: false }));
    renderDrawerSubtasks();
}

async function saveTaskDrawer() {
    const title = document.getElementById('drawer-task-title').value.trim();
    if (!title) {
        showAlert('عنوان تسک نمی‌تواند خالی باشد.');
        return;
    }

    const date = document.getElementById('drawer-task-date').value.trim();
    const tags = document.getElementById('drawer-task-tags').value.trim();
    const links = document.getElementById('drawer-task-links').value.trim();
    const description = document.getElementById('drawer-task-description').value.trim();
    const status = currentDrawerTaskDraft ? currentDrawerTaskDraft.status : 'todo';
    const priority = currentDrawerTaskDraft ? currentDrawerTaskDraft.priority : 'medium';
    const projectId = currentDrawerTaskDraft && currentDrawerTaskDraft.project_id !== undefined ? currentDrawerTaskDraft.project_id : currentProjectId;

    if (currentDrawerTaskId) {
        await apiCall('update_task_details', 'POST', {
            id: currentDrawerTaskId,
            content: title,
            task_date: date || null,
            tags: tags || null,
            links: links || null,
            description: description || null,
            status,
            priority,
            subtasks: drawerSubtasks,
            project_id: projectId
        });
    } else {
        await apiCall('add_task', 'POST', {
            content: title,
            task_date: date || null,
            tags: tags || null,
            links: links || null,
            description: description || null,
            status,
            priority,
            subtasks: drawerSubtasks,
            project_id: projectId
        });
    }

    closeTaskDrawer();
    await refreshTasksView();
}

async function drawerDeleteCurrentTask() {
    if (!currentDrawerTaskId) return;
    const ok = await showConfirm('آیا از حذف این تسک اطمینان دارید؟');
    if (!ok) return;
    await apiCall('delete_task', 'POST', { id: currentDrawerTaskId });
    closeTaskDrawer();
    await refreshTasksView();
}

// ==========================================================================
// UPTIME & SSL MONITOR CONTROLLER
// ==========================================================================
async function checkProjectUptime(domain) {
    if (!domain) return;
    try {
        const res = await apiCall('check_site_uptime&domain=' + encodeURIComponent(domain));

        // The user may have switched to another project (or closed the workspace)
        // while this request was in flight - don't paint a stale result over it.
        if (activeUptimeDomain !== domain) return;

        const badge = document.getElementById('notion-uptime-badge');
        const ssl = document.getElementById('notion-ssl-badge');
        if (!badge || !ssl) return;

        if (res && res.success) {
            if (res.is_online) {
                badge.className = 'uptime-badge online';
                badge.innerHTML = '<i class="fa fa-circle"></i> آنلاین (' + res.response_time_ms + 'ms)';
            } else {
                badge.className = 'uptime-badge offline';
                badge.innerHTML = '<i class="fa fa-circle"></i> خطا (' + (res.status_code || 'آفلاین') + ')';
            }

            if (res.ssl_days_left !== null && res.ssl_days_left !== undefined) {
                ssl.style.display = 'inline-flex';
                ssl.innerHTML = '<i class="fa fa-lock"></i> SSL: ' + res.ssl_days_left + ' روز باقی‌مانده';
            }
        }
    } catch (e) {
        console.error('Uptime check error:', e);
    }
}

// ==========================================================================
// COMMAND PALETTE (Ctrl+K Spotlight) CONTROLLER
// ==========================================================================
let cmdSelectedIdx = 0;
let cmdResultsList = [];

function openCommandPalette() {
    const overlay = document.getElementById('cmd-palette-overlay');
    const input = document.getElementById('cmd-palette-input');
    input.value = '';
    overlay.classList.add('active');
    setTimeout(() => input.focus(), 50);
    renderCommandResults('');
}

function closeCommandPalette() {
    document.getElementById('cmd-palette-overlay').classList.remove('active');
}

function getAllCommands() {
    const items = [
        // Quick Actions
        { id: 'act_new_task', title: 'افزودن تسک جدید', group: 'دستورات سریع', icon: 'fa-plus', run: () => openTaskDrawer() },
        { id: 'act_theme', title: 'تغییر تم (روز / شب)', group: 'دستورات سریع', icon: 'fa-moon', run: () => toggleTheme() },
        { id: 'act_focus', title: 'فعال/غیرفعال‌سازی تمرکز عمیق (Deep Focus)', group: 'دستورات سریع', icon: 'fa-eye-slash', run: () => toggleDeepFocus() },
        { id: 'act_pomodoro', title: 'شروع/توقف تایمر پومودورو', group: 'دستورات سریع', icon: 'fa-clock', run: () => togglePomodoro() },
        { id: 'act_ai', title: 'دستیار هوش مصنوعی وبمستر', group: 'دستورات سریع', icon: 'fa-robot', run: () => openAiAssistantModal() },
        { id: 'act_chat', title: 'چت با دوست/همکار', group: 'دستورات سریع', icon: 'fa-comments', run: () => openChatModal() },
        { id: 'act_vault', title: 'باز کردن گاوصندوق رمزها', group: 'دستورات سریع', icon: 'fa-shield-alt', run: () => openVaultModal() },
        { id: 'act_all_tasks', title: 'همه‌ی تسک‌ها (همه‌ی پروژه‌ها)', group: 'دستورات سریع', icon: 'fa-layer-group', run: () => openAllTasksView() },
        { id: 'act_backup', title: 'پشتیبان‌گیری و دانلود دیتابیس', group: 'دستورات سریع', icon: 'fa-download', run: () => exportDashboardBackup() },
        { id: 'act_sessions', title: 'مدیریت نشست تب‌های باز', group: 'دستورات سریع', icon: 'fa-layer-group', run: () => openSessionsModal() }
    ];
    if (isDesktopApp()) {
        items.push({ id: 'act_clipboard_ai', title: 'بررسی کلیپ‌بورد با AI', group: 'دستورات سریع', icon: 'fa-clipboard', run: () => askAIAboutClipboard() });
    }

    // Projects
    (projectsCache || []).forEach(p => {
        items.push({
            id: 'proj_' + p.id,
            title: 'فضای کاری: ' + p.name + (p.domain ? ' (' + p.domain + ')' : ''),
            group: 'پروژه‌ها و ورک‌اسپیس‌ها',
            icon: 'fa-briefcase',
            run: () => openNotionWorkspace(p.id)
        });
    });

    // DevTools
    const toolNames = {
        enhancer: 'شفاف‌ساز و ارتقای عکس',
        timetracker: 'ردیاب زمان وبگردی',
        irandev: 'اعتبارسنج کدملی و کارت بانکی',
        finance: 'محاسبه وام و ارزش افزوده',
        vectorizer: 'تبدیل عکس به وکتور SVG',
        imgpalette: 'استخراج پالت رنگ از عکس',
        bgremover: 'حذف پس‌زمینه تصویر',
        ai: 'دستیار هوش مصنوعی', vault: 'گاوصندوق رمزها', tempmail: 'ایمیل موقت', squoosh: 'فشرده‌ساز عکس',
        json: 'ادیتور و فرمتر JSON', color: 'رنگ و گرادیانت', qr: 'بارکدساز QR', lorem: 'متن لورم ایپسوم',
        slug: 'اسلاگ‌ساز فارسی', leakcheck: 'بررسی نشت اطلاعات', downloader: 'دانلودر تصویر و ویدیو',
        fakedata: 'تولید دیتای فیک', jwt: 'دیکدر JWT', contrast: 'کنتراست رنگ‌ها',
        seo: 'بررسی سئو و لایت‌هاوس', article: 'ربات مقاله‌نویس', reaction: 'بازی سرعت واکنش',
        hafez: 'فال حافظ', movie: 'جستجوی فیلم', myip: 'آی‌پی من',
        ledger: 'مدیریت مالی و اقساط ماهانه', newsdigest: 'اخبار روز'
    };
    if (isDesktopApp()) {
        toolNames.systemhealth = 'سلامت سیستم';
    }
    Object.entries(toolNames).forEach(([k, v]) => {
        items.push({
            id: 'tool_' + k,
            title: 'ابزار: ' + v,
            group: 'ابزارهای توسعه',
            icon: 'fa-wrench',
            run: () => openTool(k)
        });
    });

    // Tasks
    ((currentData && currentData.tasks) || []).forEach(t => {
        items.push({
            id: 'task_' + t.id,
            title: 'تسک: ' + t.content,
            group: 'وظایف و تسک‌ها',
            icon: 'fa-check-square',
            run: () => openTaskDrawer(t.id)
        });
    });

    // Bookmarks
    ((currentData && currentData.bookmarks) || []).forEach(b => {
        items.push({
            id: 'bm_' + b.id,
            title: 'بوک‌مارک: ' + b.title,
            group: 'بوک‌مارک‌ها',
            icon: 'fa-bookmark',
            run: () => window.open(b.url, '_blank')
        });
    });

    return items;
}

function renderCommandResults(query) {
    const q = query.trim().toLowerCase();
    const all = getAllCommands();
    let list = q ? all.filter(item => item.title.toLowerCase().includes(q) || item.group.toLowerCase().includes(q)) : all.slice(0, 15);
    if (q) {
        list = [{
            id: 'ai_ask_query',
            title: 'بپرس از AI: «' + query.trim() + '»',
            group: 'دستیار هوش مصنوعی',
            icon: 'fa-robot',
            run: () => askAIWithContext(query.trim())
        }, ...list];
    }
    cmdResultsList = list;
    cmdSelectedIdx = 0;

    const container = document.getElementById('cmd-palette-results');
    container.innerHTML = '';

    if (cmdResultsList.length === 0) {
        container.innerHTML = '<div class="text-muted" style="text-align:center; padding:1.5rem;">نتیجه‌ای یافت نشد.</div>';
        return;
    }

    let currentGroup = '';
    cmdResultsList.forEach((cmd, idx) => {
        if (cmd.group !== currentGroup) {
            currentGroup = cmd.group;
            const grpTitle = document.createElement('div');
            grpTitle.className = 'cmd-group-title';
            grpTitle.textContent = currentGroup;
            container.appendChild(grpTitle);
        }

        const el = document.createElement('div');
        el.className = 'cmd-item ' + (idx === cmdSelectedIdx ? 'selected' : '');
        el.innerHTML = '<i class="fa ' + cmd.icon + '"></i> <span>' + escapeHtml(cmd.title) + '</span>';
        el.addEventListener('click', () => {
            closeCommandPalette();
            cmd.run();
        });
        container.appendChild(el);
    });
}

function updateCommandSelectionUI() {
    const items = document.querySelectorAll('.cmd-palette-results .cmd-item');
    items.forEach((it, idx) => it.classList.toggle('selected', idx === cmdSelectedIdx));
    if (items[cmdSelectedIdx]) {
        items[cmdSelectedIdx].scrollIntoView({ block: 'nearest' });
    }
}

// ==========================================================================
// INTERNAL CHAT CONTROLLER (DM between registered users of this install)
// ==========================================================================
let chatActiveUserId = null;
let chatPollInterval = null;
let chatUnreadPollInterval = null;

async function openChatModal() {
    document.getElementById('chat-modal-overlay').classList.add('active');
    await loadChatUsersList();
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(() => {
        if (chatActiveUserId) loadChatMessages(chatActiveUserId, true);
    }, 4000);
}

function closeChatModal() {
    document.getElementById('chat-modal-overlay').classList.remove('active');
    if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
    refreshChatUnreadBadge();
}

async function loadChatUsersList() {
    const listEl = document.getElementById('chat-users-list');
    const res = await apiCall('get_chat_users');
    const users = (res && res.users) || [];
    if (users.length === 0) {
        listEl.innerHTML = '<p class="text-muted" style="font-size:0.78rem; padding:1rem; text-align:center;">هنوز کاربر دیگه‌ای تو این نصب ثبت‌نام نکرده.</p>';
        return;
    }
    listEl.innerHTML = users.map(u => `
        <div class="chat-user-item" data-chat-user="${u.id}">
            <span>${escapeHtml(u.display_name || u.email)}</span>
        </div>
    `).join('');
    listEl.querySelectorAll('[data-chat-user]').forEach(item => {
        item.addEventListener('click', () => {
            listEl.querySelectorAll('.chat-user-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            chatActiveUserId = item.dataset.chatUser;
            document.getElementById('chat-input-wrap').style.display = 'flex';
            loadChatMessages(chatActiveUserId);
        });
    });
}

async function loadChatMessages(withUserId, silent) {
    const outputEl = document.getElementById('chat-messages-output');
    if (!silent) outputEl.innerHTML = '<p class="text-muted" style="text-align:center; padding:2rem;"><i class="fa fa-spinner fa-spin"></i></p>';
    const res = await apiCall('get_chat_messages&with_user_id=' + encodeURIComponent(withUserId));
    if (String(chatActiveUserId) !== String(withUserId)) return; // user switched away while this was in flight
    const messages = (res && res.messages) || [];
    if (messages.length === 0) {
        outputEl.innerHTML = '<p class="text-muted" style="text-align:center; padding:2rem;">هنوز پیامی رد و بدل نشده. اولین پیام رو بفرست!</p>';
        return;
    }
    const nearBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 60;
    outputEl.innerHTML = messages.map(m => `
        <div class="ai-msg ${String(m.sender_id) === String(currentUser.id) ? 'user' : 'bot'}">${escapeHtml(m.body).replace(/\n/g, '<br>')}</div>
    `).join('');
    if (!silent || nearBottom) outputEl.scrollTop = outputEl.scrollHeight;
}

async function sendChatMessage() {
    if (!chatActiveUserId) return;
    const input = document.getElementById('chat-message-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await apiCall('send_chat_message', 'POST', { recipient_id: chatActiveUserId, body: text });
    await loadChatMessages(chatActiveUserId);
}

async function refreshChatUnreadBadge() {
    const res = await apiCall('get_unread_chat_count');
    const badge = document.getElementById('dock-chat-badge');
    if (!badge) return;
    const count = (res && res.count) || 0;
    if (count > 0) {
        badge.textContent = count > 9 ? '9+' : String(count);
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

// ==========================================================================
// AI ASSISTANT CONTROLLER
// ==========================================================================
function openAiAssistantModal() {
    document.getElementById('ai-assistant-modal-overlay').classList.add('active');
    setTimeout(() => document.getElementById('ai-prompt-input').focus(), 50);
}
function closeAiAssistantModal() {
    document.getElementById('ai-assistant-modal-overlay').classList.remove('active');
}

async function sendAiPrompt(promptText, displayText) {
    const text = promptText || document.getElementById('ai-prompt-input').value.trim();
    if (!text) return;

    const output = document.getElementById('ai-chat-output');
    const input = document.getElementById('ai-prompt-input');
    input.value = '';

    // Render User Message (displayText lets a context-heavy prompt show a short label instead of the full payload)
    const userMsg = document.createElement('div');
    userMsg.className = 'ai-msg user';
    userMsg.textContent = displayText || text;
    output.appendChild(userMsg);

    // Bot Thinking Message
    const botMsg = document.createElement('div');
    botMsg.className = 'ai-msg bot';
    botMsg.innerHTML = '<i class="fa fa-spinner fa-spin"></i> در حال تحلیل و پردازش پاسخ هوشمند...';
    output.appendChild(botMsg);
    output.scrollTop = output.scrollHeight;

    const res = await callAI(text);
    if (res && res.success && res.answer) {
        botMsg.innerHTML = escapeHtml(String(res.answer)).replace(/\n/g, '<br>');
    } else {
        botMsg.innerHTML = `<span style="color:var(--danger-color);"><i class="fa fa-triangle-exclamation"></i> ${escapeHtml((res && res.error) || 'خطا در ارتباط با سرویس هوش مصنوعی')}</span>`;
    }
    output.scrollTop = output.scrollHeight;
}

// Opens the AI Assistant chat and immediately asks it a question built from some
// other widget's own data (evidence text, finance table, a task, a watchlist) -
// contextPrefix is the bulky data payload, label is the short line shown in the chat bubble instead.
function askAIWithContext(question, contextPrefix, label) {
    openAiAssistantModal();
    const fullPrompt = contextPrefix ? `${contextPrefix}\n\n---\n\n${question}` : question;
    sendAiPrompt(fullPrompt, label || question);
}

// Desktop-only: reads whatever's currently on the OS clipboard (code, an
// error message, JSON, anything copied from any app) and asks the AI about
// it - on-demand via the command palette, not a background watcher, so
// nothing is read without the user explicitly asking.
async function askAIAboutClipboard() {
    const text = await window.__TAURI__.clipboardManager.readText();
    if (!text || !text.trim()) {
        await showAlert('چیزی تو کلیپ‌بورد پیدا نشد.', 'بررسی کلیپ‌بورد با AI');
        return;
    }
    askAIWithContext(
        'این متنی که از کلیپ‌بورد کپی کردم رو بررسی کن - اگه کد یا خطاست توضیح بده مشکل چیه و راه‌حلش چیه، اگه JSON یا داده‌ی ساختاریافته‌ست خلاصه بگو چیه، وگرنه خلاصه‌ش کن.',
        `متن کلیپ‌بورد:\n${text.slice(0, 6000)}`,
        'بررسی کلیپ‌بورد با AI'
    );
}

// ==========================================================================
// ENCRYPTED SECRET VAULT CONTROLLER (AES-GCM WebCrypto)
// ==========================================================================
let vaultUnlockedKey = null;
let vaultMasterPass = null;

async function deriveVaultKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );
    return await window.crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptVaultSecret(plainText, password) {
    const enc = new TextEncoder();
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveVaultKey(password, salt);
    const encrypted = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        enc.encode(plainText)
    );
    const hexOf = (arr) => Array.from(new Uint8Array(arr)).map(b => b.toString(16).padStart(2, '0')).join('');
    return {
        payload: hexOf(encrypted),
        iv: hexOf(iv),
        salt: hexOf(salt)
    };
}

async function decryptVaultSecret(encryptedHex, ivHex, saltHex, password) {
    const fromHex = (hex) => new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const salt = fromHex(saltHex);
    const iv = fromHex(ivHex);
    const encrypted = fromHex(encryptedHex);
    const key = await deriveVaultKey(password, salt);
    const decrypted = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encrypted
    );
    return new TextDecoder().decode(decrypted);
}

function openVaultModal() {
    const overlay = document.getElementById('vault-modal-overlay');
    overlay.classList.add('active');
    if (vaultMasterPass) {
        document.getElementById('vault-auth-screen').style.display = 'none';
        document.getElementById('vault-content-screen').style.display = 'block';
        renderVaultItems();
    } else {
        document.getElementById('vault-auth-screen').style.display = 'block';
        document.getElementById('vault-content-screen').style.display = 'none';
        setTimeout(() => document.getElementById('vault-master-pass').focus(), 50);
    }
}
function closeVaultModal() {
    document.getElementById('vault-modal-overlay').classList.remove('active');
    document.getElementById('vault-item-form-screen').style.display = 'none';
}

async function unlockVault() {
    const pass = document.getElementById('vault-master-pass').value;
    if (!pass) return;
    vaultMasterPass = pass;
    document.getElementById('vault-auth-screen').style.display = 'none';
    document.getElementById('vault-content-screen').style.display = 'block';
    renderVaultItems();
}

async function renderVaultItems() {
    const container = document.getElementById('vault-items-list');
    container.innerHTML = '';
    const items = (currentData && currentData.vault_items) || [];

    if (items.length === 0) {
        container.innerHTML = '<div class="text-muted" style="text-align:center; padding:1rem;">هیچ کلید یا رمزی ذخیره نشده است.</div>';
        return;
    }

    for (const item of items) {
        const card = document.createElement('div');
        card.className = 'vault-item-card';
        card.innerHTML = 
            '<div class="vault-item-info">' +
                '<strong>' + escapeHtml(item.title) + '</strong>' +
                '<span class="text-muted" style="font-size:0.75rem;">' + escapeHtml(item.category || 'کلید امن') + '</span>' +
            '</div>' +
            '<div style="display:flex; align-items:center; gap:6px;">' +
                '<button class="btn-secondary vault-decrypt-btn" data-id="' + item.id + '" style="padding:0.35rem 0.7rem; font-size:0.75rem;"><i class="fa fa-eye"></i> نمایش / کپی</button>' +
                '<button class="icon-btn vault-delete-btn" data-id="' + item.id + '" style="width:26px; height:26px; font-size:0.7rem; color:var(--danger-color);"><i class="fa fa-trash"></i></button>' +
            '</div>';

        card.querySelector('.vault-decrypt-btn').addEventListener('click', async () => {
            try {
                const res = await apiCall('get_vault_payload&id=' + item.id);
                if (res && res.item) {
                    const dec = await decryptVaultSecret(res.item.encrypted_payload, res.item.iv, res.item.salt, vaultMasterPass);
                    navigator.clipboard.writeText(dec);
                    showAlert('اطلاعات با موفقیت دیکریپت و در کلیپ‌بورد کپی شد:\n\n' + dec, 'رمزگشایی موفق');
                }
            } catch (e) {
                showAlert('رمز اصلی نادرست است یا خطایی رخ داد.', 'خطا در رمزگشایی');
            }
        });

        card.querySelector('.vault-delete-btn').addEventListener('click', async () => {
            const ok = await showConfirm('آیا از حذف این کلید مطمئنید؟');
            if (!ok) return;
            await apiCall('delete_vault_item', 'POST', { id: item.id });
            await fetchData();
            renderVaultItems();
        });

        container.appendChild(card);
    }
}

// Cryptographically random - not Math.random() - since this is meant to be an
// actually-strong password, matching the rigor of the vault's own AES-GCM crypto.
function generateStrongPassword(length = 18) {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+';
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, n => charset[n % charset.length]).join('');
}

function passwordStrengthLabel(pass) {
    if (!pass) return '';
    let score = 0;
    if (pass.length >= 8) score++;
    if (pass.length >= 14) score++;
    if (/[a-z]/.test(pass) && /[A-Z]/.test(pass)) score++;
    if (/[0-9]/.test(pass)) score++;
    if (/[^A-Za-z0-9]/.test(pass)) score++;
    if (score <= 1) return '<span style="color:var(--danger-color);">ضعیف</span>';
    if (score <= 3) return '<span style="color:#ff9f0a;">متوسط</span>';
    return '<span style="color:var(--success-color);">قوی</span>';
}

let editingVaultItemId = null;

function openVaultItemForm() {
    editingVaultItemId = null;
    document.getElementById('vault-content-screen').style.display = 'none';
    document.getElementById('vault-item-form-screen').style.display = 'block';
    document.getElementById('vault-form-title').value = '';
    document.getElementById('vault-form-value').value = '';
    document.getElementById('vault-form-strength').innerHTML = '';
    document.getElementById('vault-form-error').style.display = 'none';
    setTimeout(() => document.getElementById('vault-form-title').focus(), 50);
}

function closeVaultItemForm() {
    document.getElementById('vault-item-form-screen').style.display = 'none';
    document.getElementById('vault-content-screen').style.display = 'block';
}

async function saveVaultItemForm() {
    const title = document.getElementById('vault-form-title').value.trim();
    const value = document.getElementById('vault-form-value').value;
    const errorEl = document.getElementById('vault-form-error');
    if (!title || !value) {
        errorEl.textContent = 'عنوان و مقدار محرمانه هر دو لازم است.';
        errorEl.style.display = 'block';
        return;
    }
    errorEl.style.display = 'none';

    const encrypted = await encryptVaultSecret(value, vaultMasterPass);
    const res = await apiCall('save_vault_item', 'POST', {
        title,
        category: 'کلید و پسورد',
        encrypted_payload: encrypted.payload,
        iv: encrypted.iv,
        salt: encrypted.salt,
        project_id: currentProjectId
    });
    if (!res || !res.success) {
        errorEl.textContent = 'ذخیره در گاوصندوق ممکن نشد؛ ممکنه بک‌اند سرور با این نسخه از اکستنشن هم‌خوانی نداشته باشه.';
        errorEl.style.display = 'block';
        return;
    }
    closeVaultItemForm();
    await fetchData();
    renderVaultItems();
}

// ==========================================================================
// HABIT TRACKER CONTROLLER
// ==========================================================================
function renderHabits() {
    const list = document.getElementById('habits-list');
    if (!list) return;
    list.innerHTML = '';
    const habits = (currentData && currentData.habits) || [];
    const today = getTodayJalaali();

    if (habits.length === 0) {
        list.innerHTML = '<div class="text-muted" style="font-size:0.85rem; padding:0.5rem 0;">عادتی ثبت نشده است. روی + کلیک کنید.</div>';
        return;
    }

    habits.forEach(h => {
        let history = [];
        try { history = JSON.parse(h.history_json || '[]'); } catch (e) {}
        const isDoneToday = history.includes(today);

        const item = document.createElement('div');
        item.className = 'habit-item ' + (isDoneToday ? 'done' : '');
        item.innerHTML = 
            '<div style="display:flex; align-items:center; gap:8px;">' +
                '<input type="checkbox" ' + (isDoneToday ? 'checked' : '') + ' style="cursor:pointer;">' +
                '<span style="font-size:0.88rem;">' + escapeHtml(h.title) + '</span>' +
            '</div>' +
            '<div style="display:flex; align-items:center; gap:6px;">' +
                '<span class="habit-streak-badge" title="تعداد روزهای متوالی">🔥 ' + (h.streak || 0) + '</span>' +
                '<i class="fa fa-times habit-del-btn" data-id="' + h.id + '" style="color:var(--text-muted); cursor:pointer; font-size:0.75rem;"></i>' +
            '</div>';

        item.querySelector('input[type="checkbox"]').addEventListener('change', async () => {
            await apiCall('toggle_habit', 'POST', { id: h.id, date: today });
            await fetchData();
            renderHabits();
        });

        item.querySelector('.habit-del-btn').addEventListener('click', async () => {
            await apiCall('delete_habit', 'POST', { id: h.id });
            await fetchData();
            renderHabits();
        });

        list.appendChild(item);
    });
}

async function addNewHabit() {
    const title = await showPrompt('عنوان عادت روزانه (مثال: بررسی بکاپ و لاگ‌ها):', '', 'عادت جدید');
    if (!title) return;
    await apiCall('save_habit', 'POST', { title, project_id: currentProjectId });
    await fetchData();
    renderHabits();
}

// ==========================================================================
// SESSION TAB SAVER CONTROLLER
// ==========================================================================
function openSessionsModal() {
    document.getElementById('session-modal-overlay').classList.add('active');
    renderSavedSessions();
}
function closeSessionsModal() {
    document.getElementById('session-modal-overlay').classList.remove('active');
}

function renderSavedSessions() {
    const list = document.getElementById('saved-sessions-list');
    list.innerHTML = '';
    const sessions = (currentData && currentData.saved_sessions) || [];

    if (sessions.length === 0) {
        list.innerHTML = '<div class="text-muted" style="text-align:center; padding:1rem;">هیچ نشست تبی ذخیره نشده است.</div>';
        return;
    }

    sessions.forEach(s => {
        let tabs = [];
        try { tabs = JSON.parse(s.tabs_json || '[]'); } catch (e) {}

        const item = document.createElement('div');
        item.className = 'vault-item-card';
        item.innerHTML = 
            '<div>' +
                '<strong>' + escapeHtml(s.name) + '</strong>' +
                '<div class="text-muted" style="font-size:0.78rem;">' + tabs.length + ' تب ذخیره شده</div>' +
            '</div>' +
            '<div style="display:flex; gap:6px;">' +
                '<button class="btn-primary restore-session-btn" style="padding:0.35rem 0.7rem; font-size:0.75rem;"><i class="fa fa-external-link-alt"></i> باز کردن تب‌ها</button>' +
                '<button class="icon-btn delete-session-btn" style="width:26px; height:26px; font-size:0.7rem; color:var(--danger-color);"><i class="fa fa-trash"></i></button>' +
            '</div>';

        item.querySelector('.restore-session-btn').addEventListener('click', () => {
            tabs.forEach(t => {
                if (t.url) window.open(t.url, '_blank');
            });
        });

        item.querySelector('.delete-session-btn').addEventListener('click', async () => {
            await apiCall('delete_tab_session', 'POST', { id: s.id });
            await fetchData();
            renderSavedSessions();
        });

        list.appendChild(item);
    });
}

async function saveCurrentTabSession() {
    const nameInput = document.getElementById('session-name-input');
    const name = nameInput.value.trim() || 'نشست ' + getTodayJalaali();

    let tabList = [];
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        const tabs = await new Promise(res => chrome.tabs.query({ currentWindow: true }, res));
        tabList = tabs.map(t => ({ title: t.title, url: t.url }));
    } else {
        tabList = [{ title: 'داشبورد ویرا', url: window.location.href }];
    }

    await apiCall('save_tab_session', 'POST', { name, tabs: tabList, project_id: currentProjectId });
    nameInput.value = '';
    await fetchData();
    renderSavedSessions();
    showAlert('تعداد ' + tabList.length + ' تب با موفقیت در این نشست ذخیره شد.');
}

// ==========================================================================
// BACKUP & RESTORE CONTROLLER
// ==========================================================================
async function exportDashboardBackup() {
    const res = await apiCall('export_backup');
    if (res && res.success && res.backup) {
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(res.backup, null, 2));
        const a = document.createElement('a');
        a.href = dataStr;
        a.download = 'vira_backup_' + (getTodayJalaali() || 'all') + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
    } else {
        showAlert('خطا در دریافت بکاپ از سرور.');
    }
}

async function importDashboardBackup(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const backup = JSON.parse(e.target.result);
            const ok = await showConfirm('با بازیابی بکاپ، اطلاعات فعلی دیتابیس با بکاپ جایگزین خواهد شد. آیا مطمئنید؟');
            if (!ok) return;

            const res = await apiCall('import_backup', 'POST', { backup });
            if (res && res.success) {
                showAlert('داده‌ها با موفقیت بازیابی شدند!', 'موفقیت');
                await fetchData();
            } else {
                showAlert('خطا در ایمپورت داده‌ها: ' + (res ? res.error : ''));
            }
        } catch (err) {
            showAlert('فایل انتخاب‌شده یک فرمت JSON معتبر نیست.');
        }
    };
    reader.readAsText(file);
}

// ==========================================================================
// 1. LOCAL IMAGE ENHANCER & UPSCALING STUDIO (HTML5 Canvas & WebGL)
// ==========================================================================
function openEnhancerTool() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = '<i class="fa fa-wand-magic-sparkles" style="color:#38bdf8;"></i> استودیوی شفاف‌ساز و ارتقای کیفیت عکس (لوکال)';
    body.innerHTML = `
        <div class="enhancer-layout">
            <div id="enhancer-dropzone" class="image-drop-zone">
                <i class="fa fa-cloud-arrow-up" style="font-size:2.2rem; color:var(--primary-color); margin-bottom:0.5rem; display:block;"></i>
                <strong>تصویر خود را اینجا بکشید یا برای انتخاب کلیک کنید</strong>
                <p class="text-muted" style="font-size:0.8rem; margin-top:4px;">پردازش ۱۰۰٪ آفلاین و محلی در مرورگر بدون ارسال به هیچ سروری</p>
                <input type="file" id="enhancer-file-input" accept="image/*" style="display:none;">
            </div>

            <div id="enhancer-workspace" style="display:none; flex-direction:column; gap:1rem;">
                <div class="compare-viewer-wrap" id="enhancer-compare-viewer">
                    <div class="compare-badge-label compare-badge-after"><i class="fa fa-sparkles"></i> شفاف‌شده (After)</div>
                    <div class="compare-badge-label compare-badge-before"><i class="fa fa-image"></i> اصلی (Before)</div>
                    
                    <div class="compare-img-layer">
                        <canvas id="enhancer-canvas-after"></canvas>
                    </div>
                    <div class="compare-img-layer compare-before-layer" id="enhancer-before-layer">
                        <canvas id="enhancer-canvas-before"></canvas>
                    </div>
                    <div class="compare-slider-divider" id="enhancer-slider-divider">
                        <div class="compare-slider-handle"><i class="fa fa-arrows-left-right"></i></div>
                    </div>
                </div>

                <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                    <button class="chip-btn" id="enhancer-preset-auto">🌟 شفاف‌سازی خودکار</button>
                    <button class="chip-btn" id="enhancer-preset-text">🔍 رفع تاری متن / اسکرین‌شات</button>
                    <button class="chip-btn" id="enhancer-preset-vivid">🎨 عکاسی پرطراوت</button>
                    <button class="chip-btn" id="enhancer-preset-reset">🔄 ریست تنظیمات</button>
                </div>

                <div class="enhancer-controls-grid">
                    <div class="slider-control-row">
                        <div class="slider-control-header">
                            <span><i class="fa fa-crosshairs"></i> شارپ کردن و وضوح لبه‌ها</span>
                            <span id="val-sharpen">۴۰٪</span>
                        </div>
                        <input type="range" id="enhancer-range-sharpen" class="enhancer-range" min="0" max="100" value="40">
                    </div>

                    <div class="slider-control-row">
                        <div class="slider-control-header">
                            <span><i class="fa fa-sun"></i> کنتراست موضعی و رفع ماتی</span>
                            <span id="val-contrast">۲۰٪</span>
                        </div>
                        <input type="range" id="enhancer-range-contrast" class="enhancer-range" min="0" max="100" value="20">
                    </div>

                    <div class="slider-control-row">
                        <div class="slider-control-header">
                            <span><i class="fa fa-lightbulb"></i> روشنایی</span>
                            <span id="val-brightness">۰٪</span>
                        </div>
                        <input type="range" id="enhancer-range-brightness" class="enhancer-range" min="-50" max="50" value="0">
                    </div>

                    <div class="slider-control-row">
                        <div class="slider-control-header">
                            <span><i class="fa fa-palette"></i> شادابی رنگ‌ها (Vibrance)</span>
                            <span id="val-vibrance">۱۱۰٪</span>
                        </div>
                        <input type="range" id="enhancer-range-vibrance" class="enhancer-range" min="0" max="200" value="110">
                    </div>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem;">
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.85rem; font-weight:600;">
                        <input type="checkbox" id="enhancer-upscale-toggle" style="cursor:pointer; width:16px; height:16px;">
                        <span>افزایش ابعاد ۲ برابری (2x HD Upscale)</span>
                    </label>

                    <div style="display:flex; gap:0.5rem;">
                        <button class="btn-secondary" id="enhancer-new-file-btn"><i class="fa fa-folder-open"></i> انتخاب عکس جدید</button>
                        <button class="btn-primary" id="enhancer-download-png-btn"><i class="fa fa-download"></i> دانلود PNG باکیفیت</button>
                        <button class="btn-primary" id="enhancer-download-webp-btn" style="background:#059669;"><i class="fa fa-file-image"></i> دانلود WebP HD</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    overlay.classList.add('active');

    let loadedImg = null;
    const dropzone = document.getElementById('enhancer-dropzone');
    const fileInput = document.getElementById('enhancer-file-input');
    const workspace = document.getElementById('enhancer-workspace');
    const canvasBefore = document.getElementById('enhancer-canvas-before');
    const canvasAfter = document.getElementById('enhancer-canvas-after');
    const beforeLayer = document.getElementById('enhancer-before-layer');
    const divider = document.getElementById('enhancer-slider-divider');
    const viewer = document.getElementById('enhancer-compare-viewer');

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    document.getElementById('enhancer-new-file-btn').addEventListener('click', () => fileInput.click());

    function handleFile(file) {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                loadedImg = img;
                dropzone.style.display = 'none';
                workspace.style.display = 'flex';
                renderOriginal();
                processEnhance();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    function renderOriginal() {
        if (!loadedImg) return;
        canvasBefore.width = loadedImg.width;
        canvasBefore.height = loadedImg.height;
        const ctx = canvasBefore.getContext('2d');
        ctx.drawImage(loadedImg, 0, 0);
    }

    function processEnhance() {
        if (!loadedImg) return;
        const sharpen = parseInt(document.getElementById('enhancer-range-sharpen').value, 10);
        const contrast = parseInt(document.getElementById('enhancer-range-contrast').value, 10);
        const brightness = parseInt(document.getElementById('enhancer-range-brightness').value, 10);
        const vibrance = parseInt(document.getElementById('enhancer-range-vibrance').value, 10);
        const is2x = document.getElementById('enhancer-upscale-toggle').checked;

        document.getElementById('val-sharpen').textContent = sharpen + '٪';
        document.getElementById('val-contrast').textContent = contrast + '٪';
        document.getElementById('val-brightness').textContent = brightness + '٪';
        document.getElementById('val-vibrance').textContent = vibrance + '٪';

        const scale = is2x ? 2 : 1;
        const targetW = loadedImg.width * scale;
        const targetH = loadedImg.height * scale;

        canvasAfter.width = targetW;
        canvasAfter.height = targetH;
        const ctx = canvasAfter.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(loadedImg, 0, 0, targetW, targetH);

        const imgData = ctx.getImageData(0, 0, targetW, targetH);
        const d = imgData.data;
        const w = targetW;
        const h = targetH;

        // 1. Contrast, Brightness & Vibrance
        const cFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
        const vFactor = vibrance / 100;
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i];
            let g = d[i + 1];
            let b = d[i + 2];

            // Brightness & Contrast
            r = cFactor * (r - 128) + 128 + brightness * 2;
            g = cFactor * (g - 128) + 128 + brightness * 2;
            b = cFactor * (b - 128) + 128 + brightness * 2;

            // Vibrance / Saturation boost
            const max = Math.max(r, g, b);
            const avg = (r + g + b) / 3;
            const amt = ((Math.abs(max - avg) * 2 / 255) * vFactor);
            if (r !== max) r += (max - r) * amt;
            if (g !== max) g += (max - g) * amt;
            if (b !== max) b += (max - b) * amt;

            d[i] = Math.min(255, Math.max(0, r));
            d[i + 1] = Math.min(255, Math.max(0, g));
            d[i + 2] = Math.min(255, Math.max(0, b));
        }

        // 2. Convolution Sharpening (Unsharp Mask matrix)
        if (sharpen > 0) {
            const k = (sharpen / 100) * 0.9;
            const src = new Uint8ClampedArray(d);
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const idx = (y * w + x) * 4;
                    for (let c = 0; c < 3; c++) {
                        const top = ((y - 1) * w + x) * 4 + c;
                        const bottom = ((y + 1) * w + x) * 4 + c;
                        const left = (y * w + (x - 1)) * 4 + c;
                        const right = (y * w + (x + 1)) * 4 + c;
                        const center = idx + c;

                        const val = src[center] * (1 + 4 * k) - k * (src[top] + src[bottom] + src[left] + src[right]);
                        d[center] = Math.min(255, Math.max(0, val));
                    }
                }
            }
        }

        ctx.putImageData(imgData, 0, 0);
    }

    // Interactive Comparison Slider
    let isDragging = false;
    function updateDivider(x) {
        const rect = viewer.getBoundingClientRect();
        let pct = ((x - rect.left) / rect.width) * 100;
        pct = Math.max(0, Math.min(100, pct));
        divider.style.left = pct + '%';
        beforeLayer.style.clipPath = `polygon(0 0, ${pct}% 0, ${pct}% 100%, 0 100%)`;
    }

    divider.addEventListener('mousedown', () => { isDragging = true; });
    window.addEventListener('mouseup', () => { isDragging = false; });
    viewer.addEventListener('mousemove', (e) => { if (isDragging) updateDivider(e.clientX); });
    viewer.addEventListener('click', (e) => updateDivider(e.clientX));

    // Range input listeners
    ['sharpen', 'contrast', 'brightness', 'vibrance'].forEach(id => {
        document.getElementById(`enhancer-range-${id}`).addEventListener('input', () => processEnhance());
    });
    document.getElementById('enhancer-upscale-toggle').addEventListener('change', () => processEnhance());

    // Presets
    document.getElementById('enhancer-preset-auto').addEventListener('click', () => {
        document.getElementById('enhancer-range-sharpen').value = 45;
        document.getElementById('enhancer-range-contrast').value = 25;
        document.getElementById('enhancer-range-brightness').value = 4;
        document.getElementById('enhancer-range-vibrance').value = 115;
        processEnhance();
    });
    document.getElementById('enhancer-preset-text').addEventListener('click', () => {
        document.getElementById('enhancer-range-sharpen').value = 85;
        document.getElementById('enhancer-range-contrast').value = 35;
        document.getElementById('enhancer-range-brightness').value = 0;
        document.getElementById('enhancer-range-vibrance').value = 100;
        processEnhance();
    });
    document.getElementById('enhancer-preset-vivid').addEventListener('click', () => {
        document.getElementById('enhancer-range-sharpen').value = 35;
        document.getElementById('enhancer-range-contrast').value = 20;
        document.getElementById('enhancer-range-brightness').value = 5;
        document.getElementById('enhancer-range-vibrance').value = 145;
        processEnhance();
    });
    document.getElementById('enhancer-preset-reset').addEventListener('click', () => {
        document.getElementById('enhancer-range-sharpen').value = 0;
        document.getElementById('enhancer-range-contrast').value = 0;
        document.getElementById('enhancer-range-brightness').value = 0;
        document.getElementById('enhancer-range-vibrance').value = 100;
        document.getElementById('enhancer-upscale-toggle').checked = false;
        processEnhance();
    });

    // Downloads
    document.getElementById('enhancer-download-png-btn').addEventListener('click', () => {
        const link = document.createElement('a');
        link.download = 'enhanced_image_' + Date.now() + '.png';
        link.href = canvasAfter.toDataURL('image/png');
        link.click();
    });
    document.getElementById('enhancer-download-webp-btn').addEventListener('click', () => {
        const link = document.createElement('a');
        link.download = 'enhanced_image_' + Date.now() + '.webp';
        link.href = canvasAfter.toDataURL('image/webp', 0.95);
        link.click();
    });
}

// ==========================================================================
// 2. DOMAIN SCREEN TIME TRACKER
// ==========================================================================
async function openTimeTrackerTool() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = '<i class="fa fa-stopwatch-20" style="color:#ec4899;"></i> ردیاب زمان وبگردی و فعالیت';
    body.innerHTML = `
        <div class="timetracker-layout">
            <div class="timetracker-hero">
                <span class="text-muted" style="font-size:0.85rem; display:block; margin-bottom:4px;">مجموع زمان حضور شما در وب امروز</span>
                <div class="timetracker-total-time" id="timetracker-hero-time">۰ دقیقه</div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
                <div class="tool-tab-nav" style="margin-bottom:0; max-width:240px;">
                    <button class="tool-tab-btn active" id="tt-tab-today"><i class="fa fa-calendar-day"></i> امروز</button>
                    <button class="tool-tab-btn" id="tt-tab-all"><i class="fa fa-history"></i> کل تاریخچه</button>
                </div>
                ${isDesktopApp() ? `
                <div class="tool-tab-nav" style="margin-bottom:0; max-width:240px;">
                    <button class="tool-tab-btn active" id="tt-source-web"><i class="fa fa-globe"></i> وب‌گردی</button>
                    <button class="tool-tab-btn" id="tt-source-apps"><i class="fa fa-desktop"></i> برنامه‌ها</button>
                </div>
                ` : ''}
                <div style="display:flex; gap:0.5rem;">
                    <button class="btn-secondary" id="tt-ai-summary-btn" style="padding:0.35rem 0.7rem; font-size:0.75rem;"><i class="fa fa-robot"></i> خلاصه هفتگی با AI</button>
                    <button class="icon-btn" id="tt-refresh-btn" title="به‌روزرسانی"><i class="fa fa-sync-alt"></i></button>
                    <button class="btn-secondary" id="tt-clear-btn" style="padding:0.35rem 0.7rem; font-size:0.75rem; color:var(--danger-color);"><i class="fa fa-trash"></i> پاکسازی</button>
                </div>
            </div>

            <div id="timetracker-domains-list" style="max-height:320px; overflow-y:auto;">
                <p class="text-muted" style="text-align:center;">در حال دریافت آمار...</p>
            </div>
        </div>
    `;

    overlay.classList.add('active');

    let activeFilter = 'today';
    let activeSource = 'web'; // web | apps (apps only exists in the desktop build)

    async function getRawDomainStats() {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            return await new Promise((res) => {
                chrome.runtime.sendMessage({ action: 'get_domain_time_stats' }, (response) => {
                    res(response || {});
                });
            });
        }
        const { domainTimeTracker } = await storageGet({ domainTimeTracker: {} });
        return domainTimeTracker || {};
    }

    async function getRawAppStats() {
        return await window.__TAURI__.core.invoke('get_app_time_stats');
    }

    async function loadStats() {
        const stats = activeSource === 'apps' ? await getRawAppStats() : await getRawDomainStats();

        const d = new Date();
        const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        
        let targetMap = {};
        if (activeFilter === 'today') {
            targetMap = stats[todayKey] || {};
        } else {
            Object.values(stats).forEach(dayObj => {
                Object.entries(dayObj).forEach(([domain, sec]) => {
                    targetMap[domain] = (targetMap[domain] || 0) + sec;
                });
            });
        }

        const entries = Object.entries(targetMap).sort((a, b) => b[1] - a[1]);
        const totalSec = entries.reduce((acc, [, s]) => acc + s, 0);

        document.getElementById('timetracker-hero-time').textContent = formatSecondsFa(totalSec);

        const listEl = document.getElementById('timetracker-domains-list');
        if (entries.length === 0) {
            listEl.innerHTML = activeSource === 'apps'
                ? '<p class="text-muted" style="text-align:center; padding:2rem;">هنوز زمانی برای برنامه‌ای ثبت نشده. چند دقیقه با نرم‌افزارهای دیگه کار کن، بعد برگرد اینجا رو ببین.</p>'
                : '<p class="text-muted" style="text-align:center; padding:2rem;">هنوز زمانی برای سایتی ثبت نشده است. با وبگردی در تب‌های دیگر، زمان حضور شما به طور خودکار اینجا اضافه می‌شود.</p>';
            return;
        }

        const maxSec = entries[0][1] || 1;
        listEl.innerHTML = entries.map(([key, sec]) => {
            const pct = Math.round((sec / maxSec) * 100);
            const icon = activeSource === 'apps'
                ? '<i class="fa fa-desktop" style="font-size:0.9rem; color:var(--text-muted);"></i>'
                : `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(key)}&sz=32" data-fallback="icons/icon16.png" style="width:18px; height:18px; border-radius:4px;">`;
            return `
                <div class="domain-stat-item">
                    <div class="domain-stat-icon">
                        ${icon}
                    </div>
                    <div class="domain-stat-info">
                        <div class="domain-stat-name-row">
                            <span>${escapeHtml(key)}</span>
                            <span class="text-muted" style="font-family:sans-serif;">${formatSecondsFa(sec)}</span>
                        </div>
                        <div class="domain-stat-bar-track">
                            <div class="domain-stat-bar-fill" style="width:${pct}%;"></div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        wireImgFallbacks(listEl);
    }

    function formatSecondsFa(totalSeconds) {
        if (!totalSeconds || totalSeconds <= 0) return '۰ دقیقه';
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) return `${hours} ساعت و ${minutes} دقیقه`;
        if (minutes > 0) return `${minutes} دقیقه و ${seconds} ثانیه`;
        return `${seconds} ثانیه`;
    }

    document.getElementById('tt-tab-today').addEventListener('click', function() {
        this.classList.add('active');
        document.getElementById('tt-tab-all').classList.remove('active');
        activeFilter = 'today';
        loadStats();
    });
    document.getElementById('tt-tab-all').addEventListener('click', function() {
        this.classList.add('active');
        document.getElementById('tt-tab-today').classList.remove('active');
        activeFilter = 'all';
        loadStats();
    });
    if (isDesktopApp()) {
        document.getElementById('tt-source-web').addEventListener('click', function() {
            this.classList.add('active');
            document.getElementById('tt-source-apps').classList.remove('active');
            activeSource = 'web';
            loadStats();
        });
        document.getElementById('tt-source-apps').addEventListener('click', function() {
            this.classList.add('active');
            document.getElementById('tt-source-web').classList.remove('active');
            activeSource = 'apps';
            loadStats();
        });
    }
    document.getElementById('tt-refresh-btn').addEventListener('click', loadStats);
    document.getElementById('tt-ai-summary-btn').addEventListener('click', async () => {
        const stats = await getRawDomainStats();
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d2 = new Date();
            d2.setDate(d2.getDate() - i);
            days.push(`${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`);
        }
        const weekMap = {};
        days.forEach(key => {
            Object.entries(stats[key] || {}).forEach(([domain, sec]) => {
                weekMap[domain] = (weekMap[domain] || 0) + sec;
            });
        });
        const weekEntries = Object.entries(weekMap).sort((a, b) => b[1] - a[1]).slice(0, 15);
        if (weekEntries.length === 0) {
            await showAlert('هنوز آمار کافی برای هفته‌ی اخیر ثبت نشده.', 'خلاصه هفتگی وبگردی');
            return;
        }
        const summaryText = weekEntries.map(([domain, sec]) => `${domain}: ${formatSecondsFa(sec)}`).join('\n');
        askAIWithContext(
            'بر اساس این آمار زمان وبگردی هفت روز اخیر، بگو کجا بیشترین وقت صرف شده، آیا الگوی قابل‌توجهی (مثلاً پرت شدن حواس زیاد) هست، و ۲-۳ پیشنهاد عملی برای مدیریت بهتر زمان بده - همه به فارسی و خلاصه.',
            `آمار زمان حضور در سایت‌های مختلف طی ۷ روز اخیر:\n${summaryText}`,
            'خلاصه هفتگی وبگردی با AI'
        );
    });
    document.getElementById('tt-clear-btn').addEventListener('click', async () => {
        const ok = await showConfirm('آیا از پاکسازی تمام تاریخچه زمان‌های ثبت‌شده اطمینان دارید؟');
        if (!ok) return;
        if (activeSource === 'apps') {
            await window.__TAURI__.core.invoke('reset_app_time_stats');
            loadStats();
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ action: 'reset_domain_time_stats' }, loadStats);
        } else {
            await storageSet({ domainTimeTracker: {} });
            loadStats();
        }
    });

    loadStats();
}

// ==========================================================================
// 3. IRAN DEV & FINANCIAL IDENTIFIER TOOLKIT (Card, National ID, Sheba, Postal)
// ==========================================================================
const IRAN_BANK_LOGOS = {
    'melli': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#1e3a8a"/><circle cx="50" cy="50" r="38" fill="#d97706"/><circle cx="50" cy="50" r="28" fill="#1e3a8a"/><path d="M50 25 L55 42 L72 42 L58 53 L63 70 L50 59 L37 70 L42 53 L28 42 L45 42 Z" fill="#ffd700"/></svg>`,
    'mellat': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#dc2626"/><rect x="30" y="30" width="40" height="40" rx="8" fill="#991b1b"/><circle cx="50" cy="50" r="14" fill="#fbbf24"/></svg>`,
    'tejarat': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="20" fill="#0284c7"/><path d="M50 18 L76 50 L50 82 L24 50 Z" fill="#ffffff"/><path d="M50 32 L64 50 L50 68 L36 50 Z" fill="#0284c7"/></svg>`,
    'saderat': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#1e1b4b"/><circle cx="50" cy="50" r="38" fill="#3b82f6"/><path d="M50 20 C65 20 78 32 78 50 C78 68 65 80 50 80 C35 80 22 68 22 50 C22 32 35 20 50 20 Z" fill="none" stroke="#fbbf24" stroke-width="6"/><circle cx="50" cy="50" r="16" fill="#fbbf24"/></svg>`,
    'pasargad': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="18" fill="#18181b"/><circle cx="50" cy="50" r="36" fill="#eab308"/><path d="M42 32 C48 26 58 26 64 32 C68 36 68 44 64 48 C60 52 52 54 48 58 L48 68" fill="none" stroke="#18181b" stroke-width="6" stroke-linecap="round"/><circle cx="48" cy="74" r="3" fill="#18181b"/></svg>`,
    'saman': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="20" fill="#0369a1"/><path d="M50 16 L62 38 L84 50 L62 62 L50 84 L38 62 L16 50 L38 38 Z" fill="#38bdf8"/><circle cx="50" cy="50" r="12" fill="#ffffff"/></svg>`,
    'blu': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="24" fill="#2563eb"/><text x="50" y="62" font-size="34" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="sans-serif">blu</text></svg>`,
    'sepah': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#b45309"/><circle cx="50" cy="50" r="36" fill="#fef3c7"/><path d="M50 22 L58 40 L78 44 L62 58 L68 78 L50 66 L32 78 L38 58 L22 44 L42 40 Z" fill="#b45309"/></svg>`,
    'keshavarzi': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#15803d"/><path d="M50 20 C60 35 65 55 50 80 C35 55 40 35 50 20 Z" fill="#facc15"/><circle cx="50" cy="50" r="12" fill="#15803d"/></svg>`,
    'masken': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="20" fill="#c2410c"/><path d="M50 20 L80 48 L70 48 L70 78 L30 78 L30 48 L20 48 Z" fill="#fed7aa"/><rect x="42" y="54" width="16" height="24" rx="3" fill="#c2410c"/></svg>`,
    'parsian': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="18" fill="#854d0e"/><path d="M50 22 C65 35 75 55 50 78 C25 55 35 35 50 22 Z" fill="#fef08a"/><circle cx="50" cy="50" r="14" fill="#854d0e"/></svg>`,
    'shahr': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="18" fill="#ea580c"/><circle cx="50" cy="50" r="32" fill="#fed7aa"/><path d="M36 50 L50 36 L64 50 L50 64 Z" fill="#ea580c"/></svg>`,
    'ayandeh': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="20" fill="#7e22ce"/><path d="M30 30 L70 30 L50 70 Z" fill="#f3e8ff"/><circle cx="50" cy="44" r="10" fill="#7e22ce"/></svg>`,
    'resalat': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#0d9488"/><path d="M50 24 L72 50 L50 76 L28 50 Z" fill="#ccfbf1"/><circle cx="50" cy="50" r="12" fill="#0d9488"/></svg>`,
    'mehr': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#16a34a"/><path d="M50 30 C58 20 72 24 72 38 C72 54 50 68 50 68 C50 68 28 54 28 38 C28 24 42 20 50 30 Z" fill="#dcfce7"/></svg>`,
    'refah': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#1e3a8a"/><path d="M30 40 C30 30 70 30 70 40 C70 55 50 60 50 75" fill="none" stroke="#60a5fa" stroke-width="8" stroke-linecap="round"/></svg>`,
    'sina': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="18" fill="#0f766e"/><circle cx="50" cy="50" r="32" fill="#99f6e4"/><circle cx="50" cy="50" r="16" fill="#0f766e"/></svg>`,
    'en': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#4d7c0f"/><path d="M32 32 H68 V46 H46 V54 H64 V68 H32 Z" fill="#ecfccb"/></svg>`,
    'dey': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><rect x="6" y="6" width="88" height="88" rx="18" fill="#be123c"/><circle cx="50" cy="50" r="30" fill="#ffe4e6"/><path d="M40 35 H55 C65 35 65 65 55 65 H40 Z" fill="#be123c"/></svg>`,
    'default': `<svg viewBox="0 0 100 100" class="bank-logo-svg"><circle cx="50" cy="50" r="46" fill="#334155"/><path d="M50 25 L75 40 L75 75 L25 75 L25 40 Z" fill="#94a3b8"/></svg>`
};

const IRAN_BANKS = {
    '603799': { name: 'بانک ملی ایران', color: 'linear-gradient(135deg, #1e3a8a, #0f172a)', logoKey: 'melli' },
    '610433': { name: 'بانک ملت', color: 'linear-gradient(135deg, #b91c1c, #450a0a)', logoKey: 'mellat' },
    '627353': { name: 'بانک تجارت', color: 'linear-gradient(135deg, #0369a1, #082f49)', logoKey: 'tejarat' },
    '628023': { name: 'بانک مسکن', color: 'linear-gradient(135deg, #c2410c, #431407)', logoKey: 'masken' },
    '627412': { name: 'بانک اقتصاد نوین', color: 'linear-gradient(135deg, #4d7c0f, #14532d)', logoKey: 'en' },
    '622106': { name: 'بانک پارسیان', color: 'linear-gradient(135deg, #854d0e, #365314)', logoKey: 'parsian' },
    '502229': { name: 'بانک پاسارگاد', color: 'linear-gradient(135deg, #ca8a04, #18181b)', logoKey: 'pasargad' },
    '621986': { name: 'بانک سامان', color: 'linear-gradient(135deg, #0284c7, #0369a1)', logoKey: 'saman' },
    '639346': { name: 'بانک سینا', color: 'linear-gradient(135deg, #0d9488, #115e59)', logoKey: 'sina' },
    '636214': { name: 'بانک آینده', color: 'linear-gradient(135deg, #9333ea, #4c1d95)', logoKey: 'ayandeh' },
    '502806': { name: 'بانک شهر', color: 'linear-gradient(135deg, #ea580c, #7c2d12)', logoKey: 'shahr' },
    '603770': { name: 'بانک کشاورزی', color: 'linear-gradient(135deg, #15803d, #14532d)', logoKey: 'keshavarzi' },
    '603769': { name: 'بانک صادرات ایران', color: 'linear-gradient(135deg, #1e1b4b, #312e81)', logoKey: 'saderat' },
    '589210': { name: 'بانک سپه', color: 'linear-gradient(135deg, #d97706, #78350f)', logoKey: 'sepah' },
    '589463': { name: 'بانک رفاه کارگران', color: 'linear-gradient(135deg, #0284c7, #1e3a8a)', logoKey: 'refah' },
    '606373': { name: 'بانک قرض‌الحسنه مهر ایران', color: 'linear-gradient(135deg, #16a34a, #065f46)', logoKey: 'mehr' },
    '504172': { name: 'بانک رسالت', color: 'linear-gradient(135deg, #0d9488, #115e59)', logoKey: 'resalat' },
    '604932': { name: 'بلو بانک (سامان)', color: 'linear-gradient(135deg, #2563eb, #38bdf8)', logoKey: 'blu' },
    '581874': { name: 'بانک ایران زمین', color: 'linear-gradient(135deg, #7c3aed, #4c1d95)', logoKey: 'ayandeh' },
    '505416': { name: 'بانک گردشگری', color: 'linear-gradient(135deg, #0284c7, #0f766e)', logoKey: 'saman' },
    '502908': { name: 'بانک توسعه تعاون', color: 'linear-gradient(135deg, #059669, #047857)', logoKey: 'keshavarzi' },
    '502938': { name: 'بانک دی', color: 'linear-gradient(135deg, #be123c, #881337)', logoKey: 'dey' },
    '627760': { name: 'پست بانک ایران', color: 'linear-gradient(135deg, #15803d, #166534)', logoKey: 'keshavarzi' }
};

function openIranDevTool() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = '<i class="fa fa-id-card" style="color:#22c55e;"></i> جعبه‌ابزار اعتبارسنجی ایرانی و بانکی';
    body.innerHTML = `
        <div class="tool-tab-nav">
            <button class="tool-tab-btn active" id="idev-tab-card"><i class="fa fa-credit-card"></i> کارت بانکی و شبا</button>
            <button class="tool-tab-btn" id="idev-tab-national"><i class="fa fa-id-card"></i> کد ملی</button>
            <button class="tool-tab-btn" id="idev-tab-company"><i class="fa fa-building"></i> شناسه ملی و کد پستی</button>
        </div>

        <!-- Tab 1: Bank Card & Sheba -->
        <div id="idev-content-card">
            <div class="bank-card-container">
                <div class="bank-card-preview" id="preview-bank-card">
                    <div class="bank-card-top">
                        <div class="bank-card-name bank-card-logo-wrap" id="preview-bank-name">
                            <span id="preview-bank-logo">${IRAN_BANK_LOGOS.default}</span>
                            <span id="preview-bank-title">کارت شتاب</span>
                        </div>
                        <div class="bank-card-chip"></div>
                    </div>
                    <div class="bank-card-number" id="preview-card-num">•••• •••• •••• ••••</div>
                    <div class="bank-card-bottom">
                        <div><span>عضو رسمی شبکه شتاب</span></div>
                        <div id="preview-card-status" class="bank-card-status-badge">در انتظار ورودی</div>
                    </div>
                </div>
            </div>

            <div style="display:flex; flex-direction:column; gap:0.75rem; max-width:440px; margin:0 auto;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">شماره کارت بانکی (۱۶ رقم)</label>
                    <input type="text" id="idev-card-input" placeholder="6037 99xx xxxx xxxx" style="width:100%; padding:0.7rem; border-radius:10px; direction:ltr; text-align:center; font-family:monospace; font-size:1.1rem; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                </div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">شماره شبا (IBAN)</label>
                    <input type="text" id="idev-sheba-input" placeholder="IR00 0000 0000 0000 0000 0000 00" style="width:100%; padding:0.7rem; border-radius:10px; direction:ltr; text-align:left; font-family:monospace; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                    <div id="idev-sheba-result" style="font-size:0.85rem; margin-top:4px;"></div>
                    <div id="idev-sheba-account" style="font-size:0.85rem; margin-top:4px;"></div>
                </div>
                <div style="border-top:1px solid var(--glass-border); padding-top:0.75rem;">
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">تبدیل شماره حساب به شبا (فقط بانک‌های تأییدشده)</label>
                    <div class="custom-select" id="idev-conv-bank" style="margin-bottom:0.5rem;"></div>
                    <input type="text" id="idev-conv-account" inputmode="numeric" placeholder="شماره حساب (فقط رقم)" style="width:100%; padding:0.7rem; border-radius:10px; direction:ltr; text-align:center; font-family:monospace; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                    <div id="idev-conv-result" style="font-size:0.85rem; margin-top:6px; direction:ltr; text-align:left; font-family:monospace; word-break:break-all;"></div>
                    <p class="text-muted" style="font-size:0.72rem; margin-top:6px; line-height:1.7;">قاعده‌ی تبدیل این بانک‌ها رسمی منتشر نشده و با نمونه‌های واقعی سنجیده شده؛ پیش از واریز، نام صاحب حساب را در اپ بانک تأیید کن. کارت ← شبا/حساب بدون سرویس استعلام بانکی ممکن نیست.</p>
                </div>
            </div>
        </div>

        <!-- Tab 2: National ID -->
        <div id="idev-content-national" style="display:none; max-width:440px; margin:0 auto;">
            <div style="display:flex; flex-direction:column; gap:1rem;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">کد ملی ۱۰ رقمی</label>
                    <input type="text" id="idev-national-input" placeholder="مثال: 0012345678" maxlength="10" style="width:100%; padding:0.7rem; border-radius:10px; direction:ltr; text-align:center; font-family:monospace; font-size:1.2rem; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                </div>
                <div id="idev-national-result" style="padding:1.2rem; border-radius:12px; background:rgba(128,128,128,0.06); border:1px solid var(--glass-border); text-align:center; font-weight:600; line-height:1.7;">
                    کد ملی را وارد کنید
                </div>
                <button class="btn-secondary" id="idev-gen-national-btn"><i class="fa fa-dice"></i> تولید کد ملی تصادفی معتبر (تست نرم‌افزار)</button>
            </div>
        </div>

        <!-- Tab 3: Company & Postal -->
        <div id="idev-content-company" style="display:none; max-width:440px; margin:0 auto;">
            <div style="display:flex; flex-direction:column; gap:1rem;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">شناسه ملی اشخاص حقوقی و شرکت‌ها (۱۱ رقم)</label>
                    <input type="text" id="idev-company-input" placeholder="مثال: 10100000000" maxlength="11" style="width:100%; padding:0.7rem; border-radius:10px; direction:ltr; text-align:center; font-family:monospace; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                    <div id="idev-company-result" style="font-size:0.85rem; margin-top:4px;"></div>
                </div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">کد پستی ۱۰ رقمی</label>
                    <input type="text" id="idev-postal-input" placeholder="مثال: 1987654321" maxlength="10" style="width:100%; padding:0.7rem; border-radius:10px; direction:ltr; text-align:center; font-family:monospace; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                    <div id="idev-postal-result" style="font-size:0.85rem; margin-top:4px;"></div>
                </div>
            </div>
        </div>
    `;

    overlay.classList.add('active');

    // Tab Navigation
    const tabs = ['card', 'national', 'company'];
    tabs.forEach(t => {
        document.getElementById(`idev-tab-${t}`).addEventListener('click', () => {
            tabs.forEach(o => {
                document.getElementById(`idev-tab-${o}`).classList.toggle('active', o === t);
                document.getElementById(`idev-content-${o}`).style.display = (o === t) ? 'block' : 'none';
            });
        });
    });

    // Card Input Handler
    const cardInput = document.getElementById('idev-card-input');
    const previewNum = document.getElementById('preview-card-num');
    const previewTitle = document.getElementById('preview-bank-title');
    const previewLogo = document.getElementById('preview-bank-logo');
    const previewStatus = document.getElementById('preview-card-status');
    const previewCard = document.getElementById('preview-bank-card');

    cardInput.addEventListener('input', (e) => {
        let val = e.target.value.replace(/\D/g, '').substring(0, 16);
        let formatted = val.match(/.{1,4}/g)?.join(' ') || val;
        e.target.value = formatted;

        previewNum.textContent = formatted || '•••• •••• •••• ••••';

        const bin = val.substring(0, 6);
        const bank = IRAN_BANKS[bin];
        if (bank) {
            previewTitle.textContent = bank.name;
            previewLogo.innerHTML = IRAN_BANK_LOGOS[bank.logoKey] || IRAN_BANK_LOGOS.default;
            previewCard.style.background = bank.color;
        } else {
            previewTitle.textContent = 'کارت شتاب';
            previewLogo.innerHTML = IRAN_BANK_LOGOS.default;
            previewCard.style.background = 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)';
        }

        if (val.length === 16) {
            const isValid = validateLuhn(val);
            previewStatus.className = 'bank-card-status-badge ' + (isValid ? 'badge-valid' : 'badge-invalid');
            previewStatus.innerHTML = isValid ? '<i class="fa fa-check-circle"></i> معتبر' : '<i class="fa fa-times-circle"></i> نامعتبر (چک‌سام غلط)';
        } else {
            previewStatus.className = 'bank-card-status-badge';
            previewStatus.textContent = val.length > 0 ? `${val.length}/16 رقم` : 'در انتظار ورودی';
        }
    });

    // Sheba Input Handler
    document.getElementById('idev-sheba-input').addEventListener('input', (e) => {
        const val = e.target.value.trim();
        const resEl = document.getElementById('idev-sheba-result');
        if (!val) { resEl.innerHTML = ''; return; }
        const res = validateSheba(val);
        resEl.innerHTML = `<span style="color:${res.valid ? '#32d74b' : '#ff453a'}; font-weight:600;"><i class="fa fa-${res.valid ? 'check' : 'times'}"></i> ${res.message}</span>`;

        const accEl = document.getElementById('idev-sheba-account');
        if (!res.valid) { accEl.innerHTML = ''; return; }
        const acc = shebaToAccount(val);
        accEl.innerHTML = acc.ok
            ? `<span style="font-weight:600;">شماره حساب (${acc.bankName}): <span style="font-family:monospace; direction:ltr; display:inline-block; color:var(--primary-color);">${escapeHtml(acc.account)}</span></span>`
            : `<span class="text-muted">${escapeHtml(acc.message)}</span>`;
    });

    // Account -> Sheba (verified banks only)
    let convBank = '017';
    const convAccount = document.getElementById('idev-conv-account');
    const convResult = document.getElementById('idev-conv-result');
    function runConversion() {
        if (!convAccount.value.trim()) { convResult.innerHTML = ''; return; }
        const r = accountToSheba(convBank, convAccount.value);
        convResult.innerHTML = r.ok
            ? `<span style="color:#32d74b; font-weight:700;">${r.sheba}</span>`
            : `<span style="color:#ff453a; font-family:inherit; direction:rtl; display:inline-block;">${escapeHtml(r.message)}</span>`;
    }
    initDropdown(
        document.getElementById('idev-conv-bank'),
        Object.entries(SHEBA_ACCOUNT_BANKS).map(([code, b]) => ({ value: code, label: `${b.name} (${code})` })),
        convBank,
        (value) => { convBank = value; runConversion(); }
    );
    convAccount.addEventListener('input', runConversion);

    // National Code Handler
    const nationalInput = document.getElementById('idev-national-input');
    const nationalResult = document.getElementById('idev-national-result');

    function evalNationalCode(code) {
        if (!code) {
            nationalResult.textContent = 'کد ملی را وارد کنید';
            nationalResult.style.color = 'var(--text-muted)';
            return;
        }
        const res = validateNationalCode(code);
        if (res.valid) {
            nationalResult.innerHTML = `
                <div style="color:#32d74b; font-size:1.05rem; margin-bottom:6px;"><i class="fa fa-check-circle"></i> ${res.message}</div>
                <div style="font-size:0.95rem; color:var(--text-color);">استان و شهر صدور: <strong style="color:var(--primary-color); font-size:1.05rem;">${res.city}</strong></div>
            `;
        } else {
            nationalResult.innerHTML = `<span style="color:#ff453a;"><i class="fa fa-times-circle"></i> ${res.message}</span>`;
        }
    }

    nationalInput.addEventListener('input', (e) => evalNationalCode(e.target.value));
    document.getElementById('idev-gen-national-btn').addEventListener('click', () => {
        const rnd = generateRandomNationalCode();
        nationalInput.value = rnd;
        evalNationalCode(rnd);
    });

    // Company National ID
    document.getElementById('idev-company-input').addEventListener('input', (e) => {
        const clean = e.target.value.replace(/\D/g, '');
        const resEl = document.getElementById('idev-company-result');
        if (clean.length !== 11) {
            resEl.innerHTML = clean.length > 0 ? `<span class="text-muted">${clean.length}/11 رقم</span>` : '';
            return;
        }
        const isValid = validateCompanyCode(clean);
        resEl.innerHTML = `<span style="color:${isValid ? '#32d74b' : '#ff453a'}; font-weight:600;"><i class="fa fa-${isValid ? 'check' : 'times'}"></i> ${isValid ? 'شناسه ملی شرکت معتبر است' : 'شناسه ملی نامعتبر است'}</span>`;
    });

    // Postal Code
    document.getElementById('idev-postal-input').addEventListener('input', (e) => {
        const clean = e.target.value.replace(/\D/g, '');
        const resEl = document.getElementById('idev-postal-result');
        if (clean.length !== 10) {
            resEl.innerHTML = clean.length > 0 ? `<span class="text-muted">${clean.length}/10 رقم</span>` : '';
            return;
        }
        const isValid = !clean.includes('0') && !clean.includes('2') && !/^(\d)\1{9}$/.test(clean);
        resEl.innerHTML = `<span style="color:${isValid ? '#32d74b' : '#ff453a'}; font-weight:600;"><i class="fa fa-${isValid ? 'check' : 'times'}"></i> ${isValid ? 'فرمت کد پستی معتبر است' : 'کد پستی شامل ارقام غیرمجاز یا تکراری است'}</span>`;
    });
}

function validateLuhn(str) {
    let sum = 0;
    for (let i = 0; i < 16; i++) {
        let val = parseInt(str.charAt(i), 10);
        if (i % 2 === 0) {
            val *= 2;
            if (val > 9) val -= 9;
        }
        sum += val;
    }
    return sum % 10 === 0;
}

function validateSheba(iban) {
    let clean = String(iban).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean.startsWith('IR')) clean = 'IR' + clean;
    if (clean.length !== 26) return { valid: false, message: 'شماره شبا باید ۲۶ کاراکتر (IR + ۲۴ رقم) باشد.' };

    const bCode = clean.substring(4, 7);
    const bankMap = {
        '010': 'مرکزی', '011': 'صنعت و معدن', '012': 'ملت', '013': 'رفاه', '014': 'مسکن',
        '015': 'سپه', '016': 'کشاورزی', '017': 'ملی', '018': 'تجارت', '019': 'صادرات',
        '020': 'توسعه صادرات', '021': 'پست بانک', '051': 'توسعه', '052': 'قوامین', '053': 'کارآفرین',
        '054': 'پارسیان', '055': 'اقتصاد نوین', '056': 'سامان', '057': 'پاسارگاد', '058': 'سرمایه',
        '059': 'سینا', '060': 'مهر ایران', '061': 'شهر', '062': 'آینده', '063': 'انصار',
        '064': 'گردشگری', '065': 'حکمت', '066': 'دی', '069': 'ایران زمین', '070': 'رسالت'
    };

    const rearranged = clean.substring(4) + '1827' + clean.substring(2, 4);
    let remainder = 0;
    for (let i = 0; i < rearranged.length; i++) {
        remainder = (remainder * 10 + parseInt(rearranged.charAt(i), 10)) % 97;
    }
    const isValid = (remainder === 1);
    const bankName = bankMap[bCode] ? `بانک ${bankMap[bCode]}` : 'بانک شتاب';
    return { valid: isValid, bank: bankName, message: isValid ? `شبا معتبر است (${bankName})` : 'چک‌سام شبا نامعتبر است.' };
}

// Account <-> Sheba conversion, ONLY for banks whose rule has been checked against real
// samples (saeedaliakbari/sheba-converter). The 19-digit national part of a Sheba is not
// officially published, so banks without a verified rule are deliberately left out
// instead of guessed - a wrong conversion could send money to the wrong account.
const padAccount19 = (acc) => acc.padStart(19, '0');
const stripLeadingZeros = (p) => p.replace(/^0+/, '') || '0';
const SHEBA_ACCOUNT_BANKS = {
    '017': { name: 'بانک ملی ایران', maxLen: 19, encode: padAccount19, decode: (p) => p.slice(-13).replace(/^0+/, '') || '0' },
    '015': { name: 'بانک سپه', maxLen: 19, encode: padAccount19, decode: stripLeadingZeros },
    '019': { name: 'بانک صادرات ایران', maxLen: 19, encode: padAccount19, decode: stripLeadingZeros },
    '056': { name: 'بانک سامان', maxLen: 19, encode: padAccount19, decode: stripLeadingZeros },
    '060': { name: 'بانک قرض‌الحسنه مهر ایران', maxLen: 19, encode: padAccount19, decode: stripLeadingZeros },
    '078': { name: 'بانک خاورمیانه', maxLen: 19, encode: padAccount19, decode: stripLeadingZeros },
    '013': {
        name: 'بانک رفاه کارگران', maxLen: 17,
        encode: (acc) => '01' + acc.padStart(17, '0'),
        decode: (p) => p.slice(2).replace(/^0+/, '') || '0'
    },
    // Format branch(4)-subbranch(3)-serial(7)-type(1) = exactly 15 digits
    '058': { name: 'بانک سرمایه', exactLen: 15, encode: encodeSplit15, decode: decodeSplit15 },
    '069': { name: 'بانک ایران زمین', exactLen: 15, encode: encodeSplit15, decode: decodeSplit15 }
};

function encodeSplit15(acc) {
    return '0' + acc.slice(0, 7) + '0' + acc.slice(7, 14) + acc.slice(14).padStart(3, '0');
}
function decodeSplit15(p) {
    if (p.length === 19 && p[0] === '0' && p[8] === '0') {
        return p.slice(1, 8) + p.slice(9, 16) + (p.slice(16, 19).replace(/^0+/, '') || '0');
    }
    return null;
}

function mod97(numStr) {
    let rem = 0;
    for (let i = 0; i < numStr.length; i++) rem = (rem * 10 + (numStr.charCodeAt(i) - 48)) % 97;
    return rem;
}

function accountToSheba(bankCode, accountRaw) {
    const bank = SHEBA_ACCOUNT_BANKS[bankCode];
    if (!bank) return { ok: false, message: 'برای این بانک قاعده‌ی تأییدشده وجود ندارد.' };
    const digits = String(accountRaw || '').replace(/[^0-9]/g, '');
    if (!digits) return { ok: false, message: 'شماره حساب را وارد کنید.' };
    if (bank.exactLen && digits.length !== bank.exactLen) return { ok: false, message: `شماره حساب ${bank.name} باید دقیقاً ${bank.exactLen} رقم باشد (بدون خط‌تیره).` };
    if (digits.length > bank.maxLen) return { ok: false, message: `شماره حساب ${bank.name} حداکثر ${bank.maxLen} رقم است.` };
    const national = bank.encode(digits);
    if (national.length !== 19) return { ok: false, message: 'ساخت بخش ۱۹رقمی ناموفق بود.' };
    const body = bankCode + national;
    const check = String(98 - mod97(body + '182700')).padStart(2, '0');
    return { ok: true, sheba: 'IR' + check + body, bankName: bank.name };
}

function shebaToAccount(shebaRaw) {
    const res = validateSheba(shebaRaw);
    if (!res.valid) return { ok: false, message: res.message };
    let clean = String(shebaRaw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean.startsWith('IR')) clean = 'IR' + clean;
    const code = clean.slice(4, 7);
    const bank = SHEBA_ACCOUNT_BANKS[code];
    if (!bank) return { ok: false, unsupported: true, message: 'برای این بانک قاعده‌ی تأییدشده‌ای نیست؛ شماره حساب را از اپ بانک بگیر.' };
    const account = bank.decode(clean.slice(7));
    if (!account) return { ok: false, message: 'الگوی شبا با قاعده‌ی این بانک نمی‌خواند.' };
    return { ok: true, account, bankName: bank.name };
}

function validateNationalCode(code) {
    code = String(code).trim().replace(/[^\d]/g, '');
    if (code.length !== 10) return { valid: false, message: 'کد ملی باید ۱۰ رقم باشد.' };
    if (/^(\d)\1{9}$/.test(code)) return { valid: false, message: 'کد ملی نامعتبر است (ارقام تکراری).' };

    let sum = 0;
    for (let i = 0; i < 9; i++) {
        sum += parseInt(code.charAt(i), 10) * (10 - i);
    }
    let remainder = sum % 11;
    let checkDigit = parseInt(code.charAt(9), 10);

    let isValid = (remainder < 2 && checkDigit === remainder) || (remainder >= 2 && checkDigit === (11 - remainder));
    if (!isValid) return { valid: false, message: 'رقم کنترلی کد ملی نادرست است.' };

    const prefix = code.substring(0, 3);
    const city = getCityByNationalCodePrefix(prefix);
    return { valid: true, city: city, message: 'کد ملی معتبر و صحیح است.' };
}

function generateRandomNationalCode() {
    let code = '';
    for (let i = 0; i < 9; i++) {
        code += Math.floor(Math.random() * 10);
    }
    let sum = 0;
    for (let i = 0; i < 9; i++) {
        sum += parseInt(code.charAt(i), 10) * (10 - i);
    }
    let remainder = sum % 11;
    let checkDigit = remainder < 2 ? remainder : (11 - remainder);
    return code + checkDigit;
}

function validateCompanyCode(code) {
    if (code.length !== 11) return false;
    const d = code.split('').map(Number);
    const coeff = [29, 27, 23, 19, 17, 29, 27, 23, 19, 17];
    let sum = 0;
    for (let i = 0; i < 10; i++) {
        sum += (d[i] + d[10] + 2) * coeff[i];
    }
    let rem = sum % 11;
    if (rem === 10) rem = 0;
    return rem === d[10];
}

// Complete Iranian Province and City National Code Prefix Database
function getCityByNationalCodePrefix(p) {
    const map = {
        // تهران
        '001': 'تهران (مرکزی)', '002': 'تهران (شمال)', '003': 'تهران (جنوب)', '004': 'تهران (شرق)', '005': 'تهران (غرب)',
        '006': 'تهران', '007': 'تهران', '008': 'تهران', '011': 'اسلامشهر', '020': 'بهارستان', '025': 'پاکدشت',
        '041': 'دماوند', '042': 'دماوند', '043': 'رباط کریم', '044': 'شمیرانات / تجریش', '045': 'شمیرانات / لواسان',
        '048': 'شهر ری', '049': 'شهر ری', '050': 'شهریار', '054': 'فیروزکوه', '057': 'شهر قدس', '058': 'ملارد',
        '059': 'ورامین', '060': 'پیشوا', '061': 'قرچک', '062': 'پردیس',
        // البرز
        '031': 'کرج (مرکزی)', '032': 'کرج', '037': 'ساوجبلاغ / هشتگرد', '483': 'طالقان', '484': 'طالقان',
        '488': 'نظرآباد', '490': 'اشتهارد', '491': 'فردیس',
        // اصفهان
        '127': 'اصفهان (مرکزی)', '128': 'اصفهان', '129': 'اصفهان', '114': 'اصفهان', '108': 'آران و بیدگل',
        '109': 'آران و بیدگل', '115': 'اردستان', '116': 'برخوار', '117': 'تیران و کرون', '118': 'چادگان',
        '119': 'خمینی شهر', '120': 'خوانسار', '121': 'خور و بیابانک', '122': 'دهاقان', '123': 'سمیرم',
        '124': 'شاهین شهر', '125': 'شهرضا', '126': 'فریدن', '564': 'فریدونشهر', '575': 'فلاورجان',
        '619': 'کاشان', '620': 'کاشان', '621': 'کاشان', '622': 'گلپایگان', '623': 'لنجان / زرین شهر',
        '624': 'مبارکه', '625': 'نایین', '626': 'نجف آباد', '627': 'نطنز',
        // آذربایجان شرقی
        '136': 'تبریز (مرکزی)', '137': 'تبریز', '138': 'تبریز', '171': 'بناب', '172': 'بستان آباد',
        '505': 'جلفا', '506': 'سراب', '519': 'شبستر', '520': 'عجب شیر', '545': 'کلیبر', '558': 'مراغه',
        '559': 'مرند', '567': 'میانه', '604': 'هریس', '605': 'هشترود', '637': 'ورزقان', '648': 'اسکو',
        '677': 'ملکان', '682': 'چاراویماق', '689': 'آذرشهر', '708': 'خداآفرین',
        // آذربایجان غربی
        '274': 'ارومیه (مرکزی)', '275': 'ارومیه', '284': 'اشنویه', '285': 'بوکان', '289': 'پلدشت',
        '290': 'پیرانشهر', '291': 'تکاب', '292': 'چالدران', '293': 'خوی', '294': 'سردشت', '295': 'سلماس',
        '296': 'شاهین دژ', '297': 'ماکو', '298': 'مهاباد', '299': 'میاندوآب', '300': 'نقده', '301': 'شوط', '302': 'چایپاره',
        // اردبیل
        '091': 'اردبیل', '145': 'اردبیل (مرکزی)', '146': 'اردبیل', '161': 'بیله سوار', '162': 'بیله سوار',
        '166': 'پارس آباد', '167': 'پارس آباد', '173': 'خلخال', '504': 'سرعین', '566': 'مشگین شهر',
        '601': 'نمین', '602': 'نیر', '603': 'کوثر', '681': 'گرمی',
        // ایلام
        '449': 'ایلام (مرکزی)', '450': 'ایلام', '454': 'ایوان', '455': 'آبدانان', '534': 'دره شهر',
        '581': 'دهلران', '616': 'شیروان و چرداول', '634': 'مهران', '675': 'ملکشاهی', '680': 'بدره',
        // بوشهر
        '349': 'بوشهر (مرکزی)', '350': 'بوشهر', '353': 'تنگستان', '354': 'جم', '355': 'دشتستان / برازجان',
        '356': 'دشتی / خورموج', '357': 'دیر', '528': 'دیلم', '532': 'عسلویه', '533': 'کنگان', '562': 'گناوه',
        // چهارمحال و بختیاری
        '461': 'شهرکرد (مرکزی)', '462': 'شهرکرد', '465': 'بروجن', '466': 'اردل', '467': 'فارسان',
        '468': 'کوهرنگ', '632': 'لردگان', '633': 'کیار', '685': 'سامان', '686': 'بن',
        // خراسان جنوبی
        '064': 'بیرجند (مرکزی)', '065': 'بیرجند', '087': 'درمیان', '088': 'سرایان', '089': 'سربیشه',
        '523': 'فردوس', '524': 'بشرویه', '563': 'قائنات', '679': 'نهبندان', '705': 'خوسف', '706': 'زیرکوه',
        // خراسان رضوی
        '092': 'مشهد (مرکزی)', '093': 'مشهد', '094': 'مشهد', '070': 'باخرز', '072': 'بردسکن',
        '073': 'تایباد', '074': 'تربت جام', '075': 'تربت حیدریه', '076': 'چناران', '077': 'خلیل آباد',
        '078': 'خواف', '079': 'درگز', '080': 'رشتخوار', '081': 'زاوه', '082': 'سبزوار', '083': 'سرخس',
        '084': 'فریمان', '085': 'قوچان', '086': 'کاشمر', '090': 'کلات', '521': 'گناباد', '522': 'بجستان',
        '572': 'نیشابور', '573': 'فیروزه', '574': 'مه ولات', '678': 'طرقبه شاندیز', '707': 'داورزن',
        // خراسان شمالی
        '067': 'بجنورد (مرکزی)', '068': 'بجنورد', '063': 'اسفراین', '071': 'جاجرم', '525': 'شیروان',
        '591': 'فاروج', '635': 'مانه و سملقان', '684': 'گرمه', '704': 'راز و جرگلان',
        // خوزستان
        '174': 'اهواز (مرکزی)', '175': 'اهواز', '181': 'آبادان', '182': 'آبادان', '183': 'امیدیه',
        '184': 'اندیمشک', '185': 'ایذه', '186': 'باغملک', '187': 'بندر ماهشهر', '188': 'بهبهان',
        '189': 'خرمشهر', '190': 'دزفول', '191': 'دشت آزادگان / سوسنگرد', '192': 'رامشیر', '193': 'رامهرمز',
        '194': 'شادگان', '195': 'شوش', '196': 'شوشتر', '197': 'کارون', '198': 'مسجد سلیمان', '199': 'هندیجان',
        '200': 'هویزه', '526': 'گتوند', '527': 'باوی', '683': 'لالی', '693': 'اندیکا', '694': 'هفتکل',
        // زنجان
        '427': 'زنجان (مرکزی)', '428': 'زنجان', '429': 'ابهر', '430': 'ایجرود', '431': 'خدابنده',
        '432': 'خرمدره', '507': 'طارم', '508': 'ماهنشان', '640': 'سلطانیه',
        // سمنان
        '456': 'سمنان (مرکزی)', '457': 'سمنان', '458': 'دامغان', '459': 'شاهرود', '460': 'گرمسار',
        '530': 'مهدی شهر', '531': 'میامی', '687': 'آرادان', '688': 'سرخه',
        // سیستان و بلوچستان
        '361': 'زاهدان (مرکزی)', '362': 'زاهدان', '358': 'ایرانشهر', '359': 'چابهار', '360': 'خاش',
        '363': 'زابل', '364': 'سراوان', '365': 'سرباز', '366': 'نیک شهر', '367': 'کنارک', '701': 'زهک',
        '702': 'دلگان', '703': 'هیرمند',
        // فارس
        '228': 'شیراز (مرکزی)', '229': 'شیراز', '230': 'شیراز', '236': 'آباده', '237': 'ارسنجان',
        '238': 'استهبان', '239': 'اقلید', '240': 'بوانات', '241': 'پاسارگاد', '242': 'جهرم',
        '243': 'خرامه', '244': 'خرم بید', '245': 'خنج', '246': 'داراب', '247': 'رستم', '248': 'زرین دشت',
        '249': 'سپیدان', '250': 'سروستان', '251': 'فراشبند', '252': 'فسا', '253': 'فیروزآباد',
        '254': 'قیر و کارزین', '255': 'کازرون', '256': 'کوار', '257': 'گراش', '513': 'لارستان',
        '514': 'لامرد', '515': 'مرودشت', '546': 'ممسنی', '547': 'مهر', '548': 'نی ریز',
        // قزوین
        '438': 'قزوین (مرکزی)', '439': 'قزوین', '433': 'آبیک', '434': 'البرز / الوند', '435': 'بویین زهرا',
        '509': 'تاکستان', '588': 'آوج',
        // قم
        '037': 'قم (مرکزی)', '038': 'قم',
        // کردستان
        '372': 'سنندج (مرکزی)', '373': 'سنندج', '375': 'بانه', '376': 'بیجار', '377': 'دهگلان',
        '378': 'دیواندره', '379': 'سروآباد', '380': 'سقز', '381': 'قروه', '382': 'کامیاران', '383': 'مریوان',
        // کرمان
        '297': 'کرمان (مرکزی)', '305': 'کرمان', '306': 'کرمان', '307': 'انار', '308': 'بافت',
        '309': 'بردسیر', '310': 'بم', '311': 'جیرفت', '312': 'رابر', '313': 'راور', '314': 'رفسنجان',
        '315': 'رودبار جنوب', '316': 'ریگان', '317': 'زرند', '318': 'سیرجان', '319': 'شهربابک',
        '320': 'عنبرآباد', '321': 'فاریاب', '322': 'قلعه گنج', '323': 'منوجان', '582': 'کهنوج', '583': 'نرماشیر',
        // کرمانشاه
        '386': 'کرمانشاه (مرکزی)', '387': 'کرمانشاه', '324': 'اسلام آباد غرب', '325': 'پاوه',
        '333': 'ثلاث باباجانی', '334': 'جوانرود', '335': 'دالاهو', '336': 'روانسر', '337': 'سرپل ذهاب',
        '338': 'سنقر', '339': 'صحنه', '594': 'قصر شیرین', '595': 'کنگاور', '596': 'گیلانغرب', '597': 'هرسین',
        // کهگیلویه و بویراحمد
        '422': 'یاسوج / بویراحمد', '423': 'یاسوج', '424': 'بهمئی', '425': 'دنا / سی سخت',
        '426': 'کهگیلویه / دهدشت', '555': 'گچساران / دوگنبدان', '638': 'چرام', '639': 'باشت', '674': 'لنده',
        // گلستان
        '211': 'گرگان (مرکزی)', '212': 'گرگان', '213': 'آزادشهر', '214': 'آق قلا', '215': 'بندر گز',
        '216': 'بندر ترکمن', '217': 'رامیان', '218': 'علی آباد کتول', '219': 'کردکوی', '220': 'کلاله',
        '221': 'گالیکش', '222': 'گمیشان', '223': 'گنبد کاووس', '224': 'مراوه تپه', '225': 'مینودشت',
        // گیلان
        '298': 'رشت (مرکزی)', '299': 'رشت', '300': 'رشت', '258': 'آستارا', '259': 'آستانه اشرفیه',
        '261': 'املش', '262': 'بندر انزلی', '263': 'رضوانشهر', '264': 'رودبار', '265': 'رودسر',
        '266': 'سیاهکل', '267': 'شفت', '268': 'صومعه سرا', '269': 'تالش', '270': 'فومن',
        '271': 'لاهیجان', '272': 'لنگرود', '273': 'ماسال',
        // لرستان
        '406': 'خرم آباد (مرکزی)', '407': 'خرم آباد', '408': 'ازنا', '409': 'الیگودرز', '410': 'بروجرد',
        '411': 'پل دختر', '412': 'دلفان / نورآباد', '413': 'دورود', '414': 'چگنی', '415': 'سلسله / الشتر',
        '416': 'کوهدشت', '417': 'رومشکان',
        // مازندران
        '258': 'ساری (مرکزی)', '259': 'ساری', '205': 'آمل', '206': 'بابل', '208': 'بابلسر',
        '209': 'بهشهر', '210': 'تنکابن', '214': 'جویبار', '215': 'چالوس', '216': 'کلاردشت',
        '217': 'رامسر', '218': 'سوادکوه', '219': 'سوادکوه شمالی', '220': 'سیمرغ', '221': 'عباس آباد',
        '222': 'فریدونکنار', '223': 'قائم شهر', '224': 'گلوگاه', '225': 'محمودآباد', '226': 'میاندرود',
        '227': 'نکا', '580': 'نور', '581': 'نوشهر',
        // مرکزی
        '051': 'اراک (مرکزی)', '052': 'اراک', '053': 'اراک', '055': 'آشتیان', '056': 'تفرش',
        '057': 'خمین', '058': 'خنداب', '059': 'دلیجان', '060': 'زرندیه', '061': 'ساوه', '062': 'شازند',
        '614': 'فراهان', '615': 'کمیجان', '616': 'محلات',
        // هرمزگان
        '338': 'بندرعباس (مرکزی)', '339': 'بندرعباس', '340': 'ابوموسی', '341': 'بستک', '342': 'بندر لنگه',
        '343': 'جاسک', '344': 'حاجی آباد', '345': 'خمیر', '346': 'رودان', '347': 'سیریک', '348': 'قشم',
        '585': 'میناب', '586': 'پارسیان', '690': 'بشاگرد',
        // همدان
        '386': 'همدان (مرکزی)', '387': 'همدان', '392': 'اسدآباد', '393': 'بهار', '394': 'تویسرکان',
        '395': 'رزن', '396': 'فامنین', '397': 'کبودرآهنگ', '398': 'ملایر', '399': 'نهاوند',
        // یزد
        '324': 'یزد (مرکزی)', '325': 'یزد', '442': 'ابرکوه', '443': 'اردکان', '444': 'اشکذر',
        '445': 'بافق', '446': 'بهاباد', '447': 'تفت', '448': 'خاتم', '551': 'مهریز', '552': 'میبد'
    };

    if (map[p]) return map[p];

    // Smart Province Fallback
    const num = parseInt(p, 10);
    if (num >= 1 && num <= 62) return 'استان تهران / البرز';
    if (num >= 63 && num <= 90) return 'استان خراسان رضوی / شمالی / جنوبی';
    if (num >= 91 && num <= 94) return 'استان خراسان / اردبیل';
    if (num >= 108 && num <= 129) return 'استان اصفهان';
    if (num >= 136 && num <= 172) return 'استان آذربایجان شرقی';
    if (num >= 174 && num <= 200) return 'استان خوزستان';
    if (num >= 205 && num <= 227) return 'استان مازندران / گلستان';
    if (num >= 228 && num <= 257) return 'استان فارس';
    if (num >= 258 && num <= 273) return 'استان گیلان';
    if (num >= 274 && num <= 302) return 'استان آذربایجان غربی';
    if (num >= 305 && num <= 323) return 'استان کرمان';
    if (num >= 324 && num <= 339) return 'استان یزد / کرمانشاه / هرمزگان';
    if (num >= 349 && num <= 367) return 'استان بوشهر / سیستان و بلوچستان';
    if (num >= 372 && num <= 387) return 'استان کردستان / کرمانشاه / همدان';
    if (num >= 406 && num <= 417) return 'استان لرستان';
    if (num >= 422 && num <= 439) return 'استان کهگیلویه / زنجان / قزوین';
    if (num >= 449 && num <= 468) return 'استان ایلام / سمنان / چهارمحال';
    return 'ایران (عمومی)';
}

// ==========================================================================
// 4. FINANCIAL, LOAN, VAT & PERSIAN NUMBER-WORDS CALCULATOR
// ==========================================================================
function openFinanceTool() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = '<i class="fa fa-calculator" style="color:#eab308;"></i> محاسبه‌گر مالی، وام و ارزش افزوده';
    body.innerHTML = `
        <div class="tool-tab-nav">
            <button class="tool-tab-btn active" id="fin-tab-loan"><i class="fa fa-money-bill-transfer"></i> اقساط و سود وام</button>
            <button class="tool-tab-btn" id="fin-tab-vat"><i class="fa fa-receipt"></i> مالیات بر ارزش افزوده (VAT)</button>
            <button class="tool-tab-btn" id="fin-tab-words"><i class="fa fa-font"></i> عدد به حروف فارسی</button>
        </div>

        <!-- Tab 1: Loan Calculator -->
        <div id="fin-content-loan">
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:0.75rem; margin-bottom:1rem;">
                <div>
                    <label style="font-size:0.8rem; color:var(--text-muted); display:block; margin-bottom:4px;">مبلغ وام (تومان)</label>
                    <input type="text" id="loan-amount-input" value="100,000,000" style="width:100%; padding:0.6rem; border-radius:8px; direction:ltr; text-align:center; font-family:monospace; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                </div>
                <div>
                    <label style="font-size:0.8rem; color:var(--text-muted); display:block; margin-bottom:4px;">نرخ سود سالانه (درصد)</label>
                    <input type="number" id="loan-rate-input" value="23" min="0" max="100" step="0.5" style="width:100%; padding:0.6rem; border-radius:8px; text-align:center; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                </div>
                <div>
                    <label style="font-size:0.8rem; color:var(--text-muted); display:block; margin-bottom:4px;">مدت بازپرداخت (ماه)</label>
                    <input type="number" id="loan-months-input" value="24" min="1" max="360" style="width:100%; padding:0.6rem; border-radius:8px; text-align:center; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                </div>
            </div>

            <div class="finance-result-grid">
                <div class="finance-metric-card">
                    <span class="finance-metric-label">مبلغ هر قسط ماهانه</span>
                    <span class="finance-metric-val" id="loan-res-installment">۰ تومان</span>
                </div>
                <div class="finance-metric-card">
                    <span class="finance-metric-label">کل سود پرداختی</span>
                    <span class="finance-metric-val" id="loan-res-interest" style="color:#f59e0b;">۰ تومان</span>
                </div>
                <div class="finance-metric-card">
                    <span class="finance-metric-label">جمع کل بازپرداخت (اصل + سود)</span>
                    <span class="finance-metric-val" id="loan-res-total" style="color:#10b981;">۰ تومان</span>
                </div>
            </div>
            
            <div class="persian-words-box" id="loan-words-box">
                <span id="loan-words-text"></span>
            </div>
        </div>

        <!-- Tab 2: VAT Calculator -->
        <div id="fin-content-vat" style="display:none; max-width:480px; margin:0 auto;">
            <div style="display:flex; flex-direction:column; gap:0.75rem;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">مبلغ قیمت کالا یا خدمت (تومان)</label>
                    <input type="text" id="vat-amount-input" value="1,000,000" style="width:100%; padding:0.7rem; border-radius:10px; direction:ltr; text-align:center; font-family:monospace; font-size:1.1rem; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                </div>
                <div style="display:flex; gap:0.75rem;">
                    <div style="flex:1;">
                        <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">درصد مالیات ارزش افزوده</label>
                        <input type="number" id="vat-percent-input" value="10" min="0" max="100" style="width:100%; padding:0.6rem; border-radius:8px; text-align:center; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                    </div>
                    <div style="flex:1; display:flex; align-items:flex-end;">
                        <button class="btn-primary" id="vat-calc-from-gross-btn" style="width:100%; font-size:0.8rem; padding:0.65rem 0.5rem;">محاسبه از قیمت با مالیات</button>
                    </div>
                </div>

                <div class="finance-result-grid" style="grid-template-columns:1fr 1fr;">
                    <div class="finance-metric-card">
                        <span class="finance-metric-label">مبلغ مالیات بر ارزش افزوده</span>
                        <span class="finance-metric-val" id="vat-res-tax" style="color:#ef4444;">۰ تومان</span>
                    </div>
                    <div class="finance-metric-card">
                        <span class="finance-metric-label">مبلغ نهایی قابل پرداخت</span>
                        <span class="finance-metric-val" id="vat-res-final" style="color:#10b981;">۰ تومان</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Tab 3: Number to Words -->
        <div id="fin-content-words" style="display:none; max-width:500px; margin:0 auto;">
            <div style="display:flex; flex-direction:column; gap:1rem;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">عدد را وارد کنید (انگلیسی یا فارسی)</label>
                    <input type="text" id="words-num-input" placeholder="مثال: 25400000" style="width:100%; padding:0.7rem; border-radius:10px; direction:ltr; text-align:center; font-family:monospace; font-size:1.2rem; background:rgba(128,128,128,0.1); color:var(--text-color); border:1px solid var(--glass-border);">
                </div>
                <div style="display:flex; gap:0.5rem; justify-content:center;">
                    <button class="chip-btn active" data-unit="toman">تومان</button>
                    <button class="chip-btn" data-unit="rial">ریال</button>
                    <button class="chip-btn" data-unit="none">بدون واحد</button>
                </div>
                <div class="persian-words-box" style="font-size:1.1rem; min-height:80px; align-items:center;">
                    <span id="words-output-text">صفر</span>
                    <button class="icon-btn" id="words-copy-btn" title="کپی متن"><i class="fa fa-copy"></i></button>
                </div>
            </div>
        </div>
    `;

    overlay.classList.add('active');

    // Tabs
    const tabs = ['loan', 'vat', 'words'];
    tabs.forEach(t => {
        document.getElementById(`fin-tab-${t}`).addEventListener('click', () => {
            tabs.forEach(o => {
                document.getElementById(`fin-tab-${o}`).classList.toggle('active', o === t);
                document.getElementById(`fin-content-${o}`).style.display = (o === t) ? 'block' : 'none';
            });
        });
    });

    // Loan Recalculation
    function calcLoan() {
        const rawAmt = document.getElementById('loan-amount-input').value.replace(/,/g, '');
        const p = parseFloat(rawAmt) || 0;
        const rate = parseFloat(document.getElementById('loan-rate-input').value) || 0;
        const n = parseInt(document.getElementById('loan-months-input').value, 10) || 1;

        if (p <= 0 || n <= 0) return;

        let pmt = 0;
        let totalInterest = 0;
        let totalPayment = 0;

        if (rate === 0) {
            pmt = p / n;
            totalPayment = p;
            totalInterest = 0;
        } else {
            const r = (rate / 100) / 12;
            pmt = (p * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
            totalPayment = pmt * n;
            totalInterest = totalPayment - p;
        }

        document.getElementById('loan-res-installment').textContent = Math.round(pmt).toLocaleString() + ' تومان';
        document.getElementById('loan-res-interest').textContent = Math.round(totalInterest).toLocaleString() + ' تومان';
        document.getElementById('loan-res-total').textContent = Math.round(totalPayment).toLocaleString() + ' تومان';
        document.getElementById('loan-words-text').textContent = 'قسط ماهانه: ' + numberToPersianWords(Math.round(pmt)) + ' تومان';
    }

    const loanAmtInput = document.getElementById('loan-amount-input');
    loanAmtInput.addEventListener('input', (e) => {
        let clean = e.target.value.replace(/\D/g, '');
        e.target.value = clean ? parseInt(clean, 10).toLocaleString() : '';
        calcLoan();
    });
    document.getElementById('loan-rate-input').addEventListener('input', calcLoan);
    document.getElementById('loan-months-input').addEventListener('input', calcLoan);
    calcLoan();

    // VAT Recalculation
    function calcVat(isFromGross = false) {
        const rawAmt = document.getElementById('vat-amount-input').value.replace(/,/g, '');
        const amt = parseFloat(rawAmt) || 0;
        const vatRate = (parseFloat(document.getElementById('vat-percent-input').value) || 10) / 100;

        let tax = 0;
        let finalAmt = 0;

        if (isFromGross) {
            const net = amt / (1 + vatRate);
            tax = amt - net;
            finalAmt = amt;
        } else {
            tax = amt * vatRate;
            finalAmt = amt + tax;
        }

        document.getElementById('vat-res-tax').textContent = Math.round(tax).toLocaleString() + ' تومان';
        document.getElementById('vat-res-final').textContent = Math.round(finalAmt).toLocaleString() + ' تومان';
    }

    const vatAmtInput = document.getElementById('vat-amount-input');
    vatAmtInput.addEventListener('input', (e) => {
        let clean = e.target.value.replace(/\D/g, '');
        e.target.value = clean ? parseInt(clean, 10).toLocaleString() : '';
        calcVat(false);
    });
    document.getElementById('vat-percent-input').addEventListener('input', () => calcVat(false));
    document.getElementById('vat-calc-from-gross-btn').addEventListener('click', () => calcVat(true));
    calcVat(false);

    // Number to Words
    let activeUnit = 'toman';
    const wordsInput = document.getElementById('words-num-input');
    const wordsOut = document.getElementById('words-output-text');

    function updateWords() {
        const clean = wordsInput.value.replace(/\D/g, '');
        if (!clean) { wordsOut.textContent = 'صفر'; return; }
        const num = parseInt(clean, 10);
        let words = numberToPersianWords(num);
        if (activeUnit === 'toman') words += ' تومان';
        else if (activeUnit === 'rial') words += ' ریال';
        wordsOut.textContent = words;
    }

    wordsInput.addEventListener('input', updateWords);
    document.querySelectorAll('#fin-content-words .chip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#fin-content-words .chip-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeUnit = btn.dataset.unit;
            updateWords();
        });
    });
    document.getElementById('words-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(wordsOut.textContent);
        showAlert('متن فارسی کپی شد: ' + wordsOut.textContent);
    });
}

function numberToPersianWords(num) {
    if (isNaN(num) || num === '' || num === null) return 'صفر';
    num = parseInt(num, 10);
    if (num === 0) return 'صفر';
    if (num < 0) return 'منفی ' + numberToPersianWords(Math.abs(num));

    const yekan = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
    const dahgan = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
    const dahTaNoozdah = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
    const sadgan = ['', 'یکصد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
    const hezaran = ['', ' هزار', ' میلیون', ' میلیارد', ' تریلیون'];

    function parseChunk(n) {
        let res = [];
        let s = Math.floor(n / 100);
        let d = Math.floor((n % 100) / 10);
        let y = n % 10;

        if (s > 0) res.push(sadgan[s]);
        if (d === 1) {
            res.push(dahTaNoozdah[y]);
        } else {
            if (d > 1) res.push(dahgan[d]);
            if (y > 0) res.push(yekan[y]);
        }
        return res.join(' و ');
    }

    let chunks = [];
    let temp = num;
    while (temp > 0) {
        chunks.push(temp % 1000);
        temp = Math.floor(temp / 1000);
    }

    let words = [];
    for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i] > 0) {
            words.push(parseChunk(chunks[i]) + hezaran[i]);
        }
    }
    return words.join(' و ');
}

// ==========================================================================
// 5. IMAGE PALETTE EXTRACTOR & CSS GRADIENT GENERATOR
// ==========================================================================
function openImgPaletteTool() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = '<i class="fa fa-eye-dropper" style="color:#f97316;"></i> استخراج پالت رنگ از تصویر';
    body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:1rem;">
            <div id="palette-dropzone" class="image-drop-zone">
                <i class="fa fa-image" style="font-size:2rem; color:#f97316; margin-bottom:0.5rem; display:block;"></i>
                <strong>عکس را اینجا بیندازید تا پالت رنگی آن استخراج شود</strong>
                <input type="file" id="palette-file-input" accept="image/*" style="display:none;">
            </div>

            <div id="palette-results" style="display:none; flex-direction:column; gap:1rem;">
                <div class="palette-swatches-grid" id="palette-swatches"></div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">کد گرادیانت CSS مشتق‌شده:</label>
                    <div style="display:flex; gap:0.5rem;">
                        <input type="text" id="palette-gradient-code" readonly style="flex:1; padding:0.6rem; border-radius:8px; direction:ltr; font-family:monospace; background:rgba(128,128,128,0.1);">
                        <button class="btn-primary" id="palette-copy-gradient-btn"><i class="fa fa-copy"></i> کپی گرادیانت</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    overlay.classList.add('active');

    const dropzone = document.getElementById('palette-dropzone');
    const fileInput = document.getElementById('palette-file-input');
    const results = document.getElementById('palette-results');
    const swatches = document.getElementById('palette-swatches');

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) processPalette(e.target.files[0]); });

    function processPalette(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 120;
                canvas.height = 120;
                ctx.drawImage(img, 0, 0, 120, 120);
                const data = ctx.getImageData(0, 0, 120, 120).data;

                const colorMap = {};
                for (let i = 0; i < data.length; i += 16) {
                    const r = Math.round(data[i] / 24) * 24;
                    const g = Math.round(data[i + 1] / 24) * 24;
                    const b = Math.round(data[i + 2] / 24) * 24;
                    const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
                    colorMap[hex] = (colorMap[hex] || 0) + 1;
                }

                const sorted = Object.entries(colorMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
                results.style.display = 'flex';
                swatches.innerHTML = sorted.map(([hex]) => `
                    <div class="palette-swatch-card" style="background:${hex};" data-hex="${hex}">
                        <span class="palette-swatch-code">${hex}</span>
                    </div>
                `).join('');

                const gradCode = `linear-gradient(135deg, ${sorted.slice(0, 3).map(s => s[0]).join(', ')})`;
                document.getElementById('palette-gradient-code').value = gradCode;

                document.querySelectorAll('.palette-swatch-card').forEach(card => {
                    card.addEventListener('click', () => {
                        navigator.clipboard.writeText(card.dataset.hex);
                        showAlert('کد رنگ کپی شد: ' + card.dataset.hex);
                    });
                });
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    document.getElementById('palette-copy-gradient-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(document.getElementById('palette-gradient-code').value);
        showAlert('کد گرادیانت CSS کپی شد!');
    });
}

// ==========================================================================
// 6. PROFESSIONAL IMAGE TO SVG VECTORIZER (Smooth Contour Curve Fitting)
// ==========================================================================
function openVectorizerTool() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = '<i class="fa fa-bezier-curve" style="color:#a855f7;"></i> استودیوی تبدیل عکس به وکتور SVG حرفه‌ای';
    body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:1rem;">
            <div id="vector-dropzone" class="image-drop-zone">
                <i class="fa fa-bezier-curve" style="font-size:2.2rem; color:#a855f7; margin-bottom:0.5rem; display:block;"></i>
                <strong>لوگو، آیکون، امضا یا تصویر را اینجا بیندازید</strong>
                <p class="text-muted" style="font-size:0.8rem; margin-top:4px;">تولید خطوط منحنی نرم و وکتور SVG مقیاس‌پذیر و تمیز</p>
                <input type="file" id="vector-file-input" accept="image/*" style="display:none;">
            </div>

            <div id="vector-results" style="display:none; flex-direction:column; gap:1rem;">
                <div class="vector-preview-canvas-wrap" id="vector-svg-preview"></div>

                <div class="enhancer-controls-grid">
                    <div class="slider-control-row">
                        <div class="slider-control-header">
                            <span><i class="fa fa-sliders"></i> آستانه تیرگی (Threshold)</span>
                            <span id="vector-thresh-val">128</span>
                        </div>
                        <input type="range" id="vector-thresh-range" class="enhancer-range" min="20" max="235" value="128">
                    </div>

                    <div class="slider-control-row">
                        <div class="slider-control-header">
                            <span><i class="fa fa-wave-square"></i> نرم‌کنندگی منحنی‌ها (Smoothness)</span>
                            <span id="vector-smooth-val">۷۰٪</span>
                        </div>
                        <input type="range" id="vector-smooth-range" class="enhancer-range" min="10" max="100" value="70">
                    </div>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
                    <div style="display:flex; gap:0.5rem;">
                        <button class="chip-btn active" id="vec-mode-black" data-color="#111827">سیاه</button>
                        <button class="chip-btn" id="vec-mode-blue" data-color="#0a84ff">آبی</button>
                        <button class="chip-btn" id="vec-mode-purple" data-color="#9333ea">بنفش</button>
                        <button class="chip-btn" id="vec-mode-green" data-color="#16a34a">سبز</button>
                    </div>

                    <div style="display:flex; gap:0.5rem;">
                        <button class="btn-secondary" id="vector-copy-btn"><i class="fa fa-copy"></i> کپی کد SVG</button>
                        <button class="btn-primary" id="vector-download-btn"><i class="fa fa-download"></i> دانلود SVG باکیفیت</button>
                    </div>
                </div>

                <textarea id="vector-svg-code" readonly style="height:90px; padding:0.6rem; border-radius:10px; font-family:monospace; direction:ltr; font-size:0.75rem; background:rgba(128,128,128,0.08); border:1px solid var(--glass-border);"></textarea>
            </div>
        </div>
    `;

    overlay.classList.add('active');

    let loadedImg = null;
    let activeFillColor = '#111827';
    const dropzone = document.getElementById('vector-dropzone');
    const fileInput = document.getElementById('vector-file-input');
    const results = document.getElementById('vector-results');
    const preview = document.getElementById('vector-svg-preview');
    const codeArea = document.getElementById('vector-svg-code');
    const threshRange = document.getElementById('vector-thresh-range');
    const smoothRange = document.getElementById('vector-smooth-range');

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    loadedImg = img;
                    dropzone.style.display = 'none';
                    results.style.display = 'flex';
                    renderVectorSvg();
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(e.target.files[0]);
        }
    });

    function renderVectorSvg() {
        if (!loadedImg) return;
        const thresh = parseInt(threshRange.value, 10);
        const smoothVal = parseInt(smoothRange.value, 10) / 100;
        document.getElementById('vector-thresh-val').textContent = thresh;
        document.getElementById('vector-smooth-val').textContent = Math.round(smoothVal * 100) + '٪';

        // Downscale for vector boundary processing
        const maxW = 400;
        const maxH = 400;
        const scale = Math.min(maxW / loadedImg.width, maxH / loadedImg.height, 1);
        const w = Math.round(loadedImg.width * scale);
        const h = Math.round(loadedImg.height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(loadedImg, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;

        // Binary Grid
        const grid = new Uint8Array(w * h);
        for (let i = 0; i < d.length; i += 4) {
            const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const a = d[i + 3];
            grid[i / 4] = (a > 50 && lum < thresh) ? 1 : 0;
        }

        // Contour Tracing (Marching Squares / Moore-Neighbor)
        const visited = new Uint8Array(w * h);
        let pathD = '';

        function traceContour(startX, startY) {
            const points = [];
            let cx = startX;
            let cy = startY;
            let dir = 0; // 0: E, 1: SE, 2: S, 3: SW, 4: W, 5: NW, 6: N, 7: NE
            const dx = [1, 1, 0, -1, -1, -1, 0, 1];
            const dy = [0, 1, 1, 1, 0, -1, -1, -1];

            points.push({ x: cx, y: cy });

            let limit = 4000;
            while (limit-- > 0) {
                let found = false;
                for (let i = 0; i < 8; i++) {
                    const nd = (dir + i) % 8;
                    const nx = cx + dx[nd];
                    const ny = cy + dy[nd];
                    if (nx >= 0 && nx < w && ny >= 0 && ny < h && grid[ny * w + nx] === 1) {
                        cx = nx;
                        cy = ny;
                        dir = (nd + 5) % 8; // Backtrack direction
                        points.push({ x: cx, y: cy });
                        visited[ny * w + nx] = 1;
                        found = true;
                        break;
                    }
                }
                if (!found || (cx === startX && cy === startY && points.length > 2)) break;
            }
            return points;
        }

        // Scan for starting boundary points
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                if (grid[y * w + x] === 1 && grid[y * w + (x - 1)] === 0 && !visited[y * w + x]) {
                    visited[y * w + x] = 1;
                    const pts = traceContour(x, y);
                    if (pts.length > 4) {
                        // Smooth curves with Bezier interpolation
                        const step = Math.max(1, Math.round(4 * (1 - smoothVal * 0.6)));
                        const simplified = [];
                        for (let i = 0; i < pts.length; i += step) simplified.push(pts[i]);
                        if (simplified.length > 2) {
                            let dStr = `M${simplified[0].x},${simplified[0].y} `;
                            for (let i = 1; i < simplified.length; i++) {
                                const p0 = simplified[i - 1];
                                const p1 = simplified[i];
                                const mx = (p0.x + p1.x) / 2;
                                const my = (p0.y + p1.y) / 2;
                                dStr += `Q${p0.x},${p0.y} ${mx},${my} `;
                            }
                            dStr += 'Z ';
                            pathD += dStr;
                        }
                    }
                }
            }
        }

        if (!pathD) {
            // Fallback to high density path
            pathD = `M0,0 Z`;
        }

        const svgCode = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n  <path d="${pathD}" fill="${activeFillColor}" fill-rule="evenodd"/>\n</svg>`;
        preview.innerHTML = svgCode;
        codeArea.value = svgCode;
    }

    threshRange.addEventListener('input', renderVectorSvg);
    smoothRange.addEventListener('input', renderVectorSvg);

    document.querySelectorAll('#vec-mode-black, #vec-mode-blue, #vec-mode-purple, #vec-mode-green').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#vector-results .chip-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFillColor = btn.dataset.color;
            renderVectorSvg();
        });
    });

    document.getElementById('vector-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(codeArea.value);
        showAlert('کد وکتور SVG در کلیپ‌بورد کپی شد!');
    });

    document.getElementById('vector-download-btn').addEventListener('click', () => {
        const blob = new Blob([codeArea.value], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'vector_' + Date.now() + '.svg';
        a.click();
        URL.revokeObjectURL(url);
    });
}

// ==========================================================================
// 7. PROFESSIONAL LOCAL BACKGROUND REMOVER (Boundary Matting & Smart Feather)
// ==========================================================================
function openBgRemoverTool() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = '<i class="fa fa-eraser" style="color:#06b6d4;"></i> استودیوی حذف پس‌زمینه تصویر (آفلاین)';
    body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:1rem;">
            <div id="bgrem-dropzone" class="image-drop-zone">
                <i class="fa fa-eraser" style="font-size:2.2rem; color:#06b6d4; margin-bottom:0.5rem; display:block;"></i>
                <strong>عکس محصول، پرتره یا آیکون را اینجا بیندازید</strong>
                <p class="text-muted" style="font-size:0.8rem; margin-top:4px;">حذف خودکار پس‌زمینه با ماتینگ نرم + قابلیت چوب جادویی کلیکی</p>
                <input type="file" id="bgrem-file-input" accept="image/*" style="display:none;">
            </div>

            <div id="bgrem-workspace" style="display:none; flex-direction:column; gap:1rem;">
                <div class="bgrem-toolbar">
                    <button class="bgrem-tool-btn active" id="bgrem-tool-magic"><i class="fa fa-wand-magic-sparkles"></i> چوب جادویی (کلیک روی پس‌زمینه)</button>
                    <button class="bgrem-tool-btn" id="bgrem-tool-erase"><i class="fa fa-eraser"></i> قلم پاک‌کن دستی</button>
                    <button class="bgrem-tool-btn" id="bgrem-tool-restore"><i class="fa fa-paint-brush"></i> قلم بازیابی</button>
                    <button class="btn-secondary" id="bgrem-auto-btn" style="margin-inline-start:auto; padding:0.3rem 0.7rem; font-size:0.75rem;"><i class="fa fa-bolt"></i> حذف خودکار مجدد</button>
                </div>

                <div class="bgrem-canvas-container" id="bgrem-canvas-wrap">
                    <canvas id="bgrem-canvas"></canvas>
                </div>

                <div class="enhancer-controls-grid">
                    <div class="slider-control-row">
                        <div class="slider-control-header">
                            <span>حساسیت حذف رنگ (Tolerance)</span>
                            <span id="bgrem-val-tol">۳۰</span>
                        </div>
                        <input type="range" id="bgrem-range-tol" class="enhancer-range" min="5" max="85" value="30">
                    </div>

                    <div class="slider-control-row">
                        <div class="slider-control-header">
                            <span>نرمی و محوشدگی لبه‌ها (Feather)</span>
                            <span id="bgrem-val-feather">۲ پیکسل</span>
                        </div>
                        <input type="range" id="bgrem-range-feather" class="enhancer-range" min="0" max="8" value="2">
                    </div>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <button class="btn-secondary" id="bgrem-new-img-btn"><i class="fa fa-folder-open"></i> انتخاب عکس دیگر</button>
                    <button class="btn-primary" id="bgrem-download-btn"><i class="fa fa-download"></i> دانلود PNG شفاف باکیفیت</button>
                </div>
            </div>
        </div>
    `;

    overlay.classList.add('active');

    let loadedImg = null;
    let originalCanvas = document.createElement('canvas');
    let currentMask = null; // Uint8Array of transparency alpha
    let activeTool = 'magic'; // 'magic' | 'erase' | 'restore'
    let isMouseDown = false;

    const dropzone = document.getElementById('bgrem-dropzone');
    const fileInput = document.getElementById('bgrem-file-input');
    const workspace = document.getElementById('bgrem-workspace');
    const canvas = document.getElementById('bgrem-canvas');
    const tolRange = document.getElementById('bgrem-range-tol');
    const featherRange = document.getElementById('bgrem-range-feather');

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) handleFile(e.target.files[0]);
    });

    document.getElementById('bgrem-new-img-btn').addEventListener('click', () => fileInput.click());

    function handleFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                loadedImg = img;
                dropzone.style.display = 'none';
                workspace.style.display = 'flex';

                // Setup original
                originalCanvas.width = img.width;
                originalCanvas.height = img.height;
                const oCtx = originalCanvas.getContext('2d');
                oCtx.drawImage(img, 0, 0);

                canvas.width = img.width;
                canvas.height = img.height;

                currentMask = new Uint8Array(img.width * img.height);
                currentMask.fill(255); // 255 = Visible, 0 = Transparent

                autoRemoveBackground();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    // Auto border-connected Flood Fill BFS
    function autoRemoveBackground() {
        if (!loadedImg) return;
        const w = canvas.width;
        const h = canvas.height;
        const oCtx = originalCanvas.getContext('2d');
        const imgData = oCtx.getImageData(0, 0, w, h).data;
        const tol = parseInt(tolRange.value, 10);
        document.getElementById('bgrem-val-tol').textContent = tol;

        currentMask.fill(255);

        // Sample background seeds from all 4 borders
        const seeds = [];
        for (let x = 0; x < w; x += 4) {
            seeds.push({ x, y: 0 });
            seeds.push({ x, y: h - 1 });
        }
        for (let y = 0; y < h; y += 4) {
            seeds.push({ x: 0, y });
            seeds.push({ x: w - 1, y });
        }

        const visited = new Uint8Array(w * h);
        const queue = [];

        // Average corner background color
        const cornerIdx = 0;
        const bgR = imgData[cornerIdx];
        const bgG = imgData[cornerIdx + 1];
        const bgB = imgData[cornerIdx + 2];

        seeds.forEach(s => {
            const idx = s.y * w + s.x;
            if (!visited[idx]) {
                visited[idx] = 1;
                queue.push(s);
            }
        });

        while (queue.length > 0) {
            const pt = queue.shift();
            const idx = pt.y * w + pt.x;
            const pIdx = idx * 4;

            const r = imgData[pIdx];
            const g = imgData[pIdx + 1];
            const b = imgData[pIdx + 2];

            // Color distance (Perceptual weighted Euclidean)
            const diff = Math.sqrt(2 * Math.pow(r - bgR, 2) + 4 * Math.pow(g - bgG, 2) + 3 * Math.pow(b - bgB, 2));

            if (diff < tol * 3.8) {
                currentMask[idx] = 0; // Set Transparent

                const neighbors = [
                    { x: pt.x + 1, y: pt.y },
                    { x: pt.x - 1, y: pt.y },
                    { x: pt.x, y: pt.y + 1 },
                    { x: pt.x, y: pt.y - 1 }
                ];

                neighbors.forEach(n => {
                    if (n.x >= 0 && n.x < w && n.y >= 0 && n.y < h) {
                        const nIdx = n.y * w + n.x;
                        if (!visited[nIdx]) {
                            visited[nIdx] = 1;
                            queue.push(n);
                        }
                    }
                });
            }
        }

        renderMaskToCanvas();
    }

    // Render transparency with Edge Feathering
    function renderMaskToCanvas() {
        if (!loadedImg) return;
        const w = canvas.width;
        const h = canvas.height;
        const ctx = canvas.getContext('2d');
        const oCtx = originalCanvas.getContext('2d');
        const srcData = oCtx.getImageData(0, 0, w, h);
        const outData = ctx.createImageData(w, h);

        const src = srcData.data;
        const out = outData.data;
        const feather = parseInt(featherRange.value, 10);
        document.getElementById('bgrem-val-feather').textContent = feather + ' پیکسل';

        for (let i = 0; i < currentMask.length; i++) {
            const pIdx = i * 4;
            out[pIdx] = src[pIdx];
            out[pIdx + 1] = src[pIdx + 1];
            out[pIdx + 2] = src[pIdx + 2];

            if (feather === 0) {
                out[pIdx + 3] = currentMask[i];
            } else {
                // Feather soft alpha kernel
                const x = i % w;
                const y = Math.floor(i / w);
                let alphaSum = 0;
                let count = 0;

                for (let fy = -feather; fy <= feather; fy++) {
                    for (let fx = -feather; fx <= feather; fx++) {
                        const nx = x + fx;
                        const ny = y + fy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                            alphaSum += currentMask[ny * w + nx];
                            count++;
                        }
                    }
                }
                out[pIdx + 3] = Math.round(alphaSum / count);
            }
        }

        ctx.putImageData(outData, 0, 0);
    }

    // Magic Wand Click: Target clicked color
    function handleCanvasClick(e) {
        if (activeTool !== 'magic' || !loadedImg) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const clickX = Math.floor((e.clientX - rect.left) * scaleX);
        const clickY = Math.floor((e.clientY - rect.top) * scaleY);

        if (clickX < 0 || clickX >= canvas.width || clickY < 0 || clickY >= canvas.height) return;

        const w = canvas.width;
        const h = canvas.height;
        const oCtx = originalCanvas.getContext('2d');
        const imgData = oCtx.getImageData(0, 0, w, h).data;
        const tol = parseInt(tolRange.value, 10);

        const targetIdx = (clickY * w + clickX) * 4;
        const tR = imgData[targetIdx];
        const tG = imgData[targetIdx + 1];
        const tB = imgData[targetIdx + 2];

        // Flood fill from click
        const visited = new Uint8Array(w * h);
        const queue = [{ x: clickX, y: clickY }];
        visited[clickY * w + clickX] = 1;

        while (queue.length > 0) {
            const pt = queue.shift();
            const idx = pt.y * w + pt.x;
            const pIdx = idx * 4;

            const r = imgData[pIdx];
            const g = imgData[pIdx + 1];
            const b = imgData[pIdx + 2];
            const diff = Math.sqrt(2 * Math.pow(r - tR, 2) + 4 * Math.pow(g - tG, 2) + 3 * Math.pow(b - tB, 2));

            if (diff < tol * 3.8) {
                currentMask[idx] = 0;
                const neighbors = [
                    { x: pt.x + 1, y: pt.y },
                    { x: pt.x - 1, y: pt.y },
                    { x: pt.x, y: pt.y + 1 },
                    { x: pt.x, y: pt.y - 1 }
                ];
                neighbors.forEach(n => {
                    if (n.x >= 0 && n.x < w && n.y >= 0 && n.y < h) {
                        const nIdx = n.y * w + n.x;
                        if (!visited[nIdx]) {
                            visited[nIdx] = 1;
                            queue.push(n);
                        }
                    }
                });
            }
        }
        renderMaskToCanvas();
    }

    // Brush paint handler
    function paintBrush(e) {
        if (!isMouseDown || (activeTool !== 'erase' && activeTool !== 'restore') || !loadedImg) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const cx = Math.floor((e.clientX - rect.left) * scaleX);
        const cy = Math.floor((e.clientY - rect.top) * scaleY);
        const radius = 18;
        const val = (activeTool === 'erase') ? 0 : 255;
        const w = canvas.width;
        const h = canvas.height;

        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx * dx + dy * dy <= radius * radius) {
                    const px = cx + dx;
                    const py = cy + dy;
                    if (px >= 0 && px < w && py >= 0 && py < h) {
                        currentMask[py * w + px] = val;
                    }
                }
            }
        }
        renderMaskToCanvas();
    }

    canvas.addEventListener('click', handleCanvasClick);
    canvas.addEventListener('mousedown', (e) => { isMouseDown = true; paintBrush(e); });
    window.addEventListener('mouseup', () => { isMouseDown = false; });
    canvas.addEventListener('mousemove', paintBrush);

    // Toolbar buttons
    document.getElementById('bgrem-tool-magic').addEventListener('click', function() {
        document.querySelectorAll('.bgrem-tool-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        activeTool = 'magic';
        canvas.style.cursor = 'crosshair';
    });
    document.getElementById('bgrem-tool-erase').addEventListener('click', function() {
        document.querySelectorAll('.bgrem-tool-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        activeTool = 'erase';
        canvas.style.cursor = 'cell';
    });
    document.getElementById('bgrem-tool-restore').addEventListener('click', function() {
        document.querySelectorAll('.bgrem-tool-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        activeTool = 'restore';
        canvas.style.cursor = 'crosshair';
    });
    document.getElementById('bgrem-auto-btn').addEventListener('click', autoRemoveBackground);

    tolRange.addEventListener('input', autoRemoveBackground);
    featherRange.addEventListener('input', renderMaskToCanvas);

    document.getElementById('bgrem-download-btn').addEventListener('click', () => {
        const link = document.createElement('a');
        link.download = 'transparent_bg_' + Date.now() + '.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
    });
}

// ==========================================================================
// TV TIME & WATCHLIST TRACKER ENGINE (فیلم و سریال)
// ==========================================================================

async function getWatchlistItems() {
    let items = [];
    if (currentData && Array.isArray(currentData.watchlist_items)) {
        items = currentData.watchlist_items;
    } else {
        const { watchlistItems } = await storageGet({ watchlistItems: [] });
        items = watchlistItems || [];
    }

    // Deduplicate items by ID or (title + media_type) to clean up any past duplicates
    const seenIds = new Set();
    const seenTitles = new Set();
    const unique = [];

    for (const item of items) {
        if (!item || !item.title) continue;
        const idKey = item.id != null ? String(item.id) : null;
        const titleKey = `${item.title.trim().toLowerCase()}_${item.media_type || 'movie'}`;

        if (idKey && seenIds.has(idKey)) continue;
        if (seenTitles.has(titleKey)) continue;

        if (idKey) seenIds.add(idKey);
        seenTitles.add(titleKey);
        unique.push(item);
    }

    if (unique.length !== items.length) {
        // Save cleaned deduplicated list
        if (currentData) currentData.watchlist_items = unique;
        await storageSet({ watchlistItems: unique, cachedData: currentData });
    }

    return unique;
}

async function saveWatchlistItems(items) {
    if (currentData) {
        currentData.watchlist_items = items;
    }
    await storageSet({ watchlistItems: items, cachedData: currentData });
}

async function askAIForWatchSuggestion(items) {
    const completed = items.filter(i => i.status === 'completed');
    const plan = items.filter(i => i.status === 'plan');
    const watching = items.filter(i => i.status === 'watching');

    const describe = (arr) => arr.map(i => `${i.title}${i.rating ? ` (امتیاز کاربر: ${i.rating}/10)` : ''}`).join('، ') || '-';
    const context = `لیست تماشای کاربر:\nدیده‌شده و امتیازدهی‌شده: ${describe(completed)}\nدر حال تماشا: ${describe(watching)}\nقصد دیدن دارد: ${describe(plan)}`;

    const question = await showPrompt('چه جور فیلم/سریالی دنبالشی؟ (یا خالی بذار برای پیشنهاد کلی)', '', 'امشب چی ببینم؟');
    if (question === null) return;
    const finalQuestion = question || 'با توجه به سلیقه‌ام از روی این لیست، یک فیلم یا سریال جدید برای تماشای امشب پیشنهاد بده و دلیلش رو بگو.';

    askAIWithContext(finalQuestion, context, finalQuestion);
}

let isMediaAddLock = false;

window.openMovieTrackerTool = async function() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    clearInterval(tempMailInterval);
    clearTimeout(reactionTimeout);

    title.innerHTML = '<i class="fa fa-tv" style="color:#a855f7;"></i> ردیاب فیلم و سریال (تی‌وی تایم)';
    overlay.classList.add('active');
    document.querySelector('#modal-overlay .modal-content').classList.add('modal-fullscreen');

    let activeTab = 'watching'; // 'watching', 'plan', 'completed', 'all'
    let isSearchOpen = false;
    let searchResults = [];
    let isSearching = false;
    let searchQuery = '';

    // Browse-without-searching: a cached "top rated" feed shown by default when the
    // search panel is open and no query has been typed yet.
    let discoverResults = [];
    let isDiscoverLoading = false;
    let discoverLoadedOnce = false;
    let discoverTypeFilter = 'all'; // all | movie | series
    let discoverYearFilter = '';
    let discoverPage = 1;
    const DISCOVER_PAGE_SIZE = 20;

    async function refreshView(resetScroll = false) {
        // Rebuilding body.innerHTML wipes scroll position - save/restore it around
        // the rebuild so clicking "add" on an item deep in a scrolled list doesn't
        // yank the whole panel back to the top. Explicit page/filter changes pass
        // resetScroll=true instead, since jumping to the top of a new page/filter
        // is the expected behavior there.
        const scrollEl = document.getElementById('tvtime-discover-results') || document.getElementById('tvtime-search-results');
        const savedScrollTop = (!resetScroll && scrollEl) ? scrollEl.scrollTop : 0;

        const items = await getWatchlistItems();

        const countWatching = items.filter(i => i.status === 'watching').length;
        const countPlan = items.filter(i => i.status === 'plan').length;
        const countCompleted = items.filter(i => i.status === 'completed').length;
        const countAll = items.length;

        let filteredItems = items;
        if (activeTab === 'watching') filteredItems = items.filter(i => i.status === 'watching');
        else if (activeTab === 'plan') filteredItems = items.filter(i => i.status === 'plan');
        else if (activeTab === 'completed') filteredItems = items.filter(i => i.status === 'completed');

        body.innerHTML = `
            <div class="tvtime-container" id="tvtime-main-container">
                <!-- Toolbar -->
                <div class="tvtime-toolbar">
                    <div class="tvtime-tabs">
                        <button class="tvtime-tab-btn ${activeTab === 'watching' ? 'active' : ''}" data-tab="watching">
                            <i class="fa fa-play-circle"></i> در حال تماشا <span class="tvtime-tab-count">${countWatching}</span>
                        </button>
                        <button class="tvtime-tab-btn ${activeTab === 'plan' ? 'active' : ''}" data-tab="plan">
                            <i class="fa fa-bookmark"></i> می‌خواهم ببینم <span class="tvtime-tab-count">${countPlan}</span>
                        </button>
                        <button class="tvtime-tab-btn ${activeTab === 'completed' ? 'active' : ''}" data-tab="completed">
                            <i class="fa fa-check-circle"></i> دیده‌شده <span class="tvtime-tab-count">${countCompleted}</span>
                        </button>
                        <button class="tvtime-tab-btn ${activeTab === 'all' ? 'active' : ''}" data-tab="all">
                            <i class="fa fa-layer-group"></i> همه <span class="tvtime-tab-count">${countAll}</span>
                        </button>
                    </div>
                    <div class="tvtime-actions">
                        <button class="btn-secondary" id="tvtime-ai-suggest-btn" style="padding:0.45rem 0.9rem; font-size:0.82rem;">
                            <i class="fa fa-robot"></i> امشب چی ببینم؟
                        </button>
                        <button class="btn-primary" id="tvtime-toggle-search-btn" style="padding:0.45rem 0.9rem; font-size:0.82rem;">
                            <i class="fa fa-search"></i> ${isSearchOpen ? 'بستن جستجو' : 'جستجوی آنلاین'}
                        </button>
                        <button class="btn-secondary" id="tvtime-add-manual-btn" style="padding:0.45rem 0.9rem; font-size:0.82rem;">
                            <i class="fa fa-plus"></i> افزودن دستی
                        </button>
                    </div>
                </div>

                <!-- Online Search / Discover Panel -->
                ${isSearchOpen ? `
                    <div class="tvtime-search-section">
                        <div class="tvtime-search-bar">
                            <input type="text" id="tvtime-search-input" class="tvtime-search-input" placeholder="نام فیلم یا سریال را به انگلیسی یا فارسی تایپ کنید (مثال: Breaking Bad, Inception)..." autofocus value="${escapeHtml(searchQuery)}">
                            <button class="btn-primary" id="tvtime-run-search-btn" style="padding:0.6rem 1.2rem;">
                                ${isSearching ? '<i class="fa fa-spinner fa-spin"></i>' : 'جستجو'}
                            </button>
                        </div>

                        ${searchQuery ? `
                            <div class="tvtime-search-results" id="tvtime-search-results">
                                ${searchResults.length > 0 ? searchResults.map(r => renderMediaResultCard(r, items)).join('')
                                    : (isSearching ? '<div class="text-muted" style="grid-column:1/-1; text-align:center; padding:1rem;">در حال جستجو در دیتابیس جهانی فیلم و سریال...</div>' : '<div class="text-muted" style="grid-column:1/-1; text-align:center; font-size:0.85rem; padding:0.5rem;">چیزی پیدا نشد.</div>')}
                            </div>
                        ` : `
                            <div class="tvtime-discover-toolbar">
                                <div class="tvtime-discover-title"><i class="fa fa-fire"></i> برترین‌ها (بدون نیاز به جستجو)</div>
                                <div class="tvtime-discover-filters">
                                    <div class="qr-type-tabs">
                                        <span class="qr-type-btn${discoverTypeFilter === 'all' ? ' active' : ''}" data-discover-type="all">همه</span>
                                        <span class="qr-type-btn${discoverTypeFilter === 'movie' ? ' active' : ''}" data-discover-type="movie">فیلم</span>
                                        <span class="qr-type-btn${discoverTypeFilter === 'series' ? ' active' : ''}" data-discover-type="series">سریال</span>
                                    </div>
                                    <select id="tvtime-discover-year" class="tvtime-year-select">
                                        <option value="">همه‌ی سال‌ها</option>
                                        ${[...new Set(discoverResults.map(r => r.year).filter(Boolean))].sort((a, b) => b - a).map(y =>
                                            `<option value="${escapeHtml(y)}" ${discoverYearFilter === y ? 'selected' : ''}>${escapeHtml(y)}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                            </div>
                            <div class="tvtime-search-results" id="tvtime-discover-results">
                                ${isDiscoverLoading ? '<div class="text-muted" style="grid-column:1/-1; text-align:center; padding:1rem;">در حال دریافت برترین‌های جهانی...</div>' : (() => {
                                    const filtered = discoverResults.filter(r =>
                                        (discoverTypeFilter === 'all' || r.type === discoverTypeFilter) &&
                                        (!discoverYearFilter || r.year === discoverYearFilter)
                                    );
                                    const pageItems = filtered.slice((discoverPage - 1) * DISCOVER_PAGE_SIZE, discoverPage * DISCOVER_PAGE_SIZE);
                                    return pageItems.length > 0
                                        ? pageItems.map(r => renderMediaResultCard(r, items)).join('')
                                        : '<div class="text-muted" style="grid-column:1/-1; text-align:center; font-size:0.85rem; padding:0.5rem;">با این فیلتر چیزی پیدا نشد.</div>';
                                })()}
                            </div>
                            ${!isDiscoverLoading ? (() => {
                                const filteredCount = discoverResults.filter(r =>
                                    (discoverTypeFilter === 'all' || r.type === discoverTypeFilter) &&
                                    (!discoverYearFilter || r.year === discoverYearFilter)
                                ).length;
                                const totalPages = Math.max(1, Math.ceil(filteredCount / DISCOVER_PAGE_SIZE));
                                if (totalPages <= 1) return '';
                                return `
                                    <div class="tvtime-discover-pagination">
                                        <button class="icon-btn" id="tvtime-discover-prev-btn" title="صفحه قبل" ${discoverPage <= 1 ? 'disabled' : ''}><i class="fa fa-chevron-right"></i></button>
                                        <span>صفحه ${discoverPage} از ${totalPages}</span>
                                        <button class="icon-btn" id="tvtime-discover-next-btn" title="صفحه بعد" ${discoverPage >= totalPages ? 'disabled' : ''}><i class="fa fa-chevron-left"></i></button>
                                    </div>
                                `;
                            })() : ''}
                        `}
                    </div>
                ` : ''}

                <!-- Media Cards Grid -->
                <div class="tvtime-grid">
                    ${filteredItems.length === 0 ? `
                        <div class="tvtime-empty-state">
                            <i class="fa fa-film" style="font-size:3rem; opacity:0.3;"></i>
                            <p>موردی در این بخش وجود ندارد.</p>
                            <button class="btn-primary" id="tvtime-empty-search-btn" style="font-size:0.85rem; padding:0.5rem 1rem;">
                                <i class="fa fa-search"></i> جستجو و افزودن فیلم/سریال جدید
                            </button>
                        </div>
                    ` : filteredItems.map(item => {
                        const isSeries = item.media_type === 'series';
                        const totalEps = parseInt(item.total_episodes, 10) || 0;
                        const curEp = parseInt(item.current_episode, 10) || 0;
                        const curSeason = parseInt(item.current_season, 10) || 1;
                        const progressPct = totalEps > 0 ? Math.min(100, Math.round((curEp / totalEps) * 100)) : (item.status === 'completed' ? 100 : 0);

                        return `
                            <div class="tvtime-card" data-item-id="${item.id}">
                                <div class="tvtime-card-poster-wrap">
                                    <img src="${escapeHtml(item.poster_url || 'icons/icon48.png')}" class="tvtime-card-poster" alt="${escapeHtml(item.title)}" data-fallback="icons/icon48.png">
                                    <span class="tvtime-badge-type ${isSeries ? 'series' : 'movie'}">
                                        <i class="fa fa-${isSeries ? 'tv' : 'film'}"></i> ${isSeries ? 'سریال' : 'فیلم'}
                                    </span>
                                    <span class="tvtime-badge-status ${escapeHtml(item.status)}">
                                        ${item.status === 'watching' ? 'در حال تماشا' : (item.status === 'plan' ? 'می‌خواهم ببینم' : 'دیده‌شده')}
                                    </span>
                                    ${item.imdb_rating ? `
                                        <div class="tvtime-card-rating-float">
                                            <i class="fa fa-star"></i> ${escapeHtml(item.imdb_rating)}
                                        </div>
                                    ` : ''}
                                </div>
                                <div class="tvtime-card-body">
                                    <div class="tvtime-card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                                    <div class="tvtime-card-meta">
                                        <span>${escapeHtml(item.year || '')}</span>
                                        ${item.rating ? `<span style="color:#facc15; font-weight:700;"><i class="fa fa-star"></i> من: ${escapeHtml(item.rating)}/10</span>` : ''}
                                    </div>

                                    ${isSeries ? `
                                        <div class="tvtime-progress-section">
                                            <div class="tvtime-progress-text">
                                                <span>فصل ${curSeason} • قسمت ${curEp} ${totalEps > 0 ? `از ${totalEps}` : ''}</span>
                                                <span style="color:var(--primary-color);">${progressPct}٪</span>
                                            </div>
                                            <div class="tvtime-progress-track">
                                                <div class="tvtime-progress-fill" style="width:${progressPct}%;"></div>
                                            </div>
                                            <div class="tvtime-progress-controls">
                                                <button class="tvtime-btn-plus1" data-action="plus1" data-id="${item.id}" title="یک قسمت جلوتر">
                                                    <i class="fa fa-plus"></i> ۱ قسمت
                                                </button>
                                                <button class="tvtime-btn-episodes" data-action="open-episodes" data-id="${item.id}">
                                                    <i class="fa fa-list-check"></i> لیست قسمت‌ها
                                                </button>
                                            </div>
                                        </div>
                                    ` : ''}

                                    <div class="tvtime-card-actions">
                                        <div class="tvtime-user-rating" data-action="rate" data-id="${item.id}" title="امتیاز و یادداشت شخصی">
                                            <i class="fa fa-star"></i> ${item.rating ? `${escapeHtml(item.rating)}/10` : 'امتیازدهی'}
                                        </div>
                                        <div class="tvtime-actions-group">
                                            <button class="icon-btn" style="width:26px; height:26px; font-size:0.7rem;" data-action="edit" data-id="${item.id}" title="ویرایش"><i class="fa fa-edit"></i></button>
                                            <button class="icon-btn" style="width:26px; height:26px; font-size:0.7rem; color:var(--danger-color);" data-action="delete" data-id="${item.id}" title="حذف"><i class="fa fa-trash"></i></button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        const container = document.getElementById('tvtime-main-container');
        if (!container) return;
        wireImgFallbacks(container);

        const newScrollEl = document.getElementById('tvtime-discover-results') || document.getElementById('tvtime-search-results');
        if (newScrollEl && savedScrollTop) newScrollEl.scrollTop = savedScrollTop;

        // Tab switching
        container.querySelectorAll('.tvtime-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                refreshView();
            });
        });

        // Search panel toggle - loads the discover/browse feed once, the first time it opens.
        async function ensureDiscoverLoaded() {
            if (discoverLoadedOnce || isDiscoverLoading) return;
            isDiscoverLoading = true;
            discoverLoadedOnce = true;
            refreshView();
            discoverResults = await loadDiscoverResults();
            isDiscoverLoading = false;
            refreshView();
        }

        const toggleSearchBtn = document.getElementById('tvtime-toggle-search-btn');
        if (toggleSearchBtn) {
            toggleSearchBtn.addEventListener('click', () => {
                isSearchOpen = !isSearchOpen;
                refreshView();
                if (isSearchOpen && !searchQuery) ensureDiscoverLoaded();
            });
        }

        const aiSuggestBtn = document.getElementById('tvtime-ai-suggest-btn');
        if (aiSuggestBtn) {
            aiSuggestBtn.addEventListener('click', () => askAIForWatchSuggestion(items));
        }

        const emptySearchBtn = document.getElementById('tvtime-empty-search-btn');
        if (emptySearchBtn) {
            emptySearchBtn.addEventListener('click', () => {
                isSearchOpen = true;
                refreshView();
                ensureDiscoverLoaded();
            });
        }

        if (isSearchOpen && !searchQuery) ensureDiscoverLoaded();

        const runSearchBtn = document.getElementById('tvtime-run-search-btn');
        const searchInput = document.getElementById('tvtime-search-input');
        if (runSearchBtn && searchInput) {
            const doSearch = async () => {
                const q = searchInput.value.trim();
                if (isSearching) return;
                if (!q) {
                    // Empty box + Enter/click = go back to the discover feed.
                    searchQuery = '';
                    refreshView();
                    ensureDiscoverLoaded();
                    return;
                }
                searchQuery = q;
                isSearching = true;
                refreshView();
                searchResults = await executeMediaOnlineSearch(q);
                isSearching = false;
                refreshView();
            };
            runSearchBtn.addEventListener('click', doSearch);
            searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') doSearch(); });
        }

        container.querySelectorAll('[data-discover-type]').forEach(btn => {
            btn.addEventListener('click', () => {
                discoverTypeFilter = btn.dataset.discoverType;
                discoverPage = 1;
                refreshView(true);
            });
        });

        const discoverYearSelect = document.getElementById('tvtime-discover-year');
        if (discoverYearSelect) {
            discoverYearSelect.addEventListener('change', () => {
                discoverYearFilter = discoverYearSelect.value;
                discoverPage = 1;
                refreshView(true);
            });
        }

        const discoverPrevBtn = document.getElementById('tvtime-discover-prev-btn');
        if (discoverPrevBtn) {
            discoverPrevBtn.addEventListener('click', () => {
                if (discoverPage <= 1) return;
                discoverPage--;
                refreshView(true);
            });
        }
        const discoverNextBtn = document.getElementById('tvtime-discover-next-btn');
        if (discoverNextBtn) {
            discoverNextBtn.addEventListener('click', () => {
                discoverPage++;
                refreshView(true);
            });
        }

        const addManualBtn = document.getElementById('tvtime-add-manual-btn');
        if (addManualBtn) {
            addManualBtn.addEventListener('click', () => openWatchlistEditModal(null, refreshView));
        }

        // Attach event listener to container (NOT body) so it never duplicates
        container.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;

            if (action === 'add-online') {
                if (isMediaAddLock) return;
                isMediaAddLock = true;
                const searchItem = searchResults.find(r => String(r.id) === String(id)) || discoverResults.find(r => String(r.id) === String(id));
                if (!searchItem) { isMediaAddLock = false; return; }
                btn.disabled = true;
                btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';
                await addOnlineMediaToWatchlist(searchItem, btn.dataset.targetStatus || 'watching');
                isMediaAddLock = false;
                await refreshView();
            }
            else if (action === 'ai-synopsis') {
                const searchItem = searchResults.find(r => String(r.id) === String(id)) || discoverResults.find(r => String(r.id) === String(id));
                if (!searchItem) return;
                const originalHtml = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';
                const res = await callAI(`یه معرفی کوتاه و کاملاً بدون اسپویل (حداکثر ۴ خط، به‌صورت یک پاراگراف پیوسته بدون خط جدید) از این ${searchItem.type === 'series' ? 'سریال' : 'فیلم'} به فارسی بده: «${searchItem.title}»${searchItem.year ? ' (' + searchItem.year + ')' : ''}. فقط درباره‌ی ژانر، حال‌وهوا، و چرا ارزش دیدن داره بگو، بدون لو دادن داستان یا پایان.`);
                btn.disabled = false;
                btn.innerHTML = originalHtml;
                await showAlert(
                    (res && res.success && res.answer) ? res.answer : ((res && res.error) || 'دریافت توضیح ممکن نشد'),
                    searchItem.title
                );
            }
            else if (action === 'plus1') {
                await incrementSeriesEpisode(id);
                await refreshView();
            }
            else if (action === 'open-episodes') {
                const currentItems = await getWatchlistItems();
                const item = currentItems.find(i => String(i.id) === String(id));
                if (item) openEpisodesChecklistModal(item, refreshView);
            }
            else if (action === 'rate') {
                const currentItems = await getWatchlistItems();
                const item = currentItems.find(i => String(i.id) === String(id));
                if (item) openRatingAndNotesModal(item, refreshView);
            }
            else if (action === 'edit') {
                const currentItems = await getWatchlistItems();
                const item = currentItems.find(i => String(i.id) === String(id));
                if (item) openWatchlistEditModal(item, refreshView);
            }
            else if (action === 'delete') {
                const ok = await showConfirm('آیا از حذف این عنوان از واچ‌لیست مطمئن هستید؟', 'حذف فیلم/سریال');
                if (ok) {
                    await deleteWatchlistItem(id);
                    await refreshView();
                }
            }
        });
    }

    await refreshView();
};

// --- Online Media Search Engine (TVMaze for Series & MoviesAPI for Movies) ---
async function executeMediaOnlineSearch(query) {
    const results = [];
    try {
        // 1. Search TVMaze (Best for TV Shows & complete episode details)
        const tvmazePromise = fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`)
            .then(r => r.json())
            .then(data => {
                (data || []).slice(0, 8).forEach(entry => {
                    const s = entry.show;
                    if (!s) return;
                    results.push({
                        id: `tvmaze_${s.id}`,
                        rawId: s.id,
                        source: 'tvmaze',
                        title: s.name,
                        type: 'series',
                        poster: s.image ? (s.image.medium || s.image.original) : null,
                        rating: s.rating ? s.rating.average : null,
                        year: s.premiered ? s.premiered.substring(0, 4) : '',
                        genres: (s.genres || []).join(', '),
                        summary: s.summary ? s.summary.replace(/<[^>]*>?/gm, '') : ''
                    });
                });
            }).catch(() => {});

        // 2. Search MoviesAPI (for Movies)
        const moviesPromise = fetch(`https://moviesapi.ir/api/v1/movies?q=${encodeURIComponent(query)}`)
            .then(r => r.json())
            .then(data => {
                (data.data || []).slice(0, 8).forEach(m => {
                    results.push({
                        id: `movie_${m.id}`,
                        rawId: m.id,
                        source: 'moviesapi',
                        title: m.title,
                        type: 'movie',
                        poster: m.poster,
                        rating: m.imdb_rating,
                        year: m.year,
                        genres: (m.genres || []).join(', ')
                    });
                });
            }).catch(() => {});

        await Promise.allSettled([tvmazePromise, moviesPromise]);
    } catch (e) {
        console.error('Search media error:', e);
    }
    return results;
}

// --- Discover / Browse Without Searching (top-rated movies & series) ---
// moviesapi.ir's unfiltered listing is already an IMDB-top-250-style, rating-sorted
// feed (confirmed by inspection - no query needed, ?page=N paginates it). TVMaze has
// no such endpoint, but each show in its general index carries a documented "weight"
// popularity score plus its own rating, so page 0 (240 shows) sorted by those client-side
// gives a reasonable "popular series" list from a single request.
async function fetchDiscoverMovies() {
    try {
        // moviesapi.ir's unfiltered feed is a fixed IMDB-top-250-style list - 25 pages
        // of 10, confirmed via its own metadata.page_count. Fetch all of it.
        const pageNumbers = Array.from({ length: 25 }, (_, i) => i + 1);
        const pages = await Promise.all(pageNumbers.map(p =>
            fetch(`https://moviesapi.ir/api/v1/movies?page=${p}`).then(r => r.json()).catch(() => null)
        ));
        const results = [];
        pages.forEach(json => {
            ((json && json.data) || []).forEach(m => {
                results.push({
                    id: `movie_${m.id}`,
                    rawId: m.id,
                    source: 'moviesapi',
                    title: m.title,
                    type: 'movie',
                    poster: m.poster,
                    rating: m.imdb_rating,
                    year: m.year,
                    genres: (m.genres || []).join(', ')
                });
            });
        });
        return results;
    } catch (e) {
        return [];
    }
}

async function fetchDiscoverSeries() {
    try {
        // TVMaze has no "top rated" endpoint, but its general show index paginates
        // ~240 shows/page and each entry carries a documented "weight" popularity
        // score - pull a wide enough pool (~2400 shows) that sorting by weight+
        // rating client-side gives a real top-250-ish list, matching the movie feed.
        const pageNumbers = Array.from({ length: 10 }, (_, i) => i);
        const pages = await Promise.all(pageNumbers.map(p =>
            fetch(`https://api.tvmaze.com/shows?page=${p}`).then(r => r.ok ? r.json() : []).catch(() => [])
        ));
        const shows = [].concat(...pages);
        return shows
            .filter(s => s.rating && s.rating.average)
            .sort((a, b) => (b.weight || 0) - (a.weight || 0) || (b.rating.average - a.rating.average))
            .slice(0, 250)
            .map(s => ({
                id: `tvmaze_${s.id}`,
                rawId: s.id,
                source: 'tvmaze',
                title: s.name,
                type: 'series',
                poster: s.image ? (s.image.medium || s.image.original) : null,
                rating: s.rating ? s.rating.average : null,
                year: s.premiered ? s.premiered.substring(0, 4) : '',
                genres: (s.genres || []).join(', ')
            }));
    } catch (e) {
        return [];
    }
}

async function loadDiscoverResults() {
    const [movies, series] = await Promise.all([fetchDiscoverMovies(), fetchDiscoverSeries()]);
    return [...movies, ...series].sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
}

// Shared card markup for both the search-results grid and the discover/browse grid.
function isMediaAlreadyAdded(searchItem, watchlist) {
    return (watchlist || []).some(i =>
        (i.external_id && String(i.external_id) === String(searchItem.id)) ||
        (i.title && i.title.toLowerCase().trim() === searchItem.title.toLowerCase().trim() && (i.media_type || 'movie') === searchItem.type)
    );
}

function renderMediaResultCard(r, watchlist) {
    const alreadyAdded = isMediaAlreadyAdded(r, watchlist);
    const addBtns = alreadyAdded
        ? `<span class="tvtime-already-added"><i class="fa fa-check-circle"></i> در لیست شما هست</span>`
        : `
            <button class="tvtime-btn-chip" data-action="add-online" data-id="${escapeHtml(r.id)}" data-type="${escapeHtml(r.type)}" data-target-status="watching" title="افزودن به در حال تماشا">
                <i class="fa fa-play"></i> تماشا
            </button>
            <button class="tvtime-btn-chip secondary" data-action="add-online" data-id="${escapeHtml(r.id)}" data-type="${escapeHtml(r.type)}" data-target-status="plan" title="افزودن به بعداً">
                <i class="fa fa-bookmark"></i> بعداً
            </button>
            <button class="tvtime-btn-chip secondary" data-action="add-online" data-id="${escapeHtml(r.id)}" data-type="${escapeHtml(r.type)}" data-target-status="completed" title="دیده‌شده">
                <i class="fa fa-check"></i> دیدم
            </button>
        `;

    return `
        <div class="tvtime-search-card${alreadyAdded ? ' already-added' : ''}">
            <img src="${escapeHtml(r.poster || 'icons/icon48.png')}" class="tvtime-search-poster" alt="${escapeHtml(r.title)}" data-fallback="icons/icon48.png">
            <div class="tvtime-search-info">
                <div class="tvtime-search-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</div>
                <div class="tvtime-search-meta">
                    <span style="color:${r.type === 'series' ? '#a855f7' : '#0ea5e9'}; font-weight:700;">${r.type === 'series' ? 'سریال' : 'فیلم'}</span>
                    ${r.year ? `<span>• ${escapeHtml(r.year)}</span>` : ''}
                    ${r.rating ? `<span>• ⭐ ${escapeHtml(r.rating)}</span>` : ''}
                </div>
                <div class="tvtime-search-add-btns">
                    ${addBtns}
                    <button class="tvtime-btn-chip secondary" data-action="ai-synopsis" data-id="${escapeHtml(r.id)}" title="معرفی کوتاه و بدون اسپویل با AI">
                        <i class="fa fa-robot"></i>
                    </button>
                </div>
            </div>
        </div>
    `;
}

// --- Add Search Item to Watchlist & Prevent Duplication ---
async function addOnlineMediaToWatchlist(searchItem, targetStatus = 'watching') {
    const currentList = await getWatchlistItems();

    // Check if item already exists in watchlist
    const existingIndex = currentList.findIndex(i =>
        (i.external_id && String(i.external_id) === String(searchItem.id)) ||
        (i.title && i.title.toLowerCase().trim() === searchItem.title.toLowerCase().trim() && (i.media_type || 'movie') === searchItem.type)
    );

    if (existingIndex !== -1) {
        // Item already in list - update status
        currentList[existingIndex].status = targetStatus;
        await apiCall('update_watchlist_progress', 'POST', {
            id: currentList[existingIndex].id,
            status: targetStatus
        });
        await saveWatchlistItems(currentList);
        showAlert(`«${searchItem.title}» از قبل در لیست شما وجود داشت و وضعیت آن به‌روزرسانی شد.`, 'اطلاع');
        return;
    }

    let totalSeasons = 1;
    let totalEpisodes = searchItem.type === 'series' ? 10 : 1;
    let episodesData = [];
    let currentSeason = 1;
    let currentEpisode = 0;

    if (searchItem.type === 'series' && searchItem.source === 'tvmaze') {
        try {
            const epRes = await fetch(`https://api.tvmaze.com/shows/${searchItem.rawId}/episodes`);
            if (epRes.ok) {
                const epList = await epRes.json();
                if (Array.isArray(epList) && epList.length > 0) {
                    totalEpisodes = epList.length;
                    episodesData = epList.map(ep => {
                        if (ep.season > totalSeasons) totalSeasons = ep.season;
                        return {
                            id: ep.id,
                            season: ep.season,
                            number: ep.number,
                            name: ep.name || `قسمت ${ep.number}`,
                            airdate: ep.airdate || '',
                            watched: targetStatus === 'completed'
                        };
                    });
                    if (targetStatus === 'completed') {
                        currentSeason = totalSeasons;
                        currentEpisode = totalEpisodes;
                    }
                }
            }
        } catch (e) {
            console.error('Error fetching series episodes:', e);
        }
    }

    const payload = {
        title: searchItem.title,
        media_type: searchItem.type,
        poster_url: searchItem.poster || '',
        status: targetStatus,
        current_season: currentSeason,
        current_episode: currentEpisode,
        total_seasons: totalSeasons,
        total_episodes: totalEpisodes,
        episodes_data: episodesData,
        imdb_rating: searchItem.rating ? String(searchItem.rating) : null,
        year: searchItem.year ? String(searchItem.year) : null,
        external_id: searchItem.id
    };

    // Save to server
    const apiRes = await apiCall('save_watchlist_item', 'POST', payload);
    const newId = apiRes && apiRes.id ? apiRes.id : Date.now();
    payload.id = newId;

    // Save to local cache
    currentList.unshift(payload);
    await saveWatchlistItems(currentList);
}

// --- Quick +1 Episode Increment Engine ---
async function incrementSeriesEpisode(itemId) {
    const items = await getWatchlistItems();
    const item = items.find(i => String(i.id) === String(itemId));
    if (!item) return;

    let curEp = parseInt(item.current_episode, 10) || 0;
    const totalEps = parseInt(item.total_episodes, 10) || 0;
    curEp++;

    let episodesData = [];
    if (item.episodes_data) {
        episodesData = typeof item.episodes_data === 'string' ? JSON.parse(item.episodes_data) : item.episodes_data;
    }

    // Mark the next unwatched episode as watched
    let nextSeason = item.current_season || 1;
    if (Array.isArray(episodesData) && episodesData.length > 0) {
        const nextUnwatched = episodesData.find(ep => !ep.watched);
        if (nextUnwatched) {
            nextUnwatched.watched = true;
            nextSeason = nextUnwatched.season;
        }
    }

    item.current_episode = curEp;
    item.current_season = nextSeason;
    item.episodes_data = episodesData;

    // If reached or exceeded total episodes, check completion
    if (totalEps > 0 && curEp >= totalEps) {
        item.status = 'completed';
        item.current_episode = totalEps;
        showAlert(`🎉 تبریک! تمام قسمت‌های «${item.title}» را تماشا کردید و به بخش دیده‌شده‌ها منتقل شد.`, 'پایان سریال');
    }

    await apiCall('update_watchlist_progress', 'POST', {
        id: item.id,
        current_episode: item.current_episode,
        current_season: item.current_season,
        status: item.status,
        episodes_data: item.episodes_data
    });

    await saveWatchlistItems(items);
}

// --- Episodes Checklist Modal ---
function openEpisodesChecklistModal(item, onCloseCallback) {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = `<i class="fa fa-list-check" style="color:var(--primary-color);"></i> قسمت‌های «${escapeHtml(item.title)}»`;

    let episodesData = [];
    if (item.episodes_data) {
        episodesData = typeof item.episodes_data === 'string' ? JSON.parse(item.episodes_data) : item.episodes_data;
    }

    // Generate basic episodes array if missing
    if (!Array.isArray(episodesData) || episodesData.length === 0) {
        const totalEps = parseInt(item.total_episodes, 10) || 10;
        const totalSeasons = parseInt(item.total_seasons, 10) || 1;
        const epsPerSeason = Math.ceil(totalEps / totalSeasons);
        episodesData = [];
        let epCount = 0;
        for (let s = 1; s <= totalSeasons; s++) {
            for (let e = 1; e <= epsPerSeason && epCount < totalEps; e++) {
                epCount++;
                episodesData.push({
                    id: `${item.id}_s${s}_e${e}`,
                    season: s,
                    number: e,
                    name: `قسمت ${e}`,
                    airdate: '',
                    watched: epCount <= (item.current_episode || 0)
                });
            }
        }
    }

    const seasons = [...new Set(episodesData.map(ep => ep.season))].sort((a, b) => a - b);
    let activeSeason = seasons[0] || 1;

    function renderEpisodesList() {
        const totalWatched = episodesData.filter(ep => ep.watched).length;
        const totalCount = episodesData.length;
        const progressPct = totalCount > 0 ? Math.round((totalWatched / totalCount) * 100) : 0;
        const seasonEpisodes = episodesData.filter(ep => ep.season === activeSeason);

        body.innerHTML = `
            <div class="tvtime-episodes-container" id="tvtime-episodes-main-container">
                <div class="tvtime-episodes-header">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <button class="btn-secondary" id="tvtime-episodes-back-btn" style="padding:0.4rem 0.8rem; font-size:0.8rem;">
                            <i class="fa fa-arrow-right"></i> بازگشت به لیست
                        </button>
                        <span style="font-size:0.9rem; font-weight:700;">پیشرفت کلی: ${totalWatched} از ${totalCount} قسمت (${progressPct}٪)</span>
                    </div>
                    <button class="btn-primary" id="tvtime-season-mark-all-btn" style="padding:0.4rem 0.8rem; font-size:0.78rem;">
                        <i class="fa fa-check-double"></i> علامت‌گذاری کل فصل ${activeSeason}
                    </button>
                </div>

                <!-- Season Selector Tabs -->
                ${seasons.length > 1 ? `
                    <div class="tvtime-season-selector">
                        ${seasons.map(s => `
                            <button class="tvtime-season-btn ${s === activeSeason ? 'active' : ''}" data-season="${s}">
                                فصل ${s}
                            </button>
                        `).join('')}
                    </div>
                ` : ''}

                <!-- Episodes List -->
                <div class="tvtime-episodes-list">
                    ${seasonEpisodes.map(ep => `
                        <div class="tvtime-episode-row ${ep.watched ? 'watched' : ''}" data-ep-id="${ep.id}">
                            <div class="tvtime-ep-info-left">
                                <span class="tvtime-ep-num">E${ep.number}</span>
                                <div>
                                    <div class="tvtime-ep-name">${escapeHtml(ep.name || `قسمت ${ep.number}`)}</div>
                                    ${ep.airdate ? `<div class="tvtime-ep-date">${escapeHtml(ep.airdate)}</div>` : ''}
                                </div>
                            </div>
                            <div class="tvtime-ep-check">
                                <i class="fa fa-check"></i>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        const epContainer = document.getElementById('tvtime-episodes-main-container');
        if (!epContainer) return;

        // Back button
        const backBtn = document.getElementById('tvtime-episodes-back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                openMovieTrackerTool();
            });
        }

        // Season tab switch
        epContainer.querySelectorAll('.tvtime-season-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activeSeason = parseInt(btn.dataset.season, 10);
                renderEpisodesList();
            });
        });

        // Mark whole season as watched
        const markAllBtn = document.getElementById('tvtime-season-mark-all-btn');
        if (markAllBtn) {
            markAllBtn.addEventListener('click', async () => {
                const allWatched = seasonEpisodes.every(ep => ep.watched);
                seasonEpisodes.forEach(ep => { ep.watched = !allWatched; });
                await syncEpisodesProgress();
                renderEpisodesList();
            });
        }

        // Toggle individual episode
        epContainer.querySelectorAll('.tvtime-episode-row').forEach(row => {
            row.addEventListener('click', async () => {
                const epId = row.dataset.epId;
                const ep = episodesData.find(e => String(e.id) === String(epId));
                if (ep) {
                    ep.watched = !ep.watched;
                    await syncEpisodesProgress();
                    renderEpisodesList();
                }
            });
        });
    }

    async function syncEpisodesProgress() {
        const watchedCount = episodesData.filter(ep => ep.watched).length;
        const totalCount = episodesData.length;
        item.current_episode = watchedCount;
        item.episodes_data = episodesData;

        if (totalCount > 0 && watchedCount >= totalCount) {
            item.status = 'completed';
        } else if (watchedCount > 0 && item.status === 'plan') {
            item.status = 'watching';
        }

        const items = await getWatchlistItems();
        const idx = items.findIndex(i => String(i.id) === String(item.id));
        if (idx !== -1) items[idx] = item;
        await saveWatchlistItems(items);

        await apiCall('update_watchlist_progress', 'POST', {
            id: item.id,
            current_episode: item.current_episode,
            status: item.status,
            episodes_data: item.episodes_data
        });
    }

    renderEpisodesList();
}

// --- Watchlist Manual Add / Edit Modal ---
function openWatchlistEditModal(itemToEdit, onSavedCallback) {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    const isEdit = !!itemToEdit;
    title.innerHTML = isEdit ? `<i class="fa fa-edit"></i> ویرایش «${escapeHtml(itemToEdit.title)}»` : '<i class="fa fa-plus"></i> افزودن دستی عنوان جدید';

    const item = itemToEdit || {
        title: '',
        media_type: 'series',
        status: 'watching',
        poster_url: '',
        current_season: 1,
        current_episode: 0,
        total_seasons: 1,
        total_episodes: 10,
        imdb_rating: '',
        year: '',
        notes: ''
    };

    body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:0.9rem; max-width:480px; margin:0 auto;">
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">عنوان اثر *</label>
                <input type="text" id="wedit-title" value="${escapeHtml(item.title)}" placeholder="مثال: Game of Thrones یا Oppenheimer" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">نوع اثر</label>
                    <select id="wedit-type" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                        <option value="series" ${item.media_type === 'series' ? 'selected' : ''}>سریال تلویزیونی</option>
                        <option value="movie" ${item.media_type === 'movie' ? 'selected' : ''}>فیلم سینمایی</option>
                    </select>
                </div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">وضعیت تماشا</label>
                    <select id="wedit-status" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                        <option value="watching" ${item.status === 'watching' ? 'selected' : ''}>در حال تماشا</option>
                        <option value="plan" ${item.status === 'plan' ? 'selected' : ''}>می‌خواهم ببینم</option>
                        <option value="completed" ${item.status === 'completed' ? 'selected' : ''}>دیده‌شده</option>
                    </select>
                </div>
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">لینک تصویر پوستر (اختیاری)</label>
                <input type="url" id="wedit-poster" value="${escapeHtml(item.poster_url || '')}" placeholder="https://.../poster.jpg" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left;">
            </div>
            <div id="wedit-series-fields" style="display:${item.media_type === 'series' ? 'grid' : 'none'}; grid-template-columns:1fr 1fr; gap:0.75rem;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">فصل فعلی</label>
                    <input type="number" id="wedit-cur-season" value="${item.current_season || 1}" min="1" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                </div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">تعداد کل فصل‌ها</label>
                    <input type="number" id="wedit-tot-seasons" value="${item.total_seasons || 1}" min="1" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                </div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">قسمت دیده‌شده</label>
                    <input type="number" id="wedit-cur-ep" value="${item.current_episode || 0}" min="0" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                </div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">تعداد کل قسمت‌ها</label>
                    <input type="number" id="wedit-tot-eps" value="${item.total_episodes || 10}" min="1" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">سال ساخت</label>
                    <input type="text" id="wedit-year" value="${escapeHtml(item.year || '')}" placeholder="مثال: 2024" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left;">
                </div>
                <div>
                    <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">امتیاز IMDb</label>
                    <input type="text" id="wedit-imdb" value="${escapeHtml(item.imdb_rating || '')}" placeholder="مثال: 8.9" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left;">
                </div>
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">یادداشت یا لینک استریم (اختیاری)</label>
                <textarea id="wedit-notes" placeholder="نقد، نظر شخصی یا لینک دانلود..." style="width:100%; height:70px; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); resize:vertical;">${escapeHtml(item.notes || '')}</textarea>
            </div>
            <div style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:0.5rem;">
                <button class="btn-secondary" id="wedit-cancel-btn">انصراف</button>
                <button class="btn-primary" id="wedit-save-btn">ذخیره عنوان</button>
            </div>
        </div>
    `;

    document.getElementById('wedit-type').addEventListener('change', (e) => {
        document.getElementById('wedit-series-fields').style.display = e.target.value === 'series' ? 'grid' : 'none';
    });

    document.getElementById('wedit-cancel-btn').addEventListener('click', () => {
        openMovieTrackerTool();
    });

    document.getElementById('wedit-save-btn').addEventListener('click', async (e) => {
        const saveBtn = e.target;
        const titleVal = document.getElementById('wedit-title').value.trim();
        if (!titleVal) {
            showAlert('لطفاً عنوان اثر را وارد کنید.', 'خطا');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';

        const typeVal = document.getElementById('wedit-type').value;
        const payload = {
            id: isEdit ? item.id : undefined,
            title: titleVal,
            media_type: typeVal,
            status: document.getElementById('wedit-status').value,
            poster_url: document.getElementById('wedit-poster').value.trim(),
            current_season: typeVal === 'series' ? parseInt(document.getElementById('wedit-cur-season').value, 10) || 1 : 1,
            total_seasons: typeVal === 'series' ? parseInt(document.getElementById('wedit-tot-seasons').value, 10) || 1 : 1,
            current_episode: typeVal === 'series' ? parseInt(document.getElementById('wedit-cur-ep').value, 10) || 0 : 0,
            total_episodes: typeVal === 'series' ? parseInt(document.getElementById('wedit-tot-eps').value, 10) || 1 : 1,
            year: document.getElementById('wedit-year').value.trim(),
            imdb_rating: document.getElementById('wedit-imdb').value.trim(),
            notes: document.getElementById('wedit-notes').value.trim(),
            episodes_data: isEdit ? item.episodes_data : null
        };

        const apiRes = await apiCall('save_watchlist_item', 'POST', payload);
        const savedId = (apiRes && apiRes.id) ? apiRes.id : (isEdit ? item.id : Date.now());
        payload.id = savedId;

        const items = await getWatchlistItems();
        if (isEdit) {
            const idx = items.findIndex(i => String(i.id) === String(item.id));
            if (idx !== -1) items[idx] = { ...items[idx], ...payload };
        } else {
            items.unshift(payload);
        }
        await saveWatchlistItems(items);
        openMovieTrackerTool();
    });
}

// --- Star Rating & Notes Modal ---
function openRatingAndNotesModal(item, onSavedCallback) {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = `<i class="fa fa-star" style="color:#facc15;"></i> امتیاز و یادداشت «${escapeHtml(item.title)}»`;

    let selectedRating = item.rating || 0;

    body.innerHTML = `
        <div style="text-align:center; max-width:440px; margin:0 auto;">
            <p class="text-muted" style="font-size:0.9rem;">به این اثر از ۱ تا ۱۰ چه امتیازی می‌دهید؟</p>
            <div class="tvtime-stars-box" id="tvtime-stars-wrap">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(num => `
                    <span class="tvtime-star-item ${num <= selectedRating ? 'active' : ''}" data-star="${num}">★</span>
                `).join('')}
            </div>
            <div id="tvtime-rating-display" style="font-size:1.2rem; font-weight:700; color:#facc15; margin-bottom:1.2rem;">
                ${selectedRating ? `${selectedRating} از ۱۰` : 'بدون امتیاز'}
            </div>

            <textarea id="tvtime-notes-input" placeholder="یادداشت، نقد کوتاه، نظر شخصی یا لینک استریم..." style="width:100%; height:90px; padding:0.7rem; border-radius:10px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); resize:vertical; font-family:inherit;">${escapeHtml(item.notes || '')}</textarea>

            <div style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:1.2rem;">
                <button class="btn-secondary" id="tvtime-rate-cancel-btn">انصراف</button>
                <button class="btn-primary" id="tvtime-rate-save-btn">ثبت امتیاز و یادداشت</button>
            </div>
        </div>
    `;

    const starsWrap = document.getElementById('tvtime-stars-wrap');
    const ratingDisplay = document.getElementById('tvtime-rating-display');

    starsWrap.querySelectorAll('.tvtime-star-item').forEach(star => {
        star.addEventListener('click', () => {
            selectedRating = parseInt(star.dataset.star, 10);
            starsWrap.querySelectorAll('.tvtime-star-item').forEach(s => {
                const sNum = parseInt(s.dataset.star, 10);
                s.classList.toggle('active', sNum <= selectedRating);
            });
            ratingDisplay.textContent = `${selectedRating} از ۱۰`;
        });
    });

    document.getElementById('tvtime-rate-cancel-btn').addEventListener('click', () => {
        openMovieTrackerTool();
    });

    document.getElementById('tvtime-rate-save-btn').addEventListener('click', async (e) => {
        const rateBtn = e.target;
        rateBtn.disabled = true;
        const notesVal = document.getElementById('tvtime-notes-input').value.trim();
        item.rating = selectedRating || null;
        item.notes = notesVal;

        const items = await getWatchlistItems();
        const idx = items.findIndex(i => String(i.id) === String(item.id));
        if (idx !== -1) items[idx] = item;
        await saveWatchlistItems(items);

        await apiCall('update_watchlist_progress', 'POST', {
            id: item.id,
            rating: item.rating,
            notes: item.notes
        });

        openMovieTrackerTool();
    });
}

// --- Delete Watchlist Item ---
async function deleteWatchlistItem(itemId) {
    await apiCall('delete_watchlist_item', 'POST', { id: itemId });
    const items = await getWatchlistItems();
    const updated = items.filter(i => String(i.id) !== String(itemId));
    await saveWatchlistItems(updated);
}

// ==========================================================================
// FINANCE / MONTHLY LEDGER TRACKER (جایگزین اکسل درآمد و اقساط ماهانه)
// ==========================================================================
let financeYear = null;
let financeCategories = [];
let financeEntries = {}; // `${year}_${category_id}_${month}` -> entry row from server
let financeYearsShown = 2; // the selected year plus the following ones, loaded as the table is scrolled
const FINANCE_MAX_YEARS_SHOWN = 8;

function financeEntryKey(categoryId, month, year = financeYear) {
    return `${year}_${categoryId}_${month}`;
}

// Loads one year into financeEntries. Pass reset=true to drop everything loaded so far first.
async function loadFinanceData(year, reset = false) {
    const res = await apiCall('get_finance_data&year=' + year);
    financeCategories = (res && res.categories) || financeCategories;
    if (reset) financeEntries = {};
    ((res && res.entries) || []).forEach(e => {
        financeEntries[financeEntryKey(e.category_id, e.jmonth, year)] = e;
    });
}

async function loadFinanceVisibleYears() {
    await loadFinanceData(financeYear, true);
    for (let i = 1; i < financeYearsShown; i++) await loadFinanceData(financeYear + i);
}

function getFinanceEntry(categoryId, month, year = financeYear) {
    return financeEntries[financeEntryKey(categoryId, month, year)] || { amount: 0, is_paid: 0, paid_at: null, paid_method: null };
}

function computeFinanceMonthTotals(month, year = financeYear) {
    let income = 0, expense = 0;
    financeCategories.forEach(c => {
        const amt = parseFloat(getFinanceEntry(c.id, month, year).amount) || 0;
        if (c.type === 'income') income += amt; else expense += amt;
    });
    return { income, expense, balance: income - expense };
}

let financeActiveTab = 'monthly'; // monthly | checks | shopping | invoices
let financeChecks = [];
let shoppingListItems = [];
let clientInvoices = [];

window.openFinanceTrackerTool = async function() {
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    clearInterval(tempMailInterval);
    clearTimeout(reactionTimeout);

    title.innerHTML = '<i class="fa fa-wallet" style="color:#22c55e;"></i> مدیریت مالی و اقساط ماهانه';
    body.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem 0;">در حال بارگذاری...</div>';
    overlay.classList.add('active');
    document.querySelector('#modal-overlay .modal-content').classList.add('modal-fullscreen');

    if (!financeYear) {
        financeYear = jalaali.toJalaali(new Date()).jy;
    }

    financeYearsShown = 2;
    await loadFinanceVisibleYears();
    await renderFinanceModal();
};

async function renderFinanceModal() {
    const body = document.getElementById('modal-body');
    body.innerHTML = `
        <div class="finance-container" id="finance-main-container">
            <div class="finance-tabs">
                <button class="finance-tab-btn ${financeActiveTab === 'monthly' ? 'active' : ''}" data-finance-tab="monthly"><i class="fa fa-table"></i> جدول ماهانه</button>
                <button class="finance-tab-btn ${financeActiveTab === 'checks' ? 'active' : ''}" data-finance-tab="checks"><i class="fa fa-money-check"></i> دفترچه چک</button>
                <button class="finance-tab-btn ${financeActiveTab === 'shopping' ? 'active' : ''}" data-finance-tab="shopping"><i class="fa fa-heart"></i> لیست خرید</button>
                <button class="finance-tab-btn ${financeActiveTab === 'invoices' ? 'active' : ''}" data-finance-tab="invoices"><i class="fa fa-file-invoice-dollar"></i> فاکتور مشتری</button>
            </div>
            <div id="finance-tab-content"></div>
        </div>
    `;

    document.querySelectorAll('.finance-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            financeActiveTab = btn.dataset.financeTab;
            renderFinanceModal();
        });
    });

    if (financeActiveTab === 'monthly') renderFinanceTable();
    else if (financeActiveTab === 'checks') await renderFinanceChecksTab();
    else if (financeActiveTab === 'shopping') await renderFinanceShoppingTab();
    else if (financeActiveTab === 'invoices') await renderInvoicesTab();
}

function renderFinanceCell(cat, month, year = financeYear) {
    const entry = getFinanceEntry(cat.id, month, year);
    const amount = parseFloat(entry.amount) || 0;
    const isExpense = cat.type === 'expense';
    const paidTitle = entry.is_paid
        ? `پرداخت شد${entry.paid_at ? ' در ' + entry.paid_at : ''}${entry.paid_method ? ' - ' + entry.paid_method : ''}`
        : 'علامت‌گذاری پرداخت';
    const paidBadge = isExpense ? `
        <button class="finance-paid-badge ${entry.is_paid ? 'paid' : ''}" data-paid-badge data-cat-id="${cat.id}" data-month="${month}" data-year="${year}" title="${escapeHtml(paidTitle)}">
            <i class="fa fa-check"></i>
        </button>
    ` : '';
    return `
        <td>
            <div class="finance-cell-wrap">
                <input type="text" inputmode="decimal" class="finance-amount-input" data-amount-input data-cat-id="${cat.id}" data-month="${month}" data-year="${year}" value="${amount ? amount.toLocaleString() : ''}" placeholder="۰">
                ${paidBadge}
            </div>
        </td>
    `;
}

async function askAIAboutFinance(year, incomeCats, expenseCats, yearIncome, yearExpense) {
    const monthlyLines = [];
    for (let m = 1; m <= 12; m++) {
        const t = computeFinanceMonthTotals(m);
        if (t.income || t.expense) monthlyLines.push(`ماه ${m}: درآمد ${t.income.toLocaleString()} / هزینه ${t.expense.toLocaleString()} / مانده ${(t.income - t.expense).toLocaleString()}`);
    }
    const context = `جدول مالی سال ${year} کاربر:\n` +
        `دسته‌های درآمد: ${incomeCats.map(c => c.name).join('، ') || '-'}\n` +
        `دسته‌های هزینه: ${expenseCats.map(c => c.name).join('، ') || '-'}\n` +
        `جمع درآمد سال: ${yearIncome.toLocaleString()} تومان\nجمع هزینه سال: ${yearExpense.toLocaleString()} تومان\n\n` +
        `جزئیات ماهانه:\n${monthlyLines.join('\n') || 'داده‌ای ثبت نشده'}`;

    const question = await showPrompt('چه چیزی می‌خوای درباره‌ی وضعیت مالیت بدونی؟', 'خلاصه‌ای از وضعیت مالی من بده و نکات مهم رو بگو', 'تحلیل مالی با AI');
    if (!question) return;
    askAIWithContext(question, context, question);
}

// One year block of the continuous table: a year separator row followed by its 12 month rows.
function renderFinanceYearRows(year, incomeCats, expenseCats) {
    const jNow = jalaali.toJalaali(new Date());
    const isCurrentYear = year === jNow.jy;
    const colCount = incomeCats.length + expenseCats.length + 2;
    return `
        <tr class="finance-year-row" data-year-row="${year}"><td colspan="${colCount}">سال ${year}</td></tr>
        ${months.map((mName, idx) => {
            const m = idx + 1;
            const isCurrent = isCurrentYear && m === jNow.jm;
            const t = computeFinanceMonthTotals(m, year);
            return `
                <tr class="${isCurrent ? 'finance-current-month' : ''}" data-month-row="${m}" data-year="${year}">
                    <td class="finance-month-cell">${mName}</td>
                    ${incomeCats.map(c => renderFinanceCell(c, m, year)).join('')}
                    ${expenseCats.map(c => renderFinanceCell(c, m, year)).join('')}
                    <td class="finance-balance-cell ${t.balance >= 0 ? 'positive' : 'negative'}" data-balance-cell="${m}" data-year="${year}">${t.balance.toLocaleString()}</td>
                </tr>
            `;
        }).join('')}
    `;
}

// Appends the next year to the bottom of the table when the user scrolls near the end.
let financeLoadingMoreYears = false;
async function loadMoreFinanceYear() {
    if (financeLoadingMoreYears || financeYearsShown >= FINANCE_MAX_YEARS_SHOWN) return;
    const wrap = document.querySelector('#finance-tab-content .finance-table-wrap');
    const tbody = wrap && wrap.querySelector('tbody');
    if (!tbody) return;
    financeLoadingMoreYears = true;
    try {
        const nextYear = financeYear + financeYearsShown;
        await loadFinanceData(nextYear);
        if (!document.body.contains(tbody)) return; // user left the tab while loading
        financeYearsShown++;
        const incomeCats = financeCategories.filter(c => c.type === 'income');
        const expenseCats = financeCategories.filter(c => c.type === 'expense');
        tbody.insertAdjacentHTML('beforeend', renderFinanceYearRows(nextYear, incomeCats, expenseCats));
        wireFinanceRowEvents(document.getElementById('finance-main-container'));
    } finally {
        financeLoadingMoreYears = false;
    }
}

function renderFinanceTable() {
    const body = document.getElementById('finance-tab-content');

    const incomeCats = financeCategories.filter(c => c.type === 'income');
    const expenseCats = financeCategories.filter(c => c.type === 'expense');

    let yearIncome = 0, yearExpense = 0;
    for (let m = 1; m <= 12; m++) {
        const t = computeFinanceMonthTotals(m);
        yearIncome += t.income;
        yearExpense += t.expense;
    }

    body.innerHTML = `
        <div class="finance-toolbar">
            <div class="finance-year-nav">
                <button id="finance-prev-year-btn" title="سال قبل"><i class="fa fa-chevron-right"></i></button>
                <span>سال ${financeYear}</span>
                <button id="finance-next-year-btn" title="سال بعد"><i class="fa fa-chevron-left"></i></button>
            </div>
            <div class="finance-summary-badges">
                <span class="finance-badge income">درآمد سال: ${yearIncome.toLocaleString()}</span>
                <span class="finance-badge expense">هزینه سال: ${yearExpense.toLocaleString()}</span>
                <span class="finance-badge balance">مانده سال: ${(yearIncome - yearExpense).toLocaleString()}</span>
            </div>
            <button class="btn-secondary" id="finance-ai-analyze-btn" style="padding:0.45rem 0.9rem; font-size:0.82rem;">
                <i class="fa fa-robot"></i> تحلیل با AI
            </button>
            <button class="btn-primary" id="finance-add-cat-btn" style="padding:0.45rem 0.9rem; font-size:0.82rem;">
                <i class="fa fa-plus"></i> دسته جدید
            </button>
        </div>

        ${financeCategories.length === 0 ? `
            <div class="text-muted" style="text-align:center; padding:2rem 0;">
                هنوز دسته‌ای اضافه نکرده‌اید. با «دسته جدید» شروع کنید (مثلاً درآمد، وام، بیمه، قسط...).
            </div>
        ` : `
            <div class="finance-table-wrap">
                <table class="finance-table">
                    <thead>
                        <tr>
                            <th class="finance-month-header">ماه</th>
                            ${incomeCats.map(c => `
                                <th class="finance-type-income">
                                    <div class="finance-cat-header">
                                        <span>${escapeHtml(c.name)}</span>
                                        <button class="finance-cat-edit-btn" data-edit-cat="${c.id}" title="ویرایش/آرشیو دسته"><i class="fa fa-cog"></i></button>
                                    </div>
                                </th>
                            `).join('')}
                            ${expenseCats.map(c => `
                                <th class="finance-type-expense">
                                    <div class="finance-cat-header">
                                        <span>${escapeHtml(c.name)}</span>
                                        <button class="finance-cat-edit-btn" data-edit-cat="${c.id}" title="ویرایش/آرشیو دسته"><i class="fa fa-cog"></i></button>
                                    </div>
                                </th>
                            `).join('')}
                            <th>مانده</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${Array.from({ length: financeYearsShown }, (_, i) => renderFinanceYearRows(financeYear + i, incomeCats, expenseCats)).join('')}
                    </tbody>
                </table>
            </div>
        `}
    `;

    wireFinanceTableEvents();
}

function wireFinanceTableEvents() {
    const container = document.getElementById('finance-main-container');
    if (!container) return;

    document.getElementById('finance-prev-year-btn').addEventListener('click', async () => {
        financeYear--;
        financeYearsShown = 2;
        await loadFinanceVisibleYears();
        renderFinanceTable();
    });
    document.getElementById('finance-next-year-btn').addEventListener('click', async () => {
        financeYear++;
        financeYearsShown = 2;
        await loadFinanceVisibleYears();
        renderFinanceTable();
    });
    document.getElementById('finance-add-cat-btn').addEventListener('click', () => {
        openFinanceCategoryModal(null);
    });
    document.getElementById('finance-ai-analyze-btn').addEventListener('click', () => {
        const incomeCats = financeCategories.filter(c => c.type === 'income');
        const expenseCats = financeCategories.filter(c => c.type === 'expense');
        let yearIncome = 0, yearExpense = 0;
        for (let m = 1; m <= 12; m++) {
            const t = computeFinanceMonthTotals(m);
            yearIncome += t.income;
            yearExpense += t.expense;
        }
        askAIAboutFinance(financeYear, incomeCats, expenseCats, yearIncome, yearExpense);
    });

    container.querySelectorAll('[data-edit-cat]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cat = financeCategories.find(c => String(c.id) === String(btn.dataset.editCat));
            if (cat) openFinanceCategoryModal(cat);
        });
    });

    wireFinanceRowEvents(container);

    // Infinite scroll: the following year is appended when the user nears the bottom.
    const wrap = container.querySelector('.finance-table-wrap');
    if (wrap) {
        const maybeLoadMore = async () => {
            while (wrap.isConnected && wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 250 && financeYearsShown < FINANCE_MAX_YEARS_SHOWN) {
                const before = financeYearsShown;
                await loadMoreFinanceYear();
                if (financeYearsShown === before) break;
            }
        };
        wrap.addEventListener('scroll', maybeLoadMore);
        maybeLoadMore(); // a tall window may show the whole table without any scrolling
    }
}

// Wires the amount inputs and paid badges; safe to call again after rows are appended.
function wireFinanceRowEvents(container) {
    if (!container) return;

    container.querySelectorAll('[data-amount-input]:not([data-wired])').forEach(input => {
        input.dataset.wired = '1';
        // Show the raw digits (no thousands separators) while editing - easier to type/select -
        // then reformat with commas once the user is done (blur/change).
        input.addEventListener('focus', () => {
            const raw = parseFloat(String(input.value).replace(/,/g, '')) || 0;
            input.value = raw || '';
        });

        input.addEventListener('change', async () => {
            const catId = parseInt(input.dataset.catId, 10);
            const month = parseInt(input.dataset.month, 10);
            const amount = parseFloat(String(input.value).replace(/,/g, '')) || 0;
            input.value = amount ? amount.toLocaleString() : '';

            const year = parseInt(input.dataset.year, 10);
            const key = financeEntryKey(catId, month, year);
            financeEntries[key] = { ...(financeEntries[key] || {}), category_id: catId, jmonth: month, amount };
            await apiCall('save_finance_entry', 'POST', { category_id: catId, year, month, amount });

            const t = computeFinanceMonthTotals(month, year);
            const balanceCell = container.querySelector(`[data-balance-cell="${month}"][data-year="${year}"]`);
            if (balanceCell) {
                balanceCell.textContent = t.balance.toLocaleString();
                balanceCell.className = 'finance-balance-cell ' + (t.balance >= 0 ? 'positive' : 'negative');
            }
        });
    });

    container.querySelectorAll('[data-paid-badge]:not([data-wired])').forEach(badge => {
        badge.dataset.wired = '1';
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            const catId = parseInt(badge.dataset.catId, 10);
            const month = parseInt(badge.dataset.month, 10);
            openFinancePaidPopover(badge, catId, month, parseInt(badge.dataset.year, 10));
        });
    });
}

// --- Category Add/Edit/Archive Modal ---
function openFinanceCategoryModal(categoryToEdit) {
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    const isEdit = !!categoryToEdit;

    title.innerHTML = isEdit ? `<i class="fa fa-edit"></i> ویرایش دسته «${escapeHtml(categoryToEdit.name)}»` : '<i class="fa fa-plus"></i> افزودن دسته جدید';

    body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:0.9rem; max-width:420px; margin:0 auto;">
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">نام دسته</label>
                <input type="text" id="fcat-name" value="${isEdit ? escapeHtml(categoryToEdit.name) : ''}" placeholder="مثال: وام ازدواج، بیمه، حقوق..." style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">نوع</label>
                <select id="fcat-type" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                    <option value="income" ${isEdit && categoryToEdit.type === 'income' ? 'selected' : ''}>درآمد</option>
                    <option value="expense" ${!isEdit || categoryToEdit.type === 'expense' ? 'selected' : ''}>هزینه/قسط</option>
                </select>
            </div>
            <div style="display:flex; gap:0.75rem; justify-content:flex-end; align-items:center; margin-top:0.5rem;">
                ${isEdit ? '<button class="btn-secondary" id="fcat-archive-btn" style="margin-left:auto; color:var(--danger-color);"><i class="fa fa-box-archive"></i> آرشیو دسته</button>' : ''}
                <button class="btn-secondary" id="fcat-cancel-btn">انصراف</button>
                <button class="btn-primary" id="fcat-save-btn">ذخیره</button>
            </div>
        </div>
    `;

    document.getElementById('fcat-cancel-btn').addEventListener('click', () => renderFinanceModal());

    document.getElementById('fcat-save-btn').addEventListener('click', async () => {
        const name = document.getElementById('fcat-name').value.trim();
        if (!name) { showAlert('لطفاً نام دسته را وارد کنید.', 'خطا'); return; }
        const type = document.getElementById('fcat-type').value;
        await apiCall('save_finance_category', 'POST', { id: isEdit ? categoryToEdit.id : undefined, name, type });
        await loadFinanceVisibleYears();
        renderFinanceModal();
    });

    if (isEdit) {
        document.getElementById('fcat-archive-btn').addEventListener('click', async () => {
            const ok = await showConfirm(`دسته «${categoryToEdit.name}» آرشیو شود؟ اطلاعات ماه‌های قبلی حفظ می‌شود ولی این دسته دیگر در جدول نشان داده نمی‌شود.`, 'آرشیو دسته');
            if (!ok) return;
            await apiCall('archive_finance_category', 'POST', { id: categoryToEdit.id });
            await loadFinanceVisibleYears();
            renderFinanceModal();
        });
    }
}

// --- Mark Payment Popover (date + method) ---
function closeFinancePopover() {
    document.querySelectorAll('.finance-popover, .finance-popover-backdrop').forEach(el => el.remove());
}

// --- Reusable Jalali Date-Picker Popover (attach to any text input via a calendar button) ---
function closeDatePickerPopover() {
    document.querySelectorAll('.date-picker-popover, .date-picker-popover-backdrop').forEach(el => el.remove());
}

function openDatePickerPopover(anchorEl, initialDateStr, onSelect) {
    closeDatePickerPopover();
    if (typeof jalaali === 'undefined') return;

    const selectedStr = padJalaliDate(initialDateStr);
    let jy, jm;
    if (selectedStr) {
        const [y, m] = selectedStr.split('-').map(Number);
        jy = y; jm = m;
    } else {
        const t = jalaali.toJalaali(new Date());
        jy = t.jy; jm = t.jm;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'date-picker-popover-backdrop';
    backdrop.addEventListener('click', closeDatePickerPopover);
    document.body.appendChild(backdrop);

    const pop = document.createElement('div');
    pop.className = 'date-picker-popover';
    document.body.appendChild(pop);
    pop.addEventListener('click', (e) => e.stopPropagation());

    function positionPopover() {
        const rect = anchorEl.getBoundingClientRect();
        const popW = 260;
        let left = rect.left - popW / 2 + rect.width / 2;
        left = Math.max(10, Math.min(left, window.innerWidth - popW - 10));
        let top = rect.bottom + 8;
        if (top + 320 > window.innerHeight) top = Math.max(10, rect.top - 320 - 8);
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }

    function renderMonth() {
        const firstDayGreg = jalaali.toGregorian(jy, jm, 1);
        const d = new Date(firstDayGreg.gy, firstDayGreg.gm - 1, firstDayGreg.gd);
        let startDayOfWeek = d.getDay() + 1;
        if (startDayOfWeek === 7) startDayOfWeek = 0;
        const monthLength = jalaali.jalaaliMonthLength(jy, jm);
        const todayStr = getTodayJalaali();

        let daysHtml = '';
        for (let i = 0; i < startDayOfWeek; i++) daysHtml += '<span></span>';
        for (let day = 1; day <= monthLength; day++) {
            const dateStr = `${jy}-${jm}-${day}`;
            const isToday = padJalaliDate(dateStr) === padJalaliDate(todayStr);
            const isSelected = selectedStr && padJalaliDate(dateStr) === selectedStr;
            daysHtml += `<span class="date-picker-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}" data-pick-day="${day}">${day}</span>`;
        }

        pop.innerHTML = `
            <div class="date-picker-header">
                <button type="button" id="dp-prev-btn" title="ماه قبل"><i class="fa fa-chevron-right"></i></button>
                <span>${months[jm - 1]} ${jy}</span>
                <button type="button" id="dp-next-btn" title="ماه بعد"><i class="fa fa-chevron-left"></i></button>
            </div>
            <div class="date-picker-weekdays">
                <span>ش</span><span>ی</span><span>د</span><span>س</span><span>چ</span><span>پ</span><span>ج</span>
            </div>
            <div class="date-picker-days">${daysHtml}</div>
            <div class="date-picker-footer">
                <button type="button" class="btn-secondary" id="dp-today-btn">امروز</button>
                <button type="button" class="btn-secondary" id="dp-clear-btn">پاک کردن</button>
            </div>
        `;

        document.getElementById('dp-prev-btn').addEventListener('click', () => { jm--; if (jm < 1) { jm = 12; jy--; } renderMonth(); });
        document.getElementById('dp-next-btn').addEventListener('click', () => { jm++; if (jm > 12) { jm = 1; jy++; } renderMonth(); });
        document.getElementById('dp-today-btn').addEventListener('click', () => {
            const t = jalaali.toJalaali(new Date());
            onSelect(`${t.jy}-${t.jm}-${t.jd}`);
            closeDatePickerPopover();
        });
        document.getElementById('dp-clear-btn').addEventListener('click', () => {
            onSelect('');
            closeDatePickerPopover();
        });
        pop.querySelectorAll('[data-pick-day]').forEach(el => {
            el.addEventListener('click', () => {
                onSelect(`${jy}-${jm}-${el.dataset.pickDay}`);
                closeDatePickerPopover();
            });
        });

        positionPopover();
    }

    renderMonth();
}

// Wires a calendar-picker button (data-date-picker-for="<inputId>") to open the
// popover and write the selected date back into that input.
function wireDatePickerButtons(container) {
    if (!container) return;
    container.querySelectorAll('[data-date-picker-for]').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.datePickerFor);
            if (!input) return;
            openDatePickerPopover(input, input.value, (dateStr) => {
                input.value = dateStr;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });
    });
}

function updateFinancePaidBadge(categoryId, month, year = financeYear) {
    const badge = document.querySelector(`[data-paid-badge][data-cat-id="${categoryId}"][data-month="${month}"][data-year="${year}"]`);
    if (!badge) return;
    const entry = getFinanceEntry(categoryId, month, year);
    badge.classList.toggle('paid', !!entry.is_paid);
    const paidTitle = entry.is_paid
        ? `پرداخت شد${entry.paid_at ? ' در ' + entry.paid_at : ''}${entry.paid_method ? ' - ' + entry.paid_method : ''}`
        : 'علامت‌گذاری پرداخت';
    badge.title = paidTitle;
}

function openFinancePaidPopover(anchorEl, categoryId, month, year = financeYear) {
    closeFinancePopover();
    const entry = getFinanceEntry(categoryId, month, year);
    const rect = anchorEl.getBoundingClientRect();

    const backdrop = document.createElement('div');
    backdrop.className = 'finance-popover-backdrop';
    backdrop.addEventListener('click', closeFinancePopover);
    document.body.appendChild(backdrop);

    const pop = document.createElement('div');
    pop.className = 'finance-popover';
    pop.innerHTML = `
        <label>تاریخ پرداخت (شمسی)</label>
        <input type="text" id="fpaid-date" value="${escapeHtml(entry.paid_at || getTodayJalaali())}" placeholder="1405-5-20" style="direction:ltr; text-align:center;">
        <label>روش پرداخت</label>
        <input type="text" id="fpaid-method" list="fpaid-method-list" value="${escapeHtml(entry.paid_method || '')}" placeholder="مثال: کارت به کارت">
        <datalist id="fpaid-method-list">
            <option value="نقدی"></option>
            <option value="کارت به کارت"></option>
            <option value="انتقال بانکی"></option>
            <option value="چک"></option>
            <option value="اتوماتیک/یادآور بانک"></option>
        </datalist>
        <div class="finance-popover-actions">
            ${entry.is_paid ? '<button class="btn-secondary" id="fpaid-unmark-btn" style="flex:1; font-size:0.78rem; color:var(--danger-color);">حذف علامت</button>' : ''}
            <button class="btn-primary" id="fpaid-save-btn" style="flex:1; font-size:0.78rem;">ثبت پرداخت</button>
        </div>
    `;
    document.body.appendChild(pop);
    pop.addEventListener('click', (e) => e.stopPropagation());

    const popW = 260;
    let left = rect.left - popW / 2 + rect.width / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - popW - 10));
    let top = rect.bottom + 8;
    if (top + 220 > window.innerHeight) top = Math.max(10, rect.top - 220 - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    document.getElementById('fpaid-save-btn').addEventListener('click', async () => {
        const paidAt = document.getElementById('fpaid-date').value.trim() || getTodayJalaali();
        const paidMethod = document.getElementById('fpaid-method').value.trim() || null;
        await apiCall('toggle_finance_payment', 'POST', { category_id: categoryId, year, month, is_paid: 1, paid_at: paidAt, paid_method: paidMethod });
        financeEntries[financeEntryKey(categoryId, month, year)] = { ...entry, category_id: categoryId, jmonth: month, is_paid: 1, paid_at: paidAt, paid_method: paidMethod };
        closeFinancePopover();
        updateFinancePaidBadge(categoryId, month, year);
    });

    const unmarkBtn = document.getElementById('fpaid-unmark-btn');
    if (unmarkBtn) {
        unmarkBtn.addEventListener('click', async () => {
            await apiCall('toggle_finance_payment', 'POST', { category_id: categoryId, year, month, is_paid: 0 });
            financeEntries[financeEntryKey(categoryId, month, year)] = { ...entry, is_paid: 0, paid_at: null, paid_method: null };
            closeFinancePopover();
            updateFinancePaidBadge(categoryId, month, year);
        });
    }
}

// ==========================================================================
// CHECKBOOK TAB (list of checks with due dates)
// ==========================================================================
async function renderFinanceChecksTab() {
    const contentEl = document.getElementById('finance-tab-content');
    contentEl.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem 0;">در حال بارگذاری...</div>';
    const res = await apiCall('get_checks');
    financeChecks = (res && res.checks) || [];
    renderChecksList();
}

const CHECK_STATUS_LABELS = { pending: 'در انتظار', cashed: 'نقد شده', bounced: 'برگشت خورده' };

function renderChecksList() {
    const contentEl = document.getElementById('finance-tab-content');
    if (!contentEl) return;
    const todayStr = getTodayJalaali();
    const sorted = [...financeChecks].sort((a, b) => padJalaliDate(a.due_date).localeCompare(padJalaliDate(b.due_date)));
    const totalPending = financeChecks.filter(c => c.status === 'pending').reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);

    contentEl.innerHTML = `
        <div class="finance-toolbar">
            <div class="finance-discover-title"><i class="fa fa-money-check"></i> دفترچه چک</div>
            <div class="finance-summary-badges">
                <span class="finance-badge expense">مجموع چک‌های در انتظار: ${totalPending.toLocaleString()} تومان</span>
            </div>
            <button class="btn-primary" id="check-add-btn" style="padding:0.45rem 0.9rem; font-size:0.82rem;"><i class="fa fa-plus"></i> چک جدید</button>
        </div>
        <div class="finance-table-wrap" style="max-height:65vh;">
            ${sorted.length === 0 ? '<div class="text-muted" style="text-align:center; padding:2rem;">هنوز چکی ثبت نکرده‌اید.</div>' : `
                <table class="finance-table" style="white-space:normal;">
                    <thead>
                        <tr><th>عنوان / گیرنده</th><th>مبلغ (تومان)</th><th>تاریخ سررسید</th><th>وضعیت</th><th></th></tr>
                    </thead>
                    <tbody>
                        ${sorted.map(c => {
                            const isOverdue = c.status === 'pending' && c.due_date && padJalaliDate(c.due_date) < padJalaliDate(todayStr);
                            return `
                                <tr class="${isOverdue ? 'finance-current-month' : ''}">
                                    <td>${escapeHtml(c.title)}</td>
                                    <td style="font-family:sans-serif;">${(parseFloat(c.amount) || 0).toLocaleString()}</td>
                                    <td style="font-family:sans-serif;">${escapeHtml(c.due_date || '-')}${isOverdue ? ' <span style="color:var(--danger-color); font-size:0.72rem;">(سررسید گذشته)</span>' : ''}</td>
                                    <td><span class="finance-check-status-badge ${c.status}">${CHECK_STATUS_LABELS[c.status] || c.status}</span></td>
                                    <td style="white-space:nowrap;">
                                        <button class="icon-btn" data-check-cycle="${c.id}" title="تغییر وضعیت" style="width:26px; height:26px; font-size:0.7rem;"><i class="fa fa-sync"></i></button>
                                        <button class="icon-btn" data-check-edit="${c.id}" title="ویرایش" style="width:26px; height:26px; font-size:0.7rem;"><i class="fa fa-edit"></i></button>
                                        <button class="icon-btn" data-check-delete="${c.id}" title="حذف" style="width:26px; height:26px; font-size:0.7rem; color:var(--danger-color);"><i class="fa fa-trash"></i></button>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `}
        </div>
    `;

    document.getElementById('check-add-btn').addEventListener('click', () => openCheckForm(null));

    contentEl.querySelectorAll('[data-check-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
            const check = financeChecks.find(c => String(c.id) === btn.dataset.checkEdit);
            if (check) openCheckForm(check);
        });
    });
    contentEl.querySelectorAll('[data-check-delete]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ok = await showConfirm('این چک حذف شود؟', 'حذف چک');
            if (!ok) return;
            await apiCall('delete_check', 'POST', { id: btn.dataset.checkDelete });
            financeChecks = financeChecks.filter(c => String(c.id) !== btn.dataset.checkDelete);
            renderChecksList();
        });
    });
    contentEl.querySelectorAll('[data-check-cycle]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const check = financeChecks.find(c => String(c.id) === btn.dataset.checkCycle);
            if (!check) return;
            const cycle = { pending: 'cashed', cashed: 'bounced', bounced: 'pending' };
            check.status = cycle[check.status] || 'pending';
            await apiCall('update_check_status', 'POST', { id: check.id, status: check.status });
            renderChecksList();
        });
    });
}

function openCheckForm(checkToEdit) {
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    const isEdit = !!checkToEdit;

    title.innerHTML = isEdit ? `<i class="fa fa-edit"></i> ویرایش چک «${escapeHtml(checkToEdit.title)}»` : '<i class="fa fa-plus"></i> چک جدید';

    body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:0.9rem; max-width:420px; margin:0 auto;">
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">عنوان / در وجه چه کسی</label>
                <input type="text" id="check-form-title" value="${isEdit ? escapeHtml(checkToEdit.title) : ''}" placeholder="مثال: چک اجاره، در وجه فلانی..." style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">مبلغ (تومان)</label>
                <input type="text" inputmode="decimal" id="check-form-amount" value="${isEdit && checkToEdit.amount ? Number(checkToEdit.amount).toLocaleString() : ''}" placeholder="۰" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left; font-family:monospace;">
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">تاریخ سررسید (شمسی)</label>
                <div style="position:relative;">
                    <input type="text" id="check-form-date" value="${isEdit ? escapeHtml(checkToEdit.due_date || '') : ''}" placeholder="از تقویم انتخاب کن یا تایپ کن..." style="width:100%; padding:0.6rem 2.6rem 0.6rem 0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:center;">
                    <button type="button" class="icon-btn" data-date-picker-for="check-form-date" title="انتخاب از تقویم" style="position:absolute; top:50%; left:4px; transform:translateY(-50%); width:28px; height:28px; font-size:0.75rem;"><i class="fa fa-calendar-alt"></i></button>
                </div>
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">یادداشت (اختیاری)</label>
                <textarea id="check-form-notes" style="width:100%; height:60px; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); resize:vertical;">${isEdit ? escapeHtml(checkToEdit.notes || '') : ''}</textarea>
            </div>
            <div style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:0.5rem;">
                <button class="btn-secondary" id="check-form-cancel-btn">انصراف</button>
                <button class="btn-primary" id="check-form-save-btn">ذخیره</button>
            </div>
        </div>
    `;

    wireDatePickerButtons(body);
    wireLiveAmountFormatting(document.getElementById('check-form-amount'));

    document.getElementById('check-form-cancel-btn').addEventListener('click', () => renderFinanceModal());

    document.getElementById('check-form-save-btn').addEventListener('click', async () => {
        const t = document.getElementById('check-form-title').value.trim();
        if (!t) { showAlert('عنوان یا گیرنده‌ی چک را وارد کنید.', 'خطا'); return; }
        const amount = parseFloat(document.getElementById('check-form-amount').value.replace(/,/g, '')) || 0;
        const dueDate = document.getElementById('check-form-date').value.trim() || null;
        const notes = document.getElementById('check-form-notes').value.trim() || null;

        await apiCall('save_check', 'POST', {
            id: isEdit ? checkToEdit.id : undefined,
            title: t,
            amount,
            due_date: dueDate,
            notes,
            status: isEdit ? checkToEdit.status : 'pending'
        });
        financeActiveTab = 'checks';
        await renderFinanceModal();
    });
}

// ==========================================================================
// SHOPPING LIST TAB (e.g. wedding shopping list - name, price, done, target date)
// ==========================================================================
async function renderFinanceShoppingTab() {
    const contentEl = document.getElementById('finance-tab-content');
    contentEl.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem 0;">در حال بارگذاری...</div>';
    const res = await apiCall('get_shopping_list');
    shoppingListItems = (res && res.items) || [];
    renderShoppingList();
}

function renderShoppingList() {
    const contentEl = document.getElementById('finance-tab-content');
    if (!contentEl) return;
    const totalAll = shoppingListItems.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
    const totalDone = shoppingListItems.filter(i => Number(i.is_done)).reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
    const sorted = [...shoppingListItems].sort((a, b) => Number(a.is_done) - Number(b.is_done) || padJalaliDate(a.target_date).localeCompare(padJalaliDate(b.target_date)));

    contentEl.innerHTML = `
        <div class="finance-toolbar">
            <div class="finance-discover-title"><i class="fa fa-heart"></i> لیست خرید</div>
            <div class="finance-summary-badges">
                <span class="finance-badge income">خریداری‌شده: ${totalDone.toLocaleString()} تومان</span>
                <span class="finance-badge balance">جمع کل لیست: ${totalAll.toLocaleString()} تومان</span>
            </div>
            <button class="btn-primary" id="shop-add-btn" style="padding:0.45rem 0.9rem; font-size:0.82rem;"><i class="fa fa-plus"></i> مورد جدید</button>
        </div>
        <div class="finance-table-wrap" style="max-height:65vh;">
            ${sorted.length === 0 ? '<div class="text-muted" style="text-align:center; padding:2rem;">هنوز چیزی به لیست اضافه نکرده‌اید.</div>' : `
                <table class="finance-table" style="white-space:normal;">
                    <thead>
                        <tr><th></th><th>نام</th><th>قیمت (تومان)</th><th>موعد</th><th></th></tr>
                    </thead>
                    <tbody>
                        ${sorted.map(i => `
                            <tr>
                                <td><input type="checkbox" data-shop-toggle="${i.id}" ${Number(i.is_done) ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;"></td>
                                <td style="${Number(i.is_done) ? 'text-decoration:line-through; opacity:0.55;' : ''}">${escapeHtml(i.title)}</td>
                                <td style="font-family:sans-serif;">${(parseFloat(i.price) || 0).toLocaleString()}</td>
                                <td style="font-family:sans-serif;">${escapeHtml(i.target_date || '-')}</td>
                                <td style="white-space:nowrap;">
                                    <button class="icon-btn" data-shop-edit="${i.id}" title="ویرایش" style="width:26px; height:26px; font-size:0.7rem;"><i class="fa fa-edit"></i></button>
                                    <button class="icon-btn" data-shop-delete="${i.id}" title="حذف" style="width:26px; height:26px; font-size:0.7rem; color:var(--danger-color);"><i class="fa fa-trash"></i></button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `}
        </div>
    `;

    document.getElementById('shop-add-btn').addEventListener('click', () => openShoppingItemForm(null));

    contentEl.querySelectorAll('[data-shop-toggle]').forEach(cb => {
        cb.addEventListener('click', async () => {
            const item = shoppingListItems.find(i => String(i.id) === cb.dataset.shopToggle);
            if (!item) return;
            item.is_done = cb.checked ? 1 : 0;
            await apiCall('toggle_shopping_item', 'POST', { id: item.id, is_done: item.is_done });
            renderShoppingList();
        });
    });
    contentEl.querySelectorAll('[data-shop-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = shoppingListItems.find(i => String(i.id) === btn.dataset.shopEdit);
            if (item) openShoppingItemForm(item);
        });
    });
    contentEl.querySelectorAll('[data-shop-delete]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ok = await showConfirm('این مورد از لیست خرید حذف شود؟', 'حذف مورد');
            if (!ok) return;
            await apiCall('delete_shopping_item', 'POST', { id: btn.dataset.shopDelete });
            shoppingListItems = shoppingListItems.filter(i => String(i.id) !== btn.dataset.shopDelete);
            renderShoppingList();
        });
    });
}

function openShoppingItemForm(itemToEdit) {
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    const isEdit = !!itemToEdit;

    title.innerHTML = isEdit ? `<i class="fa fa-edit"></i> ویرایش «${escapeHtml(itemToEdit.title)}»` : '<i class="fa fa-plus"></i> افزودن به لیست خرید';

    body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:0.9rem; max-width:420px; margin:0 auto;">
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">نام مورد</label>
                <input type="text" id="shop-form-title" value="${isEdit ? escapeHtml(itemToEdit.title) : ''}" placeholder="مثال: لباس عروس، حلقه، تالار..." style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">قیمت (تومان)</label>
                <input type="text" inputmode="decimal" id="shop-form-price" value="${isEdit && itemToEdit.price ? Number(itemToEdit.price).toLocaleString() : ''}" placeholder="۰" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left; font-family:monospace;">
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">می‌خواد کی حل بشه (اختیاری)</label>
                <div style="position:relative;">
                    <input type="text" id="shop-form-date" value="${isEdit ? escapeHtml(itemToEdit.target_date || '') : ''}" placeholder="از تقویم انتخاب کن یا تایپ کن..." style="width:100%; padding:0.6rem 2.6rem 0.6rem 0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:center;">
                    <button type="button" class="icon-btn" data-date-picker-for="shop-form-date" title="انتخاب از تقویم" style="position:absolute; top:50%; left:4px; transform:translateY(-50%); width:28px; height:28px; font-size:0.75rem;"><i class="fa fa-calendar-alt"></i></button>
                </div>
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">یادداشت (اختیاری)</label>
                <textarea id="shop-form-notes" style="width:100%; height:60px; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); resize:vertical;">${isEdit ? escapeHtml(itemToEdit.notes || '') : ''}</textarea>
            </div>
            <div style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:0.5rem;">
                <button class="btn-secondary" id="shop-form-cancel-btn">انصراف</button>
                <button class="btn-primary" id="shop-form-save-btn">ذخیره</button>
            </div>
        </div>
    `;

    wireDatePickerButtons(body);
    wireLiveAmountFormatting(document.getElementById('shop-form-price'));

    document.getElementById('shop-form-cancel-btn').addEventListener('click', () => renderFinanceModal());

    document.getElementById('shop-form-save-btn').addEventListener('click', async () => {
        const t = document.getElementById('shop-form-title').value.trim();
        if (!t) { showAlert('نام مورد را وارد کنید.', 'خطا'); return; }
        const price = parseFloat(document.getElementById('shop-form-price').value.replace(/,/g, '')) || 0;
        const targetDate = document.getElementById('shop-form-date').value.trim() || null;
        const notes = document.getElementById('shop-form-notes').value.trim() || null;

        await apiCall('save_shopping_item', 'POST', {
            id: isEdit ? itemToEdit.id : undefined,
            title: t,
            price,
            target_date: targetDate,
            notes
        });
        financeActiveTab = 'shopping';
        await renderFinanceModal();
    });
}

// ==========================================================================
// CLIENT INVOICES TAB (for webmasters billing clients per project)
// ==========================================================================
async function renderInvoicesTab() {
    const contentEl = document.getElementById('finance-tab-content');
    contentEl.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem 0;">در حال بارگذاری...</div>';
    const res = await apiCall('get_client_invoices');
    clientInvoices = (res && res.invoices) || [];
    renderInvoicesList();
}

const INVOICE_STATUS_LABELS = { pending: 'در انتظار', paid: 'پرداخت‌شده', overdue: 'سررسیدگذشته' };

function invoiceProjectName(projectId) {
    if (!projectId) return '';
    const p = (projectsCache || []).find(pr => String(pr.id) === String(projectId));
    return p ? p.name : '';
}

function renderInvoicesList() {
    const contentEl = document.getElementById('finance-tab-content');
    if (!contentEl) return;
    const todayStr = getTodayJalaali();
    const sorted = [...clientInvoices].sort((a, b) => padJalaliDate(a.due_date).localeCompare(padJalaliDate(b.due_date)));
    const totalPending = clientInvoices.filter(i => i.status !== 'paid').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
    const totalPaid = clientInvoices.filter(i => i.status === 'paid').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);

    contentEl.innerHTML = `
        <div class="finance-toolbar">
            <div class="finance-discover-title"><i class="fa fa-file-invoice-dollar"></i> فاکتور مشتری</div>
            <div class="finance-summary-badges">
                <span class="finance-badge expense">مانده‌ی دریافتی: ${totalPending.toLocaleString()} تومان</span>
                <span class="finance-badge income">دریافت‌شده: ${totalPaid.toLocaleString()} تومان</span>
            </div>
            <button class="btn-primary" id="invoice-add-btn" style="padding:0.45rem 0.9rem; font-size:0.82rem;"><i class="fa fa-plus"></i> فاکتور جدید</button>
        </div>
        <div class="finance-table-wrap" style="max-height:65vh;">
            ${sorted.length === 0 ? '<div class="text-muted" style="text-align:center; padding:2rem;">هنوز فاکتوری ثبت نکرده‌اید.</div>' : `
                <table class="finance-table" style="white-space:normal;">
                    <thead>
                        <tr><th>عنوان</th><th>کارفرما / پروژه</th><th>مبلغ (تومان)</th><th>سررسید</th><th>وضعیت</th><th></th></tr>
                    </thead>
                    <tbody>
                        ${sorted.map(inv => {
                            const isOverdue = inv.status === 'pending' && inv.due_date && padJalaliDate(inv.due_date) < padJalaliDate(todayStr);
                            const clientLabel = [inv.client_name, invoiceProjectName(inv.project_id)].filter(Boolean).join(' • ');
                            return `
                                <tr class="${isOverdue ? 'finance-current-month' : ''}">
                                    <td>${escapeHtml(inv.title)}</td>
                                    <td class="text-muted" style="font-size:0.82rem;">${escapeHtml(clientLabel || '-')}</td>
                                    <td style="font-family:sans-serif;">${(parseFloat(inv.amount) || 0).toLocaleString()}</td>
                                    <td style="font-family:sans-serif;">${escapeHtml(inv.due_date || '-')}${isOverdue ? ' <span style="color:var(--danger-color); font-size:0.72rem;">(سررسید گذشته)</span>' : ''}</td>
                                    <td><span class="finance-check-status-badge ${inv.status}">${INVOICE_STATUS_LABELS[inv.status] || inv.status}</span></td>
                                    <td style="white-space:nowrap;">
                                        <button class="icon-btn" data-invoice-cycle="${inv.id}" title="تغییر وضعیت" style="width:26px; height:26px; font-size:0.7rem;"><i class="fa fa-sync"></i></button>
                                        <button class="icon-btn" data-invoice-edit="${inv.id}" title="ویرایش" style="width:26px; height:26px; font-size:0.7rem;"><i class="fa fa-edit"></i></button>
                                        <button class="icon-btn" data-invoice-delete="${inv.id}" title="حذف" style="width:26px; height:26px; font-size:0.7rem; color:var(--danger-color);"><i class="fa fa-trash"></i></button>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `}
        </div>
    `;

    document.getElementById('invoice-add-btn').addEventListener('click', () => openInvoiceForm(null));

    contentEl.querySelectorAll('[data-invoice-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
            const inv = clientInvoices.find(i => String(i.id) === btn.dataset.invoiceEdit);
            if (inv) openInvoiceForm(inv);
        });
    });
    contentEl.querySelectorAll('[data-invoice-delete]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ok = await showConfirm('این فاکتور حذف شود؟', 'حذف فاکتور');
            if (!ok) return;
            await apiCall('delete_client_invoice', 'POST', { id: btn.dataset.invoiceDelete });
            clientInvoices = clientInvoices.filter(i => String(i.id) !== btn.dataset.invoiceDelete);
            renderInvoicesList();
        });
    });
    contentEl.querySelectorAll('[data-invoice-cycle]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const inv = clientInvoices.find(i => String(i.id) === btn.dataset.invoiceCycle);
            if (!inv) return;
            const cycle = { pending: 'paid', paid: 'overdue', overdue: 'pending' };
            inv.status = cycle[inv.status] || 'pending';
            await apiCall('update_invoice_status', 'POST', { id: inv.id, status: inv.status });
            renderInvoicesList();
        });
    });
}

function openInvoiceForm(invoiceToEdit) {
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    const isEdit = !!invoiceToEdit;

    const projectOptions = (projectsCache || []).map(p =>
        `<option value="${p.id}" ${isEdit && String(invoiceToEdit.project_id) === String(p.id) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');

    title.innerHTML = isEdit ? `<i class="fa fa-edit"></i> ویرایش فاکتور «${escapeHtml(invoiceToEdit.title)}»` : '<i class="fa fa-plus"></i> فاکتور جدید';

    body.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:0.9rem; max-width:420px; margin:0 auto;">
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">عنوان فاکتور</label>
                <input type="text" id="invoice-form-title" value="${isEdit ? escapeHtml(invoiceToEdit.title) : ''}" placeholder="مثال: فاکتور طراحی سایت - فاز اول" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">نام کارفرما (اختیاری)</label>
                <input type="text" id="invoice-form-client" value="${isEdit ? escapeHtml(invoiceToEdit.client_name || '') : ''}" placeholder="مثال: فروشگاه آنلاین فلان" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">پروژه‌ی مرتبط (اختیاری)</label>
                <select id="invoice-form-project" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color);">
                    <option value="">بدون پروژه</option>
                    ${projectOptions}
                </select>
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">مبلغ (تومان)</label>
                <input type="text" inputmode="decimal" id="invoice-form-amount" value="${isEdit && invoiceToEdit.amount ? Number(invoiceToEdit.amount).toLocaleString() : ''}" placeholder="۰" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:left; font-family:monospace;">
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">سررسید (شمسی، اختیاری)</label>
                <div style="position:relative;">
                    <input type="text" id="invoice-form-date" value="${isEdit ? escapeHtml(invoiceToEdit.due_date || '') : ''}" placeholder="از تقویم انتخاب کن یا تایپ کن..." style="width:100%; padding:0.6rem 2.6rem 0.6rem 0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); direction:ltr; text-align:center;">
                    <button type="button" class="icon-btn" data-date-picker-for="invoice-form-date" title="انتخاب از تقویم" style="position:absolute; top:50%; left:4px; transform:translateY(-50%); width:28px; height:28px; font-size:0.75rem;"><i class="fa fa-calendar-alt"></i></button>
                </div>
            </div>
            <div>
                <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:4px;">یادداشت (اختیاری)</label>
                <textarea id="invoice-form-notes" style="width:100%; height:60px; padding:0.6rem; border-radius:8px; border:1px solid var(--glass-border); background:rgba(128,128,128,0.08); color:var(--text-color); resize:vertical;">${isEdit ? escapeHtml(invoiceToEdit.notes || '') : ''}</textarea>
            </div>
            <div style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:0.5rem;">
                <button class="btn-secondary" id="invoice-form-cancel-btn">انصراف</button>
                <button class="btn-primary" id="invoice-form-save-btn">ذخیره</button>
            </div>
        </div>
    `;

    wireDatePickerButtons(body);
    wireLiveAmountFormatting(document.getElementById('invoice-form-amount'));

    document.getElementById('invoice-form-cancel-btn').addEventListener('click', () => renderFinanceModal());

    document.getElementById('invoice-form-save-btn').addEventListener('click', async () => {
        const t = document.getElementById('invoice-form-title').value.trim();
        if (!t) { showAlert('عنوان فاکتور را وارد کنید.', 'خطا'); return; }
        const clientName = document.getElementById('invoice-form-client').value.trim() || null;
        const projectId = document.getElementById('invoice-form-project').value || null;
        const amount = parseFloat(document.getElementById('invoice-form-amount').value.replace(/,/g, '')) || 0;
        const dueDate = document.getElementById('invoice-form-date').value.trim() || null;
        const notes = document.getElementById('invoice-form-notes').value.trim() || null;

        await apiCall('save_client_invoice', 'POST', {
            id: isEdit ? invoiceToEdit.id : undefined,
            title: t,
            client_name: clientName,
            project_id: projectId,
            amount,
            due_date: dueDate,
            notes,
            status: isEdit ? invoiceToEdit.status : 'pending'
        });
        financeActiveTab = 'invoices';
        await renderFinanceModal();
    });
}

