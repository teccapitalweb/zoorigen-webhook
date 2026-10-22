'use strict';

// Contenido de los 7 PDF nuevos. Texto original de Zoorigen; solo formatos, listas de verificación y guías de organización.
// Nada de dosis, tratamientos ni interpretación clínica. Lo normativo se redacta de forma general («consulta la norma vigente»);
// lo verificado se cita con su fuente. `revision`: afirmaciones delicadas con su fuente y confianza (alto | medio);
// las «medio» las debe revisar una persona especialista (`revisar`) antes de publicar.

const LGVS = 'Ley General de Vida Silvestre, Cámara de Diputados (texto vigente): diputados.gob.mx/LeyesBiblio';
const LFSA = 'Ley Federal de Sanidad Animal, Cámara de Diputados (texto vigente): diputados.gob.mx/LeyesBiblio';
const NOM087 = 'Catálogo Mexicano de Normas (Secretaría de Economía, PLATIICA): NOM-087-SEMARNAT-SSA1-2002, residuos peligrosos biológico-infecciosos';
const MELLOR = 'Mellor DJ et al. (2020). The 2020 Five Domains Model. Animals 10(10):1870';

const docs = [];

/* ═════════ 1. Cuarentena y recepción de ejemplares ═════════ */
docs.push({
  id: 'cuarentena-recepcion-ejemplares', archivo: 'cuarentena-recepcion-ejemplares.pdf', tipo: 'checklist', papel: 'Letter', motivo: 'escudo',
  etiqueta: 'Sanidad y manejo', titulo: 'Protocolo de cuarentena y recepción de ejemplares', subtitulo: 'Lista de verificación y formatos de registro. Solo organización: sin tratamientos ni diagnósticos.',
  area: 'Sanidad y manejo de fauna silvestre', paraQuien: 'Personal de UMA, PIMVS, zoológicos y centros; médicos veterinarios', acceso: 'miembros', revisar: ['médico veterinario'],
  descripcionCorta: 'Lista de verificación para antes, durante y después de recibir un ejemplar, más el formato de registro de recepción y la bitácora diaria de cuarentena. Solo organización: sin tratamientos.',
  intro: 'Ordena la llegada de un ejemplar nuevo: qué preparar, qué revisar al recibirlo, qué anotar cada día y quién decide cuándo termina la cuarentena.',
  secciones: [
    { titulo: 'Para qué sirve este documento', etiqueta: 'Introducción', bloques: [
      { t: 'p', texto: 'La cuarentena es un aislamiento preventivo con observación de los animales recién llegados antes de mezclarlos con otros. Este documento te ayuda a organizarla: qué preparar, qué revisar, qué registrar y quién responde de cada paso.' },
      { t: 'p', texto: 'No incluye diagnósticos, tratamientos, dosis ni criterios clínicos. La duración, las revisiones y las decisiones médicas las define el médico veterinario responsable de tu instalación según la especie y el caso.' },
      { t: 'aviso', texto: 'La Ley General de Vida Silvestre señala que, cuando proceda la cuarentena de fauna silvestre, se mantenga a los ejemplares en condiciones adecuadas a sus necesidades (art. 33). Consulta la versión vigente de la norma.' }
    ] },
    { titulo: 'Antes de que llegue el ejemplar', etiqueta: 'Paso 1', bloques: [
      { t: 'casillas', items: ['Se revisó el documento que respalda el origen legal del ejemplar.', 'Se verificó si el traslado requiere autorización y que esté vigente.', 'El área de cuarentena está separada del resto, limpia y lista.', 'Hay equipo y utensilios exclusivos para esa área.', 'Se designó a una persona responsable y a su suplente.', 'El médico veterinario responsable está enterado de la fecha y hora de llegada.', 'El transporte está coordinado y hay quien reciba al ejemplar.', 'El formato de registro de recepción está impreso o disponible.'] }
    ] },
    { titulo: 'Al recibir al ejemplar', etiqueta: 'Paso 2', bloques: [
      { t: 'casillas', items: ['Se verificó la identidad del ejemplar (marca, anillo u otra identificación) contra los documentos.', 'Se registró fecha, hora y condiciones en que llegó el transporte.', 'Se tomaron fotografías del ejemplar y del embalaje.', 'Se avisó al médico veterinario responsable.', 'Se llevó directamente al área de cuarentena, sin pasar por otras áreas.', 'Se limpió el transportador y el área de descarga.', 'Se llenó el formato de recepción (sección 5).'] }
    ] },
    { titulo: 'Durante la cuarentena', etiqueta: 'Paso 3', bloques: [
      { t: 'ul', items: ['Una persona o equipo exclusivo atiende el área, siempre al final del recorrido del día.', 'Cada día se llena la bitácora (sección 6) con lo que se observa, sin interpretarlo.', 'Cualquier cambio inusual se avisa de inmediato al médico veterinario responsable.', 'Ropa, calzado, utensilios y herramientas del área no salen de ella sin limpiarse.', 'Los residuos se manejan según el plan de la instalación y la normatividad vigente.'] }
    ] },
    { titulo: 'Salida de la cuarentena', etiqueta: 'Paso 4', bloques: [
      { t: 'casillas', items: ['El médico veterinario responsable autorizó la salida por escrito.', 'La bitácora está completa hasta el último día.', 'Se registró fecha, hora y destino dentro de la instalación.', 'Se limpió el área de cuarentena antes de recibir a otro ejemplar.', 'Se archivó el expediente completo del ejemplar (documentos, fotografías y registros).'] }
    ] },
    { titulo: 'Formato: registro de recepción', etiqueta: 'Formato 5', nueva: true, bloques: [
      { t: 'campos', columnas: 2, items: ['Fecha de llegada', 'Hora de llegada', 'Especie (nombre común y científico)', 'Identificación o marca', 'Sexo', 'Edad aproximada o estado de desarrollo', 'Procedencia', 'Documento que respalda el origen', 'Autorización de traslado (si aplica)', 'Persona que entrega', 'Persona que recibe', 'Médico veterinario avisado (nombre y hora)'] },
      { t: 'sub', texto: 'Condiciones del transporte y del ejemplar al llegar (descripción libre)' },
      { t: 'lineas', n: 4 },
      { t: 'sub', texto: 'Observaciones' }, { t: 'lineas', n: 3 },
      { t: 'campos', columnas: 2, items: ['Firma de quien recibe', 'Firma del médico veterinario responsable'] }
    ] },
    { titulo: 'Formato: bitácora diaria de cuarentena', etiqueta: 'Formato 6', nueva: true, bloques: [
      { t: 'p', texto: 'Escribe lo que observas con tus palabras y con los mismos criterios cada día. No interpretes: describe. Avisa al médico veterinario ante cualquier duda.' },
      { t: 'campos', columnas: 3, items: ['Ejemplar (identificación)', 'Especie', 'Fecha de inicio de cuarentena'] },
      { t: 'registro', cab: ['Fecha', 'Hora', 'Quién observa', 'Consumo de alimento y agua (describir)', 'Comportamiento (describir)', 'Otras observaciones', '¿Se avisó al MVZ?'], anchos: ['9%', '7%', '12%', '20%', '20%', '22%', '10%'], filas: 14 }
    ] }
  ],
  fuentes: [LGVS + ' (art. 33)', LFSA + ' (definición de cuarentena y bioseguridad)', 'Criterios de organización: elaboración propia de Zoorigen'],
  revision: [
    { afirmacion: 'Cuando proceda la cuarentena de fauna silvestre, se adoptan medidas para mantener a los ejemplares en condiciones adecuadas a sus necesidades.', fuente: 'Ley General de Vida Silvestre, art. 33', confianza: 'alto' },
    { afirmacion: 'La lista de pasos, la bitácora y los criterios de organización son redacción propia de Zoorigen, sin duración ni criterios clínicos.', fuente: 'Criterio editorial', confianza: 'medio' },
    { afirmacion: 'No se incluyen duraciones de cuarentena, pruebas diagnósticas ni tratamientos: los define el médico veterinario responsable.', fuente: 'Omisión deliberada', confianza: 'alto' }
  ]
});

