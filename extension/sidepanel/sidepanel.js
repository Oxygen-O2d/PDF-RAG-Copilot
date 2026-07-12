/**
 * sidepanel.js — Complete Phase 4 Production Controller (Updated with Robust PDF Detection)
 * Orchestrates:
 * 1. Client-Side PDF.js Text Extraction via background Service Worker & Offscreen Document.
 * 2. POST /ingest to local Python FastAPI + ChromaDB server (http://127.0.0.1:8000).
 * 3. Conversational RAG queries via POST /chat with interactive source citations & accordions.
 * 4. Robust Offline / File-Scheme Permission error handling.
 */

const BACKEND_URL = "http://127.0.0.1:8000";

// DOM Elements
const apiStatusBadge = document.getElementById("apiStatusBadge");
const apiStatusText = document.getElementById("apiStatusText");
const backendOfflineAlert = document.getElementById("backendOfflineAlert");
const pdfBadge = document.getElementById("pdfBadge");
const docTitle = document.getElementById("docTitle");
const extractIngestBtn = document.getElementById("extractIngestBtn");
const refreshTabBtn = document.getElementById("refreshTabBtn");
const filePermissionAlert = document.getElementById("filePermissionAlert");
const openExtensionSettings = document.getElementById("openExtensionSettings");
const progressWrapper = document.getElementById("progressWrapper");
const progressBarFill = document.getElementById("progressBarFill");
const progressText = document.getElementById("progressText");
const chatMessages = document.getElementById("chatMessages");
const typingIndicator = document.getElementById("typingIndicator");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

let currentTabInfo = null;
let currentDocId = null;
let isBackendOnline = false;

// Initialize Side Panel
document.addEventListener("DOMContentLoaded", async () => {
  await checkBackendStatus();
  await refreshActiveTabInfo();
  setupEventListeners();
});

/**
 * 1. Robust PDF Detection Fix (client helper)
 */
function isPDF(tab) {
  if (!tab || !tab.url) return false;
  const urlRegex = /\.pdf($|\?|#)/i;
  const isPdfUrl = urlRegex.test(tab.url) || tab.url.startsWith("chrome-extension://");
  const isPdfTitle = tab.title && tab.title.toLowerCase().includes(".pdf");
  const isDrivePage = tab.url.includes("drive.google.com");

  return Boolean(isPdfUrl || isPdfTitle || isDrivePage || tab.isPdf);
}

/**
 * Health Check against http://127.0.0.1:8000/health
 */
async function checkBackendStatus() {
  try {
    const response = await fetch(`${BACKEND_URL}/health`, { method: "GET" });
    if (response.ok) {
      isBackendOnline = true;
      setApiStatus(true, "RAG Online");
      backendOfflineAlert.classList.add("hidden");
    } else {
      throw new Error(`Server returned status ${response.status}`);
    }
  } catch (error) {
    isBackendOnline = false;
    setApiStatus(false, "Backend Offline");
    backendOfflineAlert.classList.remove("hidden");
  }
}

function setApiStatus(online, text) {
  apiStatusBadge.className = `status-badge ${online ? "online" : "offline"}`;
  apiStatusText.textContent = text;
}

/**
 * Query current active tab info from Service Worker
 */
async function refreshActiveTabInfo() {
  chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB_INFO" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      updateDocumentUI({ title: "No active document", isPdf: false });
      return;
    }
    updateDocumentUI(response.payload);
  });
}

/**
 * Listen for broadcasts from background service worker when tab switches
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TAB_UPDATED" && message.payload) {
    updateDocumentUI(message.payload);
  }
});

/**
 * Update UI cards based on active document type
 */
function updateDocumentUI(tabInfo) {
  currentTabInfo = tabInfo;
  docTitle.textContent = tabInfo.title || tabInfo.url || "Unknown Document";

  // Check file:// permissions warning
  if (tabInfo.isFileUrl && !tabInfo.allowedFileAccess) {
    filePermissionAlert.classList.remove("hidden");
  } else {
    filePermissionAlert.classList.add("hidden");
  }

  const pdfDetected = isPDF(tabInfo);

  if (pdfDetected) {
    pdfBadge.className = "badge badge-pdf";
    pdfBadge.textContent = "PDF / DRIVE DETECTED";
    extractIngestBtn.disabled = false;
  } else {
    pdfBadge.className = "badge badge-neutral";
    pdfBadge.textContent = "READY TO SCAN";
    extractIngestBtn.disabled = false;
  }
}

