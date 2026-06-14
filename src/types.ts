export interface ProxyConfig {
  chatjimmyApiUrl: string;
  anthropicApiKey: string;
  proxyPort: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
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
