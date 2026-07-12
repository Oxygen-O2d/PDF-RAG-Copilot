# PDF RAG Copilot — Full-Stack Manifest V3 Chrome Extension & Local Python RAG

A browser-native AI assistant that opens a Chrome Side Panel when viewing any PDF (local `file:///` files, Google Drive previews, or web PDFs), extracts text entirely client-side using an Offscreen Document (`pdf.js`), and chats with your PDF using a local Python vector backend (`FastAPI` + `Chroma DB` + `LangChain`).

---

## Complete Project Directory Structure

```
d:\RAGExtension\
├── extension/                      # Manifest V3 Chrome Extension
│   ├── manifest.json               # MV3 Permissions & sidePanel config
│   ├── background.js               # Service Worker & Offscreen lifecycle manager
│   ├── lib/
│   │   ├── pdf.min.js              # Bundled local PDF.js core
│   │   ├── pdf.worker.min.js       # Bundled local PDF.js worker
│   │   └── download_pdfjs.ps1      # Script to download official PDF.js prebuilt files
│   ├── offscreen/
│   │   ├── offscreen.html          # MV3 Offscreen Document
│   │   └── offscreen.js            # PDF.js text extractor
│   └── sidepanel/
│       ├── sidepanel.html          # Chat & Ingest UI shell
│       ├── sidepanel.js            # End-to-end API & RAG Controller
│       └── styles.css              # Glassmorphic dark mode styling
│
└── backend/                        # Isolated Python RAG Backend
    ├── main.py                     # FastAPI server (/ingest & /chat)
    ├── requirements.txt            # Python dependencies
    ├── .env.example                # Template for LLM API keys
    └── README.md                   # Backend setup & Uvicorn commands
```

---

## Quickstart Guide

### Step 1: Start the Local RAG Backend
1. Open PowerShell in `d:\RAGExtension\backend`:
   ```powershell
   cd d:\RAGExtension\backend
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```
2. Start the FastAPI server:
   ```powershell
   uvicorn main:app --reload --host 0.0.0.0 --port 8000
   ```

### Step 2: Load the Chrome Extension
1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top right toggle).
3. Click **Load unpacked** and select `d:\RAGExtension\extension`.
4. *(Optional for local files)*: Click **Details** on the extension card and toggle **ON "Allow access to file URLs"**.

### Step 3: Extract & Chat
1. Open any PDF tab (local file, Google Drive preview, or online PDF).
2. Click the extension toolbar icon to open the Side Panel.
3. Click **Extract & Index PDF** — the extension will extract all text locally via `chrome.offscreen` and POST it to `http://127.0.0.1:8000/ingest`.
4. Once indexed, type your question and inspect clickable source citation badges (`Page X`) with expandable context accordions!
