# PDF.js Local Bundling for Manifest V3

Manifest V3 extensions **cannot load remote scripts** from CDNs (e.g., `https://cdnjs.cloudflare.com/...`). All scripts must be bundled directly inside your extension package and declared in `manifest.json`.

## 1. Where to Place PDF.js Files
Place the following two files inside this `lib/` directory:
- `pdf.min.js` (Core PDF.js library)
- `pdf.worker.min.js` (Web Worker for parsing PDF binary streams without freezing UI)

Directory structure:
```
d:\RAGExtension\
  extension\
    lib\
      pdf.min.js
      pdf.worker.min.js
      README.md
```

## 2. How to Download Official PDF.js Prebuilt Files
You can download the official Mozilla PDF.js prebuilt distribution:

### Option A: Automated PowerShell Download (Recommended)
Run the included PowerShell script inside this folder:
```powershell
cd d:\RAGExtension\extension\lib
.\download_pdfjs.ps1
```

### Option B: Manual Download
1. Visit the official PDF.js releases on GitHub or cdnjs:
   - `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js`
   - `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`
2. Save them into `d:\RAGExtension\extension\lib\` as `pdf.min.js` and `pdf.worker.min.js`.

## 3. How Manifest V3 Configures Local PDF.js
In `offscreen/offscreen.html`, we load `lib/pdf.min.js` locally:
```html
<script src="../lib/pdf.min.js"></script>
```
And inside `offscreen/offscreen.js`, we configure the worker source path to our local package:
```javascript
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
```
