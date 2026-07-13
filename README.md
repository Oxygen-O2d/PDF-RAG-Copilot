# PDF RAG Copilot v2.0 — Backend-Free AI PDF Chat

> **A fully self-contained Chrome Extension.** Chat with any PDF — local files, web PDFs, or cloud drives — with no backend, no WebAssembly, and no setup beyond adding an API key.

---

## What's New in v2.0

The entire Python backend has been eliminated, and we've replaced heavy WASM libraries with lightning-fast pure JavaScript alternatives to comply with strict Manifest V3 Content Security Policies.

| Feature | v1.0 | v2.0 Final |
|---|---|---|
| **Architecture** | Python server + Extension | ✅ **100% Chrome Extension** |
| **Text extraction** | pdf.js | ✅ **pdf.js + Universal DOM Fallback** |
| **Indexing engine** | Python + ChromaDB | ✅ **Pure JS BM25 Search Engine** (Instant, No WASM) |
| **Data storage** | SQLite | ✅ **IndexedDB** (Browser-native) |
| **LLM calls** | FastAPI relay | ✅ **Direct API calls** (Google, OpenAI, Anthropic, Groq) |

---

## Architecture

```
Chrome Extension (fully standalone)
│
├── sidepanel/            ← Chat UI · Settings · Direct LLM API calls
├── background.js         ← Universal Fetcher · Blob/Drive Handlers · DOM Scrape Fallback
└── offscreen/            ← Heavy lifting (isolated background DOM context)
    ├── pdf.js            → Extracts text from raw PDF binaries
    ├── BM25 Engine       → Pure JavaScript search algorithm (Elasticsearch style)
    └── IndexedDB         → Stores chunked text locally
```

**Data flow:**
1. Background script tries to fetch the PDF binary (bypassing CORS and auth via in-tab injection).
2. If the fetch returns an HTML intercept (like Google Drive or WhatsApp viewers), it gracefully falls back to **scraping the visible text off the DOM**.
3. Raw text is sent to the **Offscreen Document**, where it is chunked (512 chars, 50 overlap).
4. Chunks are saved instantly to **IndexedDB**.
5. On chat: query is passed to the **Pure JS BM25 search engine**, which instantly ranks the top 4 chunks using TF-IDF math.
6. Chunks + query are sent directly to the **LLM API** → answer streamed back.

---

## Quick Start

### 1. Download pdf.js

```powershell
cd extension/lib
Invoke-WebRequest 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' -OutFile 'pdf.min.js'
Invoke-WebRequest 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' -OutFile 'pdf.worker.min.js'
```

### 2. Load the Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked** → select the `extension/` folder
4. *(For local PDFs)* Click **Details** on the extension → enable **"Allow access to file URLs"**

### 3. Add Your API Key

1. Click the extension icon to open the Side Panel
2. Click the **⚙️ icon** (top right of panel)
3. Pick your provider, paste your key, click **Save & Apply**

| Provider | Locked Model | Get your key |
|---|---|---|
| 🔵 **Google** | `gemini-2.0-flash` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) — free |
| 🟢 **OpenAI** | `gpt-4o-mini` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| 🟠 **Anthropic** | `claude-3-5-haiku` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| 🔴 **Groq** | `llama-3.3-70b-versatile` | [console.groq.com/keys](https://console.groq.com/keys) — free |

### 4. Chat with Your PDF

1. Open any PDF tab (local `file:///`, web URL, WhatsApp Web `blob:`, or cloud drive).
2. Click **Extract & Index PDF**.
3. The extension will automatically bypass auth blocks, extract the text, and index it instantly using BM25.
4. Ask anything in the chat box!

---

## Privacy

- **Extraction, indexing, and search** happen 100% locally in your browser.
- **Only your question + the top retrieved chunks** are sent to the LLM API to generate an answer.
- API keys are stored in `chrome.storage.sync` (encrypted by Chrome, synced across your signed-in devices).

---

## Notes

- **First run is slower** — Tesseract.js (~10MB) and Transformers.js (~30MB) models are downloaded from CDN and cached by the browser. Subsequent runs are fast.
- The vector index **persists in IndexedDB** — no need to re-index every time you open the panel.
- Each LLM provider **stores its own API key and model independently** — you can configure all four and switch between them without re-entering keys.
