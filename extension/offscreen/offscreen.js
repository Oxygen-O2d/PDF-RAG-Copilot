/**
 * offscreen.js — Manifest V3 Offscreen Document (v2.0 — Backend-Free)
 *
 * This is the core processing engine of the extension. It runs in an isolated
 * background DOM context and handles:
 *
 *  1. PDF text extraction via pdf.js
 *  2. Text chunking (512 chars, 50 char overlap)
 *  3. In-browser vector store via IndexedDB
 *  4. Pure JS BM25 search engine for RAG retrieval (No WASM required)
 */

// ─── pdf.js setup ─────────────────────────────────────────────────────────────

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
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

// ─── BM25 Search Engine (Pure JS, No WASM) ───────────────────────────────────

function tokenize(text) {
  return (text.toLowerCase().match(/\b\w+\b/g) || []).filter(t => t.length > 2);
}

class BM25 {
  constructor(corpus) {
    this.k1 = 1.2;
    this.b = 0.75;
    this.docCount = corpus.length;
    this.docLengths = [];
    this.termFreqs = [];
    this.docFreqs = {};
    let totalLen = 0;

    for (let i = 0; i < corpus.length; i++) {
      const tokens = tokenize(corpus[i].text);
      this.docLengths.push(tokens.length);
      totalLen += tokens.length;

      const freqs = {};
      const uniqueTokens = new Set();
      for (const token of tokens) {
        freqs[token] = (freqs[token] || 0) + 1;
        uniqueTokens.add(token);
      }
      this.termFreqs.push(freqs);

      for (const token of uniqueTokens) {
        this.docFreqs[token] = (this.docFreqs[token] || 0) + 1;
      }
    }
    this.avgDocLen = this.docCount > 0 ? totalLen / this.docCount : 0;
  }

  score(queryTokens, docIdx) {
    let score = 0;
    const docLen = this.docLengths[docIdx];
    const freqs = this.termFreqs[docIdx];

    for (const token of queryTokens) {
      if (!this.docFreqs[token]) continue;
      const tf = freqs[token] || 0;
      const df = this.docFreqs[token];
      const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
      const numerator = tf * (this.k1 + 1);
      const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLen));
      score += idf * (numerator / denominator);
    }
    return score;
  }

  search(query, chunks, topK = 4) {
    const queryTokens = tokenize(query);
    const scores = [];
    for (let i = 0; i < this.docCount; i++) {
      scores.push({ chunk: chunks[i], score: this.score(queryTokens, i) });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }
}

// ─── Text Chunking (page-aware) ─────────────────────────────────────────────

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
  let missedPages = 0;

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
      missedPages++;
    }
  }

  return { pages, missedPages, numPages };
}

// ─── Main Message Router ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── 1. Extract PDF (pdf.js only) ──────────────────────────────────────────
  if (message.type === "OFFSCREEN_EXTRACT_PDF") {
    (async () => {
      try {
        const { arrayBuffer: b64, url } = message.payload;

        let arrayBuffer;
        if (b64) {
          const binary = atob(b64);
          arrayBuffer = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) arrayBuffer[i] = binary.charCodeAt(i);
          arrayBuffer = arrayBuffer.buffer;
        } else {
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          arrayBuffer = await res.arrayBuffer();
        }

        const { pages, missedPages, numPages } = await extractWithPdfJs(arrayBuffer);

        if (missedPages > 0) {
          console.warn(`[Offscreen] Missing text on ${missedPages} pages (scanned/images). WASM OCR disabled.`);
        }

        pages.sort((a, b) => a.page - b.page);
        const fullText = pages.map((p) => `[Page ${p.page}]\n${p.text}`).join("\n\n");

        sendResponse({
          success: true,
          pageCount: numPages,
          ocrPageCount: 0, // OCR removed
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

  // ── 2. Index Chunks (chunk + store in IndexedDB) ──────────────────────────
  if (message.type === "OFFSCREEN_INDEX_CHUNKS") {
    (async () => {
      try {
        const { pages, doc_id, title } = message.payload;
        const rawChunks = chunkPages(pages, 512, 50);
        console.log(`[Offscreen] Chunked into ${rawChunks.length} segments.`);

        const chunkRecords = rawChunks.map((c, i) => ({
          id: `${doc_id}_chunk_${i}`,
          doc_id,
          title,
          chunk_index: i,
          page: c.page,
          text: c.text
        }));

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

  // ── 3. Search Chunks (BM25 retrieval) ─────────────────────────────────────
  if (message.type === "OFFSCREEN_SEARCH_CHUNKS") {
    (async () => {
      try {
        const { query, doc_id, top_k = 4 } = message.payload;

        const db = await openDB();
        const chunks = await loadChunksFromDB(db, doc_id);

        if (chunks.length === 0) {
          sendResponse({ success: false, error: "No indexed chunks found. Please re-index the PDF." });
          return;
        }

        // Build BM25 index on the fly (very fast for thousands of chunks)
        const bm25 = new BM25(chunks);
        const ranked = bm25.search(query, chunks, top_k);

        const sources = ranked.map((r, idx) => ({
          chunk_id: idx + 1,
          page: r.chunk.page,
          doc_id: r.chunk.doc_id,
          snippet: r.chunk.text.slice(0, 200),
          score: r.score.toFixed(4)
        }));

        const context = ranked.map((r, i) => `--- [Retrieved Chunk ${i + 1} | Page ${r.chunk.page}] ---\n${r.chunk.text}`).join("\n\n");

        sendResponse({ success: true, sources, context });
      } catch (err) {
        console.error("[Offscreen] SEARCH_CHUNKS failed:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
