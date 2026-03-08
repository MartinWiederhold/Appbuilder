import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getSecret } from "../security/secrets.mjs";

export async function getProviderClient(provider = "openai") {
  if (provider === "openai") {
    const apiKey = await getSecret("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY in secure store / env");
    }

    return {
      provider: "openai",
      client: new OpenAI({ apiKey }),
    };
  }

  if (provider === "anthropic") {
    const apiKey = await getSecret("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY in secure store / env");
    }

    return {
      provider: "anthropic",
      client: new Anthropic({ apiKey }),
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
