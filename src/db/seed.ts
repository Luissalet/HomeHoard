import type { DataSource } from './types';

// Casa de ejemplo para el primer arranque. Ejercita habitaciones con geometría,
// muebles anidados, objetos sueltos y en contenedores, y tags. Se ejecuta contra
// la interfaz DataSource, así que sirve igual para SQLite (nativo) y memoria (web).
export async function seedInitialHome(ds: DataSource): Promise<void> {
  const home = await ds.addHome('Mi casa', 'flat');
  const floor = await ds.addFloor(home.id, 'Planta única', 900, 700);

  // Habitaciones (colocadas en el lienzo 900×700 cm)
  const dormitorio = await ds.addRoom(floor.id, 'Dormitorio', { x_cm: 0, y_cm: 0, width_cm: 400, height_cm: 350 }, { kind: 'bedroom', color: '#3B82F6' });
  const salon = await ds.addRoom(floor.id, 'Salón', { x_cm: 400, y_cm: 0, width_cm: 500, height_cm: 350 }, { kind: 'living', color: '#22C55E' });
  const cocina = await ds.addRoom(floor.id, 'Cocina', { x_cm: 0, y_cm: 350, width_cm: 350, height_cm: 350 }, { kind: 'kitchen', color: '#F59E0B' });
  const bano = await ds.addRoom(floor.id, 'Baño', { x_cm: 350, y_cm: 350, width_cm: 300, height_cm: 200 }, { kind: 'bathroom', color: '#14B8A6' });

  // Muebles (coords relativas a su habitación)
  const armario = await ds.addContainer(dormitorio.id, 'Armario', { kind: 'wardrobe', rect: { x_cm: 20, y_cm: 20, width_cm: 150, height_cm: 60 } });
  const cajonSup = await ds.addContainer(dormitorio.id, 'Cajón superior', { kind: 'drawer', parentContainerId: armario.id });
  const baldaInf = await ds.addContainer(dormitorio.id, 'Balda inferior', { kind: 'shelf', parentContainerId: armario.id });
  const mesita = await ds.addContainer(dormitorio.id, 'Mesita de noche', { kind: 'nightstand', rect: { x_cm: 300, y_cm: 20, width_cm: 80, height_cm: 60 } });

  const estanteria = await ds.addContainer(salon.id, 'Estantería', { kind: 'shelf', rect: { x_cm: 20, y_cm: 20, width_cm: 250, height_cm: 40 } });

  const nevera = await ds.addContainer(cocina.id, 'Nevera', { kind: 'fridge', rect: { x_cm: 20, y_cm: 20, width_cm: 70, height_cm: 70 } });
  const alacena = await ds.addContainer(cocina.id, 'Alacena', { kind: 'cabinet', rect: { x_cm: 150, y_cm: 20, width_cm: 140, height_cm: 50 } });

  // Tags
  const tImportante = await ds.createTag('Importante', '#EF4444');
  const tInvierno = await ds.createTag('Invierno', '#3B82F6');
  const tDocs = await ds.createTag('Documentos', '#F59E0B');
  const tFragil = await ds.createTag('Frágil', '#EC4899');

  // Objetos
  await ds.addItem({ name: 'Pasaporte', room_id: dormitorio.id, container_id: cajonSup.id, description: 'Caduca en 2030', favorite: true, tagIds: [tImportante.id, tDocs.id] });
  await ds.addItem({ name: 'Bufanda azul', room_id: dormitorio.id, container_id: armario.id, tagIds: [tInvierno.id] });
  await ds.addItem({ name: 'Zapatillas running', room_id: dormitorio.id, container_id: baldaInf.id });
  await ds.addItem({ name: 'Cargador de móvil', room_id: dormitorio.id, container_id: mesita.id });
  await ds.addItem({ name: 'Silla plegable', room_id: salon.id, container_id: null, quantity: 2, description: 'Suelta, junto al sofá' });
  await ds.addItem({ name: 'Mando de la TV', room_id: salon.id, container_id: estanteria.id });
  await ds.addItem({ name: 'Tomate frito', room_id: cocina.id, container_id: nevera.id, quantity: 3 });
  await ds.addItem({ name: 'Vajilla buena', room_id: cocina.id, container_id: alacena.id, tagIds: [tFragil.id] });
  await ds.addItem({ name: 'Botiquín', room_id: bano.id, container_id: null, tagIds: [tImportante.id] });
}
