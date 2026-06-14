const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: "test", baseURL: "http://localhost:3000" });
async function main() {
  const stream = client.messages.stream({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 300,
    tools: [{ name: "Read", description: "Read a file from disk. Use when asked to read/view a file.",
      input_schema: { type: "object", properties: { file_path: { type: "string", description: "Absolute path" } }, required: ["file_path"] } }],
    messages: [{ role: "user", content: "Please read /tmp/cj-tool-test/config.txt" }],
  });
  const final = await stream.finalMessage();
  console.log("stop_reason:", final.stop_reason);
  console.log("content:", JSON.stringify(final.content, null, 2));
}
main().catch(e => { console.error("SDK ERROR:", e.message); process.exit(1); });