function setupEventListeners() {
  refreshTabBtn.addEventListener("click", async () => {
    await checkBackendStatus();
    await refreshActiveTabInfo();
  });

  openExtensionSettings?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });

  // Extract & Index Button Handler
  extractIngestBtn.addEventListener("click", async () => {
    if (!currentTabInfo) return;
    await handleExtractAndIngest(currentTabInfo);
  });

  // Chat Form Submission
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleChatSubmit();
  });

  // Handle Enter (without Shift) inside Textarea
  chatInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      await handleChatSubmit();
    }
  });

  chatInput.addEventListener("input", autoResizeInput);
}

function autoResizeInput() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 100)}px`;
}

/**
 * Generate clean, deterministic document identifier from URL/Filename
 */
function generateDocId(url) {
  if (!url) return "doc_default";
  const cleaned = url.split("?")[0].split("#")[0];
  const filename = cleaned.split("/").pop() || "document";
  return filename.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

/**
 * INGESTION WORKFLOW
 */
async function handleExtractAndIngest(tabInfo) {
  extractIngestBtn.disabled = true;
  progressWrapper.classList.remove("hidden");
  progressBarFill.style.width = "25%";
  progressText.textContent = "Extracting text from PDF tab via Offscreen Document...";

  try {
    const extractionResult = await extractPdfTextFromTab(tabInfo);

    if (!extractionResult.success) {
      throw new Error(extractionResult.error || "Failed to extract text from PDF");
    }

    progressBarFill.style.width = "65%";
    progressText.textContent = "Ingesting PDF into local vector database...";

    currentDocId = generateDocId(tabInfo.url);

    const ingestResponse = await fetch(`${BACKEND_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw_text: extractionResult.fullText,
        pages: extractionResult.pages,
        doc_id: currentDocId,
        title: tabInfo.title || "Untitled PDF"
      })
    });

    if (!ingestResponse.ok) {
      throw new Error(`Server returned HTTP ${ingestResponse.status}`);
    }

    const ingestData = await ingestResponse.json();

    progressBarFill.style.width = "100%";
    progressText.textContent = `Success! Vectorized ${ingestData.chunk_count} chunks into Chroma DB.`;

    pdfBadge.className = "badge badge-ready";
    pdfBadge.textContent = "READY TO CHAT";
    extractIngestBtn.textContent = "Re-Index Document";

    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();

    appendAssistantMessage(
      `🎉 **Ready to Chat!** Successfully indexed **${tabInfo.title}** (${extractionResult.pageCount} pages, ${ingestData.chunk_count} chunks stored in local Chroma DB).\n\nAsk any question below!`
    );
  } catch (error) {
    console.error("[Ingest Error]", error);
    progressBarFill.style.width = "100%";
    progressBarFill.style.background = "var(--danger-color)";
    progressText.textContent = "Ingestion failed.";

    if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
      backendOfflineAlert.classList.remove("hidden");
      appendAssistantMessage(
        `⚠️ **Cannot connect to RAG server.**\n\nPlease run \`uvicorn main:app --reload\` within your virtual environment on \`${BACKEND_URL}\`.`
      );
    } else {
      appendAssistantMessage(`⚠️ **Ingestion Error:** ${error.message}`);
    }
  } finally {
    setTimeout(() => {
      progressWrapper.classList.add("hidden");
      progressBarFill.style.background = "";
      extractIngestBtn.disabled = false;
    }, 4500);
  }
}

/**
 * Relay PDF text extraction request to background worker
 */
function extractPdfTextFromTab(tabInfo) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "EXTRACT_PDF_TEXT", payload: { tabId: tabInfo.tabId, url: tabInfo.url } },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: "No response received from extraction script" });
        }
      }
    );
  });
}

/**
 * CHAT TRIGGER
 */
