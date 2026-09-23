import { parse } from "@swc/core";
import type {
  ArrayExpression,
  BindingIdentifier,
  BooleanLiteral,
  ClassDeclaration,
  ClassMember,
  Decorator,
  Expression,
  ModuleItem,
  NumericLiteral,
  ObjectExpression,
  Param,
  Pattern,
  PropertyName,
  Span,
  StringLiteral,
  TsParameterProperty,
} from "@swc/core";
import { TokenName } from "@/compiler/token-name.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { InjectedValues } from "@/compiler/injected-values.ts";
import { ResolveDependency } from "@/compiler/resolve-dependency.ts";
import type {
  BindingsMetadata,
  DecoratorMetadata,
  HostDirectiveMetadata,
  InjectDep,
  InjectFlags,
  ModuleImport,
  ProviderMetadata,
  QueryMetadata,
} from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

/** Nombre local de un import → símbolo exportado + paquete (`undefined` = relativo, mismo paquete que el archivo). */
type ImportMap = Map<string, { symbol: string; packageName: string | undefined; specifier: string }>;

/** Un span a sacar del código, o a reemplazar por `replacement` (`inject()` → `InjectedValues.ref`). */
type SourceEdit = Span & { replacement?: string };

/** Inputs/outputs/host de la clase — los `providers` se leen aparte, del objeto del decorador. */
type ClassBindings = Omit<BindingsMetadata, "providers" | "hostDirectives">;

/** Lo que cada clase del archivo necesita para resolver nombres de DI (`TokenName`). */
interface FileContext {
  path: string;
  code: string;
  imports: ImportMap;
}

/** Claves que acepta un provider objeto — cualquier otra es error (no se ignora en silencio). */
const PROVIDER_KEYS = new Set(["provide", "useClass", "useValue", "useFactory", "useExisting", "deps", "multi"]);
const PROVIDER_RECIPES = ["useClass", "useValue", "useFactory", "useExisting"] as const;

const CLASS_DECORATOR_KIND: Record<string, DecoratorMetadata["kind"]> = {
  Component: "component",
  Directive: "directive",
  Pipe: "pipe",
  Service: "service",
  Injectable: "injectable",
  NgModule: "ngmodule",
};

/** Flags de DI de Angular: decorador de parámetro / clase en `deps` (`new Optional()`) → clave en `InjectFlags`. */
const INJECT_FLAG_BY_NAME: Record<string, keyof InjectFlags> = { Optional: "optional", Self: "self", SkipSelf: "skipSelf", Host: "host" };
/** Decoradores de miembro / parámetro que solo tienen sentido en una clase decorada (ver `assertNoAngularFeatures`). */
const ANGULAR_MEMBER_DECORATORS = new Set([
  "Input",
  "Output",
  "HostBinding",
  "HostListener",
  "Inject",
  "Optional",
  "Self",
  "SkipSelf",
  "Host",
  "Attribute",
  "ViewChild",
  "ViewChildren",
  "ContentChild",
  "ContentChildren",
]);
/** Queries de Angular: de vista o de contenido, una o varias, y el default de `descendants`. */
const QUERY_DECORATORS: Record<string, { kind: "view" | "content"; first: boolean; descendants: boolean }> = {
  ViewChild: { kind: "view", first: true, descendants: true },
  ViewChildren: { kind: "view", first: false, descendants: true },
  ContentChild: { kind: "content", first: true, descendants: true },
  ContentChildren: { kind: "content", first: false, descendants: false },
};
/** Opciones de `inject(Token, { ... })`. */
const INJECT_OPTION_KEYS = new Set<string>(["optional", "self", "skipSelf", "host"]);

/** Nodos cuyo cuerpo NO corre durante la construcción — un `inject()` adentro se deja para runtime. */
const NESTED_SCOPES = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration", "ClassExpression", "ClassDeclaration"]);

/** No son decoradores — se detectan por nombre de método (como Angular real: se implementan por convención). Ver `LifecycleWiring`. */
const LIFECYCLE_HOOK_NAMES = new Set([
  "ngOnChanges",
  "ngOnInit",
  "ngDoCheck",
  "ngAfterContentInit",
  "ngAfterContentChecked",
  "ngAfterViewInit",
  "ngAfterViewChecked",
  "ngOnDestroy",
]);

/**
 * Fase 1 del pipeline de compilación: parsea (vía `@swc/core`), GUARDA en
 * `MetadataStore`, y SACA del código cada decorador que ya leyó
 * (`@Component`/`@Input`/`@Inject`/etc.) — el punto es que ese trabajo deje
 * de correr en runtime, no que conviva al lado. Lo que no reconoce (un
 * decorador de otra librería) lo deja intacto.
 */
export class DecoratorReader {
  private static readonly PROPERTY_BINDING_HANDLERS: Record<
    string,
    (bindings: ClassBindings, propName: string, override: string) => void
  > = {
    Input: (bindings, propName, bindingName) => bindings.inputs.push({ propName, bindingName }),
    Output: (bindings, propName, bindingName) => bindings.outputs.push({ propName, bindingName }),
    HostBinding: (bindings, propName, hostProperty) => bindings.hostBindings.push({ propName, hostProperty }),
  };

  private static readonly LITERAL_READERS: Record<string, (expr: Expression) => unknown> = {
    StringLiteral: (expr) => (expr as StringLiteral).value,
    NumericLiteral: (expr) => (expr as NumericLiteral).value,
    BooleanLiteral: (expr) => (expr as BooleanLiteral).value,
    NullLiteral: () => null,
    ArrayExpression: (expr) =>
      (expr as ArrayExpression).elements.map((el) => (el ? DecoratorReader.literalValue(el.expression) : undefined)),
    ObjectExpression: (expr) => DecoratorReader.objectLiteralValue(expr as ObjectExpression),
  };

