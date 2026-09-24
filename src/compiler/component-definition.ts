import { ClassHierarchy } from "@/compiler/class-hierarchy.ts";
import { ComponentBindings } from "@/compiler/component-bindings.ts";
import type { ComponentMetadata, DirectiveMetadata } from "@/metadata/decorator-metadata.ts";

/**
 * El objeto de `.component(nombre, { ... })` de un `@Component` (sin `controller`, que es su `ɵfac`): lo registra
 * `ModuleWriter` para los `declarations` de un `@NgModule`, y queda como dato en `ɵcmp.definition` para que el
 * runtime registre al vuelo un componente que no está en ningún módulo cargado (`loadComponent` del router).
 */
export class ComponentDefinition {
  /**
   * `moduleControllerAs`: el del `@NgModule` que lo declara (o que lo hereda); sin ninguno, `fallbackControllerAs`.
   * Para `ɵcmp.definition` se pasa `null`: solo el explícito, así el runtime puede aplicar el del módulo raíz.
   */
  static fields(
    declared: ComponentMetadata,
    moduleControllerAs?: string,
    fallbackControllerAs: string | null = "$ctrl",
  ): Record<string, unknown> {
    // Con los inputs/outputs heredados de sus bases del proyecto (`ClassHierarchy`).
    const metadata = ClassHierarchy.effective(declared);
    const options = metadata.options as { template?: string; templateUrl?: string; controllerAs?: string };
    const bindings = ComponentBindings.from(metadata.inputs, metadata.outputs);
    const controllerAs = options.controllerAs ?? moduleControllerAs ?? fallbackControllerAs ?? undefined;
    return {
      ...(options.template !== undefined && { template: options.template }),
      ...(options.templateUrl !== undefined && { templateUrl: options.templateUrl }),
      ...(controllerAs !== undefined && { controllerAs }),
      ...(Object.keys(bindings).length && { bindings }),
      ...(ComponentDefinition.projectsContent(options.template) && { transclude: true }),
    };
  }

  /**
   * Lo de `.directive()` que no sale del selector (`restrict`/`controllerAs` por alternativa los arma quien registra):
   * `bindings` (el `bindToController`), el template si lo tiene y un `controllerAs` explícito. En `ɵdir.definition`,
   * para registrar al vuelo (un módulo de test).
   */
  static directiveFields(declared: DirectiveMetadata): Record<string, unknown> {
    const metadata = ClassHierarchy.effective(declared);
    const options = metadata.options as { template?: string; templateUrl?: string; controllerAs?: string };
    const bindings = ComponentBindings.from(metadata.inputs, metadata.outputs);
    return {
      ...(Object.keys(bindings).length && { bindings }),
      ...(options.template !== undefined && { template: options.template }),
      ...(options.templateUrl !== undefined && { templateUrl: options.templateUrl }),
      ...(options.controllerAs !== undefined && { controllerAs: options.controllerAs }),
      ...(ComponentDefinition.projectsContent(options.template) && { transclude: true }),
    };
  }

  /**
   * `<ng-content>` en el template → `transclude: true`: sin eso AngularJS no le pasa `$transclude` a nadie y el
   * contenido escrito entre los tags del componente se pierde. Solo se ve con el template inline — `ng-js-vite`
   * inlinea los `templateUrl` antes del escaneo.
   */
  static projectsContent(template: string | undefined): boolean {
    return template !== undefined && /<ng-content[\s>/]/.test(template);
  }
}
