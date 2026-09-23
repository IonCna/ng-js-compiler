import type { auto, IRootScopeService } from "angular";

/**
 * El contrato del código compilado: lo que el build estampa en cada clase y deja en `globalThis`, tipado para quien
 * lo consuma en runtime. Solo tipos — nada de esto corre. Se publica a través de `ng-js-cli/contract` (quien consume
 * no necesita saber quién lo produce). Cada tipo describe el texto que emite el compilador; si uno cambia, cambia el
 * otro.
 */

// --- Nombres ---------------------------------------------------------------------------------------------------------

/**
 * Nombre de DI con que AngularJS registra/pide un token: `símboloExportado_hash8`, donde `hash8` son los primeros 8
 * hex de `sha256("símbolo:paquete")` y `paquete` es el `name` del `package.json` que declara el símbolo (ej.
 * `HttpClient_1a2b3c4d`). Un string literal en `@Inject("$http")` queda tal cual. Es el mismo en quien declara y en
 * quien usa: un runtime que provee un token de librería lo tiene que registrar con ESTE nombre.
 */
export type DiName = string;

/** Nombre de DI de la función que resuelve una dependencia con flags (ver `ResolveDependencyFn`). */
export type ResolveDependencyName = "ɵresolve";

/** jqLite `data()` que el `ɵfac` de cada `@Component` deja en su elemento (valor: el propio elemento) — límite de `@Host`. */
export type HostDataKey = "$ngjsHost";

/** jqLite `data()` donde vive el injector por elemento (el de los `providers` de `@Component`/`@Directive`). */
export type ScopedInjectorDataKey = "$ngjsScopedInjector";

/** Nombre de cada aporte de un multi-provider: `token#multi#<id del módulo>#i` (o `#import#i` si viene de un `ModuleWithProviders`). */
export type MultiProviderMemberName = `${DiName}#multi#${string}`;

// --- Factories --------------------------------------------------------------------------------------------------------

/** Anotación en array de AngularJS: nombres de DI y al final la función que construye. */
export type Annotation<T = unknown> = [...DiName[], (...args: never[]) => T];

/**
 * `ClassName.ɵfac` — la anotación con la que se construye la clase (`controller:` de `.component()`/`.directive()`,
 * factory de un servicio, instancia de un pipe). En `@Component`/`@Directive` los dos últimos nombres son siempre
 * `"$element"` y `"$scope"`. Las deps con flags se piden como `ResolveDependencyName`.
 */
export type CompiledFactory<T = unknown> = Annotation<T> & {
  /** `providers` del `@Component`/`@Directive` — recetas que resuelve el injector por elemento, lazy, por instancia. */
  ɵproviders?: ScopedProviderDescriptor[];
  /** Presente en los `@Component` (no en las `@Directive`). */
  ɵcomponent?: true;
};

/** Una receta de `ɵfac.ɵproviders` (providers de `@Component`/`@Directive`). */
export type ScopedProviderDescriptor =
  | { token: DiName; kind: "class"; ctor: CompiledClass }
  | { token: DiName; kind: "constructor" | "useClass"; ctor: CompiledClass; deps?: DiName[]; multi?: true }
  | { token: DiName; kind: "useValue"; value: unknown; multi?: true }
  | { token: DiName; kind: "useFactory"; factory: (...args: never[]) => unknown; deps: DiName[]; multi?: true }
  | { token: DiName; kind: "useExisting"; existing: DiName; multi?: true };

/** Flags de resolución de Angular (`@Optional()`/`@Self()`/`@SkipSelf()`/`@Host()`, `inject(X, { ... })`). */
export interface InjectFlags {
  optional?: boolean;
  self?: boolean;
  skipSelf?: boolean;
  host?: boolean;
}

/**
 * Lo que devuelve inyectar `ResolveDependencyName`: el factory la llama con el token y los flags (`element` = la
 * clase que pide es un `@Component`/`@Directive`). Sin injector de elemento, `self`/`host` en un elemento no
 * encuentran nada propio; con `optional`, `null` en vez de error.
 */
export type ResolveDependencyFn = (token: DiName, flags?: InjectFlags, element?: boolean) => unknown;

// --- Definiciones estampadas (forma de Ivy) ---------------------------------------------------------------------------

/** `ClassName.ɵprov` de `@Injectable`/`@Service`, y `TOKEN.ɵprov` de un `InjectionToken` de nivel de archivo. */
export interface InjectableDef<T = unknown> {
  token: DiName;
  providedIn?: "root";
  /** Con receta (`@Injectable({ useFactory, ... })`, `InjectionToken` con `factory`): cómo se provee solo. Si no, su `ɵfac`. */
  factory?: Annotation<T>;
}