  static async read(code: string, path: string): Promise<string | undefined> {
    if (!/@(Component|Directive|Pipe|Service|Injectable|NgModule|Input|Output|HostBinding|HostListener|ViewChild|ViewChildren|ContentChild|ContentChildren)\s*\(/.test(code)) {
      return undefined;
    }

    const ast = await parse(code, { syntax: "typescript", decorators: true, target: "es2022" });

    const context: FileContext = { path, code, imports: DecoratorReader.readImports(ast.body) };
    const metadata: DecoratorMetadata[] = [];
    const stripSpans: SourceEdit[] = [];
    for (const item of ast.body) {
      const cls = DecoratorReader.unwrapClassDeclaration(item);
      const found = cls && DecoratorReader.readClassMetadata(cls, stripSpans, context);
      if (found) metadata.push(found);
      else if (cls) DecoratorReader.assertNoAngularFeatures(cls);
    }

    if (!metadata.length) return undefined;

    MetadataStore.set(path, metadata);
    return DecoratorReader.stripSpans(code, stripSpans);
  }

  /**
   * Saca (o reemplaza, con `replacement`) cada span de atrás para adelante — de adelante para atrás correr un
   * splice invalidaría los offsets de los que faltan. Los `Span` de `@swc/core` son offsets en BYTES UTF-8 desde
   * `BytePos(1)` (como en `source()`): se edita sobre el buffer, no sobre el string — con un índice de string, un
   * comentario con tildes antes del decorador corría el corte.
   */
  private static stripSpans(code: string, spans: SourceEdit[]): string {
    const sorted = [...spans].sort((a, b) => b.start - a.start);
    const bytes = sorted.reduce(
      (result, span) =>
        Buffer.concat([result.subarray(0, span.start - 1), Buffer.from(span.replacement ?? "", "utf8"), result.subarray(span.end - 1)]),
      Buffer.from(code, "utf8"),
    );
    return bytes.toString("utf8");
  }

  /** `import { A as B } from "./x"` → `B → { symbol: "A", packageName: undefined }`; default/namespace no aplican (no son un símbolo con nombre). */
  private static readImports(body: ModuleItem[]): ImportMap {
    const imports: ImportMap = new Map();

    for (const item of body) {
      if (item.type !== "ImportDeclaration") continue;
      const packageName = TokenName.packageFromSpecifier(item.source.value);

      for (const specifier of item.specifiers) {
        if (specifier.type !== "ImportSpecifier") continue;
        const symbol = specifier.imported?.value ?? specifier.local.value;
        imports.set(specifier.local.value, { symbol, packageName, specifier: item.source.value });
      }
    }

    return imports;
  }

  /** Identificador local → nombre de DI: por su import si viene de otro archivo, si no declarado acá (mismo paquete). */
  private static diName(local: string, context: FileContext): string {
    const imported = context.imports.get(local);
    return TokenName.of(imported?.symbol ?? local, imported?.packageName ?? TokenName.packageOf(context.path));
  }

  private static unwrapClassDeclaration(item: ModuleItem): ClassDeclaration | undefined {
    if (item.type === "ClassDeclaration") return item;
    if (item.type === "ExportDeclaration" && item.declaration.type === "ClassDeclaration") return item.declaration;
    return undefined;
  }

  private static readClassMetadata(cls: ClassDeclaration, stripSpans: SourceEdit[], context: FileContext): DecoratorMetadata | undefined {
    for (const decorator of cls.decorators ?? []) {
      const decoratorName = DecoratorReader.decoratorCallName(decorator);
      const kind = decoratorName ? CLASS_DECORATOR_KIND[decoratorName] : undefined;
      if (!kind) continue;

      stripSpans.push(decorator.span);
      const className = cls.identifier.value;

      const argExpr = DecoratorReader.decoratorFirstArgExpression(decorator);
      const objExpr = argExpr?.type === "ObjectExpression" ? argExpr : undefined;

      const ctor = DecoratorReader.readConstructorTokens(cls, kind, stripSpans, context);
      const injected = DecoratorReader.readInjectCalls(cls, stripSpans, context);
      const superClass = cls.superClass?.type === "Identifier" ? (context.imports.get(cls.superClass.value)?.symbol ?? cls.superClass.value) : undefined;
      const construction = {
        ...(superClass && { superClass }),
        hasConstructor: cls.body.some((member) => member.type === "Constructor"),
        constructorTokens: ctor.constructorTokens,
        constructorFlags: ctor.constructorFlags,
        constructorAttributes: ctor.constructorAttributes,
        injectTokens: injected.injectTokens,
        constructorImports: [...new Set([...ctor.constructorImports, ...injected.imports])],
      };

      if (kind === "ngmodule") {
        // Angular instancia la clase del módulo al crear su injector: su constructor lleva DI como cualquier clase.
        return {
          kind,
          className,
          ...construction,
          token: DecoratorReader.diName(className, context),
          declarations: DecoratorReader.identifierArray(objExpr, "declarations"),
          imports: DecoratorReader.readModuleImports(objExpr, className, context),
          providers: DecoratorReader.readProviders(objExpr, className, context),
          bootstrap: DecoratorReader.identifierArray(objExpr, "bootstrap"),
          controllerAs: DecoratorReader.stringProp(objExpr, "controllerAs"),
        };
      }

      const options = DecoratorReader.decoratorFirstArgObject(decorator);

      if (kind === "component" || kind === "directive") {
        return {
          kind,
          className,
          options,
          ...construction,
          ...DecoratorReader.readBindings(cls.body, stripSpans, className, context),
          hostDirectives: DecoratorReader.readHostDirectives(objExpr, className, context),
          providers: DecoratorReader.readProviders(objExpr, className, context),
        };
      }

      if (kind === "service" || kind === "injectable") {
        const recipe = DecoratorReader.injectableRecipe(objExpr, className, context);
        return { kind, className, options, ...construction, token: DecoratorReader.diName(className, context), ...(recipe && { recipe }) };
      }

      return { kind, className, options, ...construction };
    }
    return undefined;
  }

  /**
   * Como Angular desde v10: una clase que usa features de Angular (`@Input`, `@HostListener`, `@Inject`/flags en el
   * constructor, …) tiene que estar decorada — una base abstracta lleva `@Directive()`/`@Injectable()`. Sin decorador
   * no se lee (no hay metadata que heredar) y el decorador quedaría corriendo en runtime: error en build.
   */
  private static assertNoAngularFeatures(cls: ClassDeclaration): void {
    const used = [
      ...cls.body.flatMap((member) => (member.type === "ClassProperty" ? (member.decorators ?? []) : member.type === "ClassMethod" ? (member.function.decorators ?? []) : [])),
      ...cls.body.flatMap((member) => (member.type === "Constructor" ? member.params.flatMap((param) => param.decorators ?? []) : [])),
    ]
      .map((decorator) => DecoratorReader.decoratorCallName(decorator))
      .find((name) => name !== undefined && ANGULAR_MEMBER_DECORATORS.has(name));
    if (used) {
      throw new Error(
        `DecoratorReader: "${cls.identifier.value}" usa @${used} pero no tiene decorador de clase — agregale @Directive()/@Injectable() (Angular también lo exige).`,
      );
    }
  }

  private static decoratorFirstArgExpression(decorator: Decorator): Expression | undefined {
    const expr = decorator.expression;
    return expr.type === "CallExpression" ? expr.arguments[0]?.expression : undefined;
  }

  /** `controllerAs: "ctrl"` — string literal simple, mismo criterio que el resto de `options`. */
  private static stringProp(objExpr: ObjectExpression | undefined, key: string): string | undefined {
    if (!objExpr) return undefined;
    for (const prop of objExpr.properties) {
      if (prop.type !== "KeyValueProperty" || DecoratorReader.propName(prop.key) !== key) continue;
      return prop.value.type === "StringLiteral" ? prop.value.value : undefined;
    }
    return undefined;
  }

  /** `declarations: [CardComponent]` — identificadores, no literales; `literalValue` no los resuelve a propósito. */
  private static identifierArray(objExpr: ObjectExpression | undefined, key: string): string[] {
    if (!objExpr) return [];

    for (const prop of objExpr.properties) {
      if (prop.type !== "KeyValueProperty" || DecoratorReader.propName(prop.key) !== key) continue;
      if (prop.value.type !== "ArrayExpression") return [];

      return prop.value.elements
        .map((el) => (el?.expression.type === "Identifier" ? el.expression.value : undefined))
        .filter((value): value is string => Boolean(value));
    }

    return [];
  }

  /**
   * `imports: [...]` de `@NgModule` — array literal (anidados se aplanan, como Angular). Un string es un
   * módulo de AngularJS por nombre; un identificador/`legacy.module` se resuelve después en el scanner
   * (`@NgModule` propio, de otro paquete o `IModule` legacy); `angular.module("x")` es un `IModule`. Cualquier otra
   * llamada (`ConfigModule.forRoot(options)`) se evalúa al correr — ver `ModuleWithProvidersRuntime`.
   */
  private static readModuleImports(objExpr: ObjectExpression | undefined, owner: string, context: FileContext): ModuleImport[] {
    const value = DecoratorReader.propValue(objExpr, "imports");
    if (!value) return [];
    if (value.type !== "ArrayExpression") {
      throw new Error(`DecoratorReader: "${owner}" — \`imports\` tiene que ser un array literal.`);
    }
    return DecoratorReader.moduleImportElements(value, owner, context);
  }

  private static moduleImportElements(array: ArrayExpression, owner: string, context: FileContext): ModuleImport[] {
    return array.elements.flatMap((element): ModuleImport[] => {
      if (!element || element.spread) {
        throw new Error(`DecoratorReader: "${owner}" — \`imports\` no admite huecos ni \`...spread\`.`);
      }

      const { expression } = element;
      if (expression.type === "ArrayExpression") return DecoratorReader.moduleImportElements(expression, owner, context);
      if (expression.type === "StringLiteral") return [{ kind: "name", name: expression.value }];
      if (expression.type === "Identifier") return [{ kind: "reference", identifier: expression.value }];
      if (expression.type === "MemberExpression") return [{ kind: "expression", expr: DecoratorReader.source(expression, context) }];
      if (DecoratorReader.isAngularModuleCall(expression)) {
        return [{ kind: "angularModule", expr: DecoratorReader.source(expression, context) }];
      }
      if (expression.type === "CallExpression") return [{ kind: "call", expr: DecoratorReader.source(expression, context) }];

      throw new Error(
        `DecoratorReader: "${owner}" — import \`${DecoratorReader.source(expression, context)}\` no soportado (un @NgModule, un ModuleWithProviders, un angular.IModule o el nombre de un módulo).`,
      );
    });
  }

  /** `angular.module("x")` — la única llamada que da un `IModule` sin ambigüedad. */
  private static isAngularModuleCall(expr: Expression): boolean {
    if (expr.type !== "CallExpression" || expr.callee.type !== "MemberExpression") return false;
    const { object, property } = expr.callee;
    return object.type === "Identifier" && object.value === "angular" && property.type === "Identifier" && property.value === "module";
  }

  /**
   * `providers: [...]` — array literal (anidados se aplanan, como Angular). Cada elemento es una clase
   * (`UserService`) o un objeto literal (`{ provide, useClass/useValue/useFactory/useExisting, deps, multi }`).
   * Lo que no se puede leer en build (variable, `...spread`, `provideX()`) es error, nunca se descarta.
   */
  private static readProviders(objExpr: ObjectExpression | undefined, owner: string, context: FileContext): ProviderMetadata[] {
    const value = DecoratorReader.propValue(objExpr, "providers");
    if (!value) return [];
    if (value.type !== "ArrayExpression") {
      throw new Error(`DecoratorReader: "${owner}" — \`providers\` tiene que ser un array literal.`);
    }
    return DecoratorReader.providerElements(value, owner, context);
  }

  private static providerElements(array: ArrayExpression, owner: string, context: FileContext): ProviderMetadata[] {
    return array.elements.flatMap((element): ProviderMetadata[] => {
      if (!element || element.spread) {
        throw new Error(`DecoratorReader: "${owner}" — \`providers\` no admite huecos ni \`...spread\`.`);
      }

      const expression = DecoratorReader.unwrapForwardRef(element.expression, context);
      if (expression.type === "ArrayExpression") return DecoratorReader.providerElements(expression, owner, context);
      if (expression.type === "Identifier") {
        return [{ kind: "class", token: DecoratorReader.diName(expression.value, context), classExpr: expression.value }];
      }
      if (expression.type === "ObjectExpression") return [DecoratorReader.providerObject(expression, owner, context)];

      throw new Error(
        `DecoratorReader: "${owner}" — provider \`${DecoratorReader.source(expression, context)}\` no soportado (solo una clase o un objeto { provide, ... }).`,
      );
    });
  }

  private static providerObject(object: ObjectExpression, owner: string, context: FileContext): ProviderMetadata {
    const fail = (reason: string): never => {
      throw new Error(`DecoratorReader: "${owner}" — provider \`${DecoratorReader.source(object, context)}\`: ${reason}`);
    };

    const props = new Map<string, Expression>();
    for (const prop of object.properties) {
      const key = prop.type === "KeyValueProperty" ? DecoratorReader.propName(prop.key) : undefined;
      if (prop.type !== "KeyValueProperty" || !key) return fail("solo admite propiedades `clave: valor`.");
      if (!PROVIDER_KEYS.has(key)) return fail(`clave "${key}" desconocida.`);
      props.set(key, prop.value);
    }

    const provide = DecoratorReader.unwrapForwardRef(props.get("provide") ?? fail("falta `provide`."), context);
    const token = DecoratorReader.tokenOf(provide, context) ?? fail("`provide` tiene que ser una clase, un InjectionToken o un string.");
    return DecoratorReader.providerFromProps(props, provide, token, fail, owner, context);
  }

  /**
   * `@Injectable({ providedIn, useClass/useValue/useFactory/useExisting, deps })` — la receta con la que se
   * provee la clase, igual que un provider `{ provide: Clase, ... }` (Ivy: `ɵprov.factory`). Sin receta,
   * `undefined`: la clase se construye con su `ɵfac`.
   */
  private static injectableRecipe(objExpr: ObjectExpression | undefined, className: string, context: FileContext): ProviderMetadata | undefined {
    const fail = (reason: string): never => {
      throw new Error(`DecoratorReader: "${className}" — @Injectable: ${reason}`);
    };
    const props = new Map<string, Expression>();
    for (const prop of objExpr?.properties ?? []) {
      const key = prop.type === "KeyValueProperty" ? DecoratorReader.propName(prop.key) : undefined;
      if (prop.type === "KeyValueProperty" && key && (key === "deps" || (PROVIDER_RECIPES as readonly string[]).includes(key))) props.set(key, prop.value);
    }
    if (!PROVIDER_RECIPES.some((recipe) => props.has(recipe))) return undefined;
    return DecoratorReader.providerFromProps(props, undefined, DecoratorReader.diName(className, context), fail, className, context);
  }

  /** La receta de un provider ya separada en `props` (`multi`/`deps`/`use*`) — compartido por `providers` y `@Injectable`. */
  private static providerFromProps(
    props: Map<string, Expression>,
    provide: Expression | undefined,
    token: string,
    fail: (reason: string) => never,
    owner: string,
    context: FileContext,
  ): ProviderMetadata {
    const multiExpr = props.get("multi");
    if (multiExpr && multiExpr.type !== "BooleanLiteral") fail("`multi` tiene que ser true/false literal.");
    const multi = multiExpr?.type === "BooleanLiteral" && multiExpr.value;

    const depsExpr = props.get("deps");
    const parsedDeps = depsExpr && DecoratorReader.depsOf(depsExpr, context, fail);
    const deps = parsedDeps?.deps;
    const depFlags = parsedDeps?.depFlags.some(ResolveDependency.hasFlags) ? parsedDeps.depFlags : undefined;

    const recipes = PROVIDER_RECIPES.filter((recipe) => props.has(recipe));
    if (recipes.length > 1) fail(`solo una receta a la vez (${recipes.join(", ")}).`);

    switch (recipes[0]) {
      case "useClass":
        return {
          kind: "useClass",
          token,
          classExpr: DecoratorReader.source(DecoratorReader.unwrapForwardRef(props.get("useClass")!, context), context),
          deps,
          ...(depFlags && { depFlags }),
          multi,
        };
      case "useValue":
        return { kind: "useValue", token, valueExpr: DecoratorReader.source(props.get("useValue")!, context), multi };
      case "useFactory": {
        const factory = DecoratorReader.factorySource(props.get("useFactory")!, owner, context);
        return {
          kind: "useFactory",
          token,
          factoryExpr: factory.text,
          deps: deps ?? [],
          ...(depFlags && { depFlags }),
          ...(factory.injectTokens.length && { injectTokens: factory.injectTokens }),
          multi,
        };
      }
      case "useExisting": {
        const existingToken = DecoratorReader.tokenOf(props.get("useExisting")!, context);
        return existingToken
          ? { kind: "useExisting", token, existingToken, multi }
          : fail("`useExisting` tiene que ser una clase, un InjectionToken o un string.");
      }
      default:
        if (provide?.type !== "Identifier") return fail("sin receta, `provide` tiene que ser una clase.");
        return { kind: "constructor", token, classExpr: provide.value, deps, ...(depFlags && { depFlags }), multi };
    }
  }

  /**
   * `deps: [A, "$http", [new Optional(), new SkipSelf(), B]]` → nombres de DI + sus flags. Un elemento array es
   * token + flags (`new Optional()`/`new Self()`/`new SkipSelf()`/`new Host()`), como en Angular.
   */
  private static depsOf(expr: Expression, context: FileContext, fail: (reason: string) => never): { deps: string[]; depFlags: InjectFlags[] } {
    if (expr.type !== "ArrayExpression") return fail("`deps` tiene que ser un array literal.");
    const invalid = () => fail("cada elemento de `deps` tiene que ser una clase, un InjectionToken, un string o [flags..., token].");
    const depFlags: InjectFlags[] = [];
    const deps = expr.elements.map((element) => {
      if (!element || element.spread) return invalid();
      if (element.expression.type !== "ArrayExpression") {
        depFlags.push({});
        return DecoratorReader.tokenOf(element.expression, context) ?? invalid();
      }

      const flags: InjectFlags = {};
      let token: string | undefined;
      for (const part of element.expression.elements) {
        if (!part || part.spread) return invalid();
        const flag = part.expression.type === "NewExpression" && part.expression.callee.type === "Identifier" ? part.expression.callee.value : undefined;
        if (flag === undefined) {
          if (token !== undefined) return invalid();
          token = DecoratorReader.tokenOf(part.expression, context) ?? invalid();
        } else {
          const key = DecoratorReader.flagOf(context.imports.get(flag)?.symbol ?? flag);
          if (!key) return fail(`\`new ${flag}()\` en \`deps\` no es un flag de DI (Optional/Self/SkipSelf/Host).`);
          flags[key] = true;
        }
      }
      depFlags.push(flags);
      return token ?? invalid();
    });
    return { deps, depFlags };
  }

  /**
   * Texto de un `useFactory` con sus `inject()` ya reemplazados (`InjectedValues.ref`, clave `FACTORY`). Solo se miran los que corren al
   * llamar al factory: el cuerpo de un arrow/función literal, sin entrar a funciones anidadas. Un factory por
   * referencia (`useFactory: createFoo`) queda tal cual — su cuerpo no está acá.
   */
  private static factorySource(expr: Expression, owner: string, context: FileContext): { text: string; injectTokens: InjectDep[] } {
    if (expr.type !== "ArrowFunctionExpression" && expr.type !== "FunctionExpression") {
      return { text: DecoratorReader.source(expr, context), injectTokens: [] };
    }
    const edits: SourceEdit[] = [];
    const { injectTokens } = DecoratorReader.collectInjectCalls([expr.body], edits, InjectedValues.FACTORY, owner, context);
    return { text: DecoratorReader.editedSource(expr, edits, context), injectTokens };
  }

  /**
   * Para `InjectionTokenWriter`: el `factory` de `new InjectionToken(desc, { factory })`, con sus `inject()` ya
   * reemplazados (`InjectedValues.ref`) — misma lectura que un `useFactory`, resolviendo tokens con los imports de `body`.
   */
  static tokenFactory(expr: Expression, owner: string, code: string, path: string, body: ModuleItem[]): { text: string; injectTokens: InjectDep[] } {
    return DecoratorReader.factorySource(expr, owner, { path, code, imports: DecoratorReader.readImports(body) });
  }

  /** `source()` con los `edits` que caen adentro de `node` aplicados (offsets relativos al nodo). */
  private static editedSource(node: Expression, edits: SourceEdit[], context: FileContext): string {
    const { start } = (node as Expression & { span: Span }).span;
    const local = edits.map((edit) => ({ ...edit, start: edit.start - start + 1, end: edit.end - start + 1 }));
    return DecoratorReader.stripSpans(DecoratorReader.source(node, context), local);
  }

  /** Identificador → nombre de DI (`TokenName`); string literal → tal cual (nombre de AngularJS). */
  private static tokenOf(expr: Expression, context: FileContext): string | undefined {
    const unwrapped = DecoratorReader.unwrapForwardRef(expr, context);
    if (unwrapped.type === "Identifier") return DecoratorReader.diName(unwrapped.value, context);
    if (unwrapped.type === "StringLiteral") return unwrapped.value;
    return undefined;
  }

  /**
   * `forwardRef(() => X)` → `X`. En Angular difiere la referencia a una clase declarada más abajo; acá el nombre
   * de DI sale del identificador en build y el registro se emite al final del archivo, no hay nada que diferir.
   * Se reconoce por el símbolo `forwardRef`, no por el paquete.
   */
  private static unwrapForwardRef(expr: Expression, context: FileContext): Expression {
    if (expr.type !== "CallExpression" || expr.callee.type !== "Identifier") return expr;
    if ((context.imports.get(expr.callee.value)?.symbol ?? expr.callee.value) !== "forwardRef") return expr;
    const fn = expr.arguments[0]?.expression;
    if (fn?.type !== "ArrowFunctionExpression") return expr;
    if (fn.body.type !== "BlockStatement") return fn.body;
    const [only] = fn.body.stmts;
    return fn.body.stmts.length === 1 && only?.type === "ReturnStatement" && only.argument ? only.argument : expr;
  }

  private static propValue(objExpr: ObjectExpression | undefined, key: string): Expression | undefined {
    for (const prop of objExpr?.properties ?? []) {
      if (prop.type === "KeyValueProperty" && DecoratorReader.propName(prop.key) === key) return prop.value;
    }
    return undefined;
  }

  /** Texto fuente de un nodo — los `Span` de `@swc/core` son offsets en BYTES UTF-8 desde 1, no índices de string. */
  private static source(node: Expression, context: FileContext): string {
    const { start, end } = (node as Expression & { span: Span }).span;
    return Buffer.from(context.code, "utf8").subarray(start - 1, end - 1).toString("utf8");
  }

  private static readBindings(members: ClassMember[], stripSpans: SourceEdit[], owner: string, context: FileContext): ClassBindings {
    const bindings: ClassBindings = { inputs: [], outputs: [], hostBindings: [], hostListeners: [], lifecycleHooks: [], queries: [] };

    for (const member of members) {
      if (member.type === "ClassProperty") {
        const name = DecoratorReader.propName(member.key);
        if (!name) continue;

        for (const decorator of member.decorators ?? []) {
          const query = DecoratorReader.queryOf(decorator, name, owner, context);
          if (query) {
            bindings.queries.push(query);
            stripSpans.push(decorator.span);
            continue;
          }
          const args = DecoratorReader.decoratorArgs(decorator);
          const override = typeof args[0] === "string" ? args[0] : name;
          const decoratorName = DecoratorReader.decoratorCallName(decorator);
          const handler = decoratorName ? DecoratorReader.PROPERTY_BINDING_HANDLERS[decoratorName] : undefined;
          if (!handler) continue;
          handler(bindings, name, override);
          stripSpans.push(decorator.span);
        }
      }

      if (member.type === "ClassMethod") {
        const name = DecoratorReader.propName(member.key);
        if (!name) continue;

        if (LIFECYCLE_HOOK_NAMES.has(name)) bindings.lifecycleHooks.push(name);

        for (const decorator of member.function.decorators ?? []) {
          // `@ViewChild("x") set foo(value) {...}` — la query sobre un setter.
          const query = DecoratorReader.queryOf(decorator, name, owner, context);
          if (query) {
            bindings.queries.push(query);
            stripSpans.push(decorator.span);
            continue;
          }
          if (DecoratorReader.decoratorCallName(decorator) !== "HostListener") continue;
          const [eventName, args] = DecoratorReader.decoratorArgs(decorator);
          bindings.hostListeners.push({
            methodName: name,
            eventName: typeof eventName === "string" ? eventName : "",
            args: DecoratorReader.hostListenerArgs(args, owner, name),
          });
          stripSpans.push(decorator.span);
        }
      }
    }

    return bindings;
  }

  /**
   * `@ViewChild(Pred, { read, static })` y compañía → la definición de la query (formato de Ivy). `Pred` es una
   * clase (`forwardRef` desenvuelto) o un string de nombres de `#ref` separados por coma. `descendants` solo cuenta
   * en las de contenido (las de vista siempre lo son); default de Angular: `@ContentChildren` → `false`.
   */
  private static queryOf(decorator: Decorator, propertyName: string, owner: string, context: FileContext): QueryMetadata | undefined {
    const name = DecoratorReader.decoratorCallName(decorator);
    const spec = name ? QUERY_DECORATORS[name] : undefined;
    if (!spec) return undefined;
    const fail = (reason: string): never => {
      throw new Error(`DecoratorReader: "${owner}.${propertyName}" — @${name}: ${reason}`);
    };

    const call = decorator.expression;
    if (call.type !== "CallExpression" || !call.arguments[0] || call.arguments[0].spread) return fail("falta el predicado (una clase o un nombre de #ref).");
    const predicateExpr = DecoratorReader.unwrapForwardRef(call.arguments[0].expression, context);
    const predicate: QueryMetadata["predicate"] =
      predicateExpr.type === "StringLiteral"
        ? { kind: "names", names: predicateExpr.value.split(",").map((ref) => ref.trim()).filter(Boolean) }
        : predicateExpr.type === "Identifier" || predicateExpr.type === "MemberExpression"
          ? { kind: "type", expr: DecoratorReader.source(predicateExpr, context) }
          : fail("el predicado tiene que ser una clase o un string literal.");

    const query: QueryMetadata = { kind: spec.kind, propertyName, first: spec.first, predicate, descendants: spec.descendants, static: false };
    const options = call.arguments[1]?.expression;
    if (!options) return query;
    if (options.type !== "ObjectExpression") return fail("las opciones tienen que ser un objeto literal.");
    for (const prop of options.properties) {
      const key = prop.type === "KeyValueProperty" ? DecoratorReader.propName(prop.key) : undefined;
      if (prop.type !== "KeyValueProperty" || !key) return fail("las opciones solo admiten propiedades `clave: valor`.");
      if (key === "read") {
        const read = DecoratorReader.unwrapForwardRef(prop.value, context);
        query.readExpr = read.type === "Identifier" || read.type === "MemberExpression" ? DecoratorReader.source(read, context) : fail("`read` tiene que ser una clase o un token.");
      } else if (key === "static" || key === "descendants" || key === "emitDistinctChangesOnly") {
        if (prop.value.type !== "BooleanLiteral") return fail(`\`${key}\` tiene que ser true/false literal.`);
        if (key === "static") query.static = prop.value.value;
        if (key === "descendants" && spec.kind === "content") query.descendants = prop.value.value;
      } else {
        return fail(`opción "${key}" desconocida.`);
      }
    }
    return query;
  }

  /** `hostDirectives: [X, { directive: Y, inputs: [...], outputs: [...] }]` → su definición (`forwardRef` desenvuelto). */
  private static readHostDirectives(objExpr: ObjectExpression | undefined, owner: string, context: FileContext): HostDirectiveMetadata[] {
    const value = DecoratorReader.propValue(objExpr, "hostDirectives");
    if (!value) return [];
    const fail = (reason: string): never => {
      throw new Error(`DecoratorReader: "${owner}" — \`hostDirectives\`: ${reason}`);
    };
    if (value.type !== "ArrayExpression") return fail("tiene que ser un array literal.");

    const classOf = (expr: Expression): string => {
      const unwrapped = DecoratorReader.unwrapForwardRef(expr, context);
      return unwrapped.type === "Identifier" || unwrapped.type === "MemberExpression" ? DecoratorReader.source(unwrapped, context) : fail("cada directiva tiene que ser una clase.");
    };
    const strings = (expr: Expression | undefined, key: string): string[] | undefined => {
      if (!expr) return undefined;
      const list = DecoratorReader.literalValue(expr);
      return Array.isArray(list) && list.every((item) => typeof item === "string") ? list : fail(`\`${key}\` tiene que ser un array de strings literales.`);
    };

    return value.elements.map((element) => {
      if (!element || element.spread) return fail("no admite huecos ni `...spread`.");
      const { expression } = element;
      if (expression.type !== "ObjectExpression") return { directiveExpr: classOf(expression) };
      const directive = DecoratorReader.propValue(expression, "directive") ?? fail("la forma larga necesita `directive`.");
      const inputs = strings(DecoratorReader.propValue(expression, "inputs"), "inputs");
      const outputs = strings(DecoratorReader.propValue(expression, "outputs"), "outputs");
      return { directiveExpr: classOf(directive), ...(inputs && { inputs }), ...(outputs && { outputs }) };
    });
  }

  /**
   * `['$event', '$event.target']` de `@HostListener` — cada expresión tiene que empezar con `$event`
   * (lo único que existe para traducir: el evento nativo del `addEventListener`); cualquier otra cosa
   * (una variable, un servicio inyectado) no se puede resolver en build, así que es error, no se ignora.
   */
  private static hostListenerArgs(args: unknown, owner: string, methodName: string): string[] {
    if (args === undefined) return [];
    if (!Array.isArray(args)) {
      throw new Error(`DecoratorReader: "${owner}.${methodName}" — el segundo argumento de @HostListener tiene que ser un array literal.`);
    }
    return args.map((arg) => {
      if (typeof arg === "string" && (arg === "$event" || arg.startsWith("$event."))) return arg;
      throw new Error(
        `DecoratorReader: "${owner}.${methodName}" — @HostListener solo soporta expresiones "$event"/"$event.algo", no ${JSON.stringify(arg)}.`,
      );
    });
  }

  /**
   * Un nombre de DI por parámetro, en orden — `@Inject(Token)` si está, si no
   * la anotación de tipo (`constructor(private http: HttpClient)`, sin
   * decorador, como en Angular real). Sin ninguno de los dos no hay token que
   * inyectar: error en build (Angular real también falla ahí). `@Optional()`/`@Self()`/`@SkipSelf()`/`@Host()`
   * quedan en `constructorFlags`; `@Attribute("x")` en `constructorAttributes` (no es DI).
   */
  private static readConstructorTokens(
    cls: ClassDeclaration,
    kind: DecoratorMetadata["kind"],
    stripSpans: SourceEdit[],
    context: FileContext,
  ): { constructorTokens: string[]; constructorFlags: InjectFlags[]; constructorAttributes: (string | null)[]; constructorImports: string[] } {
    const ctor = cls.body.find((member) => member.type === "Constructor");
    if (!ctor) return { constructorTokens: [], constructorFlags: [], constructorAttributes: [], constructorImports: [] };

    const imports = new Set<string>();
    const constructorFlags = ctor.params.map((param) => DecoratorReader.takeFlags(param, stripSpans));
    const constructorAttributes = ctor.params.map((param) => DecoratorReader.takeAttribute(param, kind, stripSpans, cls.identifier.value));
    const constructorTokens = ctor.params.map((param, index) => {
      if (constructorAttributes[index] !== null) return "";
      const token = DecoratorReader.paramToken(param, stripSpans, context);
      if (token === undefined) {
        throw new Error(
          `DecoratorReader: "${cls.identifier.value}" — el parámetro ${index} del constructor no tiene tipo de clase ni @Inject(), no hay token de DI que resolver.`,
        );
      }
      if (token.local) {
        const specifier = context.imports.get(token.local)?.specifier;
        if (specifier) imports.add(specifier);
      }
      return token.name;
    });
    return { constructorTokens, constructorFlags, constructorAttributes, constructorImports: [...imports] };
  }

  /**
   * `@Attribute("type")`: el valor estático de ese atributo en el host (`$element[0].getAttribute`), leído al
   * construir — solo existe en `@Component`/`@Directive` (como en Angular); en otra clase es error en build.
   */
  private static takeAttribute(param: TsParameterProperty | Param, kind: DecoratorMetadata["kind"], stripSpans: SourceEdit[], owner: string): string | null {
    const decorator = (param.decorators ?? []).find((candidate) => DecoratorReader.decoratorCallName(candidate) === "Attribute");
    if (!decorator) return null;
    if (kind !== "component" && kind !== "directive") {
      throw new Error(`DecoratorReader: "${owner}" — @Attribute() solo existe en @Component/@Directive (lee un atributo del host).`);
    }
    const [name] = DecoratorReader.decoratorArgs(decorator);
    if (typeof name !== "string") throw new Error(`DecoratorReader: "${owner}" — @Attribute() recibe el nombre del atributo como string literal.`);
    stripSpans.push(decorator.span);
    return name;
  }

  /**
   * `inject(Token)` / `inject(Token, { optional, self, skipSelf, host })` que corre DURANTE la construcción: en el inicializador
   * de un campo de instancia o en el cuerpo del constructor. El token se conoce en build, así que es una
   * dependencia más del `ɵfac` (como un parámetro del constructor): la llamada se reemplaza por
   * `InjectedValues.ref(clase, i)` y el factory expone esos valores alrededor del `new` (`DecoratorWriter.facStatement`).
   *
   * Lo que está dentro de una función anidada (callback, arrow de un campo, método) corre después, fuera de la
   * construcción: se deja intacto. Un campo `static` tampoco se construye con la instancia. Se reconoce por el
   * símbolo `inject` (también con alias en el import), no por el paquete.
   */
  private static readInjectCalls(
    cls: ClassDeclaration,
    stripSpans: SourceEdit[],
    context: FileContext,
  ): { injectTokens: InjectDep[]; imports: string[] } {
    const roots: unknown[] = [];
    for (const member of cls.body) {
      if (member.type === "ClassProperty" && !member.isStatic) roots.push(member.value);
      if (member.type === "Constructor") roots.push(member.body);
    }
    return DecoratorReader.collectInjectCalls(roots, stripSpans, cls.identifier.value, cls.identifier.value, context);
  }

  /**
   * Cada `inject()` dentro de `roots` (sin entrar a funciones anidadas) → `InjectedValues.ref(key, i)` en `edits`, con su token
   * en el mismo orden. `imports`: de qué archivos vienen los tokens (para el import de efecto, como el constructor).
   */
  private static collectInjectCalls(
    roots: unknown[],
    edits: SourceEdit[],
    key: string,
    owner: string,
    context: FileContext,
  ): { injectTokens: InjectDep[]; imports: string[] } {
    const injectTokens: InjectDep[] = [];
    const imports = new Set<string>();

    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const typed = node as { type?: string };
      if (typed.type && NESTED_SCOPES.has(typed.type)) return;
      if (typed.type === "CallExpression" && DecoratorReader.isInjectCall(typed as Expression, context)) {
        const call = typed as Expression & { type: "CallExpression" };
        const read = DecoratorReader.injectArguments(call, owner, context);
        if (read.local) {
          const specifier = context.imports.get(read.local)?.specifier;
          if (specifier) imports.add(specifier);
        }
        edits.push({ ...call.span, replacement: InjectedValues.ref(key, injectTokens.length) });
        injectTokens.push({ token: read.token, flags: read.flags });
        return;
      }
      for (const value of Object.values(node)) visit(value);
    };

    for (const root of roots) visit(root);
    return { injectTokens, imports: [...imports] };
  }

