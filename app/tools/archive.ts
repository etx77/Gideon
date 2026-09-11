import { tool } from "@openai/agents";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import AdmZip from "adm-zip";

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

export const listArchiveTool = tool({
  name: "list_archive",

  description: `
Mostra il contenuto di un archivio ZIP presente sotto /data.

Usa questo tool quando:
- l'utente vuole sapere cosa contiene un archivio
- devi capire quali file diagnostici sono presenti
- devi decidere quali file estrarre e analizzare

Non modifica l'archivio originale.
`,

  parameters: z.object({
    path: z
      .string()
      .describe("Percorso relativo a /data dell'archivio ZIP"),
  }),

  async execute({ path: relativePath }) {
    const archivePath = safePath(relativePath);

    const stat = await fs.stat(archivePath);

    if (!stat.isFile()) {
      throw new Error("Il percorso specificato non è un file");
    }

    const zip = new AdmZip(archivePath);

    const entries = zip.getEntries().map((entry) => ({
      name: entry.entryName,
      directory: entry.isDirectory,
      size: entry.header.size,
    }));

    return JSON.stringify({
      archive: relativePath,
      entries,
    });
  },
});

export const extractArchiveTool = tool({
  name: "extract_archive",

  description: `
Estrae un archivio ZIP sotto /data.

Usa questo tool quando:
- devi analizzare i file contenuti in un archivio
- devi estrarre log, thread dump o configurazioni
- list_archive ha mostrato che l'archivio contiene file utili

L'archivio originale non viene modificato.
I file vengono estratti in una directory dedicata sotto /data.
`,

  parameters: z.object({
    path: z
      .string()
      .describe("Percorso relativo a /data dell'archivio ZIP"),
  }),

  async execute({ path: relativePath }) {
    const archivePath = safePath(relativePath);

    const stat = await fs.stat(archivePath);

    if (!stat.isFile()) {
      throw new Error("Il percorso specificato non è un file");
    }

    const zip = new AdmZip(archivePath);

    const archiveName = path.basename(
      relativePath,
      path.extname(relativePath)
    );

    const outputRelativePath = path.join(
      "extracted",
      archiveName
    );

    const outputPath = safePath(outputRelativePath);

    await fs.mkdir(outputPath, {
      recursive: true,
    });

    zip.extractAllTo(outputPath, true);

    return JSON.stringify({
      archive: relativePath,
      extractedTo: outputRelativePath,
      entries: zip.getEntries().length,
    });
  },
});