/**
 * Una query — solo la definición (formato `ɵɵngDeclareComponent`); resolverla y el `QueryList` son del runtime.
 * `predicate`/`read` son getters: se resuelven al leerse (sirven con clases declaradas después o imports circulares).
 */
export interface QueryDef {
  propertyName: string;
  /** `@ViewChild`/`@ContentChild` (una) → `true`; los plurales (`QueryList`) → `false`. */
  first: boolean;
  descendants: boolean;
  static: boolean;
  /** Una clase, o nombres de `#ref`. */
  readonly predicate: CompiledClass | string[];
  readonly read?: unknown;
}

/** Un elemento de `hostDirectives` (siempre en la forma larga). `directive` es un getter, como en `QueryDef`. */
export interface HostDirectiveDef {
  readonly directive: CompiledClass;
  inputs?: string[];
  outputs?: string[];
}

/** `ClassName.ɵdir` / `ClassName.ɵcmp`. Una `@Directive()` abstracta (sin selector) lleva `selectors: []`. */
export interface DirectiveDef {
  /** Un array por selector de la lista: `[tag, attr, valor, ...]` — `"app-card"` → `[["app-card"]]`, `"[x]"` → `[["", "x", ""]]`. */
  selectors: string[][];
  /** Nombre público → propiedad (`@Input("aka") alias` → `{ aka: "alias" }`), con los de las bases del proyecto. */
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  exportAs?: string[];
  /** De contenido (`@ContentChild`/`@ContentChildren`). */
  queries?: QueryDef[];
  /** De vista (`@ViewChild`/`@ViewChildren`). */
  viewQueries?: QueryDef[];
  hostDirectives?: HostDirectiveDef[];
}

export type ComponentDef = DirectiveDef;

/** `ClassName.ɵpipe`. */
export interface PipeDef {
  name: string;
  pure: boolean;
}

/** `ClassName.ɵmod`: el id del `angular.module` que registró el build y los tags de `bootstrap`. */
export interface NgModuleDef {
  id: string;
  bootstrap?: string[];
}

/** Una clase tal como la deja el build (los campos presentes dependen de su decorador). */
export interface CompiledClass<T = unknown> {
  new (...args: never[]): T;
  ɵfac?: CompiledFactory<T>;
  ɵprov?: InjectableDef<T>;
  ɵcmp?: ComponentDef;
  ɵdir?: DirectiveDef;
  ɵpipe?: PipeDef;
  ɵmod?: NgModuleDef;
}

/** Un `InjectionToken` de nivel de archivo, ya estampado. */
export interface CompiledInjectionToken {
  ɵprov: InjectableDef;
}

/**
 * Lo que el compilado acepta como elemento de `imports` que viene de una llamada (`X.forRoot(...)`): con `ngModule`
 * se importa ese módulo y se registran sus `providers` (en runtime, por forma — como `isModuleWithProviders`). Un
 * token de esos `providers` tiene que tener nombre de DI en runtime: string, clase con `ɵprov` o `InjectionToken`.
 */
export interface ModuleWithProviders<T = CompiledClass> {
  ngModule: T;
  providers?: unknown[];
}

// --- Globales ---------------------------------------------------------------------------------------------------------

/** `globalThis.ɵngjsPlatform` — lo deja el build al inicio (solo en una aplicación); `platformBrowserDynamic()` lo devuelve. */
export interface NgjsPlatform {
  /** Arma el módulo raíz (`providedIn: "root"` primero, después `moduleType`), monta `bootstrap` y hace `angular.bootstrap`. */
  bootstrapModule(moduleType: CompiledClass): Promise<auto.IInjectorService>;
}

declare global {
  /** Ver `NgjsPlatform`. */
  var ɵngjsPlatform: NgjsPlatform | undefined;
  /** Cola de `providedIn: "root"`: `[nombre de DI, anotación]`, en orden de evaluación. */
  var ɵngjsRootProviders: [DiName, Annotation][] | undefined;
  /** El `$rootScope` de la app arrancada — lo usan los patches globales para disparar el digest. */
  var ɵngjsRootScope: IRootScopeService | undefined;
  /** El `$injector` de la app arrancada — lo usa `inject()` fuera de una construcción. */
  var ɵngjsInjector: auto.IInjectorService | undefined;
  /** Initializadores registrados por `provideAppInitializer()` antes del bootstrap. */
  var ɵngjsAppInitializers: ((injector: auto.IInjectorService) => void | Promise<unknown>)[] | undefined;
  /** Valores de los `inject()` de construcción, por clase dueña — solo mientras corre un factory. */
  var ɵngjsInjected: Record<string, unknown[]> | undefined;
}
