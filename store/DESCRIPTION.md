## YouTube Gemini Summarizer

Summarize YouTube videos using Gemini. The extension reads the current YouTube page (title + description + transcript when available) and generates a summary.

### Features
- One-click summary: Start summarizing from the extension popup.
- In-page drawer: The result is shown in a right-side drawer on the YouTube page.
- Video cards across YouTube: On Home, Subscriptions, Search, and many Channel lists, a **Summarize** button appears on supported video cards.
- Summary modes: Summary / Detailed Summary.
- Model selection: Automatic (recommended) or manually choose a model from the settings list.
- Rate-limit aware fallback: If a model is rate-limited/unavailable, it tries another compatible model.

### How to use
1. Open Settings and paste your Gemini API key.
2. Open any YouTube video page.
3. Click the extension icon → “Summarize with Gemini”.

### Notes
- On free-tier keys you may hit rate limits; wait a bit and try again.
- Your API key is stored locally in your browser (`chrome.storage.local`). Do not share it.
