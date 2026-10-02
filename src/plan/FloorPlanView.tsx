import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Rect, Text as SvgText } from 'react-native-svg';
import type { Container as DbContainer, FloorPlan, ID, Rect as DbRect, Room } from '../db/types';
import { colors, radius } from '../theme';

const ZOOM_STEPS = [1, 1.5, 2, 3];
const ROOM_SNAP = 10; // cm
const CONT_SNAP = 5; // cm
const ROOM_MIN = 80; // cm
const CONT_MIN = 20; // cm

// Convierte un color hex (#RRGGBB) en rgba con alpha.
function withAlpha(hex: string | null, alpha: number): string {
  if (!hex || !/^#([0-9a-f]{6})$/i.test(hex)) return `rgba(109,139,255,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const snap = (v: number, step: number) => Math.round(v / step) * step;

type Sel = { kind: 'room' | 'container'; id: ID } | null;

interface Ghost {
  kind: 'room' | 'container';
  id: ID;
  rect: DbRect;
}

interface DragState {
  mode: 'move' | 'resize';
  kind: 'room' | 'container';
  id: ID;
  orig: DbRect;
  roomOfContainer?: Room;
}

export function FloorPlanView({
  plan,
  roomCounts,
  onSelectRoom,
  onSelectContainer,
  editable = false,
  onRoomGeometry,
  onContainerGeometry,
}: {
  plan: FloorPlan;
  roomCounts?: Record<ID, number>;
  onSelectRoom: (roomId: ID) => void;
  onSelectContainer: (containerId: ID) => void;
  /** Modo edición: arrastra para mover, tira de la esquina para redimensionar. */
  editable?: boolean;
  onRoomGeometry?: (roomId: ID, rect: DbRect) => void | Promise<void>;
  onContainerGeometry?: (containerId: ID, rect: DbRect) => void | Promise<void>;
}) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoomIdx, setZoomIdx] = useState(0);
  const [selected, setSelected] = useState<Sel>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  const { floor, rooms, rootContainers } = plan;

  // Límites reales del contenido (por si hay habitaciones fuera de las medidas iniciales del floor).
  const contentW = useMemo(
    () => Math.max(floor.width_cm, ...rooms.map((r) => r.x_cm + r.width_cm), 1),
    [floor.width_cm, rooms]
  );
  const contentH = useMemo(
    () => Math.max(floor.height_cm, ...rooms.map((r) => r.y_cm + r.height_cm), 1),
    [floor.height_cm, rooms]
  );

  const fitScale = box.w && box.h ? Math.min((box.w - 8) / contentW, (box.h - 8) / contentH) : 0;
  // El nivel inicial siempre muestra el plano completo, también en pantallas anchas.
  const scale = editable ? fitScale : fitScale * ZOOM_STEPS[zoomIdx];
  const svgW = contentW * scale;
  const svgH = contentH * scale;

  const onLayout = (e: LayoutChangeEvent) =>
    setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  // ── Drag & resize (solo en modo edición) ─────────────────────
  const drag = useRef<DragState | null>(null);
  const ghostRef = useRef<Ghost | null>(null);
  const setGhostBoth = (g: Ghost | null) => {
    ghostRef.current = g;
    setGhost(g);
  };

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const contsRef = useRef(rootContainers);
  contsRef.current = rootContainers;
  const selRef = useRef(selected);
  selRef.current = selected;
  const dimsRef = useRef({ contentW, contentH });
  dimsRef.current = { contentW, contentH };

  const findRoom = (id: ID) => roomsRef.current.find((r) => r.id === id);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          const s = scaleRef.current;
          if (!s) return;
          const cx = evt.nativeEvent.locationX / s;
          const cy = evt.nativeEvent.locationY / s;
          const sel = selRef.current;

          // 1) ¿Está tirando del tirador de redimensionado del elemento seleccionado?
          if (sel) {
            const rect = currentRectOf(sel);
            if (rect) {
              const hx = rect.x_cm + rect.width_cm;
              const hy = rect.y_cm + rect.height_cm;
              const rPx = 18 / s; // radio de agarre en cm
              if (Math.hypot(cx - hx, cy - hy) <= rPx) {
                drag.current = {
                  mode: 'resize',
                  kind: sel.kind,
                  id: sel.id,
                  orig: rect,
                  roomOfContainer: sel.kind === 'container' ? roomOfCont(sel.id) : undefined,
                };
                return;
              }
            }
          }

          // 2) ¿Ha tocado un mueble? (por encima de las habitaciones)
          for (const c of [...contsRef.current].reverse()) {
            const room = findRoom(c.room_id);
            if (!room || c.x_cm == null || c.y_cm == null || c.width_cm == null || c.height_cm == null) continue;
            const ax = room.x_cm + c.x_cm;
            const ay = room.y_cm + c.y_cm;
            if (cx >= ax && cx <= ax + c.width_cm && cy >= ay && cy <= ay + c.height_cm) {
              setSelected({ kind: 'container', id: c.id });
              drag.current = {
                mode: 'move',
                kind: 'container',
                id: c.id,
                orig: { x_cm: c.x_cm, y_cm: c.y_cm, width_cm: c.width_cm, height_cm: c.height_cm },
                roomOfContainer: room,
              };
              return;
            }
          }

          // 3) ¿Una habitación?
          for (const r of [...roomsRef.current].reverse()) {
            if (cx >= r.x_cm && cx <= r.x_cm + r.width_cm && cy >= r.y_cm && cy <= r.y_cm + r.height_cm) {
              setSelected({ kind: 'room', id: r.id });
              drag.current = {
                mode: 'move',
                kind: 'room',
                id: r.id,
                orig: { x_cm: r.x_cm, y_cm: r.y_cm, width_cm: r.width_cm, height_cm: r.height_cm },
              };
              return;
            }
          }

          // 4) Vacío: deselecciona.
          setSelected(null);
          drag.current = null;
        },
        onPanResponderMove: (_evt, g) => {
          const d = drag.current;
          const s = scaleRef.current;
          if (!d || !s) return;
          const dxCm = g.dx / s;
          const dyCm = g.dy / s;
          const { contentW: cw, contentH: ch } = dimsRef.current;
          const step = d.kind === 'room' ? ROOM_SNAP : CONT_SNAP;
          const min = d.kind === 'room' ? ROOM_MIN : CONT_MIN;

          if (d.mode === 'move') {
            let nx = snap(d.orig.x_cm + dxCm, step);
            let ny = snap(d.orig.y_cm + dyCm, step);
            if (d.kind === 'room') {
              nx = Math.min(Math.max(0, nx), cw - d.orig.width_cm);
              ny = Math.min(Math.max(0, ny), ch - d.orig.height_cm);
            } else if (d.roomOfContainer) {
              const room = d.roomOfContainer;
              nx = Math.min(Math.max(0, nx), Math.max(0, room.width_cm - d.orig.width_cm));
              ny = Math.min(Math.max(0, ny), Math.max(0, room.height_cm - d.orig.height_cm));
            }
            setGhostBoth({ kind: d.kind, id: d.id, rect: { ...d.orig, x_cm: nx, y_cm: ny } });
          } else {
            let nw = snap(d.orig.width_cm + dxCm, step);
            let nh = snap(d.orig.height_cm + dyCm, step);
            nw = Math.max(min, nw);
            nh = Math.max(min, nh);
            if (d.kind === 'room') {
              nw = Math.min(nw, cw - d.orig.x_cm);
              nh = Math.min(nh, ch - d.orig.y_cm);
            } else if (d.roomOfContainer) {
              nw = Math.min(nw, d.roomOfContainer.width_cm - d.orig.x_cm);
              nh = Math.min(nh, d.roomOfContainer.height_cm - d.orig.y_cm);
            }
            setGhostBoth({ kind: d.kind, id: d.id, rect: { ...d.orig, width_cm: nw, height_cm: nh } });
          }
        },
        onPanResponderRelease: () => {
          const d = drag.current;
          const g = ghostRef.current;
          drag.current = null;
          if (d && g && g.id === d.id) {
            if (d.kind === 'room') onRoomGeometry?.(d.id, g.rect);
            else onContainerGeometry?.(d.id, g.rect);
          }
          setGhostBoth(null);
        },
        onPanResponderTerminate: () => {
          drag.current = null;
          setGhostBoth(null);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onRoomGeometry, onContainerGeometry]
  );

  function roomOfCont(cid: ID): Room | undefined {
    const c = contsRef.current.find((x) => x.id === cid);
    return c ? findRoom(c.room_id) : undefined;
  }

  /** Rect vigente de la selección (con ghost si se está arrastrando). */
  function currentRectOf(sel: NonNullable<Sel>): DbRect | null {
    const g = ghostRef.current;
    if (g && g.id === sel.id) {
      if (sel.kind === 'container') {
        const room = roomOfCont(sel.id);
        if (!room) return null;
        return { ...g.rect, x_cm: room.x_cm + g.rect.x_cm, y_cm: room.y_cm + g.rect.y_cm };
      }
      return g.rect;
    }
    if (sel.kind === 'room') {
      const r = findRoom(sel.id);
      return r ? { x_cm: r.x_cm, y_cm: r.y_cm, width_cm: r.width_cm, height_cm: r.height_cm } : null;
    }
    const c = contsRef.current.find((x) => x.id === sel.id);
    const room = c ? findRoom(c.room_id) : undefined;
    if (!c || !room || c.x_cm == null || c.y_cm == null || c.width_cm == null || c.height_cm == null) return null;
    return { x_cm: room.x_cm + c.x_cm, y_cm: room.y_cm + c.y_cm, width_cm: c.width_cm, height_cm: c.height_cm };
  }

  // Rects efectivos (aplicando ghost mientras se arrastra).
  const roomRect = (r: Room): DbRect =>
    ghost && ghost.kind === 'room' && ghost.id === r.id
      ? ghost.rect
      : { x_cm: r.x_cm, y_cm: r.y_cm, width_cm: r.width_cm, height_cm: r.height_cm };

  const contRect = (c: DbContainer): DbRect | null => {
    if (c.x_cm == null || c.y_cm == null || c.width_cm == null || c.height_cm == null) return null;
    return ghost && ghost.kind === 'container' && ghost.id === c.id
      ? ghost.rect
      : { x_cm: c.x_cm, y_cm: c.y_cm, width_cm: c.width_cm, height_cm: c.height_cm };
  };

  // Líneas de rejilla cada 100 cm.
  const gridLines: React.ReactElement[] = [];
  if (scale > 0) {
    for (let x = 0; x <= contentW; x += 100) {
      gridLines.push(<Line key={`vx${x}`} x1={x} y1={0} x2={x} y2={contentH} stroke={colors.border} strokeWidth={1 / scale} />);
    }
    for (let y = 0; y <= contentH; y += 100) {
      gridLines.push(<Line key={`hy${y}`} x1={0} y1={y} x2={contentW} y2={y} stroke={colors.border} strokeWidth={1 / scale} />);
    }
  }

  const selectedRect = selected && editable ? currentRectOf(selected) : null;

  const svg =
    scale > 0 ? (
      <Svg width={svgW} height={svgH} viewBox={`0 0 ${contentW} ${contentH}`} pointerEvents={editable ? 'none' : 'auto'}>
        {/* Fondo del lienzo */}
        <Rect x={0} y={0} width={contentW} height={contentH} fill={colors.surface} />
        {gridLines}

        {/* Habitaciones */}
        {rooms.map((room) => {
          const rect = roomRect(room);
          const count = roomCounts?.[room.id];
          const labelSize = Math.min(18 / scale, rect.width_cm * 0.1, rect.height_cm * 0.15);
          const isSel = editable && selected?.kind === 'room' && selected.id === room.id;
          return (
            <G key={room.id} onPress={editable ? undefined : () => onSelectRoom(room.id)}>
              <Rect
                x={rect.x_cm}
                y={rect.y_cm}
                width={rect.width_cm}
                height={rect.height_cm}
                rx={6}
                fill={withAlpha(room.color, isSel ? 0.3 : 0.18)}
                stroke={room.color ?? colors.accent}
                strokeWidth={(isSel ? 3 : 2) / scale}
              />
              <SvgText
                x={rect.x_cm + rect.width_cm / 2}
                y={rect.y_cm + rect.height_cm * 0.54}
                fill={colors.text}
                fontSize={labelSize}
                fontWeight="700"
                fontFamily="sans-serif"
                textAnchor="middle"
              >
                {room.name}
              </SvgText>
              {count != null && !editable ? (
                <SvgText
                  x={rect.x_cm + rect.width_cm / 2}
                  y={rect.y_cm + rect.height_cm * 0.54 + Math.min(17 / scale, labelSize)}
                  fill={colors.textDim}
                  fontSize={Math.min(12 / scale, labelSize * 0.75)}
                  fontFamily="sans-serif"
                  textAnchor="middle"
                >
                  {count === 1 ? '1 objeto' : `${count} objetos`}
                </SvgText>
              ) : null}
            </G>
          );
        })}

        {/* Muebles raíz (coords relativas a su habitación) */}
        {rootContainers.map((c) => {
          const room = rooms.find((r) => r.id === c.room_id);
          const rel = contRect(c);
          if (!room || !rel) return null;
          const rBase = roomRect(room);
          const ax = rBase.x_cm + rel.x_cm;
          const ay = rBase.y_cm + rel.y_cm;
          const isSel = editable && selected?.kind === 'container' && selected.id === c.id;
          return (
            <G key={c.id} onPress={editable ? undefined : () => onSelectContainer(c.id)}>
              <Rect
                x={ax}
                y={ay}
                width={rel.width_cm}
                height={rel.height_cm}
                rx={3}
                fill={isSel ? colors.surface2 : colors.surface2}
                stroke={isSel ? colors.accent : colors.textDim}
                strokeWidth={(isSel ? 2.5 : 1.5) / scale}
              />
              <SvgText
                x={ax + rel.width_cm / 2}
                y={ay + rel.height_cm / 2 + 6}
                fill={colors.text}
                fontSize={Math.min(11 / scale, rel.height_cm * 0.32, rel.width_cm * 0.17)}
                fontFamily="sans-serif"
                textAnchor="middle"
              >
                {c.name}
              </SvgText>
            </G>
          );
        })}

        {/* Tirador de redimensionado de la selección */}
        {selectedRect ? (
          <>
            <Rect
              x={selectedRect.x_cm}
              y={selectedRect.y_cm}
              width={selectedRect.width_cm}
              height={selectedRect.height_cm}
              fill="none"
              stroke={colors.accent}
              strokeDasharray={`${8 / scale},${6 / scale}`}
              strokeWidth={1.5 / scale}
            />
            <Circle
              cx={selectedRect.x_cm + selectedRect.width_cm}
              cy={selectedRect.y_cm + selectedRect.height_cm}
              r={12 / scale}
              fill={colors.accent}
              stroke={colors.bg}
              strokeWidth={2 / scale}
            />
          </>
        ) : null}
      </Svg>
    ) : null;

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {editable ? (
        <View style={styles.editCanvas}>
          <View style={{ width: svgW, height: svgH }} {...panResponder.panHandlers}>
            {svg}
          </View>
          <View style={styles.editHint} pointerEvents="none">
            <Ionicons name="move-outline" size={14} color={colors.textDim} />
            <Text style={styles.editHintText}>
              {selected
                ? 'Arrastra para mover · tira del punto azul para redimensionar'
                : 'Toca una habitación o mueble para seleccionarlo'}
            </Text>
          </View>
        </View>
      ) : scale > 0 ? (
        <ScrollView
          style={styles.scrollY}
          contentContainerStyle={{ alignItems: 'center' }}
          maximumZoomScale={1}
          showsVerticalScrollIndicator={false}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: 0 }}>
            {svg}
          </ScrollView>
        </ScrollView>
      ) : null}

      {/* Controles de zoom (solo vista) */}
      {!editable ? (
        <View style={styles.zoom}>
          <Pressable
            onPress={() => setZoomIdx((i) => Math.min(i + 1, ZOOM_STEPS.length - 1))}
            style={styles.zoomBtn}
            accessibilityLabel="Acercar"
          >
            <Ionicons name="add" size={20} color={colors.text} />
          </Pressable>
          <Pressable
            onPress={() => setZoomIdx((i) => Math.max(i - 1, 0))}
            style={styles.zoomBtn}
            accessibilityLabel="Alejar"
          >
            <Ionicons name="remove" size={20} color={colors.text} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  scrollY: { flex: 1 },
  editCanvas: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  editHint: {
    position: 'absolute',
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  editHintText: { color: colors.textDim, fontSize: 12 },
  zoom: { position: 'absolute', right: 12, top: 12, gap: 8 },
  zoomBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
