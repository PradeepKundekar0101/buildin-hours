/**
 * `pnpm twilio:check` - everything that silently breaks a live call, checked before
 * anyone is on stage.
 *
 * The failure modes this catches are all invisible until you dial: a trial account
 * that plays its own announcement over your opener, geo permissions that block
 * India by default, a tunnel URL that is still the placeholder, a number without
 * voice capability.
 */
import twilio from "twilio";
import { env } from "./env.js";

const ok = (s: string) => `  ok    ${s}`;
const warn = (s: string) => `  warn  ${s}`;
const bad = (s: string) => `  FAIL  ${s}`;

let failures = 0;
let warnings = 0;
const say = (line: string) => {
  if (line.includes("FAIL")) failures++;
  if (line.includes("warn")) warnings++;
  console.log(line);
};

async function main(): Promise<void> {
  console.log("\nTwilio preflight\n");

  if (!env.twilioSid || !env.twilioToken) {
    say(bad("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are empty."));
    console.log("        Console home page -> Account Info panel. The SID starts with AC.\n");
    process.exit(1);
  }

  const client = twilio(env.twilioSid, env.twilioToken);

  // ---- account ----
  let isTrial = false;
  try {
    const account = await client.api.v2010.accounts(env.twilioSid).fetch();
    isTrial = account.type === "Trial";
    say(ok(`account "${account.friendlyName}" · ${account.type} · ${account.status}`));
    if (isTrial) {
      say(warn("TRIAL ACCOUNT. Two hard blockers for a live demo:"));
      console.log("          1. You can only call numbers you have verified in the console.");
      console.log("          2. Twilio plays its own trial announcement to the person who");
      console.log("             answers, before your opener. It will talk over the greeting");
      console.log("             and the counterparty will hang up.");
      console.log("          Upgrade, or run the demo on verified teammate numbers.");
    }
  } catch (err) {
    say(bad(`credentials rejected: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }

  // ---- the from number ----
  if (!env.twilioFrom) {
    say(bad("TWILIO_FROM_NUMBER is empty. Use E.164, e.g. +15188643842"));
  } else {
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: env.twilioFrom, limit: 1 });
    const number = numbers[0];
    if (!number) {
      say(bad(`${env.twilioFrom} is not on this account. Check for spaces or a missing +.`));
    } else {
      say(ok(`from number ${number.phoneNumber} (${number.friendlyName})`));
      if (!number.capabilities.voice) say(bad("this number cannot make voice calls"));
      if (env.twilioFrom.startsWith("+1")) {
        say(warn("a +1 caller ID calling Indian shops is a pickup-rate problem, not a"));
        console.log("          technical one. Expect many unanswered calls. Nothing in the code");
        console.log("          can fix that - it is what the shopkeeper sees on their screen.");
      }
    }
  }

  // ---- geo permissions: the silent killer ----
  try {
    const india = await client.voice.v1.dialingPermissions.countries("IN").fetch();
    if (india.lowRiskNumbersEnabled) {
      say(ok("voice geo permissions allow India"));
    } else {
      say(bad("voice calling to India is DISABLED on this account."));
      console.log("        Console -> Voice -> Settings -> Geo Permissions -> tick India.");
      console.log("        Calls fail with error 21215 until you do.");
    }
  } catch {
    say(warn("could not read geo permissions (needs a full account); check India manually"));
  }

  // ---- the tunnel ----
  const url = env.publicBaseUrl;
  if (!url) {
    say(bad("PUBLIC_BASE_URL is empty. Twilio cannot open a media stream back to you."));
  } else if (url.includes("your-tunnel")) {
    say(bad(`PUBLIC_BASE_URL is still the placeholder (${url}). Run: ngrok http ${env.port}`));
  } else if (!url.startsWith("https://")) {
    say(bad(`PUBLIC_BASE_URL must be https, got ${url}`));
  } else {
    // Twilio is an anonymous client. A tunnel that is fine in your browser - because
    // your browser carries a session cookie - can still be a locked door to Twilio.
    let httpOk = false;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      const body = await res.text();

      if (res.status === 401 || res.status === 403) {
        say(bad(`${url} requires authentication (HTTP ${res.status}).`));
        console.log(tunnelHint(url));
      } else if (!res.ok) {
        say(bad(`${url}/health returned ${res.status} - is the orchestrator running?`));
      } else if (body.trimStart().startsWith("<")) {
        say(bad(`${url}/health returned HTML, not JSON - the tunnel is serving a login page.`));
        console.log(tunnelHint(url));
      } else {
        say(ok(`${url}/health reachable anonymously`));
        httpOk = true;
      }
    } catch (err) {
      say(bad(`${url}/health unreachable: ${err instanceof Error ? err.message : err}`));
      console.log("        Start the orchestrator first, then the tunnel, then re-run this.");
    }

    // The media stream is a websocket, and a tunnel can pass HTTP while refusing the
    // upgrade. Twilio reports that as error 31920 with no further explanation, so we
    // check it here where the message can actually be useful.
    if (httpOk) {
      const wsUrl = `${url.replace(/^https/, "wss")}/media/preflight`;
      const handshake = await probeWebSocket(wsUrl);
      if (handshake.ok) {
        say(ok(`websocket upgrade accepted on ${wsUrl.replace("/preflight", "/:callId")}`));
      } else {
        say(bad(`websocket upgrade REJECTED: ${handshake.error}`));
        console.log("        This is exactly what Twilio reports as error 31920 (Stream -");
        console.log("        WebSocket - Handshake Error). The call connects, the stream never");
        console.log("        opens, and the call ends after about a second.");
        console.log(tunnelHint(url));
      }
    }
  }

  console.log(
    `\n${failures ? `${failures} blocker(s)` : "no blockers"}` +
      `${warnings ? `, ${warnings} warning(s)` : ""}. ` +
      `${failures ? "Fix the FAIL lines before dialling anyone.\n" : "Outbound calls should connect.\n"}`
  );
  process.exit(failures ? 1 : 0);
}

/** Tunnel-specific remediation, because the generic advice is useless here. */
function tunnelHint(url: string): string {
  if (url.includes("devtunnels.ms")) {
    return [
      "        VS Code dev tunnels are PRIVATE by default. Twilio is an anonymous",
      "        client and cannot log in.",
      "          VS Code: Ports panel -> right-click the port -> Port Visibility -> Public",
      "          CLI:     devtunnel host -p 8080 --allow-anonymous",
      "        Or use ngrok, which is public by default: ngrok http 8080",
    ].join("\n");
  }
  if (url.includes("ngrok")) {
    return [
      "        An ngrok tunnel with basic auth or an interstitial will do this.",
      "        Start it plainly: ngrok http 8080",
    ].join("\n");
  }
  return "        Whatever is fronting this URL must allow anonymous POST and websocket upgrades.";
}

/** Resolve as soon as the upgrade succeeds; the server closing after is expected. */
function probeWebSocket(url: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      resolve(r);
    };

    const socket = new WebSocket(url);
    socket.addEventListener("open", () => done({ ok: true }));
    socket.addEventListener("error", () =>
      done({ ok: false, error: "handshake failed (auth, proxy, or wrong scheme)" })
    );
    socket.addEventListener("close", (e) => {
      // A close before open means the upgrade itself never completed.
      done(settled ? { ok: true } : { ok: false, error: `closed during handshake (code ${e.code})` });
    });
    setTimeout(() => done({ ok: false, error: "timed out after 10s" }), 10_000);
  });
}

void main().catch((err) => {
  console.error(`preflight crashed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
