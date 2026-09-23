import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ZonePatchesRuntime } from "@/compiler/zone-patches-runtime.ts";

/** Evalúa `source()` en una ventana jsdom fresca (aislada por test) y devuelve esa ventana ya parcheada. */
function evaluate(): Window & typeof globalThis {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
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
    expect(scope.calls).toBe(1);
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
});
