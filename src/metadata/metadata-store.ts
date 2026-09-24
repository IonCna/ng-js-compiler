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
   * Una clase decorada por nombre, como se ve desde `from`: primero una del mismo archivo (puede ser no exportada),
   * después una exportada de cualquier archivo ya leído (esas son únicas en el proyecto — ver `ApplicationScanner`,
   * que lee todo antes de emitir). Para `ClassHierarchy`: la base de un `extends` suele estar en otro archivo.
   */
  static findClass(className: string, from?: DecoratorMetadata): DecoratorMetadata | undefined {
    const sameFile = from && [...MetadataStore.store.values()].find((metadata) => metadata.includes(from));
    const own = sameFile?.find((candidate) => candidate.className === className);
    if (own) return own;
    for (const metadata of MetadataStore.store.values()) {
      const found = metadata.find((candidate) => candidate.className === className && !candidate.local);
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