/* ═════════ 2. Necropsia y registro de mortalidad ═════════ */
docs.push({
  id: 'formato-necropsia-mortalidad', archivo: 'formato-necropsia-mortalidad.pdf', tipo: 'plantilla', papel: 'Letter', motivo: 'registro',
  etiqueta: 'Registro y trazabilidad', titulo: 'Formato de necropsia y registro de mortalidad', subtitulo: 'Campos y lista de documentación. Sin interpretación clínica.',
  area: 'Registro y trazabilidad de fauna silvestre', paraQuien: 'Médicos veterinarios, responsables de UMA, zoológicos y centros', acceso: 'miembros', revisar: ['médico veterinario'],
  descripcionCorta: 'Formato imprimible con los campos de un registro de necropsia, la lista de documentación a reunir y la tabla anual de mortalidad. Sin interpretación clínica: la hace el médico veterinario.',
  intro: 'Ordena la información cuando muere un animal: qué anotar, qué documentar, quién interviene y cómo llevar el registro anual de mortalidad.',
  secciones: [
    { titulo: 'Propósito y alcance', etiqueta: 'Introducción', bloques: [
      { t: 'p', texto: 'La necropsia debe realizarla un médico veterinario. Este formato ordena los datos y la documentación alrededor del hecho; no sugiere causas, no interpreta hallazgos y no sustituye el informe del profesional.' },
      { t: 'aviso', texto: 'Los residuos biológico-infecciosos de atención veterinaria se rigen por la NOM-087-SEMARNAT-SSA1-2002 (vigente). Consulta la norma vigente y tu plan de manejo de residuos para el destino de los restos.' }
    ] },
    { titulo: 'Primeras acciones de organización', etiqueta: 'Paso 1', bloques: [
      { t: 'casillas', items: ['Se avisó al médico veterinario responsable y al responsable de la unidad.', 'Se identificó al ejemplar (marca, anillo u otro) y se tomaron fotografías.', 'Se anotaron fecha, hora y lugar del hallazgo, y quién lo encontró.', 'Se evitó manipular más de lo necesario y se protegió el área.', 'Se anotaron las condiciones ambientales y cualquier evento reciente del recinto.', 'Se separó el cuerpo y se registró dónde queda mientras se decide su destino.'] }
    ] },
    { titulo: 'Documentación que conviene reunir', etiqueta: 'Paso 2', bloques: [
      { t: 'casillas', items: ['Identificación o marca y ficha del ejemplar.', 'Documento de legal procedencia (copia) y registro de ingreso.', 'Historial reciente: cambios de manejo, traslados, observaciones.', 'Registros de alimentación y de observación de los últimos días.', 'Fotografías del hallazgo y del ejemplar.', 'Registro de notificaciones realizadas (a quién y cuándo).', 'Cadena de custodia de las muestras, si se tomaron.', 'Informe del médico veterinario, cuando esté disponible.', 'Anotación de la baja en el inventario o libro de registro de ejemplares.'] }
    ] },
    { titulo: 'Formato: registro de necropsia', etiqueta: 'Formato 3', nueva: true, bloques: [
      { t: 'campos', columnas: 2, items: ['Fecha del hallazgo', 'Hora del hallazgo', 'Especie (nombre común y científico)', 'Identificación o marca', 'Sexo', 'Edad aproximada o estado de desarrollo', 'Recinto o ubicación', 'Quién lo encontró', 'Fecha y hora de la necropsia', 'Médico veterinario responsable', 'Lugar de la necropsia', 'Personas presentes'] },
      { t: 'sub', texto: 'Antecedentes relevantes (descripción libre, tal como se conocen)' }, { t: 'lineas', n: 4 },
      { t: 'sub', texto: 'Hallazgos descritos por el médico veterinario' }, { t: 'lineas', n: 8 },
      { t: 'sub', texto: 'Muestras tomadas' },
      { t: 'registro', cab: ['Tipo de muestra', 'Identificador', 'Hora', 'Quién la tomó', 'Destino (laboratorio u otro)'], anchos: ['26%', '16%', '10%', '20%', '28%'], filas: 5 },
      { t: 'sub', texto: 'Conclusiones o diagnóstico (a cargo del médico veterinario)' }, { t: 'lineas', n: 4 },
      { t: 'sub', texto: 'Destino de los restos (según el plan de la instalación y la normatividad vigente)' }, { t: 'lineas', n: 2 },
      { t: 'campos', columnas: 2, items: ['Firma del médico veterinario', 'Firma del responsable de la unidad'] }
    ] },
    { titulo: 'Registro anual de mortalidad', etiqueta: 'Formato 4', nueva: true, bloques: [
      { t: 'campos', columnas: 2, items: ['Unidad o instalación', 'Año'] },
      { t: 'registro', cab: ['Fecha', 'Ejemplar (ID)', 'Especie', 'Edad / etapa', 'Causa registrada por el MVZ', 'Documento de baja', 'Observaciones'], anchos: ['9%', '12%', '17%', '10%', '21%', '14%', '17%'], filas: 16 },
      { t: 'p', texto: 'Al terminar el año, cuenta los registros por especie y compáralos con tu libro de ingresos, bajas y traslados: las cifras deben coincidir.' }
    ] }
  ],
  fuentes: [NOM087, LGVS + ' (legal procedencia, art. 51: documentación del origen del ejemplar)', 'Estructura del formato: elaboración propia de Zoorigen'],
  revision: [
    { afirmacion: 'Los residuos de atención veterinaria clasificados como biológico-infecciosos se rigen por la NOM-087-SEMARNAT-SSA1-2002 (vigente).', fuente: 'Catálogo Mexicano de Normas (PLATIICA)', confianza: 'alto' },
    { afirmacion: 'Los campos del formato y la lista de documentación son criterio de organización de Zoorigen; la necropsia y su interpretación corresponden al médico veterinario.', fuente: 'Criterio editorial', confianza: 'medio' },
    { afirmacion: 'No se mencionan procedimientos de necropsia, causas de muerte ni criterios de eutanasia.', fuente: 'Omisión deliberada', confianza: 'alto' }
  ]
});

