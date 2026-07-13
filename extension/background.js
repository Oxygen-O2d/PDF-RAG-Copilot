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
  if (url.includes("drive.google.com")) return true;         // Google Drive
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

function scrapeDriveDomText() {
  try {
    const pages = [];
    const textChunks = [];
    const pageElements = document.querySelectorAll(
      '.textLayer, [role="document"] .kix-page, .ndfHFb-c4YZDc-cYj04b-V67aGc, .kix-page-content-wrapper, .drive-viewer-paginated-scrollable .page'
    );
    if (pageElements && pageElements.length > 0) {
      pageElements.forEach((el) => {
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (text && text.length > 15 && !text.includes("docs-offline-")) {
          const pageNum = pages.length + 1;
          pages.push({ page: pageNum, text });
          textChunks.push(`[Page ${pageNum}]\n${text}`);
        }
      });
    }
    let fullText = textChunks.join("\n\n");
    if (!fullText || fullText.trim().length < 30) {
      const modal = document.querySelector('[role="dialog"]') || document.querySelector(".drive-viewer-paginated-scrollable");
      if (modal) {
        fullText = (modal.innerText || modal.textContent || "").replace(/\s+/g, " ").trim();
        if (fullText && !fullText.includes("docs-offline-")) {
          pages.length = 0;
          pages.push({ page: 1, text: fullText });
        }
      }
    }
    if (!fullText || fullText.trim().length < 10) {
      return { success: false, error: "Could not extract visible text from Google Drive preview." };
    }
    return { success: true, pageCount: pages.length || 1, pages, fullText, url: window.location.href };
  } catch (err) {
    return { success: false, error: "Drive extraction error: " + err.message };
  }
}

// ─── Helper: In-Tab PDF Fetcher ───────────────────────────────────────────────
// Injected into the current tab so it can access blob: URLs (like WhatsApp)
// and share the tab's authenticated cookies (like Google Drive).

async function fetchPdfInTab(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { success: true, base64: btoa(binary) };
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
        const isDrivePage = targetUrl.includes("drive.google.com");

        // ── Helper: fetch PDF binary in background (host_permissions bypasses CORS) ──
        async function fetchPdfAsBase64(fetchUrl) {
          const res = await fetch(fetchUrl, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return btoa(binary);
        }

        // 1. WhatsApp Web / Blob URLs
        if (targetUrl.startsWith("blob:")) {
          try {
            // Blob URLs must be fetched from within the tab that created them
            const fetchResults = await chrome.scripting.executeScript({
              target: { tabId },
              func: fetchPdfInTab,
              args: [targetUrl]
            });
            const fetchRes = fetchResults[0]?.result;
            if (fetchRes && fetchRes.success && fetchRes.base64) {
              await ensureOffscreenDocument();
              const result = await chrome.runtime.sendMessage({
                type: "OFFSCREEN_EXTRACT_PDF",
                payload: { arrayBuffer: fetchRes.base64, url: targetUrl }
              });
              sendResponse(result);
              return;
            } else {
              throw new Error(fetchRes?.error || "In-tab fetch failed");
            }
          } catch (e) {
            console.error("[Background] Blob fetch failed:", e);
            sendResponse({ success: false, error: "Could not read blob PDF. Refresh the page and try again." });
            return;
          }
        }

        // 2. Google Drive
        if (isDrivePage) {
          // Try Drive File ID → direct download
          let foundFileId = null;
          try {
            const idResults = await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: findDriveFileId
            });
            for (const r of (idResults || [])) {
              if (r.result && typeof r.result === "string" && r.result.length >= 20) {
                foundFileId = r.result;
                break;
              }
            }
          } catch (e) {
            console.debug("[Background] Drive File ID lookup failed:", e);
          }

          if (foundFileId) {
            const driveDownloadUrl = `https://drive.google.com/uc?export=download&id=${foundFileId}`;
            try {
              // First try fetching inside the tab to inherit user session cookies automatically
              const fetchResults = await chrome.scripting.executeScript({
                target: { tabId },
                func: fetchPdfInTab,
                args: [driveDownloadUrl]
              });
              let b64 = fetchResults[0]?.result?.success ? fetchResults[0].result.base64 : null;

              // Fallback to background fetch if in-tab failed
              if (!b64) {
                b64 = await fetchPdfAsBase64(driveDownloadUrl);
              }

              if (b64) {
                // If it's HTML (Google virus scan warning), PDF.js will fail gracefully, and we fallback to DOM scrape
                await ensureOffscreenDocument();
                const result = await chrome.runtime.sendMessage({
                  type: "OFFSCREEN_EXTRACT_PDF",
                  payload: { arrayBuffer: b64, url: driveDownloadUrl }
                });
                if (result?.success && result.pageCount > 0) { sendResponse(result); return; }
              }
            } catch (e) {
              console.debug("[Background] Drive binary fetch failed, falling back to DOM scrape:", e);
            }
          }

          // Fallback: DOM scrape
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: scrapeDriveDomText
          });
          let best = null;
          for (const r of (results || [])) {
            if (r.result?.success && r.result.fullText) {
              if (!best || r.result.fullText.length > best.fullText.length) best = r.result;
            }
          }
          if (!best) throw new Error("Could not extract text from Google Drive. Ensure the PDF preview is open.");
          sendResponse(best);
          return;
        }

        // 3. Standard web / local PDF
        await ensureOffscreenDocument();

        if (targetUrl.startsWith("file://")) {
          // Local file: offscreen must fetch directly (needs "Allow access to file URLs")
          const result = await chrome.runtime.sendMessage({
            type: "OFFSCREEN_EXTRACT_PDF",
            payload: { url: targetUrl }
          });
          sendResponse(result);
        } else {
          // Web PDF: fetch here in background (CORS bypass via host_permissions) → base64 to offscreen
          const b64 = await fetchPdfAsBase64(targetUrl);
          const result = await chrome.runtime.sendMessage({
            type: "OFFSCREEN_EXTRACT_PDF",
            payload: { arrayBuffer: b64, url: targetUrl }
          });
          sendResponse(result);
        }
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
