import { tool } from "@openai/agents";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";


const BASE_DIR = "/data";

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 500;
const MAX_CONTEXT_LINES = 20;
const MAX_READ_LINES = 5000;

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

function relativePath(fullPath: string): string {
  return path.relative(BASE_DIR, fullPath) || ".";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/*
 * --------------------------------------------------------------------------
 * list_files
 * --------------------------------------------------------------------------
 */

export const listFilesTool = tool({
  name: "list_files",

  description: `
Elenca file e directory disponibili nell'area /data.

Usa questo tool quando:
- l'utente chiede quali file sono disponibili
- devi esplorare una directory
- devi individuare file da analizzare

Puoi leggere solamente contenuti sotto /data.

Restituisce:
- nome
- tipo
- percorso relativo
- dimensione per i file
`,
  
  parameters: z.object({
    path: z
      .string()
      .default(".")
      .describe("Percorso relativo a /data"),
  }),

  async execute({ path: relative }) {
    const target = safePath(relative);

    const stat = await fs.stat(target);

    if (!stat.isDirectory()) {
      throw new Error("Il percorso specificato non è una directory");
    }

    const entries = await fs.readdir(target, {
      withFileTypes: true,
    });

    const results = [];

    for (const entry of entries) {
      const fullPath = path.join(target, entry.name);

      try {
        const entryStat = await fs.stat(fullPath);

        results.push({
          name: entry.name,
          path: relativePath(fullPath),
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? entryStat.size : undefined,
        });
      } catch {
        results.push({
          name: entry.name,
          path: relativePath(fullPath),
          type: entry.isDirectory() ? "directory" : "file",
        });
      }
    }

    results.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });

    return JSON.stringify({
      path: relative || ".",
      results,
    });
  },
});

/*
 * --------------------------------------------------------------------------
 * read_file
 * --------------------------------------------------------------------------
 */

