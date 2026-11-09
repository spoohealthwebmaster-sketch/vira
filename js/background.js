// extension/js/background.js - Focus Mode, Domain Time Tracker, Evidence Capture,
// Quick Bookmarks & Installment Reminders
importScripts('config.js', '../vendor/jalaali/jalaali.min.js');

const BLOCKED_SITES = ["instagram.com", "twitter.com", "x.com", "facebook.com", "reddit.com", "youtube.com"];

// --- 1. Focus Mode (DeclarativeNetRequest) ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "vira_download") {
        // Sent only by our own content script on the user's click.
        if (typeof request.url === 'string' && /^https?:\/\//.test(request.url)) {
            chrome.downloads.download({ url: request.url, filename: request.filename || undefined, saveAs: false }, (id) => {
                sendResponse({ ok: !chrome.runtime.lastError && id !== undefined, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
            });
            return true;
        }
        sendResponse({ ok: false, error: 'bad url' });
        return;
    }
    if (request.action === "enable_focus") {
        const rules = BLOCKED_SITES.map((domain, index) => {
            return {
                id: index + 1,
                priority: 1,
                action: { type: "block" },
                condition: { urlFilter: `*://${domain}/*`, resourceTypes: ["main_frame"] }
            };
        });

        chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: rules.map(r => r.id),
            addRules: rules
        }, () => {
            sendResponse({ status: "Focus mode enabled!" });
        });
        return true;
    }
    else if (request.action === "disable_focus") {
        const ruleIds = BLOCKED_SITES.map((_, index) => index + 1);
        chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: ruleIds
        }, () => {
            sendResponse({ status: "Focus mode disabled!" });
        });
        return true;
    }
    else if (request.action === "get_domain_time_stats") {
        flushCurrentTimeTracking().then(() => {
            chrome.storage.local.get({ domainTimeTracker: {} }, (res) => {
                sendResponse(res.domainTimeTracker || {});
            });
        });
        return true;
    }
    else if (request.action === "reset_domain_time_stats") {
        chrome.storage.local.set({ domainTimeTracker: {} }, () => {
            sendResponse({ success: true });
        });
        return true;
    }
});

// --- 2. Domain Screen Time Tracker ---
//
// MV3 background service workers are terminated after ~30s of inactivity and
// restart from scratch on the next event, wiping any state kept in plain
// top-level `let`/`var` variables. The previous version tracked "which domain,
// since when" that way, so almost every real browsing session (anyone staying
// on one tab for more than ~30s, which is the common case) lost its elapsed
// time silently - the tracker looked broken because it effectively was.
//
// Fix: persist that state in chrome.storage.session (survives service worker
// restarts, cleared on browser close - exactly what's needed here) instead of
// in-memory variables, and use chrome.alarms instead of setInterval for the
// periodic flush, since setInterval timers are also destroyed when the service
// worker is torn down.

const TRACKER_STATE_KEY = 'timeTrackerState';
const HEARTBEAT_ALARM = 'vira-time-heartbeat';

async function getTrackerState() {
    const { [TRACKER_STATE_KEY]: state } = await chrome.storage.session.get({ [TRACKER_STATE_KEY]: null });
    return state || { currentActiveDomain: null, lastActiveTimestamp: Date.now(), isWindowFocused: true };
}

async function setTrackerState(state) {
    await chrome.storage.session.set({ [TRACKER_STATE_KEY]: state });
}

function extractCleanDomain(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        let host = u.hostname.toLowerCase();
        if (host.startsWith('www.')) host = host.substring(4);
        return host;
    } catch (e) {
        return null;
    }
}

function getTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function flushCurrentTimeTracking() {
    const state = await getTrackerState();
    const now = Date.now();
    const elapsedSec = Math.floor((now - state.lastActiveTimestamp) / 1000);
    state.lastActiveTimestamp = now;

    if (elapsedSec <= 0 || !state.currentActiveDomain || !state.isWindowFocused) {
        await setTrackerState(state);
        return;
    }

    const todayKey = getTodayKey();
    const { domainTimeTracker } = await chrome.storage.local.get({ domainTimeTracker: {} });
    const data = domainTimeTracker || {};
    if (!data[todayKey]) data[todayKey] = {};
    data[todayKey][state.currentActiveDomain] = (data[todayKey][state.currentActiveDomain] || 0) + elapsedSec;
    await chrome.storage.local.set({ domainTimeTracker: data });
    await setTrackerState(state);
}

async function updateActiveTab() {
    await flushCurrentTimeTracking();
    const state = await getTrackerState();

    if (!state.isWindowFocused) {
        state.currentActiveDomain = null;
        await setTrackerState(state);
        return;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0 && tabs[0].url) {
        state.currentActiveDomain = extractCleanDomain(tabs[0].url);
    } else {
        state.currentActiveDomain = null;
    }
    state.lastActiveTimestamp = Date.now();
    await setTrackerState(state);
}

// Tab switched
chrome.tabs.onActivated.addListener(() => {
    updateActiveTab();
});

// URL changed in active tab
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.url) {
        updateActiveTab();
    }
});

// Window focus changed
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    const state = await getTrackerState();
    state.isWindowFocused = (windowId !== chrome.windows.WINDOW_ID_NONE);
    await setTrackerState(state);
    updateActiveTab();
});

// Periodic flush so a long, uninterrupted session on a single tab still gets
// recorded even before the next tab-switch/focus event. chrome.alarms (not
// setInterval) since alarms survive service worker restarts; 1 minute is the
// shortest period Chrome reliably honors for a recurring alarm.
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) flushCurrentTimeTracking();
});

// --- 3. Evidence Capture & Quick Bookmarks (right-click on any site) ---

const EVIDENCE_MENU_ID = 'vira-save-evidence';
const BOOKMARK_MENU_ID = 'vira-quick-bookmark';

function createViraContextMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: EVIDENCE_MENU_ID,
            title: 'افزودن به کتابخانه‌ی شواهد ویرا',
            contexts: ['selection']
        });
        chrome.contextMenus.create({
            id: BOOKMARK_MENU_ID,
            title: 'افزودن این صفحه به بوک‌مارک‌های ویرا',
            contexts: ['page']
        });
    });
}
chrome.runtime.onInstalled.addListener(createViraContextMenus);
chrome.runtime.onStartup.addListener(createViraContextMenus);

function notifyVira(title, message) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message
    });
}

function truncateText(str, len) {
    str = (str || '').trim();
    return str.length > len ? str.slice(0, len) + '…' : str;
}

async function getAuthTokenOrNotify(title) {
    const { authToken } = await chrome.storage.local.get({ authToken: null });
    if (!authToken) {
        notifyVira(title, 'اول باید توی داشبورد ویرا وارد حساب کاربری‌ات بشی.');
        return null;
    }
    return authToken;
}

