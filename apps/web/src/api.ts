export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  theme: "system" | "light" | "dark" | "plain-light" | "plain-dark" | "expanse";
  protectedFromDelete: boolean;
  isActive: boolean;
  createdAt: string;
  deletedAt: string | null;
  // Self-only: present on the signed-in user (session + profile), absent on the
  // admin user list. Used by Send-to-e-reader and the Profile field.
  ereaderEmail?: string | null;
}

interface ApiErrorPayload {
  error?: string;
  details?: {
    fieldErrors?: Record<string, string[]>;
    formErrors?: string[];
  };
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isAccessOrMissingApiError(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
    const fieldMessage = payload.details?.fieldErrors
      ? Object.entries(payload.details.fieldErrors)
          .flatMap(([field, messages]) => messages.map((message) => `${field}: ${message}`))
          .join("; ")
      : "";
    const formMessage = payload.details?.formErrors?.join("; ") ?? "";
    throw new ApiError(fieldMessage || formMessage || payload.error || "Request failed", response.status);
  }

  return response.json() as Promise<T>;
}
