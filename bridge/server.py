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
PAGE = """<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HomeHoard · Faustus</title>
<link rel="icon" type="image/png" href="/icon.png"><style>
:root{font-family:system-ui,sans-serif;color:#182a24;background:#f6f3eb}*{box-sizing:border-box}body{margin:0}main{max-width:690px;margin:0 auto;padding:42px 22px 80px}header{display:flex;align-items:center;gap:11px;font-size:19px;font-weight:800}header b{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#1d6450;color:white}.eyebrow{color:#1d6450;font-weight:700;margin:88px 0 12px}h1{font-size:clamp(36px,7vw,58px);letter-spacing:-.045em;line-height:1.03;margin:0 0 20px}p{line-height:1.65;color:#52635a}section{background:#fffefa;border:1px solid #d9d5c9;border-radius:18px;padding:28px;margin:32px 0}h2{font-size:19px;margin:0 0 8px}label{display:block;margin:24px 0 10px;font-weight:700}input{font:inherit;max-width:100%;color:#182a24}button{font:inherit;font-weight:700;background:#1d6450;color:white;border:0;border-radius:11px;padding:13px 20px;cursor:pointer;margin-top:17px}button:hover{background:#16523f}button:focus-visible,input:focus-visible{outline:3px solid #9a8060;outline-offset:3px}.status{font-size:14px;font-weight:650;color:#1d6450}.error{color:#b3342d}.foot{font-size:13px}
</style><main><header><b>⌂</b> HomeHoard</header><div class="eyebrow">Conexión local con Faustus</div><h1>Tu casa, a mano.</h1><p>Carga aquí una copia JSON exportada desde HomeHoard. Faustus podrá decirte en qué habitación, mueble o cajón está un objeto.</p><section><h2>Copia de inventario</h2><p id="status" class="status">Comprobando…</p><label for="file">Archivo exportado desde HomeHoard</label><input id="file" type="file" accept=".json,application/json"><br><button id="upload" type="button">Actualizar copia local</button><p id="message" role="status"></p></section><p class="foot">El archivo se procesa en este ordenador. Las fotos se excluyen de la copia que consulta Faustus. Si cambias objetos en HomeHoard, exporta y carga otra copia para actualizar las respuestas.</p></main>
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
