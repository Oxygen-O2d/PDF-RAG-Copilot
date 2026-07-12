/**
 * background.js — Manifest V3 Service Worker (Updated with Google Drive Preview Support)
 * Handles Side Panel behavior, active tab PDF detection, offscreen document lifecycle,
 * and fallback DOM text extraction for Google Drive previews via content script injection.
 */

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  console.log("[Background] PDF RAG Copilot installed. Side panel behavior configured.");
});

/**
 * 1. Updated Detection Logic
 * Detects .pdf URLs, query parameters/hashes, Chrome native viewers, tab titles,
 * and Google Drive file previews (drive.google.com/file/d/...).
 */
function isPDF(tab) {
  if (!tab || !tab.url) return false;
  const urlRegex = /\.pdf($|\?|#)/i;
  const isPdfUrl = urlRegex.test(tab.url) || tab.url.startsWith("chrome-extension://");
  const isPdfTitle = tab.title && tab.title.toLowerCase().includes(".pdf");
  const isDrivePage = tab.url.includes("drive.google.com");

  return Boolean(isPdfUrl || isPdfTitle || isDrivePage);
}

/**
 * Ensure the Manifest V3 Offscreen Document exists before sending extraction commands
 */
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.DOM_PARSER, chrome.offscreen.Reason.BLOBS],
    justification: "Parse PDF binary streams with PDF.js to extract text for local RAG indexing."
  });
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const matchedClients = await clients.matchAll();
  for (const client of matchedClients) {
    if (client.url === offscreenUrl) {
      return true;
    }
  }
  return false;
}

/**
 * Helper injected into Google Drive tabs to find the active File ID for direct binary download
 */
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

    const links = document.querySelectorAll('a[href*="/file/d/"], a[href*="id="], [data-id], [data-target-id]');
    for (const l of links) {
      const href = l.href || l.getAttribute("data-id") || l.getAttribute("data-target-id") || "";
      m = href.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/) || href.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) || href.match(/^([a-zA-Z0-9_-]{25,})$/);
      if (m && m[1]) return m[1];
    }
  } catch (e) {}
  return null;
}

/**
 * 2. Fallback Content Script Function injected into Google Drive Preview tabs
 * Reads visible text from Drive DOM containers when binary stream cannot be fetched directly.
 */
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
          pages.push({ page: pageNum, text: text });
          textChunks.push(`[Page ${pageNum}]\n${text}`);
        }
      });
    }

    let fullText = textChunks.join("\n\n");
    if (!fullText || fullText.trim().length < 30) {
      const modalDialog =
        document.querySelector('[role="dialog"]') ||
        document.querySelector(".a-b-d-e") ||
        document.querySelector(".drive-viewer-paginated-scrollable");
      if (modalDialog) {
        fullText = (modalDialog.innerText || modalDialog.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (fullText && !fullText.includes("docs-offline-")) {
          pages.length = 0;
          pages.push({ page: 1, text: fullText });
        }
      }
    }

    if (!fullText || fullText.trim().length < 10 || fullText.includes("docs-offline-")) {
      return {
        success: false,
        error:
          "Could not extract visible text from Google Drive preview modal."
      };
    }

    return {
      success: true,
      pageCount: pages.length || 1,
      pages: pages,
      fullText: fullText,
      url: window.location.href
    };
  } catch (err) {
    return {
      success: false,
      error: "Google Drive extraction error: " + err.message
    };
  }
}

/**
 * Inspect tab and notify side panel if open
 */
async function inspectActiveTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return;

    const pdfDetected = isPDF(tab);
    const isFileUrl = tab.url.startsWith("file://");

    const allowedFileAccess = await new Promise((resolve) => {
      chrome.extension.isAllowedFileSchemeAccess(resolve);
    });

    chrome.runtime.sendMessage({
      type: "TAB_UPDATED",
      payload: {
        tabId: tab.id,
        url: tab.url,
        title: tab.title || "Untitled Document",
        isPdf: pdfDetected,
        isFileUrl: isFileUrl,
        allowedFileAccess: allowedFileAccess
      }
    }).catch(() => {});
  } catch (error) {
    console.debug("[Background] Could not inspect tab:", error);
  }
}

