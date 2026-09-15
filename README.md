# Watermark Social local demo

The React interface calls `watermark_api.py`, which invokes the project's
SIFT/JPEG-grid watermark pipeline rather than generating a UI-only key.

## Start it

From the repository root, use a Python 3.10--3.12 environment with the
research dependencies installed:

```powershell
py -3 -m pip install -r Code\requirements.txt
py -3 web\watermark_api.py
```

In another terminal:

```powershell
cd web\web-watermark-new
npm run dev
```

Open the Vite address shown in the terminal, normally `http://localhost:5173`.

Generated watermarked images, originals, and `.npz` keys are kept locally in
`web/runtime/`. The browser also saves the feed and its local copyright vault
in `localStorage`.
