/**
 * offscreen.js — Manifest V3 Offscreen Document (v2.0 — Backend-Free)
 *
 * This is the core processing engine of the extension. It runs in an isolated
 * background DOM context and handles:
 *
 *  1. PDF text extraction via pdf.js
 *  2. OCR fallback via Tesseract.js (for scanned/image-only pages)
 *  3. Text chunking (512 chars, 50 char overlap)
 *  4. Embedding generation via @xenova/transformers (all-MiniLM-L6-v2, runs in-browser)
 *  5. In-browser vector store via IndexedDB
 *  6. Cosine similarity search for RAG retrieval
 */

// ─── pdf.js setup ─────────────────────────────────────────────────────────────

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
}

// ─── Transformers.js setup ────────────────────────────────────────────────────
// Loaded dynamically from CDN on first use; cached in-memory after that.
let embedder = null;

async function getEmbedder() {
  if (embedder) return embedder;
  const { pipeline } = await import(
    "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js"
  );
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true
  });
  return embedder;
}

// ─── IndexedDB Vector Store ───────────────────────────────────────────────────

const DB_NAME = "pdf_rag_copilot_v2";
const DB_VERSION = 1;
const STORE_NAME = "chunks";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("doc_id", "doc_id", { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function clearDocFromDB(db, docId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("doc_id");
    const req = index.openCursor(IDBKeyRange.only(docId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function saveChunksToDB(db, chunks) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const chunk of chunks) {
      store.put(chunk);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function loadChunksFromDB(db, docId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("doc_id");
    const req = index.getAll(docId);
    req.onsuccess = (e) => resolve(e.target.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ─── Text Chunking (page-aware) ─────────────────────────────────────────────
// Accepts an array of {page, text} objects; returns {text, page} chunk records
// so page numbers are known at split time — no string-searching later.

function chunkPages(pages, chunkSize = 512, overlap = 50) {
  const results = [];
  for (const { page, text } of pages) {
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const slice = text.slice(start, end).trim();
      if (slice.length > 20) results.push({ text: slice, page });
      if (end === text.length) break;
      start += chunkSize - overlap;
    }
  }
  return results;
}

// ─── PDF Text Extraction ──────────────────────────────────────────────────────

async function extractWithPdfJs(arrayBuffer) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer, useSystemFonts: true }).promise;
  const numPages = pdfDoc.numPages;
  const pages = [];
  const imageOnlyPages = []; // track pages with no text for OCR

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => item.str || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (pageText.length > 10) {
      pages.push({ page: pageNum, text: pageText });
    } else {
      // No meaningful text — likely a scanned image page
      imageOnlyPages.push({ pageNum, pdfPage: page });
    }
  }

  return { pages, imageOnlyPages, numPages };
}

// ─── Tesseract.js OCR ─────────────────────────────────────────────────────────

let tesseractWorker = null;

async function getTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;

  // Dynamically import Tesseract.js from CDN
  const { createWorker } = await import(
    "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js"
  );
  tesseractWorker = await createWorker("eng", 1, {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd.wasm.js",
    logger: (m) => console.debug("[Tesseract]", m.status, m.progress?.toFixed(2))
  });
  return tesseractWorker;
}

async function ocrPdfPage(pdfPage) {
  // Render the PDF page to a canvas, then pass the image data to Tesseract
  const scale = 2.0; // higher scale = better OCR accuracy
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;

  const worker = await getTesseractWorker();
  const { data } = await worker.recognize(canvas);
  return data.text.replace(/\s+/g, " ").trim();
}

// ─── Main Message Router ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── 1. Extract PDF (pdf.js + OCR fallback) ────────────────────────────────
  if (message.type === "OFFSCREEN_EXTRACT_PDF") {
    (async () => {
      try {
        const { url } = message.payload;

        // Fetch the PDF binary
        let arrayBuffer;
        try {
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          arrayBuffer = await res.arrayBuffer();
        } catch (fetchErr) {
          if (url?.startsWith("file://")) {
            throw new Error(
              'Cannot read local file. Please enable "Allow access to file URLs" in extension settings (chrome://extensions).'
            );
          }
          throw new Error(`Failed to fetch PDF: ${fetchErr.message}`);
        }

        // Try pdf.js first
        const { pages, imageOnlyPages, numPages, pdfDoc } = await extractWithPdfJs(arrayBuffer);

        // OCR fallback for image-only pages
        if (imageOnlyPages.length > 0) {
          console.log(`[Offscreen] ${imageOnlyPages.length} image-only page(s) detected. Running Tesseract OCR...`);
          for (const { pageNum, pdfPage } of imageOnlyPages) {
            try {
              const ocrText = await ocrPdfPage(pdfPage);
              if (ocrText && ocrText.length > 10) {
                pages.push({ page: pageNum, text: `[OCR] ${ocrText}` });
              }
            } catch (ocrErr) {
              console.warn(`[Offscreen] OCR failed for page ${pageNum}:`, ocrErr);
            }
          }
        }

        // Sort pages by page number
        pages.sort((a, b) => a.page - b.page);
        const fullText = pages.map((p) => `[Page ${p.page}]\n${p.text}`).join("\n\n");

        sendResponse({
          success: true,
          pageCount: numPages,
          ocrPageCount: imageOnlyPages.length,
          pages,
          fullText,
          url
        });
      } catch (err) {
        console.error("[Offscreen] EXTRACT_PDF failed:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // ── 2. Index Chunks (chunk + embed + store in IndexedDB) ──────────────────
  if (message.type === "OFFSCREEN_INDEX_CHUNKS") {
    (async () => {
      try {
        const { pages, doc_id, title } = message.payload;

        // 1. Page-aware chunking — page number is known at split time
        const rawChunks = chunkPages(pages, 512, 50);
        console.log(`[Offscreen] Chunked into ${rawChunks.length} segments.`);

        // 2. Generate embeddings
        const embed = await getEmbedder();

        const chunkRecords = [];
        for (let i = 0; i < rawChunks.length; i++) {
          const { text, page } = rawChunks[i];
          const output = await embed(text, { pooling: "mean", normalize: true });
          chunkRecords.push({
            id: `${doc_id}_chunk_${i}`,
            doc_id,
            title,
            chunk_index: i,
            page,
            text,
            vector: Array.from(output.data)
          });

          if (i % 10 === 0) {
            chrome.runtime.sendMessage({
              type: "INDEXING_PROGRESS",
              payload: { current: i + 1, total: rawChunks.length }
            }).catch(() => {});
          }
        }

        // 3. Save to IndexedDB
        const db = await openDB();
        await clearDocFromDB(db, doc_id);
        await saveChunksToDB(db, chunkRecords);

        sendResponse({ success: true, chunk_count: chunkRecords.length, doc_id });
      } catch (err) {
        console.error("[Offscreen] INDEX_CHUNKS failed:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // ── 3. Search Chunks (cosine similarity retrieval) ────────────────────────
  if (message.type === "OFFSCREEN_SEARCH_CHUNKS") {
    (async () => {
      try {
        const { query, doc_id, top_k = 4 } = message.payload;

        // Embed the user query
        const embed = await getEmbedder();
        const output = await embed(query, { pooling: "mean", normalize: true });
        const queryVector = Array.from(output.data);

        // Load chunks from IndexedDB
        const db = await openDB();
        const chunks = await loadChunksFromDB(db, doc_id);

        if (chunks.length === 0) {
          sendResponse({ success: false, error: "No indexed chunks found for this document. Please re-index the PDF." });
          return;
        }

        // Rank by cosine similarity
        const ranked = chunks
          .map((c) => ({ ...c, score: cosineSimilarity(queryVector, c.vector) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, top_k);

        const sources = ranked.map((c, idx) => ({
          chunk_id: idx + 1,
          page: c.page,
          doc_id: c.doc_id,
          snippet: c.text.slice(0, 200),
          score: c.score.toFixed(4)
        }));

        const context = ranked.map((c, i) => `--- [Retrieved Chunk ${i + 1} | Page ${c.page}] ---\n${c.text}`).join("\n\n");

        sendResponse({ success: true, sources, context });
      } catch (err) {
        console.error("[Offscreen] SEARCH_CHUNKS failed:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