/* ═════════ 3. Plantilla de Plan de manejo de una UMA ═════════ */
const apartadoPlan = (n, titulo, guia, campos, extra = []) => ({ titulo: `${n}. ${titulo}`, etiqueta: 'Apartado ' + n, junta: true, bloques: [{ t: 'p', texto: guia }, ...(campos ? [{ t: 'campos', columnas: 2, items: campos }] : []), ...extra] });
docs.push({
  id: 'plantilla-plan-manejo-uma', archivo: 'plantilla-plan-manejo-uma.pdf', tipo: 'plantilla', papel: 'Letter', motivo: 'plan',
  etiqueta: 'Normatividad de vida silvestre', titulo: 'Plantilla de Plan de manejo de una UMA', subtitulo: 'Estructura, índice y guía de llenado para ordenar tu información.',
  area: 'Normatividad de vida silvestre', paraQuien: 'Responsables técnicos de UMA, consultores y estudiantes', acceso: 'retos', requiereRetos: 6, revisar: ['abogado', 'biólogo'],
  descripcionCorta: 'Plantilla para ordenar la información de un plan de manejo de UMA: índice propuesto, guía de llenado por apartado y listas de anexos. No sustituye los términos de referencia oficiales de la autoridad.',
  avisoInicial: 'Este documento ordena tu información. La estructura, los términos de referencia y los requisitos oficiales del plan de manejo los publica y actualiza la autoridad: úsalos como referencia principal. Aquí no se afirma que estos apartados sean los exigidos.',
  intro: 'Un plan de manejo es el documento técnico operativo de una UMA: describe y programa actividades, y establece metas e indicadores de éxito. Aquí tienes una forma de ordenar la información.',
  secciones: [
    { titulo: 'Cómo usar esta plantilla', etiqueta: 'Introducción', bloques: [
      { t: 'p', texto: 'La Ley General de Vida Silvestre describe el plan de manejo como el documento técnico operativo de una UMA, sujeto a aprobación de la Secretaría, que describe y programa las actividades para manejar especies silvestres y sus hábitats, y establece metas e indicadores de éxito.' },
      { t: 'p', texto: 'Esta plantilla propone doce apartados para reunir y ordenar tu información antes de escribir el plan en el formato oficial. Cada apartado trae una guía de llenado y espacios para anotar. Los apartados son una propuesta de organización, no una lista de requisitos.' },
      { t: 'aviso', texto: 'Antes de redactar tu plan, consulta los términos de referencia vigentes de la autoridad y, si lo necesitas, a un asesor con experiencia en UMA.' }
    ] },
    apartadoPlan(1, 'Datos generales', 'Identifica la UMA, a quien responde de ella y cómo contactarla.', ['Nombre de la UMA', 'Clave o número de registro (si ya lo tienes)', 'Persona titular', 'Responsable técnico', 'Domicilio o ubicación', 'Teléfono y correo']),
    apartadoPlan(2, 'Ubicación y descripción del predio', 'Describe dónde está, qué superficie tiene, qué hay alrededor y cómo es el sitio (clima, vegetación, agua, infraestructura). Incluye un croquis o mapa.', ['Superficie', 'Coordenadas de referencia', 'Colindancias', 'Tipo de vegetación y clima (descripción)'], [{ t: 'lineas', etiqueta: 'Descripción general', n: 4 }]),
    apartadoPlan(3, 'Especies de interés', 'Lista las especies con las que trabajarás, con nombre común y científico y el estatus de riesgo que consultes en la norma vigente. Anota de dónde viene cada ejemplar o población.', null, [{ t: 'registro', cab: ['Nombre común', 'Nombre científico', 'Estatus de riesgo (consulta la norma vigente)', 'Origen de los ejemplares o población'], anchos: ['22%', '24%', '28%', '26%'], filas: 6 }]),
    apartadoPlan(4, 'Objetivos', 'Escribe qué quieres lograr con la UMA, en pocas frases claras.', null, [{ t: 'lineas', n: 5 }]),
    apartadoPlan(5, 'Metas e indicadores de éxito', 'Cada meta debe poder verificarse. Define para cada una cómo sabrás que se cumplió (indicador), con qué periodicidad lo medirás y quién lo mide.', null, [{ t: 'registro', cab: ['Meta', 'Indicador', 'Cómo se mide', 'Periodicidad', 'Responsable'], anchos: ['26%', '22%', '22%', '14%', '16%'], filas: 6 }]),
    apartadoPlan(6, 'Actividades y calendario', 'Enumera las actividades de manejo y cuándo se harán. Relaciona cada una con una meta.', null, [{ t: 'registro', cab: ['Actividad', 'Meta relacionada', 'Fecha o periodo', 'Responsable', 'Recursos necesarios'], anchos: ['28%', '18%', '16%', '17%', '21%'], filas: 7 }], ),
    apartadoPlan(7, 'Seguimiento del hábitat y de las poblaciones', 'Una UMA mantiene un seguimiento permanente del hábitat y de las poblaciones. Describe qué vas a observar, con qué método, cada cuándo y cómo guardarás los datos.', null, [{ t: 'lineas', etiqueta: 'Qué se monitorea y con qué método', n: 4 }, { t: 'lineas', etiqueta: 'Cada cuándo y quién', n: 3 }]),
    apartadoPlan(8, 'Manejo y bienestar de los ejemplares', 'Describe cómo se alimentará, alojará y manejará a los animales, de forma que se evite dolor, deterioro físico o sufrimiento (trato digno y respetuoso). Incluye personal capacitado y registros.', null, [{ t: 'lineas', n: 5 }]),
    apartadoPlan(9, 'Sanidad y bioseguridad', 'Anota quién es el médico veterinario o responsable sanitario, qué medidas de bioseguridad aplicarás y cómo registrarás la cuarentena, la limpieza y los incidentes.', null, [{ t: 'lineas', n: 4 }]),
    apartadoPlan(10, 'Registros e inventarios', 'Define qué libros o registros llevarás: inventario de ejemplares, ingresos, bajas, traslados, mortalidad y eventos. Indica quién los llena y cuándo se revisan.', null, [{ t: 'lineas', n: 3 }]),
    apartadoPlan(11, 'Personal, capacitación y seguridad', 'Lista a las personas que participan, su función, su capacitación y las medidas de seguridad para ellas y para los visitantes, si los hay.', null, [{ t: 'registro', cab: ['Nombre', 'Función', 'Capacitación', 'Medidas de seguridad'], anchos: ['26%', '22%', '26%', '26%'], filas: 5 }]),
    apartadoPlan(12, 'Riesgos y contingencias', 'Piensa qué podría salir mal (fuga, enfermedad, clima, falta de recursos) y qué harás, quién decide y a quién avisas.', null, [{ t: 'registro', cab: ['Riesgo', 'Qué se hace', 'Quién decide', 'A quién se avisa'], anchos: ['24%', '36%', '20%', '20%'], filas: 5 }]),
    { titulo: 'Lista de anexos que conviene reunir', etiqueta: 'Anexos', nueva: true, bloques: [
      { t: 'p', texto: 'Marca lo que ya tienes. La lista es una sugerencia de organización: confirma con la autoridad qué documentos te pide en tu caso.' },
      { t: 'casillas', items: ['Documento que acredita la posesión o el uso legal del predio.', 'Identificación de la persona titular y del responsable técnico.', 'Croquis o mapa del predio con sus áreas.', 'Documentación de legal procedencia de los ejemplares (si ya los hay).', 'Inventario de ejemplares.', 'Fotografías del predio e infraestructura.', 'Currículum o constancia del responsable técnico.', 'Cualquier otra constancia o permiso que te indique la autoridad.'] }
    ] }
  ],
  fuentes: [LGVS + ' (arts. 3 y 39: UMA y plan de manejo)', 'Reglamento de la Ley General de Vida Silvestre, Cámara de Diputados (texto vigente): diputados.gob.mx/LeyesBiblio', 'Términos de referencia y formatos oficiales: consúltalos en el sitio de la autoridad (SEMARNAT)'],
  revision: [
    { afirmacion: 'Plan de manejo: documento técnico operativo de una UMA, sujeto a aprobación de la Secretaría, que describe y programa actividades y establece metas e indicadores de éxito. UMA: opera con seguimiento permanente de hábitat y poblaciones.', fuente: 'Ley General de Vida Silvestre (arts. 3 y 39)', confianza: 'alto' },
    { afirmacion: 'Los doce apartados y la lista de anexos son una propuesta de organización de Zoorigen: no se afirma que sean los exigidos por la autoridad.', fuente: 'Criterio editorial; requiere revisión de un abogado y de un biólogo con experiencia en UMA', confianza: 'medio' },
    { afirmacion: 'No se citan formatos ni requisitos oficiales que no se verificaron; se remite a los términos de referencia vigentes de la autoridad.', fuente: 'Omisión deliberada', confianza: 'alto' }
  ]
});

