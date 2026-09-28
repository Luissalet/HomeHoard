import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useData } from '../src/db/provider';
import { parseLabel } from '../src/features/qrPayload';
import { colors, space } from '../src/theme';
import { Button } from '../src/ui/components';

export default function ScanScreen() {
  const router = useRouter();
  const data = useData();
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState('Apunta a una etiqueta de HomeHoard.');
  const busy = useRef(false);

  async function openLabel(raw: string) {
    if (busy.current) return;
    busy.current = true;
    try {
      const label = parseLabel(raw);
      if (!label) {
        setMessage('Este QR no es una etiqueta de HomeHoard.');
        return;
      }
      const found = label.kind === 'container' ? await data.getContainer(label.id) : await data.getItem(label.id);
      if (!found) {
        setMessage('La etiqueta apunta a un objeto que ya no está en este inventario.');
        return;
      }
      router.replace(`/${label.kind}/${label.id}`);
    } catch {
      setMessage('No se pudo abrir la ficha. Inténtalo de nuevo.');
    } finally {
      setTimeout(() => { busy.current = false; }, 1200);
    }
  }

  return (
    <View style={styles.wrap}>
      <Stack.Screen options={{ title: 'Escanear etiqueta' }} />
      {permission?.granted ? (
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data: value }) => { void openLabel(value); }}
        />
      ) : (
        <View style={styles.permission}>
          <Text style={styles.text}>La cámara se usa solo para leer etiquetas QR de tu inventario.</Text>
          <Button label="Abrir cámara" onPress={() => { void requestPermission(); }} />
        </View>
      )}
      <Text style={styles.message} accessibilityLiveRegion="polite">{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  camera: { flex: 1 },
  permission: { flex: 1, justifyContent: 'center', padding: space(5), gap: space(4) },
  text: { color: colors.text, fontSize: 16 },
  message: { color: colors.text, textAlign: 'center', padding: space(4) },
});
