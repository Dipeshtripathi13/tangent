/**
 * Reads the chat page the user already has open, and hosts the panel.
 *
 * Deliberately free of site-specific selectors. Chat UIs are redesigned
 * constantly, and a scraper keyed to class names breaks on the next deploy.
 * Both signals we need can be had generically:
 *
 *   what was asked - read the composer's own text at the moment of submit
 *   nothing else   - we do not read the conversation, the replies, or history
 *
 * The panel is an extension page in an iframe rather than markup injected into
 * the host document. That keeps the page's CSS and the panel's completely
 * isolated in both directions, and lets the panel embed YouTube's player under
 * the extension's own CSP rather than the site's.
 */
(function () {
  'use strict';

  const INSTANCE_KEY = '__tangentContentInstance';
  if (window[INSTANCE_KEY]) return;
  window[INSTANCE_KEY] = true;

  // Take over cleanly from any previous instance in this page.
  document.getElementById('tangent-panel-host')?.remove();
  document.getElementById('tangent-push-style')?.remove();

  const MIN_CHARS = 12;
  const PANEL_ID = 'tangent-panel-host';
  const STYLE_ID = 'tangent-push-style';
  const PANEL_W = 340;

  let lastSent = '';
  let lastSentAt = 0;
  let host = null;
  let visible = false;

  /* ------------------------------------------------------------ reading */

  function isEditable(el) {
    return !!el && !!el.tagName && (el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  /** The composer is the focused editable, or the largest one on the page. */
  function findComposer() {
    const nodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
    let best = null;
    let bestArea = 0;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = n; }
    }
    return best;
  }

  function composerText(el) {
    const node = isEditable(el) ? el : findComposer();
    if (!node) return '';
    const text = node.value !== undefined ? node.value : node.innerText;
    return (text || '').trim();
  }

  function onSubmit(text) {
    const clean = (text || '').trim();
    if (clean.length < MIN_CHARS) return;
    // The same turn can arrive from both the keydown and the click handler.
    if (clean === lastSent && Date.now() - lastSentAt < 3000) return;
    lastSent = clean;
    lastSentAt = Date.now();

    send({ type: 'turn', text: clean, href: location.href });
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Extension reloaded or updated underneath the page; nothing to do.
    }
  }

  // Enter submits on both sites; Shift+Enter is a newline.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (!isEditable(e.target)) return;
    const text = composerText(e.target);
    setTimeout(() => onSubmit(text), 0);   // read before the site clears the box
  }, true);

  // Send button: any button click while the composer holds text.
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button');
    if (!btn) return;
    const text = composerText(null);
    if (!text) return;
    setTimeout(() => onSubmit(text), 0);
  }, true);

  /* ------------------------------------------------------------- panel */

  function ensurePanel() {
    // isConnected rather than a containment check against a specific parent:
    // the panel hangs off <html>, and asking whether <body> contained it was
    // always false, so every toggle built another panel on top of the last.
    if (host?.isConnected) return host;

    // A panel may also be left in the page by an earlier instance of this
    // script - orphaned by an extension reload, or injected twice. Only one
    // may exist, and it must be the one this instance can actually control.
    for (const stale of document.querySelectorAll(`#${PANEL_ID}`)) stale.remove();

    host = document.createElement('div');
    host.id = PANEL_ID;
    Object.assign(host.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      width: '340px',
      height: '100vh',
      zIndex: '2147483647',
      border: '0',
      boxShadow: '0 0 28px rgba(0,0,0,.18)',
      display: 'none',
      colorScheme: 'normal',
    });

    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/ui/panel.html');
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    frame.title = 'Tangent';
    Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });

    host.appendChild(frame);
    // Attached to <html>, not <body>: the push below makes <body> a containing
    // block for its fixed children, which would otherwise drag the panel along
    // with the page it is meant to sit beside.
    document.documentElement.appendChild(host);
    return host;
  }

  const CAP_ATTR = 'data-tangent-capped';

  /**
   * Narrow the page so the panel sits beside the conversation.
   *
   * Two independent reasons a naive attempt fails, and both had to be handled:
   *
   *  - Chat UIs place their header, sidebar and composer with `position:
   *    fixed`, which resolves against the viewport and ignores any margin an
   *    ancestor takes on. Giving <body> a transform makes it the containing
   *    block for its own fixed descendants, so narrowing body narrows them.
   *
   *  - Some layouts size their root in viewport units (`100vw`, Tailwind's
   *    `w-screen`). A viewport unit means the window, not the parent, so no
   *    amount of narrowing an ancestor touches it. Those have to be found and
   *    capped individually.
   *
   * The second is why this measures instead of assuming: rather than carrying a
   * list of which sites need what, it checks whether the page actually moved
   * and only escalates if it did not.
   */
  function pushCss() {
    return `html { overflow-x: hidden !important; }
      body {
        width: calc(100% - ${PANEL_W}px) !important;
        max-width: calc(100% - ${PANEL_W}px) !important;
        transform: translateX(0) !important;
        transition: width .15s ease !important;
      }`;
  }

  /** True when no page content sits under where the panel is drawn. */
  function pageIsClear() {
    const x = window.innerWidth - Math.round(PANEL_W / 2);
    const y = Math.round(window.innerHeight / 2);
    const previous = host ? host.style.visibility : null;
    if (host) host.style.visibility = 'hidden';
    const el = document.elementFromPoint(x, y);
    if (host) host.style.visibility = previous ?? '';
    return !el || el === document.documentElement || el === document.body;
  }

  /**
   * Cap anything still as wide as the whole viewport. Kept to the top of the
   * tree, where full-bleed roots live, so ordinary content is left alone.
   */
  function capWideElements(root = document.body, depth = 0) {
    if (!root || depth > 3) return;
    const cap = `calc(100vw - ${PANEL_W}px)`;
    for (const el of root.children) {
      if (el === host || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
      if (el.getBoundingClientRect().width >= window.innerWidth - 2) {
        el.setAttribute(CAP_ATTR, '');
        el.style.setProperty('width', cap, 'important');
        el.style.setProperty('max-width', cap, 'important');
      }
      capWideElements(el, depth + 1);
    }
  }

  function releaseCapped() {
    for (const el of document.querySelectorAll(`[${CAP_ATTR}]`)) {
      el.style.removeProperty('width');
      el.style.removeProperty('max-width');
      el.removeAttribute(CAP_ATTR);
    }
  }

  function applyPush(on) {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head ?? document.documentElement).appendChild(style);
    }
    style.textContent = on ? pushCss() : '';
    if (!on) { releaseCapped(); return; }

    // Let the new width take effect before judging whether it worked.
    requestAnimationFrame(() => {
      if (!pageIsClear()) capWideElements();
    });
  }

  function setVisible(next, pushPage = true) {
    visible = next;
    ensurePanel().style.display = next ? 'block' : 'none';
    applyPush(next && pushPage);
  }

  // A resize changes what counts as viewport-wide, so re-evaluate.
  window.addEventListener('resize', () => {
    if (!visible) return;
    releaseCapped();
    requestAnimationFrame(() => { if (!pageIsClear()) capWideElements(); });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'toggle-panel') {
      setVisible(!visible, msg.pushPage !== false);
      sendResponse({ ok: true, visible });
      return false;
    }
    if (msg?.type === 'close-panel') {
      setVisible(false);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // The panel asks to be closed from its own header button. Accept that only
  // from our own iframe, never from the host page or a third-party frame.
  window.addEventListener('message', (e) => {
    if (e.data?.tangent !== 'close') return;
    const frame = host?.firstElementChild;
    if (!frame || e.source !== frame.contentWindow) return;
    setVisible(false);
  });

  window.addEventListener('pagehide', () => applyPush(false));
})();