  /** `inject(...)` — el callee es el símbolo `inject`, importado con ese nombre o con alias. */
  private static isInjectCall(expr: Expression, context: FileContext): boolean {
    if (expr.type !== "CallExpression" || expr.callee.type !== "Identifier") return false;
    const local = expr.callee.value;
    return (context.imports.get(local)?.symbol ?? local) === "inject";
  }

  /** Token (clase / `InjectionToken` / string, como `@Inject`) + opciones `{ optional, self, skipSelf, host }`. */
  private static injectArguments(
    call: Expression & { type: "CallExpression" },
    owner: string,
    context: FileContext,
  ): { token: string; local?: string; flags: InjectFlags } {
    const fail = (reason: string): never => {
      throw new Error(`DecoratorReader: "${owner}" — \`${DecoratorReader.source(call, context)}\`: ${reason}`);
    };

    const [tokenArg, optionsArg, ...rest] = call.arguments;
    if (!tokenArg || tokenArg.spread || rest.length) fail("inject() recibe un token y, opcional, un objeto de opciones.");
    const tokenExpr = DecoratorReader.unwrapForwardRef(tokenArg!.expression, context);
    const token = DecoratorReader.tokenOf(tokenExpr, context) ?? fail("el token tiene que ser una clase, un InjectionToken o un string.");

    const flags: InjectFlags = {};
    if (optionsArg) {
      if (optionsArg.spread || optionsArg.expression.type !== "ObjectExpression") fail("las opciones tienen que ser un objeto literal.");
      for (const prop of (optionsArg.expression as ObjectExpression).properties) {
        const key = prop.type === "KeyValueProperty" ? DecoratorReader.propName(prop.key) : undefined;
        if (prop.type !== "KeyValueProperty" || !key || !INJECT_OPTION_KEYS.has(key)) fail("opción desconocida (solo `optional`/`self`/`skipSelf`/`host`).");
        const value = (prop as { value: Expression }).value;
        if (value.type !== "BooleanLiteral") fail(`\`${key}\` tiene que ser true/false literal.`);
        if ((value as BooleanLiteral).value) flags[key as keyof InjectFlags] = true;
      }
    }

    return { token, local: tokenExpr.type === "Identifier" ? tokenExpr.value : undefined, flags };
  }

