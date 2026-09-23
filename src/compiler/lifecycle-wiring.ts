import type { BindingsMetadata } from "@/metadata/decorator-metadata.ts";

type Inputs = BindingsMetadata["inputs"];

/**
 * Traduce los métodos de lifecycle de Angular real (detectados por nombre en `DecoratorReader`, sin
 * decorador) a los 5 hooks nativos de un controller de AngularJS (`$onChanges`/`$onInit`/`$doCheck`/
 * `$postLink`/`$onDestroy`) — AngularJS los llama solo si el controller los tiene definidos, así que se
 * estampa `ClassName.prototype.$xxx` únicamente cuando hace falta.
 *
 * El código de la clase NO se toca: `ngOnInit`/etc. quedan como los escribió el autor, 100% Angular real.
 * Lo que se genera es un método puente que los llama — nunca al revés.
 */
export class LifecycleWiring {
  static hasAny(hooks: string[]): boolean {
    return hooks.length > 0;
  }

  static statements(className: string, hooks: string[], inputs: Inputs): string[] {
    const has = (name: string): boolean => hooks.includes(name);

    const statements: string[] = [];
    if (has("ngOnInit")) statements.push(`${className}.prototype.$onInit = function () { this.ngOnInit(); };`);
    if (has("ngOnDestroy")) statements.push(`${className}.prototype.$onDestroy = function () { this.ngOnDestroy(); };`);
    if (has("ngOnChanges")) statements.push(LifecycleWiring.onChangesStatement(className, inputs));
    if (has("ngAfterContentInit") || has("ngAfterViewInit")) {
      statements.push(LifecycleWiring.postLinkStatement(className, has("ngAfterContentInit"), has("ngAfterViewInit")));
    }
    if (has("ngDoCheck") || has("ngAfterContentChecked") || has("ngAfterViewChecked")) {
      statements.push(
        LifecycleWiring.doCheckStatement(className, has("ngDoCheck"), has("ngAfterContentChecked"), has("ngAfterViewChecked")),
      );
    }
    return statements;
  }

  /** Orden real de Angular: `AfterContentInit` antes que `AfterViewInit`. `$postLink` corre una sola vez, como los dos "Init". */
  private static postLinkStatement(className: string, content: boolean, view: boolean): string {
    const calls = [content && "this.ngAfterContentInit();", view && "this.ngAfterViewInit();"].filter(Boolean).join(" ");
    return `${className}.prototype.$postLink = function () { ${calls} };`;
  }

  /**
   * `$doCheck` es el único hook de AngularJS que corre en cada digest — de ahí cuelgan también los que no
   * tienen contraparte real (`AfterContentChecked`/`AfterViewChecked`). Se llaman SINCRÓNICO, en orden
   * (content antes que view, como en Angular real) — nada de `$scope.$evalAsync`: `$doCheck` corre una vez
   * por cada pasada INTERNA del loop de `$digest` (no una vez por digest "lógico"), así que encolar algo en
   * `$evalAsync` desde ahí deja la cola async no vacía al final de cada pasada para siempre — el digest
   * nunca estabiliza y AngularJS aborta con "$digest() iterations reached" a las 10 vueltas. Probado.
   */
  private static doCheckStatement(className: string, doCheck: boolean, contentChecked: boolean, viewChecked: boolean): string {
    const calls = [
      doCheck && "this.ngDoCheck();",
      contentChecked && "this.ngAfterContentChecked();",
      viewChecked && "this.ngAfterViewChecked();",
    ]
      .filter(Boolean)
      .join(" ");

    return `${className}.prototype.$doCheck = function () { ${calls} };`;
  }

  /**
   * Angular real: clave por `propName` (no por `bindingName`), con `firstChange` como propiedad Y como
   * método (compatible con las dos formas de leerlo en Angular real, para cuando migren de verdad). Cada
   * input en su propia IIFE — `c` no puede ser una variable compartida entre inputs: la closure de
   * `isFirstChange` la capturaría por referencia y todas terminarían viendo el último valor asignado.
   */
  private static onChangesStatement(className: string, inputs: Inputs): string {
    const entries = inputs
      .map(
        ({ propName, bindingName }) => `
    (function () {
      var c = changesObj[${JSON.stringify(bindingName)}];
      if (!c) return;
      changes[${JSON.stringify(propName)}] = { previousValue: c.previousValue, currentValue: c.currentValue, firstChange: c.isFirstChange(), isFirstChange: function () { return c.isFirstChange(); } };
    })();`,
      )
      .join("");

    return `${className}.prototype.$onChanges = function (changesObj) { var changes = {};${entries}\n    this.ngOnChanges(changes); };`;
  }
}
