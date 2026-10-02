// Catálogo de plantillas de mantenimiento (compartido con el servidor: shared/maintenance-templates.json).
import catalogue from '../../shared/maintenance-templates.json';
import type { TemplateCatalogue } from './maintenanceCore';

export const CATALOGUE = catalogue as TemplateCatalogue;
export const TEMPLATES = CATALOGUE.templates;
export const templateById = (id: string | null | undefined) => TEMPLATES.find((t) => t.id === id) ?? null;
