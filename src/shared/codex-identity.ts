/** A launch observation, never a substitute for the running server's handshake. */
export interface CodexIdentity {
  binary: string;
  resolved: string;
  executable: string;
  file: string;
  version: string;
  node: string;
  cwd: string;
  environment: string;
}

export interface CodexTarget {
  identity: CodexIdentity;
  configuration: string;
  launch: string;
}
