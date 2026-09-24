/**
 * Lo que arma el plugin de lectura (`DecoratorReader`, todavía sin construir)
 * y consume el de codegen — un tipo por decorador, discriminados por `kind`.
 * Solo se CONSTRUYE la lectura de `@Component` primero, pero el tipo ya
 * contempla los demás decoradores.
 */
/**
 * Flags de resolución de Angular (`@Optional`/`@Self`/`@SkipSelf`/`@Host`, `inject(X, { ... })`, `[new Optional(), X]`
 * en `deps`) — misma forma que `InjectOptions`. Los resuelve `ɵresolve` al construir (ver `ResolveDependency`).
 */
export interface InjectFlags {
  optional?: boolean;
  self?: boolean;
  skipSelf?: boolean;
  host?: boolean;
}

/** Un `inject(Token)` / `inject(Token, flags)` reemplazado en build (`InjectedValues.ref`). */
export interface InjectDep {
  token: string;
  flags: InjectFlags;
}

/**
 * Cómo se construye la clase (su `ɵfac`) — lo comparten todos los decoradores, `@NgModule` incluido: Angular
 * instancia la clase del módulo al crear su injector, con DI en el constructor.
 */
export interface ConstructionMetadata {
  className: string;
  /**
   * `extends Base` — el nombre exportado de la base (también si se importó con alias). Si es una clase decorada del
   * proyecto, `ClassHierarchy` hereda de ella el constructor, los `inject()` y los bindings.
   */
  superClass?: string;
  /** La clase declara su propio `constructor` (si no, en una subclase se usa el de la base, como el factory heredado de Ivy). */
  hasConstructor?: boolean;
  /**
   * Nombre de DI de cada parámetro del constructor, en orden y YA resuelto en
   * build (`TokenName`) — de `@Inject(Token)` si lo tiene, si no de la anotación
   * de tipo (`constructor(private http: HttpClient)`, como en Angular real).
   * `@Inject("$http")` (string) queda tal cual: ya es el nombre de AngularJS.
   */
  constructorTokens: string[];
  /** Paralelo a `constructorTokens`: `@Optional()`/`@Self()`/`@SkipSelf()`/`@Host()` del parámetro (`{}` si no lleva). */
  constructorFlags: InjectFlags[];
  /**
   * Paralelo a `constructorTokens`: el nombre de `@Attribute("x")` si el parámetro lo lleva (ahí el token queda
   * `""`: no es DI, es el atributo estático del host — solo `@Component`/`@Directive`), si no `null`.
   */
  constructorAttributes: (string | null)[];
  /**
   * `inject(Token)` durante la construcción (inicializador de campo o cuerpo del constructor), en el orden en
   * que se reemplazaron (`InjectedValues.ref(clase, i)`) — se piden en el `ɵfac` después de los del constructor.
   */
  injectTokens: InjectDep[];
  /**
   * De qué archivos vienen esas dependencias (specifier tal cual, sin repetir). `ɵfac` lleva strings, así que
   * un import usado solo como tipo se eliminaría y ese archivo nunca se evaluaría (un `providedIn: "root"` no se
   * registraría); `DecoratorWriter` emite un import de efecto por cada uno, como la referencia de valor de Ivy.
   */
  constructorImports: string[];
}

