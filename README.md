# Watermark Social

```text
web/
├── frontend/                 # React + Vite social-network interface
├── backend/                  # Local HTTP API connected to the research pipeline
│   ├── watermark_api.py
│   └── runtime/              # Generated images, .npz keys, API logs (not source)
└── README.md

Code/
├── models/                   # Core SIFT/JPEG-grid watermark implementation
└── scripts/                  # Research, benchmark, and platform experiment scripts
```

## Run locally

Terminal 1 — API and research pipeline:

```powershell
C:\Users\PC\AppData\Local\Programs\Python\Python312\python.exe web\backend\watermark_api.py
```

Terminal 2 — frontend:

```powershell
cd web\frontend
npm run dev
```

Open the Vite address shown in Terminal 2 (normally `http://localhost:5173`).
The backend stores accounts, persistent sessions, the shared newsfeed,
generated watermarked images, and `.npz` synchronization keys under
`web/backend/runtime/`. The browser only keeps the current login token.
