export interface GlobalInstructions {
  content: string;
  revision: string;
  exists: boolean;
  path: string;
  overridden: boolean;
}
export interface SaveGlobalInstructions {
  content: string;
  revision: string;
}
