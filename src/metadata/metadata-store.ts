import type { DecoratorMetadata } from "@/metadata/decorator-metadata.ts";

/**
 * Canal entre el plugin de lectura (guarda) y el de codegen (lee) — evita
 * meterle un `context` extra a `NgjsTransform`. Clave = path del archivo;
 * valor = un array, porque un archivo puede tener más de una clase decorada.
 * Al recorrer, el de codegen decide qué generar según `metadata.kind`.
 */
export class MetadataStore {
  private static readonly store = new Map<string, DecoratorMetadata[]>();

  static set(path: string, metadata: DecoratorMetadata[]): void {
    MetadataStore.store.set(path, metadata);
  }

  static get(path: string): DecoratorMetadata[] {
    return MetadataStore.store.get(path) ?? [];
  }

  static clear(): void {
    MetadataStore.store.clear();
  }
}