/* ═════════ 4. Etograma y hoja de observación conductual ═════════ */
docs.push({
  id: 'etograma-hoja-observacion', archivo: 'etograma-hoja-observacion.pdf', tipo: 'plantilla', papel: 'Letter', motivo: 'ojo',
  etiqueta: 'Comportamiento animal', titulo: 'Etograma y hoja de observación conductual', subtitulo: 'Instrucciones y formatos para observar y registrar conducta con método.',
  area: 'Comportamiento animal', paraQuien: 'Biólogos, cuidadores, estudiantes y personal de bienestar', acceso: 'miembros', revisar: ['biólogo'],
  descripcionCorta: 'Instrucciones, etograma en blanco y tres hojas de registro (muestreo focal, de barrido y conteo de eventos) para observar conducta con método.',
  intro: 'Todo lo necesario para empezar a observar conducta: cómo definir tus conductas, un etograma en blanco y hojas listas para imprimir.',
  secciones: [
    { titulo: 'Cómo usar este documento', etiqueta: 'Instrucciones', bloques: [
      { t: 'ol', items: ['Elige una pregunta sencilla (por ejemplo, ¿cuánto tiempo descansa el grupo por la mañana?).', 'Define tus conductas en el etograma (sección 2): nombre, código y una definición que se pueda observar, sin interpretar emociones.', 'Elige el método: focal (sigues a un individuo), de barrido (revisas al grupo a intervalos) o de conteo de eventos.', 'Practica con otra persona hasta que ambas anoten lo mismo en la misma situación.', 'Observa en distintos días y horarios, con las mismas condiciones, y anota fecha, hora, clima y observador.', 'Resume tus datos: tiempo en cada conducta ÷ tiempo total observado, o número de eventos ÷ horas observadas.'] },
      { t: 'aviso', texto: 'Observar no es diagnosticar. Si ves cambios inusuales, anótalos y coméntalos con tu médico veterinario o tu equipo de bienestar.' }
    ] },
    { titulo: 'Etograma en blanco', etiqueta: 'Formato 2', nueva: true, bloques: [
      { t: 'campos', columnas: 2, items: ['Especie', 'Sitio o recinto', 'Elaborado por', 'Fecha'] },
      { t: 'registro', cab: ['Código', 'Conducta', 'Definición observable', 'Evento o estado', 'No confundir con…'], anchos: ['9%', '16%', '38%', '12%', '25%'], filas: 12 },
      { t: 'p', texto: 'Evento: conducta breve que se cuenta. Estado: conducta que dura y de la que se mide el tiempo.' }
    ] },
    { titulo: 'Hoja de muestreo focal', etiqueta: 'Formato 3', nueva: true, bloques: [
      { t: 'campos', columnas: 3, items: ['Especie', 'Individuo observado', 'Observador', 'Fecha', 'Hora de inicio y fin', 'Clima y condiciones'] },
      { t: 'p', texto: 'Cada renglón es un intervalo. Anota el código de la conducta que ocurre en ese momento (o marca las columnas de tus conductas).' },
      { t: 'registro', cab: ['Minuto', 'Código de la conducta', 'Notas', 'Minuto', 'Código de la conducta', 'Notas'], anchos: ['8%', '22%', '20%', '8%', '22%', '20%'], filas: 15 }
    ] },
    { titulo: 'Hoja de muestreo de barrido', etiqueta: 'Formato 4', nueva: true, bloques: [
      { t: 'campos', columnas: 3, items: ['Especie y grupo', 'Observador', 'Fecha', 'Intervalo entre barridos', 'Hora de inicio y fin', 'Clima y condiciones'] },
      { t: 'p', texto: 'En cada barrido, anota el código de la conducta de cada individuo en el momento exacto del barrido.' },
      { t: 'registro', cab: ['Hora del barrido', 'Individuo 1', 'Individuo 2', 'Individuo 3', 'Individuo 4', 'Individuo 5', 'Individuo 6'], anchos: ['16%', '14%', '14%', '14%', '14%', '14%', '14%'], filas: 14 }
    ] },
    { titulo: 'Hoja de conteo de eventos', etiqueta: 'Formato 5', nueva: true, bloques: [
      { t: 'campos', columnas: 3, items: ['Especie y grupo', 'Observador', 'Fecha', 'Hora de inicio y fin', 'Total de horas observadas', 'Clima y condiciones'] },
      { t: 'registro', cab: ['Código', 'Evento', 'Marcas de conteo', 'Total', 'Notas'], anchos: ['10%', '24%', '36%', '10%', '20%'], filas: 12 },
      { t: 'p', texto: 'Frecuencia = total de eventos ÷ horas observadas.' }
    ] }
  ],
  fuentes: ['Altmann J. (1974). Observational study of behavior: sampling methods. Behaviour 49(3-4):227-267', 'Formatos y recomendaciones: elaboración propia de Zoorigen'],
  revision: [
    { afirmacion: 'Los métodos de muestreo focal, de barrido y de conteo de eventos corresponden a los descritos en Altmann (1974).', fuente: 'Altmann J. (1974), Behaviour 49(3-4):227-267 (verificar la cita en la fuente original)', confianza: 'medio' },
    { afirmacion: 'Las recomendaciones de práctica y los formatos son criterio de Zoorigen.', fuente: 'Criterio editorial', confianza: 'medio' }
  ]
});

