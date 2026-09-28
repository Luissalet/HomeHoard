# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

El propietario de una casa que quiere registrar dónde guarda sus objetos y encontrarlos después desde el ordenador o el móvil.

## Product Purpose

HomeHoard responde a preguntas prácticas como «¿dónde tengo guardada la linterna Philips?» con una ubicación concreta dentro de la vivienda.

## Operating Context

El inventario se crea y consulta en la app. Faustus debe poder consultar una copia local del inventario. El usuario todavía no usa HomeHoard de forma habitual; los datos de ejemplo no representan su casa.

## Capabilities and Constraints

- Los datos y las fotos permanecen locales. No se requiere cuenta, nube ni conexión para el inventario.
- El modelo admite viviendas, plantas, habitaciones, muebles anidados, objetos, etiquetas, fotos y copias JSON.
- La app se ejecuta en web y en móvil con Expo. El almacenamiento del navegador y el del móvil son independientes; una copia JSON permite trasladar el inventario entre dispositivos.
- Faustus solo puede responder sobre objetos presentes en una copia local actualizada; debe indicar cuando no encuentra el objeto.

## Evidence on Hand

El proyecto contiene una casa de demostración con objetos ficticios. No consta un inventario real del usuario ni la ubicación de su linterna.

## Product Principles

1. Encontrar un objeto debe ser más rápido que recorrer un plano.
2. Registrar una ubicación debe requerir pocos pasos y ofrecer una ruta completa.
3. Nunca presentar datos de demostración como pertenencias reales.
4. Mostrar cuándo fue actualizada la copia local que consulta Faustus.