export const readFileTool = tool({
  name: "read_file",

  description: `
Legge il contenuto di un file disponibile sotto /data.

Usa questo tool quando devi:
- leggere log
- leggere configurazioni
- analizzare codice sorgente
- leggere stack trace
- leggere thread dump
- analizzare file di testo
- analizzare file grandi a blocchi

Parametri:
- path: percorso relativo a /data
- offset: prima riga da leggere, numerazione da 1
- limit: numero massimo di righe

Per file grandi usa offset e limit.

Il tool NON carica inutilmente l'intero file quando viene richiesto
un intervallo specifico di righe.
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
      .describe("Numero della prima riga da leggere"),

    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_READ_LINES)
      .default(1000)
      .describe("Numero massimo di righe da leggere"),
  }),

  async execute({
    path: relative,
    offset,
    limit,
  }) {
    const target = safePath(relative);

    const stat = await fs.stat(target);

    if (!stat.isFile()) {
      throw new Error("Il percorso specificato non è un file");
    }

    const startLine = offset;
    const endLine = offset + limit - 1;

    const lines: string[] = [];

    const fileHandle = await fs.open(target, "r");

    try {
      const stream = fileHandle.readLines();

      let currentLine = 1;

      for await (const line of stream) {
        if (currentLine >= startLine && currentLine <= endLine) {
          lines.push(line);
        }

        if (currentLine > endLine) {
          break;
        }

        currentLine++;
      }

      const totalLinesKnown =
        currentLine <= endLine ? currentLine - 1 : undefined;

      return JSON.stringify({
        path: relative,
        size: stat.size,
        offset,
        limit,
        linesRead: lines.length,
        content: lines.join("\n"),
        truncated: lines.length === limit,
        totalLinesKnown,
      });
    } finally {
      await fileHandle.close();
    }
  },
});

/*
 * --------------------------------------------------------------------------
 * search_files
 * --------------------------------------------------------------------------
 *
 * La ricerca viene delegata a ripgrep.
 *
 * Questo evita:
 * - readFile() dell'intero file
 * - split() dell'intero contenuto
 * - lowercase() di ogni riga
 * - ricorsione manuale in JavaScript
 *
 * ripgrep gestisce direttamente:
 * - ricerca ricorsiva
 * - regex
 * - case sensitivity
 * - glob
 * - file binari
 * - contesto
 * - ricerca veloce su directory grandi
 */

export const searchFilesTool = tool({
  name: "search_files",

  description: `
Cerca testo o regex nei file disponibili sotto /data.

Usa questo tool quando devi:
- trovare errori nei log
- cercare eccezioni
- trovare configurazioni
- cercare una stringa in molti file
- trovare rapidamente informazioni
- analizzare grandi directory di log
- cercare stack trace
- cercare pattern tecnici con regex

La ricerca viene eseguita tramite ripgrep.

Parametri:
- query: testo o regex da cercare
- path: directory o file relativo a /data
- regex: interpreta query come espressione regolare
- case_sensitive: ricerca case-sensitive
- max_results: massimo numero di match
- context_before: righe precedenti al match
- context_after: righe successive al match
- file_pattern: filtro glob opzionale, ad esempio "*.log"

I risultati contengono:
- file
- numero di riga
- contenuto
- contesto quando richiesto

La ricerca rimane confinata a /data.
`,

  parameters: z.object({
    query: z
      .string()
      .min(1)
      .describe("Testo o regex da cercare"),

    path: z
      .string()
      .default(".")
      .describe("Directory o file relativo a /data"),

    regex: z
      .boolean()
      .default(false)
      .describe("Interpreta query come regex"),

    case_sensitive: z
      .boolean()
      .default(false)
      .describe("Ricerca case-sensitive"),

    max_results: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS)
      .default(DEFAULT_MAX_RESULTS)
      .describe("Numero massimo di risultati"),

    context_before: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONTEXT_LINES)
      .default(0)
      .describe("Numero di righe prima del match"),

    context_after: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONTEXT_LINES)
      .default(0)
      .describe("Numero di righe dopo il match"),

    file_pattern: z
      .string()
      .optional()
      .describe("Glob opzionale, ad esempio *.log"),
  }),

  async execute({
    query,
    path: relative,
    regex,
    case_sensitive,
    max_results,
    context_before,
    context_after,
    file_pattern,
  }) {
        console.log("[SEARCH_FILES] START", {
      query,
      path: relative,
      regex,
      case_sensitive,
      max_results,
      context_before,
      context_after,
      file_pattern,
    });
    const target = safePath(relative);

    const stat = await fs.stat(target);

    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error("Percorso non valido");
    }

    const args: string[] = [
      "--json",
      "--no-heading",
      "--line-number",
      "--max-count",
      String(max_results),
    ];

    /*
     * Non seguiamo symlink esterni.
     * In questo modo la ricerca resta confinata a /data.
     */
    args.push("--no-follow");

    /*
     * Ignora automaticamente file binari.
     */


    /*
     * Mostra file nascosti solo quando esplicitamente richiesto
     * in futuro. Per ora manteniamo il comportamento sicuro/default.
     */

    if (!case_sensitive) {
      args.push("--ignore-case");
    }

    if (regex) {
      args.push("--regexp", query);
    } else {
      args.push("--fixed-strings", "--regexp", query);
    }

    if (context_before > 0) {
      args.push("--before-context", String(context_before));
    }

    if (context_after > 0) {
      args.push("--after-context", String(context_after));
    }


    if (
      file_pattern &&
      file_pattern.trim() !== "" &&
      file_pattern.toLowerCase() !== "none"
    ) {
      args.push("--glob", file_pattern);
    }
    /*
     * Non interpretiamo automaticamente .gitignore:
     * /data non è necessariamente un repository Git.
     */

    args.push(target);

    const results: Array<{
      file: string;
      line: number;
      content: string;
      context?: string[];
    }> = [];

    let stderr = "";
    let stdoutBuffer = "";
    console.log("[SEARCH_FILES] RG START", {
      command: "rg",
      args,
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn("rg", args, {
        cwd: BASE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;

        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          if (results.length >= max_results) break;

          try {
            const event = JSON.parse(line);

            if (event.type === "match") {
              const data = event.data;

              const filePath = data.path?.text ?? "";
              const lineNumber = data.line_number ?? 0;

              const content =
                typeof data.lines?.text === "string"
                  ? data.lines.text.replace(/\r?\n$/, "")
                  : "";

              results.push({
                file: path.relative(BASE_DIR, filePath),
                line: lineNumber,
                content,
              });
            }
          } catch {
            // Ignora eventuali righe JSON non valide.
          }
        }
      });

      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", reject);

    child.on("close", (code) => {
      console.log("[SEARCH_FILES] RG EXIT", {
        exitCode: code,
        results: results.length,
        stderr: stderr.trim(),
      });

      resolve(code ?? 1);
    });
    });

    /*
     * rg:
     *
     * 0 = almeno un match
     * 1 = nessun match
     * 2 = errore
     */

    if (exitCode === 2) {
      throw new Error(
        `Errore ripgrep: ${stderr.trim() || "errore sconosciuto"}`
      );
    }

    /*
     * ripgrep può avere ancora un ultimo record senza newline.
     */
    if (
      stdoutBuffer.trim() &&
      results.length < max_results
    ) {
      try {
        const event = JSON.parse(stdoutBuffer);

        if (event.type === "match") {
          const data = event.data;

          results.push({
            file: path.relative(
              BASE_DIR,
              data.path?.text ?? ""
            ),
            line: data.line_number ?? 0,
            content:
              typeof data.lines?.text === "string"
                ? data.lines.text.replace(/\r?\n$/, "")
                : "",
          });
        }
      } catch {
        // Ignora record finale non valido.
      }
    }
    console.log("[SEARCH_FILES] END", {
      query,
      results: results.length,
      exitCode,
    });

    return JSON.stringify({
      query,
      path: relative,
      regex,
      caseSensitive: case_sensitive,
      results: results.slice(0, clamp(max_results, 1, MAX_RESULTS)),
      count: results.length,
      truncated: results.length >= max_results,
      exitCode,
      stderr: stderr.trim() || undefined,
    });
  },
});