/* ═════════ 5. Carteles imprimibles (A4) ═════════ */
docs.push({
  id: 'carteles-visitantes-senales', archivo: 'carteles-visitantes-senales.pdf', tipo: 'infografia', papel: 'A4', carteles: true,
  etiqueta: 'Visitantes y señalización', titulo: 'Carteles imprimibles para visitantes y señales de zona', subtitulo: 'Seis carteles A4 con mensajes generales, listos para imprimir.',
  area: 'Visitantes y señalización', paraQuien: 'Zoológicos, UMA con visitantes, centros educativos y de rescate', acceso: 'miembros', revisar: [],
  descripcionCorta: 'Seis carteles A4 para imprimir: normas para visitantes, no alimentar, zona solo para personal, lavado de manos, mantener la distancia y cuidado del lugar. Mensajes generales con espacio para tu información.',
  carteles: [
    { etiqueta: 'Visitantes', icono: 'lista', titulo: 'Normas para visitantes', sub: 'Gracias por cuidar a los animales y a las demás personas.', items: ['Respeta las indicaciones del personal y los letreros.', 'Mantén tu distancia de los animales.', 'No alimentes ni toques a los animales.', 'Cuida a niñas y niños de tu grupo.', 'Usa los botes de basura.', 'Lávate las manos al salir.'], campos: ['Horario de visita', 'Contacto o emergencias'], pie: 'Adapta las normas al reglamento de tu instalación.' },
    { etiqueta: 'Aviso', icono: 'alto', color: '#' + 'B42318', titulo: 'No alimentes a los animales', sub: 'Su alimentación está cuidada por el equipo de la instalación.', items: ['Dar alimento puede dañar su salud.', 'No lances objetos a los recintos.', 'Si ves algo extraño, avisa al personal.'], campos: ['Contacto del personal'], pie: 'Gracias por ayudarnos a cuidarlos.' },
    { etiqueta: 'Restringido', icono: 'alto', color: '#' + 'C75402', titulo: 'Zona solo para personal autorizado', sub: 'Por la seguridad de las personas y de los animales.', items: ['No pases de este punto sin autorización.', 'Si necesitas algo, pregunta al personal.', 'Las visitas solo con acompañamiento.'], campos: ['Persona responsable del área'], pie: 'Área con acceso controlado.' },
    { etiqueta: 'Higiene', icono: 'mano', titulo: 'Lávate las manos', sub: 'Antes y después de tu visita.', items: ['Usa agua y jabón.', 'Hazlo al salir del área de animales.', 'Antes de comer o beber.'], campos: ['Ubicación de lavamanos'], pie: 'Cuidamos a los animales y a las personas.' },
    { etiqueta: 'Seguridad', icono: 'ojo', titulo: 'Mantén tu distancia', sub: 'Observa sin invadir su espacio.', items: ['Permanece detrás de las barreras.', 'No golpees cristales ni rejas.', 'Habla en voz baja.'], campos: ['Indicaciones del lugar'], pie: 'Respeta a los animales y disfruta la visita.' },
    { etiqueta: 'Cuidado del lugar', icono: 'hoja', titulo: 'Cuida este lugar', sub: 'Lo que dejas puede dañar a los animales.', items: ['Deposita la basura en los botes.', 'No arranques plantas ni muevas objetos.', 'Sigue los senderos señalados.'], campos: ['Contacto o redes de la instalación'], pie: 'Gracias por cuidar este espacio.' }
  ],
  fuentes: [],
  revision: [
    { afirmacion: 'Los carteles contienen mensajes generales de convivencia y seguridad sin afirmaciones técnicas ni normativas; cada instalación debe ajustar el texto a su reglamento.', fuente: 'Criterio editorial', confianza: 'alto' }
  ]
});

