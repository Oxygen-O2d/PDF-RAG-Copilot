/**
 * sidepanel.js — PDF RAG Copilot v2.1 (Backend-Free · 4 LLM Providers)
 *
 * Supported providers: Google Gemini, OpenAI, Anthropic, Groq
 */

// ─── Provider config ─────────────────────────────────────────────────────────

const PROVIDERS = {
  gemini: {
    label: "Google",
    keyLabel: "Google API Key",
    keyHint: "Get free key →",
    keyLink: "https://aistudio.google.com/app/apikey",
    keyLinkText: "aistudio.google.com",
    placeholder: "AIza...",
    models: [
      { value: "gemini-2.0-flash",   label: "gemini-2.0-flash ✨ Latest" },
      { value: "gemini-1.5-flash",   label: "gemini-1.5-flash ⚡ Fast" },
      { value: "gemini-1.5-pro",     label: "gemini-1.5-pro 🧠 Smart" },
    ],
    default: "gemini-2.0-flash"
  },
  openai: {
    label: "OpenAI",
    keyLabel: "OpenAI API Key",
    keyHint: "Get key →",
    keyLink: "https://platform.openai.com/api-keys",
    keyLinkText: "platform.openai.com",
    placeholder: "sk-...",
    models: [
      { value: "gpt-4o-mini",     label: "gpt-4o-mini ⚡ Fast & Cheap" },
      { value: "gpt-4o",          label: "gpt-4o 🧠 Most Capable" },
      { value: "gpt-3.5-turbo",   label: "gpt-3.5-turbo 💰 Budget" },
    ],
    default: "gpt-4o-mini"
  },
  anthropic: {
    label: "Anthropic",
    keyLabel: "Anthropic API Key",
    keyHint: "Get key →",
    keyLink: "https://console.anthropic.com/settings/keys",
    keyLinkText: "console.anthropic.com",
    placeholder: "sk-ant-...",
    models: [
      { value: "claude-3-5-haiku-20241022",  label: "claude-3.5-haiku ⚡ Fast" },
      { value: "claude-3-5-sonnet-20241022", label: "claude-3.5-sonnet 🧠 Smart" },
      { value: "claude-3-opus-20240229",     label: "claude-3-opus 💎 Best" },
    ],
    default: "claude-3-5-haiku-20241022"
  },
  groq: {
    label: "Groq",
    keyLabel: "Groq API Key",
    keyHint: "Get free key →",
    keyLink: "https://console.groq.com/keys",
    keyLinkText: "console.groq.com",
    placeholder: "gsk_...",
    models: [
      // Best for RAG: strong reasoning + Groq's ultra-fast LPU inference
      { value: "llama-3.3-70b-versatile",     label: "llama-3.3-70b-versatile 🏆 Best for RAG" },
      { value: "llama-3.1-8b-instant",        label: "llama-3.1-8b-instant ⚡ Fastest" },
      { value: "llama3-70b-8192",             label: "llama3-70b-8192 🧠 Capable" },
      { value: "mixtral-8x7b-32768",          label: "mixtral-8x7b-32768 📚 Long Context" },
      { value: "gemma2-9b-it",               label: "gemma2-9b-it 🌿 Google" },
    ],
    default: "llama-3.3-70b-versatile"
  }
};

// ─── DOM references ───────────────────────────────────────────────────────────

const apiStatusBadge       = document.getElementById("apiStatusBadge");
const apiStatusText        = document.getElementById("apiStatusText");
const pdfBadge             = document.getElementById("pdfBadge");
const docTitle             = document.getElementById("docTitle");
const extractIngestBtn     = document.getElementById("extractIngestBtn");
const refreshTabBtn        = document.getElementById("refreshTabBtn");
const filePermissionAlert  = document.getElementById("filePermissionAlert");
const openExtensionSettings = document.getElementById("openExtensionSettings");
const progressWrapper      = document.getElementById("progressWrapper");
const progressBarFill      = document.getElementById("progressBarFill");
const progressText         = document.getElementById("progressText");
const chatMessages         = document.getElementById("chatMessages");
const typingIndicator      = document.getElementById("typingIndicator");
const chatForm             = document.getElementById("chatForm");
const chatInput            = document.getElementById("chatInput");
const sendBtn              = document.getElementById("sendBtn");

