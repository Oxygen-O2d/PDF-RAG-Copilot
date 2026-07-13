# PDF RAG Copilot v2.0 — Backend-Free AI PDF Chat

> **A fully self-contained Chrome Extension.** Chat with any PDF — local files, web PDFs, or Google Drive previews — with no Python backend, no local server, and no setup beyond loading the extension and adding an API key.

---

## What's New in v2.0

The entire Python/FastAPI backend has been removed. Everything runs inside the Chrome extension itself.

| | v1.0 | v2.0 |
|---|---|---|
| Text extraction | ✅ pdf.js | ✅ pdf.js |
| OCR (scanned PDFs) | ❌ | ✅ **Tesseract.js** (WebAssembly, CDN) |
| Embeddings | Python + ChromaDB | ✅ **Transformers.js** (WebAssembly, CDN) |
| Vector store | Python ChromaDB | ✅ **IndexedDB** (browser-native) |
| LLM calls | Python FastAPI relay | ✅ **Direct API calls** (your key) |
| Requires backend | ✅ | ❌ **Not needed** |
| Supported LLM providers | OpenAI only | ✅ **Google · OpenAI · Anthropic · Groq** |

---

## Architecture

```
Chrome Extension (fully standalone)
│
├── sidepanel/            ← Chat UI · Settings · Direct LLM API calls
├── background.js         ← Tab detection · Offscreen lifecycle · Message routing
└── offscreen/            ← Heavy lifting (isolated background DOM context)
    ├── pdf.js            → Extracts text from standard PDFs
    ├── Tesseract.js      → OCRs scanned / image-only pages  (CDN, cached)
    ├── Transformers.js   → Generates embeddings             (CDN, cached ~30MB)
    └── IndexedDB         → Stores chunk vectors locally
```

**Data flow:**
1. PDF binary → **pdf.js** extracts text per page
2. Image-only pages → **Tesseract.js** OCR fallback
3. Pages → **page-aware chunker** (512 chars, 50 overlap, page tag preserved)
4. Each chunk → **Transformers.js** `all-MiniLM-L6-v2` embedding (384-dim)
5. Vectors saved to **IndexedDB** (persists across sessions)
6. On chat: query embedded → **cosine similarity search** → top 4 chunks
7. Chunks + query → **LLM API** of your choice → answer streamed back

---

## Quick Start

### 1. Download pdf.js

```powershell
cd d:\PDF-RAG-Copilot\extension\lib
Invoke-WebRequest 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' -OutFile 'pdf.min.js'
Invoke-WebRequest 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' -OutFile 'pdf.worker.min.js'
```

> Tesseract.js and Transformers.js are loaded automatically from CDN on first use — no download needed.

### 2. Load the Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked** → select the `extension/` folder
4. *(For local PDFs)* Click **Details** on the extension → enable **"Allow access to file URLs"**

### 3. Add Your API Key

1. Click the extension icon to open the Side Panel
2. Click the **⚙️ icon** (top right of panel)
3. Pick your provider, paste your key, select a model, click **Save & Apply**

| Provider | Get your key |
|---|---|
| 🔵 Google Gemini | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) — free |
| 🟢 OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| 🟠 Anthropic | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| 🔴 Groq | [console.groq.com/keys](https://console.groq.com/keys) — free |

### 4. Chat with Your PDF

1. Open any PDF tab (local `file:///`, web URL, or Google Drive preview)
2. Click **Extract & Index PDF** — the extension will extract text, OCR any scanned pages, and embed everything locally
3. Ask anything in the chat box!

---

## Supported Models

| Provider | Models |
|---|---|
| Google Gemini | gemini-2.0-flash · gemini-1.5-flash · gemini-1.5-pro |
| OpenAI | gpt-4o-mini · gpt-4o · gpt-3.5-turbo |
| Anthropic | claude-3.5-haiku · claude-3.5-sonnet · claude-3-opus |
| Groq | **llama-3.3-70b-versatile** *(recommended for RAG)* · llama-3.1-8b-instant · llama3-70b · mixtral-8x7b · gemma2-9b |

> **Why llama-3.3-70b-versatile on Groq?** It's the most capable model Groq hosts and runs at near-instant speed thanks to their custom LPU chips — ideal for low-latency RAG responses.

---

## Privacy

- **Extraction, OCR, and indexing** happen 100% locally in your browser.
- **Only your question + the top retrieved chunks** are sent to the LLM API to generate an answer.
- API keys are stored in `chrome.storage.sync` (encrypted by Chrome, synced across your signed-in devices).

---

## Notes

- **First run is slower** — Tesseract.js (~10MB) and Transformers.js (~30MB) models are downloaded from CDN and cached by the browser. Subsequent runs are fast.
- The vector index **persists in IndexedDB** — no need to re-index every time you open the panel.
- Each LLM provider **stores its own API key and model independently** — you can configure all four and switch between them without re-entering keys.
