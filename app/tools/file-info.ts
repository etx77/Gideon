import { tool } from "@openai/agents";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

const BASE_DIR = "/data";

function safePath(inputPath: string): string {
  const resolved = path.resolve(BASE_DIR, inputPath);

  if (
    resolved !== BASE_DIR &&
    !resolved.startsWith(BASE_DIR + path.sep)
  ) {
    throw new Error("Percorso non consentito");
  }

  return resolved;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function countLines(
  filePath: string,
  maxBytes: number
): Promise<{
  lines: number | null;
  estimated: boolean;
}> {
  const stat = await fs.stat(filePath);

  /*
   * Per file molto grandi evitiamo di attraversare inutilmente
   * tutto il contenuto solo per contare le righe.
   */
  if (stat.size > maxBytes) {
    return {
      lines: null,
      estimated: false,
    };
  }

  const content = await fs.readFile(filePath, "utf8");

  if (content.length === 0) {
    return {
      lines: 0,
      estimated: false,
    };
  }

  return {
    lines: content.split(/\r?\n/).length,
    estimated: false,
  };
}

export const fileInfoTool = tool({
  name: "file_info",

  description: `
Fornisce informazioni dettagliate su un file o una directory sotto /data.

Usa questo tool prima di analizzare file potenzialmente grandi quando
devi conoscere dimensione, tipo e altre caratteristiche del file.

Restituisce:
- percorso
- nome
- tipo (file o directory)
- dimensione
- dimensione leggibile
- data ultima modifica
- numero di righe per file di testo non troppo grandi

Per file molto grandi il numero di righe può non essere calcolato.

Questo tool NON modifica il file.
`,

  parameters: z.object({
    path: z
      .string()
      .describe("Percorso relativo a /data del file o directory"),
  }),

  async execute({ path: relativePath }) {
    const target = safePath(relativePath);

    const stat = await fs.stat(target);

    const isDirectory = stat.isDirectory();
    const isFile = stat.isFile();

    let lineInfo: {
      lines: number | null;
      estimated: boolean;
    } = {
      lines: null,
      estimated: false,
    };

    if (isFile) {
      lineInfo = await countLines(
        target,
        50 * 1024 * 1024
      );
    }

    return JSON.stringify({
      path: relativePath,
      name: path.basename(target),

      type: isDirectory
        ? "directory"
        : isFile
          ? "file"
          : "other",

      size: isFile ? stat.size : null,

      sizeFormatted: isFile
        ? formatBytes(stat.size)
        : null,

      modifiedAt: stat.mtime.toISOString(),

      lines: lineInfo.lines,

      linesEstimated: lineInfo.estimated,
    });
  },
});