// Settings
const settingsToggleBtn    = document.getElementById("settingsToggleBtn");
const settingsPanel        = document.getElementById("settingsPanel");
const providerPills        = document.getElementById("providerPills");
const providerSelect       = document.getElementById("providerSelect"); // hidden input
const apiKeyInput          = document.getElementById("apiKeyInput");
const apiKeyLabel          = document.getElementById("apiKeyLabel");
const apiKeyHint           = document.getElementById("apiKeyHint");
const apiKeyLink           = document.getElementById("apiKeyLink");
const modelSelect          = document.getElementById("modelSelect");
const saveSettingsBtn      = document.getElementById("saveSettingsBtn");
const toggleKeyVisibility  = document.getElementById("toggleKeyVisibility");

// ─── State ────────────────────────────────────────────────────────────────────

let currentTabInfo = null;
let currentDocId   = null;

// Per-provider settings (each has its own key + model stored separately)
let settings = {
  activeProvider: "gemini",
  gemini:    { apiKey: "", model: "gemini-2.0-flash" },
  openai:    { apiKey: "", model: "gpt-4o-mini" },
  anthropic: { apiKey: "", model: "claude-3-5-haiku-20241022" },
  groq:      { apiKey: "", model: "llama-3.3-70b-versatile" }
};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await refreshActiveTabInfo();
  setupEventListeners();
  updateApiStatusBadge();
});

// ─── Settings persistence ─────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.sync.get(["activeProvider", "gemini", "openai", "anthropic", "groq"]);
  if (stored.activeProvider) settings.activeProvider = stored.activeProvider;
  ["gemini", "openai", "anthropic", "groq"].forEach((p) => {
    if (stored[p]) settings[p] = { ...settings[p], ...stored[p] };
  });
  applyProviderToUI(settings.activeProvider);
}

async function saveSettings() {
  const provider = settings.activeProvider;

  // Save the current key + model into the active provider's slot
  settings[provider].apiKey = apiKeyInput.value.trim();
  settings[provider].model  = modelSelect.value;

  await chrome.storage.sync.set({
    activeProvider: settings.activeProvider,
    gemini:    settings.gemini,
    openai:    settings.openai,
    anthropic: settings.anthropic,
    groq:      settings.groq
  });

  updateApiStatusBadge();
  settingsPanel.classList.add("hidden");
  showSaveToast();
}

function showSaveToast() {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = "✓ Settings saved";
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("toast-show"), 10);
  setTimeout(() => {
    toast.classList.remove("toast-show");
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ─── Provider UI logic ────────────────────────────────────────────────────────

function applyProviderToUI(providerKey) {
  const cfg = PROVIDERS[providerKey];
  if (!cfg) return;

  settings.activeProvider = providerKey;
  providerSelect.value = providerKey;

  // Update pill active state
  providerPills.querySelectorAll(".provider-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.provider === providerKey);
  });

  // Update label, hint, placeholder
  apiKeyLabel.textContent  = cfg.keyLabel;
  apiKeyInput.placeholder  = cfg.placeholder;
  apiKeyLink.href          = cfg.keyLink;
  apiKeyLink.textContent   = cfg.keyLinkText;
  apiKeyHint.childNodes[0].textContent = cfg.keyHint + " ";

  // Fill API key from saved settings
  apiKeyInput.value        = settings[providerKey].apiKey || "";
  apiKeyInput.type         = "password";

  // Rebuild model options
  modelSelect.innerHTML = cfg.models
    .map((m) => `<option value="${m.value}">${m.label}</option>`)
    .join("");
  modelSelect.value = settings[providerKey].model || cfg.default;
}

function updateApiStatusBadge() {
  const provider = settings.activeProvider;
  const apiKey   = settings[provider]?.apiKey;

  if (apiKey) {
    const label = PROVIDERS[provider]?.label || provider;
    apiStatusBadge.className = "status-badge online";
    apiStatusText.textContent = `${label} Ready`;
  } else {
    apiStatusBadge.className = "status-badge offline";
    apiStatusText.textContent = "No API Key";
  }
}

// ─── Tab Detection ────────────────────────────────────────────────────────────

function isPDF(tab) {
  if (!tab || !tab.url) return false;
  const urlRegex = /\.pdf($|\?|#)/i;
  return Boolean(
    urlRegex.test(tab.url) ||
    tab.url.startsWith("chrome-extension://") ||
    (tab.title && tab.title.toLowerCase().includes(".pdf")) ||
    tab.url.includes("drive.google.com") ||
    tab.isPdf
  );
}

async function refreshActiveTabInfo() {
  chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB_INFO" }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      updateDocumentUI({ title: "No active document", isPdf: false });
      return;
    }
    updateDocumentUI(response.payload);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TAB_UPDATED" && message.payload) {
    updateDocumentUI(message.payload);
  }
  if (message.type === "INDEXING_PROGRESS") {
    const { current, total } = message.payload;
    const pct = Math.round((current / total) * 40) + 55;
    progressBarFill.style.width = `${pct}%`;
    progressText.textContent = `Embedding chunk ${current} / ${total}...`;
  }
});

