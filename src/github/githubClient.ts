/**
 * GitWhisper — GitHub API Client
 * High-reliability client for public GitHub REST API with rate limit tracking,
 * pagination, timeout bounds, and cancellation support.
 */

import { ICancellationTokenLike } from '../git/gitService';
import { GitHubRateLimitInfo } from './githubTypes';

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
  fetchFn?: typeof fetch;
}

export interface GitHubApiResponse<T> {
  data: T;
  headers: Record<string, string>;
  rateLimit: GitHubRateLimitInfo;
  status: number;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly rateLimit?: GitHubRateLimitInfo,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchFn: typeof fetch;
  private latestRateLimit: GitHubRateLimitInfo = {
    limit: 60,
    remaining: 60,
    resetEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
    resetDate: new Date(Date.now() + 3600000).toISOString(),
    isExhausted: false,
  };

  constructor(options?: GitHubClientOptions) {
    this.baseUrl = (options?.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.token = options?.token;
    this.timeoutMs = options?.timeoutMs ?? 15000;
    this.userAgent = options?.userAgent ?? 'GitWhisper-EvidenceGraph/0.3.3';
    this.fetchFn = options?.fetchFn ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : fetch);
  }

  public getRateLimit(): GitHubRateLimitInfo {
    return { ...this.latestRateLimit };
  }

  public parseRateLimitHeaders(headers: Headers | Record<string, string>): GitHubRateLimitInfo {
    const getHeader = (name: string): string | null => {
      if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name);
      }
      const record = headers as Record<string, string>;
      return record[name] ?? record[name.toLowerCase()] ?? null;
    };

    const limitStr = getHeader('x-ratelimit-limit');
    const remainingStr = getHeader('x-ratelimit-remaining');
    const resetStr = getHeader('x-ratelimit-reset');

    if (limitStr !== null && remainingStr !== null && resetStr !== null) {
      const limit = parseInt(limitStr, 10) || 60;
      const remaining = parseInt(remainingStr, 10);
      const resetEpochSeconds = parseInt(resetStr, 10) || Math.floor(Date.now() / 1000);
      const resetDate = new Date(resetEpochSeconds * 1000).toISOString();
      const isExhausted = remaining <= 0;

      this.latestRateLimit = {
        limit,
        remaining,
        resetEpochSeconds,
        resetDate,
        isExhausted,
      };
    }

    return { ...this.latestRateLimit };
  }

  public async get<T>(
    endpointOrUrl: string,
    options?: {
      cancellationToken?: ICancellationTokenLike;
      timeoutMs?: number;
      headers?: Record<string, string>;
    }
  ): Promise<GitHubApiResponse<T>> {
    const url = endpointOrUrl.startsWith('http://') || endpointOrUrl.startsWith('https://')
      ? endpointOrUrl
      : `${this.baseUrl}${endpointOrUrl.startsWith('/') ? '' : '/'}${endpointOrUrl}`;

    if (this.latestRateLimit.isExhausted && this.latestRateLimit.resetEpochSeconds * 1000 > Date.now()) {
      throw new GitHubApiError(
        `GitHub API rate limit exhausted. Resets at ${this.latestRateLimit.resetDate}`,
        429,
        this.latestRateLimit
      );
    }

    if (options?.cancellationToken?.isCancellationRequested) {
      throw new GitHubApiError('Request cancelled by caller', 499);
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort(new Error('GitHub API request timed out'));
    }, options?.timeoutMs ?? this.timeoutMs);

    let cancelSubscription: { dispose: () => void } | undefined;
    if (options?.cancellationToken) {
      cancelSubscription = options.cancellationToken.onCancellationRequested(() => {
        abortController.abort(new Error('Request cancelled'));
      });
    }

    const reqHeaders: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': this.userAgent,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(options?.headers ?? {}),
    };

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: reqHeaders,
        signal: abortController.signal,
      });

      const headerMap: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        headerMap[key.toLowerCase()] = val;
      });

      const rateLimit = this.parseRateLimitHeaders(response.headers);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        let errorMsg = `GitHub API HTTP ${response.status}: ${response.statusText}`;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.message) {
            errorMsg = `GitHub API HTTP ${response.status}: ${parsed.message}`;
          }
        } catch {
          // keep fallback errorMsg
        }

        if (response.status === 403 && (errorMsg.includes('rate limit') || rateLimit.remaining === 0)) {
          this.latestRateLimit.isExhausted = true;
          throw new GitHubApiError(
            `GitHub API rate limit exceeded: ${errorMsg}`,
            403,
            rateLimit,
            errorText
          );
        }

        throw new GitHubApiError(errorMsg, response.status, rateLimit, errorText);
      }

      const data = (await response.json()) as T;
      return {
        data,
        headers: headerMap,
        rateLimit,
        status: response.status,
      };
    } catch (err: any) {
      if (err instanceof GitHubApiError) {
        throw err;
      }
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        if (options?.cancellationToken?.isCancellationRequested) {
          throw new GitHubApiError('GitHub request was cancelled', 499);
        }
        throw new GitHubApiError(`GitHub request timed out after ${options?.timeoutMs ?? this.timeoutMs}ms`, 408);
      }
      throw new GitHubApiError(`GitHub request failed: ${err.message}`, 500);
    } finally {
      clearTimeout(timeout);
      cancelSubscription?.dispose();
    }
  }

  /**
   * Paginates through a GitHub list endpoint up to maxItems or until no more pages exist.
   */
  public async getPaginated<T>(
    endpoint: string,
    options?: {
      maxItems?: number;
      perPage?: number;
      cancellationToken?: ICancellationTokenLike;
      timeoutMs?: number;
    }
  ): Promise<{ items: T[]; rateLimit: GitHubRateLimitInfo }> {
    const maxItems = options?.maxItems ?? 100;
    const perPage = Math.min(options?.perPage ?? 30, maxItems);
    const items: T[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && items.length < maxItems) {
      if (options?.cancellationToken?.isCancellationRequested) {
        break;
      }

      const separator = endpoint.includes('?') ? '&' : '?';
      const pageUrl = `${endpoint}${separator}page=${page}&per_page=${perPage}`;

      const res = await this.get<T[]>(pageUrl, {
        cancellationToken: options?.cancellationToken,
        timeoutMs: options?.timeoutMs,
      });

      if (!Array.isArray(res.data) || res.data.length === 0) {
        hasMore = false;
        break;
      }

      for (const item of res.data) {
        items.push(item);
        if (items.length >= maxItems) {
          hasMore = false;
          break;
        }
      }

      if (res.data.length < perPage) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return {
      items,
      rateLimit: this.getRateLimit(),
    };
  }
}
