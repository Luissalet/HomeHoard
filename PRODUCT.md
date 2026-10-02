# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

El propietario de una casa que quiere registrar dónde guarda sus objetos y encontrarlos después desde el ordenador o el móvil.

## Product Purpose

HomeHoard responde a preguntas prácticas como «¿dónde tengo guardada la linterna Philips?» con una ubicación concreta dentro de la vivienda.

## Operating Context

El inventario se crea y consulta en la app. El ordenador guarda la casa (servidor de HomeHoard en 127.0.0.1:5196): la web se sincroniza con él y Faustus la consulta y la cambia en vivo. Los papeles, plazos legales y avisos viven en Kafka's Hoard; HomeHoard enlaza a ellos y refleja cada tarea de mantenimiento como plazo en Kafka para que avise por sus canales. El usuario todavía no usa HomeHoard de forma habitual; los datos de ejemplo no representan su casa.

## Capabilities and Constraints

- Los datos y las fotos permanecen locales. No se requiere cuenta, nube ni conexión para el inventario.
- El modelo admite viviendas, plantas, habitaciones, muebles anidados, objetos, etiquetas, fotos, fichas de aparatos, tareas de mantenimiento con su historial y copias JSON.
- La app se ejecuta en web y en móvil con Expo. La web se sincroniza con el ordenador y trabaja sin conexión con su copia; el móvil es independiente y pasa sus datos con una copia JSON.
- Faustus responde sobre la casa que guarda el ordenador; debe indicar cuando no encuentra el objeto.
- Las tareas de mantenimiento distinguen obligación legal (con su norma), fabricante y recomendación; nunca se presenta una recomendación como obligación.

## Evidence on Hand

El proyecto contiene una casa de demostración con objetos ficticios. No consta un inventario real del usuario ni la ubicación de su linterna.

## Product Principles

1. Encontrar un objeto debe ser más rápido que recorrer un plano.
2. Registrar una ubicación debe requerir pocos pasos y ofrecer una ruta completa.
3. Nunca presentar datos de demostración como pertenencias reales.
4. Mostrar si la web está guardada en el ordenador y cuándo se sincronizó.
5. Cada tarea de mantenimiento dice por qué existe: norma, fabricante o recomendación.
