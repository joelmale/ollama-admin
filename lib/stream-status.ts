// nginx's "client closed request", so aborted streams stand apart from failures in the logs.
export const CLIENT_CLOSED_REQUEST = 499;

export function streamStatusCode(failed: boolean, clientGone: boolean) {
  if (failed) return 502;
  if (clientGone) return CLIENT_CLOSED_REQUEST;
  return 200;
}
