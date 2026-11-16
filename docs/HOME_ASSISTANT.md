# Home Assistant como pasarela

HomeHoard habla con una instancia de Home Assistant: lee sus entidades y estados, llama a sus servicios y escucha su
bus de eventos para avisar cuando algo cambie. Todo ocurre en el ordenador que guarda la casa; la instancia se alcanza
por su API con un token de larga duración.

## Conexión

| Ajuste | Qué es |
|---|---|
| `ha_url` | Dirección de la instancia, `http://` o `https://` con su puerto (`http://homeassistant.local:8123`). Se normaliza sin la barra final. |
| `ha_token` | Token de larga duración del perfil de Home Assistant. Se guarda en `data/settings.json` y **nunca** se devuelve al navegador: `GET /api/settings` lo entrega vacío y añade `ha_token_set`. |
| `ha_notify` | Si las reglas avisan por las notificaciones de la familia. |

Se editan en la página `/homeassistant` (pestaña Conexión) o con `POST /api/settings`. `GET /api/homeassistant/status`
dice si está configurado, si el bus está conectado, cuántas reglas hay y, con `?probe=1`, si la instancia responde
(versión, nombre de la casa y número de entidades).

El token se crea en Home Assistant: perfil › Seguridad › Tokens de acceso de larga duración.

## Entidades y servicios

- `ha_list_entities` lee `GET /api/states` y devuelve `entity_id`, dominio, nombre, estado, unidad, `device_class` y
  atributos. Filtra por `domain` y por texto en el id o el nombre (sin acentos ni mayúsculas), pagina con `offset` y
  `limit` y cachea unos segundos (`refresh` vuelve a leer).
- `ha_get_state` lee una entidad concreta (`GET /api/states/<entity_id>`).
- `ha_call_service` llama a `POST /api/services/<domain>/<service>` con los campos en `data` (`entity_id`,
  `brightness`, `temperature`…) y devuelve las entidades que la instancia informa como cambiadas. Vacía la caché de
  estados.

Los errores se dicen tal cual: `not_configured` (falta dirección o token), `auth` (token rechazado), `not_found`
(entidad o servicio inexistente), `unreachable` (no se llega) y `error` (otra respuesta).

## Reglas

Una regla dice «cuando esta entidad cambie a este estado, avisa y/o llama a este servicio». Viven en
`data/homeassistant-rules.json` y se gestionan con `ha_watch`:

| `action` | Qué hace |
|---|---|
| `list` (por defecto) | Las reglas y el estado del bus. |
| `save` | Crea una regla o actualiza la de `rule`. Campos: `entity_id` (admite `light.*`), `from_state`, `to_state`, `name`, `notify_title`, `notify_body`, `priority` (`low`, `normal`, `high`, `urgent`), `service_domain`, `service_name`, `service_data`, `enabled`, `cooldown_s`. Hace falta una entidad y al menos un aviso o un servicio. |
| `delete` | Borra la regla; necesita `confirm=true`. |
| `run` | Ejecuta la regla ahora, sin esperar a un cambio. |
| `events` | Los últimos cambios que ha entregado el bus (hasta 100 en memoria). |

El servidor abre el bus al arrancar (`ws(s)://<instancia>/api/websocket`): `auth` con el token, `subscribe_events` de
`state_changed` y, por cada evento, las reglas que coinciden. `cooldown_s` evita repetir el aviso en ráfaga. El aviso
sale por `hoard_link.fam_notify`, así que el Hub decide el canal (toast, ntfy, Telegram o correo) con sus horas de
silencio y sus límites; si el Hub no responde, la regla sigue ejecutando su servicio y el estado lo dice. Cada disparo
emite `homehoard.homeassistant.rule` en el bus de la familia.

Si la conexión se cae, el bus reintenta con espera creciente (5 s hasta 60 s) y `last_error` guarda el motivo.

## Página `/homeassistant`

Tres pestañas: **Dispositivos** (buscar, filtrar por dominio, ver estados y llamar a un servicio), **Reglas** (listar,
crear, editar, probar y borrar, con los últimos cambios escuchados) y **Conexión** (dirección, token, avisos y prueba
de conexión). Usa la paleta de la familia y el mismo guard local que el resto de la app.

## Pruebas

`bridge/test_homeassistant.py` levanta una instancia falsa (REST y WebSocket en un puerto libre) y comprueba el
cliente, la caché, las reglas, el cooldown, el bus real y las rutas HTTP. `python -m unittest discover -s bridge -p
"test_*.py"` corre la suite entera.