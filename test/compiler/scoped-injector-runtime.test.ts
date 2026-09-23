import { describe, expect, it, vi } from "vitest";
import { ScopedInjectorRuntime } from "@/compiler/scoped-injector-runtime.ts";

type ControllerDelegate = (expression: unknown, locals: Record<string, unknown> | undefined, later?: boolean, ident?: unknown) => unknown;

interface ElementInjectorNode {
  resolve(name: string): unknown;
  destroy(): void;
}

/** Evalúa `source()` y devuelve `ɵElementInjectorNode`/`ɵscopedController` para manejarlos a mano. */
function evaluate(): {
  Node: new (providers: unknown[], parent: unknown, $injector: unknown, element?: unknown, boundary?: unknown) => ElementInjectorNode;
  scopedController: ($delegate: ControllerDelegate, $injector: unknown) => ControllerDelegate;
} {
  // eslint-disable-next-line no-new-func
  return new Function(`${ScopedInjectorRuntime.source()}; return { Node: ɵElementInjectorNode, scopedController: ɵscopedController };`)();
}

/** jqLite mínimo: `data()`/`inheritedData()` sobre un mapa a mano, con `parent` opcional. */
function fakeElement(parent?: { store: Map<string, unknown> }) {
  const store = new Map<string, unknown>();
  return {
    store,
    data: (key: string, value?: unknown) => {
      if (value === undefined) return store.get(key);
      store.set(key, value);
      return undefined;
    },
    inheritedData: (key: string) => store.get(key) ?? parent?.store.get(key),
  };
}

