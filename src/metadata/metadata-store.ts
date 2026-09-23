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

  /**
   * Una clase decorada por nombre, en cualquier archivo ya leído (los nombres son únicos en el proyecto — ver
   * `ApplicationScanner`, que lee todo antes de emitir). Para `ClassHierarchy`: la base de un `extends` suele estar
   * en otro archivo.
   */
  static findClass(className: string): DecoratorMetadata | undefined {
    for (const metadata of MetadataStore.store.values()) {
      const found = metadata.find((candidate) => candidate.className === className);
      if (found) return found;
    }
    return undefined;
  }

  /** Todo lo leído, por archivo (`[path, metadata]`). */
  static entries(): [string, DecoratorMetadata[]][] {
    return [...MetadataStore.store.entries()];
  }

  static clear(): void {
    MetadataStore.store.clear();
  }
}
