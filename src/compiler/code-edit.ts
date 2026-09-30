import MagicString from "magic-string";
import type { TransformOutput, TransformSourceMap } from "@/compiler/ngjs-transform.ts";

/**
 * Las ediciones de texto de un paso del compilador (sacar un decorador, agregar registraciones al final, un `import`
 * arriba) con su source map: el código original sigue apuntando a su línea/columna aunque se mueva.
 */
export class CodeEdit {
  private readonly text: MagicString;

  private constructor(
    code: string,
    private readonly path: string,
  ) {
    this.text = new MagicString(code);
  }

  static from(code: string, path: string): CodeEdit {
    return new CodeEdit(code, path);
  }

  /** Atajo: `code` + `text` al final. */
  static append(code: string, path: string, text: string): TransformOutput {
    return CodeEdit.from(code, path).append(text).output();
  }

  prepend(text: string): this {
    this.text.prepend(text);
    return this;
  }

  append(text: string): this {
    this.text.append(text);
    return this;
  }

  /** Reemplaza `[start, end)` (índices de string) por `replacement`; vacío = lo saca. */
  replace(start: number, end: number, replacement = ""): this {
    if (replacement) this.text.overwrite(start, end, replacement);
    else this.text.remove(start, end);
    return this;
  }

  output(): TransformOutput {
    const map = this.text.generateMap({ source: this.path, hires: true, includeContent: true });
    return { code: this.text.toString(), map: JSON.parse(map.toString()) as TransformSourceMap };
  }

  /** El índice de string de un offset en bytes UTF-8 (los `Span` de SWC), para `replace`. */
  static byteToIndex(code: string): (byteOffset: number) => number {
    if (Buffer.byteLength(code, "utf8") === code.length) return (byteOffset) => byteOffset;
    const indexOf: number[] = [];
    let index = 0;
    for (const char of code) {
      const bytes = Buffer.byteLength(char, "utf8");
      for (let i = 0; i < bytes; i++) indexOf.push(index);
      index += char.length;
    }
    indexOf.push(index);
    return (byteOffset) => indexOf[byteOffset] ?? index;
  }
}
