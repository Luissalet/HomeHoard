// Estado de la sincronización con el ordenador para la interfaz.
import { useEffect, useState } from 'react';
import { getServerSync, type SyncStatus } from './serverSync';

const OFF: SyncStatus = { mode: 'off', base: null, version: null, lastSync: null, pending: 0, error: null };

export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(() => getServerSync()?.status ?? OFF);
  useEffect(() => {
    const sync = getServerSync();
    if (!sync) return;
    return sync.subscribe(setStatus);
  }, []);
  return status;
}

export const SYNC_LABEL: Record<SyncStatus['mode'], string> = {
  off: 'Solo en este dispositivo',
  connecting: 'Conectando con el ordenador…',
  online: 'Guardado en el ordenador',
  offline: 'Sin conexión con el ordenador',
  demo: 'Casa de ejemplo: no se guarda en el ordenador',
};
