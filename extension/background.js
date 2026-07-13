/**
 * background.js — Manifest V3 Service Worker (v2.0 — Backend-Free)
 * Handles Side Panel behavior, PDF detection, Offscreen document lifecycle.
 * No longer relays to a Python backend — all processing is in the Offscreen document.
 */

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  console.log("[Background] PDF RAG Copilot v2 installed. Backend-free mode active.");
});

// ─── PDF Detection ────────────────────────────────────────────────────────────

function isPDF(tab) {
  if (!tab || !tab.url) return false;
  const url = tab.url;
  const title = (tab.title || "").toLowerCase();
  if (url.startsWith("chrome-extension://")) return true;   // built-in PDF viewer
  if (/\.pdf(\?|#|$)/i.test(url)) return true;              // URL ends in .pdf
  if (title.endsWith(".pdf")) return true;                   // title contains PDF filename
  if (url.includes("drive.google.com") || url.includes("docs.google.com")) return true; // Google Drive/Docs
  if (tab.isPdf) return true;                               // signalled by content-type check
  return false;
}

// Tries to detect application/pdf content type via scripting (catches PDF URLs without .pdf)
async function detectPdfByContentType(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType
    });
    return result?.result === "application/pdf";
  } catch {
    return false;
  }
}

// ─── Offscreen Document Lifecycle ─────────────────────────────────────────────

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existing = await clients.matchAll();
  if (existing.some((c) => c.url === offscreenUrl)) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.DOM_PARSER, chrome.offscreen.Reason.BLOBS],
    justification: "Run pdf.js, Tesseract.js OCR, Transformers.js embeddings and local vector DB in a background DOM context."
  });
}

// ─── Tab Inspection & Side Panel Notification ─────────────────────────────────

async function inspectActiveTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return;

    const allowedFileAccess = await new Promise((resolve) => {
      chrome.extension.isAllowedFileSchemeAccess(resolve);
    });

    // Check content-type for web PDFs that don't have .pdf in the URL
    let isPdfByType = false;
    if (!isPDF(tab) && tab.url && !tab.url.startsWith("chrome") && !tab.url.startsWith("file")) {
      isPdfByType = await detectPdfByContentType(tabId);
    }

    chrome.runtime.sendMessage({
      type: "TAB_UPDATED",
      payload: {
        tabId: tab.id,
        url: tab.url,
        title: tab.title || "Untitled Document",
        isPdf: isPDF(tab) || isPdfByType,
        isFileUrl: tab.url.startsWith("file://"),
        allowedFileAccess
      }
    }).catch(() => {});
  } catch (error) {
    console.debug("[Background] Could not inspect tab:", error);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => inspectActiveTab(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    inspectActiveTab(tabId);
  }
});

// ─── Google Drive File ID Finder (injected into Drive tab) ───────────────────

function findDriveFileId() {
  try {
    let m = window.location.href.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
    if (m && m[1]) return m[1];
    const params = new URLSearchParams(window.location.search);
    if (params.get("id") && params.get("id").length > 15) return params.get("id");
    const iframes = document.querySelectorAll("iframe");
    for (const f of iframes) {
      const src = f.src || "";
      m = src.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/) || src.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
      if (m && m[1]) return m[1];
    }
  } catch (e) {}
  return null;
}

function scrapeGenericDomText() {
  try {
    const pages = [];
    const textChunks = [];
    // 1. Try Drive/Docs specific formatting
    const drivePages = document.querySelectorAll(
      '.textLayer, [role="document"] .kix-page, .ndfHFb-c4YZDc-cYj04b-V67aGc, .kix-page-content-wrapper, .drive-viewer-paginated-scrollable .page'
    );
    if (drivePages && drivePages.length > 0) {
      drivePages.forEach((el) => {
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (text && text.length > 15 && !text.includes("docs-offline-")) {
          const pageNum = pages.length + 1;
          pages.push({ page: pageNum, text });
          textChunks.push(`[Page ${pageNum}]\n${text}`);
        }
      });
      if (pages.length > 0) {
        return { success: true, pageCount: pages.length, pages, fullText: textChunks.join("\n\n"), url: window.location.href };
      }
    }

    // 2. Drive modal fallback
    const modal = document.querySelector('[role="dialog"]') || document.querySelector(".drive-viewer-paginated-scrollable");
    if (modal) {
      const fullText = (modal.innerText || modal.textContent || "").replace(/\s+/g, " ").trim();
      if (fullText && fullText.length > 30 && !fullText.includes("docs-offline-")) {
        return { success: true, pageCount: 1, pages: [{ page: 1, text: fullText }], fullText, url: window.location.href };
      }
    }

    // 3. Universal generic fallback: grab all body text (useful for WhatsApp, OneDrive, Notion embeds, etc.)
    const bodyText = document.body.innerText.replace(/\s+/g, " ").trim();
    if (bodyText.length > 100) {
      return { success: true, pageCount: 1, pages: [{ page: 1, text: bodyText }], fullText: bodyText, url: window.location.href };
    }

    return { success: false, error: "Could not extract visible text from the page." };
  } catch (err) {
    return { success: false, error: "DOM extraction error: " + err.message };
  }
}

// ─── Helper: In-Tab PDF Fetcher ───────────────────────────────────────────────
// Injected into the current tab so it can access blob: URLs (like WhatsApp)
// and share the tab's authenticated cookies (like Google Drive).