describe("ScopedInjectorRuntime", () => {
  describe("ɵElementInjectorNode", () => {
    it("class/constructor sin deps: usa ctor.ɵfac (misma convención que ModuleWriter para providers de @NgModule)", () => {
      const { Node } = evaluate();
      class UserService {
        static ɵfac: unknown[];
        name = "Ana";
      }
      UserService.ɵfac = [function UserService_Factory() { return new UserService(); }];

      const node = new Node([{ token: "UserService_hash", kind: "class", ctor: UserService }], undefined, {});
      expect((node.resolve("UserService_hash") as UserService).name).toBe("Ana");
    });

    it("useClass/constructor con deps: resuelve cada dep contra la cadena y construye con new", () => {
      const { Node } = evaluate();
      class Logger {
        constructor(readonly prefix: string) {}
      }
      const $injector = { get: (name: string) => (name === "PREFIX" ? ">> " : undefined) };

      const node = new Node([{ token: "Logger_hash", kind: "useClass", ctor: Logger, deps: ["PREFIX"] }], undefined, $injector);
      expect((node.resolve("Logger_hash") as Logger).prefix).toBe(">> ");
    });

    it("useValue / useFactory / useExisting", () => {
      const { Node } = evaluate();
      const node = new Node(
        [
          { token: "api.url", kind: "useValue", value: "https://api" },
          { token: "greeting", kind: "useFactory", factory: (url: string) => "hola " + url, deps: ["api.url"] },
          { token: "alias", kind: "useExisting", existing: "api.url" },
        ],
        undefined,
        {},
      );

      expect(node.resolve("api.url")).toBe("https://api");
      expect(node.resolve("greeting")).toBe("hola https://api");
      expect(node.resolve("alias")).toBe("https://api");
    });

    it("multi: junta todas las recetas del token en un array", () => {
      const { Node } = evaluate();
      const node = new Node(
        [
          { token: "HOOKS", kind: "useValue", value: "a", multi: true },
          { token: "HOOKS", kind: "useValue", value: "b", multi: true },
        ],
        undefined,
        {},
      );

      expect(node.resolve("HOOKS")).toEqual(["a", "b"]);
    });

    it("cachea: la misma instancia en resoluciones sucesivas", () => {
      const { Node } = evaluate();
      let calls = 0;
      const node = new Node([{ token: "x", kind: "useFactory", factory: () => ({ n: ++calls }), deps: [] }], undefined, {});

      const first = node.resolve("x");
      const second = node.resolve("x");
      expect(first).toBe(second);
      expect(calls).toBe(1);
    });

    it("lo que no está en el nodo sube al padre, y sin padre cae al $injector de la app", () => {
      const { Node } = evaluate();
      const $injector = { get: vi.fn((name: string) => (name === "$http" ? "native-http" : undefined)) };
      const parent = new Node([{ token: "Foo", kind: "useValue", value: "from-parent" }], undefined, $injector);
      const child = new Node([], parent, $injector);

      expect(child.resolve("Foo")).toBe("from-parent");
      expect(child.resolve("$http")).toBe("native-http");
      expect($injector.get).toHaveBeenCalledWith("$http");
    });

    it("ɵresolve con optional: resuelve por la cadena (nodo → padre → $injector) y da null si nadie lo provee", () => {
      const { Node } = evaluate();
      const $injector = { has: (name: string) => name === "$http", get: (name: string) => (name === "$http" ? "native-http" : undefined) };
      const parent = new Node([{ token: "Foo", kind: "useValue", value: "from-parent" }], undefined, $injector);
      const child = new Node([], parent, $injector);

      const resolve = child.resolve("ɵresolve") as (token: string, flags: Record<string, boolean>) => unknown;
      const optional = (token: string) => resolve(token, { optional: true });
      expect(optional("Foo")).toBe("from-parent");
      expect(optional("$http")).toBe("native-http");
      expect(optional("Missing")).toBeNull();
    });

    it("ɵresolve con self/skipSelf: la semántica de ElementInjectorNode de ngjs-core", () => {
      const { Node } = evaluate();
      const $injector = { has: (name: string) => name === "App", get: (name: string) => (name === "App" ? "from-app" : undefined) };
      const parent = new Node([{ token: "Theme", kind: "useValue", value: "parent-theme" }], undefined, $injector);
      const child = new Node([{ token: "Theme", kind: "useValue", value: "child-theme" }], parent, $injector);
      const resolve = child.resolve("ɵresolve") as (token: string, flags: Record<string, boolean>) => unknown;

      expect(resolve("Theme", { self: true })).toBe("child-theme");
      expect(resolve("Theme", { skipSelf: true })).toBe("parent-theme");
      expect(() => resolve("App", { self: true })).toThrow(/con \{ self: true \}/);
      expect(resolve("App", { self: true, optional: true })).toBeNull();
    });

    it("ɵresolve con host (como Angular): sube por los nodos dentro del elemento host y no consulta la app", () => {
      const { Node } = evaluate();
      const $injector = { has: (name: string) => name === "App", get: (name: string) => (name === "App" ? "from-app" : undefined) };
      // outer (fuera del host) > host (el componente dueño de la vista) > inner (una directiva adentro)
      const outerEl = { contains: () => false };
      const innerEl = {};
      const hostEl = { contains: (el: unknown) => el === innerEl };
      const outer = new Node([{ token: "Theme", kind: "useValue", value: "outer-theme" }, { token: "Outer", kind: "useValue", value: "outer" }], undefined, $injector, outerEl);
      const host = new Node([{ token: "Theme", kind: "useValue", value: "host-theme" }], outer, $injector, hostEl);
      const inner = new Node([], host, $injector, innerEl, hostEl);
      const resolve = inner.resolve("ɵresolve") as (token: string, flags: Record<string, boolean>) => unknown;

      expect(resolve("Theme", { host: true })).toBe("host-theme");
      expect(resolve("Outer", { host: true, optional: true })).toBeNull();
      expect(() => resolve("App", { host: true })).toThrow(/con \{ host: true \}/);
    });

    it("destroy(): limpia la caché", () => {
      const { Node } = evaluate();
      let calls = 0;
      const node = new Node([{ token: "x", kind: "useFactory", factory: () => ++calls, deps: [] }], undefined, {});

      node.resolve("x");
      node.destroy();
      node.resolve("x");
      expect(calls).toBe(2);
    });
  });

  describe("ɵscopedController (el .decorator(\"$controller\", ...))", () => {
    it("sin $element en locals, delega tal cual", () => {
      const { scopedController } = evaluate();
      const $delegate = vi.fn(() => "instance");
      const decorated = scopedController($delegate, {});

      const result = decorated("Expr", { $scope: {} }, false, "ctrl");

      expect(result).toBe("instance");
      expect($delegate).toHaveBeenCalledWith("Expr", { $scope: {} }, false, "ctrl");
    });

    it("una clase con ɵproviders propios: crea un nodo, lo cuelga en $element.data() y limpia en $destroy", () => {
      const { scopedController } = evaluate();
      const $delegate = vi.fn((_expr, locals) => locals);
      const $injector = {};
      const decorated = scopedController($delegate, $injector);

      const expression = Object.assign(["UserService_hash", function Factory() {}], {
        ɵproviders: [{ token: "UserService_hash", kind: "useValue", value: "mock-user" }],
      });
      const $element = fakeElement();
      let destroyHandler: (() => void) | undefined;
      const $scope = { $on: (event: string, handler: () => void) => { if (event === "$destroy") destroyHandler = handler; } };

      const locals = decorated(expression, { $element, $scope }, false, undefined) as { UserService_hash?: unknown };

      expect(locals.UserService_hash).toBe("mock-user");
      expect($element.store.get("$ngjsScopedInjector")).toBeDefined();

      destroyHandler?.();
      // Después de destroy, la próxima resolución del mismo token vuelve a instanciar (cache limpia) — se
      // prueba indirectamente confirmando que el nodo sigue ahí y `destroy` no rompe nada.
      expect(($element.store.get("$ngjsScopedInjector") as ElementInjectorNode).resolve("UserService_hash")).toBe("mock-user");
    });

    it("un descendiente sin providers propios hereda el nodo del ancestro y resuelve sus deps contra él", () => {
      const { scopedController } = evaluate();
      const $delegate = vi.fn((_expr, locals) => locals);
      const decorated = scopedController($delegate, {});

      const parentExpr = Object.assign(["Foo_hash", function Factory() {}], {
        ɵproviders: [{ token: "Foo_hash", kind: "useValue", value: "from-parent" }],
      });
      const parentElement = fakeElement();
      decorated(parentExpr, { $element: parentElement, $scope: { $on: () => {} } }, false, undefined);

      // El hijo no tiene providers propios, pero pide "Foo_hash" en su propio $inject (el array de su ɵfac).
      const childExpr = ["Foo_hash", function ChildFactory() {}];
      const childElement = fakeElement(parentElement);

      const locals = decorated(childExpr, { $element: childElement }, false, undefined) as { Foo_hash?: unknown };
      expect(locals.Foo_hash).toBe("from-parent");
    });

    it("dos instancias hermanas con providers propios quedan aisladas (cada una la suya, no una registración global)", () => {
      const { scopedController } = evaluate();
      const $delegate = vi.fn((_expr, locals) => locals);
      const decorated = scopedController($delegate, {});

      const expression = Object.assign(["Foo_hash", function Factory() {}], {
        ɵproviders: [{ token: "Foo_hash", kind: "useFactory", factory: () => ({}), deps: [] }],
      });

      const a = decorated(expression, { $element: fakeElement(), $scope: { $on: () => {} } }, false, undefined) as { Foo_hash: unknown };
      const b = decorated(expression, { $element: fakeElement(), $scope: { $on: () => {} } }, false, undefined) as { Foo_hash: unknown };

      expect(a.Foo_hash).not.toBe(b.Foo_hash);
    });

    it("no pisa una key que otro bridge ya haya puesto en locals", () => {
      const { scopedController } = evaluate();
      const $delegate = vi.fn((_expr, locals) => locals);
      const decorated = scopedController($delegate, {});

      const expression = Object.assign(["Foo_hash", function Factory() {}], {
        ɵproviders: [{ token: "Foo_hash", kind: "useValue", value: "from-node" }],
      });

      const locals = decorated(
        expression,
        { $element: fakeElement(), $scope: { $on: () => {} }, Foo_hash: "from-other-bridge" },
        false,
        undefined,
      ) as { Foo_hash: unknown };

      expect(locals.Foo_hash).toBe("from-other-bridge");
    });
  });
});
