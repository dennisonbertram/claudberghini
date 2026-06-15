import axios from 'axios';
import { ProxyConfig } from './types';

export class APIHandler {
  constructor(private config: ProxyConfig) {}

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
      const response = await axios.head(this.config.claudberghiniApiUrl, {
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

  private log(level: string, message: string): void {
    const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
    const currentLevel = logLevels[this.config.logLevel] || 1;
    const messageLevel = logLevels[level as keyof typeof logLevels] || 1;

    if (messageLevel >= currentLevel) {
      console.log(`[${level.toUpperCase()}] ${new Date().toISOString()} - ${message}`);
    }
  }
}
