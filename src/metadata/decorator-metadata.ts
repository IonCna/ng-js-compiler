/**
 * Lo que arma el plugin de lectura (`DecoratorReader`, todavía sin construir)
 * y consume el de codegen — un tipo por decorador, discriminados por `kind`.
 * Solo se CONSTRUYE la lectura de `@Component` primero, pero el tipo ya
 * contempla los demás decoradores.
 */
interface BaseMetadata {
  className: string;
  options: Record<string, unknown>;
  /**
   * Nombre de DI de cada parámetro del constructor, en orden y YA resuelto en
   * build (`TokenName`) — de `@Inject(Token)` si lo tiene, si no de la anotación
   * de tipo (`constructor(private http: HttpClient)`, como en Angular real).
   * `@Inject("$http")` (string) queda tal cual: ya es el nombre de AngularJS.
   */
  constructorTokens: string[];
  /**
   * De qué archivos vienen esas dependencias (specifier tal cual, sin repetir). `ɵfac` lleva strings, así que
   * un import usado solo como tipo se eliminaría y ese archivo nunca se evaluaría (un `providedIn: "root"` no se
   * registraría); `DecoratorWriter` emite un import de efecto por cada uno, como la referencia de valor de Ivy.
   */
  constructorImports: string[];
}

/**
 * Un provider de `providers: [...]`, ya clasificado en build (como el
 * `providerToFactory` de Angular). `token`/`deps`/`existingToken` son nombres
 * de DI ya resueltos (`TokenName`, o el string tal cual si era un literal);
 * los `*Expr` son el TEXTO fuente de la expresión (no se evalúa nada):
 * - `class` — `UserService` suelto.
 * - `constructor` — `{ provide: X }`/`{ provide: X, deps: [...] }`: sin `deps`
 *   usa el `ɵfac` de `X`, con `deps` hace `new X(...deps)`.
 * - `useClass` — igual que `constructor` pero con otra clase.
 * - `useValue`/`useFactory`/`useExisting` — como en Angular.
 */
export type ProviderMetadata =
  | { kind: "class"; token: string; classExpr: string }
  | { kind: "constructor"; token: string; classExpr: string; deps?: string[]; multi: boolean }
  | { kind: "useClass"; token: string; classExpr: string; deps?: string[]; multi: boolean }
  | { kind: "useValue"; token: string; valueExpr: string; multi: boolean }
  | { kind: "useFactory"; token: string; factoryExpr: string; deps: string[]; multi: boolean }
  | { kind: "useExisting"; token: string; existingToken: string; multi: boolean };

export interface BindingsMetadata {
  inputs: { propName: string; bindingName: string }[];
  outputs: { propName: string; bindingName: string }[];
  hostBindings: { propName: string; hostProperty: string }[];
  hostListeners: { methodName: string; eventName: string }[];
  /** Solo se lee — todavía no se emite nada con ellos (providers a nivel componente es un ítem aparte). */
  providers: ProviderMetadata[];
}

export interface ComponentMetadata extends BaseMetadata, BindingsMetadata {
  kind: "component";
}

export interface DirectiveMetadata extends BaseMetadata, BindingsMetadata {
  kind: "directive";
}

export interface PipeMetadata extends BaseMetadata {
  kind: "pipe";
}

export interface ServiceMetadata extends BaseMetadata {
  kind: "service" | "injectable";
  /** Nombre de DI de la propia clase (`TokenName`) — el `token` de `ɵprov`. */
  token: string;
}

/**
 * Un elemento de `imports` de `@NgModule`, sin resolver todavía (eso es del
 * scanner, que conoce todo el proyecto):
 * - `name` — `"ngAnimate"`: nombre de un módulo de AngularJS, tal cual.
 * - `reference` — `FeatureModule`/`legacyModule`: si es un `@NgModule` del
 *   proyecto se usa su id; si no, un `@NgModule` de otro paquete (su `ɵmod.id`)
 *   o un `angular.IModule` legacy (su `.name`), resuelto al correr.
 * - `expression` — `legacy.module`: igual que una referencia que no es del
 *   proyecto; texto fuente de la expresión.
 * - `angularModule` — `angular.module("x")`: siempre un `IModule`.
 */
export type ModuleImport =
  | { kind: "name"; name: string }
  | { kind: "reference"; identifier: string }
  | { kind: "expression"; expr: string }
  | { kind: "angularModule"; expr: string };

/**
 * `declarations`/`bootstrap` de `@NgModule` son ARRAYS DE IDENTIFICADORES
 * (`[CardComponent]`), no literales — por eso van como `string[]` (el nombre
 * tal cual aparece en el código, ya importado en ese archivo), no evaluados
 * como el resto de `options`. `imports` además admite módulos legacy (`ModuleImport`).
 *
 * Sin `id`: el `id` real de `angular.module(...)` sale de un hash (`HashId`,
 * en `ModuleWriter`), determinista — el módulo que importa a otro calcula el
 * mismo id sin esperar a que ese otro archivo se haya procesado.
 */
export interface NgModuleMetadata {
  kind: "ngmodule";
  className: string;
  declarations: string[];
  imports: ModuleImport[];
  providers: ProviderMetadata[];
  bootstrap: string[];
  controllerAs?: string;
}

export type DecoratorMetadata = ComponentMetadata | DirectiveMetadata | PipeMetadata | ServiceMetadata | NgModuleMetadata;