function updateDocumentUI(tabInfo) {
  currentTabInfo = tabInfo;
  docTitle.textContent = tabInfo.title || tabInfo.url || "Unknown Document";

  if (tabInfo.isFileUrl && !tabInfo.allowedFileAccess) {
    filePermissionAlert.classList.remove("hidden");
  } else {
    filePermissionAlert.classList.add("hidden");
  }

  if (isPDF(tabInfo)) {
    pdfBadge.className = "badge badge-pdf";
    pdfBadge.textContent = "PDF DETECTED";
  } else {
    pdfBadge.className = "badge badge-neutral";
    pdfBadge.textContent = "READY TO SCAN";
  }
  extractIngestBtn.disabled = false;
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function setupEventListeners() {
  refreshTabBtn.addEventListener("click", refreshActiveTabInfo);

  openExtensionSettings.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });

  settingsToggleBtn.addEventListener("click", () => {
    settingsPanel.classList.toggle("hidden");
    // When opening, make sure UI reflects current provider
    if (!settingsPanel.classList.contains("hidden")) {
      applyProviderToUI(settings.activeProvider);
    }
  });

  // Provider pill buttons
  providerPills.addEventListener("click", (e) => {
    const pill = e.target.closest(".provider-pill");
    if (!pill) return;

    // Save current provider's key/model before switching
    const prev = settings.activeProvider;
    settings[prev].apiKey = apiKeyInput.value.trim();
    settings[prev].model  = modelSelect.value;

    applyProviderToUI(pill.dataset.provider);
  });

  toggleKeyVisibility.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  saveSettingsBtn.addEventListener("click", saveSettings);

  extractIngestBtn.addEventListener("click", async () => {
    if (!currentTabInfo) return;
    const provider = settings.activeProvider;
    if (!settings[provider]?.apiKey) {
      settingsPanel.classList.remove("hidden");
      appendAssistantMessage(
        `⚙️ **API Key Required**\n\nSelect a provider and paste your API key in the settings panel above, then click **Save & Apply**.`
      );
      return;
    }
    await handleExtractAndIndex(currentTabInfo);
  });

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleChatSubmit();
  });

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

// ─── Extract & Index Pipeline ─────────────────────────────────────────────────

