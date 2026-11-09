declare module 'pino-roll' {
  import type { EventEmitter } from 'node:events';
  interface RollingStream extends EventEmitter {
    write(data: string): boolean;
    flush(callback: (error?: Error) => void): void;
    end(): void;
    destroyed: boolean;
    file: string;
    fd: number;
    destroy(): void;
  }
  export default function roll(options: Record<string, unknown>): Promise<RollingStream>;
}
