import type { BindingsMetadata, DecoratorMetadata, InjectDep, NgModuleMetadata } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

type ClassMetadata = Exclude<DecoratorMetadata, NgModuleMetadata>;
type ConstructorMetadata = Pick<ClassMetadata, "constructorTokens" | "constructorFlags" | "constructorAttributes">;
type ElementBindings = Omit<BindingsMetadata, "providers">;

/**
 * Herencia entre clases decoradas del proyecto, resuelta en build — la versión de compilación de `collectMetadata`
 * de `ngjs-core` (metadata por prototipo, juntada del padre al hijo) y del factory heredado de Ivy:
 * - el constructor: una clase sin `constructor` propio usa el de su ancestro más cercano que lo declare;
 * - los `inject()` de construcción: los de cada clase de la cadena, cada uno con su clave (`InjectedValues`);
 * - en `@Component`/`@Directive`, inputs/outputs/host y lifecycle de los ancestros elemento, el hijo pisa al padre.
 *
 * La cadena corta en la primera base que no es una clase decorada del proyecto (otra librería, o sin decorador —
 * una base sin decorador que use features de Angular ya es error en `DecoratorReader`, como en Angular).
 */
export class ClassHierarchy {
  /** `[raíz, ..., metadata]` — solo clases decoradas del proyecto. */
  static chain(metadata: ClassMetadata): ClassMetadata[] {
    const chain = [metadata];
    for (let current = metadata; current.superClass; ) {
      const parent = MetadataStore.findClass(current.superClass);
      if (!parent || parent.kind === "ngmodule" || chain.includes(parent)) break;
      chain.unshift(parent);
      current = parent;
    }
    return chain;
  }

  /** El constructor que corre al construir: el propio o, si la clase no declara uno, el del ancestro más cercano que sí. */
  static constructorOf(metadata: ClassMetadata): ConstructorMetadata {
    const owner = [...ClassHierarchy.chain(metadata)].reverse().find((candidate) => candidate.hasConstructor !== false);
    if (!owner) return { constructorTokens: [], constructorFlags: [], constructorAttributes: [] };
    return { constructorTokens: owner.constructorTokens, constructorFlags: owner.constructorFlags, constructorAttributes: owner.constructorAttributes };
  }

  /** Los `inject()` de construcción de toda la cadena (raíz primero), agrupados por la clase que los declara. */
  static injectsByClass(metadata: ClassMetadata): { owner: string; tokens: InjectDep[] }[] {
    return ClassHierarchy.chain(metadata)
      .filter((member) => member.injectTokens.length)
      .map((member) => ({ owner: member.className, tokens: member.injectTokens }));
  }

  /** Bindings de un `@Component`/`@Directive` con los de sus ancestros elemento (padre → hijo; el hijo pisa). */
  static bindingsOf(metadata: ClassMetadata & ElementBindings): ElementBindings {
    const elements = ClassHierarchy.chain(metadata).filter(
      (member): member is ClassMetadata & ElementBindings => member.kind === "component" || member.kind === "directive",
    );
    const merge = <T>(pick: (member: ElementBindings) => T[], key: (item: T) => string): T[] => {
      const byKey = new Map<string, T>();
      for (const member of elements) for (const item of pick(member)) byKey.set(key(item), item);
      return [...byKey.values()];
    };
    return {
      inputs: merge((member) => member.inputs, (input) => input.propName),
      outputs: merge((member) => member.outputs, (output) => output.propName),
      hostBindings: merge((member) => member.hostBindings, (binding) => binding.propName),
      hostListeners: merge((member) => member.hostListeners, (listener) => `${listener.eventName}:${listener.methodName}`),
      lifecycleHooks: merge((member) => member.lifecycleHooks, (hook) => hook),
      // Como Ivy (`ɵɵInheritDefinitionFeature`): las queries y los `hostDirectives` del padre también valen para el hijo.
      queries: merge((member) => member.queries, (query) => query.propertyName),
      hostDirectives: merge((member) => member.hostDirectives, (hostDirective) => hostDirective.directiveExpr),
    };
  }

  /** La metadata con lo heredado aplicado (constructor y, en elementos, bindings) — los `inject()` se piden aparte. */
  static effective<T extends ClassMetadata>(metadata: T): T {
    const withConstructor = { ...metadata, ...ClassHierarchy.constructorOf(metadata) };
    if (metadata.kind !== "component" && metadata.kind !== "directive") return withConstructor;
    return { ...withConstructor, ...ClassHierarchy.bindingsOf(metadata as ClassMetadata & ElementBindings) };
  }
}
