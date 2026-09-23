import type { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { decoratorMetadataTransform } from "@/compiler/decorator-metadata-transform.ts";
import { decoratorReaderTransform } from "@/compiler/decorator-reader.ts";
import { decoratorWriterTransform } from "@/compiler/decorator-writer.ts";
import { injectionTokenWriterTransform } from "@/compiler/injection-token-writer.ts";
import { createModuleWriterTransform } from "@/compiler/module-writer.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";

/**
 * La cadena de compilación de decoradores (`@Component`/`@Directive`/`@NgModule`
 * → registración real de AngularJS → metadata de SWC), compartida entre el
 * adaptador de esbuild (`esbuild.ts`) y el de Vite (`vite.ts`). Es una factory
 * (no una lista fija) porque `ModuleWriter` necesita el `scanner` ya corrido
 * (`ApplicationScanner.scan()`) — el grafo del proyecto completo, resuelto
 * ANTES de emitir el primer archivo. El template scoping NO va acá — es
 * responsabilidad de quien consuma este paquete.
 */
export function createNgjsCompilerTransforms(scanner: ApplicationScanner): NgjsTransform[] {
  return [
    decoratorReaderTransform,
    decoratorWriterTransform,
    injectionTokenWriterTransform,
    createModuleWriterTransform(scanner),
    decoratorMetadataTransform,
  ];
}
