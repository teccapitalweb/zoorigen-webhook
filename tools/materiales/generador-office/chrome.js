'use strict';

// Chrome sin ventana: capturas (portadas y vistas previas) y PDF. Solo para generar materiales; el servidor no lo usa.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function conArchivoHtml(html, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-chrome-'));
  const archivo = path.join(dir, 'doc.html');
  fs.writeFileSync(archivo, html);
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-perfil-'));
  try { return fn('file:///' + archivo.replace(/\\/g, '/'), perfil); } finally {
    for (const d of [dir, perfil]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch (e) { /* se limpia solo después */ } }
  }
}

function capturar(html, destino, ancho, alto, { transparente = false } = {}) {
  destino = path.resolve(destino);
  conArchivoHtml(html, (url, perfil) => {
    const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars', '--user-data-dir=' + perfil, `--window-size=${ancho},${alto}`, '--force-device-scale-factor=1', '--virtual-time-budget=3000', '--screenshot=' + destino];
    if (transparente) args.push('--default-background-color=00000000');
    const r = spawnSync(CHROME, [...args, url], { timeout: 90000, stdio: 'ignore' });
    if (!fs.existsSync(destino)) throw new Error('Chrome no generó ' + destino + ' (código ' + r.status + ')');
  });
  return destino;
}

function aPDF(html, destino) {
  destino = path.resolve(destino);
  conArchivoHtml(html, (url, perfil) => {
    const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-pdf-header-footer', '--user-data-dir=' + perfil, '--virtual-time-budget=4000', '--print-to-pdf=' + destino, url], { timeout: 120000, stdio: 'ignore' });
    if (!fs.existsSync(destino)) throw new Error('Chrome no generó ' + destino + ' (código ' + r.status + ')');
  });
  const pdf = fs.readFileSync(destino, 'latin1');
  return (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

module.exports = { CHROME, capturar, aPDF };
