// La casa en 3D vive en la web que sirve el ordenador (ver House3DView.web.tsx). En el móvil, que guarda su copia en el
// propio dispositivo, se explica dónde verla.
import React from 'react';
import { View } from 'react-native';
import type { ID } from '../db/types';
import { colors } from '../theme';
import { EmptyState } from '../ui/components';

export interface House3DProps {
  /** Objeto al que llevar la cámara al abrir. */
  focusItemId?: ID;
  /** La vista pide volver al plano 2D (casa sin habitaciones). */
  onShowPlan?: () => void;
}

export function House3DView(_props: House3DProps) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
      <EmptyState
        icon="cube-outline"
        title="La casa en 3D está en el ordenador"
        subtitle="Abre HomeHoard en el navegador del ordenador que guarda la casa: la pestaña Plano tiene la vista Casa 3D."
      />
    </View>
  );
}
