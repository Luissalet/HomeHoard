"""Local-only import page for the Faustus inventory snapshot."""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from inventory import save, status

PORT = 5196


def local_origin(origin: str) -> bool:
    try:
        parsed = urlparse(origin)
        return (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
                and parsed.port is not None and not parsed.username and not parsed.password
                and not parsed.path and not parsed.query and not parsed.fragment)
    except ValueError:
        return False
PAGE = """<!doctype html><html lang="es" data-hoard-app="homehoard"><meta charset="utf-8"><meta name="theme-color" content="#1c1814"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HomeHoard · Faustus</title>
<link rel="icon" type="image/png" href="/icon.png"><style>:root {color-scheme: dark;--hoard-font-serif: 'Cinzel', 'Iowan Old Style', Charter, Georgia, 'Liberation Serif', 'Noto Serif', 'Times New Roman', serif;--hoard-font-sans: 'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', 'Liberation Sans', Arial, sans-serif;--hoard-font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;--hoard-radius-sm: 6px;--hoard-radius: 8px;--hoard-radius-lg: 10px;--hoard-sidebar-w: 220px;--hoard-header-h: 64px;--hoard-success: #4a9e6d;--hoard-warning: #d4a843;--hoard-danger: #c4463a;--hoard-info: #4a7ec4;--hoard-shadow: 0 8px 28px rgba(0, 0, 0, 0.38);--hoard-focus: 0 0 0 2px var(--hoard-accent);}html[data-hoard-app="homehoard"] {--hoard-deep: #1c1814;--hoard-sunken: #161310;--hoard-surface: #24201b;--hoard-elevated: #2f2a25;--hoard-hover: #38322b;--hoard-border: #433c35;--hoard-border-hover: #6a6158;--hoard-text: #ece7e1;--hoard-text-muted: #beb9b4;--hoard-text-dim: #a6a19b;--hoard-accent: #e5913f;--hoard-accent-strong: #eaa663;--hoard-accent-dim: #ba732d;--hoard-accent-ink: #1b1713;--hoard-accent-rgb: 229, 145, 63;--hoard-accent-soft: rgba(229, 145, 63, 0.14);--hoard-accent-line: rgba(229, 145, 63, 0.38);}html{background:var(--hoard-deep)}*{box-sizing:border-box}body{margin:0;background:var(--hoard-deep);color:var(--hoard-text);font-family:var(--hoard-font-sans);-webkit-font-smoothing:antialiased}::selection{background:var(--hoard-accent-soft);color:var(--hoard-text)}*{scrollbar-width:thin;scrollbar-color:var(--hoard-border) transparent}header{display:flex;align-items:center;gap:12px;height:var(--hoard-header-h);padding:0 32px;background:var(--hoard-surface);border-bottom:1px solid var(--hoard-border);font-family:var(--hoard-font-serif);font-size:20px;font-weight:700;color:var(--hoard-accent)}header b{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:var(--hoard-accent);color:var(--hoard-accent-ink);font-family:var(--hoard-font-sans);font-size:18px}main{padding:0 0 80px}main>:not(header){width:min(690px,100% - 48px);margin-left:auto;margin-right:auto}main>header{margin-bottom:40px}.eyebrow{color:var(--hoard-text-dim);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin-top:24px;margin-bottom:10px}h1{font-family:var(--hoard-font-serif);font-weight:700;font-size:30px;letter-spacing:0;line-height:1.15;margin:0 0 12px;color:var(--hoard-text)}p{line-height:1.6;font-size:14px;color:var(--hoard-text-muted)}section{background:var(--hoard-surface);border:1px solid var(--hoard-border);border-radius:var(--hoard-radius-lg);padding:24px;margin-top:28px;margin-bottom:28px}section:hover{border-color:var(--hoard-border-hover)}h2{font-size:15px;font-weight:600;margin:0 0 8px;color:var(--hoard-text)}label{display:block;margin:20px 0 10px;font-size:14px;font-weight:600;color:var(--hoard-text)}input{font:inherit;max-width:100%;color:var(--hoard-text);background:var(--hoard-sunken);border:1px solid var(--hoard-border);border-radius:var(--hoard-radius);padding:8px 10px}input::file-selector-button{font:inherit;color:var(--hoard-text);background:var(--hoard-elevated);border:1px solid var(--hoard-border);border-radius:var(--hoard-radius-sm);padding:4px 10px;margin-right:10px;cursor:pointer}button{font:inherit;font-weight:600;background:var(--hoard-accent);color:var(--hoard-accent-ink);border:0;border-radius:var(--hoard-radius);height:40px;padding:0 20px;cursor:pointer;margin-top:17px}button:hover{background:var(--hoard-accent-strong)}button:focus-visible,input:focus-visible{outline:2px solid var(--hoard-accent);outline-offset:2px}.status{font-size:14px;font-weight:600;color:var(--hoard-accent)}.error{color:var(--hoard-danger)}.foot{font-size:13px;color:var(--hoard-text-dim)}</style><main><header><b>⌂</b> HomeHoard</header><div class="eyebrow">Conexión local con Faustus</div><h1>Tu casa, a mano.</h1><p>Carga aquí una copia JSON exportada desde HomeHoard. Faustus podrá decirte en qué habitación, mueble o cajón está un objeto.</p><section><h2>Copia de inventario</h2><p id="status" class="status">Comprobando…</p><label for="file">Archivo exportado desde HomeHoard</label><input id="file" type="file" accept=".json,application/json"><br><button id="upload" type="button">Actualizar copia local</button><p id="message" role="status"></p></section><p class="foot">El archivo se procesa en este ordenador. Las fotos se excluyen de la copia que consulta Faustus. Si cambias objetos en HomeHoard, exporta y carga otra copia para actualizar las respuestas.</p></main>
<script>
const statusEl=document.getElementById('status'),message=document.getElementById('message');
async function refresh(){const r=await fetch('/api/status');const s=await r.json();statusEl.textContent=s.ready?`${s.items} objetos · copia del ${s.exported_at?new Date(s.exported_at).toLocaleString('es-ES'):'fecha desconocida'}`:'Aún no hay una copia para Faustus';}
document.getElementById('upload').onclick=async()=>{const file=document.getElementById('file').files[0];if(!file){message.textContent='Elige primero una copia JSON.';message.className='error';return;}try{const data=JSON.parse(await file.text());delete data.photos;if(data.data?.items)data.data.items=data.data.items.map(i=>({...i,photo_uri:null}));const r=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const body=await r.json();if(!r.ok)throw Error(body.error||'No se pudo importar');message.textContent='Copia actualizada. Faustus ya puede buscar tus objetos.';message.className='status';await refresh();}catch(e){message.textContent=e.message;message.className='error';}};refresh();
</script></html>"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if local_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin", "")
        if urlparse(self.path).path != "/api/import" or not local_origin(origin):
            self._json(403, {"error": "Origen no permitido"})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/api/status", "/api/health"):
            self._json(200, {"service": "homehoard-bridge", **status()})
        elif path == "/icon.png":
            body = (Path(__file__).resolve().parent.parent / "app-icon.png").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/":
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json(404, {"error": "No encontrado"})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/import":
            self._json(404, {"error": "No encontrado"})
            return
        origin = self.headers.get("Origin", "")
        if origin and not local_origin(origin):
            self._json(403, {"error": "Origen no permitido"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 20_000_000:
                raise ValueError("El inventario es demasiado grande o está vacío")
            bundle = json.loads(self.rfile.read(length))
            self._json(200, save(bundle))
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(400, {"error": str(exc)})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"HomeHoard para Faustus: http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
