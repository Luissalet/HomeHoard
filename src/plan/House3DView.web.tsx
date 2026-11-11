// La casa en 3D dentro de la pestaña Plano: la página /casa3d del ordenador en un marco. La página avisa con mensajes
// cuando hay que abrir una ficha, cuando ha cambiado el plano (puertas, ventanas) o cuando no hay nada que levantar.
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getServerSync } from '../db/serverSync';
import { useSyncStatus } from '../db/useSync';
import { flushLocal, OFFLINE_MESSAGE, refreshFromServer } from '../features/serverApi';
import { colors } from '../theme';
import { EmptyState } from '../ui/components';
import type { House3DProps } from './House3DView';

const OPENABLE = /^\/(?:(?:item|room|container)\/[A-Za-z0-9_.:-]{1,200}|plan|maintenance)$/;

export function House3DView({ focusItemId, onShowPlan }: House3DProps) {
  const router = useRouter();
  const sync = useSyncStatus();
  const connected = sync.mode === 'online';
  const [ready, setReady] = useState(false);
  const base = connected ? getServerSync()?.url('') ?? null : null;

  // Lo último que se haya tocado en esta web llega al ordenador antes de que él levante la casa.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    void flushLocal().catch(() => undefined).then(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [connected]);

  useEffect(() => {
    if (base === null) return;
    const origin = new URL(base || '/', window.location.href).origin;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; path?: unknown } | null;
      if (event.origin !== origin || !data || data.source !== 'homehoard-casa3d') return;
      if (data.type === 'open' && typeof data.path === 'string' && OPENABLE.test(data.path)) router.push(data.path as never);
      else if (data.type === 'changed') void refreshFromServer().catch(() => undefined);
      else if (data.type === 'view') onShowPlan?.();
      else if (data.type === 'expand') window.location.assign(`${base}/casa3d`);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [base, router, onShowPlan]);

  if (base === null || !ready) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
        <EmptyState icon="cube-outline" title={connected ? 'Levantando la casa…' : 'La casa en 3D necesita el ordenador'} subtitle={connected ? undefined : OFFLINE_MESSAGE} />
      </View>
    );
  }
  const src = `${base}/casa3d?embed=1${focusItemId ? `&objeto=${encodeURIComponent(focusItemId)}` : ''}`;
  return React.createElement('iframe', {
    key: src,
    src,
    title: 'Casa en 3D',
    allow: 'fullscreen',
    style: { border: 0, width: '100%', height: '100%', display: 'block', backgroundColor: colors.bg },
  });
}
