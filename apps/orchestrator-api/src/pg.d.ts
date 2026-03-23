declare module "pg" {
  export class Pool {
    constructor(config?: Record<string, unknown>);
    query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  }
}
