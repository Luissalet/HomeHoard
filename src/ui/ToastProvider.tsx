import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from '../theme';

export interface ToastOptions {
  /** Texto de la acción opcional (p. ej. "Deshacer"). */
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  durationMs?: number;
}

type ShowToast = (message: string, opts?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

/** Notificaciones ligeras con acción opcional (deshacer). Multiplataforma. */
export const useToast = (): ShowToast => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() debe usarse dentro de <ToastProvider>');
  return ctx;
};

interface ToastState {
  id: number;
  message: string;
  opts?: ToastOptions;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counter = useRef(0);

  const hide = useCallback(() => {
    Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
      setToast(null);
    });
  }, [opacity]);

  const show = useCallback<ShowToast>(
    (message, opts) => {
      counter.current += 1;
      setToast({ id: counter.current, message, opts });
    },
    []
  );

  useEffect(() => {
    if (!toast) return;
    if (timer.current) clearTimeout(timer.current);
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    timer.current = setTimeout(hide, toast.opts?.durationMs ?? (toast.opts?.actionLabel ? 5000 : 2500));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, opacity, hide]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <Animated.View style={[styles.wrap, { opacity }]} pointerEvents="box-none">
          <View style={styles.toast}>
            <Text style={styles.msg} numberOfLines={2}>
              {toast.message}
            </Text>
            {toast.opts?.actionLabel ? (
              <Pressable
                hitSlop={10}
                onPress={async () => {
                  hide();
                  await toast.opts?.onAction?.();
                }}
              >
                <Text style={styles.action}>{toast.opts.actionLabel}</Text>
              </Pressable>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: space(24),
    alignItems: 'center',
    zIndex: 1000,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(4),
    maxWidth: 480,
    marginHorizontal: space(5),
    backgroundColor: '#26262E',
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  msg: { color: colors.bg, fontSize: 14, flexShrink: 1 },
  action: { color: '#8FD3BB', fontSize: 14, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
});