function generateDocId(url) {
  if (!url) return "doc_default";
  const cleaned = url.split("?")[0].split("#")[0];
  const filename = cleaned.split("/").pop() || "document";
  return filename.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

async function handleExtractAndIndex(tabInfo) {
  extractIngestBtn.disabled = true;
  progressWrapper.classList.remove("hidden");
  progressBarFill.style.width = "10%";
  progressText.textContent = "Extracting text from PDF...";

  try {
    const extractResult = await bgMessage("EXTRACT_PDF_TEXT", {
      tabId: tabInfo.tabId,
      url: tabInfo.url
    });

    if (!extractResult.success) throw new Error(extractResult.error);

    const ocrNote = extractResult.ocrPageCount > 0
      ? ` (${extractResult.ocrPageCount} page(s) via OCR)`
      : "";

    progressBarFill.style.width = "40%";
    progressText.textContent = `Extracted ${extractResult.pageCount} pages${ocrNote}. Generating embeddings...`;

    currentDocId = generateDocId(tabInfo.url);

    const indexResult = await bgMessage("INDEX_CHUNKS", {
      pages: extractResult.pages,
      doc_id: currentDocId,
      title: tabInfo.title || "Untitled PDF"
    });

    if (!indexResult.success) throw new Error(indexResult.error);

    progressBarFill.style.width = "100%";
    progressText.textContent = `✓ Indexed ${indexResult.chunk_count} chunks locally.`;

    pdfBadge.className = "badge badge-ready";
    pdfBadge.textContent = "READY TO CHAT";
    extractIngestBtn.textContent = "Re-Index Document";

    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();

    const provider = PROVIDERS[settings.activeProvider]?.label || settings.activeProvider;
    appendAssistantMessage(
      `🎉 **Ready to Chat!**\n\n` +
      `Indexed **${tabInfo.title}** successfully:\n` +
      `- 📄 ${extractResult.pageCount} pages extracted${ocrNote}\n` +
      `- 🧩 ${indexResult.chunk_count} chunks embedded locally (Transformers.js)\n` +
      `- 💾 Stored in browser IndexedDB\n` +
      `- 🤖 Answers powered by **${provider} · ${settings[settings.activeProvider].model}**\n\n` +
      `Ask anything below!`
    );

  } catch (error) {
    console.error("[SidePanel] Indexing failed:", error);
    progressBarFill.style.width = "100%";
    progressBarFill.style.background = "var(--danger-color)";
    progressText.textContent = "Failed.";
    appendAssistantMessage(`⚠️ **Indexing Error:** ${error.message}`);
  } finally {
    setTimeout(() => {
      progressWrapper.classList.add("hidden");
      progressBarFill.style.background = "";
      extractIngestBtn.disabled = false;
    }, 4000);
  }
}

// ─── Chat Pipeline ────────────────────────────────────────────────────────────

async function handleChatSubmit() {
  const query = chatInput.value.trim();
  if (!query || !currentDocId) return;

  appendUserMessage(query);
  chatInput.value = "";
  autoResizeInput();
  typingIndicator.classList.remove("hidden");
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const provider = settings.activeProvider;
    const apiKey   = settings[provider]?.apiKey;
    if (!apiKey) throw new Error("No API key configured. Click ⚙️ to add your API key.");

    // Retrieve relevant chunks via cosine search
    const searchResult = await bgMessage("SEARCH_CHUNKS", {
      query,
      doc_id: currentDocId,
      top_k: 4
    });

    if (!searchResult.success) throw new Error(searchResult.error);

    // Call the active provider's LLM with the retrieved context
    const answer = await callLLM(query, searchResult.context);
    appendAssistantMessage(answer, searchResult.sources);

  } catch (error) {
    console.error("[SidePanel] Chat failed:", error);
    appendAssistantMessage(`⚠️ **Query Error:** ${error.message}`);
  } finally {
    typingIndicator.classList.add("hidden");
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

// ─── Background message helper ────────────────────────────────────────────────

function bgMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: "No response" });
      }
    });
  });
}

// ─── LLM Router ──────────────────────────────────────────────────────────────

async function callLLM(query, context) {
  const provider = settings.activeProvider;
  const apiKey   = settings[provider].apiKey;
  const model    = settings[provider].model;
  const prompt   = buildRagPrompt(query, context);

  switch (provider) {
    case "openai":    return callOpenAI(prompt, apiKey, model);
    case "anthropic": return callAnthropic(prompt, apiKey, model);
    case "groq":      return callGroq(prompt, apiKey, model);
    case "gemini":
    default:          return callGemini(prompt, apiKey, model);
  }
}

