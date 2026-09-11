import { tool } from "@openai/agents";
import { z } from "zod";
import { NodeSSH, Config } from "node-ssh";

type SshSession = {
  ssh: NodeSSH;
  host: string;
  port: number;
  username: string;
  password: string;
  key: string;
  execLock: Promise<void>;
};

const sessions = new Map<string, SshSession>();

function sessionKey(
  host: string,
  port: number,
  username: string
): string {
  return `${username}@${host}:${port}`;
}

/**
 * Serializza i comandi sulla stessa sessione.
 *
 * In questo modo due exec contemporanei sulla stessa
 * connessione non possono interferire tra loro.
 */
async function executeLocked<T>(
  session: SshSession,
  fn: () => Promise<T>
): Promise<T> {
  let releaseLock!: () => void;

  const previousLock = session.execLock;

  session.execLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

/**
 * Apre una nuova sessione oppure riutilizza quella già presente.
 */
async function connectSsh(
  host: string,
  port: number,
  username: string,
  password: string
): Promise<{
  sessionId: string;
  reused: boolean;
}> {
  const key = sessionKey(
    host,
    port,
    username
  );

  const existing = sessions.get(key);

  if (existing) {
    if (existing.ssh.isConnected()) {
      console.log(
        `[SSH] Reusing existing session ${key}`
      );

      return {
        sessionId: key,
        reused: true,
      };
    }

    console.log(
      `[SSH] Existing session ${key} is no longer connected, removing it`
    );

    sessions.delete(key);

    try {
      existing.ssh.dispose();
    } catch {
      // Ignora eventuali errori durante il dispose
    }
  }

  console.log(
    `[SSH] Connecting to ${username}@${host}:${port}`
  );

  const ssh = new NodeSSH();

  const config: Config = {
    host,
    port,
    username,
    password,

    readyTimeout: 15000,

    keepaliveInterval: 10000,
    keepaliveCountMax: 3,

    /*
     * Manteniamo il comportamento attuale.
     *
     * In produzione sarebbe meglio usare known_hosts.
     */
    hostVerifier: () => true,
  };

  try {
    await ssh.connect(config);

    console.log(
      `[SSH] Connection ready ${username}@${host}:${port}`
    );
  } catch (error) {
    console.error(
      `[SSH] Connection error ${username}@${host}:${port}:`,
      error
    );

    try {
      ssh.dispose();
    } catch {
      // Ignora eventuali errori durante il dispose
    }

    throw error;
  }

  const session: SshSession = {
    ssh,
    host,
    port,
    username,
    password,
    key,
    execLock: Promise.resolve(),
  };

  sessions.set(key, session);

  console.log(
    `[SSH] Persistent session opened ${key}`
  );

  return {
    sessionId: key,
    reused: false,
  };
}

/**
 * Esegue un comando sulla sessione SSH.
 *
 * node-ssh gestisce direttamente:
 *
 * - stdout
 * - stderr
 * - exit code
 *
 * Non utilizziamo marker o parsing della shell.
 */
async function executeCommand(
  session: SshSession,
  command: string,
  timeoutMs: number
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return executeLocked(
    session,
    async () => {
      console.log(
        `[SSH] EXEC ${session.username}@${session.host}: ${command}`
      );

      let remoteCommand = command;
      let stdin: string | undefined;

      /*
       * Gestione sudo.
       *
       * Se il comando inizia con sudo:
       *
       *   sudo id
       *
       * diventa:
       *
       *   sudo -S -p '' id
       *
       * La password viene inviata tramite stdin.
       */
      if (/^\s*sudo(?:\s|$)/i.test(command)) {
        remoteCommand = command.replace(
          /^\s*sudo\b/i,
          "sudo -S -p ''"
        );

        stdin = `${session.password}\n`;

        console.log(
          `[SSH] sudo detected, password will be sent through stdin`
        );
      }

      let timeoutHandle:
        | NodeJS.Timeout
        | undefined;

      const resultPromise =
        session.ssh.execCommand(
          remoteCommand,
          {
            stdin,

            onStdout(chunk) {
              console.log(
                `[SSH] STDOUT ${session.username}@${session.host}: ${chunk.toString()}`
              );
            },

            onStderr(chunk) {
              console.log(
                `[SSH] STDERR ${session.username}@${session.host}: ${chunk.toString()}`
              );
            },
          }
        );

      const timeoutPromise =
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Timeout durante l'esecuzione del comando (${timeoutMs} ms)`
              )
            );
          }, timeoutMs);
        });

      try {
        const result = await Promise.race([
          resultPromise,
          timeoutPromise,
        ]);

        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",

          exitCode:
            typeof result.code === "number"
              ? result.code
              : null,
        };
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }
  );
}

