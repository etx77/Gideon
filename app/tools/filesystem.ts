import { tool } from "@openai/agents";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

const BASE_DIR = "/data";

function safePath(inputPath: string): string {
  const resolved = path.resolve(BASE_DIR, inputPath);

  if (resolved !== BASE_DIR && !resolved.startsWith(BASE_DIR + path.sep)) {
    throw new Error("Percorso non consentito");
  }

  return resolved;
}

export const listFilesTool = tool({
  name: "list_files",

  description: `
Elenca file e directory disponibili nell'area /data.

Usa questo tool quando:
- l'utente chiede quali file sono disponibili
- devi esplorare una directory
- devi individuare file da analizzare

Puoi leggere solamente contenuti sotto /data.
`,

  parameters: z.object({
    path: z
      .string()
      .default(".")
      .describe("Percorso relativo a /data"),
  }),

  async execute({ path: relativePath }) {
    const target = safePath(relativePath);

    const entries = await fs.readdir(target, {
      withFileTypes: true,
    });

    const results = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));

    return JSON.stringify({
      path: relativePath,
      results,
    });
  },
});


export const readFileTool = tool({
  name: "read_file",

  description: `
Legge il contenuto di un file disponibile sotto /data.

Può leggere anche file molto grandi a blocchi.

Usa questo tool quando devi:
- leggere log
- leggere configurazioni
- analizzare codice sorgente
- leggere stack trace
- leggere thread dump
- analizzare file di testo
- analizzare grandi file di log senza caricarli interamente

Per file grandi usa offset e limit per leggere solamente la parte necessaria.

Parametri:
- offset: numero della riga da cui iniziare la lettura. La prima riga è 1.
- limit: numero massimo di righe da leggere.

Se offset e limit non vengono specificati, viene letto l'intero file
solo se il file è sufficientemente piccolo.
`,

  parameters: z.object({
    path: z
      .string()
      .describe("Percorso relativo a /data"),

    offset: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Numero della prima riga da leggere. La prima riga è 1."),

    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(1000)
      .describe("Numero massimo di righe da leggere."),
  }),

  async execute({
    path: relativePath,
    offset,
    limit,
  }) {
    const target = safePath(relativePath);

    const stat = await fs.stat(target);

    if (!stat.isFile()) {
      throw new Error("Il percorso specificato non è un file");
    }

    const MAX_DIRECT_READ = 5 * 1024 * 1024;

    let content: string;

    if (stat.size <= MAX_DIRECT_READ) {
      content = await fs.readFile(target, "utf8");
    } else {
      /*
       * Per file grandi leggiamo comunque il file in streaming,
       * evitando di caricarlo interamente nella memoria.
       */

      const chunks: string[] = [];

      const stream = (await import("fs")).createReadStream(target, {
        encoding: "utf8",
      });

      let currentLine = 1;
      let collectedLines = 0;
      let buffer = "";

      for await (const chunk of stream) {
        buffer += chunk;

        const lines = buffer.split(/\r?\n/);

        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (currentLine >= offset && collectedLines < limit) {
            chunks.push(line);
            collectedLines++;
          }

          currentLine++;

          if (collectedLines >= limit) {
            stream.destroy();
            break;
          }
        }

        if (collectedLines >= limit) {
          break;
        }
      }

      if (
        collectedLines < limit &&
        buffer.length > 0 &&
        currentLine >= offset
      ) {
        chunks.push(buffer);
      }

      content = chunks.join("\n");
    }

    const lines = content.split(/\r?\n/);

    /*
     * Per file piccoli applichiamo offset/limit dopo la lettura.
     * Per file grandi il contenuto è già stato limitato durante lo stream.
     */

    const selectedLines =
      stat.size <= MAX_DIRECT_READ
        ? lines.slice(offset - 1, offset - 1 + limit)
        : lines;

    const actualStartLine = offset;

    return JSON.stringify({
      path: relativePath,
      size: stat.size,
      offset: actualStartLine,
      limit,
      linesRead: selectedLines.length,
      content: selectedLines.join("\n"),
      truncated:
        actualStartLine + selectedLines.length - 1 <
        lines.length + actualStartLine - 1,
    });
  },
});


export const searchFilesTool = tool({
  name: "search_files",

  description: `
Cerca una stringa nei file disponibili sotto /data.

Usa questo tool quando l'utente vuole:
- trovare errori nei log
- cercare eccezioni
- trovare una configurazione
- cercare una parola o una stringa in più file
- individuare rapidamente informazioni senza leggere tutti i file

La ricerca è ricorsiva nelle sottodirectory.

Restituisci:
- file
- numero di riga
- contenuto della riga trovata

Limita i risultati per evitare di restituire quantità eccessive di testo.
`,

  parameters: z.object({
    query: z
      .string()
      .min(1)
      .describe("Testo da cercare"),

    path: z
      .string()
      .default(".")
      .describe("Directory relativa a /data in cui cercare"),
  }),

  async execute({ query, path: relativePath }) {
    const root = safePath(relativePath);

    const results: {
      file: string;
      line: number;
      content: string;
    }[] = [];

    async function walk(currentPath: string) {
      if (results.length >= 100) {
        return;
      }

      const entries = await fs.readdir(currentPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (results.length >= 100) {
          return;
        }

        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        try {
          const stat = await fs.stat(fullPath);

          if (stat.size > 5 * 1024 * 1024) {
            continue;
          }

          const content = await fs.readFile(fullPath, "utf8");
          const lines = content.split(/\r?\n/);

          lines.forEach((line, index) => {
            if (
              results.length < 100 &&
              line.toLowerCase().includes(query.toLowerCase())
            ) {
              results.push({
                file: path.relative(BASE_DIR, fullPath),
                line: index + 1,
                content: line.trim(),
              });
            }
          });
        } catch {
          // Ignora file non leggibili o non testuali
        }
      }
    }

    await walk(root);

    return JSON.stringify({
      query,
      path: relativePath,
      results,
      truncated: results.length >= 100,
    });
  },
});
