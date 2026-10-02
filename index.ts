// Server-side example: generate a video with Seedance 2.5 through the Higgsfield API.
// Run with `npm run higgsfield:example`. Credentials come from HF_CREDENTIALS in .env.local.
import { config as loadEnv } from "dotenv";
import {
  config,
  higgsfield,
  AuthenticationError,
  CredentialsMissedError,
  NotEnoughCreditsError,
  TimeoutError,
} from "@higgsfield/client/v2";

loadEnv({ path: ".env.local", quiet: true });

const MODEL = "bytedance/seedance-2.5/text-to-video";

async function main(): Promise<number> {
  if (!process.env.HF_CREDENTIALS) {
    console.error("HF_CREDENTIALS is not set. Add it to .env.local as KEY_ID:KEY_SECRET.");
    return 1;
  }

  config({
    credentials: process.env.HF_CREDENTIALS,
    // Video generation can take several minutes; the SDK default is 5.
    maxPollTime: 15 * 60 * 1000,
  });

  try {
    const result = await higgsfield.subscribe(MODEL, {
      input: {
        prompt: "A cinematic scene at sunset",
        duration: 5,
        resolution: "720p",
        aspect_ratio: "16:9",
      },
      withPolling: true,
    });

    // The API can also report "canceled", which the SDK's status type does not list.
    const status: string = result.status;
    const videoUrl = result.video?.url;

    if (status === "completed" && videoUrl) {
      console.log(`Request ${result.request_id} completed.`);
      console.log(`Video URL: ${videoUrl}`);
      return 0;
    }

    const reasons: Record<string, string> = {
      failed: "generation failed (credits are refunded)",
      nsfw: "request was blocked by moderation",
      canceled: "request was canceled",
      completed: "request completed but returned no video URL",
    };
    console.error(`Request ${result.request_id}: ${reasons[status] ?? `ended with status "${status}"`}.`);
    return 1;
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof CredentialsMissedError) {
      console.error("Higgsfield rejected the credentials. Check HF_CREDENTIALS in .env.local.");
    } else if (error instanceof NotEnoughCreditsError) {
      console.error("Not enough Higgsfield credits for this generation.");
    } else if (error instanceof TimeoutError) {
      console.error("Gave up waiting for the generation to finish; it may still complete in the Higgsfield console.");
    } else {
      console.error("Higgsfield request failed:", error instanceof Error ? error.message : error);
    }
    return 1;
  }
}

process.exitCode = await main();
