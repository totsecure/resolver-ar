import zipfile, shutil, re, sys

# Congela filas/columnas de una hoja dentro de un .xlsx ya escrito.
# uso: congelar.py archivo.xlsx NombreHoja colSplit filaSplit
ruta, hoja, col, fila = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
tmp = ruta + '.tmp'

zin = zipfile.ZipFile(ruta)
wbxml = zin.read('xl/workbook.xml').decode('utf-8')
rels = zin.read('xl/_rels/workbook.xml.rels').decode('utf-8')

m = re.search(r'<sheet[^>]*name="' + re.escape(hoja) + r'"[^>]*r:id="(rId\d+)"', wbxml)
if not m:
    sys.exit('hoja no encontrada: ' + hoja)
rid = m.group(1)
d = re.search(r'Id="' + rid + r'"[^>]*Target="([^"]+)"', rels)
if not d:
    sys.exit('target no encontrado para ' + rid)
destino = d.group(1)
if not destino.startswith('xl/'):
    destino = 'xl/' + destino.lstrip('/')

pane = '<pane xSplit="{c}" ySplit="{f}" topLeftCell="{cell}{f1}" activePane="bottomRight" state="frozen"/>'.format(
    c=col, f=fila, cell=chr(64 + col + 1), f1=fila + 1)

zout = zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED)
tocado = False
for item in zin.infolist():
    data = zin.read(item.filename)
    if item.filename == destino:
        s = data.decode('utf-8')
        if '<pane ' not in s:
            # ojo 1: '<sheetViews>' tambien arranca con '<sheetView', hay que
            # enganchar el tag que abre la vista (singular) y no el contenedor
            # ojo 2: el tag suele venir autocerrado (<sheetView .../>), hay que
            # abrirlo y meterle el <pane> adentro, no despues
            m2 = re.search(r'<sheetView(?![s])[^>]*?/?>', s)
            if m2:
                tag = m2.group(0)
                if tag.endswith('/>'):
                    tag = tag[:-2] + '>'
                    reemplazo = tag + pane + '</sheetView>'
                else:
                    reemplazo = tag + pane
                s = s[:m2.start()] + reemplazo + s[m2.end():]
            else:
                s = s.replace('<sheetViews>', '<sheetViews><sheetView workbookViewId="0">' + pane + '</sheetView>', 1)
            tocado = True
        data = s.encode('utf-8')
    zout.writestr(item, data)
zout.close()
zin.close()
shutil.move(tmp, ruta)
print('congelado ' + hoja + ' en ' + destino + ': ' + pane if tocado else 'ya estaba congelado')
