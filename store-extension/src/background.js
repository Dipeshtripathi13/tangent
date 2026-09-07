/**
 * Service worker: the only place that talks to YouTube.
 *
 * The split that matters: reading your message and naming a topic happens here,
 * locally, on every turn and for free. Searching happens only when you click.
 * Nothing about a message you ignore ever leaves the browser.
 */
import { BUILD } from './build.js';
import { extractTopic, normalizeKey } from './generated/core/topic.js';
import { rankShorts } from './generated/core/rank.js';
import { searchShorts, QuotaExceededError, ApiKeyError, verifyKey } from './youtube.js';
import {
  getSettings, saveSettings, settingsDefaults,
  cacheGet, cacheSet, clearCache, cacheStats,
  getQuota, spendQuota, markQuotaExhausted,
  setOffer, getOffer, clearOffer, markSeen, getSeen, forgetTab,
} from './storage.js';

/* ------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // Nothing works without a key, so send people straight to the one screen
    // that matters rather than letting them wonder why nothing happens.
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/welcome.html') });
  }
});

// Clicking the toolbar icon shows or hides the in-page panel.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const settings = await getSettings();
  const message = { type: 'toggle-panel', pushPage: settings.pushPage };

  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return;
  } catch (err) {
  if (!/Receiving end does not exist/.test(err?.message ?? '')) return;
}

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
    await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Injection is only refused on a site we do not run on at all.
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/welcome.html') });
  }
});

/* --------------------------------------------------------------- routing */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
  return true;   // keep the channel open for the async reply
});

async function handle(msg, sender) {
  // Every panel and content script lives in a tab, and each tab is its own
  // conversation. Without this the whole extension shares one state.
  const tabId = sender?.tab?.id ?? 0;

  switch (msg?.type) {
    case 'turn':      return onTurn(msg, tabId);
    case 'accept':    return onAccept(tabId, msg.query);
    case 'get-state': return getState(tabId);
    case 'dismiss':   return onDismiss(tabId);
    case 'settings':  return { ok: true, settings: await getSettings(), defaults: settingsDefaults() };
    case 'save-settings': {
      const settings = await saveSettings(msg.patch ?? {});
      return { ok: true, settings };
    }
    case 'verify-key': return await verifyKey(msg.apiKey ?? '');
    case 'clear-cache': {
      const removed = await clearCache();
      return { ok: true, removed };
    }
    default: return { ok: false, error: `unknown message: ${msg?.type}` };
  }
}

/* ------------------------------------------------------------ the offer */

/**
 * A new user message. Extract a topic locally; if it is worth offering, park it
 * and light up the toolbar badge. No network call happens here, ever.
 */
async function onTurn(msg, tabId) {
  const settings = await getSettings();

  const host = safeHost(msg.href);
  if (host && settings.disabledHosts.includes(host)) return { ok: true, offered: false, reason: 'disabled here' };

  const topic = extractTopic(msg.text ?? '');
  if (!topic || topic.confidence < settings.minConfidence) {
    await clearOffer(tabId);
    await badge('', tabId);
    await broadcast({ type: 'no-offer', tabId, reason: topic ? 'below the confidence threshold' : 'no teachable topic' });
    return { ok: true, offered: false };
  }

  const variant = variantKey(settings);
  const cached = await cacheGet(topic.key, variant, settings.cacheTtlHours);

  const offer = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    topic,
    cached: cached !== null,
    createdAt: Date.now(),
  };
  await setOffer(tabId, offer);
  await badge('1', tabId);
  await broadcast({ type: 'offer', tabId, offer });
  return { ok: true, offered: true };
}

async function onDismiss(tabId) {
  await clearOffer(tabId);
  await badge('', tabId);
  return { ok: true };
}

// A closed tab's conversation is over; do not leave its state behind.
chrome.tabs.onRemoved.addListener((tabId) => { void forgetTab(tabId); });

/* ----------------------------------------------------------- the search */

/** The click. This is the only path that spends a search. */
async function onAccept(tabId, requested) {
  const offer = await getOffer(tabId);
  if (!offer) return { ok: false, error: 'That suggestion expired. Send another message.' };

  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, error: 'no-key' };
  }

  // The panel shows the phrase in an editable field, so what comes back may not
  // be what was guessed. A corrected phrase is a better search than the guess
  // by definition, and it needs its own cache key or it would collide with it.
  const topic = topicFor(offer.topic, requested);

  const variant = variantKey(settings);
  const seen = await getSeen(tabId);

  let videos = await cacheGet(topic.key, variant, settings.cacheTtlHours);
  let fromCache = videos !== null;

  if (!fromCache) {
    const quota = await getQuota(settings.dailySearches);
    if (quota.blocked || quota.remaining <= 0) {
      return { ok: false, error: `Daily search budget spent (${quota.used}/${quota.limit}). It resets at midnight US Pacific.` };
    }
    try {
      await spendQuota(settings.dailySearches);
      videos = await searchShorts(topic.query, settings);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        await markQuotaExhausted(settings.dailySearches);
        return { ok: false, error: 'YouTube says the daily quota is used up. It resets at midnight US Pacific.' };
      }
      if (e instanceof ApiKeyError) {
        return { ok: false, error: `YouTube rejected the API key: ${e.message}` };
      }
      return { ok: false, error: e.message };
    }
    if (videos.length > 0) await cacheSet(topic.key, variant, videos);
  }

  if (!videos || videos.length === 0) {
    return { ok: false, error: `No short videos matched "${topic.query}".` };
  }

  const ranked = rankShorts(videos, topic, {
    preferUnderSec: settings.preferUnderSec,
    maxDurationSec: settings.maxDurationSec,
    seen,
  }).slice(0, settings.count);

  await markSeen(tabId, ranked.map((v) => v.id));
  await clearOffer(tabId);
  await badge('', tabId);

  const result = { topic, videos: ranked, cached: fromCache };
  await broadcast({ type: 'results', tabId, result });
  return { ok: true, result };
}

/**
 * The topic to actually search: the one that was offered, unless the user
 * edited the field, in which case theirs wins verbatim. `terms` drives title
 * relevance during ranking, so it has to follow the words too.
 */
function topicFor(offered, requested) {
  const custom = String(requested ?? '').trim().slice(0, 120);
  if (!custom || custom === offered.query) return offered;
  return {
    ...offered,
    query: custom,
    label: custom.replace(/\s+explained$/i, ''),
    key: normalizeKey(custom),
    terms: custom.split(/\s+/).filter((w) => w.length > 2),
    edited: true,
  };
}

/* --------------------------------------------------------------- shared */

async function getState(tabId) {
  const settings = await getSettings();
  const [offer, quota, cache] = await Promise.all([
    getOffer(tabId),
    getQuota(settings.dailySearches),
    cacheStats(),
  ]);
  return {
    ok: true, offer, quota, cache,
    hasKey: !!settings.apiKey,
    playerBase: settings.playerBase,
    build: BUILD,
    tabId,
  };
}

/** Cache entries are only interchangeable when these settings match. */
function variantKey(s) {
  return `${s.maxDurationSec}:${s.regionCode}:${s.relevanceLanguage}:${s.safeSearch}`;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return null; }
}

async function badge(text, tabId) {
  try {
    await chrome.action.setBadgeText(tabId ? { text, tabId } : { text });
    await chrome.action.setBadgeBackgroundColor({ color: '#c85c2e' });
  } catch { /* badge is cosmetic, and the tab may have gone */ }
}

/** Tell every open panel. No listener is a normal state, not an error. */
async function broadcast(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch { /* nobody listening */ }
}
