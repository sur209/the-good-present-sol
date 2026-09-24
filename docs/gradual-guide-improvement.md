# Mejora gradual de guías

El motor debe proponer cambios pequeños y revisables a partir de la retroalimentación humana acumulada. No debe reescribir ni publicar una guía automáticamente.

## Contrato de retroalimentación

- Una idea con puntaje de 1 a 4 dentro de una guía pública queda marcada para reemplazo.
- Un puntaje de 8 a 10 enseña una cualidad deseada sólo si el editor explica el motivo. El nombre del objeto se oculta para que no se convierta en una plantilla.
- Un puntaje de 5 a 7 sólo se utiliza cuando el motivo aporta contexto útil.
- Los ejemplos negativos pueden conservar el nombre del objeto para impedir que vuelva la misma idea débil.
- Los comentarios sobre el texto permanecen separados de los puntajes de las ideas.

La marca de reemplazo se deriva del puntaje y de la presencia en una guía pública. Desaparece si la nota se corrige por encima de 4, por lo que no existe un segundo estado que pueda quedar desactualizado.

## Flujo de iteraciones pequeñas

1. **Cola:** reunir ideas públicas marcadas para reemplazo y comentarios de texto aceptados.
2. **Propuesta:** elegir una guía y proponer como máximo un reemplazo de regalo y una corrección menor de texto.
3. **Comparación:** mostrar lado a lado la versión actual y la propuesta, con el motivo del cambio y la versión del prompt utilizada.
4. **Revisión:** el editor acepta, rechaza o comenta cada propuesta por separado.
5. **Aplicación local:** los cambios aceptados actualizan sólo un borrador local; la URL, el slug, las demás ideas y el texto ajeno al cambio permanecen intactos.
6. **Verificación:** ejecutar controles de esquema, duplicación, cobertura, enlaces, build y apariencia visual.
7. **Publicación separada:** publicar sigue siendo una decisión humana explícita después de revisar la guía completa.

El recorrido de cada cambio es:

`marcado → propuesto → aceptado/rechazado → aplicado localmente → verificado → publicado por separado`

## Límites de seguridad

- No cambiar más de un regalo por guía en cada iteración.
- Al reemplazar, preferir otra clase de regalo; no parafrasear el objeto rechazado.
- Conservar el destinatario, la ocasión, el rango de precio y la diversidad útil de la guía.
- No reutilizar como opción predeterminada los objetos con notas altas. Transferir las razones por las que funcionaron: capacidad de ser apreciado, novedad, presentación, utilidad o valor estético.
- Rechazar duplicados cercanos ya presentes en la guía o en propuestas recientes.
- Guardar un historial reversible con valor anterior, propuesta, decisión, motivo, versión del prompt y fecha.
- En la primera versión no habrá reescrituras programadas, publicación autónoma ni reemplazos masivos.

## Primera versión útil

El motor mínimo necesita solamente:

1. Una cola filtrada a ideas públicas con puntaje de 1 a 4.
2. Un botón para solicitar un reemplazo de una idea seleccionada.
3. Una tarjeta de comparación con acciones de aceptar y rechazar.
4. Aplicación a un borrador local y los controles existentes.
5. Una acción de publicación separada después de revisar la guía completa.

## Medición

Conviene medir la tasa de aceptación de reemplazos, la variación del puntaje después del cambio, la repetición de clases de regalo, los motivos de rechazo y las reversiones posteriores. Estas señales deben afinar los criterios de propuestas futuras sin incentivar la repetición de objetos exactos.