function buildRagPrompt(query, context) {
  return `You are an expert PDF AI Assistant. Answer the user's question using ONLY the provided document context below.

### Retrieved Document Context:
${context}

### User Question:
${query}

### Instructions:
- Answer directly and confidently.
- Do NOT say "Based on the provided text" or "According to the context". Just answer.
- Use clean Markdown formatting: headers (###), bold (**), bullet points, code blocks.
- If the answer is not in the context, clearly state what information is missing.`;
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
async function callGemini(prompt, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini error (${res.status}): ${err.error?.message || res.statusText}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from Gemini.";
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function callOpenAI(prompt, apiKey, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 1024
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI error (${res.status}): ${err.error?.message || res.statusText}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "No response from OpenAI.";
}

// ── Anthropic Claude ──────────────────────────────────────────────────────────
async function callAnthropic(prompt, apiKey, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for Claude calls from browser context
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Anthropic error (${res.status}): ${err.error?.message || res.statusText}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || "No response from Anthropic.";
}

// ── Groq ──────────────────────────────────────────────────────────────────────
async function callGroq(prompt, apiKey, model) {
  // Groq uses an OpenAI-compatible API endpoint
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 1024
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq error (${res.status}): ${err.error?.message || res.statusText}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "No response from Groq.";
}

// ─── UI Rendering Helpers ─────────────────────────────────────────────────────

function appendUserMessage(text) {
  removeWelcomeBanner();
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendAssistantMessage(markdownText, sources = []) {
  removeWelcomeBanner();
  const div = document.createElement("div");
  div.className = "msg assistant";

  let html = `<div class="msg-bubble">${parseMarkdown(markdownText)}`;

  if (sources?.length > 0) {
    html += `
      <div class="sources-container">
        <div class="sources-header">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          Sources (${sources.length} chunks)
        </div>
        <div class="source-chips-row">
          ${sources.map((src, i) => {
            const label = src.page ? `Page ${src.page}` : `Chunk ${i + 1}`;
            const score = src.score ? ` · ${src.score}` : "";
            return `<button type="button" class="source-badge" data-source-index="${i}">🔖 ${label}${score}</button>`;
          }).join("")}
        </div>
        <div class="source-accordion hidden"></div>
      </div>`;
  }

  html += `</div>`;
  div.innerHTML = html;
  chatMessages.appendChild(div);

  if (sources?.length > 0) {
    const accordion = div.querySelector(".source-accordion");
    div.querySelectorAll(".source-badge").forEach((badge) => {
      badge.addEventListener("click", () => {
        const i = parseInt(badge.dataset.sourceIndex, 10);
        const src = sources[i];
        if (!src) return;
        const label = src.page ? `Page ${src.page}` : `Chunk ${i + 1}`;
        if (!accordion.classList.contains("hidden") && accordion.dataset.currentIdx === String(i)) {
          accordion.classList.add("hidden");
          return;
        }
        accordion.dataset.currentIdx = String(i);
        accordion.innerHTML = `<strong>Context (${label}):</strong>\n"${src.snippet}"`;
        accordion.classList.remove("hidden");
      });
    });
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeWelcomeBanner() {
  chatMessages.querySelector(".welcome-banner")?.remove();
}

function escapeHtml(str) {
  const p = document.createElement("p");
  p.textContent = str;
  return p.innerHTML.replace(/\n/g, "<br/>");
}

function parseMarkdown(text) {
  if (!text) return "";
  // Two-pass list wrapping: convert bullet lines to <li>, then wrap consecutive
  // runs of <li> elements in a single <ul> (avoids the greedy single-match bug).
  const html = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/```([\s\S]*?)```/g, '<pre style="background:rgba(0,0,0,0.35);padding:10px;border-radius:6px;overflow-x:auto;font-size:11px;"><code>$1</code></pre>')
    .replace(/^### (.*$)/gim, '<h3 style="margin:8px 0 4px;font-size:13px;color:#fff;">$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.12);padding:2px 5px;border-radius:4px;font-family:monospace;font-size:12px;">$1</code>')
    .replace(/^\s*[\*\-]\s+(.*$)/gim, '<li style="margin-left:16px;margin-bottom:4px;">$1</li>')
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
  // Wrap each consecutive run of <li> elements in a <ul>
  return html.replace(/(<li[^>]*>.*?<\/li>)(<br>(<li[^>]*>.*?<\/li>))*/g,
    (match) => `<ul style="padding-left:4px;margin:6px 0;">${match.replace(/<br>/g, "")}</ul>`);
}
