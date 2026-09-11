import { tool } from "@openai/agents";
import { z } from "zod";
import * as cheerio from "cheerio";

export const fetchUrlTool = tool({
  name: "fetch_url",

  description: `
Apre un URL fornito dall'utente e ne legge il contenuto.

Usa questo tool quando:
- l'utente fornisce direttamente un URL
- l'utente chiede di aprire o controllare una pagina
- devi leggere una pagina trovata tramite una ricerca
- devi analizzare il contenuto di un'applicazione web
- devi verificare una pagina web o un servizio HTTP

Può accedere a URL pubblici, locali, privati e interni.
Non assumere che un URL sia irraggiungibile solo perché usa un hostname
locale, un dominio .lan o un indirizzo IP privato.

Se l'utente fornisce un URL esplicito, prova ad aprirlo.
`,

  parameters: z.object({
    url: z.string().url().describe("URL della pagina da aprire"),
  }),

  async execute({ url }) {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(
        `Download pagina fallito: HTTP ${response.status}`
      );
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      const text = await response.text();

      return JSON.stringify({
        url,
        contentType,
        text: text.slice(0, 30000),
      });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    $("script, style, noscript, iframe, svg").remove();

    const title = $("title").first().text().trim();

    const text = $("body")
      .text()
      .replace(/\s+/g, " ")
      .trim();

    return JSON.stringify({
      url,
      title,
      text: text.slice(0, 30000),
    });
  },
});
