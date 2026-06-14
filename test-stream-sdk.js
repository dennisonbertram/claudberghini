const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: "test", baseURL: "http://localhost:3000" });

async function main() {
  let full = "";
  let events = [];
  const stream = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "Say hello in 3 words" }],
  });
  for await (const ev of stream) {
    events.push(ev.type);
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
      full += ev.delta.text;
    }
  }
  console.log("Event types:", events.join(", "));
  console.log("Reconstructed text:", JSON.stringify(full));
}
main().catch(e => { console.error("SDK ERROR:", e.message); process.exit(1); });
