'use strict';

// Los 8 libros de Excel de Zoorigen. Todos con fórmulas reales, listas desplegables, formato condicional, una hoja «Instrucciones»
// y filas de EJEMPLO que se pueden borrar. Nada de dosis, tratamientos ni indicaciones clínicas: solo registros y planeación.
// Cada constructor devuelve un Buffer (.xlsx).

const { COLOR } = require('./comun');
const X = require('./xl');
const { agregarGraficos } = require('./graficos');

const HOY = Date.UTC(2026, 9, 22);
const d = n => new Date(HOY + n * 86400000);
const FMT_FECHA = 'dd/mm/yyyy';

async function aBuffer(wb, graficos) {
  const crudo = await wb.xlsx.writeBuffer();
  return graficos && graficos.length ? agregarGraficos(Buffer.from(crudo), graficos) : Buffer.from(crudo);
}

/* ═════════════ 1. Inventario de botiquín con alerta de caducidad ═════════════ */
async function inventarioBotiquin() {
  const wb = X.libro('Inventario de botiquín con alerta de caducidad', 'Inventario de insumos de botiquín con colores por días restantes para caducar');
  X.instrucciones(wb, {
    titulo: 'Inventario de botiquín con alerta de caducidad',
    para: 'Lleva el inventario de lo que hay en el botiquín de tu unidad (curación, instrumental, material de protección, limpieza y otros) y deja que la hoja te avise qué ya caducó y qué caduca pronto. Es un registro de control interno: no indica qué usar ni cuánto.',
    hojas: [['Inventario', 'Una fila por artículo y lote: escribe su cantidad y su fecha de caducidad.'], ['Resumen', 'Cuenta cuántos artículos hay por estado, la próxima caducidad y el valor de los días de aviso (los puedes cambiar).']],
    pasos: ['Abre la hoja «Resumen» y revisa los dos números de aviso: por defecto 30 días («Caduca pronto») y 90 días («Revisar pronto»). Cámbialos si tu unidad necesita otros plazos.',
      'En la hoja «Inventario» borra las filas de EJEMPLO y escribe tus artículos: código, nombre, categoría, cantidad, unidad, lote y fecha de caducidad.',
      'La columna «Días restantes» y la columna «Estado» se calculan solas. Los colores cambian conforme pasan los días, sin que tengas que hacer nada.',
      'Cada vez que revises el botiquín, actualiza la cantidad. Si un artículo se agota, la hoja lo marca como «Agotado».',
      'Revisa la hoja «Resumen» al empezar la semana: ahí ves de un vistazo cuántos artículos están vencidos o por vencer.'],
    notas: ['Los colores usan la fecha de hoy de tu computadora: al abrir el archivo se actualizan.', 'Para artículos que sujetas a controles especiales (por ejemplo, medicamentos controlados), consulta la normatividad vigente y los formatos oficiales que te correspondan: este libro no los sustituye.']
  });
  const ws = X.hoja(wb, 'Inventario', { congelar: { x: 2, y: 4 } });
  X.banda(ws, 'Inventario de botiquín', 'Zoorigen · Club VIP · Material de apoyo (no es un formato oficial). Las filas con la palabra EJEMPLO se borran antes de empezar.', 13);
  const t = X.tabla(ws, [
    { clave: 'cod', titulo: 'Código', ancho: 11, ayuda: 'Un código corto para encontrar el artículo.' },
    { clave: 'art', titulo: 'Artículo', ancho: 32 },
    { clave: 'cat', titulo: 'Categoría', ancho: 24, lista: ['Curación', 'Instrumental', 'Material de protección', 'Limpieza y desinfección', 'Medicamentos', 'Otro'] },
    { clave: 'pres', titulo: 'Presentación', ancho: 16 },
    { clave: 'cant', titulo: 'Cantidad', ancho: 10, formato: '#,##0.##', numero: { min: 0, max: 1000000 } },
    { clave: 'uni', titulo: 'Unidad', ancho: 11, lista: ['pieza', 'caja', 'frasco', 'par', 'rollo', 'bolsa', 'litro', 'otro'] },
    { clave: 'lote', titulo: 'Lote', ancho: 14 },
    { clave: 'cad', titulo: 'Fecha de caducidad', ancho: 15, formato: FMT_FECHA, fecha: true, ayuda: 'Escribe la fecha que trae el envase, por ejemplo 15/03/2027.' },
    { clave: 'dias', titulo: 'Días restantes', ancho: 11, tipo: 'calc', formato: '0', formula: (r, m) => `IF(${m.cad}${r}="","",${m.cad}${r}-TODAY())` },
    { clave: 'est', titulo: 'Estado', ancho: 19, tipo: 'calc', formula: (r, m) => `IF(AND(${m.cod}${r}="",${m.art}${r}=""),"",IF(AND(${m.cant}${r}<>"",${m.cant}${r}<=0),"Agotado",IF(${m.cad}${r}="","Sin fecha",IF(${m.dias}${r}<0,"Vencido",IF(${m.dias}${r}<=Resumen!$C$5,"Caduca pronto",IF(${m.dias}${r}<=Resumen!$C$6,"Revisar pronto","Vigente"))))))` },
    { clave: 'ubi', titulo: 'Ubicación', ancho: 18 },
    { clave: 'resp', titulo: 'Responsable', ancho: 18 },
    { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], {
    filas: 200, columnaNota: 'nota',
    ejemplos: [
      { cod: 'B-001', art: 'Gasas estériles', cat: 'Curación', pres: 'Paquete', cant: 12, uni: 'paquete', lote: 'L-2026-A', cad: d(420), ubi: 'Botiquín 1', resp: 'Nombre' },
      { cod: 'B-002', art: 'Guantes de exploración', cat: 'Material de protección', pres: 'Caja', cant: 3, uni: 'caja', lote: 'L-2026-B', cad: d(75), ubi: 'Botiquín 1', resp: 'Nombre' },
      { cod: 'B-003', art: 'Solución para limpieza de heridas', cat: 'Limpieza y desinfección', pres: 'Frasco', cant: 2, uni: 'frasco', lote: 'L-2025-C', cad: d(18), ubi: 'Botiquín 2', resp: 'Nombre' },
      { cod: 'B-004', art: 'Venda elástica', cat: 'Curación', pres: 'Rollo', cant: 6, uni: 'rollo', lote: 'L-2024-D', cad: d(-12), ubi: 'Botiquín 2', resp: 'Nombre' },
      { cod: 'B-005', art: 'Pinzas de disección', cat: 'Instrumental', pres: 'Pieza', cant: 4, uni: 'pieza', ubi: 'Estuche A', resp: 'Nombre' },
      { cod: 'B-006', art: 'Cubrebocas', cat: 'Material de protección', pres: 'Caja', cant: 0, uni: 'caja', lote: 'L-2026-F', cad: d(300), ubi: 'Almacén', resp: 'Nombre' }
    ]
  });
  const rango = `A${t.primera}:M${t.ultima}`;
  X.formatoCondicional(ws, rango, `$J${t.primera}="Vencido"`, { relleno: COLOR.rojoClaro, color: COLOR.rojo });
  X.formatoCondicional(ws, rango, `$J${t.primera}="Caduca pronto"`, { relleno: 'FDE3C8', color: '8A3F00' });
  X.formatoCondicional(ws, rango, `$J${t.primera}="Revisar pronto"`, { relleno: COLOR.ambarClaro, color: '7A5200' });
  X.formatoCondicional(ws, `J${t.primera}:J${t.ultima}`, `$J${t.primera}="Vigente"`, { relleno: COLOR.verdeClaro, color: COLOR.verde });
  X.formatoCondicional(ws, rango, `$J${t.primera}="Agotado"`, { relleno: 'E9ECEF', color: COLOR.gris });
  ws.autoFilter = `A${t.fila0}:M${t.ultima}`;

  const rs = X.hoja(wb, 'Resumen', { color: COLOR.dorado });
  X.banda(rs, 'Resumen del botiquín', null, 8);
  rs.columns = [{ width: 30 }, { width: 14 }, { width: 14 }, { width: 4 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  X.etiqueta(rs, 'A4', 'Plazos de aviso (los puedes cambiar)', { size: 12 });
  X.parametro(rs, 'A5', 'C5', '«Caduca pronto» cuando faltan (días) o menos', 30, '0');
  X.parametro(rs, 'A6', 'C6', '«Revisar pronto» cuando faltan (días) o menos', 90, '0');
  rs.getColumn(1).width = 46;
  X.etiqueta(rs, 'A8', 'Artículos por estado', { size: 12 });
  ['Estado', 'Artículos'].forEach((h, i) => { const c = rs.getCell(9, i + 1); c.value = h; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; });
  const estados = ['Vencido', 'Caduca pronto', 'Revisar pronto', 'Vigente', 'Agotado', 'Sin fecha'];
  estados.forEach((e, i) => {
    const r = 10 + i;
    rs.getCell(`A${r}`).value = e; X.estiloCelda(rs.getCell(`A${r}`), 'entrada');
    rs.getCell(`B${r}`).value = { formula: `COUNTIF(Inventario!$J$5:$J$204,A${r})` }; X.estiloCelda(rs.getCell(`B${r}`), 'calc', '0');
  });
  X.etiqueta(rs, 'A17', 'Total de artículos registrados', { color: COLOR.tinta }); rs.getCell('B17').value = { formula: 'SUM(B10:B15)' }; X.estiloCelda(rs.getCell('B17'), 'calc', '0');
  X.etiqueta(rs, 'A18', 'Próxima fecha de caducidad (de lo que aún no vence)', { color: COLOR.tinta });
  rs.getCell('B18').value = { formula: 'IFERROR(SMALL(Inventario!$H$5:$H$204,COUNTIF(Inventario!$H$5:$H$204,"<"&TODAY())+1),"-")' }; X.estiloCelda(rs.getCell('B18'), 'calc', FMT_FECHA);
  X.etiqueta(rs, 'A19', 'Fecha de hoy', { color: COLOR.tinta }); rs.getCell('B19').value = { formula: 'TODAY()' }; X.estiloCelda(rs.getCell('B19'), 'calc', FMT_FECHA);
  X.formatoCondicional(rs, 'B10', 'AND($B$10>0)', { relleno: COLOR.rojoClaro, color: COLOR.rojo });
  X.formatoCondicional(rs, 'B11', 'AND($B$11>0)', { relleno: 'FDE3C8', color: '8A3F00' });
  rs.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  return aBuffer(wb, [{ hoja: 'Resumen', tipo: 'barras', titulo: 'Artículos por estado', tituloY: 'Artículos', series: [{ nombre: 'Artículos', categorias: 'Resumen!$A$10:$A$15', valores: 'Resumen!$B$10:$B$15', color: '1F5F3A' }], ancla: { col: 4, fila: 7, ancho: 5, alto: 14 } }]);
}

/* ═════════════ 2. Libro de entradas y salidas de insumos con saldo automático ═════════════ */
async function libroEntradasSalidas() {
  const wb = X.libro('Libro de entradas y salidas de insumos', 'Registro interno de entradas y salidas de insumos con saldo automático');
  X.instrucciones(wb, {
    titulo: 'Libro de entradas y salidas de insumos',
    para: 'Registra cada entrada y cada salida de tus insumos (material de curación, limpieza, alimentos de prueba, medicamentos y lo que necesites controlar) y el libro calcula solo el saldo de cada producto. Es un formato de registro interno: NO es un formato oficial ni indica qué usar o en qué cantidad.',
    hojas: [['Productos', 'Tu catálogo: un código por producto, su unidad y el mínimo que quieres tener. Aquí ves entradas, salidas y saldo de cada uno.'], ['Movimientos', 'El libro: una fila por cada entrada o salida. El saldo después de cada movimiento se calcula solo.']],
    pasos: ['En «Productos» borra los EJEMPLOS y da de alta tus productos con un código único (por ejemplo P-001), su nombre, la unidad y el stock mínimo.',
      'En «Movimientos» escribe la fecha, elige el código de la lista, elige si es Entrada o Salida y escribe la cantidad. El nombre del producto aparece solo.',
      'Escribe el lote, la fecha de caducidad (si aplica), quién hizo el movimiento y el motivo o destino. Escríbelos en el mismo orden en que ocurrieron.',
      'La columna «Saldo después» muestra cuánto queda de ese producto tras el movimiento. Si sale en rojo, hay un saldo negativo: revisa si faltó registrar una entrada.',
      'En «Productos» la columna «Estado» te avisa cuando un producto está en su mínimo o por debajo.'],
    notas: ['Este libro no sustituye los formatos, libros de control o recetarios que la normatividad pida para ciertos productos (por ejemplo medicamentos controlados). Consulta la norma vigente y a tu médico veterinario responsable.', 'No registres dosis ni indicaciones de uso: solo cantidades de entrada y salida.']
  });
  const wp = X.hoja(wb, 'Productos', { congelar: { y: 4 } });
  X.banda(wp, 'Catálogo de productos y saldos', 'Zoorigen · Material de apoyo (formato de registro interno, no oficial)', 9);
  const prod = X.tabla(wp, [
    { clave: 'cod', titulo: 'Código', ancho: 12 }, { clave: 'nom', titulo: 'Producto', ancho: 34 },
    { clave: 'uni', titulo: 'Unidad', ancho: 12, lista: ['pieza', 'caja', 'frasco', 'bolsa', 'kg', 'litro', 'otro'] },
    { clave: 'min', titulo: 'Stock mínimo', ancho: 12, numero: { min: 0, max: 1000000 } },
    { clave: 'ent', titulo: 'Entradas', ancho: 12, tipo: 'calc', formato: '#,##0.##', formula: (r, m) => `IF(${m.cod}${r}="","",SUMIFS(Movimientos!$E$5:$E$504,Movimientos!$B$5:$B$504,${m.cod}${r},Movimientos!$D$5:$D$504,"Entrada"))` },
    { clave: 'sal', titulo: 'Salidas', ancho: 12, tipo: 'calc', formato: '#,##0.##', formula: (r, m) => `IF(${m.cod}${r}="","",SUMIFS(Movimientos!$E$5:$E$504,Movimientos!$B$5:$B$504,${m.cod}${r},Movimientos!$D$5:$D$504,"Salida"))` },
    { clave: 'sld', titulo: 'Saldo', ancho: 12, tipo: 'calc', formato: '#,##0.##', formula: (r, m) => `IF(${m.cod}${r}="","",${m.ent}${r}-${m.sal}${r})` },
    { clave: 'est', titulo: 'Estado', ancho: 22, tipo: 'calc', formula: (r, m) => `IF(${m.cod}${r}="","",IF(${m.sld}${r}<0,"Saldo negativo: revisa",IF(AND(${m.min}${r}<>"",${m.sld}${r}<=${m.min}${r}),"En el mínimo o por debajo","Suficiente")))` },
    { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 100, columnaNota: 'nota', ejemplos: [
    { cod: 'P-001', nom: 'Gasas estériles', uni: 'paquete', min: 5 }, { cod: 'P-002', nom: 'Guantes de exploración', uni: 'caja', min: 2 },
    { cod: 'P-003', nom: 'Solución para limpieza', uni: 'frasco', min: 2 }, { cod: 'P-004', nom: 'Bolsas para residuos', uni: 'bolsa', min: 20 }
  ] });
  X.formatoCondicional(wp, `A${prod.primera}:I${prod.ultima}`, `LEFT($H${prod.primera},5)="Saldo"`, { relleno: COLOR.rojoClaro, color: COLOR.rojo });
  X.formatoCondicional(wp, `A${prod.primera}:I${prod.ultima}`, `LEFT($H${prod.primera},2)="En"`, { relleno: COLOR.ambarClaro, color: '7A5200' });
  const wm = X.hoja(wb, 'Movimientos', { congelar: { x: 2, y: 4 } });
  X.banda(wm, 'Libro de entradas y salidas', 'Zoorigen · Material de apoyo (formato de registro interno, no oficial). Escribe los movimientos en el orden en que ocurrieron.', 12);
  const mov = X.tabla(wm, [
    { clave: 'fec', titulo: 'Fecha', ancho: 13, formato: FMT_FECHA, fecha: true },
    { clave: 'cod', titulo: 'Código', ancho: 12, lista: 'Productos!$A$5:$A$104' },
    { clave: 'nom', titulo: 'Producto', ancho: 32, tipo: 'calc', formula: (r, m) => `IF(${m.cod}${r}="","",IFERROR(INDEX(Productos!$B$5:$B$104,MATCH(${m.cod}${r},Productos!$A$5:$A$104,0)),"Código no encontrado"))` },
    { clave: 'tip', titulo: 'Tipo', ancho: 11, lista: ['Entrada', 'Salida'] },
    { clave: 'can', titulo: 'Cantidad', ancho: 11, formato: '#,##0.##', numero: { min: 0, max: 1000000 } },
    { clave: 'lot', titulo: 'Lote', ancho: 13 },
    { clave: 'cad', titulo: 'Caducidad', ancho: 13, formato: FMT_FECHA, fecha: true },
    { clave: 'res', titulo: 'Responsable', ancho: 16 },
    { clave: 'mot', titulo: 'Motivo o destino', ancho: 26 },
    { clave: 'sdo', titulo: 'Saldo después', ancho: 13, tipo: 'calc', formato: '#,##0.##', formula: (r, m) => `IF(OR(${m.cod}${r}="",${m.can}${r}=""),"",SUMIFS($E$5:$E${r},$B$5:$B${r},${m.cod}${r},$D$5:$D${r},"Entrada")-SUMIFS($E$5:$E${r},$B$5:$B${r},${m.cod}${r},$D$5:$D${r},"Salida"))` },
    { clave: 'ale', titulo: 'Alerta', ancho: 22, tipo: 'calc', formula: (r, m) => `IF(${m.sdo}${r}="","",IF(${m.sdo}${r}<0,"Saldo negativo: revisa",IFERROR(IF(${m.sdo}${r}<=INDEX(Productos!$D$5:$D$104,MATCH(${m.cod}${r},Productos!$A$5:$A$104,0)),"En el mínimo o por debajo",""),"")))` },
    { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 500, columnaNota: 'nota', ejemplos: [
    { fec: d(-40), cod: 'P-001', tip: 'Entrada', can: 20, lot: 'L-01', res: 'Nombre', mot: 'Compra inicial' },
    { fec: d(-33), cod: 'P-001', tip: 'Salida', can: 6, res: 'Nombre', mot: 'Uso en curaciones' },
    { fec: d(-30), cod: 'P-002', tip: 'Entrada', can: 4, lot: 'L-02', cad: d(500), res: 'Nombre', mot: 'Compra' },
    { fec: d(-20), cod: 'P-001', tip: 'Salida', can: 11, res: 'Nombre', mot: 'Uso en curaciones' },
    { fec: d(-12), cod: 'P-002', tip: 'Salida', can: 3, res: 'Nombre', mot: 'Uso en revisiones' },
    { fec: d(-5), cod: 'P-003', tip: 'Entrada', can: 3, lot: 'L-03', cad: d(200), res: 'Nombre', mot: 'Compra' }
  ] });
  X.formatoCondicional(wm, `J${mov.primera}:K${mov.ultima}`, `LEFT($K${mov.primera},5)="Saldo"`, { relleno: COLOR.rojoClaro, color: COLOR.rojo });
  X.formatoCondicional(wm, `J${mov.primera}:K${mov.ultima}`, `LEFT($K${mov.primera},2)="En"`, { relleno: COLOR.ambarClaro, color: '7A5200' });
  X.formatoCondicional(wm, `D${mov.primera}:D${mov.ultima}`, `$D${mov.primera}="Entrada"`, { color: COLOR.verde });
  X.formatoCondicional(wm, `D${mov.primera}:D${mov.ultima}`, `$D${mov.primera}="Salida"`, { color: COLOR.naranja });
  wm.autoFilter = `A${mov.fila0}:L${mov.ultima}`;
  return aBuffer(wb);
}

/* ═════════════ 3. Registro de peso y curva de crecimiento por ejemplar ═════════════ */
async function pesoCurva() {
  const wb = X.libro('Registro de peso y curva de crecimiento por ejemplar', 'Registro de pesos por ejemplar con curva de crecimiento y ganancia entre pesajes');
  X.instrucciones(wb, {
    titulo: 'Registro de peso y curva de crecimiento por ejemplar',
    para: 'Anota los pesajes de cada ejemplar y mira su curva: la hoja calcula cuánto cambió entre un pesaje y el siguiente y dibuja la gráfica de la persona o el animal que elijas. Es una herramienta de registro: la interpretación de un peso o de una curva le corresponde al médico veterinario o al biólogo responsable.',
    hojas: [['Ejemplares', 'Lista de tus ejemplares y la unidad en que pesas a cada uno.'], ['Registro', 'Un renglón por pesaje. Cálculos automáticos de cambio y ganancia por día.'], ['Curva', 'Elige un ejemplar de la lista y ve su tabla y su gráfica.']],
    pasos: ['En «Ejemplares» borra los EJEMPLOS y escribe tus ejemplares: identificador, nombre común, especie, sexo y la unidad de peso (kg o g).',
      'En «Registro» elige el ejemplar de la lista, escribe la fecha y el peso. Escribe los pesajes de cada ejemplar en orden cronológico (del más antiguo al más reciente).',
      'Las columnas grises calculan el cambio de peso, los días transcurridos y la ganancia por día respecto al pesaje anterior del mismo ejemplar.',
      'Abre «Curva», elige el ejemplar en la celda verde y revisa la gráfica. La curva se actualiza al cambiar de ejemplar.',
      'Usa siempre la misma báscula y las mismas condiciones de pesaje cuando sea posible, para que las comparaciones tengan sentido.'],
    notas: ['La gráfica muestra hasta 40 pesajes por ejemplar. Si tienes más, usa un ejemplar con otro identificador por periodo.', 'Un peso por sí solo no dice si un animal está sano: esta hoja no emite diagnósticos ni valores de referencia.']
  });
  const we = X.hoja(wb, 'Ejemplares', { congelar: { y: 4 } });
  X.banda(we, 'Ejemplares', 'Zoorigen · Material de apoyo', 7);
  const ej = X.tabla(we, [
    { clave: 'id', titulo: 'Identificador', ancho: 16, ayuda: 'Un identificador único (marca, anillo, nombre o código).' },
    { clave: 'nom', titulo: 'Nombre común', ancho: 22 }, { clave: 'esp', titulo: 'Nombre científico', ancho: 26 },
    { clave: 'sex', titulo: 'Sexo', ancho: 14, lista: ['Macho', 'Hembra', 'Indeterminado'] },
    { clave: 'nac', titulo: 'Nacimiento o ingreso', ancho: 18, formato: FMT_FECHA, fecha: true },
    { clave: 'uni', titulo: 'Unidad de peso', ancho: 14, lista: ['kg', 'g'] }, { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 60, columnaNota: 'nota', ejemplos: [
    { id: 'EJ-001', nom: 'Especie de ejemplo A', esp: '(escribe el nombre científico)', sex: 'Hembra', nac: d(-220), uni: 'kg' },
    { id: 'EJ-002', nom: 'Especie de ejemplo B', esp: '(escribe el nombre científico)', sex: 'Macho', nac: d(-190), uni: 'g' }
  ] });
  const wr = X.hoja(wb, 'Registro', { congelar: { x: 1, y: 4 } });
  X.banda(wr, 'Registro de pesajes', 'Zoorigen · Material de apoyo. Escribe los pesajes de cada ejemplar del más antiguo al más reciente.', 10);
  const reg = X.tabla(wr, [
    { clave: 'eje', titulo: 'Ejemplar', ancho: 16, lista: 'Ejemplares!$A$5:$A$64' },
    { clave: 'fec', titulo: 'Fecha', ancho: 13, formato: FMT_FECHA, fecha: true },
    { clave: 'pes', titulo: 'Peso', ancho: 11, formato: '#,##0.00', numero: { min: 0, max: 100000 }, ayuda: 'En la unidad indicada en la hoja Ejemplares.' },
    { clave: 'uni', titulo: 'Unidad', ancho: 9, tipo: 'calc', formula: (r, m) => `IF(${m.eje}${r}="","",IFERROR(INDEX(Ejemplares!$F$5:$F$64,MATCH(${m.eje}${r},Ejemplares!$A$5:$A$64,0)),""))` },
    { clave: 'obs', titulo: 'Observaciones', ancho: 28 },
    { clave: 'num', titulo: 'N.º de pesaje', ancho: 10, tipo: 'calc', formato: '0', formula: (r, m) => `IF(${m.eje}${r}="","",COUNTIF($A$5:$A${r},${m.eje}${r}))` },
    { clave: 'cla', titulo: 'Clave', ancho: 14, tipo: 'calc', formula: (r, m) => `IF(${m.eje}${r}="","",${m.eje}${r}&"|"&${m.num}${r})` },
    { clave: 'cam', titulo: 'Cambio de peso', ancho: 12, tipo: 'calc', formato: '+#,##0.00;-#,##0.00;0.00', formula: (r, m) => `IF(OR(${m.num}${r}="",${m.num}${r}<2,${m.pes}${r}=""),"",IFERROR(${m.pes}${r}-INDEX($C$5:$C$504,MATCH(${m.eje}${r}&"|"&(${m.num}${r}-1),$G$5:$G$504,0)),""))` },
    { clave: 'dia', titulo: 'Días desde el pesaje anterior', ancho: 14, tipo: 'calc', formato: '0', formula: (r, m) => `IF(OR(${m.num}${r}="",${m.num}${r}<2,${m.fec}${r}=""),"",IFERROR(${m.fec}${r}-INDEX($B$5:$B$504,MATCH(${m.eje}${r}&"|"&(${m.num}${r}-1),$G$5:$G$504,0)),""))` },
    { clave: 'gan', titulo: 'Ganancia por día', ancho: 13, tipo: 'calc', formato: '+#,##0.000;-#,##0.000;0.000', formula: (r, m) => `IF(OR(${m.cam}${r}="",${m.dia}${r}="",${m.dia}${r}=0),"",${m.cam}${r}/${m.dia}${r})` }
  ], { filas: 500, altoCab: 44, ejemplos: [
    { eje: 'EJ-001', fec: d(-100), pes: 2.4 }, { eje: 'EJ-001', fec: d(-70), pes: 3.1 }, { eje: 'EJ-001', fec: d(-40), pes: 3.9 },
    { eje: 'EJ-001', fec: d(-10), pes: 4.5 }, { eje: 'EJ-002', fec: d(-90), pes: 310 }, { eje: 'EJ-002', fec: d(-60), pes: 365 }, { eje: 'EJ-002', fec: d(-30), pes: 402 }
  ] });
  X.formatoCondicional(wr, `H${reg.primera}:H${reg.ultima}`, `AND(ISNUMBER($H${reg.primera}),$H${reg.primera}<0)`, { color: COLOR.rojo });
  const wc = X.hoja(wb, 'Curva', { color: COLOR.dorado });
  X.banda(wc, 'Curva de crecimiento', 'Elige un ejemplar en la celda verde. La tabla y la gráfica se actualizan solas.', 9);
  wc.columns = [{ width: 8 }, { width: 14 }, { width: 18 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 3 }, { width: 14 }, { width: 14 }];
  X.etiqueta(wc, 'A3', 'Ejemplar:', { color: COLOR.tinta });
  wc.mergeCells('B3:C3');
  const sel = X.parametro(wc, 'A3', 'B3', 'Ejemplar:', 'EJ-001');
  wc.dataValidations.add('B3:C3', { type: 'list', allowBlank: false, formulae: ['Ejemplares!$A$5:$A$64'], showErrorMessage: true, errorTitle: 'Elige un ejemplar', error: 'Elige un ejemplar de la lista.' });
  void sel;
  ['N.º', 'Fecha', 'Días desde el primer pesaje', 'Peso', 'Cambio vs. anterior', 'Ganancia por día'].forEach((h, i) => {
    const c = wc.getCell(5, i + 1); c.value = h; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = X.borde;
  });
  wc.getRow(5).height = 32;
  for (let k = 1; k <= 40; k++) {
    const r = 5 + k;
    const f = col => `INDEX(Registro!$${col}$5:$${col}$504,MATCH($B$3&"|"&$A${r},Registro!$G$5:$G$504,0))`;
    wc.getCell(`A${r}`).value = k;
    wc.getCell(`B${r}`).value = { formula: `IFERROR(${f('B')},NA())` };
    wc.getCell(`C${r}`).value = { formula: `IF(ISNA(B${r}),NA(),B${r}-$B$6)` };
    wc.getCell(`D${r}`).value = { formula: `IFERROR(${f('C')},NA())` };
    wc.getCell(`E${r}`).value = { formula: `IFERROR(IF(${f('H')}="",NA(),${f('H')}),NA())` };
    wc.getCell(`F${r}`).value = { formula: `IFERROR(IF(${f('J')}="",NA(),${f('J')}),NA())` };
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach(c => X.estiloCelda(wc.getCell(`${c}${r}`), 'calc', c === 'B' ? FMT_FECHA : (c === 'D' ? '#,##0.00' : (c === 'E' ? '+#,##0.00;-#,##0.00;0.00' : (c === 'F' ? '+#,##0.000;-#,##0.000;0.000' : '0')))));
  }
  X.formatoCondicional(wc, 'B6:F45', 'ISNA(B6)', { color: COLOR.grisClaro, negrita: false });
  X.etiqueta(wc, 'A47', 'Los #N/A (en gris claro) son filas sin pesaje: es normal y así la gráfica no dibuja puntos vacíos.', { negrita: false, color: COLOR.gris });
  return aBuffer(wb, [{ hoja: 'Curva', tipo: 'dispersion', titulo: 'Curva de peso del ejemplar elegido', tituloX: 'Días desde el primer pesaje', tituloY: 'Peso', formatoY: '#,##0.0', series: [{ nombre: 'Peso', categorias: 'Curva!$C$6:$C$45', valores: 'Curva!$D$6:$D$45', color: '1F5F3A' }], ancla: { col: 7, fila: 3, ancho: 8, alto: 20 } }]);
}

/* ═════════════ 4. Calendario de actividades preventivas con tu propio protocolo ═════════════ */
async function calendarioPreventivo() {
  const wb = X.libro('Calendario de vacunación y desparasitación con tu protocolo', 'Calendario que calcula próximas fechas y vencimientos a partir del protocolo que defines');
  X.instrucciones(wb, {
    titulo: 'Calendario de vacunación y desparasitación (tu propio protocolo)',
    para: 'Escribe el protocolo que define y autoriza tu médico veterinario responsable (qué actividad, cada cuánto) y registra cuándo se aplicó cada una: el libro calcula la próxima fecha, los días que faltan y marca lo vigente, lo que está por vencer y lo vencido. La hoja NO sugiere productos, dosis, esquemas ni intervalos: los pones tú.',
    hojas: [['Protocolo', 'Tus actividades preventivas y cada cuánto se repiten. Es lo único que debes definir.'], ['Registro', 'Cada aplicación realizada: ejemplar, actividad y fecha. Calcula la próxima fecha y el estado.'], ['Resumen', 'Cuántas aplicaciones están vigentes, por vencer o vencidas, por actividad.']],
    pasos: ['En «Protocolo» borra los EJEMPLOS y escribe tus actividades con el nombre que uses (por ejemplo «Actividad A»), su tipo y cada cuánto se repite (número y unidad: días, semanas o meses). Usa lo que indique tu médico veterinario.',
      'En «Registro» elige el ejemplar, elige la actividad de la lista y escribe la fecha en que se aplicó. Anota el producto y el lote en la columna de texto si lo necesitas.',
      'Cada vez que se repita una actividad, agrega un renglón nuevo. El libro toma como vigente solo la aplicación más reciente de cada ejemplar y actividad; las anteriores aparecen como «Reemplazada».',
      'Mira la columna «Estado»: «Por vencer» aparece cuando faltan los días de aviso que definiste en el Protocolo (por defecto 30).',
      'Revisa «Resumen» al empezar cada semana.'],
    notas: ['Los intervalos y las actividades las define tu médico veterinario responsable. Este libro solo hace las cuentas de fechas.', 'Para trámites oficiales usa los formatos que la autoridad te pida: esto es un registro interno.']
  });
  const wp = X.hoja(wb, 'Protocolo', { congelar: { y: 4 } });
  X.banda(wp, 'Protocolo (lo defines tú)', 'Zoorigen · Material de apoyo. Los nombres e intervalos del ejemplo son ilustrativos: NO son una recomendación.', 6);
  const pro = X.tabla(wp, [
    { clave: 'act', titulo: 'Actividad', ancho: 30 }, { clave: 'tip', titulo: 'Tipo', ancho: 26, lista: ['Vacunación', 'Desparasitación', 'Otra actividad preventiva'] },
    { clave: 'cad', titulo: 'Se repite cada…', ancho: 14, numero: { min: 1, max: 1000 }, ayuda: 'Un número: 1, 2, 6, 12…' },
    { clave: 'uni', titulo: 'Unidad', ancho: 12, lista: ['días', 'semanas', 'meses'] },
    { clave: 'avi', titulo: 'Avisar con (días)', ancho: 14, numero: { min: 0, max: 365 }, ayuda: 'Cuántos días antes quieres que aparezca «Por vencer». Si lo dejas vacío, 30.' },
    { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 50, columnaNota: 'nota', ejemplos: [
    { act: 'Actividad A (ejemplo)', tip: 'Vacunación', cad: 12, uni: 'meses', avi: 30 }, { act: 'Actividad B (ejemplo)', tip: 'Desparasitación', cad: 3, uni: 'meses', avi: 15 },
    { act: 'Actividad C (ejemplo)', tip: 'Otra actividad preventiva', cad: 8, uni: 'semanas' }
  ] });
  const wr = X.hoja(wb, 'Registro', { congelar: { x: 1, y: 4 } });
  X.banda(wr, 'Registro de aplicaciones', 'Zoorigen · Material de apoyo. Una fila por aplicación realizada.', 11);
  const bus = (col, r, m) => `INDEX(Protocolo!$${col}$5:$${col}$54,MATCH(${m.act}${r},Protocolo!$A$5:$A$54,0))`;
  const reg = X.tabla(wr, [
    { clave: 'eje', titulo: 'Ejemplar', ancho: 18 }, { clave: 'act', titulo: 'Actividad', ancho: 28, lista: 'Protocolo!$A$5:$A$54' },
    { clave: 'tip', titulo: 'Tipo', ancho: 22, tipo: 'calc', formula: (r, m) => `IF(${m.act}${r}="","",IFERROR(${bus('B', r, m)},""))` },
    { clave: 'fec', titulo: 'Fecha de aplicación', ancho: 15, formato: FMT_FECHA, fecha: true },
    { clave: 'pro', titulo: 'Producto y lote (texto libre)', ancho: 26 }, { clave: 'res', titulo: 'Responsable', ancho: 18 },
    { clave: 'prx', titulo: 'Próxima fecha', ancho: 14, tipo: 'calc', formato: FMT_FECHA, formula: (r, m) => `IF(OR(${m.act}${r}="",${m.fec}${r}=""),"",IFERROR(IF(${bus('D', r, m)}="meses",EDATE(${m.fec}${r},${bus('C', r, m)}),${m.fec}${r}+${bus('C', r, m)}*IF(${bus('D', r, m)}="semanas",7,1)),""))` },
    { clave: 'dias', titulo: 'Días para vencer', ancho: 12, tipo: 'calc', formato: '0', formula: (r, m) => `IF(${m.prx}${r}="","",${m.prx}${r}-TODAY())` },
    { clave: 'rec', titulo: '¿Es la más reciente?', ancho: 16, tipo: 'calc', formula: (r, m) => `IF(OR(${m.eje}${r}="",${m.act}${r}="",${m.fec}${r}=""),"",IF(${m.fec}${r}=SUMPRODUCT(MAX(($A$5:$A$504=${m.eje}${r})*($B$5:$B$504=${m.act}${r})*$D$5:$D$504)),"Sí","Reemplazada"))` },
    { clave: 'est', titulo: 'Estado', ancho: 14, tipo: 'calc', formula: (r, m) => `IF(${m.rec}${r}="","",IF(${m.rec}${r}="Reemplazada","Reemplazada",IF(${m.dias}${r}="","Sin fecha",IF(${m.dias}${r}<0,"Vencida",IF(${m.dias}${r}<=IFERROR(IF(${bus('E', r, m)}="",30,${bus('E', r, m)}),30),"Por vencer","Vigente")))))` },
    { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 500, altoCab: 40, columnaNota: 'nota', ejemplos: [
    { eje: 'EJ-001', act: 'Actividad A (ejemplo)', fec: d(-340), pro: 'Producto y lote (escríbelo tú)', res: 'Nombre' },
    { eje: 'EJ-001', act: 'Actividad B (ejemplo)', fec: d(-120), pro: 'Producto y lote (escríbelo tú)', res: 'Nombre' },
    { eje: 'EJ-002', act: 'Actividad A (ejemplo)', fec: d(-400), pro: 'Producto y lote (escríbelo tú)', res: 'Nombre' },
    { eje: 'EJ-002', act: 'Actividad B (ejemplo)', fec: d(-30), res: 'Nombre' },
    { eje: 'EJ-002', act: 'Actividad B (ejemplo)', fec: d(-100), res: 'Nombre' },
    { eje: 'EJ-003', act: 'Actividad C (ejemplo)', fec: d(-50), res: 'Nombre' }
  ] });
  const rango = `A${reg.primera}:K${reg.ultima}`;
  X.formatoCondicional(wr, rango, `$J${reg.primera}="Vencida"`, { relleno: COLOR.rojoClaro, color: COLOR.rojo });
  X.formatoCondicional(wr, rango, `$J${reg.primera}="Por vencer"`, { relleno: COLOR.ambarClaro, color: '7A5200' });
  X.formatoCondicional(wr, `J${reg.primera}:J${reg.ultima}`, `$J${reg.primera}="Vigente"`, { relleno: COLOR.verdeClaro, color: COLOR.verde });
  X.formatoCondicional(wr, rango, `$J${reg.primera}="Reemplazada"`, { color: COLOR.gris, negrita: false });
  wr.autoFilter = `A${reg.fila0}:K${reg.ultima}`;
  const rs = X.hoja(wb, 'Resumen', { color: COLOR.dorado });
  X.banda(rs, 'Resumen por actividad', 'Cuenta solo la aplicación más reciente de cada ejemplar y actividad.', 6);
  rs.columns = [{ width: 32 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }];
  ['Actividad', 'Vigentes', 'Por vencer', 'Vencidas', 'Con registro'].forEach((h, i) => { const c = rs.getCell(4, i + 1); c.value = h; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; c.alignment = { horizontal: 'center' }; });
  for (let k = 0; k < 20; k++) {
    const r = 5 + k;
    rs.getCell(`A${r}`).value = { formula: `IF(Protocolo!A${5 + k}="","",Protocolo!A${5 + k})` };
    ['Vigente', 'Por vencer', 'Vencida'].forEach((e, i) => { rs.getCell(r, 2 + i).value = { formula: `IF($A${r}="","",COUNTIFS(Registro!$B$5:$B$504,$A${r},Registro!$J$5:$J$504,"${e}"))` }; });
    rs.getCell(`E${r}`).value = { formula: `IF($A${r}="","",SUM(B${r}:D${r}))` };
    ['A', 'B', 'C', 'D', 'E'].forEach(c => X.estiloCelda(rs.getCell(`${c}${r}`), 'calc', c === 'A' ? null : '0'));
  }
  X.formatoCondicional(rs, 'D5:D24', 'AND(ISNUMBER($D5),$D5>0)', { relleno: COLOR.rojoClaro, color: COLOR.rojo });
  X.formatoCondicional(rs, 'C5:C24', 'AND(ISNUMBER($C5),$C5>0)', { relleno: COLOR.ambarClaro, color: '7A5200' });
  rs.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  return aBuffer(wb);
}

/* ═════════════ 5. Registro de ingresos, bajas y traslados de ejemplares ═════════════ */
async function registroMovimientos() {
  const wb = X.libro('Registro de ingresos, bajas y traslados de ejemplares', 'Registro interno de movimientos de ejemplares con resumen anual por especie');
  X.instrucciones(wb, {
    titulo: 'Registro de ingresos, bajas y traslados de ejemplares',
    para: 'Lleva el movimiento de los ejemplares de tu UMA, PIMVS, zoológico o centro: quién ingresa, quién causa baja y quién se traslada, con su documento de respaldo. La hoja «Resumen» te da por especie la existencia al inicio del año, los ingresos, las bajas, los traslados y la existencia al cierre. Es un registro interno de apoyo: NO sustituye los informes, bitácoras ni formatos que la autoridad te solicite.',
    hojas: [['Ejemplares', 'La lista de ejemplares con su especie, sexo y marca o identificación.'], ['Movimientos', 'Un renglón por cada ingreso, baja o traslado, con el documento que lo respalda.'], ['Resumen', 'Cuenta por especie para el año que elijas.']],
    pasos: ['En «Ejemplares» borra los EJEMPLOS y escribe tus ejemplares con un identificador único. Escribe la especie de forma consistente: el resumen agrupa por el nombre común tal como lo escribas.',
      'En «Movimientos» elige el ejemplar, la fecha, el tipo (Ingreso, Baja, Traslado saliente o Traslado entrante) y el motivo. Anota el documento que respalda el movimiento (por ejemplo, el número o la descripción del oficio, factura o nota de remisión) y el origen o destino.',
      'La columna «Efecto» suma 1 cuando entra un ejemplar y resta 1 cuando sale. La especie y el año se calculan solos.',
      'En «Resumen» escribe el año y, en la columna A, cada especie como aparece en «Ejemplares». Se calcula la existencia al inicio, los movimientos del año y la existencia al cierre.',
      'Revisa la columna «Revisión»: te avisa si el cierre calculado no coincide con la suma de todos los movimientos.'],
    notas: ['Los documentos que deben acompañar cada movimiento (por ejemplo los de legal procedencia o de traslado) los define la normatividad vigente: consulta la norma y a tu asesor legal. Aquí solo hay un campo de texto para anotarlos.', 'Si un ejemplar nace en la unidad, regístralo como Ingreso con el motivo «Nacimiento».']
  });
  const we = X.hoja(wb, 'Ejemplares', { congelar: { y: 4 } });
  X.banda(we, 'Ejemplares', 'Zoorigen · Material de apoyo (registro interno, no oficial)', 7);
  const ej = X.tabla(we, [
    { clave: 'id', titulo: 'Identificador', ancho: 16 }, { clave: 'nom', titulo: 'Nombre común (especie)', ancho: 26 }, { clave: 'cie', titulo: 'Nombre científico', ancho: 28 },
    { clave: 'sex', titulo: 'Sexo', ancho: 14, lista: ['Macho', 'Hembra', 'Indeterminado'] }, { clave: 'mar', titulo: 'Marca o identificación', ancho: 22 }, { clave: 'obs', titulo: 'Observaciones', ancho: 26 }, { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 300, columnaNota: 'nota', ejemplos: [
    { id: 'EJ-001', nom: 'Especie de ejemplo A', cie: '(nombre científico)', sex: 'Hembra', mar: 'Marca 0001' }, { id: 'EJ-002', nom: 'Especie de ejemplo A', cie: '(nombre científico)', sex: 'Macho', mar: 'Marca 0002' },
    { id: 'EJ-003', nom: 'Especie de ejemplo B', cie: '(nombre científico)', sex: 'Indeterminado', mar: 'Marca 0003' }, { id: 'EJ-004', nom: 'Especie de ejemplo B', cie: '(nombre científico)', sex: 'Hembra', mar: 'Marca 0004' },
    { id: 'EJ-005', nom: 'Especie de ejemplo C', cie: '(nombre científico)', sex: 'Macho', mar: 'Marca 0005' }
  ] });
  const wm = X.hoja(wb, 'Movimientos', { congelar: { x: 2, y: 4 } });
  X.banda(wm, 'Movimientos de ejemplares', 'Zoorigen · Material de apoyo. Anota el documento que respalda cada movimiento.', 12);
  const mov = X.tabla(wm, [
    { clave: 'fec', titulo: 'Fecha', ancho: 13, formato: FMT_FECHA, fecha: true }, { clave: 'eje', titulo: 'Ejemplar', ancho: 15, lista: 'Ejemplares!$A$5:$A$304' },
    { clave: 'esp', titulo: 'Especie', ancho: 24, tipo: 'calc', formula: (r, m) => `IF(${m.eje}${r}="","",IFERROR(INDEX(Ejemplares!$B$5:$B$304,MATCH(${m.eje}${r},Ejemplares!$A$5:$A$304,0)),"Ejemplar no encontrado"))` },
    { clave: 'tip', titulo: 'Tipo', ancho: 17, lista: ['Ingreso', 'Baja', 'Traslado saliente', 'Traslado entrante'] },
    { clave: 'mot', titulo: 'Motivo', ancho: 20, lista: ['Nacimiento', 'Adquisición', 'Donación', 'Rescate o entrega', 'Muerte', 'Liberación', 'Intercambio o préstamo', 'Otro'] },
    { clave: 'doc', titulo: 'Documento que lo respalda', ancho: 30 }, { clave: 'ori', titulo: 'Origen o destino', ancho: 24 }, { clave: 'res', titulo: 'Responsable', ancho: 16 },
    { clave: 'efe', titulo: 'Efecto', ancho: 8, tipo: 'calc', formato: '+0;-0;0', formula: (r, m) => `IF(${m.tip}${r}="","",IF(OR(${m.tip}${r}="Ingreso",${m.tip}${r}="Traslado entrante"),1,-1))` },
    { clave: 'ani', titulo: 'Año', ancho: 8, tipo: 'calc', formato: '0', formula: (r, m) => `IF(${m.fec}${r}="","",YEAR(${m.fec}${r}))` },
    { clave: 'obs', titulo: 'Observaciones', ancho: 22 }, { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 600, columnaNota: 'nota', ejemplos: [
    { fec: new Date(Date.UTC(2025, 2, 10)), eje: 'EJ-001', tip: 'Ingreso', mot: 'Adquisición', doc: 'Descripción del documento (ejemplo)', ori: 'Origen de ejemplo', res: 'Nombre' },
    { fec: new Date(Date.UTC(2025, 2, 10)), eje: 'EJ-002', tip: 'Ingreso', mot: 'Adquisición', doc: 'Descripción del documento (ejemplo)', ori: 'Origen de ejemplo', res: 'Nombre' },
    { fec: new Date(Date.UTC(2026, 1, 18)), eje: 'EJ-003', tip: 'Ingreso', mot: 'Nacimiento', doc: 'Acta interna de nacimiento (ejemplo)', ori: 'Nacido en la unidad', res: 'Nombre' },
    { fec: new Date(Date.UTC(2026, 3, 2)), eje: 'EJ-004', tip: 'Traslado entrante', mot: 'Intercambio o préstamo', doc: 'Descripción del documento (ejemplo)', ori: 'Otra unidad (ejemplo)', res: 'Nombre' },
    { fec: new Date(Date.UTC(2026, 5, 20)), eje: 'EJ-005', tip: 'Ingreso', mot: 'Rescate o entrega', doc: 'Descripción del documento (ejemplo)', ori: 'Entrega voluntaria (ejemplo)', res: 'Nombre' },
    { fec: new Date(Date.UTC(2026, 7, 8)), eje: 'EJ-002', tip: 'Baja', mot: 'Muerte', doc: 'Registro de mortalidad (ejemplo)', ori: '', res: 'Nombre' },
    { fec: new Date(Date.UTC(2026, 8, 15)), eje: 'EJ-005', tip: 'Traslado saliente', mot: 'Liberación', doc: 'Descripción del documento (ejemplo)', ori: 'Destino de ejemplo', res: 'Nombre' }
  ] });
  X.formatoCondicional(wm, `D${mov.primera}:D${mov.ultima}`, `OR($D${mov.primera}="Baja",$D${mov.primera}="Traslado saliente")`, { color: COLOR.naranja });
  X.formatoCondicional(wm, `D${mov.primera}:D${mov.ultima}`, `OR($D${mov.primera}="Ingreso",$D${mov.primera}="Traslado entrante")`, { color: COLOR.verde });
  wm.autoFilter = `A${mov.fila0}:L${mov.ultima}`;
  const rs = X.hoja(wb, 'Resumen', { color: COLOR.dorado });
  X.banda(rs, 'Resumen anual por especie', 'Escribe el año y las especies (como aparecen en Ejemplares).', 8);
  rs.columns = [{ width: 30 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 18 }];
  X.parametro(rs, 'A3', 'B3', 'Año del resumen', 2026, '0');
  ['Especie', 'Existencia al 1 de enero', 'Ingresos', 'Bajas', 'Traslados salientes', 'Existencia al 31 de dic.', 'Existencia actual', 'Revisión'].forEach((h, i) => { const c = rs.getCell(5, i + 1); c.value = h; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  rs.getRow(5).height = 34;
  const M = 'Movimientos!';
  const especies = ['Especie de ejemplo A', 'Especie de ejemplo B', 'Especie de ejemplo C'];
  for (let k = 0; k < 30; k++) {
    const r = 6 + k;
    const a = rs.getCell(`A${r}`); if (k < 3) { a.value = especies[k]; } X.estiloCelda(a, 'entrada');
    if (k < 3) { a.fill = X.relleno(COLOR.doradoClaro); a.font = { italic: true }; }
    const fm = (c, f) => { rs.getCell(`${c}${r}`).value = { formula: f }; X.estiloCelda(rs.getCell(`${c}${r}`), 'calc', '0'); };
    fm('B', `IF($A${r}="","",SUMIFS(${M}$I$5:$I$604,${M}$C$5:$C$604,$A${r},${M}$A$5:$A$604,"<"&DATE($B$3,1,1)))`);
    fm('C', `IF($A${r}="","",SUMIFS(${M}$I$5:$I$604,${M}$C$5:$C$604,$A${r},${M}$J$5:$J$604,$B$3,${M}$I$5:$I$604,1))`);
    fm('D', `IF($A${r}="","",COUNTIFS(${M}$C$5:$C$604,$A${r},${M}$J$5:$J$604,$B$3,${M}$D$5:$D$604,"Baja"))`);
    fm('E', `IF($A${r}="","",COUNTIFS(${M}$C$5:$C$604,$A${r},${M}$J$5:$J$604,$B$3,${M}$D$5:$D$604,"Traslado saliente"))`);
    fm('F', `IF($A${r}="","",B${r}+C${r}-D${r}-E${r})`);
    fm('G', `IF($A${r}="","",SUMIFS(${M}$I$5:$I$604,${M}$C$5:$C$604,$A${r}))`);
    rs.getCell(`H${r}`).value = { formula: `IF($A${r}="","",IF(F${r}=SUMIFS(${M}$I$5:$I$604,${M}$C$5:$C$604,$A${r},${M}$A$5:$A$604,"<"&DATE($B$3+1,1,1)),"Coincide","Revisa los movimientos"))` };
    X.estiloCelda(rs.getCell(`H${r}`), 'calc');
  }
  rs.getCell('A36').value = 'Total'; rs.getCell('A36').font = { bold: true };
  ['B', 'C', 'D', 'E', 'F', 'G'].forEach(c => { rs.getCell(`${c}36`).value = { formula: `SUM(${c}6:${c}35)` }; X.estiloCelda(rs.getCell(`${c}36`), 'calc', '0'); rs.getCell(`${c}36`).font = { bold: true }; });
  X.formatoCondicional(rs, 'H6:H35', 'LEFT($H6,6)="Revisa"', { relleno: COLOR.rojoClaro, color: COLOR.rojo });
  X.formatoCondicional(rs, 'H6:H35', '$H6="Coincide"', { color: COLOR.verde });
  return aBuffer(wb, [{ hoja: 'Resumen', tipo: 'barras', titulo: 'Movimientos del año por especie', tituloY: 'Ejemplares', series: [
    { nombre: 'Ingresos', categorias: 'Resumen!$A$6:$A$15', valores: 'Resumen!$C$6:$C$15', color: '1F5F3A' }, { nombre: 'Bajas', categorias: 'Resumen!$A$6:$A$15', valores: 'Resumen!$D$6:$D$15', color: 'C75402' }, { nombre: 'Traslados salientes', categorias: 'Resumen!$A$6:$A$15', valores: 'Resumen!$E$6:$E$15', color: 'E8A317' }
  ], ancla: { col: 9, fila: 3, ancho: 8, alto: 20 } }]);
}

/* ═════════════ 6. Presupuesto anual de una UMA o zoológico ═════════════ */
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const CATEGORIAS = ['Alimentación', 'Insumos y material', 'Servicios', 'Personal', 'Mantenimiento e infraestructura', 'Otros'];
async function presupuestoAnual() {
  const wb = X.libro('Presupuesto anual de una UMA o zoológico', 'Presupuesto anual por categoría con comparación contra el gasto real y gráficas');
  X.instrucciones(wb, {
    titulo: 'Presupuesto anual de una UMA o zoológico',
    para: 'Planea el año de tu unidad: alimentación, insumos, servicios, personal y mantenimiento, mes por mes. El libro suma los totales, calcula qué parte del presupuesto es cada concepto y, si capturas el gasto real, te muestra la diferencia y el porcentaje ejercido, con gráficas. Las cantidades del ejemplo son ILUSTRATIVAS: no son referencia de costos reales.',
    hojas: [['Presupuesto', 'Tu plan: un renglón por concepto y una columna por mes.'], ['Real', 'Lo que realmente gastaste, con la misma estructura.'], ['Resumen', 'Totales por categoría, presupuesto contra real y gráficas.']],
    pasos: ['En «Resumen» escribe el año y la moneda.', 'En «Presupuesto» borra los EJEMPLOS y escribe tus conceptos: elige la categoría de la lista, escribe el concepto y el monto de cada mes.',
      'El total anual y el porcentaje del total se calculan solos. Puedes agregar tantos conceptos como necesites en las filas vacías.', 'Cada mes, captura lo gastado en «Real» (una fila por concepto, con su categoría).',
      'En «Resumen» revisa la diferencia por categoría: positiva significa que gastaste menos de lo presupuestado; negativa, que te pasaste.'],
    notas: ['Los montos son los que tú captures. El libro no trae precios ni referencias.', 'Para presupuestos que debas presentar a una autoridad, a un patronato o a un financiador, usa el formato que ellos pidan: este libro es una herramienta de planeación.']
  });
  const cols = (extra = []) => [
    { clave: 'cat', titulo: 'Categoría', ancho: 30, lista: CATEGORIAS }, { clave: 'con', titulo: 'Concepto', ancho: 32 },
    ...MESES.map((m, i) => ({ clave: 'm' + i, titulo: m, ancho: 11, formato: '#,##0', numero: { min: 0, max: 1e12 } })),
    { clave: 'tot', titulo: 'Total anual', ancho: 14, tipo: 'calc', formato: '#,##0', formula: (r, m) => `IF(AND(${m.cat}${r}="",${m.con}${r}=""),"",SUM(C${r}:N${r}))` }, ...extra
  ];
  const ejemplos = [
    { cat: 'Alimentación', con: 'Alimento (ejemplo)', ...Object.fromEntries(MESES.map((m, i) => ['m' + i, 18000 + (i % 3) * 500])) },
    { cat: 'Insumos y material', con: 'Material de limpieza (ejemplo)', ...Object.fromEntries(MESES.map((m, i) => ['m' + i, 3500 + (i % 2) * 400])) },
    { cat: 'Servicios', con: 'Agua y luz (ejemplo)', ...Object.fromEntries(MESES.map((m, i) => ['m' + i, 6200])) },
    { cat: 'Personal', con: 'Nómina y honorarios (ejemplo)', ...Object.fromEntries(MESES.map((m, i) => ['m' + i, 42000])) },
    { cat: 'Mantenimiento e infraestructura', con: 'Reparaciones (ejemplo)', ...Object.fromEntries(MESES.map((m, i) => ['m' + i, i % 4 === 0 ? 15000 : 2500])) }
  ];
  const wp = X.hoja(wb, 'Presupuesto', { congelar: { x: 2, y: 4 } });
  X.banda(wp, 'Presupuesto anual', 'Zoorigen · Material de apoyo. Cifras de ejemplo ilustrativas: bórralas y captura las tuyas.', 15);
  const pre = X.tabla(wp, [...cols(), { clave: 'pct', titulo: '% del total', ancho: 11, tipo: 'calc', formato: '0.0%', formula: (r, m) => `IF(OR(${m.tot}${r}="",SUM($O$5:$O$104)=0),"",${m.tot}${r}/SUM($O$5:$O$104))` }, { clave: 'nota', titulo: 'Nota', ancho: 11 }], { filas: 100, columnaNota: 'nota', ejemplos, altoCab: 28 });
  wp.getCell(`B${pre.ultima + 2}`).value = 'Total'; wp.getCell(`B${pre.ultima + 2}`).font = { bold: true };
  for (let c = 3; c <= 15; c++) { const L = String.fromCharCode(64 + c); const cell = wp.getCell(`${L}${pre.ultima + 2}`); cell.value = { formula: `SUM(${L}5:${L}104)` }; X.estiloCelda(cell, 'calc', '#,##0'); cell.font = { bold: true }; }
  const wr = X.hoja(wb, 'Real', { congelar: { x: 2, y: 4 } });
  X.banda(wr, 'Gasto real', 'Zoorigen · Material de apoyo. Captura lo realmente gastado, por concepto y por mes.', 15);
  const real = X.tabla(wr, cols([{ clave: 'nota', titulo: 'Nota', ancho: 11 }]), { filas: 100, columnaNota: 'nota', ejemplos: ejemplos.map(e => ({ ...e, m0: e.m0 && e.m0 + 900, m1: e.m1 && e.m1 - 600 })), altoCab: 28 });
  wr.getCell(`B${real.ultima + 2}`).value = 'Total'; wr.getCell(`B${real.ultima + 2}`).font = { bold: true };
  for (let c = 3; c <= 15; c++) { const L = String.fromCharCode(64 + c); const cell = wr.getCell(`${L}${real.ultima + 2}`); cell.value = { formula: `SUM(${L}5:${L}104)` }; X.estiloCelda(cell, 'calc', '#,##0'); cell.font = { bold: true }; }
  const rs = X.hoja(wb, 'Resumen', { color: COLOR.dorado });
  X.banda(rs, 'Resumen del presupuesto', 'Presupuesto contra gasto real por categoría.', 12);
  rs.columns = [{ width: 32 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 14 }, { width: 3 }];
  X.parametro(rs, 'A3', 'B3', 'Año', 2027, '0'); X.parametro(rs, 'C3', 'D3', 'Moneda', 'MXN');
  ['Categoría', 'Presupuestado', 'Gasto real', 'Diferencia', '% ejercido'].forEach((h, i) => { const c = rs.getCell(5, i + 1); c.value = h; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; c.alignment = { horizontal: 'center' }; });
  CATEGORIAS.forEach((c, i) => {
    const r = 6 + i;
    rs.getCell(`A${r}`).value = c; X.estiloCelda(rs.getCell(`A${r}`), 'calc');
    rs.getCell(`B${r}`).value = { formula: `SUMIF(Presupuesto!$A$5:$A$104,$A${r},Presupuesto!$O$5:$O$104)` };
    rs.getCell(`C${r}`).value = { formula: `SUMIF(Real!$A$5:$A$104,$A${r},Real!$O$5:$O$104)` };
    rs.getCell(`D${r}`).value = { formula: `B${r}-C${r}` };
    rs.getCell(`E${r}`).value = { formula: `IF(B${r}=0,"",C${r}/B${r})` };
    ['B', 'C', 'D'].forEach(L => X.estiloCelda(rs.getCell(`${L}${r}`), 'calc', '#,##0;[Red]-#,##0')); X.estiloCelda(rs.getCell(`E${r}`), 'calc', '0.0%');
  });
  rs.getCell('A12').value = 'Total'; rs.getCell('A12').font = { bold: true };
  ['B', 'C', 'D'].forEach(L => { rs.getCell(`${L}12`).value = { formula: `SUM(${L}6:${L}11)` }; X.estiloCelda(rs.getCell(`${L}12`), 'calc', '#,##0;[Red]-#,##0'); rs.getCell(`${L}12`).font = { bold: true }; });
  rs.getCell('E12').value = { formula: 'IF(B12=0,"",C12/B12)' }; X.estiloCelda(rs.getCell('E12'), 'calc', '0.0%');
  X.formatoCondicional(rs, 'E6:E12', 'AND(ISNUMBER($E6),$E6>1)', { relleno: COLOR.rojoClaro, color: COLOR.rojo });
  rs.getCell('A15').value = 'Por mes'; rs.getCell('A15').font = { bold: true, color: { argb: X.argb(COLOR.verde) } };
  ['Mes', 'Presupuestado', 'Gasto real'].forEach((h, i) => { const c = rs.getCell(16, i + 1); c.value = h; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; });
  MESES.forEach((m, i) => {
    const r = 17 + i; const L = String.fromCharCode(67 + i);
    rs.getCell(`A${r}`).value = m; X.estiloCelda(rs.getCell(`A${r}`), 'calc');
    rs.getCell(`B${r}`).value = { formula: `SUM(Presupuesto!${L}$5:${L}$104)` }; rs.getCell(`C${r}`).value = { formula: `SUM(Real!${L}$5:${L}$104)` };
    ['B', 'C'].forEach(c => X.estiloCelda(rs.getCell(`${c}${r}`), 'calc', '#,##0'));
  });
  rs.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  return aBuffer(wb, [
    { hoja: 'Resumen', tipo: 'barras', titulo: 'Presupuestado y gasto real por categoría', tituloY: 'Monto', series: [{ nombre: 'Presupuestado', categorias: 'Resumen!$A$6:$A$11', valores: 'Resumen!$B$6:$B$11', color: '1F5F3A' }, { nombre: 'Gasto real', categorias: 'Resumen!$A$6:$A$11', valores: 'Resumen!$C$6:$C$11', color: 'E8A317' }], ancla: { col: 6, fila: 3, ancho: 7, alto: 16 } },
    { hoja: 'Resumen', tipo: 'lineas', titulo: 'Gasto por mes', tituloY: 'Monto', series: [{ nombre: 'Presupuestado', categorias: 'Resumen!$A$17:$A$28', valores: 'Resumen!$B$17:$B$28', color: '1F5F3A' }, { nombre: 'Gasto real', categorias: 'Resumen!$A$17:$A$28', valores: 'Resumen!$C$17:$C$28', color: 'C75402' }], ancla: { col: 6, fila: 19, ancho: 7, alto: 16 } }
  ]);
}

/* ═════════════ 7. Bitácora de enriquecimiento ambiental semanal ═════════════ */
const TIPOS_ENR = ['Físico', 'Sensorial', 'Alimentario', 'Cognitivo', 'Social'];
const RESPUESTAS = ['Interactuó', 'Interés breve', 'Sin interés', 'Evitó', 'No se observó'];
async function bitacoraEnriquecimiento() {
  const wb = X.libro('Bitácora de enriquecimiento ambiental semanal', 'Registro de actividades de enriquecimiento por recinto con resumen semanal');
  X.instrucciones(wb, {
    titulo: 'Bitácora de enriquecimiento ambiental semanal',
    para: 'Registra qué enriquecimiento ofreces en cada recinto, de qué tipo es y cómo respondieron los animales; la hoja «Semana» te muestra qué recintos recibieron enriquecimiento cada día y cuántas actividades hubo por tipo y por respuesta. Sirve para planear y evaluar, no para diagnosticar: la interpretación de las respuestas le corresponde a tu equipo de bienestar y a tu médico veterinario o biólogo.',
    hojas: [['Catalogo', 'Los recintos de tu unidad (para las listas y el resumen) y los tipos de enriquecimiento.'], ['Registro', 'Una fila por actividad: fecha, recinto, tipo, qué se hizo y cómo respondieron.'], ['Semana', 'Elige el lunes de la semana y ve la cobertura por recinto y día, y los conteos.']],
    pasos: ['En «Catalogo» borra los recintos de EJEMPLO y escribe los tuyos (hasta 30).', 'En «Registro» elige el recinto, el tipo (físico, sensorial, alimentario, cognitivo o social), describe la actividad con tus palabras y elige la respuesta observada.',
      'En «Semana» escribe la fecha del lunes de la semana que quieres revisar. La cuadrícula marca con color los días con enriquecimiento y deja en gris los días sin registro.',
      'Revisa los recintos con pocos días cubiertos y planea nuevas actividades para la semana siguiente.', 'Evalúa a lo largo de varias semanas: una sola respuesta no dice mucho.'],
    notas: ['Los tipos de enriquecimiento son una clasificación de uso común en el manejo de fauna; si tu unidad usa otra, puedes cambiar la lista en «Catalogo».', 'Todo animal responde distinto: registra lo que observas, sin interpretarlo de más.']
  });
  const wc = X.hoja(wb, 'Catalogo', { color: COLOR.dorado });
  X.banda(wc, 'Catálogo', 'Zoorigen · Material de apoyo', 6);
  wc.columns = [{ width: 28 }, { width: 28 }, { width: 3 }, { width: 22 }, { width: 3 }, { width: 22 }];
  ['Recintos (hasta 30)', 'Especie o grupo (texto libre)'].forEach((h, i) => { const c = wc.getCell(4, 1 + i); c.value = h; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; });
  const rec = [['Recinto 1 (ejemplo)', 'Grupo A (ejemplo)'], ['Recinto 2 (ejemplo)', 'Grupo B (ejemplo)'], ['Recinto 3 (ejemplo)', 'Grupo C (ejemplo)'], ['Recinto 4 (ejemplo)', 'Grupo D (ejemplo)']];
  for (let k = 0; k < 30; k++) { for (let j = 0; j < 2; j++) { const c = wc.getCell(5 + k, 1 + j); if (rec[k]) { c.value = rec[k][j]; } X.estiloCelda(c, 'entrada'); if (rec[k]) { c.fill = X.relleno(COLOR.doradoClaro); c.font = { italic: true }; } } }
  const lista = (col, titulo, items) => { const c = wc.getCell(`${col}4`); c.value = titulo; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; items.forEach((t, i) => { const x = wc.getCell(`${col}${5 + i}`); x.value = t; X.estiloCelda(x, 'entrada'); }); };
  lista('D', 'Tipos de enriquecimiento', TIPOS_ENR); lista('F', 'Respuesta observada', RESPUESTAS);
  const wr = X.hoja(wb, 'Registro', { congelar: { y: 4 } });
  X.banda(wr, 'Registro de enriquecimiento', 'Zoorigen · Material de apoyo. Una fila por actividad.', 9);
  const reg = X.tabla(wr, [
    { clave: 'fec', titulo: 'Fecha', ancho: 13, formato: FMT_FECHA, fecha: true }, { clave: 'rec', titulo: 'Recinto', ancho: 24, lista: 'Catalogo!$A$5:$A$34' },
    { clave: 'tip', titulo: 'Tipo', ancho: 14, lista: 'Catalogo!$D$5:$D$9' }, { clave: 'des', titulo: 'Qué se hizo (descríbelo)', ancho: 40 },
    { clave: 'min', titulo: 'Duración (min)', ancho: 12, numero: { min: 0, max: 1440 } }, { clave: 'res', titulo: 'Respuesta observada', ancho: 18, lista: 'Catalogo!$F$5:$F$9' },
    { clave: 'per', titulo: 'Responsable', ancho: 16 }, { clave: 'obs', titulo: 'Observaciones', ancho: 28 }, { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 500, columnaNota: 'nota', altoCab: 30, ejemplos: [
    { fec: d(-6), rec: 'Recinto 1 (ejemplo)', tip: 'Alimentario', des: 'Alimento escondido en distintos puntos (ejemplo)', min: 30, res: 'Interactuó', per: 'Nombre' },
    { fec: d(-6), rec: 'Recinto 2 (ejemplo)', tip: 'Físico', des: 'Cambio de posición de troncos (ejemplo)', min: 20, res: 'Interés breve', per: 'Nombre' },
    { fec: d(-5), rec: 'Recinto 1 (ejemplo)', tip: 'Sensorial', des: 'Objeto con aroma nuevo (ejemplo)', min: 15, res: 'Interactuó', per: 'Nombre' },
    { fec: d(-4), rec: 'Recinto 3 (ejemplo)', tip: 'Cognitivo', des: 'Comedero con reto sencillo (ejemplo)', min: 25, res: 'Sin interés', per: 'Nombre' },
    { fec: d(-3), rec: 'Recinto 2 (ejemplo)', tip: 'Social', des: 'Sesión de observación del grupo (ejemplo)', min: 40, res: 'No se observó', per: 'Nombre' },
    { fec: d(-2), rec: 'Recinto 1 (ejemplo)', tip: 'Físico', des: 'Nueva estructura para trepar (ejemplo)', min: 30, res: 'Evitó', per: 'Nombre' },
    { fec: d(-1), rec: 'Recinto 3 (ejemplo)', tip: 'Alimentario', des: 'Presentación distinta del alimento (ejemplo)', min: 20, res: 'Interactuó', per: 'Nombre' }
  ] });
  X.formatoCondicional(wr, `F${reg.primera}:F${reg.ultima}`, `$F${reg.primera}="Evitó"`, { relleno: COLOR.ambarClaro, color: '7A5200' });
  wr.autoFilter = `A${reg.fila0}:I${reg.ultima}`;
  const ws = X.hoja(wb, 'Semana', { color: COLOR.dorado });
  X.banda(ws, 'Resumen de la semana', 'Escribe la fecha del lunes que quieres revisar.', 12);
  ws.columns = [{ width: 28 }, ...Array(7).fill({ width: 10 }), { width: 14 }, { width: 3 }, { width: 22 }, { width: 12 }];
  X.parametro(ws, 'A3', 'B3', 'Lunes de la semana', new Date(Date.UTC(2026, 9, 19)), FMT_FECHA);
  const dias7 = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const h0 = ws.getCell('A5'); h0.value = 'Recinto'; h0.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; h0.fill = X.relleno(COLOR.verde); h0.border = X.borde;
  dias7.forEach((dn, i) => { const L = String.fromCharCode(66 + i); const c = ws.getCell(`${L}5`); c.value = { formula: `"${dn} "&TEXT($B$3+${i},"dd/mm")` }; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; c.alignment = { horizontal: 'center', wrapText: true }; });
  const hd = ws.getCell('I5'); hd.value = 'Días cubiertos'; hd.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; hd.fill = X.relleno(COLOR.verdeMedio); hd.border = X.borde; hd.alignment = { horizontal: 'center', wrapText: true };
  ws.getRow(5).height = 32;
  for (let k = 0; k < 30; k++) {
    const r = 6 + k;
    ws.getCell(`A${r}`).value = { formula: `IF(Catalogo!A${5 + k}="","",Catalogo!A${5 + k})` }; X.estiloCelda(ws.getCell(`A${r}`), 'calc');
    for (let i = 0; i < 7; i++) { const L = String.fromCharCode(66 + i); ws.getCell(`${L}${r}`).value = { formula: `IF($A${r}="","",COUNTIFS(Registro!$B$5:$B$504,$A${r},Registro!$A$5:$A$504,$B$3+${i}))` }; X.estiloCelda(ws.getCell(`${L}${r}`), 'calc', '0'); ws.getCell(`${L}${r}`).alignment = { horizontal: 'center' }; }
    ws.getCell(`I${r}`).value = { formula: `IF($A${r}="","",COUNTIF(B${r}:H${r},">0"))` }; X.estiloCelda(ws.getCell(`I${r}`), 'calc', '0'); ws.getCell(`I${r}`).alignment = { horizontal: 'center' };
  }
  X.formatoCondicional(ws, 'B6:H35', 'AND(ISNUMBER(B6),B6>0)', { relleno: 'BFDCC6', color: COLOR.verde });
  X.formatoCondicional(ws, 'B6:H35', 'AND(ISNUMBER(B6),B6=0)', { relleno: 'EDEFEB', color: COLOR.gris, negrita: false });
  X.formatoCondicional(ws, 'I6:I35', 'AND(ISNUMBER($I6),$I6<3)', { relleno: COLOR.ambarClaro, color: '7A5200' });
  const encab = (c, t) => { const x = ws.getCell(c); x.value = t; x.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; x.fill = X.relleno(COLOR.verde); x.border = X.borde; };
  encab('K5', 'Tipo (esta semana)'); encab('L5', 'Actividades');
  TIPOS_ENR.forEach((t, i) => { const r = 6 + i; ws.getCell(`K${r}`).value = { formula: `Catalogo!D${5 + i}` }; ws.getCell(`L${r}`).value = { formula: `COUNTIFS(Registro!$C$5:$C$504,K${r},Registro!$A$5:$A$504,">="&$B$3,Registro!$A$5:$A$504,"<="&($B$3+6))` }; X.estiloCelda(ws.getCell(`K${r}`), 'calc'); X.estiloCelda(ws.getCell(`L${r}`), 'calc', '0'); });
  encab('K13', 'Respuesta (esta semana)'); encab('L13', 'Actividades');
  RESPUESTAS.forEach((t, i) => { const r = 14 + i; ws.getCell(`K${r}`).value = { formula: `Catalogo!F${5 + i}` }; ws.getCell(`L${r}`).value = { formula: `COUNTIFS(Registro!$F$5:$F$504,K${r},Registro!$A$5:$A$504,">="&$B$3,Registro!$A$5:$A$504,"<="&($B$3+6))` }; X.estiloCelda(ws.getCell(`K${r}`), 'calc'); X.estiloCelda(ws.getCell(`L${r}`), 'calc', '0'); });
  ws.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  return aBuffer(wb, [
    { hoja: 'Semana', tipo: 'barras', titulo: 'Actividades por tipo de enriquecimiento', tituloY: 'Actividades', series: [{ nombre: 'Actividades', categorias: 'Semana!$K$6:$K$10', valores: 'Semana!$L$6:$L$10', color: '1F5F3A' }], ancla: { col: 13, fila: 3, ancho: 7, alto: 15 } },
    { hoja: 'Semana', tipo: 'barras', titulo: 'Respuestas observadas', tituloY: 'Actividades', series: [{ nombre: 'Actividades', categorias: 'Semana!$K$14:$K$18', valores: 'Semana!$L$14:$L$18', color: 'E8A317' }], ancla: { col: 13, fila: 19, ancho: 7, alto: 15 } }
  ]);
}

/* ═════════════ 8. Control de alimentación por recinto ═════════════ */
async function controlAlimentacion() {
  const wb = X.libro('Control de alimentación por recinto', 'Registro de alimento ofrecido y sobrante por recinto con consumo y costo');
  X.instrucciones(wb, {
    titulo: 'Control de alimentación por recinto',
    para: 'Anota cuánto alimento se ofrece y cuánto sobra en cada recinto y la hoja calcula lo consumido, el porcentaje de consumo y el costo. Sirve para llevar el control de tu inventario de alimento y detectar cambios en el consumo que valga la pena comentar con tu médico veterinario. NO define dietas, raciones ni cantidades: eso lo hace el responsable técnico de cada especie.',
    hojas: [['Recintos', 'Tus recintos y cuántos animales hay en cada uno.'], ['Alimentos', 'Los alimentos que manejas, su unidad y su costo por unidad (opcional).'], ['Registro', 'Una fila por alimento ofrecido en un recinto en una fecha.'], ['Resumen', 'Totales por recinto en el periodo que elijas.']],
    pasos: ['En «Recintos» y «Alimentos» borra los EJEMPLOS y escribe los tuyos. El costo por unidad es opcional.', 'En «Registro» escribe la fecha, elige el recinto y el alimento, y escribe la cantidad ofrecida y la sobrante (en la unidad del alimento).',
      'La hoja calcula la cantidad consumida, el porcentaje consumido y el costo del alimento ofrecido.', 'En «Resumen» elige las fechas «Desde» y «Hasta» para ver los totales por recinto.', 'Si el consumo de un recinto cambia mucho respecto a lo habitual, avísalo a tu médico veterinario o biólogo responsable.'],
    notas: ['Las cantidades son las que tú registras: el libro no sugiere cantidades ni dietas.', 'Un porcentaje bajo de consumo no es un diagnóstico por sí solo: es una alerta para observar.']
  });
  const wr = X.hoja(wb, 'Recintos', { color: COLOR.dorado, congelar: { y: 4 } });
  X.banda(wr, 'Recintos', 'Zoorigen · Material de apoyo', 5);
  const rec = X.tabla(wr, [{ clave: 'cod', titulo: 'Recinto', ancho: 24 }, { clave: 'esp', titulo: 'Especie o grupo', ancho: 28 }, { clave: 'num', titulo: 'N.º de animales', ancho: 14, numero: { min: 0, max: 100000 } }, { clave: 'nota', titulo: 'Nota', ancho: 11 }], { filas: 50, columnaNota: 'nota', ejemplos: [
    { cod: 'Recinto 1 (ejemplo)', esp: 'Grupo A (ejemplo)', num: 4 }, { cod: 'Recinto 2 (ejemplo)', esp: 'Grupo B (ejemplo)', num: 2 }, { cod: 'Recinto 3 (ejemplo)', esp: 'Grupo C (ejemplo)', num: 6 }
  ] });
  void rec;
  const wa = X.hoja(wb, 'Alimentos', { color: COLOR.dorado, congelar: { y: 4 } });
  X.banda(wa, 'Alimentos', 'Zoorigen · Material de apoyo. El costo es opcional y ilustrativo en el ejemplo.', 5);
  X.tabla(wa, [{ clave: 'nom', titulo: 'Alimento', ancho: 28 }, { clave: 'uni', titulo: 'Unidad', ancho: 12, lista: ['kg', 'g', 'litro', 'pieza', 'porción'] }, { clave: 'cos', titulo: 'Costo por unidad', ancho: 16, formato: '#,##0.00', numero: { min: 0, max: 1e9 } }, { clave: 'nota', titulo: 'Nota', ancho: 11 }], { filas: 100, columnaNota: 'nota', ejemplos: [
    { nom: 'Alimento A (ejemplo)', uni: 'kg', cos: 30 }, { nom: 'Alimento B (ejemplo)', uni: 'kg', cos: 55 }, { nom: 'Alimento C (ejemplo)', uni: 'pieza', cos: 4.5 }
  ] });
  const wg = X.hoja(wb, 'Registro', { congelar: { x: 1, y: 4 } });
  X.banda(wg, 'Registro de alimentación', 'Zoorigen · Material de apoyo. Una fila por alimento y recinto.', 12);
  const reg = X.tabla(wg, [
    { clave: 'fec', titulo: 'Fecha', ancho: 13, formato: FMT_FECHA, fecha: true }, { clave: 'rec', titulo: 'Recinto', ancho: 24, lista: 'Recintos!$A$5:$A$54' }, { clave: 'ali', titulo: 'Alimento', ancho: 26, lista: 'Alimentos!$A$5:$A$104' },
    { clave: 'uni', titulo: 'Unidad', ancho: 9, tipo: 'calc', formula: (r, m) => `IF(${m.ali}${r}="","",IFERROR(INDEX(Alimentos!$B$5:$B$104,MATCH(${m.ali}${r},Alimentos!$A$5:$A$104,0)),""))` },
    { clave: 'ofr', titulo: 'Cantidad ofrecida', ancho: 12, formato: '#,##0.##', numero: { min: 0, max: 1e7 } }, { clave: 'sob', titulo: 'Cantidad sobrante', ancho: 12, formato: '#,##0.##', numero: { min: 0, max: 1e7 } },
    { clave: 'con', titulo: 'Consumida', ancho: 11, tipo: 'calc', formato: '#,##0.##', formula: (r, m) => `IF(OR(${m.ofr}${r}="",${m.sob}${r}=""),"",${m.ofr}${r}-${m.sob}${r})` },
    { clave: 'pct', titulo: '% consumido', ancho: 11, tipo: 'calc', formato: '0%', formula: (r, m) => `IF(OR(${m.con}${r}="",${m.ofr}${r}="",${m.ofr}${r}=0),"",${m.con}${r}/${m.ofr}${r})` },
    { clave: 'cos', titulo: 'Costo ofrecido', ancho: 13, tipo: 'calc', formato: '#,##0.00', formula: (r, m) => `IF(OR(${m.ofr}${r}="",${m.ali}${r}=""),"",IFERROR(${m.ofr}${r}*INDEX(Alimentos!$C$5:$C$104,MATCH(${m.ali}${r},Alimentos!$A$5:$A$104,0)),""))` },
    { clave: 'res', titulo: 'Responsable', ancho: 16 }, { clave: 'obs', titulo: 'Observaciones', ancho: 26 }, { clave: 'nota', titulo: 'Nota', ancho: 11 }
  ], { filas: 800, columnaNota: 'nota', altoCab: 32, ejemplos: [
    { fec: d(-6), rec: 'Recinto 1 (ejemplo)', ali: 'Alimento A (ejemplo)', ofr: 8, sob: 1, res: 'Nombre' }, { fec: d(-6), rec: 'Recinto 2 (ejemplo)', ali: 'Alimento B (ejemplo)', ofr: 3, sob: 0.2, res: 'Nombre' },
    { fec: d(-5), rec: 'Recinto 1 (ejemplo)', ali: 'Alimento A (ejemplo)', ofr: 8, sob: 2.5, res: 'Nombre', obs: 'Sobró más de lo habitual (ejemplo)' }, { fec: d(-5), rec: 'Recinto 3 (ejemplo)', ali: 'Alimento C (ejemplo)', ofr: 24, sob: 2, res: 'Nombre' },
    { fec: d(-4), rec: 'Recinto 2 (ejemplo)', ali: 'Alimento B (ejemplo)', ofr: 3, sob: 0.1, res: 'Nombre' }, { fec: d(-3), rec: 'Recinto 3 (ejemplo)', ali: 'Alimento C (ejemplo)', ofr: 24, sob: 5, res: 'Nombre' }
  ] });
  X.formatoCondicional(wg, `H${reg.primera}:H${reg.ultima}`, `AND(ISNUMBER($H${reg.primera}),$H${reg.primera}<0.6)`, { relleno: COLOR.ambarClaro, color: '7A5200' });
  wg.autoFilter = `A${reg.fila0}:L${reg.ultima}`;
  const rs = X.hoja(wb, 'Resumen', { color: COLOR.dorado });
  X.banda(rs, 'Resumen por recinto', 'Elige el periodo.', 8);
  rs.columns = [{ width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 16 }];
  X.parametro(rs, 'A3', 'B3', 'Desde', d(-10), FMT_FECHA); X.parametro(rs, 'C3', 'D3', 'Hasta', d(0), FMT_FECHA);
  ['Recinto', 'Ofrecido', 'Sobrante', 'Consumido', '% consumido', 'Costo ofrecido'].forEach((h, i) => { const c = rs.getCell(5, i + 1); c.value = h; c.font = { bold: true, color: { argb: X.argb(COLOR.blanco) } }; c.fill = X.relleno(COLOR.verde); c.border = X.borde; c.alignment = { horizontal: 'center' }; });
  const crit = '"<="&$D$3';
  for (let k = 0; k < 20; k++) {
    const r = 6 + k;
    rs.getCell(`A${r}`).value = { formula: `IF(Recintos!A${5 + k}="","",Recintos!A${5 + k})` };
    rs.getCell(`B${r}`).value = { formula: `IF($A${r}="","",SUMIFS(Registro!$E$5:$E$804,Registro!$B$5:$B$804,$A${r},Registro!$A$5:$A$804,">="&$B$3,Registro!$A$5:$A$804,${crit}))` };
    rs.getCell(`C${r}`).value = { formula: `IF($A${r}="","",SUMIFS(Registro!$F$5:$F$804,Registro!$B$5:$B$804,$A${r},Registro!$A$5:$A$804,">="&$B$3,Registro!$A$5:$A$804,${crit}))` };
    rs.getCell(`D${r}`).value = { formula: `IF($A${r}="","",B${r}-C${r})` };
    rs.getCell(`E${r}`).value = { formula: `IF(OR($A${r}="",B${r}=0),"",D${r}/B${r})` };
    rs.getCell(`F${r}`).value = { formula: `IF($A${r}="","",SUMIFS(Registro!$I$5:$I$804,Registro!$B$5:$B$804,$A${r},Registro!$A$5:$A$804,">="&$B$3,Registro!$A$5:$A$804,${crit}))` };
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach(c => X.estiloCelda(rs.getCell(`${c}${r}`), 'calc', c === 'A' ? null : (c === 'E' ? '0%' : (c === 'F' ? '#,##0.00' : '#,##0.##'))));
  }
  X.etiqueta(rs, 'A27', 'Nota: las cantidades de recintos con alimentos en distintas unidades se suman tal como las escribas; úsalo con alimentos de la misma unidad o revisa «Registro».', { negrita: false, color: COLOR.gris });
  rs.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  return aBuffer(wb, [{ hoja: 'Resumen', tipo: 'barras', titulo: 'Costo del alimento ofrecido por recinto', tituloY: 'Costo', formatoY: '#,##0', series: [{ nombre: 'Costo ofrecido', categorias: 'Resumen!$A$6:$A$15', valores: 'Resumen!$F$6:$F$15', color: '1F5F3A' }], ancla: { col: 7, fila: 3, ancho: 7, alto: 16 } }]);
}

module.exports = {
  libros: [
    { id: 'inventario-botiquin-caducidad', construir: inventarioBotiquin },
    { id: 'libro-entradas-salidas-insumos', construir: libroEntradasSalidas },
    { id: 'peso-curva-crecimiento', construir: pesoCurva },
    { id: 'calendario-preventivo-protocolo', construir: calendarioPreventivo },
    { id: 'registro-ingresos-bajas-traslados', construir: registroMovimientos },
    { id: 'presupuesto-anual-uma-zoologico', construir: presupuestoAnual },
    { id: 'bitacora-enriquecimiento-semanal', construir: bitacoraEnriquecimiento },
    { id: 'control-alimentacion-recintos', construir: controlAlimentacion }
  ]
};