/* ═════════ 6. Auditoría interna de bienestar ═════════ */
const verif = (items) => [{ t: 'verificacion', items }];
docs.push({
  id: 'checklist-auditoria-bienestar', archivo: 'checklist-auditoria-bienestar.pdf', tipo: 'checklist', papel: 'Letter', motivo: 'lista',
  etiqueta: 'Bienestar animal', titulo: 'Checklist de auditoría interna de bienestar animal', subtitulo: 'Una revisión organizada según los cinco dominios del bienestar.',
  area: 'Bienestar animal', paraQuien: 'Personal de UMA, zoológicos y centros; biólogos y médicos veterinarios', acceso: 'retos', requiereRetos: 8, revisar: ['médico veterinario', 'biólogo'],
  descripcionCorta: 'Lista de verificación para una auditoría interna de bienestar, ordenada por los cinco dominios: qué revisar en el recinto, en los registros y en lo que se observa en los animales, y un plan de mejora.',
  intro: 'Recorre tu instalación con esta lista, marca lo que ves y arma un plan de mejora con responsables y fechas. Es una herramienta de organización, no un dictamen.',
  secciones: [
    { titulo: 'Cómo usar esta lista', etiqueta: 'Introducción', bloques: [
      { t: 'p', texto: 'El modelo de los Cinco Dominios (Mellor y colaboradores, 2020) organiza el bienestar en nutrición, ambiente físico, salud, interacciones conductuales y estado mental. Los dominios 1 a 4 aportan evidencia sobre el dominio 5. Esta lista sigue esa estructura.' },
      { t: 'ul', items: ['Recorre cada recinto con la lista, sin avisar al área y con otra persona.', 'Marca Sí, Parcial, No o N/A y anota evidencia en observaciones.', 'Basa tu opinión en lo que observas en los animales, además de lo que existe en el recinto: un factor de riesgo por sí solo no prueba un problema.', 'Al final, convierte los «No» y «Parcial» en acciones con responsable y fecha (sección 7).'] },
      { t: 'campos', columnas: 3, items: ['Instalación', 'Recinto o área', 'Fecha', 'Quién audita', 'Grupo o especie', 'Hora de inicio'] },
      { t: 'aviso', texto: 'Las decisiones médicas y de manejo las toma el responsable técnico o médico veterinario. Esta lista no emite diagnósticos.' }
    ] },
    { titulo: 'Dominio 1: Nutrición', etiqueta: 'Revisión', junta: true, bloques: verif(['El alimento disponible corresponde al plan definido por el responsable técnico.', 'Hay agua disponible y limpia en el recinto.', 'Existe registro diario de alimento y agua.', 'El alimento se almacena de forma limpia y ordenada.', 'Se registran cambios en el consumo.']) },
    { titulo: 'Dominio 2: Ambiente físico', etiqueta: 'Revisión', junta: true, bloques: verif(['El recinto está limpio y en buen estado.', 'Hay zonas de refugio y descanso.', 'Los materiales y estructuras no presentan riesgo evidente de lesión.', 'Las condiciones del ambiente se revisan y se registran.', 'El espacio tiene variedad (sustratos, niveles, elementos).']) },
    { titulo: 'Dominio 3: Salud', etiqueta: 'Revisión', junta: true, nueva: true, bloques: verif(['Existe un responsable veterinario designado y su contacto es conocido por el personal.', 'Se revisa a los animales con la periodicidad que define el responsable.', 'Se registran los cambios y las atenciones.', 'Hay un procedimiento para avisar ante cualquier cambio inusual.', 'Los registros de cuarentena, limpieza y bioseguridad están al día.']) },
    { titulo: 'Dominio 4: Interacciones conductuales', etiqueta: 'Revisión', junta: true, bloques: verif(['Los animales tienen oportunidades de explorar, buscar alimento y elegir.', 'Se aplica enriquecimiento planeado y se registra.', 'Las interacciones con las personas son tranquilas y consistentes.', 'Los grupos sociales son adecuados para la especie y no hay conflictos persistentes.', 'Se hacen observaciones conductuales con método.']) },
    { titulo: 'Dominio 5: Estado mental (lo que se observa)', etiqueta: 'Revisión', junta: true, bloques: [{ t: 'p', texto: 'Este dominio se infiere con lo observado en los otros cuatro y en la conducta de los animales. Anota evidencia, no impresiones.' }, ...verif(['Los animales muestran conductas propias de su especie.', 'Se observan conductas de exploración y de uso del espacio.', 'No hay señales persistentes de evitación, agitación o conductas inusuales sin explicación.', 'El equipo conoce la conducta habitual de cada grupo.', 'Las observaciones se registran y se revisan en equipo.'])] },
    { titulo: 'Resumen y plan de mejora', etiqueta: 'Cierre', nueva: true, bloques: [
      { t: 'p', texto: 'Anota los hallazgos principales y define acciones concretas con responsable y fecha.' },
      { t: 'registro', cab: ['Hallazgo (Parcial o No)', 'Acción de mejora', 'Responsable', 'Fecha compromiso', 'Estado'], anchos: ['28%', '30%', '16%', '14%', '12%'], filas: 10 },
      { t: 'campos', columnas: 2, items: ['Firma de quien audita', 'Firma del responsable de la instalación'] }
    ] }
  ],
  fuentes: [MELLOR, 'Mellor DJ (2016). Updating animal welfare thinking: moving beyond the Five Freedoms. Animals 6(3):21', LGVS + ' (arts. 3 y 29: trato digno y respetuoso)'],
  revision: [
    { afirmacion: 'Los cinco dominios del modelo 2020 son nutrición, ambiente físico, salud, interacciones conductuales y estado mental; la evaluación debe basarse en evidencia observada en el animal y un factor de riesgo por sí solo no prueba un problema.', fuente: 'Mellor et al. 2020, Animals 10(10):1870', confianza: 'alto' },
    { afirmacion: 'Las preguntas de la lista son criterio de organización de Zoorigen por dominio; no son una norma ni una certificación.', fuente: 'Criterio editorial; requiere revisión de un médico veterinario o biólogo de bienestar', confianza: 'medio' }
  ]
});

