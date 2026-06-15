export interface ProxyConfig {
  claudberghiniApiUrl: string;
  anthropicApiKey: string;
  proxyPort: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  // Real-Anthropic passthrough: requests whose model matches `passthroughMatch`
  // (and only when anthropicApiKey is set) are forwarded verbatim to anthropicApiUrl
  // instead of the Llama backend. Lets the same endpoint serve a real-Opus coordinator
  // alongside cheap proxied-Llama sub-agents.
  anthropicApiUrl: string;
  anthropicVersion: string;
  passthroughMatch: string;
}

export interface ConversionRequest {
  sourceFormat: string;
  targetFormat: string;
  data: unknown;
  options?: Record<string, unknown>;
}

export interface ConversionResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  timestamp: string;
}

export interface APIRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  endpoint: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface APIResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  timestamp: string;
}

export interface ProxyError {
  code: string;
  message: string;
  details?: unknown;
}
