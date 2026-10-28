# Privacidad · UI5 Technical Lens

- La extensión no transmite información a ningún servidor y no utiliza cookies, telemetría ni analítica.
- Lee en la pestaña inspeccionada el título, la URL, la versión de UI5, el identificador/título del componente, los nombres técnicos y los IDs de controles para mostrarlos localmente.
- Con los flags de modelos/OData activos, lee nombres y tipos de modelos, bindings, rutas, contextos y URLs de servicio ya presentes en el cliente. No lee valores de datos del modelo ni campos. Las rutas de contexto pueden contener claves de entidad. Los servicios se muestran sin credenciales, query ni fragmento URL.
- La inspección de bindings no solicita datos ni metadatos OData adicionales y no refresca modelos.
- El flag de controladores consulta nombres, metadatos, asociaciones con vistas/fragmentos y nombres de módulos ya cargados. También lee eventos registrados, nombres/tipos de parámetros, nombres de métodos y nombres formales de argumentos, sin invocar handlers, evaluar expresiones XML, leer valores de eventos ni oData. No descarga el código de los controladores.
- Guarda las opciones booleanas de visualización por ID de pestaña y, si solicitas navegar con DevTools cerrado, una referencia opaca de función y el ID del marco hasta conectar o cerrar la pestaña en `chrome.storage.session`. No guarda URLs, manifiestos, nombres técnicos, datos de negocio, formularios ni credenciales en el almacenamiento de la extensión.
- Los controles y nombres de fragmentos capturados se mantienen en memoria en el contexto de la página, hasta su destrucción o recarga. La app puede acceder a ese contexto y modificarlo; es una herramienta de desarrollo, no una frontera de seguridad.
- **Copiar ruta** escribe en el portapapeles la información técnica seleccionada. **Copiar todo** en una tarjeta fijada copia sus detalles técnicos. También puedes seleccionar texto y copiarlo con Ctrl+C. Ninguna de estas acciones envía datos fuera del navegador.
- El permiso para sitios HTTP/HTTPS permite la inspección en apps UI5 y sus marcos. Puedes restringirlo desde Chrome. No añade solicitudes de red propias de la extensión; UI5 puede cargar su módulo Fragment mediante su cargador habitual cuando comienza la inspección.
- La app de demostración es independiente de la extensión y descarga SAPUI5 del CDN oficial de SAP.

- **Ver función en DevTools** transmite la referencia de función y la URL del marco únicamente entre los componentes locales de la extensión para seleccionar su código en Sources. No guarda esa URL ni el código; no ejecuta la función. El usuario abre DevTools manualmente.