/* ═════════ 7. Guía de rotulado y trazabilidad de muestras ═════════ */
docs.push({
  id: 'guia-rotulado-trazabilidad-muestras', archivo: 'guia-rotulado-trazabilidad-muestras.pdf', tipo: 'guia', papel: 'Letter', motivo: 'tubo',
  etiqueta: 'Registro y trazabilidad', titulo: 'Guía de rotulado y trazabilidad de muestras', subtitulo: 'Cómo identificar, registrar y dar seguimiento a muestras. Solo organización.',
  area: 'Registro y trazabilidad de fauna silvestre', paraQuien: 'Biólogos, médicos veterinarios, técnicos de campo y personal de laboratorio', acceso: 'miembros', revisar: ['biólogo', 'médico veterinario'],
  descripcionCorta: 'Guía para rotular y dar seguimiento a muestras: qué datos lleva una etiqueta, cómo llevar un registro maestro y una cadena de custodia, con formatos para imprimir. Sin técnicas de toma ni conservación.',
  intro: 'Una muestra sin identificación pierde su valor. Esta guía propone qué datos anotar, cómo llevar el registro y cómo documentar quién tiene la muestra en cada momento.',
  secciones: [
    { titulo: 'Principios de trazabilidad', etiqueta: 'Introducción', bloques: [
      { t: 'ul', items: ['Cada muestra tiene un identificador único que no se repite.', 'El identificador viaja con la muestra: en su etiqueta, en el registro y en los documentos de envío.', 'Cada cambio de manos o de lugar queda anotado (cadena de custodia).', 'Las etiquetas se llenan en el momento, con letra clara y con materiales que resistan las condiciones de manejo.', 'Los requisitos de toma, conservación y transporte los define el laboratorio o el responsable técnico: consúltalos antes de tomar la muestra.'] },
      { t: 'aviso', texto: 'Esta guía no explica cómo tomar, conservar ni transportar muestras. Esos procedimientos dependen del tipo de muestra, del análisis y del laboratorio.' }
    ] },
    { titulo: 'Qué datos lleva una etiqueta', etiqueta: 'Etiquetado', bloques: [
      { t: 'tabla', cab: ['Dato', 'Para qué sirve'], anchos: ['34%', '66%'], filas: [['Identificador de la muestra', 'Distingue la muestra de todas las demás'], ['Ejemplar o sitio de origen', 'Relaciona la muestra con el animal o el lugar'], ['Tipo de muestra', 'Evita confusiones al procesarla'], ['Fecha y hora de toma', 'Contexto temporal de la muestra'], ['Persona que la tomó', 'Responsable ante dudas'], ['Observaciones breves', 'Información que no debe perderse']] },
      { t: 'p', texto: 'Escribe lo mismo en la etiqueta y en el registro maestro. Si algo no cabe en la etiqueta, anótalo en el registro y deja el identificador como enlace.' }
    ] },
    { titulo: 'Lista de verificación antes de entregar', etiqueta: 'Verificación', bloques: [
      { t: 'casillas', items: ['El identificador está completo y legible.', 'El tipo de muestra, la fecha y la hora están anotados.', 'La persona que tomó la muestra firmó o inició el registro.', 'Se confirmaron con el laboratorio los requisitos de entrega.', 'El registro maestro coincide con las etiquetas.', 'La cadena de custodia tiene el primer renglón lleno.', 'Se guardó una copia del registro.'] }
    ] },
    { titulo: 'Formato: registro maestro de muestras', etiqueta: 'Formato 4', bloques: [
      { t: 'campos', columnas: 2, items: ['Proyecto o unidad', 'Responsable del registro'] },
      { t: 'registro', cab: ['ID de muestra', 'Ejemplar o sitio', 'Tipo', 'Fecha y hora', 'Tomada por', 'Destino', 'Observaciones'], anchos: ['13%', '16%', '13%', '13%', '13%', '14%', '18%'], filas: 16 }
    ] },
    { titulo: 'Formato: cadena de custodia', etiqueta: 'Formato 5', nueva: true, bloques: [
      { t: 'campos', columnas: 2, items: ['ID de la muestra o lote', 'Tipo de muestra'] },
      { t: 'registro', cab: ['Fecha y hora', 'Entrega (nombre y firma)', 'Recibe (nombre y firma)', 'Motivo', 'Condiciones o notas'], anchos: ['15%', '23%', '23%', '17%', '22%'], filas: 10 }
    ] },
    { titulo: 'Errores frecuentes', etiqueta: 'Buenas prácticas', bloques: [
      { t: 'ul', items: ['Etiquetas con tinta que se borra o papel que se despega.', 'Identificadores repetidos o que cambian de una hoja a otra.', 'Registros llenados horas después, de memoria.', 'Cambios de manos sin anotar.', 'No confirmar con el laboratorio qué información necesita.'] }
    ] }
  ],
  fuentes: ['Principios generales de trazabilidad y cadena de custodia: criterio de organización de Zoorigen; consulta los requisitos de tu laboratorio y la normatividad vigente que te aplique', NOM087],
  revision: [
    { afirmacion: 'Los datos de la etiqueta, el registro maestro y la cadena de custodia son criterio de organización general; no sustituyen los requisitos de un laboratorio o de una norma específica.', fuente: 'Criterio editorial; requiere revisión de un biólogo o veterinario con experiencia en muestras', confianza: 'medio' },
    { afirmacion: 'No se incluyen técnicas de toma, conservación, fijación ni transporte.', fuente: 'Omisión deliberada', confianza: 'alto' }
  ]
});

module.exports = { docs };
