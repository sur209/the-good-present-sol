# Revisión editorial sobre la copia local

La revisión se hace en `http://127.0.0.1:4322/local/`. El sitio público en GitHub Pages no recibe los controles ni los cambios. La copia usa el HTML, estilos e imágenes del último build local.

1. Ejecutar `npm run build` cuando cambie el sitio público y luego `npm run studio`.
2. Abrir la URL local, entrar en una guía y pulsar **Empezar a revisar esta guía**. Esto crea un borrador, no publica nada.
3. Para cambiar un regalo, pulsar **Cambiar idea**, escribir la idea nueva y el motivo. El borrador pierde el Product, enlace, copy e imagen anteriores para esa posición. Luego pulsar **Generar texto**, revisar el resultado y **Aprobar texto** si corresponde. El placeholder vuelve hasta que se prepare una imagen pertinente.
4. Para revisar redacción, seleccionar una frase y pulsar **Comentar selección**; también se puede hacer doble clic en un párrafo para comentar el campo completo. Se envía al proveedor de IA solo ese campo, el título/idea como contexto breve y el comentario. La propuesta **no** modifica el borrador hasta pulsar **Aceptar**; se puede **Rechazar**.
5. **Historial** muestra reemplazos de ideas y propuestas de texto con su decisión. Los registros se guardan en `editorial-data/manual-reviews/`. Las últimas tres decisiones aceptadas y relevantes para el mismo cluster se resumen en los prompts futuros de ideas y copy. Las propuestas rechazadas se conservan pero no se usan como preferencia positiva.

El proveedor predeterminado es Codex CLI con la sesión local existente: no se añade hosting, base de datos ni clave API de pago. Sigue sujeto a los límites de uso de esa sesión. El sitio público continúa siendo estático. Para publicar cambios, hay que completar/validar el borrador en Studio y ejecutar por separado el flujo normal de publicación, commit y despliegue.
