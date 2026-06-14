# ChatJimmy Proxy - Curl Test Examples

All examples assume the proxy server is running on `localhost:3000`.

## Health Checks

### Check Server Health
```bash
curl http://localhost:3000/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-06-14T15:03:04.092Z"
}
```

### Check Upstream API Connectivity
```bash
curl http://localhost:3000/health/upstream
```

**Response:**
```json
{
  "connected": true
}
```

### Get Server Configuration
```bash
curl http://localhost:3000/config
```

**Response:**
```json
{
  "chatjimmyApiUrl": "https://chatjimmy.ai",
  "proxyPort": 3000,
  "logLevel": "info",
  "upstreamKeyConfigured": false
}
```

## Non-Streaming Requests

### Simple Message with GPT-4
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello, who are you?"}],
    "max_tokens": 500,
    "stream": false
  }'
```

**Sample Response:**
```json
{
  "id": "msg_1781449256508",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "I'm an AI model, which means I'm a computer program designed to simulate conversations and answer questions. I'm here to assist you, provide information, and even have a chat..."
    }
  ],
  "model": "gpt-4",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 266
  }
}
```

### With System Prompt
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "system": "You are a helpful math assistant.",
    "messages": [{"role": "user", "content": "What is 5 * 3?"}],
    "max_tokens": 100,
    "stream": false
  }'
```

### GPT-3.5 Turbo
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Tell me a short joke"}],
    "max_tokens": 150,
    "stream": false
  }'
```

### Claude 3 Opus
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-opus",
    "messages": [{"role": "user", "content": "Explain quantum computing"}],
    "max_tokens": 200,
    "stream": false
  }'
```

### Claude 3 Haiku
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-haiku",
    "messages": [{"role": "user", "content": "Hi there"}],
    "max_tokens": 100,
    "stream": false
  }'
```

## Multi-Turn Conversations

### Conversation with History
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "What is the capital of France?"},
      {"role": "assistant", "content": "The capital of France is Paris."},
      {"role": "user", "content": "What is its population?"}
    ],
    "max_tokens": 100,
    "stream": false
  }'
```

**Sample Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "The population of Paris, the city, is approximately 2.2 million people. The population of the greater Paris metropolitan area, which includes the surrounding cities and suburbs, is over 12 million people."
    }
  ],
  "usage": {
    "input_tokens": 0,
    "output_tokens": 50
  }
}
```

## Streaming Requests

### Stream with GPT-4
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "max_tokens": 500,
    "stream": true
  }'
```

**Response Format (Server-Sent Events):**
```
data: {"type":"content_block_delta","index":0,"content_block":{"type":"text","text":"chunk of response"},"delta":{"type":"text_delta","text":"chunk of response"}}

data: {"type":"content_block_delta","index":0,"content_block":{"type":"text","text":"more chunks"},"delta":{"type":"text_delta","text":"more chunks"}}

data: {"type":"message_stop","message":{"id":"msg_1781449259153","type":"message","role":"assistant","stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":0}}}
```

### Stream with Claude 3 Opus
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-opus",
    "messages": [{"role": "user", "content": "Say hello world in 5 words"}],
    "max_tokens": 50,
    "stream": true
  }'
```

## Pretty-Printed Examples

### Get Just the Response Text
```bash
curl -s -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100,
    "stream": false
  }' | jq '.content[0].text'
```

### Get Model and Token Count
```bash
curl -s -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100,
    "stream": false
  }' | jq '{
    model: .model,
    stop_reason: .stop_reason,
    output_tokens: .usage.output_tokens,
    text_preview: (.content[0].text | .[0:80])
  }'
```

**Response:**
```json
{
  "model": "gpt-4",
  "stop_reason": "end_turn",
  "output_tokens": 114,
  "text_preview": "Hello! I'm an AI assistant. How can I help you today?"
}
```

### Monitor All Supported Models
```bash
for model in gpt-4 gpt-4-turbo gpt-3.5-turbo claude-3-opus claude-3-haiku; do
  echo "Testing $model..."
  curl -s -X POST http://localhost:3000/v1/messages \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$model\",
      \"messages\": [{\"role\": \"user\", \"content\": \"Hi\"}],
      \"max_tokens\": 50,
      \"stream\": false
    }" | jq '.model'
done
```

## Error Handling Examples

### Missing Model Field
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100,
    "stream": false
  }'
```

**Response:**
```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "Missing required field: model"
  }
}
```

### Missing Messages Field
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "max_tokens": 100,
    "stream": false
  }'
```

**Response:**
```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "Missing required field: messages (must be an array)"
  }
}
```

## Performance Testing

### Measure Response Time
```bash
time curl -s -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "2+2=?"}],
    "max_tokens": 50,
    "stream": false
  }' > /dev/null
```

Expected: 40-120ms

### Load Test Multiple Requests
```bash
for i in {1..5}; do
  curl -s -X POST http://localhost:3000/v1/messages \
    -H "Content-Type: application/json" \
    -d '{
      "model": "gpt-4",
      "messages": [{"role": "user", "content": "Hi"}],
      "max_tokens": 50,
      "stream": false
    }' | jq '.id'
done
```

## Using with jq for Response Processing

### Extract Full Conversation
```bash
curl -s -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100,
    "stream": false
  }' | jq '{
    message_id: .id,
    model_used: .model,
    response: .content[0].text,
    stop_reason: .stop_reason,
    tokens_used: .usage.output_tokens
  }'
```

### Filter Response Text Only
```bash
curl -s -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100,
    "stream": false
  }' | jq -r '.content[0].text'
```

## Notes

- All endpoints accept JSON payloads
- The proxy automatically converts Anthropic format to ChatJimmy format and back
- Model names are mapped to available ChatJimmy models
- Token counts are estimated based on response length
- System messages can be passed in the `system` field or as a message with `"role": "system"`
- Streaming uses Server-Sent Events (SSE) format
- All responses include proper Anthropic-compatible structure
