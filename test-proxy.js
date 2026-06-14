const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: "test-key",
  baseURL: "http://localhost:3000",
});

async function main() {
  console.log("Testing ChatJimmy proxy...\n");

  const t = Date.now();
  const msg = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 200,
    messages: [{ role: "user", content: "What model are you and who made you?" }],
  });

  console.log("Response:", msg.content[0].text);
  console.log(`\nLatency: ${Date.now() - t}ms`);
  console.log("Model in response:", msg.model);
  console.log("Tokens:", msg.usage);
}

main().catch(console.error);
