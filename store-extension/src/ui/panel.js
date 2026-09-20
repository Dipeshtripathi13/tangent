/**
 * Panel logic. Ships inside the package: no remotely hosted code, which
 * Manifest V3 requires and the Chrome Web Store checks for.
 *
 * Nothing loads from YouTube until the viewer presses play on a specific clip.
 * Until then a card is a thumbnail, so the panel stays silent and pulls in no
 * third-party frames the user did not ask for.
 */

const $ = (id) => document.getElementById(id);

const PANES = ['paneSetup', 'paneIdle', 'paneOffer', 'paneLoading', 'paneResults', 'paneError'];

let offer = null;
let result = null;
let hasKey = false;
let index = 0;
/** The https page that hosts the embed; empty means play in a window. */
let playerBase = '';
/** Which tab this panel belongs to; broadcasts for other tabs are ignored. */
let myTabId = null;

function show(pane) {
  for (const p of PANES) $(p).hidden = p !== pane;
}

function say(text) {
  $('why').textContent = text;
}

/* ---------------------------------------------------------------- offers */

function renderOffer(next) {
  offer = next;
  result = null;
  say(`Spotted in your message · ${Math.round(next.topic.confidence * 100)}% confident`);

  // Without a key we cannot search, but hiding what we found makes the
  // extension look broken. Name the topic on the setup screen instead.
  if (!hasKey) {
    const el = $('setupTopic');
    el.innerHTML = '';
    el.append('Found in your message: ');
    const strong = document.createElement('strong');
    strong.textContent = next.topic.label;
    el.append(strong, '. Add a key and this becomes a search.');
    el.hidden = false;
    show('paneSetup');
    return;
  }

  $('offerSubject').textContent = next.topic.label;
  // Prefilled, not read-only: the extractor's guess is usually right, and when
  // it is not the person reading it can simply correct it before searching.
  $('offerQuery').value = next.topic.query;
  $('offerCost').textContent = next.cached
    ? 'Already saved from an earlier search — costs nothing.'
    : 'Uses one of today’s searches.';
  $('btnFind').disabled = false;
  show('paneOffer');
}

async function accept() {
  if (!offer) return;
  $('btnFind').disabled = true;
  show('paneLoading');

  // The reply already carries the videos. Rendering from the broadcast alone
  // meant one lost message left the panel spinning forever, with the answer
  // sitting unread in a variable. The broadcast is now only how *other* open
  // panels find out.
  const query = $('offerQuery').value.trim();
  if (!query) {
    fail('Type something to search for.');
    return;
  }
  $('loadingText').textContent = `Searching for “${query}”…`;

  let res;
  try {
    res = await withTimeout(send({ type: 'accept', query }), 25_000);
  } catch (e) {
    fail(`The search did not come back (${e.message}). The extension's background worker may have been suspended — try again.`);
    return;
  }

  if (res?.ok && res.result) { renderResults(res.result); return; }
  if (res?.error === 'no-key') { show('paneSetup'); return; }
  fail(res?.error ?? 'The search failed.');
}

function fail(message) {
  $('errorText').textContent = message;
  $('btnFind').disabled = false;
  show('paneError');
}

/** A promise that can never leave the panel spinning indefinitely. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

/* --------------------------------------------------------------- results */

function renderResults(next) {
  // A duplicate from the broadcast must not reset the clip the user is watching,
  // but it must still render if the results pane is not the one showing.
  if (result && next?.topic?.key === result.topic?.key && !$('paneResults').hidden) return;
  result = next;
  offer = null;
  index = 0;
  say(`Searched “${next.topic.query}” · ${next.cached ? 'from your saved results' : 'fresh'}`);
  show('paneResults');
  try {
    paint();
  } catch (e) {
    fail(`Could not draw the results: ${e.message}`);
  }
}