chrome.tabs.onActivated.addListener(({ activeTabId }) => {
  inspectActiveTab(activeTabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    inspectActiveTab(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      sendResponse({
        success: true,
        payload: {
          tabId: tab.id,
          url: tab.url,
          title: tab.title || "Untitled Document",
          isPdf: isPDF(tab),
          isFileUrl: tab.url.startsWith("file://"),
          allowedFileAccess: allowedFileAccess
        }
      });
    });
    return true;
  }

  // Handle extraction: Drive Content Script fallback OR Offscreen Document
  if (message.type === "EXTRACT_PDF_TEXT") {
    (async () => {
      try {
        const targetUrl = message.payload?.url || "";
        const isDrivePage = targetUrl.includes("drive.google.com");

        if (isDrivePage) {
          console.log("[Background] Google Drive page detected. Checking for Drive File ID across all frames...");

          // 1. Attempt to locate Google Drive File ID to download true binary PDF
          let foundFileId = null;
          try {
            const idResults = await chrome.scripting.executeScript({
              target: { tabId: message.payload.tabId, allFrames: true },
              func: findDriveFileId
            });
            if (idResults && idResults.length > 0) {
              for (const r of idResults) {
                if (r.result && typeof r.result === "string" && r.result.length >= 20) {
                  foundFileId = r.result;
                  break;
                }
              }
            }
          } catch (idErr) {
            console.debug("[Background] Could not find Drive File ID:", idErr);
          }

          // 2. If Drive File ID found, parse all pages via Offscreen PDF.js!
          if (foundFileId) {
            console.log("[Background] Found Drive File ID:", foundFileId, "Extracting full binary via Offscreen PDF.js...");
            try {
              const driveDownloadUrl = `https://drive.google.com/uc?export=download&id=${foundFileId}`;
              await ensureOffscreenDocument();
              const extractionResult = await chrome.runtime.sendMessage({
                type: "OFFSCREEN_EXTRACT_PDF",
                payload: {
                  url: driveDownloadUrl,
                  tabId: message.payload.tabId
                }
              });

              if (extractionResult && extractionResult.success && extractionResult.pageCount > 0) {
                sendResponse(extractionResult);
                return;
              }
            } catch (binaryErr) {
              console.warn("[Background] Offscreen Drive binary extraction fallback:", binaryErr);
            }
          }

          // 3. Fallback to DOM Scraper if File ID not found or binary download fails
          console.log("[Background] Running DOM extraction script across all frames...");
          const results = await chrome.scripting.executeScript({
            target: { tabId: message.payload.tabId, allFrames: true },
            func: scrapeDriveDomText
          });

          if (!results || results.length === 0) {
            throw new Error("Failed to scrape text from Google Drive preview DOM.");
          }

          let bestResult = null;
          for (const r of results) {
            if (r.result && r.result.success && r.result.fullText) {
              if (!bestResult || r.result.fullText.length > bestResult.fullText.length) {
                bestResult = r.result;
              }
            }
          }

          if (!bestResult) {
            throw new Error("Could not extract visible text from Google Drive preview modal. Ensure the PDF preview is open on your screen.");
          }

          sendResponse(bestResult);
          return;
        }

        await ensureOffscreenDocument();
        const extractionResult = await chrome.runtime.sendMessage({
          type: "OFFSCREEN_EXTRACT_PDF",
          payload: message.payload
        });

        sendResponse(extractionResult);
      } catch (error) {
        console.error("[Background] Extraction relay failed:", error);
        sendResponse({
          success: false,
          error: error.message || "Failed to extract PDF text."
        });
      }
    })();
    return true;
  }
});
