import { createHash } from "node:crypto";

/**
 * Hash corto y estable de `sha256`, sin coordinación entre archivos — para
 * nombres de registro AngularJS (id de `angular.module`, nombres de DI de `TokenName`).
 */
export class HashId {
  static from(...parts: string[]): string {
    return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 8);
  }

  /**
   * Como `from()`, pero prefijado con `name` — sin esto, un error de AngularJS
   * (`[$injector:modulerr] Failed to instantiate module '68f3b23b'`) no dice
   * nada útil. Con el prefijo: `'AppModule_68f3b23b'`, legible Y sigue siendo
   * único (el hash rompe el empate si dos clases distintas comparten nombre).
   */
  static readable(name: string, ...parts: string[]): string {
    return `${name}_${HashId.from(name, ...parts)}`;
  }
}