async function handleChatSubmit() {
  const query = chatInput.value.trim();
  if (!query) return;

  appendUserMessage(query);
  chatInput.value = "";
  autoResizeInput();

  typingIndicator.classList.remove("hidden");
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const response = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query,
        doc_id: currentDocId || generateDocId(currentTabInfo?.url),
        top_k: 4
      })
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    const data = await response.json();
    appendAssistantMessage(data.answer || "No answer returned.", data.sources || []);
  } catch (error) {
    if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
      backendOfflineAlert.classList.remove("hidden");
      appendAssistantMessage(
        `⚠️ **Cannot connect to RAG server.**\n\nPlease run \`uvicorn main:app --reload\` within your virtual environment.`
      );
    } else {
      appendAssistantMessage(`⚠️ **Query Error:** ${error.message}`);
    }
  } finally {
    typingIndicator.classList.add("hidden");
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function appendUserMessage(text) {
  removeWelcomeBanner();
  const msgDiv = document.createElement("div");
  msgDiv.className = "msg user";
  msgDiv.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendAssistantMessage(markdownText, sources = []) {
  removeWelcomeBanner();
  const msgDiv = document.createElement("div");
  msgDiv.className = "msg assistant";

  const formattedHtml = parseMarkdown(markdownText);
  let fullHtml = `<div class="msg-bubble">${formattedHtml}`;

  if (sources && sources.length > 0) {
    fullHtml += `
      <div class="sources-container">
        <div class="sources-header">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          Sources (${sources.length} retrieved chunks)
        </div>
        <div class="source-chips-row">
    `;

    sources.forEach((src, idx) => {
      const pageLabel = src.page ? `Page ${src.page}` : `Chunk ${idx + 1}`;
      fullHtml += `
        <button type="button" class="source-badge" data-source-index="${idx}">
          🔖 ${pageLabel}
        </button>
      `;
    });

    fullHtml += `
        </div>
        <div class="source-accordion hidden"></div>
      </div>
    `;
  }

  fullHtml += `</div>`;
  msgDiv.innerHTML = fullHtml;
  chatMessages.appendChild(msgDiv);

  if (sources && sources.length > 0) {
    const badges = msgDiv.querySelectorAll(".source-badge");
    const accordion = msgDiv.querySelector(".source-accordion");

    badges.forEach((badge) => {
      badge.addEventListener("click", () => {
        const idx = parseInt(badge.getAttribute("data-source-index"), 10);
        const src = sources[idx];
        if (!src) return;

        const snippetText = src.snippet || "No preview snippet available.";
        const pageLabel = src.page ? `Page ${src.page}` : `Chunk ${idx + 1}`;

        if (!accordion.classList.contains("hidden") && accordion.getAttribute("data-current-idx") === String(idx)) {
          accordion.classList.add("hidden");
          return;
        }

        accordion.setAttribute("data-current-idx", String(idx));
        accordion.innerHTML = `<strong>Source Context (${pageLabel}):</strong>\n"${snippetText}"`;
        accordion.classList.remove("hidden");
      });
    });
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeWelcomeBanner() {
  const welcome = chatMessages.querySelector(".welcome-banner");
  if (welcome) welcome.remove();
}

function escapeHtml(str) {
  const p = document.createElement("p");
  p.textContent = str;
  return p.innerHTML.replace(/\n/g, "<br/>");
}

/**
 * Lightweight browser-native Markdown parser for Manifest V3 Side Panel
 */
function parseMarkdown(text) {
  if (!text) return "";
  return text
    // Escape basic HTML to prevent XSS
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    // Fenced Code Blocks (```code```)
    .replace(/```([\s\S]*?)```/g, '<pre style="background:rgba(0,0,0,0.35);padding:10px;border-radius:6px;overflow-x:auto;font-size:11px;"><code>$1</code></pre>')
    // Headers (###)
    .replace(/^### (.*$)/gim, '<h3 style="margin:8px 0 4px;font-size:13px;color:#fff;">$1</h3>')
    // Bold (**)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Inline Code (`code`)
    .replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.12);padding:2px 5px;border-radius:4px;font-family:monospace;font-size:12px;">$1</code>')
    // Bullet Points (* or -)
    .replace(/^\s*[\*\-]\s+(.*$)/gim, '<li style="margin-left:16px;margin-bottom:4px;">$1</li>')
    // Wrap lists correctly
    .replace(/(<li.*<\/li>)/sim, '<ul style="padding-left:4px;margin:6px 0;">$1</ul>')
    // Paragraphs & Line Breaks
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}
