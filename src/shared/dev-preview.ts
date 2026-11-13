export interface PreviewService {
  id: string;
  threadId: string;
  projectId: string | null;
  projectName: string;
  command: string;
  port: number;
  status: 'running' | 'withdrawn';
  reason?: string;
}
export interface PreviewSettings {
  enabled: boolean;
  fullRequests: boolean;
}
export interface PreviewSnapshot {
  settings: PreviewSettings;
  services: PreviewService[];
  available: boolean;
  error?: string;
}
