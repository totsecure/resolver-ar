#!/usr/bin/env node
/* externalizar-inline.mjs — mueve el <script> inline de cada HTML del panel a un
 * archivo .js hermano y lo referencia con <script src> (defer). Necesario porque
 * el CSP del server usa script-src 'self' (sin unsafe-inline).
 *
 * USO: node scripts/externalizar-inline.mjs <html> [<html> ...]
 */
import fs from 'node:fs';
import path from 'node:path';

for (const rel of process.argv.slice(2)) {
  const html = path.resolve(rel);
  const src = fs.readFileSync(html, 'utf8');
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) { console.log('SIN SCRIPT inline: ' + rel); continue; }
  const js = path.join(path.dirname(html), path.basename(html, '.html') + '.js');
  fs.writeFileSync(js, '/* Extraído de ' + path.basename(html) + ' (CSP script-src \'self\'). */\n' + m[1].trim() + '\n');
  const out = src.replace(/<script>[\s\S]*?<\/script>/, '<script src="/panel/' + path.basename(js) + '" defer></script>');
  fs.writeFileSync(html, out);
  console.log('OK ' + path.basename(html) + ' -> ' + path.basename(js) + ' (' + js.length + ' bytes)');
}