async function viraApiPost(action, authToken, body) {
    const res = await fetch(`${CONFIG.API_URL}?action=${action}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify(body)
    });
    if (res.status === 401) return { expired: true };
    return await res.json();
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === EVIDENCE_MENU_ID) {
        const selection = (info.selectionText || '').trim();
        if (!selection) return;

        const authToken = await getAuthTokenOrNotify('کتابخانه‌ی شواهد ویرا');
        if (!authToken) return;

        const pageTitle = (tab && tab.title) || '';
        const pageUrl = info.pageUrl || (tab && tab.url) || '';

        try {
            const data = await viraApiPost('save_note', authToken, {
                type: 'evidence',
                title: truncateText(selection, 60) || truncateText(pageTitle, 60) || 'شاهد بدون عنوان',
                content: selection,
                language: null,
                source_url: pageUrl,
                source_title: pageTitle,
                project_id: null
            });
            if (data.expired) {
                notifyVira('کتابخانه‌ی شواهد ویرا', 'نشست شما منقضی شده - دوباره توی داشبورد ویرا وارد شو.');
                return;
            }
            notifyVira('کتابخانه‌ی شواهد ویرا', data.success ? 'به کتابخانه‌ی شواهد اضافه شد.' : 'ذخیره ممکن نشد.');
        } catch (e) {
            notifyVira('کتابخانه‌ی شواهد ویرا', 'ذخیره ممکن نشد؛ اتصال به سرور را بررسی کن.');
        }
        return;
    }

    if (info.menuItemId === BOOKMARK_MENU_ID) {
        const pageUrl = info.pageUrl || (tab && tab.url) || '';
        if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return;

        const authToken = await getAuthTokenOrNotify('بوک‌مارک سریع ویرا');
        if (!authToken) return;

        try {
            const data = await viraApiPost('add_bookmark', authToken, {
                title: truncateText((tab && tab.title) || pageUrl, 150),
                url: pageUrl,
                category_id: null,
                project_id: null
            });
            if (data.expired) {
                notifyVira('بوک‌مارک سریع ویرا', 'نشست شما منقضی شده - دوباره توی داشبورد ویرا وارد شو.');
                return;
            }
            notifyVira('بوک‌مارک سریع ویرا', data.success ? 'این صفحه به بوک‌مارک‌هات اضافه شد.' : 'ذخیره ممکن نشد.');
        } catch (e) {
            notifyVira('بوک‌مارک سریع ویرا', 'ذخیره ممکن نشد؛ اتصال به سرور را بررسی کن.');
        }
    }
});

// --- 4. Installment / Finance Due Reminders ---
//
// Checks the current Jalali month's finance entries for unpaid expense
// categories with an amount > 0, and notifies once per day per distinct set
// of unpaid items (re-notifying every check would just be noise once you've
// already seen today's reminder and nothing has changed).

const FINANCE_REMINDER_ALARM = 'vira-finance-reminder';
chrome.alarms.create(FINANCE_REMINDER_ALARM, { periodInMinutes: 720 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FINANCE_REMINDER_ALARM) checkUnpaidInstallments();
});
chrome.runtime.onStartup.addListener(checkUnpaidInstallments);
chrome.runtime.onInstalled.addListener(checkUnpaidInstallments);

async function checkUnpaidInstallments() {
    if (typeof jalaali === 'undefined') return;

    const { authToken } = await chrome.storage.local.get({ authToken: null });
    if (!authToken) return; // passive background check - don't nag about login here

    const today = jalaali.toJalaali(new Date());

    try {
        const res = await fetch(`${CONFIG.API_URL}?action=get_finance_data&year=${today.jy}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.success) return;

        const catById = {};
        (data.categories || []).forEach(c => { catById[c.id] = c; });

        const unpaid = (data.entries || []).filter(e => {
            const cat = catById[e.category_id];
            return cat && cat.type === 'expense' && Number(e.jmonth) === today.jm && Number(e.amount) > 0 && !Number(e.is_paid);
        });
        if (unpaid.length === 0) return;

        const names = unpaid.map(e => (catById[e.category_id] || {}).name).filter(Boolean);
        const shown = names.slice(0, 4).join('، ') + (names.length > 4 ? ` و ${names.length - 4} مورد دیگر` : '');

        // Only re-notify if the set of unpaid categories actually changed since the last check.
        const signatureKey = `financeReminderSig_${today.jy}_${today.jm}`;
        const { [signatureKey]: lastSignature } = await chrome.storage.local.get({ [signatureKey]: null });
        const signature = unpaid.map(e => e.category_id).sort((a, b) => a - b).join(',');
        if (signature === lastSignature) return;

        notifyVira('یادآوری اقساط ویرا', `${unpaid.length} مورد پرداخت این ماه هنوز ثبت نشده: ${shown}`);
        await chrome.storage.local.set({ [signatureKey]: signature });
    } catch (e) {
        // silent - this is a passive background reminder, not a user-initiated action
    }
}
