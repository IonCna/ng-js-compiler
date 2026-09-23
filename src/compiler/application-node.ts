import type { DecoratorMetadata } from "@/metadata/decorator-metadata.ts";

/**
 * Lo que declara un `@NgModule`, ya resuelto y categorizado por tipo — no
 * strings, referencias reales a otros `ApplicationNode`. Solo se llena para
 * nodos `kind === "ngmodule"`; en cualquier otro nodo queda con los 3 arrays
 * vacíos (no hay un tipo separado por simplicidad — el `kind` de `metadata`
 * ya dice si tiene sentido mirar esto).
 */
export interface DeclarationBuckets {
  components: ApplicationNode[];
  directives: ApplicationNode[];
  pipes: ApplicationNode[];
}

/**
 * Un nodo por clase decorada del proyecto (`@Component`/`@Directive`/`@Pipe`/
 * `@Injectable`/`@NgModule`) — arma `ApplicationScanner` en dos pasadas: esta
 * clase nace con `metadata` ya leída pero `declarations`/`imports` vacíos
 * (pasada 1), y `ApplicationScanner.resolve()` los llena después (pasada 2),
 * cuando ya existen TODOS los nodos del proyecto para poder referenciarlos.
 */
export class ApplicationNode {
  declarations: DeclarationBuckets = { components: [], directives: [], pipes: [] };
  imports: ApplicationNode[] = [];
  /** Módulos de AngularJS legacy de `imports` — expresiones JS que dan su nombre (`"ngAnimate"`, `legacyModule.name`). */
  legacyImports: string[] = [];

  constructor(
    public readonly className: string,
    public readonly path: string,
    public readonly metadata: DecoratorMetadata,
  ) {}
}