function paint() {
  if (!result?.videos?.length) return;
  const v = result.videos[index];

  const frame = $('frame');
  frame.textContent = '';

  const img = document.createElement('img');
  img.src = v.thumbnail;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';

  if (playerBase && !playerDead) {
    // The player is loaded with the result rather than behind our own play
    // button. Lazy-loading cost two clicks: ours, then YouTube's, because user
    // activation does not reach a cross-origin iframe created after the click
    // and no autoplay trick gets around that. Loading it up front leaves
    // exactly one click - YouTube's own - and nothing plays until it is made.
    const f = document.createElement('iframe');
    f.src = `${playerBase}?v=${encodeURIComponent(v.id)}`;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; web-share';
    f.allowFullscreen = true;
    f.title = v.title;
    frame.appendChild(f);
    watchForPlayer();
  } else {
    // No player page, or it never answered: thumbnail and a popup window.
    const btn = document.createElement('button');
    btn.className = 'play';
    btn.setAttribute('aria-label', `Play: ${v.title}`);
    const glyph = document.createElement('span');
    glyph.textContent = '▶';
    btn.appendChild(glyph);
    btn.addEventListener('click', () => playVideo(v));
    frame.append(img, btn);
  }

  $('vtitle').textContent = v.title;
  $('vmeta').textContent = [v.channel, fmtDuration(v.durationSec), fmtViews(v.viewCount)]
    .filter(Boolean).join(' · ');

  const strip = $('strip');
  strip.textContent = '';
  result.videos.forEach((vid, i) => {
    const b = document.createElement('button');
    b.setAttribute('aria-current', String(i === index));
    b.title = vid.title;
    const t = document.createElement('img');
    t.src = vid.thumbnail;
    t.alt = '';
    t.loading = 'lazy';
    t.referrerPolicy = 'no-referrer';
    b.appendChild(t);
    b.addEventListener('click', () => { index = i; paint(); });
    strip.appendChild(b);
  });
}

/**
 * Opens the clip in a small always-on-top window rather than embedding it.
 *
 * YouTube requires an HTTP Referer to identify the embedder, and Chrome sends
 * none from a chrome-extension:// page, so an inline player fails with
 * "Video player configuration error (153)". Nothing in the extension's control
 * fixes that: referrerpolicy does not apply to the extension origin, and
 * declarativeNetRequest cannot set Referer. The only true fix is proxying
 * through a page on a real https domain, which would mean depending on a server
 * this extension deliberately does not have.
 *
 * A compact popup keeps the clip beside the conversation and always works.
 */
function playVideo(v) {
  const width = 420;
  const height = 760;
  const left = Math.max(0, Math.round((screen.availWidth - width) / 2));
  const top = Math.max(0, Math.round((screen.availHeight - height) / 2));

  if (chrome.windows?.create) {
    chrome.windows
      .create({ url: v.url, type: 'popup', width, height, left, top })
      .catch(() => openFallback(v.url, width, height, left, top));
    return;
  }
  openFallback(v.url, width, height, left, top);
}

