// Server-side example: generate a video with Seedance 2.5 through the Higgsfield API.
// Credentials come from HF_CREDENTIALS in .env.local, as KEY_ID:KEY_SECRET.
//
//   npm run higgsfield:check                      check credentials, connection and model (spends no credits)
//   npm run higgsfield:example                    submit one generation and wait for the video
//   npm run higgsfield:example -- --resume <id>   wait for a request that was already submitted
import { randomUUID } from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import { config as loadEnv } from "dotenv";
import {
  config,
  higgsfield,
  AuthenticationError,
  BadInputError,
  CredentialsMissedError,
  NotEnoughCreditsError,
  ValidationError,
} from "@higgsfield/client/v2";

loadEnv({ path: ".env.local", quiet: true });

const API_BASE = "https://api.higgsfield.ai";
const MODEL = "bytedance/seedance-2.5/text-to-video";
// Values the API accepts for this model: duration 4 to 30 (whole seconds), resolution 480p, 720p
// or 1080p, aspect_ratio 16:9, 4:3, 1:1, 3:4, 9:16 or 21:9.
const INPUT = {
  prompt: "A cinematic scene at sunset",
  duration: 5,
  resolution: "720p",
  aspect_ratio: "16:9",
};

const POLL_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
// Video generation can take several minutes.
const MAX_WAIT_MS = 15 * 60 * 1000;
// The API also reports "canceled", which the SDK's own polling does not treat as final.
const FINAL_STATUSES = new Set(["completed", "failed", "nsfw", "canceled"]);

interface RequestStatus {
  status: string;
  request_id: string;
  video?: { url: string };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    return error.code ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

// Dropped connections, timeouts, rate limits and server errors are worth another try.
function isTransient(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status === 429 || status >= 500;
}

async function check(api: AxiosInstance): Promise<boolean> {
  // An unknown request id answers 404 when the credentials are valid and 401 when they are not.
  const auth = await api.get(`/requests/${randomUUID()}/status`, { validateStatus: () => true });
  if (auth.status === 401) {
    console.error("✗ Higgsfield rejected the credentials. Check HF_CREDENTIALS in .env.local.");
    return false;
  }
  if (auth.status !== 404) {
    console.error(`✗ Unexpected answer from ${API_BASE}: HTTP ${auth.status} ${JSON.stringify(auth.data)}`);
    return false;
  }
  console.log(`✓ Connected to ${API_BASE} and credentials accepted`);

  // An empty body is rejected before anything is generated: 400 means the model exists, 404 means it does not.
  const model = await api.post(`/${MODEL}`, {}, { validateStatus: () => true });
  if (model.status === 404) {
    console.error(`✗ Model ${MODEL} was not found.`);
    return false;
  }
  if (model.status !== 400) {
    console.error(`✗ Unexpected answer for ${MODEL}: HTTP ${model.status} ${JSON.stringify(model.data)}`);
    return false;
  }
  console.log(`✓ Model ${MODEL} is available`);
  return true;
}

async function submit(credentials: string): Promise<string | undefined> {
  // maxRetries 0: the SDK would otherwise resend the request after a dropped connection,
  // which can start a second generation and charge for it twice.
  config({ credentials, maxRetries: 0 });
  try {
    const { request_id } = await higgsfield.subscribe(MODEL, { input: INPUT, withPolling: false });
    console.log(`Submitted request ${request_id}.`);
    console.log(`If this script stops early, resume with: npm run higgsfield:example -- --resume ${request_id}`);
    return request_id;
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof CredentialsMissedError) {
      console.error("Higgsfield rejected the credentials. Check HF_CREDENTIALS in .env.local.");
    } else if (error instanceof NotEnoughCreditsError) {
      console.error("Not enough Higgsfield credits for this generation.");
    } else if (error instanceof BadInputError || error instanceof ValidationError) {
      console.error(`Higgsfield rejected the input: ${error.message}`);
    } else if (axios.isAxiosError(error) && !error.response) {
      console.error(`The connection dropped while submitting (${describe(error)}).`);
      console.error("Higgsfield may or may not have accepted the request, so it was not resent.");
      console.error("Check the Higgsfield console before running this again.");
    } else {
      console.error("Submitting to Higgsfield failed:", describe(error));
    }
    return undefined;
  }
}

async function waitFor(api: AxiosInstance, requestId: string): Promise<RequestStatus | undefined> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastStatus = "";
  let failures = 0;

  while (Date.now() < deadline) {
    try {
      const { data } = await api.get<RequestStatus>(`/requests/${requestId}/status`);
      failures = 0;
      if (data.status !== lastStatus) {
        console.log(`Status: ${data.status}`);
        lastStatus = data.status;
      }
      if (FINAL_STATUSES.has(data.status)) return data;
    } catch (error) {
      if (!isTransient(error)) throw error;
      failures++;
      console.warn(`Status check failed (${describe(error)}), trying again.`);
    }
    await sleep(Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS));
  }
  return undefined;
}

async function main(): Promise<number> {
  const credentials = process.env.HF_CREDENTIALS?.trim();
  if (!credentials || credentials.split(":").length !== 2) {
    console.error("HF_CREDENTIALS is missing or malformed. Add it to .env.local as KEY_ID:KEY_SECRET.");
    return 1;
  }

  const api = axios.create({
    baseURL: API_BASE,
    timeout: 30_000,
    headers: { Authorization: `Key ${credentials}` },
  });
  const [command, argument] = process.argv.slice(2);

  let requestId: string | undefined;
  try {
    if (command === "--check") return (await check(api)) ? 0 : 1;

    if (command === "--resume") {
      if (!argument) {
        console.error("Usage: npm run higgsfield:example -- --resume <request_id>");
        return 1;
      }
      requestId = argument;
    } else {
      if (!(await check(api))) return 1;
      requestId = await submit(credentials);
      if (!requestId) return 1;
    }

    const result = await waitFor(api, requestId);
    if (!result) {
      console.error(`Stopped waiting after ${MAX_WAIT_MS / 60_000} minutes; the generation may still finish.`);
      console.error(`Resume with: npm run higgsfield:example -- --resume ${requestId}`);
      return 1;
    }

    const videoUrl = result.video?.url;
    if (result.status === "completed" && videoUrl) {
      console.log(`Request ${requestId} completed.`);
      console.log(`Video URL: ${videoUrl}`);
      return 0;
    }

    const reasons: Record<string, string> = {
      failed: "generation failed (credits are refunded)",
      nsfw: "request was blocked by moderation",
      canceled: "request was canceled",
      completed: "request completed but returned no video URL",
    };
    console.error(`Request ${requestId}: ${reasons[result.status] ?? `ended with status "${result.status}"`}.`);
    return 1;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      console.error("Higgsfield rejected the credentials. Check HF_CREDENTIALS in .env.local.");
    } else if (axios.isAxiosError(error) && error.response?.status === 404 && requestId) {
      console.error(`Higgsfield has no request with id ${requestId}.`);
    } else {
      console.error("Higgsfield request failed:", describe(error));
      if (requestId) console.error(`Resume with: npm run higgsfield:example -- --resume ${requestId}`);
    }
    return 1;
  }
}

process.exitCode = await main();
