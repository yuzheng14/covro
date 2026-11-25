export const HISTORY_PAGE_SIZE = 12;

export function historyCursor(
  threadId: string,
  epoch: string,
  position: { cursor: string } | { beforeTurnId: string },
): string {
  return Buffer.from(JSON.stringify({ threadId, epoch, ...position })).toString('base64url');
}
