export type AsyncRequestGuard = {
  activate: () => void;
  begin: () => number;
  invalidate: () => void;
  isCurrent: (requestId: number) => boolean;
};

export function createAsyncRequestGuard(): AsyncRequestGuard {
  let active = true;
  let currentRequestId = 0;

  return {
    activate: () => {
      active = true;
    },
    begin: () => {
      currentRequestId += 1;
      return currentRequestId;
    },
    invalidate: () => {
      active = false;
      currentRequestId += 1;
    },
    isCurrent: (requestId: number) => active && requestId === currentRequestId
  };
}
