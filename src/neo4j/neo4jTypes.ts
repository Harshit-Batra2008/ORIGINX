import type { Driver, Session } from 'neo4j-driver';

export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
  connectionTimeoutMs?: number;
  maxConnectionLifetimeMs?: number;
}

export interface Neo4jConnectionResult {
  connected: boolean;
  serverVersion?: string;
  durationMs: number;
  uri: string;
  username: string;
  database?: string;
  error?: string;
}

export interface INeo4jSession {
  run(query: string, parameters?: Record<string, any>): Promise<any>;
  executeWrite?<T>(work: (tx: { run(query: string, parameters?: Record<string, any>): Promise<any> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface INeo4jDriver {
  session(options?: any): INeo4jSession;
  getServerInfo?(): Promise<any>;
  close(): Promise<void>;
}
