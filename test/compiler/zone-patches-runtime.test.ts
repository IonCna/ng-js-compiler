import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ZonePatchesRuntime } from "@/compiler/zone-patches-runtime.ts";

/** Evalúa `source()` en una ventana jsdom fresca (aislada por test) y devuelve esa ventana ya parcheada. */
function evaluate(setup?: (win: Window & typeof globalThis) => void): Window & typeof globalThis {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", pretendToBeVisual: true });
  setup?.(dom.window as unknown as Window & typeof globalThis);
  dom.window.eval(ZonePatchesRuntime.source());
  return dom.window as unknown as Window & typeof globalThis;
}

/** Fake $scope mínimo: $apply corre síncrono, $root.$$phase indica si ya hay un digest en curso. */
function fakeScope(): { $root: { $$phase: string | null }; $apply: () => void; calls: number } {
  const scope = {
    $root: { $$phase: null as string | null },
    calls: 0,
    $apply() {
      scope.calls++;
    },
  };
  return scope;
}

/**
 * Espera a que se vacíe la cola de microtasks: un timer de Node (no el `setTimeout` parcheado de la ventana, que
 * dispararía su propio `$apply`) corre recién cuando no queda ningún microtask, de ningún realm.
 */
function microtasksDrained(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ZonePatchesRuntime", () => {
  it("no se instala dos veces (guard de globalThis.ɵngjsZonePatched) — se detecta en que el segundo eval no reemplaza los globales otra vez", () => {
    const win = evaluate();
    const patchedSetTimeout = win.setTimeout;
    win.eval(ZonePatchesRuntime.source());

    expect(win.setTimeout).toBe(patchedSetTimeout);
  });

  it("setTimeout: corre el callback y dispara $apply después, solo si ɵngjsRootScope ya está seteado", async () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    let called = false;
    await new Promise<void>((resolve) => {
      win.setTimeout(
        (a: string, b: number) => {
          called = true;
          expect(a).toBe("x");
          expect(b).toBe(2);
          resolve();
        },
        0,
        "x",
        2,
      );
    });
    // El $apply del patch corre en el mismo tick del callback (sincrónico, dentro del setTimeout real).
    expect(called).toBe(true);
    expect(scope.calls).toBe(1);
  });

  it("setTimeout: sin ɵngjsRootScope todavía (antes del bootstrap), no explota y no hace nada extra", async () => {
    const win = evaluate();
    let called = false;
    await new Promise<void>((resolve) => {
      win.setTimeout(() => {
        called = true;
        resolve();
      }, 0);
    });
    expect(called).toBe(true);
  });

  it("setInterval: cada tick dispara $apply", async () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    let ticks = 0;
    const id = await new Promise<number>((resolve) => {
      const intervalId = win.setInterval(() => {
        ticks++;
        if (ticks === 2) resolve(intervalId);
      }, 5);
    });
    win.clearInterval(id);

    expect(ticks).toBe(2);
    expect(scope.calls).toBe(2);
  });

  it("Promise.prototype.then: dispara $apply después de un .then() explícito", async () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    const PromiseCtor = win.Promise;
    let received: number | undefined;
    // `await` sobre una promesa de OTRO realm (win.Promise, no la nativa de Node de este test) pasa por el
    // protocolo genérico de "thenable" y llamaría `.then()` una vez más — se envuelve en una promesa NATIVA
    // de Node para no confundir esa llamada extra con la del patch bajo prueba.
    await new Promise<void>((resolve) => {
      PromiseCtor.resolve(1).then((v: number) => {
        received = v;
        resolve();
      });
    });

    expect(received).toBe(1);
    await microtasksDrained();
    expect(scope.calls).toBe(1);
  });

  it("Promise.prototype.then: una cadena de .then termina en UN digest, cuando se vacía la cola de microtasks (onMicrotaskEmpty)", async () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    const steps: number[] = [];
    win.Promise.resolve()
      .then(() => steps.push(1))
      .then(() => steps.push(2))
      .then(() => steps.push(3));

    await microtasksDrained();
    expect(steps).toEqual([1, 2, 3]);
    expect(scope.calls).toBe(1);
  });

  it("Promise.prototype.then: el digest corre después de que el motor adopta la promesa que devolvió el callback", async () => {
    // Un hook async de UI-Router devuelve una promesa `$q`: si el digest corre antes de que el motor le encadene sus
    // handlers (un microtask después), `$q` la ve rechazada y sin handlers ("Possibly unhandled rejection").
    const win = evaluate();
    let adopted = false;
    let adoptedAtDigest: boolean | undefined;
    const scope = fakeScope();
    scope.$apply = () => {
      scope.calls++;
      adoptedAtDigest = adopted;
    };
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    const thenable = {
      then(resolve: (value: number) => void) {
        adopted = true;
        resolve(1);
      },
    };
    win.Promise.resolve().then(() => thenable);

    await microtasksDrained();
    expect(adoptedAtDigest).toBe(true);
  });

  it("addEventListener: dispara $apply después de correr el listener", () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    const el = win.document.createElement("button");
    let received: Event | undefined;
    el.addEventListener("click", (event) => {
      received = event;
    });

    el.dispatchEvent(new win.Event("click"));

    expect(received).toBeDefined();
    expect(scope.calls).toBe(1);
  });

  it("removeEventListener: saca el listener de verdad, usando la MISMA referencia que pasó el dev (no el wrapper)", () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    const el = win.document.createElement("button");
    let calls = 0;
    const handler = () => {
      calls++;
    };

    el.addEventListener("click", handler);
    el.dispatchEvent(new win.Event("click"));
    expect(calls).toBe(1);

    el.removeEventListener("click", handler);
    el.dispatchEvent(new win.Event("click"));
    expect(calls).toBe(1); // no volvió a sumar — el remove agarró el wrapper correcto.
  });

  it("dos addEventListener del mismo handler para eventos distintos: remove de uno no saca el otro", () => {
    const win = evaluate();
    const el = win.document.createElement("button");
    let clicks = 0;
    let hovers = 0;
    const handler = (event: Event) => {
      if (event.type === "click") clicks++;
      else hovers++;
    };

    el.addEventListener("click", handler);
    el.addEventListener("mouseover", handler);
    el.removeEventListener("click", handler);

    el.dispatchEvent(new win.Event("click"));
    el.dispatchEvent(new win.Event("mouseover"));

    expect(clicks).toBe(0);
    expect(hovers).toBe(1);
  });

  it("el mismo handler en dos elementos: remove en uno no toca el del otro (el wrapper se busca por target)", () => {
    const win = evaluate();
    const a = win.document.createElement("button");
    const b = win.document.createElement("button");
    const seen: string[] = [];
    const handler = function (this: HTMLElement) {
      seen.push(this === a ? "a" : "b");
    };

    a.addEventListener("click", handler);
    b.addEventListener("click", handler);
    b.removeEventListener("click", handler);

    a.dispatchEvent(new win.Event("click"));
    b.dispatchEvent(new win.Event("click"));

    expect(seen).toEqual(["a"]);
  });

  it("el mismo handler dos veces en el mismo target/tipo/fase se registra una sola vez (como el nativo)", () => {
    const win = evaluate();
    const el = win.document.createElement("button");
    let clicks = 0;
    const handler = () => {
      clicks++;
    };

    el.addEventListener("click", handler);
    el.addEventListener("click", handler);
    el.dispatchEvent(new win.Event("click"));
    expect(clicks).toBe(1);

    el.removeEventListener("click", handler);
    el.dispatchEvent(new win.Event("click"));
    expect(clicks).toBe(1);
  });

  it("lo programado dentro de runOutsideAngular (globalThis.ɵngjsOutsideAngular > 0) no dispara $apply al correr", async () => {
    const win = evaluate();
    const scope = fakeScope();
    const globals = win as unknown as { ɵngjsRootScope: unknown; ɵngjsOutsideAngular: number };
    globals.ɵngjsRootScope = scope;

    globals.ɵngjsOutsideAngular = 1;
    const outside = new Promise<void>((resolve) => win.setTimeout(resolve, 0));
    const el = win.document.createElement("button");
    el.addEventListener("click", () => {});
    globals.ɵngjsOutsideAngular = 0;

    await outside;
    el.dispatchEvent(new win.Event("click"));
    expect(scope.calls).toBe(0);

    // Programado afuera de runOutsideAngular: sí.
    await new Promise<void>((resolve) => win.setTimeout(resolve, 0));
    expect(scope.calls).toBe(1);
  });

  it("un callback programado afuera corre afuera: lo que él programe (un .then, un timer) tampoco dispara $apply", async () => {
    const win = evaluate();
    const scope = fakeScope();
    const globals = win as unknown as { ɵngjsRootScope: unknown; ɵngjsOutsideAngular: number };
    globals.ɵngjsRootScope = scope;

    let seenOutside = -1;
    globals.ɵngjsOutsideAngular = 1;
    const chained = new Promise<void>((resolve) =>
      win.setTimeout(() => {
        seenOutside = globals.ɵngjsOutsideAngular;
        win.Promise.resolve().then(() => win.setTimeout(resolve, 0));
      }, 0),
    );
    globals.ɵngjsOutsideAngular = 0;

    await chained;
    expect(seenOutside).toBe(1);
    expect(globals.ɵngjsOutsideAngular).toBe(0);
    expect(scope.calls).toBe(0);
  });

  it("una promesa resuelta con otra promesa no dispara $apply por el encadenado interno del motor (solo por los .then de la app)", async () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    const inner = win.Promise.resolve(1);
    await new win.Promise((resolve) => resolve(inner));
    expect(scope.calls).toBe(0);

    await win.Promise.resolve().then(() => undefined);
    expect(scope.calls).toBe(1);
  });

  it("con la app destruida ($rootScope.$root === null) un timer pendiente no explota", async () => {
    const win = evaluate();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = { $root: null, $apply: () => { throw new Error("no"); } };
    let ran = false;
    await new Promise<void>((resolve) => win.setTimeout(() => { ran = true; resolve(); }, 0));
    expect(ran).toBe(true);
  });

  it("requestAnimationFrame: dispara $apply después del callback", async () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
    expect(scope.calls).toBe(1);
  });

  it("queueMicrotask: dispara $apply después del callback", async () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    await new Promise<void>((resolve) => win.queueMicrotask(() => resolve()));
    expect(scope.calls).toBe(1);
  });

  it("MutationObserver: el callback dispara $apply", async () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    const el = win.document.createElement("div");
    const observed = new Promise<void>((resolve) => {
      const observer = new win.MutationObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(el, { attributes: true });
    });
    el.setAttribute("id", "x");

    await observed;
    expect(scope.calls).toBe(1);
  });

  it("IntersectionObserver/ResizeObserver: el callback corre en la zona donde se construyó; instanceof y subclases siguen andando", () => {
    // jsdom no los trae: un nativo falso que guarda el callback para dispararlo a mano.
    const win = evaluate((w) => {
      for (const name of ["IntersectionObserver", "ResizeObserver"]) {
        (w as unknown as Record<string, unknown>)[name] = class {
          constructor(public callback: (...args: unknown[]) => void, public options?: unknown) {}
          trigger(entries: unknown[]) {
            this.callback(entries, this);
          }
        };
      }
    });
    const scope = fakeScope();
    const globals = win as unknown as {
      ɵngjsRootScope: unknown;
      ɵngjsOutsideAngular: number;
      IntersectionObserver: new (cb: (...args: unknown[]) => void, options?: unknown) => { trigger(entries: unknown[]): void; options: unknown };
      ResizeObserver: new (cb: (...args: unknown[]) => void) => { trigger(entries: unknown[]): void };
    };
    globals.ɵngjsRootScope = scope;

    let received: unknown[] = [];
    const inside = new globals.IntersectionObserver((entries) => (received = entries as unknown[]), { threshold: 1 });
    expect(inside).toBeInstanceOf(globals.IntersectionObserver);
    expect(inside.options).toEqual({ threshold: 1 });
    inside.trigger(["entry"]);
    expect(received).toEqual(["entry"]);
    expect(scope.calls).toBe(1);

    class Sub extends globals.ResizeObserver {}
    const sub = new Sub(() => {});
    expect(sub).toBeInstanceOf(Sub);
    sub.trigger([]);
    expect(scope.calls).toBe(2);

    globals.ɵngjsOutsideAngular = 1;
    const outside = new globals.IntersectionObserver(() => {});
    globals.ɵngjsOutsideAngular = 0;
    outside.trigger([]);
    expect(scope.calls).toBe(2);
  });

  it("handlers por propiedad (el.onclick): dispara $apply, el getter devuelve el original y el retorno se respeta", () => {
    const win = evaluate();
    const scope = fakeScope();
    (win as unknown as { ɵngjsRootScope: unknown }).ɵngjsRootScope = scope;

    const el = win.document.createElement("button");
    let clicks = 0;
    const handler = () => {
      clicks++;
      return false;
    };
    el.onclick = handler;
    expect(el.onclick).toBe(handler);

    const event = new win.MouseEvent("click", { cancelable: true });
    el.dispatchEvent(event);
    expect(clicks).toBe(1);
    expect(scope.calls).toBe(1);
    // `return false` en un handler por propiedad cancela el evento: el wrapper tiene que devolverlo.
    expect(event.defaultPrevented).toBe(true);

    el.onclick = null;
    expect(el.onclick).toBeNull();
    el.dispatchEvent(new win.MouseEvent("click"));
    expect(clicks).toBe(1);
    expect(scope.calls).toBe(1);
  });

  it("handlers por propiedad asignados dentro de runOutsideAngular no disparan $apply", () => {
    const win = evaluate();
    const scope = fakeScope();
    const globals = win as unknown as { ɵngjsRootScope: unknown; ɵngjsOutsideAngular: number };
    globals.ɵngjsRootScope = scope;

    const el = win.document.createElement("button");
    let clicks = 0;
    globals.ɵngjsOutsideAngular = 1;
    el.onclick = () => {
      clicks++;
    };
    globals.ɵngjsOutsideAngular = 0;

    el.dispatchEvent(new win.MouseEvent("click"));
    expect(clicks).toBe(1);
    expect(scope.calls).toBe(0);
  });

  it("handlers por propiedad fuera del DOM (xhr.onload): el getter devuelve el original", () => {
    const win = evaluate();
    const xhr = new win.XMLHttpRequest();
    const handler = () => {};
    xhr.onload = handler;
    expect(xhr.onload).toBe(handler);
  });

  it("addEventListener con { once: true }: tras dispararse, el mismo handler se puede volver a registrar", () => {
    const win = evaluate();
    const el = win.document.createElement("button");
    let clicks = 0;
    const handler = () => {
      clicks++;
    };

    el.addEventListener("click", handler, { once: true });
    el.dispatchEvent(new win.Event("click"));
    el.dispatchEvent(new win.Event("click"));
    expect(clicks).toBe(1);

    el.addEventListener("click", handler);
    el.dispatchEvent(new win.Event("click"));
    expect(clicks).toBe(2);
  });

  it("addEventListener con signal: tras abort(), el mismo handler se puede volver a registrar", () => {
    const win = evaluate();
    const el = win.document.createElement("button");
    let clicks = 0;
    const handler = () => {
      clicks++;
    };

    const controller = new win.AbortController();
    el.addEventListener("click", handler, { signal: controller.signal });
    el.dispatchEvent(new win.Event("click"));
    controller.abort();
    el.dispatchEvent(new win.Event("click"));
    expect(clicks).toBe(1);

    el.addEventListener("click", handler);
    el.dispatchEvent(new win.Event("click"));
    expect(clicks).toBe(2);
  });

  it("addEventListener con una señal ya abortada no registra nada (ni bloquea un registro posterior)", () => {
    const win = evaluate();
    const el = win.document.createElement("button");
    let clicks = 0;
    const handler = () => {
      clicks++;
    };

    const controller = new win.AbortController();
    controller.abort();
    el.addEventListener("click", handler, { signal: controller.signal });
    el.dispatchEvent(new win.Event("click"));
    expect(clicks).toBe(0);

    el.addEventListener("click", handler);
    el.dispatchEvent(new win.Event("click"));
    expect(clicks).toBe(1);
  });
});