function openFallback(url, width, height, left, top) {
  // "noopener" must not appear in the features string: browsers read that as a
  // request for an ordinary tab and throw the geometry away, which is exactly
  // how this ended up opening full-screen.
  const w = window.open(url, '_blank', `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  if (w) w.opener = null;
}

/**
 * The player page posts a greeting when it loads. If none arrives, the URL has
 * moved or the host is down — a cross-origin iframe fires `load` for an error
 * page just the same, so waiting for the greeting is the only way to know.
 */
let playerDead = false;
let playerTimer = null;

function watchForPlayer() {
  clearTimeout(playerTimer);
  playerTimer = setTimeout(() => {
    playerDead = true;
    say('The player page did not respond. Clips will open in a window instead.');
    paint();
  }, 5000);
}

window.addEventListener('message', (e) => {
  if (e.data?.tangent !== 'player-ready') return;
  clearTimeout(playerTimer);
  playerDead = false;
});

function move(delta) {
  if (!result) return;
  index = (index + delta + result.videos.length) % result.videos.length;
  paint();
}

/* ------------------------------------------------------------------ chat */

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e?.message }));
}

chrome.runtime.onMessage.addListener((msg) => {
  // Broadcasts reach every panel in every tab. Only act on our own tab's, or a
  // search run in one chat shows up in the panel of every other one.
  if (msg?.tabId != null && myTabId != null && msg.tabId !== myTabId) return false;

  if (msg?.type === 'offer') renderOffer(msg.offer);
  else if (msg?.type === 'results') renderResults(msg.result);
  else if (msg?.type === 'no-offer' && !result) {
    say(`Nothing to suggest here — ${msg.reason}.`);
    show('paneIdle');
  }
  return false;
});

/* -------------------------------------------------------------- controls */

$('btnFind').addEventListener('click', accept);
$('offerQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); accept(); }
});
$('btnSkip').addEventListener('click', async () => {
  await send({ type: 'dismiss' });
  offer = null;
  say('Skipped. Your next message raises a new one.');
  show('paneIdle');
});
$('btnPrev').addEventListener('click', () => move(-1));
$('btnNext').addEventListener('click', () => move(1));
$('btnOpen').addEventListener('click', () => {
  if (result) playVideo(result.videos[index]);
});
$('btnBack').addEventListener('click', () => show(offer ? 'paneOffer' : 'paneIdle'));
$('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btnOpenOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Setting the key here rather than sending people to a separate page: this is
// the one thing standing between install and the extension working, and it is
// two fields, not a settings screen.
$('setupKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
$('btnSaveKey').addEventListener('click', saveKey);

async function saveKey() {
  const apiKey = $('setupKey').value.trim();
  const status = $('setupStatus');
  if (!apiKey) { status.textContent = 'Paste a key first.'; status.className = 'status bad'; return; }

  status.textContent = 'Checking…';
  status.className = 'status';
  const check = await send({ type: 'verify-key', apiKey });
  if (!check?.ok) {
    status.textContent = `YouTube rejected that key: ${check?.error ?? 'unknown error'}`;
    status.className = 'status bad';
    return;
  }

  await send({ type: 'save-settings', patch: { apiKey } });
  hasKey = true;
  status.textContent = 'Saved. Ask your assistant something.';
  status.className = 'status ok';
  const state = await send({ type: 'get-state' });
  if (state?.ok) {
    $('quota').textContent = `${state.quota.remaining}/${state.quota.limit} searches left today`;
    if (state.offer) { renderOffer(state.offer); return; }
  }
  show('paneIdle');
}
// Route close through the service worker so it remains reliable when this
// iframe is hidden and shown again.
$('btnClose').addEventListener('click', () => {
  void send({ type: 'close-panel' });
});

document.addEventListener('keydown', (e) => {
  // The search field has its own handler and owns typing while it is focused.
  if (e.target === $('offerQuery')) return;
  if (!$('paneOffer').hidden && (e.key === 'Enter' || e.key === 'f')) { accept(); e.preventDefault(); return; }
  if ($('paneResults').hidden) return;
  if (e.key === 'j' || e.key === 'ArrowDown') { move(1); e.preventDefault(); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { move(-1); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === 'o') { $('btnOpen').click(); }
});

/* ------------------------------------------------------------------ boot */

async function showBuild(workerBuild) {
  let panelBuild = 'dev';
  try {
    ({ BUILD: panelBuild } = await import('../build.js'));
  } catch { /* built file absent when running straight from src */ }
  // Showing both makes a half-updated extension obvious: the panel can reload
  // with new code while the service worker is still running the old bundle.
  $('attribution').textContent = workerBuild && workerBuild !== panelBuild
    ? `panel ${panelBuild} / worker ${workerBuild} — MISMATCH`
    : `build ${panelBuild}`;
}

async function init() {
  const state = await send({ type: 'get-state' });
  void showBuild(state?.build);
  if (!state?.ok) { show('paneIdle'); return; }

  hasKey = state.hasKey;
  playerBase = state.playerBase ?? '';
  myTabId = state.tabId ?? null;
  $('playnote').hidden = !!playerBase;
  $('quota').textContent = hasKey
    ? `${state.quota.remaining}/${state.quota.limit} searches left today`
    : 'No API key yet';

  // An offer can arrive while this await is in flight; do not clobber it.
  if (offer || result) return;

  if (state.offer) { renderOffer(state.offer); return; }
  show(hasKey ? 'paneIdle' : 'paneSetup');
}

function fmtDuration(s) {
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

function fmtViews(n) {
  if (typeof n !== 'number') return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M views`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K views`;
  return `${n} views`;
}

init();
