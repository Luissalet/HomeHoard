import React, { createContext, useContext, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from '../theme';
import { Button, Input } from './components';

interface PromptOptions {
  title: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
}

type Resolver = (value: string | null) => void;

const PromptContext = createContext<((opts: PromptOptions) => Promise<string | null>) | null>(null);

/** Pide un texto al usuario mediante un modal. Multiplataforma (móvil + web). */
export const usePrompt = () => {
  const ctx = useContext(PromptContext);
  if (!ctx) throw new Error('usePrompt() debe usarse dentro de <PromptProvider>');
  return ctx;
};

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [opts, setOpts] = useState<PromptOptions>({ title: '' });
  const [value, setValue] = useState('');
  const resolver = useRef<Resolver | null>(null);

  const prompt = (o: PromptOptions) =>
    new Promise<string | null>((resolve) => {
      setOpts(o);
      setValue(o.initialValue ?? '');
      resolver.current = resolve;
      setVisible(true);
    });

  const close = (result: string | null) => {
    setVisible(false);
    resolver.current?.(result);
    resolver.current = null;
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => close(null)}>
        <Pressable style={styles.backdrop} onPress={() => close(null)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center}>
            <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
              <Text style={styles.title}>{opts.title}</Text>
              <Input
                value={value}
                onChangeText={setValue}
                placeholder={opts.placeholder}
                autoFocus
                onSubmitEditing={() => value.trim() && close(value.trim())}
                returnKeyType="done"
              />
              <View style={styles.actions}>
                <View style={{ flex: 1 }}>
                  <Button label="Cancelar" variant="ghost" onPress={() => close(null)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label={opts.confirmLabel ?? 'Guardar'}
                    onPress={() => (value.trim() ? close(value.trim()) : close(null))}
                  />
                </View>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </PromptContext.Provider>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  center: { flex: 1, justifyContent: 'center', paddingHorizontal: space(6) },
  sheet: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space(5), gap: space(4), borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: space(3) },
});