  /** `@Optional()`/`@Self()`/`@SkipSelf()`/`@Host()` en el parámetro: se sacan del código (como `@Inject`) y quedan como flags. */
  private static takeFlags(param: TsParameterProperty | Param, stripSpans: SourceEdit[]): InjectFlags {
    const flags: InjectFlags = {};
    for (const decorator of param.decorators ?? []) {
      const name = DecoratorReader.decoratorCallName(decorator);
      const key = name ? DecoratorReader.flagOf(name) : undefined;
      if (!key) continue;
      flags[key] = true;
      stripSpans.push(decorator.span);
    }
    return flags;
  }

  /** Nombre del decorador / clase de flag de Angular → su clave en `InjectFlags`. */
  private static flagOf(name: string): keyof InjectFlags | undefined {
    return INJECT_FLAG_BY_NAME[name];
  }

  /** `name` = nombre de DI; `local` = el identificador del que salió (para saber de qué archivo viene), si no era un string. */
  private static paramToken(
    param: TsParameterProperty | Param,
    stripSpans: SourceEdit[],
    context: FileContext,
  ): { name: string; local?: string } | undefined {
    for (const decorator of param.decorators ?? []) {
      if (DecoratorReader.decoratorCallName(decorator) !== "Inject") continue;
      stripSpans.push(decorator.span);
      const rawArg = DecoratorReader.decoratorFirstArgExpression(decorator);
      const arg = rawArg && DecoratorReader.unwrapForwardRef(rawArg, context);
      if (arg?.type === "Identifier") return { name: DecoratorReader.diName(arg.value, context), local: arg.value };
      if (arg?.type === "StringLiteral") return { name: arg.value };
    }

    const pat: Pattern = param.type === "TsParameterProperty" ? param.param : param.pat;
    // `Pattern` incluye tanto `BindingIdentifier` (con `typeAnnotation`) como el
    // `Identifier` de `Expression` (sin) — ambos con `type: "Identifier"`, TS no
    // los distingue solo, hace falta el cast.
    if (pat.type !== "Identifier") return undefined;
    const binding = pat as BindingIdentifier;

    // `foo: Foo | null` (lo idiomático con `@Optional()`): `null`/`undefined` no son token, cuenta el resto.
    const annotation = binding.typeAnnotation?.typeAnnotation;
    const candidates =
      annotation?.type === "TsUnionType"
        ? annotation.types.filter((type) => !(type.type === "TsKeywordType" && (type.kind === "null" || type.kind === "undefined")))
        : [annotation];
    const typeAnnotation = candidates.length === 1 ? candidates[0] : undefined;
    if (typeAnnotation?.type !== "TsTypeReference" || typeAnnotation.typeName.type !== "Identifier") return undefined;

    const local = typeAnnotation.typeName.value;
    return { name: DecoratorReader.diName(local, context), local };
  }

