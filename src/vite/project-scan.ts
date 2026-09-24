import { resolve, sep } from "node:path";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { createNgjsCompilerTransforms } from "@/compiler/ngjs-compiler-transforms.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";

/**
 * El escaneo del proyecto (`ApplicationScanner`) en el dev-server, vivo: `ModuleWriter` registra cada `@NgModule`
 * con la metadata de TODO el proyecto (sus `declarations`/`imports` resueltos a otros archivos), así que un archivo
 * nuevo o un decorador editado cambia la salida de archivos que no se tocaron. Cada cambio de un `.ts` bajo
 * `sourceRoot` dispara un escaneo nuevo; los `transform` que lleguen mientras tanto lo esperan (`ready()`), así
 * nunca compilan contra el grafo viejo.
 */
export class ProjectScan {
  private transforms: NgjsTransform[];
  private pending: Promise<void> = Promise.resolve();
  private readonly roots: string[];

  constructor(
    private readonly sourceRoot: string | string[],
    private readonly extraTransforms: NgjsTransform[],
  ) {
    this.transforms = extraTransforms;
    this.roots = (Array.isArray(sourceRoot) ? sourceRoot : [sourceRoot]).map((root) => resolve(root));
  }

  /** Los transforms del último escaneo, después de esperar el que esté en curso (su error, si falló, sale acá). */
  async ready(): Promise<NgjsTransform[]> {
    await this.pending;
    return this.transforms;
  }

  /**
   * Escaneo nuevo, encadenado detrás del anterior. Si falla (un archivo a medio escribir), el error sale en los
   * `transform` que lo esperan (overlay de Vite) y el grafo anterior queda: el próximo cambio reintenta.
   */
  rescan(): Promise<void> {
    this.pending = this.pending.catch(() => undefined).then(() => this.scan());
    return this.pending;
  }

  /** `true` si `file` es un `.ts` de alguna raíz escaneada — lo que puede cambiar el grafo. */
  covers(file: string): boolean {
    if (!file.endsWith(".ts")) return false;
    const absolute = resolve(file);
    return this.roots.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`));
  }

  private async scan(): Promise<void> {
    const scanner = new ApplicationScanner();
    await scanner.scan(this.sourceRoot, { transforms: this.extraTransforms });
    this.transforms = [...this.extraTransforms, ...createNgjsCompilerTransforms(scanner)];
  }
}
