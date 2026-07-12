/**
 * offscreen.js — Complete Manifest V3 Offscreen Document Script
 * Runs PDF.js in an isolated background DOM environment to parse binary PDF streams
 * and extract clean page-by-page text without blocking the main extension worker.
 */

// Explicitly define global worker path pointing to the local extension directory
if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "OFFSCREEN_EXTRACT_PDF") {
    handlePdfExtraction(message.payload)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("[Offscreen] PDF extraction failed:", err);
        sendResponse({
          success: false,
          error: err.message || "Unknown PDF extraction error."
        });
      });
    return true; // Keep message channel open for async sendResponse
  }
});

/**
 * Main PDF Extraction Handler
 */
async function handlePdfExtraction({ url, tabId }) {
  if (typeof pdfjsLib === "undefined") {
    throw new Error(
      "PDF.js library not loaded. Please ensure pdf.min.js and pdf.worker.min.js are downloaded inside extension/lib/."
    );
  }

  // Ensure workerSrc is explicitly defined right before running extraction logic
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

  // 1. Resolve target URL
  const targetUrl = url;

  // 2. Fetch binary PDF stream as ArrayBuffer
  let arrayBuffer;
  try {
    const fetchResponse = await fetch(targetUrl, { credentials: "include" });
    if (!fetchResponse.ok) {
      throw new Error(`HTTP ${fetchResponse.status} - ${fetchResponse.statusText}`);
    }
    arrayBuffer = await fetchResponse.arrayBuffer();
  } catch (fetchErr) {
    if (url && url.startsWith("file://")) {
      throw new Error(
        'Cannot read local file:/// URL. Please open extension settings (chrome://extensions) and enable "Allow access to file URLs" for PDF RAG Copilot.'
      );
    }
    throw new Error(`Failed to fetch PDF data from URL (${targetUrl}): ${fetchErr.message}`);
  }

  // 3. Load PDF document via PDF.js
  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    useSystemFonts: true
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;
  const pages = [];
  const textChunks = [];

  // 4. Iterate over every page and extract structured text
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();

    const pageText = textContent.items
      .map((item) => (item.str ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    pages.push({
      page: pageNum,
      text: pageText
    });
    textChunks.push(`[Page ${pageNum}]\n${pageText}`);
  }

  return {
    success: true,
    pageCount: numPages,
    pages: pages,
    fullText: textChunks.join("\n\n"),
    url: url
  };
}