async function fetchPdfInTab(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      throw new Error("Fetched URL returned an HTML page instead of a PDF document.");
    }
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const b64 = reader.result.split(",")[1];
        resolve({ success: true, base64: b64 });
      };
      reader.onerror = () => reject(new Error("Failed to read PDF blob"));
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Side panel asks for current tab info on open
  if (message.type === "GET_ACTIVE_TAB_INFO") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }
      const tab = tabs[0];
      const allowedFileAccess = await new Promise((resolve) => {
        chrome.extension.isAllowedFileSchemeAccess(resolve);
      });
      let isPdfByType = false;
      if (!isPDF(tab) && tab.url && !tab.url.startsWith("chrome") && !tab.url.startsWith("file")) {
        isPdfByType = await detectPdfByContentType(tab.id);
      }
      sendResponse({
        success: true,
        payload: {
          tabId: tab.id,
          url: tab.url,
          title: tab.title || "Untitled Document",
          isPdf: isPDF(tab) || isPdfByType,
          isFileUrl: tab.url.startsWith("file://"),
          allowedFileAccess
        }
      });
    });
    return true;
  }

  if (message.type === "EXTRACT_PDF_TEXT") {
    (async () => {
      try {
        const { tabId, url } = message.payload;
        const targetUrl = url || "";
        const isDrivePage = targetUrl.includes("drive.google.com") || targetUrl.includes("docs.google.com");

        // ── Helper: fetch PDF binary in background (host_permissions bypasses CORS) ──
        async function fetchPdfAsBase64(fetchUrl) {
          const res = await fetch(fetchUrl, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("text/html")) {
            throw new Error("Fetched URL returned an HTML page instead of a PDF document.");
          }
          const blob = await res.blob();
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(",")[1]);
            reader.onerror = () => reject(new Error("Failed to read PDF blob"));
            reader.readAsDataURL(blob);
          });
        }

        // 1. WhatsApp Web / Blob URLs
        let b64 = null;
        let fetchError = null;

        try {
          if (targetUrl.startsWith("blob:")) {
            const fetchResults = await chrome.scripting.executeScript({
              target: { tabId },
              func: fetchPdfInTab,
              args: [targetUrl]
            });
            const fetchRes = fetchResults[0]?.result;
            if (fetchRes?.success && fetchRes.base64) b64 = fetchRes.base64;
            else throw new Error(fetchRes?.error || "In-tab fetch failed");
          } 
          // 2. Google Drive / Docs
          else if (isDrivePage) {
            let foundFileId = null;
            try {
              const idResults = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: findDriveFileId });
              for (const r of (idResults || [])) {
                if (r.result && typeof r.result === "string" && r.result.length >= 20) { foundFileId = r.result; break; }
              }
            } catch (e) {}

            if (foundFileId) {
              const driveDownloadUrl = `https://drive.google.com/uc?export=download&id=${foundFileId}`;
              const fetchResults = await chrome.scripting.executeScript({ target: { tabId }, func: fetchPdfInTab, args: [driveDownloadUrl] });
              if (fetchResults[0]?.result?.success) b64 = fetchResults[0].result.base64;
              else b64 = await fetchPdfAsBase64(driveDownloadUrl);
            }
          } 
          // 3. Standard web / local PDF
          else if (!targetUrl.startsWith("file://")) {
            b64 = await fetchPdfAsBase64(targetUrl);
          }
        } catch (e) {
          fetchError = e;
          console.debug("[Background] Binary fetch failed:", e);
        }

        // Try extracting via offscreen pdf.js if we got the binary (or if it's a local file offscreen can fetch itself)
        if (b64 || targetUrl.startsWith("file://")) {
          try {
            await ensureOffscreenDocument();
            const result = await chrome.runtime.sendMessage({
              type: "OFFSCREEN_EXTRACT_PDF",
              payload: { arrayBuffer: b64, url: targetUrl }
            });
            if (result?.success && result.pageCount > 0) {
              sendResponse(result);
              return;
            }
          } catch (e) {
            console.debug("[Background] Offscreen extraction failed:", e);
            fetchError = fetchError || e;
          }
        }

        // --- UNIVERSAL FALLBACK: DOM Scrape ---
        // If fetch failed, returned HTML, or pdf.js failed, and the tab isn't a restricted local/extension page:
        if (!targetUrl.startsWith("file://") && !targetUrl.startsWith("chrome")) {
          console.log("[Background] Falling back to generic DOM scrape...");
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: scrapeGenericDomText
          });
          let best = null;
          for (const r of (results || [])) {
            if (r.result?.success && r.result.fullText) {
              if (!best || r.result.fullText.length > best.fullText.length) best = r.result;
            }
          }
          if (best) {
            sendResponse(best);
            return;
          }
        }

        throw fetchError || new Error("Could not extract PDF text or find visible text on the page.");

      } catch (error) {
        console.error("[Background] Extraction failed:", error);
        sendResponse({ success: false, error: error.message || "Failed to extract PDF." });
      }
    })();
    return true;
  }

  // Generic relay: ensure offscreen doc exists, forward message, return response
  if (message.type === "SEARCH_CHUNKS" || message.type === "INDEX_CHUNKS") {
    const outType = message.type === "SEARCH_CHUNKS"
      ? "OFFSCREEN_SEARCH_CHUNKS"
      : "OFFSCREEN_INDEX_CHUNKS";
    (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          type: outType,
          payload: message.payload
        });
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
});
