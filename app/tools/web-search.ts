import { tool } from "@openai/agents";
import { z } from "zod";
import * as cheerio from "cheerio";

export const webSearchTool = tool({
  name: "web_search",

  description: `
Cerca informazioni aggiornate su Internet.

Usa questo tool quando l'utente:
- chiede di cercare qualcosa online
- chiede informazioni aggiornate
- vuole documentazione recente
- vuole verificare un'informazione
- vuole trovare manuali, guide, articoli o documentazione tecnica

Restituisci i risultati della ricerca con titolo, URL e descrizione.
`,

  parameters: z.object({
    query: z.string().describe("La ricerca da effettuare su Internet"),
  }),

  async execute({ query }) {
    const url =
      "https://html.duckduckgo.com/html/?q=" +
      encodeURIComponent(query);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Ricerca web fallita: HTTP ${response.status}`
      );
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const results: {
      title: string;
      url: string;
      snippet: string;
    }[] = [];

    $(".result").each((_, element) => {
      const title = $(element)
        .find(".result__a")
        .first()
        .text()
        .trim();

      const resultUrl = $(element)
        .find(".result__a")
        .first()
        .attr("href");

      const snippet = $(element)
        .find(".result__snippet")
        .first()
        .text()
        .trim();

      if (title && resultUrl) {
        results.push({
          title,
          url: resultUrl,
          snippet,
        });
      }
    });

    return JSON.stringify({
      query,
      results: results.slice(0, 8),
    });
  },
});
