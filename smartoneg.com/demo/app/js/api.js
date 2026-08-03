/** Thin fetch wrapper. 401s flip the app into the login view. */
export const onUnauthorized = { handler: null };

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  // A 401 on a normal request means the session expired -> flip to login. The
  // login request itself is exempt: its 401 is "wrong credentials", and the
  // server's own message should reach the caller.
  if (res.status === 401 && !url.endsWith('/auth/login')) {
    onUnauthorized.handler?.();
    throw new ApiError('Authentication required', 401, null);
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data);
  return data;
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const api = {
  get: (url) => call('GET', url),
  post: (url, body) => call('POST', url, body ?? {}),
  put: (url, body) => call('PUT', url, body),
  patch: (url, body) => call('PATCH', url, body),
  del: (url, body) => call('DELETE', url, body),
};