  private static decoratorCallName(decorator: Decorator): string | undefined {
    const expr = decorator.expression;
    if (expr.type === "CallExpression" && expr.callee.type === "Identifier") return expr.callee.value;
    if (expr.type === "Identifier") return expr.value;
    return undefined;
  }

  private static decoratorArgs(decorator: Decorator): unknown[] {
    const expr = decorator.expression;
    if (expr.type !== "CallExpression") return [];
    return expr.arguments.map((arg) => DecoratorReader.literalValue(arg.expression));
  }

  private static decoratorFirstArgObject(decorator: Decorator): Record<string, unknown> {
    const arg = DecoratorReader.decoratorArgs(decorator)[0];
    return arg && typeof arg === "object" && !Array.isArray(arg) ? (arg as Record<string, unknown>) : {};
  }

  /** Solo evalúa literales (string/número/booleano/null/array/objeto) — una referencia (identifier, etc.) no se puede resolver estáticamente acá. */
  private static literalValue(expr: Expression): unknown {
    return DecoratorReader.LITERAL_READERS[expr.type]?.(expr);
  }

  private static objectLiteralValue(expr: ObjectExpression): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const prop of expr.properties) {
      if (prop.type !== "KeyValueProperty") continue;
      const key = DecoratorReader.propName(prop.key);
      if (key) obj[key] = DecoratorReader.literalValue(prop.value);
    }
    return obj;
  }

  private static propName(key: PropertyName): string | undefined {
    if (key.type === "Identifier" || key.type === "StringLiteral") return key.value;
    if (key.type === "NumericLiteral") return String(key.value);
    return undefined;
  }
}

export const decoratorReaderTransform: NgjsTransform = {
  transform: (code, path) => DecoratorReader.read(code, path),
};
