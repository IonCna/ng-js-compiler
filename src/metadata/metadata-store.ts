import { AsyncLocalStorage } from "node:async_hooks";
import type { DecoratorMetadata } from "@/metadata/decorator-metadata.ts";

/** La metadata de UNA compilación (un `ApplicationScanner`): clave = path del archivo. */
export type MetadataScope = Map<string, DecoratorMetadata[]>;

/**
 * Canal entre el plugin de lectura (guarda) y el de codegen (lee) — evita
 * meterle un `context` extra a `NgjsTransform`. Clave = path del archivo;
 * valor = un array, porque un archivo puede tener más de una clase decorada.
 * Al recorrer, el de codegen decide qué generar según `metadata.kind`.
 *
 * Cada compilación tiene su propio scope (`within`): dos builds en el mismo proceso (ESM + CJS en paralelo) o dos
 * escaneos seguidos del dev-server no se ven entre sí, y un archivo borrado del proyecto no sobrevive al escaneo
 * siguiente. Fuera de un `within` (tests unitarios) se usa un scope por defecto.
 */
export class MetadataStore {
  private static readonly fallback: MetadataScope = new Map();
  private static readonly current = new AsyncLocalStorage<MetadataScope>();

  private static get store(): MetadataScope {
    return MetadataStore.current.getStore() ?? MetadataStore.fallback;
  }

  /** Un scope vacío para una compilación nueva. */
  static scope(): MetadataScope {
    return new Map();
  }

  /** Corre `fn` (y todo lo async que dispare) contra `scope`. */
  static within<T>(scope: MetadataScope, fn: () => T): T {
    return MetadataStore.current.run(scope, fn);
  }

  static set(path: string, metadata: DecoratorMetadata[]): void {
    MetadataStore.store.set(path, metadata);
  }

  /** El archivo ya no tiene clases decoradas: sin esto, la emisión seguiría viendo las de antes. */
  static delete(path: string): void {
    MetadataStore.store.delete(path);
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
