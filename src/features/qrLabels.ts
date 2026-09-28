import { Platform } from 'react-native';
import QRCode from 'qrcode';
import * as Print from 'expo-print';
import { labelUrl, type LabelKind } from './qrPayload';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export async function printLabel(kind: LabelKind, id: string, name: string, location: string): Promise<void> {
  // Open synchronously before the QR promise, so web popup blockers allow it.
  const page = Platform.OS === 'web' ? window.open('', '_blank') : null;
  if (Platform.OS === 'web' && !page) throw new Error('Permite abrir la ventana de impresión.');
  try {
    const url = labelUrl(kind, id);
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 320 });
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiqueta ${escapeHtml(name)}</title>
<style>@page{size:A4;margin:15mm}body{font:16px system-ui,sans-serif;color:#111}.label{border:1px solid #aaa;border-radius:12px;padding:20px;width:90mm;min-height:52mm;display:flex;align-items:center;gap:16px;break-inside:avoid}svg{width:38mm;height:38mm;flex:none}.name{font-size:20px;font-weight:700;overflow-wrap:anywhere}.location{margin-top:8px;color:#444;overflow-wrap:anywhere}.hint{font-size:11px;color:#666;margin-top:9px}</style></head><body>
<div class="label">${svg}<div><div class="name">${escapeHtml(name)}</div><div class="location">${escapeHtml(location)}</div><div class="hint">Escanea con HomeHoard</div></div></div></body></html>`;
    if (page) {
      page.onload = () => page.print();
      page.document.open();
      page.document.write(html);
      page.document.close();
    } else {
      await Print.printAsync({ html });
    }
  } catch (error) {
    page?.close();
    throw error;
  }
}
