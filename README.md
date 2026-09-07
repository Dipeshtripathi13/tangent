# Tangent

**Short video explainers for whatever you just asked an AI chatbot.**

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-install-b4531f)](https://chromewebstore.google.com/detail/kagpgdldipdgmplebhgohaojbigdnpje)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

You ask a chatbot something, read the answer, and still don't really have it.
So you open YouTube, type roughly the same question, watch a short, and come
back. Every time.

Tangent is that trip without the leaving and the retyping. After you send a
message, a button appears in a side panel with the topic already worked out.
Click it and you get a handful of 15 to 90 second YouTube Shorts on exactly
that, playing next to the conversation. Ignore it and nothing happens.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/kagpgdldipdgmplebhgohaojbigdnpje)**
&nbsp;·&nbsp; [Website](https://dipeshtripathi13.github.io/tangent/)
&nbsp;·&nbsp; [Privacy](https://dipeshtripathi13.github.io/tangent/privacy.html)
&nbsp;·&nbsp; [Changelog](store-extension/CHANGELOG.md)

---

```
  you ─── message ───▶  an AI chat site
                              │
                        content script
                              │
                              ▼
                  ┌─────────────────────────┐
                  │  extract topic          │   local, offline, free
                  │  "database migration"   │
                  └────────────┬────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  [ Find explainers ] │   ← you click here
                    └──────────┬───────────┘
                               │
                               ▼             ┌─────────────┐
                            search ─────────▶│   YouTube   │
                                             └─────────────┘
```

Working out the topic is local and costs nothing, so the button can appear on
every message. **Nothing is ever searched until you click.**

---

## Why it is not a distraction

The hard part was never finding videos. It was **not being annoying**.

**It raises a button, never a video.** Reading your message and naming the topic
happens on your own device, so ignoring the button is free, and ignoring it is
the normal case.

**It knows a question from a chore.** "What is photosynthesis" gets a button.
"Rerun the tests", "commit this", "yes" get nothing at all.

**No feed.** A fixed set of clips about one topic, then it stops. No autoplay,
no recommendations, no "up next".

**You get the last word.** The phrase it will search sits in an editable box,
already filled in. The extractor is a heuristic and is sometimes wrong; you
always know whether it got your question.

---

## What leaves your browser

A short search phrase, to YouTube. Nothing else, nowhere else.

Your message is processed locally. Before anything is derived from it, the
redactor strips code blocks, diffs, stack traces, file paths, URLs, emails,
hashes and environment variables. If the text contains anything shaped like a
credential (`sk-…`, `ghp_…`, `AKIA…`, a JWT, `password: …`), the whole message
is **dropped without a search**.

What YouTube sees is `database migration postgres explained`. Not your message,
not the assistant's reply, not your history.

No server, no analytics, no account. Everything is stored in your own browser.
Full detail in [the privacy policy](https://dipeshtripathi13.github.io/tangent/privacy.html).

---

## Setup

Tangent searches with **your own** free YouTube Data API key, so your usage is
yours and nothing is routed through anyone else's service.

1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate)
2. [Enable YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
3. Credentials, then Create credentials, then API key
4. Click the Tangent icon on any chat page and paste it into the panel

Google grants **100 searches per day** per key. Tangent stops at 90 to leave
headroom and reuses saved results, so a repeated topic never costs twice. That
limit is why searching is opt-in rather than automatic: a heavy day might raise
fifty buttons and spend three searches.

---

## Where it works

Sixteen AI chat sites, including Claude, ChatGPT, Gemini, Grok, DeepSeek, Qwen,
Kimi, Perplexity, Mistral, Copilot, Poe, Meta AI and HuggingChat. The full list
is in [the manifest](store-extension/manifest.json), and each site can be
switched off individually in settings.

It does nothing at all on any other site.

## Settings

| | |
|---|---|
| **API key** | Yours; verified against YouTube when you save it |
| **Sites** | Turn off any site you would rather it ignored |
| **Confidence** | How sure it must be before offering. Higher means fewer buttons |
| **Clip length** | Longest video to accept, and which lengths to prefer |
| **Player page** | Where inline playback is framed from; clear it to open clips in a window instead |
| **Narrow the page** | Whether the panel pushes the page aside or floats over it |

---

## How it works

```
store-extension/
  manifest.json        MV3, AI-chat hosts plus googleapis, no remote code
  src/background.js    service worker: extracts topics, searches only on a click
  src/content.js       reads the composer, hosts the panel iframe
  src/youtube.js       YouTube Data API v3 over fetch
  src/storage.js       settings, cache and daily budget on chrome.storage
  src/ui/              panel, options and welcome pages, all in-package
  src/generated/       compiled from ../src/core, do not edit
```

The topic extractor lives in [`src/core/`](src/core/) as TypeScript and is
compiled into the extension by `store-extension/tsconfig.core.json`. It:

1. **Redacts** code, paths and secrets. This protects you and improves
   extraction, since a stack trace has no topic in it.
2. **Matches curated concepts**, longest first, so `cap theorem` is found before
   `theorem` can claim the words.
3. **Scores n-grams** on lexicon membership, rarity, position and capitalisation.
4. **Pairs a thin winner** with a second strong term, in the order you wrote
   them, so "how do I reverse a linked list" gives `reverse linked list`.

Results are ranked for a short break: brevity, title relevance, channel
diversity, and a penalty for engagement bait.

### Build it yourself

```bash
cd store-extension
npm install
npm test          # 17 self-tests; no API key, no network
npm run package   # -> load-unpacked/ and dist/tangent-x.y.z.zip
```

Load `store-extension/load-unpacked` at `chrome://extensions`, Developer mode,
Load unpacked.

---

## Limitations

- **Topic extraction is a heuristic, not a model.** Fast, free, offline and
  private, and sometimes wrong. That is why the phrase is editable.
- **The lexicon is English-centric.** Unlisted concepts still work through the
  rarity and position heuristics, but less reliably. PRs welcome.
- **A free API key is required.** There is no shared key, by design.
- **Clips play through a hosted page.** YouTube refuses to play inside a
  `chrome-extension://` frame, so the panel frames
  [`docs/player.html`](docs/player.html) on GitHub Pages. It only embeds the
  official player. Host your own copy, or turn inline playback off.
- **Shorts are for orientation, not understanding.** This is for the gap in
  your attention, not a substitute for reading properly.

---

## Also in this repository

`src/`, `extension/` and `vscode/` are an earlier version that ran as a local
daemon with Claude Code hooks, a terminal panel and a VS Code sidebar. It works,
but it cannot be published: its panel UI is served from `127.0.0.1`, which
Manifest V3 forbids. The browser extension is the product; that code remains
because the extractor in `src/core/` is shared with it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Adding vocabulary to
[`src/core/lexicon.ts`](src/core/lexicon.ts) for a field it does not know yet is
the most useful change and needs no architectural knowledge.

## License

MIT