interface BaseMetadata extends ConstructionMetadata {
  options: Record<string, unknown>;
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
 *
 * `depFlags` (paralelo a `deps`): `[new Optional(), new Self(), X]` en `deps`. `injectTokens`: los `inject()` del cuerpo
 * de un `useFactory` (arrow/función literal), ya reemplazados en `factoryExpr` (`InjectedValues`). Ver `FactoryCode`.
 */
export type ProviderMetadata =
  | { kind: "class"; token: string; classExpr: string }
  | { kind: "constructor"; token: string; classExpr: string; deps?: string[]; depFlags?: InjectFlags[]; multi: boolean }
  | { kind: "useClass"; token: string; classExpr: string; deps?: string[]; depFlags?: InjectFlags[]; multi: boolean }
  | { kind: "useValue"; token: string; valueExpr: string; multi: boolean }
  | { kind: "useFactory"; token: string; factoryExpr: string; deps: string[]; depFlags?: InjectFlags[]; injectTokens?: InjectDep[]; multi: boolean }
  | { kind: "useExisting"; token: string; existingToken: string; multi: boolean };

export interface BindingsMetadata {
  /** `mode: "@"` = `@Input({ binding: "@" })`, binding de interpolación de AngularJS; sin `mode`, `<`. */
  inputs: { propName: string; bindingName: string; mode?: "@" }[];
  outputs: { propName: string; bindingName: string }[];
  hostBindings: { propName: string; hostProperty: string }[];
  /**
   * `args` son las expresiones del segundo argumento de `@HostListener` (`['$event', '$event.target']`),
   * ya validadas en build: cada una tiene que empezar con `$event` (nada más se resuelve). Sin segundo
   * argumento (`@HostListener('click')`) queda `[]` — el método se llama sin parámetros, como en Angular real.
   */
  hostListeners: { methodName: string; eventName: string; args: string[] }[];
  /** Solo se lee — todavía no se emite nada con ellos (providers a nivel componente es un ítem aparte). */
  providers: ProviderMetadata[];
  /**
   * Nombres de método de ciclo de vida de Angular real presentes en la clase (`ngOnInit`, `ngOnChanges`,
   * `ngDoCheck`, `ngAfterContentInit`, `ngAfterViewInit`, `ngAfterContentChecked`, `ngAfterViewChecked`,
   * `ngOnDestroy`) — no son decoradores, se detectan por nombre de método. Ver `LifecycleWiring`.
   */
  lifecycleHooks: string[];
  /** `@ViewChild`/`@ViewChildren`/`@ContentChild`/`@ContentChildren` — solo la definición (ver `QueryMetadata`). */
  queries: QueryMetadata[];
  /** `hostDirectives` del decorador — solo la definición (ver `HostDirectiveMetadata`). */
  hostDirectives: HostDirectiveMetadata[];
}

/**
 * Una query, en el formato de datos de Ivy (`ɵɵngDeclareComponent`: `queries`/`viewQueries`). El compilador solo
 * la define — resolverla (y el `QueryList`) es del runtime. `predicate` es una clase (texto fuente de la referencia,
 * `forwardRef` ya desenvuelto) o nombres de `#ref`; `read` igual que una clase.
 */
export interface QueryMetadata {
  kind: "view" | "content";
  propertyName: string;
  /** `true` en `@ViewChild`/`@ContentChild` (una), `false` en los plurales (`QueryList`). */
  first: boolean;
  predicate: { kind: "type"; expr: string } | { kind: "names"; names: string[] };
  descendants: boolean;
  static: boolean;
  readExpr?: string;
}

/** Un elemento de `hostDirectives` (forma corta `X` o larga `{ directive, inputs, outputs }`), texto fuente de la clase. */
export interface HostDirectiveMetadata {
  directiveExpr: string;
  inputs?: string[];
  outputs?: string[];
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
  /** `@Injectable({ useClass/useValue/useFactory/useExisting, deps })`: con qué se provee la clase (`ɵprov.factory`). */
  recipe?: ProviderMetadata;
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
 * - `call` — cualquier otra llamada (`ConfigModule.forRoot(options)`): no se sabe en build qué devuelve, se
 *   evalúa al correr. Si el resultado trae `ngModule` es un `ModuleWithProviders` (se importa `ngModule` y
 *   se registran sus `providers`); si no, se trata como un módulo más. Por forma, no por nombre del método.
 */
export type ModuleImport =
  | { kind: "name"; name: string }
  | { kind: "reference"; identifier: string }
  | { kind: "expression"; expr: string }
  | { kind: "angularModule"; expr: string }
  | { kind: "call"; expr: string };

/**
 * `declarations`/`bootstrap` de `@NgModule` son ARRAYS DE IDENTIFICADORES
 * (`[CardComponent]`), no literales — por eso van como `string[]` (el nombre
 * tal cual aparece en el código, ya importado en ese archivo), no evaluados
 * como el resto de `options`. `imports` además admite módulos legacy (`ModuleImport`).
 *
 * Sin `id`: el `id` real de `angular.module(...)` sale de un hash (`HashId`,
 * en `ModuleWriter`), determinista — el módulo que importa a otro calcula el
 * mismo id sin esperar a que ese otro archivo se haya procesado.
 *
 * Como en Angular, la clase se instancia (con DI) al crear el injector del módulo; hereda de su base decorada
 * solo el constructor (`ClassHierarchy`), nunca `declarations`/`imports`/`providers`/`bootstrap`.
 */
export interface NgModuleMetadata extends ConstructionMetadata {
  kind: "ngmodule";
  /** Nombre de DI de la propia clase (`TokenName`) — la clase del módulo es inyectable, como en Angular. */
  token: string;
  declarations: string[];
  imports: ModuleImport[];
  providers: ProviderMetadata[];
  bootstrap: string[];
  controllerAs?: string;
}

export type DecoratorMetadata = ComponentMetadata | DirectiveMetadata | PipeMetadata | ServiceMetadata | NgModuleMetadata;
