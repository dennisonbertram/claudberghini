import axios, { AxiosError } from 'axios';
import { APIRequest, APIResponse, ProxyConfig } from './types';

export class APIHandler {
  constructor(private config: ProxyConfig) {}

  /**
   * Handle proxied API requests to upstream services
   */
  async handleRequest(request: APIRequest): Promise<APIResponse> {
    const timestamp = new Date().toISOString();

    try {
      this.log('info', `Processing ${request.method} request to ${request.endpoint}`);

      const url = this.buildUrl(request.endpoint);
      const headers = this.buildHeaders(request.headers);

      const response = await axios({
        method: request.method,
        url,
        headers,
        data: request.body,
        timeout: 30000,
      });

      this.log('info', `Request successful: ${response.status}`);

      return {
        status: response.status,
        headers: response.headers as Record<string, string>,
        body: response.data,
        timestamp,
      };
    } catch (error) {
      return this.handleError(error, timestamp);
    }
  }

  /**
   * Health check for the proxy server
   */
  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check connectivity to upstream API
   */
  async checkUpstreamConnectivity(): Promise<{ connected: boolean; error?: string }> {
    try {
      const response = await axios.head(this.config.chatjimmyApiUrl, {
        timeout: 5000,
      });
      this.log('info', `Upstream connectivity check successful: ${response.status}`);
      return { connected: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.log('error', `Upstream connectivity check failed: ${errorMsg}`);
      return {
        connected: false,
        error: errorMsg,
      };
    }
  }

  private buildUrl(endpoint: string): string {
    const baseUrl = this.config.chatjimmyApiUrl.replace(/\/$/, '');
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${baseUrl}${path}`;
  }

  private buildHeaders(customHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'ChatJimmy-Proxy/1.0.0',
      'Content-Type': 'application/json',
    };

    if (this.config.anthropicApiKey) {
      headers['Authorization'] = `Bearer ${this.config.anthropicApiKey}`;
    }

    return { ...headers, ...customHeaders };
  }

  private handleError(error: unknown, timestamp: string): APIResponse {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      this.log('error', `API request failed: ${axiosError.message}`);

      return {
        status: axiosError.response?.status || 500,
        headers: (axiosError.response?.headers as Record<string, string>) || {},
        body: {
          error: axiosError.message,
          details: axiosError.response?.data,
        },
        timestamp,
      };
    }

    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    this.log('error', `Unexpected error: ${errorMsg}`);

    return {
      status: 500,
      headers: {},
      body: {
        error: errorMsg,
      },
      timestamp,
    };
  }

  private log(level: string, message: string): void {
    const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
    const currentLevel = logLevels[this.config.logLevel] || 1;
    const messageLevel = logLevels[level as keyof typeof logLevels] || 1;

    if (messageLevel >= currentLevel) {
      console.log(`[${level.toUpperCase()}] ${new Date().toISOString()} - ${message}`);
    }
  }
}