export const sshTool = tool({
  name: "ssh",

  description: `
Gestisce sessioni SSH persistenti e generiche verso macchine remote.

Il tool può:

- aprire una connessione SSH
- riutilizzare una sessione SSH esistente
- eseguire qualsiasi comando Linux
- mantenere la connessione tra comandi successivi
- gestire sudo
- restituire stdout reale
- restituire stderr reale
- restituire l'exit code reale
- chiudere una sessione SSH esistente

========================
REGOLE DELLA SESSIONE
========================

1. Ogni sessione è identificata internamente da:

   username@host:port

2. Se esiste già una sessione attiva verso lo stesso
   username@host:port, NON aprire una nuova connessione.

3. Il tool restituisce il session_id reale generato
   internamente.

4. Il modello NON deve inventare session_id.

5. Dopo connect, i successivi exec devono riutilizzare
   la sessione esistente.

6. NON sostituire mai l'host fornito dall'utente con
   localhost, 127.0.0.1 o un altro host.

7. NON aprire una nuova connessione se esiste già
   una sessione utilizzabile.

8. Gli exec sulla stessa sessione vengono serializzati.

========================
REGOLE EXEC
========================

9. Ogni comando deve essere realmente eseguito
   sulla macchina remota.

10. stdout deve contenere esclusivamente l'output
    stdout ricevuto dalla macchina remota.

11. stderr deve contenere esclusivamente l'output
    stderr ricevuto dalla macchina remota.

12. exitCode deve essere l'exit code reale del comando.

13. exitCode=0 significa comando terminato correttamente.

14. exitCode diverso da 0 significa comando terminato
    con errore.

15. exitCode=null significa che il risultato non contiene
    un exit code verificabile.

16. NON inventare mai stdout, stderr, exit code,
    hostname, processi, pacchetti o altri risultati.

========================
REGOLE SUDO
========================

17. Se il comando inizia con sudo, il tool gestisce
    automaticamente la password utilizzando stdin.

18. La password NON deve mai essere restituita
    intenzionalmente nel risultato del tool.

19. Non inserire mai la password nella command line
    del comando remoto.

========================
REGOLE CLOSE
========================

20. Quando l'utente chiede di chiudere una sessione SSH,
    NON aprire una nuova connessione.

21. Se viene fornito session_id, utilizzalo.

22. Se session_id non è disponibile ma sono disponibili
    host e username, individua automaticamente la sessione
    tramite username@host:port.

23. NON chiedere all'utente il session_id se il tool
    può ricavarlo da host + username + porta.

24. NON chiamare connect prima di close.

25. NON chiudere automaticamente una sessione dopo un exec.

26. La sessione deve rimanere disponibile per i comandi
    successivi fino a quando l'utente chiede di chiuderla
    oppure la connessione non è più disponibile.

========================
REGOLE RISULTATO
========================

27. Se un comando è stato eseguito realmente, usa
    esclusivamente il risultato del tool come fonte
    del risultato operativo.

28. Se il tool non restituisce il risultato del comando,
    NON dichiarare che il comando è riuscito.

29. Se il modello riceve un errore dopo che il tool
    ha già eseguito un comando, non inventare il risultato.

30. Non utilizzare risultati precedenti della conversazione
    come sostituto dell'esecuzione reale del comando.
`,

  parameters: z.object({
    action: z
      .enum(["connect", "exec", "close"])
      .describe("Operazione SSH"),

    host: z
      .string()
      .optional()
      .describe(
        "Hostname o indirizzo IP remoto"
      ),

    port: z
      .number()
      .int()
      .positive()
      .optional()
      .default(22)
      .describe(
        "Porta SSH"
      ),

    username: z
      .string()
      .optional()
      .describe(
        "Utente SSH"
      ),

    password: z
      .string()
      .optional()
      .describe(
        "Password SSH"
      ),

    session_id: z
      .string()
      .optional()
      .describe(
        "ID sessione restituito dal tool. Non inventarlo."
      ),

    command: z
      .string()
      .optional()
      .describe(
        "Comando Linux da eseguire"
      ),

    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .default(120000)
      .describe(
        "Timeout del comando in millisecondi"
      ),
  }),

  async execute({
    action,
    host,
    port,
    username,
    password,
    session_id,
    command,
    timeout_ms,
  }) {

    /*
     * =====================================================
     * CONNECT
     * =====================================================
     */

    if (action === "connect") {
      if (!host || !username || !password) {
        throw new Error(
          "Per connect sono necessari host, username e password."
        );
      }

      const sshPort = port ?? 22;

      const result = await connectSsh(
        host,
        sshPort,
        username,
        password
      );

      return JSON.stringify({
        success: true,

        session_id:
          result.sessionId,

        host,

        port:
          sshPort,

        username,

        reused:
          result.reused,

        message:
          result.reused
            ? "Sessione SSH già attiva: connessione riutilizzata."
            : "Nuova sessione SSH aperta e mantenuta.",
      });
    }

    /*
     * =====================================================
     * CLOSE
     * =====================================================
     */

    if (action === "close") {
      let sessionKeyToClose =
        session_id;

      /*
       * Se il modello non passa il session_id,
       * ricaviamo automaticamente la chiave.
       */
      if (
        !sessionKeyToClose &&
        host &&
        username
      ) {
        sessionKeyToClose =
          sessionKey(
            host,
            port ?? 22,
            username
          );
      }

      if (!sessionKeyToClose) {
        throw new Error(
          "Per close sono necessari session_id oppure host e username."
        );
      }

      const session =
        sessions.get(
          sessionKeyToClose
        );

      if (!session) {
        return JSON.stringify({
          success: false,

          session_id:
            sessionKeyToClose,

          host:
            host ?? null,

          port:
            port ?? 22,

          username:
            username ?? null,

          error:
            "Sessione SSH non trovata o già chiusa.",
        });
      }

      console.log(
        `[SSH] Closing session ${session.key}`
      );

      try {
        session.ssh.dispose();
      } catch (error) {
        console.error(
          `[SSH] Error disposing session ${session.key}:`,
          error
        );
      }

      sessions.delete(
        session.key
      );

      return JSON.stringify({
        success: true,

        session_id:
          session.key,

        host:
          session.host,

        port:
          session.port,

        username:
          session.username,

        message:
          "Sessione SSH chiusa.",
      });
    }

    /*
     * =====================================================
     * EXEC
     * =====================================================
     */

    if (action === "exec") {
      if (!command) {
        throw new Error(
          "command obbligatorio."
        );
      }

      let session:
        | SshSession
        | undefined;

      /*
       * Prima scelta:
       * session_id esplicito.
       */
      if (session_id) {
        session =
          sessions.get(
            session_id
          );
      }

      /*
       * Seconda scelta:
       * username + host + porta.
       */
      if (
        !session &&
        host &&
        username
      ) {
        session =
          sessions.get(
            sessionKey(
              host,
              port ?? 22,
              username
            )
          );
      }

      if (!session) {
        throw new Error(
          "Nessuna sessione SSH attiva disponibile. " +
          "Apri prima una sessione con connect."
        );
      }

      /*
       * Verifica che la connessione sia ancora attiva.
       */
      if (
        !session.ssh.isConnected()
      ) {
        console.log(
          `[SSH] Session ${session.key} is no longer connected`
        );

        sessions.delete(
          session.key
        );

        try {
          session.ssh.dispose();
        } catch {
          // Ignora errori durante dispose
        }

        return JSON.stringify({
          success: false,

          session_id:
            session.key,

          host:
            session.host,

          port:
            session.port,

          username:
            session.username,

          command,

          exitCode:
            null,

          stdout:
            "",

          stderr:
            "",

          error:
            "La sessione SSH non è più connessa.",
        });
      }

      try {
        const result =
          await executeCommand(
            session,
            command,
            timeout_ms ?? 120000
          );

        const success =
          result.exitCode === 0;

        console.log(
          `[SSH] EXIT ${session.username}@${session.host}: ${result.exitCode}`
        );

        console.log(
          `[SSH] STDOUT: ${JSON.stringify(result.stdout)}`
        );

        console.log(
          `[SSH] STDERR: ${JSON.stringify(result.stderr)}`
        );

        return JSON.stringify({
          success,

          session_id:
            session.key,

          host:
            session.host,

          port:
            session.port,

          username:
            session.username,

          command,

          exitCode:
            result.exitCode,

          stdout:
            result.stdout,

          stderr:
            result.stderr,
        });
      } catch (error) {
        console.error(
          `[SSH] EXEC ERROR ${session.username}@${session.host}:`,
          error
        );

        return JSON.stringify({
          success: false,

          session_id:
            session.key,

          host:
            session.host,

          port:
            session.port,

          username:
            session.username,

          command,

          exitCode:
            null,

          stdout:
            "",

          stderr:
            "",

          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }

    throw new Error(
      "Azione SSH non supportata."
    );
  },
});
