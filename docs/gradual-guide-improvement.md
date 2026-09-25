# Mejora gradual de guías

El motor debe proponer cambios pequeños y revisables a partir de la retroalimentación humana acumulada. No debe reescribir ni publicar una guía automáticamente.

## Contrato de retroalimentación

- Una idea con puntaje de 1 a 4 dentro de una guía pública queda marcada para reemplazo.
- Todos los puntajes forman un perfil agregado del grupo; el promedio describe lo revisado y no se convierte en una meta.
- Un puntaje de 8 a 10 eleva el estándar general. Si el editor explica el motivo, también enseña una cualidad deseada. El nombre del objeto se oculta para que no se convierta en una plantilla.
- Un puntaje de 5 a 7 señala una idea sensata de apoyo para completar una guía variada. Si tiene motivo, también aporta contexto condicional.
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

## Revisión automática

La revisión se dispara por un cambio, no por un calendario. Se ejecuta una sola vez al aplicar localmente una iteración que reemplaza un regalo o modifica varios campos relevantes. Debe comentar la modificación y su efecto en el contexto de la guía, sin aplicar una segunda corrección por sí sola. Una corrección menor sólo deja historial. Si no hubo cambios, no hay revisión; nunca se ejecuta cada cierta cantidad de horas o días.

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

1. Una cola filtrada a ideas públicas con puntaje de 1 a 4, agrupada por guía y ordenada por peor puntaje.
2. Un botón para solicitar un reemplazo de una idea seleccionada.
3. Una tarjeta de comparación con acciones de aceptar y rechazar.
4. Aplicación a un borrador local y los controles existentes.
5. Una acción de publicación separada después de revisar la guía completa.

## Medición

Conviene medir la tasa de aceptación de reemplazos, la variación del puntaje después del cambio, la repetición de clases de regalo, los motivos de rechazo y las reversiones posteriores. Estas señales deben afinar los criterios de propuestas futuras sin incentivar la repetición de objetos exactos.